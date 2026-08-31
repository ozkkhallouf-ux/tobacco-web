// فحص سلوكي كامل لميزة OZK Automatic iCloud Archive.
//
// يشغّل الجسر فعلياً على منفذ عابر فوق جذر iCloud وهمي داخل مجلد مؤقت، ويطلب
// منه ما يطلبه الموقع تماماً — لا مطابقة نصية للكود. يغطي:
//   1) اسم ملف فاتورة عربي مطابق للاصطلاح المعتمد
//   2) أسماء مجلدات عربية بصيغ Unicode مختلفة (NFD + محرف RLM مخفي)
//   3) منع التكرار (نفس المحتوى) وتوليد نسخة مرقّمة عند اختلاف المحتوى
//   4) رفض نوع مستند غير معروف
//   5) رفض بيانات وصفية ناقصة
//   6) سقوط الموقع إلى التنزيل العادي حين يكون الجسر متوقفاً (عميل الواجهة)
//   7) أمان: path traversal، أصل مرفوض، Host مزيّف، رمز خاطئ
//   8) مجلد iCloud مفقود
//   9) أرشفة ناجحة (PDF جاهز + تحويل HTML عبر Chromium إن توفّر)
//
// كل شيء داخل مجلد مؤقت — الفحص لا يلمس iCloud الحقيقي ولا أي ملف للمستخدم.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import http from "node:http";
import assert from "node:assert/strict";

const results = [];
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    results.push(`  ✅ ${name}`);
  } catch (error) {
    failed += 1;
    results.push(`  ❌ ${name}\n     ${error && error.message}`);
  }
}

function skip(name, why) {
  results.push(`  ⏭️  ${name} — ${why}`);
}

// ===== تهيئة بيئة معزولة =====

const TMP = mkdtempSync(path.join(tmpdir(), "ozk-archive-check-"));
const HOME_DIR = path.join(TMP, "bridge-home");
const ICLOUD = path.join(TMP, "icloud");
mkdirSync(HOME_DIR, { recursive: true });
mkdirSync(ICLOUD, { recursive: true });

// أسماء المجلدات كما تظهر فعلياً على جهاز المالك: بعضها NFD (الهمزة محرف
// مركّب منفصل) وواحد يبدأ بـU+200F غير مرئي. الجسر يجب أن يجدها كلها.
const RLM = "‏";
const FOLDER_SPECS = [
  { logical: "فواتير الزبائن", onDisk: "فواتير الزبائن".normalize("NFD") },
  { logical: "سندات قبض ودفع", onDisk: "سندات قبض ودفع" },
  { logical: "نشرات أسعار", onDisk: "نشرات أسعار".normalize("NFD") },
  { logical: "تقرير المخزون", onDisk: "تقرير المخزون" },
  { logical: "تقرير الذمم", onDisk: "تقرير الذمم" },
  { logical: "كشف حسابات", onDisk: "كشف حسابات" },
  { logical: "فواتير المشتريات", onDisk: RLM + "فواتير المشتريات" },
  { logical: "تقارير مختلفة", onDisk: "تقارير مختلفة" }
];

let folderSetupError = null;
for (const spec of FOLDER_SPECS) {
  try {
    mkdirSync(path.join(ICLOUD, spec.onDisk), { recursive: true });
  } catch (error) {
    folderSetupError = error;
  }
}

writeFileSync(path.join(HOME_DIR, "config.json"), JSON.stringify({
  port: 0,
  host: "127.0.0.1",
  allowedOrigins: ["https://ozktobacco.com", "http://localhost:5173"],
  autoPair: true,
  icloudRoot: ICLOUD,
  maxBodyBytes: 8 * 1024 * 1024,
  renderTimeoutMs: 20000,
  browserIdleMs: 0,
  rateLimit: { windowMs: 60000, max: 500 }
}, null, 2));

process.env.OZK_ARCHIVE_HOME = HOME_DIR;

const { buildFileName, sanitizePart, resolveDate } = await import("../tools/mac-archive-bridge/lib/naming.mjs");
const { folderKey } = await import("../tools/mac-archive-bridge/lib/arabic.mjs");
const { discoverFolders, missingFolders, resolveFolderPath } = await import("../tools/mac-archive-bridge/lib/folders.mjs");
const { archiveDocument } = await import("../tools/mac-archive-bridge/lib/archive.mjs");
const { server } = await import("../tools/mac-archive-bridge/server.mjs");
const { renderAvailable, closeBrowser } = await import("../tools/mac-archive-bridge/lib/render.mjs");

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;
const ORIGIN = "https://ozktobacco.com";
const TOKEN = readFileSync(path.join(HOME_DIR, "token"), "utf8").trim();

function samplePdf(marker = "A") {
  // مستند PDF صغير لكنه صالح البنية وأكبر من الحد الأدنى (1 ك.ب).
  const body = `%PDF-1.4\n% ozk-archive-check ${marker}\n` + `${marker}`.repeat(2048) + "\n%%EOF\n";
  return Buffer.from(body, "latin1");
}

