// اختبارات أرشفة سندات القبض (المرحلة 2) — أمين وDrive وEdge وهمية بالذاكرة، بلا شبكة ولا
// بيانات زبائن حقيقية. قرار المالك: مستند لكل زبون في كل سند، ومبلغا الزبون نفسه في السند
// نفسه في ورقة واحدة، ولا تجميع لسندات مختلفة أبداً.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fakes = require("./fakes.cjs");
const { createStore } = require(path.join(dir, "lib", "store.js"));
const { createArchiver } = require(path.join(dir, "lib", "archiver.js"));
const { createDrive } = require(path.join(dir, "lib", "drive.js"));
const { createEdge } = require(path.join(dir, "lib", "edge.js"));
const { validate, DEFAULTS, RECEIPT_TYPE_GUID } = require(path.join(dir, "lib", "config.js"));
const { assertReadOnlySql } = require(path.join(dir, "..", "manual-a4-print", "lib", "sql-guard.js"));
const template = require(path.join(dir, "..", "ameen-autoprint", "invoice-html.js"));
const receiptTemplate = require(path.join(dir, "lib", "receipt-html.js"));
const receiptModel = require(path.join(dir, "lib", "receipt-model.js"));
const { paperFor } = require(path.join(dir, "..", "manual-a4-print", "lib", "paper.js"));

const R1 = "a1111111-1111-4111-8111-111111111111";
const R2 = "a2222222-2222-4222-8222-222222222222";
const R3 = "a3333333-3333-4333-8333-333333333333";
const CA = "aaaaaaaa-0000-4000-8000-000000000001";
const CB = "bbbbbbbb-0000-4000-8000-000000000002";
const CC = "cccccccc-0000-4000-8000-000000000003";

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "ozk-receipts-")); }
function credentials() {
  return { client_id: "cid.apps.googleusercontent.com", client_secret: "GOCSPX-test-secret-value", refresh_token: "1//refresh-token-for-tests-only" };
}

async function setup({ mode = "live", receipts = {}, withTemplate = true } = {}) {
  const dataDir = tmp();
  const ameen = fakes.createFakeAmeen();
  const renderer = fakes.createFakeRenderer();
  const drive = fakes.createFakeDrive({});
  const edgeFake = await fakes.createFakeEdge();
  let clock = Date.parse("2026-10-24T12:00:00Z");
  const now = () => clock;
  const { baselineGuids = [], ...rc } = receipts;
  const prod = { newInvoicesFrom: "1900-01-01T00:00:00", baselineFile: "test-baseline.json", baselineSha256: "0".repeat(64) };
  const rprod = { enabled: true, newReceiptsFrom: "1900-01-01T00:00:00", baselineFile: "test-receipts-baseline.json", baselineSha256: "1".repeat(64) };
  const cfg = validate({ ...DEFAULTS, mode, archiveFrom: "2026-10-01", dataDir, edgeUrl: edgeFake.url, ...prod, receipts: { ...DEFAULTS.receipts, ...rprod, ...rc } }, clock);
  cfg.baselineGuids = [];
  cfg.receipts.baselineGuids = baselineGuids;
  const logs = [];
  const build = () => {
    const store = createStore(dataDir, now);
    const driveClient = createDrive({ credentials: credentials(), expectedEmail: cfg.expectedAccountEmail, fetchImpl: drive.fetchImpl, now });
    const edge = createEdge({ url: edgeFake.url, secret: edgeFake.state.secret, fetchImpl: edgeFake.fetchImpl, host: "TEST" });
    const archiver = createArchiver({
      cfg, store, ameen: ameen.api, renderer, template, receiptTemplate: withTemplate ? receiptTemplate : null,
      paper: paperFor("A4", { papers: ["A4"] }), getDrive: () => driveClient, edge, log: (e) => logs.push(e), now,
    });
    return { store, archiver };
  };
  let env = build();
  return {
    cfg, ameen, renderer, drive, edgeFake, logs,
    get store() { return env.store; },
    restart() { env = build(); return env; },
    advance(seconds) {
      clock += seconds * 1000;
      ameen.setNow(new Date(Date.parse(`${ameen.db.now}Z`) + seconds * 1000).toISOString().slice(0, 19));
    },
    cycle() { return env.archiver.cycle({ host: "TEST", version: "test" }); },
  };
}

const receiptJobs = (env) => env.store.jobs().filter((j) => j.docType === "receipt");

