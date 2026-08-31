import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = normalize(join(dirname(fileURLToPath(import.meta.url)), ".."));
const portArgIndex = process.argv.indexOf("--port");
const requestedPort = portArgIndex >= 0
  ? Number(process.argv[portArgIndex + 1])
  : Number(process.env.PORT) || 5173;
// الافتراضي 0.0.0.0 كما كان — ويندوز يخدم أجهزة الشبكة من هذا السيرفر ولا
// يتغيّر سلوكه إطلاقاً. صار المضيف قابلاً للضبط كي يحصره مرافق الماك على
// الاسترجاع وحده (HOST=127.0.0.1) فلا يُعرَض الموقع على الشبكة من الماك.
const requestedHost = process.env.HOST || "0.0.0.0";

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const clean = decoded === "/" ? "/index.html" : decoded;
  const target = normalize(join(root, clean));
  return target.startsWith(root) ? target : join(root, "index.html");
}

function handler(req, res) {
  let target = safePath(req.url || "/");

  if (!existsSync(target) || statSync(target).isDirectory()) {
    target = join(root, "index.html");
  }

  res.setHeader("Content-Type", types[extname(target)] || "application/octet-stream");
  createReadStream(target).pipe(res);
}

const server = createServer(handler);

server.listen(requestedPort, requestedHost, () => {
  console.log(`Web Platform is running:`);
  console.log(`Local:   http://127.0.0.1:${requestedPort}`);
  if (requestedHost === "0.0.0.0") {
    console.log(`Network: http://YOUR_WINDOWS_IP:${requestedPort}`);
  } else {
    console.log(`Bound:   ${requestedHost} (محصور محلياً — غير معروض على الشبكة)`);
  }
});
