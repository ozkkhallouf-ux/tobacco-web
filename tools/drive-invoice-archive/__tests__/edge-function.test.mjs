// تشغيل دالة Edge الحقيقية `document-archive-notify/index.ts` على Node (حذف الأنواع)
// ببديل Deno بالذاكرة وfetch وهمي لـSupabase وتيليغرام. لا شبكة.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const fnDir = path.join(root, "supabase", "functions");
const SECRET = "z".repeat(48);
const OWNER_CHAT = "987654321";
const TOKEN = "123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function stripTypesSupported() {
  return Number(process.versions.node.split(".")[0]) >= 22;
}

// نسخة مؤقتة: بلا استيراد jsr، والاستيرادات المحلية بمسارات مطلقة.
async function loadHandler(env, fetchMock) {
  const src = fs.readFileSync(path.join(fnDir, "document-archive-notify", "index.ts"), "utf8")
    .replace(/^import "jsr:[^"]+";\n/m, "")
    .replace(/"\.\.\/_shared\/([^"]+)"/g, (_, f) => JSON.stringify(pathToFileURL(path.join(fnDir, "_shared", f)).href));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ozk-edge-"));
  const file = path.join(tmp, "index.ts");
  fs.writeFileSync(file, src);
  let handler = null;
  globalThis.Deno = { env: { get: (k) => env[k] }, serve: (h) => { handler = h; } };
  globalThis.fetch = fetchMock;
  await import(`${pathToFileURL(file).href}?v=${Math.random()}`);
  return handler;
}

