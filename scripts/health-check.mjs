#!/usr/bin/env node
/**
 * فحص صحة المشروع الدوري (كل 30 دقيقة عبر .github/workflows/health-check.yml).
 *
 * ماذا يفحص:
 *  - وصول الموقع الفعلي (ozktobacco.com) ونشرة أسعار واحدة كعينة.
 *  - آخر تشغيل لسير عمل "توليد نشرات الأسعار" (فشل؟).
 *  - آخر تشغيل لسير عمل "Deploy TOBACCO Web" (فشل؟).
 *  - أي تشغيل فاشل لأي سير عمل آخر خلال نافذة المراقبة، باستثناء
 *    "Codex Review Gate" (فشله المؤقت قبل رد Codex متوقع وليس عطلاً — البند 5/6).
 *
 * عند اكتشاف مشكلة:
 *  - Issue واحد لكل مشكلة (dedupe عبر علامة مخفية <!-- health:KEY --> + label health-check).
 *    لا يُنشأ Issue مكرر إن كانت المشكلة نفسها ما تزال مفتوحة.
 *  - إشعار تيليغرام عبر نفس دالة notify_telegram الموجودة (لا نظام تنبيه جديد)،
 *    باسم المشكلة ودرجة الخطورة ورابط الـIssue. dedupe إضافي على مستوى Supabase نفسه.
 *  - إذا زالت مشكلة كانت مفتوحة سابقاً، يُغلق الـIssue تلقائياً بتعليق "تم الحل".
 *
 * هذا السكريبت *يكتشف ويبلّغ فقط* — لا يوجد أي إصلاح تلقائي (auto-fix) هنا عمداً (البند 8).
 * نقطة التوسع المستقبلية: مخرجات JSON بمتغير GITHUB_OUTPUT (problems) يمكن لخطوة لاحقة
 * (تشخيص → إصلاح Claude Code → اختبارات → مراجعة Codex → دمج) قراءتها بدون إعادة بناء هذا السكريبت.
 *
 * لا يعتمد هذا الفحص على استجابة Codex إطلاقاً؛ Codex غير مستدعى هنا أبداً (البند 5/6).
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = process.env.GITHUB_REPOSITORY || "ozkkhallouf-ux/tobacco-web";
const SITE_URL = "https://ozktobacco.com/";
const BULLETIN_SAMPLE_URL = "https://ozktobacco.com/public/downloads/price-list-usd.html";
const LOOKBACK_MINUTES = 40; // نافذة أكبر قليلاً من فترة الجدولة (30 دقيقة) لتفادي الفجوات
const EXCLUDED_WORKFLOW_NAMES = new Set(["Codex Review Gate"]);
const LABEL = "health-check";

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function ghJSON(args) {
  return JSON.parse(gh(args));
}

async function fetchStatus(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { redirect: "follow", signal: controller.signal });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, status: 0, error: String(err) };
  } finally {
    clearTimeout(t);
  }
}

async function checkSiteReachability() {
  const problems = [];
  const healthy = [];
  const site = await fetchStatus(SITE_URL);
  // ⚠️ يجب أن يكون هذا هو نفس مفتاح العطل أدناه ("site-down") بالضبط. لو اختلفا،
  // لا يُغلق Issue العطل أبداً، ثم يجد reportProblem ذلك الـIssue مفتوحاً في كل
  // انقطاع لاحق فيتخطّى الإنشاء وإشعار تيليغرام — أي تُكتَم كل الأعطال التالية.
  if (site.ok) healthy.push("site-down");
  if (!site.ok) {
    problems.push({
      key: "site-down",
      title: `الموقع لا يستجيب (${SITE_URL})`,
      severity: "حرج",
      details: `HTTP status=${site.status}${site.error ? ` error=${site.error}` : ""}`,
    });
  }
  const bulletin = await fetchStatus(BULLETIN_SAMPLE_URL);
  if (!bulletin.ok) {
    problems.push({
      key: "bulletin-unreachable",
      title: `نشرة الأسعار لا تُفتح (${BULLETIN_SAMPLE_URL})`,
      severity: "متوسط",
      details: `HTTP status=${bulletin.status}${bulletin.error ? ` error=${bulletin.error}` : ""}`,
    });
  } else {
    healthy.push("bulletin-unreachable");
  }
  return { problems, healthy };
}

// "skipped" غالباً سلوك مقصود (مثلاً pages.yml يتخطى deploy إن فشل سير عمل توليد
// النشرات الذي يشغّله — تلك مشكلته الخاصة، وليست عطلاً إضافياً بالنشر نفسه).
//
// ⚠️ قائمة سماح لا قائمة منع: أي نتيجة نهائية غير success/skipped تُعدّ عطلاً.
// قائمة المنع السابقة كانت تُسقط startup_failure وstale وneutral فتصنّفها "سليمة"
// وتغلق عطلاً قائماً. وهذه هي القاعدة نفسها المعتمدة في
// .github/workflows/alert-on-automation-failure.yml.
export const NON_INCIDENT_CONCLUSIONS = new Set(["success", "skipped"]);
export const isIncidentConclusion = (conclusion) => !NON_INCIDENT_CONCLUSIONS.has(conclusion);

// ⚠️ "ليست حادثة" ≠ "دليل تعافٍ" — وهذا هو جوهر ملاحظة Codex الأخيرة.
// pages.yml ("Deploy TOBACCO Web") فيه `check` مشروط بـ
// github.event.workflow_run.conclusion == 'success'، و`deploy` عليه needs: check.
// فإذا شُغِّل عبر workflow_run بعد فشل توليد النشرات، تُتخطّى الوظيفتان وينتهي
// التشغيل بنتيجة skipped **بلا أي نشر فعلي**. لذلك skipped سببٌ وجيه لعدم إطلاق
// إنذار، لكنه ليس إطلاقاً دليلاً على أن النشر تعافى. الدليل الوحيد هو success:
// في pages.yml لا توجد على deploy أي شرط عدا needs: check، فنتيجة success على
// مستوى التشغيل تعني أن deploy نُفِّذ ونجح فعلاً.
export const isRecoveryConclusion = (conclusion) => conclusion === "success";

// دالة نقية (قابلة للاختبار بلا شبكة): تصنّف قائمة تشغيلات إلى واحدة من ثلاث حالات.
//
// ⚠️ إصلاح ملاحظة Codex P1 الثانية على PR #135: القراءة السابقة كانت تأخذ أحدث
// تشغيل مطلقاً (--limit 1) وتشترط status === "completed". فإن تلا تشغيلٌ فاشلٌ
// تشغيلٌ جديد queued/in_progress، رجعت الدالة [] — فبدا العطل وكأنه زال، وأُغلق
// الـIssue رغم أن آخر نتيجة مكتملة كانت فشلاً. الصواب: تجاهل التشغيلات غير
// المكتملة والحكم بأحدث تشغيل *مكتمل*؛ وإن لم يوجد أي مكتمل فالحالة "مجهولة"
// لا "سليمة" — فلا يُغلق شيء بناءً عليها.
export function classifyLatestRun(runs, { workflowName, key, severity }) {
  const completed = (runs || []).filter((r) => r && r.status === "completed");
  if (!completed.length) return { problems: [], healthy: [], unknown: true };
  const last = completed[0];
  if (isIncidentConclusion(last.conclusion)) {
    return {
      problems: [{
        key,
        title: `آخر تشغيل مكتمل لسير العمل "${workflowName}" فشل (${last.conclusion})`,
        severity,
        details: `${last.url} — ${last.createdAt}`,
      }],
      healthy: [],
      unknown: false,
    };
  }
  // نجاح صريح فقط يُغلق حادثة. أما skipped فلا إنذار ولا إغلاق — حالة مجهولة،
  // لأن تشغيلاً متخطّى لم يَنشر شيئاً ولا يُثبت زوال العطل.
  if (isRecoveryConclusion(last.conclusion)) return { problems: [], healthy: [key], unknown: false };
  return { problems: [], healthy: [], unknown: true };
}

function checkLatestWorkflowRun(workflowName, key, severity) {
  let runs;
  try {
    runs = ghJSON([
      "run", "list",
      "--repo", REPO,
      "--workflow", workflowName,
      "--branch", "main",
      // نطلب عدة تشغيلات لا واحداً: أحدث تشغيل قد يكون queued/in_progress ويحجب
      // آخر نتيجة مكتملة. نحتاج أحدث *مكتمل* لا أحدث مطلقاً.
      "--limit", "10",
      "--json", "conclusion,status,url,createdAt",
    ]);
  } catch (err) {
    // فشل الاستعلام مشكلة بذاته، ولا يجوز اعتباره دليل سلامة على `key`.
    return {
      problems: [{
        key: `${key}-lookup-failed`,
        title: `تعذّر فحص حالة سير العمل "${workflowName}"`,
        severity: "منخفض",
        details: String(err.message || err),
      }],
      healthy: [],
      unknown: true,
    };
  }
  const verdict = classifyLatestRun(runs, { workflowName, key, severity });
  // نجاح الاستعلام نفسه يُثبت زوال مشكلة "تعذّر الفحص" السابقة.
  return { ...verdict, healthy: [...verdict.healthy, `${key}-lookup-failed`] };
}

// دالة نقية: تصفية التشغيلات الفاشلة الحديثة وتحويلها إلى مشاكل.
//
// ⚠️ إصلاح ملاحظة Codex P1 الأولى على PR #135: كان المسح مقيَّداً بـ--branch main،
// بينما check.yml وbusiness-os-foundation.yml وDecision Engine Check كلها من نوع
// pull_request، فتُنسب تشغيلاتها إلى فرع الـPR لا إلى main — أي أن فشلها لم يكن
// يظهر إطلاقاً رغم أن السكربت يَعِد برصد "أي تشغيل فاشل لأي سير عمل آخر".
// (تحقق حي: بفلتر main تُرى "توليد نشرات الأسعار" فقط؛ وبدونه تظهر أيضاً
//  "فحص المشروع" و"Decision Engine Check".) لذلك أُزيل قيد الفرع نهائياً،
// وصار مفتاح المشكلة يشمل الفرع كي تُتابَع كل حادثة على حدة.
export function selectRecentFailures(runs, sinceMs, excludedNames = EXCLUDED_WORKFLOW_NAMES) {
  return (runs || [])
    .filter((r) => r && !excludedNames.has(r.workflowName))
    // ⚠️ لا نعتمد على --status failure في الاستعلام: فهو لا يشمل startup_failure
    // ولا stale ولا غيرهما من النتائج النهائية غير الناجحة. نجلب المكتملة كلها
    // ونصنّفها هنا بقائمة السماح نفسها المستعملة في classifyLatestRun.
    .filter((r) => r.status === "completed" && isIncidentConclusion(r.conclusion))
    .filter((r) => new Date(r.createdAt).getTime() >= sinceMs)
    .map((r) => {
      const branch = r.headBranch || "?";
      return {
        key: `workflow-failure-${r.workflowName}@${branch}`,
        title: `تشغيل فاشل حديث لسير العمل "${r.workflowName}" على الفرع "${branch}"`,
        severity: "متوسط",
        details: `${r.displayTitle} — ${r.url} — ${r.createdAt}`,
      };
    });
}

function checkRecentWorkflowFailures() {
  const since = Date.now() - LOOKBACK_MINUTES * 60 * 1000;
  let runs;
  try {
    runs = ghJSON([
      "run", "list",
      "--repo", REPO,
      // بلا --branch عمداً: الفحوص الأساسية تعمل على فروع الـPR لا على main.
      // وبلا --status failure عمداً أيضاً: التصنيف يجري في الذاكرة بقائمة السماح
      // كي تُرصد startup_failure وstale وسواهما.
      // الاستثناء والتصنيف وفلترة الزمن تجري بعد هذا الحد، فلو بقي منخفضاً
      // امتلأت الدفعة بتشغيلات Codex Review Gate المستثناة وأزاحت الحقيقية.
      "--limit", "100",
      "--json", "workflowName,headBranch,url,createdAt,displayTitle,status,conclusion",
    ]);
  } catch (err) {
    // ⚠️ فشل المسح ليس دليل سلامة. نرفعه كمشكلة ظاهرة، ونُعلم منطق الإغلاق
    // أن مفاتيح workflow-failure-* غير مُتحقَّق منها هذه الجولة.
    return {
      problems: [{
        key: "workflow-scan-failed",
        title: "تعذّر مسح التشغيلات الفاشلة الحديثة",
        severity: "منخفض",
        details: String(err.message || err),
      }],
      scanOk: false,
    };
  }
  return { problems: selectRecentFailures(runs, since), scanOk: true };
}

function dedupeByKey(problems) {
  const seen = new Map();
  for (const p of problems) seen.set(p.key, p);
  return [...seen.values()];
}

// ملاحظة مهمة: `gh issue list --search` يعتمد على فهرسة بحث GitHub وقد يتأخر ثوانٍ عن Issue
// أُنشئ للتو (لوحظ فعلياً أثناء الاختبار: 504 من واجهة GraphQL + Issue مكرر). لذلك الاعتماد
// هنا على `--label` فقط (فلترة مباشرة غير مفهرسة) ثم مطابقة العلامة المخفية داخل الذاكرة.
let _openHealthIssuesCache = null;
function listAllOpenHealthIssues() {
  if (_openHealthIssuesCache) return _openHealthIssuesCache;
  try {
    _openHealthIssuesCache = ghJSON([
      "issue", "list",
      "--repo", REPO,
      "--label", LABEL,
      "--state", "open",
      "--json", "number,title,body",
      "--limit", "50",
    ]);
  } catch {
    _openHealthIssuesCache = [];
  }
  return _openHealthIssuesCache;
}

function findOpenIssueForKey(key) {
  const marker = `<!-- health:${key} -->`;
  return listAllOpenHealthIssues().find((i) => i.body && i.body.includes(marker)) || null;
}

function ensureLabel() {
  try {
    gh(["label", "list", "--repo", REPO, "--search", LABEL, "--json", "name"]);
  } catch {
    /* ignore */
  }
  try {
    gh([
      "label", "create", LABEL,
      "--repo", REPO,
      "--color", "B60205",
      "--description", "تقارير مراقبة صحة المشروع الآلية",
      "--force",
    ]);
  } catch {
    /* موجودة مسبقاً أو لا صلاحية — لا يوقف التنفيذ */
  }
}

