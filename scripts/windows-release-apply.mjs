#!/usr/bin/env node
// ============================================================
// windows-release-apply.mjs — تقديم windows-production وتسجيل الإصدار (بعد موافقة البيئة)
//
// قابل للاستكمال بأمان (Codex P1 #4): إذا نجح الدفع ثم فشل أو أُلغي تسجيل الـDeployment،
// فإعادة التشغيل (الوظيفة الفاشلة أو التشغيل كاملاً) تجد الفرع يساوي الهدف بالضبط فتتخطى
// الدفع وتكمل التسجيل فقط — بعد إعادة التحقق كاملاً من الـSHA وmain وCI وموافقة الكتابة.
// الفرع في أي حالة أخرى غير «الأساس المتحقَّق» أو «الهدف نفسه» = رفض. لا --force، لا reset.
// ============================================================
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_KIND, fetchCi, loadGateConfig, makeGitContext, makeGitHubApi, recordedReleases } from "./windows-release-verify.mjs";

// قرار الدفع وحده، بلا آثار جانبية.
export function planPush({ current, base, sha, isAncestor }) {
  if (current === sha) return "resume";
  if (current === base) {
    if (!isAncestor(base, sha)) throw new Error(`${sha} is not a fast-forward of the verified base ${base}`);
    return "push";
  }
  throw new Error(`windows-production is at ${current}: neither the verified base ${base} nor the target ${sha}`);
}

export async function applyRelease(ctx, { verification: v, inputSha, approver, runId, config }) {
  const sha = String(inputSha || "").trim().toLowerCase();
  if (v.kind !== RELEASE_KIND || v.sha !== sha || !/^[0-9a-f]{40}$/.test(sha)) throw new Error("verification does not match the requested SHA");
  // إعادة التحقق: الـSHA موجود وعلى main، CI أخضر الآن، وموافقة الكتابة متسقة.
  if (!ctx.gitOk(["cat-file", "-e", `${sha}^{commit}`])) throw new Error(`commit ${sha} not found`);
  if (!ctx.gitOk(["merge-base", "--is-ancestor", sha, `origin/${config.mainBranch}`])) throw new Error("commit is not on main");
  if (v.writerScriptsChanged.length && !v.writeScriptsApproved) throw new Error("writer scripts changed without write approval");
  const ci = await fetchCi(ctx, sha, config);
  if (!ci.ok) throw new Error(`CI not green on ${sha}: ${ci.failing.join(", ")}`);

  const current = ctx.git(["rev-parse", `origin/${config.windowsBranch}`]);
  const plan = planPush({ current, base: v.base, sha, isAncestor: (a, b) => ctx.gitOk(["merge-base", "--is-ancestor", a, b]) });
  if (plan === "push") {
    ctx.push(sha);
    if (ctx.remoteBranchSha() !== sha) throw new Error("windows-production did not advance to the target after push");
  }

  // تسجيل متكرر-الأمان: سجل ناجح موجود = انتهى؛ سجل بلا حالة نجاح = إكمال حالته؛ لا شيء = إنشاء.
  const existing = (await recordedReleases(ctx, config, sha)).filter((r) => r.sha === sha);
  if (existing.some((r) => r.succeeded)) return { plan, registration: "already-recorded", sha };
  let id = existing[0]?.id;
  let registration = "status-completed";
  if (!id) {
    const created = await ctx.api.post("deployments", {
      ref: sha, environment: config.deploymentEnvironment, auto_merge: false, required_contexts: [], production_environment: true,
      description: `OZK Windows release ${sha.slice(0, 7)}`,
      payload: {
        kind: RELEASE_KIND, sha, base: v.base, windowsRef: v.windowsRef, approver, runId: String(runId || ""),
        writeScriptsApproved: v.writeScriptsApproved, writerBlobs: v.writerBlobs, changedFiles: v.changedFiles.length,
        ps1Changed: v.ps1Changed, sqlChanged: v.sqlChanged, pendingRestart: v.pendingRestart
      }
    });
    id = created.id;
    registration = "created";
  }
  await ctx.api.post(`deployments/${id}/statuses`, { state: "success", description: "approved and fast-forwarded" });
  return { plan, registration, sha, id };
}

async function main() {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[i + 1];
  const config = loadGateConfig();
  const git = makeGitContext();
  git.git(["fetch", "--no-tags", "origin", config.mainBranch, config.windowsBranch]);
  const ctx = {
    ...git,
    api: makeGitHubApi(process.env.GITHUB_REPOSITORY || "ozkkhallouf-ux/tobacco-web"),
    // بلا --force: GitHub يرفض أي دفع ليس Fast-Forward.
    push: (sha) => git.git(["push", "origin", `${sha}:refs/heads/${config.windowsBranch}`]),
    remoteBranchSha: () => { git.git(["fetch", "--no-tags", "origin", config.windowsBranch]); return git.git(["rev-parse", `origin/${config.windowsBranch}`]); }
  };
  const verification = JSON.parse(readFileSync(args.verification || "windows-release.json", "utf8"));
  const result = await applyRelease(ctx, { verification, inputSha: args.sha, approver: process.env.APPROVER, runId: process.env.RUN_ID, config });
  console.log(`OK: ${result.plan} / ${result.registration} ${result.sha.slice(0, 7)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(`FAIL: ${err.message}`); process.exit(1); });
}