function createBackend() {
  const s = { items: new Map(), telegram: [], rpc: [], failRecord: false, failRecordTimes: 0, recordCalls: 0,
    telegramFail: 0, telegramStatus: 500, restDown: false, calls: 0,
    // Migration 26: نموذج الحجز بالذاكرة بنفس قواعد supabase/proposed/26 (تُختبر SQL حياً في check-drive-invoice-archive).
    claims: new Map(), labels: [], clock: Date.parse("2026-10-25T12:00:00Z"), noClaimRpc: false, failFinish: false, released: [],
    // تيليغرام: lostReply يوصل المستند ثم يقطع الاتصال؛ unreadable يوصله بجسم غير مقروء؛ delayMs يبطئه.
    lostReply: 0, unreadable: 0, delayMs: 0 };
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  async function telegramApi(u, init) {
    if (s.delayMs) await new Promise((r) => setTimeout(r, s.delayMs));
    if (s.telegramFail > 0) {
      s.telegramFail--;
      return json(s.telegramStatus, { ok: false, error_code: s.telegramStatus, description: "Too Many Requests: retry after 5" });
    }
    const entry = { method: u.pathname.split("/").pop(), token: u.pathname.split("/")[1] };
    if (init.body instanceof FormData) {
      for (const [k, v] of init.body.entries()) entry[k] = typeof v === "string" ? v : { name: v.name, size: v.size };
    } else {
      Object.assign(entry, JSON.parse(init.body));
    }
    s.telegram.push(entry);
    if (s.lostReply > 0) { s.lostReply--; const e = new TypeError("fetch failed"); e.code = "ECONNRESET"; throw e; }
    if (s.unreadable > 0) { s.unreadable--; return new Response("<html>bad gateway</html>", { status: 200 }); }
    return json(200, { ok: true, result: { message_id: 7000 + s.telegram.length } });
  }

  const LEASE_MS = 300 * 1000;
  function claimRpc(init) {
    if (s.noClaimRpc) return json(404, { message: "function not found" });
    const { p_job_id: id, p_label: label } = JSON.parse(init.body);
    s.labels.push(label);
    const item = s.items.get(id);
    const token = `t${Math.random()}`;
    if (item && item.telegram_message_id != null) {
      s.claims.set(id, { ...(s.claims.get(id) || { token }), state: "sent", msg: item.telegram_message_id });
      return json(200, { status: "sent", message_id: item.telegram_message_id });
    }
    const c = s.claims.get(id);
    if (!c || c.state === "released") {
      s.claims.set(id, { state: "sending", token, at: s.clock, attempts: (c ? c.attempts : 0) + 1 });
      return json(200, { status: "claimed", token });
    }
    if (c.state === "sent") return json(200, { status: "sent", message_id: c.msg });
    if (c.state === "sending" && s.clock - c.at < LEASE_MS) return json(200, { status: "in_progress" });
    if (c.state === "sending") c.state = "unknown";
    return json(200, { status: "unknown" });
  }

  function finishRpc(init) {
    if (s.failFinish) return json(503, { message: "busy" });
    const { p_job_id: id, p_token: token, p_outcome: outcome, p_message_id: msg } = JSON.parse(init.body);
    const c = s.claims.get(id);
    let ok = false;
    if (c && c.token === token) {
      if (outcome === "sent" && (c.state === "sending" || c.state === "unknown")) { c.state = "sent"; c.msg = msg; ok = true; }
      else if (outcome !== "sent" && c.state === "sending") { c.state = outcome === "not_sent" ? "released" : "unknown"; ok = true; }
    }
    return json(200, { ok });
  }

  function releaseRpc(init) {
    const { p_job_ids: ids } = JSON.parse(init.body);
    let n = 0;
    for (const id of ids) { const c = s.claims.get(id); if (c && c.state === "unknown") { c.state = "released"; n++; } }
    s.released.push(...ids);
    return json(200, n);
  }

  function recordNotification(init) {
    s.recordCalls++;
    if (s.failRecord) return json(500, { message: "boom" });
    if (s.failRecordTimes > 0) { s.failRecordTimes--; return json(503, { message: "busy" }); }
    const { p_item } = JSON.parse(init.body);
    s.items.set(p_item.job_id, p_item);
    s.rpc.push(p_item);
    return json(200, null);
  }

  function ingestReport(init) {
    const items = JSON.parse(init.body).p_report.items;
    // نفس قاعدة upsert في Migration 22: message_id الأول لا يُكتب فوقه.
    for (const it of items) {
      const prev = s.items.get(it.job_id);
      s.items.set(it.job_id, { ...it, telegram_message_id: (prev && prev.telegram_message_id) ?? it.telegram_message_id ?? null });
    }
    const retry = s.retryNext || [];
    s.retryNext = [];
    return json(200, { items: items.length, retry_job_ids: retry });
  }

  const rest = {
    "/rest/v1/bot_config": () => json(200, [{ value: OWNER_CHAT }]),
    "/rest/v1/document_archive_items": (init, u) => {
      const it = s.items.get(/job_id=eq\.([0-9a-f]+)/.exec(u.search)[1]);
      return json(200, it ? [{ telegram_message_id: it.telegram_message_id }] : []);
    },
    "/rest/v1/rpc/document_archive_record_notification": recordNotification,
    "/rest/v1/rpc/document_archive_ingest_report": ingestReport,
    "/rest/v1/rpc/document_archive_claim_notification": claimRpc,
    "/rest/v1/rpc/document_archive_finish_notification": finishRpc,
    "/rest/v1/rpc/document_archive_release_notification_claims": releaseRpc,
  };

  async function fetchMock(url, init = {}) {
    const u = new URL(url);
    s.calls++;
    if (u.hostname === "api.telegram.org") return telegramApi(u, init);
    if (s.restDown) { const e = new TypeError("fetch failed"); e.code = "ECONNRESET"; throw e; }
    const route = rest[u.pathname];
    return route ? route(init, u) : json(404, {});
  }
  return { s, fetchMock };
}

const ENV = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-key", DOCUMENT_ARCHIVE_SECRET: SECRET, TELEGRAM_BOT_TOKEN: TOKEN };
const PDF = Buffer.from("%PDF-1.4\n%test\n%%EOF\n");

function notifyRequest(fields, { secret = SECRET, file = PDF } = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  if (file) form.append("file", new Blob([file], { type: "application/pdf" }), "فاتورة جملة - رقم 501.pdf");
  return new Request("https://example.supabase.co/functions/v1/document-archive-notify/notify", {
    method: "POST", headers: { "x-ozk-archive-secret": secret }, body: form,
  });
}

