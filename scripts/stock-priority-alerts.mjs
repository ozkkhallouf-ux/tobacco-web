#!/usr/bin/env node
// ============================================================================
// تنبيهات النفاد حسب أولوية المبيعات — المُشغِّل (.github/workflows/stock-priority-alerts.yml).
//
// يقرأ من Supabase فقط: آخر تقرير مخزون (ameen_sql_agent)، وآخر تقرير فواتير
// (ameen_customer_invoices)، وbot_config.low_stock_threshold. يحسب بـ
// src/stock-alert-priority.js (منطق نقي)، ثم يضع الرسائل في telegram_outbox عبر
// notify_telegram — ومنع التكرار (dedupe_key + نافذة الدقائق) هناك.
//
// لا يقرأ الأمين ولا يكتب فيه، ولا يكتب على أي جدول غير telegram_outbox (عبر الدالة).
// بلا --send يعمل تجريبياً: يطبع أعداداً فقط (لا أسماء أصناف في سجل CI).
// ============================================================================
import "../src/stock-alert-priority.js";

const engine = globalThis.ozkStockAlertPriority;

function headers(serviceKey, profileHeader) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    Accept: "application/json",
    [profileHeader]: "public"
  };
}

async function getJson(fetchImpl, url, serviceKey) {
  const res = await fetchImpl(url, { headers: headers(serviceKey, "Accept-Profile") });
  if (!res.ok) throw new Error(`HTTP ${res.status} على ${url.split("?")[0]}`);
  return res.json();
}

async function latestReport(fetchImpl, base, serviceKey, source) {
  const url = `${base}/rest/v1/inventory_reports?source=eq.${encodeURIComponent(source)}`
    + "&select=source,report_date,created_at,summary,items&order=created_at.desc&limit=1";
  const rows = await getJson(fetchImpl, url, serviceKey);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function lowStockThreshold(fetchImpl, base, serviceKey) {
  const rows = await getJson(fetchImpl, `${base}/rest/v1/bot_config?key=eq.low_stock_threshold&select=value&limit=1`, serviceKey);
  const value = Array.isArray(rows) && rows.length ? Number(rows[0].value) : NaN;
  return Number.isFinite(value) ? value : 50;
}

async function enqueue(fetchImpl, base, serviceKey, message) {
  const res = await fetchImpl(`${base}/rest/v1/rpc/notify_telegram`, {
    method: "POST",
    headers: { ...headers(serviceKey, "Content-Profile"), "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({
      p_event_type: message.eventType,
      p_message: message.message,
      p_dedupe_key: message.dedupeKey,
      p_dedupe_minutes: message.cooldownMinutes
    })
  });
  if (!res.ok) throw new Error(`notify_telegram: HTTP ${res.status}`);
}

export async function run({ env = process.env, argv = process.argv.slice(2), fetchImpl = globalThis.fetch, now = new Date(), log = console.log } = {}) {
  const send = argv.includes("--send");
  const base = String(env.SUPABASE_URL || "").replace(/\/+$/, "");
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!base || !serviceKey) throw new Error("SUPABASE_URL أو SUPABASE_SERVICE_ROLE_KEY غير مضبوط.");

  const [stockReport, invoicesReport, threshold] = await Promise.all([
    latestReport(fetchImpl, base, serviceKey, engine.CONFIG.stockSource),
    latestReport(fetchImpl, base, serviceKey, engine.CONFIG.invoicesSource),
    lowStockThreshold(fetchImpl, base, serviceKey)
  ]);
  const result = engine.buildStockAlerts({ stockReport, invoicesReport, now, lowStockThreshold: threshold });

  log(`الحالة: ${result.status} | أصناف مباعة: ${result.priority?.soldCount ?? "-"} | مؤهلة: ${result.priority?.eligible?.length ?? "-"}`
    + ` | تنبيهات: ${result.alerts.length} | رسائل: ${result.messages.length}`
    + (result.problems.length ? ` | مشاكل: ${result.problems.map((p) => `${p.kind}:${p.code}`).join(",")}` : "")
    + (result.warnings.length ? ` | تحذيرات: ${result.warnings.join(",")}` : ""));

  if (!send) {
    log("وضع تجريبي (بلا --send): لم يُرسل شيء.");
    return { result, sent: 0 };
  }
  for (const message of result.messages) await enqueue(fetchImpl, base, serviceKey, message);
  log(`أُرسلت ${result.messages.length} رسالة إلى notify_telegram (منع التكرار داخل الدالة).`);
  return { result, sent: result.messages.length };
}

const invokedDirectly = process.argv[1] && new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;
if (invokedDirectly) {
  run().catch((error) => {
    console.error(`فشل: ${error.message}`);
    process.exit(1);
  });
}
