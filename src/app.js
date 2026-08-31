const appConfig = window.appConfig;
const roadmapItems = window.roadmapItems;
const monitoringCards = window.monitoringCards;
const remoteServices = window.remoteServices;
const dataStore = window.tobaccoData;
const RECON_PENDING_SAVE_KEY_PREFIX = "ozk_recon_pending_save";

// مفتاح localStorage منفصل لكل مستخدم — جهازان يستعملان نفس المتصفح (أو
// نفس المستخدم بعد تسجيل خروج/دخول بحساب آخر) يجب ألا يتشاركا idempotency
// key بصمة أحدهما، وإلا أعاد أحدهما استعمال مفتاح الآخر بالخطأ.
function reconPendingSaveKey(userId) {
  return `${RECON_PENDING_SAVE_KEY_PREFIX}:${userId || "anon"}`;
}

function safeErrorMessage(error) {
  const msg = String(error?.message ?? "");
  console.error("[OZK Error]", msg);
  if (/لا توجد جلسة|سجل الدخول|كلمة المرور|البريد|تأكيد|مصادقة/.test(msg)) return msg;
  if (/لا يمكن حفظ|لا توجد أسعار|لا توجد طلبات|لا يوجد جرد/.test(msg)) return msg;
  if (/fetch|ECONNREFUSED|ENOTFOUND|network|Failed to fetch/i.test(msg))
    return "تعذر الاتصال بالخادم. تحقق من اتصالك بالإنترنت.";
  if (/401|403|unauthorized|permission|denied/i.test(msg))
    return "ليس لديك صلاحية لتنفيذ هذه العملية.";
  if (/pgrst|postgres|supabase|relation|column|database|sql/i.test(msg))
    return "حدث خطأ في قاعدة البيانات. حاول مجدداً أو تواصل مع الدعم.";
  if (msg.length > 120 || /Error:|\.js:\d+|at \w+\s/i.test(msg))
    return "حدث خطأ غير متوقع. حاول مجدداً.";
  return msg || "حدث خطأ غير متوقع.";
}

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

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    };
    return entities[char];
  });
}

function formValue(form, name) {
  return String(new FormData(form).get(name) || "").trim();
}

function csvCell(value) {
  const text = String(value ?? "").replace(/\r?\n/g, " ").replace(/"/g, '""');
  return `"${text}"`;
}

function normalizeItemName(value) {
  const normalized = String(value ?? "")
    .trim()
    .replace(/^\d{2,}\s*[-–—]\s*/u, "")
    .replace(/[ـًٌٍَُِّْ]/gu, "")
    .replace(/[إأآٱ]/gu, "ا")
    .replace(/ى/gu, "ي")
    .replace(/ة/gu, "ه")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  // الاسمان القديمان في الموقع يقابلان الاسمين الجديدين في الأمين.
  // إبقاء alias هنا يمنع انقطاع المخزون أو السعر عند وجود سجل قديم في Supabase.
  const aliases = new Map([
    ["كابتن بلاك كوين ازرق", "كابتن بلاك كور ازرق جديد"],
    ["كابتن بلاك كوين اسود", "كابتن بلاك كور اسود جديد"]
  ]);
  return aliases.get(normalized) || normalized;
}

function normalizeNumericText(value, options = {}) {
  const { allowNegative = true, allowDecimal = true } = options;
  let text = String(value ?? "")
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[٫،]/g, ".")
    .replace(/\s+/g, "")
    .trim();

  const commaCount = (text.match(/,/g) || []).length;
  if (allowDecimal && !text.includes(".") && commaCount === 1) {
    const [, decimalPart = ""] = text.split(",");
    if (/^\d{1,2}$/.test(decimalPart)) {
      text = text.replace(",", ".");
    }
  }

  text = text.replace(/,/g, "").replace(/[^\d.-]/g, "");
  const isNegative = allowNegative && text.includes("-");
  text = text.replace(/-/g, "");

  if (!allowDecimal) {
    text = text.replace(/\./g, "");
  } else {
    const parts = text.split(".");
    text = `${parts.shift() || ""}${parts.length ? `.${parts.join("")}` : ""}`;
    if (text.startsWith(".")) text = `0${text}`;
  }

  return isNegative && text ? `-${text}` : text;
}

function toNumber(value) {
  const text = normalizeNumericText(value);
  if (!text) return 0;
  const number = Number(text);
  return Number.isFinite(number) ? number : 0;
}

function roundPrice(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return 0;
  return Math.round((number + Number.EPSILON) * 1000) / 1000;
}

function toPositivePrice(value) {
  return Math.max(0, roundPrice(toNumber(value)));
}

function samePrice(left, right) {
  return Math.abs(roundPrice(left) - roundPrice(right)) <= 0.005;
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function formatDateTime(value) {
  if (!value) return "غير معروف";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("en-GB-u-ca-gregory-nu-latn", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function formatDate(value) {
  if (!value) return "غير متوفر";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("en-GB-u-ca-gregory-nu-latn", {
    dateStyle: "medium"
  }).format(date);
}

function sourceLabel(source) {
  return (
    {
      ameen_sql_agent: "مزامنة مباشرة من الأمين",
      ameen_excel: "ملف إكسل من الأمين"
    }[source] || source || "غير معروف"
  );
}

function minutesSince(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
}

function syncFreshnessLabel(value) {
  const minutes = minutesSince(value);
  if (minutes === null) return "لم يتم تحديد وقت المزامنة";
  if (minutes <= 2) return "محدث الآن";
  if (minutes < 60) return `قبل ${minutes} دقيقة`;
  return `قبل ${Math.round(minutes / 60)} ساعة`;
}

const allowedRoutes = new Set(["overview", "login", "requests", "ameen", "balances", "pricing", "remote", "monitoring", "payments", "purchases", "sales", "warehouses", "inventoryRecon", "smartInventory", "staff", "search", "ai", "dashboard"]);

const customerPriceContacts = [
  { label: "هاتف المبيعات", value: "0985000771" },
  { label: "واتساب", value: "0984000662" },
  { label: "رقم المركز", value: "0994092038" }
];

function initialRoute() {
  const requestedRoute = new URLSearchParams(window.location.search).get("route");
  return allowedRoutes.has(requestedRoute) ? requestedRoute : "overview";
}

const state = {
  route: initialRoute(),
  installPrompt: null,
  completed: new Set(readJson("completed-items", [])),
  session: null,
  requests: [],
  inventoryReports: [],
  customerBalanceReports: [],
  customerMovementsReport: null,
  customerInvoicesReport: null,
  invoiceSeriesReport: null,   // آخر رقم فاتورة لكل سلسلة ترقيم في الأمين
  customerWhatsapp: [],
  broadcastType: "",
  broadcastText: "",
  customerCreditLimits: [],
  customerLimitError: null,
  approvedPriceItems: [],
  approvedPriceError: null,
  itemCosts: [],
  paymentRecords: {},
  paymentError: null,
  lastInventoryRefresh: null,
  priceExport: null,
  ameenSearch: "",
  ameenFilter: "alerts",
  ameenSort: "qtyAsc",
  pricingSearch: "",
  bulletinStatus: null,
  customerSearch: "",
  customerFilter: "debit_balance",
  customerSort: "balanceDesc",
  selectedCustomerKey: "",
  dailyMovement: null,
  dailyMovementDate: "",
  dailyMovementLoading: false,
  dailyMovementError: null,
  dmFetchedFor: null,
  loading: true,
  startupDegraded: false,
  notice: null,
  passwordResetMode: new URLSearchParams(window.location.search).get("recovery") === "code",
  passwordResetEmail: "",
  aiMessages: [],
  aiProvider: "claude",
  aiLoading: false,
  aiSettingsOpen: false,
  // ===== فاتورة مبيعات (route: sales) — نواة MVP =====
  salesMode: readJson("sales-mode", "jumla"),        // "jumla" جملة/دولار | "mufrak" مفرق/سوري
  salesCustomer: "",                                    // فارغ = زبون نقدي
  salesPayMethod: "cash",                               // "cash" نقدي | "credit" أجل
  salesDiscount: "",
  salesPaid: "",
  salesInvoiceNo: "",
  salesInvoiceNoMode: "",  // الوضع الذي حُسب له الرقم — تبديل الوضع يبدّل السلسلة
  salesSavedNo: "",
  salesSaving: false,
  salesInfoKey: "",        // مفتاح الصنف المفتوحة بطاقته (فارغ = مغلقة)
  salesHistoryOpen: false, // شاشة «الفواتير السابقة» مفتوحة بدل نموذج الفاتورة
  salesHistoryQuery: "",   // بحث القائمة (اسم زبون أو رقم فاتورة)
  salesHistoryFocus: false, // أعِد التركيز لحقل البحث بعد إعادة الرسم
  itemDetails: null,       // خريطة مفتاح ← تفاصيل (تكلفة/مستودعات) من تقرير الأمين
  itemDetailsAt: "",       // وقت التقرير — يُعرض كي يعرف المستخدم حداثة الأرقام
  salesRows: [{ q: "", key: "", name: "", num: "", unit: "unit2", qty: "1", price: "", edited: false }],
  // ===== فاتورة مشتريات (route: purchases) — مسودة/معتمدة/بانتظار مزامنة/مُزامَنة/فشلت =====
  purchaseInvoices: [],
  poItemSnapshots: [],     // تخزين مؤقت للقطة أصناف الأمين (فارغة عملياً حتى تفعيل push-purchase-item-snapshot.ps1)
  poItemSnapshotsAt: "",
  poSupplierQuery: "",
  poSupplierKey: "",       // supplier_ameen_code إن وُجد — لا يوجد لائحة موردين حقيقية بعد
  poSupplierGuid: "",
  poDate: "",
  poNotes: "",
  poCurrency: "USD",       // USD | SYP — بلا تحويل ضمني إطلاقاً
  poPayMethod: "credit",   // cash نقدي | credit آجل
  poRegisterPayment: false,
  poPaymentAmount: "",
  poPaymentDate: "",
  poPaymentAccount: "",
  poPaymentError: "",
  poRows: [{ q: "", key: "", name: "", num: "", unit: "unit2", qty: "1", price: "", edited: false }],
  poInfoKey: "",           // مفتاح الصنف المفتوحة بطاقته
  poSaving: false,
  poOpenId: "",
  poCorrectionOpenId: "",  // فاتورة "مُزامَنة" قيد إجراء تصحيحي
  poCorrectionNote: "",
  // ===== فواتير مشتريات الأمين — عرض قراءة فقط (لا علاقة بنموذج المسودة أعلاه) =====
  poAmeenReport: null,     // آخر تقرير من جدول ameen_purchase_invoice_reports المحمي (يكتبه pull-purchase-invoices-from-ameen.ps1)
  poAmeenSupplierQuery: "",
  poAmeenSupplierName: "", // المورد المختار حالياً للتصفح
  poAmeenNavIndex: 0,      // فهرس الفاتورة الحالية ضمن فواتير المورد المختار (0 = الأحدث)
  poAmeenItemQuery: "",    // بحث داخل بنود الفاتورة الحالية برقم/اسم المادة
  // ===== الجرد الشهري (route: inventoryRecon) — تسجيلي فقط: لا يغيّر مخزوناً أو حساباً =====
  reconSessions: [],
  // لا مستودع افتراضي ثابت — يُختار من قائمة مستودعات الأمين الحقيقية فقط
  // (state.reconWarehouses)، بمفتاح GUID. لا يوجد "جملة"/"مركز" مخترَع.
  reconWarehouseKey: "",
  reconWarehouseName: "",
  reconWarehouses: [],            // [{warehouseKey, warehouseName, createdAt}] من listReconWarehouses()
  reconWarehousesLoading: false,
  reconSessionDate: "",
  reconSessionMonth: "",
  reconNotes: "",
  reconRows: [],
  reconRowQuery: "",
  reconSaving: false,
  reconOpenId: "",
  reconWarehouseStockMap: null,   // itemKey -> qty من تقرير مخزون المستودع الموثوق (null = غير متوفر بعد)
  reconWarehouseStockItems: null, // مصفوفة أصناف المستودع نفسه (name/number/unit/qty) — null = لا تقرير، [] = تقرير فارغ
  reconWarehouseStockLoading: false,
  reconWarehouseStockGeneratedAt: null, // وقت توليد التقرير (summary.generated_at) — لكشف التقادم
  // ===== المستودعات والمناقلات (عرض قراءة فقط من Ameen) =====
  warehouseReports: {},
  warehouseSelectedKey: "",
  warehouseSearch: "",
  warehouseShowZero: false,
  warehouseTransferReport: null,
  warehouseLoading: false,
  notifPermission: "default",
  seenRequestIds: new Set(),
  globalSearch: "",
  syriaCurrency: "USD",
  syriaExchangeRate: readJson("syria-exchange-rate", 14050),
  syriaRateConfirmed: false,
  bulletinPdfTheme: readJson("bulletin-pdf-theme", "dark") === "light" ? "light" : "dark",
  openSections: {},
  priceMode: readJson("price-mode", "jumla"),
  showExchangeModal: false,
  pricePreview: null
};

const app = document.querySelector("#app");

function enterPasswordRecovery() {
  if (!dataStore.isPasswordRecovery?.()) return;
  state.route = "login";
  state.notice = null;
  render();
}

dataStore.onPasswordRecovery?.(enterPasswordRecovery);

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  state.installPrompt = event;
  render();
});

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", () => {
    // التسجيل من الجذر ليغطي النطاق الموقع كاملاً؛ التسجيل القديم بنطاق public/ يُزال
    navigator.serviceWorker.getRegistrations()
      .then((regs) => regs.forEach((reg) => { if (reg.scope.includes("/public/")) reg.unregister(); }))
      .catch(() => {});
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  });
}

function setNotice(type, text) {
  state.notice = { type, text };
}

function notifSupported() {
  return "Notification" in window;
}

async function requestNotifPermission() {
  if (!notifSupported()) return;
  const result = await Notification.requestPermission();
  state.notifPermission = result;
  render();
}

function fireRequestNotif(customerName) {
  if (!notifSupported() || Notification.permission !== "granted") return;
  const opts = { body: `طلب جديد من ${customerName}`, icon: "public/icons/app-icon.png", dir: "rtl", lang: "ar" };
  if (navigator.serviceWorker?.controller) {
    navigator.serviceWorker.ready
      .then((reg) => reg.showNotification("OZK TOBACCO", opts))
      .catch(() => new Notification("OZK TOBACCO", opts));
  } else {
    new Notification("OZK TOBACCO", opts);
  }
}

function applyTheme() {
  document.documentElement.dataset.theme = state.darkMode ? "dark" : "light";
  writeJson("dark-mode", state.darkMode);
}

let shortcutsInitialized = false;
function initKeyboardShortcuts() {
  if (shortcutsInitialized) return;
  shortcutsInitialized = true;
  document.addEventListener("keydown", (event) => {
    const typing = document.activeElement?.matches("input, textarea, select, [contenteditable]");
    if (event.altKey && !event.ctrlKey && !event.metaKey) {
      // كل قيمة هنا يجب أن تكون صفحة مسجّلة فعلاً في pages وفي allowedRoutes،
      // وإلا رمى الرسم TypeError صامتاً. يحرسه scripts/check-keyboard-shortcut-routes.mjs.
      const routeMap = { "1": "overview", "2": "dashboard", "3": "requests", "4": "ameen", "5": "pricing", "7": "purchases", "8": "balances", "9": "sales" };
      const target = routeMap[event.key];
      if (target) {
        event.preventDefault();
        if ((target === "dashboard" || target === "purchases" || target === "sales") && !state.session) return;
        setRoute(target);
        render();
        return;
      }
      if (event.key === "t" || event.key === "T") {
        event.preventDefault();
        state.darkMode = !state.darkMode;
        applyTheme();
        render();
        return;
      }
    }
    if (!typing) {
      if (event.key === "/" && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        app.querySelector(".search-input")?.focus();
      }
      if (event.key === "Escape") {
        if (state.aiSettingsOpen) { state.aiSettingsOpen = false; render(); }
        else if (state.selectedCustomerKey) { state.selectedCustomerKey = ""; render(); }
      }
    }
  });
}

function notifPermissionBanner() {
  if (!state.session || !notifSupported() || state.notifPermission !== "default") return "";
  return `
    <section class="notice-panel warning notif-banner">
      <span><strong>إشعارات الطلبات</strong> — فعّل الإشعارات لتصلك تنبيهات فورية عند وصول طلب جديد.</span>
      <button class="button primary" type="button" data-action="enable-notif">تفعيل</button>
    </section>
  `;
}

const STARTUP_TIMEOUT_MS = 12000;

async function boot() {
  applyTheme();
  initKeyboardShortcuts();
  state.loading = true;
  state.startupDegraded = false;
  const startupTimeout = window.setTimeout(() => {
    if (!state.loading) return;
    if (!state.session) state.route = "overview";
    state.loading = false;
    state.startupDegraded = true;
    render();
  }, STARTUP_TIMEOUT_MS);

  try {
    if (dataStore.isPasswordRecovery?.()) state.route = "login";
    await loadPublishedExchangeRate();
    await refreshSession();
    if (dataStore.isPasswordRecovery?.()) {
      state.route = "login";
      return;
    }
    // Counter accounts receive only the smart-inventory RPC payload. Do not
    // start any legacy loader that could place Ameen stock, prices, balances,
    // invoices or reconciliation differences in browser state.
    if (isInventoryCounter()) {
      state.route = "smartInventory";
      window.__ozkSession = state.session;
      await window.SmartInventory?.load(state.session);
      return;
    }
    await loadRequests();
    await loadInventoryReports();
    await loadCustomerBalanceReports();
    await loadCustomerCreditLimits();
    await loadApprovedPriceItems();
    await loadCustomerProfiles();
    await loadPurchaseInvoices();
    await loadReconSessions();
    await loadWarehouseDashboard();
    state.seenRequestIds = new Set(state.requests.map((r) => r.id));
    state.notifPermission = notifSupported() ? Notification.permission : "denied";
    state.startupDegraded = false;
    const overdue = overdueCustomers();
    if (overdue.length > 0) fireOverdueNotif(overdue.length);
  } catch (error) {
    state.startupDegraded = true;
    setNotice("error", `تعذر تحميل بعض البيانات: ${safeErrorMessage(error)}`);
  } finally {
    window.clearTimeout(startupTimeout);
    state.loading = false;
    render();
  }
}

// مصدر الحقيقة الوحيد لسعر الصرف: جدول Supabase bulletin_exchange_rate (عبر
// dataStore.getSyriaExchangeRate). لا ملف JSON، ولا قيمة "معلّقة" منفصلة —
// المعاينة وPDF يقرآن نفس هذه القيمة دائماً.
async function loadPublishedExchangeRate() {
  try {
    const rate = await dataStore.getSyriaExchangeRate();
    if (Number.isFinite(rate) && rate > 0) {
      state.syriaExchangeRate = rate;
      writeJson("syria-exchange-rate", rate);
    }
  } catch {}
}

async function refreshSession() {
  try {
    state.session = await dataStore.getSession();
    window.__ozkSession = state.session;
    if (isInventoryCounter()) state.route = "smartInventory";
    else if (!canAccessRoute(state.route)) state.route = "overview";
  } catch (error) {
    state.session = null;
    setNotice("error", safeErrorMessage(error));
  }
}

async function loadRequests() {
  try {
    if (dataStore.isConfigured() && !state.session) {
      state.requests = [];
      return;
    }
    state.requests = await dataStore.listRequests();
  } catch (error) {
    state.requests = dataStore.defaultRequests;
    setNotice("error", safeErrorMessage(error));
  }
}

async function loadInventoryReports() {
  try {
    if (dataStore.isConfigured() && !state.session) {
      state.inventoryReports = [];
      state.lastInventoryRefresh = null;
      state.itemCosts = [];
      return;
    }
    state.inventoryReports = await dataStore.listInventoryReports();
    state.lastInventoryRefresh = new Date().toISOString();
    await loadItemCosts();
  } catch {
    state.inventoryReports = [];
  }
}

async function loadPurchaseInvoices() {
  try {
    if (dataStore.isConfigured() && !state.session) {
      state.purchaseInvoices = [];
      return;
    }
    state.purchaseInvoices = dataStore.listPurchaseInvoices ? await dataStore.listPurchaseInvoices() : [];
  } catch {
    state.purchaseInvoices = [];
  }
  try {
    state.poItemSnapshots = dataStore.listItemSnapshots ? await dataStore.listItemSnapshots() : [];
    state.poItemSnapshotsAt = state.poItemSnapshots.length ? new Date().toISOString() : "";
  } catch {
    state.poItemSnapshots = [];
    state.poItemSnapshotsAt = "";
  }
}

async function loadReconSessions() {
  try {
    if (dataStore.isConfigured() && !state.session) {
      state.reconSessions = [];
      return;
    }
    state.reconSessions = dataStore.listReconSessions ? await dataStore.listReconSessions() : [];
  } catch {
    state.reconSessions = [];
  }
  await loadReconWarehouses();
  await loadReconWarehouseStock(state.reconWarehouseKey);
}

// قائمة المستودعات الحقيقية (GUID + اسم) من آخر تقارير ameen_warehouse_stock —
// لا خيار "الكل" هنا عمداً؛ الجرد الفعلي يجب أن يبقى بمستودع فعلي واحد كل مرة.
async function loadReconWarehouses() {
  state.reconWarehousesLoading = true;
  try {
    state.reconWarehouses = dataStore.listReconWarehouses ? await dataStore.listReconWarehouses() : [];
  } catch {
    state.reconWarehouses = [];
  } finally {
    state.reconWarehousesLoading = false;
  }
  const stillValid = state.reconWarehouses.some((w) => w.warehouseKey === state.reconWarehouseKey);
  if (!stillValid) {
    const first = state.reconWarehouses[0];
    state.reconWarehouseKey = first ? first.warehouseKey : "";
    state.reconWarehouseName = first ? first.warehouseName : "";
  }
}

// يبني قائمة أصناف المستودع نفسه (وخريطة itemKey → كمية) من أحدث تقرير مخزون موثوق.
// يبقيان null إن لم يوجد تقرير بعد (لا سكريبت سحب فعلي حتى الآن) — لا تُخترَع كمية صفرية
// بديلة، ولا يُرجع الجرد إلى مخزون النشرة العام (قد يشمل أصنافاً غير موجودة بهذا المستودع
// أصلاً أو بكمية مختلفة عن المستودع المختار).
async function loadReconWarehouseStock(warehouseKey) {
  state.reconWarehouseStockMap = null;
  state.reconWarehouseStockItems = null;
  state.reconWarehouseStockReportId = null;
  state.reconWarehouseStockGeneratedAt = null;
  if (!warehouseKey || !dataStore.getLatestWarehouseStockReport) return;
  state.reconWarehouseStockLoading = true;
  try {
    const report = await dataStore.getLatestWarehouseStockReport(warehouseKey);
    const items = report && Array.isArray(report.items) ? report.items : [];
    if (report) {
      state.reconWarehouseStockGeneratedAt =
        (report.summary && report.summary.generated_at) || report.created_at || null;
    }
    if (report && items.length) {
      const map = {};
      const list = [];
      items.forEach((it) => {
        const key = it.itemKey || it.item_key;
        if (!key) return;
        const qty = Number(it.qty ?? it.stockQty ?? it.stock_qty ?? 0);
        map[key] = qty;
        list.push({
          itemKey: key,
          itemName: it.itemName || it.item_name || key,
          itemNumber: it.itemNumber || it.item_number || it.itemCode || it.item_code || "",
          unitName: it.unitName || it.unit_name || it.unit1Name || "",
          qty
        });
      });
      state.reconWarehouseStockMap = map;
      state.reconWarehouseStockItems = list;
      state.reconWarehouseStockReportId = report.id || null;
    } else if (report) {
      state.reconWarehouseStockItems = []; // تقرير موجود لكن بلا أصناف — لا يوجد ما يُضاف
      state.reconWarehouseStockReportId = report.id || null;
    }
  } catch {
    state.reconWarehouseStockMap = null;
    state.reconWarehouseStockItems = null;
    state.reconWarehouseStockReportId = null;
  } finally {
    state.reconWarehouseStockLoading = false;
  }
}

async function loadWarehouseDashboard() {
  if (!state.session) {
    state.warehouseReports = {};
    state.warehouseTransferReport = null;
    return;
  }
  state.warehouseLoading = true;
  try {
    if (!state.reconWarehouses.length) await loadReconWarehouses();
    const reports = dataStore.listLatestWarehouseStockReports
      ? await dataStore.listLatestWarehouseStockReports()
      : [];
    const entries = reports.map((report) => [report?.summary?.warehouseKey, report]);
    state.warehouseReports = Object.fromEntries(entries.filter(([, report]) => report));
    if (!state.reconWarehouses.some((w) => w.warehouseKey === state.warehouseSelectedKey)) {
      state.warehouseSelectedKey = state.reconWarehouses[0]?.warehouseKey || "";
    }
  } catch (error) {
    state.warehouseReports = {};
    setNotice("error", safeErrorMessage(error));
  }
  try {
    state.warehouseTransferReport = dataStore.getLatestWarehouseTransferReport
      ? await dataStore.getLatestWarehouseTransferReport()
      : null;
  } catch {
    // يسمح بعرض المخزون حتى قبل تطبيق جدول المناقلات الجديد أو عند تعذره.
    state.warehouseTransferReport = null;
  }
  state.warehouseLoading = false;
}

async function loadDailyMovement(date) {
  const target = date || state.dailyMovementDate || todayIsoDate();
  state.dailyMovementDate = target;
  state.dailyMovementLoading = true;
  state.dailyMovementError = null;
  state.dmFetchedFor = target;
  render();
  try {
    state.dailyMovement = dataStore.getDailyMovementReport
      ? await dataStore.getDailyMovementReport(target)
      : null;
  } catch (error) {
    state.dailyMovement = null;
    state.dailyMovementError = safeErrorMessage(error);
  } finally {
    state.dailyMovementLoading = false;
    render();
  }
}

// التكلفة للمدير فقط — تُجلب من جدول item_costs المحمي (RLS = is_owner)
const OWNER_EMAILS = ["ozkkhallouf@gmail.com", "ozkkhalouf@gmail.com"];
const OWNER_ONLY_ROUTES = new Set(["decision", "command"]);
const SMART_INVENTORY_ROLES = new Set(["owner", "inventory_counter"]);
function isOwner() {
  const email = String(state.session?.email || "").trim().toLowerCase();
  return state.session?.accessRole === "owner" || OWNER_EMAILS.includes(email);
}
function isInventoryCounter() {
  return state.session?.accessRole === "inventory_counter";
}
function canAccessRoute(route) {
  const requested = String(route || "");
  if (isInventoryCounter()) return requested === "smartInventory";
  if (requested === "smartInventory") return SMART_INVENTORY_ROLES.has(state.session?.accessRole);
  return !OWNER_ONLY_ROUTES.has(requested) || isOwner();
}
window.ozkCanAccessRoute = canAccessRoute;

async function loadItemCosts() {
  try {
    if (!isOwner() || !dataStore.listItemCosts) {
      state.itemCosts = [];
      return;
    }
    state.itemCosts = await dataStore.listItemCosts();
  } catch {
    state.itemCosts = [];
  }
}

let _costIndexRef = null;
let _costIndex = new Map();
function itemCostIndex() {
  if (_costIndexRef === state.itemCosts) return _costIndex;
  const map = new Map();
  (state.itemCosts || []).forEach((row) => {
    if (!row) return;
    if (row.item_guid) map.set("g:" + String(row.item_guid).toUpperCase(), row);
    if (row.item_name) map.set("n:" + normalizeItemName(row.item_name), row);
  });
  _costIndexRef = state.itemCosts;
  _costIndex = map;
  return map;
}
function itemCostFor(item) {
  if (!isOwner() || !item) return null;
  const idx = itemCostIndex();
  if (item.itemGuid) {
    const byGuid = idx.get("g:" + String(item.itemGuid).toUpperCase());
    if (byGuid) return byGuid;
  }
  const byName = idx.get("n:" + normalizeItemName(item.name || item.key || ""));
  return byName || null;
}

// ===== واتساب: إرسال وصل/فاتورة رسمية للزبون =====
// (SITE_BASE أُزيل هنا — كان يشير لدومين GitHub Pages القديم fhwvtqdc2q-svg.github.io
// المهجور منذ اعتماد ozktobacco.com، ولم يكن مستخدَماً في أي مكان بالملف أصلاً.)

async function loadCustomerWhatsapp() {
  try {
    state.customerWhatsapp = dataStore.listCustomerWhatsapp ? await dataStore.listCustomerWhatsapp() : [];
  } catch {
    state.customerWhatsapp = [];
  }
}

// مطابقة ذكية لاسم الزبون: تطابق تام أولاً، ثم "اسم بداية الآخر"، ثم "يحتوي".
// تحلّ مشكلة اختلاف الاسم المختصر عن الاسم الكامل (مثل «مركز الحرية» مقابل «مركز الحرية / حي تشرين»).
function smartNameMatch(list, getName, name) {
  const nm = normalizeItemName(name || "");
  if (!nm || !Array.isArray(list)) return null;
  const norm = (x) => normalizeItemName(getName(x) || "");
  let row = list.find((x) => norm(x) === nm);
  if (row) return row;
  const pref = list.filter((x) => { const n = norm(x); return n && (n.startsWith(nm) || nm.startsWith(n)); });
  if (pref.length) return pref[0];
  const cont = list.filter((x) => { const n = norm(x); return n && (n.includes(nm) || nm.includes(n)); });
  return cont.length ? cont[0] : null;
}

function findWhatsappByName(name) {
  return smartNameMatch(state.customerWhatsapp || [], (c) => c.customer_name, name);
}

function findBalanceCustomerByText(text) {
  return smartNameMatch(latestCustomerBalanceItems() || [], (it) => it.name, text);
}

function whatsappFor(item) {
  if (!item) return null;
  const list = state.customerWhatsapp || [];
  const guid = item.customerGuid || item.customerAccountGuid;
  let row = guid ? list.find((c) => c.customer_guid === guid) : null;
  if (!row) row = findWhatsappByName(item.name);
  return row || null;
}

function customerCurrencyOverride(item) {
  if (!item) return "";
  const map = readJson("customer-currency-overrides", {});
  const val = map ? map[customerKey(item)] : "";
  return val === "$" || val === "ل.س" ? val : "";
}

function setCustomerCurrencyOverride(item, cur) {
  if (!item) return;
  const map = readJson("customer-currency-overrides", {}) || {};
  map[customerKey(item)] = cur;
  writeJson("customer-currency-overrides", map);
}

function customerCurrency(item) {
  const ov = customerCurrencyOverride(item);
  if (ov) return ov;
  const w = whatsappFor(item);
  const c = String((w && w.currency) || "").trim().toLowerCase();
  if (c.includes("ليرة") || c.includes("ل.س") || c.includes("syp") || c.includes("pound")) return "ل.س";
  return "$";
}

// تقرير مزامنة الذمم يرسل رصيد ac000 بعملة الأساس (الدولار) لكل الزبائن.
// لا نعيد تحويله حسب عملة الفاتورة أو إعداد الوصل كي لا نصغّر حساباً دولارياً خطأً.
function customerBalanceSortValue(item) {
  return customerBalance(item);
}

// حارس تصدير المستندات: نقرتان سريعتان تنتجان رقمَي سند مختلفين للحركة نفسها.
let voucherExportBusy = false;

// وقت مختصر «يوم-شهر ساعة:دقيقة» لوسم حداثة رقم مطبوع.
function shortDateTime(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw.slice(0, 16).replace("T", " ");
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function docNumber(prefix) {
  return prefix + "-" + todayIsoDate().replace(/-/g, "") + "-" + String(Math.floor(1000 + Math.random() * 9000));
}

async function sendReceiptWhatsapp(item, amount, date, notes) {
  const w = whatsappFor(item);
  const cur = customerCurrency(item);
  const amt = Number(amount) || 0;
  const balanceAfter = customerBalance(item) - amt;
  const doc = {
    t: "receipt",
    no: docNumber("R"),
    date: date || todayIsoDate(),
    name: item.name || "",
    phone: w ? w.phone_number : "",
    amount: amt,
    balance: balanceAfter,
    cur: cur,
    notes: notes || ""
  };
  try {
    await dataStore.createSharedDocument(doc);
  } catch (e) {
    setNotice("error", "تعذّر حفظ الوصل: " + (e.message || ""));
    return;
  }
  // واتساب أُلغي — الوصل يُحفظ بالنظام/الأرشيف (أساس الرفع التلقائي إلى Google Drive لاحقاً)
  setNotice("success", "تم حفظ الوصل بالنظام والأرشيف ✓");
}

// لوحة الإرسال الجماعي حسب التصنيف
function whatsappBroadcastPanel() {
  // واتساب أُلغي بالكامل — لوحة الإرسال الجماعي معطّلة (التحويل إلى Google Drive)
  return "";
  const list = state.customerWhatsapp || [];
  const types = [...new Set(list.map((c) => (c.customer_type || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ar"));
  if (!types.length) return "";
  const sel = state.broadcastType || "";
  const inGroup = sel ? list.filter((c) => (c.customer_type || "").trim() === sel && c.phone_number) : [];
  const rowStyle = "display:flex;justify-content:space-between;align-items:center;gap:10px;padding:7px 4px;border-bottom:1px solid var(--line)";
  const rows = inGroup
    .map((c) => `<div style="${rowStyle}"><span>${escapeHtml(c.customer_name || "")}</span><span class="muted" dir="ltr" style="font-size:.8rem">${escapeHtml(c.phone_number)}</span><button class="button secondary mini-button" type="button" data-bc-send="${escapeHtml(c.phone_number)}">📲 إرسال</button></div>`)
    .join("");
  return `
    <details class="panel" style="margin:12px 0" ${sel ? "open" : ""}>
      <summary style="cursor:pointer;font-weight:800">📲 إرسال جماعي للزبائن حسب التصنيف</summary>
      <div style="margin-top:10px;display:grid;gap:10px">
        <label>التصنيف
          <select data-bc-type>
            <option value="">— اختر تصنيف —</option>
            ${types.map((t) => `<option value="${escapeHtml(t)}" ${t === sel ? "selected" : ""}>${escapeHtml(t)}</option>`).join("")}
          </select>
        </label>
        <label>نص الرسالة
          <textarea data-bc-text rows="3" placeholder="اكتب الرسالة (مثلاً: رابط نشرة الأسعار، أو تنبيه)...">${escapeHtml(state.broadcastText || "")}</textarea>
        </label>
        ${sel
          ? `<p class="muted">${inGroup.length} زبون بتصنيف «${escapeHtml(sel)}». اضغط «إرسال» جنب كل زبون — بيفتح واتساب جاهز بالرسالة.</p>${rows || '<p class="muted">لا يوجد زبائن بأرقام في هذا التصنيف.</p>'}`
          : '<p class="muted">اختر تصنيف لعرض زبائنه.</p>'}
      </div>
    </details>`;
}

async function loadCustomerBalanceReports() {
  try {
    if (dataStore.isConfigured() && !state.session) {
      state.customerBalanceReports = [];
      return;
    }
    state.customerBalanceReports = dataStore.listCustomerBalanceReports
      ? await dataStore.listCustomerBalanceReports()
      : [];
  } catch {
    state.customerBalanceReports = [];
  }
  try {
    state.customerMovementsReport = dataStore.getCustomerMovementsReport
      ? await dataStore.getCustomerMovementsReport()
      : null;
  } catch {
    state.customerMovementsReport = null;
  }
  try {
    state.customerInvoicesReport = dataStore.getCustomerInvoicesReport
      ? await dataStore.getCustomerInvoicesReport()
      : null;
  } catch {
    state.customerInvoicesReport = null;
  }
  try {
    state.poAmeenReport = dataStore.getPurchaseInvoicesAmeenReport
      ? await dataStore.getPurchaseInvoicesAmeenReport()
      : null;
  } catch {
    state.poAmeenReport = null;
  }
  try {
    state.invoiceSeriesReport = dataStore.getInvoiceSeriesReport
      ? await dataStore.getInvoiceSeriesReport()
      : null;
  } catch {
    state.invoiceSeriesReport = null;
  }
  await loadCustomerWhatsapp();
}

// فواتير زبون محدّد مع محتوياتها (من تقرير ameen_customer_invoices، بمطابقة ذكية للاسم)
function customerInvoicesFor(name) {
  const report = state.customerInvoicesReport;
  const items = report && Array.isArray(report.items) ? report.items : [];
  const match = smartNameMatch(items, (it) => it.name, name);
  return match && Array.isArray(match.invoices) ? match.invoices : [];
}

// مطابقة قيد دائن (دفعة محتملة) بفاتورة مرتجع فعلية بالتاريخ والمبلغ — قيود المرتجع في الأمين
// لا تحمل معرّف الفاتورة (BiGUID) كالفواتير العادية، فلا مطابقة قطعية ممكنة هنا.
function findReturnInvoiceForMovement(custName, movement) {
  const credit = Number(movement?.credit || 0);
  if (!(credit > 0)) return null;
  const invs = customerInvoicesFor(custName).filter((x) => x.isReturn);
  if (!invs.length) return null;
  const dOnly = String(movement?.date || "").slice(0, 10);
  const amtMatch = (x) => Math.abs(Number(x.total || 0) - credit) < 1;
  const dateMatch = (x) => String(x.date || "").slice(0, 10) === dOnly;
  return invs.find((x) => dateMatch(x) && amtMatch(x)) || invs.find((x) => amtMatch(x)) || null;
}

// كمية سطر الفاتورة بشكل مقروء (نفضّل الوحدة الأكبر إن وُجدت).
// لا نعرض سعر/إجمالي السطر لأن أرقام الأسطر المفردة بمصدر الأمين غير دقيقة
// (مجموعها لا يطابق إجمالي الفاتورة)؛ الموثوق هو إجمالي الفاتورة فقط.
// قيمة السطر الفعلية. مصدر الحقيقة هو `lineTotal` القادم من الأمين
// (Qty × Price كما يسجّلهما) — لا يُعاد حسابه من السعر المعروض.
// **العطل الذي يعالجه:** المستند كان يعرض «سعر الوحدة» وحده، وهو سعر الوحدة
// الكبرى (سعر الكرتونة 403)، فيُقرأ على أنه قيمة السطر. نصف كرتونة قيمتها
// 201.50 لا 403. السعر يبقى سعر وحدة، والقيمة تصير عموداً مستقلاً.
//
// حين يكون أساس أسعار الفاتورة الوحدة الكبرى (`unit2`) يكون `Qty × Price`
// القادم من الأمين محسوباً على أساس مختلف، فنحسب القيمة من الكمية بالوحدة
// الكبرى — نفس المنطق الذي يحسم به `invoicePriceBasis` أساس السعر.
function invoiceLineTotalValue(line, inv) {
  const price = Number(line?.price || 0);
  const qty = Number(line?.qty || 0);
  const qtyUnits = Number(line?.qtyUnits || 0);
  const stored = Number(line?.lineTotal || 0);
  if (inv && qtyUnits > 0 && invoicePriceBasis(inv) === "unit2") {
    return roundPrice(price * qtyUnits);
  }
  if (stored > 0) return roundPrice(stored);
  return roundPrice(price * qty);
}

function invoiceLineValueText(line, inv) {
  const value = invoiceLineTotalValue(line, inv);
  return value > 0 ? formatMoney(value) : "—";
}

function invoiceLineQty(line) {
  const u1 = String(line?.unit1 || "").trim();
  const u2 = String(line?.unit2 || "").trim();
  const qty = Number(line?.qty || 0);
  const qtyUnits = Number(line?.qtyUnits || 0);
  if (qtyUnits > 0 && u2) {
    const detail = qty > 0 && u1 && (qty !== qtyUnits || u1 !== u2) ? ` (${formatMoney(qty)} ${u1})` : "";
    return `${formatMoney(qtyUnits)} ${u2}${detail}`;
  }
  if (qty > 0) return `${formatMoney(qty)} ${u1}`.trim();
  return "—";
}

// الأمين يسجّل سعر السطر بحسب طريقة إدخال الفاتورة: بعض الفواتير أسعارها للكرتونة
// وبعضها للكروز (الوحدة الأساسية) — يختلف من فاتورة لأخرى. نحسم أساس السعر لكل فاتورة
// بمطابقة مجموع (السعر × الكمية) بكلا الأساسين مع إجمالي الفاتورة (الرقم الموثوق من الأمين):
// الأقرب للإجمالي هو الأساس الصحيح. يرجع "unit1" (كروز) أو "unit2" (كرتونة/شرحة/طرد).
function invoicePriceBasis(inv) {
  const lines = Array.isArray(inv?.lines) ? inv.lines : [];
  const total = Number(inv?.total || 0);
  if (!(total > 0) || !lines.length) return "unit2";
  let sumBase = 0, sumUnits = 0;
  for (const l of lines) {
    const p = Number(l?.price || 0);
    sumBase += p * Number(l?.qty || 0);
    sumUnits += p * Number(l?.qtyUnits || 0);
  }
  return Math.abs(sumBase - total) <= Math.abs(sumUnits - total) ? "unit1" : "unit2";
}

// سعر الوحدة معروضاً دائماً بالوحدة الكبرى (كرتونة/شرحة/طرد): إن كان أساس أسعار الفاتورة
// الكروز نضرب بمعامل الوحدة (كمية الكروز ÷ كمية الكراتين لنفس السطر)، وإلا نعرضه كما هو.
// نواة حسم الوحدة رقماً — مصدر واحد لكل من يحتاج سعر سطر الفاتورة (العرض في كشف
// الحساب، وآخر سعر للزبون في بطاقة الصنف). تعيد { price, unit, converted } أو null.
function invoiceLineUnitPrice(line, inv) {
  const price = Number(line?.price || 0);
  if (!(price > 0)) return null;
  const u1 = String(line?.unit1 || "").trim();
  const u2 = String(line?.unit2 || "").trim();
  const qty = Number(line?.qty || 0);
  const qtyUnits = Number(line?.qtyUnits || 0);
  const factor = qty > 0 && qtyUnits > 0 ? qty / qtyUnits : 0;
  if (inv && u2 && factor > 0 && invoicePriceBasis(inv) === "unit1") {
    return { price: roundPrice(price * factor), unit: u2, converted: true };
  }
  return { price, unit: qtyUnits > 0 && u2 ? u2 : u1, converted: false };
}

function invoiceLinePrice(line, inv) {
  const resolved = invoiceLineUnitPrice(line, inv);
  if (!resolved) return "—";
  return `${formatMoney(resolved.price)} $${resolved.unit ? " / " + resolved.unit : ""}`;
}

async function loadCustomerCreditLimits() {
  try {
    state.customerLimitError = null;
    if (dataStore.isConfigured() && !state.session) {
      state.customerCreditLimits = [];
      return;
    }
    state.customerCreditLimits = dataStore.listCustomerCreditLimits
      ? await dataStore.listCustomerCreditLimits()
      : [];
  } catch (error) {
    state.customerCreditLimits = [];
    state.customerLimitError = safeErrorMessage(error);
  }
}

async function loadApprovedPriceItems() {
  try {
    state.approvedPriceError = null;
    if (dataStore.isConfigured() && !state.session) {
      state.approvedPriceItems = [];
      return;
    }
    state.approvedPriceItems = dataStore.listApprovedPriceItems ? await dataStore.listApprovedPriceItems() : [];
  } catch (error) {
    state.approvedPriceItems = [];
    state.approvedPriceError = safeErrorMessage(error);
  }
}

async function loadPaymentRecords(customerKey) {
  if (!customerKey || !state.session) return;
  try {
    state.paymentLoading = true;
    const records = await dataStore.listPaymentRecords(customerKey);
    state.paymentRecords = { ...state.paymentRecords, [customerKey]: records };
    state.paymentLoading = false;
    state.paymentError = null;
    render();
  } catch (error) {
    state.paymentLoading = false;
    state.paymentError = error.message;
    render();
  }
}

async function loadCustomerProfiles() {
  try {
    state.customerProfiles = await dataStore.listCustomerProfiles();
  } catch {}
}

function customerProfile(key) {
  return state.customerProfiles.find((p) => p.customerKey === key) || null;
}

async function printOverdueReport() {
  const overdue = overdueCustomers();
  if (!overdue.length) {
    setNotice("error", "لا يوجد زبائن متأخرون حالياً.");
    render();
    return;
  }
  const now = new Date().toLocaleDateString("ar-SA-u-ca-gregory", { year: "numeric", month: "long", day: "numeric" });
  const rows = overdue.map((item, i) => `
    <tr style="background:${i % 2 === 0 ? "#fff" : "#fdf8ee"}">
      <td style="padding:8px 10px;border:1px solid #d8c890;text-align:center">${i + 1}</td>
      <td style="padding:8px 10px;border:1px solid #d8c890">${escapeHtml(item.customer_name || item.name || "—")}</td>
      <td style="padding:8px 10px;border:1px solid #d8c890;direction:ltr;text-align:left;font-family:monospace">${formatMoney(customerBalance(item))}</td>
      <td style="padding:8px 10px;border:1px solid #d8c890;text-align:center;color:${item.daysSince === null ? "#888" : item.daysSince >= 7 ? "#b00" : "#9a6000"};font-weight:bold">${item.daysSince === null ? "—" : item.daysSince + " يوم"}</td>
    </tr>`).join("");
  const html = `
    <div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;color:#221808;padding:20px">
      <div style="text-align:center;margin-bottom:20px;border-bottom:2px solid #d7a83f;padding-bottom:16px">
        <h2 style="margin:0 0 4px;font-size:1.4rem">OZK TOBACCO</h2>
        <h3 style="margin:0;font-size:1.1rem;color:#6b4e10">تقرير الزبائن المتأخرين عن الدفع</h3>
        <p style="margin:8px 0 0;font-size:0.85rem;color:#888">التاريخ: ${now}</p>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:0.9rem">
        <thead>
          <tr style="background:#d7a83f;color:#1a1000">
            <th style="padding:9px 10px;border:1px solid #b8892a;width:40px">#</th>
            <th style="padding:9px 10px;border:1px solid #b8892a;text-align:right">اسم الزبون</th>
            <th style="padding:9px 10px;border:1px solid #b8892a;text-align:right">الرصيد</th>
            <th style="padding:9px 10px;border:1px solid #b8892a;text-align:center">أيام بلا دفعة</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="margin-top:16px;font-size:0.82rem;color:#888">المجموع: ${overdue.length} زبون / أكثر من 7 أيام: ${overdue.filter((x) => x.daysSince !== null && x.daysSince >= 7).length}</p>
    </div>`;
  const filename = `ozk-overdue-${new Date().toISOString().slice(0, 10)}.pdf`;
  if (isHandheldDevice()) {
    try {
      const blob = await createPortablePdfBlob(html, filename, {
        margin: [10, 15, 10, 15],
        width: 760,
        image: { type: "jpeg", quality: 0.95 }
      });
      presentPortablePdf(blob, filename, "تقرير الزبائن المتأخرين");
      setNotice("success", "تم تجهيز التقرير كملف PDF. اضغط «مشاركة / حفظ في الملفات».");
    } catch (error) {
      setNotice("error", "تعذّر إنشاء ملف PDF: " + safeErrorMessage(error));
    }
    render();
    return;
  }

  archiveToICloud("other_report", html, { title: "تقرير الزبائن المتأخرين", date: todayIsoDate() });
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);
  window.html2pdf().set({
    margin: [10, 15, 10, 15],
    filename,
    image: { type: "jpeg", quality: 0.95 },
    html2canvas: { scale: 2, useCORS: true },
    jsPDF: { unit: "mm", format: "a4", orientation: "portrait" }
  }).from(container).save().finally(() => container.remove());
}

function setRoute(route, clearNotice = true) {
  const requestedRoute = String(route || "overview");
  const safeFallback = isInventoryCounter() ? "smartInventory" : "overview";
  state.route = canAccessRoute(requestedRoute) ? requestedRoute : safeFallback;
  if (state.route !== requestedRoute) {
    setNotice("error", isInventoryCounter() ? "حساب موظف الجرد مخصص للجرد فقط." : "ليست لديك صلاحية لهذه الصفحة.");
    clearNotice = false;
  }
  // أرشيف الفواتير شاشة عابرة داخل صفحة المبيعات: أي تنقّل يعيدك إلى النموذج
  // لا إلى الأرشيف، كي لا تفتح «فاتورة مبيعات» فتجد قائمة الفواتير القديمة.
  state.salesHistoryOpen = false;
  cancelSalesHistorySearch();
  if (clearNotice) state.notice = null;
  if (state.route === "smartInventory" && state.session) window.SmartInventory?.load(state.session);
  render();
}

function toggleItem(id) {
  if (state.completed.has(id)) {
    state.completed.delete(id);
  } else {
    state.completed.add(id);
  }
  writeJson("completed-items", [...state.completed]);
  render();
}

async function saveSession(form, action) {
  try {
    const input = {
      name: formValue(form, "name"),
      role: formValue(form, "role"),
      email: formValue(form, "email"),
      password: formValue(form, "password")
    };

    const result = action === "signup" ? await dataStore.signUp(input) : await dataStore.signIn(input);
    state.session = result.session || (await dataStore.getSession());
    window.__ozkSession = state.session;

    if (result.needsEmailConfirmation) {
      setNotice("success", "تم إنشاء الحساب. إذا كان تأكيد البريد مفعلا في Supabase، افتح البريد ثم سجل الدخول.");
    } else {
      setNotice("success", dataStore.isConfigured() ? "تم تسجيل الدخول عبر Supabase." : "تم تسجيل الدخول التجريبي محليا.");
    }

    if (isInventoryCounter()) {
      state.route = "smartInventory";
      await window.SmartInventory?.load(state.session, true);
      setNotice("success", "تم تسجيل الدخول إلى الجرد الذكي.");
      render();
      return;
    }
    await loadRequests();
    await loadInventoryReports();
    await loadCustomerBalanceReports();
    await loadCustomerCreditLimits();
    await loadApprovedPriceItems();
    await loadPurchaseInvoices();
    setRoute("overview", false);
  } catch (error) {
    setNotice("error", safeErrorMessage(error));
    render();
  }
}

async function saveInventoryCounterSession(form) {
  try {
    const result = await dataStore.signInInventoryCounter({
      username: formValue(form, "username"),
      password: formValue(form, "password"),
      deviceId: window.SmartInventory?.deviceId?.() || ""
    });
    state.session = result.session || (await dataStore.getSession());
    window.__ozkSession = state.session;
    if (state.session?.accessRole !== "inventory_counter") throw new Error("هذا الحساب ليس حساب موظف جرد.");
    state.route = "smartInventory";
    window.history.replaceState({}, "", `${window.location.pathname}?route=smartInventory`);
    await window.SmartInventory?.load(state.session, true);
    setNotice("success", "تم الدخول. اختر المستودع وابدأ الجرد.");
  } catch (error) { setNotice("error", safeErrorMessage(error)); }
  render();
}

async function requestPasswordReset(form) {
  try {
    const email = formValue(form, "email");
    await dataStore.requestPasswordReset(email);
    state.passwordResetMode = true;
    state.passwordResetEmail = email;
    window.history.replaceState({}, "", `${window.location.pathname}?route=login&recovery=code`);
    setNotice("success", "أرسلنا رمز استعادة إلى البريد. أدخل الرمز كاملاً كما ورد في أحدث رسالة، ثم اختر كلمة مرور جديدة.");
  } catch (error) {
    setNotice("error", safeErrorMessage(error));
  }
  render();
}

async function saveRecoveredPasswordCode(form) {
  try {
    const email = formValue(form, "email");
    const token = formValue(form, "recoveryCode");
    const password = formValue(form, "password");
    const confirmation = formValue(form, "passwordConfirmation");
    if (password !== confirmation) throw new Error("كلمتا المرور غير متطابقتين.");
    if (!dataStore.isPasswordRecovery?.()) {
      await dataStore.verifyPasswordRecoveryOtp(email, token);
    }
    await dataStore.updateRecoveredPassword(password);
    await dataStore.signOut();
    state.session = null;
    state.passwordResetMode = false;
    state.passwordResetEmail = "";
    window.history.replaceState({}, "", `${window.location.pathname}?route=login`);
    setNotice("success", "تم تغيير كلمة المرور. سجّل الدخول الآن بكلمة المرور الجديدة.");
  } catch (error) {
    setNotice("error", safeErrorMessage(error));
  }
  render();
}

async function saveRecoveredPassword(form) {
  try {
    const password = formValue(form, "password");
    const confirmation = formValue(form, "passwordConfirmation");
    if (password !== confirmation) throw new Error("كلمتا المرور غير متطابقتين.");
    await dataStore.updateRecoveredPassword(password);
    await dataStore.signOut();
    state.session = null;
    window.history.replaceState({}, "", `${window.location.pathname}?route=login`);
    setNotice("success", "تم تغيير كلمة المرور. سجّل الدخول الآن بكلمة المرور الجديدة.");
  } catch (error) {
    setNotice("error", safeErrorMessage(error));
  }
  render();
}

async function logout() {
  // الإلغاء قبل أي انتظار: لو أُلغي بعد signOut لَبقيت نافذة تنفيذ أثناء
  // الانتظار، ولَما أُلغي إطلاقاً عند فشل الخروج.
  cancelSalesHistorySearch();
  state.salesHistoryOpen = false;
  state.salesHistoryQuery = "";
  try {
    await dataStore.signOut();
    state.session = null;
    window.__ozkSession = null;
    window.SmartInventory?.reset?.();
    state.route = "login";
    window.history.replaceState({}, "", `${window.location.pathname}?route=login`);
    state.inventoryReports = [];
    state.customerBalanceReports = [];
    state.customerMovementsReport = null;
    state.customerCreditLimits = [];
    state.customerLimitError = null;
    state.approvedPriceItems = [];
    state.approvedPriceError = null;
    state.purchaseInvoices = [];
    setNotice("success", "تم تسجيل الخروج.");
  } catch (error) {
    setNotice("error", safeErrorMessage(error));
  }
  render();
}

async function addRequest(form) {
  try {
    await dataStore.createRequest({
      customer: formValue(form, "customer"),
      channel: formValue(form, "channel"),
      type: formValue(form, "type"),
      note: formValue(form, "note")
    });
    await loadRequests();
    setNotice("success", dataStore.isConfigured() ? "تم حفظ الطلب في Supabase." : "تم حفظ الطلب محليا للتجربة.");
    setRoute("requests", false);
  } catch (error) {
    setNotice("error", safeErrorMessage(error));
    if (/سجل الدخول/i.test(error.message)) state.route = "login";
    render();
  }
}

async function updateRequest(id, status) {
  try {
    await dataStore.updateRequestStatus(id, status);
    await loadRequests();
    setNotice("success", "تم تحديث حالة الطلب.");
  } catch (error) {
    setNotice("error", safeErrorMessage(error));
  }
  render();
}

function exportRequestsForAmeen() {
  if (!state.requests.length) {
    setNotice("error", "لا توجد طلبات لتصديرها.");
    render();
    return;
  }

  const headers = [
    "رقم الطلب",
    "اسم العميل",
    "القناة",
    "نوع الطلب",
    "الحالة",
    "الملاحظة",
    "تاريخ الإنشاء"
  ];
  const rows = state.requests.map((request) => [
    request.publicId || request.id,
    request.customer,
    request.channel,
    request.type,
    request.status,
    request.note,
    request.createdAt || ""
  ]);
  const csv = [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `tobacco-ameen-requests-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  setNotice("success", "تم تصدير ملف CSV قابل للفتح في إكسل وتجهيزه كخطوة أولى للتوافق مع الأمين.");
  render();
}

function assertExcelSupport() {
  if (!window.XLSX) {
    throw new Error("مكتبة قراءة إكسل لم تتحمل بعد. حدث الصفحة ثم جرب مرة أخرى.");
  }
}

async function readWorkbookFile(file) {
  assertExcelSupport();
  const buffer = await file.arrayBuffer();
  return window.XLSX.read(buffer, { type: "array", cellDates: true });
}

function sheetRows(workbook, preferredNames = []) {
  const sheetName =
    workbook.SheetNames.find((name) => preferredNames.some((preferred) => name.includes(preferred))) ||
    workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  return {
    sheetName,
    rows: window.XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" })
  };
}

function findHeaderRow(rows) {
  const index = rows.findIndex((row) =>
    row.some((cell) => {
      const text = String(cell ?? "").trim();
      const normalized = normalizeItemName(text);
      return (
        text.includes("اسم المادة") ||
        text === "المادة" ||
        normalized === "item name" ||
        normalized === "item key" ||
        normalized === "material name"
      );
    })
  );
  if (index === -1) throw new Error("لم أجد عمود اسم المادة داخل ملف إكسل.");
  return index;
}

function findColumn(header, candidates) {
  return header.findIndex((cell) => {
    const text = String(cell ?? "").trim();
    const normalizedText = normalizeItemName(text);
    return candidates.some((candidate) => {
      const normalizedCandidate = normalizeItemName(candidate);
      return text.includes(candidate) || (normalizedCandidate && normalizedText.includes(normalizedCandidate));
    });
  });
}

function findPriceColumns(headers) {
  return headers
    .map((header, index) => {
      const text = String(header ?? "").trim();
      const normalized = normalizeItemName(text);
      const isPriceColumn = text.includes("سعر") || /\b(price|sale)\b/i.test(normalized);
      if (!isPriceColumn) return null;

      const isUnit1 =
        /\bunit\s*1\b/i.test(normalized) ||
        normalized.includes("unit1") ||
        normalized.includes("first unit") ||
        normalized.includes("sale price") ||
        normalized.includes("الوحده الاولي") ||
        normalized.includes("الوحده الاولى");
      const isUnit2 =
        /\bunit\s*2\b/i.test(normalized) ||
        normalized.includes("unit2") ||
        normalized.includes("second unit") ||
        normalized.includes("الوحده الثانيه");

      return {
        index,
        header: text,
        unit: isUnit1 && !isUnit2 ? "unit1" : "unit2"
      };
    })
    .filter(Boolean);
}

function aggregateStockItems(rows, headerIndex, threshold) {
  const header = rows[headerIndex].map((cell) => String(cell ?? "").trim());
  const itemIndex = findColumn(header, ["اسم المادة", "المادة", "الصنف"]);
  const totalIndex = findColumn(header, ["الكمية الإجمالية", "الكمية الاجمالية", "إجمالي", "اجمالي"]);

  if (itemIndex < 0) throw new Error("ملف الجرد لا يحتوي على عمود اسم المادة.");
  const itemsByKey = new Map();

  rows.slice(headerIndex + 1).forEach((row) => {
    const name = String(row[itemIndex] ?? "").trim();
    const key = normalizeItemName(name);
    if (!name || !key || key === normalizeItemName("اسم المادة")) return;

    const qty =
      totalIndex >= 0
        ? toNumber(row[totalIndex])
        : row.reduce((sum, cell, index) => (index === itemIndex ? sum : sum + toNumber(cell)), 0);

    const current = itemsByKey.get(key);
    if (current) {
      current.stockQty += qty;
    } else {
      itemsByKey.set(key, {
        key,
        name,
        stockQty: qty,
        status: "active",
        priceListed: false,
        lowThreshold: threshold
      });
    }
  });

  return [...itemsByKey.values()];
}

async function parseStockWorkbook(file, threshold) {
  const workbook = await readWorkbookFile(file);
  const { sheetName, rows } = sheetRows(workbook, ["جرد", "مخزون"]);
  const headerIndex = findHeaderRow(rows);
  const items = aggregateStockItems(rows, headerIndex, threshold);
  if (!items.length) throw new Error("ملف الجرد لا يحتوي على مواد قابلة للقراءة.");
  return { sheetName, items };
}

async function parsePriceWorkbook(file) {
  const workbook = await readWorkbookFile(file);
  const { sheetName, rows } = sheetRows(workbook, ["لائحة", "اسعار", "أسعار"]);
  const headerIndex = findHeaderRow(rows);
  const headers = rows[headerIndex].map((cell) => String(cell ?? "").trim());
  const itemIndex = findColumn(headers, ["اسم المادة", "المادة", "الصنف", "item_name", "item name", "material_name", "material name"]);
  const itemKeyIndex = findColumn(headers, ["item_key", "item key", "مفتاح المادة"]);
  if (itemIndex < 0 && itemKeyIndex < 0) throw new Error("ملف الأسعار لا يحتوي على عمود اسم المادة.");
  const priceColumns = findPriceColumns(headers);
  if (!priceColumns.length) throw new Error("ملف الأسعار لا يحتوي على عمود سعر واضح.");
  const priceIndexes = priceColumns.map((column) => column.index);

  const priceRows = rows
    .slice(headerIndex + 1)
    .map((row) => {
      const nameValue = itemIndex >= 0 ? row[itemIndex] : row[itemKeyIndex];
      const keyValue = itemKeyIndex >= 0 ? row[itemKeyIndex] : nameValue;
      const key = normalizeItemName(keyValue || nameValue);
      const name = String(nameValue ?? keyValue ?? "").trim();
      return {
        key,
        name,
        hasPrice: priceColumns.some((column) => toPositivePrice(row[column.index]) > 0),
        raw: headers.map((_, index) => row[index] ?? "")
      };
    })
    .filter((row) => row.key && row.name && row.key !== normalizeItemName("اسم المادة"));

  if (!priceRows.length) throw new Error("ملف الأسعار لا يحتوي على مواد قابلة للقراءة.");
  return { sheetName, headers, rows: priceRows, priceIndexes, priceColumns };
}

function movementSummary(currentItems, previousReport) {
  const previousItems = Array.isArray(previousReport?.items) ? previousReport.items : [];
  const previousMap = new Map(
    previousItems.map((item) => [item.key || normalizeItemName(item.name), Number(item.stockQty || 0)])
  );

  let activeMovement = 0;
  let staleMovement = 0;
  let restocked = 0;

  currentItems.forEach((item) => {
    if (!previousMap.has(item.key)) return;
    const previousQty = previousMap.get(item.key);
    const delta = Number(item.stockQty || 0) - previousQty;
    if (delta < 0) activeMovement += 1;
    if (delta === 0 && item.stockQty > 0) staleMovement += 1;
    if (delta > 0) restocked += 1;
  });

  return {
    activeMovement,
    staleMovement,
    restocked,
    previousReportDate: previousReport?.report_date || previousReport?.summary?.reportDate || ""
  };
}

function classifyInventoryItems(stockItems, priceRows, threshold) {
  const priceKeys = new Set((priceRows || []).map((row) => row.key));

  return stockItems.map((item) => {
    const priceListed = priceKeys.has(item.key);
    let status = "active";
    if (item.stockQty <= 0) status = "out";
    else if (item.stockQty <= threshold) status = "low";
    else if (priceRows && !priceListed) status = "stale";

    return {
      ...item,
      stockQty: Number(item.stockQty.toFixed(3)),
      status,
      priceListed
    };
  });
}

async function buildInventoryReport(stockFile, priceFile, threshold, previousReport) {
  const stock = await parseStockWorkbook(stockFile, threshold);
  const price = priceFile ? await parsePriceWorkbook(priceFile) : null;
  const availableKeys = new Set(stock.items.filter((item) => item.stockQty > 0).map((item) => item.key));
  const filteredPriceRows = price ? price.rows.filter((row) => availableKeys.has(row.key) && row.hasPrice) : [];
  const excludedPriceRows = price ? price.rows.filter((row) => !availableKeys.has(row.key)) : [];
  const zeroPriceRows = price ? price.rows.filter((row) => availableKeys.has(row.key) && !row.hasPrice) : [];
  const items = classifyInventoryItems(stock.items, price?.rows, threshold);
  const movement = movementSummary(items, previousReport);
  const summary = {
    reportDate: todayIsoDate(),
    stockFileName: stockFile.name,
    priceFileName: priceFile?.name || "",
    totalStockItems: items.length,
    availableItems: items.filter((item) => item.stockQty > 0).length,
    lowStockItems: items.filter((item) => item.status === "low").length,
    outOfStockItems: items.filter((item) => item.status === "out").length,
    staleItems: items.filter((item) => item.status === "stale").length,
    activeItems: items.filter((item) => item.status === "active").length,
    priceRows: price?.rows.length || 0,
    pricedRows: price?.rows.filter((row) => row.hasPrice).length || 0,
    zeroPriceRows: zeroPriceRows.length,
    exportedPriceRows: filteredPriceRows.length,
    excludedPriceRows: excludedPriceRows.length,
    threshold,
    ...movement
  };

  return {
    reportDate: summary.reportDate,
    source: "ameen_excel",
    summary,
    items,
    priceExport: price
      ? {
          sheetName: price.sheetName,
          headers: price.headers,
          rows: filteredPriceRows.map((row) => row.raw)
        }
      : null
  };
}

async function importAmeenReport(form) {
  try {
    const stockFile = form.elements.stock?.files?.[0];
    const priceFile = form.elements.price?.files?.[0] || null;
    const threshold = Math.max(0, toNumber(form.elements.lowThreshold?.value || 50));

    if (!stockFile) throw new Error("اختر ملف جرد الأمين أولا.");
    const report = await buildInventoryReport(stockFile, priceFile, threshold, latestStockReport());
    state.priceExport = report.priceExport;
    await dataStore.createInventoryReport(report);
    await loadInventoryReports();

    setNotice(
      report.summary.zeroPriceRows ? "error" : "success",
      `تم حفظ تقرير الأمين. المواد القريبة من النفاد: ${report.summary.lowStockItems}، المستبعدة من لائحة الأسعار: ${report.summary.excludedPriceRows}، ومواد موجودة لكن بلا سعر: ${report.summary.zeroPriceRows}.`
    );
    setRoute("ameen", false);
  } catch (error) {
    setNotice("error", safeErrorMessage(error));
    render();
  }
}

async function refreshAmeenReports() {
  try {
    await loadInventoryReports();
    await loadCustomerBalanceReports();
    await loadCustomerCreditLimits();
    await loadApprovedPriceItems();
    setNotice("success", "تم تحديث تقارير الأمين من Supabase.");
    setRoute("ameen", false);
  } catch (error) {
    setNotice("error", safeErrorMessage(error));
    render();
  }
}

async function saveCustomerLimit(form) {
  try {
    const customerName = form.dataset.customerName || "";
    // نطبّع دائماً — حتى مفتاح dataset — كي لا يتكرّر خلل عدم الارتباط
    // الذي جعل حد «مركز شريفة» لا يُطبَّق (ة مقابل ه).
    const customerKeyValue = normalizeItemName(form.dataset.customerKey || customerName);
    const creditLimit = Math.max(0, toNumber(formValue(form, "creditLimit")));

    if (!customerKeyValue) throw new Error("لم أستطع تحديد الزبون لحفظ الحد.");

    await dataStore.upsertCustomerCreditLimit({
      customerKey: customerKeyValue,
      customerName,
      creditLimit,
      notes: formValue(form, "notes")
    });

    await loadCustomerCreditLimits();
    setNotice("success", `تم حفظ الحد المسموح للزبون ${customerName || customerKeyValue}.`);
    render();
  } catch (error) {
    state.customerLimitError = safeErrorMessage(error);
    setNotice("error", state.customerLimitError);
    render();
  }
}

function downloadFilteredPriceList() {
  if (!state.priceExport) {
    setNotice("error", "حلل ملف الأسعار أولا حتى أجهز نسخة المواد المتوفرة فقط.");
    render();
    return;
  }

  if (!state.priceExport.rows.length) {
    setNotice("error", "لا توجد مواد بسعر صالح للتنزيل. ملف الأسعار الحالي يحتوي أسعارا صفرية أو فارغة للمواد المتوفرة.");
    render();
    return;
  }
  writePriceExportWorkbook(state.priceExport, "tobacco-available-prices");
  setNotice("success", "تم تنزيل لائحة أسعار تحتوي فقط المواد الموجودة في المستودع.");
  render();
}

// أحدث تقرير جرد حقيقي: نتعرّف عليه بشكل عناصره (فيها stockQty) لا بترتيبه فقط،
// كي لا يُزيحه تقرير آخر (فواتير/مصاريف/حركات) خُزّن بنفس جدول inventory_reports.
function latestStockReport() {
  const reports = Array.isArray(state.inventoryReports) ? state.inventoryReports : [];
  return reports.find((r) => reportItems(r).some((it) => it && ("stockQty" in it || "stockQtyPositive" in it)))
    || null;
}

function liveAvailableItems() {
  return reportItems(latestStockReport()).filter((item) => itemQty(item) > 0);
}

function writePriceExportWorkbook(priceExport, filePrefix) {
  assertExcelSupport();
  const worksheet = window.XLSX.utils.aoa_to_sheet([priceExport.headers, ...priceExport.rows]);
  const workbook = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(workbook, worksheet, "available-prices");
  window.XLSX.writeFile(workbook, `${filePrefix}-${todayIsoDate()}.xlsx`);
}

function firstPositivePrice(rawRow, priceColumns, unit) {
  for (const column of priceColumns || []) {
    if (unit && column.unit !== unit) continue;
    const price = toPositivePrice(rawRow[column.index]);
    if (price > 0) return price;
  }
  return 0;
}

function normalizePriceForItem(rawRow, priceColumns, unit2Factor) {
  const factor = Math.max(1, toPositivePrice(unit2Factor) || 1);
  const rawUnit2Price = firstPositivePrice(rawRow, priceColumns, "unit2");
  const rawUnit1Price = firstPositivePrice(rawRow, priceColumns, "unit1");

  if (rawUnit2Price > 0) {
    const unit2Price = roundPrice(rawUnit2Price);
    const unit1Price = roundPrice(unit2Price / factor);
    return {
      unit2Price,
      unit1Price,
      salePrice: unit1Price,
      sourceUnit: "unit2",
      wasCorrected: rawUnit1Price > 0 && !samePrice(rawUnit1Price, unit1Price)
    };
  }

  if (rawUnit1Price > 0) {
    const unit1Price = roundPrice(rawUnit1Price);
    return {
      unit2Price: roundPrice(unit1Price * factor),
      unit1Price,
      salePrice: unit1Price,
      sourceUnit: "unit1",
      wasCorrected: factor > 1
    };
  }

  return { unit2Price: 0, unit1Price: 0, salePrice: 0, sourceUnit: "", wasCorrected: false };
}

function correctedPriceRow(rawRow, priceColumns, normalizedPrice) {
  const next = [...rawRow];
  const unit2Column = (priceColumns || []).find((column) => column.unit === "unit2");
  const unit1Column = (priceColumns || []).find((column) => column.unit === "unit1");
  if (unit2Column) next[unit2Column.index] = normalizedPrice.unit2Price;
  if (unit1Column) next[unit1Column.index] = normalizedPrice.unit1Price;
  return next;
}

function uuidOrNull(value) {
  const text = String(value || "");
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)
    ? text
    : null;
}

function downloadLivePriceTemplate() {
  const latest = latestStockReport();
  const availableItems = liveAvailableItems();
  if (!latest || !availableItems.length) {
    setNotice("error", "لا يوجد جرد حي يحتوي مواد متوفرة لإنشاء قالب تسعير.");
    render();
    return;
  }

  assertExcelSupport();
  const rows = availableItems.map((item) => [
    item.name || "",
    itemQty(item),
    itemUnit2Name(item),
    itemUnit2Factor(item),
    "",
    itemUnit1Name(item),
    statusLabel(item.status),
    reportSyncedAt(latest)
  ]);
  const worksheet = window.XLSX.utils.aoa_to_sheet([
    ["اسم المادة", "الكمية المتوفرة", "سعر البيع", "الحالة", "آخر مزامنة"],
    ...rows
  ]);
  window.XLSX.utils.sheet_add_aoa(
    worksheet,
    [["اسم المادة", "الكمية المتوفرة", "الوحدة الثانية", "عامل التحويل", "سعر الوحدة الثانية", "الوحدة الأولى", "الحالة", "آخر مزامنة"]],
    { origin: "A1" }
  );
  const workbook = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(workbook, worksheet, "price-template");
  window.XLSX.writeFile(workbook, `tobacco-price-template-${todayIsoDate()}.xlsx`);
  setNotice("success", `تم تنزيل قالب تسعير يحتوي ${availableItems.length} مادة متوفرة فقط.`);
  render();
}

async function importLivePriceList(form) {
  try {
    const latest = latestStockReport();
    const availableItems = liveAvailableItems();
    const priceFile = form.elements.livePrice?.files?.[0];

    if (!latest || !availableItems.length) {
      throw new Error("لا يوجد جرد حي يحتوي مواد متوفرة للمطابقة.");
    }
    if (!priceFile) {
      throw new Error("اختر ملف الأسعار بعد التسعير أولا.");
    }

    const price = await parsePriceWorkbook(priceFile);
    const availableByKey = new Map(availableItems.map((item) => [item.key || normalizeItemName(item.name), item]));
    const availableKeys = new Set(availableByKey.keys());
    const filteredRows = price.rows.filter((row) => availableKeys.has(row.key) && row.hasPrice);
    const excludedRows = price.rows.filter((row) => !availableKeys.has(row.key));
    const zeroPriceRows = price.rows.filter((row) => availableKeys.has(row.key) && !row.hasPrice);
    let correctedPriceRows = 0;
    const approvedItems = filteredRows.map((row) => {
      const stockItem = availableByKey.get(row.key);
      const unit2Factor = itemUnit2Factor(stockItem);
      const normalizedPrice = normalizePriceForItem(row.raw, price.priceColumns, unit2Factor);
      if (normalizedPrice.wasCorrected) correctedPriceRows += 1;
      row.correctedRaw = correctedPriceRow(row.raw, price.priceColumns, normalizedPrice);
      return {
        itemKey: row.key,
        itemName: row.name,
        unit1Name: itemUnit1Name(stockItem),
        unit2Name: itemUnit2Name(stockItem),
        unit2Factor,
        unit2Price: normalizedPrice.unit2Price,
        unit1Price: normalizedPrice.unit1Price,
        salePrice: normalizedPrice.salePrice,
        stockQty: itemQty(stockItem),
        stockStatus: stockItem?.status || "active",
        sourceReportId: uuidOrNull(latest.id),
        sourceSyncedAt: reportSyncedAt(latest),
        pricePayload: {
          pricedUnit: normalizedPrice.sourceUnit,
          correctedAutomatically: normalizedPrice.wasCorrected,
          headers: price.headers,
          row: row.raw
        }
      };
    });

    state.priceExport = {
      sheetName: price.sheetName,
      headers: price.headers,
      rows: filteredRows.map((row) => row.correctedRaw || row.raw),
      source: "live_inventory",
      excludedRows: excludedRows.length,
      zeroPriceRows: zeroPriceRows.length
    };

    if (!filteredRows.length) {
      throw new Error("ملف الأسعار لا يحتوي مواد متوفرة بسعر صالح. راجع عمود سعر البيع أو آخر مزامنة جرد.");
    }

    writePriceExportWorkbook(state.priceExport, "tobacco-sale-prices");
    let savedCount = 0;
    let saveWarning = "";
    const saveApprovedPrices = dataStore.replaceApprovedPriceItems || dataStore.upsertApprovedPriceItems;
    if (saveApprovedPrices) {
      try {
        const saved = await saveApprovedPrices.call(dataStore, approvedItems);
        state.approvedPriceItems = saved;
        savedCount = saved.length;
      } catch (saveError) {
        saveWarning = ` تم تنزيل الملف، لكن تعذر حفظ الأسعار لجهاز المحاسبة: ${saveError.message}`;
      }
    }
    const correctionText = correctedPriceRows ? ` وتم تصحيح ${correctedPriceRows} سعر تلقائياً حسب عامل التحويل.` : "";
    setNotice(
      zeroPriceRows.length || saveWarning ? "error" : "success",
      `تم تنزيل لائحة البيع النهائية: ${filteredRows.length} مادة. تم حذف ${excludedRows.length} غير موجودة في المستودع، و${zeroPriceRows.length} موجودة لكن بلا سعر. تم استبدال لائحة المحاسبة بـ ${savedCount} سعر.${correctionText}${saveWarning}`
    );
  } catch (error) {
    setNotice("error", safeErrorMessage(error));
  }
  render();
}

function downloadApprovedPricesForAccounting() {
  const items = state.approvedPriceItems || [];
  if (!items.length) {
    setNotice("error", "لا توجد أسعار معتمدة محفوظة للتصدير إلى المحاسبة.");
    render();
    return;
  }

  assertExcelSupport();
  const rows = items.map((item) => [
    item.itemName || "",
    Number(item.unit2Price || 0),
    item.unit2Name || "",
    Number(item.unit2Factor || 1),
    itemUnit1PriceFromSecondUnit(item),
    item.unit1Name || "",
    Number(item.stockQty || 0),
    item.stockStatus || "",
    item.approvedAt || item.updatedAt || ""
  ]);
  const worksheet = window.XLSX.utils.aoa_to_sheet([
    ["اسم المادة", "سعر البيع", "الكمية", "الحالة", "وقت الاعتماد"],
    ...rows
  ]);
  window.XLSX.utils.sheet_add_aoa(
    worksheet,
    [["اسم المادة", "سعر الوحدة الثانية", "الوحدة الثانية", "عامل التحويل", "سعر الوحدة الأولى", "الوحدة الأولى", "الكمية", "الحالة", "وقت الاعتماد"]],
    { origin: "A1" }
  );
  const workbook = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(workbook, worksheet, "accounting-prices");
  window.XLSX.writeFile(workbook, `tobacco-accounting-prices-${todayIsoDate()}.xlsx`);
  setNotice("success", "تم تنزيل الأسعار المعتمدة للمحاسبة.");
  render();
}

function customerPriceListItems(mode, options) {
  const prices = approvedPriceMap();
  const items = liveAvailableItems()
    .map((item) => {
      const key = item.key || normalizeItemName(item.name);
      const approvedPrice = prices.get(key);
      const pricedItem = { ...item, key, approvedPrice };
      const unit2Price = itemUnit2Price(pricedItem);
      const unit1Price = itemUnit1PriceFromSecondUnit(pricedItem);
      return {
        ...pricedItem,
        groupName: item.groupName || "مواد بدون مجموعة",
        unit1Name: itemUnit1Name(pricedItem),
        unit2Name: itemUnit2Name(pricedItem),
        unit2Factor: itemUnit2Factor(pricedItem),
        unit2Price,
        unit1Price,
        salePrice: unit1Price
      };
    })
    .filter((item) => itemQty(item) > 0 && (item.unit2Price > 0 || item.unit1Price > 0))
    .sort(
      (a, b) =>
        String(a.groupName || "").localeCompare(String(b.groupName || ""), "ar") ||
        String(a.name || "").localeCompare(String(b.name || ""), "ar")
    );
  // `skipMerge` لمن يحتاج الترشيح قبل الدمج (نشرة الجملة تستبعد ما دون وحدة
  // ثانية كاملة أولاً، تماماً كما يفعل المولّد، وإلا قد يسقط الصف المدموج
  // ويختفي صنف صالح كان سيظهر في النشرة).
  if (options && options.skipMerge) return items;
  return consolidateGeneralPriceItems(items, mode);
}

function isWazariPriceItem(item) {
  const name = normalizeItemName(item.name || item.itemName || "");
  if (name.includes("نخله") && (name.includes("محزر") || name.includes("وزاري"))) return true;
  if (name.includes("كينت") && !name.includes("حره")) return true;
  if (name.includes("وينستون") && !name.includes("حره")) return true;
  if (name.includes("فاخر") && name.includes("اسود") && name.includes("محزر")) return true;
  if (
    name.includes("مالبورو") &&
    (name.includes("محزر") ||
      (name.includes("ورق") && (name.includes("ابيض") || name.includes("احمر"))) ||
      (name.includes("كوين") && name.includes("ازرق")))
  ) return true;
  return false;
}

function hasFullSecondUnit(item) {
  const factor = itemUnit2Factor(item);
  return factor > 0 && itemQty(item) / factor >= 1;
}

function shishaPriceLabel(item) {
  const name = normalizeItemName(item.name || item.itemName || "");
  if (name.includes("مزايا")) return name.includes("كف") ? "مزايا كف" : "مزايا مشكل";
  if (name.includes("اسطوره")) return "أسطورة مشكل";
  if (name.includes("معسل روز")) return "روز مشكل";
  if (name.includes("صفوه")) return "صفوة جميع النكهات";
  if (name.includes("فاخر")) {
    if (name.includes("اسود") && name.includes("كف")) return "فاخر أسود كف";
    if (name.includes("اسود")) return "فاخر أسود كروز";
    if (name.includes("احمر")) return "فاخر أحمر كروز";
    return "فاخر نكهات";
  }
  return item.name || item.itemName || "";
}

function isGeneralShishaPriceItem(item) {
  const group = normalizeItemName(item.groupName || "");
  const name = normalizeItemName(item.name || item.itemName || "");
  return ["معسل", "مزايا", "نخله"].some((word) => group.includes(word)) ||
    ["معسل", "مزايا", "نخله", "فاخر", "صفوه", "اسطوره"].some((word) => name.includes(word));
}

function consolidateGeneralPriceItems(items, mode) {
  const regular = [];
  const merged = new Map();
  items.filter((item) => !isWazariPriceItem(item)).forEach((item) => {
    const normalizedName = normalizeItemName(item.name || item.itemName || "");
    if (isGeneralShishaPriceItem(item) && /100\s*غ/u.test(normalizedName)) return;
    if (!isGeneralShishaPriceItem(item) || normalizedName.includes("نخله")) {
      regular.push(item);
      return;
    }
    const label = shishaPriceLabel(item);
    const existing = merged.get(label);
    if (existing) {
      existing.sourceKeys.push(item.key);
      return;
    }
    merged.set(label, {
      ...item,
      name: label,
      itemName: label,
      groupName: "معسل",
      sourceKeys: [item.key].filter(Boolean)
    });
  });
  return mergeBulletinNamedGroups([...regular, ...merged.values()], mode);
}

function isMazayaPriceItem(item) {
  const groupName = normalizeItemName(item.groupName || "");
  const itemName = normalizeItemName(item.name || item.itemName || "");
  return groupName.includes("مزايا") || itemName.includes("مزايا");
}

// المزايا 100غ مستبعدة من النشرة (طلب الإدارة): لا تظهر ولا تؤثّر على سعر المزايا
function isMazaya100g(item) {
  return String(item.name || item.itemName || "").includes("100");
}

// دمج أصناف متشابهة في النشرة بسطر واحد (طلب الإدارة) — أضف الاسم القانوني هنا لدمج أي صنف يبدأ به
const BULLETIN_MERGE_NAMES = ["ماستر طويل ورق", "ماستر قصير أزرق", "اليغانس طويل فضي"];

function mergeBulletinNamedGroups(items, mode) {
  // القائمة إدارية وصريحة: الاسم الأساسي وما يبدأ به aliases لصنف واحد حتى لو
  // بقيت لهما أسعار قديمة مختلفة. نعتمد بيانات الاسم الأساسي ونحفظ مفاتيح كل
  // aliases كي يؤدي تعديل السطر المدمج إلى توحيد أسعارها في الحفظ التالي.
  const result = [...items];
  BULLETIN_MERGE_NAMES.forEach((display) => {
    const baseN = normalizeItemName(display);
    const named = result
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => {
        const n = normalizeItemName(item.name || item.itemName || "");
      return n === baseN || n.startsWith(baseN + " ");
    });
    if (!named.length) return;
    const exact = named.find(({ item }) => normalizeItemName(item.name || item.itemName || "") === baseN);
    const rep = exact || named[0];
    const anchor = Math.min(...named.map(({ index }) => index));
    result[anchor] = {
      ...rep.item,
      name: display,
      itemName: display,
      sourceKeys: named.map(({ item }) => item.key).filter(Boolean)
    };
    const dropped = named.map(({ index }) => index).filter((index) => index !== anchor);
    dropped.sort((a, b) => b - a).forEach((index) => result.splice(index, 1));
  });
  return result.sort(
    (a, b) =>
      String(a.groupName || "").localeCompare(String(b.groupName || ""), "ar") ||
      String(a.name || "").localeCompare(String(b.name || ""), "ar")
  );
}




// أسعار سطري المزايا: تُؤخذ تلقائيًا من النظام (صفحة الأسعار).
// القيمتان التاليتان احتياطيتان فقط — تُستعمل إذا لم يوجد سعر مُدخَل في النظام.
const MAZAYA_MIX_PRICE = 132;       // مزايا مشكل (شرحة) — احتياطي عند غياب السعر
const MAZAYA_BAHRAINI_PRICE = 135;  // مزايا بحريني (شرحة) — احتياطي عند غياب السعر
const MAZAYA_UNIT2_FACTOR = 12;     // عدد الكروز في شرحة المزايا (لقسمة سعر المفرق على الكروز)

function mergeMazayaPriceItems(items) {
  const allMazaya = items.filter(isMazayaPriceItem);
  if (!allMazaya.length) return items;
  // نستبعد المزايا 100غ نهائيًا من النشرة (لا تظهر ولا تؤثّر على السعر)
  const mazayaItems = allMazaya.filter((it) => !isMazaya100g(it));

  // مزايا مشكل = كل النكهات (أي صنف مزايا ليس بحرينيًا)
  const isBahrainiItem = (it) => normalizeItemName(it.name || it.itemName || "").includes("بحريني");
  const bahrainiItems = mazayaItems.filter(isBahrainiItem);
  const mixItems = mazayaItems.filter((it) => !isBahrainiItem(it));

  // السعر (الجملة) تلقائي من أول صنف مُسعّر؛ والقيمة الثابتة احتياط فقط.
  // نختار صنف المصدر الذي يملك سعر مفرق (retail) حتى يظهر السطر في نشرة المفرق،
  // ونثبّت عدد الكروز بالشرحة = 12 لتُقسم نشرة المفرق على الكروز.
  const base = mazayaItems[0];
  const hasRetailPrice = (it) =>
    Number(it && it.approvedPrice && it.approvedPrice.pricePayload && it.approvedPrice.pricePayload.retail && it.approvedPrice.pricePayload.retail.price) > 0;
  const makeMazayaLine = (name, key, srcItems, fallbackPrice) => {
    const priced = srcItems.find((it) => Number(it.unit2Price) > 0);
    const price = priced ? Number(priced.unit2Price) : fallbackPrice;
    const src = srcItems.find(hasRetailPrice) || priced || srcItems[0] || base;
    return {
      ...src,
      key,
      sourceKeys: srcItems.map((it) => it.key).filter(Boolean),
      name,
      itemName: name,
      groupName: "مزايا",
      unit1Name: "كروز",
      unit1Price: 0,
      unit2Name: "شرحة",
      unit2Factor: MAZAYA_UNIT2_FACTOR,
      unit2Price: price,
      salePrice: price
    };
  };

  const mazayaLines = [];
  if (mixItems.length) mazayaLines.push(makeMazayaLine("مزايا مشكل", "mazaya-mix", mixItems, MAZAYA_MIX_PRICE));
  if (bahrainiItems.length) mazayaLines.push(makeMazayaLine("مزايا بحريني", "mazaya-bahraini", bahrainiItems, MAZAYA_BAHRAINI_PRICE));

  return [...items.filter((item) => !isMazayaPriceItem(item)), ...mazayaLines].sort(
    (a, b) =>
      String(a.groupName || "").localeCompare(String(b.groupName || ""), "ar") ||
      String(a.name || "").localeCompare(String(b.name || ""), "ar")
  );
}

// صنف الأسطورة: سطر واحد بدل كل البنود (طلب الإدارة) — السعر يتبع البيانات تلقائيًا
function isOstoraPriceItem(item) {
  const groupName = normalizeItemName(item.groupName || "");
  const itemName = normalizeItemName(item.name || item.itemName || "");
  return groupName.includes("اسطوره") || itemName.includes("اسطوره");
}

function mergeOstoraPriceItems(items) {
  const ostora = items.filter(isOstoraPriceItem);
  if (!ostora.length) return items;

  const first = ostora.find((it) => it.unit2Price > 0) || ostora[0];
  const ostoraItem = {
    ...first,
    key: "ostora-all",
    sourceKeys: ostora.map((it) => it.key).filter(Boolean),
    name: "معسل الأسطورة",
    itemName: "معسل الأسطورة",
    groupName: "معسل الاسطورة",
    unit1Name: "",
    unit1Price: 0,
    unit2Name: first.unit2Name || "شرحة",
    unit2Factor: first.unit2Factor || 1,
    unit2Price: first.unit2Price > 0 ? first.unit2Price : 0,
    salePrice: first.unit2Price > 0 ? first.unit2Price : first.salePrice
  };

  return [...items.filter((item) => !isOstoraPriceItem(item)), ostoraItem].sort(
    (a, b) =>
      String(a.groupName || "").localeCompare(String(b.groupName || ""), "ar") ||
      String(a.name || "").localeCompare(String(b.name || ""), "ar")
  );
}

function groupCustomerPriceItems(items) {
  const groups = new Map();
  items.forEach((item) => {
    const groupName = item.groupName || "مواد بدون مجموعة";
    if (!groups.has(groupName)) groups.set(groupName, []);
    groups.get(groupName).push(item);
  });
  return [...groups.entries()].map(([name, groupItems]) => ({ name, items: groupItems }));
}

function customerPriceContactMarkup() {
  return customerPriceContacts
    .map(
      (contact) => `
        <span class="price-pdf-contact">
          <b>${escapeHtml(contact.label)}</b>
          ${escapeHtml(contact.value)}
        </span>
      `
    )
    .join("");
}

function pricePdfItem(item) {
  const unit2Label = item.unit2Name || item.unit1Name || "وحدة";
  const unit1Label = item.unit1Name || "حبة";
  const unit2Price = item.unit2Price > 0 ? formatMoney(item.unit2Price) : "";
  const unit1Price = item.unit1Price > 0 ? formatMoney(item.unit1Price) : "";
  const primaryPrice = unit2Price || unit1Price;
  const primaryUnit = unit2Price ? unit2Label : unit1Label;
  const secondaryText = unit2Price && unit1Price ? `${unit1Label}: ${unit1Price}` : "";
  return `
    <div class="price-pdf-item">
      <span class="price-pdf-name">${escapeHtml(item.name || "")}</span>
      <b>${escapeHtml(primaryPrice)}</b>
      <small>${escapeHtml(primaryUnit)}${secondaryText ? ` / ${escapeHtml(secondaryText)}` : ""}</small>
    </div>
  `;
}

function pricePdfItemUnits(item) {
  const nameLength = String(item.name || "").length;
  // الارتفاع الحقيقي ثابت تقريبًا لكل صنف؛ الإضافة فقط عند التفاف الاسم الطويل لسطرين
  return 1 + (nameLength > 42 ? 0.45 : 0);
}

function pricePdfRow(row) {
  if (row.type === "group") {
    return `<h2 class="price-pdf-group-title">${escapeHtml(row.name)}</h2>`;
  }
  return pricePdfItem(row.item);
}

function isSpecialPricePdfGroup(groupName) {
  const normalized = normalizeItemName(groupName || "");
  return ["معسل", "مزايا", "نخلة", "فحم", "ورق", "فيبات", "قداحات", "سلفان"]
    .some((name) => normalized.includes(normalizeItemName(name)));
}

function pricePdfPages(groups) {
  const maxUnits = 47;
  const groupUnits = 1.4;
  const pages = [{ columns: [[], []] }];
  let pageIndex = 0;
  let columnIndex = 0;
  let usedUnits = 0;

  function currentColumn() {
    return pages[pageIndex].columns[columnIndex];
  }

  function nextColumn() {
    columnIndex += 1;
    usedUnits = 0;
    if (columnIndex >= 2) {
      pages.push({ columns: [[], []] });
      pageIndex += 1;
      columnIndex = 0;
    }
  }

  function addRow(row, units) {
    if (usedUnits > 0 && usedUnits + units > maxUnits) nextColumn();
    currentColumn().push(row);
    usedUnits += units;
  }

  groups.filter((group) => !isSpecialPricePdfGroup(group.name)).forEach((group) => {
    let hasGroupTitle = false;
    group.items.forEach((item) => {
      const itemUnits = pricePdfItemUnits(item);
      if (!hasGroupTitle) {
        if (usedUnits > 0 && usedUnits + groupUnits + itemUnits > maxUnits) nextColumn();
        addRow({ type: "group", name: group.name }, groupUnits);
        hasGroupTitle = true;
      } else if (usedUnits > 0 && usedUnits + itemUnits > maxUnits) {
        nextColumn();
        addRow({ type: "group", name: group.name }, groupUnits);
      }
      addRow({ type: "item", item }, itemUnits);
    });
  });

  const specialGroups = groups.filter((group) => isSpecialPricePdfGroup(group.name));
  if (specialGroups.length) {
    const rightNames = ["فحم", "ورق", "فيبات", "قداحات", "سلفان"];
    const right = [];
    const left = [];
    specialGroups.forEach((group) => {
      const target = rightNames.some((name) => normalizeItemName(group.name).includes(normalizeItemName(name)))
        ? right
        : left;
      target.push({ type: "group", name: group.name });
      group.items.forEach((item) => target.push({ type: "item", item }));
    });
    pages.push({ columns: [right, left], special: true });
  }

  const visiblePages = pages.filter((page) => page.columns.some((column) => column.length));
  const lastGeneralPage = [...visiblePages].reverse().find((page) => !page.special);
  if (lastGeneralPage) balanceLastPricePdfPage(lastGeneralPage);
  return visiblePages;
}

// الصفحة العامة الأخيرة قد تحتوي أقل من عمود كامل، فيترك المولد القديم نصف A4 أبيض.
// نقسم صفوفها بين العمودين مع تكرار عنوان المجموعة عند استمرارها في العمود الثاني.
function balanceLastPricePdfPage(page) {
  const rows = [...page.columns[0], ...page.columns[1]];
  const itemCount = rows.filter((row) => row.type === "item").length;
  if (itemCount < 8) return;

  const totalUnits = rows.reduce((sum, row) => sum + (row.type === "group" ? 1.4 : pricePdfItemUnits(row.item)), 0);
  const targetUnits = totalUnits / 2;
  let usedUnits = 0;
  let splitIndex = rows.length;
  let activeGroup = "";
  let splitGroup = "";
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (row.type === "group") activeGroup = row.name;
    const units = row.type === "group" ? 1.4 : pricePdfItemUnits(row.item);
    if (usedUnits > 0 && usedUnits + units > targetUnits) {
      splitIndex = index;
      splitGroup = activeGroup;
      break;
    }
    usedUnits += units;
  }
  while (splitIndex < rows.length && rows[splitIndex]?.type === "group") splitIndex++;
  if (splitIndex <= 1 || splitIndex >= rows.length) return;

  const right = rows.slice(0, splitIndex);
  const left = rows.slice(splitIndex);
  if (left[0]?.type === "item" && splitGroup) left.unshift({ type: "group", name: splitGroup });
  page.columns = [right, left];
}

function pricePdfPage(page, index, totalPages, pdfTitle = "قائمة أسعار OZK TOBACCO") {
  const logoSrc = `${window.location.origin}/public/icons/ozk-logo.png`;
  return `
    <section class="price-pdf-page">
      ${index === 0 ? `
        <header class="price-pdf-header">
          <img class="price-pdf-logo" src="${logoSrc}" alt="OZK TOBACCO" />
          <div class="price-pdf-title-block">
            <h1>${escapeHtml(pdfTitle)}</h1>
            <p>نشرة أسعار الأصناف المتوفرة للزبائن</p>
            <p class="price-pdf-cash">البيع حصراً نقدي</p>
          </div>
          <div class="price-pdf-date">
            <span>تاريخ النشرة</span>
            <b>${escapeHtml(todayIsoDate())}</b>
          </div>
        </header>
        <div class="price-pdf-meta">
          ${customerPriceContactMarkup()}
        </div>
      ` : ""}
      <main class="price-pdf-groups">
        ${page.columns
          .map(
            (column) => `
              <div class="price-pdf-column">
                ${column.map(pricePdfRow).join("")}
              </div>
            `
          )
          .join("")}
      </main>
      <footer class="price-pdf-footer">
        <b>صفحة ${escapeHtml(index + 1)} من ${escapeHtml(totalPages)}</b>
      </footer>
    </section>
  `;
}

function pricePdfBook(groups, pdfTitle = "قائمة أسعار OZK TOBACCO") {
  const pages = pricePdfPages(groups);
  return pages
    .map((page, index) => pricePdfPage(page, index, pages.length, pdfTitle))
    .join("");
}

// أهم المجموعات تظهر أول النشرة/التقرير دائمًا (طلب الإدارة). أضِف مجموعات هنا بالترتيب المطلوب.
const PRIORITY_PRICE_GROUPS = ["غلواز", "ماستر"];

// رتبة المجموعة حسب الأولوية: 0 لأول مجموعة أولوية، فالأكبر لغير الأولوية (تُرتَّب بعدها أبجديًا).
function priorityGroupRank(name) {
  const n = normalizeItemName(name || "");
  const i = PRIORITY_PRICE_GROUPS.findIndex((g) => n.includes(normalizeItemName(g)));
  return i === -1 ? PRIORITY_PRICE_GROUPS.length : i;
}

function orderPriorityGroups(groups) {
  return [...groups].sort(
    (a, b) => priorityGroupRank(a.name) - priorityGroupRank(b.name) || String(a.name || "").localeCompare(String(b.name || ""), "ar")
  );
}

function bulletinDisplayGroups(items, useSyria = false) {
  return orderPriorityGroups(groupCustomerPriceItems(items));
}

function normalizedBulletinPdfTheme(theme = state.bulletinPdfTheme) {
  return theme === "light" ? "light" : "dark";
}

function storeBulletinPdfTheme(theme) {
  const normalized = normalizedBulletinPdfTheme(theme);
  state.bulletinPdfTheme = normalized;
  writeJson("bulletin-pdf-theme", normalized);
  return normalized;
}

function freshPublishedBulletinUrl(path) {
  const separator = String(path || "").includes("?") ? "&" : "?";
  return `${path}${separator}fresh=${Date.now()}`;
}

function formatBulletinEnglishInteger(value) {
  const number = Number(value);
  const rounded = Number.isFinite(number) ? Math.round(number) : 0;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(rounded);
}

// ملاحظة النشرة: نص اختياري لكل صنف (approvedPrice.notes) يُضاف بجانب الاسم في
// النشرة والـPDF بصيغة «الاسم — الملاحظة»، ويُترك الاسم كما هو إن كانت فارغة.
function bulletinItemDisplayName(item) {
  const name = item.name || "";
  const note = String((item.approvedPrice && item.approvedPrice.notes) || "").trim();
  return note ? `${name} — ${note}` : name;
}

// يقيس ارتفاع كل مجموعة فعلياً من DOM (رأس المجموعة + الجدول كاملاً + الحدود
// + margin-bottom الذي لا يدخل ضمن getBoundingClientRect) داخل حاوية مخفية
// بنفس عرض العمود الحقيقي، ثم يحسب توزيع المجموعات على الأعمدة/الصفحات عبر
// layoutGroupsMeasured — بلا تقدير ثابت بعدد الأسطر وبلا قصّ لأي مجموعة.
// يُستخدم من نفس الدالة (customerPricePdfMarkup) في المعاينة والتصدير معاً،
// فتحصل الشاشتان على نفس نتيجة التوزيع تماماً.
function buildMeasuredBulletinLayout(template, groups, renderOptions) {
  if (typeof document === "undefined" || typeof template?.layoutGroupsMeasured !== "function") return null;
  const probe = document.createElement("div");
  probe.style.position = "fixed";
  probe.style.left = "-10000px";
  probe.style.top = "0";
  probe.style.width = "794px";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  // تمريرة أولية بالتوزيع التقليدي فقط لالتقاط ارتفاع الرأس الحقيقي وعرض
  // العمود الحقيقي (نفس CSS المستخدم فعلياً)، وليست هي التوزيع النهائي.
  probe.innerHTML = template.render({ ...renderOptions, groups });
  document.body.appendChild(probe);
  try {
    const header = probe.querySelector(".price-list-header");
    const subheader = probe.querySelector(".price-list-subheader");
    const stackEl = probe.querySelector(".price-list-column-stack");
    const headerHeightPx = (header?.getBoundingClientRect().height || 0) + (subheader?.getBoundingClientRect().height || 0);
    const columnWidthPx = stackEl?.getBoundingClientRect().width || 385;

    const measureStack = document.createElement("div");
    measureStack.className = "price-list-column-stack";
    measureStack.style.width = `${columnWidthPx}px`;
    probe.querySelector(".ozk-price-list")?.appendChild(measureStack);
    const heights = new Map();
    groups.forEach((group) => {
      measureStack.innerHTML = template.renderGroup(group);
      const el = measureStack.firstElementChild;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const marginBottom = parseFloat(getComputedStyle(el).marginBottom) || 0;
      heights.set(String(group.name || ""), rect.height + marginBottom);
    });

    return template.layoutGroupsMeasured(groups, heights, {
      pageWidthPx: 794,
      headerHeightPx,
      safetyMarginPx: 6
    });
  } finally {
    probe.remove();
  }
}

function customerPricePdfMarkup(items, latest, useSyria = false, theme = state.bulletinPdfTheme) {
  const groups = bulletinDisplayGroups(items, useSyria);
  const template = window.OZKPriceListTemplate;
  if (!template) throw new Error("تعذر تحميل تصميم النشرة الجديدة. حدّث الصفحة وجرّب مجدداً.");
  const templateGroups = groups.map((group) => ({
    name: group.name,
    items: group.items.map((item) => ({
      name: bulletinItemDisplayName(item),
      unit: item.unit2Name || item.unit1Name || "وحدة",
      price: useSyria
        ? `${formatBulletinEnglishInteger(item.unit2Price)} ل.س`
        : `${Number(item.unit2Price || item.unit1Price || 0).toFixed(2)} $`
    }))
  }));
  const syriaFlag = '<span class="new-syria-flag" role="img" aria-label="علم سوريا الجديد"><span class="green"></span><span class="white">★★★</span><span class="black"></span></span>';
  const renderOptions = {
    logoSrc: `${window.location.origin}/public/icons/ozk-logo.png`,
    issueDate: template.formatArabicIssueDate(new Date()),
    badgeClass: useSyria ? "badge-syp" : "badge-usd",
    badgeLabelHtml: useSyria
      ? `${syriaFlag} ليرة — مفرق — صرف ${formatBulletinEnglishInteger(state.syriaExchangeRate)}`
      : "💵 دولار أمريكي — جملة",
    unitLabel: useSyria ? "سعر المفرق للوحدة" : "سعر الكرتونة (جملة)",
    theme: normalizedBulletinPdfTheme(theme)
  };
  const layout = buildMeasuredBulletinLayout(template, templateGroups, renderOptions);
  if (layout?.oversized?.length) {
    console.warn("نشرة الأسعار: مجموعة أطول من عمود صفحة كاملة، لم تُقصّ ولم توضع:", layout.oversized);
  }
  return template.render({ ...renderOptions, groups: templateGroups, layout: layout || undefined });
}

function customerPriceTemplatePageCount(items, useSyria = false) {
  const template = window.OZKPriceListTemplate;
  if (!template) return 0;
  const groups = bulletinDisplayGroups(items, useSyria).map((group) => ({ name: group.name, items: group.items }));
  return template.pageCount(groups);
}

let bulletinPublishTimer = null;

function refreshBulletinStatusNotice() {
  const element = app.querySelector("[data-bulletin-status]");
  if (!element) return;
  if (!state.bulletinStatus) {
    element.hidden = true;
    return;
  }
  element.hidden = false;
  element.className = `bulletin-status ${state.bulletinStatus.type || "muted"}`;
  element.textContent = state.bulletinStatus.msg || "";
}

// تحديث محلي فوري فقط (أثناء الكتابة) — لا يكتب على Supabase. يبقى للمعاينة
// اللحظية فقط؛ الحفظ الفعلي (مصدر الحقيقة) يمر حصراً عبر commitSyriaExchangeRate.
function applySyriaExchangeRateLocally(value) {
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  state.syriaExchangeRate = rate;
  writeJson("syria-exchange-rate", rate);
  return rate;
}

// الحفظ الفعلي لسعر الصرف: يكتب على جدول Supabase bulletin_exchange_rate —
// المصدر الوحيد للحقيقة الذي تقرأ منه المعاينة وPDF والنشر الآلي جميعاً.
async function commitSyriaExchangeRate(value) {
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  applySyriaExchangeRateLocally(rate);
  const saved = await dataStore.setSyriaExchangeRate(rate);
  applySyriaExchangeRateLocally(saved);
  return saved;
}

// نلتقط قيمة الحقل المرئية قبل أي حفظ قد يعيد رسم صفحة التسعير.
// بهذا تبقى المعاينة وPDF والنشر على نفس سعر الصرف الذي كتبه المستخدم الآن.
async function capturePublishedExchangeRate() {
  const rateInput = app.querySelector("[data-published-exchange-rate]");
  return commitSyriaExchangeRate(rateInput?.value ?? state.syriaExchangeRate);
}

function scheduleBulletinPublish(options = {}) {
  clearTimeout(bulletinPublishTimer);
  const label = options.label || "السعر";
  if (!localStorage.getItem("gh_publish_token")) {
    state.bulletinStatus = options.cloudFallback === false
      ? { type: "muted", msg: `حُفظ ${label} على هذا الجهاز. اضغط «اعتماد ونشر» لتطبيقه على النشرة العامة.` }
      : { type: "success", msg: `حُفظ ${label} — ستلتقطه السحابة تلقائياً خلال 15 دقيقة. زر «اعتماد ونشر» يبقى للنشر الفوري فقط.` };
    refreshBulletinStatusNotice();
    return;
  }
  state.bulletinStatus = { type: "muted", msg: `حُفظ ${label} — ستُحدّث النشرة تلقائياً بعد انتهاء تعديلاتك.` };
  refreshBulletinStatusNotice();
  bulletinPublishTimer = setTimeout(() => publishBulletin({ storedTokenOnly: true }), 15000);
}

async function publishBulletin(options = {}) {
  clearTimeout(bulletinPublishTimer);
  const REPO = "ozkkhallouf-ux/tobacco-web";
  const WORKFLOW = "generate-price-lists.yml";
  let rate;
  try {
    rate = await capturePublishedExchangeRate();
  } catch (error) {
    setNotice("error", `تعذر حفظ سعر الصرف: ${safeErrorMessage(error)}`);
    render();
    return;
  }
  if (rate === null) {
    setNotice("error", "أدخل سعر صرف صحيح قبل نشر النشرة.");
    render();
    return;
  }

  let token = localStorage.getItem("gh_publish_token");
  if (!token) {
    if (options.storedTokenOnly) return;
    token = prompt("أدخل GitHub Token لنشر النشرة (يُحفظ مرة واحدة على هذا الجهاز):");
    if (!token) return;
    localStorage.setItem("gh_publish_token", token.trim());
  }

  state.bulletinStatus = { type: "muted", msg: "⏳ جارٍ إرسال طلب التوليد..." };
  render();

  try {
    const resp = await fetch(
      `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/vnd.github+json",
        },
        // لا حقل rate هنا عمداً — الـworkflow يقرأ سعر الصرف من Supabase
        // (bulletin_exchange_rate) مباشرة، وهذا الحفظ أعلاه هو ما يحدّده.
        body: JSON.stringify({ ref: "main" }),
      }
    );

    if (resp.status === 204) {
      state.bulletinStatus = {
        type: "success",
        msg: `✅ تم إرسال سعر الصرف ${rate.toLocaleString()} — ستتولد النسختان الداكنة والفاتحة خلال دقيقتين، وبعدها افتح الروابط العلوية.`,
      };
    } else if (resp.status === 401 || resp.status === 403) {
      localStorage.removeItem("gh_publish_token");
      state.bulletinStatus = { type: "error", msg: "❌ Token غير صحيح أو منتهي — أعد المحاولة وأدخل token جديد." };
    } else {
      state.bulletinStatus = { type: "error", msg: `❌ خطأ ${resp.status} — تحقق من صلاحيات Token.` };
    }
  } catch {
    state.bulletinStatus = { type: "error", msg: "❌ تعذر الاتصال بـ GitHub. تحقق من الإنترنت." };
  }
  render();
}

// يجهّز عناصر النشرة (مع التحقق وتحويل العملة) — يرجع null إذا تعذّر المتابعة
function prepareBulletinItems(useSyria = false) {
  const latest = latestStockReport();
  // الوضع من نوع النشرة المصدَّرة لا من تبويب الصفحة: تصدير نشرة السوري
  // والصفحة على وضع الجملة كان يدمج بقرار الوضع الخاطئ.
  const bulletinMode = useSyria ? "mufrak" : "jumla";
  // الترشيح أولاً ثم الدمج: النشرة تُبنى من الأصناف المؤهَّلة وحدها.
  let items = customerPriceListItems(bulletinMode, { skipMerge: true });

  // الترشيح الكامل قبل الدمج في النشرتين، كترتيب المولّد حرفياً:
  // الجملة تستبعد ما دون وحدة ثانية كاملة، والسوري يستبعد ما لا سعر مفرق له.
  // بدون ترشيح السوري أولاً قد يُختار ممثّل بلا سعر مفرق فتسقط المجموعة كلها
  // لاحقاً رغم وجود صنف مسعّر فيها.
  if (useSyria) items = items.filter((item) => itemRetailPrice(item) > 0);
  else items = items.filter(hasFullSecondUnit);
  items = consolidateGeneralPriceItems(items, bulletinMode);

  if (useSyria) {
    // نشرة المفرّق: سعر المفرق يُدخل بسعر الكرتونة بالدولار → يقسم على عدد الكروز ثم × سعر الصرف
    const rate = Number(state.syriaExchangeRate) || 1;
    items = items
      .map((item) => {
        const retail = itemRetailPrice(item);
        const factor = itemUnit2Factor(item);
        return { ...item, unit2Price: Math.round((retail / factor) * rate), unit2Name: item.unit1Name || "كروز", unit2Factor: 1, unit1Price: 0, unit1Name: "" };
      })
      .filter((item) => item.unit2Price > 0);
  } else {
    // نشرة الجملة: سعر الكرتونة (الوحدة الثانية) بالدولار
    items = items
      .map((item) => {
        const whole = item.unit2Price > 0 ? item.unit2Price : item.unit1Price;
        const wholeName = item.unit2Price > 0 ? (item.unit2Name || "كرتونة") : (item.unit1Name || "وحدة");
        return { ...item, unit2Price: whole, unit2Name: wholeName, unit2Factor: 1, unit1Price: 0, unit1Name: "" };
      })
      .filter((item) => item.unit2Price > 0);
  }

  if (!latest || !items.length) {
    setNotice("error", "لا توجد مواد متوفرة ومُسعّرة لإنشاء نشرة PDF.");
    render();
    return null;
  }
  if (!window.html2pdf) {
    setNotice("error", "مكتبة PDF لم تتحمل. حدث الصفحة وجرب مرة أخرى.");
    render();
    return null;
  }
  if (!window.OZKPriceListTemplate) {
    setNotice("error", "تصميم النشرة الجديدة لم يتحمّل. حدّث الصفحة وجرّب مرة أخرى.");
    render();
    return null;
  }
  return { items, latest };
}

// يفتح معاينة النشرة قبل التصدير
function openPricePreview(useSyria = false, theme = state.bulletinPdfTheme) {
  if (useSyria && !state.syriaRateConfirmed) {
    state.showExchangeModal = true;
    render();
    return;
  }
  const prepared = prepareBulletinItems(useSyria);
  state.syriaRateConfirmed = false;
  if (!prepared) return;
  state.pricePreview = {
    open: true,
    useSyria,
    items: prepared.items,
    latest: prepared.latest,
    theme: storeBulletinPdfTheme(theme)
  };
  render();
}

function pricingRowTimestamp(row) {
  const value = row?.updatedAt || row?.approvedAt || row?.updated_at || row?.approved_at || row?.createdAt || row?.created_at || "";
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function newestApprovedPriceForKeys(keys) {
  const wanted = new Set((keys || []).filter(Boolean));
  return (state.approvedPriceItems || []).reduce((newest, row) => {
    if (!wanted.has(row.itemKey)) return newest;
    return !newest || pricingRowTimestamp(row) > pricingRowTimestamp(newest) ? row : newest;
  }, null);
}

function pricingFormNeedsSave(form) {
  if (form.dataset.dirty === "true") return true;
  let sourceKeys = [];
  try {
    sourceKeys = JSON.parse(form.dataset.sourceKeys || "[]").filter(Boolean);
  } catch {
    sourceKeys = [];
  }
  const saved = newestApprovedPriceForKeys([form.dataset.itemKey || "", ...sourceKeys]);
  const wholesaleText = formValue(form, "wholesalePrice");
  const retailText = formValue(form, "retailPrice");
  const wholesale = toPositivePrice(wholesaleText);
  const retail = toPositivePrice(retailText);
  return (wholesaleText !== "" && !samePrice(wholesale, Number(saved?.unit2Price || 0))) ||
    (retailText !== "" && !samePrice(retail, Number(saved?.pricePayload?.retail?.price || 0)));
}

// الطباعة وPDF يجب أن يعكسا ما كتبه المستخدم الآن، حتى لو لم يطلق المتصفح
// حدث input أو انتقل المستخدم مباشرةً من الحقل إلى زر المعاينة.
async function savePendingPricingEdits() {
  const pendingForms = [...app.querySelectorAll("[data-form='pricing-item']")].filter(pricingFormNeedsSave);
  for (const form of pendingForms) {
    const saved = await savePricingItem(form);
    if (!saved) return false;
  }
  // نبني المعاينة من تأكيد القاعدة بعد الحفظ، لا من نسخة state سابقة.
  await loadApprovedPriceItems();
  return true;
}

async function openFreshPricePreview(useSyria = false, theme = state.bulletinPdfTheme) {
  // يجب التقاط السعر قبل savePendingPricingEdits لأن حفظ صنف واحد قد يستدعي
  // render ويستبدل الحقل المرئي بنسخة state القديمة.
  if (useSyria && app.querySelector("[data-published-exchange-rate]")) {
    const rate = capturePublishedExchangeRate();
    if (rate === null) {
      setNotice("error", "أدخل سعر صرف صحيحاً أكبر من صفر قبل معاينة النشرة السورية.");
      render();
      return;
    }
    state.syriaRateConfirmed = true;
  }
  if (!(await savePendingPricingEdits())) {
    if (useSyria) state.syriaRateConfirmed = false;
    return;
  }
  openPricePreview(useSyria, theme);
}

function closePricePreview() {
  state.pricePreview = null;
  render();
}

// foreignObject يحفظ تشكيل العربية الصحيح، لكنه قد يلف أسماء مجموعات قصيرة
// أو يضغط سطور الاتصال عند نسخ القالب إلى SVG. نثبّت هذه العناصر في نسخة
// التصدير فقط؛ المعاينة والقالب المنشور يبقيان بلا أي تغيير.
function stabilizeBulletinPdfRtlLayout(source) {
  if (!source?.classList?.contains("ozk-price-list")) return;
  source.querySelectorAll(".price-list-group-header").forEach((header) => {
    header.style.whiteSpace = "nowrap";
    header.style.lineHeight = "1.35";
  });
  source.querySelectorAll(".price-list-secondary-page").forEach((page) => {
    // عرض التصدير 794px؛ ارتفاع A4 المقابل 1123px. يملأ هذا خلفية آخر صفحة
    // الداكنة حتى الحافة بدلاً من ترك الجزء السفلي أبيض بعد نهاية المحتوى.
    page.style.minHeight = "1123px";
  });
  const phones = source.querySelector(".price-list-phones");
  if (!phones) return;
  phones.style.display = "grid";
  phones.style.gridAutoRows = "min-content";
  phones.style.alignItems = "start";
  phones.style.justifyItems = "start";
  phones.querySelectorAll("span").forEach((line) => {
    line.style.display = "block";
    line.style.whiteSpace = "nowrap";
    line.style.lineHeight = "1.35";
  });
}

// يولّد ويحفظ ملف PDF من عناصر جاهزة
async function exportBulletinPdf(items, latest, useSyria = false, theme = state.bulletinPdfTheme) {
  if (!items || !items.length || !window.html2pdf) return;
  const selectedTheme = normalizedBulletinPdfTheme(theme);
  const backgroundColor = selectedTheme === "light" ? "#fffdf8" : "#0c0a07";
  // اسم الملف يتولد تلقائياً من تاريخ التصدير الفعلي وعملة النشرة — لا اسم ثابت
  // ولا تدخل يدوي؛ نفس المتغير يُستخدم لمساري سطح المكتب (html2pdf().save())
  // والجوال (createPortablePdfBlob/presentPortablePdf) فلا يوجد مصدر آخر لتحديثه.
  const filename = `نشرة-الأسعار-${useSyria ? "SYP" : "USD"}-${todayIsoDate()}.pdf`;
  const markup = customerPricePdfMarkup(items, latest, useSyria, selectedTheme);
  archiveToICloud("price_list", markup, { date: todayIsoDate() });

  // iOS داخل الـPWA لا ينفّذ تنزيل html2pdf().save() بشكل موثوق. نولّد Blob
  // حقيقياً ثم نعرض زر مشاركة مستقل؛ النقر على الزر يمنح Safari إيماءة مستخدم
  // جديدة فيسمح بالحفظ في Files أو الإرسال عبر واتساب.
  if (isHandheldDevice()) {
    try {
      const blob = await createPortablePdfBlob(markup, filename, {
        margin: [0, 0, 0, 0],
        width: 794,
        scale: 2,
        backgroundColor,
        image: { type: "jpeg", quality: 0.94 },
        allowTaint: true,
        // html2canvas يعيد ترتيب الحروف العربية عند الرسم التقليدي على Canvas.
        // مسار foreignObject يترك تشكيل RTL لمحرك المتصفح نفسه فيحفظ النص صحيحاً.
        foreignObjectRendering: true,
        stabilizeBulletinRtl: true,
        pagebreak: { mode: ["css"] }
      });
      presentPortablePdf(blob, filename, useSyria ? "نشرة المفرّق (ليرة)" : "نشرة الجملة (دولار)");
      setNotice("success", `تم تجهيز ${useSyria ? "نشرة المفرّق (ليرة)" : "نشرة الجملة (دولار)"} كملف PDF: ${items.length} صنف.`);
    } catch (error) {
      setNotice("error", safeErrorMessage(error) || "تعذر إنشاء ملف PDF.");
    }
    return;
  }

  const container = document.createElement("div");
  container.style.width = "794px";
  container.style.backgroundColor = backgroundColor;
  container.innerHTML = markup;
  document.body.appendChild(container);
  stabilizeBulletinPdfRtlLayout(container.querySelector(".ozk-price-list"));

  try {
    await window
      .html2pdf()
      .set({
        filename,
        margin: [0, 0, 0, 0],
        image: { type: "png", quality: 0.98 },
        html2canvas: {
          scale: 2,
          useCORS: true,
          backgroundColor,
          allowTaint: true,
          // يمنع قلب ترتيب العنوان والمجموعات وأسماء الأصناف العربية في PDF.
          foreignObjectRendering: true
        },
        jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
        pagebreak: { mode: ["css"] }
      })
      .from(container)
      .save();
    setNotice("success", `تم تجهيز ${useSyria ? "نشرة المفرّق (ليرة)" : "نشرة الجملة (دولار)"}: ${items.length} صنف.`);
  } catch (error) {
    setNotice("error", error.message || "تعذر إنشاء ملف PDF.");
  } finally {
    container.remove();
  }
}

// تصدير من شاشة المعاينة
async function exportPricePreview() {
  const preview = state.pricePreview;
  if (!preview) return;
  await exportBulletinPdf(preview.items, preview.latest, preview.useSyria, preview.theme);
  state.pricePreview = null;
  render();
}

function setPricePreviewTheme(theme) {
  if (!state.pricePreview) return;
  state.pricePreview.theme = storeBulletinPdfTheme(theme);
  render();
}

function approvedPriceMap() {
  return new Map((state.approvedPriceItems || []).filter((item) => item.itemKey).map((item) => [item.itemKey, item]));
}

function isSameIsoDay(value, isoDay = todayIsoDate()) {
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10) === isoDay;
  return date.toISOString().slice(0, 10) === isoDay;
}

function pricingWorklistItems({ ignoreSearch = false } = {}) {
  const prices = approvedPriceMap();
  const query = normalizeItemName(state.pricingSearch);
  return liveAvailableItems()
    .map((item) => {
      const key = item.key || normalizeItemName(item.name);
      const price = prices.get(key);
      return {
        ...item,
        key,
        itemGuid: item.itemGuid || price?.itemGuid || "",
        approvedPrice: price,
        salePrice: Number(price?.salePrice || 0),
        unit1Name: item.unit1Name || price?.unit1Name || "",
        unit2Name: item.unit2Name || price?.unit2Name || item.unit1Name || "",
        unit2Factor: itemUnit2Factor({ ...item, approvedPrice: price }),
        unit2Price: itemUnit2Price({ ...item, approvedPrice: price }),
        hasApprovedPrice: Boolean(price && (Number(price.salePrice || 0) > 0 || Number(price.unit2Price || 0) > 0))
      };
    })
    .filter((item) => {
      if (ignoreSearch || !query) return true;
      return String(item.key || "").includes(query) || normalizeItemName(item.name).includes(query);
    })
    .sort((a, b) => Number(a.hasApprovedPrice) - Number(b.hasApprovedPrice) || String(a.name || "").localeCompare(String(b.name || ""), "ar"));
}

// قائمة العمل داخل الموقع تطابق النشرة العامة: الوزاري منفصل والدمج ظاهر كما يراه الزبون.
// حد الوحدة الثانية يخص الجملة فقط؛ المفرق السوري يبقى متاحاً لأي مخزون موجب حسب القاعدة المعتمدة.
function generalPricingWorklistItems() {
  const allItems = pricingWorklistItems({ ignoreSearch: true });
  const items = pricingWorklistItems()
    .filter((item) => state.priceMode === "mufrak" ? itemQty(item) > 0 : hasFullSecondUnit(item));
  const consolidated = consolidateGeneralPriceItems(items, state.priceMode === "mufrak" ? "mufrak" : "jumla");

  // شرط الكرتونة الكاملة يحدد ظهور الصنف في نشرة الجملة فقط، ولا يجوز أن
  // يمنع تحديث سعر بقية أصناف المجموعة المدمجة ذات المخزون الموجب.
  return consolidated.map((item) => {
    if (!Array.isArray(item.sourceKeys) || !item.sourceKeys.length) return item;
    const label = normalizeItemName(item.name || item.itemName || "");
    const groupKeys = allItems
      .filter((candidate) => {
        const candidateName = normalizeItemName(candidate.name || candidate.itemName || "");
        return !isWazariPriceItem(candidate) &&
          isGeneralShishaPriceItem(candidate) &&
          !/100\s*غ/u.test(candidateName) &&
          normalizeItemName(shishaPriceLabel(candidate)) === label;
      })
      .map((candidate) => candidate.key)
      .filter(Boolean);
    return { ...item, sourceKeys: [...new Set([...item.sourceKeys, ...groupKeys])] };
  });
}

function downloadDailyPricingWorklist() {
  const latest = latestStockReport();
  const items = generalPricingWorklistItems();
  if (!latest || !items.length) {
    setNotice("error", "لا توجد مواد متوفرة لإنشاء قائمة تسعير اليوم.");
    render();
    return;
  }

  assertExcelSupport();
  const rows = items.map((item) => [
    item.name || "",
    itemQty(item),
    itemUnit2Name(item),
    itemUnit2Factor(item),
    item.unit2Price > 0 ? item.unit2Price : "",
    item.salePrice > 0 ? item.salePrice : "",
    itemUnit1Name(item),
    item.hasApprovedPrice ? "سعر معتمد" : "بحاجة تسعير",
    item.approvedPrice?.approvedAt || item.approvedPrice?.updatedAt || "",
    reportSyncedAt(latest)
  ]);
  const worksheet = window.XLSX.utils.aoa_to_sheet([
    ["اسم المادة", "الكمية المتوفرة", "سعر البيع", "حالة التسعير", "آخر اعتماد", "آخر مزامنة جرد"],
    ...rows
  ]);
  window.XLSX.utils.sheet_add_aoa(
    worksheet,
    [["اسم المادة", "الكمية المتوفرة", "الوحدة الثانية", "عامل التحويل", "سعر الوحدة الثانية", "سعر الوحدة الأولى", "الوحدة الأولى", "حالة التسعير", "آخر اعتماد", "آخر مزامنة جرد"]],
    { origin: "A1" }
  );
  const workbook = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(workbook, worksheet, "daily-pricing");
  window.XLSX.writeFile(workbook, `tobacco-daily-pricing-${todayIsoDate()}.xlsx`);
  setNotice("success", `تم تنزيل قائمة تسعير اليوم: ${items.length} مادة.`);
  render();
}

async function savePricingItem(form) {
  try {
    const latest = latestStockReport();
    const itemKey = form.dataset.itemKey || "";
    const sourceKeys = JSON.parse(form.dataset.sourceKeys || "[]").filter(Boolean);
    const itemName = form.dataset.itemName || "";
    const latestItem = reportItems(latest).find((item) => {
      const key = item.key || normalizeItemName(item.name);
      return key === itemKey || sourceKeys.includes(key);
    });
    const unit1Name = form.dataset.unit1Name || itemUnit1Name(latestItem) || "";
    const unit2Name = form.dataset.unit2Name || itemUnit2Name(latestItem) || unit1Name;
    const formUnit2Factor = toNumber(form.dataset.unit2Factor || 0);
    const liveUnit2Factor = itemUnit2Factor(latestItem);
    const unit2Factor = Math.max(1, liveUnit2Factor > 1 ? liveUnit2Factor : formUnit2Factor || 1);
    const wholesaleText = formValue(form, "wholesalePrice");
    const retailText = formValue(form, "retailPrice");
    const wholesaleProvided = wholesaleText !== "";
    const retailProvided = retailText !== "";
    const enteredWholesale = toPositivePrice(wholesaleText);
    const enteredRetail = toPositivePrice(retailText);
    // ملاحظة النشرة: نص اختياري يُطبَّق على كل أصناف السطر (كما تُطبَّق الأسعار
    // على aliases الصنف نفسه)، ويحل محل القيمة السابقة كاملةً — تفريغ الخانة يمسحها.
    const bulletinNoteText = formValue(form, "bulletinNote").trim().slice(0, 200);
    const stockQty = toNumber(form.dataset.stockQty);
    const stockStatus = form.dataset.stockStatus || "active";

    if ((!wholesaleProvided || enteredWholesale <= 0) && (!retailProvided || enteredRetail <= 0)) {
      throw new Error("اكتب سعر الجملة أو سعر المفرق بقيمة أكبر من صفر.");
    }
    if (!latest) throw new Error("لا يوجد جرد حي للمطابقة.");
    if (!itemKey || !itemName) throw new Error("لا يمكن حفظ السعر بدون مادة واضحة.");
    if (!dataStore.upsertApprovedPriceItems) throw new Error("حفظ الأسعار غير مفعل في قاعدة البيانات.");

    const requestedKeys = sourceKeys.length ? sourceKeys : [itemKey];
    const normalizedTargets = new Set(requestedKeys.map(normalizeItemName));
    // وحّد كل aliases القديمة للاسم نفسه (همزة/تاء مربوطة/نقاط) بالسعر الجديد.
    // بذلك لا تستطيع مزامنة المخزون إعادة سعر قديم إلى النشرة لاحقاً.
    const aliasKeys = (state.approvedPriceItems || [])
      .filter((price) => normalizedTargets.has(normalizeItemName(price.itemKey)) || normalizedTargets.has(normalizeItemName(price.itemName)))
      .map((price) => price.itemKey)
      .filter(Boolean);
    const targetKeys = [...new Set([...requestedKeys, ...aliasKeys])];
    const records = targetKeys.map((targetKey) => {
      // مطابقة المفتاح أولاً بالمطابقة الحرفية ثم بالتطبيع (همزة/تاء مربوطة/نقاط).
      // لا نسقط أبداً على الصنف المدمج (latestItem) إلا لمفتاح الصنف المطلوب نفسه:
      // السقوط عليه لبقية أصناف السطر المدمج ينسخ اسمه ووحدته ومخزونه فوقها
      // (عطل «معسل مزايا بولو» 2026-07-25 الذي شوّه ثمانية أصناف مزايا).
      const liveItems = reportItems(latest);
      const normalizedTarget = normalizeItemName(targetKey);
      // عند تصادم التطبيع (صنفان مختلفان يتطابقان بعد التطبيع) لا نختار أحدهما
      // عشوائياً: نتركهما معاً ونعتمد على الصف المحفوظ، كما في قاعدة رفض
      // التصادمات غير المحسومة في pull-item-numbers.ps1.
      const normalizedMatches = liveItems.filter((item) => normalizeItemName(item.key || item.name) === normalizedTarget
        || normalizeItemName(item.name) === normalizedTarget);
      const sourceItem = liveItems.find((item) => (item.key || normalizeItemName(item.name)) === targetKey)
        || (normalizedMatches.length === 1 ? normalizedMatches[0] : null)
        || (targetKey === itemKey ? latestItem : null);
      const sourceExisting = approvedPriceMap().get(targetKey);
      // مفتاح تابع مجهول تماماً (لا في الجرد الحي ولا في الأسعار المحفوظة) لا
      // يُنشأ له صف: أي بيانات نكتبها له ستكون بيانات السطر المدمج المصطنعة.
      if (!sourceItem && !sourceExisting && targetKey !== itemKey) return null;
      // عند غياب الصنف من الجرد الحي نُبقي بيانات صفّه المحفوظ كما هي ولا نغيّر إلا السعر.
      const sourceFactor = Math.max(1, sourceItem
        ? itemUnit2Factor(sourceItem)
        : Number(sourceExisting?.unit2Factor) || unit2Factor);
      const sourceExistingWholesale = Number(sourceExisting?.unit2Price || 0);
      const sourceExistingRetail = Number(sourceExisting?.pricePayload?.retail?.price || 0);
      const sourceUnit2Price = wholesaleProvided ? enteredWholesale : sourceExistingWholesale;
      const sourceRetailPrice = retailProvided ? enteredRetail : sourceExistingRetail;
      if (sourceUnit2Price <= 0 && sourceRetailPrice <= 0) return null;
      // sale_price يبقى سعراً مرجعياً للوحدة الأولى. سعر المفرق المستقل محفوظ
      // حصراً في price_payload.retail.price وتقرأه نشرة السوري مباشرة.
      const sourceSalePrice = roundPrice(
        (sourceUnit2Price > 0 ? sourceUnit2Price : sourceRetailPrice) / sourceFactor
      );
      const existingPayload = sourceExisting?.pricePayload || {};
      const sourcePayload = {
        ...existingPayload,
        ...(retailProvided
          ? { retail: { ...(existingPayload.retail || {}), price: enteredRetail } }
          : {}),
        source: "phone_pricing_page",
        ...(wholesaleProvided ? { pricedUnit: "unit2" } : {}),
        pricedDate: todayIsoDate()
      };
      return {
        itemKey: targetKey,
        itemName: sourceItem?.name || sourceExisting?.itemName || itemName,
        unit1Name: (sourceItem ? itemUnit1Name(sourceItem) : sourceExisting?.unit1Name) || unit1Name,
        unit2Name: (sourceItem ? itemUnit2Name(sourceItem) : sourceExisting?.unit2Name) || unit2Name,
        unit2Factor: sourceFactor,
        unit2Price: sourceUnit2Price,
        unit1Price: sourceSalePrice,
        salePrice: sourceSalePrice,
        stockQty: sourceItem ? itemQty(sourceItem) : Number(sourceExisting?.stockQty || 0),
        stockStatus: (sourceItem ? sourceItem.status : sourceExisting?.stockStatus) || stockStatus,
        sourceReportId: uuidOrNull(latest.id),
        sourceSyncedAt: reportSyncedAt(latest),
        pricePayload: sourcePayload,
        notes: bulletinNoteText
      };
    }).filter(Boolean);
    if (!records.length) throw new Error("لم يُعثر على الصنف في الجرد الحي ولا في الأسعار المحفوظة. حدّث الجرد ثم أعد المحاولة.");
    const saved = await dataStore.upsertApprovedPriceItems(records);

    if (!saved || !Array.isArray(saved)) {
      throw new Error("لم يتم استقبال تأكيد الحفظ من قاعدة البيانات. تأكد من الاتصال والصلاحيات.");
    }

    const priceMap = approvedPriceMap();
    saved.forEach((item) => priceMap.set(item.itemKey, item));
    state.approvedPriceItems = [...priceMap.values()].sort((a, b) => String(a.itemName || "").localeCompare(String(b.itemName || ""), "ar"));
    const mergedLabel = records.length > 1 ? ` على ${records.length} أصناف مدمجة` : "";
    // شفافية: مفاتيح السطر المدمج التي تُخطّيناها لعدم وضوح مطابقتها تُذكر بالعدد.
    const skippedCount = targetKeys.length - records.length;
    const skippedLabel = skippedCount > 0
      ? ` — وتُخطّي ${skippedCount} ${skippedCount === 1 ? "مفتاح غير واضح المطابقة" : "مفاتيح غير واضحة المطابقة"}`
      : "";
    const savedParts = [];
    if (wholesaleProvided) savedParts.push(`الجملة ${formatMoney(enteredWholesale)}$`);
    if (retailProvided) savedParts.push(`المفرق ${formatMoney(enteredRetail)}$`);
    const savedLabel = savedParts.join(" و");
    // تنبيه معلوماتي لا يمنع شيئاً: السعر المحفوظ تحت التكلفة.
    const savedCostRow = itemCostFor({ name: itemName, key: itemKey });
    const savedCostUnit2 = savedCostRow && Number(savedCostRow.avg_cost) > 0
      ? roundPrice(Number(savedCostRow.avg_cost) * unit2Factor)
      : 0;
    const belowCostLabel = (savedCostUnit2 > 0 && wholesaleProvided && enteredWholesale < savedCostUnit2)
      ? ` · ℹ️ تحت التكلفة (${formatMoney(savedCostUnit2)}$ لل${unit2Name || "كرتونة"}) — حُفظ كما هو`
      : "";
    setNotice("success", `✓ تم حفظ سعر ${savedLabel}: ${itemName}${mergedLabel}${skippedLabel}${belowCostLabel}`);
    scheduleBulletinPublish();
    render();
    return true;
  } catch (error) {
    setNotice("error", safeErrorMessage(error));
    render();
    return false;
  }
}

function downloadLatestInventoryReport() {
  const latest = latestStockReport();
  const items = reportItems(latest);
  if (!latest || !items.length) {
    setNotice("error", "لا يوجد تقرير جرد حي جاهز للتصدير.");
    render();
    return;
  }

  assertExcelSupport();
  const rows = items.map((item) => [
    item.name || "",
    Number(item.stockQty || 0),
    statusLabel(item.status),
    item.lowThreshold || latest.summary?.threshold || "",
    item.priceListed ? "نعم" : "لا"
  ]);
  const worksheet = window.XLSX.utils.aoa_to_sheet([
    ["المادة", "الكمية", "الحالة", "حد التنبيه", "ضمن لائحة الأسعار"],
    ...rows
  ]);
  const workbook = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(workbook, worksheet, "live-inventory");
  window.XLSX.writeFile(workbook, `tobacco-live-inventory-${todayIsoDate()}.xlsx`);
  setNotice("success", "تم تنزيل تقرير الجرد الحي من آخر مزامنة.");
  render();
}

function downloadFilteredInventoryReport() {
  const latest = latestStockReport();
  const items = ameenFilteredItems(reportItems(latest));
  if (!latest || !items.length) {
    setNotice("error", "لا توجد مواد معروضة للتصدير حسب البحث والفلتر الحالي.");
    render();
    return;
  }

  assertExcelSupport();
  const rows = items.map((item) => [
    item.name || "",
    itemQty(item),
    statusLabel(item.status),
    item.lowThreshold || latest.summary?.threshold || "",
    item.priceListed ? "نعم" : "لا"
  ]);
  const worksheet = window.XLSX.utils.aoa_to_sheet([
    ["المادة", "الكمية", "الحالة", "حد التنبيه", "ضمن لائحة الأسعار"],
    ...rows
  ]);
  const workbook = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(workbook, worksheet, "filtered-inventory");
  window.XLSX.writeFile(workbook, `tobacco-filtered-inventory-${todayIsoDate()}.xlsx`);
  setNotice("success", "تم تنزيل المواد المعروضة حسب البحث والفلتر الحالي.");
  render();
}

function downloadFilteredCustomerBalances() {
  const latest = state.customerBalanceReports[0];
  const items = filteredCustomerItems(latestCustomerBalanceItems());
  if (!latest || !items.length) {
    setNotice("error", "لا توجد أرصدة زبائن معروضة للتصدير حسب البحث والفلتر الحالي.");
    render();
    return;
  }

  assertExcelSupport();
  const rows = items.map((item) => [
    item.name || "",
    customerBalance(item),
    customerLimit(item) > 0 ? customerLimit(item) : "",
    customerLimit(item) > 0 ? customerRemainingLimit(item) : "",
    customerLastPaymentAmount(item) > 0 ? customerLastPaymentAmount(item) : "",
    customerLastPaymentDate(item) || "",
    customerStatusLabel(item.status)
  ]);
  const worksheet = window.XLSX.utils.aoa_to_sheet([
    ["الزبون", "الرصيد", "الحد المسموح", "المتبقي من الحد", "آخر دفعة", "تاريخ آخر دفعة", "الحالة"],
    ...rows
  ]);
  const workbook = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(workbook, worksheet, "customer-balances");
  window.XLSX.writeFile(workbook, `tobacco-customer-balances-${todayIsoDate()}.xlsx`);
  setNotice("success", "تم تنزيل أرصدة الزبائن المعروضة حسب البحث والفلتر الحالي.");
  render();
}

async function installApp() {
  if (!state.installPrompt) return;
  state.installPrompt.prompt();
  await state.installPrompt.userChoice;
  state.installPrompt = null;
  render();
}

function completionPercent() {
  return Math.round((state.completed.size / roadmapItems.length) * 100);
}

function shell(content) {
  if (isInventoryCounter()) {
    return `
      <div class="app-shell route-smartInventory counter-shell">
        <aside class="sidebar" aria-label="التنقل">
          <div class="brand"><img src="public/icons/ozk-logo.png" alt=""><span>${escapeHtml(appConfig.name)}</span></div>
          <nav>${navButton("smartInventory", "📋 الجرد الذكي")}</nav>
        </aside>
        <main class="main"><header class="topbar"><div><h1>الجرد الذكي</h1></div><div class="topbar-actions">
          <button class="button secondary theme-toggle" data-action="toggle-theme">${state.darkMode ? "☀️" : "🌙"}</button>
          <button class="button secondary" data-action="logout">تسجيل الخروج — ${escapeHtml(state.session.name)}</button>
        </div></header>${connectionNotice()}${messagePanel()}${state.loading ? loadingPanel() : content}</main>
      </div>`;
  }
  return `
    <div class="app-shell route-${escapeHtml(state.route)}">
      <aside class="sidebar" aria-label="التنقل">
        <a class="brand" href="#" data-route="overview" aria-label="الرئيسية">
          <img src="public/icons/ozk-logo.png" alt="">
          <span>${escapeHtml(appConfig.name)}</span>
        </a>
        <nav>
          ${navButton("overview", "🏠 الرئيسية")}
          ${state.session ? navButton("dashboard", "📑 التقارير") : ""}
          ${navButton("login", "🔑 تسجيل الدخول")}
          ${navButton("ameen", "📦 الأمين")}
          ${state.session ? navButton("balances", "💳 أرصدة الزبائن") : ""}
          ${navButton("pricing", "نشرة الأسعار")}
          ${state.session ? navButton("sales", "🧮 فاتورة مبيعات") : ""}
          ${state.session ? navButton("purchases", "🧾 فواتير مشتريات") : ""}
          ${state.session ? navButton("warehouses", "🏭 المستودعات والمناقلات") : ""}
          ${state.session ? navButton("inventoryRecon", "📋 الجرد الشهري") : ""}
          ${isOwner() ? navButton("smartInventory", "✅ الجرد الذكي") : ""}
          ${state.session ? navButton("staff", "👥 الموظفون") : ""}
          ${state.session ? navButton("ai", "🤖 المساعد الذكي") : ""}
        </nav>
        <div style="margin-top:auto;padding-top:20px;border-top:1px solid #2f2415">
          <a href="privacy-policy.html" style="display:block;font-size:0.78rem;color:#7a6040;text-align:center;text-decoration:none;padding:6px 0;" target="_blank">سياسة الخصوصية</a>
          <a href="terms-of-use.html" style="display:block;font-size:0.78rem;color:#7a6040;text-align:center;text-decoration:none;padding:6px 0;" target="_blank">شروط الاستخدام</a>
        </div>
      </aside>
      <main class="main">
        <header class="topbar">
          <div>
            <h1>${pageTitle()}</h1>
          </div>
          <div class="topbar-actions">
            ${state.session ? `
              <form class="search-wrap" data-form="global-search">
                <input class="search-input" name="q" placeholder="🔍 بحث…" value="${escapeHtml(state.globalSearch)}" autocomplete="off" dir="auto">
              </form>
            ` : ""}
            <button class="button secondary theme-toggle" data-action="toggle-theme" title="${state.darkMode ? "وضع النهار" : "وضع الليل"}">${state.darkMode ? "☀️" : "🌙"}</button>
            ${state.installPrompt ? '<button class="button secondary" data-action="install">تثبيت</button>' : ""}
            ${state.session ? `<button class="button secondary" data-action="logout">${escapeHtml(state.session.name)}</button>` : ""}
            <a class="button primary" href="mailto:${escapeHtml(appConfig.supportEmail)}">الدعم</a>
          </div>
        </header>
        ${connectionNotice()}
        ${notifPermissionBanner()}
        ${messagePanel()}
        ${state.loading ? loadingPanel() : content}
      </main>
    </div>
  `;
}

function connectionNotice() {
  if (state.startupDegraded) {
    return `
      <section class="notice-panel warning" data-startup-degraded>
        <span><strong>تعذر الاتصال بقاعدة البيانات.</strong> فُتحت الواجهة بدون بعض البيانات ولم يتم تنفيذ أي حفظ. أعد المحاولة بعد عودة الاتصال.</span>
        <button class="button primary" type="button" data-action="retry-startup">إعادة المحاولة</button>
      </section>
    `;
  }
  return "";
}

function messagePanel() {
  if (!state.notice) return "";
  return `<section class="message-panel ${state.notice.type}">${escapeHtml(state.notice.text)}</section>`;
}

function loadingPanel() {
  return `<section class="panel wide"><h2>جاري التحميل...</h2><p class="muted">نجهز بيانات التطبيق.</p></section>`;
}

const NAV_HINTS = {
  overview: "لوحة المعلومات والبدء السريع",
  decision: "ملخص تنفيذي للتحصيل والموردين",
  dashboard: "حركة مبيعات وأرصدة اليوم",
  login: "دخول الموظفين والإدارة",
  ameen: "مخزون وتقارير من نظام الأمين",
  balances: "أرصدة وحدود ائتمانية للزبائن",
  pricing: "تسعير ونشر نشرة الجملة والمفرق",
  sales: "إنشاء فاتورة بيع للزبون",
  purchases: "فواتير المشتريات والتزامات الموردين",
  warehouses: "مخزون المستودعات والمناقلات بينها",
  inventoryRecon: "مطابقة الجرد الشهري مع النظام",
  smartInventory: "جرد يومي أعمى ومتابعة الفروقات للمالك",
  staff: "إدارة حسابات وصلاحيات الموظفين",
  ai: "مساعد ذكي للأسئلة والاستفسارات"
};

function navButton(route, label) {
  const active = state.route === route ? "active" : "";
  const hint = NAV_HINTS[route];
  const title = hint ? ` title="${escapeHtml(hint)}"` : "";
  return `<button class="nav-link ${active}" data-route="${route}"${title}>${label}</button>`;
}

function pageTitle() {
  return {
    overview: "لوحة OZK",
    decision: "قرار اليوم",
    login: "تسجيل الدخول",
    requests: "طلبات العملاء",
    ameen: "تقارير الأمين",
    balances: "أرصدة الزبائن والحد المسموح",
    pricing: "نشرة الأسعار",
    remote: "الإدارة عن بعد",
    monitoring: "المراقبة",
    payments: "الدفع",
    ai: "المساعد الذكي",
    sales: "فاتورة مبيعات",
    purchases: "فواتير المشتريات",
    warehouses: "المستودعات والمناقلات",
    inventoryRecon: "الجرد الشهري",
    smartInventory: "الجرد الذكي",
    dashboard: "التقارير",
    staff: "إدارة الموظفين",
    search: `نتائج: ${escapeHtml(state.globalSearch)}`
  }[state.route];
}

function overview() {
  const contactInfo = [];
  if (appConfig.centerNumber) {
    contactInfo.push(`المركز: ${escapeHtml(appConfig.centerNumber)}`);
  }
  if (appConfig.privateNumber) {
    contactInfo.push(`الخاص: ${escapeHtml(appConfig.privateNumber)}`);
  }

  const live = dataStore.isConfigured();
  const quickActions = state.session
    ? [
        ...(isOwner() ? [{ route: "decision", label: "📌 قرار اليوم", hint: "ملخص تنفيذي للتحصيل والموردين" }] : []),
        { route: "pricing", label: "📋 نشرة الأسعار", hint: "تسعير ونشر للزبائن" },
        { route: "ameen", label: "📦 الأمين", hint: "مخزون وتقارير" },
        { route: "dashboard", label: "📑 التقارير", hint: "حركة اليوم" }
      ]
    : [
        { route: "login", label: "🔑 تسجيل الدخول", hint: "ابدأ من هنا" },
        { route: "pricing", label: "📋 نشرة الأسعار", hint: "معاينة النشرة العامة" },
        { route: "ameen", label: "📦 الأمين", hint: "حالة مزامنة المخزون" }
      ];

  const quickCards = quickActions
    .map(
      (item) => `
        <button class="quick-card" type="button" data-route="${item.route}" title="${escapeHtml(item.hint)}">
          <span class="quick-label">${item.label}</span>
          <span class="quick-hint">${escapeHtml(item.hint)}</span>
        </button>`
    )
    .join("");

  const systemStatus = live
    ? `<span class="status-dot ok"></span> متصل بقاعدة Supabase`
    : `<span class="status-dot warn"></span> وضع تجريبي محلي`;

  return shell(`
    <section class="hero-panel business-hero">
      <div class="hero-copy">
        <img class="hero-logo" src="public/icons/ozk-logo.png" alt="OZK TOBACCO" />
        <h1 style="font-weight: bold; font-size: 1.8em; margin: 20px 0 10px 0;">مركز أبو زياد OZK TOBACCO</h1>
        <p style="font-size: 1.1em; margin: 10px 0 20px 0;">لتجارة الدخان الوطني والأجنبي والمستورد</p>
        ${contactInfo.length > 0 ? `<p style="margin: 15px 0 0 0; color: #666;">${contactInfo.join(" | ")}</p>` : ""}
      </div>
    </section>

    <section class="panel wide">
      <div class="panel-title-row">
        <h2>بدء سريع</h2>
        <span class="system-status">${systemStatus}</span>
      </div>
      <div class="quick-grid">${quickCards}</div>
      ${state.session ? "" : '<p class="muted">سجّل الدخول لفتح الأقسام الإدارية (التقارير، الفواتير، المستودعات، الموظفون).</p>'}
    </section>
  `);
}

function login() {
  const live = dataStore.isConfigured();
  const recovering = live && dataStore.isPasswordRecovery?.();
  if (recovering) {
    return shell(`
      <section class="panel wide form-layout">
        <div><h2>اختيار كلمة مرور جديدة</h2><p class="muted">اكتب كلمة مرور قوية للحساب، ثم سجّل الدخول بها.</p></div>
        <form class="form-card" data-form="password-recovery">
          <label>كلمة المرور الجديدة<input name="password" type="password" minlength="10" autocomplete="new-password" required></label>
          <label>تأكيد كلمة المرور<input name="passwordConfirmation" type="password" minlength="10" autocomplete="new-password" required></label>
          <button class="button primary" type="submit">حفظ كلمة المرور</button>
        </form>
      </section>
    `);
  }
  if (live && state.passwordResetMode) {
    return shell(`
      <section class="panel wide form-layout">
        <div>
          <h2>تغيير كلمة المرور برمز الاستعادة</h2>
          <p class="muted">أدخل البريد نفسه والرمز الرقمي كاملاً من أحدث رسالة (إعداد Supabase الحالي: 8 أرقام)، ثم اختر كلمة مرور جديدة.</p>
        </div>
        <form class="form-card" data-form="password-recovery-code">
          <label>البريد الإلكتروني<input name="email" type="email" value="${escapeHtml(state.passwordResetEmail)}" autocomplete="email" required></label>
          <label>رمز الاستعادة<input name="recoveryCode" type="text" inputmode="numeric" pattern="[0-9]{6,10}" minlength="6" maxlength="10" autocomplete="one-time-code" required></label>
          <label>كلمة المرور الجديدة<input name="password" type="password" minlength="10" autocomplete="new-password" required></label>
          <label>تأكيد كلمة المرور<input name="passwordConfirmation" type="password" minlength="10" autocomplete="new-password" required></label>
          <button class="button primary" type="submit">التحقق وحفظ كلمة المرور</button>
          <button class="button secondary" type="button" data-action="cancel-password-reset">العودة إلى تسجيل الدخول</button>
        </form>
      </section>
    `);
  }
  return shell(`
    <section class="panel wide form-layout">
      <div>
        <h2>دخول الموظفين والإدارة</h2>
        <p class="muted">${live ? "موظف الجرد يدخل باسم المستخدم وكلمة المرور. الإدارة تدخل بالبريد المعتاد." : "هذا دخول تجريبي محلي."}</p>
      </div>
      ${state.session ? `
        <div class="notice-panel success">
          <strong>أنت داخل الآن</strong>
          <span>${escapeHtml(state.session.name)} — ${escapeHtml(state.session.role)}</span>
        </div>
      ` : ""}
      ${live ? `<form class="form-card smart-login-card" data-form="inventory-counter-login">
        <h3>دخول موظف الجرد</h3>
        <label>اسم المستخدم<input name="username" autocomplete="username" maxlength="48" required></label>
        <label>كلمة المرور<input name="password" type="password" autocomplete="current-password" minlength="8" maxlength="128" required></label>
        <button class="button primary" type="submit">دخول إلى الجرد فقط</button>
        <p class="muted">لا تحتاج Gmail أو بريداً شخصياً. الحساب ينشئه المالك.</p>
      </form><div class="smart-login-divider"><span>دخول الإدارة</span></div>` : ""}
      <form class="form-card" data-form="login">
        ${live ? "" : `
          <label>
            الاسم
            <input name="name" placeholder="مثال: أحمد" autocomplete="name">
          </label>
        `}
        <label>
          البريد الإلكتروني
          <input name="email" type="email" placeholder="example@gmail.com" autocomplete="email" ${live ? "required" : ""}>
        </label>
        <label>
          كلمة المرور
          <input name="password" type="password" placeholder="8 أحرف على الأقل" minlength="8" autocomplete="current-password" ${live ? "required" : ""}>
        </label>
        <div class="button-row">
          <button class="button primary" type="submit" data-auth-action="signin">دخول</button>
          ${live ? "" : '<button class="button secondary" type="submit" data-auth-action="signup">إنشاء حساب تجريبي</button>'}
        </div>
        ${live ? '<button class="button secondary" type="button" data-action="forgot-password">نسيت كلمة المرور</button>' : ""}
      </form>
    </section>
  `);
}

function smartInventoryPage() {
  if (!state.session || !SMART_INVENTORY_ROLES.has(state.session.accessRole)) return shell('<section class="notice-panel error">ليس لديك صلاحية الجرد الذكي.</section>');
  return shell(window.SmartInventory?.render(state.session) || '<section class="panel wide"><p>جاري تحميل وحدة الجرد…</p></section>');
}

function requests() {
  const loginPrompt =
    dataStore.isConfigured() && !state.session
      ? '<p class="muted">سجل الدخول أولا حتى تظهر طلبات Supabase وتستطيع إضافة طلب جديد. إذا أنشأت الحساب للتو، قد تحتاج تأكيد البريد أولا.</p>'
      : "";

  return shell(`
    <section class="content-grid request-layout">
      <article class="panel">
        <h3>إضافة طلب عميل</h3>
        ${loginPrompt}
        <form class="form-card compact" data-form="request">
          <label>
            اسم العميل
            <input name="customer" maxlength="120" placeholder="اسم العميل أو رقم الطلب">
          </label>
          <label>
            القناة
            <select name="channel">
              <option>واتساب</option>
              <option>هاتف</option>
              <option>ويب</option>
              <option>زيارة فرع</option>
            </select>
          </label>
          <label>
            نوع الطلب
            <select name="type">
              <option>استفسار</option>
              <option>شكوى</option>
              <option>متابعة</option>
              <option>طلب خدمة</option>
            </select>
          </label>
          <label>
            ملاحظة
            <textarea name="note" rows="4" maxlength="1000" placeholder="اكتب ملخص الطلب"></textarea>
          </label>
          <button class="button primary" type="submit">حفظ الطلب</button>
        </form>
      </article>
      <article class="panel">
        <div class="panel-title-row">
          <h3>سجل الطلبات</h3>
          <div style="display:flex;gap:8px">
            <button class="button secondary compact-button" type="button" data-action="export-monthly">📥 التقرير الشهري (إكسل)</button>
            <button class="button secondary compact-button" type="button" data-action="export-ameen">تصدير للأمين</button>
          </div>
        </div>
        <p class="muted">يُصدر الملف بصيغة CSV قابلة للفتح في إكسل. عند معرفة قالب استيراد الأمين لديك نطابق الأعمدة معه بدقة.</p>
        <div class="request-list">
          ${state.requests.length ? state.requests.map(requestCard).join("") : loginPrompt || '<p class="muted">لا توجد طلبات بعد.</p>'}
        </div>
      </article>
    </section>
  `);
}

function reportItems(report) {
  return Array.isArray(report?.items) ? report.items : [];
}

function reportSyncedAt(report) {
  return report?.summary?.syncedAt || report?.created_at || report?.summary?.reportDate || report?.report_date || "";
}

function statusLabel(status) {
  return {
    active: "فعالة",
    low: "قريبة من النفاد",
    out: "غير موجودة",
    stale: "راكدة"
  }[status] || status;
}

const ameenFilters = [
  { id: "alerts", label: "تنبيهات" },
  { id: "all", label: "الكل" },
  { id: "low", label: "قريب النفاد" },
  { id: "zero", label: "صفر" },
  { id: "negative", label: "سالب" },
  { id: "available", label: "موجود" }
];

function itemQty(item) {
  const qty = Number(item?.stockQty || 0);
  const positiveQty = Number(item?.stockQtyPositive || 0);
  return qty > 0 ? qty : positiveQty;
}

function itemUnit1Name(item) {
  return item?.unit1Name || item?.approvedPrice?.unit1Name || "الوحدة الأولى";
}

function itemUnit2Name(item) {
  return item?.unit2Name || item?.approvedPrice?.unit2Name || itemUnit1Name(item);
}

function itemUnit2Factor(item) {
  const factor = Number(item?.unit2Factor || item?.approvedPrice?.unit2Factor || 1);
  return Number.isFinite(factor) && factor > 0 ? factor : 1;
}

function itemUnit2Price(item) {
  // السعر المعتمد هو مصدر النشرة. تقرير المخزون قد يحمل لقطة سعر أقدم، لذلك
  // لا يجوز أن يتغلب item.unit2Price على آخر سعر حُفظ في approved_price_items.
  const approvedPrice = item?.approvedPrice || null;
  const approvedUnit2Price = Number(approvedPrice?.unit2Price);
  const savedUnit2Price = approvedPrice && Number.isFinite(approvedUnit2Price)
    ? approvedUnit2Price
    : Number(item?.unit2Price || 0);
  if (savedUnit2Price > 0) return roundPrice(savedUnit2Price);
  const unit1Price = approvedPrice
    ? Number(approvedPrice.salePrice || approvedPrice.unit1Price || 0)
    : Number(item?.salePrice || item?.unit1Price || 0);
  return unit1Price > 0 ? roundPrice(unit1Price * itemUnit2Factor(item)) : 0;
}

function itemUnit1PriceFromSecondUnit(item) {
  const approvedPrice = item?.approvedPrice || null;
  const approvedUnit2Price = Number(approvedPrice?.unit2Price);
  const unit2Price = approvedPrice && Number.isFinite(approvedUnit2Price)
    ? approvedUnit2Price
    : Number(item?.unit2Price || 0);
  const unit2Factor = itemUnit2Factor(item);
  if (unit2Price > 0 && unit2Factor > 0) return roundPrice(unit2Price / unit2Factor);
  return roundPrice(approvedPrice
    ? Number(approvedPrice.salePrice || approvedPrice.unit1Price || 0)
    : Number(item?.salePrice || item?.unit1Price || 0));
}

function isNegativeItem(item) {
  return itemQty(item) < 0;
}

function isZeroItem(item) {
  return itemQty(item) === 0;
}

function isLowPositiveItem(item) {
  return item.status === "low" && itemQty(item) > 0;
}

function isAlertItem(item) {
  return isNegativeItem(item) || isZeroItem(item) || isLowPositiveItem(item);
}

function ameenFilterCounts(items) {
  return {
    all: items.length,
    alerts: items.filter(isAlertItem).length,
    low: items.filter(isLowPositiveItem).length,
    zero: items.filter(isZeroItem).length,
    negative: items.filter(isNegativeItem).length,
    available: items.filter((item) => itemQty(item) > 0).length
  };
}

function matchesAmeenSearch(item, query) {
  const text = query.trim();
  if (!text) return true;
  const normalizedQuery = normalizeItemName(text);
  const normalizedName = normalizeItemName(item.name || "");
  return (
    String(item.name || "").includes(text) ||
    String(item.key || "").includes(normalizedQuery) ||
    normalizedName.includes(normalizedQuery)
  );
}

function filterAmeenItems(items, filter, query) {
  return items.filter((item) => {
    if (!matchesAmeenSearch(item, query)) return false;
    if (filter === "low") return isLowPositiveItem(item);
    if (filter === "zero") return isZeroItem(item);
    if (filter === "negative") return isNegativeItem(item);
    if (filter === "available") return itemQty(item) > 0;
    if (filter === "alerts") return isAlertItem(item);
    return true;
  });
}

function sortAmeenItems(items, sort) {
  const sorted = [...items];
  if (sort === "qtyDesc") {
    sorted.sort((a, b) => itemQty(b) - itemQty(a));
  } else if (sort === "nameAsc") {
    sorted.sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "ar"));
  } else {
    sorted.sort((a, b) => itemQty(a) - itemQty(b));
  }
  return sorted;
}

function ameenFilteredItems(items) {
  return sortAmeenItems(filterAmeenItems(items, state.ameenFilter, state.ameenSearch), state.ameenSort);
}

function ameenSyncState(syncedAt) {
  const minutes = minutesSince(syncedAt);
  if (minutes === null) {
    return { type: "warning", label: "وقت المزامنة غير معروف" };
  }
  if (minutes > 5) {
    return { type: "warning", label: `المزامنة متأخرة: قبل ${minutes} دقيقة` };
  }
  return { type: "success", label: "المزامنة تعمل" };
}

const customerFilters = [
  { id: "debit_balance", label: "عليه رصيد" },
  { id: "credit_balance", label: "له رصيد" },
  { id: "clear", label: "بلا رصيد" },
  { id: "no_limit", label: "بلا حد" },
  { id: "over_limit", label: "تجاوز الحد" },
  { id: "near_limit", label: "قريب من الحد" },
  { id: "all", label: "الكل" }
];

function customerBalance(item) {
  return Number(item?.balance || 0);
}

function customerKey(item) {
  return String(item?.key || normalizeItemName(item?.name || "")).trim();
}

function customerLimit(item) {
  return Number(item?.creditLimit || 0);
}

function customerRemainingLimit(item) {
  return Number(item?.remainingLimit || 0);
}

function customerLastPaymentAmount(item) {
  return Number(item?.lastPaymentAmount || 0);
}

function customerLastPaymentDate(item) {
  return item?.lastPaymentDate || "";
}

function customerLimitSourceLabel(source) {
  return {
    internal: "حد داخلي",
    ameen: "حد من الأمين",
    none: "بلا حد"
  }[source] || "بلا حد";
}

// التطبيع على الطرفين إلزامي: مفاتيح الحدود المحفوظة سابقاً غير مطبّعة أحياناً
// (مثال حقيقي: «مركز شريفة اسعد شريفة» بالتاء المربوطة) بينما مزامنة الأرصدة
// تطبّع (ة←ه)، فكان الحد لا يرتبط بصاحبه أبداً ويظهر «بلا حد محدّد».
// التطبيع هنا يُصلح السجلات القديمة بلا ترحيل بيانات.
function customerLimitMap() {
  const map = new Map();
  (state.customerCreditLimits || []).forEach((limit) => {
    const raw = limit && (limit.customerKey || limit.customerName);
    if (!raw) return;
    const key = normalizeItemName(String(raw));
    if (key && !map.has(key)) map.set(key, limit);
  });
  return map;
}

function deriveCustomerStatus(balance, limit) {
  if (limit > 0 && balance > limit) return "over_limit";
  if (limit > 0 && balance > 0 && balance >= limit * 0.9) return "near_limit";
  if (balance > 0) return "open_balance";
  if (balance < 0) return "credit_balance";
  return "clear";
}

function applyCustomerLimits(items) {
  const limits = customerLimitMap();
  return items.map((item) => {
    const key = customerKey(item);
    const savedLimit = limits.get(normalizeItemName(key)); // الطرف الآخر مطبّع أيضاً
    const ameenLimit = Number(item?.creditLimit || 0);
    const internalLimit = Number(savedLimit?.creditLimit || 0);
    const effectiveLimit = internalLimit > 0 ? internalLimit : ameenLimit;
    const balance = customerBalance(item);

    return {
      ...item,
      key,
      ameenCreditLimit: ameenLimit,
      internalCreditLimit: internalLimit,
      creditLimit: effectiveLimit,
      creditLimitNotes: savedLimit?.notes || "",
      limitSource: internalLimit > 0 ? "internal" : ameenLimit > 0 ? "ameen" : "none",
      remainingLimit: effectiveLimit > 0 ? effectiveLimit - Math.max(0, balance) : 0,
      lastPaymentAmount: Number(item?.lastPaymentAmount || 0),
      lastPaymentDate: item?.lastPaymentDate || "",
      lastPaymentNotes: item?.lastPaymentNotes || "",
      recentPayments: Array.isArray(item?.recentPayments) ? item.recentPayments : [],
      recentMovements: Array.isArray(item?.recentMovements) ? item.recentMovements : [],
      status: deriveCustomerStatus(balance, effectiveLimit)
    };
  });
}

function latestCustomerBalanceItems() {
  const latest = state.customerBalanceReports[0];
  return applyCustomerLimits(Array.isArray(latest?.items) ? latest.items : []);
}

function overdueCustomers(thresholdDays = 3) {
  const items = latestCustomerBalanceItems();
  const now = new Date();
  return items
    .filter((item) => customerBalance(item) > 0)
    .map((item) => {
      const dateStr = item.lastPaymentDate || "";
      let daysSince = null;
      if (dateStr) {
        try {
          const d = new Date(dateStr);
          if (!isNaN(d)) daysSince = Math.floor((now - d) / 86400000);
        } catch {}
      }
      return { ...item, daysSince };
    })
    .filter((item) => item.daysSince === null || item.daysSince >= thresholdDays)
    .sort((a, b) => (b.daysSince ?? 9999) - (a.daysSince ?? 9999));
}

function fireOverdueNotif(count) {
  if (!notifSupported() || Notification.permission !== "granted") return;
  const opts = {
    body: `${count} زبون بدون دفعة منذ أكثر من 3 أيام`,
    icon: "public/icons/app-icon.png",
    dir: "rtl",
    lang: "ar",
    tag: "overdue-customers"
  };
  if (navigator.serviceWorker?.controller) {
    navigator.serviceWorker.ready.then((reg) => reg.showNotification("OZK — تنبيه ديون", opts)).catch(() => new Notification("OZK — تنبيه ديون", opts));
  } else {
    new Notification("OZK — تنبيه ديون", opts);
  }
}

function customerBalanceTotals(items) {
  const debitItems = items.filter((item) => customerBalance(item) > 0);
  const creditItems = items.filter((item) => customerBalance(item) < 0);
  return {
    debitCustomers: debitItems.length,
    creditCustomers: creditItems.length,
    totalDebitBalance: debitItems.reduce((sum, item) => sum + customerBalance(item), 0),
    totalCreditBalance: creditItems.reduce((sum, item) => sum + customerBalance(item), 0),
    customersWithLimit: items.filter((item) => customerLimit(item) > 0).length,
    customersWithPayment: items.filter((item) => customerLastPaymentAmount(item) > 0).length
  };
}

function selectedCustomer(items) {
  if (!state.selectedCustomerKey && items.length) {
    return null;
  }
  return items.find((item) => customerKey(item) === state.selectedCustomerKey) || null;
}

function movementLabel(movement) {
  const debit = Number(movement?.debit || 0);
  const credit = Number(movement?.credit || 0);
  if (credit > 0 && debit <= 0) return "دفعة";
  if (debit > 0 && credit <= 0) return "فاتورة / دين";
  return "قيد";
}

function movementAmount(movement) {
  const debit = Number(movement?.debit || 0);
  const credit = Number(movement?.credit || 0);
  if (credit > 0 && debit <= 0) return credit;
  if (debit > 0 && credit <= 0) return debit;
  return Math.max(debit, credit);
}

function customerStatusLabel(status) {
  return {
    over_limit: "تجاوز الحد",
    near_limit: "قريب من الحد",
    open_balance: "عليه رصيد",
    credit_balance: "له رصيد",
    clear: "صافي"
  }[status] || status;
}

function formatMoney(value) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 3
  }).format(Number(value || 0));
}

function customerFilterCounts(items) {
  return {
    all: items.length,
    debit_balance: items.filter((item) => customerBalance(item) > 0).length,
    credit_balance: items.filter((item) => customerBalance(item) < 0).length,
    clear: items.filter((item) => customerBalance(item) === 0).length,
    over_limit: items.filter((item) => item.status === "over_limit").length,
    near_limit: items.filter((item) => item.status === "near_limit").length,
    no_limit: items.filter((item) => customerLimit(item) <= 0).length
  };
}

function matchesCustomerSearch(item, query) {
  const text = query.trim();
  if (!text) return true;
  const normalizedQuery = normalizeItemName(text);
  return (
    String(item.name || "").includes(text) ||
    String(item.key || "").includes(normalizedQuery) ||
    normalizeItemName(item.name || "").includes(normalizedQuery)
  );
}

function filterCustomerItems(items, filter, query) {
  return items.filter((item) => {
    if (!matchesCustomerSearch(item, query)) return false;
    if (filter === "debit_balance") return customerBalance(item) > 0;
    if (filter === "credit_balance") return customerBalance(item) < 0;
    if (filter === "clear") return customerBalance(item) === 0;
    if (filter === "over_limit") return item.status === "over_limit";
    if (filter === "near_limit") return item.status === "near_limit";
    if (filter === "no_limit") return customerLimit(item) <= 0;
    return true;
  });
}

function sortCustomerItems(items, sort) {
  const sorted = [...items];
  if (sort === "remainingAsc") {
    sorted.sort((a, b) => customerRemainingLimit(a) - customerRemainingLimit(b));
  } else if (sort === "nameAsc") {
    sorted.sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "ar"));
  } else {
    sorted.sort((a, b) => customerBalanceSortValue(b) - customerBalanceSortValue(a));
  }
  return sorted;
}

function filteredCustomerItems(items) {
  return sortCustomerItems(filterCustomerItems(items, state.customerFilter, state.customerSearch), state.customerSort);
}

function inventoryMetric(label, value, detail = "") {
  return `
    <article class="inventory-metric">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      ${detail ? `<small>${escapeHtml(detail)}</small>` : ""}
    </article>
  `;
}

function inventoryList(title, items, emptyText) {
  return `
    <article class="panel">
      <h3>${escapeHtml(title)}</h3>
      <div class="inventory-list">
        ${
          items.length
            ? items
                .slice(0, 12)
                .map(
                  (item) => `
                    <div class="inventory-row">
                      <strong>${escapeHtml(item.name)}</strong>
                      <span>${escapeHtml(statusLabel(item.status))} / الكمية: ${escapeHtml(item.stockQty)}</span>
                    </div>
                  `
                )
                .join("")
            : `<p class="muted">${escapeHtml(emptyText)}</p>`
        }
      </div>
    </article>
  `;
}

function inventoryRow(item) {
  const qty = itemQty(item);
  const rowState = qty < 0 ? "negative" : qty === 0 ? "zero" : item.status;
  return `
    <div class="inventory-row inventory-row-${escapeHtml(rowState)}">
      <strong>${escapeHtml(item.name)}</strong>
      <span>${escapeHtml(statusLabel(item.status))} / الكمية: ${escapeHtml(qty)}</span>
    </div>
  `;
}

function ameenBrowser(items) {
  const counts = ameenFilterCounts(items);
  const filtered = ameenFilteredItems(items);
  const activeFilter = ameenFilters.some((filter) => filter.id === state.ameenFilter) ? state.ameenFilter : "alerts";

  return `
    <section class="panel wide inventory-browser">
      <div class="panel-title-row inventory-browser-head">
        <div>
          <h3>مواد الأمين</h3>
          <p class="muted">ابحث، صفّ، ورتّب المواد من آخر مزامنة مباشرة.</p>
        </div>
        <span class="status-chip" data-ameen-count>يعرض ${escapeHtml(filtered.length)} من ${escapeHtml(items.length)}</span>
      </div>
      <div class="inventory-controls">
        <label>
          بحث باسم المادة
          <input data-ameen-search value="${escapeHtml(state.ameenSearch)}" placeholder="مثال: 1970 أو اسم المادة">
        </label>
        <label>
          الترتيب
          <select data-ameen-sort>
            <option value="qtyAsc" ${state.ameenSort === "qtyAsc" ? "selected" : ""}>الكمية من الأقل للأعلى</option>
            <option value="qtyDesc" ${state.ameenSort === "qtyDesc" ? "selected" : ""}>الكمية من الأعلى للأقل</option>
            <option value="nameAsc" ${state.ameenSort === "nameAsc" ? "selected" : ""}>الاسم أبجدياً</option>
          </select>
        </label>
      </div>
      <div class="filter-pills">
        ${ameenFilters
          .map(
            (filter) => `
              <button class="filter-pill ${activeFilter === filter.id ? "active" : ""}" type="button" data-ameen-filter="${escapeHtml(filter.id)}">
                <span>${escapeHtml(filter.label)}</span>
                <strong>${escapeHtml(counts[filter.id] || 0)}</strong>
              </button>
            `
          )
          .join("")}
      </div>
      <div class="button-row report-actions">
        <button class="button secondary" type="button" data-action="download-filtered-inventory" ${filtered.length ? "" : "disabled"}>تصدير المعروض</button>
      </div>
      <div class="inventory-list inventory-list-dense" data-ameen-results>
        ${filtered.length ? groupedAccordion("ameen", filtered, { groupOf: (i) => i.groupName, rowOf: inventoryRow, query: state.ameenSearch }) : '<p class="muted">لا توجد مواد تطابق البحث والفلتر الحالي.</p>'}
      </div>
      
    </section>
  `;
}

function itemRetailPrice(item) {
  const r = item && item.approvedPrice && item.approvedPrice.pricePayload && item.approvedPrice.pricePayload.retail;
  return Number((r && r.price) || 0);
}

function pricingRow(item) {
  const qty = itemQty(item);
  const unit1Name = itemUnit1Name(item);
  const unit2Name = itemUnit2Name(item);
  const unit2Factor = itemUnit2Factor(item);
  const wholesale = itemUnit2Price(item);
  const retail = itemRetailPrice(item);
  const bulletinNote = String((item.approvedPrice && item.approvedPrice.notes) || "");
  const unitLabel = unit2Name || "كرتونة";
  const priced = wholesale > 0 || retail > 0;
  const retailPerUnit1 = retail > 0 ? roundPrice(retail / unit2Factor) : 0;
  const retailHint = retailPerUnit1 > 0 ? `<small class="muted">المفرق ≈ ${escapeHtml(formatMoney(retailPerUnit1))} $ لكل ${escapeHtml(unit1Name || "كروز")}</small>` : "";
  const rowState = (wholesale > 0 || retail > 0) ? "active" : item.status;
  const costRow = itemCostFor(item);
  // التكلفة في الأمين لكل كروز — نضربها بعدد الكروزات بالكرتونة لتطابق تسعير الكرتونة
  const cartonFactor = unit2Factor > 0 ? unit2Factor : 1;
  const costPerCarton = costRow && Number(costRow.avg_cost) > 0 ? Number(costRow.avg_cost) * cartonFactor : 0;
  const costLine = costPerCarton > 0
    ? `<div class="cost-line" title="متوسط تكلفة ${escapeHtml(unitLabel)} (التكلفة لكل ${escapeHtml(unit1Name || "كروز")} × ${escapeHtml(unit2Factor)}) — يظهر لك أنت فقط (المدير)">🔒 تكلفة ${escapeHtml(unitLabel)}: <b>${escapeHtml(formatMoney(costPerCarton))}</b> $</div>`
    : "";
  // تنبيه معلوماتي فقط: البيع تحت التكلفة مسموح ومقصود أحياناً (تصفية صلاحية مثلاً)،
  // فلا يمنع الحفظ ولا المزامنة ولا يغيّر أي سعر.
  const belowCostParts = [];
  if (wholesale > 0 && costPerCarton > 0 && wholesale < costPerCarton) {
    belowCostParts.push(`الجملة بـ ${formatMoney(roundPrice(costPerCarton - wholesale))}$`);
  }
  if (retail > 0 && costPerCarton > 0 && retail < costPerCarton) {
    belowCostParts.push(`المفرق بـ ${formatMoney(roundPrice(costPerCarton - retail))}$`);
  }
  const belowCostLine = belowCostParts.length
    ? `<div class="cost-line" style="color:var(--danger)" title="للعلم فقط — الحفظ والمزامنة يعملان كالمعتاد">ℹ️ تحت التكلفة: ${escapeHtml(belowCostParts.join("، "))} لل${escapeHtml(unitLabel)}</div>`
    : "";
  return `
    <div class="pricing-card inventory-row-${escapeHtml(rowState)}">
      <div class="pricing-card-head">
        <strong title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</strong>
        <span>${escapeHtml(qty)}</span>
      </div>
      <small>${escapeHtml(unit2Name)} / ${escapeHtml(unit2Factor)} ${escapeHtml(unit1Name)}</small>
      <div class="pricing-price-summary">
        <b>جملة: ${wholesale > 0 ? `${escapeHtml(formatMoney(wholesale))} $` : "غير مسعّر"}</b>
        <b>مفرق: ${retail > 0 ? `${escapeHtml(formatMoney(retail))} $` : "غير مسعّر"}</b>
      </div>
      ${costLine}
      ${belowCostLine}
      ${retailHint}
      <span>${escapeHtml(priced ? "الأسعار مستقلة — راجع الحقلين" : statusLabel(item.status))}</span>
      <form class="pricing-editor" data-form="pricing-item" data-item-key="${escapeHtml(item.key)}" data-source-keys="${escapeHtml(JSON.stringify(item.sourceKeys || []))}" data-item-name="${escapeHtml(item.name || "")}" data-stock-qty="${escapeHtml(qty)}" data-stock-status="${escapeHtml(item.status || "")}" data-unit1-name="${escapeHtml(unit1Name)}" data-unit2-name="${escapeHtml(unit2Name)}" data-unit2-factor="${escapeHtml(unit2Factor)}">
        <div class="pricing-editor-fields">
          <label>
            <span>سعر الجملة (${escapeHtml(unitLabel)} $)</span>
            <input name="wholesalePrice" type="text" inputmode="decimal" dir="ltr" value="${escapeHtml(wholesale > 0 ? wholesale : "")}" placeholder="0">
          </label>
          <label>
            <span>سعر المفرق (${escapeHtml(unitLabel)} $)</span>
            <input name="retailPrice" type="text" inputmode="decimal" dir="ltr" value="${escapeHtml(retail > 0 ? retail : "")}" placeholder="0">
          </label>
          <label class="pricing-editor-note">
            <span>ملاحظة النشرة (اختياري — تظهر بجانب الاسم)</span>
            <input name="bulletinNote" type="text" maxlength="200" value="${escapeHtml(bulletinNote)}" placeholder="مثال: مع قداحات">
          </label>
        </div>
        <button class="button secondary mini-button" type="submit">حفظ السعر</button>
      </form>
    </div>
  `;
}

function pricing() {
  const latest = latestStockReport();
  const items = generalPricingWorklistItems();
  const allAvailable = liveAvailableItems();
  const approvedCount = items.filter((item) => item.hasApprovedPrice || item.unit2Price > 0 || item.salePrice > 0).length;
  const waiting = Math.max(0, items.length - approvedCount);
  const syncedAt = reportSyncedAt(latest);
  const emptyText =
    dataStore.isConfigured() && !state.session
      ? "سجل الدخول أولاً حتى تظهر مواد التسعير ويتم الحفظ في Supabase."
      : "لا توجد مواد متوفرة أو مطابقة للبحث الحالي.";
  const authHint =
    dataStore.isConfigured() && !state.session
      ? '<p class="muted">سجل الدخول حتى تحفظ الأسعار في Supabase وتصل إلى جهاز المحاسبة.</p>'
      : "";
  const generalCount = customerPriceListItems().length;
  const publishState = state.bulletinStatus?.type === "error" ? "تحتاج مراجعة" : "جاهزة للنشر";

  return shell(`
    <section class="newsletter-hub">
      <div class="newsletter-hero">
        <div class="newsletter-hero-copy">
          <span class="newsletter-kicker">OZK TOBACCO</span>
          <h2>مركز نشرة الأسعار</h2>
          <p>حدّث المخزون، راجع الأسعار، عاين النشرات وانشرها للزبائن من مكان واحد.</p>
        </div>
        <div class="newsletter-hero-status">
          <span>حالة النشرة</span>
          <strong>${escapeHtml(publishState)}</strong>
          <small>آخر جرد: ${escapeHtml(formatDateTime(syncedAt))}</small>
        </div>
      </div>

      <div class="newsletter-steps" aria-label="مراحل تجهيز النشرة">
        <div class="newsletter-step is-ready"><span>1</span><strong>تحديث المخزون</strong><small>مزامنة الأمين</small></div>
        <div class="newsletter-step is-current"><span>2</span><strong>مراجعة الأسعار</strong><small>${escapeHtml(waiting)} بحاجة تسعير</small></div>
        <div class="newsletter-step"><span>3</span><strong>معاينة النشرة</strong><small>دولار وسوري</small></div>
        <div class="newsletter-step"><span>4</span><strong>اعتماد ونشر</strong><small>رابط الزبائن</small></div>
      </div>

      <div class="newsletter-metrics">
        ${inventoryMetric("مواد المخزون", allAvailable.length, "من آخر جرد حي")}
        ${inventoryMetric("أسعار معتمدة", approvedCount, "محفوظة للمحاسبة")}
        ${inventoryMetric("بحاجة تسعير", waiting, "تحتاج المراجعة")}
        ${inventoryMetric("مواد النشرة", generalCount, "جاهزة للمعاينة")}
      </div>

      <section class="newsletter-editions" aria-labelledby="newsletter-editions-title">
        <div class="newsletter-section-head">
          <div><span>المعاينة النهائية</span><h3 id="newsletter-editions-title">اختر النشرة</h3></div>
          <a class="newsletter-public-link" href="public/downloads/" target="_blank" rel="noopener">فتح صفحة الزبائن</a>
        </div>
        <div class="newsletter-edition-grid">
          <article class="newsletter-edition-card is-featured">
            <span class="newsletter-edition-type">جملة</span><h4>نشرة الدولار</h4><p>الكرتونة أو الطرد أو الشرحة الكاملة فقط.</p>
            <button class="button primary mini-button" type="button" data-action="download-customer-price-pdf">حفظ التعديلات ومعاينة PDF الآن</button>
            <p class="newsletter-published-label">آخر نسخة منشورة للزبائن:</p>
            <div><a href="${escapeHtml(freshPublishedBulletinUrl("public/downloads/price-list-usd.html"))}">اختيار اللون</a><a href="${escapeHtml(freshPublishedBulletinUrl("public/downloads/price-list-usd.pdf"))}">داكن</a><a href="${escapeHtml(freshPublishedBulletinUrl("public/downloads/price-list-usd-light.pdf"))}">فاتح</a></div>
          </article>
          <article class="newsletter-edition-card">
            <span class="newsletter-edition-type">مفرق</span><h4>نشرة السوري</h4><p>المواد ذات المخزون الموجب وفق سعر الصرف المعتمد.</p>
            <button class="button primary mini-button" type="button" data-action="download-customer-price-syria">حفظ التعديلات ومعاينة PDF الآن</button>
            <p class="newsletter-published-label">آخر نسخة منشورة للزبائن:</p>
            <div><a href="${escapeHtml(freshPublishedBulletinUrl("public/downloads/price-list-syp-14050.html"))}">اختيار اللون</a><a href="${escapeHtml(freshPublishedBulletinUrl("public/downloads/price-list-syp-14050.pdf"))}">داكن</a><a href="${escapeHtml(freshPublishedBulletinUrl("public/downloads/price-list-syp-14050-light.pdf"))}">فاتح</a></div>
          </article>
          <article class="newsletter-edition-card">
            <span class="newsletter-edition-type">وزاري جملة</span><h4>الوزاري بالدولار</h4><p>الأصناف الوزارية والمحزّرة المتوفرة بالجملة.</p>
            <div><a href="${escapeHtml(freshPublishedBulletinUrl("public/downloads/price-list-wazari-usd.html"))}">اختيار اللون</a><a href="${escapeHtml(freshPublishedBulletinUrl("public/downloads/price-list-wazari-usd.pdf"))}">داكن</a><a href="${escapeHtml(freshPublishedBulletinUrl("public/downloads/price-list-wazari-usd-light.pdf"))}">فاتح</a></div>
          </article>
          <article class="newsletter-edition-card">
            <span class="newsletter-edition-type">وزاري مفرق</span><h4>الوزاري بالسوري</h4><p>نسخة المفرق المستقلة للأصناف الوزارية.</p>
            <div><a href="${escapeHtml(freshPublishedBulletinUrl("public/downloads/price-list-wazari-syp-14050.html"))}">اختيار اللون</a><a href="${escapeHtml(freshPublishedBulletinUrl("public/downloads/price-list-wazari-syp-14050.pdf"))}">داكن</a><a href="${escapeHtml(freshPublishedBulletinUrl("public/downloads/price-list-wazari-syp-14050-light.pdf"))}">فاتح</a></div>
          </article>
        </div>
      </section>

      <section class="newsletter-command" aria-labelledby="newsletter-command-title">
        <div class="newsletter-section-head">
          <div><span>العمل اليومي</span><h3 id="newsletter-command-title">تحديث، مراجعة، نشر</h3></div>
          <span class="status-chip">${state.session ? "متصل بالحساب" : "يلزم تسجيل الدخول للنشر"}</span>
        </div>
        <div class="newsletter-primary-actions">
          <button class="button secondary" type="button" data-action="refresh-ameen">تحديث المخزون</button>
          <label style="display:flex;align-items:center;gap:8px;font-weight:700">سعر الصرف اليوم
            <input data-published-exchange-rate type="number" min="1" step="1" value="${escapeHtml(state.syriaExchangeRate)}" style="width:120px;padding:8px;border:1px solid var(--line);border-radius:8px" aria-label="سعر صرف الليرة السورية مقابل الدولار">
          </label>
          <div role="group" aria-label="لون معاينة وملف PDF" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            <strong style="font-size:0.9rem">لون PDF:</strong>
            <button class="button ${state.bulletinPdfTheme === "dark" ? "primary" : "secondary"}" type="button" data-action="select-bulletin-theme" data-theme="dark" aria-pressed="${state.bulletinPdfTheme === "dark"}">داكن</button>
            <button class="button ${state.bulletinPdfTheme === "light" ? "primary" : "secondary"}" type="button" data-action="select-bulletin-theme" data-theme="light" aria-pressed="${state.bulletinPdfTheme === "light"}">فاتح</button>
          </div>
          <button class="button primary" type="button" data-action="download-customer-price-pdf">حفظ أي تعديل ثم معاينة وطباعة الدولار</button>
          <button class="button primary" type="button" data-action="download-customer-price-syria">حفظ أي تعديل ثم معاينة وطباعة السوري</button>
          <button class="button success" type="button" data-action="publish-bulletin" ${state.session ? "" : "disabled"}>اعتماد ونشر للزبائن</button>
        </div>
        <p class="muted" style="margin:8px 0 0">اختيار اللون يطبّق على المعاينة وPDF الحالي. «اعتماد ونشر» يولّد للزبائن النسختين الداكنة والفاتحة بالسعر نفسه.</p>
        <p class="bulletin-status ${escapeHtml(state.bulletinStatus?.type || "muted")}" data-bulletin-status ${state.bulletinStatus ? "" : "hidden"}>${escapeHtml(state.bulletinStatus?.msg || "")}</p>
      </section>

      <section class="panel wide inventory-browser newsletter-pricing-panel">
      <div class="panel-title-row inventory-browser-head">
        <div>
          <span class="newsletter-section-label">مراجعة المواد</span>
          <h3>أسعار النشرة</h3>
          <p class="muted">تظهر هنا النشرة العامة فقط بعد استبعاد الوزاري ودمج الأصناف المتشابهة. بعد حفظ الأسعار تُحدّث النشرة تلقائياً خلال لحظات.</p>
        </div>
        <span class="status-chip">${escapeHtml(approvedCount)} سعر معتمد</span>
      </div>
      ${authHint}
      ${state.approvedPriceError ? `<p class="muted">تنبيه الأسعار: ${escapeHtml(state.approvedPriceError)}</p>` : ""}
      <div class="currency-toggle" role="group">
        <button type="button" class="ctgl ${state.priceMode === "mufrak" ? "" : "active"}" data-mode="jumla">عرض أصناف نشرة الجملة</button>
        <button type="button" class="ctgl ${state.priceMode === "mufrak" ? "active" : ""}" data-mode="mufrak">عرض أصناف نشرة المفرق</button>
      </div>
      <p class="pricing-mode-help">اختيار العرض يغيّر الأصناف الظاهرة فقط. كل بطاقة تحفظ سعر الجملة وسعر المفرق كلّاً في حقله المستقل.</p>
      <div class="inventory-controls">
        <label>
          البحث ضمن مواد النشرة
          <input data-pricing-search value="${escapeHtml(state.pricingSearch)}" placeholder="اكتب اسم المادة أو المجموعة">
        </label>
      </div>
      <div class="inventory-list inventory-list-dense pricing-list" data-pricing-results>
        ${items.length ? groupedAccordion("pricing", items, { groupOf: (i) => i.groupName, rowOf: pricingRow, query: state.pricingSearch }) : `<p class="muted">${escapeHtml(emptyText)}</p>`}
      </div>
      <details class="newsletter-tools">
        <summary>أدوات وتقارير إضافية</summary>
        <div class="button-row report-actions">
          <button class="button secondary" type="button" data-action="download-daily-pricing" ${items.length ? "" : "disabled"}>قائمة تسعير اليوم</button>
          <button class="button secondary" type="button" data-action="report-inventory">تقرير المخزون PDF</button>
          <button class="button secondary" type="button" data-action="download-price-template" ${allAvailable.length ? "" : "disabled"}>قالب إكسل</button>
          <button class="button secondary" type="button" data-action="download-approved-prices" ${state.approvedPriceItems.length ? "" : "disabled"}>أسعار المحاسبة</button>
        </div>
        <form class="form-card compact" data-form="live-price-import">
          <label>رفع ملف تسعير كامل<input name="livePrice" type="file" accept=".xlsx,.xls,.csv"></label>
          <button class="button primary" type="submit" ${allAvailable.length ? "" : "disabled"}>اعتماد ملف الأسعار</button>
        </form>
      </details>
      </section>
    </section>
  `);
}

function customerBalanceRow(item) {
  const limit = customerLimit(item);
  const remaining = customerRemainingLimit(item);
  const rowState = item.status === "over_limit" ? "negative" : item.status === "near_limit" ? "low" : "active";
  const key = customerKey(item);
  return `
    <div class="inventory-row inventory-row-${escapeHtml(rowState)}">
      <div class="customer-row-title">
        <button class="customer-name-btn" type="button" data-customer-details="${escapeHtml(key)}">${escapeHtml(item.name)}</button>
      </div>
      <span>الرصيد: ${escapeHtml(formatMoney(customerBalance(item)))} / الحد: ${escapeHtml(limit > 0 ? formatMoney(limit) : "غير محدد")}</span>
      <span>المتبقي من الحد: ${escapeHtml(limit > 0 ? formatMoney(remaining) : "غير محدد")} / الحالة: ${escapeHtml(customerStatusLabel(item.status))} / المصدر: ${escapeHtml(customerLimitSourceLabel(item.limitSource))}</span>
      <span>آخر دفعة: ${escapeHtml(customerLastPaymentAmount(item) > 0 ? formatMoney(customerLastPaymentAmount(item)) : "غير متوفر")} / التاريخ: ${escapeHtml(customerLastPaymentDate(item) ? formatDate(customerLastPaymentDate(item)) : "غير متوفر")}</span>
      <form class="customer-limit-editor" data-form="customer-limit" data-customer-key="${escapeHtml(key)}" data-customer-name="${escapeHtml(item.name || "")}">
        <label>
          الحد الداخلي
          <input name="creditLimit" type="text" inputmode="decimal" dir="ltr" value="${escapeHtml(item.internalCreditLimit > 0 ? item.internalCreditLimit : "")}" placeholder="${escapeHtml(limit > 0 ? formatMoney(limit) : "0")}">
        </label>
        <label>
          ملاحظة
          <input name="notes" maxlength="500" value="${escapeHtml(item.creditLimitNotes || "")}" placeholder="اختياري">
        </label>
        <button class="button secondary mini-button" type="submit">حفظ</button>
      </form>
    </div>
  `;
}

function customerPaymentRow(payment) {
  return `
    <div class="detail-row">
      <strong>${escapeHtml(formatMoney(payment?.amount || 0))}</strong>
      <span>${escapeHtml(payment?.date ? formatDate(payment.date) : "غير متوفر")}</span>
      <small>${escapeHtml(payment?.notes || "بلا ملاحظة")}</small>
    </div>
  `;
}

function customerMovementRow(movement) {
  return `
    <div class="detail-row">
      <strong>${escapeHtml(movementLabel(movement))}: ${escapeHtml(formatMoney(movementAmount(movement)))}</strong>
      <span>${escapeHtml(movement?.date ? formatDate(movement.date) : "غير متوفر")}</span>
      <small>${escapeHtml(movement?.notes || "بلا ملاحظة")}</small>
    </div>
  `;
}

// ====== تقارير PDF (محرّك مشترك) ======
const REPORT_STYLE = `<style>
.ozk-rpt{font-family:Tahoma,Arial,sans-serif;color:#221808;background:#fff;direction:rtl;padding:6px 10px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.ozk-rpt .rhead{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #b8892a;padding-bottom:8px;margin-bottom:12px}
.ozk-rpt .brand{font-weight:900;font-size:19px}.ozk-rpt .brand small{display:block;font-weight:400;font-size:10px;color:#6b5535}
.ozk-rpt .rtitle{flex:1;text-align:right;white-space:nowrap;padding-right:14px}.ozk-rpt .rtitle h2{margin:0;font-size:16px;color:#b8892a;white-space:nowrap}.ozk-rpt .rtitle span{font-size:10px;color:#6b5535;white-space:nowrap}
.ozk-rpt .balbox{background:#f6ead0;border:1px solid #b8892a;border-radius:8px;padding:10px 14px;display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.ozk-rpt .balbox .nm{font-weight:900;font-size:15px}.ozk-rpt .balbox .big{font-size:24px;font-weight:900;color:#c0271f}
.ozk-rpt .muted{color:#6b5535;font-size:10.5px}
.ozk-rpt .sec{font-weight:800;font-size:12.5px;margin:12px 0 4px}
.ozk-rpt table{width:100%;border-collapse:collapse;font-size:12px}
.ozk-rpt th{background:#ece6d4;padding:6px 8px;text-align:right;border:1px solid #c8b890;font-size:11px}
.ozk-rpt td{padding:5px 8px;border:1px solid #c8b890}
.ozk-rpt table{page-break-inside:auto}.ozk-rpt thead{display:table-header-group}.ozk-rpt tfoot{display:table-footer-group}.ozk-rpt tr{page-break-inside:avoid}.ozk-rpt .rhead,.ozk-rpt .balbox,.ozk-rpt .cards{page-break-inside:avoid}.ozk-rpt tr.closing td{background:#f6ead0;font-weight:800;border-top:2px solid #b8892a}
.ozk-rpt tr:nth-child(even) td{background:#faf6ec}
.ozk-rpt .deb{color:#c0271f;font-weight:700}.ozk-rpt .cred{color:#16794f;font-weight:700}
.ozk-rpt .cards{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:12px}
.ozk-rpt .rcard{background:#ece6d4;border:1px solid #c8b890;border-radius:8px;padding:10px 12px;text-align:center}
.ozk-rpt .rcard .v{font-size:21px;font-weight:900}.ozk-rpt .rcard .l{font-size:10.5px;color:#6b5535}
.ozk-rpt .rcard .v.gold{color:#b8892a}.ozk-rpt .rcard .v.red{color:#c0271f}.ozk-rpt .rcard .v.green{color:#16794f}
.ozk-rpt .rlogo{height:46px;width:auto}
.ozk-rpt tr.open td{background:#ece6d4;font-weight:800}
.ozk-rpt .rfoot{margin-top:16px;border-top:1.5px solid #b8892a;padding-top:7px;font-size:10px;color:#6b5535;display:flex;justify-content:space-between}
.ozk-rpt .stamp-wrap{margin-top:16px;display:flex;justify-content:flex-start;page-break-inside:avoid}
.ozk-rpt .seal{border:2.5px solid #16357a;outline:1.5px solid #16357a;outline-offset:3px;border-radius:12px;color:#16357a;padding:9px 20px;text-align:center;transform:rotate(-5deg);opacity:.9;line-height:1.45}
.ozk-rpt .seal .s-name{font-size:15px;font-weight:900}
.ozk-rpt .seal .s-sub{font-size:12px;font-weight:700}
.ozk-rpt .seal .s-logo{font-size:18px;font-weight:900;letter-spacing:1px;margin:2px 0}
.ozk-rpt .seal .s-info{font-size:10.5px;font-weight:700}
.ozk-rpt .seal .s-addr{font-size:11px;font-weight:700;border-top:1px solid #16357a;margin-top:4px;padding-top:3px}
</style>`;

// واجهة موحّدة لملفات PDF على الهاتف. إبقاء الملف داخل نافذة التطبيق بعد
// التوليد مهم: navigator.share يحتاج نقرة مستخدم جديدة بعد انتهاء html2canvas،
// وإلا يرفض iOS المشاركة لأن عملية الرسم غير المتزامنة أنهت صلاحية النقرة الأولى.
function presentPortablePdf(blob, filename, title) {
  const previous = document.querySelector("[data-portable-pdf]");
  if (previous && typeof previous.closePortablePdf === "function") previous.closePortablePdf();
  else if (previous) previous.remove();

  const url = URL.createObjectURL(blob);
  const file = typeof File === "function"
    ? new File([blob], filename, { type: "application/pdf" })
    : null;
  let canShareFile = false;
  try {
    canShareFile = Boolean(
      file && navigator.share && navigator.canShare && navigator.canShare({ files: [file] })
    );
  } catch {
    // بعض المتصفحات تعرّف canShare لكنها ترمي عند تمرير files؛ يبقى الفتح والتنزيل متاحين.
  }
  const dialog = document.createElement("div");
  dialog.setAttribute("data-portable-pdf", "");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", title || "ملف PDF جاهز");
  dialog.dir = "rtl";
  dialog.style.cssText = "position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.82);display:grid;place-items:center;padding:12px";
  dialog.innerHTML = `
    <section style="width:min(760px,100%);height:min(92vh,900px);background:#fff;color:#241f18;border-radius:14px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 18px 60px rgba(0,0,0,.45)">
      <header style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px;border-bottom:1px solid #ded6c8">
        <div><strong style="display:block">${escapeHtml(title || "ملف PDF جاهز")}</strong><small style="color:#6b6154">اختر مشاركة لحفظه في «الملفات» أو إرساله للزبون</small></div>
        <button type="button" data-pdf-close aria-label="إغلاق" style="border:0;background:#eee7dc;border-radius:999px;width:38px;height:38px;font-size:22px">×</button>
      </header>
      <iframe src="${escapeHtml(url)}" title="معاينة ${escapeHtml(title || "PDF")}" style="flex:1;width:100%;border:0;background:#eee"></iframe>
      <footer style="display:flex;flex-wrap:wrap;gap:8px;padding:12px 14px;border-top:1px solid #ded6c8">
        <button type="button" data-pdf-share class="button primary" ${canShareFile ? "" : "hidden"}>مشاركة / حفظ في الملفات</button>
        <a class="button secondary" href="${escapeHtml(url)}" download="${escapeHtml(filename)}">تنزيل PDF</a>
        <a class="button secondary" href="${escapeHtml(url)}" target="_blank" rel="noopener">فتح PDF</a>
      </footer>
    </section>`;

  let closed = false;
  dialog.closePortablePdf = () => {
    if (closed) return;
    closed = true;
    dialog.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  dialog.querySelector("[data-pdf-close]")?.addEventListener("click", dialog.closePortablePdf);
  dialog.querySelector("[data-pdf-share]")?.addEventListener("click", async () => {
    try {
      // الاستدعاء يبدأ داخل معالج النقرة نفسه كي تبقى user activation فعالة على iOS.
      await navigator.share({ files: [file], title: title || filename });
    } catch (error) {
      if (error && error.name === "AbortError") return;
      setNotice("error", "تعذّرت المشاركة. استخدم «تنزيل PDF» أو «فتح PDF».");
      render();
    }
  });
  document.body.appendChild(dialog);
}

// يبني Blob PDF فعلياً من القالب الظاهر. نمرّر عنصر المحتوى لا الحاوية
// الموضوعة خارج الشاشة كي لا يلتقط html2canvas لوحة بارتفاع صفر على الهاتف.
async function createPortablePdfBlob(bodyHtml, filename, options = {}) {
  if (!window.html2pdf) throw new Error("مكتبة PDF لم تتحمّل. حدّث الصفحة وجرّب مجدداً.");

  const container = document.createElement("div");
  const backgroundColor = options.backgroundColor || "#ffffff";
  // Safari/WebKit (كل متصفحات iOS فعلياً) لا يرسم foreignObject بشكل موثوق إذا كان
  // العنصر المصدر خارج حدود الشاشة (إحداثيات سالبة كبيرة مثل left:-10000px) — يُخرج
  // canvas فارغاً تماماً بلا أي خطأ (خرج PDF من عدة صفحات لكنها بيضاء بالكامل). لذا
  // نُبقي العنصر ضمن حدود الشاشة الفعلية (top:0;left:0) ونُخفيه بصرياً عبر z-index
  // سالب خلف محتوى الصفحة نفسه بدل إخراجه من نطاق الرؤية. هذا لا يؤثر على Chrome
  // (سطح المكتب أو أندرويد) الذي يرسم foreignObject بشكل صحيح بالحالتين.
  container.style.cssText = `position:fixed;left:0;top:0;width:${Number(options.width) || 794}px;background:${backgroundColor};z-index:-1;pointer-events:none`;
  container.innerHTML = bodyHtml;
  document.body.appendChild(container);
  const source = [...container.children].find((element) => element.tagName !== "STYLE") || container;
  if (options.stabilizeBulletinRtl) stabilizeBulletinPdfRtlLayout(source);

  // html2canvas قد يحذف المسافة العادية الملاصقة لكلمة عربية (مثل «رقم 1»
  // فتصير «رقم1»). نثبّت مسافات عقد النص العربية فقط قبل الرسم؛ لا نغيّر HTML
  // الأصلي ولا CSS ولا النصوص الإنكليزية الخالصة.
  const textWalker = document.createTreeWalker(source, NodeFilter.SHOW_TEXT);
  let textNode = textWalker.nextNode();
  while (textNode) {
    if (/[\u0600-\u06ff]/.test(textNode.nodeValue || "")) {
      textNode.nodeValue = String(textNode.nodeValue || "").replace(/ /g, "\u00a0");
    }
    textNode = textWalker.nextNode();
  }

  try {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    const worker = window.html2pdf().set({
      margin: options.margin || [8, 8, 8, 8],
      filename,
      image: options.image || { type: "jpeg", quality: 0.96 },
      html2canvas: {
        scale: Number(options.scale) || 1.25,
        useCORS: true,
        backgroundColor,
        allowTaint: Boolean(options.allowTaint),
        foreignObjectRendering: Boolean(options.foreignObjectRendering),
        scrollX: 0,
        scrollY: 0
      },
      jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
      pagebreak: options.pagebreak || {
        mode: ["css", "legacy"],
        avoid: ["tr", ".rhead", ".balbox", ".cards", ".rfoot", ".stamp-wrap"]
      }
    }).from(source);

    // نطبّق القص بعد أن يضيف html2pdf حشوات فواصل الصفحات داخل نسخته المستنسخة؛
    // القياس قبل هذه المرحلة لا يرى انتقال التذييل وحده إلى صفحة رابعة.
    await worker.toContainer();
    const renderContainer = worker.prop && worker.prop.container;
    const renderSource = renderContainer?.querySelector(".ozk-rpt") || renderContainer?.firstElementChild || renderContainer;
    if (renderSource) trimTrailingPortablePdfDecorations(renderSource, options.margin || [8, 8, 8, 8]);
    await worker.toCanvas();
    const canvas = (worker.prop && worker.prop.canvas) || worker.canvas;
    // معدّل الحبر على كامل الـcanvas يُخفي صفحة واحدة فارغة إن كانت بقية الصفحات
    // ممتلئة (متوسط عام لا يهبط تحت الحد). لذا نفحص شرائح أفقية منفصلة أيضاً — أي
    // شريحة فارغة تماماً (مثل صفحة كاملة سقطت بسبب علّة رسم WebKit) تُفشل التصدير
    // بدل تسليم PDF يبدو ناجحاً لكنه أبيض جزئياً.
    const bandCount = 8;
    const bandHeight = canvas ? canvas.height / bandCount : 0;
    const bandRatios = canvas
      ? Array.from({ length: bandCount }, (_, i) => canvasInkRatio(canvas, i * bandHeight, (i + 1) * bandHeight))
      : [];
    if (!canvas || canvasInkRatio(canvas) <= 0.001 || bandRatios.some((ratio) => ratio <= 0.0005)) {
      throw new Error("خرجت صفحة PDF فارغة. أغلق التطبيق وافتحه ثم جرّب مجدداً.");
    }
    await worker.toPdf();
    const pdf = worker.prop && worker.prop.pdf;
    const blob = pdf ? pdf.output("blob") : await worker.outputPdf("blob");
    if (!blob || blob.type !== "application/pdf" || blob.size < 4 * 1024) {
      throw new Error(`خرج ملف PDF غير صالح (${Math.round((blob?.size || 0) / 1024)} ك.ب).`);
    }
    return blob;
  } finally {
    container.remove();
  }
}

// إذا بدأ التذييل الزخرفي وحده في صفحة جديدة نخفيه من نسخة الهاتف؛ إبقاؤه كان يصنع
// صفحة A4 بيضاء تقريباً لا تحمل أي فاتورة أو حركة أو قيمة مفيدة.
function trimTrailingPortablePdfDecorations(source, margin) {
  const values = Array.isArray(margin) ? margin.map(Number) : [Number(margin) || 0];
  const top = values[0] || 0;
  const right = values.length > 1 ? values[1] || 0 : top;
  const bottom = values.length > 2 ? values[2] || 0 : top;
  const left = values.length > 3 ? values[3] || 0 : right;
  const sourceRect = source.getBoundingClientRect();
  const innerWidthMm = 210 - left - right;
  const innerHeightMm = 297 - top - bottom;
  if (!(sourceRect.width > 0 && innerWidthMm > 0 && innerHeightMm > 0)) return;
  const pageHeight = sourceRect.width * innerHeightMm / innerWidthMm;
  const contentNodes = [...source.querySelectorAll("tr,.rhead,.balbox,.cards,.stamp-wrap")];

  [...source.querySelectorAll(".rfoot")].reverse().forEach((footer) => {
    const footerRect = footer.getBoundingClientRect();
    const footerTop = footerRect.top - sourceRect.top;
    const pageStart = Math.floor((footerTop + 1) / pageHeight) * pageHeight;
    const startsNearPageTop = footerTop - pageStart < pageHeight * 0.14;
    const hasUsefulContentOnPage = contentNodes.some((node) => {
      const rect = node.getBoundingClientRect();
      const nodeTop = rect.top - sourceRect.top;
      const nodeBottom = rect.bottom - sourceRect.top;
      return nodeBottom > pageStart + 2 && nodeTop < footerTop - 2;
    });
    if (startsNearPageTop && !hasUsefulContentOnPage) {
      footer.style.display = "none";
      source.style.height = `${Math.max(1, Math.floor(pageStart - 1))}px`;
      source.style.overflow = "hidden";
    }
  });
}

// الطباعة تتم داخل الصفحة نفسها عبر iframe مخفي، لا عبر window.open.
// السبب: التطبيق مثبَّت كـPWA (display: standalone في manifest.webmanifest)،
// وفي هذا الوضع تفتح window.open على iOS نافذةً بلا شريط متصفح — بلا زر رجوع
// ولا طباعة ولا مشاركة — فتظهر للمستخدم «شاشة جامدة» لا مخرج منها. أما الـiframe
// فيفتح ورقة الطباعة الأصلية للنظام (وفيها «حفظ بصيغة PDF» وزر إلغاء)، ويعمل
// على iOS وأندرويد وويندوز معاً بلا حاجة للسماح بالنوافذ المنبثقة.
function printHtmlDocument(html, options = {}) {
  // نسخة iCloud تُطلق قبل فتح ورقة الطباعة كي لا ينتظرها المستخدم إطلاقاً،
  // ولا يؤثر نجاحها أو فشلها على الطباعة نفسها بأي شكل.
  if (options.archive && options.archive.docType) {
    archiveToICloud(options.archive.docType, html, options.archive.meta);
  }
  const previous = document.querySelector("iframe[data-print-frame]");
  if (previous) previous.remove();

  const frame = document.createElement("iframe");
  frame.setAttribute("data-print-frame", "");
  frame.setAttribute("aria-hidden", "true");
  frame.setAttribute("title", options.title || "طباعة");
  // خارج الشاشة لا display:none — Safari لا يطبع الإطارات المخفية بـdisplay.
  // القياس بمقاس A4 عند 96dpi كي يخرج تنسيق الصفحة مطابقاً للمعاينة.
  frame.style.cssText =
    "position:fixed;left:-10000px;top:0;width:794px;height:1123px;opacity:0;border:0;pointer-events:none;";

  let finished = false;
  const cleanup = () => {
    if (finished) return;
    finished = true;
    setTimeout(() => frame.remove(), 1000);
  };

  frame.addEventListener("load", () => {
    const win = frame.contentWindow;
    if (!win) {
      cleanup();
      return;
    }
    try {
      win.addEventListener("afterprint", cleanup, { once: true });
    } catch {
      // بعض المتصفحات تمنع الاستماع داخل الإطار — تكفي المهلة الاحتياطية أدناه.
    }
    // مهلة قصيرة كي تكتمل الخطوط والرسم قبل فتح ورقة الطباعة.
    setTimeout(() => {
      try {
        win.focus();
        win.print();
      } catch {
        cleanup();
        if (typeof options.onError === "function") options.onError();
        return;
      }
      // احتياط: إن لم يصل afterprint (شائع على iOS) نحذف الإطار بعد مهلة.
      setTimeout(cleanup, 60000);
    }, 250);
  }, { once: true });

  document.body.appendChild(frame);
  frame.srcdoc = withDocumentTitle(html, options.title);
}

// أرشفة صامتة إلى iCloud Drive عبر الجسر المحلي على الماك (src/icloud-archive.js).
//
// قاعدة حاكمة: الأرشفة ميزة مساعدة منفصلة تماماً عن العملية التجارية. لا تُعيد
// وعداً ينتظره أحد، ولا ترمي، ولا تُغيّر نتيجة التصدير أو الطباعة أو البيع.
// إن كان الجسر مطفأ أو الجهاز ليس ماك، يتابع الموقع تنزيله المعتاد بلا أي فرق.
// نتخطّى الهاتف صراحةً: لا جسر هناك، فلا داعي لطلب شبكي ولا لتنبيه محيّر.
// `content` إما نص HTML (يحوّله الجسر بـChromium فيخرج عربي متجه) أو Blob PDF
// جاهز — نفضّل الـBlob حين يكون موجوداً أصلاً كي تكون النسخة المؤرشفة مطابقة
// حرفياً للملف الذي نزّله المالك أو أرسله للزبون.
function archiveToICloud(docType, content, meta) {
  try {
    if (!docType || !content) return;
    if (isHandheldDevice()) return;
    if (!window.ozkArchive || typeof window.ozkArchive.archive !== "function") return;
    const payload = { docType, meta: meta || {} };
    if (typeof Blob !== "undefined" && content instanceof Blob) payload.pdfBlob = content;
    else payload.html = String(content);
    void window.ozkArchive.archive(payload);
  } catch {
    // لا شيء: فشل الأرشفة لا يجوز أن يظهر كخطأ في مسار الفاتورة.
  }
}

// ===== اسم الملف المقترح عند «حفظ بصيغة PDF» =====
//
// كروم يشتقّ اسم الملف المقترح من **عنوان المستند المطبوع** (`<title>`) لا من
// أي شيء آخر. كانت العناوين تحمل الرقم وحده («فاتورة مبيعات 562») فيخرج الملف
// بلا اسم الزبون. نبني العنوان الآن من **نفس** كائن البيانات الذي تُبنى منه
// الأرشفة، فيستحيل أن يفترق اسم ملف كروم عن اسم النسخة في iCloud.

const DOC_TYPE_LABELS = {
  invoice: "فاتورة",
  return_invoice: "فاتورة مرتجع",
  receipt: "سند قبض",
  payment: "سند دفع",
  account_statement: "كشف حساب",
  stock_report: "تقرير المخزون",
  receivables_report: "تقرير الذمم",
  price_list: "نشرة أسعار",
  purchase_invoice: "فاتورة مشتريات",
  other_report: "تقرير"
};

// ينقّي جزءاً من اسم الملف: يحذف ما تمنعه أنظمة الملفات ومحارف التحكّم
// والاتجاه غير المرئية، ويُبقي الحروف العربية والفراغات العادية كما هي.
function sanitizeDocumentTitle(value) {
  return String(value == null ? "" : value)
    .normalize("NFC")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/[\u200B-\u200F\u061C\u2066-\u2069\u202A-\u202E\uFEFF]/g, "")
    .replace(/[/\\:*?"<>|]/g, " ")
    .replace(/\.{2,}/g, ".")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s-]+/, "")
    .replace(/[.\s]+$/, "")
    .slice(0, 80)
    .trim();
}

// التاريخ في اسم الملف بصيغة يقرأها المالك (DD-MM-YYYY)، بينما يبقى اسم النسخة
// المؤرشفة على YYYY-MM-DD حسب اصطلاح مجلدات iCloud المعتمد. المصدر واحد.
function fileDateLabel(isoDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || "").slice(0, 10));
  return match ? `${match[3]}-${match[2]}-${match[1]}` : "";
}

/**
 * عنوان المستند المطبوع = اسم الملف الذي يقترحه المتصفح.
 * يُبنى من نفس `meta` التي تذهب إلى الأرشفة — لا لقطة أخرى ولا قيمة افتراضية.
 */
function archiveDocumentTitle(docType, meta) {
  const info = meta || {};
  const label = docType === "other_report"
    ? (sanitizeDocumentTitle(info.title) || DOC_TYPE_LABELS.other_report)
    : (DOC_TYPE_LABELS[docType] || "مستند");
  const party = sanitizeDocumentTitle(info.party);
  const number = sanitizeDocumentTitle(info.number);
  const date = fileDateLabel(info.date);
  let title = label;
  if (party) title += ` - ${party}`;
  if (number) title += ` - رقم ${number}`;
  if (date) title += ` - ${date}`;
  return title;
}

// يفرض العنوان داخل المستند المطبوع نفسه — هو وحده ما يقرأه كروم.
function withDocumentTitle(html, title) {
  const safe = escapeHtml(String(title || "").trim());
  if (!safe) return html;
  const source = String(html);
  if (/<title>[\s\S]*?<\/title>/i.test(source)) {
    return source.replace(/<title>[\s\S]*?<\/title>/i, `<title>${safe}</title>`);
  }
  if (/<head[^>]*>/i.test(source)) {
    return source.replace(/<head[^>]*>/i, (open) => `${open}<title>${safe}</title>`);
  }
  return source;
}

// نستعمل طباعة المتصفح الأصلية (حفظ بصيغة PDF) بدل html2canvas —
// المحرّك القديم صار يطلّع صفحات بيضا بعد تحديثات كروم. الطباعة الأصلية
// ترسم التقرير مثل الشاشة تماماً (عربي وألوان مظبوطة) ومستحيل تطلع فاضية.
//
// `archive` اختياري: { docType, meta } — عند تمريره تُحفظ نسخة في iCloud أيضاً،
// ويُشتقّ منه عنوان المستند (اسم ملف كروم) فيتطابق الاسمان دائماً.
async function exportReportPdf(bodyHtml, filename, archive) {
  const title = archive && archive.docType
    ? archiveDocumentTitle(archive.docType, archive.meta)
    : String(filename || "تقرير").replace(/\.pdf$/i, "");
  if (archive && archive.docType) archiveToICloud(archive.docType, bodyHtml, archive.meta);
  if (isHandheldDevice()) {
    try {
      const blob = await createPortablePdfBlob(bodyHtml, filename, { width: 794 });
      presentPortablePdf(blob, filename, title);
      return true;
    } catch (error) {
      setNotice("error", "تعذّر إنشاء ملف PDF: " + safeErrorMessage(error));
      render();
      return false;
    }
  }
  const doc =
    '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">' +
    '<base href="' + window.location.href + '">' +
    '<title>' + title + '</title>' +
    '<style>@page{size:A4 portrait;margin:10mm}' +
    'html,body{margin:0;padding:0;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
    'img{max-width:100%}table{page-break-inside:auto}tr{page-break-inside:avoid}thead{display:table-header-group}tfoot{display:table-footer-group}' +
    '@media print{.ozk-rpt{padding:0}}</style>' +
    '</head><body>' + bodyHtml +
    '</body></html>';
  printHtmlDocument(doc, {
    title,
    onError: () => {
      setNotice("error", "تعذّر فتح نافذة الطباعة. أغلق التطبيق وافتحه ثم جرّب مجدداً.");
      render();
    }
  });
  setNotice("success", "اختر «حفظ بصيغة PDF» من نافذة الطباعة.");
  render();
  return true;
}

// يجلب حركات الزبون الكاملة (من تقرير ameen_customer_movements) بمطابقة الاسم
function customerFullMovements(item) {
  const report = state.customerMovementsReport;
  const items = Array.isArray(report?.items) ? report.items : [];
  const name = String(item?.name || "").trim();
  if (!name) return null;
  return items.find((x) => String(x.name || "").trim() === name) || null;
}

// قيد دفتر الأمين المرتبط بفاتورة محددة عبر معرّفها (BiGUID) — مطابقة قطعية بلا تخمين
// بالتاريخ/المبلغ، فتصحّ حتى مع الحسومات وتعدد فواتير اليوم الواحد. null إن لم تصل
// بيانات المزامنة المحدّثة بعد (فيرجع المستدعي للعرض الآمن: الرصيد الحالي فقط).
function movementForBill(custName, billGuid) {
  const g = String(billGuid || "").trim().toLowerCase();
  if (!g) return null;
  const report = state.customerMovementsReport;
  const items = report && Array.isArray(report.items) ? report.items : [];
  const match = smartNameMatch(items, (it) => it.name, custName);
  const movements = match && Array.isArray(match.movements) ? match.movements : [];
  return movements.find((m) =>
    String(m?.billGuid || "").trim().toLowerCase() === g
    && m.balance !== undefined && m.balance !== null
  ) || null;
}

// حركة الفاتورة في تقرير الحركات: نطابق بمعرّف القيد (GUID) إن وُجد وغير صفري، وإلا بالتاريخ
// والمبلغ على جهة المدين. سبب الاحتياط: قيود السنة الجديدة (AmnDb002 بعد التدوير) تأتي أحياناً
// بمعرّف صفري (00000000-...) فيفشل الربط بالمعرّف وحده.
function invoiceMovement(custName, inv) {
  const report = state.customerMovementsReport;
  const items = report && Array.isArray(report.items) ? report.items : [];
  const match = smartNameMatch(items, (it) => it.name, custName);
  const movements = match && Array.isArray(match.movements) ? match.movements : [];
  if (!movements.length) return null;
  const g = String(inv?.guid || "").trim().toLowerCase();
  const ZERO_GUID = "00000000-0000-0000-0000-000000000000";
  if (g && g !== ZERO_GUID) {
    const byGuid = movements.find((m) => String(m?.billGuid || "").trim().toLowerCase() === g);
    if (byGuid) return byGuid;
  }
  const d = String(inv?.date || "").slice(0, 10);
  const total = Number(inv?.total || 0);
  for (let i = movements.length - 1; i >= 0; i--) {
    const m = movements[i];
    if (d && String(m?.date || "").slice(0, 10) !== d) continue;
    if (Number(m?.debit || 0) > 0 && Math.abs(Number(m?.debit || 0) - total) <= 0.5) return m;
  }
  return null;
}

// الرصيد الزمني الحقيقي للحركة — يُفضَّل للمستندات المُرسَلة للزبون (فاتورة/سند) على `balance`
// الذي هو بترتيب كشف الأمين (المدين قبل الدائن) فيتضخّم إن جاءت دفعة بين فاتورتَي نفس اليوم.
function movementChronoBalance(m) {
  if (!m) return null;
  const c = m.balanceChrono;
  if (c !== undefined && c !== null && c !== "") return Number(c);
  if (m.balance !== undefined && m.balance !== null && m.balance !== "") return Number(m.balance);
  return null;
}

// رصيدا المستند: بعد/قبل **سند القيد كاملاً** (يشملان قيد الخصم المرافق للفاتورة بنفس السند،
// فلا يتضخّم الرصيد الجديد). يسقطان إلى الرصيد الزمني للسطر إن غابا (تقارير قبل تحديث المزامنة).
function movementDocBalances(m) {
  if (!m) return null;
  const dn = m.docNew, dp = m.docPrev;
  if (dn !== undefined && dn !== null && dn !== "" && dp !== undefined && dp !== null && dp !== "") {
    return { newBalance: Number(dn), prevBalance: Number(dp) };
  }
  const chrono = movementChronoBalance(m);
  if (chrono === null) return null;
  return { newBalance: chrono, prevBalance: chrono - Number(m.debit || 0) + Number(m.credit || 0) };
}

// الرصيد بعد قيد الحركة كما حسبه الأمين وخزّنه (الرصيد المتحرك الدقيق، يشمل القيد الافتتاحي
// وبترتيب الأمين). نطابق الحركة بالتاريخ والقيمة على الجهة الصحيحة (مدين للفاتورة، دائن للدفعة)
// ونُرجع رصيدها المُخزَّن. يُرجع null إن لم يتوفّر الرصيد المُخزَّن بعد (بيانات قبل تحديث المزامنة).
function movementBalanceAfter(custName, dateStr, debit, credit) {
  const report = state.customerMovementsReport;
  const items = report && Array.isArray(report.items) ? report.items : [];
  const match = smartNameMatch(items, (it) => it.name, custName);
  const movements = match && Array.isArray(match.movements) ? match.movements : [];
  const d = String(dateStr || "").slice(0, 10);
  const wantDebit = Number(debit || 0), wantCredit = Number(credit || 0);
  for (let i = movements.length - 1; i >= 0; i--) {
    const m = movements[i];
    if (m.balance === undefined || m.balance === null) continue;
    if (d && String(m.date || "").slice(0, 10) !== d) continue;
    const sideOk = wantDebit > 0
      ? Math.abs(Number(m.debit || 0) - wantDebit) <= 0.5
      : Math.abs(Number(m.credit || 0) - wantCredit) <= 0.5;
    if (sideOk) return roundPrice(m.balance);
  }
  return null;
}

// الكشف الرسمي الكامل: رصيد أول المدة + كل حركات الفترة برصيد متحرك + الرصيد النهائي
function customerStatementPdfMarkup(item) {
  const key = customerKey(item);
  const profile = customerProfile(key);
  const phone = profile?.phone ? ` — هاتف: ${escapeHtml(profile.phone)}` : "";
  const lastD = customerLastPaymentDate(item);
  const full = customerFullMovements(item);
  const report = state.customerMovementsReport;
  const stmtNo = docNumber("ST");

  const header = `
    <div class="rhead">
      <div style="display:flex;align-items:center;gap:10px">
        <img src="public/icons/ozk-logo.png" class="rlogo" alt="OZK" onerror="this.style.display='none'">
        <div class="brand">OZK TOBACCO<small>مركز أبو زياد — لتجارة الدخان</small></div>
      </div>
      <div class="rtitle"><h2>كشف حساب</h2><span>رقم: ${escapeHtml(stmtNo)} · ${escapeHtml(todayIsoDate())}</span></div>
    </div>
    <div class="balbox"><div><div class="nm">${escapeHtml(item.name || "")}</div>
      <div class="muted">آخر دفعة: ${lastD ? escapeHtml(String(lastD).slice(0, 10)) : "لا يوجد"}${phone}</div></div>
      <div style="text-align:left"><div class="muted">الرصيد المستحق</div><div class="big">${escapeHtml(formatMoney(customerBalance(item)))}</div></div></div>`;

  const footer = `
    <div class="rfoot">
      <span>هذا الكشف صادر آليًا عن نظام OZK TOBACCO</span>
      <span dir="ltr">0985000771 — 0984000662</span>
    </div>`;

  const stamp = `
    <div class="stamp-wrap"><div class="seal">
      <div class="s-name">مركز أبو زياد</div>
      <div class="s-sub">لتجارة الدخان</div>
      <div class="s-logo">OZK TOBACCO</div>
      <div class="s-info" dir="ltr">0985000771 - 0984000662 · رقم المركز: 0994092038</div>
      <div class="s-addr">دوما - ساحة الغنم</div>
    </div></div>`;

  if (full && Array.isArray(full.movements)) {
    const fromDate = report?.summary?.fromDate || "";
    const rows = [];
    let running = Number(full.openingBalance || 0);
    rows.push(`<tr class="open"><td>${escapeHtml(fromDate || "—")}</td><td colspan="2">رصيد أول المدة</td><td></td><td>${escapeHtml(formatMoney(running))}</td></tr>`);
    full.movements.forEach((m) => {
      const d = Number(m.debit || 0), c = Number(m.credit || 0);
      // نستعمل الرصيد المُخزَّن من الأمين إن توفّر (الأدقّ)، وإلا نحسبه تراكمياً.
      running = (m.balance !== undefined && m.balance !== null) ? Number(m.balance) : roundPrice(running + d - c);
      rows.push(`<tr><td>${m.date ? escapeHtml(String(m.date).slice(0, 10)) : "—"}</td><td class="deb">${d > 0 ? escapeHtml(formatMoney(d)) : "—"}</td><td class="cred">${c > 0 ? escapeHtml(formatMoney(c)) : "—"}</td><td>${escapeHtml(m.notes || "—")}</td><td>${escapeHtml(formatMoney(running))}</td></tr>`);
    });
    const closing = Number(full.closingBalance || running);
    const truncNote = full.truncated ? `<p class="muted">ملاحظة: الكشف يعرض آخر الحركات ضمن الفترة لكثرتها.</p>` : "";
    const liveBalance = customerBalance(item);
    const liveNote = Math.abs(liveBalance - closing) > 0.01
      ? `<p class="muted">الرصيد الحالي بعد آخر مزامنة: ${escapeHtml(formatMoney(liveBalance))}</p>`
      : "";
    return `${REPORT_STYLE}<div class="ozk-rpt">
      ${header}
      <div class="sec">حركة الحساب من ${escapeHtml(fromDate || "بداية الفترة")} حتى ${escapeHtml(todayIsoDate())}</div>
      <table>
        <thead><tr><th>التاريخ</th><th>مدين (بضاعة)</th><th>دائن (دفع)</th><th>البيان</th><th>الرصيد</th></tr></thead>
        <tbody>
        ${rows.join("")}
        <tr class="open closing"><td></td><td colspan="2">الرصيد في نهاية الفترة</td><td></td><td><b>${escapeHtml(formatMoney(closing))}</b></td></tr>
        </tbody>
      </table>
      ${truncNote}${liveNote}
      ${stamp}
      ${footer}
    </div>`;
  }

  // احتياط: النسخة المختصرة (آخر الحركات والدفعات فقط) إذا لم يتوفر تقرير الحركات الكاملة
  const ameenP = (Array.isArray(item.recentPayments) ? item.recentPayments : []).map((p) => ({ amount: p.amount, date: p.date || "", notes: p.notes }));
  const manualP = ((state.paymentRecords && state.paymentRecords[key]) || []).map((p) => ({ amount: p.amount, date: p.paymentDate || "", notes: p.notes }));
  const payments = [...ameenP, ...manualP].sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0)).slice(0, 25);
  const movements = (Array.isArray(item.recentMovements) ? [...item.recentMovements] : []).sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0)).slice(0, 25);
  const pr = payments.length
    ? payments.map((p) => `<tr><td>${p.date ? escapeHtml(String(p.date).slice(0, 10)) : "—"}</td><td class="cred">${escapeHtml(formatMoney(p.amount || 0))}</td><td>${escapeHtml(p.notes || "—")}</td></tr>`).join("")
    : `<tr><td colspan="3" class="muted">لا توجد دفعات مسجّلة</td></tr>`;
  const mv = movements.length
    ? movements.map((m) => {
        const d = Number(m.debit || 0), c = Number(m.credit || 0);
        return `<tr><td>${m.date ? escapeHtml(String(m.date).slice(0, 10)) : "—"}</td><td class="deb">${d > 0 ? escapeHtml(formatMoney(d)) : "—"}</td><td class="cred">${c > 0 ? escapeHtml(formatMoney(c)) : "—"}</td><td>${escapeHtml(m.notes || "—")}</td></tr>`;
      }).join("")
    : `<tr><td colspan="4" class="muted">لا توجد حركة مسجّلة</td></tr>`;
  return `${REPORT_STYLE}<div class="ozk-rpt">
    ${header}
    <div class="sec">سجل الدفعات (الأحدث)</div>
    <table><thead><tr><th>التاريخ</th><th>المبلغ</th><th>ملاحظات</th></tr></thead><tbody>${pr}</tbody></table>
    <div class="sec">كشف الحركة (الأحدث)</div>
    <table><thead><tr><th>التاريخ</th><th>مدين (بضاعة)</th><th>دائن (دفع)</th><th>ملاحظات</th></tr></thead><tbody>${mv}</tbody></table>
    ${stamp}
    ${footer}
  </div>`;
}

async function exportCustomerStatementPdf() {
  const item = selectedCustomer(latestCustomerBalanceItems());
  if (!item) {
    setNotice("error", "اختر زبونًا أولاً.");
    render();
    return;
  }
  const safe = String(item.name || "customer").replace(/[^\p{L}\p{N}]+/gu, "_").slice(0, 40);
  const exported = await exportReportPdf(
    customerStatementPdfMarkup(item),
    `كشف-حساب-${safe}-${todayIsoDate()}.pdf`,
    { docType: "account_statement", meta: { party: item.name, date: todayIsoDate() } }
  );
  if (exported) setNotice("success", isHandheldDevice() ? "تم تجهيز كشف الحساب كملف PDF." : "تم تجهيز كشف الحساب PDF.");
  render();
}

// سند رسمي (قبض/صرف) بالتصميم المبرَند مع الختم الأزرق
// صياغة الرصيد للزبون: القيمة المطلقة مع بيان الجهة (عليكم = دين عليه، لكم = رصيد له).
function balanceText(bal, cur) {
  const b = roundPrice(bal);
  if (Math.abs(b) < 0.01) return "مسدّد (صفر)";
  return `${formatMoney(Math.abs(b))} ${cur} ${b > 0 ? "(عليكم)" : "(لكم)"}`;
}

function voucherPdfMarkup(v) {
  const isPay = v.type === "payment";
  const isInv = v.type === "invoice";
  const isRet = v.type === "return";
  const title = isInv ? "فاتورة" : (isRet ? "فاتورة مرتجع" : (isPay ? "سند صرف" : "سند قبض"));
  const cur = v.cur || "ل.س";
  const amtColor = (isPay || isInv) ? "#c0271f" : "#16794f";
  const amtLabel = isInv ? "قيمة الفاتورة" : (isRet ? "قيمة المرتجع" : (isPay ? "المبلغ المصروف" : "المبلغ المستلم"));
  const dstr = String(v.date || todayIsoDate()).slice(0, 10);
  const noteLine = isInv
    ? "هذه فاتورة صادرة عن OZK TOBACCO."
    : (isRet
      ? "هذا سند رسمي بقيمة البضاعة المرتجعة إلى OZK TOBACCO — خُصمت من رصيد حسابكم."
      : (isPay
        ? "هذا سند رسمي بالمبلغ المصروف من صندوق OZK TOBACCO."
        : "شكراً لتعاملكم مع OZK TOBACCO. هذا سند رسمي بالمبلغ المستلم."));
  const balLabel = isInv ? "الرصيد الحالي" : (isRet ? "الرصيد بعد المرتجع" : (isPay ? "الرصيد بعد الصرف" : "الرصيد بعد الدفعة"));
  // أرصدة الذمم تأتي من ac000 بعملة الأساس (الدولار) ولا تُحوَّل — فلا يجوز طبعها
  // بوسم «ل.س» لزبون عملة وصله ليرة. عملة الرصيد مستقلة عن عملة المستند.
  const balCur = v.balanceCur || "$";
  const rows = [];
  rows.push(`<tr><th style="width:130px">التاريخ</th><td>${escapeHtml(dstr)}</td></tr>`);
  if (v.method) rows.push(`<tr><th>طريقة الدفع</th><td>${escapeHtml(v.method)}</td></tr>`);
  if (v.notes) rows.push(`<tr><th>البيان</th><td>${escapeHtml(v.notes)}</td></tr>`);
  // للفاتورة والمرتجع: نعرض الرصيد السابق ثم القيمة ثم الرصيد الجديد ليعرف الزبون وضعه بوضوح.
  if ((isInv || isRet) && v.newBalance !== undefined && v.newBalance !== null) {
    rows.push(`<tr><th>الرصيد السابق</th><td>${escapeHtml(balanceText(v.prevBalance, balCur))}</td></tr>`);
    rows.push(`<tr><th>${isRet ? "قيمة هذا المرتجع" : "قيمة هذه الفاتورة"}</th><td>${escapeHtml(formatMoney(v.amount || 0))} ${escapeHtml(cur)}</td></tr>`);
    // إن سُجّلت الفاتورة على الحساب بمبلغ أقل/أكثر من قيمتها (حسم أو تسوية) نُظهر الفرق
    // ليبقى الحساب شفافاً: السابق + الفاتورة − الحسم = الجديد.
    // الحسم ودفعة الزبون عمليتان محاسبيتان مستقلتان تماماً، ولكلٍّ سطره:
    //   الرصيد الجديد = السابق + قيمة الفاتورة − الحسم − دفعة الزبون
    // لا يجوز أن تُطبع دفعة داخل خانة الحسم ولا العكس. كلٌّ يظهر فقط إن وُجد.
    if (Number(v.discount || 0) > 0.009) {
      rows.push(`<tr><th>الحسم</th><td class="cred">− ${escapeHtml(formatMoney(v.discount))} ${escapeHtml(cur)}</td></tr>`);
    }
    if (Number(v.payment || 0) > 0.009) {
      rows.push(`<tr><th>دفعة من الزبون</th><td class="cred">− ${escapeHtml(formatMoney(v.payment))} ${escapeHtml(cur)}</td></tr>`);
    }
    // `adjust` فرق **غير منسوب**: ما تبقّى من حركة الحساب بعد طرح الحسم والدفعة
    // المعروفَين. لا يُسمّى حسماً: مصدر فواتير الأمين لا يفصل الحسم عن الدفعة
    // (راجع tools/push-customer-invoices.ps1 — الفاتورة تصل بحقول
    // number/date/guid/total/isReturn/lines فقط)، فتسميته حسماً تطبع دفعة زبون
    // على أنها حسم في مستند يُسلَّم للزبون.
    if (Number(v.adjust || 0) > 0.009) {
      rows.push(`<tr><th>تسوية على الحساب</th><td class="cred">− ${escapeHtml(formatMoney(v.adjust))} ${escapeHtml(cur)}</td></tr>`);
    } else if (Number(v.adjust || 0) < -0.009) {
      rows.push(`<tr><th>إضافة / تسوية</th><td class="deb">+ ${escapeHtml(formatMoney(Math.abs(v.adjust)))} ${escapeHtml(cur)}</td></tr>`);
    }
    rows.push(`<tr><th>الرصيد الجديد</th><td><b>${escapeHtml(balanceText(v.newBalance, balCur))}</b></td></tr>`);
  } else if (v.balance !== undefined && v.balance !== null && v.balance !== "") {
    const lbl = v.balanceLabel || balLabel;
    const balTxt = (isInv || isRet || v.type === "receipt") ? balanceText(v.balance, balCur) : `${formatMoney(v.balance)} ${cur}`;
    rows.push(`<tr><th>${escapeHtml(lbl)}</th><td>${escapeHtml(balTxt)}</td></tr>`);
    // إن تحرّك الحساب بعد هذا القيد (فواتير لاحقة مثلاً) نعرض الرصيد الحالي أيضاً:
    // سطر واحد لا يكفي — الزبون يقارن السند برصيده اليوم فيظنّ الفرق خطأً.
    // محصور بسند القبض وحده: الفاتورة والمرتجع لهما سطرا «السابق/الجديد».
    if (v.type === "receipt"
      && v.currentBalance !== undefined && v.currentBalance !== null && v.currentBalance !== ""
      && Math.abs(Number(v.currentBalance) - Number(v.balance)) > 0.009) {
      const asOf = shortDateTime(v.currentBalanceAt);
      rows.push(`<tr><th>الرصيد الحالي</th><td>${escapeHtml(balanceText(v.currentBalance, balCur))} <small>(بعد حركات لاحقة${asOf ? " — حتى " + escapeHtml(asOf) : ""})</small></td></tr>`);
    }
  }
  const stamp = `
    <div class="stamp-wrap"><div class="seal">
      <div class="s-name">مركز أبو زياد</div>
      <div class="s-sub">لتجارة الدخان</div>
      <div class="s-logo">OZK TOBACCO</div>
      <div class="s-info" dir="ltr">0985000771 - 0984000662 · رقم المركز: 0994092038</div>
      <div class="s-addr">دوما - ساحة الغنم</div>
    </div></div>`;
  return `${REPORT_STYLE}<div class="ozk-rpt">
    <div class="rhead">
      <div style="display:flex;align-items:center;gap:10px">
        <img src="public/icons/ozk-logo.png" class="rlogo" alt="OZK" onerror="this.style.display='none'">
        <div class="brand">OZK TOBACCO<small>مركز أبو زياد — لتجارة الدخان</small></div>
      </div>
      <div class="rtitle"><h2>${title}</h2><span>رقم: ${escapeHtml(v.no || docNumber(isInv ? "INV" : (isRet ? "RET" : (isPay ? "PV" : "R"))))} · ${escapeHtml(dstr)}</span></div>
    </div>
    <div class="balbox">
      <div><div class="nm">${escapeHtml(v.name || "")}</div>
        <div class="muted">${isPay ? "جهة الصرف / المستفيد" : (v.phone ? "هاتف: " + escapeHtml(v.phone) : "")}</div></div>
      <div style="text-align:left"><div class="muted">${amtLabel}</div>
        <div class="big" style="color:${amtColor}">${escapeHtml(formatMoney(v.amount || 0))} ${escapeHtml(cur)}</div></div>
    </div>
    ${((isInv || isRet) && Array.isArray(v.lines) && v.lines.length) ? `
    <div class="sec">${isRet ? "أصناف المرتجع" : "أصناف الفاتورة"}</div>
    <table>
      <thead><tr><th>المادة</th><th>الكمية</th><th>سعر الوحدة</th><th>قيمة السطر</th></tr></thead>
      <tbody>${v.lines.map((l) => `<tr><td>${escapeHtml(l.material || "")}</td><td>${escapeHtml(invoiceLineQty(l))}</td><td>${escapeHtml(invoiceLinePrice(l, { total: v.amount, lines: v.lines }))}</td><td>${escapeHtml(invoiceLineValueText(l, { total: v.amount, lines: v.lines }))}</td></tr>`).join("")}</tbody>
    </table>` : ""}
    <table>${rows.join("")}</table>
    <p class="muted" style="margin:8px 0 0">${noteLine}</p>
    ${stamp}
    <div class="rfoot"><span>صادر آليًا عن نظام OZK TOBACCO · رقم المركز: 0994092038</span><span dir="ltr">0985000771 — 0984000662</span></div>
  </div>`;
}

async function exportVoucherPdf(v) {
  const isPay = v.type === "payment";
  const isInv = v.type === "invoice";
  const isRet = v.type === "return";
  const safe = String(v.name || (isInv ? "فاتورة" : (isRet ? "مرتجع" : (isPay ? "صرف" : "قبض")))).replace(/[^\p{L}\p{N}]+/gu, "_").slice(0, 40);
  const prefix = isInv ? "فاتورة" : (isRet ? "فاتورة-مرتجع" : (isPay ? "سند-صرف" : "سند-قبض"));
  // وجهة الأرشفة: الفاتورة والمرتجع إلى «فواتير الزبائن»، السندان إلى «سندات
  // قبض ودفع». المرتجع نوع مستقل (`return_invoice`) لا يُخلط مع `invoice`
  // داخلياً، واسمه يبدأ بـ«فاتورة مرتجع» فيتميّز في الأرشيف عن بيع حقيقي.
  const archiveDocType = isInv ? "invoice" : (isRet ? "return_invoice" : (isPay ? "payment" : "receipt"));
  const archiveDate = String(v.date || todayIsoDate()).slice(0, 10);
  const archiveMeta = { party: v.name, number: v.no, date: archiveDate };
  const exported = await exportReportPdf(
    voucherPdfMarkup(v),
    `${prefix}-${safe}-${todayIsoDate()}.pdf`,
    { docType: archiveDocType, meta: archiveMeta }
  );
  if (exported) setNotice("success", isInv ? "تم تجهيز الفاتورة PDF." : (isRet ? "تم تجهيز فاتورة المرتجع PDF." : (isPay ? "تم تجهيز سند الصرف PDF." : "تم تجهيز سند القبض PDF.")));
  render();
}

function receivablesPdfMarkup() {
  const items = latestCustomerBalanceItems();
  const totals = customerBalanceTotals(items);
  const totalDebit = totals.totalDebitBalance;              // مجموع المدين (موجب)
  const totalCredit = Math.abs(totals.totalCreditBalance);  // مجموع الدائن (نعرضه موجباً)
  const net = totalDebit - totalCredit;                     // صافي الذمم لصالحنا
  // كل الزبائن أصحاب رصيد (مدين موجب أو دائن سالب) — بلا قصّ. المدينون أولاً ثم الدائنون.
  const withBalance = items
    .filter((i) => Math.abs(customerBalance(i)) > 0.009)
    .sort((a, b) => customerBalanceSortValue(b) - customerBalanceSortValue(a));
  const rows = withBalance.length
    ? withBalance.map((it, idx) => {
        const bal = customerBalance(it);
        const isDebit = bal > 0;
        const ld = customerLastPaymentDate(it);
        const la = customerLastPaymentAmount(it);
        return `<tr><td>${idx + 1}</td><td>${escapeHtml(it.name || "")}</td>`
          + `<td class="deb">${isDebit ? escapeHtml(formatMoney(bal)) : "—"}</td>`
          + `<td class="cred">${isDebit ? "—" : escapeHtml(formatMoney(Math.abs(bal)))}</td>`
          + `<td>${ld ? escapeHtml(String(ld).slice(0, 10)) : "—"}</td>`
          + `<td>${la > 0 ? escapeHtml(formatMoney(la)) : "—"}</td></tr>`;
      }).join("")
      + `<tr class="closing"><td></td><td>الإجمالي (${escapeHtml(withBalance.length)} زبون)</td>`
      + `<td class="deb">${escapeHtml(formatMoney(totalDebit))}</td>`
      + `<td class="cred">${escapeHtml(formatMoney(totalCredit))}</td><td></td><td></td></tr>`
    : `<tr><td colspan="6" class="muted">لا يوجد زبائن أصحاب أرصدة</td></tr>`;
  return `${REPORT_STYLE}<div class="ozk-rpt">
    <div class="rhead"><div class="brand">OZK TOBACCO<small>تقرير الذمم الإجمالي</small></div>
      <div class="rtitle"><h2>الذمم</h2><span>بتاريخ ${escapeHtml(todayIsoDate())}</span></div></div>
    <div class="cards">
      <div class="rcard"><div class="v red">${escapeHtml(formatMoney(totalDebit))}</div><div class="l">إجمالي المدين — مستحق لنا (${escapeHtml(totals.debitCustomers)} زبون)</div></div>
      <div class="rcard"><div class="v green">${escapeHtml(formatMoney(totalCredit))}</div><div class="l">إجمالي الدائن — لهم عندنا (${escapeHtml(totals.creditCustomers)} زبون)</div></div>
      <div class="rcard"><div class="v gold">${escapeHtml(formatMoney(net))}</div><div class="l">صافي الذمم لصالحنا</div></div>
    </div>
    <div class="sec">أرصدة الزبائن — المدين والدائن (${escapeHtml(withBalance.length)} زبون)</div>
    <table>
      <thead><tr><th>#</th><th>الزبون</th><th>مدين (عليه)</th><th>دائن (له)</th><th>تاريخ آخر دفعة</th><th>قيمة آخر دفعة</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

async function exportReceivablesPdf() {
  const items = latestCustomerBalanceItems();
  if (!items.length) {
    setNotice("error", "لا توجد أرصدة زبائن لإنشاء التقرير.");
    render();
    return;
  }
  const exported = await exportReportPdf(
    receivablesPdfMarkup(),
    `تقرير-الذمم-${todayIsoDate()}.pdf`,
    { docType: "receivables_report", meta: { date: todayIsoDate() } }
  );
  if (exported) setNotice("success", "تم تجهيز تقرير الذمم PDF.");
  render();
}

// محرّك تحويل PDF (html2canvas) يسقط المسافات بين الكلمات العربية أحياناً —
// نحوّل المسافات العادية لمسافات ثابتة (nbsp) لتبقى ظاهرة في التقرير.
function pdfAr(s) {
  return String(s == null ? "" : s).replace(/ /g, " ");
}

// كمية الصنف بالوحدة الكبرى (كرتونة/شرحة/طرد): نفضّل stockQtyUnit2 المحسوبة جاهزةً في
// مزامنة الأمين، وإلا نقسم كمية الكروز على معامل الوحدة.
function itemQtyUnit2(it) {
  const direct = Number(it?.stockQtyUnit2);
  const q = itemQty(it);
  if (Number.isFinite(direct) && (direct > 0 || q <= 0)) return direct;
  const f = Number(it?.unit2Factor || 0);
  return roundPrice(f > 0 ? q / f : q);
}

// كمية الصنف بصيغة التاجر: كراتين كاملة + الباقي كروزاً («10 كرتونة و21 كروز») بدل
// الكسور العشرية المربكة («10.42 كرتونة»). الكميات السالبة (جرد بالسالب) تُعرض بإشارتها.
function formatQtyCartons(it) {
  const q = Number(it?.stockQty ?? itemQty(it)) || 0;
  const f = Number(it?.unit2Factor || 0);
  const u1 = String(it?.unit1Name || "").trim();
  const u2 = String(it?.unit2Name || "").trim();
  if (!(f > 1) || !u2) return `${formatMoney(roundPrice(q))} ${u2 || u1}`.trim();
  const sign = q < 0 ? "−" : "";
  const abs = Math.abs(q);
  const whole = Math.floor((abs + 1e-9) / f);
  const rem = roundPrice(abs - whole * f);
  if (whole > 0 && rem > 0) return `${sign}${formatMoney(whole)} ${u2} و${formatMoney(rem)} ${u1 || ""}`.trim();
  if (whole > 0) return `${sign}${formatMoney(whole)} ${u2}`;
  return `${sign}${formatMoney(rem)} ${u1 || u2}`.trim();
}

// حالة الصنف كما تحسبها مزامنة الأمين (بحدود المجموعات، مثل: ماستر < 250 كروز = قارب النفاد)
// — لا نعيد حسابها في الموقع كي لا تخالف الأمين.
const INV_STATUS_BADGE = {
  out: '<span class="deb">نافد</span>',
  low: '<span style="color:#8a5a00;font-weight:700">قارب على النفاد</span>',
  stale: '<span class="muted" style="font-weight:700">راكدة</span>',
  review: '<span class="deb">مراجعة جرد</span>',
  active: '<span style="color:#16794f;font-weight:700">متوفّر</span>'
};

// ترتيب تقرير المخزون يطابق ترتيب مجموعات نشرة الأسعار. لا ندمج المواد هنا:
// كل صنف (وبالأخص أصناف المعسل) يبقى بسطر مستقل لإظهار كميته الحقيقية.
const INVENTORY_GROUP_SEQUENCE = [
  ["غلواز", "جولواز", "gauloises"],
  ["ماستر", "master"],
  ["كابتن بلاك", "captain black"],
  ["اليغانس", "اليجنس", "elegance"],
  ["اوسكار", "oscar"],
  ["تي اس", "ts"],
  ["اختمار"],
  ["اوريس", "auris"],
  ["روز", "rose"],
  ["حمرا", "الحمراء"],
  ["1970"],
  ["يونايتد", "united"],
  ["كينغ دوم", "كينج دوم", "kingdom"],
  ["ولسون", "wilson"],
  ["مانشستر", "manchester"],
  ["نابولي", "napoli"],
  ["مليونير", "millionaire"],
  ["بزنس", "business"],
  ["بارسا", "barca"],
  ["برو", "pro"],
  ["ام تي", "mt"],
  ["اصناف الحره", "حرة", "حره"],
  ["سيغار", "سيناتور", "كلارو"],
  ["فحم"],
  ["ورق"],
  ["معسل", "مزايا", "فاخر", "نخله", "صفوه", "اسطوره"],
  ["فيب", "فيبات"],
  ["قداحات", "قداحه"],
  ["سلفان"]
];

function inventoryGroupInfo(it) {
  const label = String(it?.groupName || "مواد بدون مجموعة").trim() || "مواد بدون مجموعة";
  const haystack = normalizeItemName(`${label} ${it?.name || ""}`);
  const rank = INVENTORY_GROUP_SEQUENCE.findIndex((aliases) =>
    aliases.some((alias) => haystack.includes(normalizeItemName(alias)))
  );
  return { label, rank: rank < 0 ? INVENTORY_GROUP_SEQUENCE.length : rank };
}

function isCriticalFastGroup(it) {
  const text = normalizeItemName(`${it?.groupName || ""} ${it?.name || ""}`);
  return ["ماستر", "master", "غلواز", "جولواز", "gauloises"]
    .some((alias) => text.includes(normalizeItemName(alias)));
}

// التصنيف التشغيلي يعتمد على حركة المبيع لا على رقم ثابت لجميع المواد:
// 30 يوماً أو أقل = قريب من النفاد. الأصناف البطيئة بلا مبيع حديث تبقى «متوفرة»
// ولا تُظلم بتصنيف قريب النفاد. نحتفظ بحد الأمين للماستر والغلواز لأنهما سريعَا الحركة.
function inventoryReportStatus(it, sales, periodDays, hasSalesReport) {
  const rawQty = Number(it?.stockQty || 0);
  const positiveQty = Number(it?.stockQtyPositive || 0);
  if (rawQty <= 0 && positiveQty > 0) return "review";
  if (rawQty <= 0) return "out";
  if (!hasSalesReport) return ["low", "review", "stale"].includes(it?.status) ? it.status : "active";

  const sold = Number(sales.get(normalizeItemName(it?.name || "")) || 0);
  if (sold > 0) {
    const coverageDays = rawQty / (sold / periodDays);
    if (coverageDays <= 30) return "low";
  }
  if (isCriticalFastGroup(it) && it?.status === "low") return "low";
  return "active";
}

const INVENTORY_REPORT_STYLE = `<style>
.ozk-rpt.inventory-rpt{color-scheme:light!important;color:#221808!important;background:#fffdf8!important}
.ozk-rpt.inventory-rpt .inventory-page{background:#fffdf8!important;break-after:page;page-break-after:always}
.ozk-rpt.inventory-rpt .inventory-page:last-child{break-after:auto;page-break-after:auto}
.ozk-rpt.inventory-rpt .rhead{background:#fffdf8!important;margin-bottom:7px;padding-bottom:5px}
.ozk-rpt.inventory-rpt .rhead .brand{font-size:15px}.ozk-rpt.inventory-rpt .rtitle h2{font-size:13px}
.ozk-rpt.inventory-rpt .cards{gap:6px;margin-bottom:7px}.ozk-rpt.inventory-rpt .rcard{background:#f7efd9!important;color:#221808!important;padding:5px 7px}
.ozk-rpt.inventory-rpt .rcard .v{font-size:16px}.ozk-rpt.inventory-rpt .rcard .l{font-size:8.5px}
.ozk-rpt.inventory-rpt .inventory-columns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;align-items:start;direction:rtl}
.ozk-rpt.inventory-rpt .inventory-column{min-width:0}
.ozk-rpt.inventory-rpt .inventory-group{margin:0 0 5px;break-inside:avoid;page-break-inside:avoid}
.ozk-rpt.inventory-rpt table{font-size:9.2px;table-layout:fixed}
.ozk-rpt.inventory-rpt th{background:#ece1c4!important;color:#221808!important;padding:3px 5px;font-size:8.8px}
.ozk-rpt.inventory-rpt td{background:#fffdf8!important;color:#221808!important;padding:3px 5px;line-height:1.25}
.ozk-rpt.inventory-rpt tr:nth-child(even) td{background:#faf4e6!important}
.ozk-rpt.inventory-rpt .inventory-group-row td{background:#6b4309!important;color:#f4ca62!important;border-color:#b8892a!important;font-weight:900;padding:4px 6px;font-size:10px}
.ozk-rpt.inventory-rpt .inventory-group-row .group-count{float:left;background:#f4ca62;color:#4d2d04;border-radius:999px;padding:1px 7px;font-size:10px}
.ozk-rpt.inventory-rpt .status-low{color:#9a6100!important;font-weight:800}.ozk-rpt.inventory-rpt .status-active{color:#16794f!important;font-weight:800}
@media print{html,body,.ozk-rpt.inventory-rpt,.ozk-rpt.inventory-rpt .inventory-page{background:#fffdf8!important;color:#221808!important}.ozk-rpt.inventory-rpt{padding:0!important}}
</style>`;

// تقسيم فعلي إلى صفحات وعمودين. كل مجموعة تبقى كتلة واحدة، وتذهب المجموعة التالية
// إلى العمود الأقصر؛ لذلك تبدأ الغلواز يميناً والماستر يساراً وتختفي الفراغات الكبيرة.
function inventoryTwoColumnPages(groups, columnCapacity = 48) {
  const pages = [];
  const newPage = () => ({ columns: [[], []], weights: [0, 0] });
  let page = newPage();
  pages.push(page);
  for (const group of groups) {
    const weight = group.items.length + 1;
    let column = page.weights[0] <= page.weights[1] ? 0 : 1;
    const other = column === 0 ? 1 : 0;
    if (page.weights[column] + weight > columnCapacity && page.weights[other] + weight <= columnCapacity) column = other;
    if (page.weights[column] + weight > columnCapacity) {
      page = newPage();
      pages.push(page);
      column = 0;
    }
    page.columns[column].push(group);
    page.weights[column] += weight;
  }
  return pages;
}

function inventoryReportPdfMarkup() {
  // كل كمية موجبة تظهر. الصنف النافد لا يظهر إلا إذا كان عليه مبيع حقيقي حديث؛
  // التسعير القديم وحده ليس دليلاً كافياً (مثل أصناف بلاتينوم القديمة).
  const allRaw = reportItems(latestStockReport());
  const sales = materialSalesUnit1Map();
  const salesReport = state.customerInvoicesReport;
  const hasSalesReport = Boolean(salesReport && Array.isArray(salesReport.items));
  const periodDays = Math.max(1, Number(salesReport?.summary?.periodDays || 60));
  const hasRecentSale = (it) => sales.has(normalizeItemName(it?.name || ""));
  const all = allRaw.filter((it) =>
    Number(it?.stockQty || 0) > 0 || Number(it?.stockQtyPositive || 0) > 0 || hasRecentSale(it)
  );
  const excludedCount = allRaw.length - all.length;
  const classified = all.map((it) => ({
    ...it,
    reportStatus: inventoryReportStatus(it, sales, periodDays, hasSalesReport),
    reportGroup: inventoryGroupInfo(it)
  }));
  const low = classified.filter((i) => i.reportStatus === "low");
  const out = classified.filter((i) => i.reportStatus === "out");
  const review = classified.filter((i) => i.reportStatus === "review");
  const list = classified.slice().sort((a, b) =>
    a.reportGroup.rank - b.reportGroup.rank ||
    String(a.reportGroup.label).localeCompare(String(b.reportGroup.label), "ar") ||
    String(a.name || "").localeCompare(String(b.name || ""), "ar")
  );
  const grouped = [];
  for (const it of list) {
    let group = grouped[grouped.length - 1];
    if (!group || group.label !== it.reportGroup.label) {
      group = { label: it.reportGroup.label, items: [] };
      grouped.push(group);
    }
    group.items.push(it);
  }
  const badgeOf = (it) => it.reportStatus === "low"
    ? '<span class="status-low">قريب من النفاد</span>'
    : (it.reportStatus === "active" ? '<span class="status-active">متوفّر</span>' : (INV_STATUS_BADGE[it.reportStatus] || INV_STATUS_BADGE.active));
  const groupMarkup = (group) => `<div class="inventory-group"><table><tbody>
    <tr class="inventory-group-row"><td colspan="3">${escapeHtml(pdfAr(group.label))}<span class="group-count">${escapeHtml(group.items.length)}</span></td></tr>
    ${group.items.map((it) => `<tr><td style="width:48%">${escapeHtml(pdfAr(it.name || ""))}</td><td style="width:29%">${escapeHtml(pdfAr(formatQtyCartons(it)))}</td><td style="width:23%">${badgeOf(it)}</td></tr>`).join("")}
  </tbody></table></div>`;
  const pages = inventoryTwoColumnPages(grouped);
  const pagesMarkup = pages.map((page, pageIndex) => `<section class="inventory-page">
    <div class="rhead"><div class="brand">OZK TOBACCO<small>تقرير المخزون التشغيلي</small></div>
      <div class="rtitle"><h2>المخزون — حسب ترتيب النشرة</h2><span>بتاريخ ${escapeHtml(todayIsoDate())} · صفحة ${escapeHtml(pageIndex + 1)} من ${escapeHtml(pages.length)}</span></div></div>
    ${pageIndex === 0 ? `<div class="cards">
      <div class="rcard"><div class="v gold">${escapeHtml(classified.length)}</div><div class="l">أصناف فعلية ومتداولة</div></div>
      <div class="rcard"><div class="v red">${escapeHtml(low.length)}</div><div class="l">قريب من النفاد حسب حركة المبيع</div></div>
      <div class="rcard"><div class="v red">${escapeHtml(out.length)}</div><div class="l">نافد وله طلب حديث</div></div>
    </div>` : ""}
    <div class="inventory-columns">
      <div class="inventory-column">${page.columns[0].map(groupMarkup).join("") || '<p class="muted">—</p>'}</div>
      <div class="inventory-column">${page.columns[1].map(groupMarkup).join("") || '<p class="muted">—</p>'}</div>
    </div>
    ${pageIndex === pages.length - 1 ? `<p class="muted" style="margin-top:6px">الحالة محسوبة على تغطية المبيع خلال ${escapeHtml(periodDays)} يوماً${hasSalesReport ? "" : " (لم تصل حركة المبيع؛ استُخدم تصنيف المزامنة مؤقتاً)"}. لا تُدمج أصناف المعسل.${review.length ? ` يوجد ${escapeHtml(review.length)} صنف يحتاج مراجعة جرد.` : ""}${excludedCount > 0 ? ` استُبعد ${escapeHtml(excludedCount)} صنفاً نافداً بلا مبيع حديث.` : ""}</p>` : ""}
  </section>`).join("");
  return `${REPORT_STYLE}${INVENTORY_REPORT_STYLE}<div class="ozk-rpt inventory-rpt">${pagesMarkup}</div>`;
}

async function exportInventoryReportPdf() {
  const items = reportItems(latestStockReport());
  if (!items.length) {
    setNotice("error", "لا توجد مواد لإنشاء تقرير المخزون.");
    render();
    return;
  }
  const exported = await exportReportPdf(
    inventoryReportPdfMarkup(),
    `تقرير-المخزون-${todayIsoDate()}.pdf`,
    { docType: "stock_report", meta: { date: todayIsoDate() } }
  );
  if (exported) setNotice("success", "تم تجهيز تقرير المخزون PDF.");
  render();
}

// إجمالي المبيع لكل مادة بالوحدة الأساسية (كروز) من فواتير الزبائن خلال فترة التقرير.
function materialSalesUnit1Map() {
  const map = new Map();
  const report = state.customerInvoicesReport;
  const custItems = report && Array.isArray(report.items) ? report.items : [];
  for (const cust of custItems) {
    const invoices = Array.isArray(cust.invoices) ? cust.invoices : [];
    for (const inv of invoices) {
      const lines = Array.isArray(inv.lines) ? inv.lines : [];
      for (const l of lines) {
        const key = normalizeItemName(l.material || "");
        const qty = Number(l.qty || 0); // كروز
        if (key && qty > 0) map.set(key, (map.get(key) || 0) + qty);
      }
    }
  }
  return map;
}

// تقرير المواد الراكدة: يقارن المخزون الحالي بمعدّل البيع (كم شهراً يكفي المخزون)،
// ويرتّب المواد من الأكثر ركوداً (مخزون مرتفع + مبيع قليل) إلى الأقل.
function stagnantMaterialsPdfMarkup() {
  const stock = pricingWorklistItems().filter((it) => itemQty(it) > 0);
  const sales = materialSalesUnit1Map();
  const periodDays = Math.max(1, Number(state.customerInvoicesReport?.summary?.periodDays || 60));

  const rows = stock.map((it) => {
    const factor = itemUnit2Factor(it);
    const stockU1 = itemQty(it);                                     // كروز
    const soldU1 = sales.get(normalizeItemName(it.name || "")) || 0; // كروز خلال الفترة
    const monthlyU1 = (soldU1 / periodDays) * 30;
    const coverage = monthlyU1 > 0 ? stockU1 / monthlyU1 : Infinity; // أشهر التغطية
    return {
      name: it.name || "",
      u2: itemUnit2Name(it),
      stockU2: factor > 0 ? stockU1 / factor : stockU1,
      soldU2: factor > 0 ? soldU1 / factor : soldU1,
      coverage,
      noSale: soldU1 <= 0
    };
  }).sort((a, b) => (b.coverage - a.coverage) || (b.stockU2 - a.stockU2));

  const statusOf = (r) =>
    r.noSale ? '<span class="deb">راكد — لا مبيع</span>'
    : (r.coverage >= 6 ? '<span class="deb">بطيء جداً</span>'
    : (r.coverage >= 3 ? '<span style="color:#8a5a00;font-weight:700">بطيء</span>'
    : '<span style="color:#16794f;font-weight:700">متحرّك</span>'));
  const covText = (r) => r.noSale ? "∞ (لا مبيع)" : `${formatMoney(roundPrice(r.coverage))} شهر`;

  const body = rows.length
    ? rows.map((r) => `<tr><td>${escapeHtml(pdfAr(r.name))}</td>`
        + `<td>${escapeHtml(pdfAr(`${formatMoney(roundPrice(r.stockU2))} ${r.u2}`))}</td>`
        + `<td>${escapeHtml(pdfAr(`${formatMoney(roundPrice(r.soldU2))} ${r.u2}`))}</td>`
        + `<td>${escapeHtml(covText(r))}</td><td>${statusOf(r)}</td></tr>`).join("")
    : `<tr><td colspan="5" class="muted">لا توجد بيانات كافية</td></tr>`;

  const noSale = rows.filter((r) => r.noSale).length;
  const slow = rows.filter((r) => !r.noSale && r.coverage >= 3).length;

  return `${REPORT_STYLE}<div class="ozk-rpt">
    <div class="rhead"><div class="brand">OZK TOBACCO<small>المواد الراكدة</small></div>
      <div class="rtitle"><h2>المواد الراكدة</h2><span>بتاريخ ${escapeHtml(todayIsoDate())}</span></div></div>
    <div class="cards">
      <div class="rcard"><div class="v red">${escapeHtml(noSale)}</div><div class="l">مادة بلا أي مبيع (خلال الفترة)</div></div>
      <div class="rcard"><div class="v red">${escapeHtml(slow)}</div><div class="l">مادة بطيئة (يكفي مخزونها ٣ أشهر فأكثر)</div></div>
      <div class="rcard"><div class="v gold">${escapeHtml(rows.length)}</div><div class="l">إجمالي المواد ذات المخزون</div></div>
    </div>
    <div class="sec">من الأكثر ركوداً (مخزون مرتفع + مبيع قليل) إلى الأقل</div>
    <table>
      <thead><tr><th>المادة</th><th>المخزون</th><th>المبيع (${escapeHtml(periodDays)} يوم)</th><th>يكفي لـ</th><th>الحالة</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
    <p class="muted" style="margin-top:8px">«يكفي لـ» = كم شهراً يكفي المخزون الحالي بمعدّل البيع. المبيع محسوب من فواتير الزبائن خلال آخر ${escapeHtml(periodDays)} يوم (لا يشمل مبيعات الكاش بدون اسم).</p>
  </div>`;
}

async function exportStagnantMaterialsPdf() {
  const stock = pricingWorklistItems().filter((it) => itemQty(it) > 0);
  if (!stock.length) {
    setNotice("error", "لا توجد مواد بمخزون لإنشاء تقرير المواد الراكدة.");
    render();
    return;
  }
  if (!state.customerInvoicesReport) {
    setNotice("error", "لم تصل بيانات مبيعات الفواتير بعد — انتظر مزامنة الفواتير ثم أعد المحاولة.");
    render();
    return;
  }
  const exported = await exportReportPdf(
    stagnantMaterialsPdfMarkup(),
    `المواد-الراكدة-${todayIsoDate()}.pdf`,
    { docType: "other_report", meta: { title: "تقرير المواد الراكدة", date: todayIsoDate() } }
  );
  if (exported) setNotice("success", "تم تجهيز تقرير المواد الراكدة PDF.");
  render();
}

function customerDetailsPanel(item) {
  if (!item) {
    return `
      <section class="customer-detail-panel customer-detail-empty" data-customer-detail-panel>
        <span class="customer-detail-hint">👆 اضغط على اسم أي زبون لعرض سجل دفعاته الكامل</span>
      </section>
    `;
  }

  const key = customerKey(item);
  const ameenPayments = (Array.isArray(item.recentPayments) ? item.recentPayments : [])
    .map((p) => ({ amount: p.amount, date: p.date || "", notes: p.notes, source: "ameen" }));
  const manualPayments = ((state.paymentRecords && state.paymentRecords[key]) || [])
    .map((p) => ({ amount: p.amount, date: p.paymentDate || "", notes: p.notes, source: "manual" }));
  const allPayments = [...ameenPayments, ...manualPayments]
    .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  const fullMv = customerFullMovements(item);
  const movements = (fullMv && Array.isArray(fullMv.movements) && fullMv.movements.length)
    ? [...fullMv.movements].sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
    : (Array.isArray(item.recentMovements)
        ? [...item.recentMovements].sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
        : []);
  const invoiceMoves = movements.filter((m) => Number(m?.debit || 0) > 0);
  const creditMoves = movements.filter((m) => Number(m?.credit || 0) > 0);
  // مرتجع المبيعات يُقيَّد دائناً على حساب الزبون تماماً كالدفعة — نفرزه هنا بمطابقة
  // فاتورة المرتجع الفعلية (بالتاريخ والمبلغ) ليُصدَّر كفاتورة مرتجع لا كسند قبض.
  const returnMoves = creditMoves.filter((m) => findReturnInvoiceForMovement(item.name || "", m));
  const paymentMoves = creditMoves.filter((m) => !findReturnInvoiceForMovement(item.name || "", m));

  return `
    <section class="customer-detail-panel" data-customer-detail-panel>
      <div class="panel-title-row inventory-browser-head">
        <div>
          <h3>${escapeHtml(item.name)}</h3>
          <p class="muted">الرصيد، تسجيل الدفعات، والفواتير والمرتجعات وسندات القبض.</p>
        </div>
        <div style="display:flex;gap:8px">
          <button class="button secondary compact-button" type="button" data-action="toggle-currency" title="تبديل عملة الزبون بين الدولار والليرة (يُحفظ)">💱 العملة: ${escapeHtml(customerCurrency(item))}</button>
          <button class="button primary compact-button" type="button" data-action="export-statement">📄 كشف حساب PDF</button>
          <button class="button secondary compact-button" type="button" data-action="clear-customer-details">✕ إغلاق</button>
        </div>
      </div>

      <div class="inventory-metrics customer-detail-metrics">
        ${inventoryMetric("الرصيد الحالي", formatMoney(customerBalance(item)), customerStatusLabel(item.status))}
        ${inventoryMetric("الحد المسموح", customerLimit(item) > 0 ? formatMoney(customerLimit(item)) : "غير محدد", customerLimitSourceLabel(item.limitSource))}
        ${inventoryMetric("المتبقي من الحد", customerLimit(item) > 0 ? formatMoney(customerRemainingLimit(item)) : "غير محدد", "من الحد الفعال")}
        ${inventoryMetric("آخر دفعة", customerLastPaymentAmount(item) > 0 ? formatMoney(customerLastPaymentAmount(item)) : "غير متوفر", customerLastPaymentDate(item) ? formatDate(customerLastPaymentDate(item)) : "لا يوجد تاريخ")}
      </div>

      ${state.session ? `
        <div class="payment-record-section">
          <h4>تسجيل دفعة جديدة</h4>
          <form class="payment-record-form" data-form="record-payment" data-customer-key="${escapeHtml(key)}" data-customer-name="${escapeHtml(item.name || "")}">
            <div class="payment-form-row">
              <label>المبلغ<input name="amount" type="text" inputmode="decimal" dir="ltr" placeholder="0.00" required></label>
              <label>التاريخ<input name="date" type="date" value="${new Date().toISOString().slice(0, 10)}" required></label>
            </div>
            <label>ملاحظة<input name="notes" maxlength="500" placeholder="مثال: دفعة نقدية"></label>
            <button class="button primary mini-button" type="submit" ${state.paymentLoading ? "disabled" : ""}>${state.paymentLoading ? "جاري الحفظ..." : "✓ حفظ الدفعة"}</button>
          </form>
          ${state.paymentError ? `<p style="color:var(--danger);font-size:0.82rem;margin:6px 0 0">${escapeHtml(state.paymentError)}</p>` : ""}
        </div>
      ` : ""}

      <div class="customer-detail-grid">
        <article>
          <div class="detail-section-head">
            <h4>🧾 الفواتير</h4>
            <span class="status-chip">${invoiceMoves.length} فاتورة</span>
          </div>
          <div class="detail-list payment-timeline">
            ${invoiceMoves.length
              ? invoiceMoves.map((m) => `
                <div class="payment-entry">
                  <div class="payment-entry-dot movement-dot"></div>
                  <div class="payment-entry-body">
                    <strong class="payment-amount">فاتورة: ${escapeHtml(formatMoney(Number(m?.debit || 0)))}</strong>
                    <span class="payment-date">${escapeHtml(m?.date ? formatDate(m.date) : "بلا تاريخ")}</span>
                    ${m?.notes ? `<small class="payment-note">${escapeHtml(m.notes)}</small>` : ""}
                    <button class="button secondary mini-button" type="button" data-action="gen-movement-doc" data-debit="${escapeHtml(String(m?.debit || 0))}" data-credit="0" data-date="${escapeHtml(m?.date || "")}" data-notes="${escapeHtml(m?.notes || "")}" data-balance="${m?.balance !== undefined && m?.balance !== null ? escapeHtml(String(m.balance)) : ""}" data-balance-chrono="${m?.balanceChrono !== undefined && m?.balanceChrono !== null ? escapeHtml(String(m.balanceChrono)) : ""}" data-doc-new="${m?.docNew !== undefined && m?.docNew !== null ? escapeHtml(String(m.docNew)) : ""}" data-doc-prev="${m?.docPrev !== undefined && m?.docPrev !== null ? escapeHtml(String(m.docPrev)) : ""}" data-bill-guid="${escapeHtml(String(m?.billGuid || ""))}" style="margin-top:6px">📄 فاتورة PDF</button>
                  </div>
                </div>`).join("")
              : '<p class="muted" style="padding:12px 0">لا توجد فواتير مسجلة.</p>'}
          </div>
        </article>
        <article>
          <div class="detail-section-head">
            <h4>🔁 المرتجعات</h4>
            <span class="status-chip">${returnMoves.length} مرتجع</span>
          </div>
          <div class="detail-list payment-timeline">
            ${returnMoves.length
              ? returnMoves.map((m) => `
                <div class="payment-entry">
                  <div class="payment-entry-dot movement-dot"></div>
                  <div class="payment-entry-body">
                    <strong class="payment-amount">مرتجع: ${escapeHtml(formatMoney(Number(m?.credit || 0)))}</strong>
                    <span class="payment-date">${escapeHtml(m?.date ? formatDate(m.date) : "بلا تاريخ")}</span>
                    ${m?.notes ? `<small class="payment-note">${escapeHtml(m.notes)}</small>` : ""}
                    <button class="button secondary mini-button" type="button" data-action="gen-movement-doc" data-debit="0" data-credit="${escapeHtml(String(m?.credit || 0))}" data-date="${escapeHtml(m?.date || "")}" data-notes="${escapeHtml(m?.notes || "")}" data-balance="${m?.balance !== undefined && m?.balance !== null ? escapeHtml(String(m.balance)) : ""}" data-balance-chrono="${m?.balanceChrono !== undefined && m?.balanceChrono !== null ? escapeHtml(String(m.balanceChrono)) : ""}" data-doc-new="${m?.docNew !== undefined && m?.docNew !== null ? escapeHtml(String(m.docNew)) : ""}" data-doc-prev="${m?.docPrev !== undefined && m?.docPrev !== null ? escapeHtml(String(m.docPrev)) : ""}" style="margin-top:6px">📄 فاتورة مرتجع PDF</button>
                  </div>
                </div>`).join("")
              : '<p class="muted" style="padding:12px 0">لا توجد مرتجعات مسجلة.</p>'}
          </div>
        </article>
        <article>
          <div class="detail-section-head">
            <h4>💵 سندات القبض</h4>
            <span class="status-chip">${paymentMoves.length} دفعة</span>
          </div>
          <div class="detail-list payment-timeline">
            ${paymentMoves.length
              ? paymentMoves.map((m) => `
                <div class="payment-entry">
                  <div class="payment-entry-dot"></div>
                  <div class="payment-entry-body">
                    <strong class="payment-amount">دفعة: ${escapeHtml(formatMoney(Number(m?.credit || 0)))}</strong>
                    <span class="payment-date">${escapeHtml(m?.date ? formatDate(m.date) : "بلا تاريخ")}</span>
                    ${m?.notes ? `<small class="payment-note">${escapeHtml(m.notes)}</small>` : ""}
                    <button class="button secondary mini-button" type="button" data-action="gen-movement-doc" data-debit="0" data-credit="${escapeHtml(String(m?.credit || 0))}" data-date="${escapeHtml(m?.date || "")}" data-notes="${escapeHtml(m?.notes || "")}" data-balance="${m?.balance !== undefined && m?.balance !== null ? escapeHtml(String(m.balance)) : ""}" data-balance-chrono="${m?.balanceChrono !== undefined && m?.balanceChrono !== null ? escapeHtml(String(m.balanceChrono)) : ""}" data-doc-new="${m?.docNew !== undefined && m?.docNew !== null ? escapeHtml(String(m.docNew)) : ""}" data-doc-prev="${m?.docPrev !== undefined && m?.docPrev !== null ? escapeHtml(String(m.docPrev)) : ""}" style="margin-top:6px">📄 سند قبض PDF</button>
                  </div>
                </div>`).join("")
              : '<p class="muted" style="padding:12px 0">لا توجد دفعات مسجلة.</p>'}
          </div>
        </article>
      </div>
    </section>
  `;
}

function customerBalanceSection(report) {
  if (!report) {
    return `
      <section class="panel wide customer-balances">
        <h3>أرصدة الزبائن</h3>
        <p class="muted">لم تصل مزامنة أرصدة الزبائن بعد. سيتم عرضها هنا بعد تشغيل مزامنة الأمين الجديدة.</p>
      </section>
    `;
  }

  const items = applyCustomerLimits(Array.isArray(report.items) ? report.items : []);
  const summary = report.summary || {};
  const counts = customerFilterCounts(items);
  const filtered = filteredCustomerItems(items);
  const totals = customerBalanceTotals(items);
  const detailItem = selectedCustomer(items);

  const overdue = overdueCustomers();
  const overdueHtml = overdue.length > 0 ? `
    <details class="panel overdue-panel" open style="margin-bottom:16px">
      <summary class="overdue-summary">
        <span class="overdue-icon">⚠️</span>
        <div style="flex:1">
          <strong>${overdue.length} زبون بدون دفعة منذ أكثر من 3 أيام</strong>
          <p class="muted" style="font-size:.85rem;margin:2px 0 0">هؤلاء الزبائن عليهم رصيد ولم يسجّل لهم أي دفعة خلال الفترة المحددة.</p>
        </div>
        <button class="button secondary compact-button" type="button" data-action="print-overdue" onclick="event.stopPropagation()">🖨️ PDF</button>
      </summary>
      <div class="overdue-list">
        ${overdue.slice(0, 20).map((item) => `
          <div class="overdue-row">
            <span class="overdue-name">${escapeHtml(item.customer_name || item.name || "—")}</span>
            <span class="overdue-balance">${formatMoney(customerBalance(item))}</span>
            <span class="overdue-days ${item.daysSince === null ? "overdue-unknown" : item.daysSince >= 7 ? "overdue-critical" : "overdue-warn"}">
              ${item.daysSince === null ? "تاريخ دفع غير معروف" : `${item.daysSince} يوم`}
            </span>
          </div>`).join("")}
      </div>
    </details>
  ` : "";

  return `
    ${overdueHtml}
    <section class="panel wide customer-balances">
      <div class="panel-title-row inventory-browser-head">
        <div>
          <h3>أرصدة الزبائن والحد المسموح</h3>
          <p class="muted">الرصيد من الأمين. الحد المسموح يعتمد على الحد الداخلي عند حفظه هنا، وإلا يبقى حد الأمين إن وجد.</p>
        </div>
        <span class="status-chip" data-customer-count>يعرض ${escapeHtml(filtered.length)} من ${escapeHtml(items.length)}</span>
      </div>
      ${
        state.customerLimitError
          ? `<div class="inline-warning">تعذر تحميل أو حفظ الحدود الداخلية. شغل ملف <code>supabase/customer-credit-limits.sql</code> في Supabase SQL Editor ثم حدث الصفحة. الخطأ: ${escapeHtml(state.customerLimitError)}</div>`
          : ""
      }
      <div class="inventory-controls">
        <label>
          بحث باسم الزبون
          <input data-customer-search value="${escapeHtml(state.customerSearch)}" placeholder="اكتب اسم الزبون">
        </label>
        <label>
          الترتيب
          <select data-customer-sort>
            <option value="balanceDesc" ${state.customerSort === "balanceDesc" ? "selected" : ""}>أعلى رصيد أولاً</option>
            <option value="remainingAsc" ${state.customerSort === "remainingAsc" ? "selected" : ""}>الأقرب للحد أولاً</option>
            <option value="nameAsc" ${state.customerSort === "nameAsc" ? "selected" : ""}>الاسم أبجدياً</option>
          </select>
        </label>
      </div>
      <div class="filter-pills">
        ${customerFilters
          .map(
            (filter) => `
              <button class="filter-pill ${state.customerFilter === filter.id ? "active" : ""}" type="button" data-customer-filter="${escapeHtml(filter.id)}">
                <span>${escapeHtml(filter.label)}</span>
                <strong>${escapeHtml(counts[filter.id] || 0)}</strong>
              </button>
            `
          )
          .join("")}
      </div>
      <div class="button-row report-actions">
        <button class="button secondary" type="button" data-action="download-customer-balances" ${filtered.length ? "" : "disabled"}>تصدير أرصدة الزبائن</button>
        <button class="button primary" type="button" data-action="report-receivables" ${items.length ? "" : "disabled"}>📊 تقرير الذمم PDF</button>
      </div>
      ${whatsappBroadcastPanel()}
      ${customerDetailsPanel(detailItem)}
      <div class="inventory-list inventory-list-dense customer-results" data-customer-results>
        ${filtered.length ? groupedAccordion("balances", filtered, { groupOf: (i) => customerBalance(i) > 0 ? "زبائن مدينون" : (customerBalance(i) < 0 ? "زبائن دائنون (لهم)" : "متوازنون"), rowOf: customerBalanceRow, query: state.customerSearch }) : '<p class="muted">لا توجد زبائن تطابق البحث والفلتر الحالي.</p>'}
      </div>
      
    </section>
  `;
}

function ameen() {
  const latest = latestStockReport();
  const summary = latest?.summary || {};
  const items = reportItems(latest);
  const approvedPrices = state.approvedPriceItems || [];
  const syncedAt = reportSyncedAt(latest);
  const negativeItems = items.filter((item) => Number(item.stockQty || 0) < 0);
  const zeroItems = items.filter((item) => Number(item.stockQty || 0) === 0);
  const syncState = ameenSyncState(syncedAt);
  const liveReport = latest?.source === "ameen_sql_agent" || summary.source === "ameen_sql_agent";
  const authHint =
    dataStore.isConfigured() && !state.session
      ? '<p class="muted">سجل الدخول حتى يتم حفظ التقرير في Supabase ويظهر على الآيفون عند فتح الموقع.</p>'
      : "";

  return shell(`
    ${
      latest
        ? `${ameenBrowser(items)}
          <section class="panel wide ameen-movement">
            <h3>حركة المواد والمقارنة</h3>
            <div class="inventory-metrics">
              ${inventoryMetric("تحركت", summary.activeMovement || 0, "انخفضت كميتها عن التقرير السابق")}
              ${inventoryMetric("بلا حركة", summary.staleMovement || 0, "نفس الكمية في تقريرين")}
              ${inventoryMetric("تم تزويدها", summary.restocked || 0, "زادت كميتها عن التقرير السابق")}
              ${inventoryMetric("المقارنة السابقة", summary.previousReportDate || "لا يوجد", "تحتاج تقريرين أو أكثر")}
            </div>
          </section>`
        : `<section class="panel wide"><h3>مخزون الأمين</h3><p class="muted">لم يصل تقرير المخزون بعد. شغّل مزامنة الأمين ثم حدّث الصفحة.</p></section>`
    }
  `);
}

function customerBalancesPage() {
  return shell(customerBalanceSection(state.customerBalanceReports[0]));
}

function remote() {
  return shell(`
    <section class="panel wide">
      <div class="section-head">
        <div>
          <p class="eyebrow">الإدارة عن بعد</p>
          <h2>خدمة الإدارة عن بعد</h2>
        </div>
      </div>
      <div class="service-grid">
        ${remoteServices.map((service) => `<article><strong>${escapeHtml(service)}</strong><p>جاهزة كواجهة تشغيل، وتقرأ من قاعدة البيانات بعد ربط Supabase.</p></article>`).join("")}
      </div>
    </section>
  `);
}

function dailyMovementSection() {
  const date = state.dailyMovementDate || todayIsoDate();
  const head = `
    <div class="dm-controls">
      <label class="report-field">التاريخ
        <input type="date" data-daily-date value="${escapeHtml(date)}" max="${escapeHtml(todayIsoDate())}">
      </label>
      <button class="button secondary" type="button" data-action="daily-refresh">🔄 تحديث</button>
    </div>`;
  if (state.dailyMovementLoading) return head + `<p class="muted">جاري تحميل تقرير اليوم…</p>`;
  if (state.dailyMovementError) return head + `<div class="report-status">تعذّر التحميل: ${escapeHtml(state.dailyMovementError)}</div>`;

  const rep = state.dailyMovement;
  if (!rep || !rep.payload) {
    return head + `<div class="report-status">لا يوجد تقرير لهذا اليوم بعد. يُنشأ تلقائياً من «الأمين»، أو شغّل الوكيل على لابتوب الأمين.</div>`;
}

  const p = rep.payload;
  const sales = Array.isArray(p.sales) ? p.sales : [];
  const UNITS = ["كرتونة", "طرد", "شرحة"];
  const fmt = (n) => (Math.round(Number(n || 0) * 100) / 100).toLocaleString("en-US");
  const net = (unit) => sales.reduce((a, r) => a + (r.unit === unit ? (Number(r.billClass) === 3 ? -1 : 1) * Number(r.units || 0) : 0), 0);
  const cards = UNITS.map((u) => `<div class="dm-card"><div class="dm-v">${escapeHtml(fmt(net(u)))}</div><div class="dm-l">${u}</div></div>`).join("");

  const types = [...new Set(sales.map((r) => r.billType))];
  const breakdown = types.length
    ? types.map((t) => {
        const cells = UNITS.map((u) => {
          const v = sales.filter((r) => r.billType === t && r.unit === u).reduce((a, r) => a + Number(r.units || 0), 0);
          return `<td>${v ? escapeHtml(fmt(v)) : "—"}</td>`;
    }).join("");
        return `<tr><td>${escapeHtml(t)}</td>${cells}</tr>`;
      }).join("")
    : `<tr><td colspan="4" class="muted">لا مبيعات في هذا اليوم</td></tr>`;

  const pays = Array.isArray(p.usdPayments) ? p.usdPayments : [];
  const cash = p.usdCash || { total: 0, bills: 0 };
  const payRows = pays.map((x) => `<tr><td>${escapeHtml(x.customer || "")}</td><td class="dm-cred">$${escapeHtml(fmt(x.paid))}</td></tr>`).join("");
  const cashRow = (Number(cash.total) || Number(cash.bills))
    ? `<tr><td>زبون الكاش (بدون اسم) — ${escapeHtml(cash.bills || 0)} فاتورة</td><td class="dm-cred">$${escapeHtml(fmt(cash.total))}</td></tr>`
    : "";
  const boxTotal = pays.reduce((a, x) => a + Number(x.paid || 0), 0) + Number(cash.total || 0);
  const emptyBox = (!payRows && !cashRow) ? '<tr><td colspan="2" class="muted">لا دفعات دولار في هذا اليوم</td></tr>' : "";

  return head + `
    <div class="dm-cards">${cards}</div>
    <div class="dm-sec">تفصيل المبيعات حسب نوع الفاتورة</div>
    <table class="dm-table"><thead><tr><th>نوع الفاتورة</th><th>كرتونة</th><th>طرد</th><th>شرحة</th></tr></thead><tbody>${breakdown}</tbody></table>
    <div class="dm-sec">حركة صندوق الدولار 💵 — الدفعات الواردة</div>
    <table class="dm-table"><thead><tr><th>الزبون</th><th>المبلغ</th></tr></thead><tbody>${payRows}${cashRow}${emptyBox}<tr class="dm-total"><td>الإجمالي</td><td class="dm-cred">$${escapeHtml(fmt(boxTotal))}</td></tr></tbody></table>
    <p class="muted" style="font-size:.74rem;margin-top:8px">آخر تحديث: ${escapeHtml(String(p.generatedAt || rep.created_at || "").slice(0, 16))} — الكميات = الكمية ÷ معامل الوحدة (مبيعات ناقص مرتجعات).</p>
  `;
  }

function reportsPage() {
  if (!state.session) {
    return shell(`<section class="panel"><p class="muted">سجّل الدخول للوصول إلى التقارير.</p></section>`);
  }
  const balItems = latestCustomerBalanceItems();
  const customerOptions = balItems
    .slice()
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "ar"))
    .map((it) => `<option value="${escapeHtml(it.name || "")}"></option>`)
    .join("");
  const selectedCustomerName = (() => {
    const m = balItems.find((it) => customerKey(it) === state.selectedCustomerKey);
    return m ? (m.name || "") : "";
  })();

  const selInvoices = selectedCustomerName ? customerInvoicesFor(selectedCustomerName) : [];
  const invoicesMarkup = !selectedCustomerName
    ? '<p class="muted" style="margin-top:10px">اختر زبوناً (أو اكتب اسمه) لعرض فواتيره ومحتوياتها.</p>'
    : !selInvoices.length
      ? `<p class="muted" style="margin-top:10px">لا توجد فواتير لهذا الزبون${state.customerInvoicesReport ? " خلال آخر فترة مزامنة" : " — لم تصل مزامنة الفواتير بعد"}.</p>`
      : `<div style="margin-top:12px">
          <div class="sec">📋 فواتير «${escapeHtml(selectedCustomerName)}» (${selInvoices.length}) — اضغط فاتورة لرؤية محتوياتها</div>
          ${selInvoices.map((inv) => `
            <details class="acc-group" style="margin:6px 0">
              <summary class="acc-summary"><span class="acc-title">${inv.isReturn ? "🔁 مرتجع" : "🧾 فاتورة"} ${escapeHtml(inv.number || "")} — ${escapeHtml(inv.date || "")}</span><span class="acc-count" style="${inv.isReturn ? "color:#16794f" : ""}">${escapeHtml(formatMoney(inv.total || 0))} $</span></summary>
              <div class="acc-body">
                <table class="dm-table" style="width:100%">
                  <thead><tr><th>المادة</th><th>الكمية</th><th>سعر الوحدة</th></tr></thead>
                  <tbody>
                    ${(inv.lines || []).map((l) => `<tr><td>${escapeHtml(l.material || "")}</td><td>${escapeHtml(invoiceLineQty(l))}</td><td>${escapeHtml(invoiceLinePrice(l, inv))}</td></tr>`).join("")}
                  </tbody>
                </table>
                <p class="muted" style="margin:6px 2px 0">${inv.isReturn ? "إجمالي المرتجع" : "إجمالي الفاتورة"}: <b>${escapeHtml(formatMoney(inv.total || 0))} $</b></p>
                <button class="button secondary mini-button" type="button" data-action="gen-invoice-doc" data-inv-number="${escapeHtml(String(inv.number || ""))}" data-inv-date="${escapeHtml(String(inv.date || ""))}" data-customer="${escapeHtml(selectedCustomerName)}" style="margin-top:8px">📄 ${inv.isReturn ? "تصدير فاتورة المرتجع PDF" : "تصدير الفاتورة PDF (مع الأصناف)"}</button>
              </div>
            </details>`).join("")}
        </div>`;

  return shell(`
    <section class="panel wide reports-page">
      <p class="muted" style="margin:0 0 16px">كل التقارير في مكان واحد. اضغط على عنوان أي تقرير ليفتح للأسفل.</p>

      <details class="acc-group" open>
        <summary class="acc-summary"><span class="acc-title">📊 ملخص الحركة اليومية</span><span class="acc-count">جديد</span></summary>
        <div class="acc-body report-card">
          <p class="muted">مبيعات اليوم بالكميات (كم كرتونة / طرد / شرحة) + حركة صندوق الدولار: الدفعات الواردة بأسماء الزبائن، والكاش (فواتير بدون اسم) باسم «زبون الكاش».</p>
          ${dailyMovementSection()}
    </div>
      </details>

      <details class="acc-group">
        <summary class="acc-summary"><span class="acc-title">📊 تقرير الذمم (أرصدة الزبائن)</span><span class="acc-count">PDF</span></summary>
        <div class="acc-body report-card">
          <p class="muted">إجمالي المبالغ المستحقة على الزبائن مع أعلى ٤٠ زبوناً مديناً.</p>
          <button class="button primary" type="button" data-action="report-receivables"${balItems.length ? "" : " disabled"}>📊 تنزيل تقرير الذمم PDF</button>
        </div>
      </details>

      <details class="acc-group"${selectedCustomerName ? " open" : ""}>
        <summary class="acc-summary"><span class="acc-title">📄 كشف حساب زبون</span><span class="acc-count">PDF</span></summary>
        <div class="acc-body report-card">
          <p class="muted">كشف حساب رسمي لزبون محدّد: الرصيد الافتتاحي، كل الحركات، والرصيد الختامي.</p>
          <label class="report-field">الزبون
            <input type="text" list="report-customer-list" data-report-customer placeholder="اكتب اسم الزبون أو اختَر من القائمة…" value="${escapeHtml(selectedCustomerName)}" autocomplete="off" dir="auto">
            <datalist id="report-customer-list">${customerOptions}</datalist>
          </label>
          <button class="button primary" type="button" data-action="report-statement"${balItems.length ? "" : " disabled"}>📄 تنزيل كشف الحساب PDF</button>
          ${invoicesMarkup}
    </div>
      </details>

      <details class="acc-group">
        <summary class="acc-summary"><span class="acc-title">📦 تقرير المخزون</span><span class="acc-count">PDF</span></summary>
        <div class="acc-body report-card">
          <p class="muted">تقرير فاتح مرتب مثل النشرة: الغلواز والماستر أولاً، وكل صنف بكمّيته الفعلية من دون دمج. حالة النفاد تُحسب من المخزون وحركة المبيع الحديثة.</p>
          <button class="button primary" type="button" data-action="report-inventory">📦 تنزيل تقرير المخزون PDF</button>
        </div>
      </details>

      <details class="acc-group">
        <summary class="acc-summary"><span class="acc-title">🐢 المواد الراكدة</span><span class="acc-count">PDF</span></summary>
        <div class="acc-body report-card">
          <p class="muted">المواد المكدّسة التي تبيع ببطء: يقارن مخزونك بمعدّل بيعك ويحسب كم شهراً يكفي المخزون — من الأكثر ركوداً للأقل.</p>
          <button class="button primary" type="button" data-action="report-stagnant">🐢 تنزيل تقرير المواد الراكدة PDF</button>
        </div>
      </details>

      <details class="acc-group">
        <summary class="acc-summary"><span class="acc-title">📥 التقرير الشهري للطلبات</span><span class="acc-count">إكسل</span></summary>
        <div class="acc-body report-card">
          <p class="muted">ملف إكسل بكل طلبات الشهر الحالي وملخّص بحالاتها.</p>
          <button class="button secondary" type="button" data-action="export-monthly">📥 تنزيل التقرير الشهري (إكسل)</button>
        </div>
      </details>
    </section>
  `);
}

function exportMonthlyReport() {
  if (!window.XLSX) { setNotice("error", "مكتبة إكسل غير محمّلة."); render(); return; }
  const now = new Date();
  const mo = now.getMonth();
  const yr = now.getFullYear();
  const monthly = state.requests.filter((r) => {
    try { const d = new Date(r.createdAt); return d.getMonth() === mo && d.getFullYear() === yr; }
    catch { return false; }
  });
  if (!monthly.length) { setNotice("error", "لا يوجد طلبات لهذا الشهر."); render(); return; }

  const wb = window.XLSX.utils.book_new();
  const reqWs = window.XLSX.utils.aoa_to_sheet([
    ["رقم الطلب", "العميل", "القناة", "النوع", "الحالة", "الملاحظة", "التاريخ"],
    ...monthly.map((r) => [r.publicId || r.id, r.customer, r.channel, r.type, r.status, r.note, r.createdAt || ""])
  ]);
  window.XLSX.utils.book_append_sheet(wb, reqWs, "الطلبات");

  const stageCounts = REQUEST_STAGES.map((s) => [s, monthly.filter((r) => (r.status || "جديد") === s).length]);
  const sumWs = window.XLSX.utils.aoa_to_sheet([
    ["الحالة", "العدد"], ...stageCounts, ["الإجمالي", monthly.length]
  ]);
  window.XLSX.utils.book_append_sheet(wb, sumWs, "ملخص");

  window.XLSX.writeFile(wb, `tobacco-${yr}-${String(mo + 1).padStart(2, "0")}.xlsx`);
  setNotice("success", "تم تصدير التقرير الشهري.");
  render();
}

function staffPage() {
  if (!state.session) {
    return shell(`<section class="panel"><p class="muted">سجّل الدخول للوصول لهذه الصفحة.</p></section>`);
  }
  const ownerSession = isOwner();
  const roles = [
    { name: "الإدارة", desc: "صلاحيات كاملة لجميع الصفحات", pages: ["الطلبات", "الأمين", "التسعير", "التقارير", "الفواتير", "المراقبة", "الدفع"] },
    { name: "خدمة العملاء", desc: "إدارة الطلبات والتواصل مع العملاء", pages: ["الطلبات", "المراقبة"] },
    { name: "المراقبة", desc: "عرض التقارير فقط", pages: ["التقارير", "المراقبة", "الأمين"] },
    { name: "الدعم الفني", desc: "إدارة المخزون والتسعير", pages: ["الأمين", "التسعير", "الطلبات"] }
  ];
  const rolesHtml = roles.map((r) => `
    <article class="staff-role-card ${state.session.role === r.name ? "active" : ""}">
      <div class="staff-role-head">
        <strong>${escapeHtml(r.name)}</strong>
        ${state.session.role === r.name ? '<span class="staff-badge">دورك الحالي</span>' : ""}
      </div>
      <p class="muted" style="font-size:.85rem;margin:4px 0 8px">${escapeHtml(r.desc)}</p>
      <div class="staff-chips">${r.pages.map((p) => `<span class="staff-chip">${p}</span>`).join("")}</div>
    </article>`).join("");

  return shell(`
    <section class="panel">
      <h3>الموظف الحالي</h3>
      <div class="staff-current">
        <div class="staff-avatar">${escapeHtml((state.session.name || "؟")[0].toUpperCase())}</div>
        <div>
          <strong>${escapeHtml(state.session.name)}</strong>
          <p class="muted" style="font-size:.88rem">${escapeHtml(state.session.role)}</p>
          ${state.session.email ? `<p class="muted" style="font-size:.82rem">${escapeHtml(state.session.email)}</p>` : ""}
        </div>
      </div>
    </section>
    <section class="panel" style="margin-top:16px">
      <h3>الأدوار الوظيفية</h3>
      <div class="staff-roles-grid">${rolesHtml}</div>
    </section>
    ${ownerSession ? `
    <section class="panel" style="margin-top:16px">
      <h3>إضافة موظف جديد</h3>
      <p class="muted" style="margin-bottom:12px">أضف حسابات الموظفين من منصة Supabase ثم شارك بيانات الدخول معهم.</p>
      <ol class="staff-steps">
        <li>افتح لوحة Supabase: <strong><span dir="ltr">Authentication → Users</span></strong></li>
        <li>اضغط <strong><span dir="ltr">Add User</span></strong> ثم أدخل البريد وكلمة المرور</li>
        <li>شارك بيانات الدخول مع الموظف بشكل آمن</li>
        <li>الموظف يختار دوره عند تسجيل الدخول</li>
      </ol>
    </section>` : ""}
  `);
}

function searchPage() {
  const q = state.globalSearch.trim().toLowerCase();
  if (!q) return shell(`<section class="panel"><p class="muted">اكتب كلمة بحث في شريط الأعلى.</p></section>`);

  const results = [];
  state.requests.forEach((r) => {
    if ((r.customer || "").toLowerCase().includes(q) || (r.note || "").toLowerCase().includes(q)) {
      results.push({ type: "طلب", label: `${r.publicId || r.id} — ${r.customer}`, sub: (r.note || "").slice(0, 50), route: "requests" });
    }
  });
  const invItems = reportItems(latestStockReport());
  invItems.forEach((i) => {
    if ((i.name || "").toLowerCase().includes(q)) {
      results.push({ type: "مخزون", label: i.name, sub: `الكمية: ${i.qty ?? "—"}`, route: "ameen" });
    }
  });
  const balItems = Array.isArray(state.customerBalanceReports?.[0]?.items) ? state.customerBalanceReports[0].items : [];
  balItems.forEach((c) => {
    const name = c.customer_name || c.name || "";
    if (name.toLowerCase().includes(q)) {
      results.push({ type: "عميل", label: name, sub: `الرصيد: ${c.balance ?? "—"}`, route: "balances" });
    }
  });
  (state.purchaseInvoices || []).forEach((p) => {
    const supplierMatch = (p.supplierName || "").toLowerCase().includes(q);
    const itemMatch = (p.items || []).some((item) => (item.name || "").toLowerCase().includes(q));
    if (supplierMatch || itemMatch) {
      results.push({ type: "مشتريات", label: `${p.publicId} — ${p.supplierName}`, sub: `${(p.items || []).length} صنف · ${p.orderDate}`, route: "purchases" });
    }
  });

  const rows = results.slice(0, 20).map((r) => `
    <button class="search-result-row" data-route="${escapeHtml(r.route)}" data-search-nav>
      <span class="search-result-type">${escapeHtml(r.type)}</span>
      <span class="search-result-label">${escapeHtml(r.label)}</span>
      <small class="muted">${escapeHtml(r.sub)}</small>
    </button>`).join("");

  return shell(`
    <section class="panel">
      <p class="muted" style="margin-bottom:16px">${results.length} نتيجة لـ "<strong>${escapeHtml(state.globalSearch)}</strong>"</p>
      ${rows || '<p class="muted">لا توجد نتائج.</p>'}
    </section>
  `);
}

function monitoring() {
  const openRequests = state.requests.filter((request) => request.status !== "مغلق").length;
  const closedRequests = state.requests.length - openRequests;
  const cards = [
    { label: "طلبات مفتوحة", value: String(openRequests), trend: "من سجل الطلبات" },
    { label: "طلبات مغلقة", value: String(closedRequests), trend: "تمت متابعتها" },
    ...monitoringCards.slice(1)
  ];

  return shell(`
    <section class="panel wide">
      <div class="section-head">
        <div>
          <p class="eyebrow">المراقبة التشغيلية</p>
          <h2>مراقبة خدمة العملاء</h2>
        </div>
      </div>
      <div class="status-board full">
        ${cards.map(statusCard).join("")}
      </div>
      <div class="audit-note">
        <strong>ملاحظة تشغيلية:</strong>
        <span>${dataStore.isConfigured() ? "هذه المؤشرات تقرأ من جدول الطلبات في Supabase." : "هذه المؤشرات تجريبية وتعتمد على الحفظ المحلي في هذا المتصفح."}</span>
      </div>
    </section>
  `);
}

function payments() {
  return shell(`
    <section class="panel wide form-layout">
      <div>
        <p class="eyebrow">المدفوعات</p>
        <h2>الدفع الإلكتروني</h2>
        <p class="muted">واجهة الدفع جاهزة كتصميم، لكن التفعيل الحقيقي يحتاج حساب مزود دفع ومراجعة شروطه لنشاط الشركة وبلد التشغيل.</p>
      </div>
      <div class="payment-box">
        <strong>${escapeHtml(appConfig.paymentStatus)}</strong>
        <p>المرحلة التالية: اختيار مزود دفع مناسب، ثم وضع مفاتيح الاختبار في بيئة آمنة، وليس داخل الواجهة.</p>
        <button class="button primary" type="button" disabled>الدفع غير مفعل بعد</button>
      </div>

      <div class="payment-record-section" style="margin-top:18px">
        <h4>📄 سند صرف / دفع</h4>
        <p class="muted" style="font-size:.85rem;margin:0 0 8px">أنشئ سند صرف رسمي (PDF) بالتصميم المعتمد للمبالغ المدفوعة: مورّد، مصروف، سلفة… إلخ.</p>
        <form class="payment-record-form" data-form="voucher-payment">
          <div class="payment-form-row">
            <label>المستفيد / الجهة<input name="name" maxlength="120" placeholder="اسم المورّد أو الجهة" required></label>
            <label>المبلغ<input name="amount" type="text" inputmode="decimal" dir="ltr" placeholder="0" required></label>
          </div>
          <div class="payment-form-row">
            <label>العملة<input name="cur" value="ل.س" maxlength="10"></label>
            <label>التاريخ<input name="date" type="date" value="${new Date().toISOString().slice(0, 10)}" required></label>
          </div>
          <label>طريقة الدفع<input name="method" maxlength="60" placeholder="نقداً / حوالة / شيك…"></label>
          <label>البيان / ملاحظة<input name="notes" maxlength="300" placeholder="سبب الصرف أو بيان الدفعة"></label>
          <button class="button primary mini-button" type="submit">📄 توليد سند صرف PDF</button>
        </form>
      </div>
    </section>
  `);
}

function renderMarkdown(text) {
  const safe = escapeHtml(String(text ?? ""));
  return safe
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/^#{1,3} (.+)$/gm, (_, t) => `<strong style="display:block;margin:8px 0 4px">${t}</strong>`)
    .replace(/^[-•] (.+)$/gm, (_, t) => `<span style="display:block;padding-right:8px">• ${t}</span>`)
    .replace(/\n\n+/g, "<br><br>")
    .replace(/\n/g, "<br>");
}

async function sendAiMessage(input) {
  const message = input.trim();
  if (!message || state.aiLoading) return;

  state.aiMessages.push({ role: "user", content: message });
  state.aiLoading = true;
  render();

  const scrollBottom = () => {
    const el = document.getElementById("ai-messages");
    if (el) el.scrollTop = el.scrollHeight;
  };
  setTimeout(scrollBottom, 30);

  try {
    const messages = state.aiMessages
      .filter((item) => item.role === "user" || item.role === "assistant")
      .map((item) => ({ role: item.role, content: item.content }));
    const result = await dataStore.askFinancialAssistant(messages, state.aiProvider);
    state.aiMessages.push({ role: "assistant", content: result.reply || "لم تصل إجابة من الخادم." });
  } catch (err) {
    state.aiMessages.push({ role: "assistant", content: `⚠️ خطأ: ${err.message}` });
  } finally {
    state.aiLoading = false;
    render();
    setTimeout(scrollBottom, 50);
  }
}

function aiAssistant() {
  if (!state.session) {
    return shell(`
      <section class="panel">
        <h2>غير مصرح</h2>
        <p class="muted">المساعد الذكي متاح للموظفين بعد تسجيل الدخول. سجّل الدخول للوصول.</p>
      </section>
    `);
  }

  const msgs = state.aiMessages;

  const messagesHtml = msgs.length === 0
    ? `<div class="ai-welcome">
         <p class="ai-welcome-title">مرحباً في المساعد الذكي</p>
         <p class="muted">اسأل عن أرصدة حسابات الأمين، الصناديق، الذمم، المبيعات، الأرباح أو المصروفات. البيانات للقراءة والتحليل فقط.</p>
       </div>`
    : msgs.map((m) => `
        <div class="ai-message ${m.role === "user" ? "ai-user" : "ai-bot"}">
          <div class="ai-bubble">${m.role === "assistant" ? renderMarkdown(m.content) : escapeHtml(m.content)}</div>
        </div>`).join("") +
      (state.aiLoading
        ? `<div class="ai-message ai-bot"><div class="ai-bubble ai-thinking"><span></span><span></span><span></span></div></div>`
        : "");

  return shell(`
    <section class="panel wide ai-panel">
      <div class="ai-toolbar">
        <div class="ai-provider-tabs"><span class="ai-tab active">المساعد المالي الآمن</span></div>
        <div class="ai-toolbar-end">
          ${msgs.length > 0 ? `<button class="button secondary" style="font-size:0.8rem;padding:4px 12px" data-action="ai-clear">مسح</button>` : ""}
          <span class="status-pill success">قراءة فقط من الأمين</span>
        </div>
      </div>

      <div class="notice-panel success" style="margin-bottom:12px">
        <strong>متصل بتقارير برنامج الأمين</strong>
        <span>البيانات تبقى داخل Supabase ولا تُرسل لأي جهة خارجية، ولا يستطيع المساعد تعديل أي حساب أو قيد.</span>
      </div>

      <div class="ai-messages" id="ai-messages">${messagesHtml}</div>

      <form class="ai-input-row" data-form="ai-chat">
        <textarea
          class="ai-textarea"
          name="message"
          placeholder="مثال: ما أرصدة الصناديق اليوم؟"
          rows="2"
          dir="auto"
          ${state.aiLoading ? "disabled" : ""}
        ></textarea>
        <button class="button primary ai-send" type="submit" ${state.aiLoading ? "disabled" : ""}>إرسال</button>
      </form>
    </section>
  `);
}

// ============================================================================
// ===== فاتورة مبيعات (route: sales) — نواة MVP =====
// تنشئ فاتورة جملة (دولار) أو مفرق
// (ليرة سورية)، تُحفظ عبر dataStore.createSharedDocument كمستند sales_invoice،
// وتُطبع بإعادة استخدام قالب طباعة الفاتورة.
// TODO (خارج النواة الحالية عمداً): خصم المخزون، تقييد الذمم، صلاحيات المدير/
// المحاسب، المرتجعات، آخر سعر للزبون، رصيد الزبون الحيّ، معلومات المستودعات،
// ومزامنة رقم الفاتورة التسلسلي مع الأمين.
// ============================================================================

// ── تفاصيل الصنف (تكلفة + مستودعات) — متطلبا 9 و16 ────────────────────────────
// المصدر: تقرير ameen_item_details الذي يرفعه tools/push-item-details.ps1.
// التكلفة في الأمين (mt000.AvgPrice) هي متوسط تكلفة **الوحدة الأولى (كروز)**
// بالدولار؛ تكلفة الكرتونة = التكلفة × معامل الوحدة الثانية.
// تحقق 2026-07-25: ماستر طويل ورق 7.044 × 50 = 352$ مقابل بيع 354$.
async function loadItemDetails() {
  if (state.itemDetails || !dataStore.getLatestItemDetailsReport) return;
  try {
    const report = await dataStore.getLatestItemDetailsReport();
    if (!report || !Array.isArray(report.items)) return;
    // التطبيع على الطرفين إلزامي: item_key في Supabase غير متسق أحياناً
    // (همزات/تاء مربوطة)، فالمطابقة الخام تُسقط ~85 صنفاً من 316.
    const map = {};
    for (const entry of report.items) {
      if (!entry) continue;
      const k = normalizeItemName(entry.name || entry.key || "");
      if (k && !map[k]) map[k] = entry;
    }
    state.itemDetails = map;
    state.itemDetailsAt = report.created_at || "";
  } catch (_) {
    // ميزة عرض فقط — تجاهل الفشل بصمت ولا تعطّل الفاتورة
  }
}

function salesDetailsFor(item) {
  if (!item || !state.itemDetails) return null;
  // نطابق بالاسم المطبّع أولاً (الأوثق)، ثم بالمفتاح المطبّع، ثم بالمفتاح الخام.
  return (
    state.itemDetails[normalizeItemName(item.itemName || "")] ||
    state.itemDetails[normalizeItemName(item.itemKey || "")] ||
    state.itemDetails[item.itemKey] ||
    null
  );
}

// التكلفة تُقرأ حصراً من item_costs المحمي بـRLS (is_owner) عبر itemCostFor —
// لا من تقرير المستودعات، لأن inventory_reports يقرأه كل موظف مسجّل بينما
// التكلفة والربح للمدير فقط (متطلبا 17 و20). غير المدير يرجع له null دائماً،
// والحماية على مستوى قاعدة البيانات لا مجرد إخفاء بالواجهة.
function salesUnitCost(item) {
  const row = itemCostFor({ name: item?.itemName, key: item?.itemKey });
  const value = Number(row?.avg_cost || 0);
  return value > 0 ? { value, basis: "متوسط" } : { value: 0, basis: "" };
}

function salesEmptyRow() {
  return { q: "", key: "", name: "", num: "", unit: "unit2", qty: "1", price: "", edited: false };
}

function salesToEnglishDigits(value) {
  return String(value ?? "")
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)));
}

function salesCurrentMode() {
  return state.salesMode === "mufrak" ? "mufrak" : "jumla";
}

function salesCurrencySymbol(mode) {
  return mode === "mufrak" ? "ل.س" : "$";
}

function salesItemByKey(key) {
  if (!key) return null;
  return (state.approvedPriceItems || []).find((item) => item.itemKey === key) || null;
}

function salesUnit2Factor(item) {
  const factor = Number(item?.unit2Factor || 1);
  return Number.isFinite(factor) && factor > 0 ? factor : 1;
}

function salesRetailPrice(item) {
  const retail = item?.pricePayload?.retail;
  return Number((retail && retail.price) || 0);
}

function salesUnitLabel(item, unit) {
  if (!item) return unit === "unit1" ? "كروز" : "كرتونة";
  if (unit === "unit1") return item.unit1Name || "كروز";
  return item.unit2Name || "كرتونة";
}

// حساب الإفرادي التلقائي حسب الوضع والوحدة (المرجع: تعليمات المهمة):
//   جملة  → كرتونة = unit2_price ، كروز = unit1_price (بالدولار)
//   مفرق  → كرتونة = round(retail × rate) ، كروز = round(retail ÷ factor × rate) (بالليرة)
function salesAutoUnitPrice(item, unit, mode) {
  if (!item) return 0;
  if (mode === "mufrak") {
    const retail = salesRetailPrice(item);
    const rate = Number(state.syriaExchangeRate) || 0;
    if (!(retail > 0) || !(rate > 0)) return 0;
    if (unit === "unit1") return Math.round((retail / salesUnit2Factor(item)) * rate);
    return Math.round(retail * rate);
  }
  if (unit === "unit1") return roundPrice(Number(item.unit1Price || 0));
  return roundPrice(Number(item.unit2Price || 0));
}

// تنسيق رقم للعرض: جملة بخانتين عشريتين، مفرق بأرقام صحيحة وفواصل آلاف — إنجليزية دائماً.
function salesFmt(value, mode) {
  const number = Number(value || 0);
  if (mode === "mufrak") {
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.round(number));
  }
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(number);
}

// رقم خام بلا فواصل آلاف (لحقول الإدخال كي لا يعبث بها مُطبِّع الأرقام).
function salesFmtPlain(value, mode) {
  const number = Number(value || 0);
  if (mode === "mufrak") return String(Math.round(number));
  return (Math.round((number + Number.EPSILON) * 100) / 100).toFixed(2);
}

function salesMoney(value, mode) {
  if (mode === "mufrak") return `${salesFmt(value, "mufrak")} ل.س`;
  return `$${salesFmt(value, "jumla")}`;
}

// الرقم المعروض للمستخدم هو كود الأمين (mt000.Code) لأنه ما يقرأه على بطاقة الصنف؛
// وitemNumber ترقيم الأمين الداخلي التسلسلي. نرجع إليه فقط إن لم يصل الكود بعد.
function salesItemCode(item) {
  return String(item?.itemCode || item?.itemNumber || "");
}

// بحث/مطابقة جزئية على كود الأمين والرقم الداخلي والاسم معاً — البحث بالرقمين مقصود
// كي لا يتعطّل من حفظ الترقيم الداخلي القديم بعد تحويل العرض إلى الكود.
function salesSearchItems(query, limit = 8) {
  const raw = String(query || "").trim();
  if (!raw) return [];
  const list = state.approvedPriceItems || [];
  if (!list.length) return [];
  const normalizedQuery = normalizeItemName(raw);
  const digits = normalizeNumericText(raw, { allowNegative: false, allowDecimal: false });
  const scored = [];
  for (const item of list) {
    // الكود أولاً في الترتيب كي تفوز مطابقته عند التعادل مع رقم داخلي لصنف آخر.
    const numbers = [String(item.itemCode || ""), String(item.itemNumber || "")].filter(Boolean);
    const normalizedName = normalizeItemName(item.itemName || "");
    let score = -1;
    if (digits) {
      for (const number of numbers) {
        if (number === digits) score = Math.max(score, 100);
        else if (number.startsWith(digits)) score = Math.max(score, 92);
        else if (number.includes(digits)) score = Math.max(score, 74);
      }
    }
    if (normalizedQuery) {
      if (normalizedName === normalizedQuery) score = Math.max(score, 96);
      else if (normalizedName.startsWith(normalizedQuery)) score = Math.max(score, 86);
      else if (normalizedName.includes(normalizedQuery)) score = Math.max(score, 62);
    }
    if (score >= 0) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score || String(a.item.itemName || "").localeCompare(String(b.item.itemName || ""), "ar"));
  return scored.slice(0, limit).map((entry) => entry.item);
}

function salesSuggestionsHtml(rowIndex, query) {
  const matches = salesSearchItems(query, 8);
  if (!matches.length) return "";
  const mode = salesCurrentMode();
  return matches
    .map((item) => {
      const code = salesItemCode(item);
      const number = code
        ? `<span class="sales-suggest-num" dir="ltr">${escapeHtml(code)}</span>`
        : `<span class="sales-suggest-num muted">—</span>`;
      const auto = salesAutoUnitPrice(item, "unit2", mode);
      const priceHint = auto > 0
        ? `<span class="sales-suggest-price" dir="ltr">${escapeHtml(salesMoney(auto, mode))}</span>`
        : `<span class="sales-suggest-price muted">بلا سعر</span>`;
      return `<button type="button" class="sales-suggest-item" data-sales-pick="${escapeHtml(item.itemKey)}" data-sales-row="${rowIndex}">${number}<span class="sales-suggest-name">${escapeHtml(item.itemName)}</span>${priceHint}</button>`;
    })
    .join("");
}

function salesRowComputed(row) {
  const item = row && row.key ? salesItemByKey(row.key) : null;
  const qty = toNumber(row?.qty);
  const price = toNumber(row?.price);
  return { item, qty, price, lineTotal: qty * price };
}

function salesTotals() {
  const grand = (state.salesRows || []).reduce(
    (sum, row) => sum + (row.key ? toNumber(row.qty) * toNumber(row.price) : 0),
    0
  );
  const discount = Math.max(0, toNumber(state.salesDiscount));
  const net = Math.max(0, grand - discount);
  const paid = state.salesPayMethod === "cash" ? net : Math.max(0, toNumber(state.salesPaid));
  const remaining = net - paid;
  return { grand, discount, net, paid, remaining };
}

// حالة المتبقّي بلغة المحاسبة: موجب = على الزبون، سالب = له عندنا، وصفر = مسدّد.
// العتبة تختلف بالعملة: الليرة أرقام صحيحة، والدولار خانتان عشريتان.
function salesRemainingState(remaining, mode) {
  const epsilon = mode === "mufrak" ? 0.5 : 0.005;
  if (Math.abs(remaining) < epsilon) return { status: "settled", label: "مسدّد" };
  if (remaining > 0) return { status: "due", label: "عليه" };
  return { status: "credit", label: "له" };
}

function salesResolvedRows() {
  return (state.salesRows || []).filter((row) => row.key && toNumber(row.qty) > 0 && toNumber(row.price) > 0);
}

// ترقيم الفواتير مأخوذ من سلاسل ترقيم الأمين نفسها، لا من عدّاد محلي مستقل:
// وضع الجملة يتابع سلسلة «مبيعات»، ووضع المفرق يتابع سلسلة «مبيعات مركز».
// المصدر تقرير ameen_invoice_series الذي يرفعه tools/push-invoice-series.ps1.
//
// لماذا ليس من ameen_customer_invoices: ذاك التقرير يشترط اسم زبون غير فارغ،
// ومعظم فواتير «مبيعات مركز» بلا اسم — فأكبر رقم فيه ليس آخر رقم فعلي. كما أنه
// لا يحمل نوع الفاتورة أصلاً، والأمين يستعمل سلسلة مستقلة لكل نوع (ست سلاسل:
// ثلاث للمبيعات وثلاث للمرتجعات)، فخلطها يعطي رقم أكبر سلسلة لكل الأوضاع.
//
// قاعدة أساسية باقية كما كانت: الرقم يُعرض بلا حجز، ولا يُحجز إلا بعد نجاح الحفظ.
// لذلك فتح الشاشة أو إعادة تحميلها أو فشل الحفظ لا يستهلك رقماً ولا يترك فجوة.

// سلسلة الأمين المقابلة لكل وضع. المعرّف هو المفتاح الثابت (لا يتغيّر بإعادة
// تسمية نوع الفاتورة في الأمين)، والاسم احتياط عند استبدال قاعدة السنة.
const SALES_AMEEN_SERIES = {
  jumla: { guid: "7f5b0921-61f3-4f23-a1f4-fbfae4144bf4", name: "مبيعات" },
  mufrak: { guid: "cc1097b1-662d-4d80-8e4e-3b493249591c", name: "مبيعات مركز" }
};

function salesSeriesTarget(mode) {
  return SALES_AMEEN_SERIES[mode === "mufrak" ? "mufrak" : "jumla"];
}

// سلسلة الترقيم الحيّة من تقرير الأمين — بالمعرّف أولاً ثم بالاسم بعد التطبيع.
function salesAmeenSeries(mode) {
  const target = salesSeriesTarget(mode);
  const items = Array.isArray(state.invoiceSeriesReport?.items) ? state.invoiceSeriesReport.items : [];
  const byGuid = items.find((s) => String(s?.typeGuid || "").toLowerCase() === target.guid);
  if (byGuid) return byGuid;
  const wanted = normalizeItemName(target.name);
  return items.find((s) => normalizeItemName(s?.typeName || "") === wanted) || null;
}

// العدّاد المحلي صار طبقة فوق رقم الأمين لا بديلاً عنه: يمنع تكرار الرقم بين
// فاتورتين أُصدرتا من الموقع قبل وصول المزامنة التالية. مفتاح مستقل لكل سلسلة.
function salesSeqState(mode) {
  const key = "sales-invoice-seq-" + (mode === "mufrak" ? "mufrak" : "jumla");
  const raw = Number(readJson(key, 0));
  return { key, seq: Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0 };
}

// الرقم المعروض: الأكبر بين «تالي الأمين» و«تالي العدّاد المحلي»، بلا أي حجز.
// يرجع نصاً فارغاً إذا لم تصل المزامنة — ولا يخمّن رقماً أبداً، لأن رقماً مخترَعاً
// قد يصطدم بفاتورة قائمة في الأمين. بلا أي تغيير — تبقى صارمة دائماً (راجع
// SALES_PRINT_GRACE_MAX_AGE_MS أدناه: التسامح لا يمنح رقماً تخمينياً إطلاقاً،
// بل مسودة بلا رقم — فهذه الدالة لا تحتاج معرفة حالة التسامح أصلاً).
function peekSalesInvoiceNumber(mode) {
  const st = salesSeriesState(mode);
  if (!st.usable) return "";
  const ameenNext = Math.floor(Number(st.series?.nextNo) || 0);
  if (!(ameenNext > 0)) return "";
  const local = salesSeqState(st.mode).seq;
  return String(Math.max(ameenNext, local + 1));
}

// الحجز الفعلي بعد نجاح الحفظ: يرفع العدّاد ليشمل هذه الفاتورة، ولا يُنقصه أبداً.
function salesReserveInvoiceNo(no, mode) {
  const seq = Number(String(no ?? "").trim());
  if (!Number.isFinite(seq) || seq <= 0) return;
  const current = salesSeqState(mode || salesCurrentMode());
  if (current.seq >= seq) return;
  writeJson(current.key, Math.floor(seq));
}

function ensureSalesInvoiceNo() {
  const mode = salesCurrentMode();
  // تبديل الوضع يبدّل السلسلة، فالرقم المخبّأ لوضعٍ آخر لا يصلح.
  if (!state.salesInvoiceNo || state.salesInvoiceNoMode !== mode) {
    state.salesInvoiceNo = peekSalesInvoiceNumber(mode);
    state.salesInvoiceNoMode = mode;
  }
  return state.salesInvoiceNo;
}

// عمر المزامنة المسموح به قبل منع إصدار رقم **للحفظ**. المهمة المجدولة تعمل
// كل 5 دقائق، فـ15 دقيقة تعني ثلاث دورات فائتة — أي أن المزامنة متوقفة فعلاً
// لا متأخرة. يبقى هذا الحد بلا أي تغيير — يحكم salesSaveInvoice حصراً.
const SALES_SERIES_MAX_AGE_MS = 15 * 60000;

// نافذة تسامح إضافية — للطباعة/تصدير PDF فقط، وليست للحفظ إطلاقاً، وليست
// تسامحاً في **الرقم** بل في **إمكانية طباعة مسودة بلا رقم إطلاقاً** (ملاحظة
// Codex P1 على PR #144: رقم "تقديري" مطبوع قد يتصادم فعلياً مع فاتورة أُدخلت
// مباشرة بالأمين أو من جهاز آخر خلال هذه النافذة — العدّاد المحلي لا يكتشف
// إصداراً خارجياً كهذا. الحل: صفر احتمال تصادم لأنه لا يُطبع أي رقم حقيقي
// إطلاقاً أثناء التدهور، فقط مسودة SALES_DRAFT_INVOICE_NO الواضحة). الطباعة
// معاينة بلا التزام: لا تحجز رقماً ولا تكتب شيئاً بقاعدة البيانات (الحجز
// الفعلي يحدث حصراً داخل salesSaveInvoice بعد نجاح الحفظ، عبر إعادة جلب
// طازجة وإعادة فحص صارمة لم تتغيّر). تجاوز هذه النافذة الأوسع أيضاً يعني على
// الأرجح انقطاعاً مستمراً
// حقيقياً (لا عطلاً عابراً كانقطاع Meshnet المؤقت الذي دفع هذا الإصلاح)،
// فتبقى الطباعة محجوبة أيضاً حينها.
const SALES_PRINT_GRACE_MAX_AGE_MS = 60 * 60000;

// إعادة جلب تقرير السلاسل عند الطلب. لا يرمي أبداً: فشل الشبكة يترك القراءة
// السابقة كما هي، ويتكفّل فحص العمر بعده بمنع الإصدار إن كانت قديمة.
async function refreshInvoiceSeries() {
  try {
    if (!dataStore.getInvoiceSeriesReport) return;
    const report = await dataStore.getInvoiceSeriesReport();
    if (report) state.invoiceSeriesReport = report;
  } catch {
    // تُترك القراءة السابقة — فحص العمر هو خط الدفاع.
  }
}

// حالة مصدر الترقيم: السلسلة، وعمر القراءة، وهل تصلح لإصدار رقم أصلاً.
// المنع لا التحذير فقط: رقم مبني على قراءة قديمة قد يكون مستهلكاً في الأمين،
// والفاتورة المطبوعة برقم مكرر خطأ محاسبي لا يُصلَح بعد تسليمها للزبون.
function salesSeriesState(mode) {
  const m = mode || salesCurrentMode();
  const target = salesSeriesTarget(m);
  const series = salesAmeenSeries(m);
  const stamp = state.invoiceSeriesReport?.summary?.syncedAt || state.invoiceSeriesReport?.created_at || "";
  const ageMs = stamp ? Date.now() - new Date(stamp).getTime() : NaN;
  const hasAge = Number.isFinite(ageMs) && ageMs >= 0;
  const stale = !hasAge || ageMs > SALES_SERIES_MAX_AGE_MS;
  return { mode: m, target, series, ageMs: hasAge ? ageMs : NaN, stale, usable: !!series && !stale };
}

// عنوان/رقم المستند المطبوع أثناء التدهور — مسودة واضحة بلا أي رقم حقيقي أو
// تخميني إطلاقاً (راجع تعليق SALES_PRINT_GRACE_MAX_AGE_MS للسبب).
const SALES_DRAFT_INVOICE_NO = "مسودة — بلا رقم نهائي";

// شارة تحذير مرئية تُدرَج داخل المستند المطبوع/المصدَّر نفسه أثناء التدهور —
// لا تكفي رسالة التأكيد وحدها (قد يُطوى المستند أو يُصوَّر لاحقاً بمعزل عن
// سياق الشاشة)، فالورقة نفسها يجب أن تُعلن بوضوح أنها مسودة غير رسمية.
function salesDraftBannerHtml(invNo) {
  if (invNo !== SALES_DRAFT_INVOICE_NO) return "";
  return `<div style="background:#fff3cd;border:2px solid #b8860b;color:#5c3d00;font-weight:700;
    text-align:center;padding:8px 12px;margin-bottom:16px;border-radius:6px">
    ⚠️ مسودة غير رسمية — بلا رقم فاتورة نهائي. الرقم الحقيقي يُحدَّد فقط عند الحفظ.
  </div>`;
}

// حالة الطباعة/تصدير PDF تحديداً — أوسع تسامحاً من الحفظ عمداً (راجع تعليق
// SALES_PRINT_GRACE_MAX_AGE_MS أعلاه). لا تُستخدم إطلاقاً من مسار الحفظ.
// degraded=true تعني: مسموح بطباعة مسودة (SALES_DRAFT_INVOICE_NO، بلا أي رقم
// حقيقي) بعد تأكيد صريح من الموظف — الرقم الفعلي يُحسم حصراً لحظة الحفظ.
function salesPrintSeriesState(mode) {
  const st = salesSeriesState(mode);
  if (st.usable) return { ...st, printUsable: true, degraded: false };
  const withinGrace = !!st.series && Number.isFinite(st.ageMs) && st.ageMs <= SALES_PRINT_GRACE_MAX_AGE_MS;
  return { ...st, printUsable: withinGrace, degraded: withinGrace };
}

function salesSeriesAgeText(ageMs) {
  if (!Number.isFinite(ageMs)) return "";
  const mins = Math.floor(ageMs / 60000);
  if (mins < 1) return "الآن";
  if (mins < 60) return `قبل ${mins} دقيقة`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `قبل ${hours} ساعة` : `قبل ${Math.floor(hours / 24)} يوم`;
}

// رسالة المنع الموحّدة — تُستعمل عند الحفظ (حد صارم 15 دقيقة) وعند تجاوز
// الطباعة نافذة التسامح الأوسع (60 دقيقة) أيضاً. صيغة مفهومة لموظف لا يعرف
// أسماء مهام Windows المجدولة — بلا أي تفاصيل تقنية داخلية.
function salesSeriesBlockReason(st) {
  if (!st.series) {
    return "تعذّر إصدار رقم فاتورة — لم تصل بيانات ترقيم الفواتير من نظام المحاسبة بعد. تواصل مع الإدارة.";
  }
  if (st.stale) {
    const age = salesSeriesAgeText(st.ageMs);
    return `تعذّر إصدار رقم فاتورة موثوق — انقطع الاتصال بجهاز المزامنة منذ ${age || "فترة"}. `
      + `تواصل مع الإدارة، أو انتظر عودة الاتصال ثم أعد المحاولة.`;
  }
  return "";
}

// رسالة تحذير الطباعة أثناء التدهور المؤقت — مختلفة عمداً عن رسالة المنع
// الكاملة: توضح أن المتابعة ممكنة بموافقة الموظف، لكن كـ"مسودة" بلا رقم
// حقيقي إطلاقاً (لا "رقم تقديري" — راجع تعليق SALES_PRINT_GRACE_MAX_AGE_MS).
function salesPrintGraceWarning(printSt) {
  const age = salesSeriesAgeText(printSt.ageMs);
  return `⚠️ انقطع الاتصال بجهاز مزامنة الترقيم منذ ${age || "فترة"}.\n`
    + `ستُطبع نسخة "مسودة" بلا رقم فاتورة نهائي — الرقم الحقيقي يُحسم حصراً عند الحفظ `
    + `(والحفظ يبقى محجوباً حتى تعود المزامنة).\n\n`
    + `هل تريد المتابعة بطباعة المسودة الآن؟`;
}

// سطر توضيحي تحت رقم الفاتورة: أي سلسلة، وآخر رقم بالأمين، وعمر المزامنة —
// كي يرى المستخدم بنفسه إن كان الرقم مبنياً على قراءة قديمة.
function salesInvoiceNoHint() {
  const st = salesSeriesState();
  if (st.usable) {
    const age = salesSeriesAgeText(st.ageMs);
    return `سلسلة «${st.series.typeName}» — آخر رقم بالأمين ${st.series.lastNo}${age ? ` (مزامنة ${age})` : ""}`;
  }
  const printSt = salesPrintSeriesState();
  if (printSt.degraded) {
    const age = salesSeriesAgeText(printSt.ageMs);
    return `⚠️ مزامنة متأخرة منذ ${age} — يمكن طباعة مسودة بلا رقم بتأكيد، والحفظ محجوب حتى تعود المزامنة.`;
  }
  return `⚠️ ${salesSeriesBlockReason(st)}`;
}

function salesEnsureTrailingRow() {
  const rows = state.salesRows;
  if (!rows.length || rows[rows.length - 1].key) rows.push(salesEmptyRow());
}

// آخر سعر بِيع به هذا الصنف لهذا الزبون (متطلب 22) — يعيد استعمال البنية الموجودة:
// customerInvoicesFor للمطابقة الذكية بالاسم، وinvoiceLineUnitPrice لحسم وحدة السعر.
//
// حسم الوحدة إلزامي قبل عرض أي رقم: أساس سعر السطر في الأمين قد يكون الكرتونة أو
// الكروز ويختلف من فاتورة لأخرى، ويُحسم بمطابقة مجموع الأسطر مع إجمالي الفاتورة.
// قِيس على بيانات الجهاز (228 فاتورة): النسبة بين الأساسين وسطها 49× وأدناها 5×،
// وصفر فاتورة يتقارب فيها المرشحان — فالحسم قطعي ولا يقلبه حسم أو خصم.
//
// المصدر تقرير ameen_customer_invoices ونافذته محدودة (60 يوماً افتراضاً)، فغياب
// الرقم يعني «لا بيع خلال النافذة» ولا يجوز إظهاره صفراً أو إخفاء السطر بصمت.
// المطابقة بالاسم فقط (أسطر التقرير بلا رقم صنف) فالتطبيع على الطرفين إلزامي.
function salesLastCustomerPrice(item) {
  const typed = String(state.salesCustomer || "").trim();
  if (!item || !typed) return { status: "no_customer" };
  if (!state.customerInvoicesReport) return { status: "no_report" };

  const target = normalizeItemName(item.itemName || "");
  if (!target) return { status: "none" };

  const invoices = customerInvoicesFor(typed).filter((inv) => inv && !inv.isReturn);
  if (!invoices.length) return { status: "no_customer_sales" };

  let best = null;
  for (const inv of invoices) {
    const lines = Array.isArray(inv.lines) ? inv.lines : [];
    for (const line of lines) {
      if (normalizeItemName(line?.material || "") !== target) continue;
      const resolved = invoiceLineUnitPrice(line, inv);
      if (!resolved || !(resolved.price > 0)) continue;
      const date = String(inv.date || "").slice(0, 10);
      // الأحدث يفوز؛ وعند تساوي التاريخ يفوز الأعلى رقم فاتورة (الأحدث تسلسلاً).
      const better =
        !best ||
        date > best.date ||
        (date === best.date && Number(inv.number || 0) > Number(best.number || 0));
      if (better) best = { date, price: resolved.price, unit: resolved.unit, number: inv.number || "" };
    }
  }
  return best ? { status: "ok", ...best } : { status: "none" };
}

// مستمعو إغلاق البطاقة مربوطون بالعناصر مباشرة لا بالتفويض، فيجب إعادة ربطهم بعد أي
// استبدال لمحتوى البطاقة (تحديثها الجراحي عند كتابة اسم الزبون) وإلا صار زر ✕ ميتاً.
function bindSalesInfoClose(root) {
  root.querySelectorAll("[data-sales-info-close]").forEach((el) => {
    el.addEventListener("click", () => {
      state.salesInfoKey = "";
      render();
    });
  });
}

// بطاقة معلومات الصنف: المخزون بالكرتونة/الكروز، التكلفة، ربح الكرتونة،
// وتوزيع المخزون على المستودعات (نظير «وحدة المعلومات» في الأمين).
function salesInfoCard() {
  if (!state.salesInfoKey) return "";
  const item = salesItemByKey(state.salesInfoKey);
  if (!item) return "";

  const factor = salesUnit2Factor(item);
  const qty = Number(item.stockQty || 0);
  const u1 = salesUnitLabel(item, "unit1");
  const u2 = salesUnitLabel(item, "unit2");

  const details = salesDetailsFor(item);
  const cost = salesUnitCost(item);
  const cartonCost = cost.value > 0 ? cost.value * factor : 0;
  const cartonPrice = Number(item.unit2Price || 0);
  const profit = cartonCost > 0 && cartonPrice > 0 ? cartonPrice - cartonCost : null;
  const margin = profit !== null && cartonPrice > 0 ? (profit / cartonPrice) * 100 : null;

  // مجموع المستودعات يُعرض من التقرير نفسه بوقته، ولا يُقارن بمخزون النشرة:
  // مخزون النشرة (approved_price_items.stock_qty) لا يُحدَّث إلا عند تغيّر عدد
  // الكراتين الكاملة، وقد يتأخر ساعات؛ كما أن حسابه يجمع الموجب فقط بينما قد
  // يكون لمستودعٍ رصيد سالب في الأمين. فعرضهما كرقم واحد يوهم بتناقض.
  const stores = details && Array.isArray(details.stores) ? details.stores.filter((s) => Number(s.qty) !== 0) : [];
  // نبني الأجزاء الموجودة فقط، ونحذف الجزء الصفري عمداً في الحالتين:
  //   سالب: «−0 كرتونة + 9 كروز» ملتبسة  ⇒  «− 9 كروز»
  //   موجب: «0 كرتونة + 9 كروز» حشو بلا فائدة ⇒ «9 كروز»
  // قرار مقصود (2026-07-25): القيمة لم تتغيّر، والنص صار أوضح للقراءة السريعة.
  const fmtQty = (q) => {
    const abs = Math.abs(q);
    const c = Math.floor(abs / factor);
    // الباقي قد يكون كسرياً (كميات موزونة). التقريب إلى صحيح كان يغيّر القيمة
    // فعلياً: 53.88 تظهر 54 و0.8 تظهر 1. نبقيه بخانتين ونحذف الأصفار الزائدة.
    const l = Math.round((abs - c * factor) * 100) / 100;
    const parts = [];
    if (c > 0) parts.push(`${c} ${u2}`);
    if (l > 0) parts.push(`${l} ${u1}`);
    if (!parts.length) parts.push(`0 ${u2}`);
    return `${q < 0 ? "− " : ""}${parts.join(" + ")}`;
  };
  const storesSum = stores.reduce((t, s) => t + Number(s.qty || 0), 0);
  const hasNegative = stores.some((s) => Number(s.qty) < 0);
  const storesHtml = stores.length
    ? `${stores
        .map((s) => {
          const sq = Number(s.qty || 0);
          return `<div class="sales-info-store ${sq < 0 ? "neg" : ""}"><span>${escapeHtml(s.name)}</span><strong dir="ltr">${escapeHtml(fmtQty(sq))}</strong></div>`;
        })
        .join("")}
       <div class="sales-info-store sales-info-store-sum"><span>مجموع المستودعات</span><strong dir="ltr">${escapeHtml(fmtQty(storesSum))}</strong></div>
       ${hasNegative ? '<p class="muted sales-info-empty">مستودع برصيد سالب في الأمين (صرف أكثر من الوارد) — يُطرح من المجموع.</p>' : ""}`
    : `<p class="muted sales-info-empty">${details ? "لا يوجد مخزون موزّع على المستودعات." : "تفاصيل المستودعات غير متاحة — شغّل tools\\push-item-details.ps1."}</p>`;

  const costHtml = cost.value > 0
    ? `<div class="sales-info-row"><span>تكلفة ${escapeHtml(u1)} (${escapeHtml(cost.basis)})</span><strong dir="ltr">$${salesFmt(cost.value, "jumla")}</strong></div>
       <div class="sales-info-row"><span>تكلفة ${escapeHtml(u2)}</span><strong dir="ltr">$${salesFmt(cartonCost, "jumla")}</strong></div>`
    : `<p class="muted sales-info-empty">${details ? "لا توجد تكلفة مسجّلة لهذا الصنف في الأمين." : "التكلفة غير متاحة — شغّل tools\\push-item-details.ps1."}</p>`;

  // عمر السعر: سعر أقدم من 30 يوماً بعد شراء جديد هو السبب الشائع لظهور «خسارة»
  // وهمية — الحالة الحقيقية 2026-07-25: بارسا سعر النشرة 245$ منذ 10 حزيران
  // بينما تكلفة آخر شراء 260$. لذلك نُظهر تاريخ التسعير ونوجّه لتحديثه.
  const pricedAt = item.approvedAt || item.updatedAt || "";
  const priceAgeDays = pricedAt ? Math.floor((Date.now() - new Date(pricedAt).getTime()) / 86400000) : null;
  const staleAge = priceAgeDays !== null && priceAgeDays >= 30;

  const profitHtml = profit !== null
    ? `<div class="sales-info-row sales-info-profit ${profit < 0 ? "loss" : ""}">
         <span>ربح ${escapeHtml(u2)}</span>
         <strong dir="ltr">${profit < 0 ? "−" : ""}$${salesFmt(Math.abs(profit), "jumla")}${margin !== null ? ` (${margin.toFixed(1)}%)` : ""}</strong>
       </div>
       ${profit < 0 ? `<p class="sales-info-warn">⚠ سعر النشرة أقل من التكلفة${staleAge ? ` — وهو مسعّر منذ ${priceAgeDays} يوماً` : ""}. غالباً لم يُحدَّث بعد آخر شراء — حدّثه قبل البيع من النشرة.</p>` : ""}`
    : "";

  const pricedAtHtml = pricedAt
    ? `<div class="sales-info-row"><span>آخر تسعير</span><strong class="${staleAge ? "sales-info-stale" : ""}" dir="ltr">${escapeHtml(formatDateTime(pricedAt))}${priceAgeDays !== null ? ` (${priceAgeDays} يوم)` : ""}</strong></div>`
    : "";

  // آخر سعر لهذا الزبون (متطلب 22): نُظهر سبب الغياب صريحاً بدل رقم مضلّل أو سطر مخفي.
  const lastCust = salesLastCustomerPrice(item);
  const windowDays = Math.max(1, Number(state.customerInvoicesReport?.summary?.periodDays || 60));
  const lastCustHtml = (() => {
    if (lastCust.status === "ok") {
      // الفرق يُقارن بسعر النشرة فقط عند اتحاد الوحدة، وإلا فمقارنة بلا معنى.
      const gap = cartonPrice > 0 && lastCust.unit === u2 ? cartonPrice - lastCust.price : null;
      const gapNote =
        gap === null || Math.abs(gap) < 0.005
          ? ""
          : `<p class="muted sales-info-empty">سعر النشرة الحالي $${salesFmt(cartonPrice, "jumla")} / ${escapeHtml(u2)} — ${gap > 0 ? "أعلى" : "أدنى"} من آخر سعر بِيع له بـ$${salesFmt(Math.abs(gap), "jumla")}.</p>`;
      return `<div class="sales-info-row">
          <span>آخر سعر لهذا الزبون</span>
          <strong dir="ltr">$${salesFmt(lastCust.price, "jumla")}${lastCust.unit ? ` / ${escapeHtml(lastCust.unit)}` : ""}</strong>
        </div>
        <div class="sales-info-row">
          <span>تاريخ آخر بيع له</span>
          <strong dir="ltr">${escapeHtml(lastCust.date)}${lastCust.number ? ` — فاتورة ${escapeHtml(String(lastCust.number))}` : ""}</strong>
        </div>
        ${gapNote}`;
    }
    const reason = {
      no_customer: "اكتب اسم الزبون في الفاتورة ليظهر آخر سعر بِيع له.",
      no_report: "مزامنة فواتير الأمين لم تصل بعد — لا يمكن معرفة آخر سعر للزبون.",
      no_customer_sales: `لا فواتير لهذا الزبون خلال آخر ${windowDays} يوماً.`,
      none: `لم يُبَع هذا الصنف لهذا الزبون خلال آخر ${windowDays} يوماً.`
    }[lastCust.status];
    return `<p class="muted sales-info-empty">${escapeHtml(reason || "")}</p>`;
  })();

  const stamp = state.itemDetailsAt
    ? `<p class="muted sales-info-stamp">تفاصيل الأمين بتاريخ ${escapeHtml(formatDateTime(state.itemDetailsAt))}</p>`
    : "";

  return `
    <div class="sales-info-backdrop" data-sales-info-close></div>
    <aside class="sales-info-card" role="dialog" aria-label="معلومات الصنف">
      <div class="sales-info-head">
        <div>
          <strong>${escapeHtml(item.itemName)}</strong>
          ${salesItemCode(item) ? `<small class="muted" dir="ltr"> #${escapeHtml(salesItemCode(item))}</small>` : ""}
        </div>
        <button type="button" class="sales-info-close" data-sales-info-close aria-label="إغلاق">✕</button>
      </div>
      <div class="sales-info-body">
        <div class="sales-info-row"><span>مخزون النشرة</span><strong dir="ltr">${escapeHtml(fmtQty(qty))}</strong></div>
        <div class="sales-info-row"><span>سعر ${escapeHtml(u2)} (جملة)</span><strong dir="ltr">${cartonPrice > 0 ? `$${salesFmt(cartonPrice, "jumla")}` : "—"}</strong></div>
        ${pricedAtHtml}
        <div class="sales-info-sep">آخر بيع لهذا الزبون</div>
        ${lastCustHtml}
        ${costHtml}
        ${profitHtml}
        <div class="sales-info-sep">توزيع المستودعات</div>
        ${storesHtml}
        ${stamp}
      </div>
    </aside>`;
}

// لوحة رصيد الزبون داخل الفاتورة (متطلب 23) — تعيد استعمال بنية الأرصدة الموجودة:
// findBalanceCustomerByText / customerBalance / customerLimit / deriveCustomerStatus.
//
// الرصيد المتوقّع = الرصيد الحالي + **المتبقّي** على الفاتورة (لا الإجمالي):
// دَين الزبون يزيد بالجزء غير المدفوع فقط، فالفاتورة النقدية المسدَّدة لا تغيّره.
// الأرصدة بالدولار (ac000 بعملة الأساس)، فنحوّل متبقّي فاتورة المفرق بسعر الصرف.
function salesCustomerPanel() {
  const typed = String(state.salesCustomer || "").trim();
  if (!typed) return "";

  const cust = findBalanceCustomerByText(typed);
  if (!cust) {
    return `<div class="sales-cust-panel"><span class="muted">زبون غير مطابق في كشف الأرصدة — لن يظهر رصيد سابق.</span></div>`;
  }

  const mode = salesCurrentMode();
  const totals = salesTotals();
  const rate = Number(state.syriaExchangeRate) || 0;
  // متبقّي الفاتورة بالدولار كي يتوافق مع عملة الأرصدة
  const remainingUsd = mode === "mufrak" ? (rate > 0 ? totals.remaining / rate : 0) : totals.remaining;

  const balance = customerBalance(cust);
  const limit = customerLimit(cust);
  const projected = balance + remainingUsd;

  const money = (v) => `$${salesFmt(Math.abs(v), "jumla")}`;
  const side = (v) => (Math.abs(v) < 0.005 ? "مسدّد" : v > 0 ? "عليه" : "له");

  // التحذير يعتمد الرصيد المتوقّع لا الحالي — الغاية أن يعرف البائع قبل الإتمام.
  // الحد صفر/غائب يعني «لا حد محدّد» فلا تحذير (معظم الزبائن بلا حد مسجّل).
  let warn = "";
  if (limit > 0) {
    if (projected > limit) {
      warn = `<p class="sales-cust-warn over">⛔ سيتجاوز حدّه الائتماني (${money(limit)}) بـ${money(projected - limit)}</p>`;
    } else if (projected >= limit * 0.9) {
      warn = `<p class="sales-cust-warn near">⚠ سيقترب من حدّه الائتماني (${money(limit)}) — المتاح ${money(limit - projected)}</p>`;
    }
  }

  const lastAmt = customerLastPaymentAmount(cust);
  const lastDate = customerLastPaymentDate(cust);

  return `
    <div class="sales-cust-panel">
      <div class="sales-cust-head">
        <strong>${escapeHtml(cust.name || typed)}</strong>
        ${limit > 0 ? `<small class="muted">الحد: ${money(limit)}</small>` : '<small class="muted">بلا حد محدّد</small>'}
      </div>
      <div class="sales-cust-row"><span>رصيده الحالي</span><strong dir="ltr">${money(balance)} <small>${side(balance)}</small></strong></div>
      <div class="sales-cust-row sales-cust-projected"><span>الرصيد بعد هذه الفاتورة</span><strong dir="ltr">${money(projected)} <small>${side(projected)}</small></strong></div>
      ${lastAmt > 0 ? `<div class="sales-cust-row"><span>آخر دفعة</span><strong dir="ltr">${money(lastAmt)}${lastDate ? ` — ${escapeHtml(String(lastDate).slice(0, 10))}` : ""}</strong></div>` : ""}
      ${warn}
    </div>`;
}

// مؤقّت تأجيل بحث الأرشيف — على مستوى الوحدة كي لا يُعاد ضبطه مع كل إعادة رسم.
let salesHistorySearchTimer = null;

// يُلغي أي إعادة رسم مؤجَّلة للبحث. يُستدعى عند مغادرة الشاشة أو التنقّل أو
// تسجيل الخروج: إعادة رسم متأخرة على شاشة أخرى تسرق تركيز الحقل الذي يكتب فيه
// المستخدم هناك.
function cancelSalesHistorySearch() {
  if (salesHistorySearchTimer) {
    clearTimeout(salesHistorySearchTimer);
    salesHistorySearchTimer = null;
  }
  state.salesHistoryFocus = false;
}

// كل فواتير المبيعات والمرتجعات من تقرير الأمين (آخر فترة مزامنة) مسطّحةً ومرتّبة
// من الأحدث — مصدر شاشة «الفواتير السابقة». مصدر واحد مع صفحة التقارير كي لا
// يظهر رقم أو مبلغ مختلف بين الشاشتين.
function salesHistoryInvoices() {
  const report = state.customerInvoicesReport;
  const customers = report && Array.isArray(report.items) ? report.items : [];
  const out = [];
  customers.forEach((cust) => {
    const customer = String(cust?.name || "").trim();
    const invoices = Array.isArray(cust?.invoices) ? cust.invoices : [];
    invoices.forEach((inv) => {
      out.push({
        customer,
        number: String(inv?.number ?? ""),
        date: String(inv?.date || "").slice(0, 10),
        total: Number(inv?.total || 0),
        isReturn: !!inv?.isReturn,
        lines: Array.isArray(inv?.lines) ? inv.lines : []
      });
    });
  });
  return out.sort((a, b) =>
    String(b.date).localeCompare(String(a.date))
    || (Number(b.number) || 0) - (Number(a.number) || 0)
  );
}

// شاشة الفواتير السابقة. زر التصدير يعيد استعمال معالج gen-invoice-doc نفسه
// المستعمل في صفحة التقارير، فلا يوجد مسار تصدير ثانٍ يمكن أن يختلف عنه.
function salesHistoryPanel() {
  const invoices = salesHistoryInvoices();
  const LIMIT = 150;
  const periodDays = Math.max(1, Number(state.customerInvoicesReport?.summary?.periodDays || 60));

  // التصفية تسبق القصّ دائماً: لو قصصنا أولاً لَما وصل البحث إلى ما بعد أول 150
  // فاتورة رغم أن الرسالة تَعِد بذلك. المطابقة بالاسم بعد التطبيع أو برقم الفاتورة.
  const rawQuery = String(state.salesHistoryQuery || "").trim();
  const needle = normalizeItemName(rawQuery);
  const filtered = rawQuery
    ? invoices.filter((inv) => (needle && normalizeItemName(inv.customer).includes(needle))
        || String(inv.number).includes(rawQuery))
    : invoices;
  const shown = filtered.slice(0, LIMIT);

  const rows = shown.map((inv) => {
    const badge = inv.isReturn
      ? '<span class="status-chip" style="background:var(--danger);color:#fff">مرتجع</span>'
      : "";
    const linesHtml = inv.lines.length
      ? `<table class="inv-table" style="margin-top:6px">
          <thead><tr><th>المادة</th><th style="width:110px">الكمية</th><th style="width:120px">سعر الوحدة</th></tr></thead>
          <tbody>${inv.lines.map((l) => `<tr><td>${escapeHtml(l.material || "")}</td><td dir="ltr">${escapeHtml(invoiceLineQty(l))}</td><td dir="ltr">${escapeHtml(invoiceLinePrice(l, { total: inv.total, lines: inv.lines }))}</td></tr>`).join("")}</tbody>
        </table>`
      : '<p class="muted" style="margin:6px 0 0">لا توجد أصناف مسجّلة لهذه الفاتورة.</p>';
    return `
      <div class="pricing-card">
        <div class="pricing-card-head">
          <strong>${escapeHtml(inv.customer || "بلا اسم")} ${badge}</strong>
          <span dir="ltr">${escapeHtml(formatMoney(inv.total))} $</span>
        </div>
        <small>فاتورة رقم <b dir="ltr">${escapeHtml(inv.number || "—")}</b> · ${escapeHtml(inv.date || "بلا تاريخ")} · ${escapeHtml(String(inv.lines.length))} صنف</small>
        <details style="margin-top:6px">
          <summary>عرض الأصناف</summary>
          ${linesHtml}
        </details>
        <button class="button secondary mini-button" type="button" data-action="gen-invoice-doc"
          data-inv-number="${escapeHtml(inv.number)}" data-inv-date="${escapeHtml(inv.date)}"
          data-customer="${escapeHtml(inv.customer)}" style="margin-top:8px">📄 ${inv.isReturn ? "تصدير فاتورة المرتجع PDF" : "تصدير الفاتورة PDF"}</button>
      </div>`;
  }).join("");

  const body = !state.customerInvoicesReport
    ? '<p class="muted">لم تصل مزامنة الفواتير من الأمين بعد. جرّب بعد دقائق.</p>'
    : (!invoices.length
        ? `<p class="muted">لا توجد فواتير خلال آخر ${escapeHtml(periodDays)} يوماً.</p>`
        : (!filtered.length
            ? `<p class="muted">لا فاتورة تطابق «${escapeHtml(rawQuery)}» ضمن ${escapeHtml(invoices.length)} فاتورة.</p>`
            : `<div class="pricing-grid" data-hist-list>${rows}</div>
               ${filtered.length > LIMIT ? `<p class="muted" style="margin-top:10px">تُعرض ${escapeHtml(LIMIT)} فاتورة من أصل ${escapeHtml(filtered.length)} مطابقة. ضيّق البحث للوصول إلى الباقي.</p>` : ""}`));

  return `
    <section class="panel wide">
      <div class="sales-toolbar">
        <button type="button" class="sales-mode-btn active" data-action="sales-history-close">↩ رجوع للفاتورة الحالية</button>
      </div>
      <h2>📄 الفواتير السابقة</h2>
      <p class="muted">فواتير المبيعات والمرتجعات المسجّلة في الأمين خلال آخر ${escapeHtml(periodDays)} يوماً — بما فيها ما أُصدر من برنامج الأمين مباشرةً.</p>
      <label class="inv-label" style="max-width:340px">بحث
        <input class="inv-input-main" id="sales-history-q" value="${escapeHtml(state.salesHistoryQuery)}" placeholder="اسم الزبون أو رقم الفاتورة" dir="auto" autocomplete="off">
      </label>
      <div style="margin-top:12px">${body}</div>
    </section>
  `;
}

function salesInvoice() {
  if (!state.session) {
    return shell(`
      <section class="panel">
        <h2>فاتورة مبيعات</h2>
        <p class="muted">سجّل الدخول أولاً للوصول إلى فاتورة المبيعات.</p>
      </section>
    `);
  }

  // شاشة الفواتير السابقة تُعرض قبل أي حساب للفاتورة الحالية: لا نستدعي
  // ensureSalesInvoiceNo هنا كي لا يُحجز أو يُستهلك رقم لمجرد تصفّح الأرشيف.
  if (state.salesHistoryOpen) return shell(salesHistoryPanel());

  const mode = salesCurrentMode();
  const symbol = salesCurrencySymbol(mode);
  const invNo = ensureSalesInvoiceNo();
  const totals = salesTotals();
  const rows = state.salesRows;
  const priceLoaded = (state.approvedPriceItems || []).length > 0;

  // اقتراحات اسم الزبون من أسماء تقرير أرصدة الأمين نفسه — نفس مصدر صفحة
  // التقارير، كي يكتب الاسم مطابقاً لما هو مسجّل بالنظام فتنجح مطابقة الرصيد
  // وحد الائتمان وآخر سعر بيع. التكرار يُزال لأن التقرير قد يحمل الاسم مرتين.
  const salesCustomerNames = Array.from(
    new Set(
      latestCustomerBalanceItems()
        .map((it) => String(it.name || "").trim())
        .filter(Boolean)
    )
  ).sort((a, b) => a.localeCompare(b, "ar"));
  const salesCustomerOptions = salesCustomerNames
    .map((name) => `<option value="${escapeHtml(name)}"></option>`)
    .join("");

  const rowsHtml = rows
    .map((row, i) => {
      const computed = salesRowComputed(row);
      const resolved = !!computed.item;
      const unitLabel = salesUnitLabel(computed.item, row.unit);
      const otherLabel = salesUnitLabel(computed.item, row.unit === "unit1" ? "unit2" : "unit1");
      return `
    <tr class="inv-row sales-row">
      <td class="sales-cell-search">
        <input class="inv-input sales-search" data-sales-field="q" data-sales-index="${i}" value="${escapeHtml(row.q)}" placeholder="رقم الصنف أو الاسم" dir="auto" autocomplete="off">
        <div class="sales-suggest" data-sales-suggest="${i}"></div>
      </td>
      <td class="sales-cell-name">${resolved ? `<strong>${escapeHtml(computed.item.itemName)}</strong>${salesItemCode(computed.item) ? `<small class="muted" dir="ltr"> #${escapeHtml(salesItemCode(computed.item))}</small>` : ""}<button type="button" class="sales-info-btn" data-sales-info="${escapeHtml(computed.item.itemKey)}" title="معلومات الصنف: المخزون والتكلفة والربح والمستودعات">i</button>` : '<span class="muted">—</span>'}</td>
      <td class="sales-cell-unit">
        <button type="button" class="sales-unit-toggle" data-sales-unit="${i}" ${resolved ? "" : "disabled"} title="${resolved ? `تبديل إلى ${escapeHtml(otherLabel)}` : "اختر صنفاً أولاً"}">${escapeHtml(unitLabel)}</button>
      </td>
      <td><input class="inv-input inv-num sales-qty" data-sales-field="qty" data-sales-num data-sales-index="${i}" value="${escapeHtml(row.qty)}" placeholder="0" type="text" inputmode="decimal" dir="ltr"></td>
      <td><input class="inv-input inv-num sales-price" data-sales-field="price" data-sales-num data-sales-index="${i}" value="${escapeHtml(row.price)}" placeholder="0" type="text" inputmode="decimal" dir="ltr"></td>
      <td class="inv-line-total sales-line-total" data-sales-linetotal="${i}">${resolved ? salesMoney(computed.lineTotal, mode) : "—"}</td>
      <td>${rows.length > 1 && resolved ? `<button class="inv-remove" data-sales-remove="${i}" title="حذف">✕</button>` : ""}</td>
    </tr>`;
    })
    .join("");

  const paidValue = state.salesPayMethod === "cash" ? salesFmtPlain(totals.paid, mode) : state.salesPaid;

  return shell(`
    <section class="panel wide inv-panel sales-panel">
      <div class="inv-form-area">
        <div class="sales-toolbar">
          <button type="button" class="sales-mode-btn" data-action="sales-history-open" title="عرض الفواتير السابقة من الأمين">↩ الفواتير السابقة</button>
          <div class="sales-mode-switch" role="group" aria-label="وضع التسعير">
            <button type="button" class="sales-mode-btn ${mode === "jumla" ? "active" : ""}" data-sales-mode="jumla">جملة · دولار</button>
            <button type="button" class="sales-mode-btn ${mode === "mufrak" ? "active" : ""}" data-sales-mode="mufrak">مفرق · سوري</button>
          </div>
          ${mode === "mufrak" ? `<span class="sales-rate-chip" dir="ltr">${escapeHtml(formatMoney(state.syriaExchangeRate))} ل.س / $</span>` : ""}
        </div>

        <div class="sales-header-grid">
          <label class="inv-label">رقم الفاتورة
            <input class="inv-input-main" value="${escapeHtml(invNo || "—")}" readonly dir="ltr">
            <small class="muted sales-inv-no-hint">${escapeHtml(salesInvoiceNoHint())}</small>
          </label>
          <label class="inv-label">التاريخ
            <input class="inv-input-main" value="${escapeHtml(todayIsoDate())}" readonly dir="ltr">
          </label>
          <label class="inv-label">اسم الزبون (اختياري)
            <input class="inv-input-main" id="sales-customer" list="sales-customer-list" autocomplete="off" value="${escapeHtml(state.salesCustomer)}" placeholder="${salesCustomerNames.length ? "اكتب أول حرفين واختَر من القائمة" : "فارغ = نقدي"}" maxlength="120" dir="auto">
            <datalist id="sales-customer-list">${salesCustomerOptions}</datalist>
          </label>
          <label class="inv-label">طريقة الدفع
            <div class="sales-pay-switch">
              <button type="button" class="sales-pay-btn ${state.salesPayMethod === "cash" ? "active" : ""}" data-sales-pay="cash">نقدي</button>
              <button type="button" class="sales-pay-btn ${state.salesPayMethod === "credit" ? "active" : ""}" data-sales-pay="credit">أجل</button>
            </div>
          </label>
        </div>

        ${priceLoaded ? "" : '<p class="muted sales-hint">لم تُحمّل لائحة الأسعار بعد — لن تظهر اقتراحات المواد حتى تُحمّل.</p>'}

        <div class="inv-table-wrap">
          <table class="inv-table sales-table">
            <thead>
              <tr>
                <th style="width:180px">رقم الصنف / الاسم</th>
                <th class="sales-th-name">الصنف</th>
                <th style="width:92px">الوحدة</th>
                <th style="width:80px">الكمية</th>
                <th style="width:120px">الإفرادي ${escapeHtml(symbol)}</th>
                <th style="width:120px">الإجمالي ${escapeHtml(symbol)}</th>
                <th style="width:34px"></th>
              </tr>
            </thead>
            <tbody id="sales-body">${rowsHtml}</tbody>
          </table>
        </div>

        <div class="sales-summary">
          <div class="sales-summary-row"><span>الإجمالي</span><strong data-sales-total dir="ltr">${salesMoney(totals.grand, mode)}</strong></div>
          <div class="sales-summary-row"><span>حسم (${escapeHtml(symbol)})</span>
            <input class="inv-input-main sales-amount-input" id="sales-discount" data-sales-num value="${escapeHtml(state.salesDiscount)}" placeholder="0" type="text" inputmode="decimal" dir="ltr">
          </div>
          <div class="sales-summary-row sales-summary-net"><span>الصافي</span><strong data-sales-net dir="ltr">${salesMoney(totals.net, mode)}</strong></div>
          <div class="sales-summary-row"><span>المدفوع (${escapeHtml(symbol)})</span>
            <input class="inv-input-main sales-amount-input" id="sales-paid" data-sales-num value="${escapeHtml(paidValue)}" placeholder="0" type="text" inputmode="decimal" dir="ltr" ${state.salesPayMethod === "cash" ? "readonly" : ""}>
          </div>
          <div class="sales-summary-row sales-summary-remaining" data-sales-remaining-row><span>المتبقّي <small class="sales-remaining-tag" data-sales-remaining-tag>${escapeHtml(salesRemainingState(totals.remaining, mode).label)}</small></span><strong data-sales-remaining dir="ltr">${salesMoney(Math.abs(totals.remaining), mode)}</strong></div>
        </div>

        <div data-sales-cust-host>${salesCustomerPanel()}</div>

        <div class="inv-actions sales-actions">
          <button class="button primary" data-action="sales-save">💾 حفظ الفاتورة</button>
          ${mode === "jumla" ? '<button class="button secondary" data-action="sales-pdf">📄 حفظ / مشاركة PDF</button>' : ""}
          ${isHandheldDevice() ? "" : `<button class="button secondary" data-action="sales-print">🖨 ${mode === "mufrak" ? "طباعة فاتورة كاشير" : "طباعة"}</button>`}
          <button class="button secondary" data-action="sales-new">＋ فاتورة جديدة</button>
        </div>
      </div>
      <div data-sales-info-host>${salesInfoCard()}</div>
    </section>
  `);
}

// تحديث جراحي للإجماليات وأسطر المجاميع دون إعادة رسم الصفحة (حفاظاً على تركيز الإدخال).
function refreshSalesTotals() {
  const mode = salesCurrentMode();
  (state.salesRows || []).forEach((row, i) => {
    const cell = document.querySelector(`[data-sales-linetotal="${i}"]`);
    if (!cell) return;
    cell.textContent = row.key ? salesMoney(toNumber(row.qty) * toNumber(row.price), mode) : "—";
  });
  const totals = salesTotals();
  const totalEl = document.querySelector("[data-sales-total]");
  if (totalEl) totalEl.textContent = salesMoney(totals.grand, mode);
  const netEl = document.querySelector("[data-sales-net]");
  if (netEl) netEl.textContent = salesMoney(totals.net, mode);
  const remainingEl = document.querySelector("[data-sales-remaining]");
  if (remainingEl) remainingEl.textContent = salesMoney(Math.abs(totals.remaining), mode);
  const remainingTagEl = document.querySelector("[data-sales-remaining-tag]");
  if (remainingTagEl) remainingTagEl.textContent = salesRemainingState(totals.remaining, mode).label;
  // لوحة الزبون تتبع المتبقّي، فتُحدَّث معه جراحياً (بلا render حفاظاً على التركيز).
  const custHost = document.querySelector("[data-sales-cust-host]");
  if (custHost) custHost.innerHTML = salesCustomerPanel();
  // وبطاقة الصنف تحتوي «آخر سعر لهذا الزبون»، فتتبع اسم الزبون كذلك — وإلا بقيت
  // البطاقة المفتوحة تقول «اكتب اسم الزبون» بعد كتابته (لا render حفاظاً على التركيز).
  if (state.salesInfoKey) {
    const infoHost = document.querySelector("[data-sales-info-host]");
    if (infoHost) {
      infoHost.innerHTML = salesInfoCard();
      bindSalesInfoClose(infoHost); // العناصر جديدة، فلا مستمعات عليها بعد الاستبدال
    }
  }
  if (state.salesPayMethod === "cash") {
    const paidInput = document.getElementById("sales-paid");
    if (paidInput) paidInput.value = salesFmtPlain(totals.paid, mode);
  }
}

// قائمة الاقتراحات تُعرض position:fixed كي لا يقصّها overflow جدول الأسطر.
function positionSalesSuggest(input, box) {
  const rect = input.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  // visualViewport يعكس المساحة الفعلية عند فتح كيبورد الآيفون (أدق من clientHeight).
  const vh = (window.visualViewport && window.visualViewport.height) || document.documentElement.clientHeight;
  const margin = 8;

  // العرض: لا يتجاوز عرض الشاشة أبداً (كان يفرض 240px فيخرج على الشاشات الضيقة).
  const width = Math.min(Math.max(rect.width, 240), vw - margin * 2);
  box.style.width = `${width}px`;

  // الأفقي: ابدأ من يسار الحقل ثم اضبطه ضمن حدود الشاشة يميناً ويساراً (مهم في RTL).
  let left = rect.left;
  if (left + width > vw - margin) left = vw - margin - width;
  if (left < margin) left = margin;
  box.style.left = `${left}px`;

  // العمودي: تحت الحقل افتراضياً؛ فإن ضاقت المساحة تحته (كيبورد الآيفون) اقلبها فوقه لتبقى مرئية.
  const spaceBelow = vh - rect.bottom;
  const spaceAbove = rect.top;
  if (spaceBelow < 160 && spaceAbove > spaceBelow) {
    const h = Math.min(320, spaceAbove - margin);
    box.style.maxHeight = `${Math.max(120, h)}px`;
    box.style.top = `${Math.max(margin, rect.top - h - 2)}px`;
  } else {
    const h = Math.min(320, spaceBelow - margin);
    box.style.maxHeight = `${Math.max(120, h)}px`;
    box.style.top = `${rect.bottom + 2}px`;
  }
}

// إعادة التركيز إلى حقل محدّد بعد إعادة الرسم (render يبني DOM جديداً كلياً).
// أساس العمل بلا ماوس: بعد اختيار الصنف ننتقل للكمية، وEnter ينقل بين الحقول.
function salesFocusField(rowIndex, field) {
  const focusNow = () => {
    const el = document.querySelector(`[data-sales-field="${field}"][data-sales-index="${rowIndex}"]`);
    if (!el) return false;
    el.focus();
    if (typeof el.select === "function") el.select();
    return true;
  };
  // المحاولة الفورية مقصودة: تبقى داخل سياق لمسة المستخدم، وهو شرط iOS لفتح الكيبورد.
  // rAF احتياط فقط لو لم يكن العنصر قد رُسم بعد.
  if (focusNow()) return;
  requestAnimationFrame(focusNow);
}

function salesPickItem(rowIndex, key) {
  const row = state.salesRows[rowIndex];
  const item = salesItemByKey(key);
  if (!row || !item) return;
  const mode = salesCurrentMode();
  row.key = item.itemKey;
  row.name = item.itemName;
  row.num = salesItemCode(item);
  row.q = row.num ? row.num : item.itemName;
  if (row.unit !== "unit1" && row.unit !== "unit2") row.unit = "unit2";
  const auto = salesAutoUnitPrice(item, row.unit, mode);
  row.price = auto > 0 ? String(auto) : "";
  row.edited = false;
  if (!(toNumber(row.qty) > 0)) row.qty = "1";
  salesEnsureTrailingRow();
  render();
  // بعد اختيار الصنف ينتقل التركيز تلقائياً إلى الكمية (متطلب العمل بلا ماوس).
  salesFocusField(rowIndex, "qty");
}

function salesToggleUnit(rowIndex) {
  const row = state.salesRows[rowIndex];
  if (!row || !row.key) return;
  const item = salesItemByKey(row.key);
  const mode = salesCurrentMode();
  row.unit = row.unit === "unit1" ? "unit2" : "unit1";
  // تغيّر الوحدة يغيّر أساس السعر ⇐ نعيد حساب الإفرادي التلقائي ونلغي أي تعديل يدوي سابق.
  const auto = salesAutoUnitPrice(item, row.unit, mode);
  row.price = auto > 0 ? String(auto) : "";
  row.edited = false;
  render();
}

function salesSetMode(mode) {
  const next = mode === "mufrak" ? "mufrak" : "jumla";
  state.salesMode = next;
  writeJson("sales-mode", next);
  // تغيّر الوضع يغيّر العملة والأساس ⇐ نعيد تسعير كل الأسطر تلقائياً ونلغي التعديلات اليدوية.
  (state.salesRows || []).forEach((row) => {
    if (!row.key) return;
    const auto = salesAutoUnitPrice(salesItemByKey(row.key), row.unit, next);
    row.price = auto > 0 ? String(auto) : "";
    row.edited = false;
  });
  render();
}

function salesNewInvoice() {
  state.salesRows = [salesEmptyRow()];
  state.salesCustomer = "";
  state.salesDiscount = "";
  state.salesPaid = "";
  state.salesPayMethod = "cash";
  state.salesInvoiceNoMode = salesCurrentMode();
  state.salesInvoiceNo = peekSalesInvoiceNumber(state.salesInvoiceNoMode);
  state.salesSavedNo = "";
  setNotice("success", "بدأت فاتورة مبيعات جديدة.");
  render();
}

async function salesSaveInvoice() {
  // نقرة ثانية أثناء تنفيذ الحفظ. هذا الفحص أولاً وقبل أي شيء، ورفعُ القفل بعده
  // مباشرةً وقبل أي await: عندما كان القفل يُرفع قبل الكتابة فقط، كانت النقرة
  // الثانية تمرّ أثناء جلب المزامنة فيُحفظ مستندان بالرقم نفسه (مانع أكّدته
  // المراجعة). كل خروج بعد هذه النقطة يمرّ عبر finally الذي يخفض القفل.
  if (state.salesSaving) return;

  if (!salesResolvedRows().length) {
    setNotice("error", "أضف صنفاً واحداً على الأقل بكمية وسعر أكبر من صفر.");
    render();
    return;
  }
  // منع حفظ الفاتورة نفسها مرتين (إعادة ضغط بعد نجاح الحفظ).
  if (state.salesSavedNo && state.salesSavedNo === state.salesInvoiceNo) {
    setNotice("error", `الفاتورة ${state.salesSavedNo} محفوظة مسبقاً — اضغط «＋ فاتورة جديدة» لإصدار فاتورة أخرى.`);
    render();
    return;
  }

  // الوضع يُثبَّت مرة واحدة ويُمرَّر صراحةً لكل ما يلي (الرقم، الحجز، المستند).
  const mode = salesCurrentMode();

  state.salesSaving = true;
  const saveBtn = document.querySelector("[data-action='sales-save']");
  if (saveBtn) saveBtn.disabled = true;

  try {
    // مصدر الترقيم يُعاد جلبه قبل الحفظ لا يُؤخذ من قراءة فتح الشاشة: قد تكون
    // مرّت ساعات وسُجّلت فواتير في الأمين.
    await refreshInvoiceSeries();

    // تبديل الوضع أثناء الجلب يغيّر العملة وأسعار الأسطر معاً، فيخرج مستند
    // بعملة وضعٍ وأسعار وضعٍ آخر (المراجعة رصدت فاتورة جملة بالدولار وفيها سعر
    // مفرق 500000 ل.س). لا نحاول التوفيق بين الوضعين — نلغي الحفظ ونطلب مراجعة
    // الأسعار، لأن أي تخمين هنا يكتب مستنداً محاسبياً خاطئاً.
    if (salesCurrentMode() !== mode) {
      setNotice("error", "تبدّل وضع الفاتورة (جملة/مفرق) أثناء الحفظ — أُلغي الحفظ ولم يُستهلك رقم. راجع الأسعار ثم احفظ مجدداً.");
      return;
    }

    const seriesState = salesSeriesState(mode);
    if (!seriesState.usable) {
      setNotice("error", salesSeriesBlockReason(seriesState));
      return;
    }

    // الرقم يُحسم لحظة الحفظ: لو كان المعروض قد استُهلك فعلاً (فاتورة أخرى، أو
    // تبويب آخر، أو وصلت مزامنة أحدث من الأمين) نأخذ التالي بدل تكرار رقم محجوز.
    const freshNo = peekSalesInvoiceNumber(mode);
    if (!freshNo) {
      setNotice("error", salesSeriesBlockReason(salesSeriesState(mode)));
      return;
    }
    const shownNo = Number(state.salesInvoiceNoMode === mode ? state.salesInvoiceNo : "");
    if (!Number.isFinite(shownNo) || shownNo < Number(freshNo)) {
      state.salesInvoiceNo = freshNo;
      state.salesInvoiceNoMode = mode;
    }

    // الأسطر تُقرأ بعد الجلب لا قبله: القراءة المسبقة تحمل مراجع الأسطر نفسها،
    // فأي تعديل حصل أثناء الانتظار يجب أن يظهر في المستند أو يُلغى الحفظ.
    const resolved = salesResolvedRows();
    if (!resolved.length) {
      setNotice("error", "أضف صنفاً واحداً على الأقل بكمية وسعر أكبر من صفر.");
      return;
    }

    const totals = salesTotals();
    const roundValue = (value) => (mode === "mufrak" ? Math.round(Number(value || 0)) : roundPrice(Number(value || 0)));
    const doc = {
      t: "sales_invoice",
      // الرقم من الحالة مباشرةً لا عبر ensureSalesInvoiceNo: تلك تقرأ الوضع الحالي.
      no: state.salesInvoiceNo,
      date: todayIsoDate(),
      name: state.salesCustomer.trim(),
      payMethod: state.salesPayMethod,
      mode,
      cur: salesCurrencySymbol(mode),
      rate: mode === "mufrak" ? Number(state.syriaExchangeRate) || 0 : null,
      items: resolved.map((row) => {
        const item = salesItemByKey(row.key);
        const qty = toNumber(row.qty);
        const price = toNumber(row.price);
        return {
          num: salesItemCode(item) || row.num || "",
          name: item?.itemName || row.name || "",
          unit: salesUnitLabel(item, row.unit),
          unitKey: row.unit,
          qty,
          price: roundValue(price),
          total: roundValue(qty * price)
        };
      }),
      total: roundValue(totals.grand),
      discount: roundValue(totals.discount),
      net: roundValue(totals.net),
      paid: roundValue(totals.paid),
      remaining: roundValue(totals.remaining)
    };

    await dataStore.createSharedDocument(doc);
    // الحجز بعد النجاح فقط: فشل الحفظ يجب ألا يستهلك رقماً ولا يترك فجوة.
    // الوضع يُمرَّر صراحةً (doc.mode) لا يُقرأ من الحالة.
    salesReserveInvoiceNo(doc.no, doc.mode);
    state.salesSavedNo = doc.no;
    // TODO: عند تفعيل النواة الكاملة يُخصم المخزون ويُقيَّد على ذمة الزبون هنا.
    setNotice("success", `تم حفظ فاتورة المبيعات ${doc.no} بالنظام والأرشيف ✓`);
  } catch (error) {
    setNotice("error", "تعذّر حفظ الفاتورة: " + safeErrorMessage(error));
  } finally {
    state.salesSaving = false;
    if (saveBtn) saveBtn.disabled = false;
    render();
  }
}

// إعادة استخدام قالب طباعة الفاتورة (نفس CSS) مع تكييف بسيط: أعمدة الوحدة/الرقم
// وكتلة مجاميع (إجمالي/حسم/صافي/مدفوع/متبقٍّ) ودعم عملة الليرة في وضع المفرق.
// نسخة الفاتورة المخصّصة لتوليد ملف PDF حقيقي: أنماط سطرية بالكامل، بلا وسم
// <style> عام. السبب: حاوية التوليد تعيش داخل صفحة التطبيق نفسها، وأي قاعدة
// مثل body{} أو table{} كانت ستتسرّب على الواجهة أثناء التوليد. الخلفية بيضاء
// صراحةً كي لا تخرج صفحات سوداء (قاعدة موثّقة في CLAUDE.md).
function salesInvoicePdfMarkup(data) {
  const border = "1px solid #d9d2c4";
  const th = `padding:7px 6px;background:#f3efe6;border:${border};font-size:12px;font-weight:700;color:#3a3226`;
  const td = `padding:6px;border:${border};font-size:12px;color:#241f18`;
  // `break-inside: avoid` على كل صف: صف كمية/سعر/إجمالي مقسوم بين صفحتين غير
  // مقبول على مستند يُسلَّم للزبون (ظهر في فاتورة 40 صنفاً عند الصف 32).
  const pdfRowStyle = "page-break-inside:avoid;break-inside:avoid";
  const rows = data.rows.map((row, i) => `
    <tr style="${pdfRowStyle}">
      <td style="${td};text-align:center">${i + 1}</td>
      <td style="${td}">${escapeHtml(row.name)}</td>
      <td style="${td};text-align:center">${escapeHtml(row.unit)}</td>
      <td style="${td};text-align:center" dir="ltr">${escapeHtml(row.qty)}</td>
      <td style="${td};text-align:left" dir="ltr">${escapeHtml(row.price)}</td>
      <td style="${td};text-align:left" dir="ltr">${escapeHtml(row.total)}</td>
    </tr>`).join("");
  const summaryRow = (label, value, strong) => `
    <tr style="${pdfRowStyle}">
      <td style="${td};background:#faf8f3;font-weight:${strong ? 700 : 400}">${escapeHtml(label)}</td>
      <td style="${td};text-align:left;font-weight:${strong ? 700 : 400}" dir="ltr">${escapeHtml(value)}</td>
    </tr>`;
  const info = (label, value) => `
    <div style="font-size:12px;color:#241f18;margin:2px 0">
      <span style="color:#6b6154">${escapeHtml(label)}:</span> <b>${escapeHtml(value)}</b>
    </div>`;

  return `
  <div dir="rtl" style="width:754px;padding:20px;background:#ffffff;color:#241f18;
       font-family:'Segoe UI',Tahoma,Arial,sans-serif">
    ${salesDraftBannerHtml(data.invNo)}
    <div class="pdf-head" style="display:flex;justify-content:space-between;align-items:flex-start;
         border-bottom:2px solid #8a6d3b;padding-bottom:10px;margin-bottom:12px;${pdfRowStyle}">
      <div>
        <div style="font-size:20px;font-weight:700;color:#8a6d3b">OZK TOBACCO</div>
        <div style="font-size:12px;color:#6b6154">مركز أبو زياد — لتجارة الدخان</div>
      </div>
      <div style="text-align:left">
        <div style="font-size:16px;font-weight:700">فاتورة مبيعات</div>
        <div style="font-size:12px;color:#6b6154" dir="ltr">${escapeHtml(data.invNo)}</div>
      </div>
    </div>

    <div class="pdf-meta" style="display:flex;justify-content:space-between;margin-bottom:12px;${pdfRowStyle}">
      <div>
        ${info("الزبون", data.customer)}
        ${info("طريقة الدفع", data.payLabel)}
      </div>
      <div>
        ${info("التاريخ", data.dateLabel)}
        ${info("العملة", data.curLabel)}
      </div>
    </div>

    <table style="width:100%;border-collapse:collapse;margin-bottom:12px">
      <thead>
        <tr style="${pdfRowStyle}">
          <th style="${th};width:28px">#</th>
          <th style="${th}">الصنف</th>
          <th style="${th};width:64px">الوحدة</th>
          <th style="${th};width:56px">الكمية</th>
          <th style="${th};width:82px">الإفرادي</th>
          <th style="${th};width:92px">الإجمالي</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <div class="pdf-tail" style="${pdfRowStyle}">
    <table class="pdf-summary" style="width:290px;border-collapse:collapse;margin-right:auto;${pdfRowStyle}">
      <tbody style="${pdfRowStyle}">
        ${summaryRow("الإجمالي", data.grand)}
        ${summaryRow("الحسم", data.discount)}
        ${summaryRow("الصافي", data.net, true)}
        ${summaryRow("المدفوع", data.paid)}
        ${summaryRow(`المتبقّي (${data.remainingLabel})`, data.remaining, true)}
      </tbody>
    </table>

    <div class="pdf-foot" style="margin-top:18px;padding-top:8px;border-top:1px solid #d9d2c4;
         font-size:11px;color:#6b6154;display:flex;justify-content:space-between;${pdfRowStyle}">
      <span>صفة البيع: ${escapeHtml(SALES_TRADE_CAPACITY)} · السجل التجاري: <span dir="ltr">${escapeHtml(SALES_TRADE_REGISTER_NO)}</span></span>
      <span dir="ltr">0985000771 — 0984000662</span>
    </div>
    </div>
  </div>`;
}

// نسبة البكسل غير الأبيض في لوحة الرسم — دليل مباشر على أن المستند رُسم فعلاً.
// نأخذ عيّنة كل 29 بكسل: تكفي للحكم وتُبقي القياس سريعاً على الهاتف.
function canvasInkRatio(canvas, yStart, yEnd) {
  if (!canvas || !canvas.width || !canvas.height) return 0;
  const top = Math.max(0, Math.floor(yStart || 0));
  const bottom = Math.min(canvas.height, Math.ceil(yEnd === undefined ? canvas.height : yEnd));
  if (bottom <= top) return 0;
  try {
    const data = canvas.getContext("2d").getImageData(0, top, canvas.width, bottom - top).data;
    let ink = 0;
    let total = 0;
    for (let i = 0; i < data.length; i += 4 * 29) {
      total++;
      if (data[i] < 235 || data[i + 1] < 235 || data[i + 2] < 235) ink++;
    }
    return total > 0 ? ink / total : 0;
  } catch {
    // تعذّر القياس (قيود أمنية مثلاً) — لا نمنع التصدير بسببه.
    return 1;
  }
}

// حفظ/مشاركة الفاتورة كملف PDF فعلي.
// السبب: على iOS داخل التطبيق المثبَّت (standalone) لا يفتح window.print() أي
// نافذة ولا يرمي خطأ — فتظهر رسالة نجاح بلا أي ورقة طباعة. الملف الفعلي يحلّ
// المشكلة ويسمح بإرساله للزبون على واتساب مباشرةً من ورقة المشاركة.
async function saveSalesInvoicePdf() {
  const resolved = salesResolvedRows();
  if (!resolved.length) {
    setNotice("error", "أضف صنفاً واحداً على الأقل بكمية وسعر قبل التصدير.");
    render();
    return;
  }
  if (!window.html2pdf) {
    setNotice("error", "مكتبة PDF لم تتحمّل. حدّث الصفحة وجرّب مجدداً.");
    render();
    return;
  }
  const mode = salesCurrentMode();
  // تصدير PDF للجملة فقط بقرار المالك؛ المفرق يُطبع فاتورة كاشير على الرول.
  // حارس إضافي حتى لو لم يُعرض الزر أصلاً في وضع المفرق.
  if (mode === "mufrak") {
    setNotice("error", "تصدير PDF مخصّص لفاتورة الجملة. المفرق يُطبع فاتورة كاشير.");
    render();
    return;
  }
  // نفس حارس الطباعة: لا نصدر مستنداً برقم غير موثوق إطلاقاً — لكن بتسامح
  // موسَّع (راجع SALES_PRINT_GRACE_MAX_AGE_MS) لأن التصدير معاينة بلا التزام،
  // لا يحجز رقماً ولا يكتب شيئاً بقاعدة البيانات. الحفظ الفعلي (salesSaveInvoice)
  // يبقى بحدّه الصارم الأصلي دون أي تغيير. أثناء التدهور: مسودة بلا رقم
  // إطلاقاً (SALES_DRAFT_INVOICE_NO) — لا رقم تخميني قد يتصادم مع فاتورة
  // أُدخلت مباشرة بالأمين أو من جهاز آخر (ملاحظة Codex P1 على PR #144).
  const series = salesPrintSeriesState(mode);
  if (!series.printUsable) {
    setNotice("error", salesSeriesBlockReason(series));
    render();
    return;
  }
  let invNo;
  if (series.degraded) {
    if (!confirm(salesPrintGraceWarning(series))) return;
    invNo = SALES_DRAFT_INVOICE_NO;
  } else {
    invNo = ensureSalesInvoiceNo();
    if (!invNo) {
      setNotice("error", salesSeriesBlockReason(salesSeriesState(mode)));
      render();
      return;
    }
  }

  const totals = salesTotals();
  const markup = salesInvoicePdfMarkup({
    invNo,
    customer: state.salesCustomer.trim() || "زبون نقدي",
    payLabel: state.salesPayMethod === "credit" ? "أجل" : "نقدي",
    dateLabel: new Intl.DateTimeFormat("ar-SA-u-ca-gregory-nu-latn", { dateStyle: "long" }).format(new Date()),
    curLabel: mode === "mufrak"
      ? `ليرة سورية — صرف ${formatMoney(state.syriaExchangeRate)}`
      : "دولار أمريكي",
    rows: resolved.map((row) => {
      const item = salesItemByKey(row.key);
      const qty = toNumber(row.qty);
      const price = toNumber(row.price);
      return {
        code: salesItemCode(item) || row.num || "",
        name: item?.itemName || row.name || "",
        unit: salesUnitLabel(item, row.unit),
        qty: formatMoney(qty),
        price: salesMoney(price, mode),
        total: salesMoney(qty * price, mode)
      };
    }),
    grand: salesMoney(totals.grand, mode),
    discount: salesMoney(totals.discount, mode),
    net: salesMoney(totals.net, mode),
    paid: salesMoney(totals.paid, mode),
    remaining: salesMoney(Math.abs(totals.remaining), mode),
    remainingLabel: salesRemainingState(totals.remaining, mode).label
  });

  const container = document.createElement("div");
  container.style.cssText = "position:absolute;left:-10000px;top:0;width:794px;background:#ffffff;";
  container.innerHTML = markup;
  document.body.appendChild(container);

  // اسم الملف المنزَّل من نفس بيانات الفاتورة المطبوعة الآن — لا رقم بلا اسم
  // زبون، ولا صيغة إنكليزية. هو نفسه مصدر اسم النسخة في iCloud.
  const pdfArchiveMeta = {
    party: state.salesCustomer.trim() || "زبون نقدي",
    number: invNo,
    date: todayIsoDate()
  };
  const fileName = `${archiveDocumentTitle("invoice", pdfArchiveMeta)}.pdf`;
  // نحفظ موضع التمرير: **السبب الجذري للملف الفارغ** أن html2canvas يلتقط منطقة
  // خاطئة حين تكون الصفحة مُمرَّرة للأسفل — وهي حالة الهاتف دائماً عند الضغط على
  // زر أسفل الشاشة. قياس فعلي: صفحة عند 1500px تعطي لوحة بصفر حبر وملف 3 ك.ب،
  // وبالرجوع إلى الأعلى قبل الالتقاط تعطي 11.84% حبراً وملفاً 104 ك.ب.
  const keepScrollX = window.scrollX || 0;
  const keepScrollY = window.scrollY || 0;
  try {
    window.scrollTo(0, 0);
    // دقة أقل على الهاتف: المقياس 2 يستهلك ذاكرة كبيرة على iOS.
    const worker = window.html2pdf().set({
      margin: [6, 6, 6, 6],
      filename: fileName,
      image: { type: "jpeg", quality: 0.96 },
      html2canvas: { scale: isHandheldDevice() ? 1.5 : 2, useCORS: true, backgroundColor: "#ffffff" },
      jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
      // يمنع قطع أي صف بين صفحتين، ويحترم أنماط break-inside في القالب.
      pagebreak: {
        mode: ["css", "legacy"],
        // الصفوف وكتل المجاميع والتذييل والترويسة: أي منها مقسوم بين صفحتين
        // يفسد شكل مستند يُسلَّم للزبون.
        // `.pdf-tail` تجمع المجاميع والتذييل معاً: تذييل وحيد في صفحة ثانية
        // شبه فارغة يبدو خطأً في الطباعة لا تنسيقاً.
        avoid: ["tr", ".pdf-tail", ".pdf-summary", ".pdf-foot", ".pdf-head", ".pdf-meta"]
      }
      // **العنصر الداخلي لا الحاوية**: تمرير حاوية `position:absolute` يجعل
      // html2canvas يحسب ارتفاعاً صفراً فتخرج لوحة 1123×0 وملف 3 ك.ب بلا رسم —
      // وهو الحجم نفسه الذي وصل المالك. قياس: الحاوية 1123×0 والداخلي 1123×751.
    }).from(container.firstElementChild || container);

    // بوابة التحقق: نقيس نسبة البكسل غير الأبيض في اللوحة قبل بناء الملف.
    // حجم الملف وحده مؤشر ضعيف (لوحة فارغة أعطت 9 ك.ب في القياس)، أما الحبر
    // فدليل مباشر على أن الفاتورة رُسمت فعلاً.
    await worker.toCanvas();
    const canvas = (worker.prop && worker.prop.canvas) || worker.canvas;
    const inkRatio = canvasInkRatio(canvas);
    if (inkRatio <= 0.001) {
      setNotice("error", "خرجت صفحة الفاتورة فارغة عند التوليد. أغلق التطبيق وافتحه ثم جرّب مجدداً — ولا تُرسل أي ملف نتج الآن.");
      render();
      return;
    }

    await worker.toPdf();
    const pdf = worker.prop && worker.prop.pdf;
    // صفحة A4 بيضاء بالكامل في آخر الملف تحصل حين يتجاوز المحتوى حدّ الصفحة
    // ببضعة بكسلات فقط (فاتورة 24 صنفاً مثلاً). نقيس حبر الشريحة الأخيرة من
    // اللوحة ونحذف الصفحة إن كانت فارغة — أنظف من العبث بالهوامش.
    if (pdf && canvas && typeof pdf.deletePage === "function") {
      const pageCount = pdf.internal.getNumberOfPages();
      if (pageCount > 1) {
        // اللوحة تُقاس إلى عرض الصفحة المفيد (210mm ناقص هامشين 6mm).
        const pxPerMm = canvas.width / (210 - 12);
        const pageHeightPx = pxPerMm * (297 - 12);
        const lastStart = (pageCount - 1) * pageHeightPx;
        if (lastStart < canvas.height && canvasInkRatio(canvas, lastStart, canvas.height) <= 0.0005) {
          pdf.deletePage(pageCount);
        }
      }
    }
    const blob = pdf ? pdf.output("blob") : await worker.outputPdf("blob");
    if (!blob || blob.size < 8 * 1024) {
      setNotice("error", `تعذّر توليد ملف الفاتورة (خرج بحجم ${Math.round((blob?.size || 0) / 1024)} ك.ب). جرّب مجدداً.`);
      render();
      return;
    }

    // نؤرشف الـBlob نفسه لا الـHTML: النسخة في iCloud تصير مطابقة حرفياً للملف
    // الذي يُسلَّم للزبون. المسودة (بلا رقم أثناء تدهور المزامنة) لا تُؤرشف
    // إطلاقاً كي لا يدخل الأرشيف مستند بلا رقم فاتورة موثوق.
    if (invNo !== SALES_DRAFT_INVOICE_NO) {
      archiveToICloud("invoice", blob, pdfArchiveMeta);
    }

    if (isHandheldDevice()) {
      presentPortablePdf(blob, fileName, `فاتورة مبيعات ${invNo}`);
      setNotice("success", `تم تجهيز الفاتورة ${invNo} كملف PDF.`);
      render();
      return;
    }

    const file = new File([blob], fileName, { type: "application/pdf" });
    // ورقة المشاركة أولاً: على iOS هي الطريق الوحيد العملي للحفظ في «الملفات»
    // أو الإرسال على واتساب. إن رفضها النظام (تنتهي صلاحية إيماءة المستخدم بعد
    // انتظار التوليد) نسقط إلى التنزيل المباشر.
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: `فاتورة مبيعات ${invNo}` });
        setNotice("success", `تم تجهيز الفاتورة ${invNo} PDF ومشاركتها.`);
        render();
        return;
      } catch (shareError) {
        // إلغاء المستخدم للمشاركة ليس خطأً — لا نُنزّل الملف رغماً عنه.
        if (shareError && shareError.name === "AbortError") {
          render();
          return;
        }
      }
    }
    const url = URL.createObjectURL(blob);
    // التحرير يُجدول فور الإنشاء: أي فشل بعده لا يترك رابطاً معلّقاً في الذاكرة.
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.rel = "noopener";
    document.body.appendChild(link);
    try {
      link.click();
    } finally {
      link.remove();
    }
    setNotice("success", `تم تنزيل الفاتورة ${invNo} كملف PDF.`);
    render();
  } catch (error) {
    setNotice("error", "تعذّر توليد ملف PDF: " + safeErrorMessage(error));
    render();
  } finally {
    container.remove();
    // إرجاع موضع التمرير **فقط إن كان ما زال حيث تركناه**: لو مرّر المستخدم
    // الصفحة أثناء التوليد فإرجاعه القسري يخطف الشاشة من تحت يده.
    if ((window.scrollX || 0) === 0 && (window.scrollY || 0) === 0) {
      window.scrollTo(keepScrollX, keepScrollY);
    }
  }
}

// بيانات ثابتة تظهر في تذييل كل مستند بيع (طباعة A4، فاتورة كاشير، وملف PDF):
// صفة البيع النظامية ورقم السجل التجاري. مصدر واحد كي لا تختلف بين المستندات.
const SALES_TRADE_REGISTER_NO = "0310109105";
const SALES_TRADE_CAPACITY = "من تاجر جملة الجملة إلى تاجر جملة ومفرق";

// الطباعة مخصّصة للابتوب وحده: لا طابعة موصولة بالهاتف، وiOS داخل التطبيق
// المثبَّت لا يفتح ورقة الطباعة أصلاً. الشرطان معاً (لمس + شاشة ضيّقة) كي لا
// يُحسب لابتوب بشاشة لمس هاتفاً فيختفي عنه زر الطباعة.
function isHandheldDevice() {
  if (typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(pointer: coarse)").matches
    && window.matchMedia("(max-width: 900px)").matches;
}

// فاتورة كاشير للمفرق: رول حراري 80mm بدل ورقة A4. الطول تلقائي (`auto`) كي
// لا تُقطع الورقة على ارتفاع ثابت، والهوامش صفر لأن الطابعة الحرارية تتكفّل بها.
// الأصناف تُطبع بسطرين لكل صنف: الاسم ثم «كمية × سعر = إجمالي» — أوضح ما يمكن
// على عرض ضيق من محاولة حشر سبعة أعمدة.
function salesReceiptDocument(data) {
  const lines = data.rows.map((row) => `
    <div class="ln">
      <div class="ln-name">${escapeHtml(row.name)}</div>
      <div class="ln-calc">
        <span class="ln-qp"><b class="nb" dir="ltr">${escapeHtml(row.qty)}</b><span class="ln-unit">${escapeHtml(row.unit)}</span><span class="ln-x">×</span><b class="nb" dir="ltr">${escapeHtml(row.price)}</b></span>
        <b class="nb" dir="ltr">${escapeHtml(row.total)}</b>
      </div>
    </div>`).join("");

  const sum = (label, value, strong) =>
    `<div class="sum${strong ? " sum-strong" : ""}"><span>${escapeHtml(label)}</span><b class="nb" dir="ltr">${escapeHtml(value)}</b></div>`;

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<title>فاتورة كاشير ${escapeHtml(data.invNo)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  @page { size: 80mm auto; margin: 0; }
  /* اسم صنف طويل بلا مسافات كان يمدّ عرض الرول من 80mm إلى أضعافه. الكسر
     داخل الكلمة إجباري هنا لأن الورقة الحرارية عرضها ثابت لا يقبل التمدّد. */
  body { width: 80mm; max-width: 80mm; padding: 3mm 4mm; direction: rtl; background: #fff; color: #000;
         font-family: 'Segoe UI', Tahoma, Arial, sans-serif; font-size: 12px; line-height: 1.5;
         overflow-wrap: anywhere; word-break: break-word; }
  .head { text-align: center; border-bottom: 1px dashed #000; padding-bottom: 6px; margin-bottom: 6px; }
  .brand { font-size: 16px; font-weight: 700; letter-spacing: 0.5px; }
  .sub { font-size: 11px; }
  .meta { font-size: 11px; margin-bottom: 6px; }
  .meta div { display: flex; justify-content: space-between; gap: 6px; }
  .meta b { text-align: left; min-width: 0; }
  /* الأرقام لا تُكسر (رقم أو مبلغ منقسم على سطرين غير مقروء)، لكنها **محدودة
     بعرض أبيها** ويُقصّ الفائض بثلاث نقاط: الرول عرضه ثابت 80mm ولا يجوز أن
     يمدّه أي مدخل مهما طال. النصوص وحدها هي التي تلتف على أسطر. */
  .nb { display: inline-block; max-width: 100%; vertical-align: bottom;
        white-space: nowrap; overflow-wrap: normal; word-break: keep-all;
        overflow: hidden; text-overflow: ellipsis; }
  .meta div > *, .ln-calc > *, .sum > * { min-width: 0; }
  .ln { border-bottom: 1px dotted #999; padding: 3px 0; }
  .ln-name { font-weight: 700; }
  .ln-code { font-weight: 400; font-size: 10px; }
  /* أولوية القصّ داخل سطر الحساب: اسم الوحدة وحده هو الذي يُقصّ عند الضيق،
     أما الكمية والسعر والإجمالي فأرقام لا تُقصّ ولا تُضغط (flex-shrink صفر).
     وإخفاء الفائض على السطر يضمن ألا يمدّ أي مدخل عرض الرول. */
  .ln-calc { display: flex; justify-content: space-between; align-items: baseline;
             gap: 6px; font-size: 11px; overflow: hidden; }
  /* الاتجاه هنا يبقى RTL كاتجاه الورقة: الكمية ثم الوحدة ثم × ثم السعر — وهو
     ترتيب القراءة الطبيعي للبائع. كل رقم وحده dir=ltr كي تُرسم خاناته صحيحة. */
  .ln-qp { display: flex; align-items: baseline; gap: 5px; min-width: 0; }
  .ln-x { flex: 0 0 auto; }
  .ln-calc > .nb, .ln-qp > .nb { flex: 0 0 auto; }
  .ln-unit { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sum span { min-width: 0; }
  .sum b { white-space: nowrap; }
  .sums { margin-top: 6px; border-top: 1px dashed #000; padding-top: 5px; }
  .sum { display: flex; justify-content: space-between; font-size: 12px; }
  .sum-strong { font-size: 14px; font-weight: 700; margin-top: 2px; }
  .foot { margin-top: 8px; border-top: 1px dashed #000; padding-top: 5px;
          text-align: center; font-size: 10px; line-height: 1.6; }
</style>
</head>
<body>
  <div class="head">
    <div class="brand">OZK TOBACCO</div>
    <div class="sub">مركز أبو زياد — لتجارة الدخان</div>
  </div>
  ${data.invNo === SALES_DRAFT_INVOICE_NO ? `<div style="background:#fff3cd;border:1px dashed #b8860b;color:#5c3d00;
    font-weight:700;text-align:center;padding:4px 6px;margin-bottom:6px;font-size:10px;line-height:1.4">
    ⚠️ مسودة — بلا رقم فاتورة نهائي
  </div>` : ""}
  <div class="meta">
    <div><span>فاتورة رقم</span><b class="nb" dir="ltr">${escapeHtml(data.invNo)}</b></div>
    <div><span>التاريخ</span><b class="nb">${escapeHtml(data.dateLabel)}</b></div>
    <div><span>الزبون</span><b>${escapeHtml(data.customer)}</b></div>
    <div><span>الدفع</span><b>${escapeHtml(data.payLabel)}</b></div>
  </div>
  ${lines}
  <div class="sums">
    ${sum("الإجمالي", data.grand)}
    ${data.hasDiscount ? sum("الحسم", data.discount) : ""}
    ${sum("الصافي", data.net, true)}
    ${sum("المدفوع", data.paid)}
    ${sum(`المتبقّي (${data.remainingLabel})`, data.remaining, true)}
  </div>
  <div class="foot">
    شكراً لتعاملكم معنا
    <div>صفة البيع: ${escapeHtml(SALES_TRADE_CAPACITY)}</div>
    <div>السجل التجاري: <span dir="ltr">${escapeHtml(SALES_TRADE_REGISTER_NO)}</span></div>
    <div dir="ltr">0985000771 — 0984000662</div>
  </div>
</body>
</html>`;
}

function printSalesInvoice() {
  const resolved = salesResolvedRows();
  if (!resolved.length) {
    setNotice("error", "أضف صنفاً واحداً على الأقل بكمية وسعر قبل الطباعة.");
    render();
    return;
  }
  const mode = salesCurrentMode();
  // لا تُطبع فاتورة برقم حقيقي أو تقديري غير موثوق: الورقة المطبوعة مستند
  // يُسلَّم للزبون، والعداد المحلي (salesSeqState) يمنع فقط تكرار الرقم على
  // نفس الجهاز — لا يحمي من إصدار مباشر في الأمين أو من جهاز آخر أثناء
  // الانقطاع (ملاحظة Codex P1 على PR #144). لذلك في الحالة المتدهورة لا
  // نطبع أي رقم مُخمَّن إطلاقاً — فقط "مسودة" صريحة بلا رقم نهائي، فيستحيل
  // تكرارها بالتعريف بغضّ النظر عمّا يحدث في مكان آخر (راجع تعليق
  // SALES_PRINT_GRACE_MAX_AGE_MS وSALES_DRAFT_INVOICE_NO).
  // لا نعيد الجلب هنا (بخلاف الحفظ) كي تبقى الطباعة داخل إيماءة المستخدم
  // مباشرةً على iOS؛ والفاتورة المحفوظة تكون قد جُلبت لها قراءة طازجة أصلاً
  // لحظة الحفظ، بحدّه الصارم الأصلي دون أي تغيير.
  const printSeries = salesPrintSeriesState(mode);
  if (!printSeries.printUsable) {
    setNotice("error", salesSeriesBlockReason(printSeries));
    render();
    return;
  }
  let invNo;
  if (printSeries.degraded) {
    if (!confirm(salesPrintGraceWarning(printSeries))) return;
    invNo = SALES_DRAFT_INVOICE_NO;
  } else {
    invNo = ensureSalesInvoiceNo();
    if (!invNo) {
      setNotice("error", salesSeriesBlockReason(salesSeriesState(mode)));
      render();
      return;
    }
  }
  const totals = salesTotals();
  const today = new Intl.DateTimeFormat("ar-SA-u-ca-gregory-nu-latn", { dateStyle: "long" }).format(new Date());
  const customer = state.salesCustomer.trim() || "زبون نقدي";
  const payLabel = state.salesPayMethod === "credit" ? "أجل" : "نقدي";
  const curLabel = mode === "mufrak"
    ? `ليرة سورية (SYP) — صرف ${formatMoney(state.syriaExchangeRate)}`
    : "دولار أمريكي (USD)";

  const rowsHtml = resolved
    .map((row, i) => {
      const item = salesItemByKey(row.key);
      const qty = toNumber(row.qty);
      const price = toNumber(row.price);
      return `
    <tr>
      <td class="col-num">${i + 1}</td>
      <td>${escapeHtml(item?.itemName || row.name || "")}</td>
      <td>${escapeHtml(salesUnitLabel(item, row.unit))}</td>
      <td>${escapeHtml(formatMoney(qty))}</td>
      <td class="col-price">${escapeHtml(salesMoney(price, mode))}</td>
      <td class="col-total">${escapeHtml(salesMoney(qty * price, mode))}</td>
    </tr>`;
    })
    .join("");

  const summaryHtml = `
    <tr><td>الإجمالي</td><td class="col-total">${escapeHtml(salesMoney(totals.grand, mode))}</td></tr>
    ${totals.discount > 0 ? `<tr><td>حسم</td><td class="col-total">− ${escapeHtml(salesMoney(totals.discount, mode))}</td></tr>` : ""}
    <tr class="sum-strong"><td>الصافي</td><td class="col-total">${escapeHtml(salesMoney(totals.net, mode))}</td></tr>
    <tr><td>المدفوع (${escapeHtml(payLabel)})</td><td class="col-total">${escapeHtml(salesMoney(totals.paid, mode))}</td></tr>
    <tr class="sum-strong"><td>المتبقّي (${escapeHtml(salesRemainingState(totals.remaining, mode).label)})</td><td class="col-total">${escapeHtml(salesMoney(Math.abs(totals.remaining), mode))}</td></tr>`;

  const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<title>فاتورة مبيعات ${invNo}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Segoe UI', Tahoma, Arial, sans-serif; font-size: 13px; color: #1a1a1a; background: #fff; padding: 40px; direction: rtl; }
  .inv-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 36px; border-bottom: 3px solid #b8860b; padding-bottom: 20px; }
  .inv-company { font-size: 22px; font-weight: 700; color: #5c3d00; letter-spacing: 1px; }
  .inv-company small { display: block; font-size: 12px; font-weight: 400; color: #888; margin-top: 4px; }
  .inv-meta { text-align: left; direction: ltr; }
  .inv-meta p { margin: 3px 0; font-size: 12px; color: #555; }
  .inv-meta strong { color: #1a1a1a; }
  .doc-type { font-size: 14px; font-weight: 700; color: #5c3d00; }
  .inv-num { font-size: 16px; font-weight: 700; color: #b8860b; }
  .inv-customer { background: #faf7f0; border: 1px solid #e8dfc8; border-radius: 6px; padding: 14px 18px; margin-bottom: 28px; display: flex; justify-content: space-between; gap: 12px; }
  .inv-customer p { font-size: 12px; color: #888; margin-bottom: 4px; }
  .inv-customer strong { font-size: 15px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
  th { background: #5c3d00; color: #fff; padding: 10px 12px; text-align: right; font-size: 12px; }
  td { padding: 9px 12px; border-bottom: 1px solid #eee; font-size: 13px; }
  tr:nth-child(even) td { background: #fdf9f3; }
  .col-num { width: 36px; text-align: center; color: #aaa; }
  .col-price, .col-total { text-align: left; direction: ltr; font-family: monospace; }
  .summary-wrap { display: flex; justify-content: flex-start; }
  .summary-table { width: 320px; margin-bottom: 24px; }
  .summary-table td { border-bottom: 1px solid #eee; }
  .summary-table tr:nth-child(even) td { background: transparent; }
  .summary-table .sum-strong td { border-top: 2px solid #b8860b; font-weight: 700; font-size: 14px; background: #faf7f0; }
  .notes { font-size: 12px; color: #666; margin-bottom: 28px; padding: 10px 14px; border-right: 3px solid #b8860b; background: #fdfaf5; }
  .inv-foot { text-align: center; font-size: 11px; color: #aaa; margin-top: 40px; border-top: 1px solid #eee; padding-top: 16px; }
  @media print { body { padding: 24px; } @page { margin: 1.5cm; } }
</style>
</head>
<body>
${salesDraftBannerHtml(invNo)}
<div class="inv-head">
  <div>
    <div class="inv-company">${escapeHtml(appConfig.name)}${appConfig.tagline ? `<small>${escapeHtml(appConfig.tagline)}</small>` : ""}</div>
  </div>
  <div class="inv-meta">
    <p class="doc-type">فاتورة مبيعات</p>
    <p class="inv-num">${escapeHtml(invNo)}</p>
    <p><strong>التاريخ:</strong> ${today}</p>
    <p><strong>طريقة الدفع:</strong> ${escapeHtml(payLabel)}</p>
    <p><strong>العملة:</strong> ${escapeHtml(curLabel)}</p>
  </div>
</div>

<div class="inv-customer">
  <div>
    <p>فاتورة إلى</p>
    <strong>${escapeHtml(customer)}</strong>
  </div>
</div>

<table>
  <thead>
    <tr>
      <th class="col-num">#</th>
      <th>المادة</th>
      <th style="width:70px">الوحدة</th>
      <th style="width:60px">الكمية</th>
      <th style="width:110px" class="col-price">الإفرادي</th>
      <th style="width:120px" class="col-total">الإجمالي</th>
    </tr>
  </thead>
  <tbody>${rowsHtml}</tbody>
</table>

<div class="summary-wrap">
  <table class="summary-table">
    <tbody>${summaryHtml}</tbody>
  </table>
</div>

<div class="inv-foot">
  <div>صفة البيع: ${escapeHtml(SALES_TRADE_CAPACITY)}</div>
  <div>السجل التجاري: <span dir="ltr">${escapeHtml(SALES_TRADE_REGISTER_NO)}</span></div>
  <div>${escapeHtml(appConfig.name)} &mdash; ${escapeHtml(appConfig.supportEmail)}</div>
</div>

</body></html>`;

  // المفرق يُطبع فاتورة كاشير على رول 80mm؛ الجملة تبقى على ورقة A4 كما هي.
  const printable = mode === "mufrak"
    ? salesReceiptDocument({
      invNo,
      dateLabel: today,
      customer,
      payLabel,
      rows: resolved.map((row) => {
        const item = salesItemByKey(row.key);
        const qty = toNumber(row.qty);
        const price = toNumber(row.price);
        return {
          code: salesItemCode(item) || row.num || "",
          name: item?.itemName || row.name || "",
          unit: salesUnitLabel(item, row.unit),
          qty: formatMoney(qty),
          price: salesMoney(price, mode),
          total: salesMoney(qty * price, mode)
        };
      }),
      grand: salesMoney(totals.grand, mode),
      hasDiscount: totals.discount > 0,
      discount: salesMoney(totals.discount, mode),
      net: salesMoney(totals.net, mode),
      paid: salesMoney(totals.paid, mode),
      remaining: salesMoney(Math.abs(totals.remaining), mode),
      remainingLabel: salesRemainingState(totals.remaining, mode).label
    })
    : html;

  // العنوان والأرشفة من كائن واحد: اسم ملف كروم = اسم النسخة في iCloud.
  const salesArchiveMeta = { party: customer, number: invNo, date: todayIsoDate() };
  printHtmlDocument(printable, {
    title: archiveDocumentTitle("invoice", salesArchiveMeta),
    // المسودة (بلا رقم موثوق أثناء تدهور المزامنة) لا تدخل الأرشيف إطلاقاً.
    archive: invNo === SALES_DRAFT_INVOICE_NO ? null : {
      docType: "invoice",
      meta: salesArchiveMeta
    },
    onError: () => {
      setNotice("error", "تعذّر فتح نافذة الطباعة. أغلق التطبيق وافتحه ثم جرّب مجدداً.");
      render();
    }
  });
}

// ===== فواتير المشتريات (مزامنة الأمين — قيد التطوير، لم تُفعَّل بعد) =====
// ملاحظة: الحفظ إلى Supabase فقط. لا مزامنة فعلية مع الأمين حتى تفعيل سكربتات tools/*
// وتطبيق supabase/purchase-invoices-ameen-sync.sql على قاعدة الإنتاج (راجع AI_WORK_SYNC.md).

// يبحث أولاً بقائمة الأسعار المعتمدة (approvedPriceItems)، وإن لم يوجد الصنف هناك
// (مادة تُشترى ولا تُباع للزبائن مثلاً) يبني شكلاً مطابقاً من قطة أصناف الأمين
// بلا أي سعر بيع — poAutoUnitPrice يبقى مصدره الوحيد آخر سعر شراء موثّق.
function poItemByKey(key) {
  if (!key) return null;
  const approved = (state.approvedPriceItems || []).find((item) => item.itemKey === key);
  if (approved) return approved;
  const snap = poSnapshotByKey(key);
  if (!snap) return null;
  return {
    itemKey: snap.itemKey,
    itemName: snap.itemName,
    itemCode: snap.itemNumber,
    itemNumber: snap.itemNumber,
    unit1Name: snap.unit1Name,
    unit2Name: snap.unit2Name,
    unit2Factor: snap.unit2Factor,
    fromSnapshotOnly: true
  };
}

function poSnapshotByKey(key) {
  if (!key) return null;
  return (state.poItemSnapshots || []).find((snap) => snap.itemKey === key) || null;
}

function poItemCode(item) {
  return String((item && (item.itemCode || item.itemNumber)) || "");
}

function poUnitLabel(item, unit) {
  if (!item) return unit === "unit1" ? "كروز" : "كرتونة";
  return unit === "unit1" ? (item.unit1Name || "كروز") : (item.unit2Name || "كرتونة");
}

// السعر التلقائي مصدره حصراً آخر سعر شراء موثّق بقطة أصناف الأمين (ameen_item_snapshot)
// — لا يُستعمل أبداً سعر بيع approved_price_items كسعر شراء. يُشترط تطابق العملة
// ووحدة الشراء الموثّقة تماماً مع سطر الفاتورة، وإلا يبقى الحقل فارغاً لإدخال يدوي.
function poAutoUnitPrice(item, unit, currency) {
  const key = item && item.itemKey;
  const snap = poSnapshotByKey(key);
  if (!snap || snap.lastPurchasePrice == null) return 0;
  if (snap.lastPurchaseCurrency && snap.lastPurchaseCurrency !== currency) return 0;
  if (snap.lastPurchaseUnit && snap.lastPurchaseUnit !== unit) return 0;
  if (!snap.lastPurchaseUnit) return 0;
  return roundPrice(Number(snap.lastPurchasePrice));
}

function poSearchItems(query, limit = 8) {
  const raw = String(query || "").trim();
  if (!raw) return [];
  const approved = state.approvedPriceItems || [];
  const seenKeys = new Set(approved.map((item) => item.itemKey));
  // اتحاد approvedPriceItems (أسعار البيع للمطابقة الاسمية فقط) مع ameen_item_snapshot
  // كي تظهر مواد تُشترى ولا تُباع للزبائن — دون أي سعر بيع مُرفَق بها.
  const snapshotOnly = (state.poItemSnapshots || [])
    .filter((snap) => snap.itemKey && !seenKeys.has(snap.itemKey))
    .map((snap) => ({
      itemKey: snap.itemKey,
      itemName: snap.itemName,
      itemCode: snap.itemNumber,
      itemNumber: snap.itemNumber,
      unit1Name: snap.unit1Name,
      unit2Name: snap.unit2Name,
      unit2Factor: snap.unit2Factor,
      fromSnapshotOnly: true
    }));
  const list = [...approved, ...snapshotOnly];
  if (!list.length) return [];
  const normalizedQuery = normalizeItemName(raw);
  const digits = raw.replace(/[^0-9]/g, "");
  const scored = [];
  for (const item of list) {
    const numbers = [String(item.itemCode || ""), String(item.itemNumber || "")].filter(Boolean);
    const normalizedName = normalizeItemName(item.itemName || "");
    let score = -1;
    if (digits) {
      for (const number of numbers) {
        if (number === digits) score = Math.max(score, 100);
        else if (number.startsWith(digits)) score = Math.max(score, 92);
        else if (number.includes(digits)) score = Math.max(score, 74);
      }
    }
    if (normalizedQuery) {
      if (normalizedName === normalizedQuery) score = Math.max(score, 96);
      else if (normalizedName.startsWith(normalizedQuery)) score = Math.max(score, 86);
      else if (normalizedName.includes(normalizedQuery)) score = Math.max(score, 62);
    }
    if (score >= 0) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score || String(a.item.itemName || "").localeCompare(String(b.item.itemName || ""), "ar"));
  return scored.slice(0, limit).map((entry) => entry.item);
}

function poSuggestionsHtml(rowIndex, query) {
  const matches = poSearchItems(query, 8);
  if (!matches.length) return "";
  return matches
    .map((item) => {
      const code = poItemCode(item);
      const number = code
        ? `<span class="sales-suggest-num" dir="ltr">${escapeHtml(code)}</span>`
        : `<span class="sales-suggest-num muted">—</span>`;
      const auto = poAutoUnitPrice(item, "unit2", state.poCurrency);
      const priceHint = auto > 0
        ? `<span class="sales-suggest-price" dir="ltr">${escapeHtml(auto.toFixed(2))}</span>`
        : `<span class="sales-suggest-price muted">بلا سعر تلقائي</span>`;
      return `<button type="button" class="sales-suggest-item" data-po-pick="${escapeHtml(item.itemKey)}" data-po-row="${rowIndex}">${number}<span class="sales-suggest-name">${escapeHtml(item.itemName)}</span>${priceHint}</button>`;
    })
    .join("");
}

function poRowComputed(row) {
  return window.poCalc.poRowComputed(row);
}

function poTotals() {
  return window.poCalc.poTotals(state.poRows);
}

function poRemaining(total) {
  const paidAmount = state.poRegisterPayment ? toNumber(state.poPaymentAmount) : 0;
  return window.poCalc.poRemainingState({ total, paidAmount });
}

function poRemainingLabel(status) {
  if (status === "due") return "متبقٍّ للمورد";
  if (status === "over") return "مدفوع زيادة";
  return "مسدّدة بالكامل";
}

function poEnsureTrailingRow() {
  const rows = state.poRows;
  const last = rows[rows.length - 1];
  if (last && (last.key || (last.q || "").trim())) {
    rows.push({ q: "", key: "", name: "", num: "", unit: "unit2", qty: "1", price: "", edited: false });
  }
}

function poFocusField(rowIndex, field) {
  const focusNow = () => {
    const el = document.querySelector(`[data-po-field="${field}"][data-po-index="${rowIndex}"]`);
    if (!el) return false;
    el.focus();
    if (typeof el.select === "function") el.select();
    return true;
  };
  if (focusNow()) return;
  requestAnimationFrame(focusNow);
}

function poPickItem(rowIndex, key) {
  const row = state.poRows[rowIndex];
  const item = poItemByKey(key);
  if (!row || !item) return;
  row.key = item.itemKey;
  row.name = item.itemName;
  row.num = poItemCode(item);
  row.q = window.poCalc.poItemDisplayLabel(row.num, row.name);
  if (row.unit !== "unit1" && row.unit !== "unit2") row.unit = "unit2";
  const auto = poAutoUnitPrice(item, row.unit, state.poCurrency);
  row.price = auto > 0 ? String(auto) : "";
  row.edited = false;
  if (!(toNumber(row.qty) > 0)) row.qty = "1";
  poEnsureTrailingRow();
  render();
  poFocusField(rowIndex, "qty");
}

function poToggleUnit(rowIndex) {
  const row = state.poRows[rowIndex];
  if (!row || !row.key) return;
  const item = poItemByKey(row.key);
  row.unit = row.unit === "unit1" ? "unit2" : "unit1";
  const auto = poAutoUnitPrice(item, row.unit, state.poCurrency);
  row.price = auto > 0 ? String(auto) : "";
  row.edited = false;
  render();
}

function poAddSuggestedItem(key) {
  const item = poItemByKey(key);
  if (!item) return;
  if (state.poRows.some((r) => r.key === key)) {
    setNotice("error", "هذا الصنف موجود بالفعل في الفاتورة.");
    render();
    return;
  }
  const emptyIdx = state.poRows.findIndex((r) => !r.key && !(r.q || "").trim());
  const targetIdx = emptyIdx >= 0 ? emptyIdx : state.poRows.length;
  if (emptyIdx < 0) state.poRows.push({ q: "", key: "", name: "", num: "", unit: "unit2", qty: "1", price: "", edited: false });
  poPickItem(targetIdx, key);
}

// أصناف مقترحة: أعلى حركة مبيعات آخر 30 يوماً من قطة أصناف الأمين (poItemSnapshots)،
// مستبعَد منها ما هو موجود بالفاتورة حالياً. القطة فارغة عملياً حتى تفعيل سكربت
// tools/push-purchase-item-snapshot.ps1 — فتظهر حينها رسالة حالة فارغة بدل بيانات وهمية.
function poSuggestedItemsHtml() {
  const usedKeys = new Set(state.poRows.map((r) => r.key).filter(Boolean));
  const ranked = (state.poItemSnapshots || [])
    .filter((snap) => snap.itemKey && !usedKeys.has(snap.itemKey) && (snap.movementRank != null || snap.unitsSold30d != null))
    .sort((a, b) => {
      const rankA = a.movementRank != null ? a.movementRank : Number.MAX_SAFE_INTEGER;
      const rankB = b.movementRank != null ? b.movementRank : Number.MAX_SAFE_INTEGER;
      if (rankA !== rankB) return rankA - rankB;
      return (b.unitsSold30d || 0) - (a.unitsSold30d || 0);
    })
    .slice(0, 8);
  if (!ranked.length) {
    return '<p class="muted" style="margin:6px 2px 0">لا توجد بيانات حركة مبيعات كافية بعد (تحتاج تفعيل تقرير قطة أصناف الأمين).</p>';
  }
  return `<div class="po-suggested-items">${ranked
    .map((snap) => `<button type="button" class="po-suggested-chip" data-po-suggest-add="${escapeHtml(snap.itemKey)}">+ ${escapeHtml(snap.itemName)}${snap.unitsSold30d != null ? ` <small>(${escapeHtml(String(Math.round(snap.unitsSold30d)))} خلال 30 يوماً)</small>` : ""}</button>`)
    .join("")}</div>`;
}

function poInfoCard() {
  const key = state.poInfoKey;
  if (!key) return "";
  const item = poItemByKey(key);
  const snap = poSnapshotByKey(key);
  const na = '<span class="muted">غير متوفر</span>';
  const factor = (item && item.unit2Factor) || (snap && snap.unit2Factor) || 1;
  const stockU1 = snap && snap.stockUnit1 != null ? snap.stockUnit1 : null;
  const stockU2 = stockU1 != null && factor > 0 ? poCalc.poRound2(stockU1 / factor) : null;
  const lastPrice = snap && snap.lastPurchasePrice != null
    ? `${snap.lastPurchasePrice.toFixed(2)} ${escapeHtml(snap.lastPurchaseCurrency || "")}`
    : null;
  const avgCost = snap && snap.averageCost != null
    ? `${snap.averageCost.toFixed(2)} ${escapeHtml(snap.averageCostCurrency || "")}${snap.averageCostBasis ? ` (${escapeHtml(snap.averageCostBasis)})` : ""}`
    : null;
  return `
    <div class="po-info-panel">
      <dl>
        <dt>الصنف</dt><dd>${escapeHtml((item && item.itemName) || (snap && snap.itemName) || key)}</dd>
        <dt>المخزون</dt><dd>${stockU1 != null ? `${escapeHtml(String(stockU1))} ${escapeHtml(poUnitLabel(item, "unit1"))} (${escapeHtml(String(stockU2))} ${escapeHtml(poUnitLabel(item, "unit2"))})` : na}</dd>
        <dt>عامل التحويل</dt><dd>1 ${escapeHtml(poUnitLabel(item, "unit2"))} = ${escapeHtml(String(factor))} ${escapeHtml(poUnitLabel(item, "unit1"))}</dd>
        <dt>آخر سعر شراء</dt><dd>${lastPrice || na}${snap && snap.lastPurchaseDate ? ` — ${escapeHtml(snap.lastPurchaseDate)}` : ""}</dd>
        <dt>متوسط التكلفة</dt><dd>${avgCost || na}</dd>
        <dt>آخر مورّد</dt><dd>${snap && snap.lastSupplierName ? escapeHtml(snap.lastSupplierName) : na}</dd>
      </dl>
      ${!state.poItemSnapshotsAt ? '<p class="muted" style="margin:8px 0 0;font-size:12px">لم تُفعَّل بعد تغذية بيانات الأمين لهذا الصنف (تقرير قطة الأصناف).</p>' : ""}
    </div>
  `;
}

function poSupplierHistory() {
  const map = new Map();
  (state.purchaseInvoices || []).forEach((po) => {
    if (!po.supplierName) return;
    const key = normalizeItemName(po.supplierName);
    if (!map.has(key)) map.set(key, { name: po.supplierName, guid: po.supplierAmeenGuid || "", code: po.supplierAmeenCode || "" });
  });
  return [...map.values()];
}

function poSupplierSuggestionsHtml(query) {
  const raw = String(query || "").trim();
  if (!raw) return "";
  const normalizedQuery = normalizeItemName(raw);
  const matches = poSupplierHistory()
    .filter((s) => normalizeItemName(s.name).includes(normalizedQuery))
    .slice(0, 6);
  if (!matches.length) return "";
  return matches
    .map((s) => `<button type="button" class="sales-suggest-item" data-po-supplier-pick="${escapeHtml(s.name)}" data-po-supplier-guid="${escapeHtml(s.guid)}" data-po-supplier-code="${escapeHtml(s.code)}"><span class="sales-suggest-name">${escapeHtml(s.name)}</span></button>`)
    .join("");
}

function poPickSupplier(name, guid, code) {
  state.poSupplierQuery = name;
  state.poSupplierGuid = guid || "";
  state.poSupplierKey = code || "";
  render();
}

function poStatusChipHtml(status) {
  const label = (poCalc.PO_STATUS_LABELS && poCalc.PO_STATUS_LABELS[status]) || status;
  const cls = status === "synced" ? "chip-closed"
    : status === "failed" ? "chip-danger"
    : status === "sync_pending" ? "chip-progress"
    : status === "approved" ? "chip-ready"
    : "chip-new";
  return `<span class="status-chip ${cls}">${escapeHtml(label)}</span>`;
}

function refreshPoTotals() {
  const currencySym = state.poCurrency === "SYP" ? "ل.س" : "$";
  (state.poRows || []).forEach((row, i) => {
    const cell = document.querySelector(`[data-po-linetotal="${i}"]`);
    if (!cell) return;
    cell.textContent = row.key ? poRowComputed(row).lineTotal.toFixed(2) : "—";
  });
  const totals = poTotals();
  const totalEl = document.querySelector("[data-po-total]");
  if (totalEl) totalEl.textContent = `${totals.grand.toFixed(2)} ${currencySym}`;
  const remainingState = poRemaining(totals.grand);
  const remainingEl = document.querySelector("[data-po-remaining]");
  if (remainingEl) remainingEl.textContent = `${Math.abs(remainingState.remaining).toFixed(2)} ${currencySym}`;
  const remainingBox = document.querySelector("[data-po-remaining-box] span");
  if (remainingBox) remainingBox.textContent = poRemainingLabel(remainingState.status);
  if (state.poRegisterPayment && state.poPayMethod === "cash") {
    const paidInput = document.getElementById("po-payment-amount");
    if (paidInput) paidInput.value = totals.grand.toFixed(2);
    state.poPaymentAmount = totals.grand.toFixed(2);
  }
}

// ===== فواتير مشتريات الأمين — عرض قراءة فقط (بيانات pull-purchase-invoices-from-ameen.ps1) =====

function poAmeenSuppliers() {
  const items = (state.poAmeenReport && state.poAmeenReport.items) || [];
  return items.map((entry) => entry.name).filter(Boolean);
}

function poAmeenSupplierSuggestionsHtml(query) {
  const matches = poCalc.poAmeenSupplierMatches(query, poAmeenSuppliers());
  if (!matches.length) return "";
  return matches.map((name) => `
    <button type="button" class="sales-suggest-item" data-po-ameen-supplier-pick="${escapeHtml(name)}">${escapeHtml(name)}</button>
  `).join("");
}

function poAmeenSelectedSupplierInvoices() {
  const items = (state.poAmeenReport && state.poAmeenReport.items) || [];
  const entry = items.find((e) => e.name === state.poAmeenSupplierName);
  return (entry && entry.invoices) || [];
}

function poAmeenCurrentInvoice() {
  const invoices = poAmeenSelectedSupplierInvoices();
  if (!invoices.length) return null;
  const idx = poCalc.poAmeenClampNavIndex(invoices.length, state.poAmeenNavIndex, 0);
  return invoices[idx] || null;
}

function poAmeenPickSupplier(name) {
  state.poAmeenSupplierName = name;
  state.poAmeenSupplierQuery = name;
  state.poAmeenNavIndex = 0;
  state.poAmeenItemQuery = "";
  render();
}

function poAmeenNavigate(direction) {
  const invoices = poAmeenSelectedSupplierInvoices();
  state.poAmeenNavIndex = poCalc.poAmeenClampNavIndex(invoices.length, state.poAmeenNavIndex, direction);
  render();
}

function poAmeenItemsRowsHtml(invoice, query) {
  const filteredItems = invoice ? poCalc.poAmeenItemMatches(query, invoice.items || []) : [];
  return filteredItems.map((item) => `
    <tr>
      <td>${escapeHtml(poCalc.poItemDisplayLabel(item.itemNumber, item.itemName))}</td>
      <td class="inv-num">${escapeHtml(String(item.qty ?? "—"))}</td>
      <td>${escapeHtml(item.unit || "—")}</td>
      <td class="inv-line-total">${item.lastPrice != null ? Number(item.lastPrice).toFixed(2) : "—"}</td>
      <td class="inv-line-total">${item.avgPrice != null ? Number(item.avgPrice).toFixed(2) : "—"}</td>
    </tr>
  `).join("") || `<tr><td colspan="5" class="muted">لا توجد بنود مطابقة.</td></tr>`;
}

function poAmeenPanelHtml() {
  const report = state.poAmeenReport;
  if (!report) {
    return `
      <section class="panel wide" style="margin-top:16px">
        <h2 style="margin:0">فواتير مشتريات الأمين (قراءة فقط)</h2>
        <p class="muted">لا يوجد تقرير محفوظ بعد. يُعبَّأ هذا القسم تلقائياً بعد أول تشغيل لسكربت <code>pull-purchase-invoices-from-ameen.ps1</code> على جهاز Windows.</p>
      </section>
    `;
  }

  const invoices = poAmeenSelectedSupplierInvoices();
  const invoice = poAmeenCurrentInvoice();
  const idx = invoices.length ? poCalc.poAmeenClampNavIndex(invoices.length, state.poAmeenNavIndex, 0) : 0;
  const currencySym = invoice && invoice.currency === "SYP" ? "ل.س"
    : invoice && invoice.currency === "USD" ? "$"
    : invoice ? "؟" : "$";

  const itemsRows = poAmeenItemsRowsHtml(invoice, state.poAmeenItemQuery);

  return `
    <section class="panel wide" style="margin-top:16px">
      <div class="panel-title-row">
        <h2 style="margin:0">فواتير مشتريات الأمين (قراءة فقط)</h2>
        ${report.report_date ? `<small class="muted">آخر تحديث: ${escapeHtml(report.report_date)}</small>` : ""}
      </div>

      <label class="inv-label po-suggest-wrap">
        اسم المورد
        <input class="inv-input-main" id="po-ameen-supplier" value="${escapeHtml(state.poAmeenSupplierQuery)}" placeholder="ابحث باسم المورد…" autocomplete="off">
        <div class="sales-suggest-box" data-po-ameen-supplier-suggest></div>
      </label>

      ${invoice ? `
        <div class="inv-header-fields" style="margin-top:12px;align-items:center">
          <button type="button" class="button secondary compact-button" data-po-ameen-nav="prev" ${idx >= invoices.length - 1 ? "disabled" : ""}>◀ فاتورة سابقة</button>
          <strong>${escapeHtml(invoice.number || "—")} — ${escapeHtml(invoice.date || "")} (${idx + 1}/${invoices.length})</strong>
          <button type="button" class="button secondary compact-button" data-po-ameen-nav="next" ${idx <= 0 ? "disabled" : ""}>فاتورة تالية ▶</button>
        </div>

        <p class="muted" style="margin:8px 4px">
          الإجمالي: ${Number(invoice.total || 0).toFixed(2)} ${currencySym}
          · ${invoice.payMethod === "cash" ? "نقدي" : invoice.payMethod === "credit" ? "آجل" : "طريقة الدفع غير محددة"}
          · الدفعة المسجلة: ${invoice.paidAmount != null ? Number(invoice.paidAmount).toFixed(2) : "—"} ${currencySym}
          · المستودع: <strong>${escapeHtml(invoice.warehouseName || "غير محدد")}</strong>
          ${invoice.isReturn ? "· <strong>مرتجع مشتريات</strong>" : ""}
        </p>

        <label class="inv-label">
          بحث ضمن بنود الفاتورة (رقم أو اسم المادة)
          <input class="inv-input-main" id="po-ameen-item-query" value="${escapeHtml(state.poAmeenItemQuery)}" placeholder="مثال: 0005 أو اسم المادة" autocomplete="off">
        </label>

        <div class="inv-table-wrap" style="margin-top:8px">
          <table class="inv-table">
            <thead>
              <tr>
                <th>الصنف</th>
                <th style="width:90px">الكمية</th>
                <th style="width:90px">الوحدة</th>
                <th style="width:130px">آخر تكلفة للوحدة الأساسية</th>
                <th style="width:130px">متوسط تكلفة الوحدة الأساسية للفترة</th>
              </tr>
            </thead>
            <tbody data-po-ameen-items-body>${itemsRows}</tbody>
          </table>
        </div>
        <p class="muted" style="margin:6px 4px;font-size:0.85em">
          آخر تكلفة/متوسط تكلفة للوحدة الأساسية للمادة (وليس سعر الوحدة المختارة بعمود
          «الوحدة» أعلاه)، محسوبان من فواتير الأمين الفعلية المسحوبة${report.summary && report.summary.periodDays ? ` لآخر ${escapeHtml(String(report.summary.periodDays))} يوماً` : ""}
          مع استبعاد مرتجعات المشتريات من المتوسط (تقريب، وليس رقماً محاسبياً مضموناً 100%).
        </p>
      ` : state.poAmeenSupplierName
        ? `<p class="muted" style="margin-top:12px">لا توجد فواتير مسجّلة لهذا المورد.</p>`
        : `<p class="muted" style="margin-top:12px">اختر مورداً من الاقتراحات لعرض فواتيره.</p>`}
    </section>
  `;
}

function warehouses() {
  if (!state.session) {
    return shell(`<section class="panel"><h2>المستودعات والمناقلات</h2><p class="muted">سجّل الدخول أولاً.</p></section>`);
  }
  const warehousesList = state.reconWarehouses || [];
  const selected = warehousesList.find((w) => w.warehouseKey === state.warehouseSelectedKey) || warehousesList[0];
  const report = selected ? state.warehouseReports[selected.warehouseKey] : null;
  const rawItems = report && Array.isArray(report.items) ? report.items : [];
  const query = normalizeItemName(state.warehouseSearch);
  const visibleItems = rawItems
    .map((item) => ({
      itemKey: item.itemKey || item.item_key || "",
      itemName: item.itemName || item.item_name || "",
      itemNumber: item.itemNumber || item.item_number || "",
      unitName: item.unitName || item.unit_name || "",
      qty: Number(item.qty ?? 0)
    }))
    .filter((item) => state.warehouseShowZero || Math.abs(item.qty) > 0.0001)
    .filter((item) => !query || normalizeItemName(`${item.itemNumber} ${item.itemName}`).includes(query))
    .sort((a, b) => b.qty - a.qty || a.itemName.localeCompare(b.itemName, "ar"));

  const warehouseCards = warehousesList.map((warehouse) => {
    const warehouseReport = state.warehouseReports[warehouse.warehouseKey];
    const items = warehouseReport && Array.isArray(warehouseReport.items) ? warehouseReport.items : [];
    const stocked = items.filter((item) => Math.abs(Number(item.qty ?? 0)) > 0.0001).length;
    const active = warehouse.warehouseKey === selected?.warehouseKey ? "primary" : "secondary";
    return `<button class="button ${active}" type="button" data-warehouse-pick="${escapeHtml(warehouse.warehouseKey)}">
      ${escapeHtml(warehouse.warehouseName)} <small>(${stocked} صنف متوفر)</small>
    </button>`;
  }).join("");

  const stockRows = visibleItems.map((item) => `<tr>
    <td>${escapeHtml(item.itemNumber || "—")}</td>
    <td>${escapeHtml(item.itemName)}</td>
    <td>${escapeHtml(item.unitName || "—")}</td>
    <td class="inv-num"><strong>${escapeHtml(item.qty.toFixed(3).replace(/\.000$/, ""))}</strong></td>
  </tr>`).join("") || `<tr><td colspan="4" class="muted">لا توجد أصناف مطابقة للبحث.</td></tr>`;

  const transfers = state.warehouseTransferReport && Array.isArray(state.warehouseTransferReport.items)
    ? state.warehouseTransferReport.items
    : [];
  const relatedTransfers = selected
    ? transfers.filter((transfer) => {
      const selectedKey = String(selected.warehouseKey).toLowerCase();
      return String(transfer.sourceWarehouseGuid || "").toLowerCase() === selectedKey
        || String(transfer.destinationWarehouseGuid || "").toLowerCase() === selectedKey;
    })
    : transfers;
  const transferCards = relatedTransfers.slice(0, 100).map((transfer) => {
    const itemRows = (transfer.items || []).map((item) => `<tr>
      <td>${escapeHtml(item.itemNumber || "—")}</td><td>${escapeHtml(item.itemName || "")}</td>
      <td>${escapeHtml(item.unitName || "—")}</td><td class="inv-num">${escapeHtml(String(item.qty ?? 0))}</td>
    </tr>`).join("");
    return `<details class="acc-group">
      <summary class="acc-summary">
        <span class="acc-title">${escapeHtml(transfer.date || "")} · #${escapeHtml(transfer.number || "—")} · من ${escapeHtml(transfer.sourceWarehouseName || "؟")} إلى ${escapeHtml(transfer.destinationWarehouseName || "؟")}</span>
        <span class="acc-count">${escapeHtml(String(transfer.itemCount ?? (transfer.items || []).length))}</span>
      </summary>
      <div class="acc-body"><div class="inv-table-wrap"><table class="inv-table">
        <thead><tr><th>الكود</th><th>الصنف</th><th>الوحدة</th><th>الكمية</th></tr></thead>
        <tbody>${itemRows}</tbody>
      </table></div></div>
    </details>`;
  }).join("") || `<p class="muted">لا يوجد تقرير مناقلات لهذا المستودع بعد.</p>`;

  const purchaseGroups = state.poAmeenReport && Array.isArray(state.poAmeenReport.items) ? state.poAmeenReport.items : [];
  const allPurchases = purchaseGroups.flatMap((supplier) =>
    (supplier.invoices || []).map((invoice) => ({ ...invoice, supplierName: supplier.name || "" })))
  const unassignedPurchases = allPurchases.filter((invoice) => !invoice.warehouseGuid || Number(invoice.warehouseCount || 0) !== 1);
  const warehousePurchases = selected ? allPurchases
    .filter((invoice) => String(invoice.warehouseGuid || "").toLowerCase() === String(selected.warehouseKey).toLowerCase())
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || ""))) : [];
  const purchaseCards = warehousePurchases.slice(0, 100).map((invoice) => `<details class="acc-group">
    <summary class="acc-summary">
      <span class="acc-title">${escapeHtml(invoice.date || "")} · #${escapeHtml(invoice.number || "—")} · ${escapeHtml(invoice.supplierName)}${invoice.isReturn ? " · مرتجع" : ""}</span>
      <span class="acc-count">${escapeHtml(String((invoice.items || []).length))}</span>
    </summary>
    <div class="acc-body">
      <p class="muted">المستودع: ${escapeHtml(invoice.warehouseName || selected?.warehouseName || "غير محدد")} · الإجمالي: ${escapeHtml(String(invoice.total ?? 0))} ${escapeHtml(invoice.currency || "")}</p>
      <div class="inv-table-wrap"><table class="inv-table"><thead><tr><th>الكود</th><th>الصنف</th><th>الوحدة</th><th>الكمية</th></tr></thead>
      <tbody>${(invoice.items || []).map((item) => `<tr><td>${escapeHtml(item.itemNumber || "—")}</td><td>${escapeHtml(item.itemName || "")}</td><td>${escapeHtml(item.unit || "—")}</td><td class="inv-num">${escapeHtml(String(item.qty ?? 0))}</td></tr>`).join("")}</tbody>
      </table></div>
    </div>
  </details>`).join("") || `<p class="muted">${state.poAmeenReport ? "لا توجد فواتير شراء لهذا المستودع ضمن الفترة المتزامنة." : "بيانات فواتير الشراء محمية وتظهر فقط للحساب المخوّل بعد مزامنة التقرير."}</p>`;

  return shell(`
    <section class="panel wide">
      <div class="panel-title-row">
        <div><h2 style="margin:0">المخزون حسب المستودع</h2><p class="muted" style="margin:4px 0 0">قراءة مباشرة متزامنة من Ameen؛ لا يمكن تعديل الكميات من هذه الصفحة.</p></div>
        <button class="button secondary" type="button" data-action="warehouse-refresh" ${state.warehouseLoading ? "disabled" : ""}>${state.warehouseLoading ? "جاري التحديث…" : "↻ تحديث"}</button>
      </div>
      <div class="inv-actions" style="margin-top:12px">${warehouseCards || '<span class="muted">لا توجد تقارير مستودعات بعد.</span>'}</div>
      ${selected ? `
        <div class="inv-header-fields" style="margin-top:14px">
          <label class="inv-label">بحث ضمن ${escapeHtml(selected.warehouseName)}
            <input id="warehouse-search" class="inv-input-main" value="${escapeHtml(state.warehouseSearch)}" placeholder="اسم الصنف أو الكود" autocomplete="off">
          </label>
          <label class="inv-label" style="justify-content:flex-end"><span><input id="warehouse-show-zero" type="checkbox" ${state.warehouseShowZero ? "checked" : ""}> إظهار الأصناف ذات الرصيد صفر</span></label>
        </div>
        <p class="muted">آخر مزامنة: ${escapeHtml(formatDateTime((report?.summary && report.summary.generated_at) || report?.created_at))} · المعروض ${visibleItems.length} من ${rawItems.length}</p>
        <div class="inv-table-wrap"><table class="inv-table">
          <thead><tr><th>الكود</th><th>الصنف</th><th>الوحدة</th><th>الرصيد</th></tr></thead>
          <tbody>${stockRows}</tbody>
        </table></div>
      ` : ""}
    </section>
    <section class="panel wide" style="margin-top:16px">
      <div class="panel-title-row"><h2 style="margin:0">المشتريات الداخلة إلى ${escapeHtml(selected?.warehouseName || "المستودع")}</h2>
        <small class="muted">${warehousePurchases.length} فاتورة ضمن التقرير المتزامن</small>
      </div>
      ${unassignedPurchases.length ? `<div class="notice-panel warning" style="margin-top:12px">⚠ ${unassignedPurchases.length} فاتورة في التقرير مستودعها غير محدد أو متعدد؛ لم تُخفَ من البيانات لكنها لا تُنسب إلى مستودع واحد حتى تُراجع.</div>` : ""}
      <div style="margin-top:12px">${purchaseCards}</div>
    </section>
    <section class="panel wide" style="margin-top:16px">
      <div class="panel-title-row"><h2 style="margin:0">المناقلات المرتبطة بـ${escapeHtml(selected?.warehouseName || "المستودعات")}</h2>
        <small class="muted">${relatedTransfers.length} مناقلة · آخر تقرير ${escapeHtml(formatDateTime(state.warehouseTransferReport?.created_at))}</small>
      </div>
      <div style="margin-top:12px">${transferCards}</div>
    </section>
  `);
}

// ===== الجرد الشهري (route: inventoryRecon) =====
// تسجيلي فقط: اعتماد الجلسة يقفلها (status) ولا يكتب أي مخزون أو قيد فعلي
// بالأمين أو Supabase — انظر tools/push-inventory-reconciliation-to-ameen.ps1 (stub مقفل).

function reconUnitCostFor(item) {
  const row = itemCostFor({ name: item?.itemName, key: item?.itemKey });
  return Number(row?.avg_cost || 0);
}

function reconSearchItems(query, limit = 8) {
  const raw = String(query || "").trim();
  if (!raw) return [];
  // الأصناف تُقتَرح حصراً من تقرير مخزون المستودع المختار — لا رجوع لمخزون النشرة العام،
  // كي لا يُضاف صنف بكمية أو من مستودع لا ينتمي إليه فعلاً.
  const list = Array.isArray(state.reconWarehouseStockItems) ? state.reconWarehouseStockItems : [];
  const already = new Set((state.reconRows || []).map((r) => r.itemKey));
  return list
    .filter((item) => item.itemKey && !already.has(item.itemKey) && window.invRecCalc.itemMatches({ itemName: item.itemName, itemNumber: item.itemNumber }, raw))
    .slice(0, limit);
}

function reconSuggestionsHtml(query) {
  const matches = reconSearchItems(query, 8);
  if (!matches.length) return "";
  return matches
    .map((item) => {
      const code = String(item.itemCode || item.itemNumber || "");
      const numHtml = code
        ? `<span class="sales-suggest-num" dir="ltr">${escapeHtml(code)}</span>`
        : `<span class="sales-suggest-num muted">—</span>`;
      return `<button type="button" class="sales-suggest-item" data-recon-pick="${escapeHtml(item.itemKey)}">${numHtml}<span class="sales-suggest-name">${escapeHtml(item.itemName)}</span></button>`;
    })
    .join("");
}

function reconAddItem(key) {
  const list = Array.isArray(state.reconWarehouseStockItems) ? state.reconWarehouseStockItems : [];
  const item = list.find((it) => it.itemKey === key);
  if (!item) return; // لا وجود لهذا الصنف بتقرير مخزون المستودع المختار
  if ((state.reconRows || []).some((r) => r.itemKey === key)) return;
  const unitCost = reconUnitCostFor(item);
  state.reconRows.push({
    itemKey: item.itemKey,
    itemNumber: item.itemNumber || "",
    itemName: item.itemName,
    unitName: item.unitName || "كروز",
    systemQty: item.qty, // من تقرير مخزون المستودع الموثوق حصراً
    systemQtySource: "warehouse",
    actualQty: "",
    unitCost,
    reason: ""
  });
  state.reconRowQuery = "";
  render();
}

function reconRemoveRow(key) {
  state.reconRows = (state.reconRows || []).filter((r) => r.itemKey !== key);
  render();
}

function reconRowComputed(row) {
  return window.invRecCalc.lineComputed(row);
}

function reconSummary() {
  return window.invRecCalc.sessionSummary(state.reconRows);
}

function reconCurrentStatus() {
  const open = (state.reconSessions || []).find((s) => s.id === state.reconOpenId);
  return open ? open.status : "draft";
}

function reconResetForm() {
  state.reconSessionDate = "";
  state.reconSessionMonth = "";
  state.reconNotes = "";
  state.reconRows = [];
  state.reconRowQuery = "";
  state.reconOpenId = "";
}

async function reconSaveDraft() {
  if (!Array.isArray(state.reconWarehouseStockItems) || !state.reconWarehouseStockItems.length) {
    toast("لا يتوفر تقرير مخزون موثوق لهذا المستودع بعد — لا يمكن حفظ الجرد.");
    return;
  }
  if (!state.reconWarehouseStockReportId) {
    toast("تعذّر تحديد تقرير مخزون المستودع الموثوق — أعد تحميل الصفحة وحاول من جديد.");
    return;
  }
  {
    const minutes = minutesSince(state.reconWarehouseStockGeneratedAt);
    if (minutes !== null && minutes > 24 * 60) {
      toast("تقرير مخزون هذا المستودع قديم — شغّل رفع مخزون المستودعات من الأمين قبل الحفظ.");
      return;
    }
  }
  if (!state.reconRows.length) {
    toast("أضف صنفاً واحداً على الأقل قبل الحفظ.");
    return;
  }
  if (state.reconSaving) return;
  state.reconSaving = true;
  render();
  try {
    const month = state.reconSessionMonth || todayIsoDate().slice(0, 7) + "-01";
    const sessionDate = state.reconSessionDate || todayIsoDate();
    const userId = state.session?.id || "";
    const pendingKey = reconPendingSaveKey(userId);
    // نفس idempotency key يُعاد استعماله عبر إعادة المحاولة (فشل الشبكة، فقدان
    // الرد، إعادة تحميل الصفحة) طالما محتوى المسودة (بصمة JSON، بما فيها
    // المستخدم وتقرير المخزون المصدر) لم يتغيّر — يمنع تكرار الجلسة على
    // الخادم؛ يُولَّد مفتاح جديد فقط عند تغيّر فعلي بالمحتوى، ويُحذف المفتاح
    // المحفوظ محلياً فقط بعد نجاح الحفظ فعلياً.
    const fingerprint = window.invRecCalc.buildDraftFingerprint({
      userId,
      sourceReportId: state.reconWarehouseStockReportId,
      warehouseKey: state.reconWarehouseKey,
      sessionDate,
      sessionMonth: month,
      notes: state.reconNotes,
      rows: state.reconRows
    });
    const pending = readJson(pendingKey, null);
    let idempotencyKey;
    if (pending && pending.fingerprint === fingerprint && pending.idempotencyKey) {
      idempotencyKey = pending.idempotencyKey;
    } else {
      const nonce = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      idempotencyKey = window.invRecCalc.buildIdempotencyKey(state.reconWarehouseKey, month, nonce);
      writeJson(pendingKey, { fingerprint, idempotencyKey });
    }
    await dataStore.createReconSessionWithLines({
      warehouseKey: state.reconWarehouseKey,
      warehouseName: state.reconWarehouseName,
      sessionDate,
      sessionMonth: month,
      notes: state.reconNotes,
      idempotencyKey,
      sourceReportId: state.reconWarehouseStockReportId
    }, state.reconRows);
    localStorage.removeItem(pendingKey);
    toast("تم حفظ مسودة الجرد.");
    reconResetForm();
    await loadReconSessions();
  } catch (err) {
    toast("تعذّر حفظ الجرد: " + (err?.message || "خطأ غير معروف"));
  } finally {
    state.reconSaving = false;
    render();
  }
}

async function reconSetStatus(session, nextStatus) {
  if (!window.invRecCalc.canTransitionStatus(session.status, nextStatus)) return;
  if (nextStatus !== "draft") {
    const check = window.invRecCalc.validateForReview(session.lines || []);
    if (!check.ok) {
      toast(`أكمل سبب الفرق لعدد ${check.missingReasonCount} صنف قبل المتابعة.`);
      return;
    }
  }
  state.reconSaving = true;
  render();
  try {
    await dataStore.setReconSessionStatus(session.id, nextStatus, session.status);
    toast(nextStatus === "approved" ? "تم اعتماد الجرد (تسجيلي فقط، بلا أثر على المخزون)." : "تم تحديث حالة الجرد.");
    await loadReconSessions();
  } catch (err) {
    toast("تعذّر تحديث الحالة: " + (err?.message || "خطأ غير معروف"));
  } finally {
    state.reconSaving = false;
    render();
  }
}

async function reconDeleteDraft(session) {
  if (!session || session.status !== "draft") return;
  if (!confirm("حذف مسودة الجرد هذا نهائياً؟ لا يمكن التراجع.")) return;
  state.reconSaving = true;
  render();
  try {
    await dataStore.deleteReconDraft(session.id);
    if (state.reconOpenId === session.id) state.reconOpenId = "";
    toast("تم حذف مسودة الجرد.");
    await loadReconSessions();
  } catch (err) {
    toast("تعذّر حذف المسودة: " + (err?.message || "خطأ غير معروف"));
  } finally {
    state.reconSaving = false;
    render();
  }
}

function reconStatusLabel(status) {
  if (status === "approved") return "معتمد";
  if (status === "reviewed") return "قيد المراجعة";
  return "مسودة";
}

const RECON_SOURCE_REPORT_MAX_AGE_DAYS = 3;

// عمر تقرير المخزون المصدر بالأيام بين وقته ووقت جلسة الجرد نفسها — لا بـ"الآن"،
// لأن فتح جلسة قديمة لاحقاً للاطلاع لا يجب أن يظهر دائماً كـ"تقرير قديم" حتى لو
// كان فعلاً حديثاً وقت إنشائها.
function reconSourceReportAgeDays(session) {
  const reportAt = session?.source_report_date || session?.sourceReportDate;
  if (!reportAt) return null;
  const sessionAt = session?.session_date || session?.sessionDate;
  const reportMs = new Date(reportAt).getTime();
  const sessionMs = sessionAt ? new Date(sessionAt).getTime() : Date.now();
  if (!Number.isFinite(reportMs) || !Number.isFinite(sessionMs)) return null;
  return Math.max(0, Math.round((sessionMs - reportMs) / 86400000));
}

function reconSourceReportLabel(session) {
  const reportAt = session?.source_report_date || session?.sourceReportDate;
  if (!reportAt) return "غير معروف";
  return formatDateTime(reportAt) || String(reportAt);
}

async function reconToggleSession(id) {
  if (state.reconOpenId === id) {
    state.reconOpenId = "";
    render();
    return;
  }
  state.reconOpenId = id;
  render();
  const idx = state.reconSessions.findIndex((s) => s.id === id);
  if (idx === -1 || state.reconSessions[idx].lines) return;
  try {
    const full = await dataStore.getReconSession(id);
    if (full) state.reconSessions[idx] = full;
  } catch {
    // best-effort فقط — البطاقة تبقى مفتوحة بدون سطور إن فشل الجلب
  }
  render();
}

function reconSessionCard(session) {
  const open = state.reconOpenId === session.id;
  const summary = window.invRecCalc.sessionSummary(session.lines || []);
  const linesRows = (session.lines || []).map((line) => {
    const computed = window.invRecCalc.lineComputed(line);
    const diffLabel = computed.diffType === "increase" ? "زيادة" : computed.diffType === "decrease" ? "نقص" : "مطابق";
    return `
      <tr>
        <td>${escapeHtml(line.item_name || line.itemName || "")}</td>
        <td>${escapeHtml(String(line.system_qty ?? line.systemQty ?? 0))}</td>
        <td>${escapeHtml(String(line.actual_qty ?? line.actualQty ?? "—"))}</td>
        <td>${diffLabel}</td>
        <td>${computed.settlementValue.toFixed(2)}</td>
        <td>${escapeHtml(line.reason || "—")}</td>
      </tr>`;
  }).join("");

  return `
    <div class="po-card">
      <div class="po-card-head" data-action="recon-toggle" data-recon-id="${escapeHtml(session.id)}">
        <div>
          <strong>${escapeHtml(session.warehouse_name || session.warehouseName || "")}</strong>
          <span class="muted"> — ${escapeHtml(session.session_date || session.sessionDate || "")}</span>
        </div>
        <span class="badge">${reconStatusLabel(session.status)}</span>
      </div>
      ${open ? `
        <div class="po-card-body">
          <p class="muted">صافي فرق التسوية: ${summary.netValue.toFixed(2)} $ (زيادة ${summary.increaseCount} · نقص ${summary.decreaseCount} · مطابق ${summary.matchedCount})</p>
          <p class="muted">تقرير المخزون المصدر: ${escapeHtml(reconSourceReportLabel(session))}${reconSourceReportAgeDays(session) !== null ? ` (منذ ${reconSourceReportAgeDays(session)} يوم)` : ""}</p>
          ${reconSourceReportAgeDays(session) !== null && reconSourceReportAgeDays(session) > RECON_SOURCE_REPORT_MAX_AGE_DAYS ? `<p class="sales-info-warn">⚠ تقرير المخزون المصدر قديم (${reconSourceReportAgeDays(session)} يوم) — راجع الكميات قبل الاعتماد.</p>` : ""}
          <div class="inv-table-wrap">
            <table class="inv-table">
              <thead><tr><th>الصنف</th><th>النظام</th><th>الفعلي</th><th>الفرق</th><th>القيمة $</th><th>السبب</th></tr></thead>
              <tbody>${linesRows || '<tr><td colspan="6" class="muted">لا سطور</td></tr>'}</tbody>
            </table>
          </div>
          <div class="inv-actions">
            ${session.status === "draft" ? `<button class="button secondary" data-action="recon-status" data-recon-id="${escapeHtml(session.id)}" data-recon-next="reviewed" ${state.reconSaving ? "disabled" : ""}>وضع قيد المراجعة</button>` : ""}
            ${session.status === "reviewed" ? `<button class="button primary" data-action="recon-status" data-recon-id="${escapeHtml(session.id)}" data-recon-next="approved" ${state.reconSaving ? "disabled" : ""}>اعتماد (تسجيلي فقط)</button>` : ""}
            <button class="button secondary" data-action="recon-pdf" data-recon-id="${escapeHtml(session.id)}">🖨 تصدير PDF</button>
            ${session.status === "draft" ? `<button class="button danger" data-action="recon-delete" data-recon-id="${escapeHtml(session.id)}" ${state.reconSaving ? "disabled" : ""}>🗑 حذف المسودة</button>` : ""}
          </div>
        </div>
      ` : ""}
    </div>`;
}

function reconSessionPdfMarkup(session) {
  const summary = window.invRecCalc.sessionSummary(session.lines || []);
  const warehouseName = session.warehouse_name || session.warehouseName || "";
  const sessionDate = session.session_date || session.sessionDate || "";
  const sessionMonth = session.session_month || session.sessionMonth || "";
  const stmtNo = docNumber("INV-REC");

  const rows = (session.lines || []).map((line) => {
    const computed = window.invRecCalc.lineComputed(line);
    const diffLabel = computed.diffType === "increase" ? "زيادة" : computed.diffType === "decrease" ? "نقص" : "مطابق";
    const diffClass = computed.diffType === "increase" ? "cred" : computed.diffType === "decrease" ? "deb" : "";
    return `
      <tr>
        <td>${escapeHtml(line.item_name || line.itemName || "")}</td>
        <td>${escapeHtml(line.unit_name || line.unitName || "—")}</td>
        <td>${escapeHtml(String(line.system_qty ?? line.systemQty ?? 0))}</td>
        <td>${escapeHtml(String(line.actual_qty ?? line.actualQty ?? "—"))}</td>
        <td class="${diffClass}">${diffLabel}${computed.diffType !== "none" ? ` ${Math.abs(computed.diffQty).toFixed(2)}` : ""}</td>
        <td>${computed.settlementValue.toFixed(2)}</td>
        <td>${escapeHtml(line.reason || "—")}</td>
      </tr>`;
  }).join("");

  const header = `
    <div class="rhead">
      <div style="display:flex;align-items:center;gap:10px">
        <img src="public/icons/ozk-logo.png" class="rlogo" alt="OZK" onerror="this.style.display='none'">
        <div class="brand">OZK TOBACCO<small>مركز أبو زياد — لتجارة الدخان</small></div>
      </div>
      <div class="rtitle"><h2>تقرير الجرد الشهري</h2><span>رقم: ${escapeHtml(stmtNo)} · ${escapeHtml(todayIsoDate())}</span></div>
    </div>`;

  const sourceReportAgeDays = reconSourceReportAgeDays(session);
  const sourceReportStale = sourceReportAgeDays !== null && sourceReportAgeDays > RECON_SOURCE_REPORT_MAX_AGE_DAYS;

  const balbox = `
    <div class="balbox"><div><div class="nm">${escapeHtml(warehouseName)}</div>
      <div class="muted">تاريخ الجرد: ${escapeHtml(sessionDate)}${sessionMonth ? ` — شهر: ${escapeHtml(String(sessionMonth).slice(0, 7))}` : ""} — الحالة: ${escapeHtml(reconStatusLabel(session.status))}</div>
      <div class="muted">تقرير المخزون المصدر: ${escapeHtml(reconSourceReportLabel(session))}${sourceReportAgeDays !== null ? ` (منذ ${sourceReportAgeDays} يوم)` : ""}</div>
      ${sourceReportStale ? `<div class="sales-info-warn">⚠ تقرير المخزون المصدر قديم (${sourceReportAgeDays} يوم) — راجع الكميات قبل الاعتماد.</div>` : ""}
      </div>
      <div style="text-align:left"><div class="muted">صافي فرق التسوية</div><div class="big">${escapeHtml(summary.netValue.toFixed(2))} $</div></div></div>`;

  const cards = `
    <div class="cards">
      <div class="rcard"><div class="v green">${summary.increaseCount}</div><div class="l">زيادة</div></div>
      <div class="rcard"><div class="v red">${summary.decreaseCount}</div><div class="l">نقص</div></div>
      <div class="rcard"><div class="v gold">${summary.matchedCount}</div><div class="l">مطابق</div></div>
    </div>`;

  const footer = `
    <div class="rfoot">
      <span>هذا التقرير تسجيلي فقط — لا يغيّر مخزوناً أو حساباً في الأمين أو Supabase</span>
      <span dir="ltr">0985000771 — 0984000662</span>
    </div>`;

  return `${REPORT_STYLE}<div class="ozk-rpt">
    ${header}
    ${balbox}
    ${cards}
    <div class="sec">سطور الجرد (${session.lines?.length || 0})</div>
    <table>
      <thead><tr><th>الصنف</th><th>الوحدة</th><th>النظام</th><th>الفعلي</th><th>الفرق</th><th>القيمة $</th><th>السبب</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" class="muted">لا سطور</td></tr>'}</tbody>
    </table>
    ${session.notes ? `<p class="muted">ملاحظات: ${escapeHtml(session.notes)}</p>` : ""}
    ${footer}
  </div>`;
}

async function saveReconSessionPdf(session) {
  if (!session) return;
  const warehouseName = session.warehouse_name || session.warehouseName || "مستودع";
  const sessionDate = session.session_date || session.sessionDate || todayIsoDate();
  const safe = String(warehouseName).replace(/[^\p{L}\p{N}]+/gu, "_").slice(0, 40);
  const exported = await exportReportPdf(
    reconSessionPdfMarkup(session),
    `جرد-${safe}-${sessionDate}.pdf`,
    { docType: "other_report", meta: { title: `تقرير جرد - ${warehouseName}`, date: String(sessionDate).slice(0, 10) } }
  );
  if (exported) setNotice("success", "تم تجهيز تقرير الجرد PDF.");
  render();
}

function inventoryRecon() {
  if (!state.session) {
    return shell(`
      <section class="panel">
        <h2>الجرد الشهري</h2>
        <p class="muted">سجّل الدخول أولاً للوصول إلى الجرد الشهري.</p>
      </section>
    `);
  }

  const summary = reconSummary();
  const hasWarehouseStock = Array.isArray(state.reconWarehouseStockItems) && state.reconWarehouseStockItems.length > 0;
  const RECON_STALE_MINUTES = 24 * 60; // تقرير مخزون أقدم من يوم يُعتبر غير موثوق لجرد اليوم
  const reconStockMinutes = minutesSince(state.reconWarehouseStockGeneratedAt);
  const isWarehouseStockStale = reconStockMinutes !== null && reconStockMinutes > RECON_STALE_MINUTES;
  const warehouseButtonsHtml = state.reconWarehouses.length
    ? state.reconWarehouses.map((w) => `
      <button type="button" class="button ${state.reconWarehouseKey === w.warehouseKey ? "primary" : "secondary"} compact-button" data-recon-warehouse="${escapeHtml(w.warehouseKey)}" data-recon-warehouse-name="${escapeHtml(w.warehouseName)}">${escapeHtml(w.warehouseName)}</button>
    `).join("")
    : `<span class="muted">${state.reconWarehousesLoading ? "جارٍ تحميل قائمة المستودعات…" : "لا توجد مستودعات متاحة بعد — شغّل رفع مخزون المستودعات من الأمين أولاً."}</span>`;
  const rowsHtml = (state.reconRows || []).map((row) => {
    const computed = reconRowComputed(row);
    const diffLabel = computed.diffType === "increase" ? "زيادة" : computed.diffType === "decrease" ? "نقص" : "—";
    return `
    <tr class="inv-row">
      <td>${escapeHtml(row.itemName)}<div class="muted" style="font-size:0.85em">${escapeHtml(row.itemNumber || "")}</div></td>
      <td>${escapeHtml(row.unitName || "")}</td>
      <td>${escapeHtml(String(row.systemQty))}<div class="muted" style="font-size:0.78em">من تقرير المستودع</div></td>
      <td><input class="inv-input inv-num" data-recon-field="actualQty" data-recon-key="${escapeHtml(row.itemKey)}" value="${escapeHtml(String(row.actualQty))}" placeholder="—" inputmode="decimal"></td>
      <td>${diffLabel}${computed.diffType !== "none" ? ` ${Math.abs(computed.diffQty).toFixed(2)}` : ""}</td>
      <td>${computed.settlementValue.toFixed(2)}</td>
      <td><input class="inv-input" data-recon-field="reason" data-recon-key="${escapeHtml(row.itemKey)}" value="${escapeHtml(row.reason || "")}" placeholder="${computed.reasonRequired ? "سبب الفرق (مطلوب)" : "—"}"></td>
      <td><button class="inv-remove" data-recon-remove="${escapeHtml(row.itemKey)}" title="حذف">✕</button></td>
    </tr>`;
  }).join("");

  const savedList = state.reconSessions.length
    ? state.reconSessions.map(reconSessionCard).join("")
    : '<p class="muted">لا توجد جلسات جرد مسجلة بعد.</p>';

  return shell(`
    <section class="notice-panel warning" style="margin-bottom:16px">
      <span>🗒 الجرد الشهري هنا للتسجيل والمراجعة فقط — اعتماد الجلسة يقفلها ولا يغيّر مخزوناً أو حساباً في الأمين أو Supabase إلى أن تُفعَّل المزامنة رسمياً.</span>
    </section>

    <section class="panel wide inv-panel">
      <h2 style="margin:0">تسجيل جرد جديد</h2>
      <div class="inv-header-fields">
        <label class="inv-label">
          المستودع
          <div class="inv-actions" style="margin-top:4px">
            ${warehouseButtonsHtml}
          </div>
        </label>
        <label class="inv-label">
          تاريخ الجرد
          <input class="inv-input-main" id="recon-date" type="date" value="${escapeHtml(state.reconSessionDate || todayIsoDate())}">
        </label>
        <label class="inv-label">
          شهر الجرد
          <input class="inv-input-main" id="recon-month" type="month" value="${escapeHtml((state.reconSessionMonth || todayIsoDate().slice(0, 7) + "-01").slice(0, 7))}">
        </label>
      </div>

      <label class="inv-label">
        ملاحظات (اختياري)
        <input class="inv-input-main" id="recon-notes" value="${escapeHtml(state.reconNotes)}" placeholder="ملاحظات عامة عن الجرد…" maxlength="500">
      </label>

      ${hasWarehouseStock ? "" : `<section class="notice-panel warning" style="margin:8px 0">
        <span>⚠ لا يتوفر تقرير مخزون موثوق لهذا المستودع بعد — تعذّر بناء قائمة الأصناف. لا يمكن إضافة أصناف أو حفظ الجرد حتى توفّر التقرير.</span>
      </section>`}
      ${hasWarehouseStock && isWarehouseStockStale ? `<section class="notice-panel warning" style="margin:8px 0">
        <span>⚠ تقرير مخزون هذا المستودع قديم (${syncFreshnessLabel(state.reconWarehouseStockGeneratedAt)}) — قد لا يعكس الوضع الحالي. شغّل رفع مخزون المستودعات من الأمين قبل الحفظ.</span>
      </section>` : ""}

      <label class="inv-label po-suggest-wrap">
        إضافة صنف للجرد
        <input class="inv-input-main" id="recon-item-query" value="${escapeHtml(state.reconRowQuery)}" placeholder="ابحث بالاسم أو الكود…" autocomplete="off" ${hasWarehouseStock ? "" : "disabled"}>
        <div class="sales-suggest-box" data-recon-suggest></div>
      </label>

      <div class="inv-table-wrap">
        <table class="inv-table">
          <thead>
            <tr>
              <th>الصنف</th><th style="width:70px">الوحدة</th><th style="width:90px">النظام</th>
              <th style="width:90px">الفعلي</th><th style="width:90px">الفرق</th><th style="width:90px">القيمة $</th>
              <th>السبب</th><th style="width:32px"></th>
            </tr>
          </thead>
          <tbody id="recon-body">${rowsHtml || '<tr><td colspan="8" class="muted">أضف صنفاً من الحقل أعلاه.</td></tr>'}</tbody>
        </table>
      </div>

      <p class="muted" style="margin-top:8px">
        صافي فرق التسوية: ${summary.netValue.toFixed(2)} $ (زيادة ${summary.increaseCount} · نقص ${summary.decreaseCount} · مطابق ${summary.matchedCount})
      </p>

      <div class="inv-actions">
        <button class="button primary" data-action="recon-save" ${state.reconSaving || !hasWarehouseStock || isWarehouseStockStale ? "disabled" : ""}>${state.reconSaving ? "جاري الحفظ…" : "💾 حفظ كمسودة"}</button>
        <button class="button secondary" data-action="recon-reset" ${state.reconSaving ? "disabled" : ""}>مسح</button>
      </div>
    </section>

    <section class="panel wide" style="margin-top:16px">
      <div class="panel-title-row">
        <h2 style="margin:0">جلسات الجرد المسجلة (${state.reconSessions.length})</h2>
      </div>
      <div class="po-list">${savedList}</div>
    </section>
  `);
}

function purchases() {
  if (!state.session) {
    return shell(`
      <section class="panel">
        <h2>فواتير المشتريات</h2>
        <p class="muted">سجّل الدخول أولاً للوصول إلى فواتير المشتريات.</p>
      </section>
    `);
  }

  const rows = state.poRows;
  const totals = poTotals();
  const grandTotal = totals.grand;
  const currencySym = state.poCurrency === "SYP" ? "ل.س" : "$";
  const payMethod = state.poPayMethod === "cash" ? "cash" : "credit";
  const remainingState = poRemaining(grandTotal);

  const rowsHtml = rows.map((r, i) => {
    const computed = poRowComputed(r);
    const item = r.key ? poItemByKey(r.key) : null;
    const unitLabel = poUnitLabel(item, r.unit);
    return `
    <tr class="inv-row">
      <td class="po-suggest-wrap">
        <input class="inv-input" data-po-field="q" data-po-index="${i}" value="${escapeHtml(r.q)}" placeholder="ابحث بالاسم أو الكود…" dir="auto" autocomplete="off">
        <div class="sales-suggest-box" data-po-suggest="${i}"></div>
      </td>
      <td>
        <button type="button" class="button secondary compact-button" data-po-unit="${i}" ${r.key ? "" : "disabled"}>${escapeHtml(unitLabel)}</button>
      </td>
      <td><input class="inv-input inv-num" data-po-field="qty" data-po-index="${i}" value="${escapeHtml(r.qty)}" placeholder="0" inputmode="decimal"></td>
      <td><input class="inv-input inv-num" data-po-field="price" data-po-index="${i}" value="${escapeHtml(r.price)}" placeholder="السعر" inputmode="decimal"></td>
      <td class="inv-line-total" data-po-linetotal="${i}">${r.key ? computed.lineTotal.toFixed(2) : "—"}</td>
      <td>${r.key ? `<button class="button secondary compact-button" type="button" data-po-info="${escapeHtml(r.key)}" title="معلومات الصنف">ℹ</button>` : ""}</td>
      <td>${rows.length > 1 ? `<button class="inv-remove" data-po-remove="${i}" title="حذف">✕</button>` : ""}</td>
    </tr>
  `;
  }).join("");

  const savedList = state.purchaseInvoices.length
    ? state.purchaseInvoices.map(purchaseInvoiceCard).join("")
    : '<p class="muted">لا توجد فواتير مشتريات مسجلة بعد. سجّل أول فاتورة من النموذج أعلاه.</p>';

  return shell(`
    <section class="notice-panel warning" style="margin-bottom:16px">
      <span>🗒 فاتورة المشتريات هنا للتسجيل والمراجعة فقط حالياً — لا تُزامَن مع الأمين بعد ولا تؤثر على المخزون أو الحسابات إلى أن تُفعَّل المزامنة رسمياً (انظر AI_WORK_SYNC.md).</span>
    </section>

    <section class="panel wide inv-panel">
      <div class="inv-form-area">
        <h2 style="margin:0">تسجيل فاتورة مشتريات جديدة</h2>
        <div class="inv-header-fields">
          <label class="inv-label po-suggest-wrap">
            اسم المورد
            <input class="inv-input-main" id="po-supplier" value="${escapeHtml(state.poSupplierQuery)}" placeholder="اسم المورد أو الشركة" maxlength="240" autocomplete="off">
            <div class="sales-suggest-box" data-po-supplier-suggest></div>
          </label>
          <label class="inv-label">
            تاريخ الفاتورة
            <input class="inv-input-main" id="po-date" type="date" value="${escapeHtml(state.poDate || todayIsoDate())}">
          </label>
        </div>

        <div class="inv-header-fields">
          <label class="inv-label">
            العملة
            <div class="inv-actions" style="margin-top:4px">
              <button type="button" class="button ${state.poCurrency === "USD" ? "primary" : "secondary"} compact-button" data-po-currency="USD">دولار USD</button>
              <button type="button" class="button ${state.poCurrency === "SYP" ? "primary" : "secondary"} compact-button" data-po-currency="SYP">ليرة SYP</button>
            </div>
          </label>
          <label class="inv-label">
            طريقة الدفع
            <div class="inv-actions" style="margin-top:4px">
              <button type="button" class="button ${payMethod === "cash" ? "primary" : "secondary"} compact-button" data-po-pay="cash">نقدي</button>
              <button type="button" class="button ${payMethod === "credit" ? "primary" : "secondary"} compact-button" data-po-pay="credit">آجل</button>
            </div>
          </label>
        </div>

        <label class="inv-label" style="display:flex;align-items:center;gap:8px;flex-direction:row-reverse;justify-content:flex-end">
          <input type="checkbox" id="po-register-payment" ${state.poRegisterPayment ? "checked" : ""}>
          تسجيل دفعة من هذه الفاتورة الآن
        </label>

        ${state.poRegisterPayment ? `
        <div class="inv-header-fields">
          <label class="inv-label">
            قيمة الدفعة (${currencySym})
            <input class="inv-input-main" id="po-payment-amount" data-po-field="payment" value="${escapeHtml(state.poPaymentAmount || (payMethod === "cash" ? grandTotal.toFixed(2) : ""))}" placeholder="0" inputmode="decimal" ${payMethod === "cash" ? "readonly" : ""}>
          </label>
          <label class="inv-label">
            تاريخ الدفعة
            <input class="inv-input-main" id="po-payment-date" type="date" value="${escapeHtml(state.poPaymentDate || state.poDate || todayIsoDate())}">
          </label>
        </div>
        <label class="inv-label">
          الصندوق / الحساب
          <input class="inv-input-main" id="po-payment-account" value="${escapeHtml(state.poPaymentAccount)}" placeholder="مثال: صندوق الدولار" maxlength="120">
        </label>
        ${state.poPaymentError ? `<p class="po-pay-error">${escapeHtml(state.poPaymentError)}</p>` : ""}
        ` : ""}

        <label class="inv-label">
          ملاحظات (اختياري)
          <input class="inv-input-main" id="po-notes" value="${escapeHtml(state.poNotes)}" placeholder="شروط التسليم، طريقة الدفع، إلخ…" maxlength="500">
        </label>

        <div class="inv-table-wrap">
          <table class="inv-table">
            <thead>
              <tr>
                <th>الصنف</th>
                <th style="width:80px">الوحدة</th>
                <th style="width:90px">الكمية</th>
                <th style="width:110px">السعر ${currencySym}</th>
                <th style="width:100px">المجموع ${currencySym}</th>
                <th style="width:32px"></th>
                <th style="width:36px"></th>
              </tr>
            </thead>
            <tbody id="po-body">${rowsHtml}</tbody>
          </table>
        </div>

        ${state.poInfoKey ? poInfoCard() : ""}

        <div style="margin-top:10px">
          <strong style="font-size:13px">أصناف مقترحة (حركة مبيعات قوية آخر 30 يوماً)</strong>
          ${poSuggestedItemsHtml()}
        </div>

        <div class="inv-footer">
          <button class="button secondary" data-action="po-add-row">+ إضافة صنف</button>
          <div class="inv-total-box">
            <span>الإجمالي</span>
            <strong class="inv-grand-total" data-po-total>${grandTotal.toFixed(2)} ${currencySym}</strong>
          </div>
        </div>
        <div class="inv-total-box" data-po-remaining-box>
          <span>${escapeHtml(poRemainingLabel(remainingState.status))}</span>
          <strong data-po-remaining>${Math.abs(remainingState.remaining).toFixed(2)} ${currencySym}</strong>
        </div>

        <div class="inv-actions">
          <button class="button primary" data-action="po-save" ${state.poSaving ? "disabled" : ""}>${state.poSaving ? "جاري الحفظ…" : "💾 تسجيل الفاتورة كمسودة"}</button>
          <button class="button secondary" data-action="po-reset" ${state.poSaving ? "disabled" : ""}>مسح</button>
        </div>
      </div>
    </section>

    <section class="panel wide" style="margin-top:16px">
      <div class="panel-title-row">
        <h2 style="margin:0">الفواتير المسجلة (${state.purchaseInvoices.length})</h2>
      </div>
      <div class="po-list">${savedList}</div>
    </section>

    ${poAmeenPanelHtml()}
  `);
}

function purchaseInvoiceCard(po) {
  const expanded = state.poOpenId === po.id;
  const correctionOpen = state.poCorrectionOpenId === po.id;
  const sym = po.currency === "SYP" ? "ل.س" : "$";
  const canEdit = po.status !== "synced";
  const detailRows = po.items.map((item, idx) => `
    <tr>
      <td style="width:32px;color:var(--muted)">${idx + 1}</td>
      <td>${escapeHtml(window.poCalc.poItemDisplayLabel(item.item_number, item.name))}</td>
      <td class="inv-num">${escapeHtml(String(item.qty))}</td>
      <td class="inv-line-total">${item.price > 0 ? item.price.toFixed(2) : "—"}</td>
      <td class="inv-line-total">${item.price > 0 ? (item.qty * item.price).toFixed(2) : "—"}</td>
    </tr>
  `).join("");

  const statusActions = canEdit
    ? po.status === "draft"
      ? `<button class="button secondary compact-button" type="button" data-po-transition="${escapeHtml(po.id)}" data-po-next="approved">✓ اعتماد</button>`
      : po.status === "approved"
        ? `<button class="button secondary compact-button" type="button" data-po-transition="${escapeHtml(po.id)}" data-po-next="sync_pending">↻ إرسال للمزامنة</button>`
        // "synced" لا يُضبط من الواجهة إطلاقاً — يقتصر على عامل المزامنة بعد تحقّق فعلي
        // من نجاح القيد بالأمين (service-role فقط، متوقف حالياً كما هو موثّق أعلاه).
        : po.status === "sync_pending"
          ? `<button class="button secondary compact-button" type="button" data-po-transition="${escapeHtml(po.id)}" data-po-next="failed">⚠ وضع فشلت</button>`
          : ""
    : `<button class="button secondary compact-button" type="button" data-po-correction="${escapeHtml(po.id)}">🛠 إجراء تصحيحي</button>`;

  return `
    <article class="po-card">
      <div class="po-card-head">
        <div class="po-card-info">
          <strong>${escapeHtml(po.publicId)} — ${escapeHtml(po.supplierName)}</strong>
          <small class="muted">${escapeHtml(po.orderDate)} · ${po.items.length} صنف · ${escapeHtml(po.total.toFixed(2))} ${sym} · ${po.payMethod === "cash" ? "نقدي" : "آجل"}</small>
        </div>
        <div class="po-card-actions">
          ${poStatusChipHtml(po.status)}
          <button class="button secondary compact-button" type="button" data-po-toggle="${escapeHtml(po.id)}">${expanded ? "إخفاء التفاصيل" : "التفاصيل"}</button>
          <button class="button secondary compact-button" type="button" data-po-print="${escapeHtml(po.id)}" title="طباعة أو حفظ PDF">🖨 طباعة / PDF</button>
          <button class="button secondary compact-button" type="button" data-po-copy="${escapeHtml(po.id)}" title="نسخ نص الفاتورة">📋 نسخ</button>
          ${statusActions}
          ${canEdit ? `<button class="button secondary compact-button po-delete" type="button" data-po-delete="${escapeHtml(po.id)}">حذف</button>` : ""}
        </div>
      </div>
      ${expanded ? `
        <div class="inv-table-wrap" style="margin-top:12px">
          <table class="inv-table">
            <thead><tr><th style="width:32px">#</th><th>الصنف</th><th style="width:80px">الكمية</th><th style="width:100px">السعر ${sym}</th><th style="width:100px">المجموع ${sym}</th></tr></thead>
            <tbody>${detailRows}</tbody>
          </table>
        </div>
        <p class="muted" style="margin:10px 4px 0">الدفعة: ${po.paidTotal.toFixed(2)} ${sym} — المتبقي: ${Math.abs(po.remainingTotal).toFixed(2)} ${sym} ${po.remainingTotal > 0.01 ? "(مستحق للمورد)" : po.remainingTotal < -0.01 ? "(مدفوع زيادة)" : "(مسدّدة)"}</p>
        ${po.notes ? `<p class="muted" style="margin:6px 4px 0">📝 ${escapeHtml(po.notes)}</p>` : ""}
        ${po.correctionCount > 0 ? `<p class="muted" style="margin:6px 4px 0">إجراءات تصحيحية: ${po.correctionCount}</p>` : ""}
      ` : ""}
      ${correctionOpen ? `
        <div class="po-info-panel" style="margin-top:10px">
          <label class="inv-label">
            سبب الإجراء التصحيحي (إلزامي)
            <input class="inv-input-main" id="po-correction-note-${escapeHtml(po.id)}" value="${escapeHtml(state.poCorrectionNote)}" placeholder="مثال: تصحيح سعر بند بعد تأكيد المورد" maxlength="500">
          </label>
          <div class="inv-actions">
            <button class="button primary compact-button" type="button" data-po-correction-submit="${escapeHtml(po.id)}">تسجيل الإجراء التصحيحي</button>
            <button class="button secondary compact-button" type="button" data-po-correction-cancel="${escapeHtml(po.id)}">إلغاء</button>
          </div>
        </div>
      ` : ""}
    </article>
  `;
}

async function savePurchaseInvoice() {
  if (state.poSaving) return;
  const supplier = state.poSupplierQuery.trim();
  if (window.poCalc.poHasUnselectedEntry(state.poRows)) {
    setNotice("error", "اختر الصنف من قائمة الاقتراحات");
    render();
    return;
  }
  const items = state.poRows
    .filter((r) => r.key)
    .map((r) => {
      const item = poItemByKey(r.key);
      return {
        item_key: r.key,
        item_number: r.num || (item ? poItemCode(item) : ""),
        item_guid: (item && item.itemGuid) || null,
        name: r.name || (item && item.itemName) || "",
        unit: r.unit === "unit1" ? "unit1" : "unit2",
        qty: toNumber(r.qty),
        price: toNumber(r.price)
      };
    })
    .filter((r) => r.name && r.qty > 0);

  if (!supplier) {
    setNotice("error", "اكتب اسم المورد أولاً.");
    render();
    return;
  }
  if (!items.length) {
    setNotice("error", "أضف صنفاً واحداً على الأقل مع كمية أكبر من صفر (اختره من الاقتراحات).");
    render();
    return;
  }
  const dedupe = poCalc.poDedupeLines(state.poRows);
  if (!dedupe.ok) {
    setNotice("error", "يوجد صنف مكرر في الفاتورة — ادمج كميته في سطر واحد بدل تكراره.");
    render();
    return;
  }

  const total = poCalc.poTotals(state.poRows).grand;
  const payMethod = state.poPayMethod === "cash" ? "cash" : "credit";
  const paymentAmount = payMethod === "cash" && state.poRegisterPayment && !state.poPaymentAmount
    ? total
    : toNumber(state.poPaymentAmount);

  if (state.poRegisterPayment) {
    const validation = poCalc.poValidatePayment({ total, amount: paymentAmount });
    if (!validation.ok) {
      state.poPaymentError = validation.error;
      render();
      return;
    }
  }
  state.poPaymentError = "";

  state.poSaving = true;
  render();
  try {
    await dataStore.createPurchaseInvoice({
      supplierName: supplier,
      supplierAmeenGuid: state.poSupplierGuid,
      supplierAmeenCode: state.poSupplierKey,
      orderDate: state.poDate || todayIsoDate(),
      notes: state.poNotes,
      items,
      currency: state.poCurrency,
      payMethod,
      registerPayment: state.poRegisterPayment,
      paymentAmount,
      paymentDate: state.poPaymentDate,
      paymentAccount: state.poPaymentAccount
    });
    await loadPurchaseInvoices();
    state.poSupplierQuery = "";
    state.poSupplierKey = "";
    state.poSupplierGuid = "";
    state.poDate = "";
    state.poNotes = "";
    state.poCurrency = "USD";
    state.poPayMethod = "credit";
    state.poRegisterPayment = false;
    state.poPaymentAmount = "";
    state.poPaymentDate = "";
    state.poPaymentAccount = "";
    state.poRows = [{ q: "", key: "", name: "", num: "", unit: "unit2", qty: "1", price: "", edited: false }];
    setNotice("success", "تم تسجيل فاتورة المشتريات كمسودة ✓ — اعتمدها من القائمة أدناه عند التأكد.");
  } catch (error) {
    setNotice("error", safeErrorMessage(error));
    if (/سجل الدخول/i.test(error.message || "")) state.route = "login";
  } finally {
    state.poSaving = false;
    render();
  }
}

// فحص دفاعي في الواجهة فقط — الفحص الحقيقي في قيد/Trigger على قاعدة Supabase.
async function applyPurchaseInvoiceStatusAction(id, nextStatus) {
  const po = state.purchaseInvoices.find((p) => p.id === id);
  if (!po) return;
  if (!poCalc.poCanTransitionStatus(po.status, nextStatus)) {
    setNotice("error", "لا يمكن هذا الانتقال في حالة الفاتورة الحالية.");
    render();
    return;
  }
  try {
    await dataStore.setPurchaseInvoiceStatus(id, nextStatus);
    await loadPurchaseInvoices();
    setNotice("success", `تم تحديث حالة الفاتورة إلى: ${(poCalc.PO_STATUS_LABELS && poCalc.PO_STATUS_LABELS[nextStatus]) || nextStatus}.`);
  } catch (error) {
    setNotice("error", safeErrorMessage(error));
  }
  render();
}

async function removePurchaseInvoice(id) {
  const po = state.purchaseInvoices.find((p) => p.id === id);
  if (po && po.status === "synced") {
    setNotice("error", "الفاتورة مُزامَنة — لا يمكن حذفها. استخدم «إجراء تصحيحي» بدلاً من ذلك.");
    render();
    return;
  }
  if (!confirm("حذف هذه الفاتورة نهائياً من السجل؟")) return;
  try {
    await dataStore.deletePurchaseInvoice(id);
    await loadPurchaseInvoices();
    setNotice("success", "تم حذف الفاتورة من السجل.");
  } catch (error) {
    setNotice("error", safeErrorMessage(error));
  }
  render();
}

function openPurchaseInvoiceCorrection(id) {
  state.poCorrectionOpenId = state.poCorrectionOpenId === id ? "" : id;
  state.poCorrectionNote = "";
  render();
}

async function submitPurchaseInvoiceCorrection(id) {
  const note = state.poCorrectionNote.trim();
  if (!note) {
    setNotice("error", "اكتب سبب الإجراء التصحيحي أولاً.");
    render();
    return;
  }
  try {
    await dataStore.correctPurchaseInvoice(id, note);
    await loadPurchaseInvoices();
    state.poCorrectionOpenId = "";
    state.poCorrectionNote = "";
    setNotice("success", "تم تسجيل الإجراء التصحيحي.");
  } catch (error) {
    setNotice("error", safeErrorMessage(error));
  }
  render();
}

function buildPurchaseInvoiceText(po) {
  const sym = po.currency === "SYP" ? "ل.س" : "$";
  const lines = po.items.map((item, idx) => {
    const base = `${idx + 1}) ${window.poCalc.poItemDisplayLabel(item.item_number, item.name)} — الكمية: ${item.qty}`;
    return item.price > 0 ? `${base} — السعر: ${item.price.toFixed(2)} ${sym}` : base;
  });
  const parts = [
    `📋 فاتورة مشتريات ${po.publicId}`,
    `من: ${appConfig.name}`,
    `التاريخ: ${po.orderDate}`,
    `المورد: ${po.supplierName}`,
    `طريقة الدفع: ${po.payMethod === "cash" ? "نقدي" : "آجل"}`,
    "",
    "الأصناف:",
    ...lines,
    "",
    `الإجمالي: ${po.total.toFixed(2)} ${sym}`,
    `المدفوع: ${po.paidTotal.toFixed(2)} ${sym}`,
    `المتبقي: ${po.remainingTotal.toFixed(2)} ${sym}`
  ];
  if (po.notes) parts.push("", `ملاحظات: ${po.notes}`);
  return parts.join("\n");
}

async function copyPurchaseInvoiceText(id) {
  const po = state.purchaseInvoices.find((p) => p.id === id);
  if (!po) return;
  const text = buildPurchaseInvoiceText(po);
  let copied = false;
  try {
    await navigator.clipboard.writeText(text);
    copied = true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      document.body.appendChild(area);
      area.select();
      copied = document.execCommand("copy");
      area.remove();
    } catch {
      copied = false;
    }
  }
  setNotice(copied ? "success" : "error", copied ? "تم نسخ نص فاتورة المشتريات." : "تعذّر النسخ التلقائي. افتح التفاصيل وانسخ الأصناف يدوياً.");
  render();
}

function printPurchaseInvoice(id) {
  const po = state.purchaseInvoices.find((p) => p.id === id);
  if (!po) return;
  const sym = po.currency === "SYP" ? "ل.س" : "$";
  const printDate = new Intl.DateTimeFormat("ar-SA-u-ca-gregory-nu-latn", { dateStyle: "long" }).format(new Date());

  const rowsHtml = po.items.map((item, i) => `
    <tr>
      <td class="col-num">${i + 1}</td>
      <td>${escapeHtml(window.poCalc.poItemDisplayLabel(item.item_number, item.name))}</td>
      <td>${escapeHtml(String(item.qty))}</td>
      <td class="col-price">${item.price > 0 ? item.price.toFixed(2) : "—"}</td>
      <td class="col-total">${item.price > 0 ? (item.qty * item.price).toFixed(2) : "—"}</td>
    </tr>
  `).join("");

  const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<title>فاتورة مشتريات ${po.publicId}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Segoe UI', Tahoma, Arial, sans-serif; font-size: 13px; color: #1a1a1a; background: #fff; padding: 40px; direction: rtl; }
  .inv-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 36px; border-bottom: 3px solid #b8860b; padding-bottom: 20px; }
  .inv-company { font-size: 22px; font-weight: 700; color: #5c3d00; letter-spacing: 1px; }
  .inv-company small { display: block; font-size: 12px; font-weight: 400; color: #888; margin-top: 4px; }
  .inv-meta { text-align: left; direction: ltr; }
  .inv-meta p { margin: 3px 0; font-size: 12px; color: #555; }
  .inv-meta strong { color: #1a1a1a; }
  .doc-type { font-size: 14px; font-weight: 700; color: #5c3d00; }
  .inv-num { font-size: 16px; font-weight: 700; color: #b8860b; }
  .inv-customer { background: #faf7f0; border: 1px solid #e8dfc8; border-radius: 6px; padding: 14px 18px; margin-bottom: 28px; }
  .inv-customer p { font-size: 12px; color: #888; margin-bottom: 4px; }
  .inv-customer strong { font-size: 15px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
  th { background: #5c3d00; color: #fff; padding: 10px 12px; text-align: right; font-size: 12px; }
  td { padding: 9px 12px; border-bottom: 1px solid #eee; font-size: 13px; }
  tr:nth-child(even) td { background: #fdf9f3; }
  .col-num { width: 36px; text-align: center; color: #aaa; }
  .col-price, .col-total { text-align: left; direction: ltr; font-family: monospace; }
  .total-row td { border-top: 2px solid #b8860b; font-weight: 700; font-size: 14px; background: #faf7f0; }
  .pay-row td { font-size: 12px; color: #555; }
  .notes { font-size: 12px; color: #666; margin-bottom: 28px; padding: 10px 14px; border-right: 3px solid #b8860b; background: #fdfaf5; }
  .inv-foot { text-align: center; font-size: 11px; color: #aaa; margin-top: 40px; border-top: 1px solid #eee; padding-top: 16px; }
  @media print { body { padding: 24px; background: #ffffff !important; } @page { margin: 1.5cm; } }
</style>
</head>
<body>
<div class="inv-head">
  <div>
    <div class="inv-company">${escapeHtml(appConfig.name)}${appConfig.tagline ? `<small>${escapeHtml(appConfig.tagline)}</small>` : ""}</div>
  </div>
  <div class="inv-meta">
    <p class="doc-type">فاتورة مشتريات</p>
    <p class="inv-num">${escapeHtml(po.publicId)}</p>
    <p><strong>التاريخ:</strong> ${escapeHtml(po.orderDate)}</p>
    <p><strong>تاريخ الطباعة:</strong> ${printDate}</p>
    <p><strong>العملة:</strong> ${po.currency === "SYP" ? "ليرة سورية (SYP)" : "دولار أمريكي (USD)"}</p>
    <p><strong>طريقة الدفع:</strong> ${po.payMethod === "cash" ? "نقدي" : "آجل"}</p>
  </div>
</div>

<div class="inv-customer">
  <p>المورد</p>
  <strong>${escapeHtml(po.supplierName)}</strong>
</div>

<table>
  <thead>
    <tr>
      <th class="col-num">#</th>
      <th>الصنف</th>
      <th style="width:70px">الكمية</th>
      <th style="width:110px" class="col-price">السعر</th>
      <th style="width:110px" class="col-total">المجموع</th>
    </tr>
  </thead>
  <tbody>${rowsHtml}</tbody>
  <tfoot>
    <tr class="total-row">
      <td colspan="3"></td>
      <td>الإجمالي</td>
      <td class="col-total">${po.total.toFixed(2)} ${sym}</td>
    </tr>
    <tr class="pay-row">
      <td colspan="3"></td>
      <td>المدفوع</td>
      <td class="col-total">${po.paidTotal.toFixed(2)} ${sym}</td>
    </tr>
    <tr class="pay-row">
      <td colspan="3"></td>
      <td>المتبقي</td>
      <td class="col-total">${po.remainingTotal.toFixed(2)} ${sym}</td>
    </tr>
  </tfoot>
</table>

${po.notes ? `<div class="notes"><strong>ملاحظة:</strong> ${escapeHtml(po.notes)}</div>` : ""}

<div class="inv-foot">${escapeHtml(appConfig.name)} &mdash; ${escapeHtml(appConfig.supportEmail)}</div>

</body></html>`;

  const purchaseArchiveMeta = { party: po.supplierName, number: po.publicId, date: todayIsoDate() };
  printHtmlDocument(html, {
    title: archiveDocumentTitle("purchase_invoice", purchaseArchiveMeta),
    archive: { docType: "purchase_invoice", meta: purchaseArchiveMeta },
    onError: () => {
      setNotice("error", "تعذّر فتح نافذة طباعة فاتورة المشتريات. أغلق التطبيق وافتحه ثم جرّب مجدداً.");
      render();
    }
  });
}


function statusCard(item) {
  return `
    <article class="status-card">
      <span>${escapeHtml(item.label)}</span>
      <strong>${escapeHtml(item.value)}</strong>
      <small>${escapeHtml(item.trend)}</small>
    </article>
  `;
}

function taskItem(item) {
  const checked = state.completed.has(item.id);
  return `
    <button class="task-item ${checked ? "done" : ""}" data-task="${escapeHtml(item.id)}">
      <span class="task-check">${checked ? "✓" : ""}</span>
      <span>
        <strong>${escapeHtml(item.title)}</strong>
        <small>${escapeHtml(item.detail)}</small>
        <em class="task-action">${checked ? "مفعلة" : "اضغط لتفعيل هذه الميزة"}</em>
      </span>
    </button>
  `;
}

const REQUEST_STAGES = ["جديد", "قيد التجهيز", "جاهز للتسليم", "مغلق"];
const STAGE_CLASS = { "جديد": "chip-new", "قيد التجهيز": "chip-progress", "جاهز للتسليم": "chip-ready", "مغلق": "chip-closed" };

function requestCard(request) {
  const status = REQUEST_STAGES.includes(request.status) ? request.status : "جديد";
  const idx = REQUEST_STAGES.indexOf(status);
  const next = REQUEST_STAGES[idx + 1] || null;
  return `
    <article class="request-card">
      <div>
        <strong>${escapeHtml(request.publicId || request.id)} - ${escapeHtml(request.customer)}</strong>
        <span>${escapeHtml(request.channel)} / ${escapeHtml(request.type)}</span>
      </div>
      <p>${escapeHtml(request.note)}</p>
      <div class="request-actions">
        <span class="status-chip ${STAGE_CLASS[status] || ""}">${escapeHtml(status)}</span>
        ${next ? `<button class="button secondary compact-button" type="button" data-request="${escapeHtml(request.id)}" data-status="${next}">→ ${next}</button>` : ""}
        ${status !== "مغلق" ? `<button class="button secondary compact-button" type="button" data-request="${escapeHtml(request.id)}" data-status="مغلق">إغلاق</button>` : `<button class="button secondary compact-button" type="button" data-request="${escapeHtml(request.id)}" data-status="جديد">إعادة فتح</button>`}
      </div>
    </article>
  `;
}

function updateAmeenBrowserResults() {
  const latest = latestStockReport();
  const items = reportItems(latest);
  const filtered = ameenFilteredItems(items);
  const results = app.querySelector("[data-ameen-results]");
  const count = app.querySelector("[data-ameen-count]");
  const exportButton = app.querySelector("[data-action='download-filtered-inventory']");

  if (results) {
    results.innerHTML = filtered.length
      ? groupedAccordion("ameen", filtered, { groupOf: (i) => i.groupName, rowOf: inventoryRow, query: state.ameenSearch })
      : '<p class="muted">لا توجد مواد تطابق البحث والفلتر الحالي.</p>';
    bindAccordions(results);
  }

  if (count) {
    count.textContent = `يعرض ${filtered.length} من ${items.length}`;
  }

  if (exportButton) {
    exportButton.disabled = filtered.length === 0;
  }

  app.querySelectorAll("[data-ameen-filter]").forEach((button) => {
    button.classList.toggle("active", button.dataset.ameenFilter === state.ameenFilter);
  });
}

function updateCustomerBalanceResults() {
  const latest = state.customerBalanceReports[0];
  const items = latest ? latestCustomerBalanceItems() : [];
  const filtered = filteredCustomerItems(items);
  const results = app.querySelector("[data-customer-results]");
  const count = app.querySelector("[data-customer-count]");
  const exportButton = app.querySelector("[data-action='download-customer-balances']");

  if (results) {
    results.innerHTML = filtered.length
      ? groupedAccordion("balances", filtered, { groupOf: (i) => customerBalance(i) > 0 ? "زبائن مدينون" : (customerBalance(i) < 0 ? "زبائن دائنون (لهم)" : "متوازنون"), rowOf: customerBalanceRow, query: state.customerSearch })
      : '<p class="muted">لا توجد زبائن تطابق البحث والفلتر الحالي.</p>';
    bindAccordions(results);
    bindCustomerLimitForms(results);
    bindCustomerDetailButtons(results);
  }

  if (count) {
    count.textContent = `يعرض ${filtered.length} من ${items.length}`;
  }

  if (exportButton) {
    exportButton.disabled = filtered.length === 0;
  }

  app.querySelectorAll("[data-customer-filter]").forEach((button) => {
    button.classList.toggle("active", button.dataset.customerFilter === state.customerFilter);
  });
}

function bindCustomerLimitForms(root = app) {
  root.querySelectorAll("[data-form='customer-limit']").forEach((form) => {
    if (form.dataset.bound === "true") return;
    form.dataset.bound = "true";
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      saveCustomerLimit(event.currentTarget);
    });
  });
}

function bindCustomerDetailButtons(root = app) {
  root.querySelectorAll("[data-customer-details]").forEach((button) => {
    if (button.dataset.bound === "true") return;
    button.dataset.bound = "true";
    button.addEventListener("click", () => {
      const key = button.dataset.customerDetails;
      state.selectedCustomerKey = key;
      state.paymentError = null;
      render();
      loadPaymentRecords(key);
      // البطاقة تُرسم أعلى القائمة — ننزل إليها تلقائياً حتى يراها المستخدم
      requestAnimationFrame(() => {
        app.querySelector("[data-customer-detail-panel]")?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    });
  });
}

function bindPricingForms(root = app) {
  root.querySelectorAll("[data-form='pricing-item']").forEach((form) => {
    if (form.dataset.bound === "true") return;
    form.dataset.bound = "true";
    form.querySelectorAll("input[name='wholesalePrice'], input[name='retailPrice']").forEach((input) => {
      input.addEventListener("input", () => {
        form.dataset.dirty = "true";
      });
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const forms = [...app.querySelectorAll("[data-form='pricing-item']")];
      const idx = forms.indexOf(event.currentTarget);
      const nextKey = forms[idx + 1]?.dataset.itemKey || "";
      const ok = await savePricingItem(event.currentTarget);
      if (ok && nextKey) {
        const nextForm = [...app.querySelectorAll("[data-form='pricing-item']")].find((f) => f.dataset.itemKey === nextKey);
        const nextInput = nextForm?.querySelector("input[name='salePrice']");
        if (nextInput) {
          const det = nextForm.closest("details.acc-group");
          if (det && !det.open) {
            det.open = true;
            const set = state.openSections.pricing || (state.openSections.pricing = new Set());
            set.add(det.dataset.accKey);
          }
          nextInput.focus();
          nextInput.select?.();
          nextForm.scrollIntoView({ block: "center", behavior: "smooth" });
        }
      }
    });
  });
}

// تحديث قائمة نتائج التسعير فقط (دون إعادة رسم الصفحة) حتى لا يضيع التركيز أثناء البحث
function updatePricingResults() {
  const items = generalPricingWorklistItems();
  const results = app.querySelector("[data-pricing-results]");
  if (!results) return;
  results.innerHTML = items.length
    ? groupedAccordion("pricing", items, { groupOf: (i) => i.groupName, rowOf: pricingRow, query: state.pricingSearch })
    : '<p class="muted">لا توجد مواد تطابق البحث الحالي.</p>';
  bindAccordions(results);
  bindPricingForms(results);
}

// أكورديون: تجميع القوائم الطويلة بعناوين مطوية
function groupedAccordion(pageKey, items, opts) {
  const groupOf = opts.groupOf, rowOf = opts.rowOf;
  const hasQuery = Boolean(opts.query && String(opts.query).trim());
  const openSet = state.openSections[pageKey] || (state.openSections[pageKey] = new Set());
  const groups = new Map();
  items.forEach((it) => {
    const g = String(groupOf(it) || "أخرى");
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(it);
  });
  const entries = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], "ar"));
  return entries
    .map(([g, arr]) => {
      const open = hasQuery || openSet.has(g);
      return `<details class="acc-group" data-acc="${escapeHtml(pageKey)}" data-acc-key="${escapeHtml(g)}"${open ? " open" : ""}>
        <summary class="acc-summary"><span class="acc-title">${escapeHtml(g)}</span><span class="acc-count">${arr.length}</span></summary>
        <div class="acc-body">${arr.map(rowOf).join("")}</div>
      </details>`;
    })
    .join("");
}

function bindAccordions(root = app) {
  root.querySelectorAll("details.acc-group").forEach((d) => {
    if (d.dataset.accBound === "true") return;
    d.dataset.accBound = "true";
    d.addEventListener("toggle", () => {
      const pg = d.dataset.acc, key = d.dataset.accKey;
      const set = state.openSections[pg] || (state.openSections[pg] = new Set());
      if (d.open) set.add(key); else set.delete(key);
    });
  });
}

function render() {
  if (state.showExchangeModal) {
    app.innerHTML = `
      <div class="modal-overlay" onclick="if(event.target === this) { state.showExchangeModal = false; render(); }">
        <div class="modal" style="max-width:420px">
          <h2>🔄 سعر صرف الدولار إلى الليرة السورية</h2>
          <p class="muted" style="margin:8px 0 16px">أدخل سعر الصرف الحالي لتحويل الأسعار وتنزيل النشرة:</p>
          <form id="exchange-form">
            <label style="display:flex;flex-direction:column;gap:4px;font-size:0.82rem;margin-bottom:14px">
              السعر (ليرة سورية مقابل دولار واحد)
              <input type="number" id="exchange-input" step="0.01" min="0" placeholder="مثال: 88000" value="${state.syriaExchangeRate}" required style="padding:8px 10px;border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:6px;font-family:monospace">
            </label>
            <div style="display:flex;gap:10px;justify-content:flex-end">
              <button class="btn btn-secondary" type="button" onclick="state.showExchangeModal = false; render()">إلغاء</button>
              <button class="btn btn-primary" type="submit">تطبيق ومعاينة</button>
            </div>
          </form>
        </div>
      </div>
    `;
    const form = app.querySelector("#exchange-form");
    if (form) {
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const input = document.getElementById("exchange-input");
        let rate;
        try {
          rate = await commitSyriaExchangeRate(input.value);
        } catch (error) {
          input.setCustomValidity(safeErrorMessage(error));
          input.reportValidity();
          return;
        }
        if (rate === null) {
          input.setCustomValidity("أدخل سعر صرف صحيحاً أكبر من صفر.");
          input.reportValidity();
          return;
        }
        input.setCustomValidity("");
        state.syriaRateConfirmed = true;
        state.showExchangeModal = false;
        openPricePreview(true);
      });
    }
    return;
  }

  if (state.pricePreview?.open) {
    const { items, latest, useSyria } = state.pricePreview;
    const previewTheme = normalizedBulletinPdfTheme(state.pricePreview.theme);
    const pageCount = customerPriceTemplatePageCount(items, useSyria);
    app.innerHTML = `
      <div class="modal-overlay" onclick="if(event.target === this){ state.pricePreview = null; render(); }">
        <div class="modal" style="max-width:920px;width:96vw;max-height:94vh;display:flex;flex-direction:column;gap:12px">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
            <div>
              <h2 style="margin:0">👁 معاينة النشرة قبل التصدير</h2>
              <p class="muted" style="margin:4px 0 0;font-size:0.8rem">${escapeHtml(items.length)} صنف — ${escapeHtml(pageCount)} صفحة${useSyria ? " — مفرّق بالليرة" : " — جملة بالدولار"}</p>
            </div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <span style="font-weight:700;font-size:0.85rem">لون PDF:</span>
              <button class="button ${previewTheme === "dark" ? "primary" : "secondary"}" type="button" data-action="price-preview-theme" data-theme="dark" aria-pressed="${previewTheme === "dark"}">داكن</button>
              <button class="button ${previewTheme === "light" ? "primary" : "secondary"}" type="button" data-action="price-preview-theme" data-theme="light" aria-pressed="${previewTheme === "light"}">فاتح</button>
              <button class="button success" type="button" data-action="export-price-preview">⬇ تصدير PDF ${previewTheme === "light" ? "الفاتح" : "الداكن"}</button>
              <button class="button secondary" type="button" data-action="close-price-preview">إغلاق</button>
            </div>
          </div>
          <div class="price-preview-scroll" style="overflow:auto;background:#9a9a9a;padding:16px;border-radius:8px;flex:1;display:flex;justify-content:center">
            ${customerPricePdfMarkup(items, latest, useSyria, previewTheme)}
          </div>
        </div>
      </div>
    `;
    app.querySelector("[data-action='export-price-preview']")?.addEventListener("click", exportPricePreview);
    app.querySelector("[data-action='close-price-preview']")?.addEventListener("click", closePricePreview);
    app.querySelectorAll("[data-action='price-preview-theme']").forEach((button) => {
      button.addEventListener("click", () => setPricePreviewTheme(button.dataset.theme));
    });
    return;
  }

  const pages = {
    overview,
    login,
    requests,
    ameen,
    balances: customerBalancesPage,
    pricing,
    remote,
    monitoring,
    payments,
    sales: salesInvoice,
    purchases,
    warehouses,
    inventoryRecon,
    smartInventory: smartInventoryPage,
    dashboard: reportsPage,
    staff: staffPage,
    search: searchPage,
    ai: aiAssistant
  };

  app.innerHTML = pages[state.route]();

  if (state.route === "smartInventory" && state.session) {
    window.SmartInventory?.bind(app, state.session, {
      render,
      notice(type, text) { setNotice(type, text); render(); }
    });
  }

  app.querySelectorAll("[data-route]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      setRoute(button.dataset.route);
    });
  });

  app.querySelectorAll("[data-task]").forEach((button) => {
    button.addEventListener("click", () => toggleItem(button.dataset.task));
  });

  app.querySelector("[data-action='toggle-theme']")?.addEventListener("click", () => {
    state.darkMode = !state.darkMode;
    applyTheme();
    render();
  });
  app.querySelector("[data-action='retry-startup']")?.addEventListener("click", () => {
    window.location.reload();
  });
  app.querySelector("[data-action='install']")?.addEventListener("click", installApp);
  app.querySelector("[data-action='logout']")?.addEventListener("click", logout);
  app.querySelector("[data-action='enable-notif']")?.addEventListener("click", requestNotifPermission);
  app.querySelector("[data-action='export-monthly']")?.addEventListener("click", exportMonthlyReport);

  app.querySelector("[data-form='global-search']")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = e.currentTarget.elements.q.value.trim();
    state.globalSearch = q;
    if (q) setRoute("search");
  });

  app.querySelectorAll("[data-search-nav]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.globalSearch = "";
      setRoute(btn.dataset.route);
    });
  });

  // Purchase invoices handlers (فواتير المشتريات — مزامنة الأمين قيد التطوير)
  app.querySelector("#po-supplier")?.addEventListener("input", (e) => {
    state.poSupplierQuery = e.currentTarget.value;
    state.poSupplierKey = "";
    state.poSupplierGuid = "";
    const box = app.querySelector("[data-po-supplier-suggest]");
    if (box) {
      const html = poSupplierSuggestionsHtml(e.currentTarget.value);
      box.innerHTML = html;
      if (html) positionSalesSuggest(e.currentTarget, box);
    }
  });
  app.querySelector("#po-supplier")?.addEventListener("blur", () => {
    setTimeout(() => {
      const box = app.querySelector("[data-po-supplier-suggest]");
      if (box) box.innerHTML = "";
    }, 180);
  });
  app.querySelector("[data-po-supplier-suggest]")?.parentElement
    ?.addEventListener("mousedown", (e) => {
      const pick = e.target.closest("[data-po-supplier-pick]");
      if (!pick) return;
      e.preventDefault();
      poPickSupplier(pick.dataset.poSupplierPick, pick.dataset.poSupplierGuid, pick.dataset.poSupplierCode);
    });
  // فواتير مشتريات الأمين (قراءة فقط) — منفصل تماماً عن نموذج المسودة أعلاه
  app.querySelector("#po-ameen-supplier")?.addEventListener("input", (e) => {
    state.poAmeenSupplierQuery = e.currentTarget.value;
    const box = app.querySelector("[data-po-ameen-supplier-suggest]");
    if (box) {
      const html = poAmeenSupplierSuggestionsHtml(e.currentTarget.value);
      box.innerHTML = html;
      if (html) positionSalesSuggest(e.currentTarget, box);
    }
  });
  app.querySelector("#po-ameen-supplier")?.addEventListener("blur", () => {
    setTimeout(() => {
      const box = app.querySelector("[data-po-ameen-supplier-suggest]");
      if (box) box.innerHTML = "";
    }, 180);
  });
  app.querySelector("[data-po-ameen-supplier-suggest]")?.parentElement
    ?.addEventListener("mousedown", (e) => {
      const pick = e.target.closest("[data-po-ameen-supplier-pick]");
      if (!pick) return;
      e.preventDefault();
      poAmeenPickSupplier(pick.dataset.poAmeenSupplierPick);
    });
  app.querySelectorAll("[data-po-ameen-nav]").forEach((btn) => {
    btn.addEventListener("click", () => {
      // القائمة مرتّبة الأحدث أولاً (idx 0 = الأحدث) — «سابقة» = أقدم = فهرس أعلى،
      // «تالية» = أحدث = فهرس أدنى.
      poAmeenNavigate(btn.dataset.poAmeenNav === "prev" ? 1 : -1);
    });
  });
  app.querySelector("#po-ameen-item-query")?.addEventListener("input", (e) => {
    state.poAmeenItemQuery = e.currentTarget.value;
    const body = app.querySelector("[data-po-ameen-items-body]");
    if (body) body.innerHTML = poAmeenItemsRowsHtml(poAmeenCurrentInvoice(), state.poAmeenItemQuery);
  });
  app.querySelector("#po-date")?.addEventListener("change", (e) => {
    state.poDate = e.currentTarget.value;
  });
  app.querySelector("#po-notes")?.addEventListener("input", (e) => {
    state.poNotes = e.currentTarget.value;
  });
  app.querySelectorAll("[data-po-currency]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.poCurrency = btn.dataset.poCurrency;
      state.poPaymentError = "";
      render();
    });
  });
  app.querySelectorAll("[data-po-pay]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.poPayMethod = btn.dataset.poPay;
      state.poPaymentError = "";
      render();
    });
  });
  app.querySelector("#po-register-payment")?.addEventListener("change", (e) => {
    state.poRegisterPayment = e.currentTarget.checked;
    state.poPaymentError = "";
    render();
  });
  app.querySelector("#po-payment-amount")?.addEventListener("input", (e) => {
    if (state.poPayMethod === "cash") return; // نقدي: القيمة محسوبة تلقائياً من الإجمالي
    state.poPaymentAmount = e.currentTarget.value;
    state.poPaymentError = "";
  });
  app.querySelector("#po-payment-date")?.addEventListener("change", (e) => {
    state.poPaymentDate = e.currentTarget.value;
  });
  app.querySelector("#po-payment-account")?.addEventListener("input", (e) => {
    state.poPaymentAccount = e.currentTarget.value;
  });
  app.querySelectorAll("[data-po-field]").forEach((input) => {
    input.addEventListener("input", (e) => {
      const i = Number(e.currentTarget.dataset.poIndex);
      const field = e.currentTarget.dataset.poField;
      if (!state.poRows[i]) return;
      if (field === "qty" || field === "price") {
        state.poRows[i][field] = e.currentTarget.value;
        if (field === "price") state.poRows[i].edited = true;
        refreshPoTotals();
      } else if (field === "q") {
        const next = window.poCalc.poNextRowAfterQueryInput(state.poRows[i], e.currentTarget.value);
        Object.assign(state.poRows[i], next);
        const box = app.querySelector(`[data-po-suggest="${i}"]`);
        if (box) {
          const html = poSuggestionsHtml(i, e.currentTarget.value);
          box.innerHTML = html;
          if (html) positionSalesSuggest(e.currentTarget, box);
        }
      }
    });
  });
  app.querySelectorAll("[data-po-field]").forEach((input) => {
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const i = Number(e.currentTarget.dataset.poIndex);
      const field = e.currentTarget.dataset.poField;
      if (field === "q") {
        const first = app.querySelector(`[data-po-suggest="${i}"] [data-po-pick]`);
        if (first) {
          poPickItem(i, first.dataset.poPick);
          return;
        }
        poFocusField(i, "qty");
        return;
      }
      if (field === "qty") {
        poFocusField(i, "price");
        return;
      }
      if (field === "price") poFocusField(i + 1, "q");
    });
  });
  app.querySelectorAll("[data-po-field='q']").forEach((input) => {
    input.addEventListener("blur", (e) => {
      const i = Number(e.currentTarget.dataset.poIndex);
      setTimeout(() => {
        const box = app.querySelector(`[data-po-suggest="${i}"]`);
        if (box) box.innerHTML = "";
      }, 180);
    });
  });
  app.querySelector("#po-body")?.addEventListener("mousedown", (e) => {
    const pick = e.target.closest("[data-po-pick]");
    if (!pick) return;
    e.preventDefault();
    poPickItem(Number(pick.dataset.poRow), pick.dataset.poPick);
  });
  app.querySelectorAll("[data-po-unit]").forEach((btn) => {
    btn.addEventListener("click", () => poToggleUnit(Number(btn.dataset.poUnit)));
  });
  app.querySelectorAll("[data-po-info]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.poInfoKey = state.poInfoKey === btn.dataset.poInfo ? "" : btn.dataset.poInfo;
      render();
    });
  });
  app.querySelectorAll("[data-po-suggest-add]").forEach((btn) => {
    btn.addEventListener("click", () => poAddSuggestedItem(btn.dataset.poSuggestAdd));
  });
  app.querySelectorAll("[data-po-remove]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.poRows.splice(Number(btn.dataset.poRemove), 1);
      if (!state.poRows.length) state.poRows.push({ q: "", key: "", name: "", num: "", unit: "unit2", qty: "1", price: "", edited: false });
      render();
    });
  });
  app.querySelector("[data-action='po-add-row']")?.addEventListener("click", () => {
    state.poRows.push({ q: "", key: "", name: "", num: "", unit: "unit2", qty: "1", price: "", edited: false });
    render();
  });
  app.querySelector("[data-action='po-save']")?.addEventListener("click", savePurchaseInvoice);
  app.querySelector("[data-action='po-reset']")?.addEventListener("click", () => {
    state.poSupplierQuery = "";
    state.poSupplierKey = "";
    state.poSupplierGuid = "";
    state.poDate = "";
    state.poNotes = "";
    state.poCurrency = "USD";
    state.poPayMethod = "credit";
    state.poRegisterPayment = false;
    state.poPaymentAmount = "";
    state.poPaymentDate = "";
    state.poPaymentAccount = "";
    state.poPaymentError = "";
    state.poInfoKey = "";
    state.poRows = [{ q: "", key: "", name: "", num: "", unit: "unit2", qty: "1", price: "", edited: false }];
    render();
  });
  app.querySelectorAll("[data-po-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.poToggle;
      state.poOpenId = state.poOpenId === id ? "" : id;
      render();
    });
  });
  app.querySelectorAll("[data-po-transition]").forEach((btn) => {
    btn.addEventListener("click", () => applyPurchaseInvoiceStatusAction(btn.dataset.poTransition, btn.dataset.poNext));
  });
  app.querySelectorAll("[data-po-correction]").forEach((btn) => {
    btn.addEventListener("click", () => openPurchaseInvoiceCorrection(btn.dataset.poCorrection));
  });
  app.querySelectorAll("[data-po-correction-cancel]").forEach((btn) => {
    btn.addEventListener("click", () => openPurchaseInvoiceCorrection(btn.dataset.poCorrectionCancel));
  });
  app.querySelectorAll("[id^='po-correction-note-']").forEach((input) => {
    input.addEventListener("input", (e) => {
      state.poCorrectionNote = e.currentTarget.value;
    });
  });
  app.querySelectorAll("[data-po-correction-submit]").forEach((btn) => {
    btn.addEventListener("click", () => submitPurchaseInvoiceCorrection(btn.dataset.poCorrectionSubmit));
  });
  app.querySelectorAll("[data-po-delete]").forEach((btn) => {
    btn.addEventListener("click", () => removePurchaseInvoice(btn.dataset.poDelete));
  });
  app.querySelectorAll("[data-po-print]").forEach((btn) => {
    btn.addEventListener("click", () => printPurchaseInvoice(btn.dataset.poPrint));
  });
  app.querySelectorAll("[data-po-copy]").forEach((btn) => {
    btn.addEventListener("click", () => copyPurchaseInvoiceText(btn.dataset.poCopy));
  });

  // ===== المستودعات والمناقلات (قراءة فقط) =====
  app.querySelectorAll("[data-warehouse-pick]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.warehouseSelectedKey = btn.dataset.warehousePick;
      state.warehouseSearch = "";
      render();
    });
  });
  app.querySelector("#warehouse-search")?.addEventListener("input", (event) => {
    state.warehouseSearch = event.currentTarget.value;
    render();
    requestAnimationFrame(() => {
      const input = app.querySelector("#warehouse-search");
      if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    });
  });
  app.querySelector("#warehouse-show-zero")?.addEventListener("change", (event) => {
    state.warehouseShowZero = event.currentTarget.checked;
    render();
  });
  app.querySelector("[data-action='warehouse-refresh']")?.addEventListener("click", async () => {
    await loadReconWarehouses();
    await loadWarehouseDashboard();
    render();
  });

  // ===== الجرد الشهري (route: inventoryRecon) =====
  app.querySelectorAll("[data-recon-warehouse]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (state.reconWarehouseKey === btn.dataset.reconWarehouse) return;
      state.reconWarehouseKey = btn.dataset.reconWarehouse;
      state.reconWarehouseName = btn.dataset.reconWarehouseName;
      state.reconRows = []; // كمية النظام تعتمد على المستودع المختار — تفريغ السطور المضافة لمستودع آخر
      render();
      await loadReconWarehouseStock(state.reconWarehouseKey);
      render();
    });
  });
  app.querySelector("#recon-date")?.addEventListener("change", (e) => {
    state.reconSessionDate = e.currentTarget.value;
  });
  app.querySelector("#recon-month")?.addEventListener("change", (e) => {
    state.reconSessionMonth = e.currentTarget.value ? `${e.currentTarget.value}-01` : "";
  });
  app.querySelector("#recon-notes")?.addEventListener("input", (e) => {
    state.reconNotes = e.currentTarget.value;
  });
  app.querySelector("#recon-item-query")?.addEventListener("input", (e) => {
    state.reconRowQuery = e.currentTarget.value;
    const box = app.querySelector("[data-recon-suggest]");
    if (box) {
      const html = reconSuggestionsHtml(e.currentTarget.value);
      box.innerHTML = html;
      if (html) positionSalesSuggest(e.currentTarget, box);
    }
  });
  app.querySelector("#recon-item-query")?.addEventListener("blur", () => {
    setTimeout(() => {
      const box = app.querySelector("[data-recon-suggest]");
      if (box) box.innerHTML = "";
    }, 180);
  });
  app.querySelector("[data-recon-suggest]")?.addEventListener("mousedown", (e) => {
    const pick = e.target.closest("[data-recon-pick]");
    if (!pick) return;
    e.preventDefault();
    reconAddItem(pick.dataset.reconPick);
  });
  app.querySelector("#recon-body")?.addEventListener("input", (e) => {
    const field = e.target.dataset.reconField;
    const key = e.target.dataset.reconKey;
    if (!field || !key) return;
    const row = (state.reconRows || []).find((r) => r.itemKey === key);
    if (!row) return;
    row[field] = e.target.value;
    if (field !== "reason") {
      const computedCell = e.target.closest("tr")?.querySelectorAll("td")[4];
      const valueCell = e.target.closest("tr")?.querySelectorAll("td")[5];
      const computed = reconRowComputed(row);
      if (computedCell) {
        const diffLabel = computed.diffType === "increase" ? "زيادة" : computed.diffType === "decrease" ? "نقص" : "—";
        computedCell.textContent = `${diffLabel}${computed.diffType !== "none" ? ` ${Math.abs(computed.diffQty).toFixed(2)}` : ""}`;
      }
      if (valueCell) valueCell.textContent = computed.settlementValue.toFixed(2);
    }
  });
  app.querySelector("#recon-body")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-recon-remove]");
    if (!btn) return;
    reconRemoveRow(btn.dataset.reconRemove);
  });
  app.querySelector("[data-action='recon-save']")?.addEventListener("click", reconSaveDraft);
  app.querySelector("[data-action='recon-reset']")?.addEventListener("click", () => {
    reconResetForm();
    render();
  });
  app.querySelectorAll("[data-action='recon-toggle']").forEach((el) => {
    el.addEventListener("click", () => reconToggleSession(el.dataset.reconId));
  });
  app.querySelectorAll("[data-action='recon-status']").forEach((btn) => {
    btn.addEventListener("click", () => {
      const session = (state.reconSessions || []).find((s) => s.id === btn.dataset.reconId);
      if (session) reconSetStatus(session, btn.dataset.reconNext);
    });
  });
  app.querySelectorAll("[data-action='recon-delete']").forEach((btn) => {
    btn.addEventListener("click", () => {
      const session = (state.reconSessions || []).find((s) => s.id === btn.dataset.reconId);
      if (session) reconDeleteDraft(session);
    });
  });
  app.querySelectorAll("[data-action='recon-pdf']").forEach((btn) => {
    btn.addEventListener("click", () => {
      const session = (state.reconSessions || []).find((s) => s.id === btn.dataset.reconId);
      if (session) saveReconSessionPdf(session);
    });
  });

  // ===== فاتورة مبيعات (route: sales) =====
  app.querySelector("#sales-customer")?.addEventListener("input", (e) => {
    state.salesCustomer = e.currentTarget.value; // بلا render حفاظاً على التركيز
    refreshSalesTotals(); // يحدّث لوحة رصيد الزبون مع كل حرف
  });
  app.querySelector("#sales-discount")?.addEventListener("input", (e) => {
    const normalized = normalizeNumericText(e.currentTarget.value, { allowNegative: false, allowDecimal: true });
    if (normalized !== e.currentTarget.value) e.currentTarget.value = normalized;
    state.salesDiscount = e.currentTarget.value;
    refreshSalesTotals();
  });
  app.querySelector("#sales-paid")?.addEventListener("input", (e) => {
    if (state.salesPayMethod === "cash") return; // النقدي تلقائي = الصافي
    const normalized = normalizeNumericText(e.currentTarget.value, { allowNegative: false, allowDecimal: true });
    if (normalized !== e.currentTarget.value) e.currentTarget.value = normalized;
    state.salesPaid = e.currentTarget.value;
    refreshSalesTotals();
  });
  app.querySelectorAll("[data-sales-field]").forEach((input) => {
    input.addEventListener("input", (e) => {
      const i = Number(e.currentTarget.dataset.salesIndex);
      const field = e.currentTarget.dataset.salesField;
      if (!state.salesRows[i]) return;
      if (field === "qty" || field === "price") {
        const normalized = normalizeNumericText(e.currentTarget.value, { allowNegative: false, allowDecimal: true });
        if (normalized !== e.currentTarget.value) e.currentTarget.value = normalized;
        state.salesRows[i][field] = e.currentTarget.value;
        if (field === "price") state.salesRows[i].edited = true;
        refreshSalesTotals();
      } else if (field === "q") {
        const eng = salesToEnglishDigits(e.currentTarget.value);
        if (eng !== e.currentTarget.value) e.currentTarget.value = eng;
        state.salesRows[i].q = e.currentTarget.value;
        const box = app.querySelector(`[data-sales-suggest="${i}"]`);
        if (box) {
          const html = salesSuggestionsHtml(i, e.currentTarget.value);
          box.innerHTML = html;
          if (html) positionSalesSuggest(e.currentTarget, box);
        }
      }
    });
  });
  // اختصارات كيبورد للعمل بلا ماوس: Enter ينتقل بحث ← كمية ← سعر ← بحث السطر التالي،
  // وفي حقل البحث يعتمد أول اقتراح ظاهر مباشرة بدل النقر عليه.
  app.querySelectorAll("[data-sales-field]").forEach((input) => {
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const i = Number(e.currentTarget.dataset.salesIndex);
      const field = e.currentTarget.dataset.salesField;
      if (field === "q") {
        const first = app.querySelector(`[data-sales-suggest="${i}"] [data-sales-pick]`);
        if (first) {
          salesPickItem(i, first.dataset.salesPick);
          return;
        }
        salesFocusField(i, "qty");
        return;
      }
      if (field === "qty") {
        salesFocusField(i, "price");
        return;
      }
      if (field === "price") salesFocusField(i + 1, "q");
    });
  });
  app.querySelectorAll("[data-sales-field='q']").forEach((input) => {
    input.addEventListener("blur", (e) => {
      const i = Number(e.currentTarget.dataset.salesIndex);
      // تأخير بسيط كي تُسجَّل نقرة الاقتراح قبل إخفاء القائمة.
      setTimeout(() => {
        const box = app.querySelector(`[data-sales-suggest="${i}"]`);
        if (box) box.innerHTML = "";
      }, 180);
    });
  });
  // تفويض حدث للاقتراحات لأنها تُحقن ديناميكياً؛ mousedown+preventDefault يمنع blur المبكر.
  app.querySelector("#sales-body")?.addEventListener("mousedown", (e) => {
    const pick = e.target.closest("[data-sales-pick]");
    if (!pick) return;
    e.preventDefault();
    salesPickItem(Number(pick.dataset.salesRow), pick.dataset.salesPick);
  });
  app.querySelectorAll("[data-sales-unit]").forEach((btn) => {
    btn.addEventListener("click", () => salesToggleUnit(Number(btn.dataset.salesUnit)));
  });
  // بطاقة معلومات الصنف: تُحمَّل التفاصيل عند أول فتح فقط (تقرير كبير).
  app.querySelectorAll("[data-sales-info]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      state.salesInfoKey = btn.dataset.salesInfo;
      render();
      let changed = false;
      if (!state.itemDetails) { await loadItemDetails(); changed = true; }
      // التكاليف للمدير فقط — loadItemCosts يرجع [] لغيره (وRLS يمنعها أصلاً).
      if (isOwner() && !(state.itemCosts || []).length) { await loadItemCosts(); changed = true; }
      if (changed && state.salesInfoKey) render();
    });
  });
  bindSalesInfoClose(app);
  app.querySelectorAll("[data-sales-remove]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.salesRows.splice(Number(btn.dataset.salesRemove), 1);
      salesEnsureTrailingRow();
      render();
    });
  });
  app.querySelectorAll("[data-sales-mode]").forEach((btn) => {
    btn.addEventListener("click", () => salesSetMode(btn.dataset.salesMode));
  });
  app.querySelectorAll("[data-sales-pay]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.salesPayMethod = btn.dataset.salesPay === "credit" ? "credit" : "cash";
      if (state.salesPayMethod === "cash") state.salesPaid = "";
      render();
    });
  });
  app.querySelector("[data-action='sales-save']")?.addEventListener("click", salesSaveInvoice);
  app.querySelector("[data-action='sales-print']")?.addEventListener("click", printSalesInvoice);
  app.querySelector("[data-action='sales-pdf']")?.addEventListener("click", saveSalesInvoicePdf);
  app.querySelector("[data-action='sales-new']")?.addEventListener("click", salesNewInvoice);

  // فتح/إغلاق أرشيف الفواتير. لا يمسّ أسطر الفاتورة الحالية ولا رقمها،
  // فالرجوع يعيد النموذج كما تركته تماماً.
  app.querySelector("[data-action='sales-history-open']")?.addEventListener("click", () => {
    state.salesHistoryOpen = true;
    render();
  });
  app.querySelector("[data-action='sales-history-close']")?.addEventListener("click", () => {
    cancelSalesHistorySearch();
    state.salesHistoryOpen = false;
    render();
  });
  // البحث يعيد الرسم كي يشمل كل الفواتير لا المعروضة منها فقط. الرسم مؤجَّل ربع
  // ثانية ويُعاد بعده التركيز وموضع المؤشر، فلا تنقطع الكتابة ولا يبقى نص بحث
  // ظاهر بلا أثر على القائمة.
  const salesHistorySearch = app.querySelector("#sales-history-q");
  if (salesHistorySearch) {
    salesHistorySearch.addEventListener("input", (event) => {
      state.salesHistoryQuery = event.target.value;
      if (salesHistorySearchTimer) clearTimeout(salesHistorySearchTimer);
      salesHistorySearchTimer = setTimeout(() => {
        salesHistorySearchTimer = null;
        // حارس عند الإطلاق: إعادة الرسم لا تحدث إلا والمستخدم فعلاً داخل أرشيف
        // المبيعات بجلسة قائمة. شرط المسار يغطي التحويلات المباشرة إلى
        // `login` التي لا تمرّ بـsetRoute، وأي تحويل مستقبلي مثلها.
        if (!state.salesHistoryOpen || !state.session || state.route !== "sales") return;
        state.salesHistoryFocus = true;
        render();
      }, 250);
    });
    if (state.salesHistoryFocus) {
      state.salesHistoryFocus = false;
      const caret = salesHistorySearch.value.length;
      salesHistorySearch.focus();
      try {
        salesHistorySearch.setSelectionRange(caret, caret);
      } catch {
        // بعض المتصفحات تمنع تحريك المؤشر برمجياً — التركيز وحده يكفي.
      }
    }
  }

  app.querySelector("[data-action='ai-clear']")?.addEventListener("click", () => {
    state.aiMessages = [];
    render();
  });

  app.querySelectorAll("[data-ai-provider]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.aiProvider = btn.dataset.aiProvider;
      render();
    });
  });

  const aiForm = app.querySelector("[data-form='ai-chat']");
  if (aiForm) {
    const aiTextarea = aiForm.querySelector("textarea");
    aiTextarea?.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        if (!state.aiLoading) {
          sendAiMessage(aiTextarea.value);
          aiTextarea.value = "";
        }
      }
    });
    aiForm.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!state.aiLoading && aiTextarea) {
        sendAiMessage(aiTextarea.value);
        aiTextarea.value = "";
      }
    });
  }
  app.querySelector("[data-action='export-ameen']")?.addEventListener("click", exportRequestsForAmeen);
  app.querySelector("[data-action='download-prices']")?.addEventListener("click", downloadFilteredPriceList);
  app.querySelector("[data-action='download-price-template']")?.addEventListener("click", downloadLivePriceTemplate);
  app.querySelector("[data-action='download-daily-pricing']")?.addEventListener("click", downloadDailyPricingWorklist);
  app.querySelectorAll("[data-action='download-customer-price-pdf']").forEach((button) => {
    button.addEventListener("click", () => openFreshPricePreview(false));
  });
  app.querySelectorAll("[data-action='download-customer-price-syria']").forEach((button) => {
    button.addEventListener("click", () => openFreshPricePreview(true));
  });
  app.querySelectorAll("[data-action='select-bulletin-theme']").forEach((button) => {
    button.addEventListener("click", () => {
      storeBulletinPdfTheme(button.dataset.theme);
      render();
    });
  });
  app.querySelector("[data-action='publish-bulletin']")?.addEventListener("click", publishBulletin);
  const publishedExchangeRateInput = app.querySelector("[data-published-exchange-rate]");
  publishedExchangeRateInput?.addEventListener("input", (event) => {
    // كتابة محلية فورية فقط للمعاينة اللحظية — لا حفظ على Supabase قبل blur.
    applySyriaExchangeRateLocally(event.currentTarget.value);
  });
  publishedExchangeRateInput?.addEventListener("change", async (event) => {
    let rate;
    try {
      rate = await commitSyriaExchangeRate(event.currentTarget.value);
    } catch (error) {
      state.bulletinStatus = { type: "error", msg: `❌ تعذر حفظ سعر الصرف: ${safeErrorMessage(error)}` };
      refreshBulletinStatusNotice();
      return;
    }
    if (rate === null) {
      state.bulletinStatus = { type: "error", msg: "أدخل سعر صرف صحيحاً أكبر من صفر." };
      refreshBulletinStatusNotice();
      return;
    }
    scheduleBulletinPublish({ label: `سعر الصرف ${rate.toLocaleString()}`, cloudFallback: false });
    // لا نعيد رسم الصفحة هنا: إعادة الرسم أثناء blur كانت تستبدل زر المعاينة
    // أو النشر قبل وصول click إليه، فتضيع النقرة الأولى للمستخدم.
  });
  app.querySelector("[data-action='download-approved-prices']")?.addEventListener("click", downloadApprovedPricesForAccounting);
  app.querySelector("[data-action='download-inventory']")?.addEventListener("click", downloadLatestInventoryReport);
  app.querySelector("[data-action='download-filtered-inventory']")?.addEventListener("click", downloadFilteredInventoryReport);
  app.querySelector("[data-action='download-customer-balances']")?.addEventListener("click", downloadFilteredCustomerBalances);
  app.querySelector("[data-action='refresh-ameen']")?.addEventListener("click", refreshAmeenReports);
  app.querySelector("[data-action='clear-customer-details']")?.addEventListener("click", () => {
    state.selectedCustomerKey = "";
    state.paymentError = null;
    render();
  });

  app.querySelector("[data-action='export-statement']")?.addEventListener("click", exportCustomerStatementPdf);
  app.querySelector("[data-action='toggle-currency']")?.addEventListener("click", () => {
    const item = selectedCustomer(latestCustomerBalanceItems());
    if (!item) { setNotice("error", "اختر زبونًا أولاً."); render(); return; }
    const next = customerCurrency(item) === "$" ? "ل.س" : "$";
    setCustomerCurrencyOverride(item, next);
    setNotice("success", `عملة الزبون الآن: ${next}`);
    render();
  });
  app.querySelectorAll("[data-action='gen-movement-doc']").forEach((el) => {
    el.addEventListener("click", () => {
      // نقرة ثانية أثناء تجهيز المستند تُتجاهَل: وإلا صدر سندان برقمين مختلفين
      // للدفعة نفسها. الحارس على مستوى الوحدة كي يصمد أمام إعادة رسم الصفحة.
      if (voucherExportBusy) return;
      voucherExportBusy = true;
      setTimeout(() => { voucherExportBusy = false; }, 1500);
      const item = selectedCustomer(latestCustomerBalanceItems());
      if (!item) { setNotice("error", "اختر زبونًا أولاً."); render(); return; }
      const debit = Number(el.dataset.debit || 0);
      const credit = Number(el.dataset.credit || 0);
      const key = customerKey(item);
      const base = {
        name: item.name || "",
        phone: customerProfile(key)?.phone || "",
        date: el.dataset.date || todayIsoDate(),
        notes: el.dataset.notes || "",
        cur: customerCurrency(item)
      };
      // الرصيد المُخزَّن من دفتر الأمين لهذا القيد بالذات — ممرَّر مع الزر، بلا أي مطابقة.
      const storedBal = el.dataset.balance !== undefined && el.dataset.balance !== ""
        ? Number(el.dataset.balance) : null;
      // الرصيد الزمني الحقيقي للمستند (لا يتضخّم بدفعة نفس اليوم). يسقط لرصيد الكشف إن غاب.
      const storedBalChrono = el.dataset.balanceChrono !== undefined && el.dataset.balanceChrono !== ""
        ? Number(el.dataset.balanceChrono) : storedBal;
      const docBal = (storedBalChrono !== null && Number.isFinite(storedBalChrono)) ? storedBalChrono : storedBal;
      // رصيدا المستند بعد/قبل سند القيد كاملاً (يشملان الخصم المرافق). يسقطان إلى الرصيد الزمني.
      const storedDocNew = el.dataset.docNew !== undefined && el.dataset.docNew !== ""
        ? Number(el.dataset.docNew) : docBal;
      const storedDocPrev = el.dataset.docPrev !== undefined && el.dataset.docPrev !== ""
        ? Number(el.dataset.docPrev) : null;
      if (debit > 0 && credit <= 0) {
        const invs = customerInvoicesFor(item.name || "").filter((x) => !x.isReturn);
        // نطابق الفاتورة التفصيلية بمعرّف القيد (قطعي) أولاً، ثم بالتاريخ/المبلغ كاحتياط.
        const bg = String(el.dataset.billGuid || "").trim().toLowerCase();
        const dOnly = String(el.dataset.date || "").slice(0, 10);
        const amtMatch = (x) => Math.abs(Number(x.total || 0) - debit) < 1;
        const dateMatch = (x) => String(x.date || "").slice(0, 10) === dOnly;
        const match = (bg ? invs.find((x) => String(x.guid || "").trim().toLowerCase() === bg) : null)
          || invs.find((x) => dateMatch(x) && amtMatch(x)) || invs.find((x) => amtMatch(x)) || invs.find((x) => dateMatch(x));
        if (match) {
          const total = match.total || debit;
          const opts = { ...base, cur: "$", type: "invoice", amount: total, no: match.number ? String(match.number) : docNumber("INV"), lines: match.lines || [] };
          if (storedDocNew !== null && Number.isFinite(storedDocNew)) {
            opts.newBalance = roundPrice(storedDocNew);
            const prev = (storedDocPrev !== null && Number.isFinite(storedDocPrev)) ? storedDocPrev : (storedDocNew - debit);
            opts.prevBalance = roundPrice(prev);
            // الحسم ودفعة الزبون يُنسبان أولاً إن توفّرا من المصدر، ويبقى ما لا
            // يُنسب «تسوية» صريحة. **فجوة بيانات معروفة:** مزامنة فواتير الأمين
            // (tools/push-customer-invoices.ps1) لا تجلب حسم رأس الفاتورة ولا
            // الدفعة المرافقة، فيبقى الفرق كله غير منسوب حتى تُجلبا — ولهذا لا
            // يُسمّى حسماً، لأن تسميته حسماً تطبع دفعة الزبون على أنها حسم.
            const knownDiscount = Math.max(0, roundPrice(Number(match.discount || 0)));
            const knownPayment = Math.max(0, roundPrice(Number(match.payment || 0)));
            if (knownDiscount > 0.009) opts.discount = knownDiscount;
            if (knownPayment > 0.009) opts.payment = knownPayment;
            const adjust = roundPrice(
              opts.prevBalance + total - knownDiscount - knownPayment - opts.newBalance
            );
            if (Math.abs(adjust) > 0.009) opts.adjust = adjust;
          } else {
            opts.balance = customerBalance(item);
          }
          exportVoucherPdf(opts);
        } else {
          setNotice("error", "لم أطابق فاتورة تفصيلية لهذه الحركة. افتح «التقارير» ← فواتير الزبون واضغط «📄 تصدير الفاتورة PDF (مع الأصناف)».");
          render();
        }
      } else if (credit > 0) {
        // مرتجع المبيعات يُقيَّد دائناً كالدفعة تماماً — نطابقه أولاً بفاتورة مرتجع فعلية
        // (بالتاريخ والمبلغ، إذ لا معرّف قيد لقيود المرتجع) لنصدّره كفاتورة مرتجع مع أصنافها.
        const retMatch = findReturnInvoiceForMovement(item.name || "", { date: el.dataset.date, credit });
        if (retMatch) {
          const opts = { ...base, cur: "$", type: "return", amount: retMatch.total || credit, no: retMatch.number ? String(retMatch.number) : docNumber("RET"), lines: retMatch.lines || [] };
          if (storedDocNew !== null && Number.isFinite(storedDocNew)) {
            opts.newBalance = roundPrice(storedDocNew);
            const prev = (storedDocPrev !== null && Number.isFinite(storedDocPrev)) ? storedDocPrev : (storedDocNew + credit);
            opts.prevBalance = roundPrice(prev);
          } else {
            opts.balance = customerBalance(item);
            opts.balanceLabel = "الرصيد بعد المرتجع";
          }
          exportVoucherPdf(opts);
        } else {
          const opts = { ...base, type: "receipt", amount: credit, no: docNumber("R") };
          if (storedDocNew !== null && Number.isFinite(storedDocNew)) {
            opts.balance = roundPrice(storedDocNew);
            opts.balanceLabel = "الرصيد بعد الدفعة";
            // سطر ثانٍ للرصيد الحالي عند اختلافه: الدفعة قد تكون تلتها فواتير،
            // فيقارن الزبون السند برصيده اليوم ويظنّ الفرق خطأً. لا يُعرض إلا من
            // تقرير محمَّل فعلاً (لا نطبع رقماً لا نعرف حداثته على مستند رسمي).
            const current = customerBalance(item);
            if (Number.isFinite(current)) {
              opts.currentBalance = roundPrice(current);
              // وقت التقرير يُطبع مع الرقم: لا ندّعي أنه رصيد اللحظة إن كانت
              // الصفحة محمَّلة منذ ساعات.
              opts.currentBalanceAt = reportSyncedAt(state.customerBalanceReports[0]);
            }
          } else {
            opts.balance = customerBalance(item);
            opts.balanceLabel = "الرصيد الحالي";
          }
          exportVoucherPdf(opts);
        }
      } else {
        setNotice("error", "لا يمكن تصدير هذا القيد."); render();
      }
    });
  });
  app.querySelectorAll("[data-action='gen-invoice-doc']").forEach((el) => {
    el.addEventListener("click", () => {
      try {
        const cust = el.dataset.customer || "";
        const invs = customerInvoicesFor(cust);
        const inv = invs.find((x) => String(x.number || "") === el.dataset.invNumber && String(x.date || "") === el.dataset.invDate)
          || invs.find((x) => String(x.number || "") === el.dataset.invNumber);
        if (!inv) { setNotice("error", "تعذّر إيجاد الفاتورة."); render(); return; }
        const invoiceTotal = inv.total || 0;
        const custItem = smartNameMatch(latestCustomerBalanceItems(), (it) => it.name, cust);
        const opts = {
          type: inv.isReturn ? "return" : "invoice",
          name: cust,
          amount: invoiceTotal,
          cur: "$",
          date: inv.date || todayIsoDate(),
          no: inv.number ? String(inv.number) : docNumber(inv.isReturn ? "RET" : "INV"),
          lines: inv.lines || []
        };
        // الرصيد قبل/بعد الفاتورة من قيدها في دفتر الأمين. نستعمل الرصيد **الزمني الحقيقي**
        // (balanceChrono) لا رصيد ترتيب-الكشف، كي لا يتضخّم رصيد الفاتورة إن جاءت دفعة بينها
        // وبين فاتورة أخرى في نفس اليوم. المطابقة بالمعرّف أو بالتاريخ/المبلغ (المعرّف قد يكون صفرياً).
        // قيود المرتجع لا تحمل معرّف قيد، فتُستثنى وتعرض الرصيد الحالي فقط.
        // عند أي خطأ في حساب الرصيد نتجاهله ونعرض الرصيد الحالي فقط — دون منع تصدير الفاتورة.
        try {
          const mv = inv.isReturn ? null : invoiceMovement(cust, inv);
          const db = mv ? movementDocBalances(mv) : null;
          if (db && Number.isFinite(db.newBalance) && Number.isFinite(db.prevBalance)) {
            opts.newBalance = roundPrice(db.newBalance);
            opts.prevBalance = roundPrice(db.prevBalance);
            // (السابق + قيمة الفاتورة) − الجديد = حسم/تسوية مُسجَّل بنفس سند الفاتورة.
            const adjust = roundPrice(opts.prevBalance + invoiceTotal - opts.newBalance);
            if (Math.abs(adjust) > 0.009) opts.adjust = adjust;
          } else {
            opts.balance = custItem ? customerBalance(custItem) : null;
            if (inv.isReturn) opts.balanceLabel = "الرصيد بعد المرتجع";
          }
        } catch (_balErr) {
          opts.balance = custItem ? customerBalance(custItem) : null;
        }
        exportVoucherPdf(opts);
      } catch (error) {
        setNotice("error", "تعذّر تصدير الفاتورة: " + (error && error.message ? error.message : String(error)));
        render();
      }
    });
  });
  app.querySelector("[data-form='voucher-payment']")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const f = event.target;
    const g = (n) => (f.querySelector(`[name='${n}']`)?.value || "").trim();
    const amount = toNumber(g("amount"));
    if (!g("name") || !(amount > 0)) { setNotice("error", "أدخل المستفيد والمبلغ."); render(); return; }
    exportVoucherPdf({
      type: "payment",
      name: g("name"),
      amount: amount,
      cur: g("cur") || "ل.س",
      date: g("date") || todayIsoDate(),
      method: g("method"),
      notes: g("notes"),
      no: docNumber("PV")
    });
  });
  app.querySelector("[data-action='report-receivables']")?.addEventListener("click", exportReceivablesPdf);
  app.querySelector("[data-action='report-inventory']")?.addEventListener("click", exportInventoryReportPdf);
  app.querySelector("[data-action='report-stagnant']")?.addEventListener("click", exportStagnantMaterialsPdf);
  app.querySelector("[data-report-customer]")?.addEventListener("change", (event) => {
    const m = findBalanceCustomerByText(event.target.value);
    if (m) { state.selectedCustomerKey = customerKey(m); render(); }
  });
  app.querySelector("[data-action='report-statement']")?.addEventListener("click", () => {
    const sel = app.querySelector("[data-report-customer]");
    const m = sel ? findBalanceCustomerByText(sel.value) : null;
    if (!m) {
      setNotice("error", "اكتب اسم زبون موجود بالقائمة ثم اضغط تنزيل.");
      render();
      return;
    }
    state.selectedCustomerKey = customerKey(m);
    exportCustomerStatementPdf();
  });
  app.querySelector("[data-daily-date]")?.addEventListener("change", (event) => {
    loadDailyMovement(event.target.value || todayIsoDate());
  });
  app.querySelector("[data-action='daily-refresh']")?.addEventListener("click", () => {
    loadDailyMovement(state.dailyMovementDate || todayIsoDate());
  });

  // تحميل تقرير الحركة اليومية تلقائياً عند فتح صفحة التقارير
  if (state.route === "dashboard" && state.session && !state.dailyMovementLoading) {
    const want = state.dailyMovementDate || todayIsoDate();
    if (state.dmFetchedFor !== want) loadDailyMovement(want);
  }

  app.querySelector("[data-action='print-overdue']")?.addEventListener("click", printOverdueReport);

  app.querySelectorAll("[data-form='record-payment']").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const key = form.dataset.customerKey;
      const name = form.dataset.customerName;
      const amount = formValue(form, "amount");
      const date = formValue(form, "date");
      const notes = formValue(form, "notes");
      state.paymentLoading = true;
      state.paymentError = null;
      render();
      try {
        await dataStore.createPaymentRecord({ customerKey: key, customerName: name, amount, paymentDate: date, notes });
        form.reset();
        form.querySelector("[name='date']").value = new Date().toISOString().slice(0, 10);
        setNotice("success", "تم تسجيل الدفعة بنجاح ✓");
        await loadPaymentRecords(key);
        try {
          const custItem = latestCustomerBalanceItems().find((i) => customerKey(i) === key)
            || { name: name, customerGuid: null, balance: 0 };
          await sendReceiptWhatsapp(custItem, amount, date, notes);
        } catch (waErr) {
          setNotice("error", "تم تسجيل الدفعة، لكن تعذّر تجهيز رسالة الواتساب: " + (waErr.message || ""));
        }
      } catch (error) {
        state.paymentLoading = false;
        state.paymentError = error.message;
        render();
      }
    });
  });

  app.querySelectorAll("[data-form='customer-profile']").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const key = form.dataset.customerKey;
      const name = form.dataset.customerName;
      try {
        await dataStore.upsertCustomerProfile({ customerKey: key, customerName: name, phone: formValue(form, "phone"), address: formValue(form, "address"), notes: formValue(form, "notes") });
        await loadCustomerProfiles();
        setNotice("success", "تم حفظ معلومات الزبون ✓");
        render();
      } catch (error) {
        setNotice("error", error.message);
        render();
      }
    });
  });

  app.querySelector("[data-ameen-search]")?.addEventListener("input", (event) => {
    state.ameenSearch = event.currentTarget.value;
    updateAmeenBrowserResults();
  });

  app.querySelector("[data-ameen-sort]")?.addEventListener("change", (event) => {
    state.ameenSort = event.currentTarget.value;
    updateAmeenBrowserResults();
  });

  app.querySelector("[data-pricing-search]")?.addEventListener("input", (event) => {
    state.pricingSearch = event.currentTarget.value;
    updatePricingResults();
  });

  app.querySelectorAll("[data-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.priceMode = btn.dataset.mode === "mufrak" ? "mufrak" : "jumla";
      writeJson("price-mode", state.priceMode);
      render();
    });
  });

  app.querySelectorAll("[data-ameen-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.ameenFilter = button.dataset.ameenFilter;
      updateAmeenBrowserResults();
    });
  });

  app.querySelector("[data-customer-search]")?.addEventListener("input", (event) => {
    state.customerSearch = event.currentTarget.value;
    updateCustomerBalanceResults();
  });

  app.querySelector("[data-customer-sort]")?.addEventListener("change", (event) => {
    state.customerSort = event.currentTarget.value;
    updateCustomerBalanceResults();
  });

  app.querySelectorAll("[data-customer-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.customerFilter = button.dataset.customerFilter;
      updateCustomerBalanceResults();
    });
  });

  bindCustomerLimitForms();
  bindCustomerDetailButtons();
  bindPricingForms();
  bindAccordions();

  // واتساب أُلغي — أُزيلت معالجات الإرسال الجماعي (التحويل إلى Google Drive)

  app.querySelector("[data-form='login']")?.addEventListener("submit", (event) => {
    event.preventDefault();
    saveSession(event.currentTarget, event.submitter?.dataset.authAction || "signin");
  });

  app.querySelector("[data-action='forgot-password']")?.addEventListener("click", (event) => {
    requestPasswordReset(event.currentTarget.closest("form"));
  });

  app.querySelector("[data-form='password-recovery']")?.addEventListener("submit", (event) => {
    event.preventDefault();
    saveRecoveredPassword(event.currentTarget);
  });

  app.querySelector("[data-form='password-recovery-code']")?.addEventListener("submit", (event) => {
    event.preventDefault();
    saveRecoveredPasswordCode(event.currentTarget);
  });

  app.querySelector("[data-action='cancel-password-reset']")?.addEventListener("click", () => {
    state.passwordResetMode = false;
    state.passwordResetEmail = "";
    state.notice = null;
    window.history.replaceState({}, "", `${window.location.pathname}?route=login`);
    render();
  });

  app.querySelector("[data-form='request']")?.addEventListener("submit", (event) => {
    event.preventDefault();
    addRequest(event.currentTarget);
  });

  app.querySelector("[data-form='inventory-counter-login']")?.addEventListener("submit", (event) => {
    event.preventDefault();
    saveInventoryCounterSession(event.currentTarget);
  });

  app.querySelector("[data-form='ameen-import']")?.addEventListener("submit", (event) => {
    event.preventDefault();
    importAmeenReport(event.currentTarget);
  });

  app.querySelector("[data-form='live-price-import']")?.addEventListener("submit", (event) => {
    event.preventDefault();
    importLivePriceList(event.currentTarget);
  });

  app.querySelectorAll("[data-request]").forEach((button) => {
    button.addEventListener("click", () => updateRequest(button.dataset.request, button.dataset.status));
  });
}

boot();

setInterval(() => {
  if (isInventoryCounter()) return;
  // لا نقاطع المستخدم أثناء الكتابة في نموذج
  const active = document.activeElement;
  if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT")) return;
  const autoRefreshRoutes = ["ameen", "balances", "pricing", "dashboard", "payments"];
  if (autoRefreshRoutes.includes(state.route) && (!dataStore.isConfigured() || state.session)) {
    Promise.all([loadInventoryReports(), loadCustomerBalanceReports(), loadCustomerCreditLimits(), loadApprovedPriceItems()])
      .then(() => render())
      .catch(() => {});
  }
}, 60000);

setInterval(async () => {
  if (isInventoryCounter()) return;
  if (!state.session && dataStore.isConfigured()) return;
  try {
    const fresh = await dataStore.listRequests();
    const newOnes = fresh.filter((r) => !state.seenRequestIds.has(r.id));
    newOnes.forEach((r) => {
      fireRequestNotif(r.customer);
      state.seenRequestIds.add(r.id);
    });
    if (newOnes.length) {
      state.requests = fresh;
      render();
    }
  } catch {}
}, 30000);
