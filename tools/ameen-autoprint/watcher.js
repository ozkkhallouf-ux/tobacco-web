"use strict";
// ============================================================
// watcher.js — مراقب فواتير مبيعات الجملة
// يراقب قاعدة الأمين كل 5 ثوانٍ ويطبع كل فاتورة جملة جديدة
// على طابعة كانون (A4) بنفس تصميم الفاتورة المرسلة للزبائن
// ============================================================

const fs   = require("fs");
const path = require("path");
const os   = require("os");
const { execSync, spawnSync } = require("child_process");
const sql  = require("mssql");
const puppeteer = require("puppeteer");
const config = require("./config");
const { buildInvoiceHtml } = require("./invoice-html");

const SALES_QUERY = fs.readFileSync(
  path.join(__dirname, "ameen-sales-query.sql"), "utf8"
);

// رصيد الزبون الحقيقي من دفتر أستاذ الأمين (cu000.Debit - Credit عبر AccountGUID)
// نفس منطق Get-InvoiceDocumentBalance في ozk-print-bridge.ps1 — لا ربط باسم الزبون
const CUSTOMER_BALANCE_QUERY = fs.readFileSync(
  path.join(__dirname, "ameen-customer-balance-query.sql"), "utf8"
);

// يُعيد null إذا تعذّر العثور على مستند محاسبي حقيقي مرتبط بهذه الفاتورة —
// في هذه الحالة يجب على طبقة العرض عدم اختلاق أي رقم رصيد.
//
// ملاحظة Codex P1 على PR #208: فشل الاستعلام نفسه (SQL/اتصال/timeout) لا يجوز
// أن يُبتلع ويتحول إلى null/"غير متاح" مثل حالة "لا يوجد مستند محاسبي" —
// فالأولى فشل تقني عابر يستحق إعادة محاولة، والثانية نتيجة عمل صحيحة نهائية.
// لذا لا نلتقط أخطاء الاستعلام هنا؛ نتركها تنتشر إلى poll() حيث تُسجَّل ولا
// تُطبع الفاتورة ولا تُعلَّم، فتُعاد محاولتها تلقائياً في دورة poll() التالية
// (بلا حلقة انتظار داخلية وبلا إيقاف المراقب).
async function getCustomerBalance(pool, invoiceGuid) {
  const result = await pool.request()
    .input("invoiceGuid", sql.UniqueIdentifier, invoiceGuid)
    .query(CUSTOMER_BALANCE_QUERY);
  if (!result.recordset.length) return null;
  const row = result.recordset[0];
  if (row.document_current === null || row.document_current === undefined) return null;
  const current = Number(row.document_current);
  // حارس: لا نقبل أي قيمة غير رقمية حقيقية (NaN/Infinity/-Infinity) كرصيد —
  // الصفر الحقيقي (0) يبقى قيمة صالحة ويُعرض كصفر.
  if (!Number.isFinite(current)) return null;
  return {
    accountGuid: row.account_guid,
    current,
  };
}

// ─── حراسة صريحة: هذه الأداة مخصّصة حصراً لمبيعات الجملة ─────────────────
// GUID مبيعات المركز (الكاشير) — يُرفض صراحة كي لا تُستخدم هذه الأداة له أبداً
const CASHIER_RETAIL_TYPE_GUID = "cc1097b1-662d-4d80-8e4e-3b493249591c";
// قائمة GUIDs الجملة المعتمدة (من ozk-print-bridge.ps1 — نفس مصدر الحقيقة)
const APPROVED_WHOLESALE_TYPE_GUIDS = [
  "7f5b0921-61f3-4f23-a1f4-fbfae4144bf4",
  "4a827bee-6ae1-4474-802b-970068872fcc",
];

function assertWholesaleConfig() {
  const guid = String(config.wholesaleTypeGuid || "").toLowerCase();
  if (guid === CASHIER_RETAIL_TYPE_GUID.toLowerCase()) {
    throw new Error(
      "رفض قاطع: wholesaleTypeGuid في config.js يطابق GUID مبيعات المركز (الكاشير). "
      + "هذه الأداة مخصّصة للجملة فقط ولن تعمل."
    );
  }
  if (!APPROVED_WHOLESALE_TYPE_GUIDS.map((g) => g.toLowerCase()).includes(guid)) {
    throw new Error(
      `رفض: wholesaleTypeGuid (${config.wholesaleTypeGuid}) ليس ضمن أنواع الجملة المعتمدة. `
      + "لن تُطبع أي فاتورة حتى يُصحَّح config.js."
    );
  }
}