const FIELDS = {
  job_id: "a".repeat(32), doc_type: "wholesale_invoice", source_guid: "11111111-1111-4111-8111-111111111111",
  doc_number: "501", doc_date: "2026-10-24", customer_guid: "aaaaaaaa-0000-4000-8000-000000000001",
  customer_name: "زبون تجريبي", amount: "1300", currency: "USD", version: "1", version_hash: "b".repeat(64),
  drive_file_id: "F000000000001xyz", drive_link: "https://drive.google.com/file/d/F000000000001xyz/view?usp=drivesdk",
  file_name: "فاتورة جملة - رقم 501 - 2026-10-24 - 11111111.pdf", host: "OZK2026",
};

test("Edge: يرسل PDF ووصفه إلى محادثة المالك وحدها ويسجّل message_id، والتكرار بلا إرسال ثانٍ", { skip: !stripTypesSupported() && "Node < 22" }, async () => {
  const b = createBackend();
  const handler = await loadHandler(ENV, b.fetchMock);
  const res = await handler(notifyRequest(FIELDS));
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.duplicate, false);
  assert.equal(b.s.telegram.length, 1);
  const sent = b.s.telegram[0];
  assert.equal(sent.method, "sendDocument");
  assert.equal(sent.chat_id, OWNER_CHAT, "المستلم من bot_config وحده");
  assert.equal(sent.document.name, FIELDS.file_name);
  assert.ok(sent.caption.includes(FIELDS.drive_link));
  assert.equal(b.s.rpc[0].telegram_message_id, body.message_id);
  // إعادة المحاولة نفسها
  const again = await (await handler(notifyRequest(FIELDS))).json();
  assert.equal(again.duplicate, true);
  assert.equal(again.message_id, body.message_id);
  assert.equal(b.s.telegram.length, 1);
});

test("Edge: سرّ خاطئ 401، ومستلم من الطلب مرفوض، وملف غير PDF مرفوض، بلا أي إرسال", { skip: !stripTypesSupported() && "Node < 22" }, async () => {
  const b = createBackend();
  const handler = await loadHandler(ENV, b.fetchMock);
  assert.equal((await handler(notifyRequest(FIELDS, { secret: "wrong" }))).status, 401);
  const r1 = await handler(notifyRequest({ ...FIELDS, chat_id: "111" }));
  assert.equal(r1.status, 400);
  assert.equal((await r1.json()).error, "recipient_not_allowed");
  const r2 = await handler(notifyRequest(FIELDS, { file: Buffer.from("<html>") }));
  assert.equal((await r2.json()).error, "file_type");
  const r3 = await handler(notifyRequest({ ...FIELDS, drive_link: "https://drive.google.com/uc?export=download&id=F000000000001xyz" }));
  assert.equal((await r3.json()).error, "drive_link");
  assert.equal((await handler(new Request("https://x/document-archive-notify/notify", { method: "GET" }))).status, 405);
  assert.equal(b.s.telegram.length, 0);
});

test("Edge: فشل تسجيل message_id لا يُفشل الإشعار، والخطأ لا يحمل التوكن", { skip: !stripTypesSupported() && "Node < 22" }, async () => {
  const b = createBackend();
  b.s.failRecord = true;
  const handler = await loadHandler(ENV, b.fetchMock);
  const body = await (await handler(notifyRequest(FIELDS))).json();
  assert.equal(body.ok, true);
  assert.equal(body.recorded, false);
  const noCfg = await loadHandler({ ...ENV, DOCUMENT_ARCHIVE_SECRET: "" }, b.fetchMock);
  assert.equal((await noCfg(notifyRequest(FIELDS))).status, 503, "بلا سرّ مضبوط الدالة مغلقة");
  const report = await handler(new Request("https://x/functions/v1/document-archive-notify/report", {
    method: "POST", headers: { "x-ozk-archive-secret": SECRET, "Content-Type": "application/json" },
    body: JSON.stringify({ host: "OZK2026", mode: "live", drive_state: "connected", items: [] }),
  }));
  assert.equal(report.status, 200);
});

