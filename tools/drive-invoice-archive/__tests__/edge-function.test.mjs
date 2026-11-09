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
    // failAt/lostReplyAt: Set بترتيب نداء تيليغرام (1 فصاعداً) لإفشال أو قطع رسالة واحدة بعينها
    // ضمن دفعة مُقسَّمة لعدة رسائل، بمعزل عن الرسائل الأخرى في الدفعة نفسها.
    lostReply: 0, unreadable: 0, delayMs: 0, telegramFailAt: null, lostReplyAt: null, telegramCallIndex: 0 };
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  async function telegramApi(u, init) {
    s.telegramCallIndex++;
    const callIndex = s.telegramCallIndex;
    if (s.delayMs) await new Promise((r) => setTimeout(r, s.delayMs));
    if (s.telegramFail > 0 || (s.telegramFailAt && s.telegramFailAt.has(callIndex))) {
      if (s.telegramFail > 0) s.telegramFail--;
      return json(s.telegramStatus, { ok: false, error_code: s.telegramStatus, description: "Too Many Requests: retry after 5" });
    }
    const entry = { method: u.pathname.split("/").pop(), token: u.pathname.split("/")[1] };
    if (init.body instanceof FormData) {
      for (const [k, v] of init.body.entries()) entry[k] = typeof v === "string" ? v : { name: v.name, size: v.size };
    } else {
      Object.assign(entry, JSON.parse(init.body));
    }
    s.telegram.push(entry);
    if (s.lostReply > 0 || (s.lostReplyAt && s.lostReplyAt.has(callIndex))) {
      if (s.lostReply > 0) s.lostReply--;
      const e = new TypeError("fetch failed"); e.code = "ECONNRESET"; throw e;
    }
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

// ─── /notify-batch: تحديث جماعي برسالة ملخص واحدة (حادثة 2026-11-09: 74 إشعاراً فردياً لتسوية دفعات) ───

function hex(n, len) { return n.toString(16).padStart(len, "0"); }

function batchItem(n, overrides = {}) {
  return {
    job_id: hex(n, 32), doc_type: "wholesale_invoice", source_guid: `11111111-1111-4111-8111-${hex(n, 12)}`,
    doc_number: String(500 + n), doc_date: "2026-10-24", customer_guid: "aaaaaaaa-0000-4000-8000-000000000001",
    customer_name: `زبون ${n}`, amount: String(1000 + n), currency: "USD", version: "2", version_hash: hex(n, 64),
    drive_file_id: `F${hex(n, 12)}xyz`, drive_link: `https://drive.google.com/file/d/F${hex(n, 12)}xyz/view?usp=drivesdk`,
    ...overrides,
  };
}

function batchRequest(items, { secret = SECRET, host = "OZK2026" } = {}) {
  return new Request("https://example.supabase.co/functions/v1/document-archive-notify/notify-batch", {
    method: "POST", headers: { "x-ozk-archive-secret": secret, "Content-Type": "application/json" },
    body: JSON.stringify({ host, items }),
  });
}

test("Edge: /notify-batch يرسل ملخصاً واحداً لعدة فواتير بلا ملف، ويسجّل كل واحدة بالمعرّف الجماعي نفسه", { skip: SKIP }, async () => {
  const b = createBackend();
  const handler = await loadHandler(ENV, b.fetchMock);
  const items = [1, 2, 3].map((n) => batchItem(n));
  const res = await handler(batchRequest(items));
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.deepEqual(body.notified_job_ids.sort(), items.map((i) => i.job_id).sort());
  assert.deepEqual(body.already_sent, {});
  assert.deepEqual(body.held_job_ids, []);
  assert.deepEqual(body.unknown_job_ids, []);
  assert.equal(b.s.telegram.length, 1, "رسالة واحدة فقط بدل ثلاث");
  const sent = b.s.telegram[0];
  assert.equal(sent.method, "sendMessage");
  assert.equal(sent.chat_id, OWNER_CHAT);
  assert.ok(!("document" in sent), "بلا ملف مرفق للرسالة الجماعية");
  for (const it of items) assert.match(sent.text, new RegExp(it.doc_number));
  assert.equal(b.s.recordCalls, 3);
  const messageId = body.notified_message_ids[items[0].job_id];
  assert.ok(Number.isFinite(messageId));
  for (const it of items) {
    assert.equal(body.notified_message_ids[it.job_id], messageId, "رسالة واحدة ⇒ نفس المعرّف لكل العناصر");
    assert.equal(b.s.items.get(it.job_id).telegram_message_id, messageId);
  }
});

test("Edge: /notify-batch وعنصر مُرسَل سابقاً عبر /notify يُفرز في already_sent برسالته الخاصة، والباقي يُرسل معاً", { skip: SKIP }, async () => {
  const b = createBackend();
  const handler = await loadHandler(ENV, b.fetchMock);
  const prior = batchItem(1);
  const firstSend = await (await handler(notifyRequest({
    ...FIELDS, job_id: prior.job_id, source_guid: prior.source_guid, version_hash: prior.version_hash, doc_number: prior.doc_number,
  }))).json();
  const items = [prior, batchItem(2), batchItem(3)];
  const res = await handler(batchRequest(items));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body.already_sent, { [prior.job_id]: firstSend.message_id });
  assert.deepEqual(body.notified_job_ids.sort(), [items[1].job_id, items[2].job_id].sort());
  assert.equal(b.s.telegram.filter((t) => t.method === "sendDocument").length, 1, "إشعار /notify السابق وحده");
  assert.equal(b.s.telegram.filter((t) => t.method === "sendMessage").length, 1, "ملخص الدفعة للباقي فقط");
});

