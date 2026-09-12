import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const PROFILE = "public";
const DEFAULT_STAFF = ["ozk.kh@outlook.com", "khalelkhalouf1196@gmail.com"];

// ============================================================
// أنواع سياق التقارير المالية (بدل any)
// البيانات جاية من Supabase REST كـ JSON، فالحقول اختيارية ونسمح بأن يكون
// السياق كله فارغاً — وهيك بنحافظ على نفس السلوك الدفاعي بدون any.
// ============================================================
type CashBox = {
  name?: string;
  currency?: string;
  opening?: unknown;
  incoming?: unknown;
  outgoing?: unknown;
  closing?: unknown;
};
type BalanceRow = { name?: string; customerName?: string; balance?: unknown };
type ExpenseRow = { entry_date?: string; account_name?: string; amount?: unknown };
type AccountRow = {
  accountCode?: string;
  accountName?: string;
  parentName?: string;
  balance?: unknown;
  debit?: unknown;
  credit?: unknown;
};

type FinancialContext = {
  account_balances?: { report_date?: string; accounts?: AccountRow[] } | null;
  customer_balances?: { report_date?: string; highest_balances?: Array<BalanceRow | null> } | null;
  daily_movement?: { report_date?: string; payload?: { cashboxes?: CashBox[] } | null } | null;
  recent_expenses?: ExpenseRow[] | null;
  daily_sales?: unknown;
  daily_profit?: { report_date?: string; summary?: unknown; items?: unknown } | null;
} | null;

function allowedOrigin(request: Request) {
  const origin = request.headers.get("origin") ?? "";
  const configured = (Deno.env.get("AI_ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const defaults = ["https://ozktobacco.com", "https://www.ozktobacco.com"];
  try {
    const url = new URL(origin);
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return origin;
  } catch { /* origin غير صالح */ }
  return [...configured, ...defaults].includes(origin) ? origin : "https://ozktobacco.com";
}

function headers(request: Request) {
  return {
    "Access-Control-Allow-Origin": allowedOrigin(request),
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
    "Content-Type": "application/json; charset=utf-8",
  };
}

function json(request: Request, status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: headers(request) });
}

async function requireStaff(request: Request) {
  const auth = request.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) throw new Error("unauthorized");
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: auth },
  });
  if (!response.ok) throw new Error("unauthorized");
  const user = await response.json();
  const email = String(user?.email ?? "").toLowerCase();
  const staff = (Deno.env.get("FINANCIAL_ASSISTANT_STAFF_EMAILS") ?? DEFAULT_STAFF.join(","))
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (!email || !staff.includes(email)) throw new Error("forbidden");
  return { id: String(user.id ?? ""), email };
}

async function rest(path: string) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Accept-Profile": PROFILE,
    },
  });
  if (!response.ok) throw new Error(`data_${response.status}`);
  return response.json();
}

function safeMessages(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(-12).map((message) => ({
    role: message?.role === "assistant" ? "assistant" : "user",
    content: String(message?.content ?? "").slice(0, 4000),
  })).filter((message) => message.content.trim());
}

async function financialContext() {
  const [accounts, balances, movement, expenses, sales, profit] = await Promise.all([
    rest("ameen_account_balance_reports?select=report_date,summary,items,created_at&order=created_at.desc&limit=1"),
    rest("inventory_reports?select=report_date,summary,items,created_at&source=eq.ameen_customer_balances&order=created_at.desc&limit=1"),
    rest("daily_movement_reports?select=report_date,payload,created_at&order=created_at.desc&limit=1"),
    rest("expense_entries?select=entry_date,account_name,amount,notes&order=entry_date.desc&limit=40"),
    rest("daily_sales_summary?select=*&order=created_at.desc&limit=1"),
    rest("inventory_reports?select=report_date,summary,items,created_at&source=eq.ameen_daily_profit&order=created_at.desc&limit=1"),
  ]);

  const accountReport = accounts?.[0] ?? null;
  const balanceReport = balances?.[0] ?? null;
  const debtors = Array.isArray(balanceReport?.items)
    ? [...balanceReport.items].sort((a, b) => Number(b?.balance ?? 0) - Number(a?.balance ?? 0)).slice(0, 40)
    : [];
  return {
    generated_at: new Date().toISOString(),
    accounting_rules: [
      "المصدر المحاسبي الموثوق هو برنامج الأمين AmnDb002.",
      "كل أرصدة دليل الحسابات بعملة الأساس USD وتحسب Debit - Credit.",
      "تقارير الصناديق تعرض كل صندوق بعملته الأصلية كما يذكر payload.",
      "هذه البيانات للقراءة والتحليل فقط، ولا يسمح المساعد بإنشاء أو تعديل قيود.",
    ],
    account_balances: accountReport ? {
      report_date: accountReport.report_date,
      created_at: accountReport.created_at,
      summary: accountReport.summary,
      accounts: Array.isArray(accountReport.items) ? accountReport.items.slice(0, 400) : [],
    } : null,
    customer_balances: balanceReport ? {
      report_date: balanceReport.report_date,
      created_at: balanceReport.created_at,
      summary: balanceReport.summary,
      highest_balances: debtors,
    } : null,
    daily_movement: movement?.[0] ?? null,
    recent_expenses: expenses ?? [],
    daily_sales: sales?.[0] ?? null,
    daily_profit: profit?.[0] ?? null,
  };
}

