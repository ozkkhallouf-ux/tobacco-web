"use strict";
// ============================================================================
// OZK - أرشفة فواتير الجملة على Google Drive + إشعار المالك على Telegram (OZK2026)
//
// فاتورة جملة مرحّلة ومستقرة في الأمين ← PDF بالقالب الرسمي A4 (نفس أداة الطباعة
// اليدوية، خط Cairo مضمَّن) ← صندوق دائم على القرص ← Drive (drive.file، خاص) ←
// دالة Edge ترسل الملف ورابطه إلى محادثة المالك وحدها.
//
// قراءة فقط من AmnDb002 عبر الحارس. لا يلمس الطباعة ولا الكاشير ولا مزامنة الأمين ولا
// وكيل الأحداث. لا يعطّل إصدار الفاتورة: يعمل مستقلاً ويقرأ ما حُفظ فعلاً.
//
//   node worker.js                 حلقة دائمة (المهمة المجدولة)
//   node worker.js --once          دورة واحدة ثم خروج
//   node worker.js --health        فحص الجاهزية (بلا رفع ولا إرسال) ثم خروج
//   node worker.js --status        ملخص الصندوق المحلي ثم خروج
//   node worker.js --retry <jobId|failed>   إعادة محاولة مهمة فاشلة محلياً
//   node worker.js --baseline <ملف>         لقطة الأساس لتفعيل الإنتاج (قراءة فقط، ملف جديد)
//   node worker.js --baseline-receipts <ملف> لقطة أساس سندات القبض (قراءة فقط، ملف جديد)
// ============================================================================

const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const { loadConfig, mergeConfig, MODES, BASELINE_SCHEMA, RECEIPT_TYPE_GUID } = require("./lib/config");
const { createStore } = require("./lib/store");
const { createArchiver } = require("./lib/archiver");
const { createDrive } = require("./lib/drive");
const { createEdge } = require("./lib/edge");
const { readSecret, hasSecret } = require("./lib/secrets");
const { redact } = require("./lib/redact");
const { createRenderer, puppeteerPath } = require("./lib/renderer");
const { assertReadOnlySql } = require("../manual-a4-print/lib/sql-guard");
const { paperFor } = require("../manual-a4-print/lib/paper");

const VERSION = (() => {
  try { return fs.readFileSync(path.join(__dirname, "VERSION"), "utf8").trim(); } catch { return "dev"; }
})();
const AUTOPRINT_DIR = path.join(__dirname, "..", "ameen-autoprint");
const MANUAL_DIR = path.join(__dirname, "..", "manual-a4-print");

const CHANGED_SQL = assertReadOnlySql(fs.readFileSync(path.join(__dirname, "lib", "changed-invoices-query.sql"), "utf8"));
const LINES_SQL = assertReadOnlySql(fs.readFileSync(path.join(__dirname, "lib", "archive-lines-query.sql"), "utf8"));
const BASELINE_SQL = assertReadOnlySql(fs.readFileSync(path.join(__dirname, "lib", "baseline-invoices-query.sql"), "utf8"));
const SOURCE_STATUS_SQL = assertReadOnlySql(fs.readFileSync(path.join(__dirname, "lib", "source-status-query.sql"), "utf8"));
const BALANCE_SQL = assertReadOnlySql(fs.readFileSync(path.join(AUTOPRINT_DIR, "ameen-customer-balance-query.sql"), "utf8"));
const RECEIPTS_SQL = assertReadOnlySql(fs.readFileSync(path.join(__dirname, "lib", "receipts-query.sql"), "utf8"));
const RECEIPT_BALANCE_SQL = assertReadOnlySql(fs.readFileSync(path.join(__dirname, "lib", "receipt-balance-query.sql"), "utf8"));
const RECEIPT_BASELINE_SQL = assertReadOnlySql(fs.readFileSync(path.join(__dirname, "lib", "receipt-baseline-query.sql"), "utf8"));
const NOW_SQL = assertReadOnlySql("SELECT CONVERT(nvarchar(33), GETDATE(), 126) AS now, DB_NAME() AS db, SUSER_SNAME() AS login");

const ZERO_GUID = "00000000-0000-0000-0000-000000000000";

function naiveDate(iso) {
  return new Date(`${String(iso).replace(/Z$/, "")}Z`);
}

