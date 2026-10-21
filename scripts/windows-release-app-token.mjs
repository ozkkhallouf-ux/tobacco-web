// ============================================================
// windows-release-app-token.mjs — هوية الإصدار المخصّصة (GitHub App «OZK Windows Release»)
//
// يُستدعى من windows-release-apply.mjs وحده، داخل job الإصدار المحمي ببيئة windows-production
// (موافقة المالك، والفرع main فقط)، وبعد إعادة التحقق كاملاً، ولحظة الدفع فقط:
//   1. JWT قصير (≤ 9 دقائق) من RELEASE_APP_ID وRELEASE_APP_PRIVATE_KEY (أسرار البيئة وحدها).
//   2. التحقق أن التطبيق مثبّت على هذا المستودع بالتثبيت المعتمد في الإعداد (releaseApp).
//   3. توكن تثبيت مقيّد صراحةً بمستودع واحد وبالصلاحيتين contents:write وworkflows:write،
//      ورفضه إن أعاد GitHub أي مستودع أو صلاحية أخرى.
//   4. إخفاؤه من السجلات (::add-mask::) ودفع Fast-Forward واحد إلى windows-production،
//      ثم إبطاله فوراً (DELETE /installation/token) ولو فشل الدفع.
// لا يكتب التوكن إلى ملف ولا متغيّر بيئة ولا مخرجات خطوة، ولا يمرّره في عنوان URL.
// ============================================================
import { createSign } from "node:crypto";

export const RELEASE_BRANCH = "windows-production";

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

