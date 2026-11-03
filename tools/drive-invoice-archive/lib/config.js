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

// نوع «سند قبض» الوحيد في AmnDb002 (discover-receipts.js، 2026-11-03: 517 سنداً في 90 يوماً).
const RECEIPT_TYPE_GUID = "a83da629-4a8b-4c2c-9d7a-a963de3640a5";

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
  // سندات القبض (المرحلة 2، قرار المالك 2026-11-03): مستند مستقل لكل زبون في كل سند. مطفأة
  // افتراضياً: تحديث الكود وحده لا يرصد سنداً. نطاقها مستقل عن الفواتير بالقواعد نفسها: الرفع
  // أو الإرسال بلا حصر تجربة يتطلب لحظة تفعيل (py000.CreateDate) ولقطة أساس للسندات
  // (node worker.js --baseline-receipts <ملف>)، فلا يُرسل أي سند سبق التفعيل.
  receipts: Object.freeze({
    enabled: false,
    typeGuid: RECEIPT_TYPE_GUID,  // et000 «سند قبض» (مثبت بالاكتشاف على AmnDb002)
    archiveFrom: "",              // فارغ ⇒ archiveFrom العام
    newReceiptsFrom: "",
    baselineFile: "",
    baselineSha256: "",
    pilotGuids: [],               // معرّفات سندات py000 (لا معرّفات المستندات المشتقة)
    pilotExpiresAt: "",
  }),
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

function receiptsPilotExpired(cfg, nowMs) {
  const r = cfg.receipts || {};
  return Boolean(r.enabled) && (r.pilotGuids || []).length > 0 && String(r.pilotExpiresAt || "") < damascusDay(nowMs);
}

