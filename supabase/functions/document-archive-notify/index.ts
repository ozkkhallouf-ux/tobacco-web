import "jsr:@supabase/functions-js/edge-runtime.d.ts";
// ============================================================================
// document-archive-notify — جسر عامل الأرشفة (OZK2026) إلى تيليغرام وSupabase.
//
// لماذا دالة Edge لا إرسال مباشر من الجهاز: توكن البوت يبقى في Supabase وحده
// (أسرار الدالة أو app_secrets كما في telegram-webhook)، والعامل يحمل سرّاً ضيقاً
// خاصاً بهذه الدالة فقط (DOCUMENT_ARCHIVE_SECRET). ولأن pg_net لا يرسل multipart،
// فـtelegram_outbox لا يستطيع إرسال ملف PDF.
//
// المسارات (POST فقط، بالرأس x-ozk-archive-secret):
//   /notify  multipart: حقول المستند + file (PDF). يرسل المستند إلى محادثة المالك
//            وحدها (bot_config.owner_chat_id) مرة واحدة على الأكثر (Migration 26):
//            حجز ذرّي لـjob_id قبل sendDocument، ثم تسجيل النتيجة. حجز قائم ⇒ 409
//            in_progress؛ نتيجة مجهولة (ضاع ردّ تيليغرام) ⇒ 409 delivery_unknown بلا إعادة
//            تلقائية أبداً؛ مُرسَل ⇒ message_id نفسه بلا إرسال ثانٍ.
//   /notify-batch  JSON: مصفوفة مستندات بلا ملفات (فواتير جملة معدَّلة كثيرة معاً، مثل
//            تسوية دفعات دفعة واحدة) ترسل برسالة ملخص (العدد وأرقام المستندات)، أو أكثر من
//            رسالة متتالية إذا تجاوز العدد حدّ تيليغرام (نادر). كل رسالة تُنهي حجز مستنداتها
//            هي وحدها: فشل رسالة واحدة لا يمسّ مستندات رسالة أخرى نجحت في الدفعة نفسها، ولا
//            يُعاد إرسالها معها لاحقاً. الحجز الذري لكل job_id نفسه (Migration 26)، فحجز
//            مُرسَل سابقاً أو قائم من محاولة متزامنة (حتى من عامل آخر يعمل بالتوازي) لا يُرسَل
//            له ثانية ضمن الدفعة.
//   /report  JSON: نبض العامل + ملخص المهام؛ يعيد طلبات إعادة المحاولة من المالك،
//            ويحرّر حجوزاتها المجهولة (المالك تحقق بنفسه أن المستند لم يصل).
//
// لا chat_id من الطلب إطلاقاً، ولا parse_mode، ولا روابط مشاركة عامة.
// النسخة غير منشورة؛ النشر بموافقة المالك من الـMac (verify_jwt=false في config.toml).
// ============================================================================
import "../_shared/telegram-format.js";
import {
  MAX_PDF_BYTES,
  buildBatchSummaries,
  buildNotifyCaption,
  isPdfBytes,
  itemFromNotify,
  timingSafeEqualText,
  validateNotifyFields,
} from "../_shared/document-archive.js";

const SUPA_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ARCHIVE_SECRET = Deno.env.get("DOCUMENT_ARCHIVE_SECRET") ?? "";
const PROFILE = "public";
const RECORD_RETRY_MS = 400;
// مهلة طلب تيليغرام: بعدها النتيجة مجهولة (قد يكون وصل). أقل من مهلة العامل (120ث)
// ومن حدّ الحجز (300ث) كي لا يصير الحجز مجهولاً والطلب ما زال يرسل.
const TELEGRAM_TIMEOUT_MS = 60000;
const CLAIM_LEASE_SECONDS = 300;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function restHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Accept-Profile": PROFILE, "Content-Profile": PROFILE, ...extra };
}