async function call(pathname, options = {}) {
  const response = await fetch(BASE + pathname, {
    method: options.method || "GET",
    headers: {
      Origin: options.origin === null ? undefined : (options.origin || ORIGIN),
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.token === null ? {} : { "X-OZK-Archive-Token": options.token || TOKEN }),
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  let data = null;
  try { data = await response.json(); } catch { data = null; }
  return { status: response.status, data };
}

function archiveBody(docType, meta, pdf = samplePdf()) {
  return { docType, meta, pdfBase64: pdf.toString("base64") };
}

function listFolder(logical) {
  const spec = FOLDER_SPECS.find((f) => f.logical === logical);
  return readdirSync(path.join(ICLOUD, spec.onDisk)).filter((n) => !n.startsWith("."));
}

// ===== 1) اسم ملف الفاتورة العربي =====

await test("اسم فاتورة عربي مطابق للاصطلاح المعتمد", () => {
  const built = buildFileName("invoice", { party: "حسن عباس", number: "562", date: "2026-08-31" });
  assert.equal(built.name, "فاتورة - حسن عباس - رقم 562 - 2026-08-31.pdf");
  assert.equal(built.folder, "فواتير الزبائن");
});

await test("اصطلاحات بقية الأنواع", () => {
  const cases = [
    ["receipt", { party: "سامر", number: "7", date: "2026-08-31" }, "سند قبض - سامر - رقم 7 - 2026-08-31.pdf", "سندات قبض ودفع"],
    ["payment", { party: "كهرباء", number: "9", date: "2026-08-31" }, "سند دفع - كهرباء - رقم 9 - 2026-08-31.pdf", "سندات قبض ودفع"],
    ["account_statement", { party: "حسن عباس", date: "2026-08-31" }, "كشف حساب - حسن عباس - 2026-08-31.pdf", "كشف حسابات"],
    ["stock_report", { date: "2026-08-31" }, "تقرير المخزون - 2026-08-31.pdf", "تقرير المخزون"],
    ["receivables_report", { date: "2026-08-31" }, "تقرير الذمم - 2026-08-31.pdf", "تقرير الذمم"],
    ["price_list", { date: "2026-08-31" }, "نشرة أسعار - 2026-08-31.pdf", "نشرات أسعار"],
    ["purchase_invoice", { party: "مورد الشام", number: "31", date: "2026-08-31" }, "فاتورة مشتريات - مورد الشام - رقم 31 - 2026-08-31.pdf", "فواتير المشتريات"],
    ["purchase_invoice", { number: "31", date: "2026-08-31" }, "فاتورة مشتريات - رقم 31 - 2026-08-31.pdf", "فواتير المشتريات"],
    ["return_invoice", { party: "حسن عباس", number: "44", date: "2026-08-31" }, "فاتورة مرتجع - حسن عباس - رقم 44 - 2026-08-31.pdf", "فواتير الزبائن"],
    ["other_report", { title: "تقرير المواد الراكدة", date: "2026-08-31" }, "تقرير المواد الراكدة - 2026-08-31.pdf", "تقارير مختلفة"]
  ];
  for (const [docType, meta, expectedName, expectedFolder] of cases) {
    const built = buildFileName(docType, meta);
    assert.equal(built.name, expectedName, `${docType}: ${built.name}`);
    assert.equal(built.folder, expectedFolder, `${docType} folder`);
  }
});

await test("تاريخ غير صالح يسقط إلى تاريخ الجهاز لا إلى نص المرسِل", () => {
  const built = buildFileName("stock_report", { date: "../../etc" });
  assert.match(built.name, /^تقرير المخزون - \d{4}-\d{2}-\d{2}\.pdf$/);
  assert.equal(resolveDate("2026-13-45"), resolveDate(undefined));
});

// ===== 2) أسماء مجلدات بصيغ Unicode مختلفة =====

await test("اكتشاف مجلدات NFD ومجلد يبدأ بمحرف RLM مخفي", async () => {
  if (folderSetupError) throw new Error("تعذّر إنشاء مجلدات الاختبار: " + folderSetupError.message);
  const folders = await discoverFolders(ICLOUD);
  assert.deepEqual(missingFolders(folders), [], "لا يجوز أن ينقص أي مجلد");
  // المسار المُحلّ يجب أن يستعمل الاسم الحقيقي على القرص لا الاسم المنطقي.
  const purchases = resolveFolderPath(folders, "فواتير المشتريات", ICLOUD);
  assert.ok(path.basename(purchases).startsWith(RLM), "يجب استعمال الاسم الحقيقي بمحرف RLM");
  const invoices = resolveFolderPath(folders, "فواتير الزبائن", ICLOUD);
  assert.ok(existsSync(invoices), "مسار فواتير الزبائن (NFD) يجب أن يكون موجوداً");
});

await test("مفتاح المطابقة يوحّد الهمزات والتاء المربوطة والتطويل", () => {
  assert.equal(folderKey("فواتير الزبائن".normalize("NFD")), folderKey("فواتير الزبائن"));
  assert.equal(folderKey(RLM + "فواتير المشتريات"), folderKey("فواتير المشتريات"));
  assert.equal(folderKey("نشرات أسعار"), folderKey("نشرات اسعار"));
  assert.equal(folderKey("تقارير مختلفة"), folderKey("تقارير مختلفه"));
});

// ===== 9) أرشفة ناجحة عبر HTTP =====

await test("أرشفة فاتورة ناجحة تكتب الملف في المجلد الصحيح", async () => {
  const res = await call("/archive", {
    method: "POST",
    body: archiveBody("invoice", { party: "حسن عباس", number: "562", date: "2026-08-31" })
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.status, "saved");
  assert.equal(res.data.file, "فاتورة - حسن عباس - رقم 562 - 2026-08-31.pdf");
  assert.ok(listFolder("فواتير الزبائن").includes(res.data.file));
  assert.equal(res.data.path, undefined, "المسار المطلق لا يُعاد للواجهة");
});

await test("سند قبض يذهب إلى مجلد السندات المشترك", async () => {
  const res = await call("/archive", {
    method: "POST",
    body: archiveBody("receipt", { party: "سامر", number: "7", date: "2026-08-31" })
  });
  assert.equal(res.status, 200);
  assert.ok(listFolder("سندات قبض ودفع").includes("سند قبض - سامر - رقم 7 - 2026-08-31.pdf"));
});

await test("فاتورة المرتجع نوع مستقل يسكن مع فواتير الزبائن بلا خلط مع البيع", async () => {
  const meta = { party: "حسن عباس", number: "44", date: "2026-08-31" };
  const ret = await call("/archive", { method: "POST", body: archiveBody("return_invoice", meta) });
  assert.equal(ret.status, 200, JSON.stringify(ret.data));
  assert.equal(ret.data.folder, "فواتير الزبائن");
  assert.equal(ret.data.file, "فاتورة مرتجع - حسن عباس - رقم 44 - 2026-08-31.pdf");

  // نفس الزبون ونفس الرقم كبيع حقيقي: يجب أن ينتج ملفاً منفصلاً باسم مختلف —
  // خلط المرتجع مع البيع يجعل المستندين لا يُميَّزان في الأرشيف.
  const sale = await call("/archive", { method: "POST", body: archiveBody("invoice", meta, samplePdf("S")) });
  assert.equal(sale.status, 200);
  assert.equal(sale.data.file, "فاتورة - حسن عباس - رقم 44 - 2026-08-31.pdf");
  assert.notEqual(sale.data.file, ret.data.file);
  const names = listFolder("فواتير الزبائن");
  assert.ok(names.includes(ret.data.file) && names.includes(sale.data.file));
});

await test("فاتورة مرتجع بلا اسم أو رقم مرفوضة", async () => {
  const noParty = await call("/archive", { method: "POST", body: archiveBody("return_invoice", { number: "44", date: "2026-08-31" }) });
  assert.equal(noParty.status, 400);
  const noNumber = await call("/archive", { method: "POST", body: archiveBody("return_invoice", { party: "حسن", date: "2026-08-31" }) });
  assert.equal(noNumber.status, 400);
});

await test("فاتورة مشتريات تُكتب داخل المجلد ذي المحرف المخفي", async () => {
  const res = await call("/archive", {
    method: "POST",
    body: archiveBody("purchase_invoice", { party: "مورد الشام", number: "31", date: "2026-08-31" })
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.ok(listFolder("فواتير المشتريات").includes("فاتورة مشتريات - مورد الشام - رقم 31 - 2026-08-31.pdf"));
});

// ===== 3) منع التكرار =====

await test("تكرار بنفس المحتوى لا يكتب ملفاً ثانياً", async () => {
  const body = archiveBody("invoice", { party: "زبون التكرار", number: "900", date: "2026-08-31" });
  const first = await call("/archive", { method: "POST", body });
  const second = await call("/archive", { method: "POST", body });
  assert.equal(first.data.status, "saved");
  assert.equal(second.data.status, "duplicate");
  assert.equal(first.data.file, second.data.file);
  const matches = listFolder("فواتير الزبائن").filter((n) => n.includes("زبون التكرار"));
  assert.equal(matches.length, 1, "يجب أن يبقى ملف واحد فقط");
});

await test("نفس الاسم بمحتوى مختلف يُحفظ كنسخة مرقّمة ولا يستبدل الأصل", async () => {
  const meta = { party: "زبون الاختلاف", number: "901", date: "2026-08-31" };
  const first = await call("/archive", { method: "POST", body: archiveBody("invoice", meta, samplePdf("A")) });
  const second = await call("/archive", { method: "POST", body: archiveBody("invoice", meta, samplePdf("B")) });
  assert.equal(first.data.status, "saved");
  assert.equal(second.data.status, "saved");
  assert.equal(second.data.file, first.data.file.replace(/\.pdf$/, " (2).pdf"));
  const dir = path.join(ICLOUD, FOLDER_SPECS[0].onDisk);
  const original = readFileSync(path.join(dir, first.data.file));
  assert.ok(original.includes("ozk-archive-check A"), "الملف الأصلي يجب أن يبقى كما هو");
});

await test("اختلاف تاريخ التوليد داخل PDF لا يُعتبر محتوى مختلفاً", async () => {
  // قياس فعلي (2026-08-31): تصديران متتاليان لنفس كشف الحساب من Chromium
  // اختلفا في CreationDate/ModDate فقط فأنتجا نسخة «(2)» زائدة في الأرشيف.
  const stamp = (t) => Buffer.from(
    `%PDF-1.4\n<</Creator (Chromium)\n/CreationDate (D:${t}+00'00')\n/ModDate (D:${t}+00'00')>>\n`
    + "Z".repeat(2048) + "\n%%EOF\n", "latin1"
  );
  const meta = { party: "زبون الطابع الزمني", number: "902", date: "2026-08-31" };
  const first = await call("/archive", { method: "POST", body: archiveBody("invoice", meta, stamp("20260831013231")) });
  const second = await call("/archive", { method: "POST", body: archiveBody("invoice", meta, stamp("20260831013259")) });
  assert.equal(first.data.status, "saved");
  assert.equal(second.data.status, "duplicate", "الطابع الزمني وحده لا يبرّر نسخة ثانية");
  const matches = listFolder("فواتير الزبائن").filter((n) => n.includes("زبون الطابع الزمني"));
  assert.equal(matches.length, 1);
});

// ===== 4) نوع مستند غير معروف =====

await test("نوع مستند غير معروف مرفوض بـ400 ولا يكتب شيئاً", async () => {
  const before = readdirSync(ICLOUD).length;
  const res = await call("/archive", { method: "POST", body: archiveBody("secret_dump", { date: "2026-08-31" }) });
  assert.equal(res.status, 400);
  assert.equal(res.data.code, "bad_doc_type");
  assert.equal(readdirSync(ICLOUD).length, before, "لا يُنشأ أي مجلد جديد");
});

await test("محاولة تمرير مسار وجهة مباشرة تُتجاهل كلياً", async () => {
  const res = await call("/archive", {
    method: "POST",
    body: {
      docType: "stock_report",
      meta: { date: "2026-08-31" },
      pdfBase64: samplePdf().toString("base64"),
      folder: "/etc",
      path: "/tmp/evil.pdf",
      fileName: "evil.pdf"
    }
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.folder, "تقرير المخزون");
  assert.equal(res.data.file, "تقرير المخزون - 2026-08-31.pdf");
});

// ===== 5) بيانات وصفية ناقصة =====

await test("فاتورة بلا اسم زبون مرفوضة", async () => {
  const res = await call("/archive", { method: "POST", body: archiveBody("invoice", { number: "5", date: "2026-08-31" }) });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /الاسم/);
});

await test("فاتورة بلا رقم مرفوضة", async () => {
  const res = await call("/archive", { method: "POST", body: archiveBody("invoice", { party: "سامر", date: "2026-08-31" }) });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /الرقم/);
});

await test("طلب بلا محتوى إطلاقاً مرفوض", async () => {
  const res = await call("/archive", { method: "POST", body: { docType: "stock_report", meta: {} } });
  assert.equal(res.status, 400);
});

await test("محتوى ليس PDF مرفوض حتى لو صحّت البيانات", async () => {
  const notPdf = Buffer.from("x".repeat(4096), "utf8");
  const res = await call("/archive", { method: "POST", body: archiveBody("stock_report", { date: "2026-08-30" }, notPdf) });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /PDF/);
});

// ===== 7) الأمان =====

await test("path traversal في الاسم يُنقّى ولا يخرج عن المجلد", async () => {
  const res = await call("/archive", {
    method: "POST",
    body: archiveBody("invoice", { party: "../../../../etc/passwd", number: "../1", date: "2026-08-31" })
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.ok(!res.data.file.includes("/"), "لا يجوز بقاء فاصل مسار في الاسم");
  assert.ok(!res.data.file.includes(".."), "لا يجوز بقاء تسلسل الصعود");
  assert.ok(listFolder("فواتير الزبائن").includes(res.data.file));
  assert.ok(!existsSync(path.join(TMP, "passwd")), "لم يُكتب أي شيء خارج المجلد");
});

await test("محارف تحكّم واتجاه مخفية تُزال من الاسم", () => {
  assert.equal(sanitizePart("حسن" + RLM + "  عباس"), "حسن عباس");
  assert.equal(sanitizePart("...محاولة"), "محاولة");
  assert.equal(sanitizePart("a\\b:c"), "a b c");
});

await test("أصل غير مسموح مرفوض بـ403", async () => {
  const res = await call("/health", { origin: "https://evil.example" });
  assert.equal(res.status, 403);
});

await test("ترويسة Host مزيّفة (DNS rebinding) مرفوضة بـ403", async () => {
  // fetch يمنع ضبط Host (ترويسة محظورة)، فنستعمل عميل http الخام كما يفعل
  // متصفّح ضحية أُعيد ربط نطاق المهاجم فيه إلى 127.0.0.1.
  const status = await new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: server.address().port,
      path: "/health",
      method: "GET",
      headers: { Host: "attacker.example", Origin: ORIGIN }
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 403);
});

await test("رمز خاطئ مرفوض بـ401", async () => {
  const res = await call("/archive", {
    method: "POST",
    token: "0".repeat(64),
    body: archiveBody("stock_report", { date: "2026-08-31" })
  });
  assert.equal(res.status, 401);
  assert.equal(res.data.code, "bad_token");
});

await test("الربط التلقائي يعطي الرمز للأصل المسموح فقط", async () => {
  const ok = await call("/pair");
  assert.equal(ok.status, 200);
  assert.equal(ok.data.token, TOKEN);
  const bad = await call("/pair", { origin: "https://evil.example" });
  assert.equal(bad.status, 403);
});

await test("preflight ينجح للأصل المسموح ويفشل لغيره", async () => {
  const good = await fetch(BASE + "/archive", {
    method: "OPTIONS",
    headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST" }
  });
  assert.equal(good.status, 204);
  assert.equal(good.headers.get("access-control-allow-origin"), ORIGIN);
  const bad = await fetch(BASE + "/archive", {
    method: "OPTIONS",
    headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" }
  });
  assert.equal(bad.status, 403);
  assert.equal(bad.headers.get("access-control-allow-origin"), null);
});

// ===== 8) مجلد iCloud مفقود =====

await test("مجلد iCloud مفقود يعطي 409 برسالة واضحة ولا يُنشئ مجلداً", async () => {
  const emptyRoot = path.join(TMP, "icloud-empty");
  mkdirSync(emptyRoot, { recursive: true });
  await assert.rejects(
    () => archiveDocument(samplePdf(), "invoice", { party: "سامر", number: "1", date: "2026-08-31" }, { root: emptyRoot }),
    /مجلد iCloud غير موجود/
  );
  assert.equal(readdirSync(emptyRoot).length, 0, "الجسر لا ينشئ مجلدات من تلقاء نفسه");
});

await test("/health يبلّغ عن المجلدات الناقصة", async () => {
  const res = await call("/health");
  assert.equal(res.status, 200);
  assert.equal(res.data.ok, true);
  assert.equal(res.data.icloud.ready, true);
  assert.deepEqual(res.data.icloud.missingFolders, []);
  assert.ok(Array.isArray(res.data.docTypes) && res.data.docTypes.includes("invoice"));
});

// ===== 9ب) تحويل HTML عربي إلى PDF =====

if (await renderAvailable()) {
  await test("تحويل HTML عربي إلى PDF متجه وحفظه", async () => {
    const res = await call("/archive", {
      method: "POST",
      body: {
        docType: "account_statement",
        meta: { party: "حسن عباس", date: "2026-08-31" },
        baseUrl: ORIGIN + "/",
        html: '<div class="ozk-rpt"><h1>كشف حساب</h1><p>حسن عباس — الرصيد 1250 دولار</p></div>'
      }
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.file, "كشف حساب - حسن عباس - 2026-08-31.pdf");
    const spec = FOLDER_SPECS.find((f) => f.logical === "كشف حسابات");
    const bytes = readFileSync(path.join(ICLOUD, spec.onDisk, res.data.file));
    assert.equal(bytes.subarray(0, 5).toString("latin1"), "%PDF-");
    assert.ok(bytes.includes("ToUnicode"), "النص يجب أن يكون متجهاً قابلاً للبحث لا صورة");
  });
} else {
  skip("تحويل HTML عربي إلى PDF", "Chromium غير مثبّت (npx playwright install chromium)");
}

// ===== 6) سقوط الموقع إلى التنزيل العادي حين يتوقف الجسر =====

function loadArchiveClient({ fetchImpl, storage = new Map(), protocol = "http:", platform = "MacIntel" }) {
  const timers = [];
  const created = [];
  const makeNode = () => ({
    style: {}, dir: "", textContent: "", attrs: {}, children: [], isConnected: true,
    setAttribute(k, v) { this.attrs[k] = v; },
    appendChild(child) { this.children.push(child); return child; },
    remove() { this.isConnected = false; }
  });
  const sandbox = {
    console,
    Blob: class Blob {},
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    fetch: fetchImpl,
    FileReader: class {
      readAsDataURL() { this.result = "data:application/pdf;base64,QUJD"; this.onload && this.onload(); }
    },
    navigator: {
      platform,
      userAgent: /mac/i.test(platform)
        ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"
        : "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
    },
    document: {
      // «loading» + مستمع لا يُطلق: يمنع الفحص التلقائي عند الإقلاع كي تبقى
      // تسلسلات الطلبات في الاختبارات محكومة بالكامل.
      readyState: "loading",
      addEventListener: () => {},
      body: { appendChild: (node) => { created.push(node); return node; } },
      querySelector: () => null,
      createElement: makeNode
    }
  };
  sandbox.window = {
    location: { origin: "https://ozktobacco.com", protocol },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, v),
      removeItem: (k) => storage.delete(k)
    }
  };
  sandbox.window.window = sandbox.window;
  sandbox.navigator = sandbox.navigator;
  vm.createContext(sandbox);
  const source = readFileSync(new URL("../src/icloud-archive.js", import.meta.url), "utf8");
  vm.runInContext(source, sandbox);
  const pick = (attr) => created.filter((n) => Object.prototype.hasOwnProperty.call(n.attrs || {}, attr));
  return {
    api: sandbox.window.ozkArchive,
    created,
    storage,
    toasts: () => pick("data-ozk-archive-toast"),
    chips: () => pick("data-ozk-archive-status")
  };
}

await test("الجسر متوقف: العميل يرجع فشلاً هادئاً ولا يرمي أبداً", async () => {
  const { api } = loadArchiveClient({
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); }
  });
  const result = await api.archive({ docType: "invoice", html: "<p>x</p>", meta: { party: "سامر", number: "1" } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unreachable");
});

await test("الجسر متوقف: لا يُرسل أي طلب أرشفة بعد فشل الفحص", async () => {
  const calls = [];
  const { api } = loadArchiveClient({
    fetchImpl: async (url) => { calls.push(String(url)); throw new Error("down"); }
  });
  await api.archive({ docType: "stock_report", html: "<p>x</p>", meta: {} });
  assert.ok(calls.every((u) => u.endsWith("/health")), "لا يجوز محاولة /archive والجسر مطفأ: " + calls.join(","));
});

await test("مسار النجاح الكامل للعميل: فحص ثم ربط ثم أرشفة", async () => {
  const calls = [];
  const { api, storage } = loadArchiveClient({
    fetchImpl: async (url, init) => {
      const target = String(url);
      calls.push(target);
      if (target.endsWith("/health")) {
        return { ok: true, status: 200, json: async () => ({ ok: true, icloud: { ready: true } }) };
      }
      if (target.endsWith("/pair")) {
        return { ok: true, status: 200, json: async () => ({ ok: true, token: "T".repeat(64) }) };
      }
      assert.equal(init.headers["X-OZK-Archive-Token"], "T".repeat(64));
      const payload = JSON.parse(init.body);
      assert.equal(payload.docType, "invoice");
      assert.equal(payload.meta.party, "حسن عباس");
      assert.ok(!("path" in payload) && !("fileName" in payload), "العميل لا يرسل مساراً ولا اسم ملف");
      return { ok: true, status: 200, json: async () => ({ ok: true, status: "saved", file: "f.pdf", folder: "فواتير الزبائن" }) };
    }
  });
  const result = await api.archive({
    docType: "invoice", html: "<p>فاتورة</p>",
    meta: { party: "حسن عباس", number: "562", date: "2026-08-31" }
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "saved");
  assert.equal(storage.get("ozk.archive.token"), "T".repeat(64));
  assert.deepEqual(calls.map((c) => c.split("8787")[1]), ["/health", "/pair", "/archive"]);
});

await test("على https: رسالة الفشل تذكر إذن الشبكة المحلية لا عطلاً وهمياً", async () => {
  // قياس فعلي (2026-08-31): من صفحة https يفشل الطلب بلا إذن الشبكة المحلية
  // وينجح بـ200 فور منحه. رسالة «الجسر غير متاح» وحدها تُرسل المالك خلف عطل
  // غير موجود.
  const { api, toasts } = loadArchiveClient({
    protocol: "https:",
    fetchImpl: async () => { throw new Error("Failed to fetch"); }
  });
  const result = await api.archive({ docType: "stock_report", html: "<p>x</p>", meta: {} });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unreachable");
  assert.equal(toasts().length, 1, "يجب أن يظهر تنبيه واحد");
  assert.match(toasts()[0].textContent, /الشبكة المحلية/);
});

await test("على http محلي: رسالة الفشل تبقى مباشرة بلا حشو", async () => {
  const { api, toasts } = loadArchiveClient({
    protocol: "http:",
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); }
  });
  await api.archive({ docType: "stock_report", html: "<p>x</p>", meta: {} });
  assert.equal(toasts().length, 1);
  assert.match(toasts()[0].textContent, /الجسر المحلي غير متاح/);
});

await test("مؤشر الحالة يعكس الاتصال ويظهر بكلمتين بلا تفاصيل تقنية", async () => {
  const down = loadArchiveClient({ fetchImpl: async () => { throw new Error("down"); } });
  await down.api.probe(true);
  assert.equal(down.chips().length, 1);
  assert.equal(down.chips()[0].children[1].textContent, "أرشفة iCloud: غير متصلة");

  const up = loadArchiveClient({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, icloud: { ready: true } }) })
  });
  await up.api.probe(true);
  assert.equal(up.chips()[0].children[1].textContent, "أرشفة iCloud: متصلة");
  // لا يجوز تسريب أي تفصيل تقني إلى الشارة.
  assert.ok(!/127\.0\.0\.1|http|fetch/i.test(up.chips()[0].children[1].textContent));
});

