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

check("أول تشغيل افتراضي بعد منتصف الليل يترك هامشاً لمزامنة المبيعات", () => {
  // 00:07 كان يسبق أول دورة sales بعد لفّ النافذة → تنبيه تيليغرام وهمي.
  assert.match(snapshotTask, /\$StartAt\s*=\s*"00:40"/);
  assert.doesNotMatch(snapshotTask, /\$StartAt\s*=\s*"00:07"/);
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

check("قراءة فارغة تماماً من الأمين لا تمسّ Supabase إطلاقاً", () => {
  // أسماء متغيّرات PowerShell غير حساسة لحالة الأحرف، فالفحص كذلك: الحارس
  // انتقل إلى Get-SupplierObligationsPlan بوسيط $AllRows وهو المتغيّر نفسه.
  assert.match(obligationsProducer, /allRows\.Count -eq 0/i,
    "لا حارس على قراءة فارغة تماماً");
  assert.match(obligationsProducer, /Refusing to touch Supabase/);
  // الإجهاض مطلق: لا عَلَم ولا وسيط يتجاوز هذا الحارس.
  assert.match(obligationsProducer, /Action\s*=\s*"abort"/,
    "حارس القراءة الفارغة لا يُنتج خطة إجهاض صريحة");
});

check("الحالة النهائية المُتحقَّقة تُنشر ولا تُجهض", () => {
  // العطل الذي تصفه ملاحظة Codex P1: حين يسدّد آخر مورد تصبح الحمولة فارغة
  // بحق، وكان الرفض المطلق يُبقي أرصدة موجبة قديمة معروضة إلى الأبد — دَين على
  // من سدّد. الإذن هنا مشتقّ من دليل (القراءة أرجعت موردين) لا من عَلَم.
  assert.match(obligationsProducer, /verified terminal state/,
    "لا مسار صريح للحالة النهائية المُتحقَّقة");
  assert.match(obligationsProducer, /PayableRows\.Count -eq 0[\s\S]{0,400}AllowEmpty\s*=\s*\$true/i,
    "الحمولة الفارغة المُتحقَّقة لا تُصرّح بالاستبدال الفارغ");
  // وفي المقابل: حمولة غير فارغة لا تُصرّح بالتفريغ أبداً.
  assert.match(obligationsProducer, /AllowEmpty\s*=\s*\$false/,
    "لا حالة ترفض التفريغ صراحةً");
});

check("الكتابة ذرّية: نداء واحد، بلا حذف منفصل وبلا تقسيم دفعات", () => {
  // العطل: delete-then-insert يترك نافذة يكون فيها الجدول فارغاً، وانقطاع
  // داخلها يمسح الالتزامات المالية. والتقسيم إلى دفعات يكسر الذرّية نفسها لأن
  // كل نداء يحذف ما ليس في دفعته هو.
  assert.match(obligationsProducer, /rest\/v1\/rpc\/\$REPLACE_RPC/,
    "المنتج لا ينشر عبر دالة الاستبدال الذرّي");
  assert.match(obligationsProducer, /\$REPLACE_RPC\s*=\s*"replace_supplier_obligations"/,
    "المنتج لا يستهدف replace_supplier_obligations");
  assert.doesNotMatch(obligationsProducer, /-Method\s+Delete/i,
    "بقي حذف REST منفصل — عادت نافذة الفراغ");
  assert.doesNotMatch(obligationsProducer, /\$batchSize/,
    "الحمولة ما زالت تُقسَّم دفعات — الذرّية مكسورة");
});

check("بوابة التفعيل في المنتج نفسه، فتغطي كل مُنادٍ لا سكريبت التسجيل وحده", () => {
  // ملاحظة Codex P1 (2026-09-14، صحيحة): tools/ameen-sync-agent.ps1 ينادي
  // push-supplier-obligations.ps1 بـ-Apply داخل Sync-Once، ووتيرة تلك المهمة
  // دقيقة واحدة. فحارس على سكريبت التسجيل وحده كان حارساً على باب لا يمرّ منه
  // أحد: لحظة تطبيق ترحيلة 03 كانت حلقة الدقيقة ستنشر الجيل وتقاعد المصدر
  // القديم خلال خمس دقائق، بلا تشغيل جاف ولا قرار بشري.
  const agent = read("tools/ameen-sync-agent.ps1");
  assert.match(agent, /push-supplier-obligations\.ps1["']?\s+-Apply/,
    "افتُرض هنا وجود مُنادٍ آخر للمنتج؛ إن زال فحدّث هذا الفحص بدل حذفه");

  assert.match(obligationsProducer, /\$Activate/,
    "لا مفتاح تفعيل دائم في المنتج");
  assert.match(obligationsProducer, /function Get-SupplierObligationsActivation/,
    "بوابة التفعيل ليست دالة نقية قابلة للاختبار");
  // الحارس على -Apply نفسه، قبل أي مصادقة أو كتابة.
  assert.match(obligationsProducer, /if \(\$Apply\)[\s\S]{0,400}Get-SupplierObligationsActivation/,
    "المنتج لا يحرس -Apply بالتفعيل");
  assert.match(obligationsProducer, /Skipped \(not activated\)/,
    "التشغيل غير المفعَّل لا يعلن تخطّيه");
  // التخطّي لا يكون فشلاً: خروج غير صفري كل دقيقة يغرق سجل الوكيل بفشل كاذب.
  assert.match(obligationsProducer, /Skipped \(not activated\)[\s\S]{0,120}exit 0/,
    "التشغيل غير المفعَّل يخرج برمز فشل — إغراق سجل وكيل المزامنة كل دقيقة");
});

check("المهمة لا تُسجَّل قبل أن يصبح المسار ذرّياً والترحيلة مطبَّقة", () => {
  const argumentsLine = /^\s*\$arguments\s*=.*$/m.exec(obligationsTask);
  assert.ok(argumentsLine, "تعذّر العثور على سطر وسائط المهمة");
  assert.match(argumentsLine[0], /\$scriptPath/, "سطر الوسائط لا يشير إلى المنتج");
  assert.match(argumentsLine[0], /-Apply/);
  // ‏$scriptPath نفسه يجب أن يكون منتج الالتزامات لا سكريبتاً آخر.
  assert.match(obligationsTask, /\$scriptPath\s*=.*push-supplier-obligations\.ps1/,
    "المهمة تشير إلى منتج غير متوقّع");
  // بوابة التسجيل: تأكيد صريح أن الترحيلة حيّة، وتحقّق ساكن على الملف الإنتاجي.
  assert.match(obligationsTask, /\$AtomicReplacementApplied/,
    "لا بوابة تمنع جدولة كاتب قبل تطبيق دالة الاستبدال");
  assert.match(obligationsTask, /if \(-not \$AtomicReplacementApplied\)[\s\S]{0,200}throw/,
    "بوابة الترحيلة لا ترفض التسجيل فعلياً");
  assert.match(obligationsTask, /-Method\\s\+Delete/,
    "التسجيل لا يتحقق من غياب الحذف المنفصل في المنتج");
  assert.match(obligationsTask, /\$batchSize/,
    "التسجيل لا يتحقق من غياب تقسيم الدفعات في المنتج");
  // ولا يُسجَّل شيء قبل التفعيل: مهمة بلا تفعيل تتخطّى كل تشغيل بصمت.
  assert.match(obligationsTask, /supplier-obligations-activated\.txt/,
    "التسجيل لا يشترط علامة التفعيل الدائمة");
});

check("مهمة التزامات الموردين مسجّلة الآن (كانت غائبة تماماً)", () => {
  const files = fs.readdirSync(new URL("../tools/", import.meta.url));
  assert.ok(files.includes("register-supplier-obligations-task.ps1"),
    "سكريبت تسجيل مهمة الموردين ما زال غير موجود");
});

check("مصدر الأرصدة يجلب دفعات تكفي نافذة الزخم ويعلن عددها الحقيقي", () => {
  const sql = read("tools/ameen-customer-balances-query.sql");
  const match = /select\s+top\s+(\d+)\s+cast\(en\.Credit/i.exec(sql);
  assert.ok(match, "تعذّر العثور على سقف الدفعات في استعلام الأرصدة");
  assert.ok(Number(match[1]) >= 40,
    `سقف الدفعات ${match[1]} لا يغطي نافذة 90 يوماً — الزخم يُحسب على سجل مقتطع`);
  // العدّاد القاطع: بدونه يبقى الاقتطاع استدلالاً يُنتج إنذارات كاذبة.
  assert.match(sql, /payments_in_window/,
    "الاستعلام لا يعلن عدد الدفعات الفعلي داخل النافذة");
  // الحدّ يُعلَن مع العدد، وإلا عدّ الطرفان بحدَّين مختلفين وظهرت فروقات كاذبة.
  assert.match(sql, /payments_window_start/,
    "الاستعلام لا يعلن حدّ النافذة الذي عدَّ به");
  const agent = read("tools/ameen-sync-agent.ps1");
  assert.match(agent, /paymentsInWindow/, "وكيل المزامنة لا يمرّر العدّاد");
  assert.match(agent, /paymentsWindowStart/, "وكيل المزامنة لا يمرّر حدّ النافذة");
  // الحدّ يُصدَّر بنفس دالة تواريخ الدفعات. تاريخ مجرّد "yyyy-MM-dd" يُقرأ في
  // المتصفح منتصفَ ليل UTC بينما الدفعات محلية، فتسقط دفعة يوم الحدّ في دمشق.
  assert.match(agent, /paymentsWindowStart\s*=\s*To-IsoDate/,
    "حدّ النافذة لا يُصدَّر بأساس تواريخ الدفعات نفسه");
  assert.doesNotMatch(agent, /paymentsWindowStart[^\n]*'yyyy-MM-dd'/,
    "حدّ النافذة يُصدَّر تاريخاً مجرّداً — انزياح منطقة زمنية");
});

check("الترحيلة تستبدل استبدالاً ذرّياً كاملاً بلا نافذة فراغ", () => {
  const sql = read("supabase/proposed/03-supplier-obligations-unique-key.sql");
  assert.match(sql, /p_allow_empty/,
    "لا إذن صريح بالاستبدال الفارغ — مورد سدّد آخر دَين يبقى ظاهراً");
  assert.match(sql, /delete from public\.supplier_obligations t?\s*\n?\s*where t?\.?source = p_source\s*\n?\s*and not exists/,
    "لا حذف لما ليس في الجيل الحالي — upsert وحده يُبقي دَيناً على من سدّد");
  // الحمولة الفارغة بلا إذن لا تمسح شيئاً.
  assert.match(sql, /jsonb_array_length\(p_rows\) = 0 and not coalesce\(p_allow_empty, false\)[\s\S]{0,200}raise exception/,
    "حمولة فارغة بلا إذن قد تمسح جيلاً قائماً");
  // الترتيب هو الضمانة: الإدراج/التحديث أولاً ثم حذف ما ليس في الجيل — فلا لحظة
  // يكون فيها الجدول محذوفاً قبل كتابة البديل. العكس يعيد نافذة الفراغ نفسها
  // التي وُجدت الترحيلة لإزالتها، ولو داخل معاملة.
  const insertAt = sql.indexOf("insert into public.supplier_obligations as t");
  const deleteOrphansAt = sql.indexOf("delete from public.supplier_obligations t");
  assert.ok(insertAt > 0, "لا إدراج للجيل الحالي");
  assert.ok(deleteOrphansAt > 0, "لا حذف لما ليس في الجيل الحالي");
  assert.ok(insertAt < deleteOrphansAt,
    "الحذف يسبق الإدراج — عادت نافذة يكون فيها الجيل محذوفاً قبل كتابة البديل");
  // القيد الفريد شرط الـupsert نفسه: بدونه لا معنى لـon conflict.
  assert.match(sql, /create unique index if not exists supplier_obligations_source_supplier_key/,
    "لا قيد فريد على (source, supplier_key) — on conflict بلا أساس");
  assert.match(sql, /on conflict \(source, supplier_key\) do update set/,
    "الإدراج لا يُحدّث الصفوف القائمة");
  // كل ذلك داخل معاملة واحدة.
  assert.match(sql, /^begin;/m, "الترحيلة بلا معاملة");
  assert.match(sql, /^commit;/m, "الترحيلة بلا إغلاق معاملة");
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

// ------------------------------------------- حارس العامل: لا ادّعاء غياب بلا schtasks
const ensureAmeen = read("tools/ensure-ameen-sync.ps1");
check("غياب Read Worker يُثبت بـschtasks قبل تنبيه «غير مسجّلة»", () => {
  assert.match(ensureAmeen, /schtasks\.exe \/Query \/TN \$ameenWorkerTaskName/);
  assert.match(ensureAmeen, /أثبت schtasks\.exe غيابها/);
  assert.match(ensureAmeen, /غير مرئية عبر Get-ScheduledTask رغم وجودها في schtasks/);
  assert.doesNotMatch(ensureAmeen, /غير مسجّلة أو متوقفة \(لا نبض\)/);
});
check("رفض الصلاحية على مهمة العامل لا يُقرأ «غير مسجّلة» ولا يُتجاوز", () => {
  assert.match(ensureAmeen, /\$workerTaskAccessDenied = \(\$schtasksExitCode -ne 0\) -and \(\$schtasksOut -match 'Access is denied\|0x80070005'\)/);
  assert.match(ensureAmeen, /\(-not \$workerTask\) -and \(-not \$heartbeatFreshEarly\) -and \(-not \$workerTaskAccessDenied\)/);
  assert.match(ensureAmeen, /RECOVERY SKIPPED: \$ameenWorkerTaskName not accessible to this account/);
  // لا رفع صلاحيات ولا تعديل ACL من الحارس.
  assert.doesNotMatch(ensureAmeen, /SetSecurityDescriptor|Set-Acl|runas|Start-Process[^\n]*-Verb/i);
});

console.log(`\ncheck-decision-pipeline-safety: اجتاز ${passed} فحصاً.`);
