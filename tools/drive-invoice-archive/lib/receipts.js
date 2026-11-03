"use strict";
// رصد سندات القبض وتوليد PDF لها (المرحلة 2) — نفس نمط رصد الفواتير في archiver.js، بحالة
// مستقلة (state.receipts) ونطاق مستقل. ما بعد التوليد (الرفع ثم الإشعار ثم التقرير) هو مراحل
// archiver.js نفسها: المهمة مهمة عادية بنوع «receipt».
//
// قرار المالك 2026-11-03: كل زبون في كل سند قبض مستند مستقل (receipt-model.js)، وأي مبلغين
// للزبون نفسه داخل السند نفسه في ورقة واحدة. لا تجميع لسندات مختلفة أبداً.
//
// الأمين قراءة فقط عبر الحارس. لا حذف ولا استبدال: تعديل سند مؤرشف ⇒ V2 بجانب V1.
// سند حُذف أو أُزيل منه زبون بعد أرشفته: لا يُمسّ ما أُرشف ولا يُرسل شيء (يُذكر في السجل).

const fs = require("fs");
const { jobIdFor, sha256 } = require("./fingerprint");
const { STATUS } = require("./store");
const { groupReceipts, receiptVersionHash, receiptHint, isGuid, DOC_TYPE, RECEIPT_HASH_SCHEMA } = require("./receipt-model");

const PAGE = 500; // سندات لكل صفحة (receipts-query.sql)
const MAX_PAGES = 40;

function addSeconds(iso, seconds) {
  const t = Date.parse(`${String(iso).replace(/Z$/, "")}Z`);
  return new Date(t + seconds * 1000).toISOString().replace(/Z$/, "");
}