function validatePilot(cfg, nowMs, errors, { list = cfg.pilotInvoiceGuids, expiresAt = cfg.pilotExpiresAt, name = "pilotInvoiceGuids", expName = "pilotExpiresAt" } = {}) {
  if (!Array.isArray(list)) { errors.push(`${name} يجب أن تكون قائمة`); return; }
  const expires = String(expiresAt || "");
  if (!list.length) {
    if (expires) errors.push(`${expName} بلا ${name}`);
    return;
  }
  if (list.length > PILOT_MAX_GUIDS) errors.push(`${name} لا تتجاوز ${PILOT_MAX_GUIDS}`);
  if (!list.every((g) => GUID_RE.test(String(g)))) errors.push(`${name}: معرّفات GUID فقط`);
  if (new Set(list.map((g) => String(g).toLowerCase())).size !== list.length) errors.push(`${name}: معرّف مكرر`);
  if (!DATE_RE.test(expires)) { errors.push(`التجربة المحصورة تتطلب ${expName} بصيغة YYYY-MM-DD`); return; }
  const today = damascusDay(nowMs);
  const latest = damascusDay(nowMs + PILOT_MAX_DAYS * 86400_000);
  if (expires < today) errors.push(`انتهت التجربة المحصورة (${expires}): احذف ${name} و${expName} أو جدّدها بقرار المالك`);
  else if (expires > latest) errors.push(`${expName} لا يتجاوز ${PILOT_MAX_DAYS} أيام`);
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
function readBaseline(cfg, { file = cfg.baselineFile, sha256: expected = cfg.baselineSha256, momentKey = "newInvoicesFrom", moment = cfg.newInvoicesFrom, kind = undefined } = {}) {
  const raw = fs.readFileSync(file);
  const sha = crypto.createHash("sha256").update(raw).digest("hex");
  if (sha !== expected) throw new Error(`إعداد غير صالح: بصمة ملف لقطة الأساس ${sha} لا تطابق البصمة المثبتة`);
  const doc = JSON.parse(raw.toString("utf8").replace(/^\uFEFF/, ""));
  const guids = Array.isArray(doc && doc.guids) ? doc.guids : null;
  const errors = [];
  if (!doc || doc.schema !== BASELINE_SCHEMA) errors.push("مخطط لقطة الأساس غير معروف");
  if (!guids) errors.push("لقطة الأساس بلا guids");
  else {
    if (!guids.every((g) => GUID_RE.test(String(g)))) errors.push("لقطة الأساس: معرّفات GUID فقط");
    if (Number(doc.count) !== guids.length) errors.push("لقطة الأساس: count لا يطابق عدد المعرّفات");
  }
  if (doc && doc[momentKey] !== moment) errors.push(`لقطة الأساس أُخذت للحظة غير ${momentKey}`);
  if (doc && doc.kind !== kind) errors.push("لقطة الأساس لنوع مستند آخر");
  if (errors.length) throw new Error(`إعداد غير صالح: ${errors.join("؛ ")}`);
  return guids.map((g) => String(g).toLowerCase());
}

// سندات القبض: لا تُفحص قيودها إلا مفعّلة، والمطفأة لا تقبل نطاقاً نصف مضبوط بصمت.
function validateReceipts(cfg, nowMs, errors) {
  const r = cfg.receipts;
  if (r === undefined) return; // إعداد مبني يدوياً بلا المفتاح ⇒ مطفأة
  if (!r || typeof r !== "object") { errors.push("receipts يجب أن يكون كائناً"); return; }
  if (!r.enabled) return;
  if (!GUID_RE.test(String(r.typeGuid || ""))) errors.push("receipts.typeGuid: معرّف GUID");
  if (r.archiveFrom && !DATE_RE.test(String(r.archiveFrom))) errors.push("receipts.archiveFrom بصيغة YYYY-MM-DD");
  validatePilot(cfg, nowMs, errors, { list: r.pilotGuids, expiresAt: r.pilotExpiresAt, name: "receipts.pilotGuids", expName: "receipts.pilotExpiresAt" });
  const from = String(r.newReceiptsFrom || "");
  const hasPilot = Array.isArray(r.pilotGuids) && r.pilotGuids.length > 0;
  if (!from) {
    if (r.baselineFile || r.baselineSha256) errors.push("receipts.baselineFile/baselineSha256 بلا receipts.newReceiptsFrom");
    if (!hasPilot && MODES[cfg.mode] && MODES[cfg.mode].upload) {
      errors.push("رفع سندات القبض أو إرسالها بلا حصر تجربة يتطلب receipts.newReceiptsFrom وbaselineFile وbaselineSha256 (node worker.js --baseline-receipts)");
    }
    return;
  }
  if (!MOMENT_RE.test(from)) errors.push("receipts.newReceiptsFrom بصيغة YYYY-MM-DDTHH:MM:SS (ساعة SQL)");
  if (!r.baselineFile) errors.push("receipts.newReceiptsFrom يتطلب receipts.baselineFile");
  if (!SHA_RE.test(String(r.baselineSha256 || ""))) errors.push("receipts.baselineSha256 بصيغة sha256 (64 حرفاً صغيراً)");
}

function validate(cfg, nowMs = Date.now()) {
  const errors = [];
  validatePilot(cfg, nowMs, errors);
  validateProduction(cfg, errors);
  validateReceipts(cfg, nowMs, errors);
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

// دمج سطحي كما كان، وكائن receipts يُدمج مع افتراضه (إعداد قديم بلا المفتاح ⇒ مطفأة).
function mergeConfig(user) {
  const u = user || {};
  return { ...DEFAULTS, ...u, receipts: { ...DEFAULTS.receipts, ...u.receipts } };
}

function loadConfig(file) {
  const target = file || process.env.OZK_DRIVE_ARCHIVE_CONFIG || path.join(__dirname, "..", "config.json");
  let user = {};
  if (fs.existsSync(target)) user = JSON.parse(fs.readFileSync(target, "utf8").replace(/^﻿/, ""));
  const cfg = validate(mergeConfig(user));
  cfg.baselineGuids = cfg.newInvoicesFrom ? readBaseline(cfg) : [];
  const r = cfg.receipts;
  r.baselineGuids = r.enabled && r.newReceiptsFrom
    ? readBaseline(cfg, { file: r.baselineFile, sha256: r.baselineSha256, momentKey: "newReceiptsFrom", moment: r.newReceiptsFrom, kind: "receipt" })
    : [];
  return cfg;
}

module.exports = { APPROVED_ACCOUNT, RECEIPT_TYPE_GUID, MODES, DEFAULTS, BASE_DIR, PILOT_MAX_DAYS, BASELINE_SCHEMA, pilotExpired, receiptsPilotExpired, validate, readBaseline, mergeConfig, loadConfig };