// ⚠️ منع التكرار يجب أن يرتبط بهوية *الحادثة* لا بنوعها.
// كان المفتاح health-${problem.key} ثابتاً مع p_dedupe_minutes=180، فإذا انقطع
// الموقع ثم تعافى ثم انقطع مجدداً خلال ثلاث ساعات، أُنشئ Issue جديد لكن
// private.notify_telegram_dispatch يجد المفتاح نفسه في telegram_outbox فيكتم
// إشعار الانقطاع الجديد. رقم الـIssue هوية فريدة لكل حادثة، فيدخل في المفتاح.
// وحين يتعذّر إنشاء Issue أصلاً لا هوية لدينا، فنستعمل حزمة زمنية بالساعة:
// يبقى الإشعار يصل (وهو الأهم في هذا المسار) دون أن يتكرر كل 30 دقيقة.
export function telegramDedupeKey(problemKey, issueNumber, nowMs = Date.now()) {
  if (issueNumber) return `health-${problemKey}-issue-${issueNumber}`;
  const hourBucket = Math.floor(nowMs / (60 * 60 * 1000));
  return `health-${problemKey}-noissue-${hourBucket}`;
}

export function issueNumberFromUrl(issueUrl) {
  const m = String(issueUrl || "").match(/\/issues\/(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

// ═══ دورة حياة العطل في سجلّ الملخص (private.ops_events) — يتطلب proposed/12 و13 ═══
// الحرجان فقط فوريان ومستقلان عن السجلّ؛ كل ما عداهما غير حرج: يُجدَّد حضوره ما دام قائماً
// ويُغلق بإشارة تعافٍ صريحة. (يطابق التوجيه: ^health-(site-down|health-check-crashed) في proposed/13.)
export const IMMEDIATE_HEALTH_KEYS = Object.freeze(["site-down", "health-check-crashed"]);
export const isImmediateHealthKey = (problemKey) => IMMEDIATE_HEALTH_KEYS.includes(problemKey);
const validIssueNumber = (n) => Number.isInteger(n) && n > 0;

async function notifyTelegram(problem, issueUrl, dedupeMinutes = 180) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !serviceKey) {
    console.log("⚠️ تخطي إشعار تيليغرام: SUPABASE_URL أو SUPABASE_SERVICE_KEY غير مضبوطين كسر GitHub Actions.");
    return false;
  }
  const issueNumber = issueNumberFromUrl(issueUrl);
  const link = issueUrl || "(تعذّر إنشاء Issue — راجع سجل health-check.yml)";
  const message = `🩺 مشكلة اكتشفتها المراقبة الآلية\nالاسم: ${problem.title}\nالخطورة: ${problem.severity}\nرابط: ${link}`;
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/notify_telegram`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Profile": "public",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        p_event_type: "health_check",
        p_message: message,
        p_dedupe_key: telegramDedupeKey(problem.key, issueNumber),
        p_dedupe_minutes: dedupeMinutes,
      }),
    });
    if (!res.ok) {
      console.log(`⚠️ فشل استدعاء notify_telegram: HTTP ${res.status} ${await res.text()}`);
      return false;
    }
    return true;
  } catch (err) {
    console.log(`⚠️ فشل استدعاء notify_telegram: ${err}`);
    return false;
  }
}

// ═══ دورة حياة أعطال الصحة عبر RPC بإقرار صريح: public.health_lifecycle (داخل proposed/13) ═══
// لا notify_telegram هنا إطلاقاً: 2xx منه لا يثبت الامتصاص (عند خطأ داخلي يُرسَل النصّ رسالة فعلية)، أما الـRPC فتُقرّ
// العملية نفسها (ok:true) أو ترمي خطأ صريحاً.
//
// آلية الانتقال **صريحة** عبر HEALTH_LIFECYCLE_MODE (يضبطها المشغّل، لا يستنتجها السكربت من PGRST202 ولا من الزمن ولا من غياب الأسرار):
//   legacy  = 13 غير مطبَّق (أو سُحب بتراجعه): صفر استدعاء DB؛ يُغلَق الـIssue بالسلوك القديم عند دليل التعافي. **المسار الوحيد للإغلاق القديم.**
//   managed = 13 مطبَّق: probe ثم renew/resolve بإقرار صريح؛ أي إخفاق (PGRST202، تأخّر schema cache، انقطاع، فقدان الأسرار، إقرار غير صالح)
//             ⇒ hold (لا إغلاق، تُعاد المحاولة)، **لا رجوع تلقائي إلى legacy** مهما طال الإخفاق.
//   غير مضبوط/قيمة غير معروفة = unknown ⇒ hold بلا استدعاء DB (الـworkflow يضبط legacy افتراضياً فيبقى الإنتاج الحالي كما هو).
// HEALTH_LIFECYCLE_SIGNALS=off ⇒ إيقاف طوارئ يسبق كل شيء: صفر استدعاء DB، الـIssues غير الحرجة تبقى مفتوحة، الحرجة كالمعتاد.
export const lifecycleSwitchOff = (env = process.env) => String(env.HEALTH_LIFECYCLE_SIGNALS || "").trim().toLowerCase() === "off";
export const declaredLifecycleMode = (env = process.env) => {
  const v = String(env.HEALTH_LIFECYCLE_MODE || "").trim().toLowerCase();
  return v === "legacy" || v === "managed" ? v : "unknown";
};

const RPC_TIMEOUT_MS = 15000;
// استدعاء health_lifecycle. الإرجاع:
//   { kind: "ok", body }      = إقرار صالح للعملية المطلوبة بعينها؛
//   { kind: "absent" }        = HTTP 404 + PGRST202 (دالة غير موجودة **أو** schema cache قديم — غير حاسم وحده)؛
//   { kind: "error", detail } = أي شيء آخر (شبكة، 5xx، 401/403، 400، جسم غير متوقع…) ⇒ غير معروف.
export async function callLifecycle(op, args = {}, { env = process.env, fetchImpl = fetch } = {}) {
  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !serviceKey) return { kind: "error", detail: "no-supabase-secrets" };
  let res;
  let text;
  try {
    res = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/health_lifecycle`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Profile": "public",
      },
      body: JSON.stringify({ p_op: op, p_key: args.key ?? null, p_issue: args.issue ?? null, p_label: args.label ?? null }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    text = await res.text();
  } catch (err) {
    return { kind: "error", detail: `network: ${err}` };
  }
  let body = null;
  try { body = JSON.parse(text); } catch { /* جسم غير JSON */ }
  if (res.status === 404 && body && body.code === "PGRST202") return { kind: "absent" };
  if (!res.ok) return { kind: "error", detail: `HTTP ${res.status} ${String(text).slice(0, 200)}` };
  const valid = body && body.ok === true && body.op === op && (
    op === "probe" ? typeof body.ready === "boolean"
    : op === "renew" ? Number.isInteger(body.renewed) && typeof body.created === "boolean"
    : Number.isInteger(body.resolved));
  if (!valid) return { kind: "error", detail: "unexpected-ack" };
  return { kind: "ok", body };
}

