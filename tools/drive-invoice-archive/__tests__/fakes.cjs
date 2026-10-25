"use strict";
// مصادر وهمية للاختبار: أمين بالذاكرة، Google Drive بالذاكرة عبر fetch، ودالة Edge
// بالذاكرة تستعمل المنطق المشترك نفسه. لا شبكة ولا بيانات زبائن حقيقية.

const crypto = require("crypto");

const WHOLESALE = "7f5b0921-61f3-4f23-a1f4-fbfae4144bf4";
const CASHIER = "cc1097b1-662d-4d80-8e4e-3b493249591c";

// ─── الأمين ───
// سطر بأعمدة archive-lines-query.sql كلها: أعمدة العرض ثم أعمدة البصمة.
function line(patch = {}) {
  return {
    item_name: "صنف تجريبي", input_unit: 1, unit1_name: "علبة", unit2_name: "كرتونة", unit3_name: "", unit2_fact: 50, unit3_fact: 0, qty: 10,
    line_guid: "eeeeeeee-0000-4000-8000-000000000001", line_number: 0, mat_guid: "cccccccc-0000-4000-8000-000000000001",
    qty2: 0, qty3: 0, price: 10, line_discount: 0, line_extra: 0, bonus_qty: 0, line_vat: 0,
    line_store_guid: "dddddddd-0000-4000-8000-000000000001", cost_guid: "00000000-0000-0000-0000-000000000000",
    ...patch,
  };
}

function createFakeAmeen() {
  const db = { invoices: new Map(), now: "2026-10-24T12:00:00" };
  let reads = 0;
  function add(inv) {
    db.invoices.set(inv.guid, {
      typeGuid: WHOLESALE, posted: 1, customerGuid: "aaaaaaaa-0000-4000-8000-000000000001",
      customer: "زبون تجريبي", total: 100, discount: 0, firstPay: 0, currencyIso: "USD",
      lines: [line()],
      totalExtra: 0, payType: 1, storeGuid: "dddddddd-0000-4000-8000-000000000001",
      createdAt: db.now, updatedAt: "1980-01-01T00:00:00", date: db.now.slice(0, 10), ...inv,
    });
  }
  function edit(guid, patch) {
    const inv = db.invoices.get(guid);
    Object.assign(inv, patch, { updatedAt: db.now });
  }
  function secondsBetween(a, b) {
    return Math.round((Date.parse(`${b}Z`) - Date.parse(`${a}Z`)) / 1000);
  }
  function row(inv) {
    const changed = inv.updatedAt > inv.createdAt ? inv.updatedAt : inv.createdAt;
    const lc = crypto.createHash("md5").update(JSON.stringify(inv.lines)).digest("hex");
    return {
      invoice_guid: inv.guid, invoice_number: inv.number, invoice_date: inv.date, type_guid: inv.typeGuid,
      type_name: "مبيعات", bill_type: 1, is_posted: inv.posted, customer_guid: inv.customerGuid,
      customer_name: inv.customer, total: inv.total, discount: inv.discount, first_pay: inv.firstPay,
      currency_val: 1, currency_iso: inv.currencyIso, line_count: inv.lines.length, lines_checksum: lc,
      customer_account_guid: inv.customerGuid, bill_customer_name: inv.billCustomerName || inv.customer,
      store_guid: inv.storeGuid, pay_type: inv.payType, total_extra: inv.totalExtra, items_disc: 0, items_extra: 0, bonus_disc: 0, vat: 0,
      changed_at: changed, seconds_since_change: secondsBetween(changed, db.now),
    };
  }
  const api = {
    serverNow: async () => db.now,
    // نفس دلالة الاستعلام: مؤشر مركّب حصري (changed_at, GUID) وترتيب بهما معاً.
    changedInvoices: async ({ since, sinceGuid = "", dateFrom, onlyGuid = null }) => {
      reads++;
      const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
      return [...db.invoices.values()]
        .filter((i) => [WHOLESALE, CASHIER].includes(i.typeGuid) && i.date >= dateFrom)
        .map(row)
        .filter((r) => r.changed_at > since || (r.changed_at === since && r.invoice_guid > sinceGuid))
        .filter((r) => !onlyGuid || r.invoice_guid === onlyGuid)
        .sort((a, b) => cmp(a.changed_at, b.changed_at) || cmp(a.invoice_guid, b.invoice_guid))
        .slice(0, 500);
    },
    lines: async (guid) => { reads++; return db.invoices.get(guid).lines.map((l) => ({ ...l })); },
    sourceStatus: async (guid) => {
      reads++;
      const inv = db.invoices.get(guid);
      return inv ? { invoice_guid: inv.guid, invoice_number: inv.number, invoice_date: inv.date, type_guid: inv.typeGuid, is_posted: inv.posted } : null;
    },
    balance: async () => 250,
  };
  const remove = (guid) => db.invoices.delete(guid);
  return { db, api, add, edit, remove, setNow: (t) => { db.now = t; }, reads: () => reads };
}

