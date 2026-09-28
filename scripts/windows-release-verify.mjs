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

// أحدث تشغيل لكل workflow مطلوب على الـSHA، ثم الفحوص المطلوبة على رأس الـPR.
export function evaluateCi({ runs, requiredMainWorkflows, pullRequest, prCheckRuns, requiredPrChecks }) {
  const results = {};
  for (const name of requiredMainWorkflows) {
    const latest = runs
      .filter((r) => r.name === name)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
    results[name] = latest ? `${latest.status}/${latest.conclusion}` : "missing";
  }
  results.pull_request = pullRequest ? `#${pullRequest.number}` : "missing";
  if (pullRequest) {
    for (const name of requiredPrChecks) {
      const matches = prCheckRuns.filter((c) => c.name === name);
      results[`pr:${name}`] = !matches.length
        ? "missing"
        : matches.some((c) => c.conclusion === "success") ? "completed/success" : `${matches[0].status}/${matches[0].conclusion}`;
    }
  }
  const failing = Object.keys(results).filter((k) => k !== "pull_request" && results[k] !== "completed/success");
  if (!pullRequest) failing.push("pull_request");
  return { ok: failing.length === 0, results, failing };
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

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, all) => (v.startsWith("--") ? [...acc, [v.slice(2), all[i + 1]]] : acc), []));
  const sha = String(args.sha || "").trim().toLowerCase();
  const writeApproved = String(args["write-approved"]) === "true";
  const out = args.out || "windows-release.json";
  const repo = process.env.GITHUB_REPOSITORY || "ozkkhallouf-ux/tobacco-web";
  const config = loadGateConfig();
  const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1); };

  if (!/^[0-9a-f]{40}$/.test(sha)) fail("sha must be a full 40-character commit SHA");
  if (!gitOk(["cat-file", "-e", `${sha}^{commit}`])) fail(`commit ${sha} not found`);
  if (!gitOk(["merge-base", "--is-ancestor", sha, `origin/${config.mainBranch}`])) fail("commit is not on main");
  if (!gitOk(["rev-parse", "--verify", `origin/${config.windowsBranch}`])) {
    fail(`origin/${config.windowsBranch} does not exist; the owner creates it once from the SHA currently deployed on OZK2026`);
  }
  const base = git(["rev-parse", `origin/${config.windowsBranch}`]);
  if (base === sha) fail("already released");
  if (!gitOk(["merge-base", "--is-ancestor", base, sha])) fail(`${sha} is not a fast-forward of ${config.windowsBranch} (${base})`);

  const change = classifyChanges(git(["diff", "--name-status", "--no-renames", base, sha]), config.writerScripts);
  if (change.writerScriptsChanged.length && !writeApproved) {
    fail(`writer scripts changed and write_scripts_approved is false: ${change.writerScriptsChanged.join(", ")}`);
  }
  const writerBlobs = {};
  for (const p of change.writerScriptsChanged) {
    const f = change.files.find((x) => x.path === p);
    writerBlobs[p] = f.status === "D" ? "deleted" : git(["rev-parse", `${sha}:${p}`]);
  }

  const runs = (await gh(repo, `actions/runs?head_sha=${sha}&per_page=100`)).workflow_runs || [];
  const pulls = await gh(repo, `commits/${sha}/pulls`);
  const pullRequest = pulls.find((p) => p.merge_commit_sha === sha && p.merged_at) || null;
  const prCheckRuns = pullRequest ? ((await gh(repo, `commits/${pullRequest.head.sha}/check-runs?per_page=100`)).check_runs || []) : [];
  const ci = evaluateCi({ runs, requiredMainWorkflows: config.requiredMainWorkflows, pullRequest, prCheckRuns, requiredPrChecks: config.requiredPrChecks });

  const summary = {
    kind: RELEASE_KIND, sha, base, windowsRef: config.windowsBranch, writeScriptsApproved: writeApproved, writerBlobs,
    changedFiles: change.files.map((f) => `${f.status} ${f.path}`), ps1Changed: change.ps1Changed, sqlChanged: change.sqlChanged,
    mjsChanged: change.mjsChanged, writerScriptsChanged: change.writerScriptsChanged, ci: ci.results
  };
  writeFileSync(out, JSON.stringify(summary, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
      `## إصدار Windows: \`${base.slice(0, 7)}\` → \`${sha.slice(0, 7)}\``,
      `- ملفات متغيّرة: ${change.files.length} — PS1: ${change.ps1Changed} — SQL: ${change.sqlChanged} — كتّاب: ${change.writerScriptsChanged.join(", ") || "لا"}`,
      ...Object.entries(ci.results).map(([k, v]) => `- CI ${k}: ${v}`),
      "", "```", ...summary.changedFiles, "```"
    ].join("\n") + "\n");
  }
  if (!ci.ok) fail(`CI not green on ${sha}: ${ci.failing.join(", ")}`);
  console.log(`OK: ${base.slice(0, 7)} -> ${sha.slice(0, 7)} (${change.files.length} files)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(`FAIL: ${err.message}`); process.exit(1); });
}
