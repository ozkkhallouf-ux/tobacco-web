// ============================================================================
// فحص ثابت: **نوع سطر الحركة (lineKind) في push-customer-movements.ps1.**
//
// الخلل الذي يمنعه (تدقيق AmnDb002، 2026-09-27): تقرير الحركات لا يحمل نوع السطر،
// فيقرأ الموقع حسم رأس الفاتورة (94 سطراً) ومشترياتنا من حساب زبون (158 سطراً) دفعاتٍ
// للزبون. lineKind يُشتق من العلاقات المحاسبية — ربط er000 بمستنده ونوعه، والحساب
// المقابل وأبوه/جده في شجرة ac000 — لا من نص الملاحظة، وما لا يثبت نوعه unknown.
//
// الفحص نصّي على السكربت (لا وصول للأمين هنا): يثبت العقد لا النتائج. النتائج مُثبتة
// قراءةً على OZK2026: 94/94 حسماً ⇒ discount، 79/79 دفعة عند البيع ⇒ sale_payment،
// 158/158 شراء ⇒ purchase، 55/55 مرتجعاً ⇒ return، 5/5 تسوية جرد ⇒ adjustment.
// ============================================================================
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const ps = readFileSync(new URL("../tools/push-customer-movements.ps1", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const here = (name) => {
  const m = ps.match(new RegExp(`\\$${name} = @"\\n([\\s\\S]*?)\\n"@`));
  assert.ok(m, `here-string مفقود: $${name}`);
  return m[1];
};
const results = [];
let failed = 0;
const test = (name, fn) => {
  try { fn(); results.push(`  ✅ ${name}`); } catch (error) { failed += 1; results.push(`  ❌ ${name}\n     ${error.message}`); }
};

const sel = here("lineKindSel");
const apply = here("lineKindApply");
const ALLOWED = ["sale", "sale_payment", "discount", "return", "purchase", "purchase_payment", "purchase_return",
  "payment", "payment_out", "opening", "debt_transfer", "adjustment", "other", "unknown"];

test("كل الأنواع المُنتَجة من القائمة المعتمدة", () => {
  const kinds = [...sel.matchAll(/THEN '([a-z_]+)'|ELSE '([a-z_]+)'/g)].map((m) => m[1] || m[2]);
  assert.ok(kinds.length > 10);
  for (const kind of kinds) assert.ok(ALLOWED.includes(kind), `نوع غير معتمد: ${kind}`);
  for (const kind of ["sale", "sale_payment", "discount", "purchase", "return", "debt_transfer", "adjustment", "unknown"]) {
    assert.ok(kinds.includes(kind), `نوع مطلوب غائب: ${kind}`);
  }
});

test("التصنيف لا يقرأ نص الملاحظة أبداً", () => {
  assert.ok(!/Notes/i.test(sel), "lineKindSel يقرأ en.Notes");
  assert.ok(!/Notes/i.test(apply), "lineKindApply يقرأ en.Notes");
});

test("المصدر: ربط er000 ونوع الفاتورة والحساب المقابل وشجرته", () => {
  assert.match(apply, /FROM dbo\.er000 lr WHERE lr\.EntryGUID = en\.ParentGUID/);
  assert.match(apply, /COUNT\(\*\) OVER \(\) AS n/, "حارس الربط المتعدد");
  assert.match(apply, /dbo\.bt000 lbt ON lbt\.GUID = lbu\.\[\$buTypeCol\]/);
  assert.match(apply, /dbo\.ac000 lca ON lca\.GUID = en\.ContraAccGUID/);
  assert.match(apply, /dbo\.ac000 lcg ON lcg\.GUID = lcp\.ParentGUID/);
  assert.match(sel, /WHEN lk\.n > 1 THEN 'unknown'/, "ربط مبهم ⇒ unknown");
});

test("الحسم والدفعة عند البيع والشراء بالحساب المقابل لا بالتخمين", () => {
  assert.match(sel, /lbt\.BillType = 1 THEN CASE\s+WHEN lca\.Code = '43' THEN CASE WHEN en\.Credit > 0 THEN 'discount'/);
  assert.match(sel, /WHEN lcp\.Code = '13' THEN CASE WHEN en\.Credit > 0 THEN 'sale_payment'/);
  assert.match(sel, /lbt\.BillType = 0 THEN CASE\s+WHEN lcp\.Code = '13' THEN 'purchase_payment'\s+WHEN lca\.Code = '124' OR lcp\.Code = '124' THEN 'purchase'/);
});

test("الانتماء بالشجرة لا ببادئة الرمز (545616 زبون تحت 1212)", () => {
  assert.ok(!/LEFT\(lca\.Code/.test(sel), "بادئة رمز الحساب ليست دليل انتماء");
  assert.match(sel, /WHEN lca\.GUID IS NULL THEN 'unknown'/, "قيد بلا حساب مقابل ⇒ unknown");
});

test("العمود يُقرأ ويُرفع، والعلامة v1 مع مصدرها", () => {
  assert.match(ps, /\$lineKindSel AS line_kind,/);
  assert.match(ps, /\n\$lineKindApply\n\s+WHERE \(COALESCE\(en\.Debit,0\) > 0/);
  assert.match(ps, /docPrev,\n\s+line_kind\nFROM led/);
  assert.match(ps, /lineKind = \[string\]\$r\.GetValue\(10\)/);
  assert.match(ps, /lineKinds\s+= \$\(if \(\$buTypeCol\) \{ "v1" \} else \{ \$null \}\)/);
});

test("قراءة فقط: لا كتابة إلى الأمين في كتلة التصنيف", () => {
  for (const text of [sel, apply]) assert.ok(!/\b(INSERT|UPDATE|DELETE|MERGE|EXEC|DROP|ALTER|CREATE)\b/i.test(text));
});

console.log(results.join("\n"));
if (failed) { console.error(`نوع سطر الحركة: فشل ${failed}`); process.exit(1); }
console.log(`نوع سطر الحركة: ${results.length} عقود محسومة.`);
