// اختبارات عامل أرشفة Google Drive — أمين وDrive وEdge وهمية بالذاكرة، بلا شبكة
// ولا بيانات زبائن حقيقية. اختبار PDF الحقيقي (Chromium) يعمل إن وُجد Playwright.
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
const { createDrive, DriveError, qValue } = require(path.join(dir, "lib", "drive.js"));
const { createEdge } = require(path.join(dir, "lib", "edge.js"));
const { validate, DEFAULTS, APPROVED_ACCOUNT } = require(path.join(dir, "lib", "config.js"));
const naming = require(path.join(dir, "lib", "naming.js"));
const { redact, registerSecret } = require(path.join(dir, "lib", "redact.js"));
const { assertReadOnlySql } = require(path.join(dir, "..", "manual-a4-print", "lib", "sql-guard.js"));
const template = require(path.join(dir, "..", "ameen-autoprint", "invoice-html.js"));
const { paperFor } = require(path.join(dir, "..", "manual-a4-print", "lib", "paper.js"));

const G1 = "11111111-1111-4111-8111-111111111111";
const G2 = "22222222-2222-4222-8222-222222222222";
const G3 = "33333333-3333-4333-8333-333333333333";
const G4 = "44444444-4444-4444-8444-444444444444";
const CUST_B = "bbbbbbbb-0000-4000-8000-000000000002";

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "ozk-drive-archive-")); }

function credentials() {
  return { client_id: "cid.apps.googleusercontent.com", client_secret: "GOCSPX-test-secret-value", refresh_token: "1//refresh-token-for-tests-only" };
}

// بيئة كاملة: الساعة الوهمية تتقدّم مع ساعة الأمين، والإعداد صالح.
async function setup({ mode = "live", email, overrides = {} } = {}) {
  const dataDir = tmp();
  const ameen = fakes.createFakeAmeen();
  const renderer = fakes.createFakeRenderer();
  const drive = fakes.createFakeDrive({ email });
  const edgeFake = await fakes.createFakeEdge();
  let clock = Date.parse("2026-10-24T12:00:00Z");
  const now = () => clock;
  const cfg = validate({ ...DEFAULTS, mode, archiveFrom: "2026-10-01", dataDir, edgeUrl: edgeFake.url, ...overrides });
  const logs = [];
  const log = (e) => logs.push(e);
  const build = () => {
    const store = createStore(dataDir, now);
    const driveClient = createDrive({ credentials: credentials(), expectedEmail: cfg.expectedAccountEmail, fetchImpl: drive.fetchImpl, now });
    const edge = createEdge({ url: edgeFake.url, secret: edgeFake.state.secret, fetchImpl: edgeFake.fetchImpl, host: "TEST" });
    const archiver = createArchiver({ cfg, store, ameen: ameen.api, renderer, template, paper: paperFor("A4", { papers: ["A4"] }), getDrive: () => driveClient, edge, log, now });
    return { store, archiver };
  };
  let env = build();
  return {
    cfg, ameen, renderer, drive, edgeFake, logs,
    get store() { return env.store; },
    get archiver() { return env.archiver; },
    restart() { env = build(); return env; },
    advance(seconds) {
      clock += seconds * 1000;
      const t = new Date(Date.parse(`${ameen.db.now}Z`) + seconds * 1000).toISOString().slice(0, 19);
      ameen.setNow(t);
    },
    cycle() { return env.archiver.cycle({ host: "TEST", version: "test" }); },
  };
}

// ─── الإعداد ───
test("الإعداد: الحساب الوحيد المقبول ozkkhallouf@gmail.com، وozkkh27 مرفوض", () => {
  assert.equal(APPROVED_ACCOUNT, "ozkkhallouf@gmail.com");
  assert.throws(() => validate({ ...DEFAULTS, archiveFrom: "2026-10-01", expectedAccountEmail: "ozkkh27@gmail.com" }), /الحساب المعتمد/);
  assert.throws(() => validate({ ...DEFAULTS, archiveFrom: "" }), /archiveFrom/);
  assert.throws(() => validate({ ...DEFAULTS, archiveFrom: "2026-10-01", mode: "live", edgeUrl: "" }), /edgeUrl/);
  assert.equal(validate({ ...DEFAULTS, archiveFrom: "2026-10-01" }).mode, "dry-run", "الافتراضي dry-run");
});