// ─── المحوّل: PDF صغير صالح بنية، محتواه بصمة الـHTML ───
function createFakeRenderer() {
  const fs = require("fs");
  let calls = 0;
  return {
    calls: () => calls,
    async render(html, _paper, outPath) {
      calls++;
      const digest = crypto.createHash("sha256").update(html).digest("hex");
      fs.writeFileSync(outPath, Buffer.from(`%PDF-1.4\n% ${digest}\n1 0 obj<</Type /Page>>endobj\n%%EOF\n`));
      return { fontOk: /@font-face\{font-family:"Cairo"/.test(html), pages: 1, bytes: 0 };
    },
    async close() {},
    browserPath: () => "fake",
  };
}

// ─── Google Drive بالذاكرة ───
function createFakeDrive({ email = "ozkkhallouf@gmail.com" } = {}) {
  const files = new Map(); // id → {id,name,mimeType,parents,appProperties,content,shared,trashed,createdTime}
  const calls = [];
  const s = { email, offline: false, fail503: 0, invalidGrant: false, scope: "https://www.googleapis.com/auth/drive.file", uploads: 0, seq: 0 };
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const unq = (v) => v.replace(/\\'/g, "'").replace(/\\\\/g, "\\");
  function matches(f, q) {
    if (/trashed=false/.test(q) && f.trashed) return false;
    const parent = /^'((?:[^'\\]|\\.)*)' in parents/.exec(q);
    if (parent && !f.parents.includes(unq(parent[1]))) return false;
    const mime = /mimeType='([^']+)'/.exec(q);
    if (mime && f.mimeType !== mime[1]) return false;
    const ap = /appProperties has \{ key='((?:[^'\\]|\\.)*)' and value='((?:[^'\\]|\\.)*)' \}/.exec(q);
    if (ap && (f.appProperties || {})[unq(ap[1])] !== unq(ap[2])) return false;
    return true;
  }
  function view(f, fields) {
    const out = { id: f.id };
    for (const k of fields) {
      if (k === "webViewLink") out.webViewLink = `https://drive.google.com/file/d/${f.id}/view?usp=drivesdk`;
      else if (k === "md5Checksum" && f.content) out.md5Checksum = crypto.createHash("md5").update(f.content).digest("hex");
      else if (k === "size" && f.content) out.size = String(f.content.length);
      else if (k in f) out[k] = f[k];
    }
    return out;
  }
  function newId() {
    s.seq++;
    return `F${String(s.seq).padStart(12, "0")}xyz`;
  }
  const notFound = () => json(404, { error: { errors: [{ reason: "notFound" }] } });
  function token() {
    if (s.invalidGrant) return json(400, { error: "invalid_grant" });
    return json(200, { access_token: `ya29.fake-${s.seq}`, expires_in: 3600, scope: s.scope, token_type: "Bearer" });
  }
  function listFiles(u) {
    const q = u.searchParams.get("q");
    const fields = /files\(([^)]*)\)/.exec(u.searchParams.get("fields"))[1].split(",");
    const list = [...files.values()].filter((f) => matches(f, q)).sort((a, b) => a.createdTime - b.createdTime);
    return json(200, { files: list.slice(0, 10).map((f) => view(f, fields)) });
  }
  function createFolder(init) {
    const f = { id: newId(), ...JSON.parse(init.body), shared: false, trashed: false, createdTime: s.seq };
    files.set(f.id, f);
    return json(200, view(f, ["shared"]));
  }
  function getFile(u) {
    const f = files.get(decodeURIComponent(u.pathname.split("/").pop()));
    return f ? json(200, view(f, ["shared", "trashed"])) : notFound();
  }
  // multipart/related: الجزء الأول JSON الوصف، والثاني PDF.
  function partBody(part) {
    return part.split("\r\n\r\n").slice(1).join("\r\n\r\n").replace(/\r\n$/, "");
  }
  function upload(init) {
    if (s.failUploads) return json(503, { error: { errors: [{ reason: "backendError" }] } });
    const boundary = /boundary=(.+)$/.exec(init.headers["Content-Type"])[1];
    const parts = Buffer.from(init.body).toString("latin1").split(`--${boundary}`);
    const meta = JSON.parse(Buffer.from(partBody(parts[1]), "latin1").toString("utf8"));
    const content = Buffer.from(partBody(parts[2]), "latin1");
    const f = { id: newId(), ...meta, content: s.corruptUpload ? content.subarray(0, content.length - 3) : content, shared: false, trashed: false, createdTime: s.seq };
    files.set(f.id, f);
    s.uploads++;
    return json(200, view(f, ["name", "webViewLink", "md5Checksum", "size", "shared"]));
  }
  function route(u, method) {
    if (u.pathname === "/drive/v3/about") return () => json(200, { user: { emailAddress: s.email } });
    if (u.pathname === "/drive/v3/files") return { GET: () => listFiles(u), POST: createFolder }[method];
    if (u.pathname.startsWith("/drive/v3/files/") && method === "GET") return () => getFile(u);
    if (u.pathname === "/upload/drive/v3/files" && method === "POST") return upload;
    return null;
  }
  async function fetchImpl(url, init = {}) {
    const method = init.method || "GET";
    calls.push({ url: String(url), method });
    if (s.offline) { const e = new Error("getaddrinfo ENOTFOUND"); e.code = "ENOTFOUND"; throw e; }
    const u = new URL(url);
    if (u.href.startsWith("https://oauth2.googleapis.com/token")) return token();
    if (/permissions/.test(u.pathname)) throw new Error("permissions endpoint must never be called");
    if (s.fail503 > 0) { s.fail503--; return json(503, { error: { errors: [{ reason: "backendError" }] } }); }
    const handler = route(u, method);
    return handler ? handler(init) : notFound();
  }
  const pathOf = (f) => {
    const names = [f.name];
    let p = f.parents && f.parents[0];
    while (p && p !== "root") { const parent = files.get(p); names.unshift(parent.name); p = parent.parents[0]; }
    return names.join("/");
  };
  return { state: s, files, calls, fetchImpl, pdfFiles: () => [...files.values()].filter((f) => f.mimeType === "application/pdf"), pathOf };
}

