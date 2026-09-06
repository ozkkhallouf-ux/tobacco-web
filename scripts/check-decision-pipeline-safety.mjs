// ============================================================================
// يثبّت الضمانات التشغيلية التي كشف تدقيق 2026-09-06 غيابها. كل تأكيد هنا يمنع
// عودة عطل وقع فعلاً، لا عطلاً متخيَّلاً.
// ============================================================================
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (relative) => fs.readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

let passed = 0;
function check(label, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${label}`);
}

// ------------------------------------------------- لقطة الأصناف: إيقاع وصوت
const snapshotProducer = read("tools/push-purchase-item-snapshot.ps1");
const snapshotTask = read("tools/register-purchase-item-snapshot-task.ps1");

check("فشل تحديث اللقطة يرفع تنبيهاً ولا يمر بصمت", () => {
  assert.match(snapshotProducer, /send-telegram-notification\.ps1/,
    "المولّد لا يستدعي قناة التنبيه");
  assert.match(snapshotProducer, /exit \$exitCode/,
    "رمز الخروج الحقيقي لا يُمرَّر إلى المجدول");
  assert.match(snapshotProducer, /snapshot-refresh-failed/,
    "لا مفتاح منع تكرار للتنبيه");
});

check("المولّد يسجّل كل تشغيل في ملف سجل", () => {
  assert.match(snapshotProducer, /Write-SnapshotLog/);
  assert.match(snapshotProducer, /purchase-item-snapshot\.log/);
});

check("مهمة اللقطة تتكرر خلال اليوم ولا تعتمد على تشغيل يومي واحد", () => {
  assert.match(snapshotTask, /RepetitionInterval/,
    "المشغّل ما زال يومياً بلا تكرار — أي رفض يجمّد اللقطة 24 ساعة");
  assert.match(snapshotTask, /IntervalHours/);
  assert.doesNotMatch(snapshotTask, /\$DailyAt/,
    "بقي البارامتر اليومي القديم");
});

check("مدّة التكرار تستعمل الصيغة التي يقبلها Task Scheduler", () => {
  // [timespan]::MaxValue يرفضه Task Scheduler عند التسجيل فلا تُنشأ المهمة
  // إطلاقاً — عطل صامت يُبطل الإصلاح كله. السابقة المعتمدة في المستودع:
  // register-ameen-sync-watchdog.ps1 يضبط Repetition.Duration = "".
  for (const file of [
    "tools/register-purchase-item-snapshot-task.ps1",
    "tools/register-supplier-obligations-task.ps1"
  ]) {
    const body = read(file);
    assert.doesNotMatch(body, /-RepetitionDuration\s*\(\[timespan\]::MaxValue\)/,
      `${file} يستعمل MaxValue الذي يرفضه Task Scheduler`);
    assert.match(body, /\$trigger\.Repetition\.Duration\s*=\s*""/,
      `${file} لا يضبط مدّة تكرار لا نهائية بالصيغة المدعومة`);
  }
});

// ------------------------------------------- التزامات الموردين: لا مسح صامت
const obligationsProducer = read("tools/push-supplier-obligations.ps1");
const obligationsTask = read("tools/register-supplier-obligations-task.ps1");

check("قراءة فارغة من الأمين لا تمسح التزامات قائمة", () => {
  assert.match(obligationsProducer, /AllowEmpty/,
    "لا يوجد إذن صريح مطلوب للمسح على صفر صفوف");
  assert.match(obligationsProducer, /allRows\.Count -eq 0/,
    "لا حارس على قراءة فارغة تماماً");
  assert.match(obligationsProducer, /Refusing to touch Supabase/);
});

check("المهمة المجدولة لا تملك صلاحية تفريغ الجدول", () => {
  // الفحص على سطر الوسائط المُمرَّرة فعلاً، لا على نص الملف كله: ذكر العَلَم في
  // تعليق يشرح سبب استبعاده ليس تمريراً له.
  // PowerShell يهرّب علامة الاقتباس داخل النص بعلامة خلفية (`")، فالسطر كاملاً
  // هو وحدة الفحص الصحيحة لا محتوى أول اقتباسين.
  const argumentsLine = /^\s*\$arguments\s*=.*$/m.exec(obligationsTask);
  assert.ok(argumentsLine, "تعذّر العثور على سطر وسائط المهمة");
  assert.doesNotMatch(argumentsLine[0], /-AllowEmpty/,
    "المهمة المجدولة تمرّر -AllowEmpty — المسح الآلي ممنوع");
  assert.match(argumentsLine[0], /\$scriptPath/, "سطر الوسائط لا يشير إلى المنتج");
  assert.match(argumentsLine[0], /-Apply/);
  // ‏$scriptPath نفسه يجب أن يكون منتج الالتزامات لا سكريبتاً آخر.
  assert.match(obligationsTask, /\$scriptPath\s*=.*push-supplier-obligations\.ps1/,
    "المهمة تشير إلى منتج غير متوقّع");
});