// ─── حراسة صريحة: طابعة Canon الفيزيائية يجب أن تكون موجودة ومتصلة ────────
// يُمنع الاعتماد على default printer، ويُمنع أي منفذ RDP/Terminal-Services معاد توجيهه.
//
// تصنيف الأعطال (ملاحظة Codex P1 على PR #208):
//   • عطل إعداد دائم  ⇒ يبقى قاتلاً كما كان: اسم طابعة غير موجود في Windows، أو
//     منفذ معاد توجيهه عبر RDP. لا معنى لإعادة المحاولة — يحتاج تدخّل إنسان.
//     (متسق مع assertWholesaleConfig التي ترمي فوراً على GUID خاطئ.)
//   • عطل عابر ⇒ يُعاد فحصه دورياً بلا إنهاء المراقب: WorkOffline=true (طابعة
//     Wi-Fi لم تلحق بالإقلاع)، أو فشل/مهلة PowerShell نفسه (خدمة CIM لم تجهز بعد
//     عند الإقلاع). كلاهما يزول وحده متى عادت الطابعة، وإنهاء العملية بسببهما كان
//     يترك المراقب ميتاً حتى إقلاع جديد لأن install-service.bat يستخدم /sc ONSTART
//     بلا أي سياسة إعادة تشغيل عند الفشل.
//
// في الحالتين لا طباعة إطلاقاً ما لم تكن الطابعة جاهزة، ولا سقوط إلى أي طابعة أخرى.

// إعادة المحاولة محدودة: تبدأ من 15 ثانية (نفس فاصل إعادة اتصال SQL) وتتضاعف حتى
// سقف 5 دقائق، فلا تصاعد بلا حد ولا busy-loop.
const PRINTER_RETRY_MIN_MS = 15_000;
const PRINTER_RETRY_MAX_MS = 300_000;
// مدة صلاحية نتيجة «جاهزة» قبل إعادة الفحص — تمنع استدعاء PowerShell كل دورة (5 ثوانٍ).
const PRINTER_READY_TTL_MS = 30_000;

// خطأ إعداد دائم: يُميَّز بعلامة صريحة كي لا تبتلعه حلقة الأخطاء العامة في main().
function printerConfigError(message) {
  const err = new Error(message);
  err.fatalPrinterConfig = true;
  return err;
}

// يفحص الطابعة مرة واحدة. يرمي عند عطل إعداد دائم، ويعيد {ready,reason} خلاف ذلك.
function probePhysicalPrinter() {
  const printer = config.printerName;
  const ps = `
    $p = Get-CimInstance Win32_Printer | Where-Object { $_.Name -eq '${printer.replace(/'/g, "''")}' }
    if (-not $p) { Write-Output 'NOT_FOUND'; exit 0 }
    Write-Output ("FOUND|" + $p.PortName + "|" + $p.WorkOffline + "|" + $p.PrinterStatus)
  `;
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    timeout: 15_000,
    encoding: "utf8",
  });
  const out = (r.stdout || "").trim();

  // اسم غير موجود = خطأ إعداد دائم (config.js خاطئ أو الطابعة غير مثبّتة أصلاً).
  if (out === "NOT_FOUND") {
    throw printerConfigError(
      `رفض قاطع: الطابعة "${printer}" غير موجودة في Windows. `
      + "لن تُطبع أي فاتورة جملة ولن يُستخدم أي fallback لطابعة أخرى أو للطابعة الافتراضية."
    );
  }
  // فشل الاستعلام نفسه ليس دليلاً على غياب الطابعة — عابر، يُعاد فحصه.
  if (r.status !== 0 || !out) {
    return { ready: false, reason: "تعذّر الاستعلام عن حالة الطابعة من Windows (PowerShell/CIM غير جاهز بعد)" };
  }

  const [, port, workOffline] = out.split("|");
  if (/^TS\d/i.test(port) || /redirected/i.test(printer)) {
    throw printerConfigError(
      `رفض قاطع: الطابعة "${printer}" على منفذ "${port}" يبدو معاد توجيهه عبر جلسة عن بُعد (RDP)، `
      + "وليس المنفذ الفيزيائي المباشر. لن تُطبع أي فاتورة جملة."
    );
  }
  if (String(workOffline).trim().toLowerCase() === "true") {
    return { ready: false, reason: `الطابعة "${printer}" غير متصلة حالياً (Work Offline)` };
  }
  return { ready: true, reason: "" };
}

