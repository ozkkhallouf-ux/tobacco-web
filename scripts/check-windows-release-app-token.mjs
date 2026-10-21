// ============================================================================
// check-windows-release-app-token.mjs — أمان هوية إصدار Windows (GitHub App «OZK Windows Release»)
//
// يثبت بلا شبكة ولا أسرار حقيقية (مفتاح RSA مؤقت يُولَّد هنا):
//   1. عدم كشف الأسرار: الأسرار في خطوة واحدة من job الإصدار، لا طباعة ولا مخرجات ولا URL،
//      وإخفاء التوكن ورسالة git الخاطئة بلا ترويسة.
//   2. منع التشغيل دون موافقة: يدوي فقط، من main فقط، وjob الإصدار خلف بيئة windows-production.
//   3. عدم النشر إلى فرع خاطئ: الهدف windows-production حصراً في الإعداد والوسائط والتطبيق.
//   4. منع تجاوز حماية الفرع: لا force ولا «+»، والتوكن contents/workflows فقط بلا administration،
//      ولا استدعاء لواجهات rulesets/protection.
//   5. رفض إصدار أقدم من الحد المعتمد: لا توكن ولا دفع قبل كل إعادة تحقق.
//   6. عدم تعديل ملفات خارج نطاق الإصدار: لا add/commit/checkout/reset، ودفع الـSHA المتحقَّق وحده.
// ============================================================================
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAppJwt, mintReleaseToken, pushArgs, pushWithReleaseApp, releaseAppConfig, assertTokenScope, RELEASE_BRANCH } from "./windows-release-app-token.mjs";
import { applyRelease, runGitScrubbed } from "./windows-release-apply.mjs";
import { loadGateConfig, RELEASE_KIND } from "./windows-release-verify.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
let passed = 0;
const ok = (msg) => { passed += 1; console.log(`  ✓ ${msg}`); };

const config = loadGateConfig();
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" });
const APP_ID = String(config.releaseApp.appId);
const INSTALLATION_ID = config.releaseApp.installationId;
const TOKEN = "ghs_TESTTOKENvalue1234567890";
const env = { RELEASE_APP_ID: APP_ID, RELEASE_APP_PRIVATE_KEY: PEM };

// --- 0) الإعداد ---------------------------------------------------------------
assert.deepEqual(config.releaseApp, { appId: 5412959, installationId: 173807509, permissions: { contents: "write", workflows: "write" } });
assert.equal(config.windowsBranch, RELEASE_BRANCH);
assert.throws(() => releaseAppConfig({ ...config, windowsBranch: "main" }), /windowsBranch must be windows-production/);
assert.throws(() => releaseAppConfig({ ...config, releaseApp: { ...config.releaseApp, permissions: { contents: "write", workflows: "write", administration: "write" } } }), /exactly contents:write and workflows:write/);
ok("الإعداد: التطبيق 5412959/التثبيت 173807509، الصلاحيتان contents/workflows حرفياً، والهدف windows-production");