function createAmeen(connString, typeGuids, receiptTypeGuid = RECEIPT_TYPE_GUID) {
  const sql = require("mssql");
  const { parseSqlConnStr } = require(path.join(MANUAL_DIR, "server.js"));
  const cfg = parseSqlConnStr(connString);
  if (/^sa$/i.test(cfg.user)) throw new Error("مرفوض: حساب sa لا يُستعمل للأرشفة. استعمل حساب القراءة.");
  cfg.options.appName = "OZK-DriveArchive";
  cfg.options.useUTC = true; // التواريخ «الساذجة» تُرسل بأرقامها كما هي
  let poolPromise = null;
  const pool = () => {
    if (!poolPromise) poolPromise = new sql.ConnectionPool(cfg).connect().catch((e) => { poolPromise = null; throw e; });
    return poolPromise;
  };
  async function q(text, bind) {
    const req = (await pool()).request();
    if (bind) bind(req, sql);
    return (await req.query(assertReadOnlySql(text))).recordset;
  }
  const [t0, t1] = [typeGuids[0], typeGuids[1] || typeGuids[0]];
  return {
    ping: async () => (await q(NOW_SQL))[0],
    serverNow: async () => (await q(NOW_SQL))[0].now,
    changedInvoices: ({ since, sinceGuid, dateFrom, onlyGuid, createdFrom }) => q(CHANGED_SQL, (r, s) => r
      .input("t0", s.UniqueIdentifier, t0)
      .input("t1", s.UniqueIdentifier, t1)
      .input("dateFrom", s.Date, naiveDate(`${dateFrom}T00:00:00`))
      .input("since", s.DateTime2(3), naiveDate(since))
      .input("sinceGuid", s.UniqueIdentifier, sinceGuid || ZERO_GUID)
      .input("onlyGuid", s.UniqueIdentifier, onlyGuid || null)
      .input("createdFrom", s.DateTime2(3), createdFrom ? naiveDate(createdFrom) : null)),
    baselineInvoices: () => q(BASELINE_SQL, (r, s) => r
      .input("t0", s.UniqueIdentifier, t0)
      .input("t1", s.UniqueIdentifier, t1)),
    lines: (guid) => q(LINES_SQL, (r, s) => r.input("invoiceGuid", s.UniqueIdentifier, guid)),
    sourceStatus: async (guid) => (await q(SOURCE_STATUS_SQL, (r, s) => r.input("invoiceGuid", s.UniqueIdentifier, guid)))[0] || null,
    balance: async (guid) => {
      const rows = await q(BALANCE_SQL, (r, s) => r.input("invoiceGuid", s.UniqueIdentifier, guid));
      if (!rows.length || rows[0].document_current === null || rows[0].document_current === undefined) return null;
      const v = Number(rows[0].document_current);
      return Number.isFinite(v) ? v : null;
    },
    // سندات القبض (المرحلة 2): نوع «سند قبض» وحده، قراءة فقط عبر الحارس نفسه.
    changedReceipts: ({ since, sinceGuid, dateFrom, onlyGuid, createdFrom }) => q(RECEIPTS_SQL, (r, s) => r
      .input("receiptType", s.UniqueIdentifier, receiptTypeGuid)
      .input("dateFrom", s.Date, naiveDate(`${dateFrom}T00:00:00`))
      .input("since", s.DateTime2(3), naiveDate(since))
      .input("sinceGuid", s.UniqueIdentifier, sinceGuid || ZERO_GUID)
      .input("onlyGuid", s.UniqueIdentifier, onlyGuid || null)
      .input("createdFrom", s.DateTime2(3), createdFrom ? naiveDate(createdFrom) : null)),
    receiptBaseline: () => q(RECEIPT_BASELINE_SQL, (r, s) => r.input("receiptType", s.UniqueIdentifier, receiptTypeGuid)),
    receiptBalance: async (entryGuid, accountGuid) => {
      const rows = await q(RECEIPT_BALANCE_SQL, (r, s) => r
        .input("entryGuid", s.UniqueIdentifier, entryGuid)
        .input("accountGuid", s.UniqueIdentifier, accountGuid));
      if (!rows.length) return null;
      const previous = Number(rows[0].document_previous);
      const current = Number(rows[0].document_current);
      return Number.isFinite(previous) && Number.isFinite(current) && rows[0].document_current !== null ? { previous, current } : null;
    },
    close: async () => { if (poolPromise) (await poolPromise).close(); },
  };
}

