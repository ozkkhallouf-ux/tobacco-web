// ============================================================================
// المساعد الذكي لـ OZK — واجهة واحدة، عدة مصادر قراءة فقط.
//
// لماذا أُعيدت كتابته (2026-09-06):
// كان التخويل يقوم على قائمة إيميلات ثابتة بالكود:
//   DEFAULT_STAFF = ["ozk.kh@outlook.com", "khalelkhalouf1196@gmail.com"]
// وهذه القائمة انفصلت عن مصدر التخويل الحقيقي في المشروع
// (`app_metadata.role` — راجع supabase/owner-role-access.sql و
// supabase/functions/inventory-auth/index.ts). النتيجة الفعلية:
//   • حسابا المالك (app_metadata.role = 'owner') يُرفضان بـ 403 "forbidden"
//     فتظهر بالواجهة: «هذا المساعد المالي متاح للحسابات الإدارية المخوّلة فقط».
//   • بينما حساب دوره 'employee' كان مسموحاً له بقراءة الصناديق والأرباح والذمم.
//   • وأحد الإيميلين بالقائمة أصلاً غير موجود بقاعدة المستخدمين (خطأ إملائي:
//     khalelkhalouf1196 مقابل khalelkhallouf1196 الحقيقي).
// أي أن القائمة لم تكن «أضيق» من الدور بل **مختلفة عنه**: تمنع المالك وتسمح
// للموظف. الإصلاح ليس توسيع الصلاحية بل إعادتها إلى مصدر الحقيقة الواحد.
//
// قواعد ثابتة لهذا الملف:
//   1. قراءة فقط. لا يوجد ولا يجوز أن يوجد هنا أي POST/PATCH/PUT/DELETE أو
//      استدعاء RPC. الحارس `readRest` يفرض GET، و
//      scripts/check-assistant-read-only.mjs يفرضها على مستوى النص المصدري.
//   2. التخويل يُفرض هنا على الخادم من app_metadata.role، ولا يُقرأ أي دور من
//      جسم الطلب أو من الواجهة إطلاقاً.
//   3. مفتاح service role لا يغادر الخادم. الواجهة ترسل جلسة المستخدم فقط.
//   4. لا يُخترع رقم. كل أداة تعيد إمّا بيانات حقيقية بمصدرها وتاريخها، أو
//      اعترافاً صريحاً بعدم توفر البيانات.
// ============================================================================
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const PROFILE = "public";

// دمشق UTC+3 بلا توقيت صيفي — نفس الأساس المستعمل في تقارير تيليغرام
// (التقرير الصباحي 8:00 دمشق = 5:00 UTC في supabase/telegram-notifications.sql).
const DAMASCUS_OFFSET_MINUTES = 180;

// ── الأدوار ──────────────────────────────────────────────────────────────────
// مصدر الحقيقة الوحيد: auth.users.raw_app_meta_data->>'role'، وهو الحقل الذي لا
// يستطيع المستخدم تعديله بنفسه (بخلاف user_metadata). نفس ما تفرضه
// public.is_owner() على مستوى RLS.
const ROLE_RANK: Record<string, number> = {
  owner: 3,
  employee: 1
};
// inventory_counter وأي دور غير معروف = 0 ⇒ ممنوع تماماً من المساعد.
// حساب الجرد مُنشأ لمهمة واحدة (عدّ المواد) ولا يملك سياق إدارة.

type Role = "owner" | "employee";
type Actor = { id: string; email: string; role: string; rank: number };

function rankOf(role: string) {
  return ROLE_RANK[role] ?? 0;
}

// ── CORS ─────────────────────────────────────────────────────────────────────
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
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8"
  };
}

function json(request: Request, status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: headers(request) });
}

// ── سجل تدقيق — رصدها Codex (تنفيذ القراءات الحسّاسة بلا أثر تدقيقي) ─────────
// سطر log منظّم فقط، لا كتابة قاعدة بيانات: الدالة مقفلة قراءة فقط
// (scripts/check-assistant-read-only.mjs)، فأي insert هنا يُسقط تلك البوابة.
// Supabase يلتقط logs الدوال تلقائياً، فهذا كافٍ كأثر تدقيقي بلا فتح مسار كتابة.
// ممنوع تسجيل نص السؤال أو أي بيانات عائدة للعميل — فقط الفاعل والأداة والنتيجة.
function auditLog(entry: { actorId: string; role: string; toolId: string; outcome: "ok" | "error"; code?: string }) {
  console.log(JSON.stringify({
    audit: "financial_assistant_read",
    at: new Date().toISOString(),
    actorId: entry.actorId,
    role: entry.role,
    toolId: entry.toolId,
    outcome: entry.outcome,
    ...(entry.code ? { code: entry.code } : {})
  }));
}

// ── التخويل — يُفرض على الخادم فقط ────────────────────────────────────────────
async function requireActor(request: Request): Promise<Actor> {
  const auth = request.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) throw new Error("unauthorized");
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: auth }
  });
  if (!response.ok) throw new Error("unauthorized");
  const user = await response.json();
  const id = String(user?.id ?? "");
  if (!id) throw new Error("unauthorized");
  // الدور من app_metadata حصراً. user_metadata يعدّله المستخدم بنفسه فلا يُقرأ.
  const role = String(user?.app_metadata?.role ?? "").trim().toLowerCase();
  const rank = rankOf(role);
  if (rank <= 0) throw new Error("forbidden");
  return { id, email: String(user?.email ?? "").toLowerCase(), role, rank };
}

// ── قراءة فقط ────────────────────────────────────────────────────────────────
// كل وصول للبيانات يمر من هنا. الدالة لا تقبل method ولا body إطلاقاً، فلا يوجد
// مسار كتابة حتى لو أراده كود لاحق. المسارات ثابتة بالكود وتُبنى من قيم مُتحقَّق
// منها فقط (تواريخ ISO وأعداد) — لا يدخل أي نص من المستخدم في مسار PostgREST.
const READABLE_TABLES = new Set([
  "ameen_account_balance_reports",
  "ameen_purchase_invoice_reports",
  "ameen_warehouse_stock_reports",
  "ameen_warehouse_transfer_reports",
  "approved_price_items",
  "daily_movement_reports",
  "expense_entries",
  "inventory_reports",
  "expense_entries_sync_state",
  "sales_line_items",
  "sales_line_items_sync_state"
]);

async function readRest(path: string) {
  const table = path.split("?")[0];
  if (!READABLE_TABLES.has(table)) throw new Error("source_not_allowed");
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: "GET",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Accept-Profile": PROFILE
    }
  });
  if (!response.ok) throw new Error(`data_${response.status}`);
  return response.json();
}

// قراءة مُصفَّحة حتى الاستنفاد.
//
// لماذا لا يكفي `limit=N` ثم مقارنة عدد الصفوف بـN: PostgREST يقصّ الاستجابة
// عند `db-max-rows` المضبوط على الخادم (غالباً 1000 على Supabase) **مهما طلبتَ**.
// فطلبُ 25000 يعود بـ1000 صف، والمقارنة `length >= 25000` تبقى false، فيُعرض
// إجمالي مبتور **على أنه كامل** — وهو بالضبط الرقم المالي الكاذب الذي بُني هذا
// المساعد كله لمنعه. (رصدها Codex على PR #205.)
//
// المنهج: حجم الصفحة الفعلي يُشتقّ من الصفحة الأولى لا من المطلوب، ثم نتابع ما
// دامت كل صفحة ممتلئة. فيصحّ السلوك أياً كان سقف الخادم. وسقف أمان يمنع حلقة
// لا تنتهي، وبلوغه يُعلَن `partial` صراحةً بدل تمريره كإجمالي.
const PAGE_SIZE = 1000;
const HARD_ROW_CAP = 60_000;
// tools/ameen-customer-balances-query.sql: TOP 40 — أحدث 40 دفعة لكل زبون، وليس
// السجل كله. مستخدَم لاكتشاف احتمال البتر عند فراغ نتيجة الدفعات المفلترة بفترة.
const PAYMENTS_ROW_CAP = 40;

async function readPaged(path: (range: string) => string) {
  const rows: Array<Record<string, unknown>> = [];
  let pageSize = 0;
  for (let offset = 0; offset < HARD_ROW_CAP; offset += pageSize || PAGE_SIZE) {
    const page = await readRest(path(`&offset=${offset}&limit=${PAGE_SIZE}`));
    const list: Array<Record<string, unknown>> = Array.isArray(page) ? page : [];
    rows.push(...list);
    // حجم الصفحة الحقيقي = ما أعاده الخادم أول مرة (قد يكون أقل من المطلوب)
    if (!pageSize) pageSize = list.length;
    if (!list.length || list.length < pageSize) return { rows, partial: false };
  }
  return { rows, partial: true };
}

// تقارير الحركة اليومية المطلوبة.
//
// حين يذكر السائل تاريخاً («كم قبضنا أمس؟») يجب أن تُقرأ تقارير **تلك الفترة**
// لا الأحدث. كان الكود يأخذ الأحدث دائماً، فيجيب عن اليوم ويقدّمه كأنه جواب
// أمس. (رصدها Codex على PR #205.)
//
// ثم مدىً كامل لا يوم واحد: أول إصلاح رشّح `report_date` لكنه أبقى `limit=1`،
// فسؤال «كم قبضنا هذا الشهر؟» كان يعرض `paymentSummary` **ليوم واحد** على أنه
// مقبوضات الشهر — نفس الكذبة بصيغة أخفّ. (رصدها Codex ثانيةً بعد df4b3df.)
// فالقراءة الآن تشمل كل أيام الفترة، وأحدث لقطة لكل يوم هي المعتمدة، والأيام
// الغائبة تُحصى وتُعلَن لأن غيابها يبخس المجموع بصمت.
//
// وبلا تاريخ مذكور يبقى الأحدث هو الصحيح — سؤال «كم بالصندوق؟» يريد الآن.
type MovementDay = { report_date: string; payload: Record<string, unknown>; created_at: string };

async function movementReports(period: Period): Promise<{
  days: MovementDay[];
  latestAvailable: string | null;
  missingDays: string[];
}> {
  if (!period.explicit) {
    const rows = await readRest(
      "daily_movement_reports?select=report_date,payload,created_at&order=report_date.desc,created_at.desc&limit=1"
    );
    const row = (Array.isArray(rows) && rows[0]) || null;
    return { days: row ? [row as MovementDay] : [], latestAvailable: null, missingDays: [] };
  }
  // الترتيب تنازلي بالتاريخ ثم بوقت الإنشاء، فأول ظهور لكل report_date هو
  // لقطته الأحدث — وما بعده إعادة رفع لنفس اليوم تُهمَل.
  const { rows } = await readPaged((range) =>
    "daily_movement_reports?select=report_date,payload,created_at"
    + `&report_date=gte.${safeDate(period.from)}&report_date=lte.${safeDate(period.to)}`
    + `&order=report_date.desc,created_at.desc${range}`
  );
  const days: MovementDay[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const date = String(row.report_date ?? "");
    if (!date || seen.has(date)) continue;
    seen.add(date);
    days.push(row as unknown as MovementDay);
  }
  if (!days.length) {
    const latest = await readRest(
      "daily_movement_reports?select=report_date&order=report_date.desc&limit=1"
    );
    const latestDate = Array.isArray(latest) && latest[0] ? String(latest[0].report_date) : null;
    return { days: [], latestAvailable: latestDate, missingDays: [] };
  }
  return { days, latestAvailable: null, missingDays: datesInPeriod(period).filter((d) => !seen.has(d)) };
}

// أيام الفترة كلها. السقف 366 حارس ضد فترة مشوّهة — parsePeriod لا تنتج أطول
// من سنة أصلاً.
function datesInPeriod(period: Period) {
  const dates: string[] = [];
  let day = period.from;
  while (day <= period.to && dates.length < 366) {
    dates.push(day);
    day = damascusDateFrom(day, 1);
  }
  return dates;
}

// الأيام الغائبة عن الفترة المطلوبة: تُعلَن ولا تُبتلع، لأن يوماً بلا تقرير
// يجعل المجموع أقلّ من الحقيقة بلا أي أثر ظاهر في الجواب.
function missingDaysNote(missingDays: string[]) {
  if (!missingDays.length) return "";
  const shown = missingDays.slice(0, 10).join("، ");
  return `\n\n> ⚠️ **${missingDays.length} يوم${missingDays.length > 2 ? "اً" : ""} داخل الفترة بلا تقرير حركة**: ${shown}`
    + (missingDays.length > 10 ? ` و${missingDays.length - 10} غيرها` : "")
    + `.\n> المجموع أعلاه يغطي الأيام الموجودة وحدها، فاقرأه **ناقصاً لا نهائياً**.`;
}

function noMovementReport(period: Period, latestDate: string | null): ToolResult {
  return {
    ok: false,
    text: `لا يوجد تقرير حركة يومية يغطي ${period.label} (${period.from} → ${period.to}).`
      + (latestDate ? `\n\nأحدث تقرير متاح بتاريخ **${latestDate}**.` : "")
      + `\n\nلن أعطيك أرقام يوم آخر مكانه — ستبدو جواباً عن اليوم المطلوب وهي ليست كذلك.`,
    sources: ["daily_movement_reports"]
  };
}

// تقارير الربح اليومي المطلوبة (inventory_reports:ameen_daily_profit).
//
// كان الفرع يقرأ **أحدث تقرير دوماً** بلا نظر إلى ctx.period، فسؤال «كم ربحنا
// الشهر الماضي؟» كان يُجاب بربح **اليوم** الحالي معروضاً على أنه ربح الشهر —
// نفس عطل تقارير الحركة قبل movementReports أعلاه. (رصدها Codex على PR #205.)
//
// المنهج مطابق لـmovementReports: بلا فترة صريحة يُقرأ الأحدث فقط، ومع فترة
// صريحة تُقرأ كل أيامها ولقطة كل يوم الأحدث تُعتمد، وتُحصى الأيام الغائبة.
type ProfitDay = { report_date: string; summary: Record<string, unknown>; created_at: string };

async function profitReports(period: Period): Promise<{
  days: ProfitDay[];
  latestAvailable: string | null;
  missingDays: string[];
}> {
  const source = "ameen_daily_profit";
  if (!period.explicit) {
    const rows = await readRest(
      "inventory_reports?select=report_date,summary,created_at"
      + `&source=eq.${source}&order=report_date.desc,created_at.desc&limit=1`
    );
    const row = (Array.isArray(rows) && rows[0]) || null;
    return { days: row ? [row as ProfitDay] : [], latestAvailable: null, missingDays: [] };
  }
  const { rows } = await readPaged((range) =>
    "inventory_reports?select=report_date,summary,created_at"
    + `&source=eq.${source}`
    + `&report_date=gte.${safeDate(period.from)}&report_date=lte.${safeDate(period.to)}`
    + `&order=report_date.desc,created_at.desc${range}`
  );
  const days: ProfitDay[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const date = String(row.report_date ?? "");
    if (!date || seen.has(date)) continue;
    seen.add(date);
    days.push(row as unknown as ProfitDay);
  }
  if (!days.length) {
    const latest = await readRest(
      `inventory_reports?select=report_date&source=eq.${source}&order=report_date.desc&limit=1`
    );
    const latestDate = Array.isArray(latest) && latest[0] ? String(latest[0].report_date) : null;
    return { days: [], latestAvailable: latestDate, missingDays: [] };
  }
  return { days, latestAvailable: null, missingDays: datesInPeriod(period).filter((d) => !seen.has(d)) };
}

function noProfitReport(period: Period, latestDate: string | null): ToolResult {
  return {
    ok: false,
    text: `لا يوجد تقرير ربح يومي يغطي ${period.label} (${period.from} → ${period.to}).`
      + (latestDate ? `\n\nأحدث تقرير متاح بتاريخ **${latestDate}**.` : "")
      + `\n\nلن أعطيك أرقام يوم آخر مكانه — ستبدو جواباً عن الفترة المطلوبة وهي ليست كذلك.`,
    sources: ["inventory_reports:ameen_daily_profit"]
  };
}