// حالة التشغيل (مرة واحدة لكل تشغيل):
//   "off" طوارئ؛ "legacy" مُعلَن؛ "unknown" غير مُعلَن؛ "ready" = managed + probe ok و ready=true؛
//   "unavailable" = managed لكن الـprobe لم ينجح (PGRST202/شبكة/أسرار ناقصة/…) ⇒ hold، وليس legacy أبداً.
export async function detectLifecycleMode(deps = {}) {
  const env = deps.env || process.env;
  if (lifecycleSwitchOff(env)) return "off";
  const declared = declaredLifecycleMode(env);
  if (declared !== "managed") return declared;
  const r = await callLifecycle("probe", {}, deps);
  return r.kind === "ok" && r.body.ready === true ? "ready" : "unavailable";
}

// قرار إغلاق Issue لعطل غير حرج (الحرجان بلا حدث ⇒ يُغلقان مباشرة في processClosures):
//   "resolved" = الـRPC أقرّت إغلاق الحدث؛  "legacy" = المشغّل أعلن legacy صراحةً؛
//   "hold"     = طوارئ/unknown/unavailable/فشل أو إقرار غير صالح ⇒ لا يُغلَق وتُعاد المحاولة الدورة التالية.
export async function resolveForClosure(key, number, { mode, call, log = () => {} }) {
  if (mode === "legacy") return "legacy";
  if (mode === "off") { log(`⏸ إيقاف الطوارئ (HEALTH_LIFECYCLE_SIGNALS=off): يبقى Issue #${number} ("${key}") مفتوحاً — لا حلّ ولا إغلاق.`); return "hold"; }
  if (mode === "unknown") { log(`⏸ HEALTH_LIFECYCLE_MODE غير مضبوط (legacy|managed) — يبقى Issue #${number} ("${key}") مفتوحاً.`); return "hold"; }
  if (mode !== "ready") { log(`::warning::HEALTH_LIFECYCLE_MODE=managed لكن 13/الأسرار غير متاحة — يبقى Issue #${number} ("${key}") مفتوحاً ولا رجوع تلقائياً إلى legacy.`); return "hold"; }
  const r = await call("resolve", { key, issue: number });
  if (r.kind === "ok") return "resolved";
  log(`✗ تعذّر حلّ حدث "${key}" (#${number}): ${r.kind === "absent" ? "PGRST202" : r.detail} — يبقى مفتوحاً وتُعاد المحاولة.`);
  return "hold";
}

