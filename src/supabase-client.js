(function () {
  const SESSION_KEY = "tobacco-session";
  const REQUESTS_KEY = "tobacco-requests";
  const INVENTORY_REPORTS_KEY = "tobacco-inventory-reports";
  const CUSTOMER_LIMITS_KEY = "tobacco-customer-credit-limits";
  const APPROVED_PRICES_KEY = "tobacco-approved-price-items";
  const PURCHASE_INVOICES_KEY = "tobacco-purchase-invoices";
  // كاش غير رسمي فقط (offline) — المصدر الوحيد للحقيقة هو جدول Supabase bulletin_exchange_rate.
  const SYRIA_EXCHANGE_RATE_CACHE_KEY = "tobacco-syria-exchange-rate-cache";
  const DEFAULT_SYRIA_EXCHANGE_RATE = 14050;

  const defaultRequests = [
    {
      id: "REQ-1001",
      publicId: "REQ-1001",
      customer: "عميل تجريبي",
      channel: "واتساب",
      type: "استفسار",
      status: "مفتوح",
      note: "طلب متابعة من فريق خدمة العملاء."
    }
  ];

  function readJson(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
    } catch {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  }

  function cleanText(value, limit) {
    return String(value || "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, limit);
  }

  function parseNumber(value) {
    let text = String(value ?? "")
      .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
      .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
      .replace(/[٫،]/g, ".")
      .replace(/\s+/g, "")
      .trim();

    const commaCount = (text.match(/,/g) || []).length;
    if (!text.includes(".") && commaCount === 1) {
      const [, decimalPart = ""] = text.split(",");
      if (/^\d{1,2}$/.test(decimalPart)) {
        text = text.replace(",", ".");
      }
    }

    text = text.replace(/,/g, "").replace(/[^\d.-]/g, "");
    const isNegative = text.includes("-");
    text = text.replace(/-/g, "");
    const parts = text.split(".");
    text = `${parts.shift() || ""}${parts.length ? `.${parts.join("")}` : ""}`;
    if (text.startsWith(".")) text = `0${text}`;
    if (isNegative && text) text = `-${text}`;

    const number = Number(text);
    return Number.isFinite(number) ? number : 0;
  }

  function roundPrice(value) {
    const number = Number(value || 0);
    if (!Number.isFinite(number)) return 0;
    return Math.round((number + Number.EPSILON) * 1000) / 1000;
  }

  const config = window.appConfig?.supabase || {};
  const hasConfig = Boolean(config.url && config.publishableKey);
  const hasLibrary = Boolean(window.supabase?.createClient);
  const tableName = config.requestsTable || "customer_requests";
  const inventoryReportsTable = config.inventoryReportsTable || "inventory_reports";
  const warehouseStockReportsTable = config.warehouseStockReportsTable || "ameen_warehouse_stock_reports";
  const warehouseTransferReportsTable = config.warehouseTransferReportsTable || "ameen_warehouse_transfer_reports";
  const creditLimitsTable = config.creditLimitsTable || "customer_credit_limits";
  const approvedPricesTable = config.approvedPricesTable || "approved_price_items";
  const paymentRecordsTable = config.paymentRecordsTable || "payment_records";
  const customerProfilesTable = config.customerProfilesTable || "customer_profiles";
  const itemCostsTable = config.itemCostsTable || "item_costs";
  const dailyMovementTable = config.dailyMovementTable || "daily_movement_reports";
  const purchaseInvoicesTable = config.purchaseInvoicesTable || "purchase_invoices";
  const itemSnapshotTable = config.itemSnapshotTable || "ameen_item_snapshot";
  const purchaseInvoiceReportsTable = config.purchaseInvoiceReportsTable || "ameen_purchase_invoice_reports";
  const reconSessionsTable = config.reconSessionsTable || "inventory_recon_sessions";
  // مصدر الحقيقة الوحيد لسعر صرف الليرة السورية بنشرة الأسعار (يقرأه أيضاً
  // GitHub Actions عبر مفتاح anon — سياسة SELECT على الجدول تسمح بذلك عمداً).
  const exchangeRateTable = config.exchangeRateTable || "bulletin_exchange_rate";
  const client =
    hasConfig && hasLibrary
      ? window.supabase.createClient(config.url, config.publishableKey, {
          auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true
          }
        })
      : null;
  const initialRecoveryUrl = String(window.location?.href || "");
  // لا تعتبر query string وحدها جلسة استعادة. جلسة الرابط الضمني تحتاج access token فعلياً،
  // أما مسار الرمز اليدوي فيُفعّل فقط بعد نجاح verifyOtp.
  let passwordRecoveryActive =
    /(?:[#&]type=recovery)/i.test(initialRecoveryUrl) &&
    /(?:[#&]access_token=)/i.test(initialRecoveryUrl);
  const passwordRecoveryListeners = new Set();

  function notifyPasswordRecovery() {
    passwordRecoveryActive = true;
    passwordRecoveryListeners.forEach((listener) => {
      try { listener(); } catch {}
    });
  }

  // Canonical browser client: feature modules reuse the same GoTrue session owner.
  if (client) {
    window.ozkSupabaseClient = client;
    if (typeof client.auth.onAuthStateChange === "function") {
      client.auth.onAuthStateChange((event) => {
        if (event === "PASSWORD_RECOVERY") notifyPasswordRecovery();
      });
    }
  }

  function normalizeSession(session) {
    const user = session?.user;
    if (!user) return null;

    const email = (user.email || "").toLowerCase();
    const staffEntry = window.appConfig?.staffRoles?.[email];
    const metadataRole = String(user.app_metadata?.role || "").toLowerCase();
    const accessRole = ["owner", "employee", "inventory_counter"].includes(metadataRole)
      ? metadataRole
      : staffEntry?.accessRole || "employee";
    const trustedDisplayName = cleanText(user.app_metadata?.display_name, 80);

    return {
      provider: "supabase",
      id: user.id,
      // Counter identities use a synthetic Auth email internally. Never copy it
      // into application state or render it in the interface.
      email: accessRole === "inventory_counter" ? "" : (user.email || ""),
      name: accessRole === "inventory_counter"
        ? (trustedDisplayName || "موظف جرد")
        : (staffEntry?.name || trustedDisplayName || user.user_metadata?.display_name || user.email || "موظف OZK"),
      role: accessRole === "inventory_counter" ? "موظف جرد" : (staffEntry?.role || (accessRole === "owner" ? "المالك" : "موظف")),
      accessRole
    };
  }

  async function inventoryRpc(name, params = {}) {
    if (!client) throw new Error("الجرد الذكي يتطلب اتصالاً آمناً بـ Supabase.");
    await requireUser();
    const { data, error } = await client.rpc(name, params);
    if (error) throw new Error(translateDbError(error.message));
    return data;
  }

  async function inventoryAuthRequest(action, payload = {}, requireSession = true) {
    if (!client) throw new Error("إدارة حسابات الجرد تتطلب اتصالاً آمناً بـ Supabase.");
    let accessToken = "";
    if (requireSession) {
      const { data, error } = await client.auth.getSession();
      if (error || !data?.session?.access_token) throw new Error(missingSessionMessage());
      accessToken = data.session.access_token;
    }
    const response = await fetch(`${config.url.replace(/\/$/, "")}/functions/v1/inventory-auth`, {
      method: "POST",
      headers: {
        apikey: config.publishableKey,
        authorization: `Bearer ${accessToken || config.publishableKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ action, ...payload })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const messages = {
        credentials_required: "اكتب اسم المستخدم وكلمة المرور.",
        invalid_or_locked: "بيانات الدخول غير صحيحة أو الحساب مقفل مؤقتاً. انتظر 15 دقيقة بعد المحاولات المتكررة.",
        device_not_allowed: "هذا الحساب مقصور على جهاز آخر. اطلب من المالك تسجيل هذا الجهاز.",
        owner_only: "هذه العملية متاحة للمالك فقط.",
        username_taken: "اسم المستخدم مستخدم مسبقاً. اختر اسماً مميزاً.",
        invalid_account_input: "أدخل اسماً واضحاً واسم مستخدم مميزاً وكلمة مرور من 8 أحرف على الأقل.",
        invalid_password: "كلمة المرور يجب أن تكون من 8 أحرف على الأقل.",
        weak_password: "كلمة المرور مرفوضة أمنياً. استخدم كلمة أقوى.",
        account_not_found: "حساب موظف الجرد غير موجود.",
        login_unavailable: "خدمة دخول الجرد غير متاحة الآن. حاول لاحقاً."
      };
      throw new Error(messages[result.error] || "تعذر تنفيذ العملية الآمنة.");
    }
    return result;
  }

  function normalizeDbRequest(row) {
    const shortId = String(row.id || Date.now()).slice(0, 8).toUpperCase();
    return {
      id: row.id,
      publicId: `REQ-${shortId}`,
      customer: row.customer,
      channel: row.channel,
      type: row.request_type,
      status: row.status === "closed" ? "مغلق" : "مفتوح",
      note: row.note || "",
      createdAt: row.created_at
    };
  }

  function toDbStatus(status) {
    return status === "مغلق" || status === "closed" ? "closed" : "open";
  }

  function normalizeDbCustomerLimit(row) {
    return {
      id: row.id,
      customerKey: row.customer_key,
      customerName: row.customer_name || "",
      creditLimit: parseNumber(row.credit_limit || 0),
      notes: row.notes || "",
      updatedAt: row.updated_at || row.created_at || ""
    };
  }

  function normalizeCustomerLimitInput(input, userId = null) {
    const creditLimit = parseNumber(input.creditLimit || 0);
    return {
      customer_key: cleanText(input.customerKey, 240),
      customer_name: cleanText(input.customerName, 240),
      credit_limit: Number.isFinite(creditLimit) ? Math.max(0, creditLimit) : 0,
      notes: cleanText(input.notes, 500),
      updated_at: new Date().toISOString(),
      ...(userId ? { updated_by: userId } : {})
    };
  }

  // فواتير المشتريات — تسجيل + مزامنة أمين مستقبلية (لم تُفعَّل بعد، انظر AI_WORK_SYNC.md)
  const PO_STATUS_VALUES = ["draft", "approved", "sync_pending", "synced", "failed"];
  const PO_CURRENCY_VALUES = ["USD", "SYP"];

  function normalizePurchaseItems(items) {
    return (Array.isArray(items) ? items : [])
      .map((item) => ({
        item_key: item.item_key == null ? null : String(item.item_key),
        item_number: item.item_number == null ? "" : String(item.item_number),
        item_guid: item.item_guid == null ? null : String(item.item_guid),
        name: cleanText(item.name, 240),
        unit: item.unit === "unit1" ? "unit1" : "unit2",
        qty: Math.max(0, parseNumber(item.qty)),
        price: Math.max(0, parseNumber(item.price))
      }))
      .filter((item) => item.name && item.qty > 0);
  }

  function normalizeDbPurchaseInvoice(row) {
    const shortId = String(row.id || Date.now()).slice(0, 8).toUpperCase();
    const items = normalizePurchaseItems(row.items);
    const status = PO_STATUS_VALUES.includes(row.status) ? row.status : "draft";
    const total = parseNumber(row.total || 0);
    const paidTotal = parseNumber(row.paid_total || 0);
    const remainingTotal = row.remaining_total != null ? parseNumber(row.remaining_total) : roundPrice(total - paidTotal);
    return {
      id: row.id,
      publicId: `PO-${shortId}`,
      supplierName: row.supplier_name || "",
      supplierAmeenGuid: row.supplier_ameen_guid || "",
      supplierAmeenCode: row.supplier_ameen_code || "",
      orderDate: row.order_date || "",
      status,
      items,
      currency: PO_CURRENCY_VALUES.includes(row.currency) ? row.currency : "USD",
      payMethod: row.pay_method === "cash" ? "cash" : "credit",
      paymentAmount: parseNumber(row.payment_amount || 0),
      paymentDate: row.payment_date || "",
      paymentAccount: row.payment_account || "",
      paidTotal,
      remainingTotal,
      idempotencyKey: row.idempotency_key || "",
      syncAttempts: Number(row.sync_attempts || 0),
      syncError: row.sync_error || "",
      ameenDocumentGuid: row.ameen_document_guid || "",
      ameenDocumentNumber: row.ameen_document_number || "",
      syncedAt: row.synced_at || "",
      approvedBy: row.approved_by || "",
      approvedAt: row.approved_at || "",
      correctionCount: Number(row.correction_count || 0),
      correctionLog: Array.isArray(row.correction_log) ? row.correction_log : [],
      total,
      notes: row.notes || "",
      createdAt: row.created_at || "",
      updatedAt: row.updated_at || row.created_at || ""
    };
  }

  function normalizeDbItemSnapshot(row) {
    return {
      itemKey: row.item_key || "",
      itemGuid: row.item_guid || "",
      itemNumber: row.item_number == null ? "" : String(row.item_number),
      itemName: row.item_name || "",
      unit1Name: row.unit1_name || "",
      unit2Name: row.unit2_name || "",
      unit2Factor: parseNumber(row.unit2_factor || 1) || 1,
      stockUnit1: row.stock_unit1 != null ? parseNumber(row.stock_unit1) : null,
      lastPurchasePrice: row.last_purchase_price != null ? parseNumber(row.last_purchase_price) : null,
      lastPurchaseDate: row.last_purchase_date || "",
      lastPurchaseCurrency: row.last_purchase_currency || "",
      lastPurchaseUnit: row.last_purchase_unit || "",
      averageCost: row.average_cost != null ? parseNumber(row.average_cost) : null,
      averageCostCurrency: row.average_cost_currency || "",
      averageCostBasis: row.average_cost_basis || "",
      lastSupplierName: row.last_supplier_name || "",
      lastSupplierGuid: row.last_supplier_guid || "",
      movementRank: row.movement_rank != null ? Number(row.movement_rank) : null,
      unitsSold30d: row.units_sold_30d != null ? parseNumber(row.units_sold_30d) : null,
      generatedAt: row.generated_at || ""
    };
  }

  function normalizeDbPaymentRecord(row) {
    return {
      id: row.id,
      customerKey: row.customer_key,
      customerName: row.customer_name || "",
      amount: parseNumber(row.amount || 0),
      paymentDate: row.payment_date || "",
      notes: row.notes || "",
      source: "manual",
      createdAt: row.created_at || ""
    };
  }

  function normalizeDbCustomerProfile(row) {
    return {
      id: row.id,
      customerKey: row.customer_key,
      customerName: row.customer_name || "",
      phone: row.phone || "",
      address: row.address || "",
      notes: row.notes || "",
      updatedAt: row.updated_at || row.created_at || ""
    };
  }

  function normalizeDbApprovedPrice(row) {
    const rawUnit2Factor = parseNumber(row.unit2_factor || 1);
    const unit2Factor = Number.isFinite(rawUnit2Factor) && rawUnit2Factor > 0 ? rawUnit2Factor : 1;
    const rawUnit2Price = parseNumber(row.unit2_price || 0);
    const unit2Price = Number.isFinite(rawUnit2Price) ? Math.max(0, roundPrice(rawUnit2Price)) : 0;
    const fallbackUnit1Price = parseNumber(row.unit1_price || row.sale_price || 0);
    const unit1Price = roundPrice(unit2Price > 0 ? unit2Price / unit2Factor : fallbackUnit1Price);
    return {
      id: row.id,
      itemKey: row.item_key,
      itemGuid: row.item_guid || "",
      itemName: row.item_name || "",
      itemNumber: row.item_number == null ? "" : String(row.item_number),
      // كود الأمين (mt000.Code) هو ما يقرأه المستخدم على البطاقة؛ itemNumber ترقيم داخلي.
      itemCode: row.item_code == null ? "" : String(row.item_code),
      salePrice: unit1Price,
      stockQty: parseNumber(row.stock_qty || 0),
      stockStatus: row.stock_status || "",
      unit1Name: row.unit1_name || "",
      unit2Name: row.unit2_name || "",
      unit2Factor,
      unit2Price,
      unit1Price,
      sourceReportId: row.source_report_id || "",
      sourceSyncedAt: row.source_synced_at || "",
      pricePayload: row.price_payload || {},
      notes: row.notes || "",
      approvedAtExplicit: row.approved_at || "",
      approvedAt: row.approved_at || row.updated_at || row.created_at || "",
      updatedAt: row.updated_at || row.approved_at || row.created_at || ""
    };
  }

  function normalizeApprovedPriceInput(input, userId = null) {
    const rawUnit2Factor = parseNumber(input.unit2Factor || 1);
    const unit2Factor = Number.isFinite(rawUnit2Factor) && rawUnit2Factor > 0 ? rawUnit2Factor : 1;
    const unit2Price = roundPrice(parseNumber(input.unit2Price || 0));
    const explicitSalePrice = roundPrice(parseNumber(input.salePrice || input.unit1Price || 0));
    const salePrice =
      Number.isFinite(unit2Price) && unit2Price > 0
        ? roundPrice(unit2Price / unit2Factor)
        : explicitSalePrice;
    const stockQty = parseNumber(input.stockQty || 0);
    const cleanSalePrice = Number.isFinite(salePrice) ? Math.max(0, roundPrice(salePrice)) : 0;
    return {
      item_key: cleanText(input.itemKey, 240),
      item_name: cleanText(input.itemName, 240),
      sale_price: cleanSalePrice,
      stock_qty: Number.isFinite(stockQty) ? stockQty : 0,
      stock_status: cleanText(input.stockStatus, 40),
      unit1_name: cleanText(input.unit1Name, 80),
      unit2_name: cleanText(input.unit2Name, 80),
      unit2_factor: unit2Factor,
      unit2_price: Number.isFinite(unit2Price) ? Math.max(0, roundPrice(unit2Price)) : 0,
      unit1_price: cleanSalePrice,
      source_report_id: input.sourceReportId || null,
      source_synced_at: input.sourceSyncedAt || null,
      price_payload: input.pricePayload || {},
      notes: cleanText(input.notes, 500),
      approved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...(userId ? { approved_by: userId } : {})
    };
  }

  function missingSessionMessage() {
    return "لا توجد جلسة دخول فعالة. إذا أنشأت الحساب للتو، افتح رسالة التأكيد في البريد أو عطّل تأكيد البريد مؤقتا من Supabase ثم سجل الدخول.";
  }

  function translateAuthError(message) {
    const msg = message || "";
    if (/auth session missing|session.*missing/i.test(msg)) return missingSessionMessage();
    if (/otp_expired|token.*expired|invalid.*token|token.*invalid|one-time token/i.test(msg)) return "رمز الاستعادة غير صالح أو انتهت صلاحيته. اطلب رمزاً جديداً واحداً.";
    if (/invalid.*credentials|invalid.*password|wrong.*password/i.test(msg)) return "البريد الإلكتروني أو كلمة المرور غير صحيحة.";
    if (/email.*not.*confirmed|email.*unconfirmed/i.test(msg)) return "يرجى تأكيد بريدك الإلكتروني قبل تسجيل الدخول.";
    if (/too many requests|rate.*limit/i.test(msg)) return "محاولات كثيرة. انتظر قليلاً ثم حاول مجدداً.";
    if (/user.*not.*found|no user/i.test(msg)) return "لا يوجد حساب بهذا البريد الإلكتروني.";
    return msg;
  }

  function translateDbError(message) {
    const msg = message || "";
    if (/pgrst116|no rows/i.test(msg)) return "لم يُعثر على البيانات المطلوبة.";
    if (/pgrst301|jwt.*expired/i.test(msg)) return "انتهت جلسة الدخول. سجّل الدخول مجدداً.";
    if (/pgrst\d+|postgres|relation|column|violates|constraint/i.test(msg)) return "حدث خطأ في قاعدة البيانات. حاول مجدداً أو تواصل مع الدعم.";
    if (/fetch|network|ECONNREFUSED/i.test(msg)) return "تعذر الاتصال بالخادم. تحقق من اتصالك بالإنترنت.";
    if (/permission|denied|403|401/i.test(msg)) return "ليس لديك صلاحية لتنفيذ هذه العملية.";
    return msg;
  }

  async function getSupabaseSession() {
    const { data, error } = await client.auth.getSession();
    if (error) throw new Error(translateDbError(error.message));
    return normalizeSession(data.session);
  }

  async function requireUser() {
    const session = await getSupabaseSession();
    if (!session) throw new Error(missingSessionMessage());

    const { data, error } = await client.auth.getUser();
    if (error) throw new Error(translateAuthError(error.message));
    if (!data.user) throw new Error(missingSessionMessage());
    return data.user;
  }

  const service = {
    mode: client ? "supabase" : "local",
    hasConfig,
    hasLibrary,
    defaultRequests,

    isConfigured() {
      return Boolean(client);
    },

    statusLabel() {
      if (client) return "متصل بقاعدة Supabase";
      if (hasConfig && !hasLibrary) return "مفاتيح Supabase موجودة لكن المكتبة لم تتحمل";
      return "وضع تجريبي محلي";
    },

    async getSession() {
      if (client) return getSupabaseSession();
      return readJson(SESSION_KEY, null);
    },

    isPasswordRecovery() {
      return Boolean(client && passwordRecoveryActive);
    },

    onPasswordRecovery(listener) {
      if (typeof listener !== "function") return () => {};
      passwordRecoveryListeners.add(listener);
      if (passwordRecoveryActive) queueMicrotask(listener);
      return () => passwordRecoveryListeners.delete(listener);
    },

    async requestPasswordReset(emailInput) {
      if (!client) throw new Error("استعادة كلمة المرور تتطلب اتصالاً بـ Supabase.");
      const email = cleanText(emailInput, 160);
      if (!email) throw new Error("اكتب البريد الإلكتروني أولاً.");
      const redirectTo = `${window.location.origin}${window.location.pathname}?route=login&recovery=1`;
      const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo });
      if (error) throw new Error(translateAuthError(error.message));
    },

    async verifyPasswordRecoveryOtp(emailInput, tokenInput) {
      if (!client) throw new Error("استعادة كلمة المرور تتطلب اتصالاً بـ Supabase.");
      const email = cleanText(emailInput, 160);
      const token = cleanText(tokenInput, 12).replace(/\s+/g, "");
      if (!email) throw new Error("اكتب البريد الإلكتروني أولاً.");
      if (!/^\d{6,10}$/.test(token)) throw new Error("اكتب رمز الاستعادة الرقمي كاملاً كما ورد في الرسالة (من 6 إلى 10 أرقام).");
      const { data, error } = await client.auth.verifyOtp({ email, token, type: "recovery" });
      if (error) throw new Error(translateAuthError(error.message));
      if (!data?.session) throw new Error("تعذّر إنشاء جلسة استعادة كلمة المرور.");
      notifyPasswordRecovery();
      return normalizeSession(data.session);
    },

    async updateRecoveredPassword(passwordInput) {
      if (!client || !passwordRecoveryActive) throw new Error("جلسة استعادة كلمة المرور غير صالحة أو انتهت صلاحيتها.");
      const password = String(passwordInput || "");
      if (password.length < 10) throw new Error("استخدم كلمة مرور من 10 أحرف على الأقل.");
      const { error } = await client.auth.updateUser({ password });
      if (error) throw new Error(translateAuthError(error.message));
      passwordRecoveryActive = false;
    },

    async signIn(input) {
      if (!client) {
        const session = {
          provider: "local",
          name: cleanText(input.name, 80) || "موظف OZK",
          role: cleanText(input.role, 40) || "خدمة العملاء"
        };
        writeJson(SESSION_KEY, session);
        return { session };
      }

      const email = cleanText(input.email, 160);
      const password = String(input.password || "");
      if (!email || !password) throw new Error("اكتب البريد وكلمة المرور.");

      const { data, error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw new Error(translateAuthError(error.message));

      const session = normalizeSession(data.session);
      if (!session) throw new Error(missingSessionMessage());
      return { session };
    },

    async signInInventoryCounter(input) {
      if (!client) throw new Error("دخول موظف الجرد يتطلب اتصالاً بـ Supabase.");
      const result = await inventoryAuthRequest("login", {
        username: cleanText(input.username, 48),
        password: String(input.password || ""),
        deviceId: cleanText(input.deviceId, 160)
      }, false);
      const { data, error } = await client.auth.setSession({
        access_token: result.accessToken,
        refresh_token: result.refreshToken
      });
      if (error) throw new Error(translateAuthError(error.message));
      const session = normalizeSession(data.session);
      if (!session || session.accessRole !== "inventory_counter") {
        await client.auth.signOut({ scope: "local" });
        throw new Error("هذا الحساب ليس حساب موظف جرد.");
      }
      return { session };
    },

    async signUp(input) {
      if (!client) return this.signIn(input);

      const email = cleanText(input.email, 160);
      const password = String(input.password || "");
      if (!email || !password) throw new Error("اكتب البريد وكلمة المرور.");
      if (password.length < 8) throw new Error("كلمة المرور يجب أن تكون 8 أحرف على الأقل.");

      const { data, error } = await client.auth.signUp({
        email,
        password,
        options: {
          data: {
            display_name: cleanText(input.name, 80),
            role: cleanText(input.role, 40) || "خدمة العملاء"
          }
        }
      });
      if (error) throw new Error(translateDbError(error.message));

      return {
        session: normalizeSession(data.session),
        needsEmailConfirmation: !data.session
      };
    },

    async signOut() {
      if (client) {
        const { error } = await client.auth.signOut();
        if (error) throw new Error(translateDbError(error.message));
      }
      writeJson(SESSION_KEY, null);
    },

    async listRequests() {
      if (!client) return readJson(REQUESTS_KEY, defaultRequests);

      const session = await getSupabaseSession();
      if (!session) return [];

      const { data, error } = await client
        .from(tableName)
        .select("id, customer, channel, request_type, status, note, created_at, updated_at")
        .order("created_at", { ascending: false })
        .limit(100);

      if (error) throw new Error(translateDbError(error.message));
      return data.map(normalizeDbRequest);
    },

    async createRequest(input) {
      const request = {
        id: `REQ-${Date.now().toString().slice(-5)}`,
        publicId: `REQ-${Date.now().toString().slice(-5)}`,
        customer: cleanText(input.customer, 120) || "عميل جديد",
        channel: cleanText(input.channel, 40) || "ويب",
        type: cleanText(input.type, 60) || "طلب خدمة",
        status: "مفتوح",
        note: cleanText(input.note, 1000) || "لا توجد ملاحظات"
      };

      if (!client) {
        const requests = [request, ...readJson(REQUESTS_KEY, defaultRequests)];
        writeJson(REQUESTS_KEY, requests);
        return request;
      }

      const user = await requireUser();
      const { data, error } = await client
        .from(tableName)
        .insert({
          customer: request.customer,
          channel: request.channel,
          request_type: request.type,
          status: "open",
          note: request.note,
          created_by: user.id
        })
        .select("id, customer, channel, request_type, status, note, created_at, updated_at")
        .limit(1);

      if (error) throw new Error(translateDbError(error.message));
      return data?.[0] ? normalizeDbRequest(data[0]) : request;
    },

    async updateRequestStatus(id, status) {
      if (!client) {
        const requests = readJson(REQUESTS_KEY, defaultRequests).map((request) =>
          request.id === id ? { ...request, status } : request
        );
        writeJson(REQUESTS_KEY, requests);
        return;
      }

      await requireUser();
      const { error } = await client
        .from(tableName)
        .update({ status: toDbStatus(status), updated_at: new Date().toISOString() })
        .eq("id", id);

      if (error) throw new Error(translateDbError(error.message));
    },

    // تفاصيل الصنف (تكلفة + توزيع المستودعات) يرفعها tools/push-item-details.ps1.
    // جلب مستقل لأن listInventoryReports محدود بآخر 12 تقريراً وتقارير المزامنة
    // المتكررة كل 5 دقائق تزيح هذا التقرير خارجها.
    async getLatestItemDetailsReport() {
      if (!client) return null;
      const session = await getSupabaseSession();
      if (!session) return null;
      const { data, error } = await client
        .from(inventoryReportsTable)
        .select("summary, items, created_at")
        .eq("source", "ameen_item_details")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) return null; // ميزة عرض فقط — لا تُفشل تحميل الصفحة
      return data || null;
    },

    async listInventoryReports() {
      if (!client) {
        return readJson(INVENTORY_REPORTS_KEY, []).filter((report) => !["ameen_customer_balances", "ameen_customer_movements", "ameen_customer_invoices", "ameen_expenses"].includes(report.source));
      }

      const session = await getSupabaseSession();
      if (!session) return [];

      const { data, error } = await client
        .from(inventoryReportsTable)
        .select("id, report_date, source, summary, items, created_at")
        .not("source", "in", '("ameen_customer_balances","ameen_customer_movements","ameen_customer_invoices","ameen_expenses")')
        .order("created_at", { ascending: false })
        .limit(12);

      if (error) throw new Error(translateDbError(error.message));
      return data || [];
    },

    async listItemCosts() {
      // التكلفة محمية على مستوى القاعدة (RLS = is_owner). غير المدير يرجع له [] دائماً.
      if (!client) return [];
      const session = await getSupabaseSession();
      if (!session) return [];
      try {
        const { data, error } = await client
          .from(itemCostsTable)
          .select("item_guid, item_name, avg_cost, currency, updated_at");
        if (error) return [];
        return data || [];
      } catch {
        return [];
      }
    },

    async getCustomerMovementsReport() {
      if (!client) {
        const local = readJson(INVENTORY_REPORTS_KEY, []).filter((report) => report.source === "ameen_customer_movements");
        return local[0] || null;
      }

      const session = await getSupabaseSession();
      if (!session) return null;

      const { data, error } = await client
        .from(inventoryReportsTable)
        .select("id, report_date, source, summary, items, created_at")
        .eq("source", "ameen_customer_movements")
        .order("created_at", { ascending: false })
        .limit(1);

      if (error) throw new Error(translateDbError(error.message));
      return (data && data[0]) || null;
    },

    async getCustomerInvoicesReport() {
      // فواتير المبيعات لكل زبون مع محتوياتها (يكتبها push-customer-invoices.ps1). للموظفين فقط.
      if (!client) {
        const local = readJson(INVENTORY_REPORTS_KEY, []).filter((report) => report.source === "ameen_customer_invoices");
        return local[0] || null;
      }

      const session = await getSupabaseSession();
      if (!session) return null;

      const { data, error } = await client
        .from(inventoryReportsTable)
        .select("id, report_date, source, summary, items, created_at")
        .eq("source", "ameen_customer_invoices")
        .order("created_at", { ascending: false })
        .limit(1);

      if (error) throw new Error(translateDbError(error.message));
      return (data && data[0]) || null;
    },

    async getPurchaseInvoicesAmeenReport() {
      // فواتير المشتريات الحقيقية من الأمين لكل مورد مع محتوياتها (يكتبها
      // pull-purchase-invoices-from-ameen.ps1). قراءة فقط، من جدول مستقل محمي
      // (ameen_purchase_invoice_reports) وليس inventory_reports العام — البيانات
      // حساسة (موردون/أسعار/تكاليف/دفعات) ومحصورة بـRLS للمالك فقط. لا علاقة
      // بجدول purchase_invoices اليدوي (مسودة/معتمدة/مزامنة).
      if (!client) {
        const local = readJson(INVENTORY_REPORTS_KEY, []).filter((report) => report.source === "ameen_purchase_invoices");
        return local[0] || null;
      }

      const session = await getSupabaseSession();
      if (!session) return null;

      const { data, error } = await client
        .from(purchaseInvoiceReportsTable)
        .select("id, report_date, summary, items, created_at")
        .order("created_at", { ascending: false })
        .limit(1);

      if (error) throw new Error(translateDbError(error.message));
      return (data && data[0]) || null;
    },

    async getInvoiceSeriesReport() {
      // آخر رقم فاتورة لكل سلسلة ترقيم في الأمين (يكتبها push-invoice-series.ps1).
      // مصدر مستقل عن ameen_customer_invoices لأن ذاك يُسقِط الفواتير بلا اسم زبون
      // ولا يحمل نوع الفاتورة، فلا يصلح لمعرفة آخر رقم فعلي في كل سلسلة.
      if (!client) {
        const local = readJson(INVENTORY_REPORTS_KEY, []).filter((report) => report.source === "ameen_invoice_series");
        return local[0] || null;
      }

      const session = await getSupabaseSession();
      if (!session) return null;

      const { data, error } = await client
        .from(inventoryReportsTable)
        .select("id, report_date, source, summary, items, created_at")
        .eq("source", "ameen_invoice_series")
        .order("created_at", { ascending: false })
        .limit(1);

      if (error) throw new Error(translateDbError(error.message));
      return (data && data[0]) || null;
    },

    async getDailyMovementReport(date) {
      // تقرير ملخص الحركة اليومية ليوم محدد (أحدث نسخة لذلك اليوم). يحتاج جلسة.
      if (!client) return null;
      const session = await getSupabaseSession();
      if (!session) return null;

      let query = client
        .from(dailyMovementTable)
        .select("id, report_date, payload, created_at")
        .order("report_date", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(1);
      if (date) query = query.eq("report_date", date);

      const { data, error } = await query;
      if (error) throw new Error(translateDbError(error.message));
      return (data && data[0]) || null;
    },

    async listCustomerBalanceReports() {
      if (!client) {
        return readJson(INVENTORY_REPORTS_KEY, []).filter((report) => report.source === "ameen_customer_balances");
      }

      const session = await getSupabaseSession();
      if (!session) return [];

      const { data, error } = await client
        .from(inventoryReportsTable)
        .select("id, report_date, source, summary, items, created_at")
        .eq("source", "ameen_customer_balances")
        .order("created_at", { ascending: false })
        .limit(12);

      if (error) throw new Error(translateDbError(error.message));
      return data || [];
    },

    async listCustomerWhatsapp() {
      if (!client) return [];
      const session = await getSupabaseSession();
      if (!session) return [];
      const { data, error } = await client
        .from("customer_whatsapp")
        .select("customer_guid, customer_name, phone_number, region, customer_type, currency");
      if (error) return [];
      return data || [];
    },

    async createSharedDocument(doc) {
      if (!client) throw new Error("غير متصل بقاعدة البيانات.");
      const session = await getSupabaseSession();
      if (!session) throw new Error(missingSessionMessage());
      const { data, error } = await client
        .from("shared_documents")
        .insert({ doc })
        .select("id, public_token")
        .single();
      if (error) throw new Error(translateDbError(error.message));
      // public_token هو رمز المشاركة المعتمد (UUID كامل). id يبقى مفتاحاً داخلياً
      // ولا يصلح رمزاً للمشاركة: 10 خانات hex أي 40 بت فقط. أي رابط وصل يُبنى
      // مستقبلاً يستعمل ‎receipt.html?t=<public_token>‎ لا ‎?id=‎.
      return { id: data.id, token: data.public_token, publicUrl: `receipt.html?t=${data.public_token}` };
    },

    async listCustomerCreditLimits() {
      if (!client) return readJson(CUSTOMER_LIMITS_KEY, []);

      const session = await getSupabaseSession();
      if (!session) return [];

      const { data, error } = await client
        .from(creditLimitsTable)
        .select("id, customer_key, customer_name, credit_limit, notes, created_at, updated_at")
        .order("updated_at", { ascending: false })
        .limit(1000);

      if (error) throw new Error(translateDbError(error.message));
      return (data || []).map(normalizeDbCustomerLimit);
    },

    async upsertCustomerCreditLimit(input) {
      const payload = normalizeCustomerLimitInput(input);
      if (!payload.customer_key) throw new Error("لا يمكن حفظ حد زبون بدون مفتاح مطابق.");

      if (!client) {
        const current = readJson(CUSTOMER_LIMITS_KEY, []);
        const limit = {
          id: payload.customer_key,
          customerKey: payload.customer_key,
          customerName: payload.customer_name,
          creditLimit: payload.credit_limit,
          notes: payload.notes,
          updatedAt: payload.updated_at
        };
        const next = [limit, ...current.filter((item) => item.customerKey !== payload.customer_key)];
        writeJson(CUSTOMER_LIMITS_KEY, next);
        return limit;
      }

      const user = await requireUser();
      const { data, error } = await client
        .from(creditLimitsTable)
        .upsert(normalizeCustomerLimitInput(input, user.id), { onConflict: "customer_key" })
        .select("id, customer_key, customer_name, credit_limit, notes, created_at, updated_at")
        .limit(1);

      if (error) throw new Error(translateDbError(error.message));
      return data?.[0] ? normalizeDbCustomerLimit(data[0]) : normalizeDbCustomerLimit(payload);
    },

    // مصدر الحقيقة الوحيد لسعر صرف الليرة السورية. لا استخدام آخر لهذا السعر
    // في كامل المشروع (لا localStorage مستقل، لا scripts/exchange-rate.json)
    // سوى كقيمة افتراضية عند تعذّر الاتصال، ودائماً عبر readJson/writeJson هنا.
    async getSyriaExchangeRate() {
      if (!client) return readJson(SYRIA_EXCHANGE_RATE_CACHE_KEY, DEFAULT_SYRIA_EXCHANGE_RATE);

      const { data, error } = await client
        .from(exchangeRateTable)
        .select("syp_per_usd, updated_at")
        .eq("id", 1)
        .limit(1);

      if (error || !data?.[0]) {
        return readJson(SYRIA_EXCHANGE_RATE_CACHE_KEY, DEFAULT_SYRIA_EXCHANGE_RATE);
      }

      const rate = Number(data[0].syp_per_usd);
      if (!Number.isFinite(rate) || rate <= 0) {
        return readJson(SYRIA_EXCHANGE_RATE_CACHE_KEY, DEFAULT_SYRIA_EXCHANGE_RATE);
      }

      writeJson(SYRIA_EXCHANGE_RATE_CACHE_KEY, rate);
      return rate;
    },

    async setSyriaExchangeRate(rate) {
      const value = Number(rate);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("سعر الصرف يجب أن يكون رقماً موجباً.");
      }

      if (!client) {
        writeJson(SYRIA_EXCHANGE_RATE_CACHE_KEY, value);
        return value;
      }

      const user = await requireUser();
      const { data, error } = await client
        .from(exchangeRateTable)
        .upsert({ id: 1, syp_per_usd: value, updated_by: user.id }, { onConflict: "id" })
        .select("syp_per_usd")
        .limit(1);

      if (error) throw new Error(translateDbError(error.message));
      const saved = Number(data?.[0]?.syp_per_usd ?? value);
      writeJson(SYRIA_EXCHANGE_RATE_CACHE_KEY, saved);
      return saved;
    },

    async listApprovedPriceItems() {
      if (!client) return readJson(APPROVED_PRICES_KEY, []);

      const session = await getSupabaseSession();
      if (!session) return [];

      const { data, error } = await client
        .from(approvedPricesTable)
        .select("id, item_key, item_guid, item_name, item_number, item_code, sale_price, stock_qty, stock_status, unit1_name, unit2_name, unit2_factor, unit2_price, unit1_price, source_report_id, source_synced_at, price_payload, notes, approved_at, updated_at")
        .order("item_name", { ascending: true })
        .limit(5000);

      if (error) throw new Error(translateDbError(error.message));
      return (data || []).map(normalizeDbApprovedPrice);
    },

    async upsertApprovedPriceItems(items) {
      const payload = (items || [])
        .map((item) => normalizeApprovedPriceInput(item))
        .filter((item) => item.item_key && item.item_name && item.sale_price > 0);

      if (!payload.length) {
        throw new Error("لا توجد أسعار صالحة للحفظ.");
      }

      if (!client) {
        const normalized = payload.map((item) =>
          normalizeDbApprovedPrice({
            ...item,
            id: item.item_key,
            created_at: item.approved_at
          })
        );
        writeJson(APPROVED_PRICES_KEY, normalized);
        return normalized;
      }

      const user = await requireUser();

      // احفظ أرقام وأكواد الأصناف الحالية كي لا يمسحها الـ upsert.
      // بيانات الموقع لا تحمل أرقام الأمين، فنُعيد ربطها من الصفوف الحالية عبر item_key.
      let numberByKey = null; // null = تعذّر الجلب → لا نلمس item_number/item_code (نفس السلوك السابق)
      let codeByKey = null;
      try {
        const { data: existingRows, error: fetchErr } = await client
          .from(approvedPricesTable)
          .select("item_key, item_number, item_code")
          .limit(5000);
        if (!fetchErr) {
          numberByKey = {};
          codeByKey = {};
          for (const row of existingRows || []) {
            if (!row || !row.item_key) continue;
            if (row.item_number != null && String(row.item_number) !== "") {
              numberByKey[row.item_key] = row.item_number;
            }
            if (row.item_code != null && String(row.item_code) !== "") {
              codeByKey[row.item_key] = row.item_code;
            }
          }
        }
      } catch (_) { numberByKey = null; codeByKey = null; }

      const withUser = (items || [])
        .map((item) => normalizeApprovedPriceInput(item, user.id))
        .filter((item) => item.item_key && item.item_name && item.sale_price > 0)
        .map((rec) =>
          numberByKey
            ? { ...rec, item_number: numberByKey[rec.item_key] ?? null, item_code: codeByKey[rec.item_key] ?? null }
            : rec
        );
      const { data, error } = await client
        .from(approvedPricesTable)
        .upsert(withUser, { onConflict: "item_key" })
        // item_number وitem_code إلزاميان في الراجع: المتصل يستبدل الصنف في الذاكرة
        // بالكائن الراجع (app.js: priceMap.set)، فغيابهما يُفرغ الرقمين حتى إعادة
        // تحميل الصفحة فيتوقف البحث بالكود وبالرقم الداخلي (مانع رصدته المراجعة).
        .select("id, item_key, item_guid, item_name, item_number, item_code, sale_price, stock_qty, stock_status, unit1_name, unit2_name, unit2_factor, unit2_price, unit1_price, source_report_id, source_synced_at, price_payload, notes, approved_at, updated_at");

      if (error) throw new Error(translateDbError(error.message));
      return (data || []).map(normalizeDbApprovedPrice);
    },

    async replaceApprovedPriceItems(items) {
      const payload = (items || [])
        .map((item) => normalizeApprovedPriceInput(item))
        .filter((item) => item.item_key && item.item_name && item.sale_price > 0);

      if (!payload.length) {
        throw new Error("لا توجد أسعار صالحة للحفظ.");
      }

      if (!client) {
        const normalized = payload.map((item) =>
          normalizeDbApprovedPrice({
            ...item,
            id: item.item_key,
            created_at: item.approved_at
          })
        );
        writeJson(APPROVED_PRICES_KEY, normalized);
        return normalized;
      }

      const user = await requireUser();

      // احفظ أرقام وأكواد الأصناف الحالية قبل الحذف كي لا تُمسح عند إعادة الإدخال.
      // بيانات الموقع لا تحمل أرقام الأمين، فنُعيد ربطها من الصفوف الحالية عبر item_key.
      let numberByKey = null; // null = تعذّر الجلب → لا نلمس item_number/item_code (نفس السلوك السابق)
      let codeByKey = null;
      try {
        const { data: existingRows, error: fetchErr } = await client
          .from(approvedPricesTable)
          .select("item_key, item_number, item_code")
          .limit(5000);
        if (!fetchErr) {
          numberByKey = {};
          codeByKey = {};
          for (const row of existingRows || []) {
            if (!row || !row.item_key) continue;
            if (row.item_number != null && String(row.item_number) !== "") {
              numberByKey[row.item_key] = row.item_number;
            }
            if (row.item_code != null && String(row.item_code) !== "") {
              codeByKey[row.item_key] = row.item_code;
            }
          }
        }
      } catch (_) { numberByKey = null; codeByKey = null; }

      // أمان حاسم: هذا المسار يحذف كل الصفوف ثم يعيدها. إن فشل جلب الأرقام الحالية فسيمحو
      // الحذفُ item_number وitem_code بلا رجعة — لذا نُوقف الحفظ بأمان بدل تنفيذ حذف أعمى.
      // الأسعار والأرقام القديمة تبقى سليمة، ويظهر تحذيرٌ للمستخدم ليعيد المحاولة.
      if (!numberByKey || !codeByKey) {
        throw new Error("تعذّر تحضير الحفظ الآمن (فشل قراءة أرقام الأصناف الحالية). لم يُحذف شيء — حاول مجدداً.");
      }

      const withUser = (items || [])
        .map((item) => normalizeApprovedPriceInput(item, user.id))
        .filter((item) => item.item_key && item.item_name && item.sale_price > 0)
        .map((rec) => ({
          ...rec,
          item_number: numberByKey[rec.item_key] ?? null,
          item_code: codeByKey[rec.item_key] ?? null
        }));

      const { error: deleteError } = await client.from(approvedPricesTable).delete().neq("item_key", "__never__");
      if (deleteError) throw new Error(deleteError.message);

      const { data, error } = await client
        .from(approvedPricesTable)
        .insert(withUser)
        // نفس سبب المسار الآخر: الرقمان إلزاميان في الراجع وإلا فُرّغا في الذاكرة.
        .select("id, item_key, item_guid, item_name, item_number, item_code, sale_price, stock_qty, stock_status, unit1_name, unit2_name, unit2_factor, unit2_price, unit1_price, source_report_id, source_synced_at, price_payload, notes, approved_at, updated_at");

      if (error) throw new Error(translateDbError(error.message));
      return (data || []).map(normalizeDbApprovedPrice);
    },

    async listPaymentRecords(customerKey) {
      const key = String(customerKey || "").trim();
      if (!key) return [];
      if (!client) {
        return readJson("payment-records", []).filter((r) => r.customerKey === key);
      }
      const session = await getSupabaseSession();
      if (!session) return [];
      const { data, error } = await client
        .from(paymentRecordsTable)
        .select("id, customer_key, customer_name, amount, payment_date, notes, created_at")
        .eq("customer_key", key)
        .order("payment_date", { ascending: false })
        .limit(100);
      if (error) {
        if (error.code === "42P01") return [];
        throw new Error(error.message);
      }
      return (data || []).map(normalizeDbPaymentRecord);
    },

    async createPaymentRecord(input) {
      const record = {
        customerKey: cleanText(input.customerKey, 240),
        customerName: cleanText(input.customerName, 240),
        amount: Math.max(0, parseNumber(input.amount || 0)),
        paymentDate: String(input.paymentDate || new Date().toISOString().slice(0, 10)),
        notes: cleanText(input.notes, 500)
      };
      if (!record.amount) throw new Error("أدخل مبلغ دفعة صحيح.");
      if (!client) {
        const all = readJson("payment-records", []);
        const local = { id: `PR-${Date.now()}`, ...record, source: "manual", createdAt: new Date().toISOString() };
        writeJson("payment-records", [local, ...all].slice(0, 500));
        return local;
      }
      const user = await requireUser();
      const { data, error } = await client
        .from(paymentRecordsTable)
        .insert({ customer_key: record.customerKey, customer_name: record.customerName, amount: record.amount, payment_date: record.paymentDate, notes: record.notes, created_by: user.id })
        .select("id, customer_key, customer_name, amount, payment_date, notes, created_at")
        .limit(1);
      if (error) {
        if (error.code === "42P01") throw new Error("جدول payment_records غير موجود. شغّل SQL الإعداد في Supabase أولاً.");
        throw new Error(error.message);
      }
      return data?.[0] ? normalizeDbPaymentRecord(data[0]) : { id: `PR-${Date.now()}`, ...record, source: "manual" };
    },

    async listPurchaseInvoices() {
      if (!client) {
        return readJson(PURCHASE_INVOICES_KEY, []).map(normalizeDbPurchaseInvoice);
      }
      const session = await getSupabaseSession();
      if (!session) return [];
      const { data, error } = await client
        .from(purchaseInvoicesTable)
        .select(
          "id, supplier_name, supplier_ameen_guid, supplier_ameen_code, order_date, status, items, currency, pay_method, payment_amount, payment_date, payment_account, paid_total, remaining_total, idempotency_key, sync_attempts, sync_error, ameen_document_guid, ameen_document_number, synced_at, approved_by, approved_at, correction_count, correction_log, total, notes, created_at, updated_at"
        )
        .order("created_at", { ascending: false })
        .limit(300);
      if (error) {
        if (error.code === "42P01") return [];
        // الأعمدة الجديدة (تسلسل المزامنة) قد لا تكون مُطبَّقة بعد على قاعدة الإنتاج.
        if (error.code === "42703") {
          const fallback = await client
            .from(purchaseInvoicesTable)
            .select("id, supplier_name, order_date, status, items, total, notes, created_at, updated_at")
            .order("created_at", { ascending: false })
            .limit(300);
          if (fallback.error) throw new Error(translateDbError(fallback.error.message));
          return (fallback.data || []).map(normalizeDbPurchaseInvoice);
        }
        throw new Error(translateDbError(error.message));
      }
      return (data || []).map(normalizeDbPurchaseInvoice);
    },

    async listItemSnapshots() {
      if (!client) return [];
      const session = await getSupabaseSession();
      if (!session) return [];
      const { data, error } = await client
        .from(itemSnapshotTable)
        .select(
          "item_key, item_guid, item_number, item_name, unit1_name, unit2_name, unit2_factor, stock_unit1, last_purchase_price, last_purchase_date, last_purchase_currency, last_purchase_unit, average_cost, average_cost_currency, average_cost_basis, last_supplier_name, last_supplier_guid, movement_rank, units_sold_30d, generated_at"
        )
        .limit(5000);
      if (error) {
        if (error.code === "42P01") return []; // الجدول لم يُنشأ بعد على قاعدة الإنتاج — طبيعي قبل تطبيق SQL الجديد
        throw new Error(translateDbError(error.message));
      }
      return (data || []).map(normalizeDbItemSnapshot);
    },

    async createPurchaseInvoice(input) {
      const items = normalizePurchaseItems(input.items);
      const total = roundPrice(items.reduce((sum, item) => sum + item.qty * item.price, 0));
      const payMethod = input.payMethod === "cash" ? "cash" : "credit";
      const paymentAmount = Math.max(0, parseNumber(input.paymentAmount || 0));
      const paidTotal = input.registerPayment ? Math.min(paymentAmount, total) : 0;
      const record = {
        supplier_name: cleanText(input.supplierName, 240),
        supplier_ameen_guid: input.supplierAmeenGuid ? String(input.supplierAmeenGuid) : null,
        supplier_ameen_code: input.supplierAmeenCode ? cleanText(input.supplierAmeenCode, 60) : null,
        order_date: String(input.orderDate || new Date().toISOString().slice(0, 10)),
        status: "draft",
        items,
        currency: PO_CURRENCY_VALUES.includes(input.currency) ? input.currency : "USD",
        pay_method: payMethod,
        payment_amount: input.registerPayment ? paidTotal : 0,
        payment_date: input.registerPayment ? String(input.paymentDate || input.orderDate || new Date().toISOString().slice(0, 10)) : null,
        payment_account: input.registerPayment ? cleanText(input.paymentAccount, 120) : null,
        paid_total: paidTotal,
        remaining_total: roundPrice(total - paidTotal),
        idempotency_key: (window.crypto?.randomUUID ? window.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`),
        notes: cleanText(input.notes, 500),
        total
      };
      if (!record.supplier_name) throw new Error("اكتب اسم المورد أولاً.");
      if (!record.items.length) throw new Error("أضف صنفاً واحداً على الأقل مع كمية.");

      if (!client) {
        const all = readJson(PURCHASE_INVOICES_KEY, []);
        const local = {
          id: `local-${Date.now()}`,
          ...record,
          correction_count: 0,
          correction_log: [],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
        writeJson(PURCHASE_INVOICES_KEY, [local, ...all].slice(0, 300));
        return normalizeDbPurchaseInvoice(local);
      }

      const user = await requireUser();
      const { data, error } = await client
        .from(purchaseInvoicesTable)
        .insert({ ...record, created_by: user.id })
        .select(
          "id, supplier_name, supplier_ameen_guid, supplier_ameen_code, order_date, status, items, currency, pay_method, payment_amount, payment_date, payment_account, paid_total, remaining_total, idempotency_key, total, notes, created_at, updated_at"
        )
        .limit(1);
      if (error) {
        if (error.code === "42P01") throw new Error("جدول purchase_invoices غير موجود. شغّل SQL الإعداد في Supabase أولاً.");
        throw new Error(translateDbError(error.message));
      }
      return data?.[0] ? normalizeDbPurchaseInvoice(data[0]) : normalizeDbPurchaseInvoice(record);
    },

    async setPurchaseInvoiceStatus(id, nextStatus, extra = {}) {
      if (!PO_STATUS_VALUES.includes(nextStatus)) throw new Error("حالة فاتورة غير معروفة.");
      const patch = { status: nextStatus, updated_at: new Date().toISOString() };
      if (extra.approvedBy) patch.approved_by = extra.approvedBy;
      if (extra.approvedAt) patch.approved_at = extra.approvedAt;
      if (extra.syncError !== undefined) patch.sync_error = extra.syncError;
      if (!client) {
        const all = readJson(PURCHASE_INVOICES_KEY, []).map((row) =>
          row.id === id ? { ...row, ...patch } : row
        );
        writeJson(PURCHASE_INVOICES_KEY, all);
        return;
      }
      const user = await requireUser();
      // نختم مَن اعتمد الفاتورة ومتى تلقائياً هنا (وليس من app.js) — RLS على Supabase
      // هي الحاجز الفعلي الذي يقرر إن كان هذا المستخدم يملك صلاحية الاعتماد أصلاً.
      if (nextStatus === "approved" && !patch.approved_by) {
        patch.approved_by = user.id;
        patch.approved_at = new Date().toISOString();
      }
      const { error } = await client.from(purchaseInvoicesTable).update(patch).eq("id", id);
      if (error) throw new Error(translateDbError(error.message));
    },

    // إجراء تصحيحي على فاتورة "مُزامَنة" — لا حذف ولا تعديل حر، فقط قيد تصحيحي موثّق
    async correctPurchaseInvoice(id, note, patch = {}) {
      const cleanNote = cleanText(note, 500);
      if (!cleanNote) throw new Error("اكتب سبب الإجراء التصحيحي.");
      if (!client) {
        const all = readJson(PURCHASE_INVOICES_KEY, []).map((row) => {
          if (row.id !== id) return row;
          const log = Array.isArray(row.correction_log) ? row.correction_log : [];
          return {
            ...row,
            ...patch,
            correction_count: Number(row.correction_count || 0) + 1,
            correction_log: [...log, { note: cleanNote, at: new Date().toISOString() }],
            updated_at: new Date().toISOString()
          };
        });
        writeJson(PURCHASE_INVOICES_KEY, all);
        return;
      }
      const user = await requireUser();
      const { data: current, error: readErr } = await client
        .from(purchaseInvoicesTable)
        .select("correction_count, correction_log")
        .eq("id", id)
        .limit(1);
      if (readErr) throw new Error(translateDbError(readErr.message));
      const row = current?.[0] || {};
      const log = Array.isArray(row.correction_log) ? row.correction_log : [];
      const entry = { note: cleanNote, at: new Date().toISOString(), by: user.id };
      const { error } = await client
        .from(purchaseInvoicesTable)
        .update({
          ...patch,
          correction_count: Number(row.correction_count || 0) + 1,
          correction_log: [...log, entry],
          updated_at: new Date().toISOString()
        })
        .eq("id", id);
      if (error) throw new Error(translateDbError(error.message));
    },

    async deletePurchaseInvoice(id) {
      if (!client) {
        const all = readJson(PURCHASE_INVOICES_KEY, []).filter((row) => row.id !== id);
        writeJson(PURCHASE_INVOICES_KEY, all);
        return;
      }
      await requireUser();
      const { error } = await client.from(purchaseInvoicesTable).delete().eq("id", id);
      if (error) throw new Error(translateDbError(error.message));
    },

    async listCustomerProfiles() {
      if (!client) return readJson("customer-profiles", []);
      const session = await getSupabaseSession();
      if (!session) return [];
      const { data, error } = await client
        .from(customerProfilesTable)
        .select("id, customer_key, customer_name, phone, address, notes, updated_at")
        .order("updated_at", { ascending: false })
        .limit(1000);
      if (error) {
        if (error.code === "42P01") return [];
        throw new Error(error.message);
      }
      return (data || []).map(normalizeDbCustomerProfile);
    },

    async upsertCustomerProfile(input) {
      const profile = {
        customerKey: cleanText(input.customerKey, 240),
        customerName: cleanText(input.customerName, 240),
        phone: cleanText(input.phone, 40),
        address: cleanText(input.address, 240),
        notes: cleanText(input.notes, 500)
      };
      if (!profile.customerKey) throw new Error("لا يمكن حفظ بيانات زبون بدون مفتاح.");
      if (!client) {
        const all = readJson("customer-profiles", []);
        const idx = all.findIndex((p) => p.customerKey === profile.customerKey);
        const rec = { id: profile.customerKey, ...profile, updatedAt: new Date().toISOString() };
        if (idx >= 0) all[idx] = rec; else all.unshift(rec);
        writeJson("customer-profiles", all);
        return rec;
      }
      const user = await requireUser();
      const { data, error } = await client
        .from(customerProfilesTable)
        .upsert({ customer_key: profile.customerKey, customer_name: profile.customerName, phone: profile.phone, address: profile.address, notes: profile.notes, updated_at: new Date().toISOString(), updated_by: user.id }, { onConflict: "customer_key" })
        .select("id, customer_key, customer_name, phone, address, notes, updated_at")
        .limit(1);
      if (error) {
        if (error.code === "42P01") throw new Error("جدول customer_profiles غير موجود. شغّل SQL الإعداد في Supabase أولاً.");
        throw new Error(error.message);
      }
      return data?.[0] ? normalizeDbCustomerProfile(data[0]) : { id: profile.customerKey, ...profile, updatedAt: new Date().toISOString() };
    },

    async createInventoryReport(report) {
      const localReport = {
        id: report.id || `local-${Date.now()}`,
        report_date: report.reportDate,
        source: report.source || "ameen_excel",
        summary: report.summary || {},
        items: report.items || [],
        created_at: new Date().toISOString()
      };

      if (!client) {
        const reports = [localReport, ...readJson(INVENTORY_REPORTS_KEY, [])].slice(0, 12);
        writeJson(INVENTORY_REPORTS_KEY, reports);
        return localReport;
      }

      const user = await requireUser();
      const { data, error } = await client
        .from(inventoryReportsTable)
        .insert({
          report_date: localReport.report_date,
          source: localReport.source,
          summary: localReport.summary,
          items: localReport.items,
          created_by: user.id
        })
        .select("id, report_date, source, summary, items, created_at")
        .limit(1);

      if (error) throw new Error(translateDbError(error.message));
      return data?.[0] || localReport;
    },

    // ============================================================
    // الجرد الشهري (تسوية المخزون) — تسجيلي فقط. اعتماد الجلسة يقفل
    // السجل (status='approved') ولا يغيّر أي مخزون أو حساب في الأمين
    // أو Supabase. انظر tools/push-inventory-reconciliation-to-ameen.ps1
    // (stub مقفل بـ exit 1) وsupabase/inventory-reconciliation-table.sql.
    // ============================================================

    async listReconSessions() {
      if (!client) return [];
      const session = await getSupabaseSession();
      if (!session) return [];
      try {
        const { data, error } = await client
          .from(reconSessionsTable)
          .select("id, session_date, session_month, warehouse_key, warehouse_name, status, idempotency_key, notes, created_by, created_at, updated_at, reviewed_at, reviewed_by, approved_at, approved_by, source_report_id, source_report_date")
          .order("session_date", { ascending: false })
          .limit(50);
        if (error) return [];
        return data || [];
      } catch {
        return [];
      }
    },

    async getReconSession(sessionId) {
      if (!client || !sessionId) return null;
      const session = await getSupabaseSession();
      if (!session) return null;
      const { data: sessionRow, error: sessionError } = await client
        .from(reconSessionsTable)
        .select("id, session_date, session_month, warehouse_key, warehouse_name, status, idempotency_key, notes, created_by, created_at, updated_at, reviewed_at, reviewed_by, approved_at, approved_by, source_report_id, source_report_date")
        .eq("id", sessionId)
        .maybeSingle();
      if (sessionError) throw new Error(translateDbError(sessionError.message));
      if (!sessionRow) return null;

      // inventory_recon_lines_select أصبحت owner-only بحسب RLS — القراءة
      // تمر عبر RPC مقنَّعة (SECURITY DEFINER) تُخفي unit_cost/currency/
      // settlement_value لغير المالك بدل .from() المباشر الذي كان سيُرجع
      // صفوفاً فارغة تماماً لمنشئ الجلسة نفسه إن لم يكن هو المالك.
      const { data: lines, error: linesError } = await client.rpc("inventory_recon_lines_for_session", {
        p_session_id: sessionId
      });
      if (linesError) throw new Error(translateDbError(linesError.message));

      return { ...sessionRow, lines: lines || [] };
    },

    // يستدعي inventory_recon_create_session_with_lines (RPC) بدل طلبين منفصلين
    // (إنشاء جلسة ثم حفظ سطور) — بدون ذلك يترك انقطاع الشبكة بين الطلبين جلسة
    // فارغة محفوظة بلا سطور. الدالة تُدرج الجلسة والسطور ضمن معاملة واحدة على
    // الخادم وترفض أي محاولة إنشاء جلسة بلا سطر إطلاقاً.
    async createReconSessionWithLines(input, lines) {
      if (!client) throw new Error("إنشاء جلسة جرد يتطلب اتصالاً بـ Supabase.");
      await requireUser();

      const warehouseKey = cleanText(input.warehouseKey, 60);
      const idempotencyKey = cleanText(input.idempotencyKey, 200);
      if (!warehouseKey || !idempotencyKey) {
        throw new Error("لا يمكن إنشاء جلسة جرد بدون مستودع.");
      }
      if (!input.sourceReportId) {
        throw new Error("لا يمكن إنشاء جلسة جرد بدون تقرير مخزون مستودع موثوق.");
      }

      // لا تُرسَل system_qty/unit_cost/item_number/item_name/unit_name/currency من المتصفح:
      // الخادم يشتقّها داخل الـRPC من تقرير inventory_reports الموثوق (p_source_report_id)
      // وجدول item_costs — العميل يرسل فقط الكمية الفعلية والسبب.
      const rows = (Array.isArray(lines) ? lines : []).map((line) => ({
        item_key: line.itemKey,
        actual_qty: line.actualQty === "" || line.actualQty === undefined ? null : line.actualQty,
        reason: line.reason || null
      }));
      if (!rows.length) {
        throw new Error("أضف صنفاً واحداً على الأقل قبل الحفظ.");
      }

      const { data, error } = await client.rpc("inventory_recon_create_session_with_lines", {
        p_session_date: input.sessionDate,
        p_session_month: input.sessionMonth,
        p_warehouse_key: warehouseKey,
        p_warehouse_name: cleanText(input.warehouseName, 120),
        p_notes: cleanText(input.notes, 500),
        p_idempotency_key: idempotencyKey,
        p_source_report_id: input.sourceReportId,
        p_lines: rows
      });

      if (error) throw new Error(translateDbError(error.message));
      return data || null;
    },

    // كل الكتابة على inventory_recon_sessions مقفلة عن authenticated (SELECT
    // فقط)؛ التحديث الوحيد المسموح يمر عبر RPC بـSECURITY DEFINER
    // (inventory_recon_set_status) الذي يتحقق من auth.uid() ويحدّث بشرط
    // status=expectedStatus ذرياً، بينما trigger inventory_recon_guard_immutable
    // يفرض صحة الانتقال وحصر الاعتماد بالمالك ويختم reviewed_by/approved_by
    // من الخادم حصراً — لا حاجة لإرسال أي من ذلك من العميل.
    async setReconSessionStatus(sessionId, nextStatus, expectedStatus) {
      if (!client) throw new Error("تحديث حالة جلسة الجرد يتطلب اتصالاً بـ Supabase.");
      const canTransition = window.invRecCalc && typeof window.invRecCalc.canTransitionStatus === "function"
        ? window.invRecCalc.canTransitionStatus(expectedStatus, nextStatus)
        : true;
      if (!canTransition) {
        throw new Error("لا يمكن الانتقال إلى هذه الحالة من الحالة الحالية.");
      }
      await requireUser();

      const { error } = await client.rpc("inventory_recon_set_status", {
        p_session_id: sessionId,
        p_next_status: nextStatus,
        p_expected_status: expectedStatus
      });

      if (error) throw new Error(translateDbError(error.message));
    },

    // حذف مسودة جرد — يمر حصراً عبر inventory_recon_delete_draft (SECURITY
    // DEFINER) الذي يقفل الصف ويتحقق من status='draft' والملكية قبل الحذف؛
    // مسموح فقط بحذف draft، وreviewed/approved تُرفض من داخل الدالة نفسها.
    async deleteReconDraft(sessionId) {
      if (!client) throw new Error("حذف مسودة الجرد يتطلب اتصالاً بـ Supabase.");
      await requireUser();

      const { error } = await client.rpc("inventory_recon_delete_draft", {
        p_session_id: sessionId
      });

      if (error) throw new Error(translateDbError(error.message));
    },

    // مخزون النظام حسب المستودع — يُرفع بواسطة tools/push-ameen-warehouse-stock.ps1
    // إلى جدول ameen_warehouse_stock_reports المستقل (مراجعة Codex على PR #40،
    // الجولة الثانية — كتابة محصورة بحساب المزامنة الموثوق عبر RLS)،
    // تقرير مستقل لكل مستودع حقيقي بالأمين.
    async getLatestWarehouseStockReport(warehouseKey) {
      if (!client) return null;
      const session = await getSupabaseSession();
      if (!session) return null;
      // نجلب أحدث بضع تقارير عامة ثم نختار أحدث تقرير يطابق المستودع فعلياً —
      // بما أن warehouse_key مخزّن داخل summary (JSON) لا كعمود مفهرس مستقل،
      // لا يمكن تصفيته بـ.eq() على مستوى الاستعلام مباشرة.
      const { data, error } = await client
        .from(warehouseStockReportsTable)
        .select("id, summary, items, created_at")
        .order("created_at", { ascending: false })
        .limit(20);
      if (error || !data) return null;
      if (!warehouseKey) return data[0] || null;
      return data.find((row) => row.summary && row.summary.warehouseKey === warehouseKey) || null;
    },

    // يجلب كل التقارير الحديثة بطلب شبكة واحد ثم يحتفظ بأحدث تقرير لكل GUID.
    // مخصص لصفحة المستودعات كي لا تنفذ طلباً منفصلاً لكل مستودع على الموبايل.
    async listLatestWarehouseStockReports() {
      if (!client) return [];
      const session = await getSupabaseSession();
      if (!session) return [];
      const { data, error } = await client
        .from(warehouseStockReportsTable)
        .select("id, summary, items, created_at")
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw new Error(translateDbError(error.message));
      const latestByWarehouse = new Map();
      for (const report of data || []) {
        const key = report.summary && report.summary.warehouseKey;
        if (key && !latestByWarehouse.has(key)) latestByWarehouse.set(key, report);
      }
      return Array.from(latestByWarehouse.values());
    },

    // قائمة المستودعات الحقيقية المتاحة للجرد — مبنية من أحدث تقارير
    // ameen_warehouse_stock فعلياً، وليست ثابتة بالكود؛ لا تُخترَع أي قيمة
    // "جملة"/"مركز عام" هنا. المفتاح الموثوق هو GUID المستودع بالأمين.
    async listReconWarehouses() {
      if (!client) return [];
      const session = await getSupabaseSession();
      if (!session) return [];
      const { data, error } = await client
        .from(warehouseStockReportsTable)
        .select("summary, created_at")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error || !data) return [];
      const byKey = new Map();
      for (const row of data) {
        const key = row.summary && row.summary.warehouseKey;
        const name = row.summary && row.summary.warehouseName;
        if (!key || !name || byKey.has(key)) continue;
        byKey.set(key, { warehouseKey: key, warehouseName: name, createdAt: row.created_at });
      }
      return Array.from(byKey.values()).sort((a, b) => a.warehouseName.localeCompare(b.warehouseName, "ar"));
    },

    // أحدث تقرير مناقلات مستودعات موثوق. يحتوي كل عنصر على مستودع المصدر
    // والوجهة والبنود بعد تحقق سكربت القراءة من توازن طرفي المناقلة.
    async getLatestWarehouseTransferReport() {
      if (!client) return null;
      const session = await getSupabaseSession();
      if (!session) return null;
      const { data, error } = await client
        .from(warehouseTransferReportsTable)
        .select("id, report_date, summary, items, created_at")
        .order("created_at", { ascending: false })
        .limit(1);
      if (error) throw new Error(translateDbError(error.message));
      return (data && data[0]) || null;
    },

    // المساعد المالي يستدعي Edge Function محمية بجلسة الموظف. مفاتيح مزودي
    // الذكاء الاصطناعي وقراءة التقارير الحساسة تبقى على الخادم ولا تصل للمتصفح.
    async askFinancialAssistant(messages, provider = "chatgpt") {
      if (!client) throw new Error("المساعد المالي يتطلب اتصالاً آمناً بـ Supabase.");
      const { data: sessionData, error: sessionError } = await client.auth.getSession();
      if (sessionError) throw new Error(translateAuthError(sessionError.message));
      const accessToken = sessionData?.session?.access_token;
      if (!accessToken) throw new Error(missingSessionMessage());

      const response = await fetch(`${config.url.replace(/\/$/, "")}/functions/v1/financial-assistant`, {
        method: "POST",
        headers: {
          apikey: config.publishableKey,
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          provider: provider === "claude" ? "claude" : "chatgpt",
          messages: (Array.isArray(messages) ? messages : []).slice(-12)
        })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const errors = {
          forbidden: "هذا المساعد المالي متاح للحسابات الإدارية المخوّلة فقط.",
          unauthorized: "انتهت جلسة الدخول. سجّل الدخول مجدداً.",
          openai_not_configured: "مفتاح OpenAI غير مضبوط في أسرار الخادم.",
          anthropic_not_configured: "مفتاح Anthropic غير مضبوط في أسرار الخادم.",
          empty_message: "اكتب سؤالك أولاً."
        };
        throw new Error(errors[payload.error] || "تعذر الحصول على إجابة من المساعد المالي.");
      }
      return payload;
    },

    // الجرد الذكي: كل payload للموظف يأتي من RPC لا تضم expected_qty أو الفرق.
    async listSmartInventoryWarehouses(date = null) {
      return inventoryRpc("smart_inventory_available_warehouses", { p_date: date || null });
    },

    async startOrJoinSmartInventory(warehouseKey) {
      return inventoryRpc("smart_inventory_start_or_join", { p_warehouse_key: cleanText(warehouseKey, 120) });
    },

    async getSmartInventoryCounterSession(sessionId) {
      return inventoryRpc("smart_inventory_counter_session", { p_session_id: sessionId });
    },

    async claimSmartInventoryItem(itemId) {
      return inventoryRpc("smart_inventory_claim_item", { p_item_id: itemId });
    },

    async saveSmartInventoryItem(input) {
      return inventoryRpc("smart_inventory_save_item", {
        p_item_id: input.itemId,
        p_request_id: input.requestId,
        p_count_state: input.countState,
        p_unit1_qty: input.unit1Qty ?? 0,
        p_unit2_qty: input.unit2Qty ?? 0,
        p_damaged_unit1_qty: input.damagedUnit1Qty ?? 0,
        p_expected_version: input.expectedVersion ?? null
      });
    },

    async completeSmartInventorySession(sessionId) {
      return inventoryRpc("smart_inventory_complete_session", { p_session_id: sessionId });
    },

    async getSmartInventoryOwnerDashboard(date = null) {
      return inventoryRpc("smart_inventory_owner_dashboard", { p_date: date || null });
    },

    async getSmartInventoryOwnerReport(sessionId) {
      return inventoryRpc("smart_inventory_owner_report", { p_session_id: sessionId });
    },

    async openSmartInventoryRecount(itemId, reason) {
      return inventoryRpc("smart_inventory_owner_open_recount", { p_item_id: itemId, p_reason: cleanText(reason, 500) });
    },

    async reopenSmartInventorySession(sessionId, reason) {
      return inventoryRpc("smart_inventory_owner_reopen_session", { p_session_id: sessionId, p_reason: cleanText(reason, 500) });
    },

    async correctSmartInventoryItem(itemId, actualQtyUnit1, reason) {
      return inventoryRpc("smart_inventory_owner_correct_item", {
        p_item_id: itemId,
        p_actual_qty_unit1: actualQtyUnit1,
        p_reason: cleanText(reason, 500)
      });
    },

    async listInventoryCounterAccounts() {
      return inventoryAuthRequest("list_accounts");
    },

    async createInventoryCounterAccount(input) {
      return inventoryAuthRequest("create_account", input);
    },

    async updateInventoryCounterAccount(action, input) {
      return inventoryAuthRequest(action, input);
    }
  };

  window.tobaccoData = service;
})();