// أحدث صف من جدول تقارير بمفتاح summary/items
async function latestReport(table: string, source?: string) {
  const filter = source ? `&source=eq.${encodeURIComponent(source)}` : "";
  const rows = await readRest(
    `${table}?select=report_date,summary,items,created_at&order=created_at.desc&limit=1${filter}`
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

// نسخة latestReport التي تحترم فترة صريحة: لفترة تاريخية (ctx.period.explicit)
// تُعاد أقرب لقطة يغطي تاريخ تقريرها الفترة المطلوبة بدل أحدث لقطة دوماً —
// وإلا فأي سؤال عن ذمم شهر ماضٍ كان يعرض الرصيد الحالي مموَّهاً بتاريخ قديم.
// بلا فترة صريحة، أو بلا لقطة تغطي الفترة، السلوك كما كان (أحدث/لا شيء).
// `source` اختياري: جداول مثل ameen_account_balance_reports بلا عمود مصدر.
// (رصدها Codex على PR #205.)
async function reportForPeriod(table: string, source: string | undefined, period: Period) {
  if (!period.explicit) return latestReport(table, source);
  const sourceFilter = source ? `&source=eq.${encodeURIComponent(source)}` : "";
  const rows = await readRest(
    `${table}?select=report_date,summary,items,created_at${sourceFilter}`
    + `&report_date=gte.${safeDate(period.from)}&report_date=lte.${safeDate(period.to)}`
    // created_at.desc بعد report_date.desc: عدة لقطات بنفس اليوم (دفع الأرصدة
    // كل 15 دقيقة يُلحق صفاً جديداً) كانت تُعاد بترتيب غير محدَّد فيقتصر limit=1
    // على لقطة صباحية بدل آخر رصيد لذلك اليوم. (رصدها Codex على PR #205.)
    + `&order=report_date.desc,created_at.desc&limit=1`
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

// ── أدوات نصية عربية ─────────────────────────────────────────────────────────
// الأرقام العربية-الهندية (٠-٩) والفارسية (۰-۹) تُردّ إلى ASCII.
//
// لوحة مفاتيح iPhone العربية — وهي الواجهة الأساسية لهذا المشروع — تكتب «٣٠»
// لا «30». وكل أنماط الفترات تطابق `\d`، فسؤال «مبيعات آخر ٣٠ يوم» كان يفشل
// في المطابقة ثم يسقط على فرع اليوم الافتراضي (fallbackDays = 0)، فيُجاب سؤالُ
// شهرٍ بمبيعات **اليوم** بلا أي إشارة إلى أن الفترة غير التي طُلبت.
// (رصدها Codex على PR #205 بعد 4fb0d18.)
const ARABIC_INDIC_DIGITS = /[\u0660-\u0669\u06F0-\u06F9]/g;
const asciiDigit = (ch: string) => String((ch.codePointAt(0)! - (ch >= "\u06F0" ? 0x06F0 : 0x0660)));

function normalize(value: unknown) {
  return String(value ?? "")
    .replace(ARABIC_INDIC_DIGITS, asciiDigit)
    .toLowerCase()
    .replace(/[ً-ٰٟۖ-ۭ]/g, "")
    .replace(/[إأآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/[ىئ]/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/[ـ]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// كلمات حشو تُزال قبل استخراج اسم زبون/صنف/حساب من السؤال
const STOP_WORDS = new Set(
  ("ما هو هي كم شو وين كيف من عند لل الى على في عن مع هل يوجد عندي عندنا لو سمحت "
    + "من فضلك اعطني اعطيني عرض اظهر اريد بدي حساب الحساب رصيد الرصيد زبون الزبون "
    + "العميل عميل مادة الماده صنف الصنف السيد المحترم شركه شركة محل مركز اليوم امس "
    + "الشهر السنه الاسبوع كل جميع هذا هذه ذلك التي الذي و ثم يا")
    .split(/\s+/)
);

const MATCH_MIN_TERM_LENGTH = 3;
const MATCH_MIN_SCORE = 3;

// كلمات دلالية للمطابقة: طول 3 فأكثر وبلا كلمات حشو.
function terms(question: string) {
  return normalize(question)
    .split(" ")
    .filter((word) => word.length >= MATCH_MIN_TERM_LENGTH && !STOP_WORDS.has(word));
}

// مطابقة اسم: تطابق كلمة كاملة ثم احتواء ثم بادئة. تُعيد أفضل المرشحين مرتّبين.
//
// عتبة الطول 3 والحدّ الأدنى 3 نقاط ليسا اعتباطاً — بدونهما تنتج المطابقة
// **رصيد زبون خاطئ** لسؤال عن زبون غير موجود: مقطع مثل «ال» يرد داخل كل اسم
// تقريباً، فيلتقط أول حساب بالقائمة ويعرض رصيده كأنه جواب. ثلاث نقاط تعني
// تطابق كلمة كاملة واحدة على الأقل، لا مجرد تشابه حروف.
function matchByName<T>(rows: T[], nameOf: (row: T) => string, needle: string, limit = 5) {
  const wanted = terms(needle).join(" ");
  const list = terms(needle);
  if (!list.length) return [] as Array<{ row: T; score: number; exact: boolean }>;
  const scored: Array<{ row: T; score: number; exact: boolean }> = [];
  for (const row of rows) {
    const hay = normalize(nameOf(row));
    if (!hay) continue;
    const hayWords = hay.split(" ");
    const hayWordSet = new Set(hayWords);
    let score = 0;
    for (const term of list) {
      if (hayWordSet.has(term)) score += 3;
      else if (term.length >= 4 && hay.includes(term)) score += 2;
      else if (term.length >= 4 && hayWords.some((word) => word.startsWith(term.slice(0, 4)))) score += 1;
    }
    if (score < MATCH_MIN_SCORE) continue;
    // التطابق التام يفوز دائماً: «ماستر طويل ورق» يجب ألا يخسر أمام «ماستر
    // طويل ورق ازرق» الذي يحرز نفس النقاط ويصادف أنه أسبق في القائمة.
    const exact = hay === wanted || hay === normalize(needle);
    if (exact) score += 100;
    // وغرامة صغيرة على الكلمات الزائدة تكسر التعادل لصالح الاسم الأقرب
    score -= Math.max(0, hayWords.length - list.length) * 0.5;
    scored.push({ row, score, exact });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

// الحدّ الفاصل للالتباس: فرق أقل من نقطتين بين أفضل مرشحَين يعني أن الاسم لا
// يميّز بينهما فعلاً، فلا يُختار أحدهما بالتخمين.
const AMBIGUOUS_MARGIN = 2;
function isAmbiguous<T>(matches: Array<{ row: T; score: number; exact: boolean }>) {
  if (matches.length < 2) return false;
  // تطابقان تامّان (exact) أو أكثر لنفس الاسم الحرفي: الاسم لا يميّز بينهما
  // إطلاقاً — كان `matches[0].exact` وحده يمرّ هذه الحالة كـ"غير غامض"
  // ويختار الأول عشوائياً (ترتيب الفرز غير حاسم بين تعادلين). (رصدها Codex
  // على PR #205 — h9ZJB.)
  const exactCount = matches.filter((m) => m.exact).length;
  if (exactCount > 1) return true;
  // تطابق تامّ واحد فقط وهو الأفضل: لا غموض، كالسابق.
  if (exactCount === 1 && matches[0].exact) return false;
  return matches[0].score - matches[1].score < AMBIGUOUS_MARGIN;
}

// ── تنسيق الأرقام ────────────────────────────────────────────────────────────
function num(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(value: unknown, currency = "USD") {
  return `${num(value).toLocaleString("en-US", { maximumFractionDigits: 2 })} ${currency}`;
}

function qty(value: unknown) {
  return num(value).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

// رصدها Codex #28: كشف تعارض وحدة السطر — نفس فكرة أداة المشتريات (مقارنة
// lineTotal المخزَّن بقيمة مُشتقّة من الكمية × السعر)، لكن مُعمَّمة لأي حقل
// سعر مرجعي بدل الاقتصار على avgPrice (فواتير الزبون لا تحمل avgPrice أصلاً).
// حين تكون lineTotal فعلياً = qty×price بالبناء (مثل lineTotalSource==="derived")
// لا يظهر أي تعارض هنا — وهذا سليم، فالخطر الحقيقي فقط حين يكون lineTotal
// قيمة حقيقية مستقلة (من الأمين) بينما qty×price بأساس وحدة مختلف.
//
// **حدّ مهم (Codex P1 على PR #205 / فاتورة #733):** حين يكون lineTotal نفسه =
// Qty×Price بوحدة مختلطة (سعر كرتونة × كمية كروز)، فالمقارنة مع نفسها لا تكشف
// شيئاً وتُمرِّر المجموع المضخَّم. لذلك لا يُعتمد هذا الحارس وحده إن وُجد
// `inv.total` — الإجمالي من رأس الفاتورة هو الرقم الموثوق (انظر printing.md
// و`invoiceLineBasisPlan` في src/app.js).
function lineTotalConflictStats(
  lines: Array<Record<string, unknown>>,
  priceField: string
): { lines: number; conflicting: number; unreliable: boolean } {
  let count = 0;
  let conflicting = 0;
  for (const line of lines) {
    count += 1;
    const stated = num(line.lineTotal);
    const base = num(line.qty) * num(line[priceField]);
    if (stated > 0 && base > 0 && Math.abs(stated - base) / Math.max(stated, base) > 0.2) conflicting += 1;
  }
  return { lines: count, conflicting, unreliable: count > 0 && conflicting / count > 0.2 };
}

// ── حسم أساس سطر الفاتورة بمطابقة إجمالي الرأس (نسخة مصغّرة من src/app.js) ──
// inv.total من الأمين هو الرقم الموثوق الوحيد. lineTotal قد يساوي Price×Qty
// بوحدة خاطئة فيتضخّم 50 ضعفاً دون أن يكشفه lineTotalConflictStats.
type InvoiceLineBasis = "unit1" | "unit2" | "stored";
const INVOICE_BASIS_SEARCH_BUDGET = 200_000;
const INVOICE_BASIS_EXACT_TOLERANCE = 0.005;

function invoiceBasisTolerance(lines: Array<Record<string, unknown>>) {
  let sumPrice = 0;
  for (const line of lines) sumPrice += Math.abs(num(line.price));
  return Math.max(0.05, 0.0006 * sumPrice);
}

function invoiceLineCandidates(line: Record<string, unknown>) {
  const price = num(line.price);
  const q = num(line.qty);
  const qtyUnits = num(line.qtyUnits);
  const unit1 = price * q;
  const unit2 = price * qtyUnits;
  return {
    unit1,
    unit2,
    hasUnit1: q > 0,
    hasUnit2: qtyUnits > 0,
    switchable: q > 0 && qtyUnits > 0 && Math.abs(unit1 - unit2) > 1e-9
  };
}

function invoiceStoredSumMatchesTotal(lines: Array<Record<string, unknown>>, total: number, tol: number) {
  let storedSum = 0;
  for (const line of lines) {
    const stored = Number(line.lineTotal);
    if (!Number.isFinite(stored) || stored < 0) return false;
    storedSum += stored;
  }
  return Math.abs(storedSum - total) <= tol;
}

type InvoiceBasisBucket = { delta: number; lines: Array<Record<string, unknown>> };

function seedInvoiceBasisBuckets(lines: Array<Record<string, unknown>>) {
  const basis = new Map<Record<string, unknown>, InvoiceLineBasis>();
  const buckets = new Map<string, InvoiceBasisBucket>();
  let base = 0;
  for (const line of lines) {
    const candidates = invoiceLineCandidates(line);
    if (!candidates.switchable) {
      if (candidates.hasUnit2) { basis.set(line, "unit2"); base += candidates.unit2; }
      else if (candidates.hasUnit1) { basis.set(line, "unit1"); base += candidates.unit1; }
      else { basis.set(line, "stored"); base += num(line.lineTotal); }
      continue;
    }
    basis.set(line, "unit2");
    base += candidates.unit2;
    const key = `${candidates.unit1.toFixed(6)}|${candidates.unit2.toFixed(6)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.lines.push(line);
    else buckets.set(key, { delta: candidates.unit1 - candidates.unit2, lines: [line] });
  }
  return { basis, buckets, base };
}

function searchInvoiceBasisPicks(
  groups: InvoiceBasisBucket[],
  target: number,
  tol: number
): number[] | null {
  const count = groups.length;
  if (!count) return null;
  const suffixMax = new Array(count + 1).fill(0);
  const suffixMin = new Array(count + 1).fill(0);
  for (let i = count - 1; i >= 0; i -= 1) {
    const span = groups[i].delta * groups[i].lines.length;
    suffixMax[i] = suffixMax[i + 1] + Math.max(0, span);
    suffixMin[i] = suffixMin[i + 1] + Math.min(0, span);
  }
  const picks = new Array(count).fill(0);
  let steps = 0;
  const searchWithin = (limit: number) => {
    const walk = (index: number, remaining: number): "found" | "budget" | null => {
      steps += 1;
      if (steps > INVOICE_BASIS_SEARCH_BUDGET) return "budget";
      if (Math.abs(remaining) <= limit) return "found";
      if (index >= count) return null;
      if (remaining > suffixMax[index] + limit || remaining < suffixMin[index] - limit) return null;
      const group = groups[index];
      for (let taken = 0; taken <= group.lines.length; taken += 1) {
        picks[index] = taken;
        const outcome = walk(index + 1, remaining - group.delta * taken);
        if (outcome) return outcome;
      }
      picks[index] = 0;
      return null;
    };
    return walk(0, target);
  };
  let outcome = searchWithin(INVOICE_BASIS_EXACT_TOLERANCE);
  if (outcome !== "found" && outcome !== "budget" && tol > INVOICE_BASIS_EXACT_TOLERANCE) {
    picks.fill(0);
    outcome = searchWithin(tol);
  }
  return outcome === "found" ? picks : null;
}

function computeInvoiceLineBasisPlan(
  lines: Array<Record<string, unknown>>,
  total: number
): Map<Record<string, unknown>, InvoiceLineBasis> | null {
  if (!(total > 0) || !lines.length) return null;
  const tol = invoiceBasisTolerance(lines);
  if (invoiceStoredSumMatchesTotal(lines, total, tol)) return null;

  const { basis, buckets, base } = seedInvoiceBasisBuckets(lines);
  const target = total - base;
  if (Math.abs(target) <= tol) return basis;

  const groups = [...buckets.values()].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const picks = searchInvoiceBasisPicks(groups, target, tol);
  if (!picks) return null;

  groups.forEach((group, index) => {
    for (let i = 0; i < picks[index]; i += 1) basis.set(group.lines[i], "unit1");
  });
  return basis;
}

function invoiceLineResolvedValue(
  line: Record<string, unknown>,
  basis: InvoiceLineBasis | undefined
): number {
  if (basis === "unit1") return num(line.price) * num(line.qty);
  if (basis === "unit2") return num(line.price) * num(line.qtyUnits);
  return num(line.lineTotal);
}

// عرض مبالغ فاتورة الزبون: إجمالي الرأس أولاً، ثم قيم الأسطر بعد حسم الأساس.
// بلا total موثوق نعود لحارس التعارض القديم (lineTotal مقابل qty×price).
function customerInvoiceAmountView(inv: Record<string, unknown>): {
  total: number | null;
  unreliable: boolean;
  valueOf: (line: Record<string, unknown>) => number | null;
  qtyLabelOf: (line: Record<string, unknown>) => string;
} {
  const lines = Array.isArray(inv.lines) ? inv.lines as Array<Record<string, unknown>> : [];
  const defaultQtyLabel = (line: Record<string, unknown>) => {
    const u2 = String(line.unit2 ?? "").trim();
    if (num(line.qtyUnits) > 0 && u2) return `${qty(line.qtyUnits)} ${u2}`;
    return `${qty(line.qty)} ${String(line.unit1 ?? "")}`.trim();
  };
  const qtyLabelForBasis = (line: Record<string, unknown>, basis: InvoiceLineBasis | undefined) => {
    const u1 = String(line.unit1 ?? "").trim();
    const u2 = String(line.unit2 ?? "").trim();
    if (basis === "unit2" && num(line.qtyUnits) > 0) {
      return `${qty(line.qtyUnits)} ${u2 || u1}`.trim();
    }
    if (basis === "unit1" || num(line.qty) > 0) {
      return `${qty(line.qty)} ${u1}`.trim();
    }
    return defaultQtyLabel(line);
  };
  const headerTotal = num(inv.total);
  if (headerTotal > 0) {
    const plan = computeInvoiceLineBasisPlan(lines, headerTotal);
    if (plan) {
      return {
        total: headerTotal,
        unreliable: false,
        valueOf: (line) => invoiceLineResolvedValue(line, plan.get(line)),
        qtyLabelOf: (line) => qtyLabelForBasis(line, plan.get(line))
      };
    }
    const tol = invoiceBasisTolerance(lines);
    let storedSum = 0;
    let storedComplete = true;
    for (const line of lines) {
      const stored = Number(line.lineTotal);
      if (!Number.isFinite(stored) || stored < 0) { storedComplete = false; break; }
      storedSum += stored;
    }
    if (storedComplete && Math.abs(storedSum - headerTotal) <= tol) {
      return {
        total: headerTotal,
        unreliable: false,
        valueOf: (line) => num(line.lineTotal),
        qtyLabelOf: defaultQtyLabel
      };
    }
    // إجمالي الرأس موثوق، لكن لا توزيع أسطر مطابق — نعرض الإجمالي ونحجب
    // معادلة السطر المضخَّمة بدل تمرير lineTotal كحقيقة.
    return {
      total: headerTotal,
      unreliable: true,
      valueOf: () => null,
      qtyLabelOf: defaultQtyLabel
    };
  }
  const { unreliable } = lineTotalConflictStats(lines, "price");
  if (unreliable) {
    return {
      total: null,
      unreliable: true,
      valueOf: (line) => num(line.lineTotal),
      qtyLabelOf: defaultQtyLabel
    };
  }
  const summed = lines.reduce((sum, line) => sum + num(line.lineTotal), 0);
  return {
    total: summed,
    unreliable: false,
    valueOf: (line) => num(line.lineTotal),
    qtyLabelOf: defaultQtyLabel
  };
}

// ── التواريخ ─────────────────────────────────────────────────────────────────
function damascusDate(offsetDays = 0) {
  const now = new Date(Date.now() + DAMASCUS_OFFSET_MINUTES * 60_000 + offsetDays * 86_400_000);
  return now.toISOString().slice(0, 10);
}

// يوم الأسبوع بتوقيت دمشق (0=أحد..6=سبت، مطابق لـ Date.getUTCDay على التاريخ
// المُزاح). الأسبوع في هذا السياق يبدأ السبت وفق العرف السوري/الإقليمي.
function damascusWeekday(offsetDays = 0) {
  const now = new Date(Date.now() + DAMASCUS_OFFSET_MINUTES * 60_000 + offsetDays * 86_400_000);
  return now.getUTCDay();
}

// عدد الأيام من بداية الأسبوع الحالي (السبت) حتى اليوم المطلوب.
function daysSinceWeekStart(dow: number) {
  return (dow + 1) % 7;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function safeDate(value: string) {
  if (!ISO_DATE.test(value)) throw new Error("bad_date_range");
  return value;
}

// `explicit` = ذُكر في السؤال تاريخ/فترة صراحةً. تمييزه ضروري: الأدوات التي
// تقرأ «أحدث تقرير» يجب أن تحترم اليوم المطلوب متى طُلب، وأن تبقى على الأحدث
// حين لا يذكر السائل تاريخاً — بلا هذا التمييز يصير «كم قبضنا أمس؟» جواباً
// عن اليوم. (رصدها Codex على PR #205.)
type Period = { from: string; to: string; label: string; explicit: boolean };

// استخراج الفترة من السؤال. الافتراضي «اليوم» للأسئلة اللحظية.
function parsePeriod(question: string, fallbackDays = 0): Period {
  // جملة المقارنة تُستثنى من الفترة الأساسية حتى لا تُدمَج تواريخ الطرفين في
  // مدى واحد (مثال: «مبيعات 2026-09-15 مقارنة بـ 2026-09-01»). (Codex P1 —
  // discussion_r4019158383.)
  const q = stripComparisonClause(normalize(question));
  const today = damascusDate();

  // مدى ينتهي بـ«اليوم»/«أمس» قبل فرع اليوم المنفرد — وإلا «من 1/9/2026 إلى اليوم»
  // كان يُختزل لليوم وحده. (Codex P1 — discussion_r4018947150.)
  const relativeEnd = parseRangeEndingRelative(q, today);
  if (relativeEnd === "invalid") throw new Error("unrecognized_date");
  if (relativeEnd) return relativeEnd;

  // «اليوم» قبل «أمس» عمداً: سؤال «مبيعات اليوم مقارنة بأمس» يحوي العبارتين،
  // والفترة المقصودة هي اليوم — وأمس يأتي من جملة المقارنة لا من هنا.
  // نفس نمط «هذا الشهر» قبل «الشهر الماضي» أدناه. (رصدها Codex على PR #205.)
  if (/(?:^| )اليوم(?: |$)|النهارده|هلق|الان/.test(q)) {
    return { from: today, to: today, label: "اليوم", explicit: true };
  }
  if (/(?:^| )امس(?: |$)|البارحه|مبارح/.test(q)) {
    const day = damascusDate(-1);
    return { from: day, to: day, label: "أمس", explicit: true };
  }
  // «هذا الشهر» تُفحص أولاً عمداً: سؤال «مبيعات هذا الشهر مقارنة بالشهر الماضي»
  // يحوي العبارتين معاً، والفترة المقصودة فيه هي الشهر الحالي — والشهر الماضي
  // يأتي من جملة المقارنة.
  if (/هذا الشهر|الشهر الحالي|شهري/.test(q)) {
    return { from: `${today.slice(0, 7)}-01`, to: today, label: "هذا الشهر", explicit: true };
  }
  if (/الشهر الماضي|الشهر السابق|الشهر الفائت/.test(q)) {
    const first = `${today.slice(0, 7)}-01`;
    const prevEnd = damascusDateFrom(first, -1);
    return { from: `${prevEnd.slice(0, 7)}-01`, to: prevEnd, label: "الشهر الماضي", explicit: true };
  }
  if (/(?:^| )الشهر(?: |$)/.test(q)) {
    return { from: `${today.slice(0, 7)}-01`, to: today, label: "هذا الشهر", explicit: true };
  }
  // سنوات — رصدها Codex: كانت تسقط بلا تطابق فترجع "اليوم" صامتاً لسؤال سنوي كامل.
  if (/هذه السنه|السنه الحاليه|هالسنه|هذا العام|العام الحالي|هالعام/.test(q)) {
    return { from: `${today.slice(0, 4)}-01-01`, to: today, label: "هذه السنة", explicit: true };
  }
  if (/السنه الماضيه|السنه الفائته|السنه السابقه|العام الماضي|العام الفائت|العام السابق/.test(q)) {
    const lastYear = String(Number(today.slice(0, 4)) - 1);
    return { from: `${lastYear}-01-01`, to: `${lastYear}-12-31`, label: "السنة الماضية", explicit: true };
  }
  // «هذا الأسبوع» و«الأسبوع الماضي» يُفحصان قبل الفرع العام لـ«أسبوع» — نفس
  // نمط الشهر/السنة أعلاه: عبارة محدّدة قبل العبارة العامة. بدون هذا التمييز
  // كان أي ذكر لكلمة «أسبوع» يُرجع نافذة متحركة 7 أيام سواء قصد السائل
  // الأسبوع التقويمي الحالي أو السابق أو آخر 7 أيام فعلاً. (رصدها Codex على PR #205.)
  if (/هذا الاسبوع|الاسبوع الحالي|هالاسبوع/.test(q)) {
    const start = damascusDate(-daysSinceWeekStart(damascusWeekday()));
    return { from: start, to: today, label: "هذا الأسبوع", explicit: true };
  }
  if (/الاسبوع الماضي|الاسبوع السابق|الاسبوع الفائت/.test(q)) {
    const currentStart = damascusDate(-daysSinceWeekStart(damascusWeekday()));
    const prevEnd = damascusDateFrom(currentStart, -1);
    const prevStart = damascusDateFrom(prevEnd, -6);
    return { from: prevStart, to: prevEnd, label: "الأسبوع الماضي", explicit: true };
  }
  if (/الاسبوع|اسبوع|٧ ايام|7 ايام|اخر سبعه/.test(q)) {
    return { from: damascusDate(-6), to: today, label: "آخر 7 أيام", explicit: true };
  }
  const explicitDays = q.match(/اخر (\d{1,3}) يوم/);
  if (explicitDays) {
    const days = Math.min(365, Math.max(1, Number(explicitDays[1])));
    return { from: damascusDate(-(days - 1)), to: today, label: `آخر ${days} يوم`, explicit: true };
  }
  // تاريخ تقويمي صريح (ISO أو يوم/شهر/سنة). normalize يحوّل الفواصل إلى
  // مسافات، فـ`2026-09-01` و`1/9/2026` يصبحان `2026 09 01` و`1 9 2026`.
  // بدون هذا الفرع كان السؤال يسقط على «اليوم» صامتاً. (رصدها Codex على PR #205.)
  const calendar = parseExplicitCalendarDate(q);
  if (calendar === "invalid") throw new Error("unrecognized_date");
  if (calendar) return calendar;
  if (fallbackDays === 0) {
    return { from: today, to: today, label: "اليوم", explicit: false };
  }
  return { from: damascusDate(-(fallbackDays - 1)), to: today, label: `آخر ${fallbackDays} يوم`, explicit: false };
}

// يحذف جملة المقارنة من السؤال قبل جمع تواريخ الفترة الأساسية.
function stripComparisonClause(q: string): string {
  return q
    .replace(/\s+(?:مقارنه|بالمقارنه)\s*(?:ب|مع|ل)?\s*.+$/, "")
    .replace(/\s+مقابل\s+.+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

// مدى صريح ينتهي بعبارة نسبية («إلى اليوم» / «إلى أمس»).
function parseRangeEndingRelative(q: string, today: string): Period | "invalid" | null {
  const toToday = /(?:الي|حتى) (?:اليوم|النهارده)(?: |$)/.test(q);
  const toYesterday = /(?:الي|حتى) (?:امس|البارحه|مبارح)(?: |$)/.test(q);
  if (!toToday && !toYesterday) return null;
  const end = toToday ? today : damascusDate(-1);
  const endLabel = toToday ? "اليوم" : "أمس";

  if (/من (?:امس|البارحه|مبارح) (?:الي|حتى)/.test(q)) {
    const from = damascusDate(-1);
    if (from > end) return "invalid";
    return { from, to: end, label: `من أمس إلى ${endLabel}`, explicit: true };
  }
  if (/من (?:اليوم|النهارده) (?:الي|حتى)/.test(q)) {
    if (today > end) return "invalid";
    return { from: today, to: end, label: `من اليوم إلى ${endLabel}`, explicit: true };
  }

  const days = collectCalendarDays(q);
  if (days === "invalid") return "invalid";
  if (!days.length) return null;
  const from = [...days].sort()[0];
  if (from > end) return "invalid";
  return {
    from,
    to: end,
    label: from === end ? endLabel : `من ${from} إلى ${endLabel}`,
    explicit: true
  };
}

// يبني YYYY-MM-DD بعد التحقق التقويمي الفعلي (لا يقبل 2026-02-31).
function ymdIso(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const parsed = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed)) return null;
  if (new Date(parsed).toISOString().slice(0, 10) !== iso) return null;
  return iso;
}

// أسماء الأشهر بعد normalize (ة→ه، أإآ→ا). «اب» يُحاط بحدود حرف لئلا
// يطابق داخل «حساب».
const ARABIC_MONTHS: Array<{ re: RegExp; month: number }> = [
  { re: /يناير|كانون الثاني/, month: 1 },
  { re: /فبراير|شباط/, month: 2 },
  { re: /مارس|اذار/, month: 3 },
  { re: /ابريل|نيسان/, month: 4 },
  { re: /مايو|ايار/, month: 5 },
  { re: /يونيو|حزيران/, month: 6 },
  { re: /يوليو|تموز/, month: 7 },
  { re: /اغسطس|(?<!\p{L})اب(?!\p{L})/u, month: 8 },
  { re: /سبتمبر|ايلول/, month: 9 },
  { re: /اكتوبر|تشرين الاول/, month: 10 },
  { re: /نوفمبر|تشرين الثاني/, month: 11 },
  { re: /ديسمبر|كانون الاول/, month: 12 }
];

function hasArabicMonthName(q: string) {
  return ARABIC_MONTHS.some(({ re }) => re.test(q));
}

// يجمع كل التواريخ التقويمية الصريحة في السؤال. أكثر من تاريخ = مدى
// (من الأقدم إلى الأحدث)، لا يوم أوّل فقط. (رصدها Codex على PR #205 بعد 912e5c9.)
function collectCalendarDays(q: string): string[] | "invalid" {
  const days: string[] = [];
  for (const m of q.matchAll(/(?:^| )(?:يوم )?(\d{4}) (\d{1,2}) (\d{1,2})(?= |$)/g)) {
    const day = ymdIso(Number(m[1]), Number(m[2]), Number(m[3]));
    if (!day) return "invalid";
    days.push(day);
  }
  for (const m of q.matchAll(/(?:^| )(?:يوم )?(\d{1,2}) (\d{1,2}) (\d{4})(?= |$)/g)) {
    const day = ymdIso(Number(m[3]), Number(m[2]), Number(m[1]));
    if (!day) return "invalid";
    days.push(day);
  }
  for (const { re, month } of ARABIC_MONTHS) {
    for (const m of q.matchAll(new RegExp(`(?:^| )(?:يوم )?(\\d{1,2}) (${re.source})(?: (\\d{4}))?(?= |$)`, "gu"))) {
      const year = m[3] ? Number(m[3]) : Number(damascusDate().slice(0, 4));
      const day = ymdIso(year, month, Number(m[1]));
      if (!day) return "invalid";
      days.push(day);
    }
    for (const m of q.matchAll(new RegExp(`(?:^| )(${re.source}) (\\d{1,2})(?: (\\d{4}))?(?= |$)`, "gu"))) {
      const year = m[3] ? Number(m[3]) : Number(damascusDate().slice(0, 4));
      const day = ymdIso(year, month, Number(m[2]));
      if (!day) return "invalid";
      days.push(day);
    }
  }
  return days;
}

// يقرأ تاريخاً تقويمياً صريحاً من السؤال المُطبَّع، أو "invalid" إن وُجدت
// نية تاريخ دون صيغة مدعومة/صالحة — كي لا يُجاب «اليوم» مكان التاريخ المطلوب.
function parseExplicitCalendarDate(q: string): Period | "invalid" | null {
  const collected = collectCalendarDays(q);
  if (collected === "invalid") return "invalid";
  if (collected.length >= 2) {
    const sorted = [...collected].sort();
    const from = sorted[0];
    const to = sorted[sorted.length - 1];
    return {
      from,
      to,
      label: from === to ? from : `من ${from} إلى ${to}`,
      explicit: true
    };
  }
  if (collected.length === 1) {
    const day = collected[0];
    return { from: day, to: day, label: day, explicit: true };
  }
  // «يوم» ثم رقم دون صيغة كاملة معروفة — رفض صريح لا سقوط على اليوم
  if (/(?:^| )يوم \d/.test(q)) return "invalid";
  // رقم + اسم شهر حاضران لكن الصيغة لم تُحلّ (يوم خارج الشهر، إلخ)
  if (hasArabicMonthName(q) && /\d/.test(q)) return "invalid";
  return null;
}

function damascusDateFrom(iso: string, offsetDays: number) {
  const base = new Date(`${iso}T00:00:00Z`).getTime() + offsetDays * 86_400_000;
  return new Date(base).toISOString().slice(0, 10);
}

// الفترة السابقة المكافئة — احتياط لأسئلة المقارنة بلا فترة مُسمّاة.
function previousPeriod(period: Period): Period {
  const days = Math.round(
    (new Date(`${period.to}T00:00:00Z`).getTime() - new Date(`${period.from}T00:00:00Z`).getTime()) / 86_400_000
  ) + 1;
  return {
    from: damascusDateFrom(period.from, -days),
    to: damascusDateFrom(period.from, -1),
    label: `الفترة السابقة (${days} يوم)`,
    explicit: true
  };
}

// فترة المقارنة كما سمّاها السائل («بالشهر الماضي»، «بأمس»…) لا previousPeriod
// الميكانيكي. (Codex P1 — discussion_r4018947162.)
function namedComparisonPeriod(question: string, primary: Period): Period {
  const q = normalize(question);
  let clause = "";
  const byMuqarana = q.match(/مقارنه\s*(?:ب|مع|ل)?\s*(.+)$/);
  if (byMuqarana) clause = byMuqarana[1].trim();
  else {
    const byMuqabil = q.match(/مقابل\s+(.+)$/);
    if (byMuqabil) clause = byMuqabil[1].trim();
  }
  clause = clause.replace(/^ب/, "").trim();

  // «قارن … بالفترة السابقة» بلا كلمة «مقارنة» لاحقة
  if (!clause && /ب(?:ال)?فتره السابقه/.test(q)) return previousPeriod(primary);
  if (!clause) {
    const tagged = q.match(
      /\bب(امس|البارحه|مبارح|الشهر الماضي|الشهر السابق|الشهر الفائت|الاسبوع الماضي|الاسبوع السابق|الاسبوع الفائت|السنه الماضيه|السنه الفائته|السنه السابقه|العام الماضي|العام الفائت|العام السابق|الفتره السابقه)\b/
    );
    if (tagged) clause = tagged[1];
  }
  if (!clause || /الفتره السابقه/.test(clause)) return previousPeriod(primary);

  try {
    const parsed = parsePeriod(clause, 0);
    if (!parsed.explicit) return previousPeriod(primary);
    return parsed;
  } catch {
    return previousPeriod(primary);
  }
}

// تغطية تقرير لقطة (فواتير الشراء وفواتير الزبائن).
//
// كلا المنتِجَين يقرأ نافذة `-PeriodDays` (60 افتراضاً) ويقصّ كل مورّد/زبون عند
// `MaxInvoicesPer…` (200) رافعاً `truncated`. فالمصفوفة المخزَّنة ليست كل
// الحقيقة بحدَّين مستقلَّين: مدىً لا تغطّيه اللقطة أصلاً، وفواتير أقدم قُصَّت
// داخل المدى المغطّى.
//
// وترشيحُ هذه المصفوفة بالفترة المطلوبة — وهو ما أضيف لتوّه — يُنتج **حكماً
// قاطعاً على ناقص**: «لا فواتير في هذه الفترة» عن مدىً لم يُقرأ أصلاً، أو
// أعداداً تُقدَّم محسوبةً على فترة تتجاوز اللقطة. فالحدّان يُقاسان ويُعلَنان،
// والنفي القاطع يُحجب متى كانت الفترة غير مغطّاة.
// (رصدها Codex على PR #205 بعد d36b86f.)
type ReportCoverage = { from: string; to: string; covered: boolean; truncated: boolean; note: string };

function reportCoverage(
  period: Period,
  summary: Record<string, unknown>,
  reportDate: unknown,
  truncated: boolean,
  what: string
): ReportCoverage {
  const from = String(summary.fromDate ?? "");
  const to = String(reportDate ?? "");
  const before = !!from && period.explicit && period.from < from;
  const after = !!to && period.explicit && period.to > to;
  const covered = !!from && !!to && !before && !after && !truncated;
  const parts: string[] = [];
  if (before) parts.push(`قبل ${from}`);
  if (after) parts.push(`بعد ${to}`);
  let note = "";
  if (parts.length) {
    note += `\n\n> ⚠️ **الفترة المطلوبة تتجاوز نافذة ${what}.**\n`
      + `> النافذة المتاحة: **${from} → ${to}**، والمطلوب يمتدّ ${parts.join(" و")}.\n`
      + `> ما خارجها لم يُقرأ أصلاً، فالأعداد أدناه تخصّ الجزء المغطّى وحده — لا الفترة المطلوبة.`;
  }
  if (truncated) {
    note += `\n\n> ⚠️ **اللقطة مقصوصة**: المنتِج يحتفظ بأحدث 200 فاتورة لكل جهة ويرفع \`truncated\`.\n`
      + `> فالفواتير الأقدم داخل النافذة غائبة، والأعداد أدناه حدٌّ أدنى لا إجمالياً.`;
  }
  return { from, to, covered, truncated, note };
}

// ── قراءة سطور المبيعات ──────────────────────────────────────────────────────
type SalesRow = {
  sale_date?: string;
  bill_no?: string;
  bill_type?: string;
  item_name?: string;
  item_key?: string;
  qty?: unknown;
  line_total?: unknown;
  unit_cost?: unknown;
  customer_name?: string;
};

// ⚠️ العمود sales_line_items.net_profit **لا يُقرأ عمداً**.
// تحقّق على بيانات الإنتاج (2026-09-06): قيمته تساوي line_total في كل صف،
// أي أنه يتجاهل التكلفة تماماً. مثال فعلي: سطر بـline_total = 16,450 وتكلفة
// 4.6914 × 3500 = 16,419.86، وnet_profit المخزَّن = 16,450. وعلى آب كله:
// Σline_total = 550,452.75 وΣnet_profit = 550,448.62 — أي «ربح» ≈ 100%.
// قراءة هذا العمود تعني إعطاء المالك رقم ربح كاذب، فالهامش يُحسب هنا من
// line_total - unit_cost×qty، والرقم المحاسبي المعتمد يبقى تقرير
// ameen_daily_profit (أداة profit). العطل نفسه في خط المزامنة لا في المساعد.
// نافذة المزامنة المتحقَّقة لسطور المبيعات.
//
// المنتِج المجدوَل يعمل بـ`-Days 30` (tools/register-sales-line-items-task.ps1)،
// وجدول sales_line_items يحتفظ بصفوف أقدم من ذلك بكثير. فالصفوف خارج آخر نافذة
// مكتملة **لا تُحدَّث**: تعديل أو حذف فاتورة في الأمين بعد خروج تاريخها من
// النافذة لا يصل إلى Supabase. تقديم مجموعها كإجمالي «نهائي» ادّعاءٌ لا يسنده
// شيء. (رصدها Codex على PR #205.)
//
// تحقُّق على الإنتاج 2026-09-06: النافذة المتحقَّقة 2026-08-07 → 2026-09-06
// (7,041 صفاً)، بينما الجدول يحمل صفوفاً من 2026-07-01. فسؤال «مبيعات الشهر
// الماضي» يشمل 1–6 آب وهي خارج النافذة.
type SyncWindow = { start: string; end: string; completedAt: string; rowCount: number; runId: string } | null;

async function syncWindow(table: string, source: string): Promise<SyncWindow> {
  // جدول علامة المزامنة قد يكون غير مُطبَّق بعد على القاعدة (ملفّا SQL
  // يُطبَّقان يدوياً ومستقلَّين عن نشر الدالة). وPostgREST يردّ 404 عندها،
  // فـreadRest ترمي، فتسقط **الأداة كلها** بـ«تعذّرت قراءة المصدر» — أي أن
  // إضافة حارسٍ للتحقق كانت ستُعطّل جواباً كان يعمل. والغياب ليس عطلاً بل
  // حالةٌ معناها «لا تحقُّق»، وهي بالضبط ما يُعبّر عنه `null`.
  let rows: unknown;
  try {
    rows = await readRest(
      `${table}?select=window_start,window_end,row_count,completed_at,sync_run_id`
      + `&source=eq.${encodeURIComponent(source)}&order=completed_at.desc&limit=1`
    );
  } catch {
    return null;
  }
  const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
  if (!row?.window_start || !row?.window_end) return null;
  return {
    start: String(row.window_start),
    end: String(row.window_end),
    completedAt: String(row.completed_at ?? ""),
    rowCount: num(row.row_count),
    runId: String(row.sync_run_id ?? "")
  };
}

// مُعرّف آخر تشغيل مزامنة — بصمة لقطة الجدول. تغيّره بين صفحتين يعني أن
// القراءة عبرت استبدالاً ذرّياً.
async function syncRunId(table: string, source: string) {
  return (await syncWindow(table, source))?.runId ?? "";
}

// قراءة مُصفَّحة **مثبَّتة على لقطة واحدة**.
//
// التصفيح بـoffset يفترض جدولاً ساكناً. والاستبدال الذرّي يحذف نافذة كاملة
// ويُدرجها من جديد، والصفوف الجديدة تسبق في الترتيب ما قُرئ فعلاً — فصفحةٌ
// لاحقة تكرّر صفوفاً وتُسقط أخرى. والأسوأ أن علامة المزامنة بعدها تبدو
// حديثة و`partial` يبقى false، فيُقدَّم إجمالي مشوّه على أنه كامل ومتحقَّق.
// (رصدها Codex على PR #205 بعد 82e9022.)
//
// فالقراءة تُحاط ببصمة التشغيل قبلها وبعدها: إن تغيّرت أُعيدت، وإن لم تستقرّ
// أُعلن الرقم غير نهائي بدل تمريره.
async function readPagedPinned(
  path: (range: string) => string,
  table: string,
  source: string
): Promise<{ rows: Array<Record<string, unknown>>; partial: boolean; unstable: boolean }> {
  let last: { rows: Array<Record<string, unknown>>; partial: boolean } = { rows: [], partial: false };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await syncRunId(table, source);
    last = await readPaged(path);
    const after = await syncRunId(table, source);
    // بصمة فارغة (لا سجل مزامنة) لا تُثبِّت شيئاً، لكن غيابها مُعلَن أصلاً
    // في تحذير التغطية — فلا تُضاف هنا دورةٌ لا تُفيد.
    if (before === after) return { ...last, unstable: false };
  }
  return { rows: last.rows, partial: true, unstable: true };
}

const salesSyncWindow = () => syncWindow("sales_line_items_sync_state", "ameen_sales_line_items");

// نافذة التحديث المتحقَّقة لحركة المصاريف — نفس علّة المبيعات بالضبط.
//
// `push-expense-entries.ps1` يستبدل آخر `-Days` يوماً (7 افتراضاً، ولا
// `register-expense-entries-task.ps1` يمرّر غيرها) ويترك ما قبلها على حاله.
// فصفوف ما قبل النافذة لا تُحدَّث: قيد مصروف عُدِّل أو حُذف في الأمين بعد خروج
// تاريخه منها لا يصل إلى Supabase، وجدول حديث العهد قد لا يحمل تلك الأيام
// إطلاقاً. تقديم مجموع «مصاريف الشهر الماضي» كإجمالي نهائي ادّعاءٌ لا يسنده
// شيء. (رصدها Codex على PR #205 بعد df4b3df.)
const expenseSyncWindow = () => syncWindow("expense_entries_sync_state", "ameen_expense_entries");

// موضوع التحذير: أي مصدر يتكلم عنه، وأي جدول يحمل سجلّ مزامنته. تمريره صريح
// لا افتراضي كي لا يُنسب غيابُ سجلٍّ إلى المصدر الخطأ في نص موجَّه للمالك.
type CoverageSubject = { what: string; table: string };
const SALES_COVERAGE: CoverageSubject = { what: "سطور المبيعات", table: "sales_line_items_sync_state" };
const EXPENSE_COVERAGE: CoverageSubject = { what: "حركة المصاريف", table: "expense_entries_sync_state" };

// فجوة التغطية كقيمة لا كنصّ. النصّ وحده لا يكفي حين يكون الجواب **حكماً
// نهائياً**: عندها يجب أن يُحجب الحكم لا أن يُذيَّل بتحذير.
function coverageGap(period: Period, window: SyncWindow) {
  if (!window) return { missing: true, before: false, after: false };
  return { missing: false, before: period.from < window.start, after: period.to > window.end };
}

// تحذير التغطية: يُعيد نصاً حين لا تقع الفترة المطلوبة كاملةً داخل النافذة.
function coverageWarning(period: Period, window: SyncWindow, subject: CoverageSubject) {
  if (!window) {
    return `\n\n> ⚠️ لا يوجد سجل مزامنة مكتمل لـ${subject.what} (\`${subject.table}\` فارغ).`
      + ` لا أستطيع تأكيد أن أرقام هذه الفترة محدَّثة، فاعتبرها **غير متحقَّقة**.`;
  }
  const { before: outsideBefore, after: outsideAfter } = coverageGap(period, window);
  if (!outsideBefore && !outsideAfter) return "";
  const parts: string[] = [];
  if (outsideBefore) parts.push(`من ${period.from} إلى ${damascusDateFrom(window.start, -1)}`);
  if (outsideAfter) parts.push(`من ${damascusDateFrom(window.end, 1)} إلى ${period.to}`);
  return `\n\n> ⚠️ **جزء من الفترة خارج آخر نافذة مزامنة متحقَّقة لـ${subject.what}.**\n`
    + `> النافذة المتحقَّقة: **${window.start} → ${window.end}** (${window.rowCount} سطر، اكتملت ${window.completedAt.slice(0, 10)}).\n`
    + `> خارجها: ${parts.join("، ")}. صفوف هذه المدة موجودة من مزامنة أقدم ولا تُحدَّث،\n`
    + `> فأي تعديل أو حذف جرى في الأمين بعدها **لا ينعكس هنا**. المجموع أعلاه يشمل هذه الصفوف،\n`
    + `> فاقرأه على أنه تقديري لا نهائي بالنسبة للجزء الخارج.`;
}

// ذيل الاكتمال الموحّد لكل جواب مشتقّ من سطور المبيعات.
//
// حدّان يجعلان الرقم غير نهائي: بلوغ سقف الصفوف (`partial`)، وخروج الفترة عن
// نافذة المزامنة المتحقَّقة. وكانا مفصولين: كل مستهلك جديد يتذكّر أحدهما
// وينسى الآخر — ونُسيا فعلاً في المقارنة بالفترة السابقة، وفي فرعَي «لا شيء»
// في الأصناف الراكدة وتوصية الشراء، وهي بالضبط المواضع التي يصدر فيها **حكم
// نهائي** («لا حاجة شراء عاجلة») عن بيانات قد تكون ناقصة. (رصدها Codex على
// PR #205 بعد 244f209.)
//
// فصارا نداءً واحداً: من يعرض رقماً من سطور المبيعات يعرض حدود صدقه معه.
//
// ويُعاد مع النصّ **حكمٌ على الاكتمال** (`complete`). فالنصّ يكفي لرقم معروض،
// ولا يكفي لحكم نهائي: تحذيرٌ ملحقٌ بجملة «لا حاجة شراء عاجلة» يُقرأ عملياً
// كـ«لا حاجة»، والقراءة الناقصة هي بعينها ما يُدخل الجواب في ذلك الفرع.
// (رصدها Codex على PR #205 بعد 85b4900.)
async function salesCompleteness(period: Period, partial: boolean, window?: SyncWindow) {
  const resolved = window === undefined ? await salesSyncWindow() : window;
  const gap = coverageGap(period, resolved);
  return {
    complete: !partial && !gap.missing && !gap.before && !gap.after,
    note: (partial
      ? `\n\n> ⚠️ بلغت قراءة ${period.label} (${period.from} → ${period.to}) سقف الأمان ${HARD_ROW_CAP} سطر،`
        + ` فالأرقام المشتقّة منها **جزئية وليست نهائية**. ضيّق الفترة.`
      : "")
      + coverageWarning(period, resolved, SALES_COVERAGE)
  };
}

// نفس منطق salesCompleteness للمصاريف: النفي القاطع («لا حركة مصروف») لا يُصدَر
// خارج النافذة المتحقَّقة. التحذير الملحق بنفيٍ قاطع يُقرأ عملياً كـ«لا مصروف».
// (رصدها Codex على PR #205 بعد f5cabd6 — discussion_r4017908914.)
async function expenseCompleteness(period: Period, partial: boolean, window?: SyncWindow) {
  const resolved = window === undefined ? await expenseSyncWindow() : window;
  const gap = coverageGap(period, resolved);
  return {
    complete: !partial && !gap.missing && !gap.before && !gap.after,
    note: (partial
      ? `\n\n> ⚠️ بلغت قراءة ${period.label} (${period.from} → ${period.to}) سقف الأمان ${HARD_ROW_CAP} حركة،`
        + ` فالمجموع أعلاه **جزئي وليس إجمالي الفترة**. ضيّق الفترة.`
      : "")
      + coverageWarning(period, resolved, EXPENSE_COVERAGE)
  };
}

async function readSales(period: Period, role: Role): Promise<{ rows: SalesRow[]; partial: boolean }> {
  // أعمدة المالك وحده: التكلفة، وقيمة السطر، واسم الزبون.
  //
  // أداة المبيعات كلها محصورة بالمالك، لكن أداة حركة الصنف مفتوحة للموظف —
  // فكانت تعرض له قيمة مبيعات الصنف وأسماء أكبر مشتريه وكمياتهم. وتكرار
  // السؤال على الأصناف يعيد بناء تقرير المبيعات المحمي ونشاط الزبائن الشرائي
  // صنفاً صنفاً. فالحجب عند المصدر لا عند العرض: ما لا يُقرأ لا يُسرَّب.
  // (رصدها Codex على PR #205 بعد 4fb0d18.)
  const columns = role === "owner"
    ? "sale_date,bill_no,bill_type,item_name,item_key,qty,line_total,unit_cost,customer_name"
    : "sale_date,bill_no,bill_type,item_name,item_key,qty";
  // ترتيب ثابت وقاطع (id ثانوياً) شرطٌ لصحة التصفيح: بلا مفتاح فارق قد يتكرر
  // صفٌّ أو يسقط آخر بين الصفحات.
  const { rows, partial } = await readPagedPinned((range) =>
    `sales_line_items?select=${columns}`
    + `&sale_date=gte.${safeDate(period.from)}&sale_date=lte.${safeDate(period.to)}`
    + `&order=sale_date.desc,id.asc${range}`,
    "sales_line_items_sync_state", "ameen_sales_line_items"
  );
  return { rows: rows as SalesRow[], partial };
}

function summarizeSales(rows: SalesRow[]) {
  const bills = new Set<string>();
  let total = 0;
  let wholesale = 0;
  let retail = 0;
  // الهامش يُجمَع فقط من السطور التي لها تكلفة موجبة. السطر بلا تكلفة يُعدّ
  // مجهولاً ويُذكر عدده — لا يُفترض له ربح صفري ولا كامل.
  let marginRevenue = 0;
  let marginCost = 0;
  let costKnown = 0;
  for (const row of rows) {
    if (row.bill_no) bills.add(`${row.bill_type ?? ""}#${row.bill_no}`);
    total += num(row.line_total);
    if (row.bill_type === "wholesale") wholesale += num(row.line_total);
    else if (row.bill_type === "retail") retail += num(row.line_total);
    const cost = num(row.unit_cost);
    if (row.unit_cost !== undefined && row.unit_cost !== null && cost > 0) {
      marginRevenue += num(row.line_total);
      marginCost += cost * num(row.qty);
      costKnown += 1;
    }
  }
  return {
    total, wholesale, retail,
    bills: bills.size,
    lines: rows.length,
    margin: marginRevenue - marginCost,
    marginRevenue,
    costKnown,
    costMissing: rows.length - costKnown
  };
}

// ============================================================================
// سجل الأدوات — كل أداة مصدر قراءة واحد مصرَّح به.
//
// إضافة قدرة جديدة = إضافة عنصر هنا. لا يُعدَّل المخطِّط ولا المُنفِّذ. هذا هو
// سبب وجود السجل: منع عودة سلسلة if/else مركزية تكبر مع كل سؤال جديد.
//
// كل أداة تُصرّح بـ:
//   id       معرّف ثابت (يظهر بالجواب وبالاختبارات)
//   title    عنوان عربي
//   minRole  أدنى دور مسموح — يُفرض في المخطِّط وفي المنفِّذ معاً
//   patterns أنماط النية مع أوزانها (تعيش مع الأداة لا في مكان مركزي)
//   entity   نوع الاسم الذي قد يحمله السؤال (زبون/صنف/حساب) أو لا شيء
//   run      قراءة آمنة ثم صياغة جواب، أو اعتراف صريح بغياب البيانات
// ============================================================================
type ToolResult = {
  ok: boolean;
  text: string;
  sources: string[];
  asOf?: string | null;
  partial?: boolean;
};

type ToolContext = {
  question: string;
  entityText: string;
  role: Role;
  period: Period;
};

type Tool = {
  id: string;
  title: string;
  minRole: Role;
  entity?: "customer" | "item" | "account" | "supplier";
  patterns: Array<{ re: RegExp; w: number }>;
  // فاصل تعادل النقاط بين أداتين — رصدها Codex: "مقبوضات الصندوق اليوم" تُسجّل
  // 6 لكل من المقبوضات (كلمة الفعل المالي الصريحة) والصندوق (مكان/وعاء عام قد
  // يُسأل عن رصيده أو عمّا دخله)، و"أرباح المبيعات اليوم" تُسجّل 6 لكل من
  // الأرباح (نتيجة صريحة) والمبيعات (أحد مدخلات تلك النتيجة). عند التعادل
  // الفعل/النتيجة المالية الصريحة تُرجَّح على الوعاء/المُدخَل العام. الافتراضي 0.
  priority?: number;
  run: (ctx: ToolContext) => Promise<ToolResult>;
};

const noData = (what: string, sources: string[]): ToolResult => ({
  ok: false,
  text: `لا تتوفر بيانات ${what} في النظام حالياً. لم أعثر على تقرير محفوظ يغطي هذا السؤال، فلن أقدّر رقماً من عندي.`,
  sources
});

function freshnessNote(asOf: string | null | undefined) {
  if (!asOf) return "";
  const stamp = new Date(asOf).getTime();
  if (!Number.isFinite(stamp)) return "";
  const hours = (Date.now() - stamp) / 3_600_000;
  if (hours < 12) return "";
  const days = Math.floor(hours / 24);
  return days >= 1
    ? `\n\n> ⚠️ آخر تحديث لهذا المصدر منذ ${days} يوم. الرقم يعود لآخر مزامنة وليس للحظة الحالية.`
    : `\n\n> ⚠️ آخر تحديث لهذا المصدر منذ ${Math.floor(hours)} ساعة.`;
}

// ── مساعدات تخفيض تعقيد أدوات الزبون / الصنف / المشتريات (CodeFactor) ────────

function rowsInPeriod(
  rows: Array<Record<string, unknown>>,
  period: Period,
  dateOf: (row: Record<string, unknown>) => string = (row) => String(row.date ?? "")
) {
  if (!period.explicit) return rows;
  return rows.filter((row) => {
    const date = dateOf(row).slice(0, 10);
    return date >= period.from && date <= period.to;
  });
}

function paymentsWindowTruncated(
  customer: Record<string, unknown>,
  allPayments: Array<Record<string, unknown>>,
  period: Period
): boolean {
  const oldestAvailable = allPayments.length
    ? allPayments
      .map((p) => String(p.date ?? "").slice(0, 10))
      .filter(Boolean)
      .sort()[0]
    : undefined;
  const windowStart = typeof customer.paymentsWindowStart === "string"
    ? customer.paymentsWindowStart.slice(0, 10)
    : undefined;
  const windowCount = typeof customer.paymentsInWindow === "number"
    ? customer.paymentsInWindow
    : undefined;

  if (windowStart !== undefined && windowCount !== undefined && period.from >= windowStart) {
    return windowCount > allPayments.length;
  }
  return allPayments.length >= PAYMENTS_ROW_CAP
    || (!!oldestAvailable && period.from < oldestAvailable);
}

function appendCustomerPaymentsText(
  text: string,
  customer: Record<string, unknown>,
  period: Period
): string {
  const allPayments = Array.isArray(customer.recentPayments) ? customer.recentPayments : [];
  const payments = rowsInPeriod(allPayments as Array<Record<string, unknown>>, period);
  if (payments.length) {
    return text
      + `\n\n**آخر الدفعات**${period.explicit ? ` (${period.label})` : ""}\n`
      + payments
        .slice(0, 6)
        .map((p) =>
          `- ${String(p.date ?? "").slice(0, 10)}: **${money(p.amount)}**${p.notes ? ` — ${String(p.notes)}` : ""}`)
        .join("\n");
  }
  if (period.explicit) {
    const maybeTruncated = paymentsWindowTruncated(customer, allPayments as Array<Record<string, unknown>>, period);
    return text + (maybeTruncated
      ? `\n\n_لا يمكن الجزم بعدم وجود دفعات ضمن ${period.label} لأن سجل الدفعات المتاح لهذا الحساب محدود لأحدث ${allPayments.length} دفعة فقط، وقد توجد دفعات أقدم خارج هذا السجل._`
      : `\n\n_لا دفعات مسجّلة لهذا الحساب في ${period.label}._`);
  }
  return text + `\n\n_لا دفعات مسجّلة لهذا الحساب في نافذة التقرير._`;
}

function formatCustomerInvoiceBlock(inv: Record<string, unknown>): string {
  const lines = Array.isArray(inv.lines) ? inv.lines as Array<Record<string, unknown>> : [];
  const view = customerInvoiceAmountView(inv);
  let block = view.total === null
    ? `\n\n**فاتورة ${String(inv.date ?? "")}** — ⚠️ لم أعرض إجمالي هذه الفاتورة عمداً (تعارض في وحدة السعر بين أسطرها)\n`
    : `\n\n**فاتورة ${String(inv.date ?? "")}** — إجمالي ${money(view.total)}`
      + (view.unreliable ? ` _(أسطرها بلا حسم وحدة قاطع — الإجمالي من رأس الفاتورة)_\n` : `\n`);
  block += lines
    .slice(0, 10)
    .map((l) => {
      const lineValue = view.valueOf(l);
      const qtyLabel = view.qtyLabelOf(l);
      return lineValue === null
        ? `- ${String(l.material ?? "")}: ${qtyLabel} × ${money(l.price)} _(قيمة السطر غير محسومة)_`
        : `- ${String(l.material ?? "")}: ${qtyLabel} × ${money(l.price)} = ${money(lineValue)}`;
    })
    .join("\n")
    + (lines.length > 10 ? `\n- _و${lines.length - 10} سطر آخر._` : "");
  return block;
}

function formatCustomerReturnsBlock(
  returns: Array<Record<string, unknown>>,
  periodLabel: string
): string {
  if (!returns.length) return "";
  return `\n\n**🔁 مرتجعات ${periodLabel}** (${returns.length})\n`
    + returns
      .slice(0, 5)
      .map((inv) => {
        const lines = Array.isArray(inv.lines) ? inv.lines as Array<Record<string, unknown>> : [];
        const view = customerInvoiceAmountView(inv);
        const amount = view.total === null
          ? "⚠️ غير محسوم (تعارض وحدة السعر)"
          : money(view.total);
        return `- ${String(inv.date ?? "")}: ${amount}`
          + (lines.length ? ` (${lines.slice(0, 3).map((l) => String(l.material ?? "")).join("، ")}${lines.length > 3 ? "…" : ""})` : "");
      })
      .join("\n")
    + (returns.length > 5 ? `\n- _و${returns.length - 5} مرتجع آخر._` : "")
    + `\n\nالمرتجع بضاعة **أعادها** الزبون، فلا يُحسب شراءً ولم يدخل في العدد أعلاه.`;
}

function resolveCustomerInvoiceEntry(
  invRows: Array<Record<string, unknown>>,
  guid: string,
  name: string
): { entry?: Record<string, unknown>; identity: "guid" | "name" | "none" } {
  if (guid) {
    const entry = invRows.find((row) => String(row.customerGuid ?? "") === guid);
    return entry ? { entry, identity: "guid" } : { identity: "none" };
  }
  const named = matchByName(invRows, (row) => String(row.name ?? ""), name, 5);
  if (named.length && !isAmbiguous(named)) {
    return { entry: named[0].row, identity: "name" };
  }
  return { identity: "none" };
}

function formatMissingCustomerInvoices(
  text: string,
  opts: {
    guid: string;
    entry?: Record<string, unknown>;
    invoices: Array<Record<string, unknown>>;
    allInvoices: Array<Record<string, unknown>>;
    period: Period;
    periodLabel: string;
    window: string;
    invCoverage: ReturnType<typeof reportCoverage>;
  }
): string | null {
  const { guid, entry, invoices, allInvoices, period, periodLabel, window, invCoverage } = opts;
  if (guid && !entry) {
    return text
      + `\n\n**المشتريات**\nلم أجد في تقرير الفواتير (${window}) أي سجل مربوط بمعرّف هذا الزبون.`
      + `\n\nلن أنسب له فواتير بتشابه الاسم — لو فعلت لعرضتُ عليك مشتريات زبون آخر بأصنافه وأسعاره.`
      + ` إن كنت تتوقع وجود فواتير، فالأرجح أن تقرير الفواتير لم يُزامَن بعد أو أن سجلّه بلا معرّف.`;
  }
  if (invoices.length) return null;
  return text + (invCoverage.covered || !period.explicit
    ? `\n\n**المشتريات**\nلا توجد فواتير لهذا الزبون ضمن ${periodLabel}.`
      + (period.explicit && allInvoices.length
        ? ` له ${allInvoices.length} فاتورة خارج هذه الفترة داخل نافذة التقرير (${window}) — لم أعرضها لأنها ليست ما سألت عنه.`
        : ` (نافذة تقرير الفواتير: ${window}.)`)
    : `\n\n**المشتريات — غير محسومة**\nلم أجد فواتير لهذا الزبون ضمن ${periodLabel}،`
      + ` لكن تقرير الفواتير لا يغطّي هذه الفترة كاملةً — فلن أقول إنه لم يشترِ شيئاً.`
      + (allInvoices.length ? ` (له ${allInvoices.length} فاتورة داخل النافذة المتاحة.)` : ""))
    + invCoverage.note;
}

function formatFoundCustomerInvoices(
  text: string,
  opts: {
    identity: "guid" | "name" | "none";
    invoices: Array<Record<string, unknown>>;
    periodLabel: string;
    invCoverage: ReturnType<typeof reportCoverage>;
  }
): string {
  const { identity, invoices, periodLabel, invCoverage } = opts;
  let out = text;
  if (identity === "name") {
    out += `\n\n> ℹ️ سجل الفواتير أدناه مطابَق بالاسم لأن حساب الزبون بلا معرّف في تقرير الأرصدة.`;
  }
  const purchases = invoices.filter((inv) => !inv.isReturn);
  const returns = invoices.filter((inv) => inv.isReturn);
  out += `\n\n**آخر الفواتير** (${purchases.length} فاتورة شراء ضمن ${periodLabel}`
    + (returns.length ? `، و${returns.length} مرتجع` : "")
    + `)`
    + (invCoverage.covered ? "" : " — العدد حدٌّ أدنى، انظر التنبيه أدناه");
  if (!purchases.length) {
    out += `\n\nلا فاتورة **شراء** له في هذه الفترة — ما وُجد مرتجعات فقط.`;
  }
  for (const inv of purchases.slice(0, 3)) out += formatCustomerInvoiceBlock(inv);
  out += formatCustomerReturnsBlock(returns, periodLabel);
  return out + invCoverage.note;
}

async function appendCustomerPurchasesText(
  text: string,
  opts: { guid: string; name: string; period: Period; sources: string[] }
): Promise<string> {
  const { guid, name, period, sources } = opts;
  try {
    const invoiceReport = await latestReport("inventory_reports", "ameen_customer_invoices");
    const invRows = Array.isArray(invoiceReport?.items) ? invoiceReport.items : [];
    sources.push("inventory_reports:ameen_customer_invoices");
    const window = `${(invoiceReport?.summary as Record<string, unknown>)?.fromDate ?? "?"} → ${invoiceReport?.report_date ?? "?"}`;
    const { entry, identity } = resolveCustomerInvoiceEntry(
      invRows as Array<Record<string, unknown>>,
      guid,
      name
    );

    const allInvoices = Array.isArray(entry?.invoices) ? entry.invoices : [];
    const invoices = rowsInPeriod(allInvoices as Array<Record<string, unknown>>, period);
    const periodLabel = period.explicit
      ? `${period.label} (${period.from} → ${period.to})`
      : `نافذة التقرير`;
    const invCoverage = reportCoverage(
      period,
      (invoiceReport?.summary ?? {}) as Record<string, unknown>,
      invoiceReport?.report_date,
      !!entry?.truncated,
      "تقرير فواتير الزبائن"
    );

    const missing = formatMissingCustomerInvoices(text, {
      guid, entry, invoices, allInvoices: allInvoices as Array<Record<string, unknown>>,
      period, periodLabel, window, invCoverage
    });
    if (missing !== null) return missing;

    return formatFoundCustomerInvoices(text, { identity, invoices, periodLabel, invCoverage });
  } catch {
    return text
      + `\n\n> ⚠️ تعذّرت قراءة تقرير الفواتير، فلم أعرض المشتريات. الرصيد أعلاه من تقرير الأرصدة وهو صحيح — ولم أستبدل الفواتير بأي تقدير.`;
  }
}

function appendOwnerItemSalesStats(
  text: string,
  mine: Array<{ customer_name?: unknown; qty?: unknown; line_total?: unknown; unit_cost?: unknown }>
): string {
  const totalValue = mine.reduce((sum, row) => sum + num(row.line_total), 0);
  const buyers = new Map<string, number>();
  for (const row of mine) {
    const buyer = String(row.customer_name ?? "").trim() || "بدون اسم";
    buyers.set(buyer, (buyers.get(buyer) ?? 0) + num(row.qty));
  }
  const top = [...buyers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  let out = text
    + `\n- قيمة المبيعات: **${money(totalValue)}**\n`
    + `- أكثر المشترين: ${top.map(([b, q]) => `${b} (${qty(q)})`).join("، ")}`;
  const withCost = mine.filter((row) => num(row.unit_cost) > 0);
  if (withCost.length) {
    const margin = withCost.reduce((sum, row) => sum + num(row.line_total) - num(row.unit_cost) * num(row.qty), 0);
    out += `\n- هامش المنتج على ${withCost.length} سطر متوفرة تكلفتها: **${money(margin)}** (بيع ناقص تكلفة، قبل المصاريف)`;
  }
  return out;
}

async function appendItemSalesMovement(
  text: string,
  ctx: ToolContext,
  name: string
): Promise<{ text: string; partial: boolean }> {
  const period = ctx.period.explicit
    ? ctx.period
    : { from: damascusDate(-59), to: damascusDate(), label: "آخر 60 يوم", explicit: true };
  const periodDays = Math.max(
    1,
    Math.round((new Date(`${period.to}T00:00:00Z`).getTime() - new Date(`${period.from}T00:00:00Z`).getTime()) / 86_400_000) + 1
  );
  const sales = await readSales(period, ctx.role);
  const mine = sales.rows.filter((row) => normalize(row.item_name) === normalize(name));
  const itemState = await salesCompleteness(period, sales.partial);
  let out = text;
  if (!mine.length) {
    out += `\n\n**الحركة (${period.label})**\n`
      + (itemState.complete
        ? `لا توجد أي مبيعات مسجّلة لهذا الصنف في ${period.label}.`
        : `لم أجد مبيعات لهذا الصنف في ${period.label}، لكن قراءة المبيعات **غير مكتملة** — فلا أجزم بغيابها.`);
  } else {
    // الكميات مُوقَّعة عمداً: المرتجع سالب (sales-line-items-atomic-refresh).
    // جمع التوقيع تحت عنوان «الكمية المباعة» يحوّل صافي الحركة إلى مبيع خام —
    // فيظهر مرتجعٌ خالص سالباً، وبيع 10 ثم مرتجع 2 كمبيع 8. افصل الاثنين.
    // (رصدها Codex على PR #205 بعد f5cabd6 — discussion_r4017908903.)
    const sold = mine.filter((row) => num(row.qty) > 0);
    const returned = mine.filter((row) => num(row.qty) < 0);
    const soldQty = sold.reduce((sum, row) => sum + num(row.qty), 0);
    const returnQty = returned.reduce((sum, row) => sum + Math.abs(num(row.qty)), 0);
    out += `\n\n**الحركة (${period.label})**\n`;
    if (sold.length) {
      out += `- الكمية المباعة: **${qty(soldQty)}** على ${sold.length} سطر\n`
        + `- متوسط ${(soldQty / periodDays).toFixed(1)} بالوحدة يومياً`;
    } else {
      out += `- لا مبيعات موجبة مسجّلة في ${period.label}`;
    }
    if (returned.length) {
      out += `\n- مرتجعات: **${qty(returnQty)}** على ${returned.length} سطر`
        + ` (لا تُحسب ضمن الكمية المباعة أعلاه)`;
    }
    if (ctx.role === "owner" && sold.length) out = appendOwnerItemSalesStats(out, sold);
  }
  return { text: out + itemState.note, partial: sales.partial };
}

type PurchaseSupplierAgg = {
  name: string;
  count: number;
  lineCount: number;
  returnCount: number;
  last: string;
};

function aggregatePurchaseSuppliers(
  items: Array<Record<string, unknown>>,
  inPeriod: (invoice: Record<string, unknown>) => boolean
): { bySupplier: PurchaseSupplierAgg[]; lines: number; conflicting: number; truncatedSuppliers: number } {
  let lines = 0;
  let conflicting = 0;
  let truncatedSuppliers = 0;
  const bySupplier = items
    .map((row) => {
      if (row.truncated) truncatedSuppliers += 1;
      const all = (Array.isArray(row.invoices) ? row.invoices : []).filter(inPeriod);
      const invoices = all.filter((invoice: Record<string, unknown>) => !invoice.isReturn);
      const returnCount = all.length - invoices.length;
      let lineCount = 0;
      for (const invoice of invoices) {
        for (const line of (Array.isArray(invoice.items) ? invoice.items : []) as Array<Record<string, unknown>>) {
          lineCount += 1;
          lines += 1;
          const stated = num(line.lineTotal);
          const base = num(line.qty) * num(line.avgPrice);
          if (stated > 0 && base > 0 && Math.abs(stated - base) / Math.max(stated, base) > 0.2) conflicting += 1;
        }
      }
      const dates = invoices.map((invoice: Record<string, unknown>) => String(invoice.date ?? "")).filter(Boolean).sort();
      return { name: String(row.name ?? ""), count: invoices.length, lineCount, returnCount, last: dates[dates.length - 1] ?? "" };
    })
    .filter((row) => row.count > 0 || row.returnCount > 0)
    .sort((a, b) => b.count - a.count);
  return { bySupplier, lines, conflicting, truncatedSuppliers };
}

function purchasesEmptyForPeriod(
  scope: string,
  coverage: ReturnType<typeof reportCoverage>,
  asOf: string | null | undefined
): ToolResult {
  if (!coverage.covered) {
    return {
      ok: false,
      text: `**المشتريات — ${scope} — غير محسومة**\n`
        + `لم أجد فواتير شراء في هذه الفترة، لكن تقرير المشتريات لا يغطّيها كاملةً`
        + ` — فالغياب هنا قد يكون غياب قراءة لا غياب شراء.`
        + coverage.note,
      sources: ["ameen_purchase_invoice_reports"],
      asOf
    };
  }
  return {
    ok: true,
    text: `**المشتريات — ${scope}**\nلا توجد فواتير شراء في هذه الفترة.`
      + `\n\nنافذة تقرير المشتريات المتاحة: ${coverage.from} → ${coverage.to}.`,
    sources: ["ameen_purchase_invoice_reports"],
    asOf
  };
}

function appendPurchasesSupplierDetail(
  text: string,
  opts: {
    items: Array<Record<string, unknown>>;
    entityText: string;
    scope: string;
    inPeriod: (invoice: Record<string, unknown>) => boolean;
  }
): string {
  const { items, entityText, scope, inPeriod } = opts;
  if (!entityText.trim()) return text;
  // limit الافتراضي (5) لا 1: الحدّ 1 كان يرمي المرشّحين الآخرين قبل أن
  // ترى isAmbiguous() أي منافس، فيُعرض تفصيل أول مورّد صامتاً لاسم مختصر
  // يطابق أكثر من حساب («فواتير المورد شركة الأمل»). (رصدها Codex على PR #205.)
  const matches = matchByName(items, (row) => String(row.name ?? ""), entityText);
  if (!matches.length) {
    return text + `\n\n_لم أجد مورّداً باسم «${entityText.trim()}» في هذا التقرير._`;
  }
  if (isAmbiguous(matches)) {
    return text
      + `\n\nالاسم «${entityText.trim()}» يطابق أكثر من مورّد:\n`
      + matches.map((m) => `- ${String(m.row.name ?? "")}`).join("\n")
      + `\n\nاكتب الاسم بشكل أدق لأختار المورّد الصحيح — لن أخمّن بينها.`;
  }
  const hit = matches[0];
  const invoices = (Array.isArray(hit.row.invoices) ? hit.row.invoices : []).filter(inPeriod);
  return text
    + `\n\n**تفصيل ${String(hit.row.name)} — ${scope}**\n`
    + invoices
      .slice(0, 8)
      .map((invoice: Record<string, unknown>) => {
        const rows = Array.isArray(invoice.items) ? invoice.items : [];
        return `- ${String(invoice.date ?? "")}: ${rows.length} صنف`
          + (rows.length ? ` (${rows.slice(0, 3).map((line: Record<string, unknown>) => String(line.itemName ?? "")).join("، ")}${rows.length > 3 ? "…" : ""})` : "");
      })
      .join("\n");
}

function formatPurchasesBody(opts: {
  scope: string;
  bySupplier: PurchaseSupplierAgg[];
  bills: number;
  lines: number;
  returnsTotal: number;
  conflicting: number;
  unreliable: boolean;
  period: Period;
  coverage: ReturnType<typeof reportCoverage>;
  items: Array<Record<string, unknown>>;
  entityText: string;
  inPeriod: (invoice: Record<string, unknown>) => boolean;
  asOf: string | null | undefined;
}): ToolResult {
  const {
    scope, bySupplier, bills, lines, returnsTotal, conflicting, unreliable,
    period, coverage, items, entityText, inPeriod, asOf
  } = opts;

  // غموض اسم المورّد يُرفض قبل أي تفصيل مالي لحساب بعينه — لا يُختار أول
  // مرشّح صامتاً. (رصدها Codex على PR #205.)
  if (entityText.trim()) {
    const matches = matchByName(items, (row) => String(row.name ?? ""), entityText);
    if (isAmbiguous(matches)) {
      return {
        ok: false,
        text: `الاسم «${entityText.trim()}» يطابق أكثر من مورّد:\n`
          + matches.map((m) => `- ${String(m.row.name ?? "")}`).join("\n")
          + `\n\nاكتب الاسم بشكل أدق لأختار المورّد الصحيح — لن أخمّن بينها.`,
        sources: ["ameen_purchase_invoice_reports"],
        asOf
      };
    }
  }

  let text = `**المشتريات — ${scope}**\n`
    + `- عدد فواتير الشراء: **${bills}** من **${bySupplier.length}** مورّد، بمجموع ${lines} سطر\n`
    + (returnsTotal ? `- ومعها **${returnsTotal}** مرتجع شراء، غير داخلة في العدد أعلاه.\n` : "")
    + (period.explicit
      ? `- محسوبة على ${coverage.covered ? "الفترة المطلوبة وحدها" : "الجزء المغطّى منها"}،`
        + ` من نافذة تقرير ${coverage.from} → ${coverage.to}.\n`
      : "")
    + `\n`
    + `**الموردون حسب عدد الفواتير**\n`
    + bySupplier
      .slice(0, 12)
      .map((row, index) =>
        `${index + 1}. ${row.name}: **${row.count}** فاتورة شراء (${row.lineCount} سطر)`
        + (row.returnCount ? ` و${row.returnCount} مرتجع` : "")
        + (row.last ? ` — آخرها ${row.last}` : ""))
      .join("\n");

  if (unreliable) {
    text += `\n\n> ⚠️ **لم أعرض إجمالي قيمة المشتريات عمداً.**\n`
      + `> في ${conflicting} من ${lines} سطر، قيمة السطر المخزَّنة (\`lineTotal\`) لا توافق الكمية × متوسط سعر الوحدة:\n`
      + `> \`price\` مسجَّل لوحدة والكمية \`qty\` لوحدة أخرى، فالضرب بينهما يضخّم القيمة بمقدار معامل الوحدة تقريباً.\n`
      + `> أي إجمالي أعرضه سيكون خاطئاً بمضاعفات، فلن أعطيك رقماً. الخلل في خط مزامنة فواتير الشراء\n`
      + `> (\`tools/pull-purchase-invoices-from-ameen.ps1\`) لا في المساعد، ويحتاج إصلاحاً هناك.`;
  }

  text = appendPurchasesSupplierDetail(text, { items, entityText, scope, inPeriod });
  text += coverage.note;
  return { ok: true, text: text + freshnessNote(asOf), sources: ["ameen_purchase_invoice_reports"], asOf };
}

async function resolveCustomerBalanceReport(ctx: ToolContext): Promise<{
  balances: Record<string, unknown> | null;
  wantsPurchases: boolean;
  needsHistoricalBalance: boolean;
  error?: ToolResult;
}> {
  const qn = normalize(ctx.question);
  const wantsPurchases = /اشتر|اخد|فواتير|بضاعه|مواد|مبيعات/.test(qn);
  // سؤال **مبلغ الرصيد** بفترة تاريخية («كم كان رصيد … الشهر الماضي؟») يحتاج
  // لقطة تغطي ذاك التاريخ. أما «كشف حساب / حركة … أمس» فيكتفي بأحدث لقطة
  // للهوية ثم يصفّي الدفعات بالفترة — رفض اللقطة التاريخية كان يكسر ذلك.
  // (رصدها Codex على PR #205.)
  const asksBalanceAmount = /رصيد/.test(qn) && !/كشف حساب/.test(qn);
  const needsHistoricalBalance = ctx.period.explicit && asksBalanceAmount && !wantsPurchases;
  const balances = needsHistoricalBalance
    ? await reportForPeriod("inventory_reports", "ameen_customer_balances", ctx.period)
    : await latestReport("inventory_reports", "ameen_customer_balances");
  if (needsHistoricalBalance && !balances) {
    return {
      balances: null,
      wantsPurchases,
      needsHistoricalBalance,
      error: {
        ok: false,
        text: `لا تتوفر لدي لقطة أرصدة زبائن تغطي ${ctx.period.label} (${ctx.period.from} → ${ctx.period.to}). `
          + `لن أعرض الرصيد الحالي كأنه يعود لتلك الفترة — التقارير المحفوظة لا تغطيها.`,
        sources: ["inventory_reports:ameen_customer_balances"]
      }
    };
  }
  return { balances: balances as Record<string, unknown> | null, wantsPurchases, needsHistoricalBalance };
}

function matchCustomerBalanceRow(
  rows: Array<Record<string, unknown>>,
  entityText: string,
  reportDate: unknown
): ToolResult | { customer: Record<string, unknown> } {
  const matches = matchByName(rows, (row) => String(row.name ?? row.key ?? ""), entityText);
  if (!matches.length) {
    return {
      ok: false,
      text: `لم أجد زبوناً باسم «${entityText.trim()}» في تقرير الأرصدة (${rows.length} حساب بتاريخ ${reportDate}). تأكد من الاسم كما هو مسجّل في الأمين.`,
      sources: ["inventory_reports:ameen_customer_balances"]
    };
  }
  if (isAmbiguous(matches)) {
    return {
      ok: false,
      text: `الاسم «${entityText.trim()}» يطابق أكثر من حساب:\n`
        + matches.map((m) => `- ${String(m.row.name ?? m.row.key)}`).join("\n")
        + `\n\nاكتب الاسم بشكل أدق لأختار الحساب الصحيح — لن أخمّن بينها.`,
      sources: ["inventory_reports:ameen_customer_balances"]
    };
  }
  return { customer: matches[0].row };
}

// فروع أداة المبيعات خارج `run` — خفض تعقيد CodeFactor (Complex Method).
// (بعد ac0d560 ارتفع run ببوابة نفي الصفر؛ وبعد a0b6537 بقي معلَّقاً.)
async function salesEmptyPeriodResult(period: Period, partial: boolean): Promise<ToolResult> {
  const any = await readRest("sales_line_items?select=sale_date&order=sale_date.desc&limit=1");
  if (!Array.isArray(any) || !any.length) return noData("المبيعات", ["sales_line_items"]);
  // «لا توجد فاتورة» نفيٌ قاطع. خارج النافذة المتحقَّقة قد يكون الغياب
  // غياب مزامنة لا غياب بيع — فتحذير ملحق بنفي لا يكفي؛ يُحجب الحكم عبر
  // salesCompleteness.complete. (رصدها Codex على PR #205 بعد f5cabd6 —
  // discussion_r4017908925.)
  const emptyState = await salesCompleteness(period, partial);
  if (!emptyState.complete) {
    return {
      ok: false,
      text: `**مبيعات ${period.label} (${period.from} → ${period.to}) — غير محسومة**\n`
        + `لم أجد أي فاتورة في هذه الفترة، لكن قراءة المبيعات **غير مكتملة** — فلا أجزم بغيابها.`
        + `\n\nآخر يوم فيه مبيعات مسجّلة هو **${String(any[0].sale_date)}**.`
        + emptyState.note,
      sources: ["sales_line_items", "sales_line_items_sync_state"],
      partial
    };
  }
  return {
    ok: true,
    text: `**مبيعات ${period.label} (${period.from} → ${period.to})**\nلا توجد أي فاتورة مسجّلة في هذه الفترة. آخر يوم فيه مبيعات مسجّلة هو **${String(any[0].sale_date)}**.`
      + `\n\nملاحظة: سطور المبيعات تصل عبر مزامنة الأمين، فإن كان اليوم ما زال في بدايته قد لا تكون فواتيره رُفعت بعد.`,
    sources: ["sales_line_items", "sales_line_items_sync_state"],
    partial
  };
}

type SalesSummary = ReturnType<typeof summarizeSales>;

function formatSalesBody(period: Period, now: SalesSummary, role: Role): string {
  let text = `**مبيعات ${period.label} (${period.from} → ${period.to})**\n`
    + `- الإجمالي: **${money(now.total)}**\n`
    + `- عدد الفواتير: **${now.bills}** على ${now.lines} سطر\n`
    + `- جملة: ${money(now.wholesale)} / مفرق: ${money(now.retail)}`;
  if (role === "owner" && now.costKnown) {
    const pct = now.marginRevenue ? (now.margin / now.marginRevenue) * 100 : 0;
    text += `\n- هامش المنتج المحسوب (بيع ناقص تكلفة) على ${now.costKnown} سطر متوفرة تكلفتها: **${money(now.margin)}** (${pct.toFixed(1)}%)`
      + (now.costMissing ? `\n  - ${now.costMissing} سطر بلا تكلفة معروفة، غير داخل في الهامش أعلاه.` : "")
      + `\n  - هذا هامش منتج تقديري قبل المصاريف والمرتجعات والحسومات. الرقم المحاسبي المعتمد للربح هو تقرير الأمين — اسأل: \`ما الأرباح؟\``;
  }
  return text;
}

async function appendSalesComparison(
  text: string,
  period: Period,
  now: SalesSummary,
  role: Role,
  question: string
): Promise<{ text: string; comparePeriod: Period; comparePartial: boolean }> {
  const prev = namedComparisonPeriod(question, period);
  // قراءة مستقلة بحدّ بتر مستقل. إسقاط `partial` هنا كان يعرض مجموع
  // الفترة السابقة والفرق والنسبة **مبتورةً** بوصفها نهائية، ويُبقي
  // `partial` في الجواب معبّراً عن الفترة الحالية وحدها.
  const prevRead = await readSales(prev, role);
  const before = summarizeSales(prevRead.rows);
  const delta = now.total - before.total;
  const pct = before.total ? (delta / before.total) * 100 : null;
  text += `\n\n**مقارنة بـ${prev.label} (${prev.from} → ${prev.to})**\n`
    + `- الفترة المُقارَن بها: **${money(before.total)}** على ${before.bills} فاتورة\n`
    + `- الفرق: **${delta >= 0 ? "+" : ""}${money(delta)}**`
    + (pct === null
      ? " (لا نسبة — الفترة المُقارَن بها صفر)"
      : ` (${delta >= 0 ? "+" : ""}${pct.toFixed(1)}%)`)
    + (prevRead.partial
      ? `\n- ⚠️ قراءة الفترة المُقارَن بها بلغت سقف ${HARD_ROW_CAP} سطر، فمجموعها والفرق والنسبة أعلاه **مبتورة**.`
      : "");
  return { text, comparePeriod: prev, comparePartial: prevRead.partial };
}

const TOOLS: Tool[] = [
  // ── الصناديق والسيولة ─────────────────────────────────────────────────────
  {
    id: "cashbox",
    title: "الصناديق والسيولة",
    minRole: "owner",
    patterns: [
      { re: /صندوق|صناديق|سيوله|كاش|نقديه|خزنه/, w: 6 },
      { re: /كم يوجد|كم عندنا|كم باق/, w: 2 }
    ],
    async run(ctx) {
      // daily_movement_reports يخزّن كل شيء في payload — لا summary/items هنا.
      // الرصيد **مقدار لحظي لا تدفّق**، فلا يُجمع عبر الأيام: أحدث يوم داخل
      // الفترة هو الجواب الصحيح. لكن حين تمتد الفترة أكثر من ذلك اليوم يُقال
      // صراحةً أي يوم يمثّله الرقم، كي لا يُقرأ كأنه رصيد الفترة كلها.
      const { days, latestAvailable } = await movementReports(ctx.period);
      const row = days[0] ?? null;
      // بلا تاريخ مطلوب، غياب الصف يعني غياب التقارير أصلاً؛ ومع تاريخ مطلوب
      // يعني أن تلك الفترة بلا تقرير — وهما حالتان مختلفتان.
      if (!row) {
        return ctx.period.explicit
          ? noMovementReport(ctx.period, latestAvailable)
          : noData("الصناديق", ["daily_movement_reports"]);
      }
      if (!row.payload) return noData("الصناديق", ["daily_movement_reports"]);
      const boxes = Array.isArray(row.payload.cashboxes) ? row.payload.cashboxes : [];
      const totals = Array.isArray(row.payload.cashTotals) ? row.payload.cashTotals : [];
      if (!boxes.length && !totals.length) return noData("الصناديق", ["daily_movement_reports"]);

      const totalLines = totals.map(
        (t: Record<string, unknown>) =>
          `- **${String(t.currency ?? "")}**: الرصيد الحالي **${money(t.closing, String(t.currency ?? ""))}**`
          + ` (افتتاحي ${money(t.opening, String(t.currency ?? ""))}،`
          + ` وارد خارجي ${money(t.externalIncoming, String(t.currency ?? ""))}،`
          + ` صادر خارجي ${money(t.externalOutgoing, String(t.currency ?? ""))})`
      );
      const boxLines = boxes
        .filter((b: Record<string, unknown>) => num(b.closing) !== 0 || num(b.incoming) !== 0 || num(b.outgoing) !== 0)
        .map(
          (b: Record<string, unknown>) =>
            `- ${String(b.name ?? "صندوق")}: **${money(b.closing, String(b.currency ?? ""))}**`
        );

      const detail = boxLines.length
        ? `\n\n**تفصيل الصناديق المتحركة**\n${boxLines.join("\n")}`
        : "\n\n_لا يوجد صندوق عليه حركة في هذا التقرير._";

      return {
        ok: true,
        text: `**رصيد الصناديق — تقرير ${row.report_date}**\n${totalLines.join("\n")}${detail}`
          + `\n\nالمجموع معروض بكل عملة على حدة كما يسجّلها الأمين — لا يُجمع الدولار مع الليرة.`
          + (ctx.period.explicit && ctx.period.from !== ctx.period.to
            ? `\n\n> ℹ️ الرصيد مقدار لحظي لا يُجمع عبر الأيام. الرقم أعلاه رصيد **${row.report_date}**`
              + ` وهو أحدث يوم له تقرير داخل ${ctx.period.label} (${ctx.period.from} → ${ctx.period.to}) — لا رصيد الفترة كلها.`
            : "")
          + freshnessNote(row.created_at),
        sources: ["daily_movement_reports"],
        asOf: row.created_at
      };
    }
  },

  // ── المقبوضات ─────────────────────────────────────────────────────────────
  {
    id: "collections",
    title: "المقبوضات والدفعات الواردة",
    minRole: "owner",
    priority: 1,
    patterns: [
      { re: /قبضنا|مقبوضات|تحصيل|دفعات (?:اليوم|الزبائن)|وارد/, w: 6 },
      { re: /كم قبض|شو قبضنا/, w: 4 }
    ],
    async run(ctx) {
      // المقبوضات **تدفّق لا مقدار لحظي**، فتُجمع عبر كل أيام الفترة. أخذ
      // أحدث يوم وحده كان يعرض مقبوضات يوم واحد جواباً عن «هذا الشهر».
      const { days, latestAvailable, missingDays } = await movementReports(ctx.period);
      if (!days.length) {
        return ctx.period.explicit
          ? noMovementReport(ctx.period, latestAvailable)
          : noData("المقبوضات", ["daily_movement_reports"]);
      }
      const withPayload = days.filter((day) => day.payload);
      if (!withPayload.length) return noData("المقبوضات", ["daily_movement_reports"]);

      type Payment = { date: string; name: string; amount: number; notes: string };
      const payments: Payment[] = [];
      let declaredCount = 0;
      let declaredTotal = 0;
      for (const day of withPayload) {
        const list = Array.isArray(day.payload.payments) ? day.payload.payments : [];
        const summary = (day.payload.paymentSummary ?? {}) as Record<string, unknown>;
        // العدد والمجموع يؤخذان من paymentSummary لأنه رقم التقرير المعتمد؛
        // والقائمة قد تكون مقتطعة في المصدر. وعند غيابه يُشتقّان من القائمة.
        declaredCount += summary.count === undefined ? list.length : num(summary.count);
        declaredTotal += summary.totalUsd === undefined
          ? list.reduce((sum: number, p: Record<string, unknown>) => sum + num(p.amountUsd ?? p.amount), 0)
          : num(summary.totalUsd);
        for (const p of list as Array<Record<string, unknown>>) {
          payments.push({
            date: day.report_date,
            name: String(p.name ?? p.customer ?? "بدون اسم"),
            amount: num(p.amountUsd ?? p.amount),
            notes: String(p.notes ?? "")
          });
        }
      }

      const multi = withPayload.length > 1;
      const heading = multi
        ? `**مقبوضات ${ctx.period.label} (${ctx.period.from} → ${ctx.period.to})** — من ${withPayload.length} يوم فيها تقرير`
        : `**مقبوضات ${withPayload[0].report_date}**`;
      const newest = withPayload[0].created_at;

      if (!payments.length) {
        return {
          ok: true,
          text: `${heading}\nلا توجد أي دفعة مسجّلة من الزبائن — العدد **0** والمجموع **${money(declaredTotal)}**.`
            + `\n\nهذا رقم حقيقي من تقرير الحركة وليس غياب بيانات.`
            + missingDaysNote(missingDays)
            + freshnessNote(newest),
          sources: ["daily_movement_reports"],
          asOf: newest
        };
      }

      const lines = payments
        .slice(0, 25)
        .map((p) => `- ${multi ? `${p.date} — ` : ""}${p.name}: **${money(p.amount)}**` + (p.notes ? ` — ${p.notes}` : ""));
      return {
        ok: true,
        text: `${heading} — العدد **${declaredCount}**، المجموع **${money(declaredTotal)}**\n${lines.join("\n")}`
          + (payments.length > 25 ? `\n\n_معروض 25 من ${payments.length}._` : "")
          + missingDaysNote(missingDays)
          + freshnessNote(newest),
        sources: ["daily_movement_reports"],
        asOf: newest
      };
    }
  },

  // ── المدفوعات والمصاريف ───────────────────────────────────────────────────
  {
    id: "expenses",
    title: "المصاريف والمدفوعات",
    minRole: "owner",
    // فعل الصرف يفوز على اسم الوعاء عند التعادل: «كم صرفنا من الصندوق؟»
    // يسجّل 6 للصندوق و6 للمصاريف — بلا أولوية كان ترتيب TOOLS يختار الصندوق
    // ويعرض أرصدة الإغلاق بدل المنصرف. (رصدها Codex على PR #205.)
    priority: 1,
    patterns: [
      { re: /مصروف|مصاريف|صرفنا|دفعنا|منصرف|نفقات/, w: 6 },
      { re: /كم دفع/, w: 4 }
    ],
    async run(ctx) {
      // مُصفَّح: الحدّ الثابت 200 كان يعيد أحدث 200 حركة فقط ثم يعرض مجموعها
      // على أنه إجمالي الفترة كلها — فسؤال «آخر 365 يوم» كان يبخس المصاريف
      // بصمت. (رصدها Codex على PR #205.)
      const { rows: list, partial } = await readPagedPinned((range) =>
        `expense_entries?select=id,entry_date,account_name,amount,notes`
        + `&entry_date=gte.${safeDate(ctx.period.from)}&entry_date=lte.${safeDate(ctx.period.to)}`
        + `&order=entry_date.desc,id.asc${range}`,
        "expense_entries_sync_state", "ameen_expense_entries"
      );
      if (!list.length) {
        // فرّق بين «لا مصاريف بهذه الفترة» و«لا بيانات مصاريف إطلاقاً»
        const any = await readRest("expense_entries?select=entry_date&order=entry_date.desc&limit=1");
        if (!Array.isArray(any) || !any.length) return noData("المصاريف", ["expense_entries"]);
        // «لا حركة مصروف» نفيٌ قاطع. خارج النافذة المتحقَّقة قد يكون الغياب غياب
        // مزامنة لا غياب صرف — فتحذير ملحق بنفي لا يكفي؛ يُحجب الحكم.
        // (رصدها Codex على PR #205 بعد f5cabd6 — discussion_r4017908914.)
        const emptyState = await expenseCompleteness(ctx.period, false);
        if (!emptyState.complete) {
          return {
            ok: false,
            text: `**مصاريف ${ctx.period.label} (${ctx.period.from} → ${ctx.period.to}) — غير محسومة**\n`
              + `لم أجد أي حركة مصروف في هذه الفترة، لكن التغطية **غير متحقَّقة** — فلا أجزم بغياب المصروف.`
              + `\n\nآخر مصروف مسجّل بتاريخ ${String(any[0].entry_date)}.`
              + emptyState.note,
            sources: ["expense_entries", "expense_entries_sync_state"]
          };
        }
        return {
          ok: true,
          text: `**مصاريف ${ctx.period.label} (${ctx.period.from} → ${ctx.period.to})**\nلا توجد أي حركة مصروف مسجّلة في هذه الفترة. آخر مصروف مسجّل بتاريخ ${String(any[0].entry_date)}.`,
          sources: ["expense_entries", "expense_entries_sync_state"]
        };
      }
      const total = list.reduce((sum, row) => sum + num(row.amount), 0);
      const lines = list
        .slice(0, 20)
        .map((row) => `- ${String(row.entry_date)} — ${String(row.account_name ?? "بند")}: **${money(row.amount)}**`);
      const state = await expenseCompleteness(ctx.period, partial);
      return {
        ok: true,
        text: `**مصاريف ${ctx.period.label} (${ctx.period.from} → ${ctx.period.to})** — `
          + (partial ? `مجموع جزئي **${money(total)}**` : `إجمالي **${money(total)}**`)
          + ` على ${list.length} حركة\n${lines.join("\n")}`
          + (list.length > 20 ? `\n\n_معروض 20 من ${list.length}._` : "")
          + state.note,
        sources: ["expense_entries", "expense_entries_sync_state"],
        partial
      };
    }
  },

  // ── المبيعات ──────────────────────────────────────────────────────────────
  {
    id: "sales",
    title: "المبيعات",
    minRole: "owner",
    patterns: [
      { re: /مبيعات|مبيع|بعنا|بيعنا|فوترنا/, w: 6 },
      { re: /قارن|مقارنه|مقابل|نسبه التغير/, w: 2 }
    ],
    async run(ctx) {
      const period = ctx.period;
      const compare = /قارن|مقارنه|مقابل|بالمقارنه|نسبه التغير|اكثر من|اقل من الشهر/.test(normalize(ctx.question));
      const current = await readSales(period, ctx.role);
      if (!current.rows.length) return salesEmptyPeriodResult(period, current.partial);

      const now = summarizeSales(current.rows);
      let text = formatSalesBody(period, now, ctx.role);
      let comparePeriod: Period | null = null;
      let comparePartial = false;
      if (compare) {
        const compared = await appendSalesComparison(text, period, now, ctx.role, ctx.question);
        text = compared.text;
        comparePeriod = compared.comparePeriod;
        comparePartial = compared.comparePartial;
      }

      const window = await salesSyncWindow();
      text += (await salesCompleteness(period, current.partial, window)).note;
      if (comparePeriod) text += (await salesCompleteness(comparePeriod, comparePartial, window)).note;
      return {
        ok: true,
        text,
        sources: ["sales_line_items", "sales_line_items_sync_state"],
        // بتر أيّ من القراءتين يجعل الجواب جزئياً — لا الحالية وحدها.
        partial: current.partial || comparePartial
      };
    }
  },

  // ── الأرباح ───────────────────────────────────────────────────────────────
  {
    id: "profit",
    title: "الأرباح",
    priority: 1,
    minRole: "owner",
    patterns: [{ re: /ربح|ارباح|خساره|هامش|مردود/, w: 6 }],
    async run(ctx) {
      const { days, latestAvailable, missingDays } = await profitReports(ctx.period);
      if (!days.length) {
        return ctx.period.explicit
          ? noProfitReport(ctx.period, latestAvailable)
          : noData("الأرباح", ["inventory_reports:ameen_daily_profit"]);
      }
      const summaries = days.map((d) => d.summary as Record<string, unknown>);
      const currency = String(summaries[0]?.currency ?? "USD");
      const sum = (field: string) => summaries.reduce((total, s) => total + num(s[field]), 0);
      const complete = summaries.every((s) => s.complete !== false);
      const missingCostLines = sum("missing_cost_lines");
      const newest = days.reduce((latest, d) => (d.created_at > latest ? d.created_at : latest), days[0].created_at);

      // `single` للعرض فقط (عنوان "يوم واحد" أم "فترة N يوم"). لا يصحّ اشتقاق
      // قمع تحذير الأيام الناقصة منه: فترة صريحة متعددة الأيام لم يصل منها
      // إلا تقرير يوم واحد كانت تُعرض كأنها "يوم واحد" كاملاً بلا أي تحذير
      // بأن باقي أيام الفترة بلا تقرير. الحكم بوجود نقص يعتمد على الفترة
      // **المطلوبة** لا على عدد الأيام **المُستلمة**. (رصدها Codex على PR #205 — h9ZJE.)
      const single = !ctx.period.explicit || days.length === 1;
      const periodIsMultiDay = ctx.period.explicit && ctx.period.from !== ctx.period.to;
      const heading = single
        ? `**تقرير الربح — ${days[0].report_date}**`
        : `**تقرير الربح — ${ctx.period.label} (${ctx.period.from} → ${ctx.period.to})** — ${days.length} يوم`;

      const text = `${heading}\n`
        + `- المبيعات الإجمالية: **${money(sum("sales_gross"), currency)}**\n`
        + `- الحسومات: ${money(sum("discounts"), currency)} / المرتجعات: ${money(sum("returns"), currency)}\n`
        + `- صافي المبيعات: **${money(sum("net_sales"), currency)}**\n`
        + `- تكلفة البضاعة المباعة: ${money(sum("sales_cost"), currency)}\n`
        + `- مجمل الربح: **${money(sum("gross_profit"), currency)}**\n`
        + `- المصاريف: ${money(sum("expenses"), currency)}\n`
        + `- **صافي الربح: ${money(sum("net_profit"), currency)}**\n`
        + `- عدد الفواتير: ${num(sum("sales_bill_count"))} — عدد السطور: ${num(sum("line_count"))}`
        + (missingCostLines > 0
          ? `\n\n> ⚠️ ${missingCostLines} سطر بلا تكلفة معروفة عبر ${single ? "هذا اليوم" : "أيام الفترة"}، فالربح أعلاه ناقص بمقدار تكلفتها.`
          : "")
        + (!complete ? `\n\n> ⚠️ تقرير يوم واحد على الأقل غير مكتمل حسب مصدره.` : "")
        + (periodIsMultiDay ? missingDaysNote(missingDays) : "");
      return { ok: true, text: text + freshnessNote(newest), sources: ["inventory_reports:ameen_daily_profit"], asOf: newest };
    }
  },

  // ── الذمم المدينة (ما للزبائن علينا / ما علينا من الزبائن) ────────────────
  {
    id: "receivables",
    title: "ذمم الزبائن",
    minRole: "owner",
    patterns: [
      // «علينا» ليست هنا عمداً: تعني ما ندين به للموردين (جانب الخصوم)، لا
      // ذمم الزبائن المدينة. (Codex P1 — discussion_r4019158397.)
      { re: /ذمم|ديون|دين|مديونيه|مدين|علي?هم|مستحقات/, w: 6 },
      { re: /اكبر الزبائن|اكتر زبون/, w: 4 }
    ],
    async run(ctx) {
      // لفترة تاريخية صريحة («ذمم الزبائن الشهر الماضي») يجب لقطة فعلية تغطي
      // ذاك التاريخ — لا أحدث لقطة معروضة كأنها تاريخية. بلا فترة صريحة
      // السلوك القديم (أحدث لقطة) كما هو. (رصدها Codex على PR #205.)
      const report = await reportForPeriod("inventory_reports", "ameen_customer_balances", ctx.period);
      if (ctx.period.explicit && !report) {
        return {
          ok: false,
          text: `لا تتوفر لدي لقطة أرصدة زبائن تغطي ${ctx.period.label} (${ctx.period.from} → ${ctx.period.to}). `
            + `لن أعرض الرصيد الحالي كأنه يعود لتلك الفترة — التقارير المحفوظة لا تغطيها.`,
          sources: ["inventory_reports:ameen_customer_balances"]
        };
      }
      const items = Array.isArray(report?.items) ? report.items : [];
      if (!items.length) return noData("أرصدة الزبائن", ["inventory_reports:ameen_customer_balances"]);
      const s = (report.summary ?? {}) as Record<string, unknown>;
      const debtors = items
        .filter((row: Record<string, unknown>) => num(row.balance) > 0)
        .sort((a: Record<string, unknown>, b: Record<string, unknown>) => num(b.balance) - num(a.balance));
      const top = debtors.slice(0, 15);
      const text = `**أكبر الذمم المدينة — ${report.report_date}**\n`
        + top
          .map((row: Record<string, unknown>, i: number) =>
            `${i + 1}. ${String(row.name ?? row.key ?? "بدون اسم")}: **${money(row.balance)}**`
            + (row.lastPaymentDate ? ` — آخر دفعة ${String(row.lastPaymentDate).slice(0, 10)}` : " — لا دفعات مسجّلة"))
          .join("\n")
        // العدد والمجموع يُؤخذان من summary لا من عدّ العناصر المعروضة: العناصر
        // قد تكون مقصوصة عند المصدر، فعدّها يعطي رقماً يناقض المجموع.
        + `\n\n**الإجمالي**: ${num(s.customersWithDebitBalance)} زبون مدين بمجموع **${money(s.totalDebitBalance)}**`
        + `، مقابل ${num(s.customersWithCreditBalance)} زبون دائن بمجموع ${money(s.totalCreditBalance)}.`
        + `\n_المعروض أعلاه أكبر ${top.length} من ${debtors.length} حساب مدين في التقرير._`
        + freshnessNote(report.created_at);
      return { ok: true, text, sources: ["inventory_reports:ameen_customer_balances"], asOf: report.created_at };
    }
  },

  // ── ما علينا للموردين (خصوم) — بلا مصدر قراءة حالياً ───────────────────────
  {
    id: "payables",
    title: "ذمم الموردين (ما علينا)",
    minRole: "owner",
    patterns: [
      // وزن أعلى من ذمم الزبائن حتى لا يفوز «ديون» وحده على سؤال «كم علينا ديون؟».
      { re: /(?:^| )علينا(?: |$)/, w: 9 },
      { re: /ذمم (?:ال)?مورد|ديون (?:ال)?مورد|مستحقات (?:ال)?مورد|الدائنون|ما ندين/, w: 8 }
    ],
    async run() {
      // لا يوجد تقرير أرصدة موردين/خصوم في مصادر المساعد. ممنوع إرجاع ذمم
      // الزبائن المدينة مكانها — عكس الميزانية. (Codex P1 — discussion_r4019158397.)
      return {
        ok: false,
        text: "سألتَ عمّا **علينا** (ديون/ذمم للموردين أو الخصوم)، وهذا غير متاح للقراءة من المساعد حالياً.\n\n"
          + "ما أملكه هو **ذمم الزبائن المدينة** (ما لهم علينا من الزبائن) من تقرير `ameen_customer_balances` — "
          + "ولن أعرضها جواباً عن «علينا» لأنها الجانب المعاكس من الميزانية.\n\n"
          + "اسأل مثلاً: `من أكبر الزبائن مديونية؟` إن أردت الذمم المدينة، "
          + "أو راجع أرصدة الموردين من الأمين مباشرة حتى يتوفّر مصدر خصوم للمساعد.",
        sources: []
      };
    }
  },

  // ── ملف زبون واحد ─────────────────────────────────────────────────────────
  {
    id: "customer",
    title: "ملف الزبون",
    minRole: "owner",
    entity: "customer",
    // تنبيه: الأنماط تُختبر على نص **مُطبَّع** (ى→ي، ة→ه، أإآ→ا). فكتابة «اشترى»
    // أو «حركة» هنا تعني نمطاً ميتاً لا يطابق شيئاً أبداً.
    patterns: [
      { re: /رصيد (?:ال)?(?:زبون|عميل)|كشف حساب|حركه (?:ال)?(?:زبون|عميل)/, w: 7 },
      { re: /(?:ماذا|شو) (?:اشتري|اخد)|مشتريات (?:ال)?زبون|فواتير (?:ال)?زبون/, w: 7 },
      // «مبيعات الزبون X» كانت تذهب لأداة المبيعات الإجمالية (وزن 6 على
      // «مبيعات») فتعرض إيراد كل الزبائن. وزن أعلى يوجّهها لملف الزبون مع
      // ترشيح فواتيره. (رصدها Codex على PR #205 بعد 3fdb433.)
      { re: /مبيعات (?:ال)?(?:زبون|عميل)/, w: 8 },
      // «ما رصيد أحمد؟» بلا كلمة «زبون». وزن منخفض عمداً كي تفوز أداة
      // دليل الحسابات على «رصيد حساب ...» التي تحمل وزن 7 على كلمة «حساب».
      { re: /رصيد /, w: 4 }
    ],
    async run(ctx) {
      if (!ctx.entityText.trim()) {
        return {
          ok: false,
          text: "حدّد اسم الزبون في السؤال، مثلاً: `ما رصيد الزبون شركة الأمل؟` أو `ماذا اشترى أحمد؟`.",
          sources: []
        };
      }
      const resolved = await resolveCustomerBalanceReport(ctx);
      if (resolved.error) return resolved.error;
      const { balances, wantsPurchases, needsHistoricalBalance } = resolved;
      const rows = Array.isArray(balances?.items) ? balances.items : [];
      if (!rows.length) return noData("أرصدة الزبائن", ["inventory_reports:ameen_customer_balances"]);

      const matched = matchCustomerBalanceRow(
        rows as Array<Record<string, unknown>>,
        ctx.entityText,
        balances?.report_date
      );
      if ("ok" in matched) return matched;

      const customer = matched.customer;
      const name = String(customer.name ?? customer.key ?? "");
      const guid = String(customer.customerGuid ?? "");
      const balanceLabel = needsHistoricalBalance
        ? `الرصيد بتاريخ ${balances?.report_date}`
        : "الرصيد الحالي";

      let text = `**${name}**\n`
        + `- ${balanceLabel}: **${money(customer.balance)}** ${num(customer.balance) > 0 ? "(مدين — عليه)" : num(customer.balance) < 0 ? "(دائن — له)" : "(مسدّد)"}\n`
        + `- تاريخ التقرير: ${balances?.report_date}`;
      text = appendCustomerPaymentsText(text, customer, ctx.period);

      const sources = ["inventory_reports:ameen_customer_balances"];
      if (wantsPurchases) {
        text = await appendCustomerPurchasesText(text, { guid, name, period: ctx.period, sources });
      }
      return {
        ok: true,
        text: text + freshnessNote(balances?.created_at as string | null | undefined),
        sources,
        asOf: balances?.created_at as string | null | undefined
      };
    }
  },

  // ── المخزون العام والنواقص ────────────────────────────────────────────────
  {
    id: "inventory",
    title: "حالة المخزون والنواقص",
    minRole: "employee",
    patterns: [
      { re: /ناقص|نواقص|نافد|منتهي|قارب|تحت الحد/, w: 7 },
      { re: /مخزون|جرد المخزون|وضع المواد|بضاعه متوفره/, w: 5 }
    ],
    async run(ctx) {
      const report = await latestReport("inventory_reports", "ameen_sql_agent");
      const items = Array.isArray(report?.items) ? report.items : [];
      if (!items.length) return noData("المخزون", ["inventory_reports:ameen_sql_agent"]);
      const s = (report.summary ?? {}) as Record<string, unknown>;
      const wantsShortage = /ناقص|نواقص|نافد|منتهي|قارب|تحت الحد|اشتري|شراء/.test(normalize(ctx.question));

      let text = `**حالة المخزون — ${report.report_date}**\n`
        + `- إجمالي المواد: **${num(s.totalStockItems)}**\n`
        + `- متوفرة: ${num(s.availableItems)} — تحت حد التنبيه: **${num(s.lowStockItems)}** — نافدة: **${num(s.outOfStockItems)}**\n`
        + `- فعّالة الحركة: ${num(s.activeItems)} — راكدة: ${num(s.staleItems)}\n`
        + `- حد التنبيه المعتمد: ${num(s.threshold)}`;

      if (wantsShortage) {
        const out = items.filter((row: Record<string, unknown>) => String(row.status ?? "") === "out");
        const low = items
          .filter((row: Record<string, unknown>) => String(row.status ?? "") === "low")
          .sort((a: Record<string, unknown>, b: Record<string, unknown>) => num(a.stockQty) - num(b.stockQty));
        const fmt = (row: Record<string, unknown>) =>
          `- ${String(row.name ?? row.key ?? "")}: ${qty(row.stockQty)} ${String(row.unit1Name ?? "")}`
          + (num(row.unit2Factor) > 0 ? ` (${qty(row.stockQtyUnit2)} ${String(row.unit2Name ?? "")})` : "");
        text += `\n\n**نافدة تماماً (${out.length})**\n`
          + (out.length ? out.slice(0, 20).map(fmt).join("\n") : "_لا يوجد_")
          + (out.length > 20 ? `\n- _و${out.length - 20} مادة أخرى._` : "")
          + `\n\n**تحت حد التنبيه (${low.length}) — الأقل أولاً**\n`
          + (low.length ? low.slice(0, 20).map(fmt).join("\n") : "_لا يوجد_")
          + (low.length > 20 ? `\n- _و${low.length - 20} مادة أخرى._` : "");
      }
      return { ok: true, text: text + freshnessNote(report.created_at), sources: ["inventory_reports:ameen_sql_agent"], asOf: report.created_at };
    }
  },

  // ── الأصناف الراكدة ───────────────────────────────────────────────────────
  {
    id: "stagnant",
    title: "الأصناف الراكدة",
    minRole: "owner",
    patterns: [{ re: /راكد|راكده|بطيئ|ما بتمشي|مش ماشيه|بلا حركه|ميته/, w: 8 }],
    async run(ctx) {
      const report = await latestReport("inventory_reports", "ameen_sql_agent");
      const items = Array.isArray(report?.items) ? report.items : [];
      if (!items.length) return noData("المخزون", ["inventory_reports:ameen_sql_agent"]);
      // الركود = مخزون موجود بلا مبيعات خلال النافذة. يُحسب من سطور المبيعات
      // الحقيقية لا من حقل جاهز، لأن staleItems في التقرير يعتمد تعريفاً آخر.
      const period = { from: damascusDate(-59), to: damascusDate(), label: "آخر 60 يوم", explicit: true };
      const sales = await readSales(period, ctx.role);
      // مرتجع (كمية سالبة) بلا بيع موجب مقابل ليس بيعاً — إدخاله بمجموعة
      // «المُباع» يُخفي صنفاً راكداً فعلياً. الركود = بلا بيعٍ موجب، لا بلا
      // أي سطر مبيعات إطلاقاً. (رصدها Codex بعد bea03ea.)
      const soldGuids = new Set(
        sales.rows
          .filter((row) => num(row.qty) > 0)
          .map((row) => String(row.item_key ?? "").trim().toLowerCase())
          .filter(Boolean)
      );
      const soldNames = new Set(
        sales.rows.filter((row) => num(row.qty) > 0).map((row) => normalize(row.item_name)).filter(Boolean)
      );
      const nameCounts = new Map<string, number>();
      for (const row of items as Array<Record<string, unknown>>) {
        const nk = normalize(row.name ?? row.key);
        if (nk) nameCounts.set(nk, (nameCounts.get(nk) ?? 0) + 1);
      }
      const collidingNames = new Set(
        [...nameCounts.entries()].filter(([, n]) => n > 1).map(([k]) => k)
      );
      const wasSold = (row: Record<string, unknown>) => {
        const guid = String(row.itemGuid ?? row.item_guid ?? "").trim().toLowerCase();
        // GUID معروف ⇒ الحكم من item_key فقط (مطابقة بلا حساسية لحالة الأحرف)
        if (guid) return soldGuids.has(guid);
        const nk = normalize(row.name ?? row.key);
        // اصطدام اسم بلا GUID: لا نعتبره «غير مبيع» ولا نُدخلُه قائمة الراكد بالتخمين.
        if (nk && collidingNames.has(nk)) return true;
        return !!nk && soldNames.has(nk);
      };
      const stagnant = items
        .filter((row: Record<string, unknown>) => num(row.stockQty) > 0 && !wasSold(row))
        .sort((a: Record<string, unknown>, b: Record<string, unknown>) => num(b.stockQty) - num(a.stockQty));
      // الحكم الموجب أخطر من السالب هنا: قراءةٌ ناقصة تُصغّر مجموعة المُباع،
      // فتنتقل أصنافٌ تُباع فعلاً إلى قائمة «الراكد». والقائمة تُغري بتصفية
      // مخزون رائج. فكلا الفرعين يُحجب حكمه عند النقص. (رصدها Codex بعد aca9bb2.)
      const stagnantState = await salesCompleteness(period, sales.partial);
      if (!stagnant.length) {
        // نفس منطق توصية الشراء: «لا يوجد صنف راكد» نفيٌ قاطع مبنيّ على أن
        // قائمة المبيعات شاملة. وقراءة ناقصة تعني أصنافاً بيعت ولم تُقرأ —
        // فيبقى الحكم غير قابل للبتّ، لا صحيحاً بتحذير.
        if (!stagnantState.complete) {
          return {
            ok: false,
            text: `**الأصناف الراكدة — غير محسومة**\n`
              + `لم يظهر صنف بمخزون بلا مبيعات خلال ${period.label}، لكن قراءة المبيعات المقارَن بها **غير مكتملة**.`
              + `\n\nفلن أقول «لا يوجد صنف راكد» — الحكم يفترض قائمة مبيعات شاملة، وهي ليست كذلك هنا.`
              + stagnantState.note,
            sources: ["inventory_reports:ameen_sql_agent", "sales_line_items", "sales_line_items_sync_state"],
            partial: sales.partial
          };
        }
        return {
          ok: true,
          text: `**الأصناف الراكدة (${period.label})**\nكل مادة عليها مخزون سُجّلت لها مبيعات خلال ${period.label}. لا يوجد صنف راكد بهذا التعريف.`,
          sources: ["inventory_reports:ameen_sql_agent", "sales_line_items", "sales_line_items_sync_state"],
          partial: sales.partial
        };
      }
      if (!stagnantState.complete) {
        return {
          ok: false,
          text: `**الأصناف الراكدة — غير محسومة**\n`
            + `ظهر ${stagnant.length} صنف بمخزون بلا مبيعات في القراءة، لكن القراءة **غير مكتملة**`
            + ` — والبيعة الغائبة قد تخصّ أيّاً منها، فيُوصف صنف رائج بالركود ويُصفّى مخزونه.`
            + `\n\nهؤلاء **مرشّحون غير مؤكَّدين**، لا قائمة أصناف راكدة:\n`
            + stagnant
              .slice(0, 25)
              .map((row: Record<string, unknown>) =>
                `- ${String(row.name ?? row.key)}: ${qty(row.stockQty)} ${String(row.unit1Name ?? "")}`)
              .join("\n")
            + (stagnant.length > 25 ? `\n- _و${stagnant.length - 25} صنف آخر._` : "")
            + stagnantState.note,
          sources: ["inventory_reports:ameen_sql_agent", "sales_line_items", "sales_line_items_sync_state"],
          partial: sales.partial,
          asOf: report.created_at
        };
      }
      return {
        ok: true,
        text: `**الأصناف الراكدة — مخزون موجود بلا أي بيع خلال ${period.label}** (${stagnant.length} صنف)\n`
          + stagnant
            .slice(0, 25)
            .map((row: Record<string, unknown>) =>
              `- ${String(row.name ?? row.key)}: ${qty(row.stockQty)} ${String(row.unit1Name ?? "")}`)
            .join("\n")
          + (stagnant.length > 25 ? `\n- _و${stagnant.length - 25} صنف آخر._` : "")
          + `\n\nالمقارنة بين مخزون ${report.report_date} وسطور المبيعات ${period.from} → ${period.to}.`
          + stagnantState.note,
        sources: ["inventory_reports:ameen_sql_agent", "sales_line_items", "sales_line_items_sync_state"],
        partial: sales.partial,
        asOf: report.created_at
      };
    }
  },

  // ── توصية الشراء ──────────────────────────────────────────────────────────
  {
    id: "purchase_advice",
    title: "ماذا يجب أن أشتري",
    minRole: "owner",
    patterns: [
      // «ماذا اشتري» وحدها في آخر السؤال = توصية شراء. أما «ماذا اشترى الزبون X»
      // فهي سؤال عن زبون، وتذهب لأداة الزبون التي تحمل وزناً على نفس العبارة.
      { re: /ماذا يجب ان اشتري|شو لازم اشتري|شو بدي اشتري|توصيه شراء|لازم نشتري|شو ينشري|ماذا اشتري\s*$/, w: 9 }
    ],
    async run(ctx) {
      const report = await latestReport("inventory_reports", "ameen_sql_agent");
      const items = Array.isArray(report?.items) ? report.items : [];
      if (!items.length) return noData("المخزون", ["inventory_reports:ameen_sql_agent"]);
      // مخزون قديم يجعل حكماً قاطعاً («شراء عاجل» أو «لا حاجة») غير موثوق —
      // نفس عتبة التحديث المستعملة في freshnessNote (≥12 ساعة). لا تُغيَّر
      // قواعد الترتيب نفسها، فقط يُحجب الحكم القاطع عند القدم. (رصدها Codex على PR #205.)
      const staleNote = freshnessNote(report.created_at);
      const stale = staleNote !== "";
      const period = { from: damascusDate(-29), to: damascusDate(), label: "آخر 30 يوم", explicit: true };
      const sales = await readSales(period, ctx.role);
      if (!sales.rows.length) {
        return {
          ok: false,
          text: `عندي حالة المخزون بتاريخ ${report.report_date}، لكن لا توجد سطور مبيعات في ${period.label} لأحسب منها معدّل الاستهلاك. بدون معدّل بيع حقيقي لا أستطيع ترتيب أولوية الشراء، ولن أرتّبها بالتخمين.`
            + (await salesCompleteness(period, sales.partial)).note,
          sources: ["inventory_reports:ameen_sql_agent", "sales_line_items", "sales_line_items_sync_state"]
        };
      }
      const days = 30;
      // الربط بـ MatGUID (sales.item_key ↔ inventory.itemGuid) لا بالاسم
      // المطبَّع: بطاقتان بنفس الاسم بعد التطبيع كانت تدمجان مبيعاتهما ثم
      // تُنسَب كاملةً لكل صف، فتُضاعَف الحاجة وتُبخَس أيام التغطية.
      // عند غياب GUID واصطدام الأسماء: نُسقِط الصف من التوصية بدل التخمين.
      // (رصدها Codex على PR #205 بعد 912e5c9.)
      const nameCounts = new Map<string, number>();
      for (const row of items as Array<Record<string, unknown>>) {
        const nk = normalize(row.name ?? row.key);
        if (nk) nameCounts.set(nk, (nameCounts.get(nk) ?? 0) + 1);
      }
      const collidingNames = new Set(
        [...nameCounts.entries()].filter(([, n]) => n > 1).map(([k]) => k)
      );
      const soldByGuid = new Map<string, number>();
      const soldByName = new Map<string, number>();
      for (const row of sales.rows) {
        const guid = String(row.item_key ?? "").trim().toLowerCase();
        if (guid) soldByGuid.set(guid, (soldByGuid.get(guid) ?? 0) + num(row.qty));
        const nk = normalize(row.item_name);
        if (nk) soldByName.set(nk, (soldByName.get(nk) ?? 0) + num(row.qty));
      }
      const soldQtyFor = (row: Record<string, unknown>): number | null => {
        const guid = String(row.itemGuid ?? row.item_guid ?? "").trim().toLowerCase();
        // GUID معروف ⇒ المبيعات من item_key فقط؛ لا رجوع للاسم حتى لو صفر
        if (guid) return soldByGuid.get(guid) ?? 0;
        const nk = normalize(row.name ?? row.key);
        if (!nk) return 0;
        if (collidingNames.has(nk)) return null; // لا تخمين عند اصطدام الاسم بلا GUID
        return soldByName.get(nk) ?? 0;
      };
      const ranked = items
        .map((row: Record<string, unknown>) => {
          const soldQty = soldQtyFor(row);
          if (soldQty === null) return null;
          const perDay = soldQty / days;
          const stock = num(row.stockQty);
          // المخزون السالب يقع فعلاً في الأمين (بيع قبل إدخال، أو خطأ إدخال).
          // «يكفي -13 يوم» جملة بلا معنى، فالتغطية تُقصّ عند الصفر ويُعلَن أن
          // الرصيد سالب ويحتاج مراجعة — لا يُخفى ولا يُعرض كأنه رقم تغطية.
          const usable = Math.max(0, stock);
          return {
            row,
            perDay,
            stock,
            negative: stock < 0,
            coverDays: perDay > 0 ? usable / perDay : Infinity
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => !!entry && entry.perDay > 0 && entry.coverDays < 21)
        .sort((a, b) => a.coverDays - b.coverDays || b.perDay - a.perDay);

      const state = await salesCompleteness(period, sales.partial);
      if (!ranked.length) {
        // «لا حاجة شراء عاجلة» حكمٌ نهائي يوقف تصرّفاً. وقراءةٌ ناقصة تبخس
        // معدّل البيع فتُدخل الجواب في هذا الفرع بالذات وتكتم طلباً لازماً.
        // فالتحذير الملحق لا يكفي هنا — يُقرأ الجواب «لا حاجة» ويُطوى معه.
        // الحكم يُحجب، ويُقال إن المعطيات لا تكفي للبتّ.
        if (!state.complete) {
          return {
            ok: false,
            text: `**توصية الشراء — غير محسومة**\n`
              + `لم يظهر صنف تحت 21 يوم تغطية حسب معدّل ${period.label}، لكن قراءة المبيعات التي بُني عليها هذا المعدّل **غير مكتملة**.`
              + ` والنقص يخفض المعدّل، وهو بعينه ما قد يكون أدخل الجواب في هذه النتيجة.`
              + `\n\nفلن أقول «لا حاجة شراء عاجلة» — لا أملك ما يكفي للبتّ، وقولها قد يكتم طلباً لازماً.`
              + state.note,
            sources: ["inventory_reports:ameen_sql_agent", "sales_line_items", "sales_line_items_sync_state"],
            partial: sales.partial
          };
        }
        if (stale) {
          return {
            ok: false,
            text: `**توصية الشراء — غير محسومة**\n`
              + `لم يظهر صنف تحت 21 يوم تغطية حسب معدّل ${period.label}، لكن تقرير المخزون الذي بُني عليه الحكم **قديم**.`
              + `\n\nفلن أقول «لا حاجة شراء عاجلة» بثقة — حدّث المخزون أولاً ثم أعد السؤال.`
              + staleNote,
            sources: ["inventory_reports:ameen_sql_agent", "sales_line_items", "sales_line_items_sync_state"],
            partial: sales.partial,
            asOf: report.created_at
          };
        }
        return {
          ok: true,
          text: `**توصية الشراء**\nلا يوجد صنف يبيع فعلياً ومخزونه يكفي أقل من 21 يوماً حسب معدّل ${period.label}. لا حاجة شراء عاجلة بهذا المعيار.`,
          sources: ["inventory_reports:ameen_sql_agent", "sales_line_items", "sales_line_items_sync_state"],
          partial: sales.partial,
          asOf: report.created_at
        };
      }
      // الفرع الموجب يُحجب كذلك. كنتُ تركتُه بحجّة أن البتر يخفض `perDay`
      // فيرفع `coverDays`، فما ظهر تحت 21 يوماً هو تحته يقيناً — والحجّة
      // خاطئة: الكميات **مُوقَّعة** والمرتجعات تُحفظ سالبةً (راجع
      // sales-line-items-atomic-refresh.sql). فبترُ صفٍّ سالب قديم مع إبقاء
      // موجبٍ أحدث **يضخّم** المعدّل ويقصّر التغطية، فيُدفع صنفٌ مخزونه كافٍ
      // إلى قائمة الشراء العاجل. (رصدها Codex على PR #205 بعد 4fb0d18.)
      if (!state.complete) {
        return {
          ok: false,
          text: `**أولوية الشراء — غير محسومة**\n`
            + `ظهر ${ranked.length} صنف تحت 21 يوم تغطية، لكن قراءة المبيعات **غير مكتملة**.`
            + ` والكميات مُوقَّعة (المرتجعات سالبة)، فبتر صفٍّ سالب يضخّم معدّل البيع`
            + ` ويقصّر التغطية — فقد يدخل القائمةَ صنفٌ مخزونه كافٍ.`
            + `\n\nهؤلاء **مرشّحون غير مؤكَّدين**، لا أولوية شراء مؤكَّدة:\n`
            + ranked
              .slice(0, 20)
              .map((e) =>
                `- ${String(e.row.name ?? e.row.key)}: مخزون ${qty(e.stock)} ${String(e.row.unit1Name ?? "")}`
                + `، بيع ${e.perDay.toFixed(1)}/يوم ⇒ يكفي ${e.coverDays.toFixed(1)} يوم`
                + (e.negative ? " ⚠️ الرصيد **سالب** في الأمين — يحتاج مراجعة إدخال" : ""))
              .join("\n")
            + `\n\nهذه قراءة وتحليل فقط — لا يُنشئ المساعد أي طلب شراء ولا يعدّل أي مخزون.`
            + state.note,
          sources: ["inventory_reports:ameen_sql_agent", "sales_line_items", "sales_line_items_sync_state"],
          partial: sales.partial,
          asOf: report.created_at
        };
      }
      if (stale) {
        return {
          ok: false,
          text: `**أولوية الشراء — غير محسومة**\n`
            + `ظهر ${ranked.length} صنف تحت 21 يوم تغطية، لكن تقرير المخزون الذي بُني عليه الحكم **قديم**.`
            + `\n\nهؤلاء **مرشّحون غير مؤكَّدين**، لا أولوية شراء مؤكَّدة — حدّث المخزون أولاً ثم أعد السؤال:\n`
            + ranked
              .slice(0, 20)
              .map((e) =>
                `- ${String(e.row.name ?? e.row.key)}: مخزون ${qty(e.stock)} ${String(e.row.unit1Name ?? "")}`
                + `، بيع ${e.perDay.toFixed(1)}/يوم ⇒ يكفي ${e.coverDays.toFixed(1)} يوم`
                + (e.negative ? " ⚠️ الرصيد **سالب** في الأمين — يحتاج مراجعة إدخال" : ""))
              .join("\n")
            + staleNote,
          sources: ["inventory_reports:ameen_sql_agent", "sales_line_items", "sales_line_items_sync_state"],
          partial: sales.partial,
          asOf: report.created_at
        };
      }
      return {
        ok: true,
        text: `**أولوية الشراء — مرتّبة بأيام التغطية المتبقية**\n`
          + `المعيار: معدّل البيع اليومي من سطور ${period.label} مقابل مخزون ${report.report_date}.\n\n`
          + ranked
            .slice(0, 20)
            .map((e) =>
              `- ${String(e.row.name ?? e.row.key)}: مخزون ${qty(e.stock)} ${String(e.row.unit1Name ?? "")}`
              + `، بيع ${e.perDay.toFixed(1)}/يوم ⇒ **يكفي ${e.coverDays.toFixed(1)} يوم**`
              + (e.negative ? " ⚠️ الرصيد **سالب** في الأمين — يحتاج مراجعة إدخال قبل الشراء" : ""))
            .join("\n")
          + `\n\nهذه قراءة وتحليل فقط — لا يُنشئ المساعد أي طلب شراء ولا يعدّل أي مخزون.`
          + (await salesCompleteness(period, sales.partial)).note,
        sources: ["inventory_reports:ameen_sql_agent", "sales_line_items", "sales_line_items_sync_state"],
        partial: sales.partial,
        asOf: report.created_at
      };
    }
  },

  // ── حركة صنف / سعر صنف ────────────────────────────────────────────────────
  {
    id: "item",
    title: "حركة صنف",
    minRole: "employee",
    entity: "item",
    patterns: [
      { re: /كم بعنا من|مبيعات ماده|مبيعات صنف|حركه (?:صنف|ماده)/, w: 8 },
      // «حركة» وحدها تكفي للصنف. أدوات الصندوق (6) والزبون (7) تحمل أوزاناً
      // أعلى على كلماتها الخاصة، فـ«حركة الصندوق» و«حركة الزبون» تذهبان إليهما.
      // ملاحظة إلزامية: لا تستعمل \b مع العربية — \w في JS هو [A-Za-z0-9_]
      // فقط، فالحرف العربي «غير كلمة» ولا تنشأ حدود بينه وبين الفراغ، والنمط
      // لا يطابق شيئاً أبداً وبصمت. استعمل (?:^| ) و(?: |$).
      { re: /(?:^| )حركه(?: |$)/, w: 5 },
      // «سعر صرف الدولار» ليس سؤال صنف — والاستثناء يشمل الصيغة بلا «ال».
      { re: /سعر (?!(?:ال)?صرف)/, w: 6 }
    ],
    async run(ctx) {
      if (!ctx.entityText.trim()) {
        return { ok: false, text: "حدّد اسم الصنف، مثلاً: `ما حركة ماستر طويل ورق؟` أو `سعر كينغ دوم سليم`.", sources: [] };
      }
      // مُصفَّح كذلك: سقف الخادم قد يقصّ اللائحة، فيصير «لم أجد صنفاً» جواباً
      // كاذباً عن صنف موجود فعلاً خارج الصفحة الأولى.
      const { rows: priceRows } = await readPaged((range) =>
        "approved_price_items?select=item_name,item_key,unit1_name,unit1_price,unit2_name,"
        + `unit2_factor,unit2_price,sale_price,stock_qty,stock_status&order=item_name.asc${range}`
      );
      const matches = matchByName(priceRows, (row) => String(row.item_name ?? row.item_key ?? ""), ctx.entityText, 5);
      if (!matches.length) {
        return {
          ok: false,
          text: `لم أجد صنفاً باسم «${ctx.entityText.trim()}» في لائحة الأسعار المعتمدة (${priceRows.length} صنف).`,
          sources: ["approved_price_items"]
        };
      }
      // اسم غامض يطابق أكثر من صنف بلا فارق فعلي بينها — نفس منطق مطابقة
      // الزبائن أعلاه: لا نخمّن، نطلب من السائل تدقيق الاسم. (رصدها Codex على PR #205.)
      if (isAmbiguous(matches)) {
        return {
          ok: false,
          text: `الاسم «${ctx.entityText.trim()}» يطابق أكثر من صنف:\n`
            + matches.map((m) => `- ${String(m.row.item_name ?? m.row.item_key)}`).join("\n")
            + `\n\nاكتب اسم الصنف بشكل أدق لأختار الصنف الصحيح — لن أخمّن بينها.`,
          sources: ["approved_price_items"]
        };
      }
      const item = matches[0].row;
      const name = String(item.item_name ?? item.item_key ?? "");
      let text = `**${name}**\n`
        + `- المخزون: **${qty(item.stock_qty)} ${String(item.unit1_name ?? "")}** (${String(item.stock_status ?? "غير محدد")})\n`
        + `- السعر: ${money(item.unit1_price ?? item.sale_price)} / ${String(item.unit1_name ?? "وحدة")}`
        + (num(item.unit2_factor) > 0
          ? ` — ${money(item.unit2_price)} / ${String(item.unit2_name ?? "")} (${qty(item.unit2_factor)} بالوحدة)`
          : "");
      if (matches.length > 1) {
        text += `\n\n_أصناف مشابهة: ${matches.slice(1).map((m) => String(m.row.item_name)).join("، ")}_`;
      }

      const movement = await appendItemSalesMovement(text, ctx, name);
      return {
        ok: true,
        text: movement.text,
        sources: ["approved_price_items", "sales_line_items", "sales_line_items_sync_state"],
        partial: movement.partial
      };
    }
  },

  // ── المشتريات ─────────────────────────────────────────────────────────────
  {
    id: "purchases",
    title: "المشتريات والموردون",
    minRole: "owner",
    entity: "supplier",
    patterns: [
      { re: /مشتريات|مورد|موردين|فواتير الشراء|اشترينا/, w: 7 }
    ],
    async run(ctx) {
      const report = await latestReport("ameen_purchase_invoice_reports");
      const items = Array.isArray(report?.items) ? report.items : [];
      if (!items.length) return noData("فواتير المشتريات", ["ameen_purchase_invoice_reports"]);
      const s = (report.summary ?? {}) as Record<string, unknown>;

      // ⚠️ قيمة السطر في هذا التقرير غير موثوقة (تحقّق على الإنتاج 2026-09-06).
      // لذلك: لا يُعرض إجمالي قيمة، ويُعلَن التعارض بدل تمرير رقم يبدو دقيقاً.
      // الأعداد تُشتقّ من المجموعة المُرشَّحة بالفترة المطلوبة لا من ملخّص اللقطة.
      const inPeriod = (invoice: Record<string, unknown>) => {
        if (!ctx.period.explicit) return true;
        const date = String(invoice.date ?? "").slice(0, 10);
        return date >= ctx.period.from && date <= ctx.period.to;
      };
      const { bySupplier, lines, conflicting, truncatedSuppliers } = aggregatePurchaseSuppliers(
        items as Array<Record<string, unknown>>,
        inPeriod
      );

      const unreliable = lines > 0 && conflicting / lines > 0.2;
      const bills = bySupplier.reduce((sum, row) => sum + row.count, 0);
      const returnsTotal = bySupplier.reduce((sum, row) => sum + row.returnCount, 0);
      const scope = ctx.period.explicit
        ? `${ctx.period.label} (${ctx.period.from} → ${ctx.period.to})`
        : `نافذة ${String(s.fromDate ?? "?")} → ${report.report_date}`;

      const coverage = reportCoverage(ctx.period, s, report.report_date, truncatedSuppliers > 0, "تقرير المشتريات");

      // المرتجع سطرٌ حقيقي في نافذة الفترة ويستحق أن يُعرض، لا أن يُبتلع خلف نفي قاطع.
      if (ctx.period.explicit && !bills && !returnsTotal) {
        return purchasesEmptyForPeriod(scope, coverage, report.created_at);
      }

      return formatPurchasesBody({
        scope,
        bySupplier,
        bills,
        lines,
        returnsTotal,
        conflicting,
        unreliable,
        period: ctx.period,
        coverage,
        items: items as Array<Record<string, unknown>>,
        entityText: ctx.entityText,
        inPeriod,
        asOf: report.created_at
      });
    }
  },

  // ── المستودعات ────────────────────────────────────────────────────────────
  {
    id: "warehouses",
    title: "المستودعات",
    minRole: "employee",
    patterns: [{ re: /مستودع|مستودعات|مخازن|مخزن/, w: 7 }],
    async run() {
      const rows = await readRest(
        "ameen_warehouse_stock_reports?select=report_date,summary,created_at&order=created_at.desc&limit=40"
      );
      const list: Array<Record<string, unknown>> = Array.isArray(rows) ? rows : [];
      if (!list.length) return noData("مخزون المستودعات", ["ameen_warehouse_stock_reports"]);
      const seen = new Map<string, Record<string, unknown>>();
      for (const row of list) {
        const summary = (row.summary ?? {}) as Record<string, unknown>;
        const key = String(summary.warehouseKey ?? "");
        if (key && !seen.has(key)) seen.set(key, { ...summary, report_date: row.report_date, created_at: row.created_at });
      }
      return {
        ok: true,
        text: `**المستودعات التي تصل تقاريرها فعلياً (${seen.size})**\n`
          + [...seen.values()]
            .map((w) => `- **${String(w.warehouseName ?? "بدون اسم")}**: ${num(w.item_count)} صنف — آخر تقرير ${String(w.report_date ?? "")}`)
            .join("\n")
          + `\n\nهذه المستودعات مقروءة من الأمين كما هي؛ لم تُخترع أي تسمية.`,
        sources: ["ameen_warehouse_stock_reports"],
        asOf: String(list[0].created_at ?? "")
      };
    }
  },

  // ── المناقلات ─────────────────────────────────────────────────────────────
  {
    id: "transfers",
    title: "مناقلات المستودعات",
    minRole: "owner",
    // الوزن أعلى من أداة المستودعات (7) عمداً: «التحويلات بين المستودعات» يحمل
    // كلمة «مستودعات» أيضاً، والنية فيه المناقلات لا قائمة المستودعات.
    patterns: [{ re: /مناقل|تحويلات? بين|نقل بين|نقل بضاعه|تحويلات المستودع/, w: 9 }],
    async run(ctx) {
      // اللقطة أحدث رفع من المنتِج (افتراضياً ~60 يوماً). الأسئلة بفترة صريحة
      // («مناقلات اليوم») كانت تتجاهل ctx.period وتعيد كل عناصر اللقطة —
      // فتختلط مناقلات قديمة بعدّ اليوم. أسماء المستودعات من المنتِج هي
      // sourceWarehouseName / destinationWarehouseName لا from/to. (Codex #205.)
      const report = await latestReport("ameen_warehouse_transfer_reports");
      const items = Array.isArray(report?.items) ? report.items : [];
      if (!report || !items.length) {
        return {
          ok: false,
          text: "لا يوجد أي تقرير مناقلات مستودعات محفوظ في النظام حتى الآن. الجدول `ameen_warehouse_transfer_reports` جاهز لكنه فارغ — لم يرفع سكربت المزامنة أي مناقلة بعد. لا أستطيع الإجابة عن المناقلات قبل وصول أول تقرير.",
          sources: ["ameen_warehouse_transfer_reports"]
        };
      }
      const s = (report.summary ?? {}) as Record<string, unknown>;
      const inPeriod = (row: Record<string, unknown>) => {
        if (!ctx.period.explicit) return true;
        const date = String(row.date ?? "").slice(0, 10);
        return date >= ctx.period.from && date <= ctx.period.to;
      };
      const filtered = items.filter(inPeriod);
      const coverage = reportCoverage(ctx.period, s, report.report_date, false, "تقرير المناقلات");
      const scope = ctx.period.explicit
        ? `${ctx.period.label} (${ctx.period.from} → ${ctx.period.to})`
        : `نافذة ${String(s.fromDate ?? "?")} → ${report.report_date}`;

      if (ctx.period.explicit && !filtered.length) {
        if (!coverage.covered) {
          return {
            ok: false,
            text: `لا أستطيع تأكيد مناقلات ${scope}: الفترة تتجاوز نافذة اللقطة المتاحة`
              + ` (${String(s.fromDate ?? "?")} → ${report.report_date}).`
              + coverage.note,
            sources: ["ameen_warehouse_transfer_reports"],
            asOf: report.created_at
          };
        }
        return {
          ok: true,
          text: `**مناقلات المستودعات — ${scope}**\nلا توجد أي مناقلة مسجّلة في هذه الفترة.`
            + coverage.note
            + freshnessNote(report.created_at),
          sources: ["ameen_warehouse_transfer_reports"],
          asOf: report.created_at
        };
      }

      return {
        ok: true,
        text: `**مناقلات المستودعات — ${scope}** (${filtered.length} مناقلة)\n`
          + filtered
            .slice(0, 15)
            .map((row: Record<string, unknown>) =>
              `- ${String(row.date ?? "")}: ${String(row.sourceWarehouseName ?? "?")} → ${String(row.destinationWarehouseName ?? "?")}`
              + ` (${Array.isArray(row.items) ? row.items.length : 0} صنف)`)
            .join("\n")
          + (filtered.length > 15 ? `\n… و${filtered.length - 15} مناقلة أخرى` : "")
          + coverage.note
          + freshnessNote(report.created_at),
        sources: ["ameen_warehouse_transfer_reports"],
        asOf: report.created_at
      };
    }
  },

  // ── أرصدة دليل الحسابات ───────────────────────────────────────────────────
  {
    id: "accounts",
    title: "أرصدة دليل الحسابات",
    minRole: "owner",
    entity: "account",
    patterns: [
      { re: /دليل الحسابات|شجره الحسابات|حساب رقم|الحسابات الختاميه/, w: 7 },
      // كلمة «حساب» تُرجّح دليل حسابات الأمين على ملف الزبون.
      { re: /رصيد (?:ال)?حساب/, w: 7 }
    ],
    async run(ctx) {
      // لفترة تاريخية صريحة («رصيد حساب البنك الوطني الشهر الماضي») يجب لقطة
      // تغطي ذاك التاريخ — لا أحدث لقطة معروضة كأنها تاريخية. (رصدها Codex على
      // PR #205 بعد f5cabd6 — discussion_r4017908937.)
      const report = await reportForPeriod("ameen_account_balance_reports", undefined, ctx.period);
      if (ctx.period.explicit && !report) {
        return {
          ok: false,
          text: `لا تتوفر لدي لقطة أرصدة حسابات تغطي ${ctx.period.label} (${ctx.period.from} → ${ctx.period.to}). `
            + `لن أعرض الرصيد الحالي كأنه يعود لتلك الفترة — التقارير المحفوظة لا تغطيها.`,
          sources: ["ameen_account_balance_reports"]
        };
      }
      const items = Array.isArray(report?.items) ? report.items : [];
      if (!items.length) return noData("أرصدة الحسابات", ["ameen_account_balance_reports"]);
      const s = (report.summary ?? {}) as Record<string, unknown>;
      if (!ctx.entityText.trim()) {
        const top = items
          .filter((row: Record<string, unknown>) => num(row.balance) !== 0)
          .sort((a: Record<string, unknown>, b: Record<string, unknown>) => Math.abs(num(b.balance)) - Math.abs(num(a.balance)))
          .slice(0, 15);
        return {
          ok: true,
          text: `**دليل حسابات الأمين — ${report.report_date}**\n`
            + `${num(s.accountCount)} حساب، منها ${num(s.nonZeroAccountCount)} برصيد غير صفري.\n\n`
            + `**أكبر الأرصدة**\n`
            + top
              .map((row: Record<string, unknown>) =>
                `- ${row.accountCode ? `${String(row.accountCode)} — ` : ""}${String(row.accountName ?? "")}: **${money(row.balance)}**`)
              .join("\n")
            + `\n\nالأساس: ${String(s.accountingBasis ?? "")}`
            + freshnessNote(report.created_at),
          sources: ["ameen_account_balance_reports"],
          asOf: report.created_at
        };
      }
      const matches = matchByName(
        items as Array<Record<string, unknown>>,
        (row) => `${String(row.accountCode ?? "")} ${String(row.accountName ?? "")} ${String(row.parentName ?? "")}`,
        ctx.entityText,
        10
      );
      if (!matches.length) {
        return {
          ok: false,
          text: `لم أجد حساباً يطابق «${ctx.entityText.trim()}» في دليل حسابات الأمين لتاريخ ${report.report_date} (${items.length} حساب).`
            + `\n\nإن كان المقصود زبوناً لا حساباً دفترياً، اسأل: \`ما رصيد الزبون ${ctx.entityText.trim()}؟\` — أرصدة الزبائن مصدرها تقرير منفصل.`,
          sources: ["ameen_account_balance_reports"]
        };
      }
      return {
        ok: true,
        text: `**نتائج البحث في دليل الحسابات — ${report.report_date}**\n`
          + matches
            .map(({ row }) =>
              `- ${row.accountCode ? `${String(row.accountCode)} — ` : ""}${String(row.accountName ?? "")}: **${money(row.balance)}**`
              + ` (مدين ${money(row.debit)} / دائن ${money(row.credit)})`)
            .join("\n")
          + freshnessNote(report.created_at),
        sources: ["ameen_account_balance_reports"],
        asOf: report.created_at
      };
    }
  },

  // ── الجرد ─────────────────────────────────────────────────────────────────
  {
    id: "stocktaking",
    title: "نتائج الجرد",
    minRole: "owner",
    patterns: [{ re: /الجرد|جرد|نتائج العد|عد المواد|جلسه جرد/, w: 7 }],
    async run() {
      // الجرد يعيش في جداول smart_inventory_* / inventory_recon_* وهي محكومة
      // بـ RLS للمالك وبـ RPCs مخصّصة. المساعد لا يملك مساراً للقراءة منها
      // حالياً، ولا يجوز أن يخترع رقماً بديلاً.
      return {
        ok: false,
        text: "لا أستطيع قراءة نتائج الجرد من هنا حالياً.\n\n"
          + "جلسات الجرد محفوظة في `smart_inventory_sessions` و`inventory_recon_sessions`، وهي لا تُقرأ إلا عبر دوال RPC مخصّصة للمالك "
          + "(`smart_inventory_owner_dashboard` و`smart_inventory_owner_report`) وليست ضمن مصادر القراءة المصرّح بها للمساعد.\n\n"
          + "افتح صفحة **الجرد الذكي** في الموقع لرؤية النتائج. ولن أعطيك رقم جرد من مصدر آخر لأنه سيكون رقماً خاطئاً.",
        sources: []
      };
    }
  },

  // ── الملخص التنفيذي ───────────────────────────────────────────────────────
  {
    id: "briefing",
    title: "ما يحتاج انتباهك اليوم",
    minRole: "owner",
    patterns: [
      { re: /يحتاج انتباه|اهم الامور|شو صار|ملخص|وضع الشركه|كيف الوضع|نظره عامه|بريف/, w: 8 }
    ],
    async run(ctx) {
      // مركّب من عدة مصادر. فشل مصدر واحد يُعلَن صراحةً ولا يُستبدل بتقدير من
      // مصدر آخر — هذه القاعدة مُختبَرة في scripts/check-assistant-routing.mjs.
      const parts: string[] = [];
      const failures: string[] = [];
      const sources: string[] = [];

      const run = async (label: string, fn: () => Promise<string | null>) => {
        try {
          const line = await fn();
          if (line) parts.push(line);
        } catch {
          failures.push(label);
        }
      };

      await run("الصناديق", async () => {
        // ثالث قارئ مستقل لهذا الجدول، وكان يأخذ أحدث صف بـ`created_at` بصرف
        // النظر عن `report_date`. فيومٌ لم يُرفع تقريره بعد — أو تقرير قديم
        // رُفع **بعد** تقرير اليوم — كان يُعرض تحت عنوان «مقبوضات اليوم» في
        // ملخصٍ كامل عنوانه «اليوم». (رصدها Codex على PR #205 بعد 9a12ea0.)
        //
        // فالقراءة تمرّ الآن من movementReports كما تمرّ الأداتان: ترشيح
        // بالتاريخ لا ترتيب بوقت الرفع. ويوم بلا تقرير يُعلَن مع ذكر أحدث
        // تاريخ متاح — ولا تُوضع أرقام يوم آخر مكانه.
        const period = { from: damascusDate(), to: damascusDate(), label: "اليوم", explicit: true };
        const { days, latestAvailable } = await movementReports(period);
        sources.push("daily_movement_reports");
        const row = days[0] ?? null;
        if (!row?.payload) {
          return `**السيولة**: لا يوجد تقرير حركة صناديق لليوم (${period.from})`
            + (latestAvailable
              ? `. أحدث تقرير متاح بتاريخ **${latestAvailable}** — اسأل عن الصناديق مباشرةً لقراءته، فلن أضع أرقامه تحت عنوان اليوم.`
              : ".");
        }
        const totals = Array.isArray(row.payload.cashTotals) ? row.payload.cashTotals : [];
        const paid = (row.payload.paymentSummary ?? {}) as Record<string, unknown>;
        return `**السيولة (${row.report_date})**: `
          + (totals.length
            ? totals.map((t: Record<string, unknown>) => money(t.closing, String(t.currency ?? ""))).join(" + ")
            : "غير متوفرة")
          + ` — مقبوضات اليوم ${money(paid.totalUsd)} على ${num(paid.count)} دفعة.`;
      });

      await run("المبيعات", async () => {
        // الملخص مستهلك خامس لـreadSales، وكان يتجاوز حارس نافذة المزامنة
        // فيعرض «0 USD» أو صفوفاً غير محدَّثة كأنها مبيعات اليوم المؤكَّدة.
        // (رصدها Codex على PR #205 بعد df4b3df.)
        const period = { from: damascusDate(), to: damascusDate(), label: "اليوم", explicit: true };
        const today = await readSales(period, ctx.role);
        sources.push("sales_line_items", "sales_line_items_sync_state");
        const s = summarizeSales(today.rows);
        return `**مبيعات اليوم**: ${money(s.total)} على ${s.bills} فاتورة.`
          + (s.bills === 0 ? " (لم تُرفع فواتير اليوم بعد أو لا يوجد بيع)" : "")
          + (await salesCompleteness(period, today.partial)).note;
      });

      await run("الذمم", async () => {
        const report = await latestReport("inventory_reports", "ameen_customer_balances");
        sources.push("inventory_reports:ameen_customer_balances");
        if (!report) return "**الذمم**: لا يوجد تقرير أرصدة.";
        const s = (report.summary ?? {}) as Record<string, unknown>;
        const items = Array.isArray(report.items) ? report.items : [];
        const top = items
          .filter((row: Record<string, unknown>) => num(row.balance) > 0)
          .sort((a: Record<string, unknown>, b: Record<string, unknown>) => num(b.balance) - num(a.balance))
          .slice(0, 3);
        return `**الذمم (${report.report_date})**: ${num(s.customersWithDebitBalance)} مدين بمجموع ${money(s.totalDebitBalance)}.`
          + (top.length ? ` الأكبر: ${top.map((row: Record<string, unknown>) => `${String(row.name)} (${money(row.balance)})`).join("، ")}.` : "");
      });

      await run("المخزون", async () => {
        const report = await latestReport("inventory_reports", "ameen_sql_agent");
        sources.push("inventory_reports:ameen_sql_agent");
        if (!report) return "**المخزون**: لا يوجد تقرير.";
        const s = (report.summary ?? {}) as Record<string, unknown>;
        return `**المخزون (${report.report_date})**: ${num(s.outOfStockItems)} صنف نافد و${num(s.lowStockItems)} تحت حد التنبيه من أصل ${num(s.totalStockItems)}.`;
      });

      await run("الأرباح", async () => {
        const report = await latestReport("inventory_reports", "ameen_daily_profit");
        sources.push("inventory_reports:ameen_daily_profit");
        if (!report?.summary) return null;
        const s = report.summary as Record<string, unknown>;
        // رصدها Codex #29: لا تعرض رقم ربح قاطع إذا كان التقرير غير مكتمل أو
        // ناقص تكلفة سطور — نفس معيار الثقة المعتمد بأداة الأرباح (complete/missing_cost_lines).
        if (s.complete === false || num(s.missing_cost_lines) > 0) {
          return `**ربح ${report.report_date}**: غير متاح بدقة — تقرير الربح ناقص (تكلفة بعض السطور غير معروفة)، فلا رقم قاطع يُعرض هنا.`;
        }
        return `**ربح ${report.report_date}**: صافي ${money(s.net_profit, String(s.currency ?? "USD"))} من صافي مبيعات ${money(s.net_sales, String(s.currency ?? "USD"))}.`;
      });

      if (!parts.length) {
        return {
          ok: false,
          text: `تعذّرت قراءة كل المصادر (${failures.join("، ")}). لا أملك أي رقم موثوق أعرضه، ولن أختلق ملخصاً.`,
          sources
        };
      }
      return {
        ok: true,
        text: `**ملخص اليوم — ${damascusDate()}**\n\n${parts.join("\n\n")}`
          + (failures.length
            ? `\n\n> ⚠️ تعذّرت قراءة: ${failures.join("، ")}. ما فوق لا يشمل هذه الجوانب — ولم أعوّضها بأي تقدير.`
            : ""),
        sources
      };
    }
  }
];

// ============================================================================
// المخطِّط — يفهم النية ويختار الأداة المصرَّح بها
// ============================================================================
type Plan = { tool: Tool; score: number; entityText: string } | null;

// كلمات تُشغّل الأداة تُزال قبل استخراج اسم الكيان، كي لا يصير «رصيد» جزءاً من
// اسم الزبون المطلوب.
// مكتوبة بالصيغة المُطبَّعة وحدها — «حركة»/«مادة»/«اشترى» لا تظهر بعد التطبيع.
const TRIGGER_WORDS =
  /رصيد|حساب|كشف|حركه|فواتير|فاتوره|اشتري|اخد|مشتريات|سعر|صنف|ماده|زبون|عميل|مورد|صندوق|مبيعات|ربح|ذمم|دين|مخزون|مستودع|جرد|مصروف|مصاريف|ناقص|راكد/g;

function extractEntity(question: string) {
  return normalize(question)
    .replace(TRIGGER_WORDS, " ")
    .split(" ")
    // «ال» تبقى معلّقة بعد شطب كلمة مُشغِّلة من «الزبون»/«الصنف»، وهي مقطع يرد
    // في كل اسم تقريباً — إبقاؤها يجعل المطابقة تلتقط أي حساب كان.
    .filter((word) => word.length > 2 && word !== "ال" && !STOP_WORDS.has(word))
    .join(" ")
    .trim();
}

// حدّ أدنى للثقة. الأنماط ذات الوزن 2 مصمَّمة كمعزِّزات لا كمشغِّلات: كلمة
// «مقارنة» وحدها في «ما حصتنا السوقية مقارنة بالمنافسين؟» يجب ألا تسحب السؤال
// إلى تقرير المبيعات. أي نمط أساسي في السجل وزنه 4 فأعلى.
const MIN_PLAN_SCORE = 4;

function planDeterministic(question: string, rank: number): Plan {
  const q = normalize(question);
  let best: Plan = null;
  for (const tool of TOOLS) {
    if (rank < rankOf(tool.minRole)) continue;
    let score = 0;
    for (const { re, w } of tool.patterns) if (re.test(q)) score += w;
    if (score < MIN_PLAN_SCORE) continue;
    // تعادل النقاط لا يُحسم بترتيب التسجيل في TOOLS — priority أعلى يفوز، والتعادل
    // فيها أيضاً يبقي أول تسجيل (استقرار)، فلا اعتماد ضمنياً على مكان الأداة بالمصفوفة.
    if (!best || score > best.score || (score === best.score && (tool.priority ?? 0) > (best.tool.priority ?? 0))) {
      best = { tool, score, entityText: tool.entity ? extractEntity(question) : "" };
    }
  }
  return best;
}

// نقطة تمديد المخطِّط.
//
// المطلوب معمارياً «فهم النية»، وهو هنا مطابقة أنماط مُصرَّح بها داخل كل أداة —
// لا سلسلة if/else مركزية: إضافة قدرة = إضافة عنصر في TOOLS، والمخطِّط لا يُمسّ.
//
// لماذا لا يوجد مخطِّط بنموذج لغوي هنا: بوابة المشروع (scripts/check.mjs) تمنع
// نصّاً ورود أي عنوان مزوّد ذكاء اصطناعي أو اسم مفتاحه في هذا الملف، تحت العنوان
// «Financial data must not leave Supabase without explicit approval». هذا قرار
// أمني قائم لصاحب النظام، ولا يجوز نقضه لإضافة ميزة. فيبقى `externalDataShared`
// صحيحاً بلا شرط: لا شيء من هذه الدالة يغادر Supabase إطلاقاً.
//
// إن أراد المالك لاحقاً فهم نية أوسع بنموذج لغوي، فالمسار الصحيح: موافقة صريحة
// منه، ثم تعديل ذلك البند في البوابة، ثم إضافة مخطِّط يرسل **نص السؤال وأسماء
// الأدوات فقط** ويعيد `{tool, entity}`؛ ويبقى تنفيذ القراءة وصياغة الجواب هنا
// كما هما، فلا يرى النموذج أي صف بيانات. التحقق من الدور يُعاد بعد قرار المخطِّط
// في كل الأحوال — النموذج لا يمنح صلاحية.
function plan(question: string, rank: number): Plan {
  return planDeterministic(question, rank);
}

function capabilityList(rank: number) {
  return TOOLS.filter((tool) => rank >= rankOf(tool.minRole)).map((tool) => `- ${tool.title}`).join("\n");
}

// ============================================================================
// المعالج
// ============================================================================
function safeMessages(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(-12)
    .map((message) => ({
      role: message?.role === "assistant" ? "assistant" : "user",
      content: String(message?.content ?? "").slice(0, 4000)
    }))
    .filter((message) => message.content.trim());
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: headers(request) });
  if (request.method !== "POST") return json(request, 405, { error: "method_not_allowed" });

  let actor: Actor;
  try {
    actor = await requireActor(request);
  } catch (error) {
    const code = String((error as { message?: unknown } | undefined)?.message ?? "internal_error");
    return json(request, code === "forbidden" ? 403 : 401, { error: code === "forbidden" ? "forbidden" : "unauthorized" });
  }

  try {
    const body = await request.json().catch(() => ({}));
    const messages = safeMessages(body?.messages);
    if (!messages.length) return json(request, 400, { error: "empty_message" });
    const question = messages[messages.length - 1].content;
    const role: Role = actor.rank >= ROLE_RANK.owner ? "owner" : "employee";

    // فهم النية ثم اختيار الأداة المصرَّح بها لهذا الدور
    const chosen = plan(question, actor.rank);

    if (!chosen) {
      return json(request, 200, {
        reply: `لم أفهم من سؤالك أي مصدر بيانات أقرأ منه، ولن أجيب بتخمين.\n\n`
          + `ما أستطيع قراءته بصلاحيتك الحالية:\n${capabilityList(actor.rank)}\n\n`
          + `اسألني مثلاً: \`كم يوجد بالصندوق؟\` أو \`ما رصيد الزبون شركة الأمل؟\` أو \`ما الأصناف الناقصة؟\``,
        provider: "internal",
        readOnly: true,
        tool: null,
        answered: false,
        sources: [],
        role: actor.role,
        externalDataShared: false
      });
    }

    // تحقق ثانٍ من الصلاحية عند التنفيذ — لا يُعتمد على المخطِّط وحده.
    if (actor.rank < rankOf(chosen.tool.minRole)) return json(request, 403, { error: "forbidden" });

    let period: Period;
    try {
      period = parsePeriod(question);
    } catch (error) {
      const code = String((error as { message?: unknown } | undefined)?.message ?? "bad_period");
      // تاريخ تقويمي ذُكر بصيغة غير معروفة/غير صالحة — رفض صريح لا جواب «اليوم».
      if (code === "unrecognized_date") {
        auditLog({ actorId: actor.id, role: actor.role, toolId: chosen.tool.id, outcome: "error", code });
        return json(request, 200, {
          reply: `طلبتَ تاريخاً محدداً لكن لم أتعرّف على صيغته، ولن أجيب بأرقام **اليوم** مكانه.\n\n`
            + `الصيغ المدعومة: \`2026-09-01\` أو \`1/9/2026\` أو \`يوم 1/9/2026\`.`,
          provider: "internal",
          readOnly: true,
          tool: chosen.tool.id,
          answered: false,
          error: code,
          sources: [],
          role: actor.role,
          externalDataShared: false
        });
      }
      throw error;
    }
    let result: ToolResult;
    try {
      result = await chosen.tool.run({ question, entityText: chosen.entityText, role, period });
    } catch (error) {
      const code = String((error as { message?: unknown } | undefined)?.message ?? "read_failed");
      auditLog({ actorId: actor.id, role: actor.role, toolId: chosen.tool.id, outcome: "error", code });
      // فشل مصدر = اعتراف صريح. لا يُستبدل برقم من مصدر آخر ولا بتقدير.
      return json(request, 200, {
        reply: `تعذّرت قراءة مصدر البيانات الخاص بـ**${chosen.tool.title}** (${code}).\n\n`
          + `لن أعطيك رقماً من مصدر آخر مكانه، لأن ذلك سيكون رقماً خاطئاً. أعد المحاولة، وإن تكرر الفشل فالمشكلة في مزامنة هذا التقرير.`,
        provider: "internal",
        readOnly: true,
        tool: chosen.tool.id,
        answered: false,
        error: code,
        sources: [],
        role: actor.role,
        externalDataShared: false
      });
    }

    auditLog({ actorId: actor.id, role: actor.role, toolId: chosen.tool.id, outcome: "ok" });

    return json(request, 200, {
      reply: result.text,
      provider: "internal",
      readOnly: true,
      tool: chosen.tool.id,
      answered: result.ok,
      partial: result.partial === true,
      sources: result.sources,
      asOf: result.asOf ?? null,
      role: actor.role,
      externalDataShared: false,
      contextGeneratedAt: new Date().toISOString()
    });
  } catch (error) {
    const code = String((error as { message?: unknown } | undefined)?.message ?? "internal_error");
    return json(request, 500, { error: code });
  }
});