// بوّابة الجاهزية: تُبقي المراقب حياً أثناء العطل العابر، وتمنع أي طباعة خلاله.
// deps تُحقن كاملة في الاختبارات (probe/now/log) فلا حاجة لطابعة أو Windows.
function createPrinterGate(deps) {
  const d = deps || {};
  const probe = d.probe || probePhysicalPrinter;
  const now = d.now || (() => Date.now());
  const log = d.log || console;
  const minRetryMs = d.minRetryMs || PRINTER_RETRY_MIN_MS;
  const maxRetryMs = d.maxRetryMs || PRINTER_RETRY_MAX_MS;
  const readyTtlMs = d.readyTtlMs === undefined ? PRINTER_READY_TTL_MS : d.readyTtlMs;

  let offlineSince = null;   // متى بدأ العطل العابر (null = جاهزة)
  let nextProbeAt = 0;       // لا فحص قبل هذه اللحظة — يمنع الـbusy-loop
  let backoffMs = minRetryMs;
  let lastReason = "";
  let readyUntil = 0;        // نافذة صلاحية نتيجة «جاهزة»

  // true فقط عندما تكون الطابعة جاهزة فعلاً. لا تطبع أي شيء إن أعادت false.
  function ready() {
    const t = now();
    if (offlineSince === null && t < readyUntil) return true;
    if (offlineSince !== null && t < nextProbeAt) return false;

    const r = probe(); // يرمي عند عطل إعداد دائم — يمرّ للأعلى عمداً
    if (r.ready) {
      if (offlineSince !== null) {
        const secs = Math.max(1, Math.round((t - offlineSince) / 1000));
        log.log(`الطابعة "${config.printerName}" عادت جاهزة بعد ${secs} ثانية — تستأنف المراقبة.`);
      }
      offlineSince = null;
      backoffMs = minRetryMs;
      lastReason = "";
      readyUntil = t + readyTtlMs;
      return true;
    }

    // تسجيل عند بداية العطل وعند تغيّر سببه فقط — لا تكرار كل دورة.
    if (offlineSince === null || r.reason !== lastReason) {
      log.warn(
        `تعليق الطباعة: ${r.reason}. لن تُطبع أي فاتورة ولن تُستخدم أي طابعة بديلة. `
        + `إعادة الفحص بعد ${Math.round(backoffMs / 1000)} ثانية.`
      );
    }
    if (offlineSince === null) offlineSince = t;
    lastReason = r.reason;
    nextProbeAt = t + backoffMs;
    backoffMs = Math.min(backoffMs * 2, maxRetryMs);
    return false;
  }

  function isOffline() {
    return offlineSince !== null;
  }

  return { ready, isOffline };
}

// البوّابة الوحيدة التي تقرّر هل يُسمح بالطباعة الآن.
const printerGate = createPrinterGate();

// ─── تحليل سلسلة الاتصال (ODBC style → mssql config) ─────────────────────
function parseSqlConnStr(cs) {
  const kv = {};
  cs.split(";").forEach((part) => {
    const eq = part.indexOf("=");
    if (eq > 0) {
      let val = part.slice(eq + 1).trim();
      // إزالة علامتَي الاقتباس المحيطتين بالقيمة إن وُجدتا (نمط ODBC القياسي)
      if (val.length >= 2 && val[0] === '"' && val[val.length - 1] === '"') {
        val = val.slice(1, -1);
      }
      kv[part.slice(0, eq).trim().toLowerCase()] = val;
    }
  });
  const cfg = {
    server:   kv["server"] || kv["data source"] || "localhost",
    database: kv["database"] || kv["initial catalog"] || "AmnDb002",
    options: {
      trustedConnection:      /^(true|yes|1)$/i.test(kv["trusted_connection"]),
      trustServerCertificate: true,
      enableArithAbort:       true,
    },
    connectionTimeout: 30_000,
    requestTimeout:    45_000,
  };
  if (!cfg.options.trustedConnection) {
    cfg.user     = kv["user id"] || kv["uid"] || "";
    cfg.password = kv["password"] || kv["pwd"] || "";
  }
  return cfg;
}

// ─── إدارة الحالة ─────────────────────────────────────────────────────────
//
// نافذتان يجب أن تبقيا متّسقتين، وعدم اتّساقهما كان سبب عطل «إعادة طباعة فواتير
// قديمة»:
//   • نافذة الاستعلام  — كل فاتورة تاريخها >= state.watchFromDate.
//   • ذاكرة الـdedup   — علامات state.printedGuids، تُحذف بعد PRINTED_RETENTION_DAYS.
//
// كانت watchFromDate تُضبط مرة واحدة يوم التثبيت ولا تتقدّم أبداً، فتكبر نافذة
// الاستعلام بلا حد بينما الذاكرة محدودة بسبعة أيام. فما إن تُحذف علامة فاتورة
// حتى يعيدها الاستعلام كأنها جديدة فتُطبع ثانية — وتأخذ ختماً زمنياً جديداً
// فتُنسى بعد سبعة أيام أخرى وتُطبع من جديد، بلا نهاية. والأسوأ أن إعادة الطباعة
// نفسها ترفع changed فتُشغّل prune مرة أخرى في الدورة نفسها، فتتحوّل إلى شلّال.
//
// الشرط الصارم: نافذة الاستعلام يجب أن تبقى **أقصر** من ذاكرة الـdedup، كي لا
// يعود الاستعلام بفاتورة نُسيت علامتها أبداً.
const WATCH_LOOKBACK_DAYS = 2;      // أبعد ما ينظر إليه الاستعلام إلى الوراء
const PRINTED_RETENTION_DAYS = 7;   // مدة الاحتفاظ بعلامة «طُبعت»
const DAY_MS = 24 * 60 * 60 * 1000;