test("Edge: /notify-batch يرفض دفعة فارغة أو أكبر من الحدّ أو بمعرّف مكرر أو بعنصر غير صالح، بلا أي حجز أو إرسال", { skip: SKIP }, async () => {
  const b = createBackend();
  const handler = await loadHandler(ENV, b.fetchMock);
  const rEmpty = await handler(batchRequest([]));
  assert.equal(rEmpty.status, 400);
  assert.equal((await rEmpty.json()).error, "empty");
  const tooMany = Array.from({ length: 201 }, (_, i) => batchItem(i + 1));
  const rBig = await handler(batchRequest(tooMany));
  assert.equal(rBig.status, 400);
  assert.equal((await rBig.json()).error, "batch_too_large");
  const dup = [batchItem(1), { ...batchItem(2), job_id: batchItem(1).job_id }];
  const rDup = await handler(batchRequest(dup));
  assert.equal((await rDup.json()).error, "duplicate_job_id");
  const invalid = [batchItem(1), { ...batchItem(2), doc_date: "24-10-2026" }];
  const rInvalid = await handler(batchRequest(invalid));
  assert.equal((await rInvalid.json()).error, "doc_date");
  assert.equal(b.s.calls, 0, "لا حجز ولا اتصال خارجي قبل اكتمال التحقق من الدفعة كلها");
});

test("Edge: ضياع ردّ تيليغرام على رسالة الدفعة ⇒ unknown_job_ids وحجز «غير محسوم»، والإعادة لا تُرسل ثانية", { skip: SKIP }, async () => {
  const b = createBackend();
  const handler = await loadHandler(ENV, b.fetchMock);
  const items = [batchItem(1), batchItem(2)];
  b.s.lostReply = 1;
  const cap = captureConsole();
  let res;
  try { res = await handler(batchRequest(items)); } finally { cap.restore(); }
  const body = await res.json();
  assert.equal(res.status, 200, "ردّ 200 دائماً؛ التصنيف في جسم الرد لا في رمز الحالة");
  assert.deepEqual(body.unknown_job_ids.sort(), items.map((i) => i.job_id).sort());
  assert.deepEqual(body.notified_job_ids, []);
  for (const it of items) assert.equal(b.s.claims.get(it.job_id).state, "unknown");
  assert.equal(b.s.telegram.length, 1, "الرسالة وصلت فعلياً رغم ضياع الردّ");
  const again = await (await handler(batchRequest(items))).json();
  assert.deepEqual(again.unknown_job_ids.sort(), items.map((i) => i.job_id).sort());
  assert.equal(b.s.telegram.length, 1, "لا إعادة إرسال تلقائية لنتيجة غامضة، كما /notify بالضبط");
});