// ترجع true إن وصلت الحادثة عبر أي قناة (Issue قائم أو جديد، أو تيليغرام).
async function reportProblem(problem) {
  const existing = findOpenIssueForKey(problem.key);
  if (existing) {
    console.log(`= مشكلة "${problem.key}" مفتوحة أصلاً بالـIssue #${existing.number} — لا تكرار.`);
    // عطل غير حرج ما زال قائماً (تأكّد هذه الدورة): تجديد حضوره في سجلّ الملخص عبر RPC بإقرار صريح (لا Telegram إطلاقاً)،
    // وإلا ظهر «يلزم إعادة التحقق» بعد 30 ساعة. لا تجديد إلا في حالة "ready"؛ فشله لا يُفشل الدورة (الـIssue موجود).
    if (!isImmediateHealthKey(problem.key) && validIssueNumber(existing.number)) {
      if ((await getLifecycleMode()) === "ready") {
        const r = await callLifecycle("renew", { key: problem.key, issue: existing.number, label: problem.title });
        if (r.kind !== "ok") console.log(`⚠️ تعذّر تجديد حضور "${problem.key}" (#${existing.number}): ${r.kind === "absent" ? "PGRST202" : r.detail}`);
      }
    }
    return true;
  }
  const marker = `<!-- health:${problem.key} -->`;
  const body = [
    marker,
    `**الخطورة:** ${problem.severity}`,
    "",
    `**التفاصيل:**`,
    problem.details || "-",
    "",
    `_تقرير آلي من health-check.yml — ${new Date().toISOString()}_`,
  ].join("\n");
  let issueUrl;
  try {
    issueUrl = gh([
      "issue", "create",
      "--repo", REPO,
      "--title", `[مراقبة آلية] ${problem.title}`,
      "--label", LABEL,
      "--body", body,
    ]).trim();
  } catch (err) {
    // ⚠️ لا نعود من هنا: تيليغرام قناة تنبيه مستقلة تماماً عن GitHub Issues.
    // إن تعطّلت واجهة Issues أو تقلّصت الصلاحيات، كان العطل الإنتاجي يمرّ بلا أي
    // تنبيه إطلاقاً (والسكربت يخرج بنجاح، وalert-on-automation-failure.yml لا
    // يراقب سير عمل health-check نفسه) — فلا يبقى منه إلا سطر في السجل.
    console.log(`✗ فشل إنشاء Issue لمشكلة "${problem.key}": ${err} — نُرسل تنبيه تيليغرام رغم ذلك.`);
    // ⚠️ إن فشلت القناتان معاً لم تصل الحادثة إلى أحد. نُبلّغ ذلك للأعلى كي
    // يُفشل main() التشغيل — وسير عمل health-check صار مراقَباً في
    // alert-on-automation-failure.yml، فيتحول الفشل الصامت إلى تنبيه فعلي.
    const delivered = await notifyTelegram(problem, null);
    if (!delivered) {
      console.log(`✗✗ لم تصل مشكلة "${problem.key}" عبر أي قناة (لا Issue ولا تيليغرام).`);
    }
    return delivered;
  }
  console.log(`✓ أُنشئ Issue جديد لمشكلة "${problem.key}": ${issueUrl}`);
  // حدّث الكاش المحلي فوراً كي لا يُنشأ Issue مكرر لنفس المشكلة إن ظهرت مرتين بنفس التشغيل.
  if (_openHealthIssuesCache) {
    _openHealthIssuesCache.push({ number: 0, title: problem.title, body: `<!-- health:${problem.key} -->` });
  }
  await notifyTelegram(problem, issueUrl);
  // الـIssue أُنشئ بنجاح، فالحادثة موثّقة حتى لو تعثّر تيليغرام.
  return true;
}