// ─── الإعداد ───
test("الإعداد: سندات القبض معطّلة افتراضياً، ونوعها «سند قبض» المكتشف من الأمين", () => {
  assert.equal(DEFAULTS.receipts.enabled, false);
  assert.equal(RECEIPT_TYPE_GUID, "a83da629-4a8b-4c2c-9d7a-a963de3640a5");
  const base = { ...DEFAULTS, archiveFrom: "2026-10-01" };
  assert.equal(validate(base).receipts.enabled, false);
  // مفعّلة برفع فعلي بلا حصر ⇒ تُلزم لحظة القطع ولقطة الأساس.
  assert.throws(() => validate({ ...base, mode: "drive", newInvoicesFrom: "1900-01-01T00:00:00", baselineFile: "b.json", baselineSha256: "0".repeat(64), receipts: { ...DEFAULTS.receipts, enabled: true } }), /newReceiptsFrom|baseline/);
  assert.throws(() => validate({ ...base, receipts: { ...DEFAULTS.receipts, enabled: true, typeGuid: "x" } }), /typeGuid|GUID/i);
});

test("الحارس: كل استعلامات السندات قراءة فقط", () => {
  for (const f of ["receipts-query.sql", "receipt-balance-query.sql", "receipt-baseline-query.sql"]) {
    const sql = fs.readFileSync(path.join(dir, "lib", f), "utf8");
    assert.doesNotThrow(() => assertReadOnlySql(sql), f);
    assert.doesNotMatch(sql, /\b(insert|update|delete|merge|exec|drop|alter|create)\b/i, f);
  }
});

// ─── النموذج ───
test("النموذج: هوية المستند ثابتة لكل (سند، حساب) ومختلفة بين الزبائن", () => {
  const a = receiptModel.receiptDocGuid(R1, CA);
  assert.equal(a, receiptModel.receiptDocGuid(R1.toUpperCase(), CA));
  assert.notEqual(a, receiptModel.receiptDocGuid(R1, CB));
  assert.notEqual(a, receiptModel.receiptDocGuid(R2, CA));
  assert.ok(receiptModel.isGuid(a));
});

// ─── الرصد والأرشفة ───
test("سند بثلاثة زبائن ⇒ ثلاثة PDF مستقلة، ومبلغا الزبون نفسه في ورقة واحدة", async () => {
  const env = await setup();
  const { ameen } = env;
  ameen.addReceipt({
    guid: R1, number: "501",
    lines: [
      ameen.receiptLine({ accountGuid: CA, customerGuid: CA, customer: "زبون أ", amount: 100 }),
      ameen.receiptLine({ accountGuid: CA, customerGuid: CA, customer: "زبون أ", amount: 50 }),
      ameen.receiptLine({ accountGuid: CB, customerGuid: CB, customer: "زبون ب", amount: 70 }),
      ameen.receiptLine({ accountGuid: CC, customerGuid: CC, customer: "زبون ج", amount: 100, currencyVal: 1 / 14050, currencyIso: "SYP" }),
    ],
  });
  env.advance(600);
  await env.cycle();
  const jobs = receiptJobs(env);
  assert.equal(jobs.length, 3, "مستند لكل زبون");
  const by = Object.fromEntries(jobs.map((j) => [j.customerName, j]));
  assert.equal(by["زبون أ"].amount, 150, "المبلغان في ورقة واحدة");
  assert.equal(by["زبون ب"].amount, 70);
  assert.equal(by["زبون ج"].amount, 1405000, "الليرة بعملتها: Credit بالدولار ÷ CurrencyVal (دولار لكل ليرة)");
  assert.equal(by["زبون ج"].currencyIso, "SYP");
  assert.equal(new Set(jobs.map((j) => j.sourceGuid)).size, 3);
  assert.ok(jobs.every((j) => j.receiptGuid === R1 && j.number === "501" && j.version === 1));
  // كلها رُفعت وأُرسلت لمحادثة المالك وحدها.
  assert.equal(env.edgeFake.state.sent.length, 3);
  assert.ok(env.edgeFake.state.sent.every((s) => s.chat === "OWNER"));
  const capA = env.edgeFake.state.sent.find((s) => s.caption.includes("زبون أ")).caption;
  assert.match(capA, /سند قبض رقم/);
  assert.match(capA, /سند قبض جديد — أرشفة ناجحة/);
  assert.match(capA, /المبلغ المستلم/);
  assert.doesNotMatch(capA, /فاتورة/);
  assert.ok(env.edgeFake.state.sent.every((s) => /^.+ - سند قبض رقم 501 - \d{2}-\d{2}-\d{4}\.pdf$/.test(s.fileName)));
});

test("سندان للزبون نفسه في اليوم نفسه ⇒ ملفان مستقلان (لا تجميع بين السندات)", async () => {
  const env = await setup();
  env.ameen.addReceipt({ guid: R1, number: "601", lines: [env.ameen.receiptLine({ amount: 40 })] });
  env.ameen.addReceipt({ guid: R2, number: "602", lines: [env.ameen.receiptLine({ amount: 60 })] });
  env.advance(600);
  await env.cycle();
  const jobs = receiptJobs(env);
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs.map((j) => j.number).sort(), ["601", "602"]);
  assert.equal(env.edgeFake.state.sent.length, 2);
});

