// حارس توجيه المساعد الذكي — كل سؤال يصل لمصدره الصحيح، ولا يُخترع رقم.
//
// القاعدة التي يحرسها: المساعد يقرأ من مصدر واحد محدَّد لكل نية، ويقول «لا
// أعرف» صراحةً بدل أن يملأ الفراغ برقم. أخطر عطل ممكن هنا ليس رسالة خطأ، بل
// **رقم مالي يبدو صحيحاً ومصدره خاطئ أو مفقود** — فالمالك يتخذ قراراً عليه.
import assert from "node:assert/strict";
import { loadAssistant, defaultFixtures, TOKENS } from "./lib/assistant-harness.mjs";

let passed = 0;
const ok = (label) => { passed += 1; console.log(`  ✓ ${label}`); };

// أرقام لا يجوز أن تظهر إلا من مصدرها. لو ظهر رقم الصندوق في جواب مبيعات فهذا
// خلط مصادر — وهو بالضبط ما يجعل الجواب المالي كاذباً.
const CASH_MARK = "2,193.09";
const SALES_MARK = "10,745.5";
const DEBT_MARK = "31,597.2";

// ── أ) كل نية تصل لأداتها ومصدرها ────────────────────────────────────────────
const ROUTES = [
  ["كم يوجد بالصندوق؟", "cashbox", "daily_movement_reports"],
  ["كم بالخزنة سيولة؟", "cashbox", "daily_movement_reports"],
  ["كم مبيعات اليوم؟", "sales", "sales_line_items"],
  ["كم قبضنا اليوم؟", "collections", "daily_movement_reports"],
  ["كم دفعنا اليوم؟", "expenses", "expense_entries"],
  ["ما المصاريف؟", "expenses", "expense_entries"],
  ["من أكبر الزبائن مديونية؟", "receivables", "inventory_reports"],
  ["ما الذمم علينا؟", "receivables", "inventory_reports"],
  ["ما رصيد الزبون جهاد التلي؟", "customer", "inventory_reports"],
  ["ماذا اشترى الزبون جهاد التلي؟", "customer", "inventory_reports"],
  ["ما الأصناف الناقصة؟", "inventory", "inventory_reports"],
  ["ما وضع المخزون؟", "inventory", "inventory_reports"],
  ["ما الأصناف الراكدة؟", "stagnant", "inventory_reports"],
  ["ماذا يجب أن أشتري؟", "purchase_advice", "inventory_reports"],
  ["ما حركة ماستر طويل ورق؟", "item", "approved_price_items"],
  ["ما الأرباح؟", "profit", "inventory_reports"],
  ["ما المشتريات؟", "purchases", "ameen_purchase_invoice_reports"],
  ["ما التحويلات بين المستودعات؟", "transfers", "ameen_warehouse_transfer_reports"],
  ["ما المستودعات لدينا؟", "warehouses", "ameen_warehouse_stock_reports"],
  ["ما رصيد حساب شام كاش؟", "accounts", "ameen_account_balance_reports"],
  ["ما نتائج الجرد؟", "stocktaking", null],
  ["ما أهم الأمور التي تحتاج انتباهي اليوم؟", "briefing", "daily_movement_reports"]
];

for (const [question, tool, table] of ROUTES) {
  const a = await loadAssistant();
  const result = await a.ask(TOKENS.owner, question);
  assert.equal(result.status, 200, `«${question}» أعاد ${result.status}`);
  assert.equal(result.body.tool, tool, `«${question}» ذهب إلى ${result.body.tool} بدل ${tool}`);
  if (table) {
    assert.ok(a.metrics.tablesRead.has(table), `«${question}» لم يقرأ ${table} — قرأ ${[...a.metrics.tablesRead]}`);
  } else {
    assert.equal(a.metrics.tablesRead.size, 0, `«${question}» كان يجب ألا يقرأ أي مصدر`);
  }
}
ok(`${ROUTES.length} سؤالاً وصل كلٌّ منها لأداته ومصدر بياناته الصحيح`);

// ── ب) لا خلط بين المصادر ────────────────────────────────────────────────────
{
  const cash = await loadAssistant();
  const cashAnswer = await cash.ask(TOKENS.owner, "كم يوجد بالصندوق؟");
  assert.ok(String(cashAnswer.body.reply).includes(CASH_MARK), "جواب الصندوق بلا رقم الصندوق");
  assert.ok(!String(cashAnswer.body.reply).includes(SALES_MARK), "رقم المبيعات تسرّب لجواب الصندوق");
  assert.deepEqual(cashAnswer.body.sources, ["daily_movement_reports"]);

  const sales = await loadAssistant();
  const salesAnswer = await sales.ask(TOKENS.owner, "كم مبيعات اليوم؟");
  assert.ok(String(salesAnswer.body.reply).includes(SALES_MARK), "جواب المبيعات بلا رقم المبيعات");
  assert.ok(!String(salesAnswer.body.reply).includes(CASH_MARK), "رقم الصندوق تسرّب لجواب المبيعات");
  assert.ok(!sales.metrics.tablesRead.has("daily_movement_reports"), "سؤال المبيعات قرأ تقرير الصناديق");

  const debts = await loadAssistant();
  const debtAnswer = await debts.ask(TOKENS.owner, "من أكبر الزبائن مديونية؟");
  assert.ok(String(debtAnswer.body.reply).includes(DEBT_MARK), "جواب الذمم بلا رقم الذمم");
  assert.ok(!String(debtAnswer.body.reply).includes(CASH_MARK), "رقم الصندوق تسرّب لجواب الذمم");
  ok("لا يتسرّب رقم من مصدر إلى جواب مصدر آخر");
}

// ── ج) سؤال غير مدعوم لا يُنتج بيانات مختلقة ────────────────────────────────
{
  // أسئلة عمل واقعية لا يملك النظام لها مصدراً إطلاقاً (لا رواتب، لا زيارات
  // مندوبين، لا بيانات سوق، لا تنبؤ صرف). هذه هي الحالة الخطرة فعلاً: سؤال
  // يبدو مشروعاً فيغري بجواب مؤلَّف.
  const unsupported = [
    "كم عدد موظفينا وما رواتبهم؟",
    "ما توقعات سعر صرف الدولار الشهر القادم؟",
    "ما حصتنا السوقية مقارنة بالمنافسين؟",
    "كم زيارة قام بها المندوبون هذا الأسبوع؟",
    "اكتب لي قصيدة"
  ];
  for (const question of unsupported) {
    const a = await loadAssistant();
    const result = await a.ask(TOKENS.owner, question);
    assert.equal(result.status, 200);
    assert.equal(result.body.tool, null, `«${question}» وُجّه إلى أداة (${result.body.tool})`);
    assert.equal(result.body.answered, false, `«${question}» ادّعى أنه أجاب`);
    assert.equal(a.metrics.tablesRead.size, 0, `«${question}» قرأ بيانات بلا داعٍ`);
    // ولا يحتوي الجواب أي رقم مالي
    assert.ok(!/\d[\d,]*\.\d/.test(String(result.body.reply)), `«${question}» أنتج رقماً مالياً مختلقاً`);
  }
  ok(`${unsupported.length} أسئلة غير مدعومة رُدَّت بلا أي رقم ملفَّق وبلا قراءة بيانات`);
}

// ── د) غياب البيانات يُعلَن ولا يُملأ بتقدير ────────────────────────────────
{
  const empty = defaultFixtures();
  empty.daily_movement_reports = [];
  const a = await loadAssistant({ fixtures: empty });
  const result = await a.ask(TOKENS.owner, "كم يوجد بالصندوق؟");
  assert.equal(result.status, 200);
  assert.equal(result.body.answered, false, "ادّعى الجواب رغم غياب تقرير الصناديق");
  assert.ok(/لا تتوفر بيانات/.test(String(result.body.reply)), "لم يُعلن غياب البيانات صراحةً");
  assert.ok(!/\d[\d,]*\.\d/.test(String(result.body.reply)), "أنتج رقماً رغم غياب المصدر");
  ok("غياب تقرير الصناديق يُعلَن صراحةً بلا أي رقم بديل");
}

{
  // فارغ ≠ صفر مختلق: يوم بلا مبيعات يجب أن يُقال إنه بلا مبيعات، لا أن يُسكت عنه
  const empty = defaultFixtures();
  empty.sales_line_items = [{ sale_date: "2026-08-01", bill_no: "1", bill_type: "retail", item_name: "x", qty: 1, line_total: 5, customer_name: "y" }];
  const a = await loadAssistant({ fixtures: empty });
  const result = await a.ask(TOKENS.owner, "كم مبيعات اليوم؟");
  assert.ok(/لا توجد أي فاتورة مسجّلة/.test(String(result.body.reply)), "لم يميّز بين «لا مبيعات» و«لا بيانات»");
  assert.ok(/2026-08-01/.test(String(result.body.reply)), "لم يذكر آخر يوم فيه مبيعات فعلية");
  ok("يوم بلا مبيعات يُوصف بدقة مع ذكر آخر يوم فيه حركة حقيقية");
}

