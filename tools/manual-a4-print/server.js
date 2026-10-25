"use strict";
// ============================================================================
// OZK - طباعة فواتير A4 (يدوياً عند الطلب) — خادم محلي على 127.0.0.1 فقط
//
// المستخدم يُدخل رقم الفاتورة ← بحث في AmnDb002 (SELECT فقط) ← اختيار السجل
// الصحيح عند تكرار الرقم بين الأنواع ← معاينة PDF بالقالب الرسمي وخط Cairo ←
// طباعة بعدد نسخ على Canon عبر SumatraPDF.
//
// لا يكتب شيئاً في الأمين. السجل محلي (JSON Lines). مستقل عن الموقع وعن
// مراقب الطباعة التلقائية: يستعمل قالبه (invoice-html.js) واستعلام الرصيد نفسيهما
// قراءةً فقط، ولا يلمس ملف حالته ولا مهمته.
//
//   node server.js                 تشغيل الخادم (يفتحه launch.ps1)
//   node server.js --health        فحص الجاهزية وطباعة النتيجة JSON ثم خروج
//   node server.js --selftest N    بحث + معاينة PDF للفاتورة N بلا طباعة ثم خروج
// ============================================================================

const fs = require("fs");
const crypto = require("crypto");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawnSync } = require("child_process");

const { assertReadOnlySql } = require("./lib/sql-guard");
const model = require("./lib/invoice-model");
const { paperFor, pdfOptions, sumatraSettings, applyPaperCss } = require("./lib/paper");
const { createPrintLog } = require("./lib/print-log");
const { createPrintGuard } = require("./lib/print-guard");

const APP_DIR = __dirname;
const AUTOPRINT_DIR = path.join(APP_DIR, "..", "ameen-autoprint");
const VERSION = (() => {
  try { return fs.readFileSync(path.join(APP_DIR, "VERSION"), "utf8").trim(); } catch { return "dev"; }
})();

const SEARCH_SQL = assertReadOnlySql(fs.readFileSync(path.join(APP_DIR, "lib", "search-query.sql"), "utf8"));
const LINES_SQL = assertReadOnlySql(fs.readFileSync(path.join(APP_DIR, "lib", "lines-query.sql"), "utf8"));
const BALANCE_SQL = assertReadOnlySql(fs.readFileSync(path.join(AUTOPRINT_DIR, "ameen-customer-balance-query.sql"), "utf8"));
const PING_SQL = assertReadOnlySql("SELECT DB_NAME() AS db, SUSER_SNAME() AS login");

// ─── الإعداد ────────────────────────────────────────────────────────────────
const DEFAULTS = {
  port: 47616,
  printerName: "Canon G3410 WiFi",
  printerHost: "",
  printerHostPort: 631,
  sumatraPath: path.join(APP_DIR, "bin", "SumatraPDF.exe"),
  browserPath: "",
  dataDir: path.join(process.env.LOCALAPPDATA || os.homedir(), "OZK", "ManualA4Print"),
  dryRun: true,
  maxCopies: 5,
  papers: ["A4"],
  allowedTypeGuids: model.DEFAULT_ALLOWED_TYPE_GUIDS,
  requireOfficialFont: true,
  autoPrintStatePath: "",
  autoPrintTaskName: "",
  idleExitMinutes: 120,
};

function loadConfig() {
  const file = process.env.OZK_MANUAL_PRINT_CONFIG || path.join(APP_DIR, "config.json");
  let user = {};
  if (fs.existsSync(file)) user = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  const cfg = { ...DEFAULTS, ...user };
  if (!path.isAbsolute(cfg.sumatraPath)) cfg.sumatraPath = path.join(APP_DIR, cfg.sumatraPath);
  cfg.maxCopies = Math.max(1, Math.min(10, Number(cfg.maxCopies) || 5));
  return cfg;
}

// ─── SQL ────────────────────────────────────────────────────────────────────
function parseSqlConnStr(cs) {
  const kv = {};
  String(cs || "").split(";").forEach((part) => {
    const eq = part.indexOf("=");
    if (eq > 0) {
      let val = part.slice(eq + 1).trim();
      if (val.length >= 2 && val[0] === '"' && val[val.length - 1] === '"') val = val.slice(1, -1);
      kv[part.slice(0, eq).trim().toLowerCase()] = val;
    }
  });
  let server = kv["server"] || kv["data source"] || "localhost";
  let port;
  const comma = server.match(/^(.*),(\d+)$/);
  if (comma) { server = comma[1]; port = Number(comma[2]); }
  let instanceName;
  const slash = server.match(/^([^\\]+)\\(.+)$/);
  if (slash) { server = slash[1]; instanceName = slash[2]; }
  const cfg = {
    server: server === "." ? "localhost" : server,
    database: kv["database"] || kv["initial catalog"] || "AmnDb002",
    user: kv["user id"] || kv["uid"] || "",
    password: kv["password"] || kv["pwd"] || "",
    options: {
      trustServerCertificate: true,
      encrypt: false,
      enableArithAbort: true,
      appName: "OZK-ManualA4Print",
      readOnlyIntent: true,
    },
    connectionTimeout: 15_000,
    requestTimeout: 30_000,
    pool: { max: 2, min: 0, idleTimeoutMillis: 60_000 },
  };
  if (port) cfg.port = port;
  if (instanceName) cfg.options.instanceName = instanceName;
  return cfg;
}

