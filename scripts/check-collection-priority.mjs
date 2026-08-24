import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../src/command-center.js", import.meta.url), "utf8");
const testConsole = { ...console, warn: () => {}, error: () => {} };

// --- Forbidden-wording / safe-wording static contract (source-level, D/L/M support) ---
// Strip "//" comment lines first: forbidden words are allowed to appear inside a comment
// that *documents* the ban (as this file itself does); they must never appear in actual
// code/string-literal output.
const codeOnly = source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
for (const forbidden of ["متأخر عن الدفع", "مستحق اليوم", "وعد بالدفع"]) {
  if (codeOnly.includes(forbidden)) throw new Error(`TEST D: forbidden fabricated wording "${forbidden}" must not appear in command-center.js output code`);
}
// "متأخر" alone (without "عن الدفع") must also not appear anywhere in the collections code path.
if (/متأخر/.test(codeOnly)) throw new Error('TEST D: forbidden fabricated wording "متأخر" must not appear in command-center.js output code');
if (!source.includes("بلا حد ائتمان معتمد")) throw new Error("TEST M: safe wording for customers without an approved credit limit is missing");
if (!source.includes("hasLastPayment")) throw new Error("TEST L: last-payment display must be gated on an explicit existence check");

function defaultSnapshot(receivables) {
  return {
    receivables,
    collections: { todayTotal: null, currency: "USD" },
    inventory: {
      urgentReorderCount: 0, outOfStockCount: 0, lowCoverCount: 0, itemCount: 0,
      stockTrusted: true, meta: { source: "test" },
      purchaseRecommendations: { items: [], settingsApproved: true }
    },
    supplierObligations: { supplierCount: 0 },
    syncHealth: { staleCount: 0, missingCount: 0 },
    dataQuality: { degraded: false }
  };
}
function defaultMetrics() { return { overall: { level: "stable", riskScore: 0, confidenceScore: 100 }, collectionPressure: 0, creditRisk: 0 }; }
function defaultBrief() { return { headline: "اختبار", executiveOrder: [], agents: {} }; }

function debtor({ key, name, balance, creditLimit = 0, creditLimitSource = "missing", ratio = null, isSupplier = false, lastPaymentDate = null, lastPaymentAmount = null, currency = "USD" }) {
  return { key, name, balance, creditLimit, creditLimitSource, ratio, level: "normal", isSupplier, lastPaymentDate, lastPaymentAmount, currency };
}
function receivablesFixture(debtors, { freshnessState = "fresh", completeness = "complete" } = {}) {
  return {
    total: debtors.reduce((s, r) => s + r.balance, 0),
    debtorCount: debtors.length,
    overLimitCount: debtors.filter((r) => r.ratio !== null && r.ratio >= 1).length,
    nearLimitCount: debtors.filter((r) => r.ratio !== null && r.ratio >= 0.9 && r.ratio < 1).length,
    topRisks: debtors.slice(0, 10),
    debtors,
    meta: { source: "test", asOf: new Date().toISOString(), completeness, note: "", freshness: { state: freshnessState, ageMinutes: 0, stale: freshnessState !== "fresh" } }
  };
}

async function runCollections(receivables, opts = {}) {
  const routes = new Set();
  const evtApp = { innerHTML: "", querySelectorAll: () => [], querySelector: () => null };
  const evtDoc = { querySelector: () => null, querySelectorAll: () => [], createElement: (tag) => ({ tagName: String(tag).toUpperCase(), dataset: {}, addEventListener: () => {} }) };
  const snap = defaultSnapshot(receivables);
  const metricsFixture = opts.metrics || defaultMetrics();
  const briefFixture = opts.brief || defaultBrief();
  const evtWin = {
    location: { search: "" }, addEventListener: () => {}, ozkCanAccessRoute: () => true,
    ozkBusinessOS: { getSnapshot: async () => snap },
    ozkBusinessMetrics: { getMetrics: async () => metricsFixture },
    ozkExecutiveTeam: { buildBrief: () => briefFixture }
  };
  const evtCtx = { console: testConsole, Date, Math, Number, String, Array, Object, Promise, URLSearchParams, setTimeout: () => 0, setInterval: () => 0, clearInterval: () => {}, window: evtWin, document: evtDoc, allowedRoutes: routes, state: { route: "command", session: { id: "collections-test" } }, app: evtApp, shell: (x) => x, render: () => {}, setRoute: () => {} };
  evtCtx.globalThis = evtCtx; vm.createContext(evtCtx); vm.runInContext(source, evtCtx, { filename: "command-center.js" });
  await evtWin.ozkCommandCenter.refresh();
  const result = evtWin.ozkCommandCenter.answerQuestion("collections");
  return { win: evtWin, result };
}