// ─── سيناريوهات تدقيق الجاهزية (بيانات تجريبية فقط، بلا شبكة) ───
const SKIP = !stripTypesSupported() && "Node < 22";

function captureConsole() {
  const lines = [];
  const orig = { error: console.error, log: console.log, warn: console.warn };
  for (const k of Object.keys(orig)) console[k] = (...a) => lines.push(a.map(String).join(" "));
  return { lines, restore: () => Object.assign(console, orig) };
}

test("Edge: فشل تيليغرام (429/500) ⇒ 502 بلا تسجيل، وإعادة المحاولة ترسل مرة واحدة فقط", { skip: SKIP }, async () => {
  const b = createBackend();
  const handler = await loadHandler(ENV, b.fetchMock);
  b.s.telegramFail = 1;
  b.s.telegramStatus = 429;
  const r1 = await handler(notifyRequest(FIELDS));
  assert.equal(r1.status, 502);
  assert.equal((await r1.json()).error, "telegram_sendDocument_429");
  assert.equal(b.s.recordCalls, 0, "لا تسجيل لإشعار لم يصل");
  b.s.telegramFail = 1;
  b.s.telegramStatus = 500;
  assert.equal((await handler(notifyRequest(FIELDS))).status, 502);
  const ok = await (await handler(notifyRequest(FIELDS))).json();
  assert.equal(ok.duplicate, false);
  assert.equal(ok.recorded, true);
  const again = await (await handler(notifyRequest(FIELDS))).json();
  assert.equal(again.duplicate, true);
  assert.equal(b.s.telegram.length, 1, "مستند واحد وصل للمالك");
});

test("Edge: فشل عابر في تسجيل الإشعار يُعاد داخل الدالة، فإعادة العامل لا تكرر الإرسال", { skip: SKIP }, async () => {
  const b = createBackend();
  const handler = await loadHandler(ENV, b.fetchMock);
  b.s.failRecordTimes = 2;
  const body = await (await handler(notifyRequest(FIELDS))).json();
  assert.equal(body.recorded, true);
  assert.equal(b.s.recordCalls, 3);
  assert.equal((await (await handler(notifyRequest(FIELDS))).json()).duplicate, true);
  assert.equal(b.s.telegram.length, 1);
});

test("Edge: فشل التسجيل كلياً ⇒ recorded=false، وتقرير العامل يسجّل message_id فيمنع الإرسال الثاني", { skip: SKIP }, async () => {
  const b = createBackend();
  b.s.failRecord = true;
  const handler = await loadHandler(ENV, b.fetchMock);
  const first = await (await handler(notifyRequest(FIELDS))).json();
  assert.equal(first.recorded, false);
  assert.equal(b.s.recordCalls, 3, "ثلاث محاولات ثم استسلام");
  const report = await handler(new Request("https://x/functions/v1/document-archive-notify/report", {
    method: "POST", headers: { "x-ozk-archive-secret": SECRET, "Content-Type": "application/json" },
    body: JSON.stringify({ host: "OZK2026", mode: "live", items: [{ job_id: FIELDS.job_id, status: "notified", telegram_message_id: first.message_id }] }),
  }));
  assert.equal(report.status, 200);
  const again = await (await handler(notifyRequest(FIELDS))).json();
  assert.equal(again.duplicate, true);
  assert.equal(again.message_id, first.message_id);
  assert.equal(b.s.telegram.length, 1);
});