// ── هـ) فشل مصدر واحد لا يُنتج جواباً مالياً مخترعاً ────────────────────────
{
  const a = await loadAssistant({ failTable: "daily_movement_reports" });
  const result = await a.ask(TOKENS.owner, "كم يوجد بالصندوق؟");
  assert.equal(result.status, 200);
  assert.equal(result.body.answered, false, "ادّعى الجواب رغم فشل المصدر");
  assert.ok(/تعذّرت قراءة/.test(String(result.body.reply)), "لم يُعلن فشل المصدر");
  assert.ok(!/\d[\d,]*\.\d/.test(String(result.body.reply)), "أنتج رقماً مالياً بعد فشل المصدر");
  ok("فشل مصدر الصناديق ⇒ اعتراف صريح، بلا أي رقم بديل");
}

{
  // الملخص المركّب: فشل جزء لا يُسقط الباقي ولا يُعوَّض بتقدير
  const a = await loadAssistant({ failTable: "sales_line_items" });
  const result = await a.ask(TOKENS.owner, "ما أهم الأمور التي تحتاج انتباهي اليوم؟");
  assert.equal(result.body.tool, "briefing");
  const reply = String(result.body.reply);
  assert.ok(reply.includes(CASH_MARK), "فشل المبيعات أسقط بيانات الصناديق السليمة");
  assert.ok(/تعذّرت قراءة: المبيعات/.test(reply), "لم يُعلن الجزء الفاشل من الملخص");
  assert.ok(!/مبيعات اليوم\*\*: [\d,]/.test(reply), "عرض رقم مبيعات رغم فشل مصدره");
  ok("الملخص المركّب: الجزء الفاشل يُعلَن والباقي يبقى — بلا تعويض بالتقدير");
}

// ── و) زبون غير موجود / اسم ملتبس ⇒ لا تخمين ────────────────────────────────
{
  const a = await loadAssistant();
  const missing = await a.ask(TOKENS.owner, "ما رصيد الزبون فلان الفلاني؟");
  assert.equal(missing.body.answered, false);
  assert.ok(/لم أجد زبوناً/.test(String(missing.body.reply)), "لم يعترف بعدم إيجاد الزبون");
  assert.ok(!/\d[\d,]*\.\d/.test(String(missing.body.reply)), "أعطى رصيداً لزبون غير موجود");
  ok("زبون غير موجود ⇒ اعتراف صريح بلا رصيد مخترع");
}

// ── ز) الفترات والمقارنة تُحسب من التاريخ لا من كلمة ثابتة ──────────────────
{
  const fixtures = defaultFixtures();
  const today = new Date(Date.now() + 180 * 60_000).toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() + 180 * 60_000 - 86_400_000).toISOString().slice(0, 10);
  fixtures.sales_line_items = [
    { sale_date: today, bill_no: "1", bill_type: "retail", item_name: "أ", qty: 1, line_total: 100, net_profit: 10, unit_cost: 90, customer_name: "س" },
    { sale_date: yesterday, bill_no: "2", bill_type: "retail", item_name: "أ", qty: 1, line_total: 40, net_profit: 4, unit_cost: 36, customer_name: "س" }
  ];
  const a = await loadAssistant({ fixtures });
  const todayAnswer = await a.ask(TOKENS.owner, "كم مبيعات اليوم؟");
  assert.ok(String(todayAnswer.body.reply).includes("100 USD"), "لم يعزل مبيعات اليوم");
  assert.ok(!String(todayAnswer.body.reply).includes("140"), "جمع اليوم مع أمس");

  const b = await loadAssistant({ fixtures });
  const yesterdayAnswer = await b.ask(TOKENS.owner, "كم مبيعات امس؟");
  assert.ok(String(yesterdayAnswer.body.reply).includes("40 USD"), "لم يعزل مبيعات أمس");

  const c = await loadAssistant({ fixtures });
  const compare = await c.ask(TOKENS.owner, "قارن مبيعات اليوم بالفترة السابقة");
  const text = String(compare.body.reply);
  assert.ok(/مقارنة بـ/.test(text), "لم يُنتج مقارنة");
  assert.ok(/\+60 USD/.test(text), `لم يحسب فرق المقارنة بشكل صحيح:\n${text}`);
  assert.ok(/\+150\.0%/.test(text), `لم يحسب نسبة المقارنة بشكل صحيح:\n${text}`);
  ok("الفترات (اليوم/أمس) والمقارنة محسوبة من التواريخ الفعلية");
}

// ── ح) الأرقام الحقيقية مطابقة للمصدر ───────────────────────────────────────
{
  const a = await loadAssistant();
  const profit = await a.ask(TOKENS.owner, "ما الأرباح؟");
  const reply = String(profit.body.reply);
  for (const expected of ["10,745.5 USD", "10,725.5 USD", "486.5 USD", "321.5 USD"]) {
    assert.ok(reply.includes(expected), `تقرير الربح لم يعرض ${expected}`);
  }
  ok("أرقام تقرير الربح معروضة كما هي في المصدر بلا إعادة حساب");
}

// ── ط) الجرد: لا يوجد مسار قراءة ⇒ يقال ذلك ولا يُستبدل بمصدر آخر ───────────
{
  const a = await loadAssistant();
  const result = await a.ask(TOKENS.owner, "ما نتائج الجرد؟");
  assert.equal(result.body.answered, false);
  assert.equal(a.metrics.tablesRead.size, 0, "قرأ مصدراً بديلاً للجرد");
  assert.ok(/smart_inventory_sessions/.test(String(result.body.reply)), "لم يوضّح أين تعيش بيانات الجرد");
  assert.ok(!/\d[\d,]*\.\d/.test(String(result.body.reply)), "أعطى رقم جرد من مصدر آخر");
  ok("الجرد: اعتراف بعدم توفر مسار قراءة، بلا رقم من مصدر بديل");
}

// ── ي) المناقلات: الجدول فارغ فعلياً ⇒ يقال ذلك بوضوح ───────────────────────
{
  const a = await loadAssistant();
  const result = await a.ask(TOKENS.owner, "ما التحويلات بين المستودعات؟");
  assert.equal(result.body.answered, false);
  assert.ok(/فارغ|لا يوجد أي تقرير/.test(String(result.body.reply)), "لم يوضّح أن مصدر المناقلات فارغ");
  ok("المناقلات: يُعلن أن الجدول فارغ بدل اختلاق مناقلات");
}

// ── ك) العمود الفاسد net_profit ممنوع نهائياً ───────────────────────────────
{
  // تحقّق على بيانات الإنتاج (2026-09-06): sales_line_items.net_profit يساوي
  // line_total في كل صف — يتجاهل التكلفة تماماً. على آب: Σline_total =
  // 550,452.75 وΣnet_profit = 550,448.62، أي «ربح» ≈ 100%. قراءته تعني إعطاء
  // المالك رقم ربح كاذب، فيمنعها هذا الحارس دائماً.
  const { functionSource } = await import("./lib/assistant-harness.mjs");
  const code = functionSource().split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  // الفحص دقيق: `summary.net_profit` في تقرير ameen_daily_profit حقلٌ سليم
  // ومختلف تماماً. الممنوع هو عمود جدول sales_line_items.
  const salesRowType = code.match(/type SalesRow = \{([\s\S]*?)\}/);
  assert.ok(salesRowType, "لم يُعثر على نوع SalesRow");
  assert.ok(!/net_profit/.test(salesRowType[1]), "نوع SalesRow ما زال يعلن net_profit");
  for (const columnList of code.match(/"[^"]*sale_date[^"]*"/g) ?? []) {
    assert.ok(!columnList.includes("net_profit"), `قائمة أعمدة المبيعات تطلب net_profit: ${columnList}`);
  }

  // والسلوك: الهامش محسوب من التكلفة، ومصحوب بتحذير عن السطور بلا تكلفة
  const fixtures = defaultFixtures();
  const today = new Date(Date.now() + 180 * 60_000).toISOString().slice(0, 10);
  fixtures.sales_line_items = [
    // بيع 1000، تكلفة 900 ⇒ هامش 100 حقيقي. net_profit «فاسد» = 1000 كما بالإنتاج
    { sale_date: today, bill_no: "1", bill_type: "wholesale", item_name: "أ", qty: 10, line_total: 1000, unit_cost: 90, net_profit: 1000, customer_name: "س" },
    // سطر بلا تكلفة — يجب أن يُستثنى ويُذكر عدده لا أن يُفترض له ربح
    { sale_date: today, bill_no: "1", bill_type: "wholesale", item_name: "ب", qty: 5, line_total: 500, unit_cost: 0, net_profit: 500, customer_name: "س" }
  ];
  const a = await loadAssistant({ fixtures });
  const result = await a.ask(TOKENS.owner, "كم مبيعات اليوم؟");
  const reply = String(result.body.reply);
  assert.ok(reply.includes("1,500 USD"), `الإجمالي غير صحيح:\n${reply}`);
  assert.ok(/هامش المنتج المحسوب/.test(reply), "لم يُعرض الهامش المحسوب");
  assert.ok(reply.includes("100 USD"), `الهامش المحسوب غير صحيح (يجب 100 لا 1500):\n${reply}`);
  assert.ok(!/\*\*1,500 USD\*\* \(100\.0%\)/.test(reply), "عرض الهامش مساوياً للمبيعات — أي أنه قرأ العمود الفاسد");
  assert.ok(/1 سطر بلا تكلفة معروفة/.test(reply), "لم يُعلن السطر بلا تكلفة");
  assert.ok(/ما الأرباح/.test(reply), "لم يُحل إلى المصدر المحاسبي المعتمد للربح");
  ok("الهامش محسوب من التكلفة لا من العمود الفاسد، والسطور بلا تكلفة مستثناة ومُعلنة");
}