// TEST A: exceeded-limit customer appears first, even when a larger-balance non-breaching debtor exists.
{
  const tier1 = debtor({ key: "c1", name: "زبون متجاوز", balance: 5000, creditLimit: 4000, creditLimitSource: "approved", ratio: 1.25 });
  const tier3 = debtor({ key: "c2", name: "زبون رصيد كبير بلا حد", balance: 50000, creditLimitSource: "missing", ratio: null });
  const { result } = await runCollections(receivablesFixture([tier3, tier1]));
  if (!result?.items?.length || result.items[0].collectionAccount.row.key !== "c1") throw new Error("TEST A: exceeded-limit customer must appear first");
  if (result.items[0].collectionAccount.reason !== "متجاوز حد الائتمان المعتمد") throw new Error("TEST A: exceeded-limit reason text mismatch");
}

// TEST B: near-limit customer follows the exceeded-limit customer.
{
  const tier1 = debtor({ key: "c1", name: "متجاوز", balance: 5000, creditLimit: 4000, creditLimitSource: "approved", ratio: 1.25 });
  const tier2 = debtor({ key: "c2", name: "قريب من الحد", balance: 950, creditLimit: 1000, creditLimitSource: "approved", ratio: 0.95 });
  const tier3 = debtor({ key: "c3", name: "رصيد عادي", balance: 100, creditLimitSource: "missing" });
  const { result } = await runCollections(receivablesFixture([tier3, tier2, tier1]));
  const keys = result.items.map((i) => i.collectionAccount.row.key);
  if (keys[0] !== "c1" || keys[1] !== "c2") throw new Error(`TEST B: expected order [c1,c2,...], got ${keys.join(",")}`);
  if (result.items[1].collectionAccount.reason !== "قريب من حد الائتمان المعتمد") throw new Error("TEST B: near-limit reason text mismatch");
}

// TEST C: no approved credit limit -> never labeled "exceeded", even if an Ameen-sourced limit ratio is >= 1.
{
  const ameenSourced = debtor({ key: "c1", name: "بلا حد معتمد", balance: 1000, creditLimit: 500, creditLimitSource: "ameen", ratio: 2 });
  const { result } = await runCollections(receivablesFixture([ameenSourced]));
  const entry = result.items.find((i) => i.collectionAccount.row.key === "c1");
  if (!entry) throw new Error("TEST C: setup failed, debtor missing from shortlist");
  if (entry.collectionAccount.reason === "متجاوز حد الائتمان المعتمد") throw new Error("TEST C: a non-approved credit limit must never be labeled as exceeded");
  if (entry.collectionAccount.tier !== 3) throw new Error("TEST C: a non-approved credit limit must fall into tier 3");
}

// TEST D: no fabricated overdue/due-date claim anywhere in the output code (static contract, asserted above at load time).
{
  if (/متأخر|مستحق اليوم|وعد بالدفع/.test(codeOnly)) throw new Error("TEST D: forbidden fabricated wording detected");
}

// TEST E: currency handling preserved per customer.
{
  const syp = debtor({ key: "c1", name: "زبون ليرة", balance: 100000, creditLimitSource: "missing", currency: "SYP" });
  const usd = debtor({ key: "c2", name: "زبون دولار", balance: 500, creditLimitSource: "missing", currency: "USD" });
  const { result } = await runCollections(receivablesFixture([syp, usd]));
  const sypEntry = result.items.find((i) => i.collectionAccount.row.key === "c1");
  const usdEntry = result.items.find((i) => i.collectionAccount.row.key === "c2");
  if (sypEntry?.collectionAccount.row.currency !== "SYP") throw new Error("TEST E: SYP currency must be preserved on the customer row");
  if (usdEntry?.collectionAccount.row.currency !== "USD") throw new Error("TEST E: USD currency must be preserved on the customer row");
}

// TEST F: no duplicate customers in the shortlist even if the source data has a duplicate key.
{
  const dupe1 = debtor({ key: "c1", name: "مكرر", balance: 900, creditLimitSource: "missing" });
  const dupe2 = debtor({ key: "c1", name: "مكرر", balance: 900, creditLimitSource: "missing" });
  const { result } = await runCollections(receivablesFixture([dupe1, dupe2]));
  const count = result.items.filter((i) => i.collectionAccount.row.key === "c1").length;
  if (count !== 1) throw new Error(`TEST F: duplicate customer key must appear at most once, got ${count}`);
}

// TEST G: stale/untrusted receivables -> no confident shortlist is shown.
{
  const row = debtor({ key: "c1", name: "زبون", balance: 5000, creditLimit: 4000, creditLimitSource: "approved", ratio: 1.5 });
  const { result } = await runCollections(receivablesFixture([row], { freshnessState: "stale" }));
  if (result.items.length !== 0) throw new Error("TEST G: stale receivables must not produce a shortlist");
  if (!/غير حديثة/.test(result.body)) throw new Error("TEST G: stale state must be communicated truthfully in the answer body");
}

