// مشغّل محلي لدالة المساعد الذكي (supabase/functions/financial-assistant).
//
// لماذا وحدة مشتركة: ثلاثة حرّاس يحتاجون **نفس** التحميل بالضبط —
// التخويل (check-assistant-authorization) والتوجيه (check-assistant-routing)
// والقراءة-فقط (check-assistant-read-only). نسخ الحمولة الوهمية ثلاث مرات يعني
// أن تشديد أحدها يترك ثغرة في الآخرين.
//
// لماذا لا نستعمل نمط vm.createContext + شطب الأنواع بـregex الموجود في
// check-owner-authorization-behavior.mjs: ذاك النمط يشطب مجموعة محدودة من صيغ
// TypeScript بتعابير نمطية، وينكسر صامتاً أمام type aliases والـgenerics
// والـcasts التي يستعملها هذا الملف بكثافة. Node 22 يشطب الأنواع أصلاً وبشكل
// صحيح، فنشغّل **الملف الحقيقي** بدل نسخة مشوّهة منه — والحارس الذي يفحص كوداً
// غير الكود المنشور حارسٌ بلا قيمة.
//
// المنهج: نسخة مؤقتة من الملف بعد إزالة استيراد jsr (لا يحلّه Node)، ثم
// import ديناميكي بعد تركيب Deno وfetch وهميين على globalThis. اسم فريد لكل
// تشغيل يتفادى ذاكرة وحدات ESM فيبقى كل اختبار معزولاً بحمولته.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const FUNCTION_PATH = fileURLToPath(
  new URL("../../supabase/functions/financial-assistant/index.ts", import.meta.url)
);

export const functionSource = () => fs.readFileSync(FUNCTION_PATH, "utf8");
export const functionFile = FUNCTION_PATH;

// رموز الجلسات الوهمية. القيمة نفسها لا معنى لها — المهم أن التحقق يجري على
// الخادم عبر /auth/v1/user، وهذا ما تفرضه الاختبارات.
export const TOKENS = {
  owner: "token-owner",
  employee: "token-employee",
  counter: "token-inventory-counter",
  roleless: "token-no-role",
  expired: "token-expired"
};

// نفس أشكال الحسابات الحقيقية في auth.users (تحقّق 2026-09-06):
// المالك بـ app_metadata.role='owner'، الموظف 'employee'، حساب الجرد
// 'inventory_counter'، وحساب المحاسب بلا أي دور.
const USERS = {
  [TOKENS.owner]: { id: "9724dbe4-owner", email: "ozkkhalouf@gmail.com", app_metadata: { role: "owner" } },
  [TOKENS.employee]: { id: "0effbc8d-emp", email: "ozk.kh@outlook.com", app_metadata: { role: "employee" } },
  [TOKENS.counter]: { id: "3fc72fee-cnt", email: "inventory-x@accounts.ozktobacco.com", app_metadata: { role: "inventory_counter" } },
  [TOKENS.roleless]: { id: "741cef72-acc", email: "khalelkhallouf1196@gmail.com", app_metadata: {} }
};