// ── ل) قيمة مشتريات متعارضة الوحدات ⇒ لا يُعرض إجمالي ─────────────────────
{
  // تحقّق على الإنتاج (2026-09-06): في تقرير فواتير الشراء، qty بوحدة وprice
  // بوحدة أخرى، فـlineTotal = qty×price مضخَّم نحو 50 ضعفاً. المجموع بهذه
  // القراءة 76.3 مليون دولار على شهرين مقابل مبيعات 1.15 مليون — مستحيل.
  // المطلوب: يمتنع المساعد عن الإجمالي ويشرح السبب، لا أن يمرّر الرقم.
  const fixtures = defaultFixtures();
  fixtures.ameen_purchase_invoice_reports = [{
    report_date: "2026-09-06",
    created_at: new Date().toISOString(),
    summary: { bills: 2, suppliers: 1, fromDate: "2026-07-08" },
    items: [{
      name: "هادي الغميان ركن الدين",
      invoices: [
        { date: "2026-08-27", items: [
          // qty×price = 4,593,750 بينما qty×avgPrice = 91,451 — تعارض صريح
          { itemName: "مالبورو غولد كرتون", qty: 3750, unit: "كرتونة", price: 1225, avgPrice: 24.387, lineTotal: 4593750 },
          { itemName: "ماستر طويل ورق", qty: 5000, unit: "كرتونة", price: 351, avgPrice: 7.046, lineTotal: 1755000 }
        ] },
        { date: "2026-08-18", items: [
          { itemName: "كينغ دوم سليم", qty: 7500, unit: "كرتونة", price: 245, avgPrice: 4.778, lineTotal: 1837500 }
        ] }
      ]
    }]
  }];
  const a = await loadAssistant({ fixtures });
  const result = await a.ask(TOKENS.owner, "ما المشتريات؟");
  const reply = String(result.body.reply);
  assert.equal(result.body.tool, "purchases");
  assert.ok(/لم أعرض إجمالي قيمة المشتريات عمداً/.test(reply), "لم يمتنع عن الإجمالي المتعارض");
  assert.ok(!/8,186,250|8186250/.test(reply), "عرض الإجمالي المضخَّم رغم التعارض");
  assert.ok(/pull-purchase-invoices-from-ameen/.test(reply), "لم يوجّه إلى موضع الخلل الحقيقي");
  // والأعداد السليمة تبقى معروضة — الامتناع عن القيمة لا يعني إخفاء كل شيء
  assert.ok(/عدد الفواتير: \*\*2\*\*/.test(reply), "أخفى عدد الفواتير وهو رقم سليم");
  assert.ok(/هادي الغميان/.test(reply), "أخفى اسم المورّد وهو معلومة سليمة");
  ok("قيمة المشتريات المتعارضة الوحدات: امتناع صريح عن الإجمالي مع إبقاء الأعداد السليمة");
}

// ── م) سقف صفوف الخادم لا ينتج إجمالياً مبتوراً يبدو كاملاً ─────────────────
{
  // ملاحظة Codex على PR #205: PostgREST يقصّ الاستجابة عند db-max-rows مهما
  // طلب العميل، فمقارنة عدد الصفوف بالحد المطلوب لا تكشف البتر إطلاقاً —
  // ويُعرض إجمالي ناقص على أنه نهائي. هنا نحاكي السقف صراحةً.
  const today = new Date(Date.now() + 180 * 60_000).toISOString().slice(0, 10);
  const fixtures = defaultFixtures();
  fixtures.sales_line_items = Array.from({ length: 250 }, (_, i) => ({
    id: i + 1,
    sale_date: today,
    bill_no: String(i + 1),
    bill_type: "wholesale",
    item_name: "أ",
    qty: 1,
    line_total: 10,
    unit_cost: 9,
    customer_name: "س"
  }));

  // سقف خادم 40 صفاً: بلا تصفيح صحيح سيظهر 400 بدل 2,500
  const a = await loadAssistant({ fixtures, maxRows: 40 });
  const result = await a.ask(TOKENS.owner, "كم مبيعات اليوم؟");
  const reply = String(result.body.reply);
  assert.ok(reply.includes("2,500 USD"), `الإجمالي مبتور رغم التصفيح:\n${reply}`);
  assert.ok(/عدد الفواتير: \*\*250\*\*/.test(reply), "عدد الفواتير مبتور");
  assert.equal(result.body.partial, false, "أُعلن جزئياً رغم اكتمال القراءة");
  assert.ok(!reply.includes("400 USD"), "عرض إجمالي الصفحة الأولى فقط");
  // ويجب أن يكون قد صفّح فعلاً (أكثر من طلب واحد لسطور المبيعات)
  const salesReads = a.metrics.reads.filter((q) => q.startsWith("sales_line_items"));
  assert.ok(salesReads.length > 1, `لم يجرِ تصفيح: ${salesReads.length} طلب فقط`);
  assert.ok(salesReads.some((q) => q.includes("offset=")), "لا يوجد offset في طلبات المبيعات");
  ok("سقف صفوف الخادم لا يبتر إجمالي المبيعات — التصفيح يقرأ الفترة كاملة");
}

{
  // نفس العطل في المصاريف: الحد الثابت 200 كان يعرض مجموع أحدث 200 حركة
  // على أنه إجمالي الفترة كلها بلا أي تحذير.
  const fixtures = defaultFixtures();
  fixtures.expense_entries = Array.from({ length: 300 }, (_, i) => ({
    id: i + 1,
    entry_date: "2026-09-06",
    account_name: `بند ${i + 1}`,
    amount: 10,
    notes: ""
  }));
  const a = await loadAssistant({ fixtures, maxRows: 50 });
  const result = await a.ask(TOKENS.owner, "ما المصاريف؟");
  const reply = String(result.body.reply);
  assert.equal(result.body.tool, "expenses");
  assert.ok(reply.includes("3,000 USD"), `إجمالي المصاريف مبتور:\n${reply}`);
  assert.ok(/على 300 حركة/.test(reply), "عدد الحركات مبتور");
  assert.ok(!reply.includes("2,000 USD"), "عرض مجموع أول 200 حركة كإجمالي");
  ok("سقف صفوف الخادم لا يبتر إجمالي المصاريف");
}

{
  // ولائحة الأسعار: صنف خارج الصفحة الأولى يجب أن يُعثر عليه لا أن يُنفى وجوده
  const fixtures = defaultFixtures();
  fixtures.approved_price_items = [
    ...Array.from({ length: 120 }, (_, i) => ({
      item_name: `حشو ${i + 1}`, item_key: `filler-${i + 1}`, unit1_name: "كروز",
      unit1_price: 1, unit2_name: "كرتونة", unit2_factor: 50, unit2_price: 50,
      sale_price: 1, stock_qty: 5, stock_status: "available"
    })),
    { item_name: "ماستر طويل ورق", item_key: "ماستر طويل ورق", unit1_name: "كروز",
      unit1_price: 7.08, unit2_name: "كرتونة", unit2_factor: 50, unit2_price: 354,
      sale_price: 7.08, stock_qty: 2000, stock_status: "active" }
  ];
  const a = await loadAssistant({ fixtures, maxRows: 25 });
  const result = await a.ask(TOKENS.owner, "سعر ماستر طويل ورق");
  const reply = String(result.body.reply);
  assert.ok(!/لم أجد صنفاً/.test(reply), "نفى وجود صنف موجود خارج الصفحة الأولى");
  assert.ok(reply.includes("ماستر طويل ورق"), "لم يعثر على الصنف");
  ok("سقف صفوف الخادم لا يجعل المساعد ينفي وجود صنف موجود");
}