function createAmeenSource(connString) {
  const sql = require("mssql");
  const cfg = parseSqlConnStr(connString);
  let poolPromise = null;
  function pool() {
    if (!poolPromise) {
      poolPromise = new sql.ConnectionPool(cfg).connect().catch((err) => { poolPromise = null; throw err; });
    }
    return poolPromise;
  }
  async function q(text, bind) {
    const p = await pool();
    const req = p.request();
    if (bind) bind(req, sql);
    const r = await req.query(assertReadOnlySql(text));
    return r.recordset;
  }
  return {
    describe: () => ({ server: cfg.server, instance: cfg.options.instanceName || "", database: cfg.database, user: cfg.user }),
    ping: async () => (await q(PING_SQL))[0],
    search: (number) => q(SEARCH_SQL, (r, s) => r.input("number", s.Int, number)),
    lines: (guid) => q(LINES_SQL, (r, s) => r.input("invoiceGuid", s.UniqueIdentifier, guid)),
    balance: async (guid) => {
      const rows = await q(BALANCE_SQL, (r, s) => r.input("invoiceGuid", s.UniqueIdentifier, guid));
      if (!rows.length || rows[0].document_current === null || rows[0].document_current === undefined) return null;
      const v = Number(rows[0].document_current);
      return Number.isFinite(v) ? v : null;
    },
    close: async () => { if (poolPromise) (await poolPromise).close(); },
  };
}

// ─── تحويل HTML ← PDF عبر Edge/Chromium المثبّت على الجهاز ──────────────────
function findBrowser(cfg) {
  const candidates = [
    cfg.browserPath,
    process.env.OZK_BROWSER_PATH,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean);
  return candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || "";
}

function createRenderer(cfg) {
  let browserPromise = null;
  async function browser() {
    if (browserPromise) {
      const b = await browserPromise.catch(() => null);
      if (b && b.connected) return b;
    }
    const executablePath = findBrowser(cfg);
    if (!executablePath) throw httpError(503, "لم يُعثر على Microsoft Edge أو Chrome لتوليد PDF");
    const puppeteer = require("puppeteer-core");
    browserPromise = puppeteer.launch({
      executablePath,
      headless: true,
      args: ["--no-first-run", "--disable-extensions", "--disable-gpu"]
        // بيئة الفحص الآلي على Linux تعمل بـroot؛ على Windows لا يُلغى العزل.
        .concat(process.platform !== "win32" && process.getuid && process.getuid() === 0 ? ["--no-sandbox"] : []),
    });
    return browserPromise;
  }
  async function render(html, paper, outPath) {
    const page = await (await browser()).newPage();
    try {
      await page.setJavaScriptEnabled(false);
      await page.setContent(applyPaperCss(html, paper), { waitUntil: "load" });
      await page.evaluateHandle("document.fonts.ready").catch(() => {});
      const fontOk = await page.evaluate(
        "document.fonts.check('700 16px Cairo') && document.fonts.check('400 13px Cairo') && [...document.fonts].some(f => f.family.replace(/\"/g,'') === 'Cairo' && f.status === 'loaded')"
      ).catch(() => false);
      const pdf = await page.pdf({ ...pdfOptions(paper), path: outPath });
      return { fontOk: Boolean(fontOk), pages: countPdfPages(pdf), bytes: pdf.length };
    } finally {
      await page.close().catch(() => {});
    }
  }
  async function close() {
    if (browserPromise) { const b = await browserPromise.catch(() => null); if (b) await b.close().catch(() => {}); }
  }
  return { render, close, browserPath: () => findBrowser(cfg) };
}

function countPdfPages(buf) {
  const m = Buffer.from(buf).toString("latin1").match(/\/Type\s*\/Page(?![s\w])/g);
  return m ? m.length : 0;
}

// ─── الطابعة ────────────────────────────────────────────────────────────────
function runPowerShell(script, timeout) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    timeout: timeout || 15_000, encoding: "utf8", windowsHide: true,
  });
}

// DetectedErrorState في Win32_Printer: ورق/حبر/غطاء/انحشار/Offline/صيانة/درج ممتلئ.
const PRINTER_BLOCKING_ERRORS = {
  4: "نفد الورق", 6: "نفد الحبر", 7: "غطاء الطابعة مفتوح", 8: "انحشار ورق",
  9: "الطابعة غير متصلة", 10: "الطابعة تحتاج صيانة", 11: "درج الإخراج ممتلئ",
};

// ردود WS-Discovery كما يكتبها سكربت الفحص: «epr^xaddr^reach» مفصولة بـ«~».
function parseWsdReplies(raw) {
  return String(raw || "").split("~").filter(Boolean).map((r) => {
    const [epr, xaddr, reach] = r.split("^");
    return { epr: String(epr || "").trim().toLowerCase(), xaddr: String(xaddr || "").trim(), reach: reach || "none" };
  });
}

function urlHost(u) {
  try { const x = new URL(u); return `${x.hostname}:${x.port || (x.protocol === "https:" ? 443 : 80)}`; } catch { return ""; }
}

