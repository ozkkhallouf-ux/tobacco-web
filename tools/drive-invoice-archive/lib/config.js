"use strict";
// إعداد عامل الأرشفة (`config.json` بجانب worker.js، خارج Git). الافتراضي آمن:
// dry-run يرصد ويولّد PDF محلياً فقط — لا Drive ولا تيليغرام.

const crypto = require("crypto");
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
  notifyWaitSeconds: 60,        // حجز إشعار قائم (409 in_progress): انتظار ثابت بلا استهلاك محاولة
  failedCooldownMinutes: 60,    // الفاشل نهائياً يُعاد تلقائياً بعد ساعة (كما telegram_outbox)
  requireOfficialFont: true,
  edgeUrl: "",                  // https://<ref>.supabase.co/functions/v1/document-archive-notify
  reportSeconds: 300,
  dataDir: path.join(BASE_DIR, "data"),
  secretDir: BASE_DIR,
  browserPath: "",
  lockPort: 47617,
  // تجربة محصورة (لا للإنتاج): إن امتلأت القائمة لا يُرصد ولا يُرفع ولا يُرسَل ولا يُبلَّغ إلا
  // عن هذه الفواتير. تتطلب تاريخ انتهاء قريباً؛ بعده يرفض العامل العمل كلياً (لا يتسع بصمت
  // إلى كل الفواتير، ولا يبقى محصوراً بصمت في التشغيل الإنتاجي).
  pilotInvoiceGuids: [],
  pilotExpiresAt: "",           // YYYY-MM-DD، آخر يوم مسموح، ≤ PILOT_MAX_DAYS من اليوم
  // نطاق الإنتاج (الفواتير الجديدة وحدها): إلزامي للرفع أو الإرسال بلا حصر تجربة.
  //   newInvoicesFrom: لحظة التفعيل بساعة SQL نفسها (YYYY-MM-DDTHH:MM:SS، بلا منطقة) —
  //     لا تدخل إلا فاتورة CreateDate فيها ≥ هذه اللحظة. التاريخ المكتوب على الفاتورة
  //     (u.Date) يغيّره المستخدم، فلا يكفي وحده لاستبعاد القديم.
  //   baselineFile + baselineSha256: لقطة بمعرّفات كل فاتورة جملة موجودة لحظة التفعيل
  //     (node worker.js --baseline <ملف>). فاتورة في اللقطة لا تُرصد ولا تُرفع ولا يُرسل
  //     عنها ولا تُبلَّغ أبداً، مهما عُدّلت أو تغيّر تاريخها أو وقت إنشائها.
  newInvoicesFrom: "",
  baselineFile: "",
  baselineSha256: "",
});

const PILOT_MAX_GUIDS = 5;
const PILOT_MAX_DAYS = 7;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MOMENT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const BASELINE_SCHEMA = 1;

// اليوم بتوقيت دمشق (UTC+3) كي لا ينقلب الحكم على الانتهاء عند منتصف ليل UTC.
function damascusDay(nowMs) {
  return new Date(nowMs + 3 * 3600_000).toISOString().slice(0, 10);
}

// انقضاء التجربة يُفحص عند الإقلاع (validate) وقبل كل دورة (archiver.cycle)، فعملية
// بدأت قبل الانتهاء لا تتجاوز منتصف ليل آخر يوم.
function pilotExpired(cfg, nowMs) {
  return (cfg.pilotInvoiceGuids || []).length > 0 && String(cfg.pilotExpiresAt || "") < damascusDay(nowMs);
}

function validatePilot(cfg, nowMs, errors) {
  const list = cfg.pilotInvoiceGuids;
  if (!Array.isArray(list)) { errors.push("pilotInvoiceGuids يجب أن تكون قائمة"); return; }
  const expires = String(cfg.pilotExpiresAt || "");
  if (!list.length) {
    if (expires) errors.push("pilotExpiresAt بلا pilotInvoiceGuids");
    return;
  }
  if (list.length > PILOT_MAX_GUIDS) errors.push(`pilotInvoiceGuids لا تتجاوز ${PILOT_MAX_GUIDS}`);
  if (!list.every((g) => GUID_RE.test(String(g)))) errors.push("pilotInvoiceGuids: معرّفات GUID فقط");
  if (new Set(list.map((g) => String(g).toLowerCase())).size !== list.length) errors.push("pilotInvoiceGuids: معرّف مكرر");
  if (!DATE_RE.test(expires)) { errors.push("التجربة المحصورة تتطلب pilotExpiresAt بصيغة YYYY-MM-DD"); return; }
  const today = damascusDay(nowMs);
  const latest = damascusDay(nowMs + PILOT_MAX_DAYS * 86400_000);
  if (expires < today) errors.push(`انتهت التجربة المحصورة (${expires}): احذف pilotInvoiceGuids وpilotExpiresAt أو جدّدها بقرار المالك`);
  else if (expires > latest) errors.push(`pilotExpiresAt لا يتجاوز ${PILOT_MAX_DAYS} أيام`);
}

