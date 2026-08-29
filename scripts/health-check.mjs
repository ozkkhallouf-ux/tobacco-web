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
  const site = await fetchStatus(SITE_URL);
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
  }
  return problems;
}

function checkLatestWorkflowRun(workflowName, key, severity) {
  let runs;
  try {
    runs = ghJSON([
      "run", "list",
      "--repo", REPO,
      "--workflow", workflowName,
      "--branch", "main",
      "--limit", "1",
      "--json", "conclusion,status,url,createdAt",
    ]);
  } catch (err) {
    return [{
      key: `${key}-lookup-failed`,
      title: `تعذّر فحص حالة سير العمل "${workflowName}"`,
      severity: "منخفض",
      details: String(err.message || err),
    }];
  }
  if (!runs.length) return [];
  const last = runs[0];
  if (last.status === "completed" && last.conclusion && last.conclusion !== "success") {
    return [{
      key,
      title: `آخر تشغيل لسير العمل "${workflowName}" فشل (${last.conclusion})`,
      severity,
      details: `${last.url} — ${last.createdAt}`,
    }];
  }
  return [];
}

function checkRecentWorkflowFailures() {
  const since = new Date(Date.now() - LOOKBACK_MINUTES * 60 * 1000);
  let runs;
  try {
    runs = ghJSON([
      "run", "list",
      "--repo", REPO,
      "--branch", "main",
      "--status", "failure",
      "--limit", "30",
      "--json", "workflowName,url,createdAt,displayTitle",
    ]);
  } catch {
    return [];
  }
  const recentFailures = runs.filter((r) => {
    if (EXCLUDED_WORKFLOW_NAMES.has(r.workflowName)) return false;
    return new Date(r.createdAt) >= since;
  });
  return recentFailures.map((r) => ({
    key: `workflow-failure-${r.workflowName}`,
    title: `تشغيل فاشل حديث لسير العمل "${r.workflowName}"`,
    severity: "متوسط",
    details: `${r.displayTitle} — ${r.url} — ${r.createdAt}`,
  }));
}

function dedupeByKey(problems) {
  const seen = new Map();
  for (const p of problems) seen.set(p.key, p);
  return [...seen.values()];
}

function findOpenIssueForKey(key) {
  const marker = `health:${key}`;
  let issues;
  try {
    issues = ghJSON([
      "issue", "list",
      "--repo", REPO,
      "--label", LABEL,
      "--state", "open",
      "--search", marker,
      "--json", "number,title,body",
      "--limit", "20",
    ]);
  } catch {
    return null;
  }
  return issues.find((i) => i.body && i.body.includes(`<!-- ${marker} -->`)) || null;
}

function listAllOpenHealthIssues() {
  try {
    return ghJSON([
      "issue", "list",
      "--repo", REPO,
      "--label", LABEL,
      "--state", "open",
      "--json", "number,title,body",
      "--limit", "50",
    ]);
  } catch {
    return [];
  }
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
  await notifyTelegram(problem, issueUrl);
}

function closeResolvedIssues(activeKeys) {
  const openIssues = listAllOpenHealthIssues();
  for (const issue of openIssues) {
    const match = issue.body && issue.body.match(/<!-- health:([^>]+) -->/);
    if (!match) continue;
    const key = match[1];
    if (activeKeys.has(key)) continue;
    try {
      gh([
        "issue", "comment", String(issue.number),
        "--repo", REPO,
        "--body", "✅ تم التحقق: المشكلة لم تعد مكتشَفة في آخر فحص آلي — يُغلق الـIssue تلقائياً.",
      ]);
      gh(["issue", "close", String(issue.number), "--repo", REPO]);
      console.log(`✓ أُغلق Issue #${issue.number} (مشكلة "${key}" لم تعد قائمة).`);
    } catch (err) {
      console.log(`✗ فشل إغلاق Issue #${issue.number}: ${err}`);
    }
  }
}

async function main() {
  ensureLabel();

  const problems = dedupeByKey([
    ...(await checkSiteReachability()),
    ...checkLatestWorkflowRun("توليد نشرات الأسعار", "price-generation-failed", "عالٍ"),
    ...checkLatestWorkflowRun("Deploy TOBACCO Web", "deploy-failed", "عالٍ"),
    ...checkRecentWorkflowFailures(),
  ]);

  console.log(`المشاكل المكتشفة: ${problems.length}`);
  for (const p of problems) console.log(`  - [${p.severity}] ${p.key}: ${p.title}`);

  for (const p of problems) {
    // eslint-disable-next-line no-await-in-loop
    await reportProblem(p);
  }

  closeResolvedIssues(new Set(problems.map((p) => p.key)));

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

main().catch((err) => {
  console.error("فشل سكريبت health-check:", err);
  // لا نفشل التشغيل بكود خطأ كي لا يتحول فحص المراقبة نفسه إلى عائق تشغيلي (البند 5).
  process.exitCode = 0;
});
