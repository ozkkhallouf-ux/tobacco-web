// فحص انحدار للمحرّك الجديد لتوزيع مجموعات نشرة الأسعار على الأعمدة/الصفحات
// (packGroupsIntoBalancedPages / layoutGroupsMeasured في src/price-list-template.js).
// اختبار وحدة صِرف (Node بلا DOM) لأن الدوال المُختبَرة نقية: تأخذ Map ارتفاعات
// مُقاسة (حقيقية أو وهمية هنا) ولا تعتمد على document — هذا يجعل السيناريوهات
// القاسية (فراغ لا يتّسع، فراغ يتّسع بالضبط، مجموعة أطول من عمود كامل، تفاوت
// كبير بين عمودين) قابلة للتكرار بدقة بالبكسل دون تفاوت المتصفح.
import "../src/price-list-template.js";

const template = globalThis.OZKPriceListTemplate;
let failed = false;

function check(label, condition) {
  if (!condition) {
    console.error(`FAIL: ${label}`);
    failed = true;
  } else {
    console.log(`ok: ${label}`);
  }
}

function group(name) {
  return { name, items: [{ name, unit: "كرتونة", price: "$ 1.00" }] };
}

// --- سيناريو 1: فراغ لا يتّسع لمجموعة — يجب ألا توضع فيه، بل تنتقل للصفحة التالية ---
{
  const groups = [group("أ"), group("ب")];
  // usable لكل عمود = 1000-6=994؛ أ(900) تملأ العمود الأول، ب(200) لا تتّسع معه (900+200>994)
  // فتذهب لعمود ثانٍ (يسار) بنفس الصفحة لأنه لا يزال فارغاً ويتّسع لها بمفردها.
  const heights = new Map([["أ", 900], ["ب", 200]]);
  const { pages, oversized } = template.packGroupsIntoBalancedPages(groups, [], heights, { fullBudget: 1000 }, 6);
  check("فراغ لا يتّسع: العمود الأول يحوي المجموعة الأولى فقط", pages[0]?.right.length === 1 && pages[0].right[0].name === "أ");
  check("فراغ لا يتّسع: المجموعة الثانية انتقلت كاملة للعمود الآخر من نفس الصفحة", pages[0]?.left.length === 1 && pages[0].left[0].name === "ب");
  check("فراغ لا يتّسع: لا مجموعات مفقودة استثنائياً هنا", oversized.length === 0);
}

// --- سيناريو 2: فراغ يتّسع بالضبط (بعد خصم هامش الأمان) — كلا المجموعتين توضعان
// كاملتين بلا فقدان ولا فيضان؛ قاعدة التوازن قد تُعيد توزيعهما بين العمودين (هذا
// مقصود — عمود ممتلئ بجانب عمود فارغ تماماً هو بالضبط العطل الذي أصلحناه). ---
{
  const groups = [group("أ"), group("ب")];
  const budget = 1000;
  const safety = 6;
  const usable = budget - safety;
  const heights = new Map([["أ", usable - 50], ["ب", 50]]); // يملأ العمود الأول بالضبط حتى usable
  const { pages } = template.packGroupsIntoBalancedPages(groups, [], heights, { fullBudget: budget }, safety);
  const placed = pages.flatMap((p) => [...p.right, ...p.left]).map((g) => g.name).sort();
  check("فراغ يتّسع بالضبط: كلتا المجموعتين وُضعتا بصفحة واحدة بلا فقدان", pages.length === 1 && placed.join(",") === "أ,ب");
  check("فراغ يتّسع بالضبط: لا فيضان بأي عمود", pages[0].rightHeight <= usable + 1e-6 && pages[0].leftHeight <= usable + 1e-6);
  check("فراغ يتّسع بالضبط: الارتفاع التراكمي الكلي يساوي usable بالضبط", Math.abs(pages[0].rightHeight + pages[0].leftHeight - usable) < 1e-6);
}