// حارس بنيوي يمنع إعادة إدخال العطل بتعديل لاحق على أحد الرقمين وحده.
// الهامش (3 أيام) يغطّي فاتورة مؤرَّخة بالغد (الاستعلام يقبلها) طُبعت اليوم.
function assertDedupWindowInvariant() {
  if (PRINTED_RETENTION_DAYS < WATCH_LOOKBACK_DAYS + 3) {
    throw new Error(
      `رفض قاطع: PRINTED_RETENTION_DAYS (${PRINTED_RETENTION_DAYS}) يجب أن تتجاوز `
      + `WATCH_LOOKBACK_DAYS (${WATCH_LOOKBACK_DAYS}) بثلاثة أيام على الأقل، وإلا `
      + "أعاد الاستعلام فواتير حُذفت علاماتها فطُبعت من جديد."
    );
  }
}

// تاريخ محلّي YYYY-MM-DD. لا يجوز استعمال toISOString هنا: هو بتوقيت UTC بينما
// u.Date وGETDATE() في الأمين بالتوقيت المحلّي (دمشق UTC+3)، فبين منتصف الليل
// والثالثة فجراً يعطي UTC تاريخ الأمس فتتّسع النافذة يوماً كاملاً بلا قصد.
function localDateStr(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// تقدّم بداية النافذة مع مرور الأيام، ولا تتراجع بها أبداً.
// تُعيد التاريخ السابق عند التقدّم فعلاً، و null إن لم يتغيّر شيء.
function advanceWatchFromDate(state, nowMs = Date.now()) {
  const floor = localDateStr(nowMs - WATCH_LOOKBACK_DAYS * DAY_MS);
  const current = String(state.watchFromDate || "");
  if (current && current >= floor) return null;
  state.watchFromDate = floor;
  return current || "(غير مضبوط)";
}

function loadState() {
  let raw;
  try { raw = fs.readFileSync(config.stateFilePath, "utf8"); }
  catch { return null; }  // لا ملف بعد — أول تشغيل، وهذه ليست حالة عطل
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object"
        || !parsed.printedGuids || typeof parsed.printedGuids !== "object"
        || !/^\d{4}-\d{2}-\d{2}$/.test(String(parsed.watchFromDate || ""))) {
      throw new Error("بنية ملف الحالة غير صالحة");
    }
    return parsed;
  } catch (err) {
    // ملف موجود لكنه غير صالح ≠ أول تشغيل: يُسجَّل صراحةً لأن البدء من الصفر
    // يعني إعادة طباعة فواتير اليوم، ولا يجوز أن يمرّ ذلك صامتاً.
    console.error(
      `تحذير: ملف الحالة "${config.stateFilePath}" غير صالح (${describeError(err)}) — `
      + "تبدأ المراقبة من اليوم، وقد تُعاد طباعة فواتير اليوم المطبوعة سابقاً."
    );
    return null;
  }
}

