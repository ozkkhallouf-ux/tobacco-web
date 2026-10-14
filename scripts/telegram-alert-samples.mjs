#!/usr/bin/env node
// ============================================================================
// أمثلة رسائل تنبيه النفاد من بيانات مصطنعة بالكامل (لا بيانات إنتاج، لا شبكة،
// لا إرسال). يطبع نص الرسائل كما سيدخل notify_telegram، للمراجعة البصرية.
//   node scripts/telegram-alert-samples.mjs            ← سيناريو قصير
//   node scripts/telegram-alert-samples.mjs --long     ← سيناريو يُقسَّم لعدة رسائل
//   node scripts/telegram-alert-samples.mjs --stale    ← رسالة التقادم
// ============================================================================
import "../src/telegram-format.js";
import "../src/stock-alert-priority.js";

const engine = globalThis.ozkStockAlertPriority;
const NOW = new Date("2026-10-03T09:00:00.000Z");
const at = (minutesAgo) => new Date(NOW.getTime() - minutesAgo * 60000).toISOString();
const guid = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

// أسماء مصطنعة تغطي العربي واللاتيني المختلط والأرقام وأحرف HTML.
const NAMES = [
  "Marlboro Gold 20s",
  "ونستون أزرق — 100mm",
  "كليوباترا <سوبر> & كينغ",
  "Gauloises Blondes Rouge",
  "معسل نخلة تفاحتين 250غ",
  "L&M Red Label (KS)"
];

export function sampleInput({ long = false, stale = false } = {}) {
  const count = long ? 80 : NAMES.length;
  const names = Array.from({ length: count }, (_, i) => NAMES[i % NAMES.length] + (i >= NAMES.length ? ` #${i + 1}` : ""));
  const sales = names.map((name, i) => ({
    itemGuid: guid(i + 1), name, unit1Name: "كروز", unit2Name: "كرتونة", unit2Factor: i % 3 === 0 ? 10 : 50,
    saleQty: 900 - i * 10, returnQty: 0, saleInvoiceCount: 6, returnInvoiceCount: 0
  }));
  // نافد، سالب، قريب، كمية صغيرة، وبقية مريحة (لا تُنبَّه)
  const stockQty = (i) => (long ? [0, -5, 40, 12, 0, 25][i % 6] : [0, 40, -5, 12, 5000, 25][i]);
  return {
    stockReport: {
      source: "ameen_sql_agent", report_date: "2026-10-03", created_at: at(stale ? 30 : 3), summary: { syncedAt: at(stale ? 30 : 3) },
      items: names.map((name, i) => ({ itemGuid: guid(i + 1), name, stockQty: stockQty(i), unit2Factor: sales[i].unit2Factor, unit1Name: "كروز", unit2Name: "كرتونة" }))
    },
    salesReport: {
      source: "ameen_item_sales", report_date: "2026-10-03", created_at: at(20),
      summary: { payloadVersion: 1, windowDays: 30, fromDate: "2026-09-04", toDate: "2026-10-03", includesAnonymous: true, syncedAt: at(20) },
      items: sales
    },
    now: NOW,
    lowStockThreshold: 50
  };
}

const invokedDirectly = process.argv[1] && new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const result = engine.buildStockAlerts(sampleInput({ long: args.includes("--long"), stale: args.includes("--stale") }));
  result.messages.forEach((m, i) => {
    console.log(`===== رسالة ${i + 1}/${result.messages.length} — ${m.message.length} حرف — ${m.dedupeKey} =====`);
    console.log(m.message);
  });
}