// JWT للتطبيق (RS256). iat متأخر 60 ثانية لتفاوت الساعة، والعمر الكلي أقل من حدّ GitHub (10 دقائق).
export function createAppJwt(appId, privateKeyPem, nowSeconds = Math.floor(Date.now() / 1000)) {
  const id = String(appId || "").trim();
  if (!/^\d+$/.test(id)) throw new Error("RELEASE_APP_ID must be numeric");
  if (!/-----BEGIN (RSA )?PRIVATE KEY-----/.test(String(privateKeyPem || ""))) throw new Error("RELEASE_APP_PRIVATE_KEY is missing or not a PEM private key");
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 9 * 60, iss: id }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${b64url(signer.sign(privateKeyPem))}`;
}

// إعداد هوية الإصدار من gate-config، مع رفض أي قيمة غير متوقعة.
export function releaseAppConfig(config) {
  const app = config.releaseApp || {};
  const [owner, repo] = String(config.githubRepo || "").split("/");
  const expected = { contents: "write", workflows: "write" };
  if (!/^\d+$/.test(String(app.appId)) || !/^\d+$/.test(String(app.installationId))) throw new Error("gate config: releaseApp.appId and releaseApp.installationId are required");
  if (JSON.stringify(app.permissions) !== JSON.stringify(expected)) throw new Error("gate config: releaseApp.permissions must be exactly contents:write and workflows:write");
  if (!owner || !repo) throw new Error("gate config: githubRepo must be owner/name");
  if (config.windowsBranch !== RELEASE_BRANCH) throw new Error(`gate config: windowsBranch must be ${RELEASE_BRANCH}`);
  return { appId: String(app.appId), installationId: String(app.installationId), owner, repo, permissions: expected };
}

// يتحقق من الاستجابة نفسها: مستودع واحد هو المستهدف، والصلاحيات هي المطلوبة حرفياً (مع metadata
// الإلزامية للقراءة فقط). أي شيء أوسع = رفض قبل أي استخدام للتوكن.
export function assertTokenScope(response, { repo, permissions }) {
  const repos = (response.repositories || []).map((r) => r.name);
  if (response.repository_selection !== "selected" || repos.length !== 1 || repos[0] !== repo) {
    throw new Error(`installation token is not limited to ${repo}`);
  }
  const granted = { ...(response.permissions || {}) };
  if (granted.metadata && granted.metadata !== "read") throw new Error("installation token grants metadata beyond read");
  delete granted.metadata;
  if (JSON.stringify(Object.keys(granted).sort().map((k) => [k, granted[k]])) !== JSON.stringify(Object.keys(permissions).sort().map((k) => [k, permissions[k]]))) {
    throw new Error(`installation token permissions differ from contents:write+workflows:write: ${JSON.stringify(response.permissions)}`);
  }
  if (!response.token || !response.expires_at) throw new Error("installation token response incomplete");
}

// يُنشئ توكن التثبيت المقيّد. appApi: طلبات بتوثيق JWT؛ تُحقن في الاختبارات.
export async function mintReleaseToken({ appApi, env, config, mask = (v) => console.log(`::add-mask::${v}`) }) {
  const app = releaseAppConfig(config);
  if (String(env.RELEASE_APP_ID || "").trim() !== app.appId) throw new Error("RELEASE_APP_ID does not match the approved release app");
  const jwt = createAppJwt(env.RELEASE_APP_ID, env.RELEASE_APP_PRIVATE_KEY);
  mask(jwt);
  const installation = await appApi("GET", `repos/${app.owner}/${app.repo}/installation`, jwt);
  if (String(installation.id) !== app.installationId || String(installation.app_id) !== app.appId) {
    throw new Error("the release app is not installed on this repository with the approved installation");
  }
  const response = await appApi("POST", `app/installations/${app.installationId}/access_tokens`, jwt, { repositories: [app.repo], permissions: app.permissions });
  if (response.token) mask(response.token);
  assertTokenScope(response, app);
  return { token: response.token, expiresAt: response.expires_at };
}

// وسائط git للدفع: Fast-Forward واحد لـSHA كامل إلى windows-production حصراً، والتوكن في ترويسة
// (لا في عنوان URL)، وبلا أي مساعد اعتماد محفوظ. أي فرع آخر أو refspec بـ«+» = رفض.
export function pushArgs({ sha, branch, repoSlug, token }) {
  if (!/^[0-9a-f]{40}$/.test(String(sha))) throw new Error("release push requires a full 40-character SHA");
  if (branch !== RELEASE_BRANCH) throw new Error(`release push target must be ${RELEASE_BRANCH}`);
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(repoSlug))) throw new Error("invalid repository slug");
  if (!token) throw new Error("release push requires the app installation token");
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    secrets: [basic],
    args: ["-c", "credential.helper=", "-c", `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`,
      "push", "--no-verify", `https://github.com/${repoSlug}.git`, `${sha}:refs/heads/${RELEASE_BRANCH}`]
  };
}

// توكن → دفع → إبطال (دائماً). runGit وappApi وrevoke تُحقن في الاختبارات.
export async function pushWithReleaseApp({ sha, config, env, appApi, runGit, revoke, mask = (v) => console.log(`::add-mask::${v}`) }) {
  const { token } = await mintReleaseToken({ appApi, env, config, mask });
  try {
    const { args, secrets } = pushArgs({ sha, branch: config.windowsBranch, repoSlug: config.githubRepo, token });
    for (const s of secrets) mask(s);
    runGit(args);
  } finally {
    try { await revoke(token); } catch (err) { console.error(`WARN: revoking the release token failed: ${err.message}`); }
  }
}

// واجهة GitHub الحقيقية: JWT للتطبيق، أو توكن التثبيت لإبطاله. لا تطبع أي ترويسة.
export function makeAppApi(fetchImpl = fetch) {
  return async (method, rel, bearer, body) => {
    const res = await fetchImpl(`https://api.github.com/${rel}`, {
      method,
      headers: { accept: "application/vnd.github+json", "user-agent": "ozk-windows-release", authorization: `Bearer ${bearer}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    if (!res.ok) throw new Error(`GitHub App API ${method} ${rel}: ${res.status}`);
    return res.status === 204 ? {} : res.json();
  };
}
