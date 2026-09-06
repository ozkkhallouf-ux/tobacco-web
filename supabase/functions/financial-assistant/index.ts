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

// أحدث صف من جدول تقارير بمفتاح summary/items
async function latestReport(table: string, source?: string) {
  const filter = source ? `&source=eq.${encodeURIComponent(source)}` : "";
  const rows = await readRest(
    `${table}?select=report_date,summary,items,created_at&order=created_at.desc&limit=1${filter}`
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

// ── أدوات نصية عربية ─────────────────────────────────────────────────────────
function normalize(value: unknown) {
  return String(value ?? "")
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
  if (matches.length < 2 || matches[0].exact) return false;
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

// ── التواريخ ─────────────────────────────────────────────────────────────────
function damascusDate(offsetDays = 0) {
  const now = new Date(Date.now() + DAMASCUS_OFFSET_MINUTES * 60_000 + offsetDays * 86_400_000);
  return now.toISOString().slice(0, 10);
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
  const q = normalize(question);
  const today = damascusDate();
  if (/(?:^| )امس(?: |$)|البارحه|مبارح/.test(q)) {
    const day = damascusDate(-1);
    return { from: day, to: day, label: "أمس", explicit: true };
  }
  // «هذا الشهر» تُفحص أولاً عمداً: سؤال «مبيعات هذا الشهر مقارنة بالشهر الماضي»
  // يحوي العبارتين معاً، والفترة المقصودة فيه هي الشهر الحالي — والشهر الماضي
  // يأتي من previousPeriod في فرع المقارنة، لا من هنا.
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
  if (/الاسبوع|اسبوع|٧ ايام|7 ايام|اخر سبعه/.test(q)) {
    return { from: damascusDate(-6), to: today, label: "آخر 7 أيام", explicit: true };
  }
  const explicitDays = q.match(/اخر (\d{1,3}) يوم/);
  if (explicitDays) {
    const days = Math.min(365, Math.max(1, Number(explicitDays[1])));
    return { from: damascusDate(-(days - 1)), to: today, label: `آخر ${days} يوم`, explicit: true };
  }
  if (/(?:^| )اليوم(?: |$)|النهارده|هلق|الان/.test(q) || fallbackDays === 0) {
    return { from: today, to: today, label: "اليوم", explicit: /(?:^| )اليوم(?: |$)|النهارده|هلق|الان/.test(q) };
  }
  return { from: damascusDate(-(fallbackDays - 1)), to: today, label: `آخر ${fallbackDays} يوم`, explicit: false };
}

function damascusDateFrom(iso: string, offsetDays: number) {
  const base = new Date(`${iso}T00:00:00Z`).getTime() + offsetDays * 86_400_000;
  return new Date(base).toISOString().slice(0, 10);
}

// الفترة السابقة المكافئة — لأسئلة المقارنة
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

// ── قراءة سطور المبيعات ──────────────────────────────────────────────────────
type SalesRow = {
  sale_date?: string;
  bill_no?: string;
  bill_type?: string;
  item_name?: string;
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
type SyncWindow = { start: string; end: string; completedAt: string; rowCount: number } | null;

async function syncWindow(table: string, source: string): Promise<SyncWindow> {
  const rows = await readRest(
    `${table}?select=window_start,window_end,row_count,completed_at`
    + `&source=eq.${encodeURIComponent(source)}&order=completed_at.desc&limit=1`
  );
  const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
  if (!row?.window_start || !row?.window_end) return null;
  return {
    start: String(row.window_start),
    end: String(row.window_end),
    completedAt: String(row.completed_at ?? ""),
    rowCount: num(row.row_count)
  };
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

// تحذير التغطية: يُعيد نصاً حين لا تقع الفترة المطلوبة كاملةً داخل النافذة.
function coverageWarning(period: Period, window: SyncWindow, subject: CoverageSubject) {
  if (!window) {
    return `\n\n> ⚠️ لا يوجد سجل مزامنة مكتمل لـ${subject.what} (\`${subject.table}\` فارغ).`
      + ` لا أستطيع تأكيد أن أرقام هذه الفترة محدَّثة، فاعتبرها **غير متحقَّقة**.`;
  }
  const outsideBefore = period.from < window.start;
  const outsideAfter = period.to > window.end;
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

async function readSales(period: Period, role: Role): Promise<{ rows: SalesRow[]; partial: boolean }> {
  // عمود التكلفة للمالك فقط. الموظف لا يرى تكلفة ولا هامشاً.
  const columns = role === "owner"
    ? "sale_date,bill_no,bill_type,item_name,qty,line_total,unit_cost,customer_name"
    : "sale_date,bill_no,bill_type,item_name,qty,line_total,customer_name";
  // ترتيب ثابت وقاطع (id ثانوياً) شرطٌ لصحة التصفيح: بلا مفتاح فارق قد يتكرر
  // صفٌّ أو يسقط آخر بين الصفحات.
  const { rows, partial } = await readPaged((range) =>
    `sales_line_items?select=${columns}`
    + `&sale_date=gte.${safeDate(period.from)}&sale_date=lte.${safeDate(period.to)}`
    + `&order=sale_date.desc,id.asc${range}`
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
  entity?: "customer" | "item" | "account";
  patterns: Array<{ re: RegExp; w: number }>;
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
    patterns: [
      { re: /مصروف|مصاريف|صرفنا|دفعنا|منصرف|نفقات/, w: 6 },
      { re: /كم دفع/, w: 4 }
    ],
    async run(ctx) {
      // مُصفَّح: الحدّ الثابت 200 كان يعيد أحدث 200 حركة فقط ثم يعرض مجموعها
      // على أنه إجمالي الفترة كلها — فسؤال «آخر 365 يوم» كان يبخس المصاريف
      // بصمت. (رصدها Codex على PR #205.)
      const { rows: list, partial } = await readPaged((range) =>
        `expense_entries?select=id,entry_date,account_name,amount,notes`
        + `&entry_date=gte.${safeDate(ctx.period.from)}&entry_date=lte.${safeDate(ctx.period.to)}`
        + `&order=entry_date.desc,id.asc${range}`
      );
      if (!list.length) {
        // فرّق بين «لا مصاريف بهذه الفترة» و«لا بيانات مصاريف إطلاقاً»
        const any = await readRest("expense_entries?select=entry_date&order=entry_date.desc&limit=1");
        if (!Array.isArray(any) || !any.length) return noData("المصاريف", ["expense_entries"]);
        // «لا حركة مصروف» نفيٌ قاطع، والغياب خارج نافذة التحديث قد يكون غياب
        // مزامنة لا غياب صرف — كما في المبيعات بالضبط.
        return {
          ok: true,
          text: `**مصاريف ${ctx.period.label} (${ctx.period.from} → ${ctx.period.to})**\nلا توجد أي حركة مصروف مسجّلة في هذه الفترة. آخر مصروف مسجّل بتاريخ ${String(any[0].entry_date)}.`
            + coverageWarning(ctx.period, await expenseSyncWindow(), EXPENSE_COVERAGE),
          sources: ["expense_entries", "expense_entries_sync_state"]
        };
      }
      const total = list.reduce((sum, row) => sum + num(row.amount), 0);
      const lines = list
        .slice(0, 20)
        .map((row) => `- ${String(row.entry_date)} — ${String(row.account_name ?? "بند")}: **${money(row.amount)}**`);
      return {
        ok: true,
        text: `**مصاريف ${ctx.period.label} (${ctx.period.from} → ${ctx.period.to})** — `
          + (partial ? `مجموع جزئي **${money(total)}**` : `إجمالي **${money(total)}**`)
          + ` على ${list.length} حركة\n${lines.join("\n")}`
          + (list.length > 20 ? `\n\n_معروض 20 من ${list.length}._` : "")
          + (partial
            ? `\n\n> ⚠️ بلغت القراءة سقف الأمان ${HARD_ROW_CAP} حركة، فالمجموع أعلاه **جزئي وليس إجمالي الفترة**. ضيّق الفترة.`
            : "")
          + coverageWarning(ctx.period, await expenseSyncWindow(), EXPENSE_COVERAGE),
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
      const now = summarizeSales(current.rows);

      if (!current.rows.length) {
        const any = await readRest("sales_line_items?select=sale_date&order=sale_date.desc&limit=1");
        if (!Array.isArray(any) || !any.length) return noData("المبيعات", ["sales_line_items"]);
        // «لا توجد فاتورة» نفيٌ قاطع، وهو أخطر من رقم ناقص متى كانت الفترة خارج
        // نافذة المزامنة: الغياب هناك قد يكون غياب مزامنة لا غياب بيع. فالتحذير
        // يلزم هذا الفرع كما يلزم فرع الأرقام.
        return {
          ok: true,
          text: `**مبيعات ${period.label} (${period.from} → ${period.to})**\nلا توجد أي فاتورة مسجّلة في هذه الفترة. آخر يوم فيه مبيعات مسجّلة هو **${String(any[0].sale_date)}**.`
            + `\n\nملاحظة: سطور المبيعات تصل عبر مزامنة الأمين، فإن كان اليوم ما زال في بدايته قد لا تكون فواتيره رُفعت بعد.`
            + coverageWarning(period, await salesSyncWindow(), SALES_COVERAGE),
          sources: ["sales_line_items", "sales_line_items_sync_state"]
        };
      }

      let text = `**مبيعات ${period.label} (${period.from} → ${period.to})**\n`
        + `- الإجمالي: **${money(now.total)}**\n`
        + `- عدد الفواتير: **${now.bills}** على ${now.lines} سطر\n`
        + `- جملة: ${money(now.wholesale)} / مفرق: ${money(now.retail)}`;
      if (ctx.role === "owner" && now.costKnown) {
        const pct = now.marginRevenue ? (now.margin / now.marginRevenue) * 100 : 0;
        text += `\n- هامش المنتج المحسوب (بيع ناقص تكلفة) على ${now.costKnown} سطر متوفرة تكلفتها: **${money(now.margin)}** (${pct.toFixed(1)}%)`
          + (now.costMissing ? `\n  - ${now.costMissing} سطر بلا تكلفة معروفة، غير داخل في الهامش أعلاه.` : "")
          + `\n  - هذا هامش منتج تقديري قبل المصاريف والمرتجعات والحسومات. الرقم المحاسبي المعتمد للربح هو تقرير الأمين — اسأل: \`ما الأرباح؟\``;
      }

      if (compare) {
        const prev = previousPeriod(period);
        const before = summarizeSales((await readSales(prev, ctx.role)).rows);
        const delta = now.total - before.total;
        const pct = before.total ? (delta / before.total) * 100 : null;
        text += `\n\n**مقارنة بـ${prev.label} (${prev.from} → ${prev.to})**\n`
          + `- الفترة السابقة: **${money(before.total)}** على ${before.bills} فاتورة\n`
          + `- الفرق: **${delta >= 0 ? "+" : ""}${money(delta)}**`
          + (pct === null
            ? " (لا نسبة — الفترة السابقة صفر)"
            : ` (${delta >= 0 ? "+" : ""}${pct.toFixed(1)}%)`);
      }

      if (current.partial) {
        text += `\n\n> ⚠️ بلغت القراءة سقف الأمان ${HARD_ROW_CAP} سطر، فالإجمالي أعلاه **جزئي وليس نهائياً**. ضيّق الفترة للحصول على رقم كامل.`;
      }
      const window = await salesSyncWindow();
      text += coverageWarning(period, window, SALES_COVERAGE);
      if (compare) text += coverageWarning(previousPeriod(period), window, SALES_COVERAGE);
      return {
        ok: true,
        text,
        sources: ["sales_line_items", "sales_line_items_sync_state"],
        partial: current.partial
      };
    }
  },

  // ── الأرباح ───────────────────────────────────────────────────────────────
  {
    id: "profit",
    title: "الأرباح",
    minRole: "owner",
    patterns: [{ re: /ربح|ارباح|خساره|هامش|مردود/, w: 6 }],
    async run() {
      const report = await latestReport("inventory_reports", "ameen_daily_profit");
      if (!report?.summary) return noData("الأرباح", ["inventory_reports:ameen_daily_profit"]);
      const s = report.summary as Record<string, unknown>;
      const currency = String(s.currency ?? "USD");
      const text = `**تقرير الربح — ${report.report_date}**\n`
        + `- المبيعات الإجمالية: **${money(s.sales_gross, currency)}**\n`
        + `- الحسومات: ${money(s.discounts, currency)} / المرتجعات: ${money(s.returns, currency)}\n`
        + `- صافي المبيعات: **${money(s.net_sales, currency)}**\n`
        + `- تكلفة البضاعة المباعة: ${money(s.sales_cost, currency)}\n`
        + `- مجمل الربح: **${money(s.gross_profit, currency)}**\n`
        + `- المصاريف: ${money(s.expenses, currency)}\n`
        + `- **صافي الربح: ${money(s.net_profit, currency)}**\n`
        + `- عدد الفواتير: ${num(s.sales_bill_count)} — عدد السطور: ${num(s.line_count)}`
        + (num(s.missing_cost_lines) > 0
          ? `\n\n> ⚠️ ${num(s.missing_cost_lines)} سطر بلا تكلفة معروفة، فالربح أعلاه ناقص بمقدار تكلفتها.`
          : "")
        + (s.complete === false ? `\n\n> ⚠️ التقرير غير مكتمل حسب مصدره.` : "");
      return { ok: true, text: text + freshnessNote(report.created_at), sources: ["inventory_reports:ameen_daily_profit"], asOf: report.created_at };
    }
  },

  // ── الذمم ─────────────────────────────────────────────────────────────────
  {
    id: "receivables",
    title: "ذمم الزبائن",
    minRole: "owner",
    patterns: [
      { re: /ذمم|ديون|دين|مديونيه|مدين|علينا|علي?هم|مستحقات/, w: 6 },
      { re: /اكبر الزبائن|اكتر زبون/, w: 4 }
    ],
    async run() {
      const report = await latestReport("inventory_reports", "ameen_customer_balances");
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
      // «ما رصيد جهاد التلي؟» بلا كلمة «زبون». وزن منخفض عمداً كي تفوز أداة
      // دليل الحسابات على «رصيد حساب ...» التي تحمل وزن 7 على كلمة «حساب».
      { re: /رصيد /, w: 4 }
    ],
    async run(ctx) {
      if (!ctx.entityText.trim()) {
        return {
          ok: false,
          text: "حدّد اسم الزبون في السؤال، مثلاً: `ما رصيد الزبون مركز الخيال؟` أو `ماذا اشترى جهاد التلي؟`.",
          sources: []
        };
      }
      const balances = await latestReport("inventory_reports", "ameen_customer_balances");
      const rows = Array.isArray(balances?.items) ? balances.items : [];
      if (!rows.length) return noData("أرصدة الزبائن", ["inventory_reports:ameen_customer_balances"]);

      const matches = matchByName(
        rows as Array<Record<string, unknown>>,
        (row) => String(row.name ?? row.key ?? ""),
        ctx.entityText
      );
      if (!matches.length) {
        return {
          ok: false,
          text: `لم أجد زبوناً باسم «${ctx.entityText.trim()}» في تقرير الأرصدة (${rows.length} حساب بتاريخ ${balances.report_date}). تأكد من الاسم كما هو مسجّل في الأمين.`,
          sources: ["inventory_reports:ameen_customer_balances"]
        };
      }
      if (isAmbiguous(matches)) {
        return {
          ok: false,
          text: `الاسم «${ctx.entityText.trim()}» يطابق أكثر من حساب:\n`
            + matches.map((m) => `- ${String(m.row.name ?? m.row.key)}`).join("\n")
            + `\n\nاكتب الاسم بشكل أدق لأختار الحساب الصحيح — لن أخمّن بينها.`,
          sources: ["inventory_reports:ameen_customer_balances"]
        };
      }

      const customer = matches[0].row;
      const name = String(customer.name ?? customer.key ?? "");
      const guid = String(customer.customerGuid ?? "");
      const wantsPurchases = /اشتر|اخد|فواتير|بضاعه|مواد/.test(normalize(ctx.question));

      let text = `**${name}**\n`
        + `- الرصيد الحالي: **${money(customer.balance)}** ${num(customer.balance) > 0 ? "(مدين — عليه)" : num(customer.balance) < 0 ? "(دائن — له)" : "(مسدّد)"}\n`
        + `- تاريخ التقرير: ${balances.report_date}`;
      const payments = Array.isArray(customer.recentPayments) ? customer.recentPayments : [];
      if (payments.length) {
        text += `\n\n**آخر الدفعات**\n`
          + payments
            .slice(0, 6)
            .map((p: Record<string, unknown>) =>
              `- ${String(p.date ?? "").slice(0, 10)}: **${money(p.amount)}**${p.notes ? ` — ${String(p.notes)}` : ""}`)
            .join("\n");
      } else {
        text += `\n\n_لا دفعات مسجّلة لهذا الحساب في نافذة التقرير._`;
      }

      const sources = ["inventory_reports:ameen_customer_balances"];
      if (wantsPurchases) {
        // الفواتير مصدر منفصل — فشله لا يلغي الرصيد أعلاه ولا يُستبدل بتقدير.
        try {
          const invoiceReport = await latestReport("inventory_reports", "ameen_customer_invoices");
          const invRows = Array.isArray(invoiceReport?.items) ? invoiceReport.items : [];
          sources.push("inventory_reports:ameen_customer_invoices");
          const window = `${(invoiceReport?.summary as Record<string, unknown>)?.fromDate ?? "?"} → ${invoiceReport?.report_date ?? "?"}`;

          // هوية الزبون بالـGUID أولاً وأخيراً متى توفّر.
          //
          // كان هنا ارتداد إلى مطابقة الاسم عند فشل مطابقة الـGUID، وهو خطأ
          // خطير: إن كان تقرير الفواتير قديماً أو ناقص الربط، فأقرب اسم مشابه
          // يفوز فتُعرض **فواتير زبون آخر** — بأصنافه وكمياته وأسعاره — تحت اسم
          // الزبون المطلوب. وهذا ينقض قاعدة موثّقة في CLAUDE.md: الربط
          // بـcustomerGuid أولاً، والمجموعة اليتيمة لا تُنسب لأحد بالتخمين بل
          // يُكتفى بتحذير صريح.
          //
          // فحين يحمل حساب الزبون GUID موثوقاً: إمّا مطابقة GUID أو لا فواتير.
          // ومطابقة الاسم لا تُستعمل إلا للسجلات القديمة التي بلا GUID أصلاً،
          // وحتى حينها بحارس الالتباس لا بأخذ أقرب مرشح.
          let entry: Record<string, unknown> | undefined;
          let identity: "guid" | "name" | "none" = "none";
          if (guid) {
            entry = invRows.find((row: Record<string, unknown>) => String(row.customerGuid ?? "") === guid);
            if (entry) identity = "guid";
          } else {
            const named = matchByName(invRows as Array<Record<string, unknown>>, (row) => String(row.name ?? ""), name, 5);
            if (named.length && !isAmbiguous(named)) {
              entry = named[0].row;
              identity = "name";
            }
          }

          const invoices = Array.isArray(entry?.invoices) ? entry.invoices : [];
          if (guid && !entry) {
            text += `\n\n**المشتريات**\nلم أجد في تقرير الفواتير (${window}) أي سجل مربوط بمعرّف هذا الزبون.`
              + `\n\nلن أنسب له فواتير بتشابه الاسم — لو فعلت لعرضتُ عليك مشتريات زبون آخر بأصنافه وأسعاره.`
              + ` إن كنت تتوقع وجود فواتير، فالأرجح أن تقرير الفواتير لم يُزامَن بعد أو أن سجلّه بلا معرّف.`;
          } else if (!invoices.length) {
            text += `\n\n**المشتريات**\nلا توجد فواتير لهذا الزبون ضمن نافذة تقرير الفواتير (${window}).`;
          } else {
            if (identity === "name") {
              text += `\n\n> ℹ️ سجل الفواتير أدناه مطابَق بالاسم لأن حساب الزبون بلا معرّف في تقرير الأرصدة.`;
            }
            const shown = invoices.slice(0, 3);
            text += `\n\n**آخر الفواتير** (${invoices.length} فاتورة في نافذة التقرير)`;
            for (const inv of shown) {
              const lines = Array.isArray(inv.lines) ? inv.lines : [];
              const total = lines.reduce((sum: number, l: Record<string, unknown>) => sum + num(l.lineTotal), 0);
              text += `\n\n**فاتورة ${String(inv.date ?? "")}** — إجمالي ${money(total)}\n`
                + lines
                  .slice(0, 10)
                  .map((l: Record<string, unknown>) =>
                    `- ${String(l.material ?? "")}: ${qty(l.qty)} ${String(l.unit1 ?? "")} × ${money(l.price)} = ${money(l.lineTotal)}`)
                  .join("\n")
                + (lines.length > 10 ? `\n- _و${lines.length - 10} سطر آخر._` : "");
            }
          }
        } catch {
          text += `\n\n> ⚠️ تعذّرت قراءة تقرير الفواتير، فلم أعرض المشتريات. الرصيد أعلاه من تقرير الأرصدة وهو صحيح — ولم أستبدل الفواتير بأي تقدير.`;
        }
      }
      return { ok: true, text: text + freshnessNote(balances.created_at), sources, asOf: balances.created_at };
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
      const sold = new Set(sales.rows.map((row) => normalize(row.item_name)));
      const stagnant = items
        .filter((row: Record<string, unknown>) => num(row.stockQty) > 0 && !sold.has(normalize(row.name ?? row.key)))
        .sort((a: Record<string, unknown>, b: Record<string, unknown>) => num(b.stockQty) - num(a.stockQty));
      if (!stagnant.length) {
        return {
          ok: true,
          text: `**الأصناف الراكدة (${period.label})**\nكل مادة عليها مخزون سُجّلت لها مبيعات خلال ${period.label}. لا يوجد صنف راكد بهذا التعريف.`,
          sources: ["inventory_reports:ameen_sql_agent", "sales_line_items"]
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
          + coverageWarning(period, await salesSyncWindow(), SALES_COVERAGE),
        sources: ["inventory_reports:ameen_sql_agent", "sales_line_items", "sales_line_items_sync_state"],
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
      const period = { from: damascusDate(-29), to: damascusDate(), label: "آخر 30 يوم", explicit: true };
      const sales = await readSales(period, ctx.role);
      if (!sales.rows.length) {
        return {
          ok: false,
          text: `عندي حالة المخزون بتاريخ ${report.report_date}، لكن لا توجد سطور مبيعات في ${period.label} لأحسب منها معدّل الاستهلاك. بدون معدّل بيع حقيقي لا أستطيع ترتيب أولوية الشراء، ولن أرتّبها بالتخمين.`,
          sources: ["inventory_reports:ameen_sql_agent", "sales_line_items"]
        };
      }
      const days = 30;
      const soldQty = new Map<string, number>();
      for (const row of sales.rows) {
        const key = normalize(row.item_name);
        if (key) soldQty.set(key, (soldQty.get(key) ?? 0) + num(row.qty));
      }
      const ranked = items
        .map((row: Record<string, unknown>) => {
          const perDay = (soldQty.get(normalize(row.name ?? row.key)) ?? 0) / days;
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
        .filter((entry) => entry.perDay > 0 && entry.coverDays < 21)
        .sort((a, b) => a.coverDays - b.coverDays || b.perDay - a.perDay);

      if (!ranked.length) {
        return {
          ok: true,
          text: `**توصية الشراء**\nلا يوجد صنف يبيع فعلياً ومخزونه يكفي أقل من 21 يوماً حسب معدّل ${period.label}. لا حاجة شراء عاجلة بهذا المعيار.`,
          sources: ["inventory_reports:ameen_sql_agent", "sales_line_items"]
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
          + coverageWarning(period, await salesSyncWindow(), SALES_COVERAGE),
        sources: ["inventory_reports:ameen_sql_agent", "sales_line_items", "sales_line_items_sync_state"],
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

      // الحركة من سطور المبيعات الحقيقية
      const period = { from: damascusDate(-59), to: damascusDate(), label: "آخر 60 يوم", explicit: true };
      const sales = await readSales(period, ctx.role);
      const mine = sales.rows.filter((row) => normalize(row.item_name) === normalize(name));
      if (!mine.length) {
        text += `\n\n**الحركة (${period.label})**\nلا توجد أي مبيعات مسجّلة لهذا الصنف في ${period.label}.`;
      } else {
        const totalQty = mine.reduce((sum, row) => sum + num(row.qty), 0);
        const totalValue = mine.reduce((sum, row) => sum + num(row.line_total), 0);
        const buyers = new Map<string, number>();
        for (const row of mine) {
          const buyer = String(row.customer_name ?? "").trim() || "بدون اسم";
          buyers.set(buyer, (buyers.get(buyer) ?? 0) + num(row.qty));
        }
        const top = [...buyers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
        text += `\n\n**الحركة (${period.label})**\n`
          + `- الكمية المباعة: **${qty(totalQty)}** على ${mine.length} سطر\n`
          + `- قيمة المبيعات: **${money(totalValue)}**\n`
          + `- متوسط ${(totalQty / 60).toFixed(1)} بالوحدة يومياً\n`
          + `- أكثر المشترين: ${top.map(([b, q]) => `${b} (${qty(q)})`).join("، ")}`;
        if (ctx.role === "owner") {
          const withCost = mine.filter((row) => num(row.unit_cost) > 0);
          if (withCost.length) {
            const margin = withCost.reduce((sum, row) => sum + num(row.line_total) - num(row.unit_cost) * num(row.qty), 0);
            text += `\n- هامش المنتج على ${withCost.length} سطر متوفرة تكلفتها: **${money(margin)}** (بيع ناقص تكلفة، قبل المصاريف)`;
          }
        }
      }
      text += coverageWarning(period, await salesSyncWindow(), SALES_COVERAGE);
      return { ok: true, text, sources: ["approved_price_items", "sales_line_items", "sales_line_items_sync_state"] };
    }
  },

  // ── المشتريات ─────────────────────────────────────────────────────────────
  {
    id: "purchases",
    title: "المشتريات والموردون",
    minRole: "owner",
    patterns: [
      { re: /مشتريات|مورد|موردين|فواتير الشراء|اشترينا/, w: 7 }
    ],
    async run(ctx) {
      const report = await latestReport("ameen_purchase_invoice_reports");
      const items = Array.isArray(report?.items) ? report.items : [];
      if (!items.length) return noData("فواتير المشتريات", ["ameen_purchase_invoice_reports"]);
      const s = (report.summary ?? {}) as Record<string, unknown>;

      // ⚠️ قيمة السطر في هذا التقرير غير موثوقة (تحقّق على الإنتاج 2026-09-06).
      // مثال فعلي: qty=3750 وunit="كرتونة" وprice=1225 وavgPrice=24.387، و
      // lineTotal=4,593,750 = qty×price. لكن price سعر الكرتونة بينما avgPrice
      // سعر الكروز (النسبة ≈ 50 = معامل الوحدة)، فإن كانت qty بالكروز فالسطر
      // مضخَّم نحو 50 ضعفاً. المجموع بهذه القراءة 76.3 مليون دولار على شهرين،
      // مقابل مبيعات 1.15 مليون في المدة نفسها — رقم مستحيل.
      // لذلك: لا يُعرض إجمالي قيمة، ويُعلَن التعارض بدل تمرير رقم يبدو دقيقاً.
      // الأعداد (الفواتير والموردون) سليمة ولا علاقة لها بالخلل، فتُعرض.
      let lines = 0;
      let conflicting = 0;
      const bySupplier = items
        .map((row: Record<string, unknown>) => {
          const invoices = Array.isArray(row.invoices) ? row.invoices : [];
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
          return { name: String(row.name ?? ""), count: invoices.length, lineCount, last: dates[dates.length - 1] ?? "" };
        })
        .sort((a, b) => b.count - a.count);

      const unreliable = lines > 0 && conflicting / lines > 0.2;

      let text = `**المشتريات — نافذة ${String(s.fromDate ?? "?")} → ${report.report_date}**\n`
        + `- عدد الفواتير: **${num(s.bills)}** من **${num(s.suppliers)}** مورّد، بمجموع ${lines} سطر\n\n`
        + `**الموردون حسب عدد الفواتير**\n`
        + bySupplier
          .slice(0, 12)
          .map((row, index) =>
            `${index + 1}. ${row.name}: **${row.count}** فاتورة (${row.lineCount} سطر)`
            + (row.last ? ` — آخرها ${row.last}` : ""))
          .join("\n");

      if (unreliable) {
        text += `\n\n> ⚠️ **لم أعرض إجمالي قيمة المشتريات عمداً.**\n`
          + `> في ${conflicting} من ${lines} سطر، قيمة السطر المخزَّنة (\`lineTotal\`) لا توافق الكمية × متوسط سعر الوحدة:\n`
          + `> \`price\` مسجَّل لوحدة والكمية \`qty\` لوحدة أخرى، فالضرب بينهما يضخّم القيمة بمقدار معامل الوحدة تقريباً.\n`
          + `> أي إجمالي أعرضه سيكون خاطئاً بمضاعفات، فلن أعطيك رقماً. الخلل في خط مزامنة فواتير الشراء\n`
          + `> (\`tools/pull-purchase-invoices-from-ameen.ps1\`) لا في المساعد، ويحتاج إصلاحاً هناك.`;
      }

      if (ctx.entityText.trim()) {
        const hit = matchByName(items as Array<Record<string, unknown>>, (row) => String(row.name ?? ""), ctx.entityText, 1)[0];
        if (hit) {
          const invoices = Array.isArray(hit.row.invoices) ? hit.row.invoices : [];
          text += `\n\n**تفصيل ${String(hit.row.name)}**\n`
            + invoices
              .slice(0, 8)
              .map((invoice: Record<string, unknown>) => {
                const rows = Array.isArray(invoice.items) ? invoice.items : [];
                return `- ${String(invoice.date ?? "")}: ${rows.length} صنف`
                  + (rows.length ? ` (${rows.slice(0, 3).map((line: Record<string, unknown>) => String(line.itemName ?? "")).join("، ")}${rows.length > 3 ? "…" : ""})` : "");
              })
              .join("\n");
        } else {
          text += `\n\n_لم أجد مورّداً باسم «${ctx.entityText.trim()}» في هذا التقرير._`;
        }
      }
      return { ok: true, text: text + freshnessNote(report.created_at), sources: ["ameen_purchase_invoice_reports"], asOf: report.created_at };
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
    async run() {
      const report = await latestReport("ameen_warehouse_transfer_reports");
      const items = Array.isArray(report?.items) ? report.items : [];
      if (!report || !items.length) {
        return {
          ok: false,
          text: "لا يوجد أي تقرير مناقلات مستودعات محفوظ في النظام حتى الآن. الجدول `ameen_warehouse_transfer_reports` جاهز لكنه فارغ — لم يرفع سكربت المزامنة أي مناقلة بعد. لا أستطيع الإجابة عن المناقلات قبل وصول أول تقرير.",
          sources: ["ameen_warehouse_transfer_reports"]
        };
      }
      return {
        ok: true,
        text: `**مناقلات المستودعات — ${report.report_date}** (${items.length} مناقلة)\n`
          + items
            .slice(0, 15)
            .map((row: Record<string, unknown>) =>
              `- ${String(row.date ?? "")}: ${String(row.fromWarehouseName ?? "?")} → ${String(row.toWarehouseName ?? "?")}`
              + ` (${Array.isArray(row.items) ? row.items.length : 0} صنف)`)
            .join("\n")
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
      const report = await latestReport("ameen_account_balance_reports");
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
        const rows = await readRest("daily_movement_reports?select=report_date,payload,created_at&order=created_at.desc&limit=1");
        sources.push("daily_movement_reports");
        const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
        if (!row?.payload) return "**السيولة**: لا يوجد تقرير حركة صناديق.";
        const totals = Array.isArray(row.payload.cashTotals) ? row.payload.cashTotals : [];
        const paid = row.payload.paymentSummary ?? {};
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
          + (today.partial ? ` ⚠️ قراءة جزئية عند سقف ${HARD_ROW_CAP} سطر — الرقم ليس نهائياً.` : "")
          + coverageWarning(period, await salesSyncWindow(), SALES_COVERAGE);
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
    if (!best || score > best.score) best = { tool, score, entityText: tool.entity ? extractEntity(question) : "" };
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
          + `اسألني مثلاً: \`كم يوجد بالصندوق؟\` أو \`ما رصيد الزبون مركز الخيال؟\` أو \`ما الأصناف الناقصة؟\``,
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

    const period = parsePeriod(question);
    let result: ToolResult;
    try {
      result = await chosen.tool.run({ question, entityText: chosen.entityText, role, period });
    } catch (error) {
      const code = String((error as { message?: unknown } | undefined)?.message ?? "read_failed");
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