function createLog(dataDir) {
  const dir = path.join(dataDir, "logs");
  fs.mkdirSync(dir, { recursive: true });
  return (entry) => {
    const file = path.join(dir, `archive-${new Date().toISOString().slice(0, 10)}.jsonl`);
    try { fs.appendFileSync(file, `${JSON.stringify(entry)}\n`); } catch { /* السجل لا يوقف العامل */ }
  };
}

// نسخة واحدة: منفذ محلي يحرّره النظام لحظة موت العملية (نمط مراقب الطباعة).
function acquireLock(port) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", (err) => reject(err.code === "EADDRINUSE" ? new Error("نسخة أخرى من العامل تعمل") : err));
    srv.listen(port, "127.0.0.1", () => resolve(srv));
  });
}

function buildDeps(cfg) {
  const typeGuids = require("../manual-a4-print/lib/invoice-model").allowedTypes(cfg);
  const conn = readSecret("sql", cfg.secretDir);
  if (!conn) throw new Error("سرّ SQL غير محفوظ (set-secret.ps1 -Name sql)");
  const ameen = createAmeen(conn, typeGuids, cfg.receipts && cfg.receipts.typeGuid);
  const renderer = createRenderer({ browserPath: cfg.browserPath });
  const template = require(path.join(AUTOPRINT_DIR, "invoice-html.js"));
  const receiptTemplate = require("./lib/receipt-html");
  const mode = MODES[cfg.mode];
  let drive = null;
  const getDrive = () => {
    if (drive) return drive;
    const credentials = readSecret("google-oauth", cfg.secretDir);
    drive = createDrive({ credentials, expectedEmail: cfg.expectedAccountEmail });
    return drive;
  };
  let edge = null;
  if (cfg.edgeUrl) {
    const secret = readSecret("notify", cfg.secretDir);
    if (secret) edge = createEdge({ url: cfg.edgeUrl, secret, host: os.hostname() });
    else if (mode.notify) throw new Error("سرّ دالة الإشعار غير محفوظ (set-secret.ps1 -Name notify)");
  }
  return { ameen, renderer, template, receiptTemplate, getDrive, edge };
}

async function health(cfg) {
  const out = {
    version: VERSION,
    host: os.hostname(),
    mode: cfg.mode,
    pilot: (cfg.pilotInvoiceGuids || []).length ? { invoiceGuids: cfg.pilotInvoiceGuids, expiresAt: cfg.pilotExpiresAt } : null,
    archiveFrom: cfg.archiveFrom,
    production: cfg.newInvoicesFrom ? { newInvoicesFrom: cfg.newInvoicesFrom, baseline: (cfg.baselineGuids || []).length, baselineSha256: cfg.baselineSha256 } : null,
    receipts: receiptsSummary(cfg),
    approvedAccount: cfg.expectedAccountEmail,
    dataDir: cfg.dataDir,
    secrets: { sql: hasSecret("sql", cfg.secretDir), googleOauth: hasSecret("google-oauth", cfg.secretDir), notify: hasSecret("notify", cfg.secretDir) },
    edgeUrlSet: Boolean(cfg.edgeUrl),
  };
  try {
    const deps = buildDeps(cfg);
    out.browser = deps.renderer.browserPath() || "";
    try { puppeteerPath(); out.pdfEngine = { ok: true }; } catch (err) { out.pdfEngine = { ok: false, error: "puppeteer-core غير مثبّت في مجلد العامل (npm ci)" }; }
    try {
      const p = await deps.ameen.ping();
      out.sql = { ok: true, db: p.db, login: p.login };
    } catch (err) {
      out.sql = { ok: false, error: redact(err && err.message, 120) };
    }
    if (out.secrets.googleOauth) {
      try {
        const d = deps.getDrive();
        await d.verifyIdentity(true);
        out.drive = { state: "connected", account: cfg.expectedAccountEmail };
      } catch (err) {
        out.drive = { state: err && err.code ? err.code : "ERROR", error: redact(err && err.message, 120) };
      }
    } else {
      out.drive = { state: "not_configured" };
    }
    await deps.ameen.close();
    await deps.renderer.close();
  } catch (err) {
    out.error = redact(err && err.message, 200);
  }
  return out;
}