// حكم طابور WSD: الهوية بالـUUID وحده، والعنوان هو ما ردّت به الطابعة الآن على
// WS-Discovery. ما يحفظه Windows للجهاز يُقارن فقط للتنبيه، فتغيّر عنوان DHCP لا يرفض الطباعة.
function wsdVerdict(wsd) {
  const uuid = String(wsd.uuid || "").trim().toLowerCase();
  const want = `urn:uuid:${uuid}`;
  const replies = parseWsdReplies(wsd.replies);
  const mine = replies.filter((r) => r.epr === want && r.xaddr);
  const match = mine.find((r) => r.reach === "ok") || mine[0];
  if (!uuid) return { reach: "fail", target: "WSD", reason: "منفذ WSD بلا معرّف طابعة (UUID) — لا يمكن التحقق من هويتها" };
  if (!match) {
    const other = replies.length > 0;
    return {
      reach: "fail", target: `WSD ${uuid}`,
      reason: other
        ? `ردّ على اكتشاف WSD جهاز لا يطابق معرّف الطابعة (${uuid})`
        : `الطابعة لا تردّ على اكتشاف WSD (${uuid})`,
    };
  }
  const target = urlHost(match.xaddr) || match.xaddr;
  if (match.reach !== "ok") return { reach: "fail", target, reason: `الطابعة لا تردّ على الشبكة (${target})` };
  const winHost = urlHost(wsd.windowsUrl);
  const warning = winHost && winHost !== target
    ? `Windows ما زال يحفظ عنوان الطابعة ${winHost} بينما تردّ الآن على ${target}`
    : "";
  return { reach: "ok", target, warning };
}

// يحكم على حالة الطابعة من حقول الاستعلام. Windows قد يُبقي طابعة الشبكة «جاهزة» وهي لا
// تردّ، فلا تُعدّ جاهزة إلا إذا ردّت على منفذها حين يكون عنوانها معروفاً.
function classifyPrinter(f) {
  const port = f.port || "";
  const base = { port, printerStatus: f.status, detectedError: f.detected, queuedJobs: f.jobs };
  if (/^TS\d/i.test(port)) return { state: "redirected", ...base, reason: "منفذ جلسة عن بُعد (RDP) — مرفوض" };
  if (String(f.offline).trim().toLowerCase() === "true" || Number(f.status) === 7) {
    return { state: "offline", ...base, reason: "الطابعة غير متصلة (Work Offline)" };
  }
  const blocking = PRINTER_BLOCKING_ERRORS[Number(f.detected)];
  if (blocking) return { state: "error", ...base, reason: blocking };
  if (Number(f.status) === 6) return { state: "error", ...base, reason: "الطابعة متوقفة" };
  const w = f.wsd ? wsdVerdict(f.wsd) : null;
  const reach = w ? w.reach : f.reach;
  const target = w ? w.target : f.target;
  if (reach === "fail") return { state: "unreachable", ...base, target, reason: (w && w.reason) || `الطابعة لا تردّ على الشبكة (${target})` };
  const warn = [w && w.warning, Number(f.jobs) > 0 ? `في طابور الطابعة ${f.jobs} مهمة سابقة لم تُطبع` : ""].filter(Boolean).join(" — ");
  return { state: "ready", ...base, ...(w ? { target } : {}), reachable: reach === "ok" ? true : null, warning: warn, reason: "" };
}

