// اختبارات أداة الطباعة اليدوية A4 — بلا SQL حقيقي وبلا طابعة.
// المصدر الوهمي يحاكي صفوف الأمين؛ المحوّل إلى PDF حقيقي (Chromium) إن وُجد.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const dir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const { assertReadOnlySql } = require(path.join(dir, "lib", "sql-guard.js"));
const model = require(path.join(dir, "lib", "invoice-model.js"));
const { createPrintGuard, REPRINT_COOLDOWN_MS } = require(path.join(dir, "lib", "print-guard.js"));
const { createPrintLog } = require(path.join(dir, "lib", "print-log.js"));
const { paperFor } = require(path.join(dir, "lib", "paper.js"));
const server = require(path.join(dir, "server.js"));

const WHOLESALE = "7f5b0921-61f3-4f23-a1f4-fbfae4144bf4";
const CASHIER = "cc1097b1-662d-4d80-8e4e-3b493249591c";
const G1 = "11111111-1111-4111-8111-111111111111";
const G2 = "22222222-2222-4222-8222-222222222222";
const G3 = "33333333-3333-4333-8333-333333333333";

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "ozk-manual-")); }

// ─── حارس القراءة فقط ───────────────────────────────────────────────────────
test("كل استعلامات الأداة SELECT صافية وتجتاز الحارس", () => {
  assert.ok(server.SEARCH_SQL && server.LINES_SQL && server.BALANCE_SQL);
});

test("الحارس يرفض أي كتابة أو عبارة ثانية أو تنفيذ إجراء", () => {
  const bad = [
    "UPDATE bu000 SET Total = 0",
    "SELECT 1; DELETE FROM bu000",
    "SELECT * INTO x FROM bu000",
    "EXEC sp_who",
    "WITH a AS (SELECT 1 x) DELETE FROM bu000",
    "INSERT INTO t VALUES (1)",
    "SELECT 1 /* */ ; DROP TABLE bu000",
  ];
  for (const s of bad) assert.throws(() => assertReadOnlySql(s), undefined, s);
  // الكلمات داخل نص حرفي أو تعليق لا تُحسب.
  assert.doesNotThrow(() => assertReadOnlySql("-- update\nSELECT N'delete' AS x"));
});

test("لا يحتوي مجلد الأداة نص SQL كتابي في أي ملف .sql", () => {
  for (const f of fs.readdirSync(path.join(dir, "lib")).filter((n) => n.endsWith(".sql"))) {
    assert.doesNotThrow(() => assertReadOnlySql(fs.readFileSync(path.join(dir, "lib", f), "utf8")), f);
  }
});

// ─── النموذج ────────────────────────────────────────────────────────────────
test("الكمية بوحدة الإدخال 1/2/3 والمعامل المفقود لا يُقسَم عليه", () => {
  const base = { item_name: "صنف", unit1_name: "كروز", unit2_name: "كرتونة", unit3_name: "طرد", unit2_fact: 50, unit3_fact: 500, qty: 100 };
  assert.deepEqual(model.lineFromRow({ ...base, input_unit: 1 }), { name: "صنف", unit: "كروز", qty: 100 });
  assert.deepEqual(model.lineFromRow({ ...base, input_unit: 2 }), { name: "صنف", unit: "كرتونة", qty: 2 });
  assert.deepEqual(model.lineFromRow({ ...base, input_unit: 3 }), { name: "صنف", unit: "طرد", qty: 0.2 });
  assert.deepEqual(model.lineFromRow({ ...base, input_unit: 2, unit2_fact: 0 }), { name: "صنف", unit: "كروز", qty: 100 });
});

test("الكاشير ونوع غير معتمد لا يُطبعان، والجملة تُطبع", () => {
  assert.equal(model.printBlockReason(WHOLESALE, {}), "");
  assert.match(model.printBlockReason(CASHIER, {}), /الكاشير/);
  assert.match(model.printBlockReason(CASHIER, { allowedTypeGuids: [CASHIER] }), /الكاشير/);
  assert.match(model.printBlockReason(G3, {}), /غير مدعوم/);
});

test("المبالغ تُحوَّل لعملة الفاتورة بـCurrencyVal كما في المراقب", () => {
  const h = model.headerFromRow({ invoice_guid: G1, invoice_number: 5, invoice_date: "2026-10-22", type_guid: WHOLESALE, type_name: "مبيعات", total: 2, discount: 0, first_pay: 1, currency_val: 0.0001, currency_iso: "SYP", line_count: 1 }, {});
  assert.equal(Math.round(h.total), 20000);
  const inv = model.buildInvoice(h, [], 3);
  assert.equal(Math.round(inv.customerBalance), 30000);
  assert.equal(model.buildInvoice(h, [], null).customerBalanceFound, false);
});

