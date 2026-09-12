// حارس تخويل المساعد الذكي — العقد السلوكي على مستوى الخادم.
//
// العطل الذي وُلد منه هذا الحارس (2026-09-06): كان التخويل قائمة إيميلات ثابتة
// في supabase/functions/financial-assistant/index.ts:
//   DEFAULT_STAFF = ["ozk.kh@outlook.com", "khalelkhalouf1196@gmail.com"]
// وهي انفصلت عن مصدر التخويل الحقيقي (app_metadata.role) فأنتجت **عكس** المراد:
//   • حسابا المالك (role='owner') يُرفضان بـ403 «متاح للحسابات الإدارية المخوّلة فقط»
//   • حساب role='employee' يقرأ الصناديق والأرباح وذمم الزبائن
//   • وإيميل بالقائمة غير موجود أصلاً بقاعدة المستخدمين (خطأ إملائي)
// لم يكن العطل «قائمة ضيّقة» بل قائمة **مختلفة عن الدور**. أي قائمة إيميلات
// جديدة ستعيد نفس الانفصال، ولذلك يفرض هذا الحارس أن الملف لا يحوي أي إيميل.
import assert from "node:assert/strict";
import { loadAssistant, functionSource, TOKENS } from "./lib/assistant-harness.mjs";

let passed = 0;
const ok = (label) => { passed += 1; console.log(`  ✓ ${label}`); };

// ── أ) مالك OZK يستطيع استخدام المساعد ──────────────────────────────────────
{
  const a = await loadAssistant();
  const result = await a.ask(TOKENS.owner, "كم يوجد بالصندوق؟");
  assert.equal(result.status, 200, "مالك OZK رُفض من المساعد");
  assert.notEqual(result.body.error, "forbidden", "مالك OZK حصل على forbidden");
  assert.equal(result.body.role, "owner");
  assert.ok(String(result.body.reply).includes("2,193.09"), "لم يصل جواب الصندوق الحقيقي للمالك");
  assert.equal(a.metrics.authCalls, 1, "لم يجرِ التحقق من الهوية على الخادم");
  ok("مالك OZK (app_metadata.role=owner) يستخدم المساعد ويصله رقم الصندوق");
}

// ── ب) الموظف يصل للتشغيلي فقط، ويُمنع من الإداري الحساس ────────────────────
{
  const a = await loadAssistant();
  const allowed = await a.ask(TOKENS.employee, "ما الأصناف الناقصة؟");
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.tool, "inventory", "الموظف مُنع من بيانات المخزون التشغيلية");
  assert.equal(allowed.body.role, "employee");
  ok("الموظف يقرأ المخزون (بيانات تشغيلية غير حساسة)");

  const sensitive = [
    ["كم يوجد بالصندوق؟", "cashbox"],
    ["كم مبيعات اليوم؟", "sales"],
    ["ما الأرباح؟", "profit"],
    ["من أكبر الزبائن مديونية؟", "receivables"],
    ["ما رصيد الزبون جهاد التلي؟", "customer"],
    ["ما المصاريف؟", "expenses"],
    ["ما المشتريات؟", "purchases"]
  ];
  for (const [question, tool] of sensitive) {
    const fresh = await loadAssistant();
    const denied = await fresh.ask(TOKENS.employee, question);
    assert.equal(denied.status, 200, `${question}: حالة غير متوقعة`);
    assert.notEqual(denied.body.tool, tool, `الموظف وصل لأداة إدارية حساسة: ${tool}`);
    assert.equal(denied.body.answered, false, `الموظف حصل على جواب من أداة حساسة عبر «${question}»`);
    // ولا يلمس أي مصدر إداري
    for (const table of ["daily_movement_reports", "expense_entries", "ameen_purchase_invoice_reports"]) {
      assert.ok(!fresh.metrics.tablesRead.has(table), `الموظف وصل لجدول إداري: ${table} عبر «${question}»`);
    }
  }
  ok(`الموظف مُنع من ${sensitive.length} أداة إدارية حساسة ولم يلمس مصادرها`);
}