function saveState(state) {
  // كتابة ذرّية: انقطاع أثناء writeFileSync يترك ملفاً مبتوراً، فيُقرأ لاحقاً
  // كأنه أول تشغيل وتُعاد طباعة فواتير اليوم كلها. الملف المؤقّت بجانب الأصل
  // (نفس القرص) فيكون rename ذرّياً فعلاً.
  const tmpPath = `${config.stateFilePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmpPath, config.stateFilePath);
}

// حذف علامات الطباعة الأقدم من PRINTED_RETENTION_DAYS لمنع تضخّم الملف.
// آمن فقط لأن النافذة أقصر منها (assertDedupWindowInvariant): كل علامة تُحذف
// هنا تخصّ فاتورة خرجت أصلاً من نافذة الاستعلام فلن يعيدها أبداً.
function pruneOldGuids(state) {
  const cutoff = Date.now() - PRINTED_RETENTION_DAYS * DAY_MS;
  for (const [guid, ts] of Object.entries(state.printedGuids)) {
    if (ts < cutoff) delete state.printedGuids[guid];
  }
}

// ─── قفل النسخة الواحدة ───────────────────────────────────────────────────
// نسختان من المراقب على نفس ملف الحالة = طباعة مزدوجة مضمونة، وهي تبدو
// للمستخدم «فواتير قديمة تُطبع من جديد». السبب أن كل نسخة تُحمّل الحالة إلى
// الذاكرة مرة واحدة عند الإقلاع ثم تكتب الكائن **كاملاً**، فكتابة الثانية
// تدهس علامات الأولى (lost update) فتعود الفواتير غير مُعلَّمة فتُطبع مرتين.
// والكتابة الذرّية لا تحمي من هذا إطلاقاً: هي تمنع الملف المبتور لا الدهس.
//
// وهذا ليس احتمالاً نظرياً — المستودع نفسه يوفّر مسارَي تشغيل على نفس الملف:
// المهمة المجدولة "OZK-AmeenAutoPrint" (تعمل كـSYSTEM عند الإقلاع عبر
// install-service.bat) و`start.bat` اليدوي. تشغيل الثاني للتحقق «هل يعمل؟»
// بينما الأولى تعمل يكفي لإنتاج العطل.
const LOCK_STALE_HINT_MS = 10 * 60 * 1000;

function lockHeldError(message) {
  const err = new Error(message);
  err.fatalLockHeld = true;
  return err;
}

// true = العملية موجودة. EPERM تعني موجودة لكن بمستخدم آخر (SYSTEM مقابل
// المستخدم المسجَّل) — وهي بالضبط الحالة التي يجب كشفها لا تجاهلها.
function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) { return Boolean(err) && err.code === "EPERM"; }
}

function lockFilePath() {
  return `${config.stateFilePath}.lock`;
}

// يرمي fatalLockHeld إن كانت نسخة حيّة تحمل القفل. القفل المتروك من عملية
// ميتة (انقطاع كهرباء) يُستولى عليه تلقائياً فلا يبقى المراقب معطّلاً للأبد.
function acquireSingleInstanceLock(nowMs = Date.now()) {
  const lockPath = lockFilePath();
  let existing = null;
  try { existing = JSON.parse(fs.readFileSync(lockPath, "utf8")); }
  catch { existing = null; }

  const pid = existing ? Number(existing.pid) : NaN;
  if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && processAlive(pid)) {
    const beat = Number(existing.heartbeatAt) || 0;
    const ageText = beat
      ? `آخر نبضة قبل ${Math.max(0, Math.round((nowMs - beat) / 1000))} ثانية`
      : "بلا نبضة مسجَّلة";
    const staleHint = beat && (nowMs - beat) > LOCK_STALE_HINT_MS
      ? " النبضة قديمة جداً، فقد تكون العملية بهذا الرقم برنامجاً آخر لا المراقب."
      : "";
    throw lockHeldError(
      `رفض قاطع: نسخة أخرى من المراقب تحمل القفل (PID ${pid}، ${ageText}).`
      + " تشغيل نسختين على نفس ملف الحالة يسبّب طباعة الفاتورة مرتين."
      + ` أوقف النسخة الأخرى — أو المهمة "OZK-AmeenAutoPrint" —  ثم أعد التشغيل.${staleHint}`
      + ` وإن تأكّدت أن العملية ${pid} ليست المراقب، احذف الملف: ${lockPath}`
    );
  }

  const writeLock = (beatMs) => {
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      host: os.hostname(),
      startedAt: new Date(nowMs).toISOString(),
      heartbeatAt: beatMs,
    }, null, 2), "utf8");
  };
  writeLock(nowMs);

  let released = false;
  return {
    path: lockPath,
    // نبضة كل دورة: تُميّز مراقباً حيّاً من رقم عملية أُعيد استخدامه.
    beat(t = Date.now()) { try { writeLock(t); } catch {} },
    // لا يُحذف إلا قفلنا نحن — كي لا تحذف نسخةٌ فاشلة قفل النسخة العاملة.
    release() {
      if (released) return;
      released = true;
      try {
        const cur = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        if (Number(cur.pid) === process.pid) fs.unlinkSync(lockPath);
      } catch {}
    },
  };
}

// فشل حفظ الحالة عطل حرج لا تحذير عابر: الفواتير طُبعت فعلاً وعلاماتها في
// الذاكرة وحدها، فأي إعادة تشغيل بعده يُعيد طباعتها كلها. يقع فعلاً حين
// يُنشئ SYSTEM ملف الحالة ثم يُشغَّل start.bat بمستخدم لا يملك حق الكتابة،
// أو حين يمتلئ القرص. لا يُرمى: الطباعة نجحت فعلاً ووقف الدورة لا يصلح شيئاً،
// لكنه يجب أن يكون مستحيل التفويت في السجل.
function persistState(state) {
  try {
    saveState(state);
    return true;
  } catch (err) {
    console.error(
      `!! عطل حرج: تعذّر حفظ ملف الحالة "${config.stateFilePath}" — ${describeError(err)}.`
      + " الفواتير المطبوعة لن تبقى مُعلَّمة بعد إعادة التشغيل فستُطبع من جديد."
      + " تحقّق من صلاحيات الكتابة على المجلد ومن مساحة القرص."
    );
    return false;
  }
}

// ─── تسمية العملة ────────────────────────────────────────────────────────
// USD → «$ 1,350»   ·   SYP أو مجهول → «1,350 ل.س»   ·   غيرهما → الرمز ISO.
// مصدر التسمية هو my000.CurrencyISO للفاتورة نفسها، لا نص ثابت.
function formatMoneyWithCurrency(value, currencyIso) {
  const n = Number(value).toLocaleString("en-US", { maximumFractionDigits: 3 });
  const iso = String(currencyIso || "").trim().toUpperCase();
  if (iso === "USD") return `$ ${n}`;
  if (iso === "SYP" || iso === "") return `${n} ل.س`;
  return `${n} ${iso}`;
}

// ─── تجميع الصفوف المسطّحة إلى فواتير ────────────────────────────────────
function groupIntoInvoices(rows) {
  const map = new Map();
  for (const row of rows) {
    const guid = row.invoice_guid;
    if (!map.has(guid)) {
      // عملة الفاتورة: الأمين يخزّن المبالغ بعملة الأساس (دولار). المبلغ المعروض
      // = الخام ÷ CurrencyVal — نفس منطق Convert-ToReceiptAmount في خط الكاشير.
      // فاتورة بالدولار: CurrencyVal = 1 فلا يتغيّر شيء. بالليرة: ÷0.00007547.
      const cv = Number(row.currency_val) > 0 ? Number(row.currency_val) : 1;
      map.set(guid, {
        guid:     guid,
        number:   row.invoice_number,
        date:     row.invoice_date,
        customer: (row.customer_name || "").trim(),
        total:    Number(row.total) / cv,
        discount: Number(row.discount) / cv,
        firstPay: Number(row.first_pay) / cv,
        currencyVal: cv,
        currencyIso: String(row.currency_iso || "").trim().toUpperCase(),
        items:    [],
      });
    }
    const item = map.get(guid);
    if ((row.item_name || "").trim()) {
      item.items.push({
        name:  row.item_name,
        unit:  row.unit_name,
        qty:   Number(row.display_qty),
      });
    }
  }
  // ترتيب زمني تصاعدي (الأقدم يُطبع أولاً)
  return [...map.values()].sort(
    (a, b) => a.date !== b.date
      ? a.date.localeCompare(b.date)
      : Number(a.number) - Number(b.number)
  );
}

// ─── الطباعة ──────────────────────────────────────────────────────────────
let _browser = null;

async function getBrowser() {
  if (_browser && _browser.connected) return _browser;
  _browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  return _browser;
}

async function htmlToPdf(htmlContent, pdfPath) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(htmlContent, { waitUntil: "networkidle0" });
    await page.pdf({
      path:            pdfPath,
      format:          "A4",
      printBackground: true,
      margin: { top: "12mm", bottom: "12mm", left: "12mm", right: "12mm" },
    });
  } finally {
    await page.close();
  }
}

function sendToPrinter(pdfPath) {
  const printer = config.printerName;

  // الأولوية: SumatraPDF — طباعة صامتة 100% بدون نوافذ
  if (fs.existsSync(config.sumatraPath)) {
    execSync(
      `"${config.sumatraPath}" -print-to "${printer}" -silent "${pdfPath}"`,
      { timeout: 30_000 }
    );
    return;
  }

  // Fallback: PowerShell Start-Process (يحتاج مشغّل PDF افتراضي مثبّتاً)
  const ps = `Start-Process -FilePath '${pdfPath.replace(/'/g, "''")}' `
           + `-Verb PrintTo -ArgumentList '${printer.replace(/'/g, "''")}' -Wait`;
  const r = spawnSync("powershell", ["-NonInteractive", "-Command", ps], { timeout: 30_000 });
  if (r.status !== 0) {
    throw new Error(
      `PowerShell print failed — ضع SumatraPDF.exe في bin/ للطباعة الصامتة.\n`
      + (r.stderr?.toString() || "")
    );
  }
}