test("A5 غير متاح ما لم يُفعَّل في الإعداد", () => {
  assert.equal(paperFor("A4", {}).label, "A4");
  assert.throws(() => paperFor("A5", {}));
  assert.equal(paperFor("a5", { papers: ["A4", "A5"] }).label, "A5");
  assert.throws(() => paperFor("Letter", { papers: ["Letter"] }));
});

// ─── منع التكرار ────────────────────────────────────────────────────────────
test("منع التكرار: نقرتان متزامنتان، إعادة بلا تأكيد، تهدئة، ثم تأكيد", () => {
  let t = 1_000_000;
  const log = createPrintLog(path.join(tmp(), "log.jsonl"), { now: () => new Date(t) });
  const guard = createPrintGuard({ log, now: () => t });
  const tok = guard.issue(G1, { paper: "A4", number: 7 });

  const a = guard.begin(tok);
  assert.equal(a.ok, true);
  const b = guard.begin(tok);
  assert.equal(b.code, "IN_FLIGHT");
  log.append({ event: "print_sent", guid: G1, copies: 1 });
  a.finish(true);

  assert.equal(guard.begin(tok).code, "COOLDOWN");
  t += REPRINT_COOLDOWN_MS + 1;
  const c = guard.begin(tok);
  assert.equal(c.code, "NEEDS_CONFIRM");
  assert.equal(c.previous.length, 1);
  const d = guard.begin(tok, { confirmReprint: true });
  assert.equal(d.ok, true);
  assert.equal(d.reprint, true);
  d.finish(false);

  // معاينة جديدة لنفس الفاتورة لا تتجاوز السجل.
  const tok2 = guard.issue(G1, { paper: "A4", number: 7 });
  assert.equal(guard.begin(tok2).code, "NEEDS_CONFIRM");
  assert.equal(guard.begin("nope").code, "NO_PREVIEW");
});

test("فشل الإرسال لا يستهلك المعاينة ولا يُعدّ طباعة", () => {
  const log = createPrintLog(path.join(tmp(), "log.jsonl"));
  const guard = createPrintGuard({ log });
  const tok = guard.issue(G2, {});
  const a = guard.begin(tok);
  a.finish(false);
  const b = guard.begin(tok);
  assert.equal(b.ok, true);
  b.finish(false);
});

// ─── التطبيق كاملاً بمصدر وهمي ──────────────────────────────────────────────
const SEARCH_ROWS = {
  42: [
    { invoice_guid: G1, invoice_number: 42, invoice_date: "2026-10-22", type_guid: WHOLESALE, type_name: "مبيعات", bill_type: 1, is_posted: 1, customer_name: "زبون تجريبي", total: 286, discount: 0, first_pay: 100, currency_val: 1, currency_iso: "USD", line_count: 2 },
    { invoice_guid: G2, invoice_number: 42, invoice_date: "2026-10-20", type_guid: CASHIER, type_name: "مبيعات مركز", bill_type: 1, is_posted: 1, customer_name: "", total: 5, discount: 0, first_pay: 5, currency_val: 1, currency_iso: "USD", line_count: 1 },
  ],
};
const LINES = {
  [G1]: [
    { item_name: "دخان تجريبي أحمر", input_unit: 2, unit1_name: "كروز", unit2_name: "كرتونة", unit3_name: "", unit2_fact: 50, unit3_fact: 0, qty: 50 },
    { item_name: "دخان تجريبي أزرق", input_unit: 1, unit1_name: "كروز", unit2_name: "كرتونة", unit3_name: "", unit2_fact: 50, unit3_fact: 0, qty: 10 },
  ],
};

function fakeAmeen() {
  const calls = [];
  return {
    calls,
    describe: () => ({ server: "fake", database: "AmnDb002", user: "reader" }),
    ping: async () => ({ db: "AmnDb002", login: "reader" }),
    search: async (n) => { calls.push(["search", n]); return SEARCH_ROWS[n] || []; },
    lines: async (g) => { calls.push(["lines", g]); return LINES[g] || []; },
    balance: async () => 1234.5,
  };
}

// المحوّل الحقيقي يحتاج puppeteer-core (npm ci داخل مجلد الأداة) وChromium؛
// بغياب أحدهما (عدّاء CI عام) يُتخطّى اختبار PDF وحده صراحةً لا صمتاً.
function hasPuppeteer() {
  try { require.resolve("puppeteer-core", { paths: [dir] }); return true; } catch { return false; }
}
function findChromium() {
  if (!hasPuppeteer()) return "";
  return [process.env.OZK_BROWSER_PATH, "/opt/pw-browsers/chromium"].find((p) => p && fs.existsSync(p)) || "";
}

