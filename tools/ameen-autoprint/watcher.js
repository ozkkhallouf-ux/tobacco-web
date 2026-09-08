"use strict";
// ============================================================
// watcher.js — مراقب فواتير مبيعات الجملة
// يراقب قاعدة الأمين كل 5 ثوانٍ ويطبع كل فاتورة جملة جديدة
// على طابعة كانون (A4) بنفس تصميم الفاتورة المرسلة للزبائن
// ============================================================

const fs   = require("fs");
const path = require("path");
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
async function getCustomerBalance(pool, invoiceGuid) {
  try {
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
  } catch (err) {
    console.error(`تعذّر جلب رصيد الزبون لفاتورة GUID=${invoiceGuid}: ${err.message}`);
    return null;
  }
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
function loadState() {
  try { return JSON.parse(fs.readFileSync(config.stateFilePath, "utf8")); }
  catch { return null; }
}

function saveState(state) {
  fs.writeFileSync(config.stateFilePath, JSON.stringify(state, null, 2), "utf8");
}

// حذف GUIDs أقدم من 7 أيام لمنع تضخّم الملف
function pruneOldGuids(state) {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const [guid, ts] of Object.entries(state.printedGuids)) {
    if (ts < cutoff) delete state.printedGuids[guid];
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
  const result = await pool.request()
    .input("guid0",     sql.UniqueIdentifier, config.wholesaleTypeGuid)
    .input("watchFrom", sql.NVarChar,         state.watchFromDate)
    .query(SALES_QUERY);

  if (!result.recordset.length) return;

  const invoices = groupIntoInvoices(result.recordset);
  let changed = false;

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
    saveState(state);
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
    const today = new Date().toISOString().slice(0, 10);
    state = { watchFromDate: today, printedGuids: {} };
    saveState(state);
    console.log(`تهيئة: بداية المراقبة من ${today} (الفواتير السابقة لن تُطبع)`);
  } else {
    const printed = Object.keys(state.printedGuids).length;
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
    await new Promise((r) => setTimeout(r, config.pollIntervalMs));
  }
}

main().catch((err) => {
  console.error("خطأ فادح:", err.message);
  process.exit(1);
});