test("تعديل مبلغ بعد الأرشفة ⇒ V2 بجانب V1، والزبون غير المعدّل لا يتكرر", async () => {
  const env = await setup();
  const { ameen } = env;
  const la = ameen.receiptLine({ accountGuid: CA, customerGuid: CA, customer: "زبون أ", amount: 100 });
  const lb = ameen.receiptLine({ accountGuid: CB, customerGuid: CB, customer: "زبون ب", amount: 70 });
  ameen.addReceipt({ guid: R1, number: "701", lines: [la, lb] });
  env.advance(600);
  await env.cycle();
  assert.equal(receiptJobs(env).length, 2);
  env.advance(60);
  ameen.editReceipt(R1, { lines: [{ ...la, amount: 120 }, lb] });
  env.advance(600);
  await env.cycle();
  const jobs = receiptJobs(env);
  assert.equal(jobs.length, 3, "V2 للزبون أ وحده");
  const a = jobs.filter((j) => j.customerName === "زبون أ").sort((x, y) => x.version - y.version);
  assert.deepEqual(a.map((j) => j.version), [1, 2]);
  assert.equal(a[1].amount, 120);
  assert.equal(a[1].changeKind, "edited");
  assert.equal(a[1].previousJobId, a[0].jobId);
  assert.equal(a[0].sourceGuid, a[1].sourceGuid);
  const last = env.edgeFake.state.sent[env.edgeFake.state.sent.length - 1];
  assert.match(last.caption, /سند قبض معدّل/);
  assert.match(last.fileName, / - V2\.pdf$/);
  // دورة أخرى بلا تغيير: لا جديد.
  env.advance(600);
  await env.cycle();
  assert.equal(receiptJobs(env).length, 3);
});

test("غير مرحّل، أو قيد غير محسوم، أو غير مستقر ⇒ لا أرشفة؛ وبعد الاستقرار يؤرشف", async () => {
  const env = await setup();
  env.ameen.addReceipt({ guid: R1, number: "801", posted: 0 });
  env.ameen.addReceipt({ guid: R2, number: "802", entryLinks: 2 });
  env.ameen.addReceipt({ guid: R3, number: "803" });
  env.advance(5); // أقل من stableSeconds
  await env.cycle();
  assert.equal(receiptJobs(env).length, 0, "غير مستقر بعد");
  env.advance(600);
  await env.cycle();
  assert.deepEqual(receiptJobs(env).map((j) => j.number), ["803"]);
  assert.ok(env.logs.some((e) => e.event === "receipt_entry_unresolved"), "القيد الملتبس يُذكر في السجل");
  // الترحيل لاحقاً يُرى بالمطابقة/التغيير.
  env.ameen.editReceipt(R1, { posted: 1 });
  env.advance(600);
  await env.cycle();
  assert.deepEqual(receiptJobs(env).map((j) => j.number).sort(), ["801", "803"]);
});

test("سند بلا سطر قبض على زبون ⇒ لا مستند", async () => {
  const env = await setup();
  env.ameen.addReceipt({ guid: R1, number: "901", lines: [] });
  env.advance(600);
  await env.cycle();
  assert.equal(receiptJobs(env).length, 0);
});

test("النطاق: لقطة الأساس ولحظة القطع تمنعان ما سبق التفعيل", async () => {
  const env = await setup({ receipts: { baselineGuids: [R1], newReceiptsFrom: "2026-10-24T12:00:00" } });
  env.ameen.addReceipt({ guid: R1, number: "1001" }); // في اللقطة
  env.ameen.addReceipt({ guid: R2, number: "1002", createdAt: "2026-10-20T09:00:00", date: "2026-10-20" }); // قبل القطع
  env.ameen.addReceipt({ guid: R3, number: "1003" });
  env.advance(600);
  await env.cycle();
  assert.deepEqual(receiptJobs(env).map((j) => j.number), ["1003"]);
});

test("الحصر التجريبي: سند واحد فقط", async () => {
  const env = await setup({ receipts: { pilotGuids: [R2], pilotExpiresAt: "2026-10-28" } });
  env.ameen.addReceipt({ guid: R1, number: "1101" });
  env.ameen.addReceipt({ guid: R2, number: "1102" });
  env.advance(600);
  await env.cycle();
  assert.deepEqual(receiptJobs(env).map((j) => j.number), ["1102"]);
  assert.equal(env.edgeFake.state.sent.length, 1);
});

