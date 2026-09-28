// ============================================================================
// check-windows-release-resume.mjs — تسجيل إصدار Windows قابل للاستكمال (Codex P1 #4)
//
// إذا نجح دفع windows-production إلى الهدف ثم فشل أو أُلغي إنشاء GitHub Deployment، فإعادة
// التشغيل يجب أن تكمل التسجيل فقط (بلا دفع جديد) بعد إعادة التحقق كاملاً، وأي موضع آخر
// للفرع يُرفض. الاختبار يبني origin عارياً ونسخة عمل بـgit حقيقي، وواجهة GitHub وهمية
// تحقن الأعطال، ويشغّل verifyRelease/applyRelease الإنتاجيتين نفسيهما.
// ============================================================================
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadGateConfig, makeGitContext, verifyRelease, RELEASE_KIND } from "./windows-release-verify.mjs";
import { applyRelease, planPush } from "./windows-release-apply.mjs";

let passed = 0;
const ok = (msg) => { passed += 1; console.log(`  ✓ ${msg}`); };
const config = { ...loadGateConfig(), requiredMainWorkflows: ["Deploy TOBACCO Web"], requiredPrChecks: ["check"] };

const base = mkdtempSync(path.join(tmpdir(), "ozk-release-"));
const sh = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const origin = path.join(base, "origin.git");
const seed = path.join(base, "seed");
const wf = path.join(base, "wf");
sh(base, "init", "-q", "--bare", origin);
sh(base, "clone", "-q", origin, seed);
sh(seed, "checkout", "-q", "-b", "main");
const commit = (file, content) => { writeFileSync(path.join(seed, file), content); sh(seed, "add", "-A"); sh(seed, "commit", "-q", "-m", file); return sh(seed, "rev-parse", "HEAD"); };
const c0 = commit("a.txt", "0\n");
sh(seed, "push", "-q", "origin", "main", `${c0}:refs/heads/windows-production`);
const c1 = commit("b.txt", "1\n");
sh(seed, "push", "-q", "origin", "main");
sh(base, "clone", "-q", origin, wf);
const git = makeGitContext(wf);
const refresh = () => git.git(["fetch", "-q", "--no-tags", "origin", "+refs/heads/*:refs/remotes/origin/*"]);
refresh();

// واجهة GitHub وهمية: deployments وstatuses وCI، مع حقن أعطال.
function fakeApi() {
  const state = { deployments: [], statuses: {}, nextId: 100, failCreate: 0, failStatus: 0, red: new Set(), posts: [] };
  const api = {
    state,
    async get(rel) {
      let m;
      if ((m = rel.match(/^deployments\?environment=[^&]+(?:&sha=([0-9a-f]{40}))?/))) return state.deployments.filter((d) => !m[1] || d.sha === m[1]);
      if ((m = rel.match(/^deployments\/(\d+)\/statuses/))) return [...(state.statuses[m[1]] || [])].reverse();
      if ((m = rel.match(/^actions\/runs\?head_sha=([0-9a-f]{40})/))) return { workflow_runs: [{ id: 1, name: "Deploy TOBACCO Web", status: "completed", conclusion: state.red.has(m[1]) ? "failure" : "success", created_at: "2026-09-28T00:00:00Z" }] };
      if ((m = rel.match(/^commits\/([0-9a-f]{40})\/pulls/))) return [{ number: 1, merge_commit_sha: m[1], merged_at: "2026-09-28T00:00:00Z", head: { sha: `h${m[1]}` } }];
      if (/^commits\/h[0-9a-f]{40}\/check-runs/.test(rel)) return { check_runs: [{ id: 1, name: "check", status: "completed", conclusion: "success", started_at: "2026-09-28T00:00:00Z" }] };
      throw new Error(`unexpected GET ${rel}`);
    },
    async post(rel, body) {
      state.posts.push(rel);
      if (rel === "deployments") {
        if (state.failCreate > 0) { state.failCreate -= 1; throw new Error("GitHub API POST deployments: 502"); }
        const d = { id: state.nextId++, sha: body.ref, created_at: new Date(Date.now() + state.nextId).toISOString(), creator: { login: "github-actions[bot]" }, payload: body.payload };
        state.deployments.push(d);
        return { id: d.id };
      }
      const m = rel.match(/^deployments\/(\d+)\/statuses/);
      if (m) {
        if (state.failStatus > 0) { state.failStatus -= 1; throw new Error("GitHub API POST statuses: 502"); }
        (state.statuses[m[1]] ||= []).push({ state: body.state });
        return { state: body.state };
      }
      throw new Error(`unexpected POST ${rel}`);
    }
  };
  return api;
}