// دالة نقية: تقرر أي Issues تُغلق فعلاً.
//
// ⚠️ جوهر إصلاح ملاحظة Codex P1 الثانية: المنطق السابق كان "أغلق كل مفتاح ليس
// ضمن المشاكل الحالية" — أي أنه يعامل *غياب الدليل* كدليل على التعافي. فأي
// انقطاع في استعلام GitHub، أو تشغيل قيد التنفيذ يحجب آخر نتيجة مكتملة، كان
// يُفرغ قائمة المشاكل فتُغلق كل الحوادث المفتوحة بتعليق "تم الحل" رغم استمرار
// العطل. الآن الإغلاق يحتاج دليلاً إيجابياً صريحاً:
//   * مفتاح ضمن healthyKeys  = نتيجة مكتملة ناجحة مرصودة فعلاً هذه الجولة، أو
//   * مفتاح يطابق بادئة ضمن healthyPrefixes = مسح نجح فعلاً ولم يجد هذه الحادثة.
// وما عدا ذلك يبقى مفتوحاً بحالة "مجهول"، وهو الخيار الآمن في المراقبة.
// يفكّ مفتاح حادثة تشغيل فاشل إلى اسم سير العمل والفرع.
// الصيغة: workflow-failure-<اسم سير العمل>@<الفرع>. نستعمل آخر '@' لأن أسماء
// الفروع قد تحتوي '@' بينما البادئة ثابتة.
export function parseWorkflowIncidentKey(key) {
  const PREFIX = "workflow-failure-";
  if (!key.startsWith(PREFIX)) return null;
  const rest = key.slice(PREFIX.length);
  const at = rest.lastIndexOf("@");
  if (at <= 0) return null;
  return { workflowName: rest.slice(0, at), branch: rest.slice(at + 1) };
}

