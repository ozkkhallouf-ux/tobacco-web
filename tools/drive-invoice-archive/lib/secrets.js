"use strict";
// أسرار العامل خارج Git: على Windows ملفات DPAPI (LocalMachine + entropy باسم السر) في
// %ProgramData%\OZK\DriveArchive\<name>.secret بقائمة ACL ضيقة يكتبها set-secret.ps1.
//
//   sql           سلسلة اتصال قراءة (ozk_print_reader، لا sa)
//   google-oauth  JSON {client_id, client_secret, refresh_token, account_email}
//   notify        سرّ دالة Edge document-archive-notify
//
// خارج Windows (تطوير واختبار فقط): ملفات نصية في OZK_DRIVE_ARCHIVE_DEV_SECRETS_DIR.
// القيمة لا تُطبع ولا تُسجَّل؛ تُسجَّل في redact لتُحجب إن ظهرت في أي رسالة خطأ.

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { registerSecret } = require("./redact");

const NAMES = Object.freeze(["sql", "google-oauth", "notify"]);

function assertName(name) {
  if (!NAMES.includes(name)) throw new Error(`اسم سرّ غير معروف: ${name}`);
}

function entropy(name) {
  return `OZK-DriveArchive-${name}`;
}

function readWindows(file, name) {
  const script = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security;"
    + ` $b=[IO.File]::ReadAllBytes('${file.replace(/'/g, "''")}');`
    + ` $d=[Security.Cryptography.ProtectedData]::Unprotect($b,[Text.Encoding]::UTF8.GetBytes('${entropy(name)}'),`
    + " [Security.Cryptography.DataProtectionScope]::LocalMachine); [Convert]::ToBase64String($d)";
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
  if (r.status !== 0) throw new Error(`تعذّر فك السر ${name}`);
  return Buffer.from(String(r.stdout).trim(), "base64").toString("utf8");
}

function readSecret(name, secretDir) {
  assertName(name);
  let value;
  if (process.platform === "win32") {
    const file = path.join(secretDir, `${name}.secret`);
    if (!fs.existsSync(file)) return null;
    value = readWindows(file, name);
  } else {
    const dev = process.env.OZK_DRIVE_ARCHIVE_DEV_SECRETS_DIR;
    if (!dev) return null;
    const file = path.join(dev, name);
    if (!fs.existsSync(file)) return null;
    value = fs.readFileSync(file, "utf8").trim();
  }
  if (name === "google-oauth") {
    const obj = JSON.parse(value);
    for (const k of ["client_secret", "refresh_token"]) registerSecret(obj[k]);
    return obj;
  }
  registerSecret(value);
  if (name === "sql") {
    const m = /(?:^|;)\s*(?:password|pwd)\s*=\s*([^;]+)/i.exec(value);
    if (m) registerSecret(m[1].trim());
  }
  return value;
}

function hasSecret(name, secretDir) {
  assertName(name);
  if (process.platform === "win32") return fs.existsSync(path.join(secretDir, `${name}.secret`));
  const dev = process.env.OZK_DRIVE_ARCHIVE_DEV_SECRETS_DIR;
  return Boolean(dev && fs.existsSync(path.join(dev, name)));
}

module.exports = { NAMES, readSecret, hasSecret, entropy };
