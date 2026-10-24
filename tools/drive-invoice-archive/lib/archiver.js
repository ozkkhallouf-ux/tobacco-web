"use strict";
// نواة عامل الأرشفة — بلا شبكة مباشرة: الأمين والمحوّل وDrive ودالة Edge كلها محقونة،
// فتُختبر بالكامل بمصادر وهمية.
//
// الدورة: رصد ← توليد PDF ← رفع ← إشعار ← تقرير. كل مرحلة مستقلة:
//   * لا إشعار قبل تأكيد الرفع (fileId + md5 + حجم مطابقة).
//   * فشل تيليغرام لا يعيد الرفع (المهمة تبقى uploaded وتحمل fileId).
//   * فشل Drive أو الشبكة يبقي المهمة في الصندوق الدائم؛ لا شيء يُحذف.
//   * الأمين قراءة فقط عبر الحارس؛ العامل لا يمسّ الفاتورة ولا الطباعة ولا الموقع.

const fs = require("fs");
const model = require("../../manual-a4-print/lib/invoice-model");
const { invoiceVersionHash, jobIdFor, sha256 } = require("./fingerprint");
const { folderPlan, fileName } = require("./naming");
const { STATUS } = require("./store");
const { MODES } = require("./config");
const { redact } = require("./redact");

const DOC_TYPE = "wholesale_invoice";
// أخطاء تخصّ الاتصال أو الحساب لا المهمة: توقف المرحلة كلها في هذه الدورة بلا عدّ محاولات.
const GLOBAL_DRIVE = { NEEDS_REAUTH: "needs_reauth", IDENTITY_MISMATCH: "identity_mismatch", NOT_PRIVATE: "not_private", OFFLINE: "disconnected" };
const GLOBAL_EDGE = new Set(["AUTH", "OFFLINE"]);

function minTime(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a < b ? a : b;
}

function addSeconds(iso, seconds) {
  const t = Date.parse(`${String(iso).replace(/Z$/, "")}Z`);
  return new Date(t + seconds * 1000).toISOString().replace(/Z$/, "");
}

function rowHint(row) {
  const { changed_at, seconds_since_change, ...rest } = row; // eslint-disable-line no-unused-vars
  return sha256(JSON.stringify(rest));
}