// ── ن) فواتير الزبون: لا نسبة بالاسم متى وُجد معرّف موثوق ──────────────────
{
  // ملاحظة Codex على PR #205: عند فشل مطابقة الـGUID كان الكود يرتد لمطابقة
  // الاسم، فيعرض فواتير **زبون آخر** بأصنافه وأسعاره تحت اسم المطلوب. وهذا
  // ينقض قاعدة موثّقة في CLAUDE.md (الربط بـcustomerGuid أولاً، ولا نسبة
  // بالتخمين). الحالة: الزبون له GUID، وتقرير الفواتير يحوي اسماً مشابهاً
  // جداً بمعرّف مختلف.
  const fixtures = defaultFixtures();
  fixtures["inventory_reports:ameen_customer_invoices"] = [{
    report_date: "2026-09-06",
    created_at: new Date().toISOString(),
    summary: { bills: 1, customers: 1, fromDate: "2026-07-08" },
    items: [{
      name: "جهاد التلي",
      customerGuid: "GUID-مختلف-تماماً",
      invoices: [{ date: "2026-08-29", lines: [
        { material: "بضاعة زبون آخر", qty: 99, price: 1234, unit1: "كروز", lineTotal: 122166 }
      ] }]
    }]
  }];
  const a = await loadAssistant({ fixtures });
  const result = await a.ask(TOKENS.owner, "ماذا اشترى الزبون جهاد التلي؟");
  const reply = String(result.body.reply);
  // الرصيد من تقرير الأرصدة يبقى صحيحاً
  assert.ok(reply.includes("12,000 USD"), "ضاع رصيد الزبون الصحيح");
  // ولا تُنسب له فواتير غيره
  assert.ok(!reply.includes("بضاعة زبون آخر"), "نسب فواتير زبون آخر بتشابه الاسم");
  assert.ok(!reply.includes("122,166"), "عرض قيمة فواتير زبون آخر");
  assert.ok(/لم أجد في تقرير الفواتير/.test(reply), "لم يُعلن عدم وجود سجل مربوط بالمعرّف");
  ok("فواتير الزبون لا تُنسب بتشابه الاسم متى وُجد معرّف موثوق");
}

{
  // وحين يتطابق المعرّف فعلاً، تُعرض الفواتير طبيعياً
  const a = await loadAssistant();
  const result = await a.ask(TOKENS.owner, "ماذا اشترى الزبون جهاد التلي؟");
  const reply = String(result.body.reply);
  assert.ok(/آخر الفواتير/.test(reply), "لم تُعرض الفواتير رغم تطابق المعرّف");
  assert.ok(reply.includes("ماستر طويل ورق"), "لم تُعرض بنود الفاتورة");
  ok("تطابق المعرّف يعرض الفواتير طبيعياً — التشديد لا يكسر الحالة السليمة");
}

// ── س) التاريخ المطلوب يُحترم في تقارير الحركة ─────────────────────────────
{
  // ملاحظة Codex على PR #205: «كم قبضنا أمس؟» كان يُحسب فيه parsePeriod صحيحاً
  // ثم تتجاهله الأداة وتأخذ أحدث تقرير — فيُعرض مقبوض **اليوم** كأنه جواب أمس.
  const today = new Date(Date.now() + 180 * 60_000).toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() + 180 * 60_000 - 86_400_000).toISOString().slice(0, 10);
  const fixtures = defaultFixtures();
  fixtures.daily_movement_reports = [
    { report_date: today, created_at: new Date().toISOString(), payload: {
      cashTotals: [{ currency: "$", opening: 900, closing: 999, externalIncoming: 0, externalOutgoing: 0 }],
      cashboxes: [{ name: "صندوق", currency: "$", opening: 900, incoming: 99, outgoing: 0, closing: 999 }],
      payments: [{ name: "زبون اليوم", amount: 777, notes: "" }],
      paymentSummary: { count: 1, totalUsd: 777 } } },
    { report_date: yesterday, created_at: new Date(Date.now() - 86_400_000).toISOString(), payload: {
      cashTotals: [{ currency: "$", opening: 100, closing: 111, externalIncoming: 0, externalOutgoing: 0 }],
      cashboxes: [{ name: "صندوق", currency: "$", opening: 100, incoming: 11, outgoing: 0, closing: 111 }],
      payments: [{ name: "زبون أمس", amount: 222, notes: "" }],
      paymentSummary: { count: 1, totalUsd: 222 } } }
  ];

  const a = await loadAssistant({ fixtures });
  const yd = await a.ask(TOKENS.owner, "كم قبضنا امس؟");
  const ydText = String(yd.body.reply);
  assert.equal(yd.body.tool, "collections");
  assert.ok(ydText.includes("222"), `لم يقرأ مقبوضات أمس:\n${ydText}`);
  assert.ok(!ydText.includes("777"), "عرض مقبوضات اليوم جواباً عن أمس");
  assert.ok(ydText.includes(yesterday), "لم يذكر تاريخ أمس");

  const b = await loadAssistant({ fixtures });
  const td = await b.ask(TOKENS.owner, "كم قبضنا اليوم؟");
  assert.ok(String(td.body.reply).includes("777"), "لم يقرأ مقبوضات اليوم");

  // وبلا تاريخ مذكور يبقى الأحدث هو الصحيح
  const c = await loadAssistant({ fixtures });
  const latest = await c.ask(TOKENS.owner, "كم يوجد بالصندوق؟");
  assert.ok(String(latest.body.reply).includes("999"), "سؤال بلا تاريخ لم يأخذ أحدث تقرير");

  // ويوم مطلوب بلا تقرير يُعلن، ولا يُستبدل بيوم آخر
  const d = await loadAssistant({ fixtures: { ...fixtures, daily_movement_reports: [fixtures.daily_movement_reports[0]] } });
  const missing = await d.ask(TOKENS.owner, "كم قبضنا امس؟");
  const missText = String(missing.body.reply);
  assert.equal(missing.body.answered, false, "ادّعى الجواب عن يوم بلا تقرير");
  assert.ok(!missText.includes("777"), "استبدل اليوم الغائب بأرقام يوم آخر");
  assert.ok(missText.includes(today), "لم يذكر أحدث تاريخ متاح");
  ok("تقارير الحركة تحترم اليوم المطلوب، وتُعلن غيابه بدل استبداله بيوم آخر");
}

// ── ع) فترة خارج نافذة المزامنة المتحقَّقة تُعلَن ──────────────────────────
{
  // ملاحظة Codex على PR #205: المنتِج يعمل بـ-Days 30 وsales_line_items يحتفظ
  // بصفوف أقدم لا تُحدَّث. تقديم مجموعها كإجمالي نهائي ادّعاء بلا سند.
  // تحقُّق على الإنتاج 2026-09-06: النافذة 2026-08-07 → 2026-09-06 بينما
  // الجدول يحمل صفوفاً من 2026-07-01.
  const today = new Date(Date.now() + 180 * 60_000).toISOString().slice(0, 10);
  const old = new Date(Date.now() + 180 * 60_000 - 50 * 86_400_000).toISOString().slice(0, 10);
  const fixtures = defaultFixtures();
  fixtures.sales_line_items = [
    { id: 1, sale_date: today, bill_no: "1", bill_type: "retail", item_name: "أ", qty: 1, line_total: 100, unit_cost: 90, customer_name: "س" },
    { id: 2, sale_date: old, bill_no: "2", bill_type: "retail", item_name: "أ", qty: 1, line_total: 50, unit_cost: 45, customer_name: "س" }
  ];
  fixtures.sales_line_items_sync_state = [{
    source: "ameen_sales_line_items",
    window_start: new Date(Date.now() + 180 * 60_000 - 29 * 86_400_000).toISOString().slice(0, 10),
    window_end: today,
    row_count: 1,
    completed_at: new Date().toISOString()
  }];

  // فترة داخل النافذة ⇒ بلا تحذير
  const inside = await loadAssistant({ fixtures });
  const insideText = String((await inside.ask(TOKENS.owner, "كم مبيعات اليوم؟")).body.reply);
  assert.ok(!/خارج آخر نافذة مزامنة/.test(insideText), "حذّر رغم أن الفترة داخل النافذة");

  // فترة تمتد قبل النافذة ⇒ تحذير صريح بحدود النافذة
  const outside = await loadAssistant({ fixtures });
  const outsideResult = await outside.ask(TOKENS.owner, "كم مبيعات اخر 60 يوم؟");
  const outsideText = String(outsideResult.body.reply);
  assert.ok(/خارج آخر نافذة مزامنة متحقَّقة/.test(outsideText), `لم يُعلن خروج الفترة عن النافذة:\n${outsideText}`);
  assert.ok(outsideText.includes(fixtures.sales_line_items_sync_state[0].window_start), "لم يذكر بداية النافذة المتحقَّقة");
  assert.ok(outside.metrics.tablesRead.has("sales_line_items_sync_state"), "لم يقرأ سجل المزامنة أصلاً");

  // وغياب سجل المزامنة كلياً ⇒ إعلان أن الأرقام غير متحقَّقة
  const none = await loadAssistant({ fixtures: { ...fixtures, sales_line_items_sync_state: [] } });
  const noneText = String((await none.ask(TOKENS.owner, "كم مبيعات اليوم؟")).body.reply);
  assert.ok(/لا يوجد سجل مزامنة مكتمل/.test(noneText), "لم يُعلن غياب سجل المزامنة");

  // وفترة خالية خارج النافذة: «لا توجد فاتورة» نفيٌ قاطع، والغياب هناك قد يكون
  // غياب مزامنة لا غياب بيع. فالتحذير يلزم فرع الصفر كما يلزم فرع الأرقام.
  const far = new Date(Date.now() + 180 * 60_000 - 100 * 86_400_000).toISOString().slice(0, 10);
  const empty = await loadAssistant({ fixtures: { ...fixtures, sales_line_items: [
    { id: 9, sale_date: far, bill_no: "9", bill_type: "retail", item_name: "أ", qty: 1, line_total: 10, unit_cost: 9, customer_name: "س" }
  ] } });
  const emptyText = String((await empty.ask(TOKENS.owner, "كم مبيعات اخر 60 يوم؟")).body.reply);
  assert.ok(/لا توجد أي فاتورة/.test(emptyText), `لم يصل لفرع الصفر:\n${emptyText}`);
  assert.ok(/خارج آخر نافذة مزامنة متحقَّقة/.test(emptyText), `نفى وجود فواتير في فترة خارج النافذة بلا تحذير:\n${emptyText}`);
  ok("الفترة خارج نافذة المزامنة المتحقَّقة تُعلَن صراحةً — في فرع الأرقام وفرع الصفر وعند غياب السجل");
}