async function restGet(path: string): Promise<unknown> {
  const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, { headers: restHeaders() });
  if (!res.ok) throw new Error(`rest_get_${res.status}`);
  return res.json();
}

async function rpc(name: string, args: unknown): Promise<unknown> {
  const res = await fetch(`${SUPA_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: restHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`rpc_${name}_${res.status}`);
  return res.json();
}

let cachedToken: string | null = null;
async function botToken(): Promise<string> {
  if (cachedToken) return cachedToken;
  const env = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (env) return (cachedToken = env);
  const rows = await restGet("app_secrets?select=name,value&name=eq.telegram_bot_token") as Array<{ value: string }>;
  const tok = Array.isArray(rows) && rows[0] ? String(rows[0].value || "") : "";
  if (!tok) throw new Error("bot_token_missing");
  return (cachedToken = tok);
}

async function ownerChatId(): Promise<string> {
  const rows = await restGet("bot_config?key=eq.owner_chat_id&select=value") as Array<{ value: string }>;
  const id = Array.isArray(rows) && rows[0] ? String(rows[0].value || "").trim() : "";
  if (!/^-?\d{3,20}$/.test(id)) throw new Error("owner_chat_missing");
  return id;
}

type SendOutcome =
  | { outcome: "sent"; messageId: number }
  | { outcome: "not_sent" | "unknown"; error: string };

// نتيجة الإرسال بثلاث حالات. not_sent فقط حين يقول تيليغرام صراحةً ok=false (لم يُرسَل).
// انقطاع أو مهلة أو جسم غير مقروء أو ok بلا message_id ⇒ unknown: قد يكون وصل.
// لا نعيد نص خطأ تيليغرام (قد يتضمن تفاصيل الطلب)؛ الرمز وحده.
async function telegramSend(method: string, body: FormData | Record<string, unknown>): Promise<SendOutcome> {
  const token = await botToken();
  const init: RequestInit = body instanceof FormData
    ? { method: "POST", body }
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/${method}`, { ...init, signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS) });
  } catch {
    return { outcome: "unknown", error: `telegram_${method}_network` };
  }
  const data = await res.json().catch(() => null) as { ok?: boolean; result?: { message_id?: number } } | null;
  if (data && data.ok === false) return { outcome: "not_sent", error: `telegram_${method}_${res.status}` };
  const messageId = data && data.ok === true && data.result ? Number(data.result.message_id) : NaN;
  if (!Number.isFinite(messageId)) return { outcome: "unknown", error: `telegram_${method}_${res.status}_unreadable` };
  return { outcome: "sent", messageId };
}

type Claim = { status: "claimed" | "sent" | "in_progress" | "unknown"; token?: string; message_id?: number };

// الوصف في تنبيه «غير محسوم» للمالك (Migration 26): نوع المستند ورقمه وتاريخه ونسخته، بلا زبون ولا مبلغ.
function claimLabel(v: { doc_type: string; doc_number: string; doc_date: string; version: number | string }): string {
  const kind = v.doc_type === "wholesale_invoice" ? "فاتورة جملة" : v.doc_type === "receipt" ? "سند قبض" : "مستند";
  return `${kind} رقم ${v.doc_number} — ${v.doc_date} — V${v.version}`;
}

async function claimNotification(jobId: string, label: string): Promise<Claim> {
  return await rpc("document_archive_claim_notification", { p_job_id: jobId, p_lease_seconds: CLAIM_LEASE_SECONDS, p_label: label }) as Claim;
}

// تسجيل النتيجة يُعاد حتى 3 مرات. إن فشل كلياً بقي الحجز sending فيصير unknown بعد
// المهلة: لا إرسال ثانٍ في كل الأحوال.
async function finishNotification(jobId: string, token: string, outcome: string, messageId: number | null, error: string | null): Promise<boolean> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await rpc("document_archive_finish_notification",
        { p_job_id: jobId, p_token: token, p_outcome: outcome, p_message_id: messageId, p_error: error }) as { ok?: boolean };
      return Boolean(r && r.ok);
    } catch {
      if (attempt < 3) await new Promise((r) => setTimeout(r, RECORD_RETRY_MS * attempt));
    }
  }
  return false;
}

