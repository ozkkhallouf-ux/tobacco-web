"use strict";
// صندوق المهام الدائم على القرص — المصدر الموثوق لحالة الأرشفة.
//
//   <dataDir>/jobs/<jobId>.json   مهمة لكل نسخة مستند (كتابة ذرّية: ملف مؤقت + fsync + rename)
//   <dataDir>/pdf/<jobId>.pdf     الملف المولَّد؛ لا يُحذف بعد الرفع (نسخة محلية ثانية)
//   <dataDir>/state.json          علامة الرصد ووقت آخر مطابقة ومخبأ معرّفات المجلدات
//   <dataDir>/quarantine/         ملفات مهام تالفة تُعزل كما هي ولا تُحذف
//
// فهرس النسخ لكل مستند يُعاد بناؤه من ملفات المهام عند البدء، فضياع state.json لا يضيّع
// شيئاً: أسوأ الأحوال إعادة رصد نافذة أوسع، والبصمة تمنع أي مهمة مكررة.

const fs = require("fs");
const path = require("path");

const STATUS = Object.freeze({
  RENDERED: "rendered",     // PDF جاهز محلياً، بانتظار الرفع
  UPLOADED: "uploaded",     // على Drive (fileId مؤكد)، بانتظار تيليغرام
  NOTIFIED: "notified",     // اكتملت
});

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  // على Windows قد يفتح برنامج آخر (مضاد فيروسات/فهرسة) الأصل لحظياً.
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; } catch (err) {
      if (i >= 5 || !["EPERM", "EACCES", "EBUSY"].includes(err.code)) {
        try { fs.unlinkSync(tmp); } catch { /* تجاهل */ }
        throw err;
      }
      const until = Date.now() + 50 * (i + 1);
      while (Date.now() < until) { /* انتظار قصير متزامن */ }
    }
  }
}

function createStore(dataDir, now = () => Date.now()) {
  const jobsDir = path.join(dataDir, "jobs");
  const pdfDir = path.join(dataDir, "pdf");
  const quarantineDir = path.join(dataDir, "quarantine");
  const stateFile = path.join(dataDir, "state.json");
  for (const d of [jobsDir, pdfDir, quarantineDir]) fs.mkdirSync(d, { recursive: true });

  // بقايا كتابة مقطوعة.
  for (const name of fs.readdirSync(jobsDir)) if (name.includes(".tmp-")) fs.rmSync(path.join(jobsDir, name), { force: true });

  const jobs = new Map();
  for (const name of fs.readdirSync(jobsDir).filter((n) => /^[0-9a-f]{32}\.json$/.test(n))) {
    const file = path.join(jobsDir, name);
    try {
      const job = JSON.parse(fs.readFileSync(file, "utf8"));
      if (job.jobId !== name.slice(0, 32)) throw new Error("jobId mismatch");
      jobs.set(job.jobId, job);
    } catch {
      fs.renameSync(file, path.join(quarantineDir, `${name}.${now()}`));
    }
  }

  let state = { watermark: null, lastReconcileAt: 0, folders: {} };
  try {
    state = { ...state, ...JSON.parse(fs.readFileSync(stateFile, "utf8")) };
  } catch (err) {
    if (err.code !== "ENOENT") {
      try { fs.renameSync(stateFile, path.join(quarantineDir, `state.json.${now()}`)); } catch { /* تجاهل */ }
    }
  }

  function saveJob(job) {
    job.updatedAt = new Date(now()).toISOString();
    atomicWrite(path.join(jobsDir, `${job.jobId}.json`), JSON.stringify(job, null, 2));
    jobs.set(job.jobId, job);
    return job;
  }

  function saveState() {
    atomicWrite(stateFile, JSON.stringify(state, null, 2));
  }

  function versionsOf(docType, sourceGuid) {
    const g = String(sourceGuid).toLowerCase();
    return [...jobs.values()]
      .filter((j) => j.docType === docType && j.sourceGuid === g)
      .sort((a, b) => a.version - b.version);
  }

  // آخر نسخة هي المرجع لاكتشاف التعديل: بصمة مختلفة عنها ⇒ نسخة جديدة.
  function latestVersion(docType, sourceGuid) {
    const list = versionsOf(docType, sourceGuid);
    return list.length ? list[list.length - 1] : null;
  }

  function nextVersionNumber(docType, sourceGuid) {
    const list = versionsOf(docType, sourceGuid);
    return list.length ? list[list.length - 1].version + 1 : 1;
  }

  function pdfPath(jobId) {
    return path.join(pdfDir, `${jobId}.pdf`);
  }

  // «معلّق» = بانتظار رفع، أو بانتظار تيليغرام حين يكون الإشعار مفعّلاً (live).
  function summary({ notifyEnabled = false } = {}) {
    const all = [...jobs.values()];
    const waiting = (j) => j.status === STATUS.RENDERED || (notifyEnabled && j.status === STATUS.UPLOADED);
    return {
      total: all.length,
      pending: all.filter((j) => waiting(j) && !j.failed).length,
      failed: all.filter((j) => j.failed).length,
      notified: all.filter((j) => j.status === STATUS.NOTIFIED).length,
      lastSuccessAt: all.map((j) => j.archivedAt).filter(Boolean).sort().pop() || null,
    };
  }

  return {
    dataDir,
    get state() { return state; },
    jobs: () => [...jobs.values()],
    get: (id) => jobs.get(id) || null,
    has: (id) => jobs.has(id),
    saveJob,
    saveState,
    versionsOf,
    latestVersion,
    nextVersionNumber,
    pdfPath,
    summary,
  };
}

module.exports = { STATUS, createStore, atomicWrite };
