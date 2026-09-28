#!/usr/bin/env node
// ============================================================
// windows-release-verify.mjs — فحوص ما قبل موافقة إصدار Windows
//
// يشغّله .github/workflows/windows-release.yml قبل خطوة موافقة المالك، ويعيد
// بوابة Windows (tools/deploy-gate/deploy-gate.ps1) نفس الفحوص مستقلةً على الجهاز.
// لا يكتب شيئاً إلى GitHub؛ يقرأ git وواجهة GitHub فقط ويُخرج ملخصاً JSON.
//
// الفحوص:
//   - SHA كامل (40 hex) وموجود وعلى main.
//   - windows-production موجود، والـSHA تقدّم Fast-Forward منه (ليس هو نفسه).
//   - CI أخضر على نفس SHA الدمج: workflows ما بعد الدمج + الفحوص المطلوبة على
//     رأس الـPR الذي أنتج هذا الـcommit.
//   - تصنيف الملفات المتغيّرة، وتغيير سكربتات الكتابة يتطلب موافقة صريحة منفصلة.
// ============================================================
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const RELEASE_KIND = "ozk-windows-release";

export function loadGateConfig(file = path.join(root, "tools/deploy-gate/gate-config.example.json")) {
  return JSON.parse(readFileSync(file, "utf8"));
}

const normalize = (p) => String(p).replace(/\\/g, "/").replace(/^\/+/, "");

// سطور `git diff --name-status --no-renames` ⇒ ملفات مصنّفة.
export function classifyChanges(nameStatusText, writerScripts) {
  const writers = new Set(writerScripts.map(normalize));
  const files = String(nameStatusText)
    .split("\n")
    .map((line) => line.match(/^([A-Z])\s+(.+)$/))
    .filter(Boolean)
    .map((m) => ({ status: m[1], path: normalize(m[2].trim()) }));
  const paths = files.map((f) => f.path);
  return {
    files,
    ps1Changed: paths.some((p) => /\.psm?1$/i.test(p)),
    sqlChanged: paths.some((p) => /\.sql$/i.test(p)),
    mjsChanged: paths.some((p) => /\.(mjs|js)$/i.test(p)),
    writerScriptsChanged: paths.filter((p) => writers.has(p))
  };
}

// أحدث تشغيل بالاسم هو الحَكَم وحده (Codex P1): نجاح قديم لا يغطّي إعادة تشغيل أحدث
// فشلت أو أُلغيت أو انتهت مهلتها أو ما زالت جارية. الترتيب: وقت البدء/الإنشاء ثم المعرّف.
// وقت فارغ (queued/in_progress بلا started_at من GitHub) = أحدث، وإلا يفوز النجاح القديم.
export function newestByName(items, name, timeField) {
  return items
    .filter((x) => x.name === name)
    .sort((a, b) => {
      const ta = String(a[timeField] || "");
      const tb = String(b[timeField] || "");
      if (!ta && tb) return -1;
      if (ta && !tb) return 1;
      return tb.localeCompare(ta) || Number(b.id || 0) - Number(a.id || 0);
    })[0] || null;
}

const verdict = (run) => (run ? `${run.status}/${run.conclusion}` : "missing");

// أحدث تشغيل لكل workflow مطلوب على الـSHA، ثم أحدث تشغيل لكل فحص مطلوب على رأس الـPR.
export function evaluateCi({ runs, requiredMainWorkflows, pullRequest, prCheckRuns, requiredPrChecks }) {
  const results = {};
  for (const name of requiredMainWorkflows) results[name] = verdict(newestByName(runs, name, "created_at"));
  results.pull_request = pullRequest ? `#${pullRequest.number}` : "missing";
  if (pullRequest) {
    for (const name of requiredPrChecks) results[`pr:${name}`] = verdict(newestByName(prCheckRuns, name, "started_at"));
  }
  const failing = Object.keys(results).filter((k) => k !== "pull_request" && results[k] !== "completed/success");
  if (!pullRequest) failing.push("pull_request");
  return { ok: failing.length === 0, results, failing };
}

// كشف قدرة الكتابة إلى الأمين (دفاع إضافي، متحفّظ): ملف تنفيذي تحت tools/ أو scripts/
// (خارج الاختبارات) يحوي متغيّر اتصال الكتابة أو تعليمات تعديل SQL. ليس بديلاً عن فصل
// صلاحيات SQL: كل السكربتات اليوم تتصل بحساب يملك الكتابة.
export function inWriteScanScope(filePath, writeScan) {
  const p = normalize(filePath);
  if (!new RegExp(writeScan.include, "i").test(p)) return false;
  return !writeScan.exclude.some((rx) => new RegExp(rx, "i").test(p));
}