async function handleNotify(req: Request): Promise<Response> {
  const form = await req.formData().catch(() => null);
  if (!form) return json(400, { ok: false, error: "form" });
  const fields: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === "string") fields[k] = v;
  const checked = validateNotifyFields(fields);
  if (checked.error) return json(400, { ok: false, error: checked.error });
  const v = checked.value!;
  const file = form.get("file");
  if (!(file instanceof File)) return json(400, { ok: false, error: "file" });
  if (file.size <= 0 || file.size > MAX_PDF_BYTES) return json(413, { ok: false, error: "file_size" });
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!isPdfBytes(bytes)) return json(400, { ok: false, error: "file_type" });

  // كل ما قد يفشل قبل الإرسال يُقرأ قبل الحجز، كي لا يبقى حجز بلا محاولة.
  const chat = await ownerChatId();
  await botToken();
  const { caption, followUp } = buildNotifyCaption(v);

  const claim = await claimNotification(v.job_id, claimLabel(v));
  if (claim.status === "sent") return json(200, { ok: true, duplicate: true, message_id: Number(claim.message_id) });
  if (claim.status === "in_progress") return json(409, { ok: false, error: "in_progress" });
  if (claim.status !== "claimed" || !claim.token) return json(409, { ok: false, error: "delivery_unknown" });

  const doc = new FormData();
  doc.append("chat_id", chat);
  doc.append("caption", caption);
  doc.append("document", new Blob([bytes], { type: "application/pdf" }), fileNameFor(v, String(fields.file_name || "")));
  const sent = await telegramSend("sendDocument", doc);
  if (sent.outcome !== "sent") {
    await finishNotification(v.job_id, claim.token, sent.outcome, null, sent.error);
    if (sent.outcome === "unknown") {
      console.error(`document-archive-notify: ${sent.error} (delivery unknown, no automatic resend)`);
      return json(409, { ok: false, error: "delivery_unknown" });
    }
    throw new Error(sent.error);
  }
  const messageId = sent.messageId;
  const claimRecorded = await finishNotification(v.job_id, claim.token, "sent", messageId, null);
  if (followUp) {
    // الرسالة المرتبطة: ردّ على المستند نفسه. فشلها لا يُفشل الإشعار (المستند وصل).
    await telegramSend("sendMessage", { chat_id: chat, text: followUp, reply_to_message_id: messageId }).catch(() => null);
  }
  const recorded = await recordNotification(itemFromNotify(v, messageId, String(fields.host || "")));
  return json(200, { ok: true, duplicate: false, message_id: messageId, recorded: recorded && claimRecorded });
}

const BATCH_MAX_ITEMS = 200;