function amount(value: unknown, currency = "USD") {
  const number = Number(value ?? 0);
  return `${Number.isFinite(number) ? number.toLocaleString("ar-SY", { maximumFractionDigits: 2 }) : "0"} ${currency}`;
}

function normalized(value: unknown) {
  return String(value ?? "").toLowerCase()
    .replace(/[إأآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي")
    .replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

function localFinancialAnswer(question: string, context: FinancialContext) {
  const q = normalized(question);
  const date = context?.account_balances?.report_date || context?.daily_movement?.report_date || "غير متوفر";

  if (/صندوق|صناديق|سيوله|شام كاش|حركه الصندوق/.test(q)) {
    const boxes = context?.daily_movement?.payload?.cashboxes;
    if (!Array.isArray(boxes) || !boxes.length) return "لا يوجد تقرير صناديق متاح حاليًا من الأمين.";
    const lines = boxes.map((box) => `- **${box.name || "صندوق"}**: افتتاحي ${amount(box.opening, box.currency)}، وارد ${amount(box.incoming, box.currency)}، صادر ${amount(box.outgoing, box.currency)}، إغلاق ${amount(box.closing, box.currency)}`);
    return `**أرصدة وحركة الصناديق — ${context?.daily_movement?.report_date}**\n${lines.join("\n")}`;
  }

  if (/دين|ديون|ذمم|مدين|ارصده الزبائن/.test(q)) {
    const rows = context?.customer_balances?.highest_balances;
    if (!Array.isArray(rows) || !rows.length) return "لا يوجد تقرير أرصدة زبائن متاح حاليًا.";
    const debtors = rows.filter((row): row is BalanceRow => Number(row?.balance ?? 0) > 0).slice(0, 10);
    const total = debtors.reduce((sum, row) => sum + Number(row.balance || 0), 0);
    return `**أعلى الذمم المدينة — ${context?.customer_balances?.report_date}**\n${debtors.map((row) => `- ${row.name || row.customerName || "بدون اسم"}: ${amount(row.balance)}`).join("\n")}\n\nإجمالي المعروض: **${amount(total)}**`;
  }

  if (/مصروف|مصاريف|صرف/.test(q)) {
    const rows = context?.recent_expenses;
    if (!Array.isArray(rows) || !rows.length) return "لا توجد حركات مصروفات حديثة متاحة.";
    const total = rows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
    return `**آخر المصروفات المسجلة**\n${rows.slice(0, 12).map((row) => `- ${row.entry_date} — ${row.account_name}: ${amount(row.amount)}`).join("\n")}\n\nإجمالي السطور المعروضة: **${amount(total)}**`;
  }

  if (/مبيعات|مبيع/.test(q)) {
    if (!context?.daily_sales) return "لا يوجد ملخص مبيعات يومي متاح حاليًا.";
    return `**ملخص المبيعات المتاح**\n\`${JSON.stringify(context.daily_sales)}\``;
  }

  if (/ربح|ارباح|تكلفه/.test(q)) {
    if (!context?.daily_profit) return "لا يوجد تقرير ربح متاح حاليًا.";
    return `**تقرير الربح المتاح — ${context.daily_profit.report_date || date}**\n\`${JSON.stringify({ summary: context.daily_profit.summary, items: context.daily_profit.items })}\``;
  }

  const accounts = context?.account_balances?.accounts;
  if (Array.isArray(accounts) && accounts.length) {
    const stop = new Set(["رصيد", "حساب", "الحساب", "كم", "ما", "هو", "اعطني", "عرض", "اريد"]);
    const terms = q.split(" ").filter((term) => term.length > 1 && !stop.has(term));
    const matches = accounts.filter((account) => {
      const haystack = normalized(`${account.accountCode || ""} ${account.accountName || ""} ${account.parentName || ""}`);
      return terms.length > 0 && terms.every((term) => haystack.includes(term));
    }).slice(0, 12);
    if (matches.length) {
      return `**نتائج حسابات الأمين — ${context?.account_balances?.report_date}**\n${matches.map((account) => `- ${account.accountCode ? `${account.accountCode} — ` : ""}${account.accountName}: **${amount(account.balance)}** (مدين ${amount(account.debit)} / دائن ${amount(account.credit)})`).join("\n")}`;
    }
  }

  return "يمكنني حاليًا عرض: **رصيد حساب محدد، الصناديق والسيولة، ديون الزبائن، المصروفات، المبيعات، أو الربح**. اكتب مثلًا: `رصيد حساب شام كاش` أو `ما أرصدة الصناديق اليوم؟`. البيانات تبقى داخل Supabase ولا تُرسل لأي مزود ذكاء اصطناعي خارجي.";
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: headers(request) });
  if (request.method !== "POST") return json(request, 405, { error: "method_not_allowed" });
  try {
    await requireStaff(request);
    const body = await request.json().catch(() => ({}));
    const messages = safeMessages(body?.messages);
    if (!messages.length) return json(request, 400, { error: "empty_message" });
    const context = await financialContext();
    const reply = localFinancialAnswer(messages[messages.length - 1].content, context);
    return json(request, 200, { reply, provider: "internal", readOnly: true, externalDataShared: false, contextGeneratedAt: context.generated_at });
  } catch (error) {
    const code = String((error as { message?: unknown } | undefined)?.message ?? "internal_error");
    const status = code === "unauthorized" ? 401 : code === "forbidden" ? 403 : 500;
    return json(request, status, { error: code });
  }
});