async function printInvoice(inv) {
  const html    = buildInvoiceHtml(inv);
  // ملاحظة: inv.customerBalance / inv.customerBalanceFound يُفترض أنهما مضبوطان
  // مسبقاً من poll() قبل الوصول إلى هنا (انظر استدعاء getCustomerBalance).
  const tmpPdf  = path.join(config.tempDir, `ozk-inv-${inv.number}-${Date.now()}.pdf`);

  await htmlToPdf(html, tmpPdf);
  try {
    sendToPrinter(tmpPdf);
  } finally {
    try { fs.unlinkSync(tmpPdf); } catch {}
  }

  const net       = inv.total - inv.discount;
  const remaining = net - inv.firstPay;
  console.log(
    `[${new Date().toLocaleTimeString("ar")}]  ✓ فاتورة #${inv.number}`
    + `  |  ${inv.customer || "—"}`
    + `  |  إجمالي ${formatMoneyWithCurrency(inv.total, inv.currencyIso)}`
    + `  |  متبقّي ${formatMoneyWithCurrency(remaining, inv.currencyIso)}`
    + `  →  ${config.printerName}`
  );
}

// يستخرج نصاً آمناً لأي قيمة مرمية مهما كان نوعها (null/undefined/نص/رقم/كائن عادي)
// دون افتراض وجود .message — يمنع رمي استثناء جديد داخل معالج استثناء.
function describeError(err) {
  if (err instanceof Error) return err.message;
  if (err === null || err === undefined) return String(err);
  if (typeof err === "object") {
    try { return JSON.stringify(err); } catch { return "[كائن خطأ غير قابل للعرض]"; }
  }
  return String(err);
}