// تحديث جماعي: كل عنصر يُحجز ذرياً كما في /notify (نفس الدوال، بلا تعديل)، ثم رسالة ملخص
// واحدة أو أكثر (sendMessage، بلا PDF) لكل ما نجح حجزه معاً — buildBatchSummaries تقسّم إلى
// رسائل متتالية فقط إذا تجاوز العدد حدّ تيليغرام. كل رسالة تُنهي حجز مستنداتها هي وحدها
// (finishNotification لكل عنصر بنتيجة رسالته بالذات): رسالة فشلت لا تُنهي حجز عنصر في رسالة
// أخرى نجحت في الدفعة نفسها، فلا تُرسَل الناجحة ثانية ولا تضيع الفاشلة — تبقى محجوزة فقط
// (claimed غير sent) فتُعاد في دورة لاحقة دون تكرار. كل عنصر يُصنَّف في الرد: already_sent
// (حجزه مُرسَل سابقاً برسالته الخاصة)، held_job_ids (حجز قائم من محاولة متزامنة — عامل آخر أو
// نفس العامل بالتوازي، انتظار قصير؛ أو رسالة رفضها تيليغرام صراحةً فحُرِّر حجزها)، unknown_job_ids
// (حجز غامض يحتاج تحقق المالك، أو رسالة ضاع ردّها/غير مقروءة)، notified_job_ids (أُرسلت الآن،
// مع رقم رسالتها في notified_message_ids). الرد 200 دائماً كي لا يضيع تصنيف عناصر أخرى بسبب
// حالة عنصر واحد أو فشل رسالة واحدة؛ خطأ شبكة حقيقي قبل أي حجز أو تسجيل يُرمى عادياً فيعيده
// المعالج العام 502 (إعادة الدفعة كاملة دورة لاحقة، كما /notify).
async function handleNotifyBatch(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || !Array.isArray((body as { items?: unknown }).items)) {
    return json(400, { ok: false, error: "json" });
  }
  const rawItems = (body as { items: unknown[] }).items;
  if (rawItems.length === 0) return json(400, { ok: false, error: "empty" });
  if (rawItems.length > BATCH_MAX_ITEMS) return json(400, { ok: false, error: "batch_too_large" });
  const host = String((body as { host?: string }).host || "");

  type Value = NonNullable<ReturnType<typeof validateNotifyFields>["value"]>;
  const values: Value[] = [];
  const seen = new Set<string>();
  for (const raw of rawItems) {
    const checked = validateNotifyFields(raw);
    if (checked.error) return json(400, { ok: false, error: checked.error });
    const v = checked.value as Value;
    if (seen.has(v.job_id)) return json(400, { ok: false, error: "duplicate_job_id" });
    seen.add(v.job_id);
    values.push(v);
  }

  const chat = await ownerChatId();
  await botToken();

  const alreadySent: Record<string, number> = {};
  const heldJobIds: string[] = [];
  const unknownJobIds: string[] = [];
  const claimed: Array<{ v: Value; token: string }> = [];
  for (const v of values) {
    const claim = await claimNotification(v.job_id, claimLabel(v));
    if (claim.status === "sent") { alreadySent[v.job_id] = Number(claim.message_id); continue; }
    if (claim.status === "in_progress") { heldJobIds.push(v.job_id); continue; }
    if (claim.status === "claimed" && claim.token) { claimed.push({ v, token: claim.token }); continue; }
    unknownJobIds.push(v.job_id); // claim.status === "unknown": حجز سابق غامض، يحتاج تحقق المالك
  }

  const notifiedJobIds: string[] = [];
  const notifiedMessageIds: Record<string, number> = {};
  // not_sent صريح من تيليغرام (لم يُرسل) ⇒ الحجز released، إعادة تلقائية آمنة كمحاولة عادية.
  // unknown (شبكة/مهلة/جسم غير مقروء) ⇒ قد يكون وصل: لا إعادة تلقائية، كما /notify بالضبط.
  const releasedJobIds: string[] = [];
  if (claimed.length > 0) {
    const tokenByJobId = new Map(claimed.map((c) => [c.v.job_id, c.token]));
    // كل مجموعة (رسالة واحدة محتملة) تُرسَل وتُنهى بمعزل عن المجموعات الأخرى: لا نسمة
    // مشتركة في النتيجة بين رسالة ناجحة ورسالة فاشلة في الدفعة نفسها.
    for (const group of buildBatchSummaries(claimed.map((c) => c.v))) {
      const sent = await telegramSend("sendMessage", { chat_id: chat, text: group.text });
      if (sent.outcome === "sent") {
        const messageId = sent.messageId;
        for (const v of group.items) {
          const token = tokenByJobId.get(v.job_id) as string;
          await finishNotification(v.job_id, token, "sent", messageId, null);
          await recordNotification(itemFromNotify(v, messageId, host));
          notifiedJobIds.push(v.job_id);
          notifiedMessageIds[v.job_id] = messageId;
        }
      } else {
        for (const v of group.items) {
          const token = tokenByJobId.get(v.job_id) as string;
          await finishNotification(v.job_id, token, sent.outcome, null, sent.error);
          (sent.outcome === "unknown" ? unknownJobIds : releasedJobIds).push(v.job_id);
        }
        console.error(`document-archive-notify: ${sent.error} (batch ${sent.outcome}, no automatic resend)`);
      }
    }
  }
  return json(200, {
    ok: true,
    notified_job_ids: notifiedJobIds,
    notified_message_ids: notifiedMessageIds,
    already_sent: alreadySent,
    held_job_ids: [...heldJobIds, ...releasedJobIds],
    unknown_job_ids: unknownJobIds,
  });
}