await test("جهاز غير ماك: لا طلب شبكي ولا شارة ولا تنبيه", async () => {
  let touched = false;
  const { api, created } = loadArchiveClient({
    platform: "Win32",
    fetchImpl: async () => { touched = true; throw new Error("should not happen"); }
  });
  assert.equal(api.isSupportedPlatform(), false);
  const result = await api.archive({ docType: "invoice", html: "<p>x</p>", meta: { party: "س", number: "1" } });
  assert.equal(result.reason, "unsupported_platform");
  assert.equal(touched, false, "ويندوز/الآيفون لا يرسلان أي طلب");
  assert.equal(created.length, 0, "ولا يظهر لهما أي عنصر واجهة");
});

await test("diagnose يجيب عن كل أسئلة التشخيص بلا إزعاج المستخدم", async () => {
  const { api, created } = loadArchiveClient({
    fetchImpl: async (url) => (String(url).endsWith("/health")
      ? { ok: true, status: 200, json: async () => ({ ok: true, service: "ozk-archive-bridge" }) }
      : { ok: true, status: 200, json: async () => ({ ok: true, token: "T".repeat(64) }) })
  });
  const report = await api.diagnose();
  assert.equal(report.platformSupported, true);
  assert.equal(report.health.reached, true);
  assert.equal(report.health.status, 200);
  assert.equal(report.pair.reached, true);
  assert.equal(report.pair.gotToken, true);
  assert.equal(report.verdict, "الجسر متاح");
  assert.equal(created.length, 0, "التشخيص لا يعرض شيئاً للمستخدم");
});

