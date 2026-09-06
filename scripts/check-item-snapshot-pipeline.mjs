import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildItemSnapshot, getSalesWindow, parseQuantity } from './item-snapshot-pipeline.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generatedAt = '2026-08-17T02:05:00.000Z';
const baseRow = (key, name = key) => ({
  id: `00000000-0000-4000-8000-${key.padStart(12, '0').slice(-12)}`,
  item_key: key, item_guid: key, item_name: name, units_sold_30d: 0,
  movement_rank: 1, generated_at: '2026-08-07T04:05:10.637Z',
});
const sale = (key, qty, saleDate = '2026-08-17', billType = 'retail') => ({
  item_key: key, item_name: key, qty, sale_date: saleDate, bill_type: billType,
  unit2_name: 'box', unit2_factor: 10,
});
const build = (overrides = {}) => buildItemSnapshot({
  currentSnapshot: [baseRow('1'), baseRow('2')], itemCosts: [], salesLineItems: [],
  windowEnd: '2026-08-17', generatedAt, ...overrides,
});

assert.deepEqual(getSalesWindow('2026-08-17', 30), { start: '2026-07-18', end: '2026-08-17' });
assert.equal(parseQuantity('1.125'), 1125n);
assert.equal(parseQuantity('-0.5'), -500n);
assert.throws(() => parseQuantity('1.0001'), /three decimal/);

// 2026-09-06: قيم تصل كأرقام JS ناتجة عن حساب عائم (ضجيج تمثيل الفاصلة العائمة)
// يجب أن تُطبَّع لأقرب ثلاث منازل وتُقبل، لا أن تُرفض بوصفها دقة تجارية زائدة.
assert.equal(parseQuantity(2.4000000000000004), 2400n);
assert.equal(parseQuantity(1.2340000000000002), 1234n);
assert.equal(parseQuantity('2.4000000000000004'), 2400n);
// لكن دقة تجارية حقيقية تتجاوز ثلاث منازل تبقى مرفوضة كما هي.
assert.throws(() => parseQuantity(1.2345), /three decimal/);
assert.throws(() => parseQuantity('1.2345'), /three decimal/);
// NaN / Infinity تبقى مرفوضة بوضوح ولا تُطبَّع أبداً.
assert.throws(() => parseQuantity(NaN), /three decimal/);
assert.throws(() => parseQuantity(Infinity), /three decimal/);
assert.throws(() => parseQuantity(-Infinity), /three decimal/);

const aggregation = build({ salesLineItems: [
  sale('1', '1', '2026-07-18'), sale('1', '2.5'), sale('1', '2.5'),
  sale('1', '99', '2026-07-17'), sale('2', '8', '2026-08-17', 'wholesale'),
] });
assert.equal(aggregation.rows.find((row) => row.item_key === '1').units_sold_30d, 6);
assert.equal(aggregation.rows.find((row) => row.item_key === '2').units_sold_30d, 8);
assert.equal(aggregation.rows.find((row) => row.item_key === '2').movement_rank, 1);
assert.equal(aggregation.rows.find((row) => row.item_key === '1').movement_rank, 2);

const returns = build({ salesLineItems: [sale('1', '10'), sale('1', '-3')] });
assert.equal(returns.rows.find((row) => row.item_key === '1').units_sold_30d, 7);
assert.throws(() => build({ salesLineItems: [sale('1', '1', '2026-08-17', 'return')] }), /unsupported bill_type/);
assert.throws(() => build({ salesLineItems: [sale('1', '-1')] }), /negative 30-day net/);

const emptySales = build();
assert.equal(emptySales.rows.length, 2);
assert.ok(emptySales.rows.every((row) => row.units_sold_30d === 0));
assert.ok(emptySales.rows.every((row) => row.movement_rank === 1));
assert.deepEqual(new Set(emptySales.rows.map((row) => row.generated_at)), new Set([generatedAt]));

const newItem = build({
  itemCosts: [{ item_guid: '3', item_name: 'new item', avg_cost: 4, currency: 'USD', updated_at: generatedAt }],
  salesLineItems: [sale('3', '2')],
});
assert.equal(newItem.rows.length, 3);
assert.equal(newItem.rows.find((row) => row.item_key === '3').average_cost, 4);
assert.equal(new Set(newItem.rows.map((row) => row.item_key)).size, newItem.rows.length);
assert.throws(() => build({ currentSnapshot: [baseRow('1'), baseRow('1')] }), /duplicate current snapshot/);

// --- item_guid vs match_key: item_costs بلا GUID أمين حقيقي (push-item-costs.ps1 لا يفبرك GUID) ---

// مادة تكلفة بلا item_guid وبلا بيع مطابق: match_key يُستخدم للتجميع فقط، ولا يُكتب أبداً في item_guid.
const costOnlyNoGuid = build({
  itemCosts: [{ match_key: 'CODE-99', item_guid: null, item_name: 'مادة بلا GUID', avg_cost: 7, currency: 'USD', updated_at: generatedAt }],
});
const costOnlyRow = costOnlyNoGuid.rows.find((row) => row.item_key === 'CODE-99');
assert.ok(costOnlyRow, 'match_key يجب أن يُستخدم كمفتاح احتياطي عند غياب item_guid');
assert.equal(costOnlyRow.item_guid, null, 'item_guid يجب أن يبقى null إن لم يوجد GUID أمين حقيقي — لا يُكتب match_key فيه');
assert.equal(costOnlyRow.average_cost, 7);

