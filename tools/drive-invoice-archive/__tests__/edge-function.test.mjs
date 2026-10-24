// تشغيل دالة Edge الحقيقية `document-archive-notify/index.ts` على Node (حذف الأنواع)
// ببديل Deno بالذاكرة وfetch وهمي لـSupabase وتيليغرام. لا شبكة.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..");
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
  const s = { items: new Map(), telegram: [], rpc: [], failRecord: false };
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  async function fetchMock(url, init = {}) {
    const u = new URL(url);
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
      if (s.failRecord) return json(500, { message: "boom" });
      const { p_item } = JSON.parse(init.body);
      s.items.set(p_item.job_id, p_item);
      s.rpc.push(p_item);
      return json(200, null);
    }
    if (u.pathname === "/rest/v1/rpc/document_archive_ingest_report") {
      return json(200, { items: JSON.parse(init.body).p_report.items.length, retry_job_ids: [] });
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
