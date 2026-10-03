// ============================================================================
// stock-priority-alerts — تنبيه تيليغرام للأصناف المهمة حسب المبيعات التي قاربت النفاد.
//
// لا قاعدة تجارية هنا: المحرك نفسه src/stock-alert-priority.js (منسوخ بايتاً ببايت في
// ../_shared ويفرض تطابقه scripts/check-stock-alert-priority.mjs) يحسب الأولوية والأهلية
// والحداثة ونص الرسالة ومفتاح منع التكرار (buildStockAlerts). هذه الدالة تجلب المدخلات
// نفسها التي يجلبها scripts/stock-priority-alerts.mjs، وترسل عبر notify_telegram
// (→ telegram_outbox) ومنع التكرار هناك: نفس المجموعة لا تُرسل مرتين خلال 6 ساعات.
//
// تستدعيها pg_cron كل 15 دقيقة (public.dispatch_stock_priority_alerts) برأس
// X-OZK-Stock-Alert-Token مطابق لـapp_secrets.stock_priority_alert_token؛ غياب الرمز
// يجعل الجدولة عملية فارغة. الرد أعداد فقط بلا أسماء أصناف.
// لا وصول لقاعدة الأمين من هنا إطلاقاً، ولا كتابة إلا notify_telegram.
// ============================================================================
import "../_shared/stock-alert-priority.js";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

type StockMessage = { eventType: string; message: string; dedupeKey: string; cooldownMinutes: number };
type Engine = {
  CONFIG: { stockSource: string; salesSource: string };
  buildStockAlerts: (input: Record<string, unknown>) => {
    status: string;
    alerts: unknown[];
    messages: StockMessage[];
    problems: { kind: string; code: string }[];
    warnings: string[];
  };
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

// مقارنة بزمن ثابت كي لا يتسرّب الرمز حرفاً حرفاً عبر التوقيت.
function sameToken(supplied: string, expected: string) {
  if (!supplied || !expected || supplied.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= supplied.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(req: Request) {
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

    const url = Deno.env.get("SUPABASE_URL") || "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!url || !serviceKey) return json({ error: "server_not_configured" }, 500);
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

    const { data: secret, error: secretError } = await admin
      .from("app_secrets").select("value").eq("name", "stock_priority_alert_token").maybeSingle();
    if (secretError) return json({ error: "secret_unavailable" }, 500);
    if (!sameToken(req.headers.get("x-ozk-stock-alert-token") || "", String(secret?.value || ""))) {
      return json({ error: "unauthorized" }, 401);
    }

    const engine = (globalThis as unknown as { ozkStockAlertPriority?: Engine }).ozkStockAlertPriority;
    if (!engine?.buildStockAlerts) return json({ error: "engine_unavailable" }, 500);

    // آخر تقرير لكل مصدر — نفس استعلام scripts/stock-priority-alerts.mjs.
    const latestReport = async (source: string) => {
      const { data, error } = await admin
        .from("inventory_reports")
        .select("source, report_date, created_at, summary, items")
        .eq("source", source)
        .order("created_at", { ascending: false })
        .limit(1);
      if (error) throw new Error(`report_${source}_failed`);
      return (data && data[0]) || null;
    };
    const lowStockThreshold = async () => {
      const { data, error } = await admin.from("bot_config").select("value").eq("key", "low_stock_threshold").limit(1);
      if (error) throw new Error("threshold_failed");
      const value = data && data.length ? Number(data[0].value) : NaN;
      return Number.isFinite(value) ? value : 50;
    };

    let result: ReturnType<Engine["buildStockAlerts"]>;
    try {
      const [stockReport, salesReport, threshold] = await Promise.all([
        latestReport(engine.CONFIG.stockSource),
        latestReport(engine.CONFIG.salesSource),
        lowStockThreshold()
      ]);
      result = engine.buildStockAlerts({ stockReport, salesReport, now: new Date(), lowStockThreshold: threshold });
    } catch (error) {
      return json({ error: String((error as Error)?.message || "build_failed") }, 500);
    }

    let enqueued = 0;
    for (const message of result.messages) {
      const { error } = await admin.rpc("notify_telegram", {
        p_event_type: message.eventType,
        p_message: message.message,
        p_dedupe_key: message.dedupeKey,
        p_dedupe_minutes: message.cooldownMinutes
      });
      if (error) return json({ error: "notify_failed", status: result.status, enqueued }, 500);
      enqueued += 1;
    }
    return json({
      status: result.status,
      alerts: result.alerts.length,
      messages: result.messages.length,
      enqueued,
      problems: result.problems.map((p) => `${p.kind}:${p.code}`),
      warnings: result.warnings
    });
  },
};
