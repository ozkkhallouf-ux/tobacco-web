"use strict";
// تنقية أي نص قبل السجل أو التقرير: رموز Google وتيليغرام وBearer وقيم الأسرار المسجّلة.
// القاعدة: السجل يحمل رمز الخطأ ورسالة مختصرة، لا جسم طلب ولا رأس ولا توكن.

const PATTERNS = [
  /ya29\.[A-Za-z0-9_\-.]+/g,          // Google access token
  /1\/\/[A-Za-z0-9_\-]{10,}/g,        // Google refresh token
  /GOCSPX-[A-Za-z0-9_\-]+/g,          // Google OAuth client secret
  /bot\d{5,}:[A-Za-z0-9_\-]{20,}/g,   // Telegram bot token في URL
  /\b\d{5,}:[A-Za-z0-9_\-]{30,}\b/g,  // Telegram bot token
  /Bearer\s+[A-Za-z0-9_\-.~+/=]+/gi,
  /(password|pwd|client_secret|refresh_token|access_token|code)=([^&;\s]+)/gi,
];

const registered = new Set();

function registerSecret(value) {
  const v = String(value || "");
  if (v.length >= 8) registered.add(v);
}

function redact(text, max = 300) {
  let out = String(text == null ? "" : text);
  for (const secret of registered) out = out.split(secret).join("***");
  for (const re of PATTERNS) out = out.replace(re, (m, k) => (typeof k === "string" ? `${k}=***` : "***"));
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

module.exports = { redact, registerSecret };