export function writeIndicators(content, writeScan) {
  return writeScan.patterns.filter((rx) => new RegExp(rx, "i").test(String(content)));
}

// العمليات الطويلة التي يمسّ الإصدار ملفاتها: تبقى تشغّل الكود القديم حتى إعادة تشغيل يدوية.
export function affectedLongRunning(changedPaths, components) {
  const changed = new Set(changedPaths.map(normalize));
  return components.filter((c) => c.files.some((f) => changed.has(normalize(f)))).map((c) => c.name);
}

// سياق قابل للحقن: git في مجلد محدد وواجهة GitHub (حقيقية أو وهمية في الاختبارات).
export function makeGitContext(cwd = root) {
  return {
    git: (args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(),
    gitOk: (args) => { try { execFileSync("git", args, { cwd, stdio: "ignore" }); return true; } catch { return false; } }
  };
}

export function makeGitHubApi(repo, token = process.env.GITHUB_TOKEN) {
  const call = async (method, rel, body) => {
    const res = await fetch(`https://api.github.com/repos/${repo}/${rel}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "ozk-windows-release",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { "content-type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (!res.ok) throw new Error(`GitHub API ${method} ${rel}: ${res.status}`);
    return res.json();
  };
  return { get: (rel) => call("GET", rel), post: (rel, body) => call("POST", rel, body) };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[i + 1];
  return {
    sha: String(args.sha || "").trim().toLowerCase(),
    writeApproved: String(args["write-approved"]) === "true",
    out: args.out || "windows-release.json"
  };
}

// سجلات الإصدار الناجحة (حمولة الإصدار نفسها + منشئ الـworkflow + آخر حالة success).
export async function recordedReleases(ctx, config, sha = "") {
  const query = `deployments?environment=${encodeURIComponent(config.deploymentEnvironment)}${sha ? `&sha=${sha}` : ""}&per_page=100`;
  const out = [];
  for (const dep of await ctx.api.get(query)) {
    const payload = typeof dep.payload === "string" && dep.payload ? JSON.parse(dep.payload) : dep.payload;
    if (!payload || payload.kind !== RELEASE_KIND || payload.sha !== dep.sha) continue;
    if (config.deploymentCreator && dep.creator?.login !== config.deploymentCreator) continue;
    const statuses = await ctx.api.get(`deployments/${dep.id}/statuses?per_page=5`);
    out.push({ id: dep.id, sha: dep.sha, created_at: dep.created_at, payload, succeeded: statuses[0]?.state === "success" });
  }
  return out;
}

// شروط git ثم الأساس (base). حالة الاستكمال (Codex P1 #4): الفرع يساوي الهدف بالضبط لأن
// الدفع نجح ثم فشل تسجيل الـDeployment — الأساس عندها آخر إصدار مسجَّل ناجح قبله، ولا دفع.
// أي حالة أخرى لا تساوي الأساس ولا الهدف = رفض.
export async function resolveReleaseBase(ctx, sha, config) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("sha must be a full 40-character commit SHA");
  if (!ctx.gitOk(["cat-file", "-e", `${sha}^{commit}`])) throw new Error(`commit ${sha} not found`);
  if (!ctx.gitOk(["merge-base", "--is-ancestor", sha, `origin/${config.mainBranch}`])) throw new Error("commit is not on main");
  if (!ctx.gitOk(["rev-parse", "--verify", `origin/${config.windowsBranch}`])) {
    throw new Error(`origin/${config.windowsBranch} does not exist; the owner creates it once from the SHA currently deployed on OZK2026`);
  }
  const current = ctx.git(["rev-parse", `origin/${config.windowsBranch}`]);
  if (current !== sha) {
    if (!ctx.gitOk(["merge-base", "--is-ancestor", current, sha])) throw new Error(`${sha} is not a fast-forward of ${config.windowsBranch} (${current})`);
    return { base: current, resume: false };
  }
  const releases = await recordedReleases(ctx, config);
  if (releases.some((r) => r.sha === sha && r.succeeded)) throw new Error("already released and recorded");
  const earlier = releases
    .filter((r) => r.succeeded && r.sha !== sha && ctx.gitOk(["merge-base", "--is-ancestor", r.sha, sha]))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
  if (!earlier) throw new Error(`${config.windowsBranch} already equals ${sha} but no earlier recorded release exists to derive the base; re-run the failed jobs of the original release run`);
  return { base: earlier.sha, resume: true };
}

function writerBlobsFor(ctx, change, sha) {
  const blobs = {};
  for (const p of change.writerScriptsChanged) {
    const f = change.files.find((x) => x.path === p);
    blobs[p] = f.status === "D" ? "deleted" : ctx.git(["rev-parse", `${sha}:${p}`]);
  }
  return blobs;
}

export async function fetchCi(ctx, sha, config) {
  const runs = (await ctx.api.get(`actions/runs?head_sha=${sha}&per_page=100`)).workflow_runs || [];
  const pulls = await ctx.api.get(`commits/${sha}/pulls`);
  const pullRequest = pulls.find((p) => p.merge_commit_sha === sha && p.merged_at) || null;
  const prCheckRuns = pullRequest ? ((await ctx.api.get(`commits/${pullRequest.head.sha}/check-runs?per_page=100`)).check_runs || []) : [];
  return evaluateCi({ runs, requiredMainWorkflows: config.requiredMainWorkflows, pullRequest, prCheckRuns, requiredPrChecks: config.requiredPrChecks });
}

// التحقق الكامل: يُستدعى من خطوة الفحص، ويُعاد حرفياً قبل التطبيق (لا ثقة بنتيجة قديمة).
export async function verifyRelease(ctx, { sha, writeApproved, config }) {
  const { base, resume } = await resolveReleaseBase(ctx, sha, config);
  const change = classifyChanges(ctx.git(["diff", "--name-status", "--no-renames", base, sha]), config.writerScripts);
  const detected = change.files
    .filter((f) => f.status !== "D" && inWriteScanScope(f.path, config.writeScan))
    .filter((f) => writeIndicators(ctx.git(["show", `${sha}:${f.path}`]), config.writeScan).length > 0)
    .map((f) => f.path);
  change.writerScriptsChanged = [...new Set([...change.writerScriptsChanged, ...detected])].sort();
  if (change.writerScriptsChanged.length && !writeApproved) {
    throw new Error(`writer scripts changed and write_scripts_approved is false: ${change.writerScriptsChanged.join(", ")}`);
  }
  const ci = await fetchCi(ctx, sha, config);
  const summary = {
    kind: RELEASE_KIND, sha, base, resume, windowsRef: config.windowsBranch, writeScriptsApproved: writeApproved, writerBlobs: writerBlobsFor(ctx, change, sha),
    changedFiles: change.files.map((f) => `${f.status} ${f.path}`), ps1Changed: change.ps1Changed, sqlChanged: change.sqlChanged,
    mjsChanged: change.mjsChanged, writerScriptsChanged: change.writerScriptsChanged, ci: ci.results,
    pendingRestart: affectedLongRunning(change.files.map((f) => f.path), config.longRunningComponents)
  };
  if (!ci.ok) { const err = new Error(`CI not green on ${sha}: ${ci.failing.join(", ")}`); err.summary = summary; throw err; }
  return summary;
}

function writeStepSummary(summary) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
    `## إصدار Windows: \`${summary.base.slice(0, 7)}\` → \`${summary.sha.slice(0, 7)}\`${summary.resume ? " (استكمال تسجيل: الفرع مُقدَّم أصلاً)" : ""}`,
    `- ملفات متغيّرة: ${summary.changedFiles.length} — PS1: ${summary.ps1Changed} — SQL: ${summary.sqlChanged} — قادرة على الكتابة: ${summary.writerScriptsChanged.join(", ") || "لا"}`,
    `- عمليات طويلة تحتاج إعادة تشغيل يدوية بعد النشر: ${summary.pendingRestart.join(", ") || "لا"}`,
    ...Object.entries(summary.ci).map(([k, v]) => `- CI ${k}: ${v}`),
    "", "```", ...summary.changedFiles, "```"
  ].join("\n") + "\n");
}

async function main() {
  const { sha, writeApproved, out } = parseArgs(process.argv.slice(2));
  const ctx = { ...makeGitContext(), api: makeGitHubApi(process.env.GITHUB_REPOSITORY || "ozkkhallouf-ux/tobacco-web") };
  try {
    const summary = await verifyRelease(ctx, { sha, writeApproved, config: loadGateConfig() });
    writeFileSync(out, JSON.stringify(summary, null, 2));
    writeStepSummary(summary);
    console.log(`OK: ${summary.base.slice(0, 7)} -> ${sha.slice(0, 7)} (${summary.changedFiles.length} files${summary.resume ? ", resume registration" : ""})`);
  } catch (err) {
    if (err.summary) { writeFileSync(out, JSON.stringify(err.summary, null, 2)); writeStepSummary(err.summary); }
    throw err;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(`FAIL: ${err.message}`); process.exit(1); });
}
