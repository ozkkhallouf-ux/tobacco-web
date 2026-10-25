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
//   /report  JSON: نبض العامل + ملخص المهام؛ يعيد طلبات إعادة المحاولة من المالك،
//            ويحرّر حجوزاتها المجهولة (المالك تحقق بنفسه أن المستند لم يصل).
//
// لا chat_id من الطلب إطلاقاً، ولا parse_mode، ولا روابط مشاركة عامة.
// النسخة غير منشورة؛ النشر بموافقة المالك من الـMac (verify_jwt=false في config.toml).
// ============================================================================
import "../_shared/telegram-format.js";
import {
  MAX_PDF_BYTES,
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

async function claimNotification(jobId: string): Promise<Claim> {
  return await rpc("document_archive_claim_notification", { p_job_id: jobId, p_lease_seconds: CLAIM_LEASE_SECONDS }) as Claim;
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

  const claim = await claimNotification(v.job_id);
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
function fileNameFor(v: { doc_number: string; doc_date: string }, given: string): string {
  const cleaned = given.replace(/[\\/:*?"<>|\u0000-\u001f‎‏⁦-⁩]/g, " ").trim();
  if (cleaned.toLowerCase().endsWith(".pdf") && cleaned.length <= 180) return cleaned;
  return `invoice-${v.doc_number}-${v.doc_date}.pdf`;
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
    if (route === "report") return await handleReport(req);
    return json(404, { ok: false, error: "route" });
  } catch (err) {
    // رمز الخطأ وحده؛ لا توكن ولا جسم طلب في السجل أو الرد.
    const code = String((err as Error)?.message || "error").replace(/bot\d+:[\w-]+/g, "bot***").slice(0, 80);
    console.error(`document-archive-notify: ${code}`);
    return json(502, { ok: false, error: code });
  }
});