// ── غ) المدى المطلوب يُجمع، ولا يُختزل في يوم واحد ──────────────────────────
{
  // ملاحظة Codex الثانية على PR #205 (بعد df4b3df): ترشيح report_date وحده لا
  // يكفي — بقي `limit=1`، فسؤال «كم قبضنا هذا الشهر؟» كان يعرض مقبوضات **يوم
  // واحد** على أنها مقبوضات الشهر. والمقبوضات تدفّق يُجمع، لا رصيد لحظي.
  const day = (offset) =>
    new Date(Date.now() + 180 * 60_000 + offset * 86_400_000).toISOString().slice(0, 10);
  const report = (date, amount, name) => ({
    report_date: date,
    created_at: new Date(Date.parse(`${date}T12:00:00Z`)).toISOString(),
    payload: {
      cashTotals: [{ currency: "$", opening: 0, closing: amount, externalIncoming: 0, externalOutgoing: 0 }],
      cashboxes: [{ name: "صندوق", currency: "$", opening: 0, incoming: amount, outgoing: 0, closing: amount }],
      payments: [{ name, amount, notes: "" }],
      paymentSummary: { count: 1, totalUsd: amount }
    }
  });

  const fixtures = defaultFixtures();
  const first = `${day(0).slice(0, 7)}-01`;
  // ثلاثة أيام من الشهر الحالي: 1 و2 واليوم. المجموع الصحيح 111+222+333=666.
  fixtures.daily_movement_reports = [
    report(day(0), 333, "زبون اليوم"),
    report(`${first.slice(0, 8)}02`, 222, "زبون الثاني"),
    report(first, 111, "زبون الأول")
  ];

  const a = await loadAssistant({ fixtures });
  const monthly = await a.ask(TOKENS.owner, "كم قبضنا هذا الشهر؟");
  const monthText = String(monthly.body.reply);
  assert.equal(monthly.body.tool, "collections");
  assert.ok(/666/.test(monthText), `لم يجمع مقبوضات أيام الشهر:\n${monthText}`);
  for (const mark of ["111", "222", "333"]) {
    assert.ok(monthText.includes(mark), `أسقط دفعة ${mark} من مجموع الشهر`);
  }

  // الأيام الغائبة تُعلَن: غيابها يبخس المجموع بلا أي أثر ظاهر لولا التصريح.
  assert.ok(/داخل الفترة بلا تقرير حركة/.test(monthText), `لم يُعلن أيام الفترة الغائبة:\n${monthText}`);

  // ويوم واحد يبقى بصيغته المفردة بلا حشو المدى
  const b = await loadAssistant({ fixtures });
  const single = String((await b.ask(TOKENS.owner, "كم قبضنا اليوم؟")).body.reply);
  assert.ok(single.includes("333"), "لم يقرأ مقبوضات اليوم");
  assert.ok(!single.includes("222") && !single.includes("111"), "أدخل أيام أخرى في جواب يوم واحد");

  // الصندوق رصيد لحظي لا تدفّق: لا يُجمع، ويُقال أي يوم يمثّله الرقم
  const c = await loadAssistant({ fixtures });
  const boxText = String((await c.ask(TOKENS.owner, "كم صار بالصندوق هذا الشهر؟")).body.reply);
  assert.ok(boxText.includes("333"), "لم يأخذ أحدث رصيد داخل الفترة");
  assert.ok(!/666/.test(boxText), "جمع الأرصدة اللحظية عبر الأيام");
  assert.ok(boxText.includes(day(0)), "لم يذكر اليوم الذي يمثّله الرصيد");
  ok("المقبوضات تُجمع عبر كل أيام المدى وتُعلن الأيام الغائبة، والرصيد لا يُجمع");
}

// ── ف) الملخص التنفيذي لا يتجاوز حارس نافذة المزامنة ───────────────────────
{
  // ملاحظة Codex على PR #205 بعد df4b3df: الملخص مستهلك خامس لـreadSales،
  // فكان يعرض «0 USD» أو صفوفاً غير محدَّثة كأنها مبيعات اليوم المؤكَّدة.
  const today = new Date(Date.now() + 180 * 60_000).toISOString().slice(0, 10);
  const fixtures = defaultFixtures();
  fixtures.sales_line_items_sync_state = [];

  const a = await loadAssistant({ fixtures });
  const brief = await a.ask(TOKENS.owner, "ما أهم الأمور التي تحتاج انتباهي اليوم؟");
  const briefText = String(brief.body.reply);
  assert.equal(brief.body.tool, "briefing");
  assert.ok(/لا يوجد سجل مزامنة مكتمل/.test(briefText), `الملخص عرض مبيعات اليوم بلا تحقُّق:\n${briefText}`);
  assert.ok(a.metrics.tablesRead.has("sales_line_items_sync_state"), "الملخص لم يقرأ سجل المزامنة أصلاً");

  // وبنافذة تغطي اليوم لا يُزعج التحذيرُ الملخصَ
  const b = await loadAssistant({ fixtures: { ...fixtures, sales_line_items_sync_state: [{
    source: "ameen_sales_line_items",
    window_start: new Date(Date.now() + 180 * 60_000 - 29 * 86_400_000).toISOString().slice(0, 10),
    window_end: today,
    row_count: 3,
    completed_at: new Date().toISOString()
  }] } });
  const okText = String((await b.ask(TOKENS.owner, "ما أهم الأمور التي تحتاج انتباهي اليوم؟")).body.reply);
  assert.ok(!/لا يوجد سجل مزامنة مكتمل/.test(okText), "حذّر رغم أن اليوم داخل النافذة");
  ok("الملخص التنفيذي يمرّ بنفس حارس نافذة المزامنة الذي تمرّ به أداة المبيعات");
}

