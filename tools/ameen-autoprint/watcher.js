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

// ─── تحليل سلسلة الاتصال (ODBC style → mssql config) ─────────────────────
function parseSqlConnStr(cs) {
  const kv = {};
  cs.split(";").forEach((part) => {
    const eq = part.indexOf("=");
    if (eq > 0) kv[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim();
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

// ─── تجميع الصفوف المسطّحة إلى فواتير ────────────────────────────────────
function groupIntoInvoices(rows) {
  const map = new Map();
  for (const row of rows) {
    const guid = row.invoice_guid;
    if (!map.has(guid)) {
      map.set(guid, {
        guid:     guid,
        number:   row.invoice_number,
        date:     row.invoice_date,
        customer: (row.customer_name || "").trim(),
        total:    Number(row.total),
        discount: Number(row.discount),
        firstPay: Number(row.first_pay),
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
    + `  |  إجمالي ${Number(inv.total).toLocaleString("en-US")} ل.س`
    + `  |  متبقّي ${Number(remaining).toLocaleString("en-US")} ل.س`
    + `  →  ${config.printerName}`
  );
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
    try {
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
    try {
      await poll(pool, state);
    } catch (err) {
      console.error(`خطأ: ${err.message}`);
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
    await new Promise((r) => setTimeout(r, config.pollIntervalMs));
  }
}

main().catch((err) => {
  console.error("خطأ فادح:", err.message);
  process.exit(1);
});
