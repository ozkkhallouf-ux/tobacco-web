// ============================================================================
// عقد ربط «ذكاء الزبائن» بالمشروع.
//
// الحارس الأول (check-customer-intelligence.mjs) يثبت أن الحساب صحيح. هذا
// الحارس يثبت أن الشاشة موصولة فعلاً، ومحصورة بالمالك، وأنها لا تعيد بناء أي
// قاعدة تجارية بنفسها — العطل المتكرر في هذا المستودع هو «ملف موجود ولا يعمل»
// أو «منطق تكرّر بنسختين تتباعدان».
// ============================================================================
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const indexHtml = read("index.html");
const appJs = read("src/app.js");
const engineJs = read("src/customer-intelligence.js");
const viewJs = read("src/customer-intelligence-view.js");
const serviceWorker = read("public/service-worker.js");

const ROUTE = "customerIntel";

// ---------------------------------------------------------------------------
// 1) الأصول الثلاثة محمّلة في index.html بترتيب صحيح ومع معامل النسخة
// ---------------------------------------------------------------------------
for (const asset of ["src/customer-intelligence.css", "src/customer-intelligence.js", "src/customer-intelligence-view.js"]) {
  assert.ok(indexHtml.includes(asset), `index.html لا يحمّل ${asset} — الميزة لن تعمل عند المستخدم`);
  // الأصل الجديد يحتاج `?v=tobacco-N` يدوياً مرة واحدة: خطوة النشر تستبدل
  // المعامل الموجود ولا تضيفه، فأصل بلا معامل يبقى بعنوان ثابت ويُخدَم من كاش
  // HTTP القديم بعد كل نشر (CLAUDE.md القاعدة ١).
  const pattern = new RegExp(`${asset.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\?v=tobacco-\\d+`);
  assert.match(indexHtml, pattern, `${asset} بلا معامل نسخة في index.html — سيُخدَم من كاش قديم بعد كل نشر`);
}

const enginePos = indexHtml.indexOf("src/customer-intelligence.js?");
const viewPos = indexHtml.indexOf("src/customer-intelligence-view.js?");
const appPos = indexHtml.indexOf("src/app.js?");
const commandPos = indexHtml.indexOf("src/command-center.js?");
assert.ok(enginePos < appPos, "محرك الحساب يجب أن يُحمَّل قبل app.js");
assert.ok(viewPos > appPos, "الواجهة تعتمد على globals من app.js فيجب تحميلها بعده");
assert.ok(viewPos > commandPos, "الواجهة تغلّف render بعد command-center.js وإلا ابتلع أحدهما الآخر");

// ---------------------------------------------------------------------------
// 2) كاش PWA يعرف الملفات الجديدة (وإلا انكسرت الشاشة دون اتصال)
// ---------------------------------------------------------------------------
for (const asset of ["src/customer-intelligence.js", "src/customer-intelligence-view.js", "src/customer-intelligence.css"]) {
  assert.ok(serviceWorker.includes(`"${asset}"`), `public/service-worker.js لا يُخزّن ${asset} مسبقاً`);
}

// ---------------------------------------------------------------------------
// 3) المسار للمالك فقط — بيانات أرصدة ومبيعات الزبائن لا تُعرض لغيره
// ---------------------------------------------------------------------------
const ownerRoutes = appJs.match(/const OWNER_ONLY_ROUTES = new Set\(\[([^\]]*)\]\)/);
assert.ok(ownerRoutes, "OWNER_ONLY_ROUTES غير موجودة في src/app.js");
assert.ok(ownerRoutes[1].includes(`"${ROUTE}"`), `المسار ${ROUTE} يجب أن يكون ضمن OWNER_ONLY_ROUTES`);

// canAccessRoute يبني على accessRole المشتق من الخادم، لا على user_metadata
assert.ok(appJs.includes("function canAccessRoute"), "canAccessRoute غير موجودة");
assert.ok(!/user_metadata/.test(viewJs), "الواجهة يجب ألا تشتق صلاحية من user_metadata");
assert.ok(!/user_metadata/.test(engineJs), "المحرك يجب ألا يشتق صلاحية من user_metadata");