// --- سيناريو 3: استغلال الفراغ — لا تُفقد أي مجموعة ولا تُقصّ، وقاعدة التوازن قد
// تنقل آخر مجموعة من العمود الأطول للأقصر لتفادي ترك عمود شبه فارغ بجانب عمود ممتلئ. ---
{
  const groups = [group("كبيرة"), group("صغيرة1"), group("صغيرة2")];
  const budget = 500;
  const heights = new Map([["كبيرة", 400], ["صغيرة1", 80], ["صغيرة2", 80]]);
  const { pages } = template.packGroupsIntoBalancedPages(groups, [], heights, { fullBudget: budget }, 6);
  // usable = 494؛ كبيرة(400) + صغيرة1(80) = 480 <= 494 تبقى بالعمود الأول ابتداءً؛
  // صغيرة2 (480+80=560>494 بالعمود الأول) تذهب للعمود الثاني من نفس الصفحة، ثم
  // قاعدة التوازن (الفارق 480 مقابل 80 يتجاوز العتبة) تنقل صغيرة1 للعمود الثاني
  // لأن ذلك يحسّن التوازن دون فيضان — سلوك مقصود، ليس عطلاً.
  const placed = [...(pages[0]?.right || []), ...(pages[0]?.left || [])].map((g) => g.name).sort();
  check("استغلال الفراغ: صفحة واحدة، المجموعات الثلاث وُضعت بلا فقدان ولا تكرار", pages.length === 1 && placed.join(",") === "صغيرة1,صغيرة2,كبيرة");
  check("استغلال الفراغ: لا فيضان بأي عمود بعد التوازن", pages[0].rightHeight <= 494 + 1e-6 && pages[0].leftHeight <= 494 + 1e-6);
  check("استغلال الفراغ: كبيرة بقيت بالعمود الأول (لم تُنقل، فقط آخر عنصر بالعمود الأطول يُنقل)", pages[0].right.some((g) => g.name === "كبيرة"));
}

// --- سيناريو 4: مجموعة أطول من عمود صفحة كامل — حالة استثنائية صريحة، لا قصّ صامت ---
{
  const groups = [group("عملاقة")];
  const heights = new Map([["عملاقة", 5000]]);
  const { pages, oversized } = template.packGroupsIntoBalancedPages(groups, [], heights, { fullBudget: 1000 }, 6);
  check("مجموعة أطول من صفحة كاملة: لم توضع في أي عمود", pages.every((p) => p.right.length === 0 && p.left.length === 0));
  check("مجموعة أطول من صفحة كاملة: رُصدت صراحة ضمن oversized", oversized.length === 1 && oversized[0].name === "عملاقة");
}

// --- سيناريو 5: لا كسر لأي مجموعة عبر عمودين/صفحات مهما تعددت الحالات ---
{
  const groups = Array.from({ length: 12 }, (_, i) => group(`صنف${i}`));
  const heights = new Map(groups.map((g, i) => [g.name, 90 + (i % 5) * 30]));
  const { pages } = template.packGroupsIntoBalancedPages(groups, [], heights, { fullBudget: 400 }, 6);
  const seen = new Set();
  pages.forEach((page) => [...page.right, ...page.left].forEach((g) => {
    check(`لا كسر: ${g.name} ظهرت في عمود واحد فقط`, !seen.has(g.name));
    seen.add(g.name);
  }));
  check("لا كسر: كل المجموعات وُزّعت (بلا فقدان صامت)", seen.size === groups.length);
}

// --- سيناريو 6: layoutGroupsMeasured يحترم ميزانية الصفحة الأولى الأصغر بسبب الرأس ---
{
  const groups = [{ name: "ماستر", items: [{ name: "أ", unit: "ك", price: "$1" }] }];
  const heights = new Map([["ماستر", 100]]);
  const layout = template.layoutGroupsMeasured(groups, heights, { pageWidthPx: 794, headerHeightPx: 1122, safetyMarginPx: 6 });
  // ميزانية صفحة1 = ارتفاع الصفحة(~1122) - الرأس(1122) = ~0، فالمجموعة (100px) تفيض لصفحة ثانية
  check("ميزانية الصفحة الأولى المخفّضة بالرأس: المجموعة انتقلت لصفحة تالية لا تُقصّ فوق الرأس",
    layout.mainPages.length >= 2 && layout.mainPages[1].right.some((g) => g.name === "ماستر"));
}