// ── ص) المصاريف كذلك محدودة بنافذة تحديثها المتحقَّقة ───────────────────────
{
  // ملاحظة Codex على PR #205: push-expense-entries.ps1 يحدّث 7 أيام فقط
  // ويترك ما قبلها. فمجموع «الشهر الماضي» قد يُسقط تاريخاً أو يحمل قيوداً
  // بائدة، وكان يُعرض بوصفه «إجمالي» بلا أي إشارة.
  const today = new Date(Date.now() + 180 * 60_000).toISOString().slice(0, 10);
  const old = new Date(Date.now() + 180 * 60_000 - 40 * 86_400_000).toISOString().slice(0, 10);
  const fixtures = defaultFixtures();
  fixtures.expense_entries = [
    { id: 1, entry_date: today, account_name: "محروقات", amount: 45, notes: "" },
    { id: 2, entry_date: old, account_name: "أجور نقل", amount: 500, notes: "" }
  ];
  fixtures.expense_entries_sync_state = [{
    source: "ameen_expense_entries",
    window_start: new Date(Date.now() + 180 * 60_000 - 7 * 86_400_000).toISOString().slice(0, 10),
    window_end: today,
    row_count: 1,
    completed_at: new Date().toISOString()
  }];

  // فترة داخل النافذة ⇒ بلا تحذير
  const inside = await loadAssistant({ fixtures });
  const insideText = String((await inside.ask(TOKENS.owner, "كم دفعنا اليوم؟")).body.reply);
  assert.ok(!/خارج آخر نافذة مزامنة/.test(insideText), "حذّر رغم أن الفترة داخل نافذة المصاريف");

  // فترة تمتد قبل النافذة ⇒ تحذير صريح يسمّي المصدر وحدّه
  const outside = await loadAssistant({ fixtures });
  const outsideText = String((await outside.ask(TOKENS.owner, "كم مصاريف اخر 60 يوم؟")).body.reply);
  assert.ok(/خارج آخر نافذة مزامنة متحقَّقة لـحركة المصاريف/.test(outsideText),
    `لم يُعلن خروج فترة المصاريف عن نافذتها:\n${outsideText}`);
  assert.ok(outsideText.includes(fixtures.expense_entries_sync_state[0].window_start), "لم يذكر بداية نافذة المصاريف");
  assert.ok(outside.metrics.tablesRead.has("expense_entries_sync_state"), "لم يقرأ سجل مزامنة المصاريف أصلاً");
  // ولا يخلط الموضوعات: تحذير المصاريف لا يُنسب لسطور المبيعات
  assert.ok(!/متحقَّقة لـسطور المبيعات/.test(outsideText), "نسب غياب التغطية إلى المصدر الخطأ");

  // وغياب السجل كلياً ⇒ إعلان أن الأرقام غير متحقَّقة
  const none = await loadAssistant({ fixtures: { ...fixtures, expense_entries_sync_state: [] } });
  const noneText = String((await none.ask(TOKENS.owner, "كم دفعنا اليوم؟")).body.reply);
  assert.ok(/لا يوجد سجل مزامنة مكتمل لـحركة المصاريف/.test(noneText), "لم يُعلن غياب سجل مزامنة المصاريف");
  ok("المصاريف محدودة بنافذة تحديثها المتحقَّقة، وكل تحذير يسمّي مصدره لا مصدراً آخر");
}

// ── ق) ملخص «اليوم» لا يحمل أرقام يوم آخر ──────────────────────────────────
{
  // ملاحظة Codex على PR #205 بعد 9a12ea0: قسم الصناديق في الملخص كان يقرأ
  // أحدث صف بـcreated_at بصرف النظر عن report_date، ثم يسمّي مقبوضاته
  // «مقبوضات اليوم» داخل ملخصٍ عنوانه «اليوم».
  const today = new Date(Date.now() + 180 * 60_000).toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() + 180 * 60_000 - 86_400_000).toISOString().slice(0, 10);
  const report = (date, createdAt, closing, paid) => ({
    report_date: date,
    created_at: createdAt,
    payload: {
      cashTotals: [{ currency: "$", opening: 0, closing, externalIncoming: 0, externalOutgoing: 0 }],
      cashboxes: [{ name: "صندوق", currency: "$", opening: 0, incoming: closing, outgoing: 0, closing }],
      payments: [{ name: "زبون", amount: paid, notes: "" }],
      paymentSummary: { count: 1, totalUsd: paid }
    }
  });

  // أ) تقرير اليوم لم يُرفع بعد ⇒ لا تُعرض أرقام أمس تحت عنوان اليوم
  const pending = defaultFixtures();
  pending.daily_movement_reports = [report(yesterday, new Date().toISOString(), 4321, 999)];
  const a = await loadAssistant({ fixtures: pending });
  const pendingText = String((await a.ask(TOKENS.owner, "ما أهم الأمور التي تحتاج انتباهي اليوم؟")).body.reply);
  assert.ok(!/مقبوضات اليوم 999/.test(pendingText), `نسب مقبوضات أمس لليوم:\n${pendingText}`);
  assert.ok(!pendingText.includes("4,321"), "عرض سيولة أمس تحت عنوان اليوم");
  assert.ok(/لا يوجد تقرير حركة صناديق لليوم/.test(pendingText), `لم يُعلن غياب تقرير اليوم:\n${pendingText}`);
  assert.ok(pendingText.includes(yesterday), "لم يذكر أحدث تاريخ متاح");

  // ب) تقرير قديم رُفع **بعد** تقرير اليوم ⇒ الترتيب بوقت الرفع كان يقلب الجواب
  const backfilled = defaultFixtures();
  backfilled.daily_movement_reports = [
    // الأحدث رفعاً هو الأقدم تاريخاً — بالضبط حالة إعادة التعبئة
    report(yesterday, new Date().toISOString(), 4321, 999),
    report(today, new Date(Date.now() - 3_600_000).toISOString(), 1234, 777)
  ];
  const b = await loadAssistant({ fixtures: backfilled });
  const backText = String((await b.ask(TOKENS.owner, "ما أهم الأمور التي تحتاج انتباهي اليوم؟")).body.reply);
  assert.ok(/مقبوضات اليوم 777/.test(backText), `أخذ التقرير الأحدث رفعاً لا الأحدث تاريخاً:\n${backText}`);
  assert.ok(!backText.includes("999"), "سرّب مقبوضات يوم مُعاد تعبئته إلى ملخص اليوم");
  assert.ok(backText.includes(today), "لم يعنون السيولة بتاريخ اليوم");
  ok("ملخص «اليوم» يقرأ تقرير اليوم بالتاريخ لا بوقت الرفع، ويُعلن غيابه بدل استبداله");
}

// ── ك) بتر الفترة السابقة لا يُسقَط من المقارنة ─────────────────────────────
{
  // ملاحظة Codex على PR #205 بعد 244f209: قراءة الفترة السابقة مستقلة بحدّ
  // بتر مستقل، وكان `partial` الخاص بها يُرمى — فيُعرض مجموعها والفرق
  // والنسبة مبتورةً بوصفها نهائية، و`partial` في الجواب يصف الحالية وحدها.
  const today = new Date(Date.now() + 180 * 60_000).toISOString().slice(0, 10);
  const dayBack = (n) => new Date(Date.now() + 180 * 60_000 - n * 86_400_000).toISOString().slice(0, 10);
  const fixtures = defaultFixtures();
  // الفترة الحالية «آخر 7 أيام» صغيرة، والسابقة مكتظّة بما يتجاوز سقف الخادم.
  const rows = [];
  let id = 1;
  for (let d = 0; d < 7; d += 1) {
    rows.push({ id: id++, sale_date: dayBack(d), bill_no: `c${d}`, bill_type: "retail", item_name: "أ", qty: 1, line_total: 10, unit_cost: 9, customer_name: "س" });
  }
  for (let i = 0; i < 300; i += 1) {
    rows.push({ id: id++, sale_date: dayBack(7 + (i % 7)), bill_no: `p${i}`, bill_type: "retail", item_name: "أ", qty: 1, line_total: 10, unit_cost: 9, customer_name: "س" });
  }
  fixtures.sales_line_items = rows;
  fixtures.sales_line_items_sync_state = [{
    source: "ameen_sales_line_items",
    window_start: dayBack(29), window_end: today, row_count: rows.length,
    completed_at: new Date().toISOString()
  }];

  const a = await loadAssistant({ fixtures, maxRows: 40, hardRowCap: 80 });
  const result = await a.ask(TOKENS.owner, "قارن مبيعات الاسبوع بالفترة السابقة");
  const text = String(result.body.reply);
  assert.equal(result.body.tool, "sales");
  assert.ok(/مقارنة بـ/.test(text), `لم يدخل فرع المقارنة:\n${text}`);
  // تحديداً: أن البتر منسوب إلى **أرقام المقارنة** لا إلى الفترة عموماً.
  // «سقف» وحدها تظهر في ذيل الاكتمال أيضاً، فمطابقتها كانت تُنجح الاختبار
  // لسبب آخر غير الذي يدّعيه.
  assert.ok(/الفرق والنسبة/.test(text),
    `لم يُنسب البتر إلى مجموع الفترة السابقة والفرق والنسبة:\n${text}`);
  // وذيل الاكتمال يذكر حدود الفترة السابقة صراحةً أيضاً
  assert.ok(text.includes(dayBack(13)), `ذيل الاكتمال لم يسمِّ حدود الفترة السابقة:\n${text}`);
  assert.equal(result.body.partial, true, "بتر الفترة السابقة لم ينعكس على partial في الجواب");
  ok("بتر قراءة الفترة السابقة يُعلَن ويُعاد في partial — لا يُرمى");
}