export function decideIssuesToClose({ openIssues, activeKeys, healthyKeys, verifyKey }) {
  const active = activeKeys instanceof Set ? activeKeys : new Set(activeKeys || []);
  const healthy = healthyKeys instanceof Set ? healthyKeys : new Set(healthyKeys || []);
  const out = [];
  for (const issue of openIssues || []) {
    const match = issue.body && issue.body.match(/<!-- health:([^>]+) -->/);
    if (!match) continue;
    const key = match[1];
    if (active.has(key)) continue;                 // ما تزال قائمة
    // ⚠️ إصلاح ملاحظة Codex الثالثة: البادئة العمياء healthyPrefixes كانت تعتبر
    // مجرد *خروج الحادثة من نافذة LOOKBACK_MINUTES* تعافياً، فتغلق فشل فحص على
    // فرع PR لم يُعَد تشغيله أصلاً بعد 40 دقيقة. الآن كل حادثة سير عمل تُتحقَّق
    // على حدة: نسأل عن أحدث تشغيل *مكتمل* لنفس سير العمل ونفس الفرع، ولا نغلق
    // إلا إذا كانت نتيجته نجاحاً صريحاً.
    let verified = healthy.has(key);
    if (!verified && typeof verifyKey === "function") verified = verifyKey(key) === true;
    if (!verified) continue;                       // مجهولة → تبقى مفتوحة
    out.push({ number: issue.number, key });
  }
  return out;
}