// كل مسار عرض في الواجهة محروس بنفس البوابة
const guardCount = (viewJs.match(/ozkCanAccessRoute\?\.\(ROUTE\)/g) || []).length;
assert.ok(guardCount >= 4, `الواجهة تفحص صلاحية المالك في ${guardCount} موضع فقط — العرض والتحميل والمؤقت والتنقل كلها تحتاج الحراسة`);
assert.ok(/if \(!window\.ozkCanAccessRoute\?\.\(ROUTE\)\) return shell\(/.test(viewJs),
  "دالة العرض يجب أن ترفض غير المالك قبل بناء أي محتوى");
assert.ok(/if \(loading \|\| !state\?\.session \|\| !window\.ozkCanAccessRoute\?\.\(ROUTE\)\) return;/.test(viewJs),
  "دالة الجلب يجب أن ترفض غير المالك قبل أي طلب بيانات");

// عنوان الصفحة معرّف، وإلا ظهرت "undefined" في الترويسة
assert.ok(/customerIntel: "/.test(appJs), "عنوان صفحة ذكاء الزبائن غير معرّف في pageTitle");

// ---------------------------------------------------------------------------
// 4) لا مفاتيح خدمة ولا وصول مباشر للجداول من الواجهة
// ---------------------------------------------------------------------------
for (const name of ["service_role", "SERVICE_ROLE", "service-role", "sb_secret"]) {
  assert.ok(!viewJs.includes(name), `الواجهة تحوي أثراً لمفتاح خدمة: ${name}`);
  assert.ok(!engineJs.includes(name), `المحرك يحوي أثراً لمفتاح خدمة: ${name}`);
}
assert.ok(!/\.from\(/.test(viewJs), "الواجهة يجب أن تمرّ عبر دوال tobaccoData القائمة لا عبر استعلام جدول مباشر");

// الواجهة تستهلك دوال الوصول الموجودة فقط — لا مصدر بيانات جديد بلا RLS معروف
for (const accessor of ["getCustomerInvoicesReport", "listCustomerBalanceReports", "getCustomerMovementsReport", "listCustomerCreditLimits"]) {
  assert.ok(viewJs.includes(accessor), `الواجهة لا تستعمل ${accessor}`);
  assert.ok(read("src/supabase-client.js").includes(accessor), `${accessor} غير موجودة في supabase-client.js`);
}

// ---------------------------------------------------------------------------
// 5) لا ازدواج في القواعد التجارية: الواجهة تعرض ولا تحسب
// ---------------------------------------------------------------------------
for (const rule of ["0.9", "declineTrendPercent:", "vipTopShare:", "inactiveGapMultiplier:", "inactiveFallbackDays:"]) {
  assert.ok(engineJs.includes(rule), `المحرك يجب أن يملك القاعدة ${rule}`);
}
// إسناد (وليس مقارنة) لأي حقل محسوب داخل الواجهة يعني قاعدة ثانية تتباعد.
for (const field of ["netSales30d", "netSalesPrevious30d", "creditUsagePercent", "primarySegment", "riskScore", "vipRank", "flags"]) {
  const assignment = new RegExp(`\\b${field}\\s*=(?!=)`);
  assert.doesNotMatch(viewJs, assignment, `الواجهة تُسنِد ${field} — القاعدة التجارية يجب أن تبقى في المحرك وحده`);
}
// والعتبات المعروضة للمستخدم تُقرأ من إعدادات المحرك، لا تُكتب رقماً ثانياً
// في نص الواجهة (وإلا عُرض للمالك رقم لا يطابق ما حسبته الطبقة الحتمية).
for (const setting of ["config.vipTopShare", "config.declineTrendPercent"]) {
  assert.ok(viewJs.includes(`intel.${setting}`), `الواجهة يجب أن تعرض ${setting} من إعدادات المحرك لا كرقم مكتوب`);
}

// ---------------------------------------------------------------------------
// 6) الميزة قراءة-فقط تجاه الأمين وقاعدة البيانات
// ---------------------------------------------------------------------------
for (const source of [engineJs, viewJs]) {
  for (const write of [".insert(", ".update(", ".upsert(", ".delete(", "AMEEN_SQL"]) {
    assert.ok(!source.includes(write), `ذكاء الزبائن ميزة قراءة فقط — وُجد ${write}`);
  }
}

// ---------------------------------------------------------------------------
// 7) عتبات الحداثة مطابقة لمراقب المهام (مصدر واحد للحقيقة)
// ---------------------------------------------------------------------------
const monitorSql = read("supabase/project-task-health-monitor.sql");
for (const [source, minutes] of [["ameen_customer_balances", 10], ["ameen_customer_movements", 30], ["ameen_customer_invoices", 90]]) {
  const row = monitorSql.match(new RegExp(`'${source}',(\\d+)`));
  assert.ok(row, `مراقب المهام لا يعرف المصدر ${source}`);
  assert.equal(
    Number(row[1]),
    minutes,
    `تغيّرت عتبة حداثة ${source} في project-task-health-monitor.sql (${row[1]} دقيقة) — حدّث CONFIG.freshnessMinutes معها`
  );
}
const freshnessBlock = engineJs.match(/freshnessMinutes: Object\.freeze\(\{([^}]*)\}\)/);
assert.ok(freshnessBlock, "CONFIG.freshnessMinutes غير موجودة في المحرك");
for (const [key, minutes] of [["balances", 10], ["movements", 30], ["invoices", 90]]) {
  assert.match(freshnessBlock[1], new RegExp(`${key}:\\s*${minutes}\\b`),
    `CONFIG.freshnessMinutes.${key} يجب أن تساوي ${minutes} دقيقة كما في مراقب المهام`);
}

// ---------------------------------------------------------------------------
// 8) قاعدة الائتمان لا تتناقض مع business-snapshot.js القائمة
// ---------------------------------------------------------------------------
const snapshotJs = read("src/business-snapshot.js");
assert.ok(snapshotJs.includes("ratio >= 0.9"), "تغيّرت عتبة القرب من الحد في business-snapshot.js");
assert.ok(engineJs.includes("nearLimitRatio: 0.9"), "عتبة القرب من الحد في ذكاء الزبائن يجب أن تبقى 0.9 كما في business-snapshot.js");
assert.ok(engineJs.includes('creditLimitSource = approved !== null ? "approved" : ameenLimit !== null ? "ameen" : "missing"'),
  "ترتيب مصدر حد الائتمان يجب أن يبقى: معتمد ← الأمين ← غير محدد");

// ---------------------------------------------------------------------------
// 9) التطبيع مشترك مع app.js وسكربت المزامنة (وإلا انكسر الربط بالاسم)
// ---------------------------------------------------------------------------
const engineNormalizer = engineJs.match(/function normalizeName\(value\) \{([\s\S]*?)\n  \}/);
const appNormalizer = appJs.match(/function normalizeItemName\(value\) \{([\s\S]*?)\n\}/);
assert.ok(engineNormalizer && appNormalizer, "تعذّر استخراج دالتَي التطبيع للمقارنة");
for (const step of ['replace(/[إأآٱ]/gu, "ا")', 'replace(/ى/gu, "ي")', 'replace(/ة/gu, "ه")', 'replace(/[^\\p{L}\\p{N}]+/gu, " ")', "toLowerCase()"]) {
  assert.ok(engineNormalizer[1].includes(step), `تطبيع ذكاء الزبائن ينقصه ${step}`);
  assert.ok(appNormalizer[1].includes(step), `تطبيع app.js ينقصه ${step} — تباعد المفتاحان`);
}

// ---------------------------------------------------------------------------
// 10) مزامنة الفواتير تبقى قراءة-فقط وتحمل هوية الزبون من الأمين
// ---------------------------------------------------------------------------
{
  const raw = readFileSync(new URL("../tools/push-customer-invoices.ps1", import.meta.url));
  assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf],
    "push-customer-invoices.ps1 يجب أن يبدأ بـUTF-8 BOM ليُقرأ صحيحاً على PowerShell 5.1");
  const ps1 = raw.toString("utf8");

  // الأمين مصدر محاسبي للقراءة فقط في هذا المسار — أي كتابة عليه عطل جسيم.
  for (const write of ["INSERT INTO", "UPDATE ", "DELETE FROM", "MERGE ", "DROP ", "ExecuteNonQuery"]) {
    assert.ok(!ps1.toUpperCase().includes(write.toUpperCase()),
      `مزامنة فواتير الزبائن قراءة فقط من الأمين — وُجد ${write}`);
  }

  // الهوية والعملة ومعرّف المادة: بدونها يعود الربط إلى الاسم وحده.
  for (const contract of ["$custGuidCol = Pick $buCols", "$custGuidSel AS customer_guid", "$currencyIsoSel AS currency_iso",
    "LOWER(CAST(m.GUID AS varchar(40))) AS item_guid", "customerGuid = $b.customerGuid", "payloadVersion = 2"]) {
    assert.ok(ps1.includes(contract), `push-customer-invoices.ps1 ينقصه عقد الهوية: ${contract}`);
  }
  // معرّف المجموعة لا يُملأ إلا باتفاق كل فواتيرها — وإلا دُمج زبونان باسم واحد.
  assert.ok(ps1.includes('$groupGuid = if ($groupGuids.Count -eq 1) { $groupGuids[0] } else { "" }'),
    "معرّف المجموعة يجب أن يبقى فارغاً عند اختلاف معرّفات فواتيرها");

  // والمحرك يقرأ هذه الحقول فعلاً (وإلا كانت المزامنة ترفع ما لا يُستعمل).
  for (const field of ["customerGuid", "customer_guid", "itemGuid", "item_guid", "invoice?.currency"]) {
    assert.ok(engineJs.includes(field), `المحرك لا يقرأ الحقل ${field} الذي ترفعه المزامنة`);
  }
}

console.log(`ربط ذكاء الزبائن: 10 عقود محسومة — المسار ${ROUTE} للمالك فقط، والأصول محمّلة ومخزّنة مسبقاً.`);