// ── ل) الأحكام النهائية «لا شيء مطلوب» تحمل حدود صدقها ─────────────────────
{
  // ملاحظة Codex على PR #205 بعد 244f209: فرع «لا حاجة شراء عاجلة» كان يتجاوز
  // sales.partial ونافذة المزامنة معاً. وقراءة ناقصة تبخس معدّل البيع فتُدخل
  // الجواب في هذا الفرع بالذات وتكتم طلب شراء لازماً — أخطر من رقم ناقص،
  // لأنه حكم يوقف تصرّفاً.
  const today = new Date(Date.now() + 180 * 60_000).toISOString().slice(0, 10);
  const fixtures = defaultFixtures();
  fixtures.sales_line_items_sync_state = [];  // بلا سجل مزامنة ⇒ غير متحقَّق
  // مخزون وافر وبيع ضئيل ⇒ لا صنف تحت 21 يوم تغطية، ولا صنف راكد
  fixtures["inventory_reports:ameen_sql_agent"] = [{
    report_date: today,
    created_at: new Date().toISOString(),
    summary: { totalStockItems: 1, lowStockItems: 0, outOfStockItems: 0 },
    items: [{ key: "k1", name: "ماستر طويل ورق", stockQty: 100000, unit1Name: "علبة" }]
  }];
  fixtures.sales_line_items = [
    { id: 1, sale_date: today, bill_no: "1", bill_type: "retail", item_name: "ماستر طويل ورق", qty: 1, line_total: 10, unit_cost: 9, customer_name: "س" }
  ];

  // متابعة Codex بعد 85b4900: التحذير المُلحق لا يكفي — الحكم نفسه يُحجب.
  // تحذيرٌ بجانب «لا حاجة شراء عاجلة» يُقرأ عملياً كـ«لا حاجة»، والقراءة
  // الناقصة هي بعينها ما يُدخل الجواب في ذلك الفرع.
  const a = await loadAssistant({ fixtures });
  const adviceResult = await a.ask(TOKENS.owner, "ماذا يجب أن أشتري؟");
  const advice = String(adviceResult.body.reply);
  // الصيغة المُثبِتة تحديداً: نصّ الامتناع يقتبس العبارة عمداً («فلن أقول …»)،
  // فمطابقتها وحدها كانت تُسقط الاختبار على الجواب الصحيح.
  assert.ok(!/لا حاجة شراء عاجلة بهذا المعيار/.test(advice), `أصدر حكم «لا حاجة شراء» عن بيانات ناقصة:\n${advice}`);
  assert.equal(adviceResult.body.answered, false, "ادّعى حسم توصية الشراء عن بيانات غير متحقَّقة");
  assert.ok(/غير محسومة/.test(advice), `لم يمتنع صراحةً عن البتّ:\n${advice}`);
  assert.ok(/لا يوجد سجل مزامنة مكتمل/.test(advice), `لم يذكر سبب الامتناع:\n${advice}`);
  assert.ok(a.metrics.tablesRead.has("sales_line_items_sync_state"), "لم يقرأ سجل المزامنة في هذا الفرع");

  const b = await loadAssistant({ fixtures });
  const stagnantResult = await b.ask(TOKENS.owner, "ما الأصناف الراكدة؟");
  const stagnant = String(stagnantResult.body.reply);
  assert.ok(!/لا يوجد صنف راكد بهذا التعريف/.test(stagnant), `أصدر حكم «لا صنف راكد» عن بيانات ناقصة:\n${stagnant}`);
  assert.equal(stagnantResult.body.answered, false, "ادّعى حسم الأصناف الراكدة عن بيانات غير متحقَّقة");
  assert.ok(/غير محسومة/.test(stagnant), `لم يمتنع صراحةً عن البتّ:\n${stagnant}`);

  // وبنافذة تغطّي الفترة كاملةً يُحسم الحكم طبيعياً — التشديد لا يشلّ الأداة
  const covered = {
    ...fixtures,
    sales_line_items_sync_state: [{
      source: "ameen_sales_line_items",
      window_start: new Date(Date.now() + 180 * 60_000 - 90 * 86_400_000).toISOString().slice(0, 10),
      window_end: today,
      row_count: 1,
      completed_at: new Date().toISOString()
    }]
  };
  const c = await loadAssistant({ fixtures: covered });
  const settled = await c.ask(TOKENS.owner, "ماذا يجب أن أشتري؟");
  assert.ok(/لا حاجة شراء عاجلة/.test(String(settled.body.reply)),
    `لم يحسم الحكم رغم اكتمال التغطية:\n${String(settled.body.reply)}`);
  assert.equal(settled.body.answered, true, "امتنع عن البتّ رغم اكتمال التغطية");
  const d = await loadAssistant({ fixtures: covered });
  const settledStagnant = await d.ask(TOKENS.owner, "ما الأصناف الراكدة؟");
  assert.ok(/لا يوجد صنف راكد بهذا التعريف/.test(String(settledStagnant.body.reply)),
    "لم يحسم «لا صنف راكد» رغم اكتمال التغطية");
  // والمُشغِّل الثاني الذي سمّته المراجعة: بلوغ سقف الصفوف. النافذة هنا كاملة،
  // والنقص من التصفيح وحده — ويجب أن يحجب الحكم كما يحجبه غياب النافذة.
  const many = [];
  for (let i = 0; i < 60; i += 1) {
    many.push({ id: i + 1, sale_date: today, bill_no: `b${i}`, bill_type: "retail",
      item_name: "ماستر طويل ورق", qty: 1, line_total: 10, unit_cost: 9, customer_name: "س" });
  }
  const truncated = { ...covered, sales_line_items: many };
  const e = await loadAssistant({ fixtures: truncated, hardRowCap: 40 });
  const capped = await e.ask(TOKENS.owner, "ماذا يجب أن أشتري؟");
  const cappedText = String(capped.body.reply);
  assert.ok(!/لا حاجة شراء عاجلة بهذا المعيار/.test(cappedText),
    `أصدر حكم «لا حاجة شراء» عن قراءة مبتورة رغم اكتمال النافذة:\n${cappedText}`);
  assert.equal(capped.body.answered, false, "ادّعى حسم توصية الشراء عن قراءة مبتورة");
  assert.ok(/سقف الأمان/.test(cappedText), `لم يذكر بلوغ سقف الصفوف سبباً:\n${cappedText}`);

  const f = await loadAssistant({ fixtures: truncated, hardRowCap: 40 });
  const cappedStagnant = await f.ask(TOKENS.owner, "ما الأصناف الراكدة؟");
  assert.equal(cappedStagnant.body.answered, false, "ادّعى حسم الأصناف الراكدة عن قراءة مبتورة");
  // والحكم **الموجب** في الراكد أخطر من السالب: القراءة الناقصة تُصغّر مجموعة
  // المُباع فتنقل صنفاً رائجاً إلى «الراكد»، والقائمة تُغري بتصفية مخزونه.
  // (رصدها Codex بعد aca9bb2.)
  const stock = {
    ...covered,
    "inventory_reports:ameen_sql_agent": [{
      report_date: today,
      created_at: new Date().toISOString(),
      summary: { totalStockItems: 2, lowStockItems: 0, outOfStockItems: 0 },
      items: [
        { key: "k1", name: "ماستر طويل ورق", stockQty: 500, unit1Name: "علبة" },
        { key: "k2", name: "صنف بلا حركة", stockQty: 300, unit1Name: "علبة" }
      ]
    }],
    sales_line_items: many
  };
  const g = await loadAssistant({ fixtures: stock, hardRowCap: 40 });
  const positive = await g.ask(TOKENS.owner, "ما الأصناف الراكدة؟");
  const positiveText = String(positive.body.reply);
  assert.ok(/صنف بلا حركة/.test(positiveText), `لم يدخل الفرع الموجب:\n${positiveText}`);
  assert.equal(positive.body.answered, false, "أصدر حكم ركود موجباً عن قراءة مبتورة");
  assert.ok(/مرشّحون غير مؤكَّدين/.test(positiveText), `قدّم المرشّحين كحكم راكد مؤكَّد:\n${positiveText}`);
  assert.ok(!/مخزون موجود بلا أي بيع خلال/.test(positiveText), "أبقى صيغة الحكم القاطع رغم النقص");

  // وباكتمال التغطية يُحسم الحكم الموجب طبيعياً
  const h = await loadAssistant({ fixtures: { ...stock, sales_line_items: [many[0]] } });
  const settledPositive = await h.ask(TOKENS.owner, "ما الأصناف الراكدة؟");
  assert.ok(/مخزون موجود بلا أي بيع خلال/.test(String(settledPositive.body.reply)),
    "لم يحسم الحكم الموجب رغم اكتمال التغطية");
  assert.equal(settledPositive.body.answered, true, "امتنع عن الحكم الموجب رغم اكتمال التغطية");
  ok("أحكام الراكد والشراء تُحجب عند نقص المعطيات — سالبةً وموجبةً — وتُحسم عند اكتمالها");
}

