// خادم الموقع المحلي.
//
// ⚠️ إصلاح أمني 2026-08-31 (ملاحظة Codex P1 على PR #148):
// النسخة السابقة كانت تحوّل أي مسار URL مباشرةً إلى ملف تحت **جذر المستودع**،
// وتكتفي بمنع الخروج عنه. أي أن `/.git/config` و`/tools/.env` و`/reports/...`
// كانت تُخدَم فعلياً. الربط على الاسترجاع وحده لا يحمي: صفحة تتحكم بنطاقها
// تستطيع توجيهه إلى 127.0.0.1 (DNS rebinding) وقراءتها من المتصفح.
// وقد صار الخادم يعمل دائماً على الماك عبر LaunchAgent، فاتّسع الأثر.
//
// التصميم الآن دفاعي بطبقتين، أساسه **allowlist** لا denylist:
//   1) جذور عامة محدودة (`src/`, `public/`) + قائمة صريحة بملفات الجذر العامة.
//      كل ما عداه — `.git`, `.env`, `tools/`, `reports/`, `logs`, `node_modules`,
//      `supabase/`, `scripts/`, ملفات `.md` الداخلية — خارج النطاق بحكم البنية،
//      لا بحكم قائمة منع قد تُنسى.
//   2) امتدادات مسموحة فقط، وفحص نهائي أن المسار المُحلّ داخل جذر عام فعلاً.
// وفوقهما حارس ترويسة `Host` ضد إعادة ربط DNS.

import { createServer } from "node:http";
import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = normalize(join(dirname(fileURLToPath(import.meta.url)), ".."));
const portArgIndex = process.argv.indexOf("--port");
const requestedPort = portArgIndex >= 0
  ? Number(process.argv[portArgIndex + 1])
  : Number(process.env.PORT) || 5173;
// الافتراضي 0.0.0.0 كما كان — ويندوز يخدم الآيفون وأجهزة الشبكة من هذا السيرفر
// ولا يتغيّر سلوكه. مرافق الماك يضبط HOST=127.0.0.1 فيحصره على الاسترجاع.
const requestedHost = process.env.HOST || "0.0.0.0";

// ===== الطبقة الأولى: جذور عامة محدودة =====

// المجلدات الوحيدة التي يجوز خدمة محتواها. كل ما تحتاجه الواجهة يقع فيها.
const PUBLIC_DIRS = ["src", "public"];

// ملفات الجذر العامة — قائمة صريحة، لا `*.html` عامة: ملفات مثل CLAUDE.md
// وAI_HANDOFF.md وpackage.json تقع في الجذر ولا يجوز خدمتها.
const PUBLIC_ROOT_FILES = new Set([
  "index.html",
  "404.html",
  "privacy-policy.html",
  "terms-of-use.html",
  "receipt.html",
  "service-worker.js",
  "robots.txt",
  "sitemap.xml"
]);

// أنواع أصول الويب وحدها. لا `.md` ولا `.ps1` ولا `.sql` ولا بلا امتداد.
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};

/**
 * يحلّ مسار الطلب إلى ملف مسموح، أو null.
 * يرجع null لكل ما هو خارج الجذور العامة — لا يسقط إلى index.html أبداً،
 * فسقوط كهذا كان يُخفي الرفض ويجعل الفحص الأمني غير قابل للملاحظة.
 */
/**
 * يجزّئ مسار URL إلى مقاطع بدلالة **URL خالصة** — بلا أي دالة من `node:path`.
 *
 * ⚠️ إصلاح 2026-08-31 (ملاحظة Codex P1 الثانية على PR #148):
 * النسخة السابقة استعملت `path.normalize(decoded)` ثم `split("/")`. على ويندوز
 * يعيد `normalize("/src/app.js")` القيمة `\src\app.js`، فيصير المسار كله مقطعاً
 * واحداً ويُرفض كملف جذر غير مسموح — أي **كل طلب داخل `src/` و`public/` يعود 404
 * عند `npm run dev` على ويندوز**، فتسقط الواجهة على ويندوز وعلى الآيفون الذي
 * يستعمل خادمها على الشبكة. مسارات URL ليست مسارات نظام ملفات: نطبّعها بفاصل
 * `/` ثابت هنا، ولا نلمس `node:path` إلا عند بناء المسار الفعلي بـ`resolve`.
 *
 * @returns {string[]|null} المقاطع، أو null لأي مسار مرفوض.
 */