// ─── دورة الاستعلام ───────────────────────────────────────────────────────
async function poll(pool, state) {
  // تقديم النافذة **قبل** الاستعلام لا بعده: الاستعلام يجب ألا ينظر أبعد ممّا
  // تتذكّره علامات الطباعة، وإلا أعاد فاتورة حُذفت علامتها فطُبعت من جديد.
  const movedFrom = advanceWatchFromDate(state);
  let changed = movedFrom !== null;
  if (movedFrom !== null) {
    console.log(
      `تقديم نافذة المراقبة: ${movedFrom} ← ${state.watchFromDate}`
      + " (الفواتير الأقدم لن تُستعلَم ولن تُطبع)"
    );
  }

  const result = await pool.request()
    .input("guid0",     sql.UniqueIdentifier, config.wholesaleTypeGuid)
    .input("watchFrom", sql.NVarChar,         state.watchFromDate)
    .query(SALES_QUERY);

  // لا نخرج مبكراً على نتيجة فارغة: تقديم النافذة أعلاه يجب أن يُحفظ أيضاً.
  const invoices = result.recordset.length ? groupIntoInvoices(result.recordset) : [];

  for (const inv of invoices) {
    if (state.printedGuids[inv.guid]) continue; // مطبوعة سابقاً
    // إن سقطت الطابعة أثناء الدورة نتوقف فوراً: الفاتورة تبقى غير مطبوعة وغير
    // مُعلَّمة في state، فتُلتقط كما هي في أول دورة بعد عودة الطابعة (dedup بلا تغيير).
    if (!printerGate.ready()) break;
    try {
      // رصيد الزبون الحقيقي (Ameen) — عبر AccountGUID فقط، لا اسم الزبون.
      // إن تعذّر العثور عليه، تبقى customerBalance فارغة ولا يُطبع أي رقم رصيد.
      const balance = await getCustomerBalance(pool, inv.guid);
      inv.customerBalanceFound = balance !== null;
      // رصيد دفتر الأستاذ مخزَّن بعملة الأساس (دولار) — يُحوَّل إلى عملة الفاتورة
      // بنفس المعامل، فيبقى الرصيد والإجمالي على الورقة بعملة واحدة.
      const balCv = Number(inv.currencyVal) > 0 ? Number(inv.currencyVal) : 1;
      inv.customerBalance = balance ? balance.current / balCv : null;
      await printInvoice(inv);
      state.printedGuids[inv.guid] = Date.now();
      changed = true;
    } catch (printErr) {
      // تسجيل الخطأ بدون إيقاف البرنامج، لإعادة المحاولة في الدورة التالية
      console.error(`خطأ طباعة فاتورة #${inv.number}: ${printErr.message}`);
    }
  }

  if (changed) {
    pruneOldGuids(state);
    persistState(state);
  }
}