function makeApp(over) {
  const dataDir = tmp();
  const cfg = { ...server.DEFAULTS, dataDir, browserPath: findChromium(), papers: ["A4", "A5"], ...over };
  const log = createPrintLog(path.join(dataDir, "print-log.jsonl"));
  const sent = [];
  const printerState = { value: { state: "ready" } };
  const printer = {
    probe: () => printerState.value,
    send: (pdf, paper, copies) => { assert.ok(fs.existsSync(pdf)); sent.push({ paper: paper.label, copies }); },
  };
  const renderer = cfg.browserPath ? server.createRenderer(cfg) : {
    browserPath: () => "",
    render: async (_html, _paper, out) => { fs.writeFileSync(out, "%PDF-1.4 /Type /Page"); return { fontOk: true, pages: 1, bytes: 10 }; },
    close: async () => {},
  };
  const ameen = fakeAmeen();
  const guard = createPrintGuard({ log });
  const app = server.createApp({ cfg, ameen, renderer, printer, log, guard });
  return { app, cfg, log, sent, renderer, ameen, printerState };
}

test("بحث برقم مكرر يعيد السجلين مع النوع، والكاشير محجوب", async () => {
  const { app } = makeApp({ browserPath: "" });
  const m = await app.search(42);
  assert.equal(m.length, 2);
  assert.equal(m[0].printable, true);
  assert.equal(m[0].typeName, "مبيعات");
  assert.equal(m[1].printable, false);
  assert.deepEqual(await app.search(999), []);
});

test("معاينة بلا بحث سابق مرفوضة، ومعاينة الكاشير مرفوضة", async () => {
  const { app } = makeApp({ browserPath: "" });
  await assert.rejects(app.preview(G1, "A4"), /غير موجودة/);
  for (const m of await app.search(42)) app.knownNumbers.set(m.guid, 42);
  await assert.rejects(app.preview(G2, "A4"), /الكاشير/);
});

test("PDF حقيقي: خط Cairo مضمَّن، صفحة A4 واحدة، وA5 بحجمه الصحيح", { skip: !findChromium() && "لا Chromium أو puppeteer-core" }, async () => {
  const { app, renderer } = makeApp();
  try {
    for (const m of await app.search(42)) app.knownNumbers.set(m.guid, 42);
    const a4 = await app.preview(G1, "A4");
    assert.equal(a4.fontOk, true, "Cairo يجب أن يُحمَّل فعلاً");
    assert.equal(a4.pages, 1);
    const a4pdf = fs.readFileSync(path.join(app.previewDir, `${a4.token}.pdf`)).toString("latin1");
    assert.match(a4pdf, /Cairo/, "اسم الخط داخل ملف PDF (مضمَّن)");
    assert.match(a4pdf, /MediaBox\s*\[\s*0 0 59[45](\.\d+)? 84[12]/, "A4 = 595×842 نقطة");

    const a5 = await app.preview(G1, "A5");
    assert.equal(a5.fontOk, true);
    assert.equal(a5.pages, 1, "الفاتورة القصيرة تسع صفحة A5 واحدة");
    const a5pdf = fs.readFileSync(path.join(app.previewDir, `${a5.token}.pdf`)).toString("latin1");
    assert.match(a5pdf, /MediaBox\s*\[\s*0 0 4(19|20)(\.\d+)? 59[45]/, "A5 = 420×595 نقطة");
    for (const [n, f] of [["a4", a4], ["a5", a5]]) {
      fs.copyFileSync(path.join(app.previewDir, `${f.token}.pdf`), path.join(process.env.OZK_TEST_OUT || os.tmpdir(), `manual-print-sample-${n}.pdf`));
    }
  } finally {
    await renderer.close();
  }
});

test("dryRun: لا إرسال للطابعة إطلاقاً ويُسجَّل الحدث", async () => {
  const { app, sent, log } = makeApp({ browserPath: "", dryRun: true });
  for (const m of await app.search(42)) app.knownNumbers.set(m.guid, 42);
  const p = await app.preview(G1, "A4");
  const r = await app.print(p.token, 1, false);
  assert.equal(r.ok, true);
  assert.equal(r.dryRun, true);
  assert.equal(sent.length, 0);
  assert.ok(log.readAll().some((e) => e.event === "dry_run"));
});

test("طباعة فعلية (وهمية): نقرتان متزامنتان ⇒ إرسال واحد، ثم إعادة بتأكيد فقط", async () => {
  const { app, sent, log } = makeApp({ browserPath: "", dryRun: false });
  for (const m of await app.search(42)) app.knownNumbers.set(m.guid, 42);
  const p = await app.preview(G1, "A4");
  const [r1, r2] = await Promise.all([app.print(p.token, 2, false), app.print(p.token, 2, false)]);
  assert.equal(sent.length, 1, "إرسال واحد فقط");
  assert.equal(sent[0].copies, 2);
  assert.equal([r1, r2].filter((r) => r.ok).length, 1);
  assert.equal(log.successfulPrints(G1).length, 1);

  const p2 = await app.preview(G1, "A4");
  assert.ok(p2.previousPrints.length === 1, "المعاينة تُظهر الطبعة السابقة");
  // خلال مهلة التهدئة يُرفض حتى مع معاينة جديدة؛ والتأكيد بعد المهلة مغطّى
  // في اختبار الحارس بساعة مزيّفة.
  const again = await app.print(p2.token, 1, true);
  assert.equal(again.code, "COOLDOWN");
  assert.equal(sent.length, 1);
});

test("عدد نسخ خارج الحد مرفوض، والطابعة غير الجاهزة تمنع الإرسال", async () => {
  const { app, sent } = makeApp({ browserPath: "", dryRun: false });
  for (const m of await app.search(42)) app.knownNumbers.set(m.guid, 42);
  const p = await app.preview(G1, "A4");
  await assert.rejects(app.print(p.token, 0, false));
  await assert.rejects(app.print(p.token, 99, false));

  const off = makeApp({ browserPath: "", dryRun: false });
  off.printerState.value = { state: "offline", reason: "الطابعة غير متصلة (Work Offline)" };
  for (const m of await off.app.search(42)) off.app.knownNumbers.set(m.guid, 42);
  const q = await off.app.preview(G1, "A4");
  const r = await off.app.print(q.token, 1, false);
  assert.equal(r.code, "PRINTER");
  assert.equal(off.sent.length + sent.length, 0);
  // بعد عودة الطابعة: المعاينة نفسها ما زالت صالحة (الرفض لم يستهلكها).
  off.printerState.value = { state: "ready" };
  assert.equal((await off.app.print(q.token, 1, false)).ok, true);
  assert.equal(off.sent.length, 1);
});

test("HTTP: مضيف غير محلي مرفوض، وPOST بلا ترويسة X-OZK مرفوض", async () => {
  const { app, cfg } = makeApp({ browserPath: "" });
  const h = server.createHttpHandler(app, cfg);
  const call = (method, url, headers) => new Promise((resolve) => {
    const res = { status: 0, writeHead(s) { this.status = s; }, end(b) { resolve({ status: this.status, body: String(b) }); } };
    const req = { method, url, headers: { host: `127.0.0.1:${cfg.port}`, ...headers }, on: () => undefined };
    h.handle(req, res);
  });
  assert.equal((await call("GET", "/api/ping", { host: "evil.example:80" })).status, 403);
  assert.equal((await call("POST", "/api/print", {})).status, 403);
  assert.equal((await call("GET", "/api/search?number=abc")).status, 400);
  const ok = await call("GET", "/api/search?number=42");
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).matches.length, 2);
});