// الحلقة: دورة كل pollSeconds حتى الإيقاف. انقضاء التجربة المحصورة أثناء العمل يُنهيها بالرمز 2.
async function runLoop(archiver, cfg, log, { host, once }) {
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  while (!stopping) {
    let r = null;
    try {
      r = await archiver.cycle({ host, version: VERSION });
      if (once) console.log(JSON.stringify(r));
    } catch (err) {
      log({ at: new Date().toISOString(), event: "cycle_failed", message: redact(err && err.message) });
    }
    if (r && r.pilotExpired) return 2;
    if (once) break;
    await new Promise((res) => setTimeout(res, cfg.pollSeconds * 1000));
  }
  return 0;
}

// لقطة الأساس: لحظة التفعيل = ساعة SQL قبل القراءة (مقطوعة إلى الثانية)، ثم كل فاتورة جملة
// موجودة. فاتورة أُنشئت بين اللحظة ونهاية القراءة تدخل اللقطة فتُستبعد (حذر: تُذكر في العدد
// createdAtOrAfter ولا تُؤرشف). ملف قائم لا يُكتب فوقه. لا رفع ولا إرسال ولا كتابة على الأمين.
async function snapshotBaseline(cfg, outFile, ameen) {
  if (!outFile || outFile.startsWith("--")) throw new Error("الاستعمال: node worker.js --baseline <ملف جديد>");
  const target = path.resolve(outFile);
  if (fs.existsSync(target)) throw new Error(`الملف موجود، لا كتابة فوقه: ${target}`);
  const newInvoicesFrom = String(await ameen.serverNow()).slice(0, 19);
  const rows = await ameen.baselineInvoices();
  const guids = [...new Set(rows.map((r) => String(r.invoice_guid).toLowerCase()))].sort();
  const createdAtOrAfter = rows.filter((r) => Date.parse(`${String(r.created_at || "").replace(/Z$/, "")}Z`) >= Date.parse(`${newInvoicesFrom}Z`)).length;
  const typeGuids = require("../manual-a4-print/lib/invoice-model").allowedTypes(cfg);
  const doc = { schema: BASELINE_SCHEMA, newInvoicesFrom, takenAtUtc: new Date().toISOString(), host: os.hostname(), typeGuids, count: guids.length, guids };
  const body = Buffer.from(`${JSON.stringify(doc, null, 1)}\n`, "utf8");
  fs.writeFileSync(target, body, { flag: "wx" });
  const sha = require("crypto").createHash("sha256").update(body).digest("hex");
  return { file: target, newInvoicesFrom, count: guids.length, createdAtOrAfter, baselineSha256: sha };
}

function receiptsSummary(cfg) {
  const r = cfg.receipts || {};
  if (!r.enabled) return { enabled: false };
  return {
    enabled: true,
    typeGuid: r.typeGuid,
    archiveFrom: r.archiveFrom || cfg.archiveFrom,
    newReceiptsFrom: r.newReceiptsFrom || null,
    baseline: (r.baselineGuids || []).length,
    pilot: (r.pilotGuids || []).length ? { receiptGuids: r.pilotGuids, expiresAt: r.pilotExpiresAt } : null,
  };
}

// لقطة أساس سندات القبض: كل سند قبض موجود لحظة التفعيل (بأي تاريخ). مثل --baseline تماماً.
async function snapshotReceiptBaseline(outFile, ameen) {
  if (!outFile || outFile.startsWith("--")) throw new Error("الاستعمال: node worker.js --baseline-receipts <ملف جديد>");
  const target = path.resolve(outFile);
  if (fs.existsSync(target)) throw new Error(`الملف موجود، لا كتابة فوقه: ${target}`);
  const newReceiptsFrom = String(await ameen.serverNow()).slice(0, 19);
  const rows = await ameen.receiptBaseline();
  const guids = [...new Set(rows.map((r) => String(r.receipt_guid).toLowerCase()))].sort();
  const createdAtOrAfter = rows.filter((r) => Date.parse(`${String(r.created_at || "").replace(/Z$/, "")}Z`) >= Date.parse(`${newReceiptsFrom}Z`)).length;
  const doc = { schema: BASELINE_SCHEMA, kind: "receipt", newReceiptsFrom, takenAtUtc: new Date().toISOString(), host: os.hostname(), count: guids.length, guids };
  const body = Buffer.from(`${JSON.stringify(doc, null, 1)}\n`, "utf8");
  fs.writeFileSync(target, body, { flag: "wx" });
  const sha = require("crypto").createHash("sha256").update(body).digest("hex");
  return { file: target, newReceiptsFrom, count: guids.length, createdAtOrAfter, baselineSha256: sha };
}

