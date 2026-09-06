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

console.log(`\nتوجيه المساعد الذكي: ${passed}/${passed} تحقق ناجح`);