const jsonResponse = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// ── حمولات واقعية، مأخوذة من أشكال الصفوف الفعلية في Supabase ────────────────
export function defaultFixtures() {
  return {
    daily_movement_reports: [{
      report_date: "2026-09-06",
      created_at: new Date().toISOString(),
      payload: {
        date: "2026-09-06",
        cashboxes: [
          { code: "133", name: "صندوق مبيعات المركز $", currency: "$", opening: 1200, incoming: 300, outgoing: 100, closing: 1400 },
          { code: "140", name: "صندوق الليرة", currency: "ل.س.", opening: 21304400.5, incoming: 0, outgoing: 0, closing: 21304400.5 }
        ],
        cashTotals: [
          { currency: "$", opening: 2193.09, closing: 2193.09, externalIncoming: 0, externalOutgoing: 0 },
          { currency: "ل.س.", opening: 21304400.5, closing: 21304400.5, externalIncoming: 0, externalOutgoing: 0 }
        ],
        payments: [
          { name: "مركز الخيال / مساكن برزة", amount: 8500, notes: "بيد ابو زياد" },
          { name: "جهاد التلي", amount: 1500, notes: "" }
        ],
        paymentSummary: { count: 2, totalUsd: 10000 }
      }
    }],
    expense_entries: [
      { entry_date: "2026-09-06", account_name: "محروقات", amount: 45, notes: "" },
      { entry_date: "2026-09-06", account_name: "أجور نقل", amount: 120, notes: "" }
    ],
    sales_line_items: [
      { sale_date: "2026-09-06", bill_no: "101", bill_type: "wholesale", item_name: "ماستر طويل ورق", qty: 25, line_total: 8875, net_profit: 400, unit_cost: 339, customer_name: "جهاد التلي" },
      { sale_date: "2026-09-06", bill_no: "101", bill_type: "wholesale", item_name: "كينغ دوم سليم", qty: 15, line_total: 70.5, net_profit: 6, unit_cost: 4.3, customer_name: "جهاد التلي" },
      { sale_date: "2026-09-06", bill_no: "102", bill_type: "retail", item_name: "ماستر طويل ورق", qty: 5, line_total: 1800, net_profit: 80, unit_cost: 344, customer_name: "زبون نقدي" }
    ],
    ameen_purchase_invoice_reports: [{
      report_date: "2026-09-06",
      created_at: new Date().toISOString(),
      summary: { bills: 108, suppliers: 20, fromDate: "2026-07-08" },
      items: [{
        name: "ايمن الذهبي /قداحات",
        invoices: [{ date: "2026-07-18", items: [{ itemName: "قداحات ضو بايدا جديد", qty: 600, lineTotal: 42000 }] }]
      }]
    }],
    ameen_warehouse_stock_reports: [{
      report_date: "2026-09-06",
      created_at: new Date().toISOString(),
      summary: { warehouseKey: "25771C9C", warehouseName: "مستودع المشترك", item_count: 430 },
      items: []
    }],
    ameen_warehouse_transfer_reports: [],
    ameen_account_balance_reports: [{
      report_date: "2026-09-06",
      created_at: new Date().toISOString(),
      summary: { accountCount: 408, nonZeroAccountCount: 210, accountingBasis: "ac000 Debit - Credit" },
      items: [
        { accountCode: "1301", accountName: "شام كاش", parentName: "الصناديق", balance: 5400, debit: 9000, credit: 3600 },
        { accountCode: "02", accountName: "المتاجرة", parentName: "الأرباح والخسائر", balance: 0, debit: 0, credit: 0 }
      ]
    }],
    approved_price_items: [
      { item_name: "ماستر طويل ورق", item_key: "ماستر طويل ورق", unit1_name: "كروز", unit1_price: 355, unit2_name: "كرتونة", unit2_factor: 50, unit2_price: 17750, sale_price: 355, stock_qty: 900, stock_status: "available" },
      { item_name: "كينغ دوم سليم", item_key: "كينغ دوم سليم", unit1_name: "كروز", unit1_price: 4.7, unit2_name: "كرتونة", unit2_factor: 50, unit2_price: 235, sale_price: 4.7, stock_qty: 12, stock_status: "low" }
    ],
    // inventory_reports مفهرس بالمصدر — الحمولة مصفوفة لكل source
    "inventory_reports:ameen_customer_balances": [{
      report_date: "2026-09-06",
      created_at: new Date().toISOString(),
      summary: {
        totalDebitBalance: 230551.427, totalCreditBalance: -830275.832,
        customersWithDebitBalance: 121, customersWithCreditBalance: 34, totalCustomers: 302
      },
      items: [
        { key: "مركز الخيال مساكن برزه", name: "مركز الخيال / مساكن برزة", balance: 31597.2, customerGuid: "bbb09cbf", lastPaymentDate: "2026-09-05T00:00:00", recentPayments: [{ date: "2026-09-05T00:00:00", amount: 8500, notes: "بيد ابو زياد" }] },
        { key: "جهاد التلي", name: "جهاد التلي", balance: 12000, customerGuid: "aaa11111", lastPaymentDate: "2026-09-01T00:00:00", recentPayments: [] },
        { key: "حساب دائن", name: "مورد سمير", balance: -4000, customerGuid: "ccc22222", recentPayments: [] }
      ]
    }],
    "inventory_reports:ameen_sql_agent": [{
      report_date: "2026-09-06",
      created_at: new Date().toISOString(),
      summary: { totalStockItems: 430, availableItems: 256, lowStockItems: 222, outOfStockItems: 174, activeItems: 34, staleItems: 0, threshold: 50 },
      items: [
        { key: "ماستر طويل ورق", name: "ماستر طويل ورق", status: "available", stockQty: 900, unit1Name: "كروز", unit2Name: "كرتونة", unit2Factor: 50, stockQtyUnit2: 18 },
        { key: "كينغ دوم سليم", name: "كينغ دوم سليم", status: "low", stockQty: 12, unit1Name: "كروز", unit2Name: "كرتونة", unit2Factor: 50, stockQtyUnit2: 0.24 },
        { key: "1970 سليم ازرق", name: "1970 سليم أزرق", status: "out", stockQty: 0, unit1Name: "كروز", unit2Name: "كرتونة", unit2Factor: 50, stockQtyUnit2: 0 },
        { key: "صنف راكد", name: "صنف راكد قديم", status: "available", stockQty: 500, unit1Name: "كروز", unit2Name: "كرتونة", unit2Factor: 50, stockQtyUnit2: 10 }
      ]
    }],
    "inventory_reports:ameen_daily_profit": [{
      report_date: "2026-09-06",
      created_at: new Date().toISOString(),
      summary: {
        currency: "USD", sales_gross: 10745.5, discounts: 20, returns: 0, net_sales: 10725.5,
        sales_cost: 10239, gross_profit: 486.5, expenses: 165, net_profit: 321.5,
        sales_bill_count: 2, line_count: 3, missing_cost_lines: 0, complete: true
      },
      items: []
    }],
    "inventory_reports:ameen_customer_invoices": [{
      report_date: "2026-09-06",
      created_at: new Date().toISOString(),
      summary: { bills: 643, customers: 77, fromDate: "2026-07-08" },
      items: [{
        name: "جهاد التلي",
        customerGuid: "aaa11111",
        invoices: [{
          date: "2026-08-29",
          lines: [
            { material: "ماستر طويل ورق", qty: 25, price: 355, unit1: "كروز", lineTotal: 8875 },
            { material: "كينغ دوم سليم", qty: 15, price: 4.7, unit1: "كروز", lineTotal: 70.5 }
          ]
        }]
      }]
    }]
  };
}

