"use strict";
// عميل Google Drive v3 بأقل صلاحية: drive.file — التطبيق يرى ويكتب ما أنشأه هو فقط.
//
// قواعد ثابتة (يفرضها scripts/check-drive-invoice-archive.mjs):
//   * لا استدعاء لأي مسار permissions إطلاقاً: لا مشاركة، لا «anyone with link».
//   * لا حذف ولا نقل إلى سلة ولا استبدال محتوى ملف موجود (لا PATCH على /upload).
//   * الهوية: about.user.emailAddress يجب أن يطابق الحساب المعتمد، وإلا يتوقف كل رفع.
//   * الخصوصية: المجلد الجذر المشترك مع أي أحد (shared=true) يوقف الرفع.
//   * لا يمرّ أي توكن إلى السجل: الأخطاء رموز ثابتة.

const crypto = require("crypto");

const SCOPE = "https://www.googleapis.com/auth/drive.file";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";

class DriveError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code; // NEEDS_REAUTH | IDENTITY_MISMATCH | NOT_PRIVATE | OFFLINE | TRANSIENT | INTEGRITY | API
  }
}

function qValue(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function createDrive({ credentials, expectedEmail, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
  if (!credentials || !credentials.client_id || !credentials.client_secret || !credentials.refresh_token) {
    throw new DriveError("NEEDS_REAUTH", "بيانات OAuth ناقصة");
  }
  const expected = String(expectedEmail || "").trim().toLowerCase();
  if (!expected) throw new DriveError("IDENTITY_MISMATCH", "الحساب المعتمد غير مضبوط");
  let access = null;
  let accessExpiresAt = 0;
  let verifiedAt = 0;

  async function call(url, init) {
    try {
      return await fetchImpl(url, init);
    } catch (err) {
      throw new DriveError("OFFLINE", err && err.code ? String(err.code) : "network");
    }
  }

  async function refresh() {
    const body = new URLSearchParams({
      client_id: credentials.client_id,
      client_secret: credentials.client_secret,
      refresh_token: credentials.refresh_token,
      grant_type: "refresh_token",
    });
    const res = await call(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      if (data.error === "invalid_grant" || data.error === "invalid_client" || data.error === "unauthorized_client") {
        throw new DriveError("NEEDS_REAUTH", data.error);
      }
      throw new DriveError(res.status >= 500 || res.status === 429 ? "TRANSIENT" : "API", `token ${res.status}`);
    }
    // النطاق الممنوح يجب أن يكون drive.file وحده (أو مع openid/email) — لا drive الكاملة.
    const scopes = String(data.scope || SCOPE).split(/\s+/);
    if (scopes.some((s) => /\/auth\/drive(\.readonly|\.metadata|\.appdata)?$/.test(s))) {
      throw new DriveError("NEEDS_REAUTH", "نطاق أوسع من drive.file — أعد المصادقة بالنطاق الأدنى");
    }
    access = data.access_token;
    accessExpiresAt = now() + Math.max(60, Number(data.expires_in) || 3600) * 1000 - 60_000;
  }

  function requestInit(method, { json, body, headers }) {
    const init = { method, headers: { Authorization: `Bearer ${access}`, ...(headers || {}) } };
    if (json !== undefined) {
      init.headers["Content-Type"] = "application/json; charset=UTF-8";
      init.body = JSON.stringify(json);
    } else if (body !== undefined) {
      init.body = body;
    }
    return init;
  }

  function apiError(status, data) {
    if (status === 401) return new DriveError("NEEDS_REAUTH", "401");
    const errors = data && data.error && data.error.errors;
    const reason = Array.isArray(errors) && errors[0] ? errors[0].reason : "";
    const transient = status === 429 || status >= 500 || /rateLimit|backendError/i.test(reason);
    return new DriveError(transient ? "TRANSIENT" : "API", `${status} ${reason}`.trim());
  }

  async function api(method, url, options = {}, retried = false) {
    if (!access || now() >= accessExpiresAt) await refresh();
    const res = await call(url, requestInit(method, options));
    if (res.status === 401 && !retried) {
      access = null;
      return api(method, url, options, true);
    }
    const data = await res.json().catch(() => ({}));
    if (res.ok) return data;
    throw apiError(res.status, data);
  }

  // الهوية قبل أي كتابة، ثم تُعاد كل 5 دقائق (حالة «متصل» لا تأتي من تحقق قديم).
  async function verifyIdentity(force = false) {
    if (!force && verifiedAt && now() - verifiedAt < 5 * 60_000) return true;
    const data = await api("GET", `${API}/about?fields=user(emailAddress)`);
    const email = String(data && data.user && data.user.emailAddress || "").trim().toLowerCase();
    if (email !== expected) {
      verifiedAt = 0;
      throw new DriveError("IDENTITY_MISMATCH", "حساب Google المرتبط ليس الحساب المعتمد");
    }
    verifiedAt = now();
    return true;
  }

  async function findAll(q, fields) {
    const url = `${API}/files?q=${encodeURIComponent(q)}&spaces=drive&orderBy=createdTime&pageSize=10`
      + `&fields=${encodeURIComponent(`files(${fields})`)}`;
    const data = await api("GET", url);
    return Array.isArray(data.files) ? data.files : [];
  }

  async function findOne(q, fields) {
    return (await findAll(q, fields))[0] || null;
  }

  async function ensureFolder(parentId, key, name) {
    const q = `'${qValue(parentId)}' in parents and mimeType='${FOLDER_MIME}' and trashed=false`
      + ` and appProperties has { key='ozkFolderKey' and value='${qValue(key)}' }`;
    const found = await findOne(q, "id,shared");
    if (found) return found;
    return api("POST", `${API}/files?fields=id,shared`, {
      json: { name, mimeType: FOLDER_MIME, parents: [parentId], appProperties: { ozkArchive: "1", ozkFolderKey: key } },
    });
  }

  // المسار كاملاً؛ يتوقف إن كان الجذر مشتركاً.
  async function ensurePath(plan, cache) {
    let parent = "root";
    for (const step of plan) {
      const cacheKey = `${parent}|${step.key}`;
      let id = cache && cache[cacheKey];
      if (!id) {
        const folder = await ensureFolder(parent, step.key, step.name);
        if (step.key === "root" && folder.shared) throw new DriveError("NOT_PRIVATE", "مجلد الأرشيف الجذر مشترك");
        id = folder.id;
        if (cache) cache[cacheKey] = id;
      }
      parent = id;
    }
    return parent;
  }

  async function checkRootPrivate(cache) {
    const rootId = cache && cache["root|root"];
    if (!rootId) return true;
    const data = await api("GET", `${API}/files/${encodeURIComponent(rootId)}?fields=id,shared,trashed`);
    if (data.trashed) { delete cache["root|root"]; return true; }
    if (data.shared) throw new DriveError("NOT_PRIVATE", "مجلد الأرشيف الجذر مشترك");
    return true;
  }

  // بعد انقطاع بين الرفع وحفظ الحالة: الملف موجود بمعرّف المهمة ⇒ لا رفع ثانٍ.
  // قد تكون أكثر من نسخة (رفع سابق وصل تالفاً فبقي ولم يُحذف)؛ المستدعي يختار المطابقة.
  async function findArchived(jobId) {
    const q = `trashed=false and appProperties has { key='ozkJobId' and value='${qValue(jobId)}' }`;
    return findAll(q, "id,name,webViewLink,md5Checksum,size,shared");
  }

  async function upload({ folderId, name, pdf, appProperties }) {
    const boundary = `ozk-${crypto.randomBytes(12).toString("hex")}`;
    const meta = { name, mimeType: "application/pdf", parents: [folderId], appProperties };
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`
        + `--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`, "utf8"),
      pdf,
      Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
    ]);
    return api("POST", `${UPLOAD}?uploadType=multipart&fields=id,name,webViewLink,md5Checksum,size,shared`, {
      body,
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    });
  }

  // التحقق بعد الرفع: md5 وحجم مطابقان، والملف غير مشترك، ورابط العرض الخاص موجود.
  function verifyUploaded(file, pdf) {
    const md5 = crypto.createHash("md5").update(pdf).digest("hex");
    if (!file || !file.id) throw new DriveError("INTEGRITY", "لا معرّف ملف");
    if (String(file.md5Checksum || "") !== md5 || Number(file.size) !== pdf.length) {
      throw new DriveError("INTEGRITY", "md5/size لا يطابق الملف المحلي");
    }
    if (file.shared) throw new DriveError("NOT_PRIVATE", "الملف المرفوع مشترك");
    if (!/^https:\/\/drive\.google\.com\/file\/d\//.test(String(file.webViewLink || ""))) {
      throw new DriveError("INTEGRITY", "رابط العرض غير متوقع");
    }
    return { fileId: file.id, webViewLink: file.webViewLink, md5 };
  }

  return { verifyIdentity, ensurePath, checkRootPrivate, findArchived, upload, verifyUploaded };
}

module.exports = { SCOPE, DriveError, createDrive, qValue, FOLDER_MIME };