// سكربت فحص الطابعة. منفذ WSD لا يحمل عنواناً في Win32_TCPIPPrinterPort:
// - طابور «IPP Class Driver» يحفظ رابط الطابعة على عقدة SWD\IPP\<UUID>، ويُفحص ذلك الرابط.
// - طابور WSD عادي يُسأل عنه بالـUUID عبر WS-Discovery (multicast على كل بطاقات IPv4)،
//   فيُفحص العنوان الذي تردّ به الطابعة الآن لا عنواناً محفوظاً. قيمة LocationInformation
//   لعقدة الطابور نفسه (تحت Enum) لا تُستعمل: تبقى على العنوان القديم بعد تغيّر DHCP.
function printerProbeScript(cfg) {
  const q = (v) => String(v || "").replace(/'/g, "''");
  return `$p = Get-CimInstance Win32_Printer | Where-Object { $_.Name -eq '${q(cfg.printerName)}' }\n`
    + `if (-not $p) { 'NOT_FOUND'; exit 0 }\n`
    + `$jobs = @(Get-CimInstance Win32_PrintJob | Where-Object { $_.Name -like ($p.Name + ',*') }).Count\n`
    + `$h = '${q(cfg.printerHost)}'; $n = ${Number(cfg.printerHostPort) || 631}\n`
    + `$tp = Get-CimInstance Win32_TCPIPPrinterPort | Where-Object { $_.Name -eq $p.PortName } | Select-Object -First 1\n`
    + `if ($tp -and $tp.HostAddress) { $h = $tp.HostAddress; $n = [int]$tp.PortNumber }\n`
    + `$wsd = ''\n`
    + `if (-not $h -and $p.PortName -like 'WSD-*') {\n`
    + `  $w = Get-ItemProperty -LiteralPath ('HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Print\\Monitors\\WSD Port\\Ports\\' + $p.PortName) -ErrorAction SilentlyContinue\n`
    + `  $uuid = if ($w) { [string]$w.'Printer UUID' } else { '' }\n`
    + `  if ($w -and $w.'IPP PortId' -and $uuid) {\n`
    + `    $u = (Get-PnpDeviceProperty -InstanceId ('SWD\\IPP\\' + $uuid) -KeyName '{A35996AB-11CF-4935-8B61-A6761081ECDF} 12' -ErrorAction SilentlyContinue).Data\n`
    + `    if ($u) { try { $x = [Uri]"$u"; $h = $x.Host; $n = $x.Port } catch { } }\n`
    + `  } else {\n`
    + `    $win = if ($uuid) { [string](Get-PnpDeviceProperty -InstanceId ('SWD\\DAFWSDProvider\\urn:uuid:' + $uuid) -KeyName 'DEVPKEY_Device_LocationInfo' -ErrorAction SilentlyContinue).Data } else { '' }\n`
    + `    $rep = @()\n`
    + `    if ($uuid) {\n`
    + `      $want = 'urn:uuid:' + $uuid\n`
    + `      $xml = '<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"><s:Header><a:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</a:To><a:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Resolve</a:Action><a:MessageID>urn:uuid:' + [guid]::NewGuid() + '</a:MessageID></s:Header><s:Body><d:Resolve><a:EndpointReference><a:Address>' + $want + '</a:Address></a:EndpointReference></d:Resolve></s:Body></s:Envelope>'\n`
    + `      $b = [Text.Encoding]::UTF8.GetBytes($xml); $socks = @()\n`
    + `      $addrs = [Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() | Where-Object { $_.OperationalStatus -eq 'Up' } | ForEach-Object { $_.GetIPProperties().UnicastAddresses } | ForEach-Object { $_.Address } | Where-Object { $_.AddressFamily -eq 'InterNetwork' -and -not [Net.IPAddress]::IsLoopback($_) -and -not $_.ToString().StartsWith('169.254.') }\n`
    + `      foreach ($a in $addrs) { try { $s = New-Object Net.Sockets.UdpClient (New-Object Net.IPEndPoint ($a, 0)); [void]$s.Send($b, $b.Length, '239.255.255.250', 3702); $socks += $s } catch { } }\n`
    + `      $found = @(); $sw = [Diagnostics.Stopwatch]::StartNew(); $ep = New-Object Net.IPEndPoint ([Net.IPAddress]::Any, 0)\n`
    + `      while ($sw.ElapsedMilliseconds -lt 2000 -and -not ($found | Where-Object { $_[0] -ieq $want })) {\n`
    + `        foreach ($s in $socks) { while ($s.Available -gt 0) { try { $t = [Text.Encoding]::UTF8.GetString($s.Receive([ref]$ep)); $e = ([regex]::Match($t, 'Address>\\s*(urn:uuid:[^<\\s]+)')).Groups[1].Value; $xa = (([regex]::Match($t, 'XAddrs>\\s*([^<]+)<')).Groups[1].Value.Trim() -split '\\s+')[0]; if ($e) { $found += ,@($e, $xa) } } catch { } } }\n`
    + `        Start-Sleep -Milliseconds 50\n`
    + `      }\n`
    + `      foreach ($s in $socks) { $s.Close() }\n`
    + `      foreach ($f in $found | Select-Object -First 5) { $r = 'none'; try { $xu = [Uri]$f[1]; $c = New-Object Net.Sockets.TcpClient; try { $r = if ($c.ConnectAsync($xu.Host, $xu.Port).Wait(2000)) { 'ok' } else { 'fail' } } catch { $r = 'fail' } finally { $c.Close() } } catch { }; $rep += ($f[0] + '^' + $f[1] + '^' + $r) }\n`
    + `    }\n`
    + `    $wsd = 'WSD^' + $uuid + '^' + $win + '^' + ($rep -join '~')\n`
    + `  }\n`
    + `}\n`
    + `$reach = 'none'\n`
    + `if ($h) { $c = New-Object Net.Sockets.TcpClient; try { $reach = if ($c.ConnectAsync($h, $n).Wait(2000)) { 'ok' } else { 'fail' } } catch { $reach = 'fail' } finally { $c.Close() } }\n`
    + `'FOUND|' + $p.PortName + '|' + $p.WorkOffline + '|' + $p.PrinterStatus + '|' + $p.DetectedErrorState + '|' + $jobs + '|' + $reach + '|' + $h + ':' + $n + '|' + $wsd`;
}

// يفكّ سطر الفحص إلى حقول classifyPrinter.
function parseProbeLine(out) {
  const [, port, offline, status, detected, jobs, reach, target, wsdRaw] = String(out).split("|");
  const f = { port, offline, status, detected, jobs, reach, target };
  if (wsdRaw && wsdRaw.startsWith("WSD^")) {
    const parts = wsdRaw.split("^");
    // WSD^uuid^windowsUrl^replies — والردود نفسها تحوي «^» داخلها.
    f.wsd = { uuid: parts[1] || "", windowsUrl: parts[2] || "", replies: parts.slice(3).join("^") };
  }
  return f;
}

function createPrinter(cfg) {
  function probe() {
    if (process.platform !== "win32") return { state: "unknown", reason: "ليس Windows" };
    const r = runPowerShell(printerProbeScript(cfg));
    const out = String(r.stdout || "").trim();
    if (out === "NOT_FOUND") return { state: "missing", reason: `الطابعة "${cfg.printerName}" غير مثبّتة على هذا الجهاز` };
    if (r.status !== 0 || !out.startsWith("FOUND|")) return { state: "unknown", reason: "تعذّر الاستعلام عن الطابعة" };
    return classifyPrinter(parseProbeLine(out));
  }
  function send(pdfPath, paper, copies) {
    if (!fs.existsSync(cfg.sumatraPath)) throw new Error(`SumatraPDF غير موجود: ${cfg.sumatraPath}`);
    const r = spawnSync(cfg.sumatraPath, [
      "-print-to", cfg.printerName,
      "-print-settings", sumatraSettings(paper, copies),
      "-silent", "-exit-when-done",
      pdfPath,
    ], { timeout: 90_000, windowsHide: true });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`SumatraPDF خرج بالرمز ${r.status}`);
  }
  return { probe, send };
}