async function main(argv) {
  if (argv.includes("--baseline-receipts")) {
    const target = process.env.OZK_DRIVE_ARCHIVE_CONFIG || path.join(__dirname, "config.json");
    const user = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, "utf8").replace(/^\uFEFF/, "")) : {};
    const cfg = mergeConfig(user);
    const conn = readSecret("sql", cfg.secretDir);
    if (!conn) throw new Error("سرّ SQL غير محفوظ (set-secret.ps1 -Name sql)");
    const ameen = createAmeen(conn, require("../manual-a4-print/lib/invoice-model").allowedTypes(cfg), cfg.receipts.typeGuid);
    try {
      console.log(JSON.stringify(await snapshotReceiptBaseline(argv[argv.indexOf("--baseline-receipts") + 1], ameen), null, 2));
    } finally {
      await ameen.close().catch(() => {});
    }
    return 0;
  }
  if (argv.includes("--baseline")) {
    // الإعداد كما هو (قد يكون بلا نطاق إنتاج بعد): قراءة فقط، فلا تطبَّق قيود الرفع هنا.
    const { DEFAULTS } = require("./lib/config");
    const target = process.env.OZK_DRIVE_ARCHIVE_CONFIG || path.join(__dirname, "config.json");
    const user = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, "utf8").replace(/^\uFEFF/, "")) : {};
    const cfg = { ...DEFAULTS, ...user };
    const conn = readSecret("sql", cfg.secretDir);
    if (!conn) throw new Error("سرّ SQL غير محفوظ (set-secret.ps1 -Name sql)");
    const ameen = createAmeen(conn, require("../manual-a4-print/lib/invoice-model").allowedTypes(cfg));
    try {
      console.log(JSON.stringify(await snapshotBaseline(cfg, argv[argv.indexOf("--baseline") + 1], ameen), null, 2));
    } finally {
      await ameen.close().catch(() => {});
    }
    return 0;
  }
  const cfg = loadConfig();
  if (argv.includes("--health")) {
    console.log(JSON.stringify(await health(cfg), null, 2));
    return 0;
  }
  const store = createStore(cfg.dataDir);
  if (argv.includes("--status")) {
    console.log(JSON.stringify({ mode: cfg.mode, production: cfg.newInvoicesFrom ? { newInvoicesFrom: cfg.newInvoicesFrom, baseline: (cfg.baselineGuids || []).length } : null, pilot: (cfg.pilotInvoiceGuids || []).length ? { invoiceGuids: cfg.pilotInvoiceGuids, expiresAt: cfg.pilotExpiresAt } : null, ...store.summary({ notifyEnabled: MODES[cfg.mode].notify }), detectErrors: Object.keys(store.state.detectErrors || {}).length, sourceIssues: Object.values(store.state.sourceIssues || {}).map((v) => ({ number: v.number, status: v.status, lastVersion: v.lastVersion, since: v.since })) }, null, 2));
    return 0;
  }
  const lock = await acquireLock(cfg.lockPort);
  const log = createLog(cfg.dataDir);
  if (argv.includes("--retry")) {
    const target = argv[argv.indexOf("--retry") + 1] || "";
    const ids = target === "failed" ? store.jobs().filter((j) => j.failed).map((j) => j.jobId) : [target];
    const archiver = createArchiver({ cfg, store, log, ameen: null, renderer: null, template: null, paper: null, getDrive: () => null, edge: null });
    console.log(`أُعيدت ${archiver.applyRetry(ids, "local")} مهمة إلى الطابور`);
    lock.close();
    return 0;
  }
  const deps = buildDeps(cfg);
  const archiver = createArchiver({ cfg, store, log, paper: paperFor("A4", { papers: ["A4"] }), ...deps });
  const host = os.hostname();
  log({ at: new Date().toISOString(), event: "worker_start", version: VERSION, mode: cfg.mode });
  const exitCode = await runLoop(archiver, cfg, log, { host, once: argv.includes("--once") });
  await deps.ameen.close().catch(() => {});
  await deps.renderer.close().catch(() => {});
  lock.close();
  return exitCode;
}

module.exports = { createAmeen, acquireLock, health, snapshotBaseline, snapshotReceiptBaseline, CHANGED_SQL, LINES_SQL, BALANCE_SQL, BASELINE_SQL, NOW_SQL, RECEIPTS_SQL, RECEIPT_BALANCE_SQL, RECEIPT_BASELINE_SQL };

if (require.main === module) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (err) => {
    console.error(redact(err && err.message || err));
    process.exit(1);
  });
}
