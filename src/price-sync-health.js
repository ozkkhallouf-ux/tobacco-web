// ============================================================================
// صحة مزامنة الأسعار (الموقع ← الأمين) — منطق نقي (Pure) بلا شبكة ولا DOM ولا كتابة.
//
// السبب (حادثة 2026-10-18): مهمة «TOBACCO Approved Prices Pull» عُطّلت أربع ساعات
// للصيانة، فبقي آخر صف «ok» في ameen_price_sync_status يتقادم بصمت، وعُدّلت أسعار
// في الموقع لم تصل للأمين، وصدرت فواتير بالأسعار القديمة. آخر نجاح قديم ليس دليلاً
// على أن المزامنة تعمل الآن.
//
// المدخلات صفوف الجدول المستقل `public.price_sync_heartbeats` (supabase/proposed/16) كما هي
// (received_at بساعة الخادم + summary). لا يكتبها إلا هوية المزامنة المعتمدة عبر الدالة
// record_price_sync_heartbeat، من tools/publish-price-sync-heartbeat.ps1 بنوعين:
//   • kind="attempt"     — نتيجة كل تشغيل لـ sync-approved-prices-to-ameen.ps1
//   • kind="task_probe"  — حالة المهمة المجدولة نفسها كما يراها Sync Watchdog
//                          (الطريق الوحيد لاكتشاف DISABLED، لأن المهمة المعطّلة لا تكتب شيئاً)
//
// قراءة الحالة لا تحتاج أي صلاحية على قاعدة الأمين: كل ما هنا يُقرأ من Supabase.
//
// الحالات الخمس:
//   HEALTHY  آخر محاولة حديثة ونجحت بإثبات (تطبيق + فحص مستقل بلا فروق، أو لا أسعار جديدة)
//   STALE    لا محاولة حديثة (المهمة لا تعمل أو الناشر لا يصل) — مهما كان آخر نجاح
//   FAILED   آخر محاولة حديثة فشلت أو لم تكتمل (اتصال الأمين، تطبيق، فحص، تعارض، معاينة فقط)
//   DISABLED المهمة معطّلة أو غير مسجّلة حسب فحص حديث للمهمة
//   UNKNOWN  لا بيانات، أو بيانات تالفة، أو ساعة مستقبلية
//
// التوثيق: docs/ai/topics/price-sync-heartbeat.md
// ============================================================================
(function () {
  "use strict";

  const VERSION = 1;
  const SOURCE = "ameen_price_sync_heartbeat";
  const SCHEMA = "price-sync-heartbeat/v1";
  const TIME_ZONE = "Asia/Damascus";

  const STATES = Object.freeze({
    HEALTHY: "HEALTHY",
    STALE: "STALE",
    FAILED: "FAILED",
    DISABLED: "DISABLED",
    UNKNOWN: "UNKNOWN"
  });

  // المهمة تعمل كل 5 دقائق. ثلاث دورات بلا محاولة = متوقفة.
  const THRESHOLDS = Object.freeze({
    taskIntervalMinutes: 5,
    staleAfterMinutes: 15,
    // فحص المهمة يُنشر كل 30 دقيقة حين تكون سليمة، وفوراً حين تتعطّل.
    probeFreshMinutes: 45,
    // هامش انحراف ساعة مقبول قبل اعتبار الطابع الزمني مستقبلياً.
    futureSkewMinutes: 5
  });

  // نتائج المحاولة الناجحة بإثبات.
  const SUCCESS_OUTCOMES = Object.freeze(["applied", "no_changes"]);
  // نتائج الفشل المعروفة ومعنى كل منها.
  const FAILURE_OUTCOMES = Object.freeze({
    pull_failed: "تعذّر سحب الأسعار من الموقع",
    ameen_unreachable: "تعذّر الاتصال بقاعدة الأمين",
    apply_failed: "فشل تطبيق الأسعار على الأمين",
    verify_failed: "تعذّر التحقق من الأسعار في الأمين",
    verify_mismatch: "أسعار الأمين لا تطابق الموقع",
    applied_with_conflicts: "طُبّقت الأسعار مع تعارض أو أصناف غير موجودة",
    preview_only: "المهمة تعمل بوضع المعاينة ولا تكتب في الأمين",
    unproven_success: "أُعلن نجاح بلا إثبات وصول الأسعار للأمين"
  });

  function toDate(value) {
    if (value === null || value === undefined || value === "") return null;
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function maxDate(...values) {
    let best = null;
    for (const value of values) {
      const date = toDate(value);
      if (date && (!best || date > best)) best = date;
    }
    return best;
  }

  function minutesBetween(later, earlier) {
    return (later.getTime() - earlier.getTime()) / 60000;
  }

  function toInt(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.trunc(number) : null;
  }

  function summaryOf(row) {
    if (!row || typeof row !== "object") return null;
    const summary = row.summary && typeof row.summary === "object" ? row.summary : row;
    if (summary.schema && summary.schema !== SCHEMA) return null;
    return summary;
  }

  // زمن الصف: received_at (ساعة الخادم في price_sync_heartbeats) هو المرجع حين يوجد، فلا يستطيع
  // العميل تقديم حداثة بطابع زمني يرسله؛ وإلا (summary مباشرة في الاختبارات) أحدث طابع متاح.
  function rowTime(row, ...summaryTimes) {
    const received = toDate(row && row.received_at);
    return received || maxDate(...summaryTimes, row && row.created_at);
  }

  // لا تتقدّم طوابع العميل على زمن الصف نفسه.
  function capAt(value, at) {
    const date = toDate(value);
    return date && date > at ? at : date;
  }

  // النجاح يعني وصول الأسعار للأمين: نفس شرط record_price_sync_heartbeat على الخادم.
  function provenSuccess(summary, verify) {
    const isZero = (value) => typeof value === "number" && value === 0;
    const zeroOrAbsent = (value) => value === undefined || value === null || isZero(value);
    return Boolean(summary.ameen_contact_at)
      && isZero(verify.mismatches) && isZero(verify.missing)
      && typeof summary.applied_wholesale === "number" && summary.applied_wholesale >= 1
      && zeroOrAbsent(summary.conflict_count) && zeroOrAbsent(summary.not_in_ameen);
  }

  // يحوّل صف price_sync_heartbeats (أو summary مباشرة) إلى محاولة موحّدة، أو null إن تلف.
  function normalizeAttempt(row) {
    const summary = summaryOf(row);
    if (!summary || summary.kind !== "attempt") return null;
    const at = rowTime(row, summary.attempt_finished_at, summary.attempt_started_at);
    if (!at || typeof summary.outcome !== "string" || !summary.outcome) return null;
    const verify = summary.verify && typeof summary.verify === "object" ? summary.verify : {};
    // «نجاح» بلا إثبات لا يُصدَّق أبداً: يُعامل فشلاً صريحاً.
    const unproven = SUCCESS_OUTCOMES.includes(summary.outcome) && !provenSuccess(summary, verify);
    return {
      at,
      outcome: unproven ? "unproven_success" : summary.outcome,
      stageFailed: summary.stage_failed || null,
      ameenContactAt: toDate(summary.ameen_contact_at),
      sentCount: toInt(summary.sent_count),
      appliedWholesale: toInt(summary.applied_wholesale),
      appliedRetail: toInt(summary.applied_retail),
      notInAmeen: toInt(summary.not_in_ameen) || 0,
      conflictCount: toInt(summary.conflict_count) || 0,
      mismatches: toInt(verify.mismatches),
      missing: toInt(verify.missing),
      pricesChanged: typeof summary.prices_changed === "boolean" ? summary.prices_changed : null,
      lastSuccessAt: unproven ? null : capAt(summary.last_success_at, at),
      lastFailureAt: capAt(summary.last_failure_at, at),
      message: typeof summary.message === "string" ? summary.message : "",
      host: typeof summary.host === "string" ? summary.host : ""
    };
  }

  function normalizeProbe(row) {
    const summary = summaryOf(row);
    if (!summary || summary.kind !== "task_probe") return null;
    const at = rowTime(row, summary.probed_at);
    const task = summary.task && typeof summary.task === "object" ? summary.task : null;
    if (!at || !task) return null;
    const state = typeof task.state === "string" ? task.state : "";
    return {
      at,
      exists: task.exists !== false,
      enabled: task.enabled !== false && state.toLowerCase() !== "disabled",
      state,
      lastRunAt: toDate(task.last_run_time),
      lastResult: toInt(task.last_result),
      host: typeof summary.host === "string" ? summary.host : ""
    };
  }

  function isSuccess(attempt) {
    return SUCCESS_OUTCOMES.includes(attempt.outcome);
  }

  function emptyHealth(state, reason, now) {
    return {
      version: VERSION,
      state,
      reason,
      checkedAt: now,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastAmeenContactAt: null,
      ageMinutes: null,
      outcome: null,
      counts: null,
      task: null,
      resumedAfter: null,
      warnings: []
    };
  }

  // rows: صفوف public.price_sync_heartbeats (proposed/16) بأي ترتيب وأي خليط من النوعين.
  function classifyPriceSyncHealth(rows, options = {}) {
    const now = toDate(options.now) || new Date();
    const thresholds = Object.assign({}, THRESHOLDS, options.thresholds || {});
    const list = Array.isArray(rows) ? rows : [];

    const attempts = list.map(normalizeAttempt).filter(Boolean).sort((a, b) => b.at - a.at);
    const probes = list.map(normalizeProbe).filter(Boolean).sort((a, b) => b.at - a.at);
    const warnings = [];
    const ignored = list.length - attempts.length - probes.length;
    if (ignored > 0) warnings.push(`ignored_rows:${ignored}`);

    if (!attempts.length && !probes.length) {
      const health = emptyHealth(STATES.UNKNOWN, list.length ? "unreadable_data" : "no_data", now);
      health.warnings = warnings;
      return health;
    }

    const futureLimit = new Date(now.getTime() + thresholds.futureSkewMinutes * 60000);
    const latest = attempts[0] || null;
    const probe = probes[0] || null;

    // آخر نجاح مثبت: من أي محاولة ناجحة، أو مما حمله الناشر من حالته المحلية.
    let lastSuccessAt = null;
    let lastFailureAt = null;
    for (const attempt of attempts) {
      if (isSuccess(attempt)) lastSuccessAt = maxDate(lastSuccessAt, attempt.at);
      else lastFailureAt = maxDate(lastFailureAt, attempt.at);
      lastSuccessAt = maxDate(lastSuccessAt, attempt.lastSuccessAt);
      lastFailureAt = maxDate(lastFailureAt, attempt.lastFailureAt);
    }
    const lastAmeenContactAt = maxDate(...attempts.map((attempt) => attempt.ameenContactAt));

    const health = emptyHealth(STATES.UNKNOWN, "", now);
    health.warnings = warnings;
    health.lastAttemptAt = latest ? latest.at : null;
    health.lastSuccessAt = lastSuccessAt;
    health.lastFailureAt = lastFailureAt;
    health.lastAmeenContactAt = lastAmeenContactAt;
    health.outcome = latest ? latest.outcome : null;
    health.ageMinutes = latest ? Math.max(0, Math.round(minutesBetween(now, latest.at))) : null;
    if (latest) {
      health.counts = {
        sent: latest.sentCount,
        appliedWholesale: latest.appliedWholesale,
        appliedRetail: latest.appliedRetail,
        notInAmeen: latest.notInAmeen,
        conflicts: latest.conflictCount,
        mismatches: latest.mismatches,
        missing: latest.missing,
        pricesChanged: latest.pricesChanged
      };
    }
    if (probe) {
      health.task = {
        probedAt: probe.at,
        exists: probe.exists,
        enabled: probe.enabled,
        state: probe.state,
        lastRunAt: probe.lastRunAt,
        lastResult: probe.lastResult
      };
    }

    if ((latest && latest.at > futureLimit) || (probe && probe.at > futureLimit)) {
      health.state = STATES.UNKNOWN;
      health.reason = "future_timestamp";
      return health;
    }

    // DISABLED يتقدّم على كل شيء: فحص حديث للمهمة يقول إنها معطّلة أو غير مسجّلة.
    const probeFresh = probe && minutesBetween(now, probe.at) <= thresholds.probeFreshMinutes;
    if (probeFresh && (!probe.exists || !probe.enabled)) {
      health.state = STATES.DISABLED;
      health.reason = probe.exists ? "task_disabled" : "task_missing";
      return health;
    }
    if (probe && !probeFresh) warnings.push("task_probe_stale");

    if (!latest) {
      health.state = STATES.UNKNOWN;
      health.reason = "no_attempts";
      return health;
    }

    if (minutesBetween(now, latest.at) > thresholds.staleAfterMinutes) {
      health.state = STATES.STALE;
      health.reason = "no_recent_attempt";
      return health;
    }

    if (isSuccess(latest)) {
      health.state = STATES.HEALTHY;
      health.reason = latest.outcome;
      // استئناف: نجاح حالي سبقه فشل، أو فجوة أطول من عتبة التوقف بين آخر محاولتين.
      const previous = attempts[1] || null;
      if (previous && (!isSuccess(previous) || minutesBetween(latest.at, previous.at) > thresholds.staleAfterMinutes)) {
        health.resumedAfter = {
          previousAttemptAt: previous.at,
          previousOutcome: previous.outcome,
          gapMinutes: Math.round(minutesBetween(latest.at, previous.at))
        };
      }
      return health;
    }

    if (Object.prototype.hasOwnProperty.call(FAILURE_OUTCOMES, latest.outcome)) {
      health.state = STATES.FAILED;
      health.reason = latest.outcome;
      return health;
    }

    health.state = STATES.UNKNOWN;
    health.reason = "unknown_outcome";
    return health;
  }

  const timeFormatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit", hour12: false
  });
  const dateFormatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit"
  });

  function damascusParts(value) {
    const date = toDate(value);
    if (!date) return null;
    const dateParts = Object.fromEntries(dateFormatter.formatToParts(date).map((part) => [part.type, part.value]));
    return { time: timeFormatter.format(date), date: `${dateParts.year}-${dateParts.month}-${dateParts.day}` };
  }

  // «HH:MM» بتوقيت دمشق، ويُضاف التاريخ إن لم يكن يوم `now` نفسه (بتوقيت دمشق).
  function formatDamascusTime(value, now) {
    const parts = damascusParts(value);
    if (!parts) return "—";
    const today = damascusParts(toDate(now) || new Date());
    return today && today.date === parts.date ? parts.time : `${parts.date} ${parts.time}`;
  }

  // وصف عربي مختصر للحالة — للشريط في صفحة الأسعار (المرحلة الثانية) وللبوت لاحقاً.
  function describePriceSyncHealth(health, options = {}) {
    if (!health) return { level: "unknown", icon: "❔", text: "حالة مزامنة الأسعار غير معروفة", detail: "" };
    const now = toDate(options.now) || toDate(health.checkedAt) || new Date();
    const at = (value) => formatDamascusTime(value, now);
    const since = health.lastSuccessAt ? at(health.lastSuccessAt) : null;

    switch (health.state) {
      case STATES.HEALTHY: {
        const detail = health.reason === "no_changes" ? "لا أسعار جديدة منذ آخر مزامنة" : "";
        const resumed = health.resumedAfter ? `عادت المزامنة بعد انقطاع ${health.resumedAfter.gapMinutes} دقيقة` : "";
        return { level: "ok", icon: "✅", text: `آخر وصول للأمين: ${at(health.lastSuccessAt || health.lastAttemptAt)}`, detail: [detail, resumed].filter(Boolean).join(" — ") };
      }
      case STATES.STALE:
        return {
          level: "warn",
          icon: "⚠️",
          text: since ? `المزامنة متوقفة منذ ${since}` : "المزامنة متوقفة",
          detail: health.lastAttemptAt ? `آخر محاولة: ${at(health.lastAttemptAt)}` : ""
        };
      case STATES.DISABLED:
        return {
          level: "error",
          icon: "⛔",
          text: health.reason === "task_missing" ? "مهمة مزامنة الأسعار غير مسجّلة على جهاز Windows" : "مهمة مزامنة الأسعار معطّلة",
          detail: since ? `آخر وصول للأمين: ${since}` : ""
        };
      case STATES.FAILED: {
        const counts = health.counts || {};
        let text = FAILURE_OUTCOMES[health.reason] || "فشلت آخر مزامنة";
        if (health.reason === "ameen_unreachable") text = "فشل آخر اتصال بالأمين";
        if (health.reason === "applied_with_conflicts") {
          const parts = [];
          if (counts.conflicts) parts.push(`تعارض في ${counts.conflicts} صنف`);
          if (counts.notInAmeen) parts.push(`${counts.notInAmeen} صنف غير موجود بالأمين`);
          if (parts.length) text = `طُبّقت الأسعار مع ${parts.join(" و")}`;
        }
        if (health.reason === "verify_mismatch") text = `أسعار الأمين لا تطابق الموقع (فروق: ${counts.mismatches ?? "؟"}، ناقص: ${counts.missing ?? "؟"})`;
        return { level: "error", icon: "❌", text, detail: since ? `آخر وصول مثبت للأمين: ${since}` : "لا يوجد وصول مثبت للأمين" };
      }
      default:
        return { level: "unknown", icon: "❔", text: "حالة مزامنة الأسعار غير معروفة", detail: health.reason === "no_data" ? "لا توجد بيانات نبض بعد" : "" };
    }
  }

  const api = Object.freeze({
    VERSION,
    SOURCE,
    SCHEMA,
    TIME_ZONE,
    STATES,
    THRESHOLDS,
    SUCCESS_OUTCOMES,
    FAILURE_OUTCOMES,
    normalizeAttempt,
    normalizeProbe,
    classifyPriceSyncHealth,
    formatDamascusTime,
    describePriceSyncHealth
  });

  if (typeof window !== "undefined") window.ozkPriceSyncHealth = api;
  if (typeof globalThis !== "undefined") globalThis.ozkPriceSyncHealth = api;
})();