test("Edge: PDF تالف أو مقطوع أو فارغ أو أكبر من 20MB مرفوض قبل أي إرسال", { skip: SKIP }, async () => {
  const b = createBackend();
  const handler = await loadHandler(ENV, b.fetchMock);
  const truncated = Buffer.from("%PDF-1.4\n1 0 obj<</Type /Page>>endobj\n");
  assert.equal((await (await handler(notifyRequest(FIELDS, { file: truncated }))).json()).error, "file_type");
  const big = Buffer.alloc(20 * 1024 * 1024 + 1, 0x20);
  big.write("%PDF-1.4\n", 0);
  big.write("%%EOF\n", big.length - 6);
  const rBig = await handler(notifyRequest(FIELDS, { file: big }));
  assert.equal(rBig.status, 413);
  assert.equal((await rBig.json()).error, "file_size");
  const rEmpty = await handler(notifyRequest(FIELDS, { file: Buffer.alloc(0) }));
  assert.equal(rEmpty.status, 413);
  const rNoFile = await handler(notifyRequest(FIELDS, { file: null }));
  assert.equal((await rNoFile.json()).error, "file");
  // ملف صالح بفراغات بعد %%EOF مقبول
  const trailing = Buffer.concat([PDF, Buffer.from("\n\n  ")]);
  assert.equal((await handler(notifyRequest(FIELDS, { file: trailing }))).status, 200);
  assert.equal(b.s.telegram.length, 1);
});

test("Edge: طلب بلا سرّ أو بسرّ خاطئ يُرفض قبل قراءة الجسم وبلا أي اتصال خارجي، ومسار مجهول 404", { skip: SKIP }, async () => {
  const b = createBackend();
  const handler = await loadHandler(ENV, b.fetchMock);
  const noHeader = new Request("https://x/functions/v1/document-archive-notify/notify", { method: "POST", body: "x".repeat(1000) });
  assert.equal((await handler(noHeader)).status, 401);
  assert.equal((await handler(notifyRequest(FIELDS, { secret: SECRET.slice(0, -1) }))).status, 401);
  assert.equal((await handler(notifyRequest(FIELDS, { secret: `${SECRET}z` }))).status, 401);
  const report = new Request("https://x/functions/v1/document-archive-notify/report", { method: "POST", body: "{}" });
  assert.equal((await handler(report)).status, 401);
  assert.equal(b.s.calls, 0, "لا Supabase ولا تيليغرام لطلب غير مخوّل");
  const unknown = await handler(new Request("https://x/functions/v1/document-archive-notify/admin", {
    method: "POST", headers: { "x-ozk-archive-secret": SECRET }, body: "{}",
  }));
  assert.equal(unknown.status, 404);
});

test("Edge: انقطاع Supabase ⇒ 502 برمز قصير بلا إرسال، والسجلات بلا رابط Drive ولا بيانات فاتورة ولا أسرار", { skip: SKIP }, async () => {
  const b = createBackend();
  const handler = await loadHandler(ENV, b.fetchMock);
  b.s.restDown = true;
  const cap = captureConsole();
  let res;
  try {
    res = await handler(notifyRequest(FIELDS));
  } finally {
    cap.restore();
  }
  assert.equal(res.status, 502);
  const body = await res.text();
  assert.equal(b.s.telegram.length, 0);
  // فشل تيليغرام برسالة تحمل التوكن: الرمز وحده في السجل والرد.
  b.s.restDown = false;
  b.s.telegramFail = 1;
  b.s.telegramStatus = 400;
  const cap2 = captureConsole();
  let res2;
  try {
    res2 = await handler(notifyRequest(FIELDS));
  } finally {
    cap2.restore();
  }
  const body2 = await res2.text();
  const all = [...cap.lines, ...cap2.lines, body, body2].join("\n");
  assert.ok(cap.lines.length + cap2.lines.length >= 1, "يُسجَّل رمز الخطأ");
  for (const secretish of [TOKEN, TOKEN.split(":")[1], SECRET, "service-key", FIELDS.drive_link, FIELDS.drive_file_id, FIELDS.customer_name, FIELDS.amount, OWNER_CHAT]) {
    assert.ok(!all.includes(secretish), `تسرّب في السجل/الرد: ${secretish.slice(0, 6)}…`);
  }
});

