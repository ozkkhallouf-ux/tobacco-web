"use strict";
// ============================================================================
// ربط حساب Google بأرشيف الفواتير — يشغّله المالك بنفسه مرة واحدة على OZK2026.
//
//   node authorize.js --client <ملف عميل OAuth من نوع Desktop app> --user <مستخدم المهمة>
//
// تدفّق OAuth 2.0 للتطبيقات المثبّتة: عنوان رجوع على 127.0.0.1 بمنفذ عشوائي، وPKCE (S256)،
// وstate عشوائي. النطاق drive.file وحده. بعد الموافقة يُتحقق من هوية الحساب عبر Drive
// نفسه: إن لم يكن ozkkhallouf@gmail.com يُلغى الرمز فوراً ولا يُحفظ شيء.
// الرمز يُحفظ عبر set-secret.ps1 (DPAPI) ولا يُطبع ولا يُسجَّل.
// ============================================================================

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const { APPROVED_ACCOUNT } = require("./lib/config");
const { SCOPE, createDrive } = require("./lib/drive");
const { redact, registerSecret } = require("./lib/redact");

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : "";
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function readClient(file) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  const c = raw.installed || raw;
  if (!c.client_id || !c.client_secret) throw new Error("ملف العميل بلا client_id/client_secret");
  if (raw.web) throw new Error("ملف العميل من نوع Web؛ المطلوب Desktop app");
  return { client_id: c.client_id, client_secret: c.client_secret };
}

function buildAuthUrl({ clientId, redirectUri, challenge, state }) {
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent select_account",
    login_hint: APPROVED_ACCOUNT,
    include_granted_scopes: "false",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  return `${AUTH_URL}?${p.toString()}`;
}

// ينتظر رجوع المتصفح بالرمز مرة واحدة، ويرفض أي state مختلف.
function waitForCode(server, expectedState, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("انتهت المهلة بلا موافقة")), timeoutMs);
    server.on("request", (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== "/callback") { res.writeHead(404).end(); return; }
      const done = (status, text) => {
        res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><meta charset="utf-8"><body dir="rtl" style="font:16px Tahoma;padding:24px">${text}</body>`);
      };
      if (url.searchParams.get("state") !== expectedState) { done(400, "طلب غير مطابق — أُهمل."); return; }
      clearTimeout(timer);
      const err = url.searchParams.get("error");
      if (err) { done(400, "لم تتم الموافقة. يمكن إغلاق هذه النافذة."); reject(new Error(`رُفضت الموافقة: ${err}`)); return; }
      done(200, "تمت الموافقة. عُد إلى نافذة الأوامر لإكمال التحقق من الحساب، ثم أغلق هذه النافذة.");
      resolve(url.searchParams.get("code") || "");
    });
  });
}

async function exchange(client, code, verifier, redirectUri, fetchImpl) {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.client_id,
      client_secret: client.client_secret,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.refresh_token) throw new Error(`تعذّر تبديل الرمز (${res.status} ${data.error || "بلا refresh_token"})`);
  registerSecret(data.refresh_token);
  registerSecret(data.access_token);
  return data;
}

async function revoke(token, fetchImpl) {
  try {
    await fetchImpl(REVOKE_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }) });
  } catch { /* أفضل جهد */ }
}

// يتحقق بالرمز الجديد أن الحساب هو المعتمد، وإلا يلغيه ولا يحفظ شيئاً.
async function verifyAndBuild(client, tokens, fetchImpl) {
  const credentials = { ...client, refresh_token: tokens.refresh_token };
  const drive = createDrive({ credentials, expectedEmail: APPROVED_ACCOUNT, fetchImpl });
  try {
    await drive.verifyIdentity(true);
  } catch (err) {
    await revoke(tokens.refresh_token, fetchImpl);
    throw err;
  }
  return { ...credentials, account_email: APPROVED_ACCOUNT, scope: SCOPE, authorized_at: new Date().toISOString() };
}

function saveSecret(json, user) {
  if (process.platform !== "win32") {
    const dev = process.env.OZK_DRIVE_ARCHIVE_DEV_SECRETS_DIR;
    if (!dev) throw new Error("الحفظ مدعوم على Windows وحده");
    fs.mkdirSync(dev, { recursive: true });
    fs.writeFileSync(path.join(dev, "google-oauth"), json, { mode: 0o600 });
    return;
  }
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", path.join(__dirname, "set-secret.ps1"), "-Name", "google-oauth", "-User", user],
  { input: json, encoding: "utf8", windowsHide: true, timeout: 30_000 });
  if (r.status !== 0) throw new Error(`فشل حفظ السر: ${redact(r.stderr || r.stdout, 200)}`);
}

async function main(argv) {
  const clientFile = arg(argv, "--client");
  const user = arg(argv, "--user") || process.env.USERNAME || "";
  if (!clientFile || !user) {
    console.log("الاستعمال: node authorize.js --client <client_secret_….json> --user <مستخدم المهمة>");
    return 2;
  }
  const client = readClient(clientFile);
  registerSecret(client.client_secret);
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = b64url(crypto.randomBytes(24));
  const server = http.createServer();
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
  const url = buildAuthUrl({ clientId: client.client_id, redirectUri, challenge, state });
  console.log(`سجّل الدخول بالحساب ${APPROVED_ACCOUNT} فقط ووافق على صلاحية «الملفات التي ينشئها التطبيق».`);
  console.log("إن لم يُفتح المتصفح تلقائياً، افتح هذا الرابط:\n" + url);
  if (process.platform === "win32") spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore" }).unref();
  try {
    const code = await waitForCode(server, state, 10 * 60_000);
    const tokens = await exchange(client, code, verifier, redirectUri, globalThis.fetch);
    const secret = await verifyAndBuild(client, tokens, globalThis.fetch);
    saveSecret(JSON.stringify(secret), user);
    console.log(`تم: الأرشيف مربوط بالحساب ${APPROVED_ACCOUNT} بصلاحية drive.file وحدها. لم يُطبع أي رمز.`);
    return 0;
  } finally {
    server.close();
  }
}

module.exports = { buildAuthUrl, readClient, exchange, verifyAndBuild, waitForCode, b64url };

if (require.main === module) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (err) => {
    console.error(`فشل الربط: ${redact(err && err.message || err)}`);
    process.exit(1);
  });
}