test("Edge: رفض صريح من تيليغرام على رسالة الدفعة يحرّر الحجز (held لا unknown)، وإعادة العامل ترسل مرة واحدة فقط", { skip: SKIP }, async () => {
  const b = createBackend();
  const handler = await loadHandler(ENV, b.fetchMock);
  const items = [batchItem(1), batchItem(2)];
  b.s.telegramFail = 1;
  b.s.telegramStatus = 429;
  const res = await handler(batchRequest(items));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body.held_job_ids.sort(), items.map((i) => i.job_id).sort(), "رفض صريح (not_sent) يُطوى في held لا unknown");
  assert.deepEqual(body.unknown_job_ids, []);
  for (const it of items) assert.equal(b.s.claims.get(it.job_id).state, "released");
  const again = await (await handler(batchRequest(items))).json();
  assert.deepEqual(again.notified_job_ids.sort(), items.map((i) => i.job_id).sort());
  assert.equal(b.s.telegram.length, 1, "رسالة واحدة فقط رغم محاولتين");
});

// الوحدة المشتركة (buildBatchSummaries) بعد تحميل telegram-format عبر loadHandler (استيراد
// index.ts يحمّلها كأثر جانبي)، لحساب عدد الفواتير فعلياً بلا تخمين رياضي للنص المُركَّب.
async function loadSharedDocArchive() {
  const file = path.join(fnDir, "_shared", "document-archive.js");
  return await import(`${pathToFileURL(file).href}?v=shared`);
}

function longDocNumber(n) { return `INV-${n}-${"X".repeat(40)}`.slice(0, 40); }

test("Edge: /notify-batch دفعة تنقسم فعلياً لثلاث رسائل؛ فشل الرسالة الوسطى صريحاً لا يمسّ الأولى والأخيرة، ولا تُعاد الناجحتان", { skip: SKIP }, async () => {
  const b = createBackend();
  const handler = await loadHandler(ENV, b.fetchMock);
  const shared = await loadSharedDocArchive();
  const items = [];
  let pages = 0;
  for (let n = 1; pages < 3 && items.length < 200; n++) {
    items.push(batchItem(n, { doc_number: longDocNumber(n) }));
    pages = shared.buildBatchSummaries(items).length;
  }
  assert.ok(pages >= 3, "تعذّر فرض ٣ رسائل على الأقل ضمن حدّ الدفعة 200 عنصراً");
  const groups = shared.buildBatchSummaries(items);
  const failedIds = groups[1].items.map((it) => it.job_id);
  const okIds = items.map((it) => it.job_id).filter((id) => !failedIds.includes(id));

  b.s.telegramFailAt = new Set([2]); // الرسالة الثانية فقط تُرفض صريحاً من تيليغرام
  const res = await handler(batchRequest(items));
  const body = await res.json();
  assert.equal(res.status, 200);
  // telegramCallIndex: عدد محاولات الاتصال بتيليغرام فعلياً (ناجحة أو مرفوضة صريحاً)؛ s.telegram
  // يسجّل فقط المحاولات التي وصلت ردّها (لا الرفض الصريح)، فطولها هنا = عدد الصفحات ناقص الفاشلة.
  assert.equal(b.s.telegramCallIndex, pages, `محاولة اتصال واحدة بكل صفحة من الصفحات (${pages})، بما فيها الفاشلة صريحاً`);
  assert.equal(b.s.telegram.length, pages - 1, "الرسائل الناجحة فقط سُجِّلت كمُرسَلة فعلياً؛ الرسالة المرفوضة صريحاً لم تُسجَّل");
  assert.deepEqual(body.notified_job_ids.sort(), okIds.sort(), "كل عناصر الرسائل الناجحة (قبل الفاشلة وبعدها) أُنهيت ونُسِّمت فعلاً");
  assert.deepEqual(body.held_job_ids.sort(), failedIds.sort(), "فقط عناصر الرسالة الفاشلة محجوزة لإعادة لاحقة");
  assert.deepEqual(body.unknown_job_ids, []);
  for (const id of failedIds) assert.equal(b.s.claims.get(id).state, "released");
  for (const id of okIds) assert.equal(b.s.claims.get(id).state, "sent");

  const sentBefore = b.s.telegram.length;
  const retry = await (await handler(batchRequest(items))).json();
  assert.equal(b.s.telegram.length, sentBefore + 1, "الإعادة تُرسل رسالة واحدة جديدة فقط لما بقي محجوزاً، بلا تكرار لما نجح");
  assert.deepEqual(retry.notified_job_ids.sort(), failedIds.sort());
  assert.equal(Object.keys(retry.already_sent).length, okIds.length, "كل الناجح سابقاً already_sent، لا إرسال ثانٍ");
});