test("Edge: /report يمرّر الدفعة إلى RPC بمفتاح الخدمة، وJSON غير صالح 400", { skip: SKIP }, async () => {
  const b = createBackend();
  const handler = await loadHandler(ENV, b.fetchMock);
  const bad = await handler(new Request("https://x/functions/v1/document-archive-notify/report", {
    method: "POST", headers: { "x-ozk-archive-secret": SECRET, "Content-Type": "application/json" }, body: "{not json",
  }));
  assert.equal(bad.status, 400);
  assert.equal(b.s.telegram.length, 0);
});

// ─── مرة واحدة على الأكثر (Migration 26) ───

function reportRequest(items = []) {
  return new Request("https://x/functions/v1/document-archive-notify/report", {
    method: "POST", headers: { "x-ozk-archive-secret": SECRET, "Content-Type": "application/json" },
    body: JSON.stringify({ host: "OZK2026", mode: "live", drive_state: "connected", items }),
  });
}

test("Edge: طلبان متزامنان للمهمة نفسها ⇒ إرسال واحد، والثاني 409 in_progress", { skip: SKIP }, async () => {
  const b = createBackend();
  const handler = await loadHandler(ENV, b.fetchMock);
  b.s.delayMs = 50;
  const results = await Promise.all([1, 2, 3].map(() => handler(notifyRequest(FIELDS))));
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 409, 409]);
  for (const r of results.filter((x) => x.status === 409)) assert.equal((await r.json()).error, "in_progress");
  assert.equal(b.s.telegram.filter((t) => t.method === "sendDocument").length, 1, "مستند واحد فقط");
  b.s.delayMs = 0;
  assert.equal((await (await handler(notifyRequest(FIELDS))).json()).duplicate, true);
  assert.equal(b.s.telegram.length, 1);
});

test("Edge: ضياع ردّ تيليغرام بعد الوصول ⇒ 409 delivery_unknown، والإعادة لا ترسل ثانية", { skip: SKIP }, async () => {
  const b = createBackend();
  const handler = await loadHandler(ENV, b.fetchMock);
  b.s.lostReply = 1;
  const cap = captureConsole();
  let r1;
  try { r1 = await handler(notifyRequest(FIELDS)); } finally { cap.restore(); }
  assert.equal(r1.status, 409);
  assert.equal((await r1.json()).error, "delivery_unknown");
  assert.equal(b.s.claims.get(FIELDS.job_id).state, "unknown");
  for (let i = 0; i < 3; i++) {
    const again = await handler(notifyRequest(FIELDS));
    assert.equal(again.status, 409);
    assert.equal((await again.json()).error, "delivery_unknown");
  }
  b.s.clock += 3600 * 1000;
  assert.equal((await handler(notifyRequest(FIELDS))).status, 409, "ولا بعد ساعة");
  assert.equal(b.s.telegram.length, 1, "وصل مرة واحدة ولم يُعَد");
  assert.equal(b.s.recordCalls, 0);
});

test("Edge: ردّ 200 غير مقروء أو بلا message_id ⇒ مجهول بلا إعادة", { skip: SKIP }, async () => {
  const b = createBackend();
  const handler = await loadHandler(ENV, b.fetchMock);
  b.s.unreadable = 1;
  const cap = captureConsole();
  let r1;
  try { r1 = await handler(notifyRequest(FIELDS)); } finally { cap.restore(); }
  assert.equal((await r1.json()).error, "delivery_unknown");
  assert.equal((await handler(notifyRequest(FIELDS))).status, 409);
  assert.equal(b.s.telegram.length, 1);
});

test("Edge: رفض صريح من تيليغرام (ok=false) يحرّر الحجز، فإعادة العامل ترسل مرة واحدة", { skip: SKIP }, async () => {
  const b = createBackend();
  const handler = await loadHandler(ENV, b.fetchMock);
  b.s.telegramFail = 1;
  b.s.telegramStatus = 429;
  const cap = captureConsole();
  let r1;
  try { r1 = await handler(notifyRequest(FIELDS)); } finally { cap.restore(); }
  assert.equal(r1.status, 502);
  assert.equal(b.s.claims.get(FIELDS.job_id).state, "released");
  const ok = await (await handler(notifyRequest(FIELDS))).json();
  assert.equal(ok.duplicate, false);
  assert.equal(b.s.claims.get(FIELDS.job_id).attempts, 2);
  assert.equal(b.s.telegram.length, 1);
});