// مادة تكلفة بلا item_guid لكن يوجد بيع بنفس المفتاح: sale.item_key دائماً GUID حقيقي فتُقبل كـitem_guid.
const costWithMatchingSale = build({
  itemCosts: [{ match_key: 'GUID-FROM-SALE', item_guid: null, item_name: 'مادة ببيع مطابق', avg_cost: 3, currency: 'USD', updated_at: generatedAt }],
  salesLineItems: [sale('GUID-FROM-SALE', '1')],
});
const withSaleRow = costWithMatchingSale.rows.find((row) => row.item_key === 'GUID-FROM-SALE');
assert.equal(withSaleRow.item_guid, 'GUID-FROM-SALE', 'وجود بيع لنفس المفتاح يعني أنه GUID حقيقي (push-sales-line-items.ps1 يرسل MatGUID فقط)');

// مادة تكلفة تحمل item_guid حقيقياً: يُكتب مباشرة بصرف النظر عن match_key.
const costWithRealGuid = build({
  itemCosts: [{ match_key: 'CODE-77', item_guid: 'real-guid-123', item_name: 'مادة بGUID حقيقي', avg_cost: 5, currency: 'USD', updated_at: generatedAt }],
});
const realGuidRow = costWithRealGuid.rows.find((row) => row.item_key === 'real-guid-123');
assert.ok(realGuidRow, 'item_guid الحقيقي في item_costs يجب أن يُستخدم كمفتاح تجميع مباشرة');
assert.equal(realGuidRow.item_guid, 'real-guid-123');

// item_costs بلا match_key وبلا item_guid يجب أن يُسقط الـsnapshot بخطأ واضح (لا مفتاح صالح إطلاقاً).
assert.throws(
  () => build({ itemCosts: [{ item_guid: null, item_name: 'بلا أي مفتاح', avg_cost: 1, updated_at: generatedAt }] }),
  /item_costs\.match_key is required/,
);

const [wrapper, producer, registration, sql] = await Promise.all([
  readFile(path.join(repoRoot, 'tools', 'push-purchase-item-snapshot.ps1'), 'utf8'),
  readFile(path.join(repoRoot, 'scripts', 'refresh-ameen-item-snapshot.mjs'), 'utf8'),
  readFile(path.join(repoRoot, 'tools', 'register-purchase-item-snapshot-task.ps1'), 'utf8'),
  readFile(path.join(repoRoot, 'supabase', 'ameen-item-snapshot-refresh.sql'), 'utf8'),
]);
for (const source of [wrapper, producer]) {
  assert.doesNotMatch(source, /AMEEN_SQL_CONNECTION_STRING|SqlConnection|System\.Data\.SqlClient|\bdbo\./i);
  assert.doesNotMatch(source, /service[_-]?role/i);
}
assert.match(wrapper, /\[switch\]\$Apply/);
assert.match(producer, /if \(!apply\)/);
assert.match(producer, /const PUBLIC_PROFILE = 'public'/);
assert.match(producer, /'Accept-Profile': PUBLIC_PROFILE/);
assert.match(producer, /'Content-Profile': PUBLIC_PROFILE/);
assert.match(producer, /readAll\('ameen_item_snapshot'/);
assert.match(producer, /readAll\('item_costs'/);
// buildItemSnapshot يتطلب match_key كمفتاح احتياطي لمواد item_costs بلا GUID حقيقي — لو سقط من الـselect
// هنا فسيسقط تحديث الـsnapshot بالكامل بخطأ "item_costs.match_key is required" عند أول مادة بلا GUID.
assert.match(producer, /readAll\('item_costs',\s*'[^']*\bmatch_key\b[^']*'/);
assert.match(producer, /readAll\('sales_line_items'/);
assert.match(producer, /publicRestHeaders\(headers, \{ write: true \}\)/);
assert.doesNotMatch(producer, /Accept-Profile['"]?\s*:\s*['"]api['"]/i);
assert.doesNotMatch(producer, /Content-Profile['"]?\s*:\s*['"]api['"]/i);
assert.match(registration, /New-ScheduledTaskTrigger -Daily/);
// 2026-09-06: كان المشغّل يومياً واحداً عند 05:05، فأي رفض من بوابة حداثة
// المبيعات (نافذتها 75 دقيقة) كان يجمّد اللقطة 24 ساعة كاملة — وهو ما جمّدها
// ستة أيام فعلياً. التكرار الساعي شرط عقدي الآن، لا تفصيلاً تشغيلياً.
assert.match(registration, /RepetitionInterval/);
assert.match(registration, /\$IntervalHours/);
assert.doesNotMatch(registration, /\$DailyAt/);
assert.match(registration, /MultipleInstances IgnoreNew/);
assert.doesNotMatch(registration, /Start-ScheduledTask/);
assert.match(sql, /security invoker/i);
assert.match(sql, /create temporary table[\s\S]+delete from public\.ameen_item_snapshot[\s\S]+insert into public\.ameen_item_snapshot/i);

console.log('Item snapshot pipeline contract checks passed.');