function createArchiver({ cfg, store, ameen, renderer, template, paper, getDrive, edge, log, now = () => Date.now() }) {
  const mode = MODES[cfg.mode];
  const state = store.state;
  state.hints = state.hints || {};
  let folderCache = {};
  let driveState = mode.upload ? "disconnected" : "disabled";
  let driveCheckedAt = null;
  let lastReportAt = 0;

  function emit(event, data) {
    const safe = {};
    for (const [k, v] of Object.entries(data || {})) safe[k] = typeof v === "string" ? redact(v) : v;
    log({ at: new Date(now()).toISOString(), event, ...safe });
  }

  function failJob(job, stage, err, { immediate = false } = {}) {
    job.attempts = (job.attempts || 0) + 1;
    job.lastError = redact(`${stage}:${err && err.code ? err.code : "ERROR"}`, 120);
    job.lastErrorAt = new Date(now()).toISOString();
    const backoff = Math.min(3600, 30 * 2 ** Math.min(job.attempts, 7));
    job.nextAttemptAt = now() + backoff * 1000;
    if (immediate || job.attempts >= cfg.maxAttempts) {
      job.failed = true;
      job.failedAt = job.lastErrorAt;
    }
    store.saveJob(job);
    emit("job_error", { jobId: job.jobId, number: job.number, version: job.version, stage, code: err && err.code, message: err && err.message });
  }

  // ─── المولّد: نفس القالب الرسمي A4 وخط Cairo؛ بلا خط مضمَّن ⇒ لا أرشفة ───
  async function renderInvoice(header, lines, outPath) {
    const balance = await ameen.balance(header.guid);
    const inv = model.buildInvoice(header, lines, balance);
    const html = template.buildInvoiceHtml(inv);
    const fontEmbedded = /@font-face\{font-family:"Cairo"/.test(html);
    const result = await renderer.render(html, paper, outPath);
    if (cfg.requireOfficialFont && !(fontEmbedded && result.fontOk)) {
      const err = new Error("خط Cairo لم يُضمَّن");
      err.code = "FONT";
      throw err;
    }
    if (!(result.pages > 0)) {
      const err = new Error("PDF بلا صفحات");
      err.code = "RENDER";
      throw err;
    }
    return inv;
  }

  function headerOf(row) {
    const header = model.headerFromRow(row, cfg);
    header.customerGuid = model.isGuid(row.customer_guid) ? model.normGuid(row.customer_guid) : "";
    return header;
  }

  // صفحات مرتبة بـ(وقت التغيير، GUID) (TOP 500 في الاستعلام)، والمؤشر المركّب حصري:
  // الصفحة التالية تبدأ بعد آخر صف بالضبط، فلا تحبسها فواتير كثيرة بالوقت نفسه (Codex P1).
  // نافذة أطول من 40 صفحة تُستأنف من المؤشر نفسه في الدورة التالية (state.resume).
  async function fetchChanged(window) {
    const all = [];
    let cursor = { since: window.since, sinceGuid: window.sinceGuid || "" };
    for (let page = 0; page < 40; page++) {
      const rows = await ameen.changedInvoices({ ...cursor, dateFrom: window.dateFrom });
      all.push(...rows);
      if (rows.length < 500) return { rows: all, complete: true, cursor: null };
      const last = rows[rows.length - 1];
      cursor = { since: last.changed_at, sinceGuid: last.invoice_guid };
    }
    return { rows: all, complete: false, cursor };
  }

  // ─── الرصد ───
  // نافذة القراءة: استئناف مسح لم يكتمل، أو مطابقة شاملة دورية (lookback)، وإلا من العلامة
  // ناقص التداخل. بلا علامة (صندوق جديد أو ضاع ملف الحالة) لا مطابقة: المسح الأول يغطي
  // النطاق المصرَّح به كاملاً من archiveFrom، وlookback لا يُطبَّق إلا بعد اكتماله (Codex P1).
  function detectWindow(serverNow, reconcile) {
    if (state.resume) return { ...state.resume };
    if (!reconcile) {
      return { since: state.watermark ? addSeconds(state.watermark, -cfg.overlapSeconds) : `${cfg.archiveFrom}T00:00:00`, dateFrom: cfg.archiveFrom };
    }
    folderCache = {}; // مجلد حُذف يدوياً لا يبقى في المخبأ أكثر من دورة مطابقة
    const lookback = addSeconds(serverNow, -cfg.lookbackDays * 86400).slice(0, 10);
    return { since: "1900-01-01T00:00:00", dateFrom: lookback > cfg.archiveFrom ? lookback : cfg.archiveFrom, reconcile: true };
  }

  function newJob(header, version, versionHash, latest, pdf) {
    return {
      jobId: jobIdFor(DOC_TYPE, header.guid, versionHash, version),
      docType: DOC_TYPE,
      sourceGuid: header.guid,
      number: header.number,
      date: header.date,
      typeGuid: header.typeGuid,
      customerGuid: header.customerGuid,
      customerName: header.customer,
      amount: Math.round((header.total - header.discount) * 1000) / 1000,
      currencyIso: header.currencyIso,
      version,
      versionHash,
      previousJobId: latest ? latest.jobId : null,
      status: STATUS.RENDERED,
      pdfSha256: sha256(pdf),
      pdfBytes: pdf.length,
      createdAt: new Date(now()).toISOString(),
      attempts: 0,
      nextAttemptAt: 0,
      failed: false,
      drive: null,
      telegram: null,
    };
  }

  // نسخة جديدة لفاتورة مستقرة: PDF ثم مهمة. يعيد true إن أُنشئت مهمة.
  async function archiveRow(header, hint) {
    const lines = await ameen.lines(header.guid);
    const content = model.buildInvoice(header, lines, null);
    content.customerGuid = header.customerGuid;
    const versionHash = invoiceVersionHash(content);
    const latest = store.latestVersion(DOC_TYPE, header.guid);
    let created = false;
    if (!latest || latest.versionHash !== versionHash) {
      const version = store.nextVersionNumber(DOC_TYPE, header.guid);
      const pdfFile = store.pdfPath(jobIdFor(DOC_TYPE, header.guid, versionHash, version));
      await renderInvoice(header, lines, pdfFile);
      const job = newJob(header, version, versionHash, latest, fs.readFileSync(pdfFile));
      store.saveJob(job);
      created = true;
      emit(version > 1 ? "invoice_edited" : "invoice_detected", { jobId: job.jobId, number: header.number, version });
    }
    state.hints[header.guid] = hint;
    delete state.detectErrors[header.guid];
    return created;
  }

  // لا مهمة بلا PDF سليم. يُعاد بتراجع (حتى ساعة)، والمطابقة الدورية تعيد رؤيته.
  function recordDetectError(header, hint, prevError, err) {
    const attempts = (prevError && prevError.hint === hint ? prevError.attempts : 0) + 1;
    state.detectErrors[header.guid] = {
      hint,
      number: header.number,
      attempts,
      code: String(err && err.code || "ERROR").slice(0, 30),
      at: new Date(now()).toISOString(),
      nextAt: now() + Math.min(3600, 60 * 2 ** Math.min(attempts, 6)) * 1000,
    };
    emit("detect_error", { guid: header.guid, number: header.number, code: err && err.code, message: err && err.message });
  }

  // صف واحد: «unstable» (لم يستقر، يحجز العلامة) أو «skip» أو «created» أو «same».
  async function detectRow(row) {
    const header = headerOf(row);
    if (!header.printable || !header.guid || !header.isPosted) return "skip"; // غير المرحّلة ليست نسخة نهائية
    if (Number(row.seconds_since_change) < cfg.stableSeconds) return "unstable";
    const hint = rowHint(row);
    if (state.hints[header.guid] === hint) return "skip";
    const prevError = state.detectErrors[header.guid];
    if (prevError && prevError.hint === hint && now() < prevError.nextAt) return "skip";
    try {
      return (await archiveRow(header, hint)) ? "created" : "same";
    } catch (err) {
      recordDetectError(header, hint, prevError, err);
      return "error";
    }
  }

  // طابور إعادة دائم لأخطاء الرصد، مستقل عن نافذة القراءة: فاتورة فشل توليدها لا تضيع حين
  // تتقدّم العلامة بعدها وتاريخها خارج lookback (Codex P1). تُقرأ بمعرّفها وحده عند حلول
  // موعدها؛ فاتورة حُذفت أو خرجت من النطاق أو صارت غير مرحّلة تخرج من الطابور.
  async function retryDetectErrors() {
    const dueGuids = Object.keys(state.detectErrors)
      .filter((g) => model.isGuid(g) && now() >= (Number(state.detectErrors[g].nextAt) || 0))
      .slice(0, 50);
    for (const guid of dueGuids) {
      const [row] = await ameen.changedInvoices({ since: "1900-01-01T00:00:00", sinceGuid: "", dateFrom: cfg.archiveFrom, onlyGuid: guid });
      const outcome = row ? await detectRow(row) : "gone";
      if (outcome !== "error") delete state.detectErrors[guid];
    }
  }

  // العلامة: لا تتجاوز أقدم فاتورة غير مستقرة، ولا آخر صف إن لم تكتمل الصفحات.
  function advanceWatermark(mark, reconcile) {
    if (!reconcile) {
      state.watermark = mark;
      return;
    }
    state.lastReconcileAt = now();
    if (!state.watermark || mark < state.watermark) state.watermark = mark;
  }

  async function detect() {
    const serverNow = await ameen.serverNow();
    const window = detectWindow(serverNow, Boolean(state.watermark) && now() - (state.lastReconcileAt || 0) >= cfg.reconcileMinutes * 60_000);
    const reconcile = Boolean(window.reconcile);
    const { rows, complete, cursor } = await fetchChanged(window);
    state.detectErrors = state.detectErrors || {};
    let holdBack = null; // أقدم فاتورة مرحّلة لم تستقر بعد
    let created = 0;
    for (const row of rows) {
      const outcome = await detectRow(row);
      if (outcome === "created") created++;
      if (outcome === "unstable" && (!holdBack || row.changed_at < holdBack)) holdBack = row.changed_at;
    }
    holdBack = minTime(window.holdBack, holdBack);
    await retryDetectErrors();
    // مسح لم يكتمل: العلامة كما هي، والمؤشر يُحفظ ليُستأنف منه بالضبط في الدورة التالية.
    if (!complete) {
      state.resume = { ...window, since: cursor.since, sinceGuid: cursor.sinceGuid, holdBack };
      store.saveState();
      return { rows: rows.length, created, reconcile, complete };
    }
    state.resume = null;
    let mark = serverNow;
    if (holdBack && holdBack < mark) mark = holdBack;
    advanceWatermark(mark, reconcile);
    store.saveState();
    return { rows: rows.length, created, reconcile, complete };
  }

  function due(job) {
    if (job.failed) {
      const failedAt = Date.parse(job.failedAt || 0) || 0;
      if (now() - failedAt < cfg.failedCooldownMinutes * 60_000) return false;
      job.failed = false; // إحياء تلقائي بعد التهدئة: دورة محاولات كاملة أخرى
      job.attempts = 0;
      store.saveJob(job);
    }
    return (job.nextAttemptAt || 0) <= now();
  }

  // ─── الرفع ───
  async function uploadJob(drive, job) {
    let pdf;
    try {
      pdf = fs.readFileSync(store.pdfPath(job.jobId));
    } catch {
      return failJob(job, "upload", { code: "PDF_MISSING" }, { immediate: true });
    }
    if (sha256(pdf) !== job.pdfSha256) return failJob(job, "upload", { code: "PDF_CHANGED" }, { immediate: true });
    const name = fileName(job);
    // ملف سابق بمعرّف المهمة نفسه ومحتوى مطابق ⇒ يُعتمد بلا رفع. ملف سابق تالف يبقى
    // كما هو (لا حذف) ويُرفع بجانبه ملف سليم.
    let verified = null;
    for (const existing of await drive.findArchived(job.jobId)) {
      try { verified = drive.verifyUploaded(existing, pdf); break; } catch (err) {
        if (err && err.code === "NOT_PRIVATE") throw err;
      }
    }
    if (verified) {
      emit("upload_found_existing", { jobId: job.jobId, number: job.number, version: job.version });
    } else {
      const folderId = await drive.ensurePath(folderPlan(job), folderCache);
      const file = await drive.upload({
        folderId,
        name,
        pdf,
        appProperties: {
          ozkArchive: "1",
          ozkJobId: job.jobId,
          ozkDocType: job.docType,
          ozkSourceGuid: job.sourceGuid,
          ozkVersion: String(job.version),
          ozkVersionHash: job.versionHash,
        },
      });
      verified = drive.verifyUploaded(file, pdf);
      emit("uploaded", { jobId: job.jobId, number: job.number, version: job.version });
    }
    job.drive = { fileId: verified.fileId, webViewLink: verified.webViewLink, fileName: name };
    job.status = STATUS.UPLOADED;
    job.archivedAt = new Date(now()).toISOString();
    job.attempts = 0;
    job.nextAttemptAt = 0;
    job.lastError = null;
    store.saveJob(job);
  }

  async function uploadStage() {
    const ready = store.jobs().filter((j) => j.status === STATUS.RENDERED && due(j));
    let drive;
    try {
      drive = getDrive();
      await drive.verifyIdentity();
      await drive.checkRootPrivate(folderCache);
      driveState = "connected";
      driveCheckedAt = new Date(now()).toISOString();
    } catch (err) {
      driveState = GLOBAL_DRIVE[err && err.code] || "disconnected";
      driveCheckedAt = new Date(now()).toISOString();
      emit("drive_unavailable", { state: driveState, code: err && err.code, message: err && err.message });
      return { uploaded: 0, blocked: ready.length };
    }
    let uploaded = 0;
    for (const job of ready.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      try {
        await uploadJob(drive, job);
        if (job.status === STATUS.UPLOADED) uploaded++;
      } catch (err) {
        if (GLOBAL_DRIVE[err && err.code]) {
          driveState = GLOBAL_DRIVE[err.code];
          emit("drive_unavailable", { state: driveState, code: err.code, message: err.message });
          break; // لا نعدّ محاولة على المهمة: العطل في الاتصال أو الحساب
        }
        failJob(job, "upload", err, { immediate: err && err.code === "INTEGRITY" });
      }
    }
    return { uploaded };
  }

  // ─── الإشعار ───
  async function notifyStage() {
    const ready = store.jobs().filter((j) => j.status === STATUS.UPLOADED && j.drive && j.drive.fileId && due(j));
    let notified = 0;
    for (const job of ready.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      let pdf;
      try {
        pdf = fs.readFileSync(store.pdfPath(job.jobId));
      } catch {
        failJob(job, "notify", { code: "PDF_MISSING" }, { immediate: true });
        continue;
      }
      try {
        const res = await edge.notify(job, pdf, job.drive.fileName || fileName(job));
        job.telegram = { messageId: res.messageId, duplicate: res.duplicate, sentAt: new Date(now()).toISOString() };
        job.status = STATUS.NOTIFIED;
        job.attempts = 0;
        job.nextAttemptAt = 0;
        job.lastError = null;
        store.saveJob(job);
        notified++;
        emit("notified", { jobId: job.jobId, number: job.number, version: job.version, duplicate: res.duplicate });
      } catch (err) {
        if (GLOBAL_EDGE.has(err && err.code)) {
          emit("notify_unavailable", { code: err.code, message: err.message });
          break;
        }
        failJob(job, "notify", err);
      }
    }
    return { notified };
  }

  // ─── التقرير إلى الموقع ───
  function reportItem(job) {
    return {
      job_id: job.jobId,
      doc_type: job.docType,
      source_guid: job.sourceGuid,
      doc_number: String(job.number),
      doc_date: job.date,
      customer_guid: job.customerGuid || null,
      customer_name: job.customerName || "",
      amount: job.amount,
      currency: job.currencyIso || "",
      version: job.version,
      version_hash: job.versionHash,
      status: job.status,
      failed: Boolean(job.failed),
      drive_file_id: job.drive ? job.drive.fileId : null,
      drive_web_link: job.drive ? job.drive.webViewLink : null,
      telegram_message_id: job.telegram ? job.telegram.messageId : null,
      attempts: job.attempts || 0,
      last_error: job.lastError || null,
    };
  }

  function applyRetry(jobIds, source) {
    let count = 0;
    for (const id of jobIds) {
      const job = store.get(id);
      if (!job || !job.failed) continue;
      job.failed = false;
      job.attempts = 0;
      job.nextAttemptAt = 0;
      store.saveJob(job);
      count++;
      emit("retry_requested", { jobId: id, source });
    }
    return count;
  }

  async function reportStage(host, version, force = false) {
    if (!edge) return null;
    if (!force && now() - lastReportAt < cfg.reportSeconds * 1000) return null;
    const since = state.lastReportedUpdate || "";
    const changed = store.jobs().filter((j) => (j.updatedAt || "") > since)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).slice(0, 200);
    const s = store.summary({ notifyEnabled: mode.notify });
    const payload = {
      host,
      worker_version: version,
      mode: cfg.mode,
      drive_state: driveState,
      drive_checked_at: driveCheckedAt,
      last_success_at: s.lastSuccessAt,
      pending_count: s.pending,
      failed_count: s.failed + Object.keys(state.detectErrors || {}).length,
      items: changed.map(reportItem),
    };
    try {
      const res = await edge.report(payload);
      lastReportAt = now();
      if (changed.length) state.lastReportedUpdate = changed[changed.length - 1].updatedAt;
      store.saveState();
      const retried = applyRetry(res.retryJobIds, "owner");
      return { items: changed.length, retried };
    } catch (err) {
      emit("report_error", { code: err && err.code, message: err && err.message });
      return null;
    }
  }

  async function cycle({ host = "", version = "dev" } = {}) {
    const out = { detect: null, upload: null, notify: null, report: null };
    try {
      out.detect = await detect();
    } catch (err) {
      emit("detect_failed", { code: err && err.code, message: err && err.message });
    }
    if (mode.upload) out.upload = await uploadStage();
    if (mode.notify && edge) out.notify = await notifyStage();
    out.report = await reportStage(host, version);
    out.driveState = driveState;
    return out;
  }

  return {
    detect,
    uploadStage,
    notifyStage,
    reportStage,
    cycle,
    applyRetry,
    get driveState() { return driveState; },
  };
}

module.exports = { createArchiver, DOC_TYPE, addSeconds, rowHint };