// --- 1) JWT --------------------------------------------------------------------
const now = 1_800_000_000;
const jwt = createAppJwt(APP_ID, PEM, now);
const [h, p, sig] = jwt.split(".");
const dec = (s) => JSON.parse(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
assert.equal(dec(h).alg, "RS256");
assert.equal(dec(p).iss, APP_ID);
assert.ok(dec(p).exp - dec(p).iat <= 600 && dec(p).exp > now, "عمر JWT ≤ 10 دقائق");
const verifier = createVerify("RSA-SHA256");
verifier.update(`${h}.${p}`);
assert.ok(verifier.verify(publicKey, Buffer.from(sig.replace(/-/g, "+").replace(/_/g, "/"), "base64")));
assert.throws(() => createAppJwt("abc", PEM), /numeric/);
assert.throws(() => createAppJwt(APP_ID, ""), /not a PEM private key/);
ok("JWT للتطبيق: RS256 موقّع بالمفتاح، iss = App ID، والعمر أقل من 10 دقائق؛ مدخلات تالفة مرفوضة");

// --- 2) توكن التثبيت المقيّد ------------------------------------------------------
function fakeAppApi({ installation = { id: INSTALLATION_ID, app_id: Number(APP_ID) }, response } = {}) {
  const calls = [];
  const api = async (method, rel, bearer, body) => {
    calls.push({ method, rel, bearer, body });
    if (method === "GET" && rel === `repos/${config.githubRepo}/installation`) return installation;
    if (method === "POST" && rel === `app/installations/${INSTALLATION_ID}/access_tokens`) {
      return response || { token: TOKEN, expires_at: "2026-10-21T17:00:00Z", repository_selection: "selected", repositories: [{ name: "tobacco-web" }], permissions: { contents: "write", workflows: "write", metadata: "read" } };
    }
    throw new Error(`unexpected ${method} ${rel}`);
  };
  return { api, calls };
}
{
  const masked = [];
  const { api, calls } = fakeAppApi();
  const t = await mintReleaseToken({ appApi: api, env, config, mask: (v) => masked.push(v) });
  assert.equal(t.token, TOKEN);
  const post = calls.find((c) => c.method === "POST");
  assert.deepEqual(post.body, { repositories: ["tobacco-web"], permissions: { contents: "write", workflows: "write" } });
  assert.ok(masked.includes(TOKEN) && masked.some((m) => m.split(".").length === 3), "التوكن والـJWT مُخفيان من السجلات");
  ok("التوكن يُطلب لمستودع tobacco-web وحده وبصلاحيتي contents/workflows فقط، ويُخفى هو والـJWT");
}
{
  const { api, calls } = fakeAppApi();
  await assert.rejects(mintReleaseToken({ appApi: api, env: { ...env, RELEASE_APP_ID: "999" }, config, mask: () => {} }), /does not match the approved release app/);
  assert.equal(calls.length, 0, "لا استدعاء لـGitHub بمعرّف تطبيق آخر");
  const other = fakeAppApi({ installation: { id: 1, app_id: Number(APP_ID) } });
  await assert.rejects(mintReleaseToken({ appApi: other.api, env, config, mask: () => {} }), /approved installation/);
  assert.ok(!other.calls.some((c) => c.method === "POST"), "لا توكن من تثبيت غير معتمد");
  const scope = { repo: "tobacco-web", permissions: { contents: "write", workflows: "write" } };
  const good = { token: "x", expires_at: "y", repository_selection: "selected", repositories: [{ name: "tobacco-web" }], permissions: { contents: "write", workflows: "write", metadata: "read" } };
  assert.doesNotThrow(() => assertTokenScope(good, scope));
  for (const [label, bad] of [
    ["كل المستودعات", { ...good, repository_selection: "all" }],
    ["مستودع إضافي", { ...good, repositories: [{ name: "tobacco-web" }, { name: "other" }] }],
    ["administration", { ...good, permissions: { ...good.permissions, administration: "write" } }],
    ["metadata كتابة", { ...good, permissions: { ...good.permissions, metadata: "write" } }],
    ["contents قراءة فقط", { ...good, permissions: { contents: "read", workflows: "write", metadata: "read" } }]
  ]) assert.throws(() => assertTokenScope(bad, scope), undefined, `يُرفض: ${label}`);
  const wide = fakeAppApi({ response: { ...good, token: TOKEN, permissions: { ...good.permissions, administration: "write" } } });
  await assert.rejects(mintReleaseToken({ appApi: wide.api, env, config, mask: () => {} }), /permissions differ/);
  ok("معرّف تطبيق أو تثبيت مختلف، أو توكن أوسع (مستودعات/administration/metadata) ⇒ رفض قبل أي استخدام");
}

// --- 3) الدفع: الفرع والـrefspec والاعتماد -------------------------------------------
{
  const sha = "a".repeat(40);
  const { args, secrets } = pushArgs({ sha, branch: RELEASE_BRANCH, repoSlug: config.githubRepo, token: TOKEN });
  assert.equal(args.at(-1), `${sha}:refs/heads/windows-production`);
  assert.equal(args.at(-2), `https://github.com/${config.githubRepo}.git`);
  assert.ok(!args.at(-2).includes(TOKEN) && !args.some((a) => a.includes(TOKEN)), "التوكن ليس في أي وسيط نصاً");
  assert.ok(args.includes("credential.helper=") && !args.includes("--force") && !args.some((a) => a.startsWith("+")));
  assert.ok(args.some((a) => a.includes(secrets[0])), "الترويسة المرمّزة هي ما يُخفى");
  for (const bad of [{ branch: "main" }, { branch: "refs/heads/windows-production" }, { sha: `+${sha.slice(1)}` }, { sha: "abc" }, { token: "" }, { repoSlug: "a/b c" }]) {
    assert.throws(() => pushArgs({ sha, branch: RELEASE_BRANCH, repoSlug: config.githubRepo, token: TOKEN, ...bad }));
  }
  ok("الدفع: refspec ‹SHA›:refs/heads/windows-production حصراً، بلا force ولا «+»، والتوكن في ترويسة لا في URL");
}
{
  const masked = [];
  const revoked = [];
  let ran = null;
  const { api } = fakeAppApi();
  await pushWithReleaseApp({ sha: "b".repeat(40), config, env, appApi: api, runGit: (a) => { ran = a; }, revoke: async (t) => revoked.push(t), mask: (v) => masked.push(v) });
  assert.ok(ran && revoked[0] === TOKEN && masked.length >= 3);
  const revoked2 = [];
  await assert.rejects(pushWithReleaseApp({ sha: "b".repeat(40), config, env, appApi: fakeAppApi().api, runGit: () => { throw new Error("push rejected"); }, revoke: async (t) => revoked2.push(t), mask: () => {} }), /push rejected/);
  assert.deepEqual(revoked2, [TOKEN], "التوكن يُبطَل حتى لو فشل الدفع");
  ok("التوكن يُبطَل بعد الدفع دائماً، نجح أو فشل");
}
{
  let msg = "";
  const secret = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");
  try { runGitScrubbed(["-c", `http.https://github.com/.extraheader=AUTHORIZATION: basic ${secret}`, "push", "--no-verify", path.join(root, "does-not-exist.git"), "HEAD:refs/heads/x"]); } catch (err) { msg = err.message; }
  assert.ok(msg.startsWith("git push to windows-production failed"), msg);
  assert.ok(!msg.includes(secret) && !msg.includes(TOKEN) && !/AUTHORIZATION|extraheader/i.test(msg), "رسالة الخطأ بلا اعتماد");
  ok("فشل git push لا يسرّب الترويسة ولا التوكن في رسالة الخطأ");
}

// --- 4) لا توكن ولا دفع قبل كل إعادة تحقق --------------------------------------------
{
  const sha = "c".repeat(40);
  const base = "d".repeat(40);
  const baseline = "e".repeat(40);
  const v = { kind: RELEASE_KIND, sha, base, writerScriptsChanged: [], writeScriptsApproved: false, windowsRef: RELEASE_BRANCH, writerBlobs: {}, changedFiles: [], ps1Changed: false, sqlChanged: false, pendingRestart: [] };
  const runs = (conclusion) => ({ workflow_runs: [{ id: 1, name: "Deploy TOBACCO Web", status: "completed", conclusion, created_at: "2026-10-21T00:00:00Z" }] });
  const makeCtx = ({ red = false, olderThanDevice = false } = {}) => {
    const ctx = {
      pushes: 0,
      gitOk: (args) => !(olderThanDevice && args[0] === "merge-base" && args[2] === baseline),
      git: (args) => (args[0] === "rev-parse" ? base : ""),
      push: async () => { ctx.pushes += 1; },
      remoteBranchSha: () => sha,
      api: {
        get: async (rel) => {
          if (rel.startsWith("actions/runs")) return runs(red ? "failure" : "success");
          if (rel.includes("/pulls")) return [{ number: 1, merge_commit_sha: sha, merged_at: "x", head: { sha: "h" } }];
          if (rel.includes("check-runs")) return { check_runs: [{ id: 1, name: "check", status: "completed", conclusion: "success", started_at: "x" }] };
          if (rel.startsWith("deployments")) return [];
          throw new Error(`unexpected ${rel}`);
        },
        post: async (rel) => (rel === "deployments" ? { id: 7 } : {})
      }
    };
    return ctx;
  };
  const cfg = { ...config, requiredMainWorkflows: ["Deploy TOBACCO Web"], requiredPrChecks: ["check"], deviceBaselineSha: baseline };
  const okCtx = makeCtx();
  await applyRelease(okCtx, { verification: v, inputSha: sha, approver: "owner", runId: "1", config: cfg });
  assert.equal(okCtx.pushes, 1);
  for (const [label, ctx, extra, rx] of [
    ["CI أحمر", makeCtx({ red: true }), {}, /CI not green/],
    ["أقدم من الحد المعتمد", makeCtx({ olderThanDevice: true }), {}, /older than what OZK2026 runs/],
    ["فرع هدف خاطئ في الإعداد", makeCtx(), { config: { ...cfg, windowsBranch: "main" } }, /release target must be windows-production/],
    ["SHA لا يطابق التحقق", makeCtx(), { inputSha: "f".repeat(40) }, /does not match/],
    ["كتابة بلا موافقة", makeCtx(), { verification: { ...v, writerScriptsChanged: ["tools/x.ps1"] } }, /write approval/]
  ]) {
    await assert.rejects(applyRelease(ctx, { verification: v, inputSha: sha, approver: "owner", runId: "1", config: cfg, ...extra }), rx, label);
    assert.equal(ctx.pushes, 0, `${label} ⇒ لا دفع (ولا توكن، فالتوكن يُنشأ داخل push)`);
  }
  ok("CI أحمر، أو إصدار أقدم من الحد المعتمد، أو فرع خاطئ، أو SHA مختلف، أو كاتب بلا موافقة ⇒ لا توكن ولا دفع");
}

// --- 5) الـworkflow: يدوي، من main، خلف الموافقة، والأسرار في خطوة واحدة ----------------------
const wfRaw = read(".github/workflows/windows-release.yml");
const wf = wfRaw.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
const onBlock = wf.slice(wf.indexOf("\non:"), wf.indexOf("\npermissions:"));
assert.match(onBlock, /workflow_dispatch:/);
assert.doesNotMatch(onBlock, /\bpush:|pull_request|schedule:|workflow_run|repository_dispatch|workflow_call/, "لا تشغيل تلقائي، ولا بسبب PR أو دمج");
const verifyJob = wf.slice(wf.indexOf("\n  verify:"), wf.indexOf("\n  release:"));
const releaseJob = wf.slice(wf.indexOf("\n  release:"));
for (const job of [verifyJob, releaseJob]) assert.match(job, /\n    if: github\.ref == 'refs\/heads\/main'\n/, "كل job من main وحده");
assert.match(releaseJob, /\n    needs: verify\n/);
assert.match(releaseJob, /\n    environment: windows-production\n/);
const checkouts = wf.split("\n      - ").filter((step) => /uses: actions\/checkout@/.test(step));
assert.equal(checkouts.length, 2);
for (const c of checkouts) assert.match(c, /persist-credentials: false/, "لا اعتماد GITHUB_TOKEN محفوظ في git");
assert.doesNotMatch(wf, /contents: write|administration:|id-token:/, "GITHUB_TOKEN بلا كتابة محتوى ولا إدارة");
const secretRefs = wf.match(/\$\{\{\s*secrets\.[A-Z_]+\s*\}\}/g) || [];
assert.deepEqual(secretRefs.map((s) => s.replace(/\s/g, "")), ["${{secrets.RELEASE_APP_ID}}", "${{secrets.RELEASE_APP_PRIVATE_KEY}}"]);
assert.ok(!verifyJob.includes("secrets."), "لا أسرار في job الفحص");
const steps = releaseJob.split("\n      - name: ");
const withSecrets = steps.filter((s) => s.includes("secrets."));
assert.equal(withSecrets.length, 1);
assert.match(withSecrets[0], /^Fast-forward windows-production and record the release/);
assert.match(withSecrets[0], /run: node scripts\/windows-release-apply\.mjs --verification windows-release\.json --sha "\$INPUT_SHA"\s*$/);
assert.doesNotMatch(wf, /set -x|echo[^\n]*(secrets|TOKEN|PRIVATE)|GITHUB_OUTPUT|GITHUB_ENV|::set-output|add-mask/, "لا طباعة أسرار ولا تمريرها لمخرجات أو بيئة لاحقة");
assert.doesNotMatch(releaseJob, /npm (ci|install)|npx |pip install/, "لا كود طرف ثالث في job يحمل الأسرار");
const uses = [...wf.matchAll(/uses: ([^\s@]+)@/g)].map((m) => m[1]);
assert.deepEqual([...new Set(uses)].sort(), ["actions/checkout", "actions/download-artifact", "actions/setup-node", "actions/upload-artifact"], "Actions رسمية فقط");
assert.doesNotMatch(wf, /run:[^\n]*\$\{\{\s*inputs\./, "المدخلات عبر env لا داخل run");
ok("الـworkflow: يدوي فقط ومن main، job الإصدار بعد الفحص وخلف بيئة windows-production، checkout بلا اعتماد محفوظ، والأسرار في خطوة واحدة بلا طباعة");

// --- 6) لا تجاوز للحماية ولا تعديل خارج نطاق الإصدار ---------------------------------------
const applySrc = read("scripts/windows-release-apply.mjs").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
const tokenSrc = read("scripts/windows-release-app-token.mjs").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
for (const src of [applySrc, tokenSrc]) {
  assert.doesNotMatch(src, /"--force"|"-f"|--force-with-lease|rulesets|\/protection|bypass/i, "لا force ولا واجهات حماية الفروع");
  assert.doesNotMatch(src, /"(add|commit|checkout|reset|rm|clean|stash|rebase|merge|tag)"/, "لا تعديل للشجرة ولا التاريخ: دفع الـSHA المتحقَّق وحده");
  assert.doesNotMatch(src, /writeFileSync|appendFileSync|GITHUB_OUTPUT|GITHUB_ENV/, "التوكن لا يُكتب إلى ملف ولا يُمرَّر لخطوة أخرى");
}
assert.match(applySrc, /await ctx\.push\(sha\)/, "الدفع للـSHA المتحقَّق نفسه");
const order = ["assertNotOlderThanDevice(ctx, sha, config)", "fetchCi(ctx, sha, config)", "plan = planPush(", "await ctx.push(sha)"].map((t) => applySrc.indexOf(t));
assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), "إعادة التحقق كاملة قبل الدفع (والتوكن داخل الدفع)");
assert.match(applySrc, /DELETE", "installation\/token"/, "إبطال التوكن بعد الدفع");
ok("لا force ولا «+» ولا واجهات حماية، لا add/commit/checkout/reset ولا كتابة ملفات، وإعادة التحقق تسبق التوكن والدفع، والتوكن يُبطَل");

console.log(`check-windows-release-app-token: اجتاز ${passed} عقود.`);