export function urlPathSegments(urlPath) {
  let decoded;
  try {
    // فك ترميز مزدوج المرحلة: `%252e%252e` تفكّ إلى `%2e%2e` ثم `..`.
    decoded = decodeURIComponent(String(urlPath || "/").split("?")[0].split("#")[0]);
    if (/%[0-9a-f]{2}/i.test(decoded)) decoded = decodeURIComponent(decoded);
  } catch {
    return null; // ترميز تالف — يُرفض لا يُخمَّن
  }
  if (decoded.includes("\0")) return null;
  // ويندوز يعامل `\` كفاصل مسار، فنوحّده قبل التجزئة كي لا يمرّ التفاف عبره.
  decoded = decoded.replace(/\\/g, "/");
  if (decoded === "" || decoded === "/") decoded = "/index.html";
  if (!decoded.startsWith("/")) return null;

  const segments = [];
  for (const raw of decoded.split("/")) {
    if (raw === "" || raw === ".") continue;
    if (raw === "..") return null;        // لا صعود إطلاقاً — أصرم من التطبيع
    if (raw.startsWith(".")) return null; // لا مخفي في أي مستوى (.git/.env/.github)
    segments.push(raw);
  }
  return segments.length ? segments : null;
}

/**
 * يحلّ مسار الطلب إلى ملف مسموح، أو null.
 * لا يسقط إلى index.html أبداً — سقوط كهذا يُخفي الرفض ويجعله غير قابل للملاحظة.
 */
export function resolvePublicPath(urlPath, base = root) {
  const segments = urlPathSegments(urlPath);
  if (!segments) return null;

  const allowed = segments.length === 1
    ? PUBLIC_ROOT_FILES.has(segments[0])
    : PUBLIC_DIRS.includes(segments[0]);
  if (!allowed) return null;

  // الامتداد من المقطع الأخير وحده — لا فواصل فيه، فالنتيجة واحدة على كل نظام.
  const last = segments[segments.length - 1];
  const dot = last.lastIndexOf(".");
  const extension = dot > 0 ? last.slice(dot).toLowerCase() : "";
  if (!Object.prototype.hasOwnProperty.call(TYPES, extension)) return null;

  const target = resolve(base, ...segments);
  // حارس نهائي: المسار المُحلّ يجب أن يبقى داخل جذر عام فعلاً.
  const roots = segments.length === 1
    ? [resolve(base)]
    : PUBLIC_DIRS.map((d) => resolve(base, d));
  const inside = roots.some((r) => target === r || target.startsWith(r + sep));
  if (!inside) return null;

  if (!existsSync(target) || !statSync(target).isFile()) return null;
  // symlink يخرج عن الجذر (مثل node_modules المرتبط في مجلدات العمل) يُرفض.
  try {
    const real = realpathSync(target);
    if (!roots.some((r) => real === r || real.startsWith(realpathSync(r) + sep))) return null;
  } catch {
    return null;
  }
  return target;
}

// ===== الطبقة الثانية: حارس ترويسة Host ضد إعادة ربط DNS =====

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function isLoopbackBind(host) {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/**
 * إعادة ربط DNS تحتاج **اسم نطاق** يتحكم به المهاجم. لذلك:
 *   • ربط على الاسترجاع (مرافق الماك) ⇒ الاسترجاع وحده مقبول.
 *   • ربط على 0.0.0.0 (ويندوز يخدم الآيفون) ⇒ عناوين IP الحرفية و`localhost`
 *     و`*.local` مقبولة — وهي ما يستعمله الآيفون فعلاً — بينما تُرفض أسماء
 *     النطاقات المسجّلة. فيبقى سلوك ويندوز/الآيفون كما هو ويسقط مسار الهجوم.
 */
export function isHostAllowed(hostHeader, bindHost = requestedHost) {
  const raw = String(hostHeader || "").trim().toLowerCase();
  if (!raw) return false;
  const name = raw.startsWith("[")
    ? raw.slice(0, raw.indexOf("]") + 1)
    : raw.replace(/:\d+$/, "");
  if (!name) return false;
  if (LOOPBACK_HOSTS.has(name)) return true;
  if (isLoopbackBind(bindHost)) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return true;   // IPv4 حرفي
  if (name.startsWith("[") && name.endsWith("]")) return true; // IPv6 حرفي
  if (name.endsWith(".local")) return true;                 // mDNS داخل الشبكة
  return false;
}

function handler(req, res) {
  if (!isHostAllowed(req.headers.host)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden host");
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Method not allowed");
    return;
  }

  const target = resolvePublicPath(req.url || "/");
  if (!target) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  res.setHeader("Content-Type", TYPES[extname(target).toLowerCase()] || "application/octet-stream");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method === "HEAD") {
    res.writeHead(200);
    res.end();
    return;
  }
  createReadStream(target).pipe(res);
}

export const server = createServer(handler);

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  server.listen(requestedPort, requestedHost, () => {
    console.log(`Web Platform is running:`);
    console.log(`Local:   http://127.0.0.1:${requestedPort}`);
    if (requestedHost === "0.0.0.0") {
      console.log(`Network: http://YOUR_WINDOWS_IP:${requestedPort}`);
    } else {
      console.log(`Bound:   ${requestedHost} (محصور محلياً — غير معروض على الشبكة)`);
    }
    console.log(`يُخدَم فقط: ${PUBLIC_DIRS.map((d) => d + "/").join(" ")}+ ملفات الجذر العامة`);
  });
}