// ─── نقطة الدخول ──────────────────────────────────────────────────────────
async function main() {
  if (!config.sqlConnectionString) {
    console.error(
      "\nخطأ: AMEEN_SQL_CONNECTION_STRING غير مضبوط.\n"
      + "اضبطه في متغيرات بيئة Windows أو أضفه مباشرة في config.js\n"
    );
    process.exit(1);
  }

  assertWholesaleConfig();
  assertDedupWindowInvariant();

  // القفل قبل أي شيء آخر: لا فحص طابعة ولا اتصال SQL ولا طباعة إن كانت نسخة
  // أخرى تعمل. ويُحرَّر في كل مسارات الخروج كي لا يبقى قفل متروك.
  const lock = acquireSingleInstanceLock();
  process.on("exit", () => lock.release());
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
    process.on(sig, () => { lock.release(); process.exit(0); });
  }
  // عطل الإعداد الدائم يرمي من هنا وينهي العملية كما كان تماماً. أما العطل العابر
  // (طابعة Wi-Fi لم تجهز بعد عند الإقلاع) فلا يُنهي المراقب: يُسجَّل، ويبدأ التشغيل
  // معلَّق الطباعة، وتُستأنف المراقبة تلقائياً فور عودة الطابعة.
  printerGate.ready();

  console.log("══════════════════════════════════════════════");
  console.log("    OZK TOBACCO — مراقب فواتير الجملة          ");
  console.log("══════════════════════════════════════════════");
  console.log(`  طابعة  →  ${config.printerName} (A4)`);
  console.log(`  فاصل   →  ${config.pollIntervalMs / 1000} ثانية`);
  if (!fs.existsSync(config.sumatraPath)) {
    console.log("  تحذير  →  SumatraPDF.exe غير موجود في bin/");
    console.log("             سيُستخدم PowerShell (يحتاج مشغّل PDF مثبّتاً)");
    console.log(`             للطباعة الصامتة ضع SumatraPDF.exe هنا:`);
    console.log(`             ${config.sumatraPath}`);
  } else {
    console.log("  طباعة  →  SumatraPDF صامتة ✓");
  }
  console.log("══════════════════════════════════════════════\n");

  // الاتصال بـSQL Server مع إعادة محاولة
  const sqlCfg = parseSqlConnStr(config.sqlConnectionString);
  let pool;
  for (;;) {
    try {
      process.stdout.write("الاتصال بـSQL Server... ");
      pool = await new sql.ConnectionPool(sqlCfg).connect();
      console.log("ناجح ✓\n");
      break;
    } catch (err) {
      console.error(`فشل: ${err.message}\nإعادة المحاولة بعد 15 ثانية...`);
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }

  // تهيئة الحالة — أول تشغيل: لا تُطبع فواتير اليوم السابقة
  let state = loadState();
  if (!state) {
    const today = localDateStr(Date.now());
    state = { watchFromDate: today, printedGuids: {} };
    persistState(state);
    console.log(`تهيئة: بداية المراقبة من ${today} (الفواتير السابقة لن تُطبع)`);
  } else {
    const printed = Object.keys(state.printedGuids).length;
    // حالة قادمة من نسخة قديمة: watchFromDate مجمّدة على يوم التثبيت. تُقدَّم
    // هنا فوراً وتُحفظ، فيتوقّف نزيف إعادة الطباعة من أول دورة لا بعد أيام.
    const movedFrom = advanceWatchFromDate(state);
    if (movedFrom !== null) {
      persistState(state);
      console.log(`تصحيح نافذة مجمّدة: ${movedFrom} ← ${state.watchFromDate}`);
    }
    console.log(`استئناف: مراقبة منذ ${state.watchFromDate} | ${printed} فاتورة مطبوعة سابقاً`);
  }

  console.log("\nالمراقبة تعمل — في انتظار فواتير جملة جديدة...\n");

  // حلقة الاستعلام الرئيسية
  for (;;) {
    // fail-closed: لا استعلام ولا طباعة إطلاقاً ما لم تكن الطابعة جاهزة الآن.
    // الاستدعاء خارج try عمداً: خطأ الإعداد الدائم يجب أن ينهي العملية لا أن يُبتلع.
    if (printerGate.ready()) {
      try {
        await poll(pool, state);
      } catch (err) {
        if (err && err.fatalPrinterConfig) throw err;
        console.error(`خطأ: ${describeError(err)}`);
        // إعادة الاتصال إذا انقطع
        if (!pool.connected) {
          try {
            await pool.close().catch(() => {});
            pool = await new sql.ConnectionPool(sqlCfg).connect();
            console.log("أُعيد الاتصال ✓");
          } catch (e2) {
            console.error(`فشل إعادة الاتصال: ${e2.message}`);
          }
        }
      }
    }
    lock.beat();
    await new Promise((r) => setTimeout(r, config.pollIntervalMs));
  }
}

main().catch((err) => {
  // القفل المحجوز خروج مقصود بسبب مفهوم، لا عطل غامض — يُميَّز في السجل.
  if (err && err.fatalLockHeld) {
    console.error(`\n${err.message}\n`);
    process.exit(2);
  }
  console.error("خطأ فادح:", describeError(err));
  process.exit(1);
});
