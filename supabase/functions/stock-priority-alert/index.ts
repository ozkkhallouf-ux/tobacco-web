// ============================================================================
// stock-priority-alert — تنبيه النفاد حسب أولوية المبيعات، مجدول بـpg_cron كل 15 دقيقة.
//
// بديل جدولة GitHub Actions (cron الـworkflow غير مضمون: شغّل مرة واحدة في 6 ساعات
// يوم 2026-10-03). لا قاعدة هنا: المحرك نفسه src/stock-alert-priority.js، منسوخ بايتاً
// ببايت في ../_shared ويفرض تطابقه scripts/check-stock-alert-priority.mjs. الحساب
// والرسالة ومفتاح منع التكرار (6 ساعات) كلها من buildStockAlerts كما في
// scripts/stock-priority-alerts.mjs؛ والإرسال عبر notify_telegram (→ telegram_outbox).
//
// تستدعيها pg_cron (public.dispatch_stock_priority_alert) برأس
// X-OZK-Stock-Alert-Token مطابق لـapp_secrets.stock_priority_alert_token.
// جسم {"dryRun": true} يحسب ويُرجع الأعداد فقط بلا إرسال (للتحقق اليدوي).
// لا وصول لقاعدة الأمين: المصادر تقارير Supabase المزامَنة. ولا أسماء أصناف في الرد.
// ============================================================================
import "../_shared/stock-alert-priority.js";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

type Message = { eventType: string; message: string; dedupeKey: string; cooldownMinutes: number };
type Result = {
  status: string;
  alerts: unknown[];
  messages: Message[];
  problems: { kind: string; code: string }[];
  warnings: string[];
  priority: { soldCount?: number; eligible?: unknown[] } | null;
};
type Engine = {
  CONFIG: { stockSource: string; salesSource: string };
  buildStockAlerts: (input: Record<string, unknown>) => Result;
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

    let dryRun = false;
    try { dryRun = (await req.json())?.dryRun === true; } catch { dryRun = false; }

    // نفس قراءات scripts/stock-priority-alerts.mjs: آخر تقرير لكل مصدر، والحد اليدوي.
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

    let result: Result;
    try {
      const [stockReport, salesReport, thresholdRow] = await Promise.all([
        latestReport(engine.CONFIG.stockSource),
        latestReport(engine.CONFIG.salesSource),
        admin.from("bot_config").select("value").eq("key", "low_stock_threshold").maybeSingle()
      ]);
      if (thresholdRow.error) throw new Error("threshold_failed");
      const parsed = Number(thresholdRow.data?.value);
      result = engine.buildStockAlerts({
        stockReport,
        salesReport,
        now: new Date(),
        lowStockThreshold: Number.isFinite(parsed) ? parsed : 50
      });
    } catch (error) {
      return json({ error: String((error as Error)?.message || "build_failed") }, 500);
    }

    const summary = {
      status: result.status,
      sold: result.priority?.soldCount ?? null,
      eligible: result.priority?.eligible?.length ?? null,
      alerts: result.alerts.length,
      messages: result.messages.length,
      problems: result.problems.map((p) => `${p.kind}:${p.code}`),
      warnings: result.warnings
    };
    if (dryRun) return json({ mode: "dry_run", ...summary });

    // منع التكرار داخل notify_telegram بالمفتاح والنافذة (360 دقيقة) كما في المُشغِّل.
    let sent = 0;
    for (const message of result.messages) {
      const { error } = await admin.rpc("notify_telegram", {
        p_event_type: message.eventType,
        p_message: message.message,
        p_dedupe_key: message.dedupeKey,
        p_dedupe_minutes: message.cooldownMinutes
      });
      if (error) return json({ error: "notify_failed", sent, ...summary }, 500);
      sent += 1;
    }
    return json({ mode: "live", sent, ...summary });
  },
};
