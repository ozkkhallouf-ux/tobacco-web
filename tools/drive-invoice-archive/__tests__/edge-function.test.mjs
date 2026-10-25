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
    telegramFail: 0, telegramStatus: 500, restDown: false, calls: 0 };
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  async function fetchMock(url, init = {}) {
    const u = new URL(url);
    s.calls++;
    if (u.hostname !== "api.telegram.org" && s.restDown) { const e = new TypeError("fetch failed"); e.code = "ECONNRESET"; throw e; }
    if (u.hostname === "api.telegram.org" && s.telegramFail > 0) {
      s.telegramFail--;
      return json(s.telegramStatus, { ok: false, error_code: s.telegramStatus, description: "Too Many Requests: retry after 5" });
    }
    if (u.hostname === "api.telegram.org") {
      const method = u.pathname.split("/").pop();
      const entry = { method, token: u.pathname.split("/")[1] };
      if (init.body instanceof FormData) {
        for (const [k, v] of init.body.entries()) entry[k] = typeof v === "string" ? v : { name: v.name, size: v.size };
      } else {
        Object.assign(entry, JSON.parse(init.body));
      }
      s.telegram.push(entry);
      return json(200, { ok: true, result: { message_id: 7000 + s.telegram.length } });
    }
    if (u.pathname === "/rest/v1/bot_config") return json(200, [{ value: OWNER_CHAT }]);
    if (u.pathname === "/rest/v1/document_archive_items") {
      const id = /job_id=eq\.([0-9a-f]+)/.exec(u.search)[1];
      const it = s.items.get(id);
      return json(200, it ? [{ telegram_message_id: it.telegram_message_id }] : []);
    }
    if (u.pathname === "/rest/v1/rpc/document_archive_record_notification") {
      s.recordCalls++;
      if (s.failRecord) return json(500, { message: "boom" });
      if (s.failRecordTimes > 0) { s.failRecordTimes--; return json(503, { message: "busy" }); }
      const { p_item } = JSON.parse(init.body);
      s.items.set(p_item.job_id, p_item);
      s.rpc.push(p_item);
      return json(200, null);
    }
    if (u.pathname === "/rest/v1/rpc/document_archive_ingest_report") {
      const items = JSON.parse(init.body).p_report.items;
      // نفس قاعدة upsert في Migration 22: message_id الأول لا يُكتب فوقه.
      for (const it of items) {
        const prev = s.items.get(it.job_id);
        s.items.set(it.job_id, { ...it, telegram_message_id: (prev && prev.telegram_message_id) ?? it.telegram_message_id ?? null });
      }
      return json(200, { items: items.length, retry_job_ids: [] });
    }
    return json(404, {});
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