test("تحليل سلسلة الاتصال: مثيل ومنفذ واسم مستخدم، وقراءة فقط", () => {
  const c = server.parseSqlConnStr("Server=OZK-TOBACCO\\SQL2019,1433;Database=AmnDb002;User Id=ozk_print_reader;Password=x;");
  assert.equal(c.server, "OZK-TOBACCO");
  assert.equal(c.port, 1433);
  assert.equal(c.options.instanceName, "SQL2019");
  assert.equal(c.user, "ozk_print_reader");
  assert.equal(c.options.readOnlyIntent, true);
});

async function httpSearch(ameenSearch) {
  const { app, cfg, ameen } = makeApp({ browserPath: "" });
  ameen.search = ameenSearch;
  const h = server.createHttpHandler(app, cfg);
  const origError = console.error;
  console.error = () => undefined;
  try {
    return await new Promise((resolve) => {
      const res = { status: 0, writeHead(st) { this.status = st; }, end(b) { resolve({ status: this.status, body: String(b) }); } };
      h.handle({ method: "GET", url: "/api/search?number=42", headers: { host: `127.0.0.1:${cfg.port}` }, on: () => undefined }, res);
    });
  } finally {
    console.error = origError;
  }
}

test("HTTP: خطأ داخلي لا يكشف نصّ الاستثناء للواجهة", async () => {
  const out = await httpSearch(async () => { throw new Error("secret-detail Password=x at Connection"); });
  assert.equal(out.status, 500);
  assert.doesNotMatch(out.body, /secret-detail|Password/);
});

test("HTTP: خطأ مكتبة يحمل status لا يُعامل كـhttpError ولا يكشف النص", async () => {
  // مكتبات HTTP/SQL كثيراً ما تضع .status على الاستثناء؛ هذا ليس httpError.
  const out = await httpSearch(async () => {
    const e = new Error("secret-detail Password=x at Connection\n    at Object.search (server.js:1:1)");
    e.status = 503;
    throw e;
  });
  assert.equal(out.status, 500);
  assert.match(out.body, /خطأ داخلي/);
  assert.doesNotMatch(out.body, /secret-detail|Password|at Object.search/);
});
