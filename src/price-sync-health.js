// ============================================================================
// حالة مزامنة الأسعار (الموقع → الأمين) — منطق نقي بلا شبكة ولا DOM ولا كتابة.
//
// المدخل آخر صف من public.price_sync_heartbeat (supabase/proposed/16-price-sync-heartbeat.sql)
// كما يعيده PostgREST. يكتب الصف tools/sync-approved-prices-to-ameen.ps1 في كل محاولة،
// والقيم last_* محسوبة على ساعة الخادم.
//
// المخرج واحدة من خمس حالات، ولا يُعدّ نجاح قديم دليلاً على أن المزامنة تعمل الآن:
//   HEALTHY  آخر محاولة حديثة ونجحت: تطبيق + تحقق مطابق + صفر تعارض.
//   STALE    لا محاولة منذ أكثر من staleAfterMinutes (المهمة لا تعمل، أو الجهاز مطفأ).
//   FAILED   آخر محاولة حديثة وفشلت: سحب، أو اتصال بالأمين، أو تحقق، أو فروق، أو تعارض.
//   DISABLED أبلغ طرف خارجي (الحارس أو إجراء صيانة) أن المهمة معطّلة أو موقوفة.
//   UNKNOWN  لا صف، أو صف لا يُقرأ، أو وقت في المستقبل.
//
// الأوقات تُعرض بتوقيت دمشق (Asia/Damascus). المستهلكون: شريط صفحة الأسعار
// (المرحلة 2) وأوامر Telegram لاحقاً. التوثيق: docs/ai/topics/price-sync-heartbeat.md
// ============================================================================
(function () {
  "use strict";

  const VERSION = 1;

  const CONFIG = Object.freeze({
    // المهمة كل 5 دقائق: ثلاث دورات فائتة = متوقفة.
    staleAfterMinutes: 15,
    // ساعة الجهاز القارئ قد تسبق الخادم قليلاً؛ أبعد من هذا = وقت غير موثوق.
    futureToleranceMinutes: 5,
    // توقف أطول من هذا ثم نجاح = «عادت المزامنة» (المرحلة 5 تبني عليه تقرير الفجوة).
    resumeGapMinutes: 15,
    // تعديل سعر أحدث من آخر تطبيق بأكثر من هذا = بانتظار الوصول للأمين.
    pendingGraceMinutes: 1,
    timeZone: "Asia/Damascus"
  });

  const STATES = Object.freeze({
    HEALTHY: "HEALTHY",
    STALE: "STALE",
    FAILED: "FAILED",
    DISABLED: "DISABLED",
    UNKNOWN: "UNKNOWN"
  });

  const FAILURE_STATUSES = new Set(["mismatch", "pull_failed", "apply_failed", "verify_failed"]);
  const EXTERNAL_STATUSES = new Set(["disabled", "paused"]);
  const KNOWN_STATUSES = new Set(["ok", ...FAILURE_STATUSES, ...EXTERNAL_STATUSES]);

  function toTime(value) {
    if (value === null || value === undefined || value === "") return null;
    const time = value instanceof Date ? value.getTime() : Date.parse(String(value));
    return Number.isFinite(time) ? time : null;
  }

  function toIso(time) {
    return time === null ? null : new Date(time).toISOString();
  }

  function toCount(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
  }

  function minutesBetween(fromTime, toTimeValue) {
    return Math.round(((toTimeValue - fromTime) / 60000) * 10) / 10;
  }

  function unknown(reason, nowTime) {
    return {
      version: VERSION,
      state: STATES.UNKNOWN,
      reason,
      status: null,
      checkedAt: toIso(nowTime),
      lastAttemptAt: null,
      ageMinutes: null,
      lastSuccessAt: null,
      lastAppliedAt: null,
      lastFailureAt: null,
      lastFailureStatus: null,
      ameenConnectedAt: null,
      newPrices: null,
      resumedAfterMinutes: null,
      pendingEdits: false,
      counts: null,
      message: ""
    };
  }

  // row: آخر صف من price_sync_heartbeat، أو null.
  // options.now: وقت القراءة (افتراضياً الآن).
  // options.latestPriceEditAt: أحدث approved_price_items.updated_at (اختياري).
  function classifyPriceSyncHealth(row, options = {}) {
    const config = { ...CONFIG, ...(options.config || {}) };
    const nowTime = toTime(options.now ?? new Date());
    if (nowTime === null) throw new TypeError("classifyPriceSyncHealth: options.now غير صالح");

    if (!row || typeof row !== "object") return unknown("no_data", nowTime);
    const status = typeof row.status === "string" ? row.status : null;
    if (!status || !KNOWN_STATUSES.has(status)) return unknown("unknown_status", nowTime);

    // وقت الخادم (created_at) هو المرجع، لا ساعة جهاز Windows.
    const attemptTime = toTime(row.created_at);
    if (attemptTime === null) return unknown("no_timestamp", nowTime);
    if (attemptTime - nowTime > config.futureToleranceMinutes * 60000) {
      return unknown("future_timestamp", nowTime);
    }

    const ageMinutes = Math.max(0, minutesBetween(attemptTime, nowTime));
    const lastSuccessTime = toTime(row.last_success_at);
    const lastAppliedTime = toTime(row.last_applied_at);
    const appliedFeedMax = toTime(row.applied_feed_max_updated_at);
    const latestEdit = toTime(options.latestPriceEditAt);
    const conflictCount = toCount(row.conflict_count);
    const gap = Number(row.gap_minutes);

    const counts = {
      pulled: toCount(row.pulled_count),
      appliedWholesale: toCount(row.applied_wholesale),
      appliedRetail: toCount(row.applied_retail),
      skipped: toCount(row.skipped_count),
      notFound: toCount(row.not_found_count),
      conflicts: conflictCount,
      verifiedWholesale: toCount(row.verified_wholesale),
      verifiedRetail: toCount(row.verified_retail),
      mismatches: toCount(row.mismatch_count),
      missing: toCount(row.missing_count)
    };

    let state;
    let reason;
    if (EXTERNAL_STATUSES.has(status)) {
      state = STATES.DISABLED;
      reason = status;
    } else if (ageMinutes > config.staleAfterMinutes) {
      // حتى لو كان آخر صف «ok»: نجاح قديم ليس دليلاً على عمل المزامنة الآن.
      state = STATES.STALE;
      reason = status === "ok" ? "no_recent_attempt" : `no_recent_attempt_after_${status}`;
    } else if (FAILURE_STATUSES.has(status)) {
      state = STATES.FAILED;
      reason = status;
    } else if (conflictCount > 0) {
      // التطبيق والتحقق نجحا، لكن أسعار الأصناف المتعارضة لم تُكتب في الأمين.
      state = STATES.FAILED;
      reason = "conflict";
    } else {
      state = STATES.HEALTHY;
      reason = row.new_prices === false ? "no_new_prices" : "applied";
    }

    // إشارة «عادت» عند أول نجاح بعد فجوة. تُحسب من صف الخادم نفسه.
    const resumedAfterMinutes = state === STATES.HEALTHY
      && Number.isFinite(gap) && gap > config.resumeGapMinutes ? gap : null;

    // تعديل في الموقع لم يدخل أي تطبيق بعد. أثناء HEALTHY هذا طبيعي حتى الدورة التالية.
    const pendingEdits = latestEdit !== null && (
      appliedFeedMax === null
        ? true
        : latestEdit - appliedFeedMax > config.pendingGraceMinutes * 60000
    );

    return {
      version: VERSION,
      state,
      reason,
      status,
      checkedAt: toIso(nowTime),
      lastAttemptAt: toIso(attemptTime),
      ageMinutes,
      lastSuccessAt: toIso(lastSuccessTime),
      lastAppliedAt: toIso(lastAppliedTime),
      lastFailureAt: toIso(toTime(row.last_failure_at)),
      lastFailureStatus: typeof row.last_failure_status === "string" ? row.last_failure_status : null,
      ameenConnectedAt: toIso(toTime(row.ameen_connected_at)),
      newPrices: typeof row.new_prices === "boolean" ? row.new_prices : null,
      resumedAfterMinutes,
      pendingEdits,
      counts,
      message: typeof row.message === "string" ? row.message : ""
    };
  }

  const damascusParts = (time, timeZone) => {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(new Date(time));
    const get = (type) => parts.find((part) => part.type === type)?.value ?? "";
    return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
  };

  // «11:34» إن كان اليوم نفسه بتوقيت دمشق، وإلا «17/10 11:34».
  function formatDamascusTime(value, options = {}) {
    const time = toTime(value);
    if (time === null) return "غير معروف";
    const timeZone = options.timeZone || CONFIG.timeZone;
    const at = damascusParts(time, timeZone);
    const clock = `${at.hour}:${at.minute}`;
    const nowTime = toTime(options.now ?? new Date());
    if (nowTime !== null) {
      const today = damascusParts(nowTime, timeZone);
      if (today.year === at.year && today.month === at.month && today.day === at.day) return clock;
      if (today.year !== at.year) return `${at.day}/${at.month}/${at.year} ${clock}`;
    }
    return `${at.day}/${at.month} ${clock}`;
  }

  const FAILURE_TITLES = Object.freeze({
    apply_failed: "❌ فشل آخر اتصال بالأمين",
    pull_failed: "❌ تعذّر سحب الأسعار من الموقع",
    verify_failed: "❌ تعذّر التحقق من أسعار الأمين",
    mismatch: "❌ الأسعار لم تصل كاملة للأمين",
    conflict: "❌ تعارض أسعار — لم تُكتب بعض الأصناف"
  });

  // نص عرض موحّد لشريط الصفحة وTelegram. tone: ok | warn | error | muted.
  function describePriceSyncHealth(health, options = {}) {
    const at = (value) => formatDamascusTime(value, options);
    const lastArrival = health.lastSuccessAt ? `آخر وصول للأمين: ${at(health.lastSuccessAt)}` : "لا وصول مثبت للأمين بعد";
    const pending = health.pendingEdits && health.state !== STATES.HEALTHY
      ? "يوجد تعديل أسعار بالموقع لم يصل للأمين — الكاشير يبيع بالسعر القديم"
      : "";
    const join = (...lines) => lines.filter(Boolean).join("\n");

    switch (health.state) {
      case STATES.HEALTHY: {
        const resumed = health.resumedAfterMinutes
          ? `عادت المزامنة بعد توقف ${Math.round(health.resumedAfterMinutes)} دقيقة — راجع الفواتير الصادرة أثناءه`
          : "";
        const idle = health.reason === "no_new_prices" ? "لا أسعار جديدة منذ آخر وصول" : "";
        return { tone: "ok", title: `✅ آخر وصول للأمين: ${at(health.lastSuccessAt)}`, detail: join(resumed, idle) };
      }
      case STATES.STALE:
        return {
          tone: "warn",
          title: `⚠️ المزامنة متوقفة منذ ${at(health.lastAttemptAt)}`,
          detail: join(lastArrival, pending)
        };
      case STATES.FAILED:
        return {
          tone: "error",
          title: FAILURE_TITLES[health.reason] || "❌ فشلت آخر مزامنة للأسعار",
          detail: join(
            health.reason === "mismatch" ? `فروق: ${health.counts.mismatches} — ناقصة: ${health.counts.missing}` : "",
            health.reason === "conflict" ? `أصناف متعارضة: ${health.counts.conflicts}` : "",
            `آخر محاولة: ${at(health.lastAttemptAt)}`,
            lastArrival,
            pending
          )
        };
      case STATES.DISABLED:
        return {
          tone: "warn",
          title: `${health.reason === "paused" ? "⏸ المزامنة موقوفة للصيانة" : "⛔ مهمة مزامنة الأسعار معطّلة"} منذ ${at(health.lastAttemptAt)}`,
          detail: join(health.message, lastArrival, pending)
        };
      default:
        return { tone: "muted", title: "❔ حالة مزامنة الأسعار غير معروفة", detail: "" };
    }
  }

  const api = Object.freeze({
    VERSION,
    CONFIG,
    STATES,
    classifyPriceSyncHealth,
    describePriceSyncHealth,
    formatDamascusTime
  });

  if (typeof window !== "undefined") window.ozkPriceSyncHealth = api;
  if (typeof globalThis !== "undefined") globalThis.ozkPriceSyncHealth = api;
})();