// ─── دالة Edge بالذاكرة (نفس قواعد الدالة الحقيقية) ───
async function createFakeEdge() {
  require("../../../supabase/functions/_shared/telegram-format.js");
  const shared = await import("../../../supabase/functions/_shared/document-archive.js");
  // conflict: ردّ 409 للطلب التالي ("in_progress" حجز قائم، "delivery_unknown" ضاع ردّ تيليغرام) — Migration 26.
  const s = { secret: "s".repeat(40), sent: [], items: new Map(), retry: [], down: false, loseResponse: 0, reports: [], conflict: [], notifyCalls: 0, reject: 0 };
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  async function fetchImpl(url, init) {
    if (s.down) { const e = new Error("ECONNRESET"); e.code = "ECONNRESET"; throw e; }
    if (!shared.timingSafeEqualText(init.headers["x-ozk-archive-secret"], s.secret)) return json(401, { ok: false, error: "unauthorized" });
    const route = String(url).split("/").pop();
    if (route === "notify") {
      const fields = {};
      let file = null;
      for (const [k, v] of init.body.entries()) { if (typeof v === "string") fields[k] = v; else file = v; }
      const checked = shared.validateNotifyFields(fields);
      if (checked.error) return json(400, { ok: false, error: checked.error });
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!shared.isPdfBytes(bytes)) return json(400, { ok: false, error: "file_type" });
      s.notifyCalls++;
      if (s.conflict.length) return json(409, { ok: false, error: s.conflict.shift() });
      if (s.reject > 0) { s.reject--; return json(502, { ok: false, error: "telegram_sendDocument_429" }); }
      const existing = s.items.get(checked.value.job_id);
      if (existing && existing.telegram_message_id) return json(200, { ok: true, duplicate: true, message_id: existing.telegram_message_id });
      const { caption, followUp } = shared.buildNotifyCaption(checked.value);
      const messageId = 1000 + s.sent.length;
      s.sent.push({ chat: "OWNER", caption, followUp, fileName: file.name, bytes: bytes.length, messageId });
      s.items.set(checked.value.job_id, shared.itemFromNotify(checked.value, messageId, fields.host));
      if (s.loseResponse > 0) { s.loseResponse--; const e = new Error("socket hang up"); e.code = "ECONNRESET"; throw e; }
      return json(200, { ok: true, duplicate: false, message_id: messageId });
    }
    if (route === "report") {
      const body = JSON.parse(init.body);
      s.reports.push(body);
      const ids = s.retry.splice(0);
      return json(200, { ok: true, result: { items: body.items.length, retry_job_ids: ids } });
    }
    return json(404, { ok: false, error: "route" });
  }
  return { state: s, fetchImpl, shared, url: "http://127.0.0.1:54321/document-archive-notify" };
}

module.exports = { WHOLESALE, CASHIER, line, createFakeAmeen, createFakeRenderer, createFakeDrive, createFakeEdge };