// مرآة الموقع: message_id على عنصر المهمة. حارس التكرار هو الحجز (Migration 26) لا هذا
// التسجيل؛ يُعاد حتى 3 مرات، وإن فشل كلياً أرسل العامل message_id في تقريره التالي.
async function recordNotification(item: unknown): Promise<boolean> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await rpc("document_archive_record_notification", { p_item: item });
      return true;
    } catch {
      if (attempt < 3) await new Promise((r) => setTimeout(r, RECORD_RETRY_MS * attempt));
    }
  }
  return false;
}

// اسم المرفق: من العامل إن كان آمناً، وإلا اسم ثابت. لا مسارات.
function fileNameFor(v: { doc_type: string; doc_number: string; doc_date: string }, given: string): string {
  const cleaned = given.replace(/[\\/:*?"<>|\u0000-\u001f‎‏⁦-⁩]/g, " ").trim();
  if (cleaned.toLowerCase().endsWith(".pdf") && cleaned.length <= 180) return cleaned;
  return `${v.doc_type === "receipt" ? "receipt" : "invoice"}-${v.doc_number}-${v.doc_date}.pdf`;
}

async function handleReport(req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return json(400, { ok: false, error: "json" });
  const result = await rpc("document_archive_ingest_report", { p_report: body }) as { retry_job_ids?: unknown };
  const retryIds = Array.isArray(result && result.retry_job_ids)
    ? (result.retry_job_ids as unknown[]).map(String).filter((id) => /^[0-9a-f]{32}$/.test(id)) : [];
  if (retryIds.length) {
    // طلب المالك يحرّر الحجوزات المجهولة وحدها؛ فشل التحرير لا يُسقط التقرير (الإعادة تعود مجهولة فيطلبها ثانية).
    await rpc("document_archive_release_notification_claims", { p_job_ids: retryIds })
      .catch(() => console.error("document-archive-notify: release_claims_failed"));
  }
  return json(200, { ok: true, result });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { ok: false, error: "method" });
  if (!ARCHIVE_SECRET || !SUPA_URL || !SERVICE_KEY) return json(503, { ok: false, error: "not_configured" });
  if (!timingSafeEqualText(req.headers.get("x-ozk-archive-secret"), ARCHIVE_SECRET)) {
    return json(401, { ok: false, error: "unauthorized" });
  }
  const route = new URL(req.url).pathname.split("/").filter(Boolean).pop();
  try {
    if (route === "notify") return await handleNotify(req);
    if (route === "notify-batch") return await handleNotifyBatch(req);
    if (route === "report") return await handleReport(req);
    return json(404, { ok: false, error: "route" });
  } catch (err) {
    // رمز الخطأ وحده؛ لا توكن ولا جسم طلب في السجل أو الرد.
    const code = String((err as Error)?.message || "error").replace(/bot\d+:[\w-]+/g, "bot***").slice(0, 80);
    console.error(`document-archive-notify: ${code}`);
    return json(502, { ok: false, error: code });
  }
});