function makeCtx(api) {
  const ctx = {
    ...git, api, pushes: 0,
    push: (sha) => { ctx.pushes += 1; git.git(["push", "-q", "origin", `${sha}:refs/heads/${config.windowsBranch}`]); },
    remoteBranchSha: () => { refresh(); return git.git(["rev-parse", `origin/${config.windowsBranch}`]); }
  };
  return ctx;
}
const moveBranch = (sha) => { sh(seed, "push", "-q", "--force", "origin", `${sha}:refs/heads/windows-production`); refresh(); };
const remote = () => { refresh(); return git.git(["rev-parse", "origin/windows-production"]); };
const recordRelease = (api, sha) => { const id = api.state.nextId++; api.state.deployments.push({ id, sha, created_at: `2026-09-2${api.state.deployments.length}T00:00:00Z`, creator: { login: "github-actions[bot]" }, payload: { kind: RELEASE_KIND, sha } }); api.state.statuses[id] = [{ state: "success" }]; };

try {
  // planPush وحده
  const anc = (a, b) => git.gitOk(["merge-base", "--is-ancestor", a, b]);
  assert.equal(planPush({ current: c0, base: c0, sha: c1, isAncestor: anc }), "push");
  assert.equal(planPush({ current: c1, base: c0, sha: c1, isAncestor: anc }), "resume");
  assert.throws(() => planPush({ current: c1, base: c0, sha: c0, isAncestor: anc }), /neither/);
  ok("planPush: الأساس ⇒ دفع، الهدف نفسه ⇒ استكمال بلا دفع، غيرهما ⇒ رفض");

  // 1) الدفع ينجح وواجهة Deployment تفشل
  const api = fakeApi();
  recordRelease(api, c0);
  const ctx = makeCtx(api);
  const v = await verifyRelease(ctx, { sha: c1, writeApproved: false, config });
  assert.equal(v.base, c0);
  assert.equal(v.resume, false);
  api.state.failCreate = 1;
  await assert.rejects(applyRelease(ctx, { verification: v, inputSha: c1, approver: "owner", runId: "1", config }), /POST deployments/);
  assert.equal(remote(), c1, "الفرع تقدّم إلى الهدف");
  assert.equal(api.state.deployments.filter((d) => d.sha === c1).length, 0, "لا سجل إصدار");
  assert.equal(ctx.pushes, 1);
  ok("1) الدفع نجح ثم فشل إنشاء Deployment ⇒ الفرع على الهدف بلا سجل");

  // 2) إعادة تشغيل الوظيفة الفاشلة (نفس ملف التحقق): لا دفع، يكمل التسجيل
  const r2 = await applyRelease(ctx, { verification: v, inputSha: c1, approver: "owner", runId: "1", config });
  assert.deepEqual([r2.plan, r2.registration], ["resume", "created"]);
  assert.equal(ctx.pushes, 1, "لا دفع جديد");
  const rec = api.state.deployments.find((d) => d.sha === c1);
  assert.equal(rec.payload.kind, RELEASE_KIND);
  assert.equal(rec.payload.sha, c1);
  assert.equal(rec.payload.base, c0);
  const r2b = await applyRelease(ctx, { verification: v, inputSha: c1, approver: "owner", runId: "1", config });
  assert.equal(r2b.registration, "already-recorded", "تكرار ثالث لا ينشئ سجلاً ثانياً");
  assert.equal(api.state.deployments.filter((d) => d.sha === c1).length, 1);
  ok("2) إعادة التشغيل والفرع = الهدف ⇒ تتخطى الدفع وتكمل التسجيل، والتكرار لا يضاعف السجل");

  // 2ب) إعادة تشغيل كاملة: الفحص يستنتج الأساس من آخر إصدار مسجَّل قبله
  const api2 = fakeApi();
  recordRelease(api2, c0);
  const ctx2 = makeCtx(api2);
  const v2 = await verifyRelease(ctx2, { sha: c1, writeApproved: false, config });
  assert.deepEqual([v2.base, v2.resume], [c0, true]);
  const r2c = await applyRelease(ctx2, { verification: v2, inputSha: c1, approver: "owner", runId: "2", config });
  assert.deepEqual([r2c.plan, r2c.registration], ["resume", "created"]);
  assert.equal(ctx2.pushes, 0);
  await assert.rejects(verifyRelease(ctx2, { sha: c1, writeApproved: false, config }), /already released and recorded/);
  await assert.rejects(verifyRelease(makeCtx(fakeApi()), { sha: c1, writeApproved: false, config }), /no earlier recorded release/);
  ok("2ب) إعادة تشغيل كاملة ⇒ الأساس = آخر إصدار مسجَّل، بلا دفع؛ ولا أساس موثوق ⇒ رفض");

  // 2ج) السجل أُنشئ لكن حالته فشلت ⇒ الاستكمال يضيف الحالة فقط
  const api3 = fakeApi();
  recordRelease(api3, c0);
  const ctx3 = makeCtx(api3);
  moveBranch(c0);
  const v3 = await verifyRelease(ctx3, { sha: c1, writeApproved: false, config });
  api3.state.failStatus = 1;
  await assert.rejects(applyRelease(ctx3, { verification: v3, inputSha: c1, approver: "owner", runId: "3", config }), /statuses/);
  const r3 = await applyRelease(ctx3, { verification: v3, inputSha: c1, approver: "owner", runId: "3", config });
  assert.deepEqual([r3.plan, r3.registration], ["resume", "status-completed"]);
  assert.equal(api3.state.deployments.filter((d) => d.sha === c1).length, 1);
  ok("2ج) سجل بلا حالة نجاح ⇒ يُكمَل بحالة success دون سجل ثانٍ");

  // 3) الفرع على SHA أحدث أو غير مرتبط ⇒ رفض
  const c2 = commit("c.txt", "2\n");
  sh(seed, "push", "-q", "origin", "main");
  refresh();
  const api4 = fakeApi();
  recordRelease(api4, c0);
  const ctx4 = makeCtx(api4);
  moveBranch(c0);
  const v4 = await verifyRelease(ctx4, { sha: c1, writeApproved: false, config });
  moveBranch(c2);
  await assert.rejects(applyRelease(ctx4, { verification: v4, inputSha: c1, approver: "owner", runId: "4", config }), /neither the verified base/);
  sh(seed, "checkout", "-q", "--orphan", "rogue");
  const rogue = commit("r.txt", "r\n");
  sh(seed, "checkout", "-q", "main");
  moveBranch(rogue);
  await assert.rejects(applyRelease(ctx4, { verification: v4, inputSha: c1, approver: "owner", runId: "4", config }), /neither the verified base/);
  await assert.rejects(verifyRelease(ctx4, { sha: c1, writeApproved: false, config }), /not a fast-forward/);
  assert.equal(ctx4.pushes, 0);
  assert.equal(api4.state.deployments.filter((d) => d.sha === c1).length, 0);
  ok("3) الفرع على SHA أحدث أو غير مرتبط ⇒ رفض بلا دفع ولا تسجيل");

  // 4) الفرع متأخر عن الأساس / هدف غير صالح / ليس Fast-Forward ⇒ رفض
  moveBranch(c1);
  const vBehind = { ...v4, base: c1, sha: c2 };
  moveBranch(c0);
  await assert.rejects(applyRelease(ctx4, { verification: vBehind, inputSha: c2, approver: "owner", runId: "5", config }), /neither the verified base/);
  await assert.rejects(applyRelease(ctx4, { verification: v4, inputSha: "abc", approver: "owner", runId: "5", config }), /does not match/);
  await assert.rejects(applyRelease(ctx4, { verification: { ...v4, sha: rogue }, inputSha: rogue, approver: "owner", runId: "5", config }), /not on main/);
  assert.throws(() => planPush({ current: c0, base: c0, sha: rogue, isAncestor: anc }), /not a fast-forward/);
  await assert.rejects(verifyRelease(ctx4, { sha: "0123456789012345678901234567890123456789", writeApproved: false, config }), /not found/);
  assert.equal(ctx4.pushes, 0);
  ok("4) فرع متأخر، SHA غير صالح، هدف خارج main أو ليس Fast-Forward ⇒ رفض");

  // 5) الإعادة تعيد التحقق: CI أحمر الآن، موافقة كتابة ناقصة ⇒ رفض قبل أي دفع أو تسجيل
  const api5 = fakeApi();
  recordRelease(api5, c0);
  const ctx5 = makeCtx(api5);
  moveBranch(c0);
  const v5 = await verifyRelease(ctx5, { sha: c1, writeApproved: false, config });
  api5.state.red.add(c1);
  await assert.rejects(applyRelease(ctx5, { verification: v5, inputSha: c1, approver: "owner", runId: "6", config }), /CI not green/);
  api5.state.red.delete(c1);
  await assert.rejects(applyRelease(ctx5, { verification: { ...v5, writerScriptsChanged: ["tools/x.ps1"], writeScriptsApproved: false }, inputSha: c1, approver: "owner", runId: "6", config }), /write approval/);
  assert.equal(ctx5.pushes, 0);
  assert.equal(remote(), c0);
  assert.equal(api5.state.posts.length, 0);
  moveBranch(c1);
  api5.state.red.add(c1);
  await assert.rejects(applyRelease(ctx5, { verification: v5, inputSha: c1, approver: "owner", runId: "6", config }), /CI not green/);
  assert.equal(api5.state.posts.length, 0, "الاستكمال أيضاً يعيد التحقق من CI قبل التسجيل");
  ok("5) الدفع والاستكمال يعيدان التحقق من الـSHA وmain وCI وموافقة الكتابة قبل أي أثر");
} finally {
  rmSync(base, { recursive: true, force: true });
}

console.log(`check-windows-release-resume: اجتاز ${passed} عقود.`);
