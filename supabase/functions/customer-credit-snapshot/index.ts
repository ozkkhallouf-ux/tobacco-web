// ============================================================================
// customer-credit-snapshot — كاتب اللقطة اليومية لحد الائتمان الآلي (STEP 2).
//
// لا قاعدة تجارية هنا: المحرك نفسه الذي تعرضه الشاشة (src/customer-intelligence.js،
// منسوخ بايتاً ببايت في ../_shared ويفرض تطابقه scripts/check-customer-intelligence.mjs)
// يحسب الحد والتنعيم والصفوف. هذه الدالة تجلب المدخلات نفسها التي تجلبها الشاشة،
// وتكتب صفوف buildCreditSnapshots() في customer_credit_history وحده.
//
// تستدعيها pg_cron (public.dispatch_customer_credit_snapshot) برأس
// X-OZK-Credit-Snapshot-Token مطابق لـapp_secrets.customer_credit_snapshot_token.
// لا وصول لقاعدة الأمين من هنا إطلاقاً: المصادر تقارير Supabase المزامَنة.
// ============================================================================
import "../_shared/customer-intelligence.js";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

type Engine = {
  build: (input: Record<string, unknown>) => Record<string, unknown>;
  buildCreditSnapshots: (result: unknown) => { eligible: boolean; reason: string | null; snapshotDate: string | null; rows: Record<string, unknown>[] };
  CONFIG: { creditHistory: { lookbackDays: number } };
};

const HISTORY_PAGE = 1000;

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
      .from("app_secrets").select("value").eq("name", "customer_credit_snapshot_token").maybeSingle();
    if (secretError) return json({ error: "secret_unavailable" }, 500);
    if (!sameToken(req.headers.get("x-ozk-credit-snapshot-token") || "", String(secret?.value || ""))) {
      return json({ error: "unauthorized" }, 401);
    }

    const engine = (globalThis as unknown as { ozkCustomerIntelligence?: Engine }).ozkCustomerIntelligence;
    if (!engine?.buildCreditSnapshots) return json({ error: "engine_unavailable" }, 500);

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

    // التاريخ: نافذة أوسع قليلاً من lookbackDays، والمحرك يقصّها بدقة على يوم المرجع.
    const sinceDay = new Date(Date.now() - (engine.CONFIG.creditHistory.lookbackDays + 2) * 86400000).toISOString().slice(0, 10);
    const readHistory = async () => {
      const rows: Record<string, unknown>[] = [];
      for (let from = 0; ; from += HISTORY_PAGE) {
        const { data, error } = await admin
          .from("customer_credit_history")
          .select("customer_guid, snapshot_date, auto_status, credit_status, limit_base, credit_limit_display, credit_currency, risk_score, factors")
          .gte("snapshot_date", sinceDay)
          .order("snapshot_date", { ascending: true })
          .order("customer_guid", { ascending: true })
          .range(from, from + HISTORY_PAGE - 1);
        if (error) throw new Error("history_read_failed");
        rows.push(...(data || []));
        if (!data || data.length < HISTORY_PAGE) return rows;
      }
    };

    let batch: ReturnType<Engine["buildCreditSnapshots"]>;
    try {
      const [invoicesReport, balancesReport, movementsReport, creditHistory] = await Promise.all([
        latestReport("ameen_customer_invoices"),
        latestReport("ameen_customer_balances"),
        latestReport("ameen_customer_movements"),
        readHistory()
      ]);
      // الحدود القديمة لا تدخل الحساب ولا الحالة (قرار المالك 2026-09-27)، فلا تُجلب.
      const result = engine.build({ invoicesReport, balancesReport, movementsReport, creditLimits: [], creditHistory, now: new Date() });
      batch = engine.buildCreditSnapshots(result);
    } catch (error) {
      return json({ error: String((error as Error)?.message || "build_failed") }, 500);
    }

    if (!batch.eligible) return json({ written: 0, skipped: batch.reason, snapshotDate: batch.snapshotDate });
    if (!batch.rows.length) return json({ written: 0, snapshotDate: batch.snapshotDate });

    const writtenAt = new Date().toISOString();
    const { error } = await admin
      .from("customer_credit_history")
      .upsert(batch.rows.map((row) => ({ ...row, written_at: writtenAt })), { onConflict: "customer_guid,snapshot_date" });
    if (error) return json({ error: "history_write_failed" }, 500);
    return json({ written: batch.rows.length, snapshotDate: batch.snapshotDate });
  },
};