// تحقق فعلي من تعافي حادثة سير عمل: أحدث تشغيل مكتمل لنفس سير العمل ونفس
// الفرع يجب أن يكون ناجحاً صراحةً. أي شيء آخر (فشل، أو لا تشغيل مكتمل، أو فشل
// الاستعلام) يعني "غير مُتحقَّق" فتبقى الحادثة مفتوحة.
function verifyWorkflowIncidentResolved(key) {
  const parsed = parseWorkflowIncidentKey(key);
  if (!parsed) return false;
  let runs;
  try {
    runs = ghJSON([
      "run", "list",
      "--repo", REPO,
      "--workflow", parsed.workflowName,
      "--branch", parsed.branch,
      "--limit", "10",
      "--json", "status,conclusion",
    ]);
  } catch {
    return false;
  }
  const lastCompleted = (runs || []).find((r) => r && r.status === "completed");
  if (!lastCompleted) return false;
  // نجاح صريح فقط — لا يكفي "ليست حادثة" (skipped لم يشغّل شيئاً).
  return isRecoveryConclusion(lastCompleted.conclusion);
}

// ينفّذ الإغلاق على قائمة قرّرتها decideIssuesToClose (دليل إيجابي فقط). الترتيب: حلّ الحدث في قاعدة البيانات أولاً ثم الإغلاق:
//   * الحرجان (لا حدث لهما) ⇒ يُغلقان مباشرة؛
//   * غيرهما ⇒ resolveLifecycle(key, number) يرجع "resolved" (إقرار الـRPC) أو "legacy" (مُعلَن) ⇒ يُغلَق،
//     أو "hold" ⇒ لا يُغلَق (طوارئ/غير معروف/فشل) وتُعاد المحاولة الدورة التالية (الحلّ idempotent فلا يبقى حدث يتيم).
// الحلّ يحمل رقم الـIssue المغلق نفسه ومفتاحه، فلا تُغلَق حادثة أخرى.
export async function processClosures(toClose, { resolveLifecycle, closeIssue, log = () => {} }) {
  const results = [];
  for (const { number, key } of toClose) {
    let lifecycle = "none";
    if (!isImmediateHealthKey(key)) {
      lifecycle = validIssueNumber(number) ? await resolveLifecycle(key, number) : "hold";
    }
    if (lifecycle === "hold") {
      results.push({ number, key, lifecycle, closed: false });
      continue;
    }
    let closed = false;
    try {
      closed = (await closeIssue(number, key)) !== false;
    } catch (err) {
      log(`✗ فشل إغلاق Issue #${number}: ${err}`);
    }
    results.push({ number, key, lifecycle, closed });
  }
  return results;
}

let _lifecycleModePromise = null;
const getLifecycleMode = () => (_lifecycleModePromise ??= detectLifecycleMode());
async function closeResolvedIssues({ activeKeys, healthyKeys, scanOk }) {
  const openIssues = listAllOpenHealthIssues();
  const toClose = decideIssuesToClose({
    openIssues,
    activeKeys,
    healthyKeys,
    // لا يُتحقَّق من حوادث سير العمل إلا إذا نجح المسح العام هذه الجولة؛
    // وحتى حينها بنجاح مرصود فعلاً لا بمجرد غياب الحادثة عن النافذة.
    verifyKey: scanOk ? verifyWorkflowIncidentResolved : undefined,
  });
  await processClosures(toClose, {
    resolveLifecycle: async (key, number) => resolveForClosure(key, number, {
      mode: await getLifecycleMode(),
      call: (op, args) => callLifecycle(op, args),
      log: (m) => console.log(m),
    }),
    log: (m) => console.log(m),
    closeIssue: (issueNumber, key) => {
      try {
        gh([
          "issue", "comment", String(issueNumber),
          "--repo", REPO,
          "--body", "✅ تم التحقق بنتيجة إيجابية صريحة (تشغيل مكتمل ناجح أو مسح ناجح لم يجد الحادثة) — يُغلق الـIssue تلقائياً.",
        ]);
        gh(["issue", "close", String(issueNumber), "--repo", REPO]);
        console.log(`✓ أُغلق Issue #${issueNumber} (مشكلة "${key}" تأكّد زوالها).`);
        return true;
      } catch (err) {
        console.log(`✗ فشل إغلاق Issue #${issueNumber}: ${err}`);
        return false;
      }
    },
  });
}