// تحميل نسخة معزولة من الدالة مع fetch وهمي.
// options.fixtures  — بيانات الجداول (انظر defaultFixtures)
// options.failTable — اسم جدول تفشل قراءته (لاختبار عزل فشل مصدر واحد)
// options.env       — متغيرات بيئة إضافية
export async function loadAssistant(options = {}) {
  const fixtures = options.fixtures ?? defaultFixtures();
  const metrics = {
    authCalls: 0,
    reads: [],
    writes: [],
    externalCalls: [],
    tablesRead: new Set()
  };

  const env = {
    SUPABASE_URL: "https://local.test",
    SUPABASE_SERVICE_ROLE_KEY: "local-service-role-stub",
    ...(options.env ?? {})
  };

  const stubFetch = async (input, init = {}) => {
    const url = String(input);
    const method = String(init.method ?? "GET").toUpperCase();

    if (url.startsWith("https://api.anthropic.com")) {
      metrics.externalCalls.push({ url, method, body: init.body });
      if (options.anthropic) return options.anthropic(init);
      throw new Error("anthropic_not_stubbed");
    }

    if (url.includes("/auth/v1/user")) {
      metrics.authCalls += 1;
      const token = String(init.headers?.Authorization ?? init.headers?.authorization ?? "")
        .replace(/^Bearer\s+/i, "");
      const user = USERS[token];
      if (!user) return jsonResponse(401, { error: "invalid_token" });
      return jsonResponse(200, user);
    }

    if (url.includes("/rest/v1/")) {
      if (method !== "GET") {
        metrics.writes.push({ url, method });
        throw new Error(`WRITE ATTEMPTED: ${method} ${url}`);
      }
      const query = url.split("/rest/v1/")[1] ?? "";
      const table = query.split("?")[0];
      metrics.reads.push(query);
      metrics.tablesRead.add(table);
      if (options.failTable && table === options.failTable) return jsonResponse(500, { error: "boom" });

      // inventory_reports متعدد المصادر — نفهرس بالمصدر كما يفعل PostgREST
      let key = table;
      const sourceMatch = query.match(/source=eq\.([^&]+)/);
      if (table === "inventory_reports" && sourceMatch) {
        key = `inventory_reports:${decodeURIComponent(sourceMatch[1])}`;
      }
      let rows = fixtures[key] ?? [];

      // ترشيح التاريخ لسطور المبيعات والمصاريف — نحاكي gte/lte
      const gte = query.match(/(?:sale_date|entry_date)=gte\.([0-9-]+)/);
      const lte = query.match(/(?:sale_date|entry_date)=lte\.([0-9-]+)/);
      if (gte || lte) {
        const field = table === "expense_entries" ? "entry_date" : "sale_date";
        rows = rows.filter((row) => {
          const value = String(row[field] ?? "");
          if (gte && value < gte[1]) return false;
          if (lte && value > lte[1]) return false;
          return true;
        });
      }

      // احترام order وlimit كما يفعل PostgREST. بدونهما يفشل الحارس في رؤية
      // أخطاء حقيقية: استعلام «آخر يوم فيه مبيعات» يعتمد على desc+limit=1،
      // ولو أعاد الوهميُّ الصف الأول عشوائياً لبدا الجواب صحيحاً وهو خاطئ.
      const order = query.match(/order=([\w.]+)\.(asc|desc)/);
      if (order) {
        const [, field, direction] = order;
        rows = [...rows].sort((left, right) => {
          const a2 = String(left[field] ?? "");
          const b2 = String(right[field] ?? "");
          return direction === "desc" ? (a2 < b2 ? 1 : a2 > b2 ? -1 : 0) : (a2 > b2 ? 1 : a2 < b2 ? -1 : 0);
        });
      }
      const limit = query.match(/limit=(\d+)/);
      if (limit) rows = rows.slice(0, Number(limit[1]));

      // احترام قائمة الأعمدة — هكذا يُثبَت حجب أعمدة التكلفة عن الموظف
      const select = query.match(/select=([^&]+)/);
      if (select && select[1] !== "*") {
        const columns = decodeURIComponent(select[1]).split(",");
        rows = rows.map((row) => Object.fromEntries(columns.filter((c) => c in row).map((c) => [c, row[c]])));
      }
      return jsonResponse(200, rows);
    }

    throw new Error(`Unexpected fetch: ${method} ${url}`);
  };

  // نسخة مؤقتة بلا استيراد jsr، باسم فريد لتفادي ذاكرة وحدات ESM
  const source = functionSource().replace(/^import\s+["']jsr:[^"']+["'];\s*$/m, "");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ozk-assistant-"));
  const file = path.join(dir, "assistant.ts");
  fs.writeFileSync(file, source, "utf8");

  let handler = null;
  const previous = { Deno: globalThis.Deno, fetch: globalThis.fetch };
  const denoStub = { env: { get: (name) => env[name] }, serve: (fn) => { handler = fn; } };
  globalThis.Deno = denoStub;
  globalThis.fetch = stubFetch;
  try {
    await import(pathToFileURL(file).href);
  } finally {
    globalThis.Deno = previous.Deno;
    globalThis.fetch = previous.fetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (typeof handler !== "function") throw new Error("financial-assistant did not register a handler");

  // كل طلب يُنفَّذ وfetch الوهمي مركّب — الدالة تلتقط globalThis.fetch عند النداء
  const ask = async (token, question, extra = {}) => {
    const headers = { "content-type": "application/json", origin: "http://localhost:5173" };
    if (token) headers.authorization = `Bearer ${token}`;
    const saved = { fetch: globalThis.fetch, Deno: globalThis.Deno };
    globalThis.fetch = stubFetch;
    globalThis.Deno = denoStub;
    try {
      const response = await handler(new Request("https://local-edge.test/financial-assistant", {
        method: "POST",
        headers,
        body: JSON.stringify({ messages: [{ role: "user", content: question }], ...extra })
      }));
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : {} };
    } finally {
      globalThis.fetch = saved.fetch;
      globalThis.Deno = saved.Deno;
    }
  };

  return { ask, metrics, handler, stubFetch };
}
