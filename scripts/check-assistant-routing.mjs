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
  ["ما الذمم علينا؟", "payables", null],
  ["كم علينا ديون؟", "payables", null],
  ["ما رصيد الزبون سامر الوهمي؟", "customer", "inventory_reports"],
  ["ماذا اشترى الزبون سامر الوهمي؟", "customer", "inventory_reports"],
  ["مبيعات الزبون سامر الوهمي اليوم", "customer", "inventory_reports"],
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
  // النفي القاطع يشترط تغطية متحقَّقة — بلاها يُحجب الحكم (انظر فرع الصفر خارج النافذة).
  const empty = defaultFixtures();
  empty.sales_line_items = [{ sale_date: "2026-08-01", bill_no: "1", bill_type: "retail", item_name: "x", qty: 1, line_total: 5, customer_name: "y" }];
  const today = new Date(Date.now() + 180 * 60_000).toISOString().slice(0, 10);
  empty.sales_line_items_sync_state = [{
    source: "ameen_sales_line_items",
    window_start: new Date(Date.now() + 180 * 60_000 - 29 * 86_400_000).toISOString().slice(0, 10),
    window_end: today,
    row_count: 1,
    completed_at: new Date().toISOString()
  }];
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
  // الوسم صار «عدد فواتير الشراء» عمداً بعد فصل المرتجعات — العدد نفسه لم يتغيّر.
  assert.ok(/عدد فواتير الشراء: \*\*2\*\*/.test(reply), "أخفى عدد الفواتير وهو رقم سليم");
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
  const today = new Date(Date.now() + 180 * 60_000).toISOString().slice(0, 10);
  const fixtures = defaultFixtures();
  fixtures.expense_entries = Array.from({ length: 300 }, (_, i) => ({
    id: i + 1,
    entry_date: today,
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
      name: "سامر الوهمي",
      customerGuid: "GUID-مختلف-تماماً",
      invoices: [{ date: "2026-08-29", lines: [
        { material: "بضاعة زبون آخر", qty: 99, price: 1234, unit1: "كروز", lineTotal: 122166 }
      ] }]
    }]
  }];
  const a = await loadAssistant({ fixtures });
  const result = await a.ask(TOKENS.owner, "ماذا اشترى الزبون سامر الوهمي؟");
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
  const result = await a.ask(TOKENS.owner, "ماذا اشترى الزبون سامر الوهمي؟");
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

  // وفترة خالية خارج النافذة: «لا توجد فاتورة» نفيٌ قاطع كان يُصدَر مع تحذير
  // ملحق — والتحذير لا يسحب النفي. يجب حجب الحكم (answered=false) عبر
  // salesCompleteness.complete. (Codex P1 بعد f5cabd6 — discussion_r4017908925.)
  const far = new Date(Date.now() + 180 * 60_000 - 100 * 86_400_000).toISOString().slice(0, 10);
  const empty = await loadAssistant({ fixtures: { ...fixtures, sales_line_items: [
    { id: 9, sale_date: far, bill_no: "9", bill_type: "retail", item_name: "أ", qty: 1, line_total: 10, unit_cost: 9, customer_name: "س" }
  ] } });
  const emptyResult = await empty.ask(TOKENS.owner, "كم مبيعات اخر 60 يوم؟");
  const emptyText = String(emptyResult.body.reply);
  assert.equal(emptyResult.body.answered, false, `نفي قاطع عن فترة خارج النافذة رغم عدم اكتمال التغطية:\n${emptyText}`);
  assert.ok(/غير محسومة/.test(emptyText), `لم يمتنع صراحةً عن البتّ:\n${emptyText}`);
  assert.ok(/فلا أجزم بغيابها/.test(emptyText), `لم يصرّح بأن الغياب غير مؤكَّد:\n${emptyText}`);
  assert.ok(!/لا توجد أي فاتورة مسجّلة/.test(emptyText), `نفى وجود فواتير رغم أن الفترة خارج النافذة:\n${emptyText}`);
  assert.ok(/خارج آخر نافذة مزامنة متحقَّقة/.test(emptyText), `لم يُعلن خروج الفترة عن النافذة:\n${emptyText}`);

  // وفترة خالية داخل النافذة ⇒ النفي القاطع مسموح
  const todayOnly = await loadAssistant({ fixtures: { ...fixtures, sales_line_items: [
    { id: 9, sale_date: far, bill_no: "9", bill_type: "retail", item_name: "أ", qty: 1, line_total: 10, unit_cost: 9, customer_name: "س" }
  ] } });
  const todayEmpty = await todayOnly.ask(TOKENS.owner, "كم مبيعات اليوم؟");
  const todayEmptyText = String(todayEmpty.body.reply);
  assert.equal(todayEmpty.body.answered, true, `فترة داخل النافذة بلا صفوف يجب أن تنفي بثقة:\n${todayEmptyText}`);
  assert.ok(/لا توجد أي فاتورة مسجّلة/.test(todayEmptyText), `لم يصل لفرع الصفر داخل النافذة:\n${todayEmptyText}`);
  ok("الفترة خارج نافذة المزامنة المتحقَّقة تُعلَن صراحةً — ونفي الصفر يُحجب خارجها ويُسمح داخله");
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

  // وفترة خالية خارج النافذة مع صفوف أحدث في الجدول: لا نفي قاطع.
  // (Codex P1 بعد f5cabd6 — discussion_r4017908914.)
  const emptyOutside = await loadAssistant({ fixtures: {
    ...fixtures,
    expense_entries: [
      { id: 1, entry_date: today, account_name: "محروقات", amount: 45, notes: "" }
    ]
  } });
  const emptyOutResult = await emptyOutside.ask(TOKENS.owner, "كم مصاريف الشهر الماضي؟");
  const emptyOutText = String(emptyOutResult.body.reply);
  assert.equal(emptyOutResult.body.answered, false, `نفي قاطع عن مصاريف خارج النافذة:\n${emptyOutText}`);
  assert.ok(/غير محسومة/.test(emptyOutText), `لم يمتنع صراحة عن البتّ في المصاريف:\n${emptyOutText}`);
  assert.ok(/فلا أجزم بغياب المصروف/.test(emptyOutText), `لم يصرّح بأن غياب المصروف غير مؤكَّد:\n${emptyOutText}`);
  assert.ok(!/لا توجد أي حركة مصروف مسجّلة/.test(emptyOutText), `نفى المصروف رغم أن الفترة خارج النافذة:\n${emptyOutText}`);

  // وفترة خالية داخل النافذة ⇒ النفي القاطع مسموح
  const emptyInside = await loadAssistant({ fixtures: {
    ...fixtures,
    expense_entries: [
      { id: 2, entry_date: old, account_name: "أجور نقل", amount: 500, notes: "" }
    ]
  } });
  const emptyInResult = await emptyInside.ask(TOKENS.owner, "كم دفعنا اليوم؟");
  const emptyInText = String(emptyInResult.body.reply);
  assert.equal(emptyInResult.body.answered, true, `فترة مصاريف داخل النافذة بلا صفوف يجب أن تنفي بثقة:\n${emptyInText}`);
  assert.ok(/لا توجد أي حركة مصروف مسجّلة/.test(emptyInText), `لم يصل لفرع صفر المصاريف داخل النافذة:\n${emptyInText}`);
  ok("المصاريف محدودة بنافذة تحديثها المتحقَّقة، ونفي الصفر يُحجب خارجها ويُسمح داخله");
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