// ── م) كل مستهلك لسطور المبيعات يمرّ بذيل الاكتمال — لا استثناء ─────────────
{
  // حارس بنيوي لا سلوكي: ثلاث جولات مراجعة متتالية كشفت مستهلكاً منسياً في
  // كل مرة (المقارنة، ثم الملخص، ثم فرعا «لا شيء»). فالقاعدة تُثبَّت على
  // الشكل نفسه: من ينادي readSales ينادي salesCompleteness في كل مخرج له.
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../supabase/functions/financial-assistant/index.ts", import.meta.url), "utf8");

  const readSalesCalls = (src.match(/await readSales\(/g) ?? []).length - 0;
  const completenessCalls = (src.match(/await salesCompleteness\(/g) ?? []).length;
  assert.ok(readSalesCalls >= 6, `عدد مستهلكي readSales غير متوقَّع (${readSalesCalls})`);
  assert.ok(
    completenessCalls >= readSalesCalls,
    `مستهلكو readSales ${readSalesCalls} وذيول الاكتمال ${completenessCalls} — مستهلك بلا حدود صدق`
  );
  // ولا يبقى نداء تحذيرِ نافذةٍ للمبيعات خارج الذيل الموحّد، وإلا عاد الانفصال
  // الذي جعل كل جولة تكشف منسيّاً جديداً.
  assert.doesNotMatch(
    src.replace(/async function salesCompleteness[\s\S]*?\n}\n/, ""),
    /coverageWarning\([^)]*SALES_COVERAGE\)/,
    "تحذير نافذة المبيعات يجب أن يمرّ من salesCompleteness وحده"
  );
  ok("كل مستهلك لسطور المبيعات يمرّ بذيل الاكتمال الموحّد — التصفيح والنافذة معاً");
}

// ── ن) الأرقام العربية-الهندية تُفهم كما تُكتب على iPhone ───────────────────
{
  // ملاحظة Codex على PR #205 بعد 4fb0d18: لوحة iPhone العربية تكتب «٣٠» لا
  // «30»، وكل أنماط الفترات تطابق \d. فالمطابقة تفشل ويسقط السؤال على فرع
  // اليوم الافتراضي، فيُجاب سؤالُ شهرٍ بمبيعات **اليوم** بلا أي إشارة.
  const day = (n) => new Date(Date.now() + 180 * 60_000 - n * 86_400_000).toISOString().slice(0, 10);
  const fixtures = defaultFixtures();
  fixtures.sales_line_items = [
    { id: 1, sale_date: day(0), bill_no: "1", bill_type: "retail", item_name: "أ", qty: 1, line_total: 100, unit_cost: 90, customer_name: "س" },
    { id: 2, sale_date: day(20), bill_no: "2", bill_type: "retail", item_name: "أ", qty: 1, line_total: 55, unit_cost: 50, customer_name: "س" }
  ];
  fixtures.sales_line_items_sync_state = [{
    source: "ameen_sales_line_items", window_start: day(40), window_end: day(0),
    row_count: 2, completed_at: new Date().toISOString()
  }];

  const a = await loadAssistant({ fixtures });
  const arabic = String((await a.ask(TOKENS.owner, "كم مبيعات اخر ٣٠ يوم؟")).body.reply);
  assert.ok(/155/.test(arabic), `لم يفهم «٣٠» فسقط على فترة أخرى:\n${arabic}`);
  assert.ok(arabic.includes(day(29)), `لم تُحسب الفترة من ٣٠ يوماً:\n${arabic}`);

  // والصيغة اللاتينية تبقى كما هي
  const b = await loadAssistant({ fixtures });
  assert.ok(/155/.test(String((await b.ask(TOKENS.owner, "كم مبيعات اخر 30 يوم؟")).body.reply)),
    "كسرت الصيغة اللاتينية");
  ok("الأرقام العربية-الهندية تُطبَّع، فسؤال «آخر ٣٠ يوم» لا يسقط على اليوم");
}

// ── هـ2) الموظف لا يعيد بناء تقرير المبيعات من أداة الصنف ───────────────────
{
  // ملاحظة Codex على PR #205 بعد 4fb0d18: أداة المبيعات محصورة بالمالك، لكن
  // حركة الصنف مفتوحة للموظف وكانت تعرض قيمة المبيعات وأسماء أكبر المشترين
  // وكمياتهم — فتكرارها على الأصناف يعيد بناء التقرير المحمي ونشاط الزبائن.
  const owner = await loadAssistant();
  const ownerText = String((await owner.ask(TOKENS.owner, "ما حركة ماستر طويل ورق؟")).body.reply);
  assert.ok(/قيمة المبيعات/.test(ownerText), "المالك فقد قيمة المبيعات");
  assert.ok(/جهاد التلي/.test(ownerText), "المالك فقد أسماء المشترين");

  const employee = await loadAssistant();
  const empResult = await employee.ask(TOKENS.employee, "ما حركة ماستر طويل ورق؟");
  const empText = String(empResult.body.reply);
  assert.equal(empResult.status, 200, "الموظف حُجب عن الأداة كلياً بدل حجب التفاصيل");
  assert.ok(/الكمية المباعة/.test(empText), `الموظف فقد حركة المخزون المشروعة:\n${empText}`);
  assert.ok(!/قيمة المبيعات/.test(empText), `الموظف رأى قيمة المبيعات:\n${empText}`);
  assert.ok(!/أكثر المشترين/.test(empText), `الموظف رأى ترتيب المشترين:\n${empText}`);
  assert.ok(!/جهاد التلي/.test(empText), `الموظف رأى اسم زبون:\n${empText}`);
  // والحجب عند المصدر: العمودان لا يُقرآن أصلاً لغير المالك
  const empReads = employee.metrics.reads.filter((q) => q.startsWith("sales_line_items?"));
  assert.ok(empReads.length > 0, "لم يقرأ سطور المبيعات أصلاً");
  for (const q of empReads) {
    assert.ok(!/customer_name/.test(q), `طلب اسم الزبون لموظف: ${q}`);
    assert.ok(!/line_total/.test(q), `طلب قيمة السطر لموظف: ${q}`);
  }
  ok("الموظف يرى كمية حركة الصنف فقط — لا قيمة ولا أسماء زبائن، ومحجوبة عند المصدر");
}

// ── و2) أولوية الشراء الموجبة تُحجب كذلك — الكميات مُوقَّعة ─────────────────
{
  // ملاحظة Codex على PR #205 بعد 4fb0d18، وهي تنقض تبريراً صرّحتُ به: ظننتُ
  // البتر يخفض perDay وحده فيبقى الفرع الموجب سليماً. لكن الكميات مُوقَّعة
  // والمرتجعات سالبة، فبتر صفٍّ سالب قديم مع إبقاء موجبٍ أحدث **يضخّم**
  // المعدّل ويقصّر التغطية، فيدخل القائمةَ صنفٌ مخزونه كافٍ.
  const today = new Date(Date.now() + 180 * 60_000).toISOString().slice(0, 10);
  const fixtures = defaultFixtures();
  fixtures["inventory_reports:ameen_sql_agent"] = [{
    report_date: today, created_at: new Date().toISOString(),
    summary: { totalStockItems: 1, lowStockItems: 0, outOfStockItems: 0 },
    items: [{ key: "k1", name: "صنف مطلوب", stockQty: 10, unit1Name: "علبة" }]
  }];
  const rows = [];
  for (let i = 0; i < 60; i += 1) {
    rows.push({ id: i + 1, sale_date: today, bill_no: `b${i}`, bill_type: "retail",
      item_name: "صنف مطلوب", qty: 5, line_total: 50, unit_cost: 40, customer_name: "س" });
  }
  fixtures.sales_line_items = rows;
  fixtures.sales_line_items_sync_state = [{
    source: "ameen_sales_line_items",
    window_start: new Date(Date.now() + 180 * 60_000 - 60 * 86_400_000).toISOString().slice(0, 10),
    window_end: today, row_count: rows.length, completed_at: new Date().toISOString()
  }];

  const a = await loadAssistant({ fixtures, hardRowCap: 40 });
  const capped = await a.ask(TOKENS.owner, "ماذا يجب أن أشتري؟");
  const cappedText = String(capped.body.reply);
  assert.ok(/صنف مطلوب/.test(cappedText), `لم يدخل الفرع الموجب:\n${cappedText}`);
  assert.equal(capped.body.answered, false, "أصدر أولوية شراء مؤكَّدة عن قراءة مبتورة");
  assert.ok(/مرشّحون غير مؤكَّدين/.test(cappedText), `قدّمهم أولوية شراء مؤكَّدة:\n${cappedText}`);
  assert.ok(!/^\*\*أولوية الشراء — مرتّبة/m.test(cappedText), "أبقى صيغة الحكم القاطع رغم البتر");

  const b = await loadAssistant({ fixtures });
  const settled = await b.ask(TOKENS.owner, "ماذا يجب أن أشتري؟");
  assert.ok(/مرتّبة بأيام التغطية/.test(String(settled.body.reply)), "لم يحسم الأولوية رغم اكتمال القراءة");
  assert.equal(settled.body.answered, true, "امتنع رغم اكتمال القراءة");
  ok("أولوية الشراء الموجبة تُحجب عند البتر — الكميات مُوقَّعة فالبتر قد يضخّم المعدّل");
}

console.log(`\nتوجيه المساعد الذكي: ${passed}/${passed} تحقق ناجح`);
