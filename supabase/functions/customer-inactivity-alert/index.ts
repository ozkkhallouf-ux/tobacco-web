// ============================================================================
// customer-inactivity-alert — تنبيه تيليغرام اليومي لغياب الزبون المهم (CUSTOMER_INACTIVE_5D).
//
// لا قاعدة تجارية هنا: المحرك نفسه الذي تعرضه الشاشة (src/customer-intelligence.js،
// منسوخ بايتاً ببايت في ../_shared ويفرض تطابقه scripts/check-customer-intelligence.mjs)
// يحدد «الزبون المهم» وغيابه ويبني الرسالة ومفاتيح منع التكرار (buildInactivityAlert).
// هذه الدالة تجلب المدخلات، وترسل عبر notify_telegram (→ telegram_outbox)، وتحدّث
// جدول الحالة customer_inactivity_alerts: إضافة من نُبِّه عنه، وحذف من عاد واشترى.
//
// الوضع الافتراضي تجريبي: تحسب وتُرجع الأعداد فقط، ولا ترسل ولا تكتب حالة، حتى يضبط المالك
// bot_config.customer_inactivity_alert_mode = 'live'.
//
// تستدعيها pg_cron (public.dispatch_customer_inactivity_alert) برأس
// X-OZK-Inactivity-Alert-Token مطابق لـapp_secrets.customer_inactivity_alert_token.
// لا وصول لقاعدة الأمين من هنا إطلاقاً: المصادر تقارير Supabase المزامَنة.
// ============================================================================
import "../_shared/customer-intelligence.js";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

type AlertPlan = {
  status: string;
  code: string;
  messages: { text: string; dedupeKey: string; customerKeys?: string[] }[];
  insertRows: Record<string, unknown>[];
  deleteKeys: string[];
};
type Engine = {
  build: (input: Record<string, unknown>) => Record<string, unknown>;
  buildInactivityAlert: (result: unknown, alertedRows: Record<string, unknown>[]) => AlertPlan;
  CONFIG: { keyCustomerAlert: { messageDedupeMinutes: number } };
};

const STATE_PAGE = 1000;

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
      .from("app_secrets").select("value").eq("name", "customer_inactivity_alert_token").maybeSingle();
    if (secretError) return json({ error: "secret_unavailable" }, 500);
    if (!sameToken(req.headers.get("x-ozk-inactivity-alert-token") || "", String(secret?.value || ""))) {
      return json({ error: "unauthorized" }, 401);
    }

    const engine = (globalThis as unknown as { ozkCustomerIntelligence?: Engine }).ozkCustomerIntelligence;
    if (!engine?.buildInactivityAlert) return json({ error: "engine_unavailable" }, 500);

    // آخر تقرير لكل مصدر — الاستعلامات نفسها في src/supabase-client.js.
    const latestReport = async (source: string) => {
      const { data, error } = await admin
        .from("inventory_reports")
        .select("id, report_date, source, summary, items, created_at")
        .eq("source", source)
        .order("created_at", { ascending: false })
        .limit(1);
      if (error) throw new Error(`report_${source}_failed`);
      return (data && data[0]) || null;
    };
    const readState = async () => {
      const rows: Record<string, unknown>[] = [];
      for (let from = 0; ; from += STATE_PAGE) {
        const { data, error } = await admin
          .from("customer_inactivity_alerts")
          .select("dedupe_key, customer_guid, customer_key, last_purchase_date")
          .order("dedupe_key", { ascending: true })
          .range(from, from + STATE_PAGE - 1);
        if (error) throw new Error("state_read_failed");
        rows.push(...(data || []));
        if (!data || data.length < STATE_PAGE) return rows;
      }
    };

    let plan: AlertPlan;
    try {
      const [invoicesReport, balancesReport, movementsReport, alerted] = await Promise.all([
        latestReport("ameen_customer_invoices"),
        latestReport("ameen_customer_balances"),
        latestReport("ameen_customer_movements"),
        readState()
      ]);
      // الحدود القديمة لا تدخل الحساب (قرار المالك 2026-09-27)، فلا تُجلب.
      const result = engine.build({ invoicesReport, balancesReport, movementsReport, creditLimits: [], now: new Date() });
      plan = engine.buildInactivityAlert(result, alerted);
    } catch (error) {
      return json({ error: String((error as Error)?.message || "build_failed") }, 500);
    }

    // الوضع التجريبي هو الافتراضي: بلا bot_config.customer_inactivity_alert_mode = 'live'
    // لا إرسال ولا كتابة حالة، فقط الأعداد. التفعيل قرار المالك.
    const { data: modeRow, error: modeError } = await admin
      .from("bot_config").select("value").eq("key", "customer_inactivity_alert_mode").maybeSingle();
    if (modeError) return json({ error: "mode_unavailable" }, 500);
    if (String(modeRow?.value || "").trim() !== "live") {
      return json({
        mode: "dry_run",
        status: plan.status,
        wouldAlert: plan.insertRows.length,
        wouldSendMessages: plan.messages.length,
        wouldClear: plan.deleteKeys.length
      });
    }

    // الإرسال أولاً ثم حالة زبائن تلك الرسالة: فشل إرسال لا يسجّل زبوناً كأنه نُبِّه عنه،
    // ورسالة نجحت قبل فشل تاليتها تُسجَّل فلا تتكرر غداً.
    const rowsByKey = new Map(plan.insertRows.map((row) => [String(row.dedupe_key), row]));
    let alerted = 0;
    for (const message of plan.messages) {
      const { error } = await admin.rpc("notify_telegram", {
        p_event_type: plan.code,
        p_message: message.text,
        p_dedupe_key: message.dedupeKey,
        p_dedupe_minutes: engine.CONFIG.keyCustomerAlert.messageDedupeMinutes
      });
      if (error) return json({ error: "notify_failed", status: plan.status, alerted }, 500);
      const rows = (message.customerKeys || []).map((key) => rowsByKey.get(key)).filter(Boolean);
      if (!rows.length) continue;
      const alertedAt = new Date().toISOString();
      const { error: stateError } = await admin
        .from("customer_inactivity_alerts")
        .upsert(rows.map((row) => ({ ...row, alerted_at: alertedAt })), { onConflict: "dedupe_key" });
      if (stateError) return json({ error: "state_write_failed", alerted }, 500);
      alerted += rows.length;
    }
    if (plan.status !== "ok") return json({ mode: "live", status: plan.status, notified: plan.messages.length });

    if (plan.deleteKeys.length) {
      const { error } = await admin.from("customer_inactivity_alerts").delete().in("dedupe_key", plan.deleteKeys);
      if (error) return json({ error: "state_cleanup_failed" }, 500);
    }
    return json({ mode: "live", status: plan.status, notified: plan.messages.length, alerted, cleared: plan.deleteKeys.length });
  },
};
