"use strict";
// عميل دالة Edge `document-archive-notify`. العامل لا يملك توكن البوت ولا يختار
// المستلم: يرسل المستند ورابطه، والدالة ترسله إلى محادثة المالك وحدها.

class EdgeError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code; // OFFLINE | TRANSIENT | AUTH | REJECTED
  }
}

function createEdge({ url, secret, fetchImpl = globalThis.fetch, host = "" }) {
  let base = String(url || "").slice(0, 300);
  while (base.endsWith("/")) base = base.slice(0, -1); // بلا regex: لا تراجع كارثي على سلسلة شرطات
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/functions\/v1\/document-archive-notify$/.test(base)
    && !/^http:\/\/127\.0\.0\.1:\d+\/document-archive-notify$/.test(base)) {
    throw new EdgeError("REJECTED", "عنوان دالة الإشعار غير معتمد");
  }
  if (!secret) throw new EdgeError("AUTH", "سرّ دالة الإشعار غير مضبوط");

  async function post(route, init) {
    let res;
    try {
      res = await fetchImpl(`${base}/${route}`, { method: "POST", ...init, headers: { ...init.headers, "x-ozk-archive-secret": secret } });
    } catch (err) {
      throw new EdgeError("OFFLINE", err && err.code ? String(err.code) : "network");
    }
    const data = await res.json().catch(() => ({}));
    if (res.ok && data && data.ok) return data;
    const code = String((data && data.error) || res.status).slice(0, 60);
    if (res.status === 401) throw new EdgeError("AUTH", code);
    if (res.status === 429 || res.status >= 500) throw new EdgeError("TRANSIENT", code);
    throw new EdgeError("REJECTED", code);
  }

  async function notify(job, pdf, fileName) {
    const form = new FormData();
    const fields = {
      job_id: job.jobId,
      doc_type: job.docType,
      source_guid: job.sourceGuid,
      doc_number: String(job.number),
      doc_date: job.date,
      customer_guid: job.customerGuid || "",
      customer_name: job.customerName || "",
      amount: job.amount === null || job.amount === undefined ? "" : String(job.amount),
      currency: job.currencyIso || "",
      version: String(job.version),
      version_hash: job.versionHash,
      drive_link: job.drive.webViewLink,
      drive_file_id: job.drive.fileId,
      file_name: fileName,
      host,
    };
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    form.append("file", new Blob([pdf], { type: "application/pdf" }), fileName);
    const data = await post("notify", { body: form });
    const messageId = Number(data.message_id);
    if (!Number.isFinite(messageId)) throw new EdgeError("TRANSIENT", "no message_id");
    return { messageId, duplicate: Boolean(data.duplicate) };
  }

  async function report(payload) {
    const data = await post("report", { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const ids = data.result && Array.isArray(data.result.retry_job_ids) ? data.result.retry_job_ids : [];
    return { retryJobIds: ids.filter((id) => /^[0-9a-f]{32}$/.test(String(id))) };
  }

  return { notify, report };
}

module.exports = { EdgeError, createEdge };