async function main() {
  ensureLabel();

  const site = await checkSiteReachability();
  const priceGen = checkLatestWorkflowRun("توليد نشرات الأسعار", "price-generation-failed", "عالٍ");
  const deploy = checkLatestWorkflowRun("Deploy TOBACCO Web", "deploy-failed", "عالٍ");
  const recent = checkRecentWorkflowFailures();

  const problems = dedupeByKey([
    ...site.problems,
    ...priceGen.problems,
    ...deploy.problems,
    ...recent.problems,
  ]);

  // الدليل الإيجابي وحده هو ما يسمح بإغلاق حادثة (انظر decideIssuesToClose).
  const healthyKeys = new Set([...site.healthy, ...priceGen.healthy, ...deploy.healthy]);
  if (recent.scanOk) healthyKeys.add("workflow-scan-failed");

  console.log(`المشاكل المكتشفة: ${problems.length}`);
  for (const p of problems) console.log(`  - [${p.severity}] ${p.key}: ${p.title}`);

  let undelivered = 0;
  for (const p of problems) {
    // eslint-disable-next-line no-await-in-loop
    const delivered = await reportProblem(p);
    if (!delivered) undelivered += 1;
  }
  if (undelivered > 0) {
    // فشل تسليم كامل: لا Issue ولا تيليغرام. لا يجوز أن ينتهي التشغيل بنجاح
    // وإلا بقي العطل الإنتاجي مرئياً في السجل وحده.
    console.error(`✗✗ ${undelivered} مشكلة لم تصل عبر أي قناة تبليغ — يُفشَل التشغيل ليُلتقط بتنبيه الأتمتة.`);
    process.exitCode = 1;
  }

  await closeResolvedIssues({
    activeKeys: new Set(problems.map((p) => p.key)),
    healthyKeys,
    scanOk: recent.scanOk,
  });

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    const fs = await import("node:fs");
    const lines = [
      "## نتيجة فحص صحة المشروع",
      "",
      `- تم الفحص: ${new Date().toISOString()}`,
      `- عدد المشاكل المكتشفة: ${problems.length}`,
      ...problems.map((p) => `  - **${p.severity}** — ${p.title}`),
    ];
    fs.appendFileSync(summaryPath, lines.join("\n") + "\n");
  }

  // نقطة توسع مستقبلية: يمكن لخطوة لاحقة قراءة هذا المخرج (JSON) لبدء مسار
  // anomaly → diagnosis → Claude Code repair → tests → Codex review → merge
  // دون الحاجة لإعادة بناء هذا السكريبت من الصفر.
  const output = process.env.GITHUB_OUTPUT;
  if (output) {
    const fs = await import("node:fs");
    fs.appendFileSync(output, `problems_count=${problems.length}\n`);
  }
}

// يُنفَّذ main() فقط عند التشغيل المباشر — كي يتمكّن
// scripts/check-health-check-logic.mjs من استيراد الدوال النقية واختبارها
// بلا أي استدعاء لـgh أو للشبكة.
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main().catch(async (err) => {
    // ⚠️ انهيار المراقب نفسه هو أخطر حالة: لا فحص ولا تبليغ. كان الكود يفرض
    // exitCode = 0 فيُبلَّغ التشغيل كناجح، وalert-on-automation-failure.yml لم
    // يكن يراقب سير عمل health-check أصلاً — فيختفي الانهيار تماماً.
    // الآن: تنبيه احتياطي عبر القناة المستقلة، ثم إفشال التشغيل ليكون مرئياً.
    // إفشاله آمن: health-check مجدول فقط (cron) ولا يحجب أي نشر أو PR،
    // فالبند 5 ("لا يحجب أي عملية تشغيلية") يبقى محفوظاً.
    console.error("فشل سكريبت health-check:", err);
    try {
      await notifyTelegram(
        {
          key: "health-check-crashed",
          title: "انهار فحص صحة المشروع نفسه — لا مراقبة هذه الدورة",
          severity: "عالٍ",
        },
        null,
      );
    } catch (notifyErr) {
      console.error("وتعذّر أيضاً إرسال التنبيه الاحتياطي:", notifyErr);
    }
    process.exitCode = 1;
  });
}