// ─── حالة الطباعة التلقائية (قراءة فقط) ─────────────────────────────────────
function autoPrintInfo(cfg, guid) {
  const out = { configured: Boolean(cfg.autoPrintStatePath || cfg.autoPrintTaskName) };
  if (cfg.autoPrintStatePath && guid) {
    try {
      const st = JSON.parse(fs.readFileSync(cfg.autoPrintStatePath, "utf8"));
      const ts = st && st.printedGuids && st.printedGuids[guid];
      out.autoPrintedAt = ts ? new Date(Number(ts)).toISOString() : null;
    } catch { out.autoPrintedAt = undefined; }
  }
  return out;
}

function autoPrintTaskState(cfg) {
  if (!cfg.autoPrintTaskName || process.platform !== "win32") return null;
  const name = cfg.autoPrintTaskName.replace(/'/g, "''");
  const r = runPowerShell(`$t = Get-ScheduledTask -TaskName '${name}' -ErrorAction SilentlyContinue; if ($t) { [string]$t.State } else { 'NOT_FOUND' }`);
  return String(r.stdout || "").trim() || "unknown";
}

// ─── التطبيق ────────────────────────────────────────────────────────────────
function createApp(deps) {
  const { cfg, ameen, renderer, printer, log, guard } = deps;
  const { buildInvoiceHtml } = deps.template || require(path.join(AUTOPRINT_DIR, "invoice-html.js"));
  const previewDir = path.join(cfg.dataDir, "previews");
  fs.mkdirSync(previewDir, { recursive: true });

  async function health() {
    const h = {
      version: VERSION,
      host: os.hostname(),
      user: os.userInfo().username,
      dryRun: Boolean(cfg.dryRun),
      printerName: cfg.printerName,
      papers: cfg.papers,
      maxCopies: cfg.maxCopies,
      sumatra: fs.existsSync(cfg.sumatraPath),
      browser: renderer.browserPath() || "",
      logFile: log.filePath,
    };
    h.printer = printer.probe();
    try {
      const p = await ameen.ping();
      h.sql = { ok: true, ...ameen.describe(), db: p.db, login: p.login };
    } catch (err) {
      console.error(`SQL health: ${err && err.stack || err}`);
      h.sql = { ok: false, ...ameen.describe(), error: sqlErrorLabel(err) };
    }
    h.autoPrintTask = autoPrintTaskState(cfg);
    const sample = buildInvoiceHtml({ number: 0, date: "", customer: "", total: 0, discount: 0, firstPay: 0, items: [] });
    h.officialFontEmbedded = /@font-face\{font-family:"Cairo"/.test(sample);
    return h;
  }

  async function search(number) {
    const rows = await ameen.search(number);
    const matches = rows.map((r) => model.headerFromRow(r, cfg));
    log.append({ event: "search", number, matches: matches.length });
    return matches;
  }

  async function preview(guid, paperName) {
    const paper = paperFor(paperName, cfg);
    const header = await headerByGuid(guid);
    if (!header) throw httpError(404, "الفاتورة غير موجودة");
    if (!header.printable) throw httpError(409, header.blockReason);
    const [lines, balance] = await Promise.all([ameen.lines(guid), ameen.balance(guid)]);
    const inv = model.buildInvoice(header, lines, balance);
    const html = buildInvoiceHtml(inv);
    const fontEmbedded = /@font-face\{font-family:"Cairo"/.test(html);
    const token = guard.issue(guid, { paper: paper.label, number: header.number });
    const pdfPath = path.join(previewDir, `${token}.pdf`);
    const result = await renderer.render(html, paper, pdfPath);
    const fontOk = fontEmbedded && result.fontOk;
    guard.lookup(token).pdfPath = pdfPath;
    guard.lookup(token).fontOk = fontOk;
    log.append({ event: "preview", guid, number: header.number, type: header.typeName, paper: paper.label, pages: result.pages, fontOk });
    return {
      token,
      pdfUrl: `/preview/${token}.pdf`,
      pages: result.pages,
      fontOk,
      paper: paper.label,
      invoice: { ...header, items: inv.items.length, customerBalanceFound: inv.customerBalanceFound },
      previousPrints: log.successfulPrints(guid).slice(-5),
      autoPrint: autoPrintInfo(cfg, guid),
    };
  }

  // البحث بالـGUID يمرّ بنفس الاستعلام عبر الرقم المخزَّن في الرمز؛ يُبقي SQL
  // ثابتاً (لا استعلام ثالث) ويتحقق أن الـGUID فعلاً من نتائج ذلك الرقم.
  const knownNumbers = new Map(); // guid → number
  async function headerByGuid(guid) {
    const number = knownNumbers.get(guid);
    if (number === undefined) return null;
    const rows = await ameen.search(number);
    const hit = rows.map((r) => model.headerFromRow(r, cfg)).find((h) => h.guid === guid);
    return hit || null;
  }

  function parseCopies(copies) {
    const n = Number(copies);
    if (!Number.isInteger(n) || n < 1 || n > cfg.maxCopies) throw httpError(400, `عدد النسخ يجب أن يكون بين 1 و${cfg.maxCopies}`);
    return n;
  }

  // شروط ما قبل الإرسال: الخط مضمَّن والطابعة جاهزة. تعيد رفضاً أو null.
  function preSendRejection(t) {
    if (cfg.requireOfficialFont && !t.fontOk) {
      return { ok: false, code: "FONT", message: "خط Cairo لم يُضمَّن في المعاينة — أُلغيت الطباعة." };
    }
    const pr = printer.probe();
    const tolerated = cfg.dryRun && pr.state === "unknown";
    if (pr.state !== "ready" && !tolerated) {
      return { ok: false, code: "PRINTER", message: pr.reason || "الطابعة غير جاهزة", printer: pr.state };
    }
    return null;
  }

  function dispatchToPrinter(t, n, reprint) {
    const paper = paperFor(t.paper, cfg);
    const base = { guid: t.guid, number: t.number, copies: n, paper: paper.label };
    log.append({ event: "print_requested", ...base, reprint, dryRun: Boolean(cfg.dryRun) });
    if (cfg.dryRun) {
      log.append({ event: "dry_run", ...base, printer: cfg.printerName });
      return { ok: true, dryRun: true, message: "وضع الاختبار: لم يُرسل شيء للطابعة (dryRun)." };
    }
    printer.send(t.pdfPath, paper, n);
    log.append({ event: "print_sent", ...base, printer: cfg.printerName, reprint });
    return { ok: true, message: `أُرسلت ${n} نسخة إلى ${cfg.printerName}` };
  }

  async function print(token, copies, confirmReprint) {
    const n = parseCopies(copies);
    const g = guard.begin(token, { confirmReprint: Boolean(confirmReprint) });
    if (!g.ok) {
      const t = guard.lookup(token);
      log.append({ event: "print_rejected", guid: t ? t.guid : null, code: g.code });
      return g;
    }
    const t = g.entry;
    let success = false;
    try {
      const rejected = preSendRejection(t);
      if (rejected) {
        log.append({ event: "print_rejected", guid: t.guid, number: t.number, code: rejected.code, printer: rejected.printer });
        return rejected;
      }
      const result = dispatchToPrinter(t, n, g.reprint);
      success = true;
      return result;
    } catch (err) {
      log.append({ event: "print_failed", guid: t.guid, number: t.number, error: String(err.message || err) });
      // التفاصيل في السجل المحلي وحده؛ الواجهة تأخذ رسالة ثابتة.
      return { ok: false, code: "FAILED", message: "فشل الإرسال إلى الطابعة — التفاصيل في سجل الطباعة المحلي." };
    } finally {
      g.finish(success);
    }
  }

  return { health, search, preview, print, knownNumbers, previewDir };
}

// تصنيف خطأ SQL لعرضه بلا نصّ الاستثناء نفسه.
function sqlErrorLabel(err) {
  const code = String(err && err.code || "");
  if (code === "ELOGIN") return "فشل تسجيل الدخول إلى SQL (اسم المستخدم أو كلمة المرور)";
  if (code === "ESOCKET" || code === "ETIMEOUT" || code === "EINSTLOOKUP") return "تعذّر الوصول إلى خادم SQL على الشبكة";
  return code ? `خطأ SQL (${code})` : "خطأ SQL";
}

// علامة خاصة بـhttpError: مكتبات HTTP/SQL قد تحمل .status على استثناء
// غير مقصود، فلا يُعرض نصّه لمجرد وجود الحقل.
const HTTP_PUBLIC = Symbol("ozk.httpPublic");

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  e[HTTP_PUBLIC] = String(message);
  return e;
}

// ─── HTTP ───────────────────────────────────────────────────────────────────
// مصادقة الجلسة: المنفذ المحلي يصل إليه أي مستخدم أو عملية على الجهاز، والترويسة
// X-OZK ثابتة معروفة. فيولّد الخادم عند إقلاعه مفتاحاً عشوائياً يكتبه في ملف داخل
// %LOCALAPPDATA% للمستخدم (لا يقرؤه مستخدم آخر غير مدير). launch.ps1 يقرؤه ويفتح
// /?k=<المفتاح> مرة واحدة، فيحوّله الخادم إلى كوكي HttpOnly ثم يعيد التوجيه إلى /.
// كل مسار غير /?k يتطلب الكوكي.
const SESSION_COOKIE = "ozk_s";

function newSessionKey() {
  return crypto.randomBytes(32).toString("hex");
}

function writeSessionKeyFile(file, key) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, key, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

function sameKey(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function cookieValue(req, name) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return "";
}

function createHttpHandler(app, cfg, sessionKey) {
  if (!sessionKey) throw new Error("مفتاح الجلسة مطلوب");
  const uiFile = path.join(APP_DIR, "ui", "index.html");
  const allowedHosts = new Set([`127.0.0.1:${cfg.port}`, `localhost:${cfg.port}`]);
  let lastActivity = Date.now();

  function send(res, status, body, type, extraHeaders) {
    res.writeHead(status, {
      "Content-Type": type || "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "SAMEORIGIN",
      "Referrer-Policy": "no-referrer",
      ...extraHeaders,
    });
    res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on("data", (c) => { size += c.length; if (size > 16_384) { reject(httpError(413, "طلب كبير")); req.destroy(); } else chunks.push(c); });
      req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { reject(httpError(400, "JSON غير صالح")); } });
      req.on("error", reject);
    });
  }

  // جدول المسارات: "METHOD path" ← معالج يعيد [status, body, type?].
  const routes = {
    "GET /": async () => [200, fs.readFileSync(uiFile), "text/html; charset=utf-8"],
    "GET /api/health": async () => [200, await app.health()],
    "GET /api/ping": async () => [200, { ok: true }],
    "GET /api/search": async (req, url) => {
      const raw = String(url.searchParams.get("number") || "").trim();
      if (!/^\d{1,9}$/.test(raw)) throw httpError(400, "أدخل رقم فاتورة صحيحاً (أرقام فقط)");
      const number = Number(raw);
      const matches = await app.search(number);
      for (const m of matches) app.knownNumbers.set(m.guid, number);
      return [200, { number, matches }];
    },
    "POST /api/preview": async (req) => {
      const body = await readJson(req);
      const guid = model.normGuid(body.guid);
      if (!model.isGuid(guid)) throw httpError(400, "معرّف فاتورة غير صالح");
      return [200, await app.preview(guid, body.paper || "A4")];
    },
    "POST /api/print": async (req) => {
      const body = await readJson(req);
      return [200, await app.print(String(body.token || ""), body.copies, body.confirmReprint === true)];
    },
  };

  function previewFile(url) {
    const pm = url.pathname.match(/^\/preview\/([0-9a-f]{32})\.pdf$/);
    if (!pm) return null;
    const file = path.join(app.previewDir, `${pm[1]}.pdf`);
    return fs.existsSync(file) ? file : null;
  }

  // حماية من DNS rebinding وطلبات المواقع الأخرى: مضيف محلي فقط، والكتابة
  // تتطلب ترويسة مخصّصة لا يرسلها متصفح عبر الأصول بلا preflight.
  function rejectReason(req) {
    if (!allowedHosts.has(String(req.headers.host || ""))) return "host";
    if (req.method === "POST" && req.headers["x-ozk"] !== "1") return "header";
    return "";
  }

  // /?k=<مفتاح> ⇒ كوكي الجلسة ثم توجيه إلى / (لا يبقى المفتاح في الشريط).
  function tryLogin(req, res, url) {
    if (req.method !== "GET" || url.pathname !== "/" || !url.searchParams.has("k")) return false;
    if (!sameKey(url.searchParams.get("k"), sessionKey)) {
      send(res, 403, "مفتاح جلسة غير صالح — افتح الأداة من اختصار سطح المكتب.", "text/plain; charset=utf-8");
      return true;
    }
    send(res, 303, "", "text/plain; charset=utf-8", {
      Location: "/",
      "Set-Cookie": `${SESSION_COOKIE}=${sessionKey}; HttpOnly; SameSite=Strict; Path=/`,
    });
    return true;
  }

  async function handle(req, res) {
    lastActivity = Date.now();
    const reject = rejectReason(req);
    if (reject) return send(res, 403, { error: reject });
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (tryLogin(req, res, url)) return undefined;
    // /api/ping بلا مصادقة: لا يعيد شيئاً سوى أن الخادم حيّ (يحتاجه launch.ps1).
    if (req.method === "GET" && url.pathname === "/api/ping") return send(res, 200, { ok: true });
    if (!sameKey(cookieValue(req, SESSION_COOKIE), sessionKey)) {
      return send(res, 401, { error: "الجلسة غير مصادَق عليها — افتح الأداة من اختصار سطح المكتب." });
    }
    try {
      const route = routes[`${req.method} ${url.pathname}`];
      if (route) {
        const [status, body, type] = await route(req, url);
        return send(res, status, body, type);
      }
      const file = req.method === "GET" ? previewFile(url) : null;
      if (file) return send(res, 200, fs.readFileSync(file), "application/pdf");
      return send(res, 404, { error: "not found" });
    } catch (err) {
      // أخطاء الطلب المقصودة (httpError) وحدها تُعرض؛ غيرها — حتى لو حمل
      // status من مكتبة — يُسجَّل محلياً ولا يخرج نصّه ولا تتبّعه إلى الواجهة.
      if (err && typeof err[HTTP_PUBLIC] === "string") {
        return send(res, err.status, { error: err[HTTP_PUBLIC] });
      }
      console.error(err && err.stack || err);
      return send(res, 500, { error: "خطأ داخلي — التفاصيل في server.err.log" });
    }
  }

  return { handle, idleMs: () => Date.now() - lastActivity };
}

