#!/usr/bin/env node
// OZK Automatic iCloud Archive — الجسر المحلي على الماك.
//
// يستقبل من موقع OZK مستنداً (HTML أو PDF جاهز) + بيانات وصفية، ويحفظ نسخة PDF
// داخل مجلد iCloud Drive المناسب باسم عربي واضح — بلا أي اختيار يدوي للمكان.
//
// حدود التصميم (مقصودة):
//   • يستمع على 127.0.0.1 فقط ولا يُفتح على الشبكة إطلاقاً.
//   • الموقع لا يرسل مساراً ولا اسم ملف: يرسل نوع المستند فقط، والجسر يقرر.
//   • لا يستبدل ولا يحذف أي ملف قائم أبداً.
//   • لا يقترب من قاعدة الأمين ولا من أي بيانات محاسبية — ملفات فقط.
//   • فشل الأرشفة لا يعني فشل الفاتورة: الموقع يتابع تنزيله العادي.

import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { loadConfig, loadToken, HOME_DIR, TOKEN_PATH } from "./lib/config.mjs";
import { logEvent } from "./lib/log.mjs";
import { DOC_TYPE_NAMES, isKnownDocType } from "./lib/doc-types.mjs";
import { discoverFolders, missingFolders, rootReady } from "./lib/folders.mjs";
import { archiveDocument } from "./lib/archive.mjs";
import { renderHtmlToPdf, renderAvailable, closeBrowser } from "./lib/render.mjs";

export const VERSION = "1.0.0";
const MAX_HTML_CHARS = 8 * 1024 * 1024;

const config = loadConfig();
const TOKEN = loadToken();
const allowedOrigins = new Set(config.allowedOrigins);
const hits = new Map();