// ── ج) أعمدة التكلفة والربح لا تُطلب أصلاً لحساب الموظف ─────────────────────
{
  const a = await loadAssistant();
  await a.ask(TOKENS.employee, "ما حركة ماستر طويل ورق؟");
  const salesReads = a.metrics.reads.filter((query) => query.startsWith("sales_line_items"));
  assert.ok(salesReads.length > 0, "لم تُقرأ سطور المبيعات إطلاقاً");
  for (const query of salesReads) {
    assert.ok(!query.includes("unit_cost"), `طُلب عمود unit_cost لحساب موظف: ${query}`);
    assert.ok(!query.includes("net_profit"), `طُلب عمود net_profit لحساب موظف: ${query}`);
  }
  const employeeAnswer = await a.ask(TOKENS.employee, "ما حركة ماستر طويل ورق؟");
  assert.ok(!/هامش|تكلفه|تكلفة|ربح/.test(String(employeeAnswer.body.reply)), "ظهر هامش/تكلفة في جواب الموظف");
  ok("عمود التكلفة لا يُطلب من قاعدة البيانات أصلاً لحساب موظف، ولا يظهر هامش في جوابه");

  const owner = await loadAssistant();
  const ownerAnswer = await owner.ask(TOKENS.owner, "ما حركة ماستر طويل ورق؟");
  assert.ok(
    owner.metrics.reads.some((query) => query.includes("unit_cost")),
    "المالك حُرم من عمود التكلفة"
  );
  assert.ok(/هامش المنتج/.test(String(ownerAnswer.body.reply)), "المالك لم يحصل على الهامش");
  ok("المالك يحصل على التكلفة والهامش — التضييق يخص الموظف وحده");
}

// ── د) هويات مرفوضة: مجهول، رمز منتهٍ، حساب جرد، حساب بلا دور ───────────────
{
  const cases = [
    ["مجهول بلا رمز", null, 401],
    ["رمز غير صالح", TOKENS.expired, 401],
    ["حساب جرد (inventory_counter)", TOKENS.counter, 403],
    ["حساب بلا أي دور", TOKENS.roleless, 403]
  ];
  for (const [label, token, expected] of cases) {
    const a = await loadAssistant();
    const result = await a.ask(token, "كم يوجد بالصندوق؟");
    assert.equal(result.status, expected, `${label}: حالة غير متوقعة`);
    assert.equal(a.metrics.tablesRead.size, 0, `${label}: وصل لبيانات قبل الرفض`);
    ok(`${label} مرفوض بـ${expected} ولم يلمس أي مصدر بيانات`);
  }
}

// ── هـ) الصلاحية تُفرض على الخادم — لا تُقرأ من جسم الطلب إطلاقاً ────────────
{
  const forged = {
    role: "owner",
    accessRole: "owner",
    owner: true,
    app_metadata: { role: "owner" },
    email: "ozkkhalouf@gmail.com",
    uid: "9724dbe4-owner",
    isOwner: true
  };
  for (const [label, token, expected] of [
    ["موظف ينتحل دور المالك", TOKENS.employee, "employee"],
    ["حساب جرد ينتحل دور المالك", TOKENS.counter, null],
    ["حساب بلا دور ينتحل دور المالك", TOKENS.roleless, null]
  ]) {
    const a = await loadAssistant();
    const result = await a.ask(token, "كم يوجد بالصندوق؟", forged);
    if (expected === null) {
      assert.equal(result.status, 403, `${label}: نجح الانتحال`);
    } else {
      assert.equal(result.body.role, expected, `${label}: الخادم صدّق الدور المُرسل من العميل`);
      assert.notEqual(result.body.tool, "cashbox", `${label}: وصل للصندوق بانتحال`);
    }
    assert.ok(!a.metrics.tablesRead.has("daily_movement_reports"), `${label}: قرأ الصناديق`);
    ok(`${label} — الخادم تجاهل الدور المزوَّر وأبقى الصلاحية من app_metadata`);
  }
}

// ── و) مصدر الحقيقة: app_metadata حصراً، ولا قائمة إيميلات في الكود ─────────
{
  const source = functionSource();
  // التعليقات تشرح لماذا لا نستعمل user_metadata، فالفحص يجري على الكود وحده.
  const code = source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  assert.ok(code.includes("app_metadata"), "الملف لا يقرأ app_metadata");
  assert.ok(
    !/user_metadata/.test(code),
    "الكود يقرأ user_metadata — وهو حقل يعدّله المستخدم بنفسه فلا يصلح للتخويل"
  );
  // أي إيميل حرفي في الكود = بداية عودة العطل نفسه
  const emails = code.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? [];
  assert.deepEqual(
    emails,
    [],
    `الملف يحوي إيميلات حرفية (${emails.join(", ")}) — التخويل يجب أن يبقى بالدور وحده`
  );
  ok("لا توجد أي قائمة إيميلات في الدالة — التخويل من app_metadata.role فقط");
}

// ── ز) الواجهة لا تملك أي مفتاح خدمة ولا تقرر الصلاحية ──────────────────────
{
  const fs = await import("node:fs");
  for (const file of ["src/supabase-client.js", "src/app.js", "src/config.js"]) {
    const text = fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.ok(!/service_role|SERVICE_ROLE_KEY|sb_secret_/.test(text), `${file} يحوي مفتاح خدمة`);
  }
  ok("لا مفتاح service-role ولا سر خادم في أي ملف يصل للمتصفح");
}

console.log(`\nتخويل المساعد الذكي: ${passed}/${passed} تحقق ناجح`);
