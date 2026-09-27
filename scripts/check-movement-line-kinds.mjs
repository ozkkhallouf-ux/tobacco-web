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
const cte = here("lineKindCte");
const balancesSql = readFileSync(new URL("../tools/ameen-customer-balances-query.sql", import.meta.url), "utf8");
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
  assert.match(sel, /WHEN lkc\.isCash = 1 THEN CASE WHEN en\.Credit > 0 THEN 'sale_payment'/);
  assert.match(sel, /lbt\.BillType = 0 THEN CASE\s+WHEN lkc\.isCash = 1 THEN 'purchase_payment'\s+WHEN lca\.Code = '124' OR lcp\.Code = '124' THEN 'purchase'/);
});

test("حركة الصندوق بتعريف الدفعة الموحّد نفسه في ameen-customer-balances-query.sql", () => {
  // نفس المعرّفات: شجرة 13، واستثناء 135 فروقات الصندوق، وشجرة 121، والقيد الافتتاحي.
  for (const guid of ["c0dc3c06-b2ac-4e57-beae-19d7da3f514c", "ef5d9f4c-db3a-4307-a402-4fefe3e4e2b8",
    "e30187a7-eccc-4ff8-8a7d-f2df5e660b53", "ea69ba80-662d-4fa4-90ee-4d2e1988a8ea"]) {
    assert.ok(balancesSql.includes(guid), `المعرّف ليس في التعريف الموحّد: ${guid}`);
    assert.ok((cte + apply).includes(guid), `المعرّف غائب عن lineKind: ${guid}`);
  }
  assert.match(apply, /COALESCE\(en\.Type, 0\) = 0/, "سطر عادي فقط");
  assert.match(apply, /en\.ContraAccGUID IN \(SELECT GUID FROM lk_cash\)/);
  assert.match(apply, /EXISTS \(SELECT 1 FROM dbo\.en000 cd WHERE cd\.ParentGUID = en\.ParentGUID/, "القيد المركب بمقابل صفري");
  assert.match(sel, /WHEN lkc\.isCash = 1 AND en\.Credit > 0 THEN CASE WHEN lkc\.isCustomerTree = 1 THEN 'payment' ELSE 'other' END/, "القبض دفعة زبون على شجرة 121 وحدها");
  assert.match(sel, /WHEN lkc\.isCashDiff = 1 THEN 'adjustment'/, "135 فروقات الصندوق تسوية");
  assert.ok(!/lcp\.Code = '13' THEN CASE/.test(sel), "لا اختصار «أبوه 13» للدفعة");
});

test("الانتماء بالشجرة لا ببادئة الرمز (545616 زبون تحت 1212)", () => {
  assert.ok(!/LEFT\(lca\.Code/.test(sel), "بادئة رمز الحساب ليست دليل انتماء");
  assert.match(sel, /WHEN lca\.GUID IS NULL THEN 'unknown'/, "قيد بلا حساب مقابل ⇒ unknown");
});

test("العمود يُقرأ ويُرفع، والعلامة v1 مع مصدرها", () => {
  assert.match(ps, /WITH \$lineKindCte led AS \(/);
  assert.match(ps, /\$lineKindSel AS line_kind,/);
  assert.match(ps, /\n\$lineKindApply\n\s+WHERE \(COALESCE\(en\.Debit,0\) > 0/);
  assert.match(ps, /docPrev,\n\s+line_kind\nFROM led/);
  assert.match(ps, /lineKind = \[string\]\$r\.GetValue\(10\)/);
  assert.match(ps, /lineKinds\s+= \$\(if \(\$buTypeCol\) \{ "v1" \} else \{ \$null \}\)/);
});

test("قراءة فقط: لا كتابة إلى الأمين في كتلة التصنيف", () => {
  for (const text of [sel, apply, cte]) assert.ok(!/\b(INSERT|UPDATE|DELETE|MERGE|EXEC|DROP|ALTER|CREATE)\b/i.test(text));
});

test("عقد الإنتاج (#277): كل نوع يُنتجه المصدر معروف للمحرك، والعلامة نفسها", () => {
  // المحرك (src/customer-intelligence.js) يقرأ lineKind فقط حين summary.lineKinds === LINE_KINDS_MARKER،
  // وأي قيمة خارج KNOWN_LINE_KINDS تُعامل unknown — فيجب ألا يُنتج المصدر نوعاً لا يعرفه المحرك.
  const engine = readFileSync(new URL("../src/customer-intelligence.js", import.meta.url), "utf8");
  const known = engine.match(/const KNOWN_LINE_KINDS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(known, "KNOWN_LINE_KINDS غائب عن المحرك");
  const engineKinds = new Set([...known[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]));
  const produced = new Set([...sel.matchAll(/THEN '([a-z_]+)'|ELSE '([a-z_]+)'/g)].map((m) => m[1] || m[2]));
  for (const kind of produced) assert.ok(engineKinds.has(kind), `المصدر يُنتج نوعاً لا يعرفه المحرك: ${kind}`);
  const marker = engine.match(/const LINE_KINDS_MARKER = "([^"]+)";/);
  assert.ok(marker, "LINE_KINDS_MARKER غائب عن المحرك");
  assert.match(ps, new RegExp(`lineKinds\\s+= \\$\\(if \\(\\$buTypeCol\\) \\{ "${marker[1]}" \\}`), "علامة المصدر تطابق علامة المحرك");
  // المحرك يقرأ الحقل باسم lineKind لكل حركة، ويوم المحاسبة من report_date.
  assert.match(engine, /movement\?\.lineKind \?\? movement\?\.line_kind/);
  assert.match(ps, /lineKind = \[string\]\$r\.GetValue\(10\)/);
  assert.match(ps, /report_date = \(Get-Date\)\.ToString\("yyyy-MM-dd"\)/, "يوم المحاسبة المحلي في التقرير");
});

console.log(results.join("\n"));
if (failed) { console.error(`نوع سطر الحركة: فشل ${failed}`); process.exit(1); }
console.log(`نوع سطر الحركة: ${results.length} عقود محسومة.`);