// TEST H: zero debtors -> truthful empty state.
{
  const { result } = await runCollections(receivablesFixture([]));
  if (result.items.length !== 0) throw new Error("TEST H: zero debtors must produce zero shortlist items");
  if (result.body !== "ما في أرصدة مدينة تحتاج متابعة حالياً.") throw new Error(`TEST H: unexpected empty-state body: ${result.body}`);
}

// TEST I: aggregate alert score below 20 (collectionPressure/creditRisk) must NOT suppress the shortlist.
{
  const row = debtor({ key: "c1", name: "زبون", balance: 5000, creditLimit: 4000, creditLimitSource: "approved", ratio: 1.5 });
  const { result } = await runCollections(receivablesFixture([row]), { metrics: { overall: { level: "stable", riskScore: 5, confidenceScore: 100 }, collectionPressure: 5, creditRisk: 5 } });
  if (result.items.length === 0) throw new Error("TEST I: a low aggregate alert score must not suppress an operational collection shortlist");
}

// TEST J: the other three Command Center questions remain governed by their own unchanged logic/thresholds.
{
  const brief = { headline: "خلاصة", executiveOrder: [{ agent: "sales", title: "أولوية", why: "سبب", action: "إجراء", severity: 50, route: "overview" }], agents: { sales: { icon: "💰", name: "المبيعات", id: "sales" } } };
  const row = debtor({ key: "c1", name: "زبون", balance: 5000, creditLimit: 4000, creditLimitSource: "approved", ratio: 1.5 });
  const { win } = await runCollections(receivablesFixture([row]), { brief });
  const today = win.ozkCommandCenter.answerQuestion("today");
  const risk = win.ozkCommandCenter.answerQuestion("risk");
  const buy = win.ozkCommandCenter.answerQuestion("buy");
  if (today.title !== "شو أعمل اليوم؟") throw new Error("TEST J: 'شو أعمل اليوم؟' title changed");
  if (risk.title !== "وين أكبر خطر؟") throw new Error("TEST J: 'وين أكبر خطر؟' title changed");
  if (buy.title !== "شو لازم أشتري؟") throw new Error("TEST J: 'شو لازم أشتري؟' title changed");
  if (today.items.some((i) => i.collectionAccount) || risk.items.some((i) => i.collectionAccount) || buy.items.some((i) => i.collectionAccount)) {
    throw new Error("TEST J: the other three questions must not be contaminated by the collections shortlist shape");
  }
}

// TEST K: isSupplier=true records are excluded, never appear regardless of balance/ratio.
{
  const supplier = debtor({ key: "s1", name: "مورد", balance: 999999, creditLimitSource: "missing", isSupplier: true });
  const customer = debtor({ key: "c1", name: "زبون حقيقي", balance: 100, creditLimitSource: "missing" });
  const { result } = await runCollections(receivablesFixture([supplier, customer]));
  if (result.items.some((i) => i.collectionAccount.row.isSupplier)) throw new Error("TEST K: supplier-labelled records must never appear in the collection shortlist");
  if (!result.items.some((i) => i.collectionAccount.row.key === "c1")) throw new Error("TEST K: genuine customer must still appear after excluding the supplier");
}

// TEST L: last-payment fields present on the row only when they actually exist in the data.
{
  const withPayment = debtor({ key: "c1", name: "له دفعة", balance: 100, creditLimitSource: "missing", lastPaymentDate: "2026-08-01T00:00:00Z", lastPaymentAmount: 50 });
  const withoutPayment = debtor({ key: "c2", name: "بدون دفعة", balance: 100, creditLimitSource: "missing" });
  const { result } = await runCollections(receivablesFixture([withPayment, withoutPayment]));
  const withEntry = result.items.find((i) => i.collectionAccount.row.key === "c1");
  const withoutEntry = result.items.find((i) => i.collectionAccount.row.key === "c2");
  if (!withEntry.collectionAccount.row.lastPaymentDate) throw new Error("TEST L: existing last-payment data must be preserved on the row");
  if (withoutEntry.collectionAccount.row.lastPaymentDate || withoutEntry.collectionAccount.row.lastPaymentAmount !== null) throw new Error("TEST L: absent last-payment data must not be fabricated");
}

// TEST M: customers without an approved credit limit use safe wording, never "exceeded"/"near-limit".
{
  const row = debtor({ key: "c1", name: "بلا حد", balance: 900, creditLimitSource: "missing", ratio: null });
  const { result } = await runCollections(receivablesFixture([row]));
  const entry = result.items.find((i) => i.collectionAccount.row.key === "c1");
  if (entry.collectionAccount.reason !== "من أعلى الأرصدة المدينة للمراجعة") throw new Error("TEST M: customer without an approved credit limit must use the safe tier-3 wording");
}

console.log("OZK Collection Priority contract: OK");