function createReceiptArchiver({ cfg, store, ameen, renderer, template, paper, emit, now = () => Date.now() }) {
  const rc = cfg.receipts || {};
  const archiveFrom = rc.archiveFrom || cfg.archiveFrom;
  const lower = (g) => String(g || "").toLowerCase();
  const pilot = new Set((rc.pilotGuids || []).map(lower));
  const baseline = new Set((rc.baselineGuids || []).map(lower));
  const createdFrom = rc.newReceiptsFrom || null;
  // النطاق بمعرّف السند في الأمين (لا بمعرّف المستند المشتق): الحصر واللقطة يخصّان السند كله.
  const inScope = (receiptGuid) => (pilot.size === 0 || pilot.has(lower(receiptGuid))) && !baseline.has(lower(receiptGuid));
  const createdBeforeCutoff = (createdAt) => Boolean(createdFrom) &&
    !(Date.parse(`${String(createdAt || "").replace(/Z$/, "")}Z`) >= Date.parse(`${createdFrom}Z`));

  const st = () => {
    const s = store.state;
    s.receipts = s.receipts || {};
    const r = s.receipts;
    r.hints = r.hints || {};
    r.detectErrors = r.detectErrors || {};
    return r;
  };

  async function renderReceipt(doc, outPath) {
    const html = template.buildReceiptHtml(doc);
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
  }

  function newJob(doc, version, versionHash, latest, pdf) {
    return {
      jobId: jobIdFor(DOC_TYPE, doc.guid, versionHash, version),
      docType: DOC_TYPE,
      sourceGuid: doc.guid,
      receiptGuid: doc.receiptGuid,
      accountGuid: doc.accountGuid,
      number: doc.number,
      date: doc.date,
      customerGuid: doc.customerGuid,
      customerName: doc.customer,
      amount: doc.amount,
      currencyIso: doc.currencyIso,
      version,
      versionHash,
      hashSchema: `receipt-${RECEIPT_HASH_SCHEMA}`,
      changeKind: version > 1 ? "edited" : "new",
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

  // سند مستقر واحد: مستند لكل زبون. نسخة جديدة فقط حين تختلف البصمة عن آخر نسخة.
  async function archiveReceipt(rec) {
    let created = 0;
    for (const doc of rec.docs) {
      const versionHash = receiptVersionHash(doc);
      const latest = store.latestVersion(DOC_TYPE, doc.guid);
      if (latest && latest.versionHash === versionHash) continue;
      if (doc.entryGuid && ameen.receiptBalance) doc.balance = await ameen.receiptBalance(doc.entryGuid, doc.accountGuid);
      const version = store.nextVersionNumber(DOC_TYPE, doc.guid);
      const pdfFile = store.pdfPath(jobIdFor(DOC_TYPE, doc.guid, versionHash, version));
      await renderReceipt(doc, pdfFile);
      const job = newJob(doc, version, versionHash, latest, fs.readFileSync(pdfFile));
      store.saveJob(job);
      created++;
      emit(version > 1 ? "receipt_edited" : "receipt_detected", { jobId: job.jobId, number: doc.number, version });
    }
    return created;
  }

  function recordDetectError(rec, hint, prev, err) {
    const s = st();
    const attempts = (prev && prev.hint === hint ? prev.attempts : 0) + 1;
    s.detectErrors[rec.receiptGuid] = {
      hint,
      number: rec.header.number,
      attempts,
      code: String(err && err.code || "ERROR").slice(0, 30),
      at: new Date(now()).toISOString(),
      nextAt: now() + Math.min(3600, 60 * 2 ** Math.min(attempts, 6)) * 1000,
    };
    emit("receipt_detect_error", { guid: rec.receiptGuid, number: rec.header.number, code: err && err.code, message: err && err.message });
  }

  // سند واحد: «unstable» أو «skip» أو «created» أو «same» أو «error».
  async function detectReceipt(rec, rows) {
    const s = st();
    const h = rec.header;
    if (!inScope(rec.receiptGuid)) return "skip";
    if (createdBeforeCutoff(h.createdAt)) return "skip";
    if (h.entryLinks !== 1 || !h.entryGuid) { emit("receipt_entry_unresolved", { guid: rec.receiptGuid, number: h.number, links: h.entryLinks }); return "skip"; }
    if (!h.isPosted) return "skip"; // غير مرحّل ليس نسخة نهائية؛ يُرى ثانيةً عند ترحيله (يتغيّر التلميح)
    if (h.secondsSinceChange < cfg.stableSeconds) return "unstable";
    const hint = receiptHint(rows);
    if (s.hints[rec.receiptGuid] === hint) return "skip";
    const prev = s.detectErrors[rec.receiptGuid];
    if (prev && prev.hint === hint && now() < prev.nextAt) return "skip";
    try {
      const created = await archiveReceipt(rec);
      s.hints[rec.receiptGuid] = hint;
      delete s.detectErrors[rec.receiptGuid];
      return created ? "created" : "same";
    } catch (err) {
      recordDetectError(rec, hint, prev, err);
      return "error";
    }
  }

  async function fetchChanged(window) {
    const all = [];
    let cursor = { since: window.since, sinceGuid: window.sinceGuid || "" };
    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = await ameen.changedReceipts({ ...cursor, dateFrom: window.dateFrom, createdFrom });
      all.push(...rows);
      const vouchers = new Set(rows.map((r) => lower(r.receipt_guid)));
      if (vouchers.size < PAGE) return { rows: all, complete: true, cursor: null };
      const last = rows[rows.length - 1];
      cursor = { since: last.changed_at, sinceGuid: lower(last.receipt_guid) };
    }
    return { rows: all, complete: false, cursor };
  }

  function detectWindow(serverNow, reconcile) {
    const s = st();
    if (s.resume) return { ...s.resume };
    if (!reconcile) {
      return { since: s.watermark ? addSeconds(s.watermark, -cfg.overlapSeconds) : `${archiveFrom}T00:00:00`, dateFrom: archiveFrom };
    }
    const lookback = addSeconds(serverNow, -cfg.lookbackDays * 86400).slice(0, 10);
    return { since: "1900-01-01T00:00:00", dateFrom: lookback > archiveFrom ? lookback : archiveFrom, reconcile: true };
  }

  async function retryDetectErrors() {
    const s = st();
    const due = Object.keys(s.detectErrors)
      .filter((g) => isGuid(g) && inScope(g) && now() >= (Number(s.detectErrors[g].nextAt) || 0))
      .slice(0, 50);
    for (const guid of due) {
      const rows = await ameen.changedReceipts({ since: "1900-01-01T00:00:00", sinceGuid: "", dateFrom: archiveFrom, onlyGuid: guid, createdFrom });
      const [rec] = groupReceipts(rows);
      const outcome = rec ? await detectReceipt(rec, rows) : "gone";
      if (outcome !== "error") delete s.detectErrors[guid];
    }
  }

  async function detect() {
    const s = st();
    const serverNow = await ameen.serverNow();
    const resumed = Boolean(s.resume);
    const window = detectWindow(serverNow, Boolean(s.watermark) && now() - (s.lastReconcileAt || 0) >= cfg.reconcileMinutes * 60_000);
    const reconcile = Boolean(window.reconcile);
    const { rows, complete, cursor } = await fetchChanged(window);
    const rowsBy = new Map();
    for (const r of rows) {
      const g = lower(r.receipt_guid);
      if (!rowsBy.has(g)) rowsBy.set(g, []);
      rowsBy.get(g).push(r);
    }
    let holdBack = null;
    let created = 0;
    for (const rec of groupReceipts(rows)) {
      const outcome = await detectReceipt(rec, rowsBy.get(rec.receiptGuid));
      if (outcome === "created") created++;
      if (outcome === "unstable" && (!holdBack || rec.header.changedAt < holdBack)) holdBack = rec.header.changedAt;
    }
    if (window.holdBack && (!holdBack || window.holdBack < holdBack)) holdBack = window.holdBack;
    await retryDetectErrors();
    if (!complete) {
      s.resume = { ...window, since: cursor.since, sinceGuid: cursor.sinceGuid, holdBack };
      store.saveState();
      return { rows: rows.length, created, reconcile, complete, resumed };
    }
    s.resume = null;
    let mark = serverNow;
    if (holdBack && holdBack < mark) mark = holdBack;
    if (!reconcile) s.watermark = mark;
    else {
      s.lastReconcileAt = now();
      if (!s.watermark || mark < s.watermark) s.watermark = mark;
    }
    store.saveState();
    return { rows: rows.length, created, reconcile, complete, resumed };
  }

  return { detect, inScope, get pilotSize() { return pilot.size; } };
}

module.exports = { createReceiptArchiver };