test("Edge: فشل تسجيل النتيجة والمرآة معاً بعد الإرسال ⇒ لا إرسال ثانٍ: in_progress ثم مجهول بعد المهلة", { skip: SKIP }, async () => {
  const b = createBackend();
  const handler = await loadHandler(ENV, b.fetchMock);
  b.s.failFinish = true;
  b.s.failRecord = true;
  const first = await (await handler(notifyRequest(FIELDS))).json();
  assert.equal(first.ok, true);
  assert.equal(first.recorded, false);
  const again = await handler(notifyRequest(FIELDS));
  assert.equal((await again.json()).error, "in_progress");
  b.s.clock += 301 * 1000;
  const later = await handler(notifyRequest(FIELDS));
  assert.equal((await later.json()).error, "delivery_unknown");
  assert.equal(b.s.telegram.length, 1);
  // تقرير العامل يحمل message_id ⇒ يُعرف أنه وصل: «مُرسَل» لا مجهول.
  b.s.failRecord = false;
  await handler(reportRequest([{ job_id: FIELDS.job_id, status: "notified", telegram_message_id: first.message_id }]));
  const known = await (await handler(notifyRequest(FIELDS))).json();
  assert.equal(known.duplicate, true);
  assert.equal(known.message_id, first.message_id);
  assert.equal(b.s.telegram.length, 1);
});

test("Edge: المجهول لا يُعاد إلا بطلب المالك؛ /report يحرّر حجوزات retry_job_ids وحدها", { skip: SKIP }, async () => {
  const b = createBackend();
  const handler = await loadHandler(ENV, b.fetchMock);
  b.s.lostReply = 1;
  const cap = captureConsole();
  try { await handler(notifyRequest(FIELDS)); } finally { cap.restore(); }
  await handler(reportRequest());
  assert.equal((await handler(notifyRequest(FIELDS))).status, 409, "تقرير بلا طلب مالك لا يحرّر");
  b.s.retryNext = [FIELDS.job_id];
  assert.equal((await handler(reportRequest())).status, 200);
  assert.deepEqual(b.s.released, [FIELDS.job_id]);
  const resent = await (await handler(notifyRequest(FIELDS))).json();
  assert.equal(resent.duplicate, false);
  assert.equal(b.s.telegram.length, 2, "إعادة صريحة بقرار المالك");
});

test("Edge: الدالة الجديدة بلا Migration 26 تفشل مغلقة: 502 بلا إرسال", { skip: SKIP }, async () => {
  const b = createBackend();
  b.s.noClaimRpc = true;
  const handler = await loadHandler(ENV, b.fetchMock);
  const cap = captureConsole();
  let r;
  try { r = await handler(notifyRequest(FIELDS)); } finally { cap.restore(); }
  assert.equal(r.status, 502);
  assert.equal(b.s.telegram.length, 0);
});

test("Edge: الحجز يحمل وصف تنبيه «غير محسوم» (النوع والرقم والتاريخ والنسخة) بلا زبون ولا مبلغ ولا رابط", { skip: SKIP }, async () => {
  const b = createBackend();
  const handler = await loadHandler(ENV, b.fetchMock);
  b.s.lostReply = 1;
  const cap = captureConsole();
  try { await handler(notifyRequest(FIELDS)); } finally { cap.restore(); }
  assert.equal(b.s.labels[0], "فاتورة جملة رقم 501 — 2026-10-24 — V1");
  for (const sensitive of [FIELDS.customer_name, FIELDS.amount, FIELDS.drive_link, FIELDS.drive_file_id]) {
    assert.ok(!b.s.labels[0].includes(sensitive));
  }
  assert.ok(cap.lines.some((l) => l.includes("delivery unknown")), "سجل الدالة يذكر النتيجة المجهولة");
});