test("Edge: /notify-batch دفعتان متزامنتان بعناصر متداخلة ⇒ لا فاتورة تُرسل مرتين ولا تضيع، والإعادة تُكمل الباقي بلا تكرار", { skip: SKIP }, async () => {
  const b = createBackend();
  const handler = await loadHandler(ENV, b.fetchMock);
  const itemsA = [1, 2, 3, 4, 5].map((n) => batchItem(n));
  const itemsB = [3, 4, 5, 6, 7].map((n) => batchItem(n));
  const sharedIds = new Set([3, 4, 5].map((n) => batchItem(n).job_id));
  const allIds = [1, 2, 3, 4, 5, 6, 7].map((n) => batchItem(n).job_id);

  const [resA, resB] = await Promise.all([handler(batchRequest(itemsA)), handler(batchRequest(itemsB))]);
  const [bodyA, bodyB] = await Promise.all([resA.json(), resB.json()]);
  assert.equal(resA.status, 200);
  assert.equal(resB.status, 200);

  const notifiedBoth = bodyA.notified_job_ids.filter((id) => bodyB.notified_job_ids.includes(id));
  assert.deepEqual(notifiedBoth, [], "لا فاتورة مشتركة اعتُبرت مُرسلة في الدفعتين معاً");
  const allNotified = [...bodyA.notified_job_ids, ...bodyB.notified_job_ids];
  assert.equal(allNotified.length, new Set(allNotified).size, "بلا ازدواج في notified_job_ids إجمالاً عبر الدفعتين");

  const classified = (body, id) => (
    body.notified_job_ids.includes(id) || id in body.already_sent || body.held_job_ids.includes(id) || body.unknown_job_ids.includes(id)
  );
  for (const id of sharedIds) {
    assert.ok(classified(bodyA, id), `${id} غير مصنَّف في ردّ الدفعة الأولى`);
    assert.ok(classified(bodyB, id), `${id} غير مصنَّف في ردّ الدفعة الثانية`);
  }

  const sentBefore = b.s.telegram.length;
  const retry = await (await handler(batchRequest([1, 2, 3, 4, 5, 6, 7].map((n) => batchItem(n))))).json();
  assert.equal(b.s.telegram.length, sentBefore, "دورة الإكمال لا تُرسل أي رسالة جديدة: كل الفواتير وصلت فعلاً من الدفعتين المتزامنتين");
  const delivered = new Set([...retry.notified_job_ids, ...Object.keys(retry.already_sent)]);
  for (const id of allIds) assert.ok(delivered.has(id), `${id} لم تُسلَّم أخيراً، أي فُقدت`);
});