// بلا حصر تجربة، الرفع أو الإرسال لا يعمل إلا بنطاق الإنتاج كاملاً: لا يتسع العامل بصمت
// إلى كل فاتورة تاريخها ≥ archiveFrom (منها فواتير سبقت التفعيل).
function validateProduction(cfg, errors) {
  const from = String(cfg.newInvoicesFrom || "");
  const hasPilot = Array.isArray(cfg.pilotInvoiceGuids) && cfg.pilotInvoiceGuids.length > 0;
  if (!from) {
    if (cfg.baselineFile || cfg.baselineSha256) errors.push("baselineFile/baselineSha256 بلا newInvoicesFrom");
    if (!hasPilot && MODES[cfg.mode] && MODES[cfg.mode].upload) {
      errors.push("الرفع أو الإرسال بلا حصر تجربة يتطلب newInvoicesFrom وbaselineFile وbaselineSha256 (node worker.js --baseline)");
    }
    return;
  }
  if (!MOMENT_RE.test(from)) errors.push("newInvoicesFrom بصيغة YYYY-MM-DDTHH:MM:SS (ساعة SQL)");
  if (!cfg.baselineFile) errors.push("newInvoicesFrom يتطلب baselineFile");
  if (!SHA_RE.test(String(cfg.baselineSha256 || ""))) errors.push("baselineSha256 بصيغة sha256 (64 حرفاً صغيراً)");
}

// لقطة الأساس: الملف كما أُنشئ بـ--baseline، ببصمته المثبتة في الإعداد. أي اختلاف (بصمة،
// لحظة، عدد، معرّف غير صالح) يرفض الإقلاع، فلا يُفهم ملف تالف أو مستبدل على أنه «لا استبعاد».
function readBaseline(cfg) {
  const raw = fs.readFileSync(cfg.baselineFile);
  const sha = crypto.createHash("sha256").update(raw).digest("hex");
  if (sha !== cfg.baselineSha256) throw new Error(`إعداد غير صالح: بصمة baselineFile ${sha} لا تطابق baselineSha256`);
  const doc = JSON.parse(raw.toString("utf8").replace(/^\uFEFF/, ""));
  const guids = Array.isArray(doc && doc.guids) ? doc.guids : null;
  const errors = [];
  if (!doc || doc.schema !== BASELINE_SCHEMA) errors.push("مخطط لقطة الأساس غير معروف");
  if (!guids) errors.push("لقطة الأساس بلا guids");
  else {
    if (!guids.every((g) => GUID_RE.test(String(g)))) errors.push("لقطة الأساس: معرّفات GUID فقط");
    if (Number(doc.count) !== guids.length) errors.push("لقطة الأساس: count لا يطابق عدد المعرّفات");
  }
  if (doc && doc.newInvoicesFrom !== cfg.newInvoicesFrom) errors.push("لقطة الأساس أُخذت للحظة غير newInvoicesFrom");
  if (errors.length) throw new Error(`إعداد غير صالح: ${errors.join("؛ ")}`);
  return guids.map((g) => String(g).toLowerCase());
}

function validate(cfg, nowMs = Date.now()) {
  const errors = [];
  validatePilot(cfg, nowMs, errors);
  validateProduction(cfg, errors);
  if (!MODES[cfg.mode]) errors.push(`mode غير معروف: ${cfg.mode}`);
  if (String(cfg.expectedAccountEmail || "").trim().toLowerCase() !== APPROVED_ACCOUNT) {
    errors.push("expectedAccountEmail يجب أن يكون الحساب المعتمد وحده");
  }
  if (!DATE_RE.test(String(cfg.archiveFrom || ""))) errors.push("archiveFrom مطلوب بصيغة YYYY-MM-DD");
  if (model.allowedTypes(cfg).length === 0) errors.push("لا أنواع جملة مسموحة");
  for (const k of ["stableSeconds", "pollSeconds", "overlapSeconds", "reconcileMinutes", "lookbackDays", "maxAttempts", "reportSeconds", "notifyWaitSeconds"]) {
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
  const cfg = validate({ ...DEFAULTS, ...user });
  cfg.baselineGuids = cfg.newInvoicesFrom ? readBaseline(cfg) : [];
  return cfg;
}

module.exports = { APPROVED_ACCOUNT, MODES, DEFAULTS, BASE_DIR, PILOT_MAX_DAYS, BASELINE_SCHEMA, pilotExpired, validate, readBaseline, loadConfig };