// ── لأ) مرتجع سالب وحده لا يُخرج صنفاً من قائمة الراكد (Codex على bea03ea) ──
{
  // كانت مجموعة «المُباع» في أداة الراكد تُبنى من كل سطور sales_line_items
  // بلا تمييز إشارة الكمية — فمرتجع (qty<0) بلا أي بيع موجب مقابل كان يُدخل
  // الصنف في «المُباع» ويُخفي ركوداً فعلياً.
  const today = new Date(Date.now() + 180 * 60_000).toISOString().slice(0, 10);
  const syncState = (rowCount) => [{
    source: "ameen_sales_line_items",
    window_start: new Date(Date.now() + 180 * 60_000 - 89 * 86_400_000).toISOString().slice(0, 10),
    window_end: today,
    row_count: rowCount,
    completed_at: new Date().toISOString()
  }];
  const stockFixtures = (name) => ({
    ...defaultFixtures(),
    "inventory_reports:ameen_sql_agent": [{
      report_date: today,
      created_at: new Date().toISOString(),
      summary: { totalStockItems: 1, lowStockItems: 0, outOfStockItems: 0 },
      items: [{ key: "k1", name, stockQty: 100, unit1Name: "علبة" }]
    }]
  });

  // CASE 1: مرتجع سالب فقط، بلا أي بيع موجب ⇒ يبقى راكداً
  const returnOnlyFixtures = stockFixtures("صنف مرتجع فقط");
  returnOnlyFixtures.sales_line_items = [
    { id: 1, sale_date: today, bill_no: "1", bill_type: "retail", item_name: "صنف مرتجع فقط", qty: -3, line_total: -30, unit_cost: 9, customer_name: "س" }
  ];
  returnOnlyFixtures.sales_line_items_sync_state = syncState(1);
  const caseReturnOnly = await loadAssistant({ fixtures: returnOnlyFixtures });
  const returnOnlyText = String((await caseReturnOnly.ask(TOKENS.owner, "ما الأصناف الراكدة؟")).body.reply);
  assert.ok(/صنف مرتجع فقط/.test(returnOnlyText), `مرتجع سالب وحده أخرج الصنف من الراكد خطأً:\n${returnOnlyText}`);

  // CASE 2: مرتجع سالب + بيع موجب لنفس الصنف ⇒ مُباع فعلاً، لا راكد
  const mixedFixtures = stockFixtures("صنف مباع ومرتجع");
  mixedFixtures.sales_line_items = [
    { id: 1, sale_date: today, bill_no: "1", bill_type: "retail", item_name: "صنف مباع ومرتجع", qty: -3, line_total: -30, unit_cost: 9, customer_name: "س" },
    { id: 2, sale_date: today, bill_no: "2", bill_type: "retail", item_name: "صنف مباع ومرتجع", qty: 5, line_total: 50, unit_cost: 9, customer_name: "ص" }
  ];
  mixedFixtures.sales_line_items_sync_state = syncState(2);
  const caseMixed = await loadAssistant({ fixtures: mixedFixtures });
  const mixedText = String((await caseMixed.ask(TOKENS.owner, "ما الأصناف الراكدة؟")).body.reply);
  assert.ok(!/صنف مباع ومرتجع/.test(mixedText), `بيع موجب موجود ولم يُستبعد الصنف من الراكد:\n${mixedText}`);

  // CASE 3: بيع موجب طبيعي فقط (بلا مرتجع) ⇒ السلوك القديم يبقى كما هو
  const plainFixtures = stockFixtures("صنف مباع عادي");
  plainFixtures.sales_line_items = [
    { id: 1, sale_date: today, bill_no: "1", bill_type: "retail", item_name: "صنف مباع عادي", qty: 5, line_total: 50, unit_cost: 9, customer_name: "س" }
  ];
  plainFixtures.sales_line_items_sync_state = syncState(1);
  const casePlain = await loadAssistant({ fixtures: plainFixtures });
  const plainText = String((await casePlain.ask(TOKENS.owner, "ما الأصناف الراكدة؟")).body.reply);
  assert.ok(!/صنف مباع عادي/.test(plainText), `بيع موجب عادي بلا مرتجع صار راكداً خطأً:\n${plainText}`);

  ok("مرتجع سالب بلا بيع موجب لا يُخرج الصنف من قائمة الراكد، وبيع موجب حقيقي يستبعده كما كان");
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
  assert.ok(/سامر الوهمي/.test(ownerText), "المالك فقد أسماء المشترين");

  const employee = await loadAssistant();
  const empResult = await employee.ask(TOKENS.employee, "ما حركة ماستر طويل ورق؟");
  const empText = String(empResult.body.reply);
  assert.equal(empResult.status, 200, "الموظف حُجب عن الأداة كلياً بدل حجب التفاصيل");
  assert.ok(/الكمية المباعة/.test(empText), `الموظف فقد حركة المخزون المشروعة:\n${empText}`);
  assert.ok(!/قيمة المبيعات/.test(empText), `الموظف رأى قيمة المبيعات:\n${empText}`);
  assert.ok(!/أكثر المشترين/.test(empText), `الموظف رأى ترتيب المشترين:\n${empText}`);
  assert.ok(!/سامر الوهمي/.test(empText), `الموظف رأى اسم زبون:\n${empText}`);
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

// ── ه‍3) استبدالٌ ذرّي أثناء التصفيح لا يمرّ كإجمالي كامل ───────────────────
{
  // ملاحظة Codex على PR #205 بعد 82e9022: التصفيح بـoffset يفترض جدولاً
  // ساكناً، والاستبدال الذرّي يحذف النافذة ويُدرجها من جديد — فصفحةٌ لاحقة
  // تكرّر صفوفاً وتُسقط أخرى، وعلامة المزامنة بعدها تبدو حديثة و`partial`
  // يبقى false، فيُقدَّم إجمالي مشوّه على أنه كامل ومتحقَّق.
  const today = new Date(Date.now() + 180 * 60_000).toISOString().slice(0, 10);
  const rows = [];
  for (let i = 0; i < 120; i += 1) {
    rows.push({ id: i + 1, sale_date: today, bill_no: `b${i}`, bill_type: "retail",
      item_name: "أ", qty: 1, line_total: 10, unit_cost: 9, customer_name: "س" });
  }
  const state = (runId) => [{
    source: "ameen_sales_line_items", sync_run_id: runId,
    window_start: today, window_end: today, row_count: rows.length,
    completed_at: new Date().toISOString()
  }];
  const fixtures = { ...defaultFixtures(), sales_line_items: rows, sales_line_items_sync_state: state("run-1") };

  // مزامنة تلتزم لقطة واحدة ⇒ الرقم كامل
  const stable = await loadAssistant({ fixtures, maxRows: 40 });
  const stableResult = await stable.ask(TOKENS.owner, "كم مبيعات اليوم؟");
  assert.ok(/1,200/.test(String(stableResult.body.reply)), `لم يقرأ الفترة كاملةً:\n${String(stableResult.body.reply)}`);
  assert.notEqual(stableResult.body.partial, true, "أعلن البتر رغم ثبات اللقطة");

  // استبدالٌ واحد يلتزم بين الصفحات ⇒ تُعاد القراءة على لقطة ثابتة، فيخرج
  // الرقم صحيحاً وكاملاً. الإعادة هي الغرض: لا رقم مشوّه ولا امتناع بلا داعٍ.
  let flipped = false;
  const shifting = await loadAssistant({
    fixtures: { ...fixtures, sales_line_items_sync_state: state("run-1") },
    maxRows: 40,
    onRead: (query, fx) => {
      if (!flipped && /offset=40/.test(query)) {
        flipped = true;
        fx.sales_line_items_sync_state = state("run-2");
      }
    }
  });
  const shiftedResult = await shifting.ask(TOKENS.owner, "كم مبيعات اليوم؟");
  const shiftedText = String(shiftedResult.body.reply);
  const firstPages = shifting.metrics.reads.filter((q) => q.startsWith("sales_line_items?") && /offset=0&/.test(q));
  assert.ok(firstPages.length >= 2, "لم يُعِد القراءة رغم تبدّل لقطة المزامنة بين الصفحات");
  assert.ok(/1,200/.test(shiftedText), `الرقم بعد الإعادة ليس المجموع الصحيح:\n${shiftedText}`);
  assert.notEqual(shiftedResult.body.partial, true, "امتنع رغم أن الإعادة استقرّت");

  // واستبدالٌ لا يستقرّ (يلتزم عند كل محاولة) ⇒ لا يُقدَّم الرقم نهائياً
  let runs = 0;
  const unstable = await loadAssistant({
    fixtures: { ...fixtures, sales_line_items_sync_state: state("run-1") },
    maxRows: 40,
    onRead: (query, fx) => {
      // بادئة مختلفة عن "run-1" الابتدائية: بدونها تُنتج أول قلبة نفس القيمة
      // فتبدو اللقطة ثابتة، ويمرّ الاختبار على حالة لم تُحاكَ أصلاً.
      if (/offset=40/.test(query)) fx.sales_line_items_sync_state = state(`shift-${++runs}`);
    }
  });
  const unstableResult = await unstable.ask(TOKENS.owner, "كم مبيعات اليوم؟");
  const unstableText = String(unstableResult.body.reply);
  assert.equal(unstableResult.body.partial, true, "قدّم رقماً قُرئ عبر استبدال متكرّر على أنه نهائي");
  assert.ok(/جزئية وليست نهائية|جزئي وليس نهائياً/.test(unstableText),
    `لم يُعلن أن الرقم غير نهائي بعد تعذّر تثبيت اللقطة:\n${unstableText}`);
  ok("القراءة تُثبَّت على لقطة مزامنة واحدة: تُعاد عند تبدّلها، وتُعلَن غير نهائية إن لم تستقرّ");
}

// ── ي) غياب جدول علامة المزامنة يُعلَن ولا يُسقط الأداة ─────────────────────
{
  // الملفّان SQL يُطبَّقان يدوياً ومستقلَّين عن نشر الدالة، فبينهما يردّ
  // PostgREST 404 على جدول العلامة. لو رُميت هذه القراءة لسقطت الأداة كلها
  // بـ«تعذّرت قراءة المصدر» — أي أن إضافة حارسٍ للتحقق تُعطّل جواباً يعمل.
  const a = await loadAssistant({ failTable: "expense_entries_sync_state" });
  const expenses = await a.ask(TOKENS.owner, "كم دفعنا اليوم؟");
  assert.equal(expenses.status, 200);
  assert.equal(expenses.body.tool, "expenses", "غياب جدول العلامة حوّل التوجيه");
  const expText = String(expenses.body.reply);
  assert.ok(!/تعذّرت قراءة مصدر البيانات/.test(expText), `غياب جدول العلامة أسقط أداة المصاريف:\n${expText}`);
  assert.ok(/لا يوجد سجل مزامنة مكتمل/.test(expText), `لم يُعلن غياب التحقق:\n${expText}`);

  const b = await loadAssistant({ failTable: "sales_line_items_sync_state" });
  const sales = await b.ask(TOKENS.owner, "كم مبيعات اليوم؟");
  assert.equal(sales.body.tool, "sales");
  assert.ok(!/تعذّرت قراءة مصدر البيانات/.test(String(sales.body.reply)), "غياب جدول العلامة أسقط أداة المبيعات");
  ok("غياب جدول علامة المزامنة يُعلَن «غير متحقَّق» ولا يُسقط الأداة");
}

// ── ط) الفترة المطلوبة تُحترم في المشتريات وفواتير الزبون ───────────────────
{
  // ملاحظتان لـCodex على PR #205 بعد 82e9022: كلتاهما نفس الصنف الذي عولج في
  // تقارير الحركة — الفترة تُحسب صحيحةً ثم تتجاهلها الأداة.
  const day = (n) => new Date(Date.now() + 180 * 60_000 - n * 86_400_000).toISOString().slice(0, 10);
  const firstOfMonth = `${day(0).slice(0, 7)}-01`;
  const lastMonthEnd = new Date(Date.parse(`${firstOfMonth}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const lastMonthStart = `${lastMonthEnd.slice(0, 7)}-01`;

  const fixtures = defaultFixtures();
  fixtures.ameen_purchase_invoice_reports = [{
    report_date: day(0),
    created_at: new Date().toISOString(),
    summary: { bills: 99, suppliers: 40, fromDate: lastMonthStart },
    items: [
      { name: "مورّد قديم", invoices: [{ date: lastMonthEnd, items: [{ itemName: "س", qty: 1, lineTotal: 10, avgPrice: 10 }] }] },
      { name: "مورّد حالي", invoices: [{ date: day(0), items: [{ itemName: "ج", qty: 1, lineTotal: 20, avgPrice: 20 }] }] }
    ]
  }];

  const a = await loadAssistant({ fixtures });
  const lastMonth = String((await a.ask(TOKENS.owner, "ما مشتريات الشهر الماضي؟")).body.reply);
  assert.ok(/مورّد قديم/.test(lastMonth), `لم يعرض مورّد الشهر الماضي:\n${lastMonth}`);
  assert.ok(!/مورّد حالي/.test(lastMonth), `أدخل مورّد هذا الشهر في جواب الشهر الماضي:\n${lastMonth}`);
  assert.ok(!/\*\*99\*\*/.test(lastMonth), `عرض عدد فواتير اللقطة كلها (99) بدل عدد الفترة:\n${lastMonth}`);
  assert.ok(/عدد فواتير الشراء: \*\*1\*\*/.test(lastMonth), `لم يشتقّ العدد من المجموعة المُرشَّحة:\n${lastMonth}`);

  // وبلا فترة صريحة تبقى اللقطة كاملةً كما كانت
  const b = await loadAssistant({ fixtures });
  const all = String((await b.ask(TOKENS.owner, "ما المشتريات؟")).body.reply);
  assert.ok(/مورّد قديم/.test(all) && /مورّد حالي/.test(all), "سؤال بلا فترة فقد جزءاً من اللقطة");

  // فواتير الزبون: نفس القاعدة
  const invFixtures = defaultFixtures();
  invFixtures["inventory_reports:ameen_customer_invoices"] = [{
    report_date: day(0),
    created_at: new Date().toISOString(),
    summary: { fromDate: lastMonthStart },
    items: [{
      customerGuid: "aaa11111", name: "سامر الوهمي",
      invoices: [
        { date: day(0), lines: [{ material: "صنف اليوم", qty: 1, unit1: "علبة", price: 500, lineTotal: 500 }] },
        { date: lastMonthEnd, lines: [{ material: "صنف الشهر الماضي", qty: 1, unit1: "علبة", price: 700, lineTotal: 700 }] }
      ]
    }]
  }];
  const c = await loadAssistant({ fixtures: invFixtures });
  const bought = String((await c.ask(TOKENS.owner, "ماذا اشترى الزبون سامر الوهمي الشهر الماضي؟")).body.reply);
  assert.ok(/صنف الشهر الماضي/.test(bought), `لم يعرض فواتير الشهر الماضي:\n${bought}`);
  assert.ok(!/صنف اليوم/.test(bought), `عرض فاتورة هذا الشهر جواباً عن الشهر الماضي:\n${bought}`);
  ok("المشتريات وفواتير الزبون تُرشَّح بالفترة المطلوبة، وأعدادها مشتقّة منها");
}

// ── ض) لقطة المشتريات/الفواتير محدودة، فلا حكم قاطع خارجها ─────────────────
{
  // ملاحظات Codex الثلاث على PR #205 بعد d36b86f: الترشيح بالفترة الذي أُضيف
  // في الجولة السابقة أنشأ **أحكاماً قاطعة على لقطة ناقصة**. المنتِجان يقرآن
  // نافذة 60 يوماً ويقصّان كل جهة عند 200 فاتورة رافعَين truncated.
  const day = (n) => new Date(Date.now() + 180 * 60_000 - n * 86_400_000).toISOString().slice(0, 10);
  const windowStart = day(60);

  const fixtures = defaultFixtures();
  fixtures.ameen_purchase_invoice_reports = [{
    report_date: day(0), created_at: new Date().toISOString(),
    summary: { bills: 500, suppliers: 40, fromDate: windowStart },
    items: [{ name: "مورّد", truncated: true, invoices: [{ date: day(5), items: [{ itemName: "س", qty: 1, lineTotal: 10, avgPrice: 10 }] }] }]
  }];

  // فترة تتجاوز نافذة التقرير ⇒ تُعلَن ولا تُقدَّم الأعداد محسوبةً عليها
  const a = await loadAssistant({ fixtures });
  const long = String((await a.ask(TOKENS.owner, "ما مشتريات اخر 365 يوم؟")).body.reply);
  assert.ok(/تتجاوز نافذة تقرير المشتريات/.test(long), `لم يُعلن خروج الفترة عن نافذة التقرير:\n${long}`);
  assert.ok(long.includes(windowStart), "لم يذكر حدّ نافذة التقرير");
  assert.ok(!/محسوبة على الفترة المطلوبة وحدها/.test(long), `ادّعى الحساب على الفترة كاملةً:\n${long}`);

  // واللقطة المقصوصة تُعلَن ولو كانت الفترة داخل النافذة
  const b = await loadAssistant({ fixtures });
  const short = String((await b.ask(TOKENS.owner, "ما مشتريات الاسبوع؟")).body.reply);
  assert.ok(/اللقطة مقصوصة/.test(short), `لم يُعلن قصّ اللقطة (truncated):\n${short}`);

  // وفترة بلا فواتير خارج التغطية ⇒ امتناع لا نفي قاطع
  const c = await loadAssistant({ fixtures });
  const emptyOutside = await c.ask(TOKENS.owner, "ما مشتريات اخر 365 يوم؟");
  const outsideText = String(emptyOutside.body.reply);
  if (/لا توجد فواتير شراء/.test(outsideText)) {
    assert.equal(emptyOutside.body.answered, false, "نفى وجود مشتريات عن فترة لا يغطّيها التقرير");
  }

  // ولقطة كاملة غير مقصوصة تُحسم طبيعياً
  const covered = {
    ...fixtures,
    ameen_purchase_invoice_reports: [{
      ...fixtures.ameen_purchase_invoice_reports[0],
      summary: { bills: 1, suppliers: 1, fromDate: day(60) },
      items: [{ name: "مورّد", truncated: false, invoices: [{ date: day(5), items: [{ itemName: "س", qty: 1, lineTotal: 10, avgPrice: 10 }] }] }]
    }]
  };
  const d = await loadAssistant({ fixtures: covered });
  const clean = String((await d.ask(TOKENS.owner, "ما مشتريات الاسبوع؟")).body.reply);
  assert.ok(!/تتجاوز نافذة|اللقطة مقصوصة/.test(clean), `حذّر رغم اكتمال التغطية:\n${clean}`);

  // فواتير الزبون: نفس القاعدة — نفيٌ قاطع خارج التغطية يُمنع
  const invFixtures = defaultFixtures();
  invFixtures["inventory_reports:ameen_customer_invoices"] = [{
    report_date: day(0), created_at: new Date().toISOString(),
    summary: { fromDate: windowStart },
    items: [{ customerGuid: "aaa11111", name: "سامر الوهمي", truncated: true,
      invoices: [{ date: day(5), lines: [{ material: "صنف", qty: 1, unit1: "علبة", price: 500, lineTotal: 500 }] }] }]
  }];
  const e = await loadAssistant({ fixtures: invFixtures });
  const custLong = String((await e.ask(TOKENS.owner, "ماذا اشترى الزبون سامر الوهمي اخر 365 يوم؟")).body.reply);
  assert.ok(/تتجاوز نافذة تقرير فواتير الزبائن/.test(custLong),
    `لم يُعلن خروج فترة الزبون عن نافذة التقرير:\n${custLong}`);

  // وفرع الصفر تحديداً: فترة **داخل** النافذة بلا فواتير، لكن اللقطة مقصوصة
  // ⇒ امتناع لا نفي. (بلا هذه الحالة يبقى فرع النفي بلا تغطية أصلاً.)
  const f = await loadAssistant({ fixtures: invFixtures });
  const custEmpty = String((await f.ask(TOKENS.owner, "ماذا اشترى الزبون سامر الوهمي امس؟")).body.reply);
  assert.ok(!/لا توجد فواتير لهذا الزبون ضمن/.test(custEmpty),
    `نفى مشتريات الزبون رغم أن اللقطة مقصوصة:\n${custEmpty}`);
  assert.ok(/المشتريات — غير محسومة/.test(custEmpty),
    `لم يمتنع عن النفي رغم نقص التغطية:\n${custEmpty}`);

  // ولقطة كاملة غير مقصوصة ⇒ النفي يُحسم طبيعياً
  const cleanInv = {
    ...invFixtures,
    "inventory_reports:ameen_customer_invoices": [{
      ...invFixtures["inventory_reports:ameen_customer_invoices"][0],
      items: [{ ...invFixtures["inventory_reports:ameen_customer_invoices"][0].items[0], truncated: false }]
    }]
  };
  const g = await loadAssistant({ fixtures: cleanInv });
  const custClean = String((await g.ask(TOKENS.owner, "ماذا اشترى الزبون سامر الوهمي امس؟")).body.reply);
  assert.ok(/لا توجد فواتير لهذا الزبون ضمن/.test(custClean),
    `امتنع عن النفي رغم اكتمال التغطية:\n${custClean}`);
  ok("لقطة المشتريات وفواتير الزبائن: الفترة خارج نافذتها أو لقطةٌ مقصوصة تُعلَن، والنفي القاطع يُحجب");
}

// ── ظ) المرتجع ليس شراءً — في فواتير الزبون وفي المشتريات ──────────────────
{
  // ملاحظة Codex على PR #205 بعد ece2495: المنتِجان يرفعان `isReturn`
  // (BillType=3 للمبيعات، ونوع مرتجع الشراء للمشتريات)، والواجهة تميّزه منذ
  // زمن (src/app.js) — والمساعد وحده كان يعرضه تحت «المشتريات» بأصنافه
  // ومبلغه. فزبونٌ **أعاد** بضاعة يظهر وكأنه اشتراها: عكس الحقيقة، لا نقصٌ
  // فيها.
  const day = (n) => new Date(Date.now() + 180 * 60_000 - n * 86_400_000).toISOString().slice(0, 10);

  // زبون له مرتجع واحد فقط ⇒ لا يُقال إنه اشترى
  const onlyReturn = defaultFixtures();
  onlyReturn["inventory_reports:ameen_customer_invoices"] = [{
    report_date: day(0), created_at: new Date().toISOString(),
    summary: { fromDate: day(60) },
    items: [{ customerGuid: "aaa11111", name: "سامر الوهمي", truncated: false,
      invoices: [{ date: day(3), isReturn: true, lines: [{ material: "بضاعة مُعادة", qty: 2, unit1: "علبة", price: 300, lineTotal: 600 }] }] }]
  }];
  const a = await loadAssistant({ fixtures: onlyReturn });
  const retText = String((await a.ask(TOKENS.owner, "ماذا اشترى الزبون سامر الوهمي؟")).body.reply);
  assert.ok(/مرتجع/.test(retText), `لم يذكر المرتجع إطلاقاً:\n${retText}`);
  assert.ok(/لا فاتورة \*\*شراء\*\* له/.test(retText),
    `عرض المرتجع كأنه شراء:\n${retText}`);
  assert.ok(!/\*\*1\*\* فاتورة شراء/.test(retText), "عدّ المرتجع فاتورة شراء");

  // وزبون له شراء ومرتجع ⇒ يُفصلان ولا يُخلطان في العدد
  const mixed = defaultFixtures();
  mixed["inventory_reports:ameen_customer_invoices"] = [{
    report_date: day(0), created_at: new Date().toISOString(),
    summary: { fromDate: day(60) },
    items: [{ customerGuid: "aaa11111", name: "سامر الوهمي", truncated: false, invoices: [
      { date: day(2), lines: [{ material: "صنف مُشترى", qty: 1, unit1: "علبة", price: 900, lineTotal: 900 }] },
      { date: day(3), isReturn: true, lines: [{ material: "بضاعة مُعادة", qty: 2, unit1: "علبة", price: 300, lineTotal: 600 }] }
    ] }]
  }];
  const b = await loadAssistant({ fixtures: mixed });
  const mixText = String((await b.ask(TOKENS.owner, "ماذا اشترى الزبون سامر الوهمي؟")).body.reply);
  assert.ok(/\(1 فاتورة شراء ضمن/.test(mixText), `لم يفصل عدد الشراء عن المرتجع:\n${mixText}`);
  assert.ok(/1 مرتجع/.test(mixText), `لم يذكر المرتجع مفصولاً:\n${mixText}`);
  assert.ok(/صنف مُشترى/.test(mixText), "أسقط فاتورة الشراء");
  assert.ok(/بضاعة مُعادة/.test(mixText), "أسقط المرتجع كلياً بدل فصله");

  // والمشتريات: مرتجع الشراء لا يُعدّ فاتورة شراء
  const purch = defaultFixtures();
  purch.ameen_purchase_invoice_reports = [{
    report_date: day(0), created_at: new Date().toISOString(),
    summary: { bills: 2, suppliers: 1, fromDate: day(60) },
    items: [{ name: "مورّد", truncated: false, invoices: [
      { date: day(2), items: [{ itemName: "س", qty: 1, lineTotal: 10, avgPrice: 10 }] },
      { date: day(3), isReturn: true, items: [{ itemName: "س", qty: 1, lineTotal: 10, avgPrice: 10 }] }
    ] }]
  }];
  const c = await loadAssistant({ fixtures: purch });
  const purchText = String((await c.ask(TOKENS.owner, "ما المشتريات؟")).body.reply);
  assert.ok(/عدد فواتير الشراء: \*\*1\*\*/.test(purchText), `عدّ مرتجع الشراء فاتورة شراء:\n${purchText}`);
  assert.ok(/\*\*1\*\* مرتجع شراء/.test(purchText), `لم يُعلن مرتجع الشراء مفصولاً:\n${purchText}`);
  ok("المرتجع يُفصل عن الشراء ويُعنون — في فواتير الزبون وفي المشتريات");
}

// ── ت) الأرباح تحترم الفترة المطلوبة — لا أحدث تقرير دائماً ─────────────────
{
  // إصلاح #25 على PR #205: أداة `profit` كانت تتجاهل ctx.period كلياً وتقرأ
  // دائماً أحدث تقرير `ameen_daily_profit` بصرف النظر عن اليوم/الفترة
  // المطلوبة — فسؤال «كم كان الربح أمس؟» كان يُجاب برقم **اليوم**.
  const today = new Date(Date.now() + 180 * 60_000).toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() + 180 * 60_000 - 86_400_000).toISOString().slice(0, 10);
  const dayBefore = new Date(Date.now() + 180 * 60_000 - 2 * 86_400_000).toISOString().slice(0, 10);
  const profitDay = (date, net) => ({
    report_date: date,
    created_at: new Date(Date.parse(`${date}T12:00:00Z`)).toISOString(),
    summary: {
      currency: "USD", sales_gross: 1000, discounts: 0, returns: 0, net_sales: 1000,
      sales_cost: 900, gross_profit: 100, expenses: 20, net_profit: net,
      sales_bill_count: 1, line_count: 1, missing_cost_lines: 0, complete: true
    },
    items: []
  });
  const fixtures = defaultFixtures();
  fixtures["inventory_reports:ameen_daily_profit"] = [
    profitDay(today, 111),
    profitDay(yesterday, 222)
  ];

  const a = await loadAssistant({ fixtures });
  const yd = await a.ask(TOKENS.owner, "كم كان الربح امس؟");
  const ydText = String(yd.body.reply);
  assert.equal(yd.body.tool, "profit");
  assert.ok(ydText.includes("222"), `لم يقرأ ربح أمس:\n${ydText}`);
  assert.ok(!ydText.includes("111"), `عرض ربح اليوم جواباً عن أمس:\n${ydText}`);
  assert.ok(ydText.includes(yesterday), "لم يذكر تاريخ أمس");

  // «الاسبوع» = آخر 7 أيام (فترة صريحة تمتد أكثر من يوم) — لدينا تقريران فقط
  // داخلها (اليوم وأمس)، فتجميعهما يثبت أن الفترة تُحسب لا يوماً واحداً، وبقية
  // أيام الأسبوع فجوة يجب الإعلان عنها لا تجاهلها صامتاً.
  const b = await loadAssistant({ fixtures });
  const range = await b.ask(TOKENS.owner, "كم الربح هذا الاسبوع؟");
  const rangeText = String(range.body.reply);
  assert.ok(rangeText.includes("333"), `لم يجمع صافي الربح عبر يومي الفترة:\n${rangeText}`);
  assert.ok(/بلا تقرير حركة/.test(rangeText), `لم يُعلن الأيام الغائبة داخل الفترة:\n${rangeText}`);

  // وفترة صريحة بلا أي تقرير مطابق على الإطلاق ⇒ امتناع صريح، لا استبدال بتقرير من فترة أخرى
  const oldFixtures = defaultFixtures();
  oldFixtures["inventory_reports:ameen_daily_profit"] = [profitDay(dayBefore, 999)];
  const c = await loadAssistant({ fixtures: oldFixtures });
  const noneInRange = await c.ask(TOKENS.owner, "كم كان الربح امس؟");
  assert.equal(noneInRange.body.answered, false, "ادّعى الجواب عن يوم ربح بلا تقرير مطابق");

  // ويوم مطلوب صراحة بلا أي تقرير على الإطلاق ⇒ امتناع صريح، لا استبدال بيوم آخر
  const d = await loadAssistant({ fixtures: { ...fixtures, "inventory_reports:ameen_daily_profit": [profitDay(today, 111)] } });
  const missing = await d.ask(TOKENS.owner, "كم كان الربح امس؟");
  const missText = String(missing.body.reply);
  assert.equal(missing.body.answered, false, "ادّعى الجواب عن يوم ربح بلا تقرير");
  assert.ok(!missText.includes("111"), "استبدل يوم الربح الغائب بأرقام يوم آخر");
  assert.ok(missText.includes(today), "لم يذكر أحدث تاريخ متاح لتقرير الربح");

  // وبلا فترة صريحة يبقى السلوك القديم: أحدث تقرير وحده
  const e = await loadAssistant({ fixtures });
  const latest = await e.ask(TOKENS.owner, "ما الأرباح؟");
  assert.ok(String(latest.body.reply).includes("111"), "سؤال بلا فترة لم يأخذ أحدث تقرير ربح");
  ok("أداة الأرباح تحترم الفترة المطلوبة: يوم محدد، تجميع مدى، وامتناع صريح عند الغياب");
}

// ── ث) مرتجعات الشراء وحدها في الفترة لا تُقرأ «لا توجد فواتير» ─────────────
{
  // إصلاح #27 على PR #205: الشرط كان `if (ctx.period.explicit && !bills)`،
  // فيُعلن «لا توجد فواتير شراء في هذه الفترة» حتى حين توجد مرتجعات شراء
  // فيها بلا فواتير شراء جديدة — نفيٌ كاذب يُخفي مرتجعات حقيقية.
  const day = (n) => new Date(Date.now() + 180 * 60_000 - n * 86_400_000).toISOString().slice(0, 10);
  const fixtures = defaultFixtures();
  fixtures.ameen_purchase_invoice_reports = [{
    report_date: day(0), created_at: new Date().toISOString(),
    summary: { bills: 1, suppliers: 1, fromDate: day(60) },
    items: [{ name: "مورّد", truncated: false, invoices: [
      { date: day(2), isReturn: true, items: [{ itemName: "س", qty: 1, lineTotal: 10, avgPrice: 10 }] }
    ] }]
  }];

  const a = await loadAssistant({ fixtures });
  const result = await a.ask(TOKENS.owner, "ما مشتريات الاسبوع؟");
  const text = String(result.body.reply);
  assert.equal(result.body.tool, "purchases");
  assert.ok(!/لا توجد فواتير شراء في هذه الفترة/.test(text), `أخفى المرتجع تحت نفي «لا فواتير» كاذب:\n${text}`);
  assert.ok(/\*\*1\*\* مرتجع شراء/.test(text), `لم يُظهر مرتجع الشراء في الفترة:\n${text}`);
  assert.ok(/عدد فواتير الشراء: \*\*0\*\*/.test(text), `لم يُصفّر عدد فواتير الشراء الجديدة:\n${text}`);
  ok("فترة فيها مرتجعات شراء وحدها لا تُعلَن خطأً بلا فواتير — المرتجع يُعرض");
}

// ── خ) الترشيح بالمورّد أصبح ممكناً بعد ضبط entity على أداة المشتريات ───────
{
  // إصلاح #26 على PR #205: أداة `purchases` كانت بلا `entity`، فـ`ctx.entityText`
  // يبقى دائماً "" (يُملأ في المخطِّط فقط عند `tool.entity` صادقة) — فكتلة
  // الترشيح بالاسم (`if (ctx.entityText.trim())`) كانت شيفرة ميتة لا تُبلَغ أبداً.
  const a = await loadAssistant();
  const result = await a.ask(TOKENS.owner, "مشتريات مورد الذهبي");
  const text = String(result.body.reply);
  assert.equal(result.body.tool, "purchases");
  assert.ok(/تفصيل.*الذهبي/.test(text), `لم يدخل فرع تفصيل المورّد المطابق:\n${text}`);
  assert.ok(/قداحات ضو بايدا جديد/.test(text), `لم يعرض تفاصيل فواتير المورّد المطابق:\n${text}`);

  // ومورّد غير موجود ⇒ رسالة صريحة بعدم العثور عليه، لا صمت ولا تخمين
  const b = await loadAssistant();
  const missing = await b.ask(TOKENS.owner, "مشتريات مورد غير موجود اطلاقا");
  assert.ok(/لم أجد مورّداً باسم/.test(String(missing.body.reply)), "لم يُعلن عدم العثور على مورّد غير موجود");
  ok("ضبط entity:\"supplier\" على أداة المشتريات فعّل ترشيح المورّد بالاسم — لم يعد شيفرة ميتة");
}

// ── ذ) فواتير الزبون: إجمالي الرأس الموثوق + حسم وحدة الأسطر (Codex #28 / P1) ─
{
  // فواتير الزبون لا تحمل avgPrice كفواتير الشراء. بلا inv.total يبقى حارس
  // lineTotal مقابل qty×price. ومع inv.total يُعتمد رأس الفاتورة ويُحسَم أساس
  // كل سطر (نمط invoiceLineBasisPlan في src/app.js / printing.md).
  const consistentFixtures = defaultFixtures();
  consistentFixtures["inventory_reports:ameen_customer_invoices"] = [{
    report_date: "2026-09-06",
    created_at: new Date().toISOString(),
    summary: { bills: 1, customers: 1, fromDate: "2026-07-08" },
    items: [{
      name: "سامر الوهمي",
      customerGuid: "aaa11111",
      invoices: [{ date: "2026-08-29", total: 1000, lines: [
        { material: "صنف عادي", qty: 10, price: 100, unit1: "علبة", lineTotal: 1000 }
      ] }]
    }]
  }];
  const a = await loadAssistant({ fixtures: consistentFixtures });
  const normal = String((await a.ask(TOKENS.owner, "ماذا اشترى الزبون سامر الوهمي؟")).body.reply);
  assert.ok(/إجمالي 1,000 USD/.test(normal), `فاتورة متسقة لم تُظهر إجمالياً صريحاً:\n${normal}`);
  assert.ok(!normal.includes("لم أعرض إجمالي هذه الفاتورة عمداً"), "امتنع عن إجمالي فاتورة متسقة بلا سبب");

  // بلا إجمالي رأس + تعارض qty×price مع lineTotal ⇒ امتناع (الحارس القديم).
  const conflictFixtures = defaultFixtures();
  conflictFixtures["inventory_reports:ameen_customer_invoices"] = [{
    report_date: "2026-09-06",
    created_at: new Date().toISOString(),
    summary: { bills: 1, customers: 1, fromDate: "2026-07-08" },
    items: [{
      name: "سامر الوهمي",
      customerGuid: "aaa11111",
      invoices: [{ date: "2026-08-27", lines: [
        // qty×price = 4,593,750 بينما lineTotal المخزَّن = 91,850 — تعارض صريح
        { material: "مالبورو غولد كرتون", qty: 3750, price: 1225, unit1: "كرتونة", lineTotal: 91850 }
      ] }]
    }]
  }];
  const b = await loadAssistant({ fixtures: conflictFixtures });
  const conflict = String((await b.ask(TOKENS.owner, "ماذا اشترى الزبون سامر الوهمي؟")).body.reply);
  assert.ok(/لم أعرض إجمالي هذه الفاتورة عمداً/.test(conflict), `لم يمتنع عن إجمالي الفاتورة المتعارضة بلا رأس:\n${conflict}`);
  assert.ok(!/إجمالي 91,850 USD/.test(conflict), "عرض إجمالياً قاطعاً رغم تعارض وحدة السعر بلا total");
  assert.ok(conflict.includes("مالبورو غولد كرتون"), "أخفى بند الفاتورة رغم أن الإخفاء يخص الإجمالي فقط");
  assert.ok(conflict.includes("= 91,850 USD"), "غيّر lineTotal المعروض بالسطر رغم أن التعديل ممنوع عند غياب الخطة");

  // فاتورة #733: lineTotal = qty×price مضخَّم (سعر كرتونة × كمية كروز) فيطابق
  // نفسه ولا يكشفه حارس التعارض — لكن inv.total = 1163.6 موثوق، والخطة تحسم
  // أساس الكرتونة للأسطر الأربعة وأساس الكروز لسطر الغلواز.
  const mixedFixtures = defaultFixtures();
  mixedFixtures["inventory_reports:ameen_customer_invoices"] = [{
    report_date: "2026-09-13",
    created_at: new Date().toISOString(),
    summary: { bills: 1, customers: 1, fromDate: "2026-07-08" },
    items: [{
      name: "سامر الوهمي",
      customerGuid: "aaa11111",
      invoices: [{
        date: "2026-09-13",
        total: 1163.6,
        lines: [
          { material: "صنف كرتون أ", qty: 50, qtyUnits: 1, price: 286, unit1: "كروز", unit2: "كرتونة", lineTotal: 14300 },
          { material: "صنف كرتون ب", qty: 50, qtyUnits: 1, price: 290, unit1: "كروز", unit2: "كرتونة", lineTotal: 14500 },
          { material: "صنف كرتون ج", qty: 50, qtyUnits: 1, price: 308, unit1: "كروز", unit2: "كرتونة", lineTotal: 15400 },
          { material: "صنف نصف كرتون", qty: 25, qtyUnits: 0.5, price: 318, unit1: "كروز", unit2: "كرتونة", lineTotal: 7950 },
          { material: "غلواز قصير أصفر", qty: 15, qtyUnits: 0.3, price: 8.04, unit1: "كروز", unit2: "كرتونة", lineTotal: 120.6 }
        ]
      }]
    }]
  }];
  const m = await loadAssistant({ fixtures: mixedFixtures });
  const mixed = String((await m.ask(TOKENS.owner, "ماذا اشترى الزبون سامر الوهمي؟")).body.reply);
  assert.ok(/إجمالي 1,163\.6 USD/.test(mixed), `لم يعرض إجمالي رأس الفاتورة الموثوق 1163.6:\n${mixed}`);
  assert.ok(!/14,300|52,270|71,270|52270/.test(mixed), `مرّر مجموع lineTotal المضخَّم بدل رأس الفاتورة:\n${mixed}`);
  assert.ok(/= 286 USD/.test(mixed), `لم يحسم قيمة سطر الكرتونة إلى 286:\n${mixed}`);
  assert.ok(/= 120\.6 USD/.test(mixed), `لم يحسم سطر الغلواز (أساس كروز) إلى 120.6:\n${mixed}`);
  assert.ok(!mixed.includes("لم أعرض إجمالي هذه الفاتورة عمداً"), "امتنع عن إجمالي موثوق من الرأس بلا سبب");

  // ولا رجوع عن الحالة السليمة: الفواتير الافتراضية (متسقة + total) لا تتأثر
  const c = await loadAssistant();
  const regression = String((await c.ask(TOKENS.owner, "ماذا اشترى الزبون سامر الوهمي؟")).body.reply);
  assert.ok(/إجمالي 8,945.5 USD/.test(regression), `فاتورة افتراضية متسقة تأثرت بالحارس الجديد:\n${regression}`);
  assert.ok(!regression.includes("لم أعرض إجمالي هذه الفاتورة عمداً"), "الحارس الجديد سبّب امتناعاً كاذباً على بيانات سليمة");
  ok("فواتير الزبون: إجمالي الرأس الموثوق + حسم وحدة الأسطر؛ بلا رأس يبقى حارس التعارض");
}

// ── ض) الملخص التنفيذي لا يعرض رقم ربح قاطع لتقرير ناقص (Codex #29) ────────
{
  const today = new Date(Date.now() + 180 * 60_000).toISOString().slice(0, 10);
  const profitReport = (overrides) => ({
    report_date: today,
    created_at: new Date().toISOString(),
    summary: {
      currency: "USD", sales_gross: 1000, discounts: 0, returns: 0, net_sales: 1000,
      sales_cost: 900, gross_profit: 100, expenses: 20, net_profit: 80,
      sales_bill_count: 1, line_count: 1, missing_cost_lines: 0, complete: true,
      ...overrides
    },
    items: []
  });

  // complete=true وmissing_cost_lines=0 ⇒ الرقم القاطع يظهر طبيعياً
  const okFixtures = defaultFixtures();
  okFixtures["inventory_reports:ameen_daily_profit"] = [profitReport({})];
  const a = await loadAssistant({ fixtures: okFixtures });
  const goodText = String((await a.ask(TOKENS.owner, "ما أهم الأمور التي تحتاج انتباهي اليوم؟")).body.reply);
  assert.ok(/صافي 80 USD من صافي مبيعات 1,000 USD/.test(goodText), `تقرير مكتمل لم يُظهر رقم الربح القاطع:\n${goodText}`);

  // complete=false ⇒ لا رقم قاطع رغم توفر net_profit خام بالتقرير
  const incompleteFixtures = defaultFixtures();
  incompleteFixtures["inventory_reports:ameen_daily_profit"] = [profitReport({ complete: false })];
  const b = await loadAssistant({ fixtures: incompleteFixtures });
  const incompleteText = String((await b.ask(TOKENS.owner, "ما أهم الأمور التي تحتاج انتباهي اليوم؟")).body.reply);
  assert.ok(/غير متاح بدقة/.test(incompleteText), `تقرير غير مكتمل (complete=false) عرض رقماً قاطعاً:\n${incompleteText}`);
  assert.ok(!/صافي 80 USD/.test(incompleteText), "عرض صافي الربح رغم complete=false");

  // missing_cost_lines>0 مع complete=true ⇒ نفس الامتناع، لا استبدال الرقم
  const missingCostFixtures = defaultFixtures();
  missingCostFixtures["inventory_reports:ameen_daily_profit"] = [profitReport({ missing_cost_lines: 2 })];
  const c = await loadAssistant({ fixtures: missingCostFixtures });
  const missingCostText = String((await c.ask(TOKENS.owner, "ما أهم الأمور التي تحتاج انتباهي اليوم؟")).body.reply);
  assert.ok(/غير متاح بدقة/.test(missingCostText), `تقرير بسطور ناقصة التكلفة عرض رقماً قاطعاً:\n${missingCostText}`);
  assert.ok(!/صافي 80 USD/.test(missingCostText), "عرض صافي الربح رغم missing_cost_lines>0");
  ok("الملخص التنفيذي يعتمد نفس معيار ثقة أداة الأرباح (complete/missing_cost_lines) قبل عرض رقم قاطع");
}

// ── h9ZJB) اسمان متطابقان تماماً ⇒ غموض حقيقي، لا اختيار عشوائي (PR #205) ───
{
  // كانت isAmbiguous() تعتمد على matches[0].exact وحده: حسابان مختلفان
  // بنفس الاسم الحرفي (كلاهما exact=true) كانا يمرّان كـ"غير غامض" لأن أول
  // مرشح فقط يُفحص — فيُختار أحدهما عشوائياً (ترتيب الفرز غير حاسم بين
  // تعادلين) بدل الإعلان عن الغموض وطلب تحديد إضافي.
  const balanceRow = (items) => [{
    report_date: new Date().toISOString().slice(0, 10),
    created_at: new Date().toISOString(),
    summary: { totalDebitBalance: 0, totalCreditBalance: 0, customersWithDebitBalance: items.length, customersWithCreditBalance: 0, totalCustomers: items.length },
    items
  }];

  const dupFixtures = defaultFixtures();
  dupFixtures["inventory_reports:ameen_customer_balances"] = balanceRow([
    { key: "سامي الحلبي", name: "سامي الحلبي", balance: 1000, customerGuid: "dup11111", recentPayments: [] },
    { key: "سامي الحلبي", name: "سامي الحلبي", balance: 5000, customerGuid: "dup22222", recentPayments: [] }
  ]);
  const a = await loadAssistant({ fixtures: dupFixtures });
  const dupResult = await a.ask(TOKENS.owner, "ما رصيد الزبون سامي الحلبي؟");
  const dupText = String(dupResult.body.reply);
  assert.equal(dupResult.body.answered, false, "اختار أحد حسابين متطابقين اسماً بدل الإعلان عن الغموض");
  assert.ok(/يطابق أكثر من حساب/.test(dupText), `لم يُرجع رسالة غموض لاسمين متطابقين تماماً:\n${dupText}`);
  assert.ok(!/1,000/.test(dupText) && !/5,000/.test(dupText), `عرض رصيد أحد الحسابين بدل طلب تحديد إضافي:\n${dupText}`);

  // تطابق تامّ واحد وسط مرشحين آخرين (fuzzy) ⇒ يبقى التطابق التامّ صالحاً بلا غموض
  const mixedFixtures = defaultFixtures();
  mixedFixtures["inventory_reports:ameen_customer_balances"] = balanceRow([
    { key: "سامي الحلبي", name: "سامي الحلبي", balance: 12000, customerGuid: "aaa99999", recentPayments: [] },
    { key: "سامي الحلبي الجديد", name: "سامي الحلبي الجديد", balance: 900, customerGuid: "bbb88888", recentPayments: [] }
  ]);
  const b = await loadAssistant({ fixtures: mixedFixtures });
  const exactResult = await b.ask(TOKENS.owner, "ما رصيد الزبون سامي الحلبي؟");
  const exactText = String(exactResult.body.reply);
  assert.equal(exactResult.body.answered, true, `تطابق تامّ واحد وسط مرشحين آخرين اعتُبر غامضاً بلا سبب:\n${exactText}`);
  assert.ok(/12,000/.test(exactText), `لم يعرض رصيد التطابق التامّ الوحيد:\n${exactText}`);

  // حساب واحد فقط مطابق ⇒ لا غموض، كالسابق (لا Regression)
  const singleFixtures = defaultFixtures();
  singleFixtures["inventory_reports:ameen_customer_balances"] = balanceRow([
    { key: "سامي الحلبي", name: "سامي الحلبي", balance: 7000, customerGuid: "ccc77777", recentPayments: [] }
  ]);
  const c = await loadAssistant({ fixtures: singleFixtures });
  const singleResult = await c.ask(TOKENS.owner, "ما رصيد الزبون سامي الحلبي؟");
  assert.equal(singleResult.body.answered, true, "حساب واحد مطابق اعتُبر غامضاً بلا سبب");
  assert.ok(/7,000/.test(String(singleResult.body.reply)), "لم يعرض رصيد الحساب الوحيد المطابق");
  ok("اسمان متطابقان تماماً ⇒ غموض صريح؛ تطابق تامّ واحد وسط مرشحين آخرين وحساب واحد فقط ⇒ بلا غموض");
}

// ── h9ZJE) فترة ربح متعددة الأيام صراحة بلقطة يوم واحد لا تُخفي النقص (PR #205) ─
{
  // كان `single` (`!ctx.period.explicit || days.length === 1`) يُستخدم أيضاً
  // لقمع missingDaysNote: فترة صريحة متعددة الأيام لم يصل منها إلا تقرير يوم
  // واحد كانت تُعرض بلا أي تحذير بأن بقية أيام الفترة بلا تقرير — رقم يوم
  // واحد يبدو كأنه يمثّل الفترة كاملة. periodIsMultiDay يفصل الحكمين.
  const dayOffset = (n) => new Date(Date.now() + 180 * 60_000 - n * 86_400_000).toISOString().slice(0, 10);
  const profitDay = (date, net) => ({
    report_date: date,
    created_at: new Date(Date.parse(`${date}T12:00:00Z`)).toISOString(),
    summary: {
      currency: "USD", sales_gross: 1000, discounts: 0, returns: 0, net_sales: 1000,
      sales_cost: 900, gross_profit: 100, expenses: 20, net_profit: net,
      sales_bill_count: 1, line_count: 1, missing_cost_lines: 0, complete: true
    },
    items: []
  });

  // فترة صريحة من 5 أيام (اخر 5 يوم)، ولا يتوفر فيها إلا تقرير يوم واحد
  const oneOfFiveFixtures = defaultFixtures();
  oneOfFiveFixtures["inventory_reports:ameen_daily_profit"] = [profitDay(dayOffset(0), 111)];
  const a = await loadAssistant({ fixtures: oneOfFiveFixtures });
  const partial = await a.ask(TOKENS.owner, "كم الربح اخر 5 يوم؟");
  const partialText = String(partial.body.reply);
  assert.equal(partial.body.tool, "profit");
  assert.equal(partial.body.answered, true, `فترة صريحة فيها لقطة يوم واحد يجب أن تُجاب بها مع تحذير النقص:\n${partialText}`);
  assert.ok(/داخل الفترة بلا تقرير حركة/.test(partialText), `لقطة يوم واحد من فترة 5 أيام صريحة أخفت تحذير الأيام الناقصة:\n${partialText}`);
  assert.ok(/4 يوم/.test(partialText), `عدد الأيام الناقصة (4) غير مذكور بدقة:\n${partialText}`);

  // فترة يوم واحد صريحة (أمس) ⇒ لا تحذير أيام ناقصة أصلاً (from === to)
  const singleDayFixtures = defaultFixtures();
  singleDayFixtures["inventory_reports:ameen_daily_profit"] = [profitDay(dayOffset(1), 222)];
  const b = await loadAssistant({ fixtures: singleDayFixtures });
  const singleDay = await b.ask(TOKENS.owner, "كم كان الربح امس؟");
  const singleDayText = String(singleDay.body.reply);
  assert.equal(singleDay.body.answered, true);
  assert.ok(!/داخل الفترة بلا تقرير حركة/.test(singleDayText), `فترة يوم واحد صريحة أظهرت تحذير أيام ناقصة زائفاً:\n${singleDayText}`);

  // فترة متعددة الأيام كاملة التغطية ⇒ لا تحذير كاذب (missingDays فارغة فعلاً)
  const fullCoverageFixtures = defaultFixtures();
  fullCoverageFixtures["inventory_reports:ameen_daily_profit"] = [0, 1, 2, 3, 4].map((n) => profitDay(dayOffset(n), 100 + n));
  const c = await loadAssistant({ fixtures: fullCoverageFixtures });
  const full = await c.ask(TOKENS.owner, "كم الربح اخر 5 يوم؟");
  const fullText = String(full.body.reply);
  assert.equal(full.body.answered, true);
  assert.ok(!/داخل الفترة بلا تقرير حركة/.test(fullText), `فترة 5 أيام كاملة التغطية أظهرت تحذير أيام ناقصة زائفاً:\n${fullText}`);
  ok("فترة ربح متعددة الأيام صراحة بلقطة يوم واحد تُظهر تحذير النقص؛ يوم واحد صريح ومدى كامل التغطية لا يُظهران تحذيراً زائفاً");
}

{
  // «هذا الأسبوع» و«الأسبوع الماضي» كانتا تقعان كلتاهما ضمن النمط العام لآخر
  // 7 أيام المتدحرجة (لا صلة له ببداية الأسبوع السوري=السبت)، فتُحسب فترتان
  // مختلفتان فعلياً بنفس الحساب الخاطئ. اللقطة فارغة عمداً كي يظهر النص
  // الرافض بتفاصيل الفترة (label/from/to) لكل صياغة، فتُقارَن الفترات الثلاث.
  const emptyBalances = defaultFixtures();
  emptyBalances["inventory_reports:ameen_customer_balances"] = [];

  const extractWindow = (text) => {
    const m = /\(([0-9-]{10}) → ([0-9-]{10})\)/.exec(text);
    return m ? `${m[1]}→${m[2]}` : null;
  };

  const thisWeek = await loadAssistant({ fixtures: emptyBalances });
  const thisWeekAnswer = await thisWeek.ask(TOKENS.owner, "كم ديون الزبائن هذا الاسبوع؟");
  const thisWeekText = String(thisWeekAnswer.body.reply);
  assert.equal(thisWeekAnswer.body.answered, false);
  assert.ok(/هذا الأسبوع/.test(thisWeekText), `«هذا الاسبوع» لم يُترجم لعنوان «هذا الأسبوع»:\n${thisWeekText}`);
  const thisWeekWindow = extractWindow(thisWeekText);
  assert.ok(thisWeekWindow, `لم يظهر مدى تاريخ في رد «هذا الاسبوع»:\n${thisWeekText}`);

  const lastWeek = await loadAssistant({ fixtures: emptyBalances });
  const lastWeekAnswer = await lastWeek.ask(TOKENS.owner, "كم ديون الزبائن الاسبوع الماضي؟");
  const lastWeekText = String(lastWeekAnswer.body.reply);
  assert.equal(lastWeekAnswer.body.answered, false);
  assert.ok(/الأسبوع الماضي/.test(lastWeekText), `«الاسبوع الماضي» لم يُترجم لعنوان «الأسبوع الماضي»:\n${lastWeekText}`);
  const lastWeekWindow = extractWindow(lastWeekText);
  assert.ok(lastWeekWindow, `لم يظهر مدى تاريخ في رد «الاسبوع الماضي»:\n${lastWeekText}`);

  const rollingWeek = await loadAssistant({ fixtures: emptyBalances });
  const rollingWeekAnswer = await rollingWeek.ask(TOKENS.owner, "كم ديون الزبائن اخر سبعه ايام؟");
  const rollingWeekText = String(rollingWeekAnswer.body.reply);
  assert.equal(rollingWeekAnswer.body.answered, false);
  assert.ok(/آخر 7 أيام/.test(rollingWeekText), `«اخر سبعه ايام» لم يُترجم لعنوان «آخر 7 أيام»:\n${rollingWeekText}`);
  const rollingWeekWindow = extractWindow(rollingWeekText);
  assert.ok(rollingWeekWindow, `لم يظهر مدى تاريخ في رد «اخر سبعه ايام»:\n${rollingWeekText}`);

  // الثلاث فترات يجب أن تختلف فعلياً — لو تعطّل الفصل رجعت جميعها لنفس مدى
  // «آخر 7 أيام» المتدحرج كما كان الخلل قبل الإصلاح.
  assert.notEqual(thisWeekWindow, rollingWeekWindow, `«هذا الاسبوع» و«اخر سبعه ايام» أعطتا نفس المدى (${thisWeekWindow}) — لم تُفصلا فعلياً`);
  assert.notEqual(lastWeekWindow, rollingWeekWindow, `«الاسبوع الماضي» و«اخر سبعه ايام» أعطتا نفس المدى (${lastWeekWindow}) — لم تُفصلا فعلياً`);
  assert.notEqual(thisWeekWindow, lastWeekWindow, `«هذا الاسبوع» و«الاسبوع الماضي» أعطتا نفس المدى (${thisWeekWindow})`);
  ok("«هذا الاسبوع» و«الاسبوع الماضي» و«اخر سبعه ايام» تُحسب بثلاث فترات منفصلة فعلياً لا فترة متدحرجة واحدة مكررة");
}

{
  // reportForPeriod: فترة تاريخية صريحة يجب أن تختار اللقطة التي يغطيها
  // report_date لا أحدث لقطة بالإنشاء. بلا فترة صريحة يبقى latestReport
  // (الأحدث بالإنشاء) كالسابق. فترة صريحة بلا أي لقطة تغطيها ⇒ رفض صريح.
  const day = (n) => new Date(Date.now() + 180 * 60_000 - n * 86_400_000).toISOString().slice(0, 10);
  const today = day(0);
  const yesterday = day(1);
  const twoSnapshots = defaultFixtures();
  twoSnapshots["inventory_reports:ameen_customer_balances"] = [
    {
      report_date: today,
      created_at: new Date(Date.now() + 180 * 60_000).toISOString(),
      summary: { totalDebitBalance: 1000, totalCreditBalance: 0, customersWithDebitBalance: 1, customersWithCreditBalance: 0, totalCustomers: 1 },
      items: [{ key: "زبون اليوم", name: "زبون اليوم", balance: 1000, customerGuid: "t1", recentPayments: [] }]
    },
    {
      report_date: yesterday,
      // created_at أقدم بيومين كي يبقى ترتيب الأحدث-بالإنشاء مخالفاً لترتيب
      // report_date، فيتّضح الفرق بين latestReport وreportForPeriod.
      created_at: new Date(Date.now() + 180 * 60_000 - 2 * 86_400_000).toISOString(),
      summary: { totalDebitBalance: 2000, totalCreditBalance: 0, customersWithDebitBalance: 1, customersWithCreditBalance: 0, totalCustomers: 1 },
      items: [{ key: "زبون الامس", name: "زبون الامس", balance: 2000, customerGuid: "y1", recentPayments: [] }]
    }
  ];

  const bare = await loadAssistant({ fixtures: twoSnapshots });
  const bareAnswer = await bare.ask(TOKENS.owner, "من أكبر الزبائن مديونية؟");
  const bareText = String(bareAnswer.body.reply);
  assert.equal(bareAnswer.body.answered, true, `سؤال بلا فترة يجب أن يُجاب من latestReport:\n${bareText}`);
  assert.ok(bareText.includes(today), `سؤال بلا فترة لم يستخدم لقطة اليوم (الأحدث بالإنشاء):\n${bareText}`);
  assert.ok(/1,000/.test(bareText), `سؤال بلا فترة لم يعرض إجمالي لقطة اليوم (1000):\n${bareText}`);

  const yest = await loadAssistant({ fixtures: twoSnapshots });
  const yestAnswer = await yest.ask(TOKENS.owner, "كم ديون الزبائن امس؟");
  const yestText = String(yestAnswer.body.reply);
  assert.equal(yestAnswer.body.answered, true, `سؤال «امس» صريح يجب أن يُجاب من لقطة الأمس رغم أنها ليست الأحدث بالإنشاء:\n${yestText}`);
  assert.ok(yestText.includes(yesterday), `سؤال «امس» لم يستخدم لقطة الأمس (report_date):\n${yestText}`);
  assert.ok(/2,000/.test(yestText), `سؤال «امس» لم يعرض إجمالي لقطة الأمس (2000) — استُخدمت لقطة اليوم بالخطأ:\n${yestText}`);

  const noCover = await loadAssistant({ fixtures: twoSnapshots });
  const noCoverAnswer = await noCover.ask(TOKENS.owner, "كم ديون الزبائن الشهر الماضي؟");
  const noCoverText = String(noCoverAnswer.body.reply);
  assert.equal(noCoverAnswer.body.answered, false, `فترة صريحة بلا أي لقطة تغطيها يجب أن تُرفض لا أن تعرض أحدث لقطة كأنها تاريخية:\n${noCoverText}`);
  assert.ok(/الشهر الماضي/.test(noCoverText), `نص الرفض لم يذكر تسمية الفترة المطلوبة:\n${noCoverText}`);
  ok("reportForPeriod يختار اللقطة المطابقة لـreport_date عند فترة صريحة (لا الأحدث بالإنشاء)، ويرفض صراحة عند غياب لقطة تغطي الفترة");
}

{
  // عدة لقطات بنفس report_date داخل فترة صريحة: يجب كسر التعادل بـcreated_at.desc
  // وإلا قد تُعاد لقطة صباحية بدل آخر رصيد لذلك اليوم.
  // (discussion_r4018189152)
  const day = (n) => new Date(Date.now() + 180 * 60_000 - n * 86_400_000).toISOString().slice(0, 10);
  const yesterday = day(1);
  const sameDay = defaultFixtures();
  sameDay["inventory_reports:ameen_customer_balances"] = [
    {
      report_date: yesterday,
      created_at: `${yesterday}T06:00:00.000Z`,
      summary: { totalDebitBalance: 1111, totalCreditBalance: 0, customersWithDebitBalance: 1, customersWithCreditBalance: 0, totalCustomers: 1 },
      items: [{ key: "زبون الصباح", name: "زبون الصباح", balance: 1111, customerGuid: "m1", recentPayments: [] }]
    },
    {
      report_date: yesterday,
      created_at: `${yesterday}T18:00:00.000Z`,
      summary: { totalDebitBalance: 9999, totalCreditBalance: 0, customersWithDebitBalance: 1, customersWithCreditBalance: 0, totalCustomers: 1 },
      items: [{ key: "زبون المساء", name: "زبون المساء", balance: 9999, customerGuid: "e1", recentPayments: [] }]
    }
  ];

  const a = await loadAssistant({ fixtures: sameDay });
  const answer = await a.ask(TOKENS.owner, "كم ديون الزبائن امس؟");
  const text = String(answer.body.reply);
  assert.equal(answer.body.answered, true, `لقطتان بنفس اليوم يجب أن تُجابا بآخر إنشاء:\n${text}`);
  assert.ok(/9,999/.test(text), `لم تُختر لقطة المساء (created_at الأحدث) عند تعادل report_date:\n${text}`);
  assert.ok(!/1,111/.test(text), `عُرض رصيد لقطة الصباح بدل آخر لقطة لنفس اليوم:\n${text}`);
  assert.ok(text.includes(yesterday), `لم يذكر تاريخ لقطة الأمس:\n${text}`);
  ok("reportForPeriod يكسر تعادل نفس اليوم بـcreated_at.desc فيختار آخر لقطة");
}

{
  // اسمان متطابقان حرفياً بـitem_name (تعادل تام exactCount>1) يجب أن يُرفض
  // اختيار أولهما صامتاً، ويُطلب من السائل تدقيق الاسم.
  const dupItems = defaultFixtures();
  dupItems.approved_price_items = [
    {
      item_name: "توتون خاص", item_key: "توتون خاص - أ", unit1_name: "كروز", unit1_price: 10,
      unit2_name: "كرتونة", unit2_factor: 50, unit2_price: 500, sale_price: 10, stock_qty: 100, stock_status: "available"
    },
    {
      item_name: "توتون خاص", item_key: "توتون خاص - ب", unit1_name: "كروز", unit1_price: 12,
      unit2_name: "كرتونة", unit2_factor: 50, unit2_price: 600, sale_price: 12, stock_qty: 80, stock_status: "available"
    }
  ];
  const a = await loadAssistant({ fixtures: dupItems });
  const result = await a.ask(TOKENS.owner, "سعر توتون خاص");
  const text = String(result.body.reply);
  assert.equal(result.body.tool, "item");
  assert.equal(result.body.answered, false, `اسم صنف يطابق سطرين بتعادل تام كان يجب رفضه لا اختيار الأول صامتاً:\n${text}`);
  assert.ok(/يطابق أكثر من صنف/.test(text), `نص الرفض لا يذكر التعدد:\n${text}`);
  assert.ok(/لن أخمّن بينها/.test(text), `نص الرفض لا يذكر رفض التخمين:\n${text}`);
  const listedLines = (text.match(/^- توتون خاص$/gm) ?? []).length;
  assert.equal(listedLines, 2, `نص الرفض يجب أن يسرد سطرين متنافسين باسم «توتون خاص» (item_name)، لا اختيار أحدهما صامتاً:\n${text}`);
  ok("اسم صنف يطابق سطرين بتعادل تام (نفس item_name) يُرفض صراحة بدل اختيار أول سطر صامتاً");
}

{
  // حركة الصنف كانت تتجاهل أي فترة صريحة بالسؤال وتستخدم دوماً نافذة ثابتة
  // 60 يوماً (والمتوسط دوماً على /60). فترة صريحة يجب أن تُستخدم كما هي في
  // كل من التسمية والمتوسط اليومي.
  const a = await loadAssistant({ fixtures: defaultFixtures() });
  const bareAnswer = await a.ask(TOKENS.owner, "حركة ماستر طويل ورق");
  const bareText = String(bareAnswer.body.reply);
  assert.equal(bareAnswer.body.tool, "item");
  assert.ok(/\*\*الحركة \(آخر 60 يوم\)\*\*/.test(bareText), `سؤال بلا فترة صريحة يجب أن يستخدم نافذة آخر 60 يوم الافتراضية:\n${bareText}`);
  assert.ok(/الكمية المباعة: \*\*30\*\*/.test(bareText), `سؤال بلا فترة لم يجمع كمية اليوم (30) بشكل صحيح:\n${bareText}`);
  assert.ok(/متوسط 0\.5 بالوحدة يومياً/.test(bareText), `متوسط النافذة الافتراضية (30/60) غير صحيح:\n${bareText}`);

  const b = await loadAssistant({ fixtures: defaultFixtures() });
  const explicitAnswer = await b.ask(TOKENS.owner, "حركة ماستر طويل ورق اخر 10 يوم؟");
  const explicitText = String(explicitAnswer.body.reply);
  assert.equal(explicitAnswer.body.tool, "item");
  assert.ok(/\*\*الحركة \(آخر 10 يوم\)\*\*/.test(explicitText), `فترة صريحة (اخر 10 يوم) لم تُستخدم في عنوان الحركة — استُخدمت النافذة الثابتة بدلاً منها:\n${explicitText}`);
  assert.ok(/الكمية المباعة: \*\*30\*\*/.test(explicitText), `فترة اخر 10 يوم لم تجمع كمية اليوم (30) بشكل صحيح:\n${explicitText}`);
  assert.ok(/متوسط 3\.0 بالوحدة يومياً/.test(explicitText), `متوسط فترة اخر 10 يوم (30/10=3.0) غير صحيح — يبدو أن القاسم بقي 60:\n${explicitText}`);
  ok("حركة الصنف تستخدم الفترة الصريحة المطلوبة بدل نافذة 60 يوماً الثابتة، في كل من العنوان والمتوسط اليومي");
}

{
  // دفعات الزبون كانت تُعرض دوماً من نافذة التقرير كاملة (أحدث 6 دفعات) بلا
  // صلة بالفترة المطلوبة بالسؤال. فترة صريحة يجب أن تُصفّي الدفعات فعلياً.
  const a = await loadAssistant({ fixtures: defaultFixtures() });
  const bareAnswer = await a.ask(TOKENS.owner, "كشف حساب مؤسسة النموذج");
  const bareText = String(bareAnswer.body.reply);
  assert.equal(bareAnswer.body.tool, "customer");
  assert.ok(/\*\*آخر الدفعات\*\*\n/.test(bareText), `سؤال بلا فترة يجب أن يعرض «آخر الدفعات» بلا تسمية فترة:\n${bareText}`);
  assert.ok(/8,500/.test(bareText), `سؤال بلا فترة لم يعرض دفعة الأمس (8500) من نافذة التقرير:\n${bareText}`);

  const b = await loadAssistant({ fixtures: defaultFixtures() });
  const todayAnswer = await b.ask(TOKENS.owner, "كشف حساب مؤسسة النموذج اليوم");
  const todayText = String(todayAnswer.body.reply);
  assert.equal(todayAnswer.body.tool, "customer");
  assert.ok(!/8,500/.test(todayText), `فترة «اليوم» الصريحة أظهرت دفعة الأمس رغم أنها خارج الفترة:\n${todayText}`);
  assert.ok(/لا دفعات مسجّلة لهذا الحساب في اليوم/.test(todayText), `فترة «اليوم» بلا دفعات يجب أن تذكر ذلك صراحة مع تسمية الفترة:\n${todayText}`);

  const c = await loadAssistant({ fixtures: defaultFixtures() });
  const yestAnswer = await c.ask(TOKENS.owner, "كشف حساب مؤسسة النموذج امس");
  const yestText = String(yestAnswer.body.reply);
  assert.equal(yestAnswer.body.tool, "customer");
  assert.ok(/\*\*آخر الدفعات\*\* \(أمس\)/.test(yestText), `فترة «امس» الصريحة يجب أن تُظهر تسمية الفترة بجانب «آخر الدفعات»:\n${yestText}`);
  assert.ok(/8,500/.test(yestText), `فترة «امس» الصريحة لم تُظهر دفعة الأمس رغم أنها داخل الفترة:\n${yestText}`);
  ok("دفعات الزبون تُصفّى فعلياً حسب الفترة الصريحة المطلوبة (اليوم يستبعد دفعة الأمس، وامس يعرضها) بدل عرض نافذة التقرير كاملة دوماً");
}

{
  // توصية الشراء كانت تصدر أحكاماً واثقة («لا حاجة شراء عاجلة») حتى من تقرير
  // مخزون قديم. اللقطات الافتراضية (ماستر/كينغ دوم) لا تنتج أي صنف عاجل
  // (ranked فارغة)، فالفرع المختبر هنا هو `!ranked.length` مع stale/fresh.
  // توصية الشراء تفحص اكتمال قراءة المبيعات (فرع «غير مكتملة») قبل فحص قِدَم
  // المخزون، ومصدر المزامنة فارغ افتراضياً — فبلا سجل مزامنة يسقط الجواب على
  // فرع الاكتمال أولاً ولا يصل لفرع القِدَم المقصود اختباره هنا إطلاقاً.
  const day6 = (n) => new Date(Date.now() + 180 * 60_000 - n * 86_400_000).toISOString().slice(0, 10);
  const syncState6 = [{
    source: "ameen_sales_line_items", window_start: day6(29), window_end: day6(0),
    row_count: 30, completed_at: new Date().toISOString()
  }];

  const staleFixtures = defaultFixtures();
  staleFixtures.sales_line_items_sync_state = syncState6;
  const staleReport = staleFixtures["inventory_reports:ameen_sql_agent"][0];
  staleReport.created_at = new Date(Date.now() - 20 * 3_600_000).toISOString(); // 20 ساعة — أقدم من حد 12 ساعة
  const stale = await loadAssistant({ fixtures: staleFixtures });
  const staleAnswer = await stale.ask(TOKENS.owner, "ماذا يجب ان اشتري؟");
  const staleText = String(staleAnswer.body.reply);
  assert.equal(staleAnswer.body.tool, "purchase_advice");
  assert.equal(staleAnswer.body.answered, false, `تقرير مخزون عمره 20 ساعة (أقدم من حد 12 ساعة) كان يجب ألا يُصدر حكم «لا حاجة شراء عاجلة» بثقة:\n${staleText}`);
  assert.ok(/توصية الشراء — غير محسومة/.test(staleText), `نص التوصية على مخزون قديم لا يذكر أنها غير محسومة:\n${staleText}`);
  assert.ok(/قديم/.test(staleText), `نص التوصية لا يصف تقرير المخزون بأنه قديم:\n${staleText}`);
  assert.ok(/حدّث المخزون أولاً/.test(staleText), `نص التوصية على مخزون قديم لا يطلب تحديث المخزون أولاً:\n${staleText}`);

  const freshFixtures = defaultFixtures();
  freshFixtures.sales_line_items_sync_state = syncState6;
  const freshReport = freshFixtures["inventory_reports:ameen_sql_agent"][0];
  freshReport.created_at = new Date().toISOString(); // طازج — أقل من حد 12 ساعة
  const fresh = await loadAssistant({ fixtures: freshFixtures });
  const freshAnswer = await fresh.ask(TOKENS.owner, "ماذا يجب ان اشتري؟");
  const freshText = String(freshAnswer.body.reply);
  assert.equal(freshAnswer.body.tool, "purchase_advice");
  assert.equal(freshAnswer.body.answered, true, `تقرير مخزون طازج يجب أن يصدر حكماً واثقاً:\n${freshText}`);
  assert.ok(/\*\*توصية الشراء\*\*/.test(freshText), `نص التوصية الطازجة لا يحمل العنوان العادي (غير «غير محسومة»):\n${freshText}`);
  assert.ok(/لا حاجة شراء عاجلة بهذا المعيار/.test(freshText), `نص التوصية الطازجة لا يذكر «لا حاجة شراء عاجلة»:\n${freshText}`);
  ok("توصية الشراء تُصدر حكماً «غير محسوم» صراحة عند مخزون قديم (≥12 ساعة) بدل «لا حاجة شراء عاجلة» واثقة، وتبقى واثقة عند مخزون طازج");
}

// ── ك.ك) دفعات الزبون المبتورة: لا نفي قاطع حين يُحتمل البتر ─────────────────
{
  // ملاحظة Codex idx46 على PR #205: tools/ameen-customer-balances-query.sql
  // يعيد أحدث 40 دفعة فقط لكل زبون (TOP 40)، لا السجل كله. فإن جاءت النتيجة
  // فارغة بعد الفلترة بفترة صريحة، الجزم بـ«لا دفعات مسجّلة» قد يكون كاذباً:
  // قد توجد دفعة أقدم فعلاً ضمن الفترة لكنها سقطت خارج نافذة الـ40 المتاحة.
  const day = (n) => new Date(Date.now() + 180 * 60_000 - n * 86_400_000).toISOString().slice(0, 10);
  const balanceRow = (items) => [{
    report_date: new Date().toISOString().slice(0, 10),
    created_at: new Date().toISOString(),
    summary: { totalDebitBalance: 0, totalCreditBalance: 0, customersWithDebitBalance: items.length, customersWithCreditBalance: 0, totalCustomers: items.length },
    items
  }];

  // الحالة ١: 40 دفعة (السقف بالضبط) ولا واحدة منها ضمن الفترة المطلوبة (اليوم)
  // ⇒ يجب ألا يُجزم بـ«لا دفعات مسجّلة»، بل يُقال إن النتيجة غير محسومة.
  const f1 = defaultFixtures();
  f1["inventory_reports:ameen_customer_balances"] = balanceRow([{
    key: "زبون سداد الاختبار", name: "زبون سداد الاختبار", balance: 5000, customerGuid: "pay40001",
    recentPayments: Array.from({ length: 40 }, (_, i) => ({ date: `${day(i + 1)}T00:00:00`, amount: 100 + i, notes: "" }))
  }]);
  const a1 = await loadAssistant({ fixtures: f1 });
  const r1 = await a1.ask(TOKENS.owner, "كشف حساب زبون سداد الاختبار اليوم");
  const t1 = String(r1.body.reply);
  assert.ok(!/لا دفعات مسجّلة/.test(t1), `40 دفعة بلا أي منها ضمن الفترة يجب ألا يُجزم بـ«لا دفعات مسجّلة»:\n${t1}`);
  assert.ok(/لا يمكن الجزم بعدم وجود دفعات/.test(t1), `النتيجة غير المحسومة لم تُذكر صراحة عند بلوغ سقف الـ40 دفعة:\n${t1}`);
  ok("CASE 1: سجل دفعات ببلوغ سقف الـ40 وفترة صريحة بلا نتائج ⇒ نتيجة غير محسومة لا نفي قاطع");

  // الحالة ٢: أقل من 40 دفعة، والفترة المطلوبة داخل تغطية البيانات الفعلية
  // (أقدم دفعة متاحة أقدم من بداية الفترة)، ولا دفعات ضمنها ⇒ النفي القاطع
  // المباشر يبقى صحيحاً كما هو، بلا تغيير.
  const f2 = defaultFixtures();
  f2["inventory_reports:ameen_customer_balances"] = balanceRow([{
    key: "زبون سداد الاختبار", name: "زبون سداد الاختبار", balance: 5000, customerGuid: "pay40002",
    recentPayments: [
      { date: `${day(5)}T00:00:00`, amount: 100, notes: "" },
      { date: `${day(10)}T00:00:00`, amount: 200, notes: "" },
      { date: `${day(15)}T00:00:00`, amount: 300, notes: "" }
    ]
  }]);
  const a2 = await loadAssistant({ fixtures: f2 });
  const r2 = await a2.ask(TOKENS.owner, "كشف حساب زبون سداد الاختبار اليوم");
  const t2 = String(r2.body.reply);
  assert.ok(/لا دفعات مسجّلة لهذا الحساب في اليوم/.test(t2), `أقل من 40 دفعة وفترة مغطّاة فعلاً يجب أن يبقى النفي القاطع كما هو:\n${t2}`);
  assert.ok(!/لا يمكن الجزم/.test(t2), `فترة مغطّاة فعلاً بالبيانات لا يجوز أن تحمل تحذير بتر غير لازم:\n${t2}`);
  ok("CASE 2: سجل دفعات دون الـ40 وفترة داخل تغطية البيانات الفعلية ⇒ النفي القاطع كما هو");

  // الحالة ٣: 40 دفعة (السقف) لكن إحداها فعلاً ضمن الفترة المطلوبة ⇒ تُعرض
  // طبيعياً بلا أي تحذير بتر زائف.
  const f3 = defaultFixtures();
  f3["inventory_reports:ameen_customer_balances"] = balanceRow([{
    key: "زبون سداد الاختبار", name: "زبون سداد الاختبار", balance: 5000, customerGuid: "pay40003",
    recentPayments: [
      { date: `${day(0)}T00:00:00`, amount: 999, notes: "دفعة اليوم" },
      ...Array.from({ length: 39 }, (_, i) => ({ date: `${day(i + 1)}T00:00:00`, amount: 100 + i, notes: "" }))
    ]
  }]);
  const a3 = await loadAssistant({ fixtures: f3 });
  const r3 = await a3.ask(TOKENS.owner, "كشف حساب زبون سداد الاختبار اليوم");
  const t3 = String(r3.body.reply);
  assert.ok(/999/.test(t3), `40 دفعة مع دفعة فعلية ضمن الفترة يجب أن تُعرض:\n${t3}`);
  assert.ok(!/لا يمكن الجزم/.test(t3), `وجود دفعة فعلية ضمن الفترة لا يجوز أن يُرفق بتحذير بتر زائف:\n${t3}`);
  assert.ok(!/لا دفعات مسجّلة/.test(t3), `وجود دفعة فعلية ضمن الفترة لا يجوز أن يُقال معه «لا دفعات مسجّلة»:\n${t3}`);
  ok("CASE 3: سجل دفعات ببلوغ سقف الـ40 لكن دفعة فعلية ضمن الفترة ⇒ تُعرض طبيعياً بلا تحذير بتر زائف");

  // الحالة ٤: بلا فترة صريحة ⇒ السلوك الحالي (نافذة التقرير كاملة) بلا تغيير
  const f4 = defaultFixtures();
  f4["inventory_reports:ameen_customer_balances"] = balanceRow([{
    key: "زبون سداد الاختبار", name: "زبون سداد الاختبار", balance: 5000, customerGuid: "pay40004",
    recentPayments: []
  }]);
  const a4 = await loadAssistant({ fixtures: f4 });
  const r4 = await a4.ask(TOKENS.owner, "كشف حساب زبون سداد الاختبار");
  const t4 = String(r4.body.reply);
  assert.ok(/لا دفعات مسجّلة لهذا الحساب في نافذة التقرير/.test(t4), `بلا فترة صريحة يجب أن يبقى السلوك كما هو تماماً (نافذة التقرير):\n${t4}`);
  assert.ok(!/لا يمكن الجزم/.test(t4), `بلا فترة صريحة لا يجوز ظهور تحذير بتر أصلاً:\n${t4}`);
  ok("CASE 4: بلا فترة صريحة ⇒ السلوك الحالي بلا تغيير");
}

// ── مقارنة «اليوم × أمس» تختار اليوم أولاً ─────────────────────────────────
{
  // ملاحظة Codex على PR #205: parsePeriod كان يطابق «امس» قبل «اليوم»، فسؤال
  // «مبيعات اليوم مقارنة بأمس» يصبح أمس مقابل ما قبله ولا يقرأ مبيعات اليوم.
  const today = new Date(Date.now() + 180 * 60_000).toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() + 180 * 60_000 - 86_400_000).toISOString().slice(0, 10);
  const dayBefore = new Date(Date.now() + 180 * 60_000 - 2 * 86_400_000).toISOString().slice(0, 10);
  const fixtures = defaultFixtures();
  fixtures.sales_line_items = [
    { sale_date: today, bill_no: "1", bill_type: "retail", item_name: "أ", qty: 1, line_total: 200, net_profit: 20, unit_cost: 180, customer_name: "س" },
    { sale_date: yesterday, bill_no: "2", bill_type: "retail", item_name: "أ", qty: 1, line_total: 80, net_profit: 8, unit_cost: 72, customer_name: "س" },
    { sale_date: dayBefore, bill_no: "3", bill_type: "retail", item_name: "أ", qty: 1, line_total: 50, net_profit: 5, unit_cost: 45, customer_name: "س" }
  ];
  const a = await loadAssistant({ fixtures });
  const result = await a.ask(TOKENS.owner, "مبيعات اليوم مقارنة بامس");
  const text = String(result.body.reply);
  assert.ok(text.includes("200 USD"), `لم يقرأ مبيعات اليوم كفترة أساسية:\n${text}`);
  assert.ok(/مقارنة بـ/.test(text), `لم يدخل فرع المقارنة:\n${text}`);
  assert.ok(text.includes("80") || /\+120 USD/.test(text), `لم يقارن بالأمس (80) بل بما قبله:\n${text}`);
  assert.ok(!text.includes("50 USD") || /مقارنة/.test(text), "سرّب يوم ما قبل الأمس كفترة أساسية");
  ok("مقارنة «اليوم × أمس» تختار اليوم أولاً ثم تقارن بالأمس");
}

// ── المناقلات: أسماء المستودعات + ترشيح الفترة ──────────────────────────────
{
  // ملاحظة Codex على PR #205: الحقول الحقيقية source/destination، والأداة كانت
  // تقرأ from/to ⇒ «? → ?». كذلك run() بلا ctx يعيد لقطة ~60 يوماً لسؤال اليوم.
  const today = new Date(Date.now() + 180 * 60_000).toISOString().slice(0, 10);
  const old = new Date(Date.now() + 180 * 60_000 - 20 * 86_400_000).toISOString().slice(0, 10);
  const fromDate = new Date(Date.now() + 180 * 60_000 - 60 * 86_400_000).toISOString().slice(0, 10);
  const fixtures = defaultFixtures();
  fixtures.ameen_warehouse_transfer_reports = [{
    report_date: today,
    created_at: new Date().toISOString(),
    summary: { source: "ameen_warehouse_transfers", periodDays: 60, fromDate, transferCount: 2 },
    items: [
      {
        date: today,
        sourceWarehouseName: "مستودع المركز",
        destinationWarehouseName: "مستودع الفرع",
        items: [{ itemName: "ماستر", qty: 10 }]
      },
      {
        date: old,
        sourceWarehouseName: "مستودع قديم",
        destinationWarehouseName: "مستودع أرشيف",
        items: [{ itemName: "قديم", qty: 1 }]
      }
    ]
  }];

  const a = await loadAssistant({ fixtures });
  const todayAsk = await a.ask(TOKENS.owner, "مناقلات اليوم");
  const todayText = String(todayAsk.body.reply);
  assert.equal(todayAsk.body.tool, "transfers");
  assert.ok(todayText.includes("مستودع المركز"), `لم يعرض اسم المصدر الحقيقي:\n${todayText}`);
  assert.ok(todayText.includes("مستودع الفرع"), `لم يعرض اسم الوجهة الحقيقي:\n${todayText}`);
  assert.ok(!todayText.includes("? → ?"), `عرض ? بدل أسماء المنتِج:\n${todayText}`);
  assert.ok(!todayText.includes("مستودع قديم"), `خلط مناقلة قديمة في جواب اليوم:\n${todayText}`);
  assert.ok(/1 مناقلة/.test(todayText), `لم يعزل مناقلة اليوم وحدها:\n${todayText}`);

  const b = await loadAssistant({ fixtures });
  const bare = await b.ask(TOKENS.owner, "ما التحويلات بين المستودعات؟");
  const bareText = String(bare.body.reply);
  assert.ok(bareText.includes("مستودع قديم"), `سؤال بلا فترة صريحة يجب أن يعرض نافذة اللقطة:\n${bareText}`);
  assert.ok(/2 مناقلة/.test(bareText), `سؤال بلا فترة لم يعدّ كل عناصر اللقطة:\n${bareText}`);
  ok("المناقلات تعرض أسماء المنتِج وترشّح الفترة الصريحة");
}

// ── Codex P1 c61b172: تعادل صرفنا×صندوق → المصاريف لا أرصدة الإغلاق ──────────
{
  // «كم صرفنا من الصندوق اليوم؟» يسجّل 6 للصندوق (صندوق) و6 للمصاريف (صرفنا).
  // بلا priority على expenses كان ترتيب TOOLS يختار الصندوق ويعرض أرصدة
  // الإغلاق بدل المنصرف. (discussion_r4017651295)
  const a = await loadAssistant();
  const result = await a.ask(TOKENS.owner, "كم صرفنا من الصندوق اليوم؟");
  assert.equal(result.body.tool, "expenses", `تعادل صرفنا×صندوق ذهب إلى ${result.body.tool} بدل expenses`);
  assert.ok(a.metrics.tablesRead.has("expense_entries"), "سؤال الصرف من الصندوق لم يقرأ expense_entries");
  assert.ok(!String(result.body.reply).includes("2,193.09"), "تسرّب رصيد إغلاق الصندوق إلى جواب المصاريف");
  assert.ok(/محروقات|أجور نقل|مصاريف/.test(String(result.body.reply)), `جواب المصاريف بلا بنود منصرف:\n${result.body.reply}`);

  const bareBox = await loadAssistant();
  const box = await bareBox.ask(TOKENS.owner, "كم يوجد بالصندوق؟");
  assert.equal(box.body.tool, "cashbox", "سؤال الصندوق الصريح يجب أن يبقى على cashbox");
  ok("فعل الصرف يفوز على اسم الوعاء عند تعادل النقاط؛ سؤال الصندوق الصريح يبقى للصناديق");
}

// ── Codex P1 c61b172: رصيد زبون بفترة تاريخية يستخدم لقطة الفترة ─────────────
{
  // «كم كان رصيد الزبون سامر الشهر الماضي؟» كان يحمل أحدث لقطة ويسمّيها
  // «الرصيد الحالي». يجب reportForPeriod كالذمم، أو رفض صريح. (discussion_r4017651314)
  const today = new Date(Date.now() + 180 * 60_000).toISOString().slice(0, 10);
  const now = new Date();
  const lastMonthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
  const lastMonth = lastMonthDate.toISOString().slice(0, 10);
  const fixtures = defaultFixtures();
  fixtures["inventory_reports:ameen_customer_balances"] = [
    {
      report_date: today,
      created_at: new Date().toISOString(),
      summary: {
        totalDebitBalance: 12000, totalCreditBalance: 0,
        customersWithDebitBalance: 1, customersWithCreditBalance: 0, totalCustomers: 1
      },
      items: [{
        key: "سامر الوهمي", name: "سامر الوهمي", balance: 12000, customerGuid: "aaa11111",
        recentPayments: []
      }]
    },
    {
      report_date: lastMonth,
      created_at: new Date(Date.now() - 40 * 86_400_000).toISOString(),
      summary: {
        totalDebitBalance: 7777, totalCreditBalance: 0,
        customersWithDebitBalance: 1, customersWithCreditBalance: 0, totalCustomers: 1
      },
      items: [{
        key: "سامر الوهمي", name: "سامر الوهمي", balance: 7777, customerGuid: "aaa11111",
        recentPayments: []
      }]
    }
  ];

  const a = await loadAssistant({ fixtures });
  const hist = await a.ask(TOKENS.owner, "كم كان رصيد الزبون سامر الوهمي الشهر الماضي؟");
  const histText = String(hist.body.reply);
  assert.equal(hist.body.tool, "customer");
  assert.equal(hist.body.answered, true, `فترة تاريخية بلقطة مطابقة يجب أن تُجاب:\n${histText}`);
  assert.ok(/7,777/.test(histText), `لم يعرض رصيد لقطة الشهر الماضي (7777):\n${histText}`);
  assert.ok(!/12,000/.test(histText), `عرض الرصيد الحالي (12000) جواباً عن الشهر الماضي:\n${histText}`);
  assert.ok(!/الرصيد الحالي/.test(histText), `وسم «الرصيد الحالي» على جواب تاريخي:\n${histText}`);
  assert.ok(histText.includes(lastMonth), `لم يذكر تاريخ لقطة الشهر الماضي:\n${histText}`);

  const bare = await loadAssistant({ fixtures });
  const nowAsk = await bare.ask(TOKENS.owner, "ما رصيد الزبون سامر الوهمي؟");
  const nowText = String(nowAsk.body.reply);
  assert.ok(/12,000/.test(nowText), `سؤال بلا فترة لم يأخذ أحدث رصيد:\n${nowText}`);
  assert.ok(/الرصيد الحالي/.test(nowText), `سؤال بلا فترة يجب أن يبقى بعنوان الرصيد الحالي:\n${nowText}`);

  const noSnap = defaultFixtures();
  noSnap["inventory_reports:ameen_customer_balances"] = [fixtures["inventory_reports:ameen_customer_balances"][0]];
  const c = await loadAssistant({ fixtures: noSnap });
  const rejected = await c.ask(TOKENS.owner, "كم كان رصيد الزبون سامر الوهمي الشهر الماضي؟");
  assert.equal(rejected.body.answered, false, `فترة بلا لقطة تغطيها يجب أن تُرفض:\n${rejected.body.reply}`);
  assert.ok(/لن أعرض الرصيد الحالي/.test(String(rejected.body.reply)), `نص الرفض لم يمنع عرض الرصيد الحالي:\n${rejected.body.reply}`);
  ok("رصيد زبون بفترة تاريخية يأخذ لقطة الفترة (أو يرفض صراحة) ولا يعرض الرصيد الحالي مموَّهاً");
}

// ── Codex P1 c61b172: اسم مورّد غامض يُرفض قبل تفصيل فواتيره ─────────────────
{
  // limit=1 كان يرمي المنافسين قبل isAmbiguous فيختار أول مورّد صامتاً.
  // (discussion_r4017651321)
  const fixtures = defaultFixtures();
  fixtures.ameen_purchase_invoice_reports = [{
    report_date: new Date(Date.now() + 180 * 60_000).toISOString().slice(0, 10),
    created_at: new Date().toISOString(),
    summary: { bills: 2, suppliers: 2, fromDate: "2026-07-08" },
    items: [
      {
        name: "شركة الأمل للتوريد",
        invoices: [{ date: "2026-08-01", items: [{ itemName: "صنف الأمل أ", qty: 1, lineTotal: 100, avgPrice: 100 }] }]
      },
      {
        name: "شركة الأمل التجارية",
        invoices: [{ date: "2026-08-02", items: [{ itemName: "صنف الأمل ب", qty: 1, lineTotal: 200, avgPrice: 200 }] }]
      }
    ]
  }];

  const a = await loadAssistant({ fixtures });
  const result = await a.ask(TOKENS.owner, "فواتير المورد شركة الأمل");
  const text = String(result.body.reply);
  assert.equal(result.body.tool, "purchases");
  assert.equal(result.body.answered, false, `اسم مورّد غامض كان يجب رفضه لا اختيار الأول:\n${text}`);
  assert.ok(/يطابق أكثر من مورّد/.test(text), `لم يُعلن الغموض:\n${text}`);
  assert.ok(/شركة الأمل للتوريد/.test(text) && /شركة الأمل التجارية/.test(text), `لم يعرض المرشّحين:\n${text}`);
  assert.ok(!/تفصيل/.test(text), `عرض تفصيل مورّد رغم الغموض:\n${text}`);
  assert.ok(!/صنف الأمل أ/.test(text) && !/صنف الأمل ب/.test(text), `عرّض فواتير مورّد رغم الغموض:\n${text}`);

  const exact = await loadAssistant({ fixtures });
  const unique = await exact.ask(TOKENS.owner, "فواتير المورد شركة الأمل للتوريد");
  const uniqueText = String(unique.body.reply);
  assert.equal(unique.body.answered, true, `اسم مورّد مميَّز يجب أن يُجاب:\n${uniqueText}`);
  assert.ok(/تفصيل.*شركة الأمل للتوريد/.test(uniqueText), `لم يعرض تفصيل المورّد المميَّز:\n${uniqueText}`);
  assert.ok(/صنف الأمل أ/.test(uniqueText), `لم يعرض فواتير المورّد المميَّز:\n${uniqueText}`);
  assert.ok(!/صنف الأمل ب/.test(uniqueText), `خلط فواتير المورّد الآخر:\n${uniqueText}`);
  ok("اسم مورّد غامض يُرفض صراحة قبل تفصيل فواتيره؛ الاسم المميَّز يعرض تفصيله وحده");
}

// ── Codex P1 f5cabd6: مرتجعات الصنف تُفصل عن الكمية المباعة ─────────────────
{
  // qty سالبة تُحفظ عمداً كمرتجع. جمع التوقيع تحت «الكمية المباعة» يحوّل
  // صافي الحركة إلى مبيع خام. (discussion_r4017908903)
  const today = new Date(Date.now() + 180 * 60_000).toISOString().slice(0, 10);
  const fixtures = defaultFixtures();
  fixtures.sales_line_items = [
    { id: 1, sale_date: today, bill_no: "201", bill_type: "wholesale", item_name: "ماستر طويل ورق", qty: 10, line_total: 3550, unit_cost: 339, customer_name: "سامر الوهمي" },
    { id: 2, sale_date: today, bill_no: "202", bill_type: "wholesale", item_name: "ماستر طويل ورق", qty: -2, line_total: -710, unit_cost: 339, customer_name: "سامر الوهمي" }
  ];
  fixtures.sales_line_items_sync_state = [{
    source: "ameen_sales_line_items",
    window_start: new Date(Date.now() + 180 * 60_000 - 29 * 86_400_000).toISOString().slice(0, 10),
    window_end: today,
    row_count: 2,
    completed_at: new Date().toISOString()
  }];

  const a = await loadAssistant({ fixtures });
  const mixed = await a.ask(TOKENS.owner, "حركة ماستر طويل ورق اليوم؟");
  const mixedText = String(mixed.body.reply);
  assert.equal(mixed.body.tool, "item");
  assert.ok(/الكمية المباعة: \*\*10\*\*/.test(mixedText), `عرض صافي الحركة (8) كمبيع بدل 10:\n${mixedText}`);
  assert.ok(!/الكمية المباعة: \*\*8\*\*/.test(mixedText), `وسم الكمية المباعة على الصافي 8:\n${mixedText}`);
  assert.ok(/مرتجعات: \*\*2\*\*/.test(mixedText), `لم يفصل المرتجع عن المبيع:\n${mixedText}`);
  assert.ok(/متوسط 10\.0 بالوحدة يومياً/.test(mixedText), `المتوسط بُني على الصافي لا على المبيع:\n${mixedText}`);

  const returnOnly = defaultFixtures();
  returnOnly.sales_line_items = [
    { id: 3, sale_date: today, bill_no: "203", bill_type: "wholesale", item_name: "ماستر طويل ورق", qty: -4, line_total: -1420, unit_cost: 339, customer_name: "سامر الوهمي" }
  ];
  returnOnly.sales_line_items_sync_state = fixtures.sales_line_items_sync_state;
  const b = await loadAssistant({ fixtures: returnOnly });
  const retText = String((await b.ask(TOKENS.owner, "حركة ماستر طويل ورق اليوم؟")).body.reply);
  assert.ok(/لا مبيعات موجبة/.test(retText), `مرتجع خالص لم يُعلن غياب المبيع الموجب:\n${retText}`);
  assert.ok(/مرتجعات: \*\*4\*\*/.test(retText), `مرتجع خالص لم يعرض كمية المرتجع:\n${retText}`);
  assert.ok(!/الكمية المباعة: \*\*-4\*\*/.test(retText), `عرض كمية مباعة سالبة من مرتجع خالص:\n${retText}`);
  ok("حركة الصنف تفصل الكمية المباعة عن المرتجعات ولا تعرض صافي الحركة كمبيع");
}

// ── Codex P1 f5cabd6: رصيد حساب بفترة تاريخية يحترم اللقطة ──────────────────
{
  // «رصيد حساب شام كاش الشهر الماضي» كان يحمل أحدث لقطة دوماً.
  // (discussion_r4017908937)
  const today = new Date(Date.now() + 180 * 60_000).toISOString().slice(0, 10);
  const now = new Date();
  const lastMonthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
  const lastMonth = lastMonthDate.toISOString().slice(0, 10);
  const fixtures = defaultFixtures();
  fixtures.ameen_account_balance_reports = [
    {
      report_date: today,
      created_at: new Date().toISOString(),
      summary: { accountCount: 2, nonZeroAccountCount: 1, accountingBasis: "ac000 Debit - Credit" },
      items: [
        { accountCode: "1301", accountName: "شام كاش", parentName: "الصناديق", balance: 5400, debit: 9000, credit: 3600 }
      ]
    },
    {
      report_date: lastMonth,
      created_at: new Date(Date.now() - 40 * 86_400_000).toISOString(),
      summary: { accountCount: 2, nonZeroAccountCount: 1, accountingBasis: "ac000 Debit - Credit" },
      items: [
        { accountCode: "1301", accountName: "شام كاش", parentName: "الصناديق", balance: 3210, debit: 5000, credit: 1790 }
      ]
    }
  ];

  const a = await loadAssistant({ fixtures });
  const hist = await a.ask(TOKENS.owner, "ما رصيد حساب شام كاش الشهر الماضي؟");
  const histText = String(hist.body.reply);
  assert.equal(hist.body.tool, "accounts");
  assert.equal(hist.body.answered, true, `فترة تاريخية بلقطة حساب مطابقة يجب أن تُجاب:\n${histText}`);
  assert.ok(/3,210/.test(histText), `لم يعرض رصيد لقطة الشهر الماضي (3210):\n${histText}`);
  assert.ok(!/5,400/.test(histText), `عرض الرصيد الحالي (5400) جواباً عن الشهر الماضي:\n${histText}`);
  assert.ok(histText.includes(lastMonth), `لم يذكر تاريخ لقطة الشهر الماضي:\n${histText}`);

  const bare = await loadAssistant({ fixtures });
  const nowAsk = await bare.ask(TOKENS.owner, "ما رصيد حساب شام كاش؟");
  const nowText = String(nowAsk.body.reply);
  assert.ok(/5,400/.test(nowText), `سؤال بلا فترة لم يأخذ أحدث رصيد حساب:\n${nowText}`);

  const noSnap = defaultFixtures();
  noSnap.ameen_account_balance_reports = [fixtures.ameen_account_balance_reports[0]];
  const c = await loadAssistant({ fixtures: noSnap });
  const rejected = await c.ask(TOKENS.owner, "ما رصيد حساب شام كاش الشهر الماضي؟");
  assert.equal(rejected.body.answered, false, `فترة حساب بلا لقطة تغطيها يجب أن تُرفض:\n${rejected.body.reply}`);
  assert.ok(/لن أعرض الرصيد الحالي/.test(String(rejected.body.reply)), `نص الرفض لم يمنع عرض الرصيد الحالي:\n${rejected.body.reply}`);
  ok("رصيد حساب بفترة تاريخية يأخذ لقطة الفترة (أو يرفض صراحة) ولا يعرض الرصيد الحالي مموَّهاً");
}

// ── Codex P1: تاريخ تقويمي صريح (ISO / يوم-شهر-سنة) لا يسقط على اليوم ───────
{
  // ملاحظة Codex على PR #205 (discussion_r4018343653): «مبيعات 2026-09-01»
  // و«مبيعات يوم 1/9/2026» لم تطابق أي فرع فترة، فكانت تُجاب بأرقام اليوم.
  const target = "2026-09-01";
  const today = new Date(Date.now() + 180 * 60_000).toISOString().slice(0, 10);
  const fixtures = defaultFixtures();
  fixtures.sales_line_items = [
    { sale_date: target, bill_no: "t1", bill_type: "retail", item_name: "أ", qty: 1, line_total: 321, net_profit: 21, unit_cost: 300, customer_name: "س" },
    { sale_date: today, bill_no: "t0", bill_type: "retail", item_name: "أ", qty: 1, line_total: 999, net_profit: 9, unit_cost: 990, customer_name: "س" }
  ];
  fixtures.sales_line_items_sync_state = [{
    source: "ameen_sales_line_items",
    window_start: "2026-01-01",
    window_end: today,
    row_count: 2,
    completed_at: new Date().toISOString()
  }];

  const isoAsk = await (await loadAssistant({ fixtures })).ask(TOKENS.owner, "مبيعات 2026-09-01");
  const isoText = String(isoAsk.body.reply);
  assert.equal(isoAsk.body.answered, true, `ISO صريح رُفض:\n${isoText}`);
  assert.ok(isoText.includes("321"), `لم يقرأ مبيعات ${target}:\n${isoText}`);
  assert.ok(!isoText.includes("999"), `سقط على مبيعات اليوم بدل التاريخ الصريح:\n${isoText}`);
  assert.ok(isoText.includes(target) || /2026-09-01/.test(isoText), `لم يذكر التاريخ المطلوب في الجواب:\n${isoText}`);

  const dmyAsk = await (await loadAssistant({ fixtures })).ask(TOKENS.owner, "مبيعات يوم 1/9/2026");
  const dmyText = String(dmyAsk.body.reply);
  assert.equal(dmyAsk.body.answered, true, `يوم/شهر/سنة رُفض:\n${dmyText}`);
  assert.ok(dmyText.includes("321"), `صيغة 1/9/2026 لم تُقرأ كمبيعات ${target}:\n${dmyText}`);
  assert.ok(!dmyText.includes("999"), `صيغة يوم/شهر/سنة سقطت على اليوم:\n${dmyText}`);

  const bad = await (await loadAssistant({ fixtures })).ask(TOKENS.owner, "مبيعات يوم 99/99/2026");
  assert.equal(bad.body.answered, false, `تاريخ غير صالح كان يجب رفضه:\n${bad.body.reply}`);
  assert.equal(bad.body.error, "unrecognized_date", `رمز الرفض ليس unrecognized_date:\n${JSON.stringify(bad.body)}`);
  assert.ok(/لن أجيب بأرقام/.test(String(bad.body.reply)) || /لم أتعرّف على صيغته/.test(String(bad.body.reply)),
    `نص الرفض لا يمنع السقوط على اليوم:\n${bad.body.reply}`);
  assert.ok(!String(bad.body.reply).includes("999"), `تاريخ فاسد أجاب بمبيعات اليوم:\n${bad.body.reply}`);

  // اسم شهر عربي — رصدها Codex بعد 3fdb433: «15 سبتمبر» بلا «يوم» كانت تسقط على اليوم.
  const namedAsk = await (await loadAssistant({ fixtures })).ask(TOKENS.owner, "مبيعات 1 سبتمبر 2026");
  const namedText = String(namedAsk.body.reply);
  assert.equal(namedAsk.body.answered, true, `اسم شهر عربي رُفض:\n${namedText}`);
  assert.ok(namedText.includes("321"), `«1 سبتمبر 2026» لم تُقرأ كمبيعات ${target}:\n${namedText}`);
  assert.ok(!namedText.includes("999"), `اسم شهر عربي سقط على مبيعات اليوم:\n${namedText}`);

  const namedDay = await (await loadAssistant({ fixtures })).ask(TOKENS.owner, "مبيعات يوم 1 سبتمبر");
  const namedDayText = String(namedDay.body.reply);
  assert.equal(namedDay.body.answered, true, `«يوم 1 سبتمبر» رُفض:\n${namedDayText}`);
  assert.ok(namedDayText.includes("321"), `«يوم 1 سبتمبر» لم يُحلّ إلى ${target}:\n${namedDayText}`);
  assert.ok(!namedDayText.includes("999"), `«يوم 1 سبتمبر» سقط على اليوم:\n${namedDayText}`);

  const badMonth = await (await loadAssistant({ fixtures })).ask(TOKENS.owner, "مبيعات 99 سبتمبر");
  assert.equal(badMonth.body.answered, false, `يوم خارج الشهر يجب أن يُرفض:\n${badMonth.body.reply}`);
  assert.equal(badMonth.body.error, "unrecognized_date");
  assert.ok(!String(badMonth.body.reply).includes("999"), `شهر عربي فاسد أجاب بمبيعات اليوم:\n${badMonth.body.reply}`);
  ok("تاريخ تقويمي صريح (ISO / يوم-شهر-سنة / اسم شهر عربي) يُقرأ، والصيغة المجهولة تُرفض بلا سقوط على اليوم");
}

// ── Codex P1: مبيعات الزبون X لا تذهب لإجمالي المبيعات ───────────────────────
{
  // ملاحظة Codex على PR #205 (discussion_r4018513793): «مبيعات الزبون سامر اليوم»
  // كانت تطابق أداة المبيعات الإجمالية فتعرض إيراد كل الزبائن.
  const today = new Date(Date.now() + 180 * 60_000).toISOString().slice(0, 10);
  const fixtures = defaultFixtures();
  fixtures.sales_line_items = [
    { sale_date: today, bill_no: "1", bill_type: "retail", item_name: "أ", qty: 1, line_total: 8888, unit_cost: 80, customer_name: "زبون آخر" },
    { sale_date: today, bill_no: "2", bill_type: "retail", item_name: "ب", qty: 1, line_total: 111, unit_cost: 10, customer_name: "سامر الوهمي" }
  ];
  fixtures.sales_line_items_sync_state = [{
    source: "ameen_sales_line_items",
    window_start: today,
    window_end: today,
    row_count: 2,
    completed_at: new Date().toISOString()
  }];
  fixtures["inventory_reports:ameen_customer_invoices"] = [{
    report_date: today,
    created_at: new Date().toISOString(),
    summary: { bills: 1, customers: 1, fromDate: today },
    items: [{
      name: "سامر الوهمي",
      customerGuid: "aaa11111",
      invoices: [{
        date: today,
        total: 111,
        isReturn: false,
        items: [{ itemName: "ب", qty: 1, price: 111, lineTotal: 111 }]
      }]
    }]
  }];

  const a = await loadAssistant({ fixtures });
  const result = await a.ask(TOKENS.owner, "مبيعات الزبون سامر الوهمي اليوم");
  const text = String(result.body.reply);
  assert.equal(result.body.tool, "customer", `ذهب إلى ${result.body.tool} بدل ملف الزبون:\n${text}`);
  assert.equal(result.body.answered, true, `مبيعات الزبون رُفضت:\n${text}`);
  assert.ok(/سامر الوهمي/.test(text), `لم يذكر الزبون المطلوب:\n${text}`);
  assert.ok(a.metrics.tablesRead.has("inventory_reports"), `لم يقرأ تقارير الزبون:\n${[...a.metrics.tablesRead]}`);
  assert.ok(!a.metrics.tablesRead.has("sales_line_items"), `قرأ سطور المبيعات الإجمالية رغم سؤال زبون معيّن:\n${[...a.metrics.tablesRead]}`);
  assert.ok(!/8,888|8888/.test(text), `عرض إجمالي زبون آخر ضمن جواب مبيعات الزبون:\n${text}`);
  ok("مبيعات الزبون X تُوجَّه لملف الزبون وتُرشَّح بهويته — لا لإجمالي المبيعات");
}

// ── Codex P1: مدى بتاريخين صريحين لا يُختزل لليوم الأوّل ─────────────────────
{
  // ملاحظة Codex على PR #205 (discussion_r4018748908): «من 2026-09-01 إلى
  // 2026-09-10» كانت تُقرأ كيوم واحد (الطرف الأوّل فقط).
  const fixtures = defaultFixtures();
  fixtures.sales_line_items = [
    { sale_date: "2026-09-01", bill_no: "1", bill_type: "retail", item_name: "أ", qty: 1, line_total: 100, unit_cost: 90, customer_name: "س" },
    { sale_date: "2026-09-05", bill_no: "2", bill_type: "retail", item_name: "أ", qty: 1, line_total: 200, unit_cost: 90, customer_name: "س" },
    { sale_date: "2026-09-10", bill_no: "3", bill_type: "retail", item_name: "أ", qty: 1, line_total: 300, unit_cost: 90, customer_name: "س" },
    { sale_date: "2026-09-15", bill_no: "4", bill_type: "retail", item_name: "أ", qty: 1, line_total: 999, unit_cost: 90, customer_name: "س" }
  ];
  fixtures.sales_line_items_sync_state = [{
    source: "ameen_sales_line_items",
    window_start: "2026-08-01",
    window_end: "2026-09-15",
    row_count: 4,
    completed_at: new Date().toISOString()
  }];

  const a = await loadAssistant({ fixtures });
  const result = await a.ask(TOKENS.owner, "كم مبيعات من 2026-09-01 إلى 2026-09-10؟");
  const text = String(result.body.reply);
  assert.equal(result.body.tool, "sales");
  assert.equal(result.body.answered, true, `مدى تاريخي رُفض:\n${text}`);
  assert.ok(/600/.test(text), `لم يجمع أيام المدى (100+200+300):\n${text}`);
  assert.ok(!/999/.test(text), `أدخل يوماً خارج المدى:\n${text}`);
  assert.ok(/2026-09-01/.test(text) && /2026-09-10/.test(text), `لم يذكر طرفي المدى:\n${text}`);
  ok("مدى بتاريخين صريحين (من…إلى) يُقرأ بطرفيه ولا يُختزل لليوم الأوّل");
}

// ── Codex P1: توصية الشراء تربط المبيعات بـ MatGUID لا بالاسم المطبَّع ───────
{
  // ملاحظة Codex على PR #205 (discussion_r4018748920): بطاقتان بنفس الاسم بعد
  // التطبيع تدمجان مبيعاتهما ثم تُنسَب كاملةً لكل صف → تغطية مبخوسة وتوصية زائفة.
  const today = new Date(Date.now() + 180 * 60_000).toISOString().slice(0, 10);
  const fixtures = defaultFixtures();
  fixtures["inventory_reports:ameen_sql_agent"] = [{
    report_date: today,
    created_at: new Date().toISOString(),
    summary: { totalStockItems: 2, availableItems: 2, lowStockItems: 2, outOfStockItems: 0, activeItems: 0, staleItems: 0, threshold: 50 },
    items: [
      { key: "غلواز كوين", name: "غلواز كوين", itemGuid: "guid-273", status: "low", stockQty: 10, unit1Name: "كروز" },
      { key: "غلواز كوين", name: "غلواز كوين", itemGuid: "guid-274", status: "low", stockQty: 10, unit1Name: "كروز" }
    ]
  }];
  fixtures.sales_line_items = [
    { sale_date: today, bill_no: "1", bill_type: "retail", item_name: "غلواز كوين", item_key: "guid-273", qty: 30, line_total: 300, unit_cost: 5, customer_name: "س" },
    { sale_date: today, bill_no: "2", bill_type: "retail", item_name: "غلواز كوين", item_key: "guid-274", qty: 3, line_total: 30, unit_cost: 5, customer_name: "س" }
  ];
  fixtures.sales_line_items_sync_state = [{
    source: "ameen_sales_line_items",
    window_start: new Date(Date.now() + 180 * 60_000 - 29 * 86_400_000).toISOString().slice(0, 10),
    window_end: today,
    row_count: 2,
    completed_at: new Date().toISOString()
  }];

  const b = await loadAssistant({ fixtures });
  const advice = await b.ask(TOKENS.owner, "ماذا يجب أن أشتري؟");
  const adviceText = String(advice.body.reply);
  assert.equal(advice.body.tool, "purchase_advice");
  assert.equal(advice.body.answered, true, `توصية GUID رُفضت:\n${adviceText}`);
  // guid-273: perDay=1, cover=10 → يظهر. guid-274: perDay=0.1, cover=100 → لا.
  // بالدمج الخاطئ perDay=1.1 على الاثنين → كلاهما cover≈9 → صفّان.
  const mentions = (adviceText.match(/غلواز كوين/g) || []).length;
  assert.ok(mentions === 1, `دُمجت مبيعات البطاقتين أو كُرِّرت التوصية (ظهور الاسم ${mentions} مرة):\n${adviceText}`);

  // حالة الأحرف: SQL Server قد يعيد GUID بأحرف كبيرة بينما المبيعات محفوظة بأحرف صغيرة
  const cased = {
    ...fixtures,
    "inventory_reports:ameen_sql_agent": [{
      ...fixtures["inventory_reports:ameen_sql_agent"][0],
      items: [
        { key: "غلواز كوين", name: "غلواز كوين", itemGuid: "GUID-273", status: "low", stockQty: 10, unit1Name: "كروز" },
        { key: "غلواز كوين", name: "غلواز كوين", itemGuid: "GUID-274", status: "low", stockQty: 10, unit1Name: "كروز" }
      ]
    }],
    sales_line_items: fixtures.sales_line_items.map((row) => ({
      ...row,
      item_key: String(row.item_key).toLowerCase()
    }))
  };
  const casedAdvice = await (await loadAssistant({ fixtures: cased })).ask(TOKENS.owner, "ماذا يجب أن أشتري؟");
  const casedText = String(casedAdvice.body.reply);
  assert.equal(casedAdvice.body.answered, true, `اختلاف حالة GUID رُفض:\n${casedText}`);
  assert.equal((casedText.match(/غلواز كوين/g) || []).length, 1,
    `اختلاف حالة GUID أعاد دمج البطاقتين:\n${casedText}`);
  ok("توصية الشراء تربط المبيعات بـ MatGUID ولا تدمج بطاقات متصادمة الاسم");
}

// ── Codex P1: مدى ينتهي بـ«اليوم» يحفظ البداية الصريحة ───────────────────────
{
  // discussion_r4018947150: «مبيعات من 1/9/2026 إلى اليوم» كانت تُختزل لليوم وحده.
  const today = new Date(Date.now() + 180 * 60_000).toISOString().slice(0, 10);
  const fixtures = defaultFixtures();
  fixtures.sales_line_items = [
    { sale_date: "2026-09-01", bill_no: "a", bill_type: "retail", item_key: "g1", item_name: "أ", qty: 1, line_total: 111, unit_cost: 100, customer_name: "س" },
    { sale_date: today, bill_no: "b", bill_type: "retail", item_key: "g1", item_name: "أ", qty: 1, line_total: 222, unit_cost: 200, customer_name: "س" },
    { sale_date: "2026-08-31", bill_no: "c", bill_type: "retail", item_key: "g1", item_name: "أ", qty: 1, line_total: 999, unit_cost: 900, customer_name: "س" }
  ];
  fixtures.sales_line_items_sync_state = [{
    source: "ameen_sales_line_items",
    window_start: "2026-01-01",
    window_end: today,
    row_count: 3,
    completed_at: new Date().toISOString()
  }];
  const ask = await (await loadAssistant({ fixtures })).ask(
    TOKENS.owner,
    "مبيعات من 1/9/2026 إلى اليوم"
  );
  const text = String(ask.body.reply);
  assert.equal(ask.body.answered, true, `مدى إلى اليوم رُفض:\n${text}`);
  assert.ok(/333/.test(text), `لم يجمع البداية مع اليوم (111+222=333):\n${text}`);
  assert.ok(!/999/.test(text), `أدخل يوماً قبل البداية:\n${text}`);
  assert.ok(/2026-09-01/.test(text), `لم يذكر بداية المدى:\n${text}`);
  assert.ok(/2/.test(text), `لم يعدّ فاتورتين في المدى:\n${text}`);
  ok("مدى «من تاريخ إلى اليوم» يحفظ البداية ولا يُختزل لليوم وحده");
}

// ── Codex P1: المقارنة تحترم الفترة المُسمّاة لا previousPeriod فقط ─────────
{
  // discussion_r4018947162: «هذا الشهر مقارنة بالشهر الماضي» كانت تقارن بنافذة
  // مساوية الطول قبل هذا الشهر لا بالشهر التقويمي السابق.
  const today = new Date(Date.now() + 180 * 60_000).toISOString().slice(0, 10);
  const firstOfMonth = `${today.slice(0, 7)}-01`;
  const lastMonthEnd = new Date(Date.parse(`${firstOfMonth}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const lastMonthStart = `${lastMonthEnd.slice(0, 7)}-01`;
  const fixtures = defaultFixtures();
  fixtures.sales_line_items = [
    { sale_date: firstOfMonth, bill_no: "c1", bill_type: "retail", item_key: "g1", item_name: "أ", qty: 1, line_total: 500, unit_cost: 400, customer_name: "س" },
    { sale_date: today, bill_no: "c2", bill_type: "retail", item_key: "g1", item_name: "أ", qty: 1, line_total: 100, unit_cost: 80, customer_name: "س" },
    { sale_date: lastMonthStart, bill_no: "p1", bill_type: "retail", item_key: "g1", item_name: "أ", qty: 1, line_total: 200, unit_cost: 150, customer_name: "س" },
    { sale_date: lastMonthEnd, bill_no: "p2", bill_type: "retail", item_key: "g1", item_name: "أ", qty: 1, line_total: 50, unit_cost: 40, customer_name: "س" }
  ];
  fixtures.sales_line_items_sync_state = [{
    source: "ameen_sales_line_items",
    window_start: "2026-01-01",
    window_end: today,
    row_count: 4,
    completed_at: new Date().toISOString()
  }];
  const ask = await (await loadAssistant({ fixtures })).ask(
    TOKENS.owner,
    "مبيعات هذا الشهر مقارنة بالشهر الماضي"
  );
  const text = String(ask.body.reply);
  assert.equal(ask.body.answered, true, `مقارنة الشهر رُفضت:\n${text}`);
  assert.ok(/الشهر الماضي/.test(text), `لم يذكر الشهر الماضي في المقارنة:\n${text}`);
  assert.ok(/600|500/.test(text), `لم يعرض مبيعات هذا الشهر:\n${text}`);
  assert.ok(/250/.test(text), `لم يقارن بمجموع الشهر الماضي (200+50=250):\n${text}`);
  assert.ok(text.includes(lastMonthStart) || text.includes(lastMonthEnd),
    `لم يذكر حدود الشهر الماضي التقويمي:\n${text}`);
  ok("المقارنة بـ«الشهر الماضي» تستخدم الشهر التقويمي السابق لا نافذة ميكانيكية");
}

// ── Codex P1: «علينا» لا تُوجَّه لذمم الزبائن المدينة ───────────────────────
{
  // ملاحظة Codex على PR #205 (discussion_r4019158397): «كم علينا ديون؟» كانت
  // تذهب لأداة الذمم المدينة وتعرض ما للزبائن علينا — عكس الميزانية.
  const a = await loadAssistant();
  const result = await a.ask(TOKENS.owner, "كم علينا ديون؟");
  assert.equal(result.body.tool, "payables", `ذهب إلى ${result.body.tool} بدل payables:\n${result.body.reply}`);
  assert.equal(result.body.answered, false, `ادّعى جواباً عن خصوم بلا مصدر:\n${result.body.reply}`);
  assert.equal(a.metrics.tablesRead.size, 0, `قرأ مصادر رغم غياب خصوم الموردين:\n${[...a.metrics.tablesRead]}`);
  assert.ok(/علينا|الموردين|غير متاح/.test(String(result.body.reply)),
    `لم يوضح أن ديون الموردين غير متاحة:\n${result.body.reply}`);
  assert.ok(!String(result.body.reply).includes("31,597"),
    `عرض ذمماً مدينة جواباً عن «علينا»:\n${result.body.reply}`);

  const b = await loadAssistant();
  const customers = await b.ask(TOKENS.owner, "من أكبر الزبائن مديونية؟");
  assert.equal(customers.body.tool, "receivables");
  assert.equal(customers.body.answered, true);
  ok("«علينا ديون» ترفض خصوم الموردين صراحة ولا تُرجع ذمم الزبائن المدينة");
}

// ── Codex P1: تواريخ المقارنة لا تُدمَج في الفترة الأساسية ───────────────────
{
  // ملاحظة Codex على PR #205 (discussion_r4019158383): «مبيعات 2026-09-15
  // مقارنة بـ 2026-09-01» كانت تجمع الطرفين كمدى أساسي 01→15 ثم تقارن بـ01.
  const fixtures = defaultFixtures();
  fixtures.sales_line_items = [
    { sale_date: "2026-09-01", bill_no: "1", bill_type: "retail", item_name: "أ", qty: 1, line_total: 100, unit_cost: 90, customer_name: "س" },
    { sale_date: "2026-09-10", bill_no: "2", bill_type: "retail", item_name: "أ", qty: 1, line_total: 999, unit_cost: 90, customer_name: "س" },
    { sale_date: "2026-09-15", bill_no: "3", bill_type: "retail", item_name: "أ", qty: 1, line_total: 250, unit_cost: 90, customer_name: "س" }
  ];
  fixtures.sales_line_items_sync_state = [{
    source: "ameen_sales_line_items",
    window_start: "2026-08-01",
    window_end: "2026-09-15",
    row_count: 3,
    completed_at: new Date().toISOString()
  }];
  const a = await loadAssistant({ fixtures });
  const result = await a.ask(TOKENS.owner, "مبيعات 2026-09-15 مقارنة بـ 2026-09-01");
  const text = String(result.body.reply);
  assert.equal(result.body.answered, true, `مقارنة يومين رُفضت:\n${text}`);
  assert.ok(/250/.test(text), `لم يقرأ مبيعات 2026-09-15 وحدها كأساس:\n${text}`);
  assert.ok(/100/.test(text), `لم يقارن بمبيعات 2026-09-01:\n${text}`);
  assert.ok(!/999/.test(text), `أدمج المدى 01→15 فأدخل يوم الوسط:\n${text}`);
  assert.ok(/2026-09-15/.test(text) && /2026-09-01/.test(text),
    `لم يذكر يومي المقارنة منفصلين:\n${text}`);
  ok("مقارنة تاريخين صريحين تفصل الأساس عن المقارنة ولا تدمجهما في مدى واحد");
}

console.log(`\nتوجيه المساعد الذكي: ${passed}/${passed} تحقق ناجح`);
