// يتحقق من مطابقة "متوسط التكلفة" (item_costs) بأصناف شاشة التسعير:
// - الأولوية لمطابقة GUID على مطابقة الاسم (لا يضيع عند تغيّر تهجئة الاسم).
// - الرجوع للاسم عند غياب GUID لا يزال يعمل.
// - صنف بلا أي تطابق يُرجع null ("غير متوفر") لا قيمة قديمة ولا صفر مضلِّل.
// - تحديث state.itemCosts (دفعة جديدة من push-item-costs.ps1) ينعكس فوراً بلا تجمّد
//   (فحص إبطال ذاكرة _costIndexRef/_costIndex في itemCostIndex()).
import { readFileSync } from "node:fs";
import vm from "node:vm";

const appJs = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");

const normalizeItemNameFn = appJs.match(/function normalizeItemName\(value\) \{[\s\S]*?\n\}/)?.[0];
const costIndexBlock = appJs.match(
  /let _costIndexRef = null;\nlet _costIndex = new Map\(\);\nfunction itemCostIndex\(\) \{[\s\S]*?\n\}\nfunction itemCostFor\(item\) \{[\s\S]*?\n\}/
)?.[0];

let failed = false;

if (!normalizeItemNameFn || !costIndexBlock) {
  console.error("تعذّر عزل normalizeItemName/itemCostIndex/itemCostFor للفحص — تحقق من تطابق الأنماط في app.js.");
  process.exit(1);
}

function run(itemCosts) {
  const sandbox = {
    state: { itemCosts },
    isOwner: () => true,
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(`${normalizeItemNameFn}\n${costIndexBlock}`, sandbox);
  return sandbox;
}

// 1) مطابقة GUID لها الأولوية حتى لو الاسم المخزَّن في item_costs مختلفاً عن اسم الصنف الحالي
{
  const sandbox = run([
    { item_guid: "1f263b30-64a8-4ea3-a2a3-3379b451ad98", item_name: "اسم قديم مختلف تماماً", avg_cost: 4.1 },
    { item_guid: null, item_name: "بلاتينيوم سليم نعنع", avg_cost: 999 } // فخ: تطابق بالاسم لو لم يُعطَ الأولوية لـGUID
  ]);
  const result = sandbox.itemCostFor({
    itemGuid: "1f263b30-64a8-4ea3-a2a3-3379b451ad98",
    name: "بلاتينيوم سليم نعنع"
  });
  if (!result || result.avg_cost !== 4.1) {
    console.error("مطابقة item_guid يجب أن تُقدَّم على مطابقة الاسم في itemCostFor().");
    failed = true;
  }
}

// 2) الرجوع للاسم عند غياب GUID في الصنف أو عدم توفره في item_costs
{
  const sandbox = run([{ item_guid: null, item_name: "دنهل احمر", avg_cost: 2.75 }]);
  const result = sandbox.itemCostFor({ itemGuid: "", name: "دنهل احمر" });
  if (!result || result.avg_cost !== 2.75) {
    console.error("يجب أن تعمل مطابقة الاسم عند غياب item_guid (الرجوع الآمن).");
    failed = true;
  }
}

// 3) صنف بلا أي تطابق يُرجع null بوضوح — لا صفر ولا قيمة صنف آخر
{
  const sandbox = run([{ item_guid: "aaaa", item_name: "صنف آخر تماماً", avg_cost: 10 }]);
  const result = sandbox.itemCostFor({ itemGuid: "bbbb", name: "صنف غير موجود إطلاقاً" });
  if (result !== null) {
    console.error('صنف بلا تطابق GUID أو اسم يجب أن يُرجع null ("غير متوفر")، لا قيمة مضلِّلة.');
    failed = true;
  }
}

// 4) عدم تجمّد القيمة: تحديث state.itemCosts (دفعة جديدة) ينعكس فوراً بلا كاش قديم
{
  const sandbox = run([{ item_guid: "guid-1", item_name: "مادة تجريبية", avg_cost: 5 }]);
  const before = sandbox.itemCostFor({ itemGuid: "guid-1", name: "مادة تجريبية" });
  // محاكاة دفعة تحديث جديدة من push-item-costs.ps1: مصفوفة جديدة (مرجع مختلف) بقيمة أحدث
  sandbox.state.itemCosts = [{ item_guid: "guid-1", item_name: "مادة تجريبية", avg_cost: 8.5 }];
  const after = sandbox.itemCostFor({ itemGuid: "guid-1", name: "مادة تجريبية" });
  if (before?.avg_cost !== 5 || after?.avg_cost !== 8.5) {
    console.error("تحديث state.itemCosts يجب أن ينعكس فوراً في itemCostFor() دون تجمّد على القيمة القديمة (تحقق من _costIndexRef).");
    failed = true;
  }
}

// 5) صاحب الحساب فقط يرى التكلفة (is_owner) — لا تسريب لغير المالك
{
  const sandbox = run([{ item_guid: "guid-2", item_name: "مادة اخرى", avg_cost: 7 }]);
  sandbox.isOwner = () => false;
  const result = sandbox.itemCostFor({ itemGuid: "guid-2", name: "مادة اخرى" });
  if (result !== null) {
    console.error("itemCostFor() يجب أن يُرجع null دائماً لغير المالك (isOwner() === false).");
    failed = true;
  }
}

if (failed) {
  process.exit(1);
} else {
  console.log("check-item-cost-matching: OK — مطابقة متوسط التكلفة بـGUID أولاً، رجوع آمن بالاسم، لا تجمّد، لا تسريب لغير المالك.");
}
