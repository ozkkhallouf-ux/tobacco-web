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
  if (site.ok) healthy.push("site-unreachable");
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
export const FAILURE_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "action_required"]);

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
  if (FAILURE_CONCLUSIONS.has(last.conclusion)) {
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
  // نجاح مؤكَّد (أو skipped المقصود): هذا هو الدليل الإيجابي الوحيد المقبول للإغلاق.
  return { problems: [], healthy: [key], unknown: false };
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
    .filter((r) => r && !excludedNames.has(r.workflowName) && new Date(r.createdAt).getTime() >= sinceMs)
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
      "--status", "failure",
      // الاستثناء وفلترة الزمن يجريان في الذاكرة بعد هذا الحد، فلو بقي الحد
      // منخفضاً امتلأت الدفعة بتشغيلات Codex Review Gate المستثناة وأزاحت
      // الإخفاقات الحقيقية خارج النافذة.
      "--limit", "100",
      "--json", "workflowName,headBranch,url,createdAt,displayTitle",
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

async function notifyTelegram(problem, issueUrl) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !serviceKey) {
    console.log("⚠️ تخطي إشعار تيليغرام: SUPABASE_URL أو SUPABASE_SERVICE_KEY غير مضبوطين كسر GitHub Actions.");
    return;
  }
  const message = `🩺 مشكلة اكتشفتها المراقبة الآلية\nالاسم: ${problem.title}\nالخطورة: ${problem.severity}\nرابط: ${issueUrl}`;
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
        p_dedupe_key: `health-${problem.key}`,
        p_dedupe_minutes: 180,
      }),
    });
    if (!res.ok) {
      console.log(`⚠️ فشل استدعاء notify_telegram: HTTP ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    console.log(`⚠️ فشل استدعاء notify_telegram: ${err}`);
  }
}

async function reportProblem(problem) {
  const existing = findOpenIssueForKey(problem.key);
  if (existing) {
    console.log(`= مشكلة "${problem.key}" مفتوحة أصلاً بالـIssue #${existing.number} — لا تكرار.`);
    return;
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
    console.log(`✗ فشل إنشاء Issue لمشكلة "${problem.key}": ${err}`);
    return;
  }
  console.log(`✓ أُنشئ Issue جديد لمشكلة "${problem.key}": ${issueUrl}`);
  // حدّث الكاش المحلي فوراً كي لا يُنشأ Issue مكرر لنفس المشكلة إن ظهرت مرتين بنفس التشغيل.
  if (_openHealthIssuesCache) {
    _openHealthIssuesCache.push({ number: 0, title: problem.title, body: `<!-- health:${problem.key} -->` });
  }
  await notifyTelegram(problem, issueUrl);
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
export function decideIssuesToClose({ openIssues, activeKeys, healthyKeys, healthyPrefixes = [] }) {
  const active = activeKeys instanceof Set ? activeKeys : new Set(activeKeys || []);
  const healthy = healthyKeys instanceof Set ? healthyKeys : new Set(healthyKeys || []);
  const out = [];
  for (const issue of openIssues || []) {
    const match = issue.body && issue.body.match(/<!-- health:([^>]+) -->/);
    if (!match) continue;
    const key = match[1];
    if (active.has(key)) continue;                 // ما تزال قائمة
    const verified = healthy.has(key) || healthyPrefixes.some((p) => key.startsWith(p));
    if (!verified) continue;                       // مجهولة → تبقى مفتوحة
    out.push({ number: issue.number, key });
  }
  return out;
}

function closeResolvedIssues({ activeKeys, healthyKeys, healthyPrefixes }) {
  const openIssues = listAllOpenHealthIssues();
  const toClose = decideIssuesToClose({ openIssues, activeKeys, healthyKeys, healthyPrefixes });
  for (const { number: issueNumber, key } of toClose) {
    const issue = { number: issueNumber };
    try {
      gh([
        "issue", "comment", String(issue.number),
        "--repo", REPO,
        "--body", "✅ تم التحقق بنتيجة إيجابية صريحة (تشغيل مكتمل ناجح أو مسح ناجح لم يجد الحادثة) — يُغلق الـIssue تلقائياً.",
      ]);
      gh(["issue", "close", String(issue.number), "--repo", REPO]);
      console.log(`✓ أُغلق Issue #${issue.number} (مشكلة "${key}" تأكّد زوالها).`);
    } catch (err) {
      console.log(`✗ فشل إغلاق Issue #${issue.number}: ${err}`);
    }
  }
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
  // مسح ناجح للتشغيلات الفاشلة يُثبت زوال أي حادثة workflow-failure-* لم يجدها.
  const healthyPrefixes = recent.scanOk ? ["workflow-failure-"] : [];
  if (recent.scanOk) healthyKeys.add("workflow-scan-failed");

  console.log(`المشاكل المكتشفة: ${problems.length}`);
  for (const p of problems) console.log(`  - [${p.severity}] ${p.key}: ${p.title}`);

  for (const p of problems) {
    // eslint-disable-next-line no-await-in-loop
    await reportProblem(p);
  }

  closeResolvedIssues({
    activeKeys: new Set(problems.map((p) => p.key)),
    healthyKeys,
    healthyPrefixes,
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
  main().catch((err) => {
    console.error("فشل سكريبت health-check:", err);
    // لا نفشل التشغيل بكود خطأ كي لا يتحول فحص المراقبة نفسه إلى عائق تشغيلي (البند 5).
    process.exitCode = 0;
  });
}