// --- سيناريو 7 (قاعدة التوازن — العطل الحقيقي المُبلَّغ من المستخدم): تصنيف علامة
// تجارية بمجموع ارتفاع "يمين" أصغر بكثير من "يسار" لم يعد يترك عموداً فارغاً
// كاملاً بينما الآخر يتكدّس عبر عدة صفحات؛ التوزيع يمتصّ الفارق تلقائياً. ---
{
  // 3 مجموعات RIGHT خفيفة جداً (900px إجمالاً) مقابل 9 مجموعات LEFT ثقيلة (900px لكل واحدة).
  const rightGroups = ["ماستر", "كابتن بلاك", "اوسكار"].map((name) => group(name));
  const leftGroups = ["غلواز", "اليغانس", "تي اس", "أوريس", "حمرا", "يونايتد", "ولسون", "نابولي", "زائدة"].map((name) => group(name));
  const groups = [...rightGroups, ...leftGroups];
  const heights = new Map([
    ...rightGroups.map((g) => [g.name, 300]),
    ...leftGroups.map((g) => [g.name, 900])
  ]);
  const layout = template.layoutGroupsMeasured(groups, heights, { pageWidthPx: 794, headerHeightPx: 0, safetyMarginPx: 6 });
  const emptyColumnWhileOtherFull = layout.mainPages.some((page) => {
    const rightEmpty = page.right.length === 0;
    const leftEmpty = page.left.length === 0;
    return (rightEmpty && page.left.length > 0) || (leftEmpty && page.right.length > 0);
  });
  check("قاعدة التوازن: لا صفحة فيها عمود فارغ تماماً بينما العمود الآخر ممتلئ", !emptyColumnWhileOtherFull);
  const totalPlaced = layout.mainPages.reduce((n, p) => n + p.right.length + p.left.length, 0);
  check("قاعدة التوازن: كل المجموعات (12) وُزّعت بلا فقدان", totalPlaced === groups.length);
  check("قاعدة التوازن: لا مجموعات استثنائية", layout.oversized.length === 0);
  // تثبيت صريح: "ماستر" يجب أن يبقى أول عنصر بالعمود اليمين و"غلواز" أول عنصر
  // بالعمود اليسار بالصفحة الأولى — هذا بالضبط العطل الذي أصلحناه (فيضان اليمين
  // كان يسبق وصول "غلواز" لبداية اليسار عبر طابور واحد مسطّح).
  check("تثبيت المستر: أول عنصر بيمين الصفحة الأولى هو ماستر", layout.mainPages[0]?.right[0]?.name === "ماستر");
  check("تثبيت الغلواز: أول عنصر بيسار الصفحة الأولى هو غلواز", layout.mainPages[0]?.left[0]?.name === "غلواز");
}

// --- سيناريو 8: قاعدة التوازن لا تنقل مجموعة إذا كان النقل سيسبب فيضاناً بالعمود الأقصر ---
{
  const groups = [group("أ"), group("ب")];
  const budget = 1000; // usable = 994
  // أ(994) تملأ العمود الأول بالكامل، ب(994) تملأ العمود الثاني بالكامل — متوازنان أصلاً، لا نقل ممكن أو لازم.
  const heights = new Map([["أ", 994], ["ب", 994]]);
  const { pages } = template.packGroupsIntoBalancedPages(groups, [], heights, { fullBudget: budget }, 6);
  check("لا فيضان بعد التوازن: العمودان بقيا كما وُزّعا دون نقل غير آمن", pages[0]?.right.length === 1 && pages[0]?.left.length === 1);
}

if (failed) {
  console.error("Price bulletin group-packing regression check FAILED.");
  process.exit(1);
}
console.log("Price bulletin group-packing regression check passed.");
