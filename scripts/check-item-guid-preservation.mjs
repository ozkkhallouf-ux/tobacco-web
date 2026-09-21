// يتحقق أن replaceApprovedPriceItems() في src/supabase-client.js يحافظ على item_guid
// عبر دورة الحذف/إعادة الإدخال الكاملة، تماماً كما يحافظ على item_number وitem_code.
// بدون هذا، كل استبدال كامل للائحة الأسعار كان يمسح item_guid لكل الأصناف ويتركها تنتظر
// مهمة الـsnapshot المجدولة (حتى 6 ساعات) لإعادة تعبئتها، فتتعطّل مطابقة متوسط التكلفة مؤقتاً.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/supabase-client.js", import.meta.url), "utf8");

const fnMatch = source.match(/async replaceApprovedPriceItems\(items\) \{[\s\S]*?\n    \},/);
assert.ok(fnMatch, "تعذّر عزل replaceApprovedPriceItems() للفحص — تحقق من تطابق النمط في supabase-client.js.");
const fn = fnMatch[0];

// 1) الجلب قبل الحذف يجب أن يشمل item_guid إلى جانب item_number/item_code.
assert.match(
  fn,
  /\.select\("item_key, item_number, item_code, item_guid"\)/,
  "الاستعلام السابق للحذف يجب أن يجلب item_guid أيضاً كي لا يُفقد."
);

// 2) يجب بناء خريطة guidByKey من نفس الصفوف المجلوبة (مثل numberByKey/codeByKey).
assert.match(fn, /let guidByKey = null;/, "يجب تعريف guidByKey بنفس نمط numberByKey/codeByKey.");
assert.match(
  fn,
  /guidByKey\[row\.item_key\] = row\.item_guid;/,
  "يجب تعبئة guidByKey من الصفوف الحالية قبل الحذف."
);

// 3) فشل الجلب (أي من الثلاثة) يجب أن يوقف الحفظ بأمان بدل تنفيذ حذف أعمى.
assert.match(
  fn,
  /if \(!numberByKey \|\| !codeByKey \|\| !guidByKey\) \{/,
  "فشل جلب item_guid يجب أن يوقف الحفظ بأمان تماماً مثل فشل جلب item_number/item_code."
);

// 4) الصفوف المُعاد إدخالها يجب أن تحمل item_guid المحفوظ، وإلا الهوية الموثوقة
//    الواردة من الجرد الحي (rec.item_guid). الترتيب مقصود: هوية صفٍّ قائم مرجع
//    لا يُدهَس (نفس قاعدة upsertApprovedPriceItems وحارس #257)، والموثوقة تُثبَّت
//    للمفتاح الجديد وحده — وهو ما كان يُدرَج بـ NULL قبل هذا الإصلاح.
assert.match(
  fn,
  /item_guid:\s*guidByKey\[rec\.item_key\]\s*\?\?\s*rec\.item_guid\s*\?\?\s*null/,
  "الصفوف المُعاد إدخالها يجب أن تحمل الهوية المحفوظة أولاً ثم الموثوقة الواردة."
);

console.log("check-item-guid-preservation: OK — replaceApprovedPriceItems() يحافظ على item_guid عبر الحذف/الإعادة.");