check("مهمة التزامات الموردين مسجّلة الآن (كانت غائبة تماماً)", () => {
  const files = fs.readdirSync(new URL("../tools/", import.meta.url));
  assert.ok(files.includes("register-supplier-obligations-task.ps1"),
    "سكريبت تسجيل مهمة الموردين ما زال غير موجود");
});

check("مصدر الأرصدة يجلب دفعات تكفي نافذة الزخم", () => {
  const sql = read("tools/ameen-customer-balances-query.sql");
  const match = /select\s+top\s+(\d+)\s+cast\(en\.Credit/i.exec(sql);
  assert.ok(match, "تعذّر العثور على سقف الدفعات في استعلام الأرصدة");
  assert.ok(Number(match[1]) >= 40,
    `سقف الدفعات ${match[1]} لا يغطي نافذة 90 يوماً — الزخم يُحسب على سجل مقتطع`);
});

check("الترحيلة المقترحة تسمح بتفريغ مأذون ولا ترفضه مطلقاً", () => {
  const sql = read("supabase/proposed/03-supplier-obligations-unique-key.sql");
  assert.match(sql, /p_allow_empty/,
    "لا إذن صريح بالاستبدال الفارغ — مورد سدّد آخر دَين يبقى ظاهراً");
  assert.match(sql, /delete from public\.supplier_obligations t?\s*\n?\s*where t?\.?source = p_source\s*\n?\s*and not exists/,
    "لا حذف لما ليس في الجيل الحالي — upsert وحده يُبقي دَيناً على من سدّد");
});

// ------------------------------------------------- الأمين للقراءة فقط
check("سكريبتات هذا الإصلاح لا تكتب على قاعدة الأمين", () => {
  for (const file of ["tools/push-supplier-obligations.ps1", "tools/push-purchase-item-snapshot.ps1"]) {
    const body = read(file);
    // الاستعلامات على الأمين قراءة فقط؛ أي كتابة تحتاج قراراً منفصلاً معلَناً.
    assert.doesNotMatch(body, /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b(?![^\n]*rest\/v1)/i,
      `${file} يحتوي عبارة كتابة على SQL`);
  }
});

check("لا التزام مالي مُلفَّق من تقرير فواتير الشراء", () => {
  const engine = read("src/decision-engine.js");
  // التقرير يجمّع بالاسم بلا معرّف، ولا فاتورة فيه تحمل paidAmount، ويحمل
  // مرتجعات بعلم isReturn — فأي رقم يُشتقّ منه التزاماً يكون مبنياً على عدم.
  assert.doesNotMatch(engine, /purchaseReportObligations/,
    "عاد الارتداد المالي المُلفَّق من تقرير الفواتير");
  assert.doesNotMatch(engine, /currency:\s*"USD"/,
    "عملة مثبَّتة يدوياً في اشتقاق التزام");
  assert.match(engine, /obligationsState/,
    "لا إعلان صريح عن حالة مصدر الالتزامات");
});

// ------------------------------------------------- تسجيل الأصول في الواجهة
check("نواة التقييم مسجّلة في الصفحة وعامل الخدمة", () => {
  assert.match(read("index.html"), /src\/decision-scoring\.js\?v=tobacco-/,
    "decision-scoring.js بلا معامل نسخة في index.html");
  assert.match(read("public/service-worker.js"), /"src\/decision-scoring\.js"/,
    "decision-scoring.js غير مُخزَّن في عامل الخدمة");
});

check("المحرّك يمرّ عبر النواة ولا يعيد بناء معادلة خاصة", () => {
  const engine = read("src/decision-engine.js");
  assert.match(engine, /ozkDecisionScoring/);
  // المعادلة القديمة: نفاد + أي بيع ⟵ 100 مباشرة.
  assert.doesNotMatch(engine, /score\s*=\s*100/,
    "بقيت درجة ثابتة 100 داخل المحرّك");
  assert.match(engine, /snapshotBanner/,
    "لا حارس لقِدَم اللقطة في العرض");
});

check("الجسر يطابق بالمعرّف لا بالاسم", () => {
  const bridge = read("src/decision-data-bridge.js");
  assert.match(bridge, /byGuid/, "الجسر لا يبني فهرساً بالمعرّف");
  assert.match(bridge, /nameCollisions/,
    "الجسر لا يحمي من تصادم الأسماء");
});

console.log(`\ncheck-decision-pipeline-safety: اجتاز ${passed} فحصاً.`);