await test("إيقاف الميزة من المتصفح يمنع أي طلب شبكي", async () => {
  const storage = new Map([["ozk.archive.enabled", "0"]]);
  let touched = false;
  const { api } = loadArchiveClient({ storage, fetchImpl: async () => { touched = true; } });
  const result = await api.archive({ docType: "invoice", html: "<p>x</p>", meta: {} });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "disabled");
  assert.equal(touched, false);
});

// ===== حراسة تراجعية على تكامل الموقع =====

await test("app.js: الأرشفة لا تحجب التصدير ولا تُنتظر", () => {
  const appJs = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  const helper = appJs.match(/function archiveToICloud\(docType, content, meta\) \{[\s\S]*?\n\}\n/);
  assert.ok(helper, "دالة archiveToICloud مفقودة");
  assert.ok(/try \{/.test(helper[0]) && /catch/.test(helper[0]), "يجب أن تبتلع أي خطأ");
  assert.ok(/void window\.ozkArchive\.archive\(/.test(helper[0]), "يجب أن تُطلق بلا await");
  assert.ok(/isHandheldDevice\(\)/.test(helper[0]), "يجب تخطّي الهاتف");
  assert.ok(!/await window\.ozkArchive/.test(appJs), "لا يجوز انتظار الأرشفة في أي مسار");
  // فاتورة المبيعات المسودة (بلا رقم موثوق) يجب ألا تدخل الأرشيف إطلاقاً.
  assert.ok(/invNo !== SALES_DRAFT_INVOICE_NO/.test(appJs), "حارس المسودة مفقود في تصدير PDF");
  assert.ok(/archive: invNo === SALES_DRAFT_INVOICE_NO \? null :/.test(appJs), "حارس المسودة مفقود في الطباعة");
  // المرتجع نوع مستقل: لا يُرسل كـinvoice ولا كـother_report.
  assert.ok(/isRet \? "return_invoice"/.test(appJs), "المرتجع يجب أن يُرسل بنوعه المستقل");
  assert.ok(!/isRet \? "other_report"/.test(appJs), "بقي التصنيف القديم للمرتجع");
});

await test("لم تسقط أي نقطة ربط للأرشفة من src/app.js", () => {
  // أُضيف هذا الحارس بعد حادثة فعلية (2026-08-31): إعادة هيكلة لنشرة الأسعار
  // في جلسة أخرى حذفت `archiveToICloud("price_list", ...)` بصمت، فتوقّفت
  // أرشفة النشرة بلا أي خطأ ظاهر. نقاط الربط تُفحص بالاسم من الآن فصاعداً.
  const appJs = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  const directHooks = ["price_list", "other_report", "invoice"];
  for (const kind of directHooks) {
    assert.ok(
      appJs.includes(`archiveToICloud("${kind}"`),
      `نقطة ربط مفقودة: archiveToICloud("${kind}") — تصدير هذا المستند لن يُؤرشف`
    );
  }
  // ملاحظة: `return_invoice` يُمرَّر عبر متغيّر لا حرفياً، ويحرسه فحص المرتجع أعلاه.
  const viaOptions = ["account_statement", "receivables_report", "stock_report", "purchase_invoice"];
  for (const kind of viaOptions) {
    assert.ok(
      appJs.includes(`docType: "${kind}"`),
      `نقطة ربط مفقودة: docType "${kind}"`
    );
  }
  // الوسيطان اللذان يمرّ منهما باقي المستندات.
  assert.match(appJs, /async function exportReportPdf\(bodyHtml, filename, archive\)/);
  assert.match(appJs, /if \(options\.archive && options\.archive\.docType\)/);
});

await test("index.html: CSP يسمح بأصل واحد محلي فقط بلا wildcard ولا منافذ إضافية", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const csp = html.match(/content="default-src[^"]*"/);
  assert.ok(csp, "وسم CSP مفقود");
  const connectSrc = csp[0].match(/connect-src([^;]*);/);
  assert.ok(connectSrc, "connect-src مفقود");
  const httpSources = connectSrc[1].trim().split(/\s+/).filter((s) => s.startsWith("http://"));
  // قرار المالك 2026-08-31: أصل محلي واحد بالضبط، لا localhost ولا منفذ ثانٍ.
  assert.deepEqual(httpSources, ["http://127.0.0.1:8787"], "connect-src: " + httpSources.join(" "));
  assert.ok(!/\*/.test(connectSrc[1].replace("https://*.supabase.co", "")), "ممنوع أي wildcard غير Supabase");
  assert.ok(/src\/icloud-archive\.js/.test(html), "عميل الأرشفة غير محمّل");
  // العميل يجب أن يخاطب العنوان نفسه المسموح به بالضبط.
  const client = readFileSync(new URL("../src/icloud-archive.js", import.meta.url), "utf8");
  assert.ok(/var BASE = "http:\/\/127\.0\.0\.1:8787"/.test(client), "عنوان العميل لا يطابق CSP");
});

await test("serve.mjs: المضيف قابل للضبط والافتراضي لم يتغيّر (ويندوز سليم)", () => {
  const serve = readFileSync(new URL("../scripts/serve.mjs", import.meta.url), "utf8");
  // الافتراضي 0.0.0.0 شرط بقاء ويندوز يخدم أجهزة الشبكة كما كان.
  assert.match(serve, /process\.env\.HOST \|\| "0\.0\.0\.0"/, "الافتراضي يجب أن يبقى 0.0.0.0");
  assert.match(serve, /server\.listen\(requestedPort, requestedHost/, "المضيف يجب أن يُمرَّر فعلياً");
  assert.ok(!/listen\([^,]*, "0\.0\.0\.0"/.test(serve), "لا يجوز تثبيت المضيف نصياً بعد الآن");
});

await test("مرافق الماك: خدمتان تعملان عند تسجيل الدخول والموقع محصور بالاسترجاع", () => {
  const sh = readFileSync(new URL("../tools/mac-archive-bridge/install-launch-agent.sh", import.meta.url), "utf8");
  assert.match(sh, /com\.ozk\.archive-bridge/);
  assert.match(sh, /com\.ozk\.local-site/);
  assert.match(sh, /<key>RunAtLoad<\/key>\s*\n\s*<true\/>/, "يجب أن تبدأ مع تسجيل الدخول");
  assert.match(sh, /<key>KeepAlive<\/key>/, "يجب أن تعود بعد الانهيار");
  // الموقع المحلي على الماك لا يُعرَض على الشبكة إطلاقاً.
  assert.match(sh, /<key>HOST<\/key>\s*\n\s*<string>127\.0\.0\.1<\/string>/, "الموقع المحلي يجب أن يكون على الاسترجاع فقط");
  // مجلد العمل خارج ~/Documents (وإلا تجمّد Node عند getcwd — قياس 2026-08-31).
  assert.match(sh, /<key>WorkingDirectory<\/key>\s*\n\s*<string>\$DATA_DIR<\/string>/);
  assert.ok(!/WorkingDirectory<\/key>\s*\n\s*<string>\$REPO_DIR/.test(sh), "مجلد العمل يجب ألا يكون داخل المستودع");
});

await test("أصل المرافق المحلي مسموح في قائمة الجسر", async () => {
  const { DEFAULT_CONFIG } = await import("../tools/mac-archive-bridge/lib/config.mjs");
  assert.ok(DEFAULT_CONFIG.allowedOrigins.includes("http://127.0.0.1:5173"));
  assert.ok(DEFAULT_CONFIG.allowedOrigins.includes("http://localhost:5173"));
  assert.ok(DEFAULT_CONFIG.allowedOrigins.every((o) => /^https:\/\/|^http:\/\/(127\.0\.0\.1|localhost):/.test(o)),
    "لا يجوز أصل http غير محلي في القائمة");
});

await test("عميل الواجهة لا يحوي أي سر مكتوب", () => {
  const client = readFileSync(new URL("../src/icloud-archive.js", import.meta.url), "utf8");
  assert.ok(!/[0-9a-f]{32,}/i.test(client), "لا يجوز وجود رمز مكتوب داخل الواجهة");
  assert.ok(client.includes("127.0.0.1"), "العنوان يجب أن يكون محلياً");
});

// ===== النتيجة =====

server.close();
await closeBrowser();
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* تنظيف أفضل جهد */ }

console.log("فحص جسر الأرشفة إلى iCloud (macOS):");
console.log(results.join("\n"));
if (failed) {
  console.error(`\n✗ فشل ${failed} فحصاً.`);
  process.exit(1);
}
console.log("\n✓ كل فحوص جسر الأرشفة نجحت.");
