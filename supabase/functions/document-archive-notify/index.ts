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
//            وحدها (bot_config.owner_chat_id) ويسجّل message_id. إن كان للمهمة
//            message_id مسجَّل يعيده بلا إرسال ثانٍ (إعادة محاولة العامل بعد ضياع الرد).
//   /report  JSON: نبض العامل + ملخص المهام؛ يعيد طلبات إعادة المحاولة من المالك.
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

async function telegram(method: string, body: FormData | Record<string, unknown>): Promise<number> {
  const token = await botToken();
  const init: RequestInit = body instanceof FormData
    ? { method: "POST", body }
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, init);
  const data = await res.json().catch(() => null) as { ok?: boolean; result?: { message_id?: number } } | null;
  const messageId = data && data.ok && data.result ? Number(data.result.message_id) : NaN;
  // لا نعيد نص خطأ تيليغرام (قد يتضمن تفاصيل الطلب)؛ الرمز وحده.
  if (!Number.isFinite(messageId)) throw new Error(`telegram_${method}_${res.status}`);
  return messageId;
}

async function existingMessageId(jobId: string): Promise<number | null> {
  const rows = await restGet(`document_archive_items?job_id=eq.${jobId}&select=telegram_message_id`) as Array<{ telegram_message_id: number | null }>;
  const v = Array.isArray(rows) && rows[0] ? rows[0].telegram_message_id : null;
  return v === null || v === undefined ? null : Number(v);
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

  const already = await existingMessageId(v.job_id);
  if (already !== null) return json(200, { ok: true, duplicate: true, message_id: already });

  const chat = await ownerChatId();
  const { caption, followUp } = buildNotifyCaption(v);
  const doc = new FormData();
  doc.append("chat_id", chat);
  doc.append("caption", caption);
  doc.append("document", new Blob([bytes], { type: "application/pdf" }), fileNameFor(v, String(fields.file_name || "")));
  const messageId = await telegram("sendDocument", doc);
  if (followUp) {
    // الرسالة المرتبطة: ردّ على المستند نفسه. فشلها لا يُفشل الإشعار (المستند وصل).
    await telegram("sendMessage", { chat_id: chat, text: followUp, reply_to_message_id: messageId }).catch(() => 0);
  }
  let recorded = true;
  try {
    await rpc("document_archive_record_notification", { p_item: itemFromNotify(v, messageId, String(fields.host || "")) });
  } catch {
    recorded = false; // المستند وصل؛ العامل يرسل message_id في تقريره التالي فيُسجَّل.
  }
  return json(200, { ok: true, duplicate: false, message_id: messageId, recorded });
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
  const result = await rpc("document_archive_ingest_report", { p_report: body });
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