test("كل استعلامات العامل SELECT صافية وتجتاز الحارس", () => {
  for (const f of fs.readdirSync(path.join(dir, "lib")).filter((n) => n.endsWith(".sql"))) {
    assert.doesNotThrow(() => assertReadOnlySql(fs.readFileSync(path.join(dir, "lib", f), "utf8")), f);
  }
  const src = fs.readFileSync(path.join(dir, "worker.js"), "utf8");
  assert.doesNotMatch(src, /ExecuteNonQuery|\.execute\(|\.batch\(|bulk\(/, "لا تنفيذ إجراءات ولا كتابة");
});

// ─── التجربة المحصورة ───
const DAY = 86400_000;
const dayOf = (ms) => new Date(ms + 3 * 3600_000).toISOString().slice(0, 10);

test("التجربة المحصورة: تتطلب انتهاءً قريباً، وبعده يرفض العامل العمل كلياً", () => {
  const now = Date.parse("2026-10-25T03:00:00Z");
  const base = { ...DEFAULTS, archiveFrom: "2026-10-25" };
  const ok = validate({ ...base, pilotInvoiceGuids: [G1], pilotExpiresAt: "2026-10-26" }, now);
  assert.deepEqual(ok.pilotInvoiceGuids, [G1]);
  assert.equal(validate(base, now).pilotInvoiceGuids.length, 0, "الافتراضي: لا حصر");
  assert.throws(() => validate({ ...base, pilotInvoiceGuids: [G1] }, now), /pilotExpiresAt/);
  assert.throws(() => validate({ ...base, pilotInvoiceGuids: [G1], pilotExpiresAt: "2026-10-24" }, now), /انتهت التجربة/);
  assert.throws(() => validate({ ...base, pilotInvoiceGuids: [G1], pilotExpiresAt: "2026-11-05" }, now), /7 أيام/);
  assert.throws(() => validate({ ...base, pilotInvoiceGuids: ["1100"], pilotExpiresAt: "2026-10-26" }, now), /GUID/);
  assert.throws(() => validate({ ...base, pilotInvoiceGuids: [G1, G1.toUpperCase()], pilotExpiresAt: "2026-10-26" }, now), /مكرر/);
  assert.throws(() => validate({ ...base, pilotExpiresAt: "2026-10-26" }, now), /بلا pilotInvoiceGuids/);
  assert.throws(() => validate({ ...base, pilotInvoiceGuids: "x", pilotExpiresAt: "2026-10-26" }, now), /قائمة/);
  // آخر يوم بتوقيت دمشق ما زال صالحاً حتى منتصف ليله، ثم يُرفض.
  assert.doesNotThrow(() => validate({ ...base, pilotInvoiceGuids: [G1], pilotExpiresAt: "2026-10-25" }, Date.parse("2026-10-25T20:59:00Z")));
  assert.throws(() => validate({ ...base, pilotInvoiceGuids: [G1], pilotExpiresAt: "2026-10-25" }, Date.parse("2026-10-25T21:01:00Z")), /انتهت التجربة/);
  const example = JSON.parse(fs.readFileSync(path.join(dir, "config.example.json"), "utf8"));
  assert.equal(example.pilotInvoiceGuids, undefined, "مثال الإعداد بلا حصر");
});

test("التجربة المحصورة: انقضاء التاريخ أثناء عمل العملية يوقف كل المراحل (Fail Closed) ولا يتسع الحصر إلى كل الفواتير", async () => {
  const t = await setup({ mode: "dry-run" });
  // الساعة المحقونة 2026-10-24T12:00Z = 15:00 دمشق؛ آخر يوم مسموح هو اليوم نفسه.
  Object.assign(t.cfg, { mode: "live", pilotInvoiceGuids: [G1], pilotExpiresAt: "2026-10-24" });
  t.restart();
  t.advance(8 * 3600 + 59 * 60); // 20:59Z = 23:59 دمشق: ما زالت سارية
  t.ameen.add({ guid: G1, number: 1100 });
  t.ameen.add({ guid: G2, number: 1101 }); // خارج الحصر: يجب ألا تُلمس بعد الانقضاء أيضاً
  t.advance(300 - 120); // 21:02Z: انقضت، والعملية نفسها ما زالت تعمل
  const sentBefore = t.edgeFake.state.sent.length;
  const reportsBefore = t.edgeFake.state.reports.length;
  const out = await t.cycle();
  assert.equal(out.pilotExpired, true);
  assert.equal(out.detect, null, "لا قراءة للمصدر");
  assert.equal(out.upload, null);
  assert.equal(out.notify, null);
  assert.equal(out.report, null);
  assert.equal(t.store.jobs().length, 0, "لا مهمة");
  assert.equal(t.drive.pdfFiles().length, 0, "لا رفع");
  assert.equal(t.edgeFake.state.sent.length, sentBefore, "لا إشعار");
  assert.equal(t.edgeFake.state.reports.length, reportsBefore, "لا تقرير");
  assert.ok(t.logs.some((l) => l.event === "pilot_expired"));
  // دورات لاحقة في العملية نفسها: تبقى موقوفة، ولا تتحول إلى أرشفة كل الفواتير.
  t.advance(3 * 3600);
  const later = await t.cycle();
  assert.equal(later.pilotExpired, true);
  assert.equal(t.store.jobs().length, 0, "لا مهمة لأي فاتورة، داخل الحصر أو خارجه");
  assert.equal(t.store.versionsOf("wholesale_invoice", G2).length, 0);
  assert.equal(t.drive.pdfFiles().length, 0);
  // وعند إعادة التشغيل يرفض الإعداد نفسه، فلا يبدأ العامل أصلاً.
  assert.throws(() => validate({ ...DEFAULTS, archiveFrom: "2026-10-01", pilotInvoiceGuids: [G1], pilotExpiresAt: "2026-10-24" }, Date.parse("2026-10-24T21:02:00Z")), /انتهت التجربة/);
});

test("التجربة المحصورة: خطأ رصد لفاتورة خارجها يبقى في الطابور ويُؤرشف بعد رفع الحصر (Codex P1)", async () => {
  const t = await setup({ mode: "dry-run", overrides: { archiveFrom: "2026-01-01" } });
  const realRender = t.renderer.render;
  t.renderer.render = async () => { throw Object.assign(new Error("عطل"), { code: "RENDER" }); };
  t.ameen.add({ guid: G2, number: 41, date: "2026-01-05", createdAt: "2026-01-05T10:00:00" }); // خارج lookback
  t.advance(300);
  await t.cycle();
  assert.deepEqual(Object.keys(t.store.state.detectErrors), [G2]);
  t.renderer.render = realRender;
  Object.assign(t.cfg, { pilotInvoiceGuids: [G1], pilotExpiresAt: "2026-10-25" });
  t.restart();
  t.advance(3700);
  await t.cycle();
  assert.deepEqual(Object.keys(t.store.state.detectErrors), [G2], "لا يُحذف أثناء الحصر");
  assert.equal(t.store.jobs().length, 0);
  Object.assign(t.cfg, { pilotInvoiceGuids: [], pilotExpiresAt: "" });
  t.restart();
  t.advance(60);
  await t.cycle();
  assert.deepEqual(t.store.jobs().map((j) => j.number), [41], "يُؤرشف بعد رفع الحصر");
  assert.equal(Object.keys(t.store.state.detectErrors).length, 0);
});

test("التجربة المحصورة: فاتورة واحدة فقط تُرفع ويُرسل إشعارها، والمهام السابقة خارجها لا تُلمس، ورفع الحصر يعيد الباقي", async () => {
  const t = await setup({ mode: "dry-run" });
  t.ameen.add({ guid: G1, number: 1100 });
  t.ameen.add({ guid: G2, number: 1101 });
  t.advance(300);
  await t.cycle(); // DRY RUN سابق بلا حصر: مهمتان محليتان
  assert.equal(t.store.jobs().length, 2);
  t.ameen.add({ guid: G3, number: 1102 });
  const reportsBefore = t.edgeFake.state.reports.length;
  Object.assign(t.cfg, { mode: "live", pilotInvoiceGuids: [G1], pilotExpiresAt: dayOf(Date.now() + DAY) });
  t.restart();
  t.advance(t.cfg.reconcileMinutes * 60);
  const out = await t.cycle();
  assert.deepEqual(out.pilot, { invoices: 1, expiresAt: t.cfg.pilotExpiresAt });
  assert.deepEqual(t.drive.pdfFiles().map((f) => f.name), ["فاتورة جملة - رقم 1100 - 2026-10-24 - 11111111 - V1.pdf"]);
  assert.equal(t.edgeFake.state.sent.length, 1, "إشعار واحد للفاتورة المحصورة");
  assert.equal(t.store.versionsOf("wholesale_invoice", G3).length, 0, "فاتورة جديدة خارج الحصر لا تُرصد");
  assert.equal(t.store.state.hints[G3], undefined, "ولا تُعلَّم ملحوظة");
  const pilotReports = t.edgeFake.state.reports.slice(reportsBefore);
  assert.ok(pilotReports.length > 0 && pilotReports.every((r) => r.items.every((i) => i.source_guid === G1)), "التقرير لا يحمل غيرها");
  assert.ok(t.logs.some((l) => l.event === "pilot_active"));
  // دورة ثانية: لا رفع ولا إشعار مكرر.
  t.advance(60);
  await t.cycle();
  assert.equal(t.drive.pdfFiles().length, 1);
  assert.equal(t.edgeFake.state.sent.length, 1);
  // رفع الحصر بقرار المالك: الباقي يُؤرشف، وG1 لا يتكرر.
  Object.assign(t.cfg, { pilotInvoiceGuids: [], pilotExpiresAt: "" });
  t.restart();
  t.advance(t.cfg.reconcileMinutes * 60);
  await t.cycle();
  assert.equal(t.drive.pdfFiles().length, 3);
  assert.equal(t.edgeFake.state.sent.length, 3);
  assert.equal(t.store.versionsOf("wholesale_invoice", G1).length, 1);
});

// ─── التسمية ───
test("التسمية: مسار المجلدات بالنوع/السنة/الشهر/الزبون، واسمان متشابهان لا يختلطان", () => {
  const job = { docType: "wholesale_invoice", date: "2026-10-24", customerName: "أبو علي / المزة", customerGuid: "aaaaaaaa-0000-4000-8000-000000000001", number: 1234, sourceGuid: G1, version: 1 };
  const plan = naming.folderPlan(job);
  assert.deepEqual(plan.map((p) => p.name), ["OZK Tobacco Archive", "فواتير مبيعات الجملة", "2026", "10", "أبو علي المزة [aaaaaaaa]"]);
  const other = naming.folderPlan({ ...job, customerGuid: CUST_B });
  assert.notEqual(plan[4].key, other[4].key, "زبونان بالاسم نفسه ⇒ مجلدان");
  assert.equal(naming.fileName(job), "فاتورة جملة - رقم 1234 - 2026-10-24 - 11111111 - V1.pdf");
  assert.equal(naming.fileName({ ...job, version: 2 }), "فاتورة جملة - رقم 1234 - 2026-10-24 - 11111111 - V2.pdf");
  assert.equal(naming.safeSegment("a‮b\\c:d*e"), "a b c d e");
});

// ─── الدورة الكاملة ───
test("dry-run: فاتورة جملة مرحّلة ⇒ PDF محلي فقط، بلا Drive ولا تيليغرام", async () => {
  const t = await setup({ mode: "dry-run" });
  t.ameen.add({ guid: G1, number: 501 });
  t.advance(300);
  await t.cycle();
  const jobs = t.store.jobs();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "rendered");
  assert.ok(fs.readFileSync(t.store.pdfPath(jobs[0].jobId)).subarray(0, 5).equals(Buffer.from("%PDF-")));
  assert.equal(t.drive.calls.length, 0, "لا طلب إلى Google");
  assert.equal(t.edgeFake.state.sent.length, 0);
});

test("live: رفع خاص إلى المسار الصحيح ثم إشعار المالك بالملف والرابط", async () => {
  const t = await setup();
  t.ameen.add({ guid: G1, number: 501, customer: "محل الأمانة", total: 1350, discount: 50 });
  t.advance(300);
  const r = await t.cycle();
  assert.equal(r.driveState, "connected");
  const [job] = t.store.jobs();
  assert.equal(job.status, "notified");
  const pdfs = t.drive.pdfFiles();
  assert.equal(pdfs.length, 1);
  assert.equal(t.drive.pathOf(pdfs[0]), "OZK Tobacco Archive/فواتير مبيعات الجملة/2026/10/محل الأمانة [aaaaaaaa]/فاتورة جملة - رقم 501 - 2026-10-24 - 11111111 - V1.pdf");
  assert.equal(pdfs[0].shared, false);
  assert.equal(pdfs[0].appProperties.ozkJobId, job.jobId);
  assert.ok(!t.drive.calls.some((c) => /permissions/.test(c.url)), "لا مشاركة إطلاقاً");
  assert.equal(t.edgeFake.state.sent.length, 1);
  const msg = t.edgeFake.state.sent[0];
  assert.equal(msg.chat, "OWNER");
  const plain = t.edgeFake.shared && globalThis.ozkTelegramFormat.stripBidi(msg.caption);
  for (const part of ["فاتورة جملة", "محل الأمانة", "501", "2026-10-24", "1,300 $", "Google Drive", `https://drive.google.com/file/d/${job.drive.fileId}/view`]) {
    assert.ok(plain.includes(part), `الوصف يتضمن ${part}`);
  }
  assert.ok(msg.caption.length <= 1024);
  assert.equal(msg.fileName, "فاتورة جملة - رقم 501 - 2026-10-24 - 11111111 - V1.pdf");
});

test("فواتير غير مؤهلة لا تُؤرشف: غير مرحّلة، الكاشير، ولم تستقر بعد", async () => {
  const t = await setup();
  t.ameen.add({ guid: G1, number: 1, posted: 0 });
  t.ameen.add({ guid: G2, number: 2, typeGuid: fakes.CASHIER });
  t.advance(300);
  t.ameen.add({ guid: G3, number: 3 }); // أُنشئت الآن
  await t.cycle();
  assert.equal(t.store.jobs().length, 0);
  t.advance(200); // استقرت الثالثة
  await t.cycle();
  assert.deepEqual(t.store.jobs().map((j) => j.number), [3]);
});

test("501 فاتورة بوقت التغيير نفسه + فاتورة أحدث: كلها تُؤرشف مرة واحدة (مؤشر مركّب، Codex P1)", async () => {
  const t = await setup({ mode: "dry-run" });
  const guidOf = (i) => `${i.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
  for (let i = 1; i <= 501; i++) t.ameen.add({ guid: guidOf(i), number: 1000 + i }); // دفعة مستوردة: createdAt واحد
  t.advance(60);
  t.ameen.add({ guid: guidOf(9999), number: 999 });
  t.advance(300);
  await t.cycle();
  await t.cycle();
  t.advance(1800); // ومطابقة دورية بعدها لا تكرر شيئاً
  await t.cycle();
  const numbers = t.store.jobs().map((j) => j.number);
  assert.equal(numbers.length, 502, `أُرشف ${numbers.length} من 502`);
  assert.equal(new Set(numbers).size, 502, "لا تكرار");
  assert.ok(numbers.includes(1501) && numbers.includes(999), "الفاتورة 501 في الدفعة والأحدث 999 وصلتا");
});

test("المسح الأول بلا علامة يغطي archiveFrom كاملاً قبل lookback، وكذا التعافي بعد ضياع الحالة (Codex P1)", async () => {
  const t = await setup({ mode: "dry-run", overrides: { archiveFrom: "2026-01-01" } });
  t.ameen.add({ guid: G1, number: 11, date: "2026-01-05", createdAt: "2026-01-05T10:00:00" }); // أقدم من 60 يوماً
  t.ameen.add({ guid: G2, number: 12, date: "2025-12-20", createdAt: "2025-12-20T10:00:00" }); // قبل archiveFrom
  t.ameen.add({ guid: G3, number: 13 }); // حديثة
  t.advance(300);
  await t.cycle();
  await t.cycle();
  assert.deepEqual(t.store.jobs().map((j) => j.number).sort(), [11, 13]);
  assert.ok(t.store.state.watermark >= "2026-10-24", "العلامة تتقدّم بعد اكتمال المسح");

  // تعافٍ: ضاع ملف الحالة، وفاتورة قديمة لم يرها أي مسح سابق (استعادة نسخة مثلاً).
  t.ameen.add({ guid: G4, number: 14, date: "2026-02-01", createdAt: "2026-02-01T09:00:00" });
  fs.rmSync(path.join(t.cfg.dataDir, "state.json"));
  t.restart();
  t.advance(60);
  await t.cycle();
  await t.cycle();
  assert.deepEqual(t.store.jobs().map((j) => j.number).sort(), [11, 13, 14], "بلا تكرار، والقديمة وصلت");
});

test("فاتورة قديمة (خارج lookback) فشل توليدها في المسح الأول تُعاد من طابور الأخطاء الدائم (Codex P1)", async () => {
  const t = await setup({ mode: "dry-run", overrides: { archiveFrom: "2026-01-01" } });
  const realRender = t.renderer.render;
  t.renderer.render = async () => { throw Object.assign(new Error("عطل مؤقت في المحوّل"), { code: "RENDER" }); };
  t.ameen.add({ guid: G1, number: 21, date: "2026-01-05", createdAt: "2026-01-05T10:00:00" });
  t.advance(300);
  await t.cycle();
  assert.equal(t.store.jobs().length, 0);
  assert.equal(Object.keys(t.store.state.detectErrors).length, 1);
  assert.ok(t.store.state.watermark >= "2026-10-24", "العلامة تقدّمت فلن تراها القراءة التزايدية");
  t.renderer.render = realRender;
  t.advance(3700); // بعد التراجع، ومع مطابقة دورية لا تشمل تاريخها
  await t.cycle();
  assert.deepEqual(t.store.jobs().map((j) => j.number), [21]);
  assert.equal(Object.keys(t.store.state.detectErrors).length, 0);
  await t.cycle();
  assert.equal(t.store.jobs().length, 1, "بلا تكرار");
});

test("طابور الأخطاء: فاتورة حُذفت أو أُلغي ترحيلها تخرج منه ولا تُعاد بلا نهاية", async () => {
  const t = await setup({ mode: "dry-run", overrides: { archiveFrom: "2026-01-01" } });
  const realRender = t.renderer.render;
  t.renderer.render = async () => { throw Object.assign(new Error("عطل"), { code: "RENDER" }); };
  t.ameen.add({ guid: G1, number: 31, date: "2026-01-05", createdAt: "2026-01-05T10:00:00" });
  t.ameen.add({ guid: G2, number: 32, date: "2026-01-06", createdAt: "2026-01-06T10:00:00" });
  t.advance(300);
  await t.cycle();
  assert.equal(Object.keys(t.store.state.detectErrors).length, 2);
  t.renderer.render = realRender;
  t.ameen.db.invoices.delete(G1);
  t.ameen.db.invoices.get(G2).posted = 0;
  t.advance(3700);
  await t.cycle();
  assert.equal(t.store.jobs().length, 0);
  assert.equal(Object.keys(t.store.state.detectErrors).length, 0);
});

test("إعادة معالجة الحدث نفسه (فقدان state.json وإعادة التشغيل) لا تكرر ملفاً ولا إشعاراً", async () => {
  const t = await setup();
  t.ameen.add({ guid: G1, number: 501 });
  t.advance(300);
  await t.cycle();
  fs.rmSync(path.join(t.cfg.dataDir, "state.json"));
  t.restart();
  t.advance(60);
  await t.cycle();
  await t.cycle();
  assert.equal(t.store.jobs().length, 1);
  assert.equal(t.drive.pdfFiles().length, 1);
  assert.equal(t.edgeFake.state.sent.length, 1);
});

test("انقطاع بعد الرفع وقبل حفظ الحالة: الملف يُعثر عليه بمعرّف المهمة ولا يُرفع ثانية", async () => {
  const t = await setup({ mode: "drive" });
  t.ameen.add({ guid: G1, number: 501 });
  t.advance(300);
  await t.cycle();
  const [job] = t.store.jobs();
  // نُرجع المهمة لحالة «قبل الرفع» كما لو انهار العامل بعد ردّ Drive مباشرة.
  job.status = "rendered"; job.drive = null;
  t.store.saveJob(job);
  t.restart();
  await t.cycle();
  assert.equal(t.drive.state.uploads, 1, "رفع واحد فقط");
  assert.equal(t.store.get(job.jobId).status, "uploaded");
  assert.ok(t.logs.some((l) => l.event === "upload_found_existing"));
});

test("تعديل فاتورة مؤرشفة ⇒ نسخة 2 بجانب الأولى بلا استبدال، ورجوع المحتوى ⇒ نسخة 3", async () => {
  const t = await setup();
  t.ameen.add({ guid: G1, number: 501, total: 100 });
  t.advance(300);
  await t.cycle();
  const v1 = t.store.jobs()[0];
  const v1Bytes = Buffer.from(t.drive.files.get(v1.drive.fileId).content);
  t.ameen.edit(G1, { total: 120 });
  t.advance(300);
  await t.cycle();
  t.ameen.edit(G1, { total: 100 });
  t.advance(300);
  await t.cycle();
  const versions = t.store.versionsOf("wholesale_invoice", G1);
  assert.deepEqual(versions.map((j) => j.version), [1, 2, 3]);
  assert.equal(versions[1].previousJobId, v1.jobId);
  const names = t.drive.pdfFiles().map((f) => f.name).sort();
  assert.deepEqual(names, [
    "فاتورة جملة - رقم 501 - 2026-10-24 - 11111111 - V1.pdf",
    "فاتورة جملة - رقم 501 - 2026-10-24 - 11111111 - V2.pdf",
    "فاتورة جملة - رقم 501 - 2026-10-24 - 11111111 - V3.pdf",
  ]);
  assert.ok(Buffer.from(t.drive.files.get(v1.drive.fileId).content).equals(v1Bytes), "النسخة الأولى لم تُمسّ");
  assert.equal(t.edgeFake.state.sent.length, 3);
  const caption = (i) => globalThis.ozkTelegramFormat.stripBidi(t.edgeFake.state.sent[i].caption);
  assert.match(caption(0), /فاتورة جملة جديدة/);
  assert.match(caption(0), /الإصدار: V1 — فاتورة جديدة/);
  assert.match(caption(1), /فاتورة جملة معدّلة/);
  assert.match(caption(1), /الإصدار: V2 — تعديل؛ الإصدار V1 وما قبله محفوظ بلا تغيير/);
  assert.match(caption(2), /V3 — تعديل/);
});

test("تغيّر الرصيد وحده لا يولّد نسخة جديدة", async () => {
  const t = await setup({ mode: "dry-run" });
  t.ameen.add({ guid: G1, number: 501 });
  t.advance(300);
  await t.cycle();
  t.ameen.api.balance = async () => 999; // دفعة لاحقة غيّرت الرصيد
  t.ameen.edit(G1, {}); // لمسة بلا تغيير محتوى
  t.advance(300);
  await t.cycle();
  assert.equal(t.store.jobs().length, 1);
});

// ─── التعديل اللاحق: البصمة تغطي الرأس والأسطر كما خُزّنت في الأمين ───
const L1 = "eeeeeeee-0000-4000-8000-000000000001";
const L2 = "eeeeeeee-0000-4000-8000-000000000002";
const MAT2 = "cccccccc-0000-4000-8000-000000000002";

test("PDF الأرشيف: «تدوير» TotalExtra سطر مستقل يدخل الصافي والمتبقي، وإجمالي البضاعة كما هو", async () => {
  const t = await setup({ mode: "dry-run" });
  const htmls = [];
  const realRender = t.renderer.render;
  t.renderer.render = async (html, p, out) => { htmls.push(html); return realRender(html, p, out); };
  // التدوير بستّ خانات كما يقرؤه changed-invoices-query.sql ⇒ يُعرض بخانتين.
  t.ameen.add({ guid: G1, number: 601, total: 111.51, totalExtra: 20.4906, firstPay: 50 });
  t.ameen.add({ guid: G2, number: 602, total: 100, totalExtra: 0 });
  t.advance(300);
  await t.cycle();
  assert.equal(htmls.length, 2);
  const text = (n) => htmls.find((h) => h.includes(`رقم: ${n} `)).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  assert.match(text(601), /تدوير \$ 20\.49 الصافي \$ 132 المدفوع \$ 50 المتبقي من هذه الفاتورة \$ 82/);
  assert.match(text(601), /إجمالي الفاتورة \$ 111\.51/);
  assert.ok(!/تدوير|الصافي/.test(text(602)), "فاتورة بلا تدوير ولا حسم كما كانت");
});

async function archivedOnce(patch = {}) {
  const t = await setup({ mode: "dry-run" });
  t.ameen.add({ guid: G1, number: 501, ...patch });
  t.advance(300);
  await t.cycle();
  assert.equal(t.store.jobs().length, 1);
  return t;
}

async function editAndCycle(t, patch) {
  t.ameen.edit(G1, patch);
  t.advance(300);
  await t.cycle();
  return t.store.versionsOf("wholesale_invoice", G1);
}

test("كل تعديل مؤثر بالرأس أو الأسطر ⇒ إصدار جديد، حتى لو بقي الإجمالي والورقة كما هما", async () => {
  const two = [fakes.line({ line_guid: L1, line_number: 0, price: 10 }), fakes.line({ line_guid: L2, line_number: 1, mat_guid: MAT2, item_name: "صنف ثانٍ", price: 5 })];
  const cases = [
    ["سعر سطرين تبادلا والإجمالي ثابت", { lines: [{ ...two[0], price: 5 }, { ...two[1], price: 10 }] }],
    ["حسم سطر", { lines: [{ ...two[0], line_discount: 2 }, two[1]] }],
    ["إضافة سطر", { lines: [two[0], two[1], fakes.line({ line_guid: "eeeeeeee-0000-4000-8000-000000000003", line_number: 2 })] }],
    ["حذف سطر", { lines: [two[0]] }],
    ["مادة السطر تغيّرت بالاسم نفسه", { lines: [{ ...two[0], mat_guid: "cccccccc-0000-4000-8000-000000000009" }, two[1]] }],
    ["الكمية", { lines: [{ ...two[0], qty: 11 }, two[1]] }],
    ["كمية هدية", { lines: [{ ...two[0], bonus_qty: 1 }, two[1]] }],
    ["حسم الفاتورة", { discount: 3 }],
    ["إضافات الفاتورة", { totalExtra: 4 }],
    ["المبلغ", { total: 130 }],
    ["المدفوع", { firstPay: 50 }],
    ["الزبون", { customerGuid: CUST_B }],
    ["طريقة الدفع", { payType: 2 }],
    ["المستودع", { storeGuid: "dddddddd-0000-4000-8000-000000000002" }],
  ];
  for (const [label, patch] of cases) {
    const t = await archivedOnce({ lines: two });
    const versions = await editAndCycle(t, patch);
    assert.deepEqual(versions.map((j) => j.version), [1, 2], label);
    assert.equal(versions[1].changeKind, "edited", label);
    assert.equal(versions[0].changeKind, "new", label);
    assert.equal(versions[1].previousJobId, versions[0].jobId, label);
  }
});

test("لا إصدار بلا تغيير حقيقي: لمسة حفظ، أو إعادة تسمية بطاقة الزبون أو المادة", async () => {
  const t = await archivedOnce();
  let versions = await editAndCycle(t, {}); // حفظ بلا تغيير (LastUpdateDate وحده)
  assert.equal(versions.length, 1, "لمسة حفظ");
  versions = await editAndCycle(t, { customer: "اسم بطاقة جديد", billCustomerName: "زبون تجريبي" });
  assert.equal(versions.length, 1, "إعادة تسمية بطاقة الزبون ليست تعديلاً للفاتورة");
  versions = await editAndCycle(t, { lines: [fakes.line({ item_name: "اسم مادة جديد" })] });
  assert.equal(versions.length, 1, "إعادة تسمية بطاقة المادة ليست تعديلاً للفاتورة");
  assert.equal(t.renderer.calls(), 1, "لا PDF جديد");
});

test("تعديل لا يلمس LastUpdateDate تلتقطه المطابقة الدورية", async () => {
  const t = await archivedOnce();
  t.advance(t.cfg.overlapSeconds + 60);
  await t.cycle(); // أول مطابقة دورية (لا تقدّم العلامة)
  t.advance(60);
  await t.cycle(); // العلامة تتقدّم فتخرج الفاتورة من نافذة التداخل التزايدية
  const inv = t.ameen.db.invoices.get(G1);
  inv.lines = [fakes.line({ price: 12 })]; // بلا تحديث updatedAt
  t.advance(300);
  await t.cycle();
  assert.equal(t.store.jobs().length, 1, "الرصد التزايدي لا يراه");
  t.advance(t.cfg.reconcileMinutes * 60);
  await t.cycle();
  assert.deepEqual(t.store.versionsOf("wholesale_invoice", G1).map((j) => j.version), [1, 2]);
});

test("ترقية مخطط البصمة: مهمة قديمة بمحتوى لم يتغيّر لا تولّد إصداراً، وتعديل بعدها يولّد V2", async () => {
  const { legacyVersionHash } = require(path.join(dir, "lib", "fingerprint.js"));
  const model = require(path.join(dir, "..", "manual-a4-print", "lib", "invoice-model.js"));
  const t = await archivedOnce();
  // نحاكي مهمة حُسبت قبل الترقية: بصمة المخطط 1 وبلا hashSchema.
  const job = t.store.jobs()[0];
  const header = model.headerFromRow((await t.ameen.api.changedInvoices({ since: "1900-01-01T00:00:00", dateFrom: "2026-10-01" }))[0], t.cfg);
  header.customerGuid = job.customerGuid;
  const inv = model.buildInvoice(header, await t.ameen.api.lines(G1), null);
  inv.customerGuid = job.customerGuid;
  job.versionHash = legacyVersionHash(inv);
  delete job.hashSchema;
  t.store.saveJob(job);
  t.restart();
  t.store.state.hints = {};
  let versions = await editAndCycle(t, {});
  assert.equal(versions.length, 1, "المحتوى نفسه بالمخطط القديم ⇒ لا إصدار");
  assert.ok(versions[0].rebasedHash, "ثُبّتت عليها بصمة المخطط الحالي");
  assert.equal(versions[0].versionHash, job.versionHash, "هوية المهمة لم تتغيّر");
  versions = await editAndCycle(t, { lines: [fakes.line({ price: 11 })] });
  assert.deepEqual(versions.map((j) => j.version), [1, 2]);
});

test("سيناريو بشكل الفاتورة 1100 (11 سطراً، نصف كرتونة، نسخة V1 بالمخطط القديم): الترقية بلا إصدار، وتبادل سعرين مع ثبات الإجمالي ⇒ V2 واحد", async () => {
  const { legacyVersionHash } = require(path.join(dir, "lib", "fingerprint.js"));
  const model = require(path.join(dir, "..", "manual-a4-print", "lib", "invoice-model.js"));
  // بيانات اختبار معزولة بالشكل فقط (لا أسماء ولا أسعار حقيقية).
  const lines = Array.from({ length: 11 }, (_, i) => fakes.line({
    line_guid: `eeeeeeee-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    line_number: i,
    mat_guid: `cccccccc-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    item_name: `صنف ${i + 1}`,
    input_unit: 2,
    qty: i === 3 ? 25 : 50 * (i + 1), // السطر الرابع نصف كرتونة
    price: 10 + i,
  }));
  const total = lines.reduce((sum, l) => sum + l.price * (l.qty / 50), 0);
  const t = await archivedOnce({ lines, total });
  // V1 كما هي على OZK2026 اليوم: محسوبة بالكود الحالي (المخطط 1).
  const job = t.store.jobs()[0];
  const row = (await t.ameen.api.changedInvoices({ since: "1900-01-01T00:00:00", dateFrom: "2026-10-01" }))[0];
  const header = model.headerFromRow(row, t.cfg);
  header.customerGuid = job.customerGuid;
  const inv = model.buildInvoice(header, await t.ameen.api.lines(G1), null);
  inv.customerGuid = job.customerGuid;
  job.versionHash = legacyVersionHash(inv);
  delete job.hashSchema;
  t.store.saveJob(job);
  t.restart();
  // أول دورة بعد الترقية: كل التلميحات تتغيّر (أعمدة جديدة) لكن لا إصدار.
  t.advance(t.cfg.reconcileMinutes * 60);
  await t.cycle();
  t.advance(t.cfg.reconcileMinutes * 60);
  await t.cycle();
  assert.equal(t.store.versionsOf("wholesale_invoice", G1).length, 1, "لا إصدار زائف بعد الترقية");
  assert.equal(t.renderer.calls(), 1);
  // تبادل سعرَي سطرين لهما الكمية نفسها: الإجمالي والورقة كما هما.
  const swapped = lines.map((l) => ({ ...l }));
  [swapped[5].qty, swapped[6].qty] = [300, 300];
  const base = lines.map((l) => ({ ...l }));
  [base[5].qty, base[6].qty] = [300, 300];
  // نبدأ من حالة بالكميتين نفسيهما ثم نبادل السعرين وحدهما.
  let versions = await editAndCycle(t, { lines: base, total: base.reduce((s, l) => s + l.price * (l.qty / 50), 0) });
  assert.equal(versions.length, 2, "تغيير الكميات تعديل حقيقي");
  [swapped[5].price, swapped[6].price] = [base[6].price, base[5].price];
  const sameTotal = base.reduce((s, l) => s + l.price * (l.qty / 50), 0);
  assert.equal(swapped.reduce((s, l) => s + l.price * (l.qty / 50), 0), sameTotal, "الإجمالي ثابت");
  versions = await editAndCycle(t, { lines: swapped, total: sameTotal });
  assert.deepEqual(versions.map((j) => j.version), [1, 2, 3], "تبادل السعرين بإجمالي ثابت ⇒ إصدار جديد");
  // دورات إضافية بلا تغيير: لا إصدار.
  t.advance(t.cfg.reconcileMinutes * 60);
  await t.cycle();
  assert.equal(t.store.versionsOf("wholesale_invoice", G1).length, 3);
});

test("إعادة تشغيل بلا ملف الحالة بعد تعديل: إصدار واحد فقط مهما تكررت الدورات", async () => {
  const t = await archivedOnce();
  t.ameen.edit(G1, { total: 140 });
  t.advance(300);
  await t.cycle();
  fs.rmSync(path.join(t.cfg.dataDir, "state.json"), { force: true });
  t.restart();
  t.advance(300);
  await t.cycle();
  t.advance(t.cfg.reconcileMinutes * 60);
  await t.cycle();
  assert.deepEqual(t.store.versionsOf("wholesale_invoice", G1).map((j) => j.version), [1, 2]);
});

test("حذف فاتورة مؤرشفة أو إلغاء ترحيلها: توثيق محلي فقط، بلا حذف أي نسخة، والرجوع يمحو العلامة", async () => {
  const t = await setup();
  t.ameen.add({ guid: G1, number: 501 });
  t.ameen.add({ guid: G2, number: 502 });
  t.advance(300);
  await t.cycle();
  const filesBefore = t.drive.pdfFiles().length;
  assert.equal(filesBefore, 2);
  t.ameen.remove(G1);
  t.ameen.edit(G2, { posted: 0 });
  t.advance(t.cfg.reconcileMinutes * 60);
  await t.cycle();
  const issues = t.store.state.sourceIssues;
  assert.equal(issues[G1].status, "deleted");
  assert.equal(issues[G1].lastVersion, 1);
  assert.equal(issues[G2].status, "unposted");
  assert.equal(t.store.jobs().length, 2, "المهام باقية");
  assert.equal(t.drive.pdfFiles().length, filesBefore, "لا ملف حُذف ولا أُضيف على Drive");
  assert.ok(t.logs.some((l) => l.event === "source_deleted"));
  // إعادة الترحيل بالمحتوى نفسه: لا إصدار، والعلامة تُمحى.
  t.ameen.edit(G2, { posted: 1 });
  t.advance(300);
  await t.cycle();
  assert.equal(t.store.state.sourceIssues[G2], undefined);
  assert.equal(t.store.versionsOf("wholesale_invoice", G2).length, 1);
  assert.ok(t.logs.some((l) => l.event === "source_restored"));
  assert.equal(t.edgeFake.state.sent.length, 2, "لا إشعار للحذف أو إلغاء الترحيل");
});

test("انقطاع الإنترنت: المهمة تبقى معلّقة بلا عدّ محاولات وتُرفع عند العودة", async () => {
  const t = await setup();
  t.ameen.add({ guid: G1, number: 501 });
  t.advance(300);
  t.drive.state.offline = true;
  const r = await t.cycle();
  assert.equal(r.driveState, "disconnected");
  const [job] = t.store.jobs();
  assert.equal(job.status, "rendered");
  assert.equal(job.attempts, 0);
  assert.equal(t.edgeFake.state.sent.length, 0, "لا إشعار قبل نجاح الرفع");
  t.drive.state.offline = false;
  t.advance(60);
  await t.cycle();
  assert.equal(t.store.get(job.jobId).status, "notified");
});

test("فشل Drive المتكرر (503): تراجع ثم «فاشلة»، إحياء بعد التهدئة، وإعادة المالك تعمل", async () => {
  const t = await setup({ mode: "drive", overrides: { maxAttempts: 2 } });
  t.ameen.add({ guid: G1, number: 501 });
  t.ameen.add({ guid: G2, number: 502 });
  t.advance(300);
  t.drive.state.failUploads = true; // الهوية والمجلدات تنجح، والرفع نفسه 503
  const r = await t.cycle();
  assert.equal(r.driveState, "connected");
  const [a, b] = t.store.jobs().sort((x, y) => x.number - y.number).map((j) => j.jobId);
  assert.equal(t.store.get(a).attempts, 1);
  assert.equal(t.store.get(a).failed, false);
  t.advance(30); // قبل انتهاء التراجع: لا محاولة
  await t.cycle();
  assert.equal(t.store.get(a).attempts, 1);
  t.advance(3600);
  await t.cycle();
  assert.equal(t.store.get(a).failed, true, "بعد maxAttempts تصبح فاشلة");
  assert.match(t.store.get(a).lastError, /^upload:TRANSIENT/);
  t.drive.state.failUploads = false;
  t.advance(60);
  await t.cycle(); // ضمن التهدئة: الفاشلة لا تُعاد تلقائياً
  assert.equal(t.store.get(a).status, "rendered");
  assert.equal(t.archiver.applyRetry([a], "owner"), 1, "إعادة المالك");
  await t.cycle();
  assert.equal(t.store.get(a).status, "uploaded");
  assert.equal(t.store.get(b).status, "rendered", "الثانية ما زالت فاشلة ضمن التهدئة");
  t.advance(3700); // انتهت التهدئة ⇒ إحياء تلقائي
  await t.cycle();
  assert.equal(t.store.get(b).status, "uploaded");
  assert.equal(t.drive.pdfFiles().length, 2);
});

test("ملف وصل Drive تالفاً (md5/حجم لا يطابق) ⇒ فاشلة فوراً بلا إشعار", async () => {
  const t = await setup();
  t.ameen.add({ guid: G1, number: 501 });
  t.advance(300);
  t.drive.state.corruptUpload = true;
  await t.cycle();
  const [job] = t.store.jobs();
  assert.equal(job.status, "rendered");
  assert.equal(job.failed, true);
  assert.match(job.lastError, /INTEGRITY/);
  assert.equal(t.edgeFake.state.sent.length, 0);
  // بعد التهدئة: الملف التالف يبقى (لا حذف) ويُرفع بجانبه ملف سليم.
  t.drive.state.corruptUpload = false;
  t.advance(3700);
  await t.cycle();
  assert.equal(t.store.get(job.jobId).status, "notified");
  assert.equal(t.drive.pdfFiles().length, 2);
  assert.equal(t.edgeFake.state.sent.length, 1);
});

test("انتهاء المصادقة (invalid_grant) ⇒ يحتاج إعادة مصادقة، ولا رفع", async () => {
  const t = await setup();
  t.ameen.add({ guid: G1, number: 501 });
  t.advance(300);
  t.drive.state.invalidGrant = true;
  const r = await t.cycle();
  assert.equal(r.driveState, "needs_reauth");
  assert.equal(t.drive.pdfFiles().length, 0);
  assert.equal(t.store.jobs()[0].attempts, 0);
});

test("حساب Google غير المعتمد (ozkkh27) ⇒ إيقاف كامل بلا أي ملف", async () => {
  const t = await setup({ email: "ozkkh27@gmail.com" });
  t.ameen.add({ guid: G1, number: 501 });
  t.advance(300);
  const r = await t.cycle();
  assert.equal(r.driveState, "identity_mismatch");
  assert.equal(t.drive.files.size, 0, "لا مجلد ولا ملف");
  assert.equal(t.edgeFake.state.sent.length, 0);
});

test("مجلد الأرشيف الجذر صار مشتركاً ⇒ إيقاف الرفع (not_private)", async () => {
  const t = await setup();
  t.ameen.add({ guid: G1, number: 501 });
  t.advance(300);
  await t.cycle();
  const root = [...t.drive.files.values()].find((f) => f.name === "OZK Tobacco Archive");
  root.shared = true;
  t.ameen.add({ guid: G2, number: 502 });
  t.advance(300);
  const r = await t.cycle();
  assert.equal(r.driveState, "not_private");
  assert.equal(t.drive.pdfFiles().length, 1, "لا ملف جديد في أرشيف مشترك");
});

test("مجلد فرعي (زبون) صار مشتركاً والجذر خاص ⇒ لا رفع إليه ولو كان في المخبأ (Codex P1)", async () => {
  const t = await setup();
  t.ameen.add({ guid: G1, number: 501 });
  t.advance(300);
  await t.cycle();
  const [first] = t.drive.pdfFiles();
  const customerFolder = t.drive.files.get(first.parents[0]);
  customerFolder.shared = true; // الجذر يبقى خاصاً
  t.ameen.add({ guid: G2, number: 502 });
  t.advance(300);
  const uploadsBefore = t.drive.state.uploads;
  const r = await t.cycle();
  assert.equal(r.driveState, "not_private");
  assert.equal(t.drive.state.uploads, uploadsBefore, "لا محتوى يُرسل إلى مجلد مشترك");
  assert.equal(t.drive.pdfFiles().length, 1);
  const month = t.drive.files.get(customerFolder.parents[0]);
  customerFolder.shared = false;
  month.shared = true; // مستوى آخر في المسار
  t.advance(3600);
  assert.equal((await t.cycle()).driveState, "not_private");
  assert.equal(t.drive.pdfFiles().length, 1);
  month.shared = false;
  t.advance(3600);
  await t.cycle();
  assert.equal(t.drive.pdfFiles().length, 2, "بعد إلغاء المشاركة يُستأنف الرفع");
});

test("مجلد مخبّأ حُذف يدوياً ⇒ يُعاد إنشاؤه ويُرفع الملف بلا خطأ", async () => {
  const t = await setup();
  t.ameen.add({ guid: G1, number: 501 });
  t.advance(300);
  await t.cycle();
  const [first] = t.drive.pdfFiles();
  t.drive.files.delete(first.parents[0]); // مجلد الزبون لم يعد موجوداً (404)
  t.ameen.add({ guid: G2, number: 502 });
  t.advance(300);
  const r = await t.cycle();
  assert.equal(r.driveState, "connected");
  const second = t.drive.pdfFiles().find((f) => f.id !== first.id);
  assert.ok(second && t.drive.files.has(second.parents[0]), "رُفع إلى مجلد زبون جديد");
});

test("فشل تيليغرام: يُعاد الإشعار دون إعادة رفع الملف", async () => {
  const t = await setup();
  t.ameen.add({ guid: G1, number: 501 });
  t.advance(300);
  t.edgeFake.state.down = true;
  await t.cycle();
  const [job] = t.store.jobs();
  assert.equal(job.status, "uploaded");
  assert.equal(t.drive.state.uploads, 1);
  t.edgeFake.state.down = false;
  t.advance(120);
  await t.cycle();
  assert.equal(t.store.get(job.jobId).status, "notified");
  assert.equal(t.drive.state.uploads, 1, "لا رفع ثانٍ");
  assert.equal(t.edgeFake.state.sent.length, 1);
});

test("ضياع ردّ الإشعار بعد الإرسال: إعادة المحاولة تعيد message_id نفسه بلا رسالة ثانية", async () => {
  const t = await setup();
  t.ameen.add({ guid: G1, number: 501 });
  t.advance(300);
  t.edgeFake.state.loseResponse = 1;
  await t.cycle();
  t.advance(120);
  await t.cycle();
  const [job] = t.store.jobs();
  assert.equal(job.status, "notified");
  assert.equal(job.telegram.duplicate, true);
  assert.equal(t.edgeFake.state.sent.length, 1);
});

test("نتيجة إرسال مجهولة (409 delivery_unknown) ⇒ موقوفة بلا استهلاك محاولة ولا إعادة تلقائية، وإعادة المالك وحدها ترسل", async () => {
  const t = await setup();
  t.ameen.add({ guid: G1, number: 501 });
  t.advance(300);
  t.edgeFake.state.conflict = ["delivery_unknown"];
  await t.cycle();
  const [job] = t.store.jobs();
  const held = t.store.get(job.jobId);
  assert.equal(held.status, "uploaded");
  assert.equal(held.failed, true, "تظهر للمالك فاشلة");
  assert.equal(held.ownerRetryOnly, true);
  assert.equal(held.attempts, 0, "لا تُستهلك محاولة");
  assert.equal(held.lastError, "notify:DELIVERY_UNKNOWN");
  assert.ok(t.logs.some((e) => e.event === "delivery_unknown" && e.jobId === job.jobId), "حدث صريح في السجل");
  for (let i = 0; i < 3; i++) { t.advance(3600); await t.cycle(); }
  assert.equal(t.edgeFake.state.notifyCalls, 1, "لا إعادة تلقائية ولا إحياء بعد التهدئة");
  assert.equal(t.store.get(job.jobId).failed, true);
  assert.equal(t.archiver.applyRetry([job.jobId], "owner"), 1);
  assert.equal(t.store.get(job.jobId).ownerRetryOnly, false);
  await t.cycle();
  assert.equal(t.store.get(job.jobId).status, "notified");
  assert.equal(t.edgeFake.state.sent.length, 1);
  assert.equal(t.drive.state.uploads, 1, "لا رفع ثانٍ");
});

test("حجز قائم (409 in_progress) متكرراً أكثر من maxAttempts ⇒ انتظار بلا استهلاك محاولة ولا فشل، ثم إرسال واحد", async () => {
  const t = await setup();
  t.ameen.add({ guid: G1, number: 501 });
  t.advance(300);
  t.edgeFake.state.conflict = Array(12).fill("in_progress");
  await t.cycle();
  const [job] = t.store.jobs();
  assert.equal(t.store.get(job.jobId).lastError, "notify:IN_PROGRESS");
  for (let i = 0; i < 11; i++) {
    t.advance(30);
    await t.cycle();
    assert.equal(t.store.get(job.jobId).status, "uploaded", "لا إعادة قبل نهاية الانتظار");
    t.advance(31);
    await t.cycle();
  }
  const waited = t.store.get(job.jobId);
  assert.equal(waited.attempts, 0, "الانتظار لا يستهلك محاولات");
  assert.equal(waited.failed, false);
  assert.equal(t.edgeFake.state.notifyCalls, 12);
  t.advance(61);
  await t.cycle();
  assert.equal(t.store.get(job.jobId).status, "notified");
  assert.equal(t.edgeFake.state.sent.length, 1);
});

test("رفض صريح من الدالة (502 عابر) ما زال يستهلك محاولة مع تراجع", async () => {
  const t = await setup();
  t.ameen.add({ guid: G1, number: 501 });
  t.advance(300);
  t.edgeFake.state.reject = 1;
  await t.cycle();
  const [job] = t.store.jobs();
  assert.equal(t.store.get(job.jobId).attempts, 1);
  assert.equal(t.store.get(job.jobId).lastError, "notify:TRANSIENT");
});

test("PDF تغيّر محلياً بعد الرفع وقبل الإشعار ⇒ فاشلة فوراً بلا إرسال (بصمة الرفع نفسها)", async () => {
  const t = await setup();
  t.ameen.add({ guid: G1, number: 501 });
  t.advance(300);
  t.edgeFake.state.down = true;
  await t.cycle();
  const [job] = t.store.jobs();
  assert.equal(job.status, "uploaded");
  fs.appendFileSync(t.store.pdfPath(job.jobId), "tampered");
  t.edgeFake.state.down = false;
  t.advance(120);
  await t.cycle();
  const after = t.store.get(job.jobId);
  assert.equal(after.failed, true);
  assert.match(after.lastError, /notify:PDF_CHANGED/);
  assert.equal(t.edgeFake.state.sent.length, 0);
});

test("عميل Edge: طلب معلّق يُقطع بالمهلة ⇒ OFFLINE (لا يجمّد العامل)", async () => {
  // مؤقّت AbortSignal.timeout غير مُثبِّت للحلقة (في الإنتاج يثبّتها المقبس المفتوح)؛ هنا مؤقّت حارس.
  const keep = setTimeout(() => {}, 5000);
  const hang = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => { clearTimeout(keep); reject(init.signal.reason); });
  });
  const edge = createEdge({ url: "https://abc.supabase.co/functions/v1/document-archive-notify", secret: "x".repeat(40), fetchImpl: hang, timeoutMs: 30 });
  await assert.rejects(edge.report({ items: [] }), (err) => err.code === "OFFLINE" && /timeout/.test(err.message));
});

test("دالة الإشعار: لا مستلم من الطلب، ولا رابط عام، ولا ملف غير PDF", async () => {
  const { shared } = await fakes.createFakeEdge();
  const base = {
    job_id: "a".repeat(32), doc_type: "wholesale_invoice", source_guid: G1, doc_number: "501", doc_date: "2026-10-24",
    version: "1", version_hash: "b".repeat(64), amount: "10", currency: "USD", customer_name: "س",
    drive_file_id: "F000000000001xyz", drive_link: "https://drive.google.com/file/d/F000000000001xyz/view?usp=drivesdk",
  };
  assert.ok(shared.validateNotifyFields(base).value);
  assert.equal(shared.validateNotifyFields({ ...base, chat_id: "123" }).error, "recipient_not_allowed");
  assert.equal(shared.validateNotifyFields({ ...base, phone: "0999" }).error, "recipient_not_allowed");
  for (const link of [
    "https://drive.google.com/uc?export=download&id=F000000000001xyz",
    "https://drive.google.com/open?id=F000000000001xyz",
    "http://drive.google.com/file/d/F000000000001xyz/view",
    "https://evil.example/file/d/F000000000001xyz/view",
  ]) assert.equal(shared.validateNotifyFields({ ...base, drive_link: link }).error, "drive_link", link);
  assert.equal(shared.validateNotifyFields({ ...base, doc_type: "statement" }).error, "doc_type");
  assert.equal(shared.isPdfBytes(Buffer.from("<html>")), false);
  const long = shared.validateNotifyFields({ ...base, customer_name: "ب".repeat(5000) }).value;
  assert.ok(shared.buildNotifyCaption(long).caption.length <= 1024);
  assert.equal(shared.timingSafeEqualText("abc", "abd"), false);
  assert.equal(shared.timingSafeEqualText("", ""), false, "سرّ فارغ لا يطابق");
});

test("عميل Edge: عنوان غير معتمد مرفوض، وسرّ خاطئ ⇒ AUTH بلا عدّ محاولات على المهمة", async () => {
  assert.throws(() => createEdge({ url: "https://evil.example/document-archive-notify", secret: "x".repeat(40) }), /غير معتمد/);
  const t = await setup();
  t.edgeFake.state.secret = "y".repeat(40); // الدالة دُوّر سرّها
  t.ameen.add({ guid: G1, number: 501 });
  t.advance(300);
  await t.cycle();
  const [job] = t.store.jobs();
  assert.equal(job.status, "uploaded");
  assert.equal(job.attempts, 0);
});

test("التقرير: الحالة والأعداد تصل الموقع، وطلب إعادة المالك يُطبَّق على الفاشلة وحدها", async () => {
  const t = await setup({ mode: "drive", overrides: { maxAttempts: 1 } });
  t.ameen.add({ guid: G1, number: 501 });
  t.advance(300);
  t.drive.state.fail503 = 99; // كل شيء يفشل بعد الاتصال؟ التحقق نفسه يفشل ⇒ disconnected
  await t.cycle();
  const rep = t.edgeFake.state.reports.at(-1);
  assert.equal(rep.mode, "drive");
  assert.equal(rep.drive_state, "disconnected");
  assert.equal(rep.pending_count, 1);
  assert.equal(rep.items.length, 1);
  assert.equal(rep.items[0].status, "rendered");
  assert.ok(!JSON.stringify(rep).includes("1//refresh"), "لا رمز في التقرير");
  const id = rep.items[0].job_id;
  const job = t.store.get(id);
  job.failed = true; job.failedAt = new Date(Date.parse("2026-10-24T12:05:00Z")).toISOString();
  t.store.saveJob(job);
  t.edgeFake.state.retry.push(id, "f".repeat(32));
  t.drive.state.fail503 = 0;
  t.advance(400);
  await t.archiver.reportStage("TEST", "test", true);
  assert.equal(t.store.get(id).failed, false);
});

test("فشل توليد PDF (خط غير مضمَّن) لا ينشئ مهمة، ويُعاد لاحقاً، ويظهر في عدد الفاشلة", async () => {
  const t = await setup({ mode: "dry-run" });
  const realRender = t.renderer.render;
  t.renderer.render = async (html, p, out) => ({ ...(await realRender(html, p, out)), fontOk: false });
  t.ameen.add({ guid: G1, number: 501 });
  t.advance(300);
  await t.cycle();
  assert.equal(t.store.jobs().length, 0);
  assert.equal(Object.keys(t.store.state.detectErrors).length, 1);
  t.renderer.render = realRender;
  t.advance(3600);
  await t.cycle();
  assert.equal(t.store.jobs().length, 1);
  assert.equal(Object.keys(t.store.state.detectErrors).length, 0);
});

test("بيانات الأمين لا تتغيّر: العامل يقرأ فقط", async () => {
  const t = await setup();
  t.ameen.add({ guid: G1, number: 501 });
  t.ameen.add({ guid: G2, number: 502, customerGuid: CUST_B });
  const before = JSON.stringify([...t.ameen.db.invoices.entries()]);
  t.advance(300);
  await t.cycle();
  t.advance(1800);
  await t.cycle();
  assert.equal(JSON.stringify([...t.ameen.db.invoices.entries()]), before);
  assert.ok(t.ameen.reads() > 0);
});

test("الصندوق: ملف مهمة تالف يُعزل ولا يوقف العامل", () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, "jobs"), { recursive: true });
  fs.writeFileSync(path.join(d, "jobs", `${"c".repeat(32)}.json`), "{broken");
  const store = createStore(d);
  assert.equal(store.jobs().length, 0);
  assert.equal(fs.readdirSync(path.join(d, "quarantine")).length, 1);
});

test("Drive: نطاق أوسع من drive.file يُرفض، وعلامات الاقتباس في الاستعلام مُهرَّبة", async () => {
  const drive = fakes.createFakeDrive();
  drive.state.scope = "https://www.googleapis.com/auth/drive";
  const client = createDrive({ credentials: credentials(), expectedEmail: APPROVED_ACCOUNT, fetchImpl: drive.fetchImpl });
  await assert.rejects(client.verifyIdentity(true), (e) => e instanceof DriveError && e.code === "NEEDS_REAUTH");
  assert.equal(qValue("abu ali's \\ shop"), "abu ali\\'s \\\\ shop");
  assert.throws(() => createDrive({ credentials: {}, expectedEmail: APPROVED_ACCOUNT }), /NEEDS_REAUTH/);
});

test("السجل لا يحمل رموزاً ولا أسراراً", () => {
  registerSecret("super-secret-notify-value-123456");
  const msg = "fail Bearer ya29.abc-def token=1//0gAbCdEfGhIjKlMn bot123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA super-secret-notify-value-123456 client_secret=GOCSPX-zzz";
  const out = redact(msg, 1000);
  for (const bad of ["ya29.abc", "1//0gAb", "AAAAAAAAAAAAAAAAAAAA", "super-secret-notify", "GOCSPX-zzz"]) assert.ok(!out.includes(bad), bad);
});

test("سجلات دورة كاملة بأخطاء لا تحمل رمز التحديث ولا سرّ العميل", async () => {
  const t = await setup();
  t.ameen.add({ guid: G1, number: 501 });
  t.advance(300);
  t.drive.state.invalidGrant = true;
  await t.cycle();
  const text = JSON.stringify(t.logs);
  assert.ok(!text.includes("1//refresh-token") && !text.includes("GOCSPX-test"));
});

// ─── PDF حقيقي بالقالب الرسمي وخط Cairo (Chromium عبر Playwright إن وُجد) ───
function playwright() {
  try { return require("playwright"); } catch { return null; }
}

test("PDF حقيقي: القالب الرسمي A4 وخط Cairo مضمَّن", { skip: !playwright() && "Playwright غير متاح" }, async () => {
  const pw = playwright();
  const browser = await pw.chromium.launch();
  try {
    const renderer = {
      async render(html, _paper, outPath) {
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: "load" });
        await page.evaluate(() => document.fonts.ready);
        const fontOk = await page.evaluate(() => document.fonts.check("700 16px Cairo") && [...document.fonts].some((f) => f.family.replace(/"/g, "") === "Cairo" && f.status === "loaded"));
        const pdf = await page.pdf({ format: "A4", printBackground: true, margin: { top: "12mm", bottom: "12mm", left: "12mm", right: "12mm" }, path: outPath });
        await page.close();
        return { fontOk, pages: (pdf.toString("latin1").match(/\/Type\s*\/Page(?![s\w])/g) || []).length, bytes: pdf.length };
      },
    };
    const dataDir = tmp();
    const ameen = fakes.createFakeAmeen();
    ameen.add({ guid: G1, number: 777, customer: "زبون اختبار", total: 286, lines: [{ item_name: "صنف اختبار", input_unit: 2, unit1_name: "علبة", unit2_name: "كرتونة", unit3_name: "", unit2_fact: 50, unit3_fact: 0, qty: 50 }] });
    ameen.setNow("2026-10-24T12:10:00");
    const store = createStore(dataDir);
    const cfg = validate({ ...DEFAULTS, archiveFrom: "2026-10-01", dataDir });
    const archiver = createArchiver({ cfg, store, ameen: ameen.api, renderer, template, paper: paperFor("A4", { papers: ["A4"] }), getDrive: () => null, edge: null, log: () => {} });
    await archiver.cycle();
    const [job] = store.jobs();
    assert.ok(job, "مهمة واحدة");
    const pdf = fs.readFileSync(store.pdfPath(job.jobId));
    assert.ok(pdf.subarray(0, 5).equals(Buffer.from("%PDF-")));
    assert.match(pdf.toString("latin1"), /Cairo/, "الخط مضمَّن في الملف");
    assert.ok(pdf.length > 8 * 1024);
  } finally {
    await browser.close();
  }
});
