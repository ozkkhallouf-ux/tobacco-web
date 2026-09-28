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
export function newestByName(items, name, timeField) {
  return items
    .filter((x) => x.name === name)
    .sort((a, b) => String(b[timeField] || "").localeCompare(String(a[timeField] || "")) || Number(b.id || 0) - Number(a.id || 0))[0] || null;
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

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function gitOk(args) {
  try { execFileSync("git", args, { cwd: root, stdio: "ignore" }); return true; } catch { return false; }
}

async function gh(repo, rel) {
  const res = await fetch(`https://api.github.com/repos/${repo}/${rel}`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "ozk-windows-release",
      ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {})
    }
  });
  if (!res.ok) throw new Error(`GitHub API ${rel}: ${res.status}`);
  return res.json();
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

// شروط git: SHA كامل وموجود وعلى main، والفرع موجود، والتقدّم Fast-Forward. يُرجع base.
function verifyGitPreconditions(sha, config) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("sha must be a full 40-character commit SHA");
  if (!gitOk(["cat-file", "-e", `${sha}^{commit}`])) throw new Error(`commit ${sha} not found`);
  if (!gitOk(["merge-base", "--is-ancestor", sha, `origin/${config.mainBranch}`])) throw new Error("commit is not on main");
  if (!gitOk(["rev-parse", "--verify", `origin/${config.windowsBranch}`])) {
    throw new Error(`origin/${config.windowsBranch} does not exist; the owner creates it once from the SHA currently deployed on OZK2026`);
  }
  const base = git(["rev-parse", `origin/${config.windowsBranch}`]);
  if (base === sha) throw new Error("already released");
  if (!gitOk(["merge-base", "--is-ancestor", base, sha])) throw new Error(`${sha} is not a fast-forward of ${config.windowsBranch} (${base})`);
  return base;
}

function writerBlobsFor(change, sha) {
  const blobs = {};
  for (const p of change.writerScriptsChanged) {
    const f = change.files.find((x) => x.path === p);
    blobs[p] = f.status === "D" ? "deleted" : git(["rev-parse", `${sha}:${p}`]);
  }
  return blobs;
}

async function fetchCi(repo, sha, config) {
  const runs = (await gh(repo, `actions/runs?head_sha=${sha}&per_page=100`)).workflow_runs || [];
  const pulls = await gh(repo, `commits/${sha}/pulls`);
  const pullRequest = pulls.find((p) => p.merge_commit_sha === sha && p.merged_at) || null;
  const prCheckRuns = pullRequest ? ((await gh(repo, `commits/${pullRequest.head.sha}/check-runs?per_page=100`)).check_runs || []) : [];
  return evaluateCi({ runs, requiredMainWorkflows: config.requiredMainWorkflows, pullRequest, prCheckRuns, requiredPrChecks: config.requiredPrChecks });
}

function writeStepSummary(summary) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
    `## إصدار Windows: \`${summary.base.slice(0, 7)}\` → \`${summary.sha.slice(0, 7)}\``,
    `- ملفات متغيّرة: ${summary.changedFiles.length} — PS1: ${summary.ps1Changed} — SQL: ${summary.sqlChanged} — قادرة على الكتابة: ${summary.writerScriptsChanged.join(", ") || "لا"}`,
    `- عمليات طويلة تحتاج إعادة تشغيل يدوية بعد النشر: ${summary.pendingRestart.join(", ") || "لا"}`,
    ...Object.entries(summary.ci).map(([k, v]) => `- CI ${k}: ${v}`),
    "", "```", ...summary.changedFiles, "```"
  ].join("\n") + "\n");
}

async function main() {
  const { sha, writeApproved, out } = parseArgs(process.argv.slice(2));
  const repo = process.env.GITHUB_REPOSITORY || "ozkkhallouf-ux/tobacco-web";
  const config = loadGateConfig();
  const base = verifyGitPreconditions(sha, config);

  const change = classifyChanges(git(["diff", "--name-status", "--no-renames", base, sha]), config.writerScripts);
  const detected = change.files
    .filter((f) => f.status !== "D" && inWriteScanScope(f.path, config.writeScan))
    .filter((f) => writeIndicators(git(["show", `${sha}:${f.path}`]), config.writeScan).length > 0)
    .map((f) => f.path);
  change.writerScriptsChanged = [...new Set([...change.writerScriptsChanged, ...detected])].sort();
  if (change.writerScriptsChanged.length && !writeApproved) {
    throw new Error(`writer scripts changed and write_scripts_approved is false: ${change.writerScriptsChanged.join(", ")}`);
  }
  const ci = await fetchCi(repo, sha, config);
  const summary = {
    kind: RELEASE_KIND, sha, base, windowsRef: config.windowsBranch, writeScriptsApproved: writeApproved, writerBlobs: writerBlobsFor(change, sha),
    changedFiles: change.files.map((f) => `${f.status} ${f.path}`), ps1Changed: change.ps1Changed, sqlChanged: change.sqlChanged,
    mjsChanged: change.mjsChanged, writerScriptsChanged: change.writerScriptsChanged, ci: ci.results,
    pendingRestart: affectedLongRunning(change.files.map((f) => f.path), config.longRunningComponents)
  };
  writeFileSync(out, JSON.stringify(summary, null, 2));
  writeStepSummary(summary);
  if (!ci.ok) throw new Error(`CI not green on ${sha}: ${ci.failing.join(", ")}`);
  console.log(`OK: ${base.slice(0, 7)} -> ${sha.slice(0, 7)} (${change.files.length} files)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(`FAIL: ${err.message}`); process.exit(1); });
}
