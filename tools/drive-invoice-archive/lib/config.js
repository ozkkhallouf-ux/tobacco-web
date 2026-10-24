"use strict";
// إعداد عامل الأرشفة (`config.json` بجانب worker.js، خارج Git). الافتراضي آمن:
// dry-run يرصد ويولّد PDF محلياً فقط — لا Drive ولا تيليغرام.

const fs = require("fs");
const os = require("os");
const path = require("path");
const model = require("../../manual-a4-print/lib/invoice-model");

// قرار المالك 2026-10-24: الحساب الوحيد المخوّل بالأرشيف. أي قيمة أخرى في الإعداد
// تُرفض، فلا يستطيع ملف إعداد أن يحوّل أرشيف العملاء إلى حساب آخر.
const APPROVED_ACCOUNT = "ozkkhallouf@gmail.com";

const MODES = Object.freeze({
  "dry-run": { upload: false, notify: false }, // رصد + PDF محلي
  drive: { upload: true, notify: false },     // + رفع إلى Drive
  live: { upload: true, notify: true },       // + إشعار تيليغرام للمالك
});

const PROGRAM_DATA = process.env.ProgramData || process.env.PROGRAMDATA || path.join(os.homedir(), ".ozk");
const BASE_DIR = path.join(PROGRAM_DATA, "OZK", "DriveArchive");

const DEFAULTS = Object.freeze({
  mode: "dry-run",
  expectedAccountEmail: APPROVED_ACCOUNT,
  archiveFrom: "",              // إلزامي: أقدم تاريخ فاتورة يدخل الأرشيف (YYYY-MM-DD)
  allowedTypeGuids: model.DEFAULT_ALLOWED_TYPE_GUIDS,
  stableSeconds: 180,           // مهلة بلا تعديل قبل الأرشفة (لا نؤرشف فاتورة أثناء تحريرها)
  pollSeconds: 30,
  overlapSeconds: 600,
  reconcileMinutes: 30,
  lookbackDays: 60,
  maxAttempts: 8,
  failedCooldownMinutes: 60,    // الفاشل نهائياً يُعاد تلقائياً بعد ساعة (كما telegram_outbox)
  requireOfficialFont: true,
  edgeUrl: "",                  // https://<ref>.supabase.co/functions/v1/document-archive-notify
  reportSeconds: 300,
  dataDir: path.join(BASE_DIR, "data"),
  secretDir: BASE_DIR,
  browserPath: "",
  lockPort: 47617,
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validate(cfg) {
  const errors = [];
  if (!MODES[cfg.mode]) errors.push(`mode غير معروف: ${cfg.mode}`);
  if (String(cfg.expectedAccountEmail || "").trim().toLowerCase() !== APPROVED_ACCOUNT) {
    errors.push("expectedAccountEmail يجب أن يكون الحساب المعتمد وحده");
  }
  if (!DATE_RE.test(String(cfg.archiveFrom || ""))) errors.push("archiveFrom مطلوب بصيغة YYYY-MM-DD");
  if (model.allowedTypes(cfg).length === 0) errors.push("لا أنواع جملة مسموحة");
  for (const k of ["stableSeconds", "pollSeconds", "overlapSeconds", "reconcileMinutes", "lookbackDays", "maxAttempts", "reportSeconds"]) {
    if (!(Number(cfg[k]) > 0)) errors.push(`${k} يجب أن يكون موجباً`);
  }
  if (Number(cfg.stableSeconds) < 60) errors.push("stableSeconds لا يقل عن 60");
  if (MODES[cfg.mode] && MODES[cfg.mode].notify && !cfg.edgeUrl) errors.push("live يتطلب edgeUrl");
  if (errors.length) throw new Error(`إعداد غير صالح: ${errors.join("؛ ")}`);
  return cfg;
}

function loadConfig(file) {
  const target = file || process.env.OZK_DRIVE_ARCHIVE_CONFIG || path.join(__dirname, "..", "config.json");
  let user = {};
  if (fs.existsSync(target)) user = JSON.parse(fs.readFileSync(target, "utf8").replace(/^﻿/, ""));
  return validate({ ...DEFAULTS, ...user });
}

module.exports = { APPROVED_ACCOUNT, MODES, DEFAULTS, BASE_DIR, validate, loadConfig };
