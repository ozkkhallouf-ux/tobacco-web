// إعدادات الجسر ورمز المصادقة.
//
// كل ما هو خارج المستودع: الإعدادات والرمز والسجلات تعيش في
// ~/OZK-Archive-Bridge كي لا يدخل أي سر إلى Git، والكود وحده يبقى في المستودع.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ICLOUD_ROOT } from "./folders.mjs";

export const HOME_DIR = process.env.OZK_ARCHIVE_HOME || path.join(homedir(), "OZK-Archive-Bridge");
export const CONFIG_PATH = path.join(HOME_DIR, "config.json");
export const TOKEN_PATH = path.join(HOME_DIR, "token");
export const LOG_DIR = path.join(HOME_DIR, "logs");

export const DEFAULT_CONFIG = {
  port: 8787,
  host: "127.0.0.1",
  // الأصول المسموح لها بمخاطبة الجسر. هذا هو خط الدفاع الأول: أي صفحة ويب
  // أخرى يرفضها المتصفح في preflight قبل أن يصل الطلب إلى منطق الحفظ.
  allowedOrigins: [
    "https://ozktobacco.com",
    "https://www.ozktobacco.com",
    "https://ozkkhallouf-ux.github.io",
    "http://localhost:5173",
    "http://127.0.0.1:5173"
  ],
  // يسمح للصفحة المسموح أصلها بسحب الرمز مرة واحدة وحفظه محلياً (بلا خطوة يدوية).
  // اجعلها false لو أردت لصق الرمز يدوياً من ملف token.
  autoPair: true,
  icloudRoot: ICLOUD_ROOT,
  maxBodyBytes: 24 * 1024 * 1024,
  renderTimeoutMs: 30000,
  // مهلة إغلاق متصفح التحويل بعد آخر استعمال (توفير ذاكرة بلا إبطاء أول طلب).
  browserIdleMs: 5 * 60 * 1000,
  rateLimit: { windowMs: 60000, max: 60 }
};

function ensureHome() {
  if (!existsSync(HOME_DIR)) mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
}

export function loadConfig() {
  ensureHome();
  let stored = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      stored = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    } catch {
      // إعدادات تالفة: نتابع بالافتراضي بدل التوقف — الأرشفة ميزة مساعدة لا حرجة.
      stored = {};
    }
  } else {
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", { mode: 0o600 });
  }
  const config = { ...DEFAULT_CONFIG, ...stored };
  config.rateLimit = { ...DEFAULT_CONFIG.rateLimit, ...(stored.rateLimit || {}) };
  if (!Array.isArray(config.allowedOrigins) || !config.allowedOrigins.length) {
    config.allowedOrigins = DEFAULT_CONFIG.allowedOrigins;
  }
  return config;
}

/** يقرأ الرمز أو يولّده عند أول تشغيل. صلاحيات 600 لأنه سر محلي. */
export function loadToken() {
  ensureHome();
  if (existsSync(TOKEN_PATH)) {
    const value = readFileSync(TOKEN_PATH, "utf8").trim();
    if (value.length >= 32) return value;
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(TOKEN_PATH, token + "\n", { mode: 0o600 });
  chmodSync(TOKEN_PATH, 0o600);
  return token;
}