function tokenMatches(candidate) {
  const a = Buffer.from(String(candidate || ""), "utf8");
  const b = Buffer.from(TOKEN, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// حارس إعادة ربط DNS: صفحة يتحكم بها مهاجم قد تُحوّل نطاقها إلى 127.0.0.1،
// لكن ترويسة Host تبقى نطاقه هو. نقبل عناوين الاسترجاع الصريحة فقط.
function hostAllowed(hostHeader) {
  const host = String(hostHeader || "").toLowerCase();
  const bare = host.replace(/:\d+$/, "");
  return bare === "127.0.0.1" || bare === "localhost" || bare === "[::1]";
}

function rateLimited(key) {
  const now = Date.now();
  const { windowMs, max } = config.rateLimit;
  const bucket = (hits.get(key) || []).filter((at) => now - at < windowMs);
  bucket.push(now);
  hits.set(key, bucket);
  if (hits.size > 64) {
    for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
  }
  return bucket.length > max;
}

function applyCors(req, res, origin) {
  res.setHeader("Vary", "Origin");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (!origin) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, x-ozk-archive-token");
  res.setHeader("Access-Control-Max-Age", "600");
  // كروم يطلب هذه الترويسة صراحةً حين تخاطب صفحة عامة عنواناً على الشبكة المحلية.
  if (req.headers["access-control-request-private-network"]) {
    res.setHeader("Access-Control-Allow-Private-Network", "true");
  }
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("حجم الطلب أكبر من المسموح"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function healthPayload() {
  const ready = await rootReady(config.icloudRoot);
  const folders = ready ? await discoverFolders(config.icloudRoot) : new Map();
  const missing = ready ? missingFolders(folders) : [];
  return {
    ok: true,
    service: "ozk-archive-bridge",
    version: VERSION,
    docTypes: DOC_TYPE_NAMES,
    icloud: { ready: ready && missing.length === 0, rootFound: ready, missingFolders: missing },
    render: await renderAvailable(),
    autoPair: Boolean(config.autoPair)
  };
}

function normalizeBaseUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(String(value));
    if (!allowedOrigins.has(url.origin)) return "";
    return url.href;
  } catch {
    return "";
  }
}

async function handleArchive(req, res, origin) {
  if (!tokenMatches(req.headers["x-ozk-archive-token"])) {
    logEvent("warn", "رفض رمز غير صالح", { origin });
    return sendJson(res, 401, { ok: false, error: "رمز غير صالح", code: "bad_token" });
  }
  const contentType = String(req.headers["content-type"] || "");
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return sendJson(res, 415, { ok: false, error: "نوع المحتوى يجب أن يكون application/json" });
  }

  let payload;
  try {
    payload = JSON.parse((await readBody(req, config.maxBodyBytes)).toString("utf8"));
  } catch (error) {
    const status = error.statusCode || 400;
    return sendJson(res, status, { ok: false, error: error.statusCode ? error.message : "جسم الطلب ليس JSON صالحاً" });
  }

  const docType = payload && payload.docType;
  if (!isKnownDocType(docType)) {
    logEvent("warn", "نوع مستند مرفوض", { docType: String(docType).slice(0, 40), origin });
    return sendJson(res, 400, { ok: false, error: "نوع مستند غير مدعوم", code: "bad_doc_type" });
  }

  const meta = (payload.meta && typeof payload.meta === "object") ? payload.meta : {};
  const hasHtml = typeof payload.html === "string" && payload.html.trim().length > 0;
  const hasPdf = typeof payload.pdfBase64 === "string" && payload.pdfBase64.length > 0;
  if (hasHtml === hasPdf) {
    return sendJson(res, 400, { ok: false, error: "أرسل html أو pdfBase64 — واحداً منهما فقط" });
  }
  if (hasHtml && payload.html.length > MAX_HTML_CHARS) {
    return sendJson(res, 413, { ok: false, error: "محتوى HTML أكبر من المسموح" });
  }

  let pdf;
  try {
    if (hasPdf) {
      pdf = Buffer.from(payload.pdfBase64, "base64");
    } else {
      pdf = await renderHtmlToPdf(payload.html, {
        baseUrl: normalizeBaseUrl(payload.baseUrl),
        timeoutMs: config.renderTimeoutMs,
        idleMs: config.browserIdleMs
      });
    }
  } catch (error) {
    logEvent("error", "فشل تحويل المستند", { docType, reason: error.message });
    return sendJson(res, 500, { ok: false, error: "تعذّر تحويل المستند إلى PDF: " + error.message });
  }

  try {
    const result = await archiveDocument(pdf, docType, meta, { root: config.icloudRoot });
    logEvent(result.status === "saved" ? "success" : "info",
      result.status === "saved" ? "تم حفظ نسخة" : "نسخة مطابقة موجودة مسبقاً",
      { docType, folder: result.folder, file: result.file, bytes: result.bytes, source: hasPdf ? "pdf" : "html" });
    return sendJson(res, 200, { ok: true, ...result, path: undefined });
  } catch (error) {
    const missing = /مجلد iCloud غير موجود/.test(error.message);
    logEvent("error", "فشل الحفظ", { docType, reason: error.message });
    return sendJson(res, missing ? 409 : 400, {
      ok: false,
      error: error.message,
      code: missing ? "folder_missing" : "archive_failed"
    });
  }
}

export const server = createServer(async (req, res) => {
  const origin = String(req.headers.origin || "");
  const originAllowed = origin && allowedOrigins.has(origin);

  if (!hostAllowed(req.headers.host)) {
    logEvent("warn", "ترويسة Host مرفوضة", { reason: String(req.headers.host || "").slice(0, 80) });
    return sendJson(res, 403, { ok: false, error: "طلب مرفوض" });
  }
  if (originAllowed) applyCors(req, res, origin);

  if (req.method === "OPTIONS") {
    res.writeHead(originAllowed ? 204 : 403);
    return res.end();
  }
  if (origin && !originAllowed) {
    logEvent("warn", "أصل مرفوض", { reason: origin.slice(0, 80) });
    return sendJson(res, 403, { ok: false, error: "أصل غير مسموح" });
  }
  if (rateLimited(origin || "local")) {
    return sendJson(res, 429, { ok: false, error: "طلبات كثيرة — انتظر قليلاً" });
  }

  const url = new URL(req.url, "http://127.0.0.1");
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, await healthPayload());
    }
    if (req.method === "GET" && url.pathname === "/pair") {
      // الربط التلقائي متاح للأصول المسموح بها فقط؛ يمكن إيقافه من config.json
      // ولصق الرمز يدوياً من ~/OZK-Archive-Bridge/token.
      if (!config.autoPair) return sendJson(res, 403, { ok: false, error: "الربط التلقائي موقوف" });
      if (!originAllowed) return sendJson(res, 403, { ok: false, error: "أصل غير مسموح" });
      return sendJson(res, 200, { ok: true, token: TOKEN });
    }
    if (req.method === "POST" && url.pathname === "/archive") {
      return await handleArchive(req, res, origin);
    }
    return sendJson(res, 404, { ok: false, error: "مسار غير معروف" });
  } catch (error) {
    logEvent("error", "خطأ غير متوقع", { reason: error.message });
    return sendJson(res, 500, { ok: false, error: "خطأ داخلي" });
  }
});

function shutdown() {
  logEvent("info", "إيقاف الجسر");
  server.close(() => {});
  closeBrowser().finally(() => process.exit(0));
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  server.listen(config.port, config.host, async () => {
    const health = await healthPayload();
    logEvent("info", `الجسر يعمل على http://${config.host}:${config.port}`, {
      reason: `مجلدات ناقصة: ${health.icloud.missingFolders.length}`
    });
    process.stdout.write(`الإعدادات: ${HOME_DIR}/config.json\nالرمز: ${TOKEN_PATH}\n`);
  });
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
