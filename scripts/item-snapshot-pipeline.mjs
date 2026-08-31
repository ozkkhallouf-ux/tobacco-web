const SCALE = 1000n;

export const SNAPSHOT_FIELDS = [
  'id', 'item_key', 'item_guid', 'item_number', 'item_name', 'unit1_name',
  'unit2_name', 'unit2_factor', 'stock_unit1', 'stock_unit2',
  'last_purchase_price', 'last_purchase_currency', 'last_purchase_date',
  'last_purchase_unit', 'average_cost', 'average_cost_currency',
  'average_cost_basis', 'last_supplier_name', 'last_supplier_guid',
  'units_sold_30d', 'movement_rank', 'generated_at',
];

export const SUPPORTED_BILL_TYPES = new Set(['retail', 'wholesale']);

function requiredKey(value, label = 'item_key') {
  const key = String(value ?? '').trim();
  if (!key) throw new Error(`${label} is required`);
  return key;
}

function dateOnly(value, label) {
  const text = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`${label} must use YYYY-MM-DD`);
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new Error(`${label} is not a valid date`);
  }
  return text;
}

export function getSalesWindow(windowEnd, lookbackDays = 30) {
  const end = dateOnly(windowEnd, 'windowEnd');
  if (!Number.isInteger(lookbackDays) || lookbackDays < 1) {
    throw new Error('lookbackDays must be a positive integer');
  }
  const start = new Date(`${end}T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() - lookbackDays);
  return { start: start.toISOString().slice(0, 10), end };
}

export function parseQuantity(value) {
  const text = String(value ?? '').trim();
  const match = /^([+-]?)(\d+)(?:\.(\d{1,3}))?$/.exec(text);
  if (!match) throw new Error(`qty must have at most three decimal places: ${text || '<empty>'}`);
  const sign = match[1] === '-' ? -1n : 1n;
  const fraction = (match[3] ?? '').padEnd(3, '0');
  return sign * ((BigInt(match[2]) * SCALE) + BigInt(fraction || '0'));
}

function quantityNumber(value) {
  const absolute = value < 0n ? -value : value;
  if (absolute > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('qty total exceeds safe JSON precision');
  return Number(value) / Number(SCALE);
}

function newestByDate(current, candidate) {
  if (!current) return candidate;
  return String(candidate.sale_date) >= String(current.sale_date) ? candidate : current;
}

function copySnapshotRow(row) {
  const copied = {};
  for (const field of SNAPSHOT_FIELDS) copied[field] = row[field] ?? null;
  copied.item_key = requiredKey(row.item_key);
  copied.item_name = String(row.item_name ?? '').trim();
  return copied;
}

function newSnapshotRow(key, cost, sale) {
  const name = String(cost?.item_name ?? sale?.item_name ?? '').trim();
  if (!name) throw new Error(`item_name is unavailable for new item ${key}`);
  // item_guid يجب أن يبقى GUID الأمين الحقيقي فقط أو null — لا نكتب match_key هنا.
  // sale.item_key دائماً GUID حقيقي (CONVERT(nvarchar(36), bi.MatGUID) في push-sales-line-items.ps1)
  // فإن وُجد بيع لهذا المفتاح فـkey نفسه GUID حقيقي؛ خلاف ذلك نأخذ item_guid الحقيقي من التكلفة إن وُجد،
  // وإلا نترك null (يعني أن key هنا ليس أكثر من match_key احتياطي من item_costs).
  const guid = cost?.item_guid ? String(cost.item_guid).trim() : (sale ? key : null);
  return {
    id: globalThis.crypto.randomUUID(), item_key: key, item_guid: guid || null,
    item_number: null, item_name: name, unit1_name: '',
    unit2_name: String(sale?.unit2_name ?? ''), unit2_factor: sale?.unit2_factor ?? 1,
    stock_unit1: null, stock_unit2: null, last_purchase_price: null,
    last_purchase_currency: null, last_purchase_date: null, last_purchase_unit: null,
    average_cost: cost?.avg_cost ?? null, average_cost_currency: cost?.currency ?? null,
    average_cost_basis: cost ? 'item_costs' : '', last_supplier_name: null,
    last_supplier_guid: null, units_sold_30d: 0, movement_rank: null,
    generated_at: null,
  };
}

export function buildItemSnapshot({ currentSnapshot, itemCosts = [], salesLineItems,
  windowEnd, generatedAt, lookbackDays = 30 }) {
  if (!Array.isArray(currentSnapshot) || !Array.isArray(itemCosts) || !Array.isArray(salesLineItems)) {
    throw new Error('snapshot inputs must be arrays');
  }
  const window = getSalesWindow(windowEnd, lookbackDays);

  const costs = new Map();
  for (const cost of itemCosts) {
    // بعض مواد item_costs بلا GUID أمين حقيقي (item_guid = null) — هذا وضع طبيعي متوقّع
    // (push-item-costs.ps1 لا يفبرك GUID)، فلا يجوز أن يُسقط الـsnapshot كله بسببها.
    // نستخدم match_key (مضمون غير فارغ من push-item-costs.ps1) كمفتاح تجميع احتياطي فقط؛
    // لا يُكتب لاحقاً في item_guid إلا إذا كان GUID حقيقياً — انظر newSnapshotRow.
    const guid = String(cost.item_guid ?? '').trim();
    const key = guid || requiredKey(cost.match_key, 'item_costs.match_key');
    const previous = costs.get(key);
    if (!previous || String(cost.updated_at ?? '') >= String(previous.updated_at ?? '')) costs.set(key, cost);
  }

  const snapshot = new Map();
  for (const row of currentSnapshot) {
    const copied = copySnapshotRow(row);
    if (snapshot.has(copied.item_key)) throw new Error(`duplicate current snapshot item_key: ${copied.item_key}`);
    snapshot.set(copied.item_key, copied);
  }

  const totals = new Map();
  const latestSales = new Map();
  for (const sale of salesLineItems) {
    const saleDate = dateOnly(sale.sale_date, 'sales_line_items.sale_date');
    if (saleDate < window.start || saleDate > window.end) continue;
    const billType = String(sale.bill_type ?? '').trim().toLowerCase();
    if (!SUPPORTED_BILL_TYPES.has(billType)) {
      throw new Error(`unsupported bill_type in sales window: ${billType || '<empty>'}`);
    }
    const key = requiredKey(sale.item_key, 'sales_line_items.item_key');
    totals.set(key, (totals.get(key) ?? 0n) + parseQuantity(sale.qty));
    latestSales.set(key, newestByDate(latestSales.get(key), sale));
  }

  const masterKeys = new Set([...snapshot.keys(), ...costs.keys(), ...totals.keys()]);
  if (masterKeys.size === 0) throw new Error('refusing to build an empty snapshot');
  for (const key of masterKeys) {
    if (!snapshot.has(key)) snapshot.set(key, newSnapshotRow(key, costs.get(key), latestSales.get(key)));
  }
  for (const [key, total] of totals) {
    if (total < 0n) throw new Error(`negative 30-day net qty for ${key}`);
  }

  const distinctTotals = [...new Set([...snapshot.keys()].map((key) => String(totals.get(key) ?? 0n)))]
    .map(BigInt).sort((left, right) => (left === right ? 0 : left > right ? -1 : 1));
  const ranks = new Map(distinctTotals.map((total, index) => [String(total), index + 1]));
  const generated = new Date(generatedAt ?? new Date());
  if (!Number.isFinite(generated.getTime())) throw new Error('generatedAt must be a valid timestamp');
  const generatedIso = generated.toISOString();
  const rows = [...snapshot.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([key, row]) => {
      const total = totals.get(key) ?? 0n;
      return { ...row, units_sold_30d: quantityNumber(total),
        movement_rank: ranks.get(String(total)), generated_at: generatedIso };
    });

  const keys = new Set(rows.map((row) => row.item_key));
  if (keys.size !== rows.length) throw new Error('output contains duplicate item_key values');
  if (rows.length < currentSnapshot.length) throw new Error('output row count is smaller than current snapshot');
  for (const key of totals.keys()) {
    if (!keys.has(key)) throw new Error(`sales item_key missing from output: ${key}`);
  }
  return { rows, window, salesItemCount: totals.size, generatedAt: generatedIso };
}