for (const n of [1, 10, 74, 100]) {
  test(`Edge: /notify-batch بالضبط ${n} فاتورة معدَّلة في دفعة واحدة (مقياس حادثة 2026-11-09 ×${n === 74 ? "1 (الحجم الحقيقي)" : "مختلف"}) ⇒ كل الفواتير مُصنَّفة وتحت حدّ الرسالة بلا تقسيم`, { skip: SKIP }, async () => {
    const b = createBackend();
    const handler = await loadHandler(ENV, b.fetchMock);
    const items = Array.from({ length: n }, (_, i) => batchItem(i + 1));
    const res = await handler(batchRequest(items));
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(body.notified_job_ids.sort(), items.map((i) => i.job_id).sort());
    assert.deepEqual(body.held_job_ids, []);
    assert.deepEqual(body.unknown_job_ids, []);
    assert.equal(b.s.telegram.length, 1, `${n} فاتورة بأرقام واقعية تبقى ضمن رسالة واحدة (buildBatchSummaries) بلا تقسيم`);
    const text = b.s.telegram[0].text;
    assert.ok(text.length < 4096, "تحت حدّ تيليغرام الفعلي 4096 محرفاً");
    for (const it of items) assert.match(text, new RegExp(it.doc_number));
    if (n === 1) assert.match(text, /فاتورة معدَّلة|مستند معدَّل/, "رسالة فاتورة معدَّلة واحدة تحمل الوصف الصحيح");
  });
}

test("Edge: /notify-batch انقطاع الاتصال أثناء إرسال رسالة واحدة ضمن دفعة من رسالتين لا يمسّ الرسالة الأخرى، ولا تُعاد الناجحة", { skip: SKIP }, async () => {
  const b = createBackend();
  const handler = await loadHandler(ENV, b.fetchMock);
  const shared = await loadSharedDocArchive();
  const items = [];
  let pages = 0;
  for (let n = 1; pages < 2 && items.length < 200; n++) {
    items.push(batchItem(n, { doc_number: longDocNumber(n) }));
    pages = shared.buildBatchSummaries(items).length;
  }
  assert.ok(pages >= 2);
  const groups = shared.buildBatchSummaries(items);
  const droppedIds = groups[0].items.map((it) => it.job_id);
  const okIds = items.map((it) => it.job_id).filter((id) => !droppedIds.includes(id));

  b.s.lostReplyAt = new Set([1]); // أول رسالة فقط: وصلت فعلياً لتيليغرام ثم انقطع الردّ (نتيجة "مجهولة")
  const res = await handler(batchRequest(items));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(b.s.telegram.length, pages, "الرسالتان أُرسلتا فعلياً رغم ضياع ردّ الأولى");
  assert.deepEqual(body.unknown_job_ids.sort(), droppedIds.sort(), "رسالة ضاع ردّها ⇒ مجهولة، لا مفقودة ولا مؤكَّد فشلها");
  assert.deepEqual(body.notified_job_ids.sort(), okIds.sort(), "الرسالة الثانية الناجحة أُنهيت بمعزل عن ضياع ردّ الأولى");
  for (const id of droppedIds) assert.equal(b.s.claims.get(id).state, "unknown");
  for (const id of okIds) assert.equal(b.s.claims.get(id).state, "sent");

  const sentBefore = b.s.telegram.length;
  const retry = await (await handler(batchRequest(items))).json();
  assert.equal(b.s.telegram.length, sentBefore, "لا إعادة إرسال تلقائية لنتيجة مجهولة (كما /notify بالضبط)، ولا تكرار للناجحة");
  assert.deepEqual(retry.unknown_job_ids.sort(), droppedIds.sort());
  assert.equal(Object.keys(retry.already_sent).length, okIds.length);
});