function cleanupPreviews(dir, maxAgeMs) {
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return; }
  for (const name of entries) {
    const p = path.join(dir, name);
    try { if (Date.now() - fs.statSync(p).mtimeMs > maxAgeMs) fs.unlinkSync(p); } catch { /* ملف مقفل — لاحقاً */ }
  }
}

function connectionString() {
  return process.env.OZK_MANUAL_PRINT_SQL || process.env.AMEEN_SQL_CONNECTION_STRING || "";
}

function buildRealApp(cfg) {
  const cs = connectionString();
  if (!cs) throw new Error("لا يوجد اتصال SQL: OZK_MANUAL_PRINT_SQL أو AMEEN_SQL_CONNECTION_STRING");
  const log = createPrintLog(path.join(cfg.dataDir, "print-log.jsonl"));
  const deps = {
    cfg,
    ameen: createAmeenSource(cs),
    renderer: createRenderer(cfg),
    printer: createPrinter(cfg),
    log,
  };
  deps.guard = createPrintGuard({ log });
  return { app: createApp(deps), deps };
}

async function selftest(app, cfg, number, paper) {
  const matches = await app.search(number);
  for (const m of matches) app.knownNumbers.set(m.guid, number);
  const report = {
    number,
    matches: matches.map((m) => ({ guid: m.guid, type: m.typeName, date: m.date, customer: m.customer ? "[موجود]" : "", printable: m.printable, lines: m.lineCount })),
  };
  const target = matches.find((m) => m.printable);
  if (!target) return report;
  const pv = await app.preview(target.guid, paper);
  const kept = path.join(cfg.dataDir, `selftest-${number}-${paper}.pdf`);
  fs.copyFileSync(path.join(app.previewDir, `${pv.token}.pdf`), kept);
  report.preview = { pages: pv.pages, fontOk: pv.fontOk, paper: pv.paper, pdf: kept, bytes: fs.statSync(kept).size, autoPrint: pv.autoPrint };
  return report;
}