test("معطّلة ⇒ لا قراءة للسندات أصلاً؛ وبلا قالب ⇒ لا رصد", async () => {
  for (const opts of [{ receipts: { enabled: false } }, { withTemplate: false }]) {
    const env = await setup(opts);
    let calls = 0;
    const orig = env.ameen.api.changedReceipts;
    env.ameen.api.changedReceipts = async (a) => { calls++; return orig(a); };
    env.restart();
    env.ameen.addReceipt({ guid: R1, number: "1201" });
    env.advance(600);
    await env.cycle();
    assert.equal(calls, 0);
    assert.equal(receiptJobs(env).length, 0);
  }
});

test("وضع dry-run: PDF محلي فقط، بلا Drive ولا تيليغرام", async () => {
  const env = await setup({ mode: "dry-run", receipts: { newReceiptsFrom: "", baselineFile: "", baselineSha256: "" } });
  env.ameen.addReceipt({ guid: R1, number: "1301" });
  env.advance(600);
  await env.cycle();
  const [job] = receiptJobs(env);
  assert.ok(job);
  assert.ok(fs.existsSync(env.store.pdfPath(job.jobId)));
  assert.equal(env.edgeFake.state.sent.length, 0);
});

test("القالب: Cairo مضمَّن، وكل الحقول الأساسية، والرصيد بعد الدفعة", () => {
  const [rec] = receiptModel.groupReceipts([
    { receipt_guid: R1, receipt_number: "77", receipt_date: "2026-11-03", receipt_notes: "دفعة على الحساب", entry_links: 1, entry_guid: CC, is_posted: 1,
      line_guid: "eeeeeeee-0000-4000-8000-000000000001", line_number: 1, account_guid: CA, customer_guid: CA, customer_name: "زبون <أ>",
      amount: 25, native_amount: 351250, currency_val: 1 / 14050, currency_iso: "SYP", cash_name: "صندوق الليرة", line_notes: "",
      changed_at: "2026-11-03T10:00:00", created_at: "2026-11-03T10:00:00", seconds_since_change: 900 },
  ]);
  const doc = { ...rec.docs[0], balance: { previous: 525, current: 500 } };
  const html = receiptTemplate.buildReceiptHtml(doc);
  assert.match(html, /@font-face\{font-family:"Cairo"/);
  assert.match(html, /<h1>سند قبض<\/h1>/);
  assert.match(html, /رقم: 77/);
  assert.match(html, /زبون &lt;أ&gt;/, "الاسم مُهرَّب");
  assert.match(html, /351,250<\/span> ل\.س/);
  assert.match(html, /المعادل: <span dir="ltr">\$ 25<\/span>/);
  assert.match(html, /الرصيد بعد الدفعة/);
  assert.match(html, /\$ 500/);
  assert.match(html, /صندوق الليرة/);
  const none = receiptTemplate.buildReceiptHtml({ ...doc, balance: null });
  assert.match(none, /غير متاح/);
});

function playwright() {
  try { return require("playwright"); } catch { return null; }
}

test("PDF حقيقي لسند قبض: A4 وخط Cairo مضمَّن وصفحة واحدة", { skip: !playwright() && "Playwright غير متاح" }, async () => {
  const pw = playwright();
  const browser = await pw.chromium.launch();
  try {
    let fontOk = false;
    const [rec] = receiptModel.groupReceipts([1, 2].map((n) => ({
      receipt_guid: R1, receipt_number: "88", receipt_date: "2026-11-03", receipt_notes: "", entry_links: 1, entry_guid: CC, is_posted: 1,
      line_guid: `eeeeeeee-0000-4000-8000-00000000000${n}`, line_number: n, account_guid: CA, customer_guid: CA, customer_name: "زبون اختبار",
      amount: 100 * n, native_amount: 100 * n, currency_val: 1, currency_iso: "USD", cash_name: "الصندوق الرئيسي", line_notes: `دفعة ${n}`,
      changed_at: "2026-11-03T10:00:00", created_at: "2026-11-03T10:00:00", seconds_since_change: 900,
    })));
    const html = receiptTemplate.buildReceiptHtml({ ...rec.docs[0], balance: { previous: 900, current: 600 } });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    fontOk = await page.evaluate(() => document.fonts.check("700 16px Cairo") && [...document.fonts].some((f) => f.family.replace(/"/g, "") === "Cairo" && f.status === "loaded"));
    const pdf = await page.pdf({ format: "A4", printBackground: true, margin: { top: "12mm", bottom: "12mm", left: "12mm", right: "12mm" } });
    await page.close();
    assert.ok(fontOk, "Cairo محمَّل");
    assert.ok(pdf.subarray(0, 5).equals(Buffer.from("%PDF-")));
    assert.match(pdf.toString("latin1"), /Cairo/);
    assert.equal((pdf.toString("latin1").match(/\/Type\s*\/Page(?![s\w])/g) || []).length, 1, "صفحة واحدة");
    assert.equal(rec.docs.length, 1, "المبلغان في ورقة واحدة");
    assert.equal(rec.docs[0].amount, 300);
  } finally {
    await browser.close();
  }
});