function argValue(argv, name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}

async function cli(argv) {
  const cfg = loadConfig();
  const { app, deps } = buildRealApp(cfg);
  try {
    if (argv.includes("--health")) {
      console.log(JSON.stringify(await app.health(), null, 2));
      return 0;
    }
    const number = Number(argValue(argv, "--selftest", ""));
    if (!Number.isInteger(number) || number < 1) throw new Error("الاستعمال: --selftest <رقم الفاتورة> [--paper A4|A5]");
    console.log(JSON.stringify(await selftest(app, cfg, number, argValue(argv, "--paper", "A4")), null, 2));
    return 0;
  } finally {
    await deps.renderer.close();
    await deps.ameen.close().catch(() => {});
  }
}

async function main() {
  const cfg = loadConfig();
  const { app, deps } = buildRealApp(cfg);
  cleanupPreviews(app.previewDir, 24 * 3600 * 1000);
  const sessionKey = newSessionKey();
  const handler = createHttpHandler(app, cfg, sessionKey);
  const server = http.createServer((req, res) => { handler.handle(req, res); });
  server.on("error", (err) => {
    // المنفذ محجوز ⇒ نسخة أخرى تعمل؛ launch.ps1 يفتح الواجهة عليها.
    console.error(err.code === "EADDRINUSE" ? "نسخة أخرى تعمل على المنفذ نفسه" : String(err));
    process.exit(err.code === "EADDRINUSE" ? 3 : 1);
  });
  server.listen(cfg.port, "127.0.0.1", () => {
    // المفتاح يُكتب بعد حجز المنفذ فقط: نسخة ثانية مرفوضة لا تكتب فوق مفتاح الأولى.
    writeSessionKeyFile(path.join(cfg.dataDir, "session.key"), sessionKey);
    console.log(`OZK manual A4 print ${VERSION} على http://127.0.0.1:${cfg.port}/ (dryRun=${cfg.dryRun})`);
  });
  const idleLimit = Number(cfg.idleExitMinutes) * 60 * 1000;
  setInterval(async () => {
    if (idleLimit > 0 && handler.idleMs() > idleLimit) {
      await deps.renderer.close();
      process.exit(0);
    }
  }, 60_000).unref();
}

module.exports = {
  createApp, classifyPrinter, printerProbeScript, parseProbeLine, wsdVerdict, createHttpHandler, SESSION_COOKIE, parseSqlConnStr, countPdfPages, loadConfig, DEFAULTS,
  SEARCH_SQL, LINES_SQL, BALANCE_SQL, createRenderer,
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes("--health") || argv.includes("--selftest")) {
    cli(argv).then((c) => process.exit(c), (err) => { console.error(String(err.message || err)); process.exit(1); });
  } else {
    main().catch((err) => { console.error(String(err.message || err)); process.exit(1); });
  }
}
