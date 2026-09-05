// OZK Automatic iCloud Archive — عميل الموقع للجسر المحلي على الماك.
//
// المبدأ الحاكم: الأرشفة **ميزة مساعدة منفصلة تماماً** عن العملية التجارية.
// لا تُوقف تصديراً ولا طباعة ولا بيعاً، ولا تُغيّر أي منطق محاسبي. كل استدعاء
// هنا يُطلق ويُنسى (fire-and-forget) ولا يرمي أبداً: إن كان الجسر مطفأ أو
// الجهاز ليس ماك، يتابع الموقع تنزيله/طباعته المعتادة كما كان تماماً.
//
// الأمان: الرمز يُسحب مرة واحدة من الجسر نفسه (الذي يقبل أصولاً محددة فقط)
// ويُحفظ محلياً في هذا المتصفح. لا سر مكتوب داخل الكود ولا داخل المستودع.

(function () {
  "use strict";

  var BASE = "http://127.0.0.1:8787";
  var TOKEN_KEY = "ozk.archive.token";
  var ENABLED_KEY = "ozk.archive.enabled";
  var HEALTH_TTL_OK = 60000;      // نجاح: نثق بالنتيجة دقيقة كاملة
  var HEALTH_TTL_DOWN = 30000;    // فشل: نعيد المحاولة بعد نصف دقيقة لا أكثر
  var PROBE_TIMEOUT = 1500;
  var ARCHIVE_TIMEOUT = 45000;
  var NAG_INTERVAL = 10 * 60000;  // لا نزعج المستخدم بتنبيه الفشل أكثر من مرة/10د

  var healthCache = null;         // { at, value }
  var lastFailureNoticeAt = 0;
  var statusEl = null;

  // ===== تشخيص =====
  // كل التفاصيل التقنية تذهب إلى console وحدها. المستخدم لا يرى منها شيئاً —
  // يرى مؤشر حالة من كلمتين وتنبيهاً مقتضباً عند الفشل فقط.
  var trace = [];
  function diag(step, detail) {
    var entry = { at: new Date().toISOString(), step: step, detail: detail };
    trace.push(entry);
    if (trace.length > 60) trace.shift();
    try { console.info("[OZK Archive] " + step, detail === undefined ? "" : detail); } catch (e) { /* تجاهل */ }
  }

  function storageGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  function storageSet(key, value) {
    try { window.localStorage.setItem(key, value); } catch (e) { /* وضع خاص/ممتلئ */ }
  }
  function storageRemove(key) {
    try { window.localStorage.removeItem(key); } catch (e) { /* تجاهل */ }
  }

  function isEnabled() {
    return storageGet(ENABLED_KEY) !== "0";
  }

  function isHandheld() {
    try {
      if (typeof window.matchMedia !== "function") return false;
      return window.matchMedia("(pointer: coarse)").matches
        && window.matchMedia("(max-width: 900px)").matches;
    } catch (e) { return false; }
  }

  // الميزة تخص جهاز الماك وحده. البوابة هنا لا في مكان آخر كي لا يتغيّر أي شيء
  // على ويندوز أو الآيفون: لا طلب شبكي، ولا مؤشر حالة، ولا تنبيه.
  function isSupportedPlatform() {
    if (isHandheld()) return false;
    var platform = "";
    try {
      platform = (navigator.userAgentData && navigator.userAgentData.platform)
        || navigator.platform || "";
    } catch (e) { platform = ""; }
    if (/mac/i.test(platform)) return true;
    try { return /Macintosh/i.test(navigator.userAgent || ""); } catch (e) { return false; }
  }

  // أصل الصفحة داخل مجال العناوين المحلي نفسه الذي يسكنه الجسر؟
  function isLoopbackOrigin() {
    try {
      var host = window.location.hostname || "";
      return host === "127.0.0.1" || host === "localhost"
        || host === "::1" || host === "[::1]" || /\.localhost$/i.test(host);
    } catch (e) { return false; }
  }

  // هل يجوز إطلاق طلب **تلقائي** إلى الجسر من هذا الأصل؟
  //
  // قياس فعلي على https://ozktobacco.com (2026-09-06، Chromium): كل محاولة
  // وصول إلى الجسر تُخرج خطأين في وحدة التحكّم قبل أن تغادر الشبكة أصلاً —
  //   Access to fetch at 'http://127.0.0.1:8787/health' … has been blocked by
  //   CORS policy: Permission was denied for this request to access the
  //   `loopback` address space.
  //   Failed to load resource: net::ERR_FAILED
  // فكروم يحجب مخاطبة مجال العناوين المحلي من أصل عام (Private Network Access)
  // ما لم يمنح المستخدم إذناً صريحاً. الحجب حالة إعداد ثابتة لا عطل عابر،
  // فإعادة المحاولة عند كل إقلاع وكل تصدير ضجيج خالص يغرق أخطاء حقيقية.
  //
  // البوابة تفتح في ثلاث حالات كلها دليل إيجابي لا تخمين:
  //   ١) الصفحة نفسها على أصل محلي (`com.ozk.local-site` على 127.0.0.1:5173) —
  //      نفس مجال العناوين فلا بوابة PNA أصلاً. وهو المسار المعتمد على الماك،
  //      فالجسر يعمل هناك تماماً كما كان بلا أي تغيير.
  //   ٢) المالك فعّلها صراحةً على هذا المتصفح: `ozkArchive.enable()`.
  //   ٣) رمز ربط محفوظ من هذا الأصل — أي أن /pair نجح فعلاً من هنا سابقاً.
  function mayReachBridge() {
    if (isLoopbackOrigin()) return true;
    if (storageGet(ENABLED_KEY) === "1") return true;
    return Boolean(storageGet(TOKEN_KEY));
  }

  function withTimeout(ms) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, ms);
    return { signal: controller.signal, clear: function () { clearTimeout(timer); } };
  }

  async function request(path, options) {
    var opts = options || {};
    var guard = withTimeout(opts.timeout || PROBE_TIMEOUT);
    var startedAt = Date.now();
    try {
      var response = await fetch(BASE + path, {
        method: opts.method || "GET",
        headers: opts.headers || undefined,
        body: opts.body || undefined,
        mode: "cors",
        cache: "no-store",
        credentials: "omit",
        signal: guard.signal
      });
      var data = null;
      try { data = await response.json(); } catch (e) { data = null; }
      diag("طلب " + path, { status: response.status, ms: Date.now() - startedAt });
      return { status: response.status, ok: response.ok, data: data };
    } catch (error) {
      // ملاحظة تشخيصية مهمة: المتصفح لا يفرّق في رسالة JS بين «الجسر مطفأ»
      // و«المتصفح حجب الطلب قبل الشبكة». الفاصل القاطع هو سجل الجسر: إن ظهر
      // فيه استلام /health بنفس اللحظة فالطلب خرج فعلاً، وإلا فقد حُجب محلياً.
      diag("فشل طلب " + path, {
        ms: Date.now() - startedAt,
        name: error && error.name,
        message: error && error.message,
        note: "راجع ~/OZK-Archive-Bridge/logs — إن لم يُسجَّل الطلب فقد حجبه المتصفح قبل الشبكة"
      });
      throw error;
    } finally {
      guard.clear();
    }
  }

  // فحص التوفّر مع ذاكرة قصيرة: يمنع طلباً على 127.0.0.1 مع كل ضغطة تصدير،
  // ويمنع الانتظار الطويل على الأجهزة التي لا جسر فيها.
  async function probe(force) {
    var now = Date.now();
    if (!force && healthCache) {
      var ttl = healthCache.value && healthCache.value.ok ? HEALTH_TTL_OK : HEALTH_TTL_DOWN;
      if (now - healthCache.at < ttl) return healthCache.value;
    }
    if (!mayReachBridge()) {
      // خامل: لا طلب، فلا خطأ في وحدة التحكّم. الشارة تُبلّغ المالك بالحالة.
      var dormant = { ok: false, reason: "needs_opt_in" };
      healthCache = { at: now, value: dormant };
      diag("خامل — أصل عام بلا تفعيل صريح، فلا طلب شبكي");
      renderStatus(dormant);
      return dormant;
    }
    var value;
    try {
      var res = await request("/health", { timeout: PROBE_TIMEOUT });
      value = (res.ok && res.data && res.data.ok)
        ? { ok: true, health: res.data }
        : { ok: false, reason: "bad_response" };
    } catch (e) {
      value = { ok: false, reason: "unreachable" };
    }
    healthCache = { at: now, value: value };
    renderStatus(value);
    return value;
  }

  async function fetchToken(force) {
    if (!force) {
      var cached = storageGet(TOKEN_KEY);
      if (cached) { diag("رمز محفوظ مسبقاً"); return cached; }
    }
    try {
      var res = await request("/pair", { timeout: PROBE_TIMEOUT });
      if (res.ok && res.data && res.data.token) {
        storageSet(TOKEN_KEY, res.data.token);
        diag("نجح الربط /pair");
        return res.data.token;
      }
      diag("فشل الربط /pair", { status: res.status });
    } catch (e) {
      diag("تعذّر الوصول إلى /pair");
    }
    return null;
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var result = String(reader.result || "");
        var comma = result.indexOf(",");
        resolve(comma >= 0 ? result.slice(comma + 1) : "");
      };
      reader.onerror = function () { reject(new Error("تعذّر قراءة ملف PDF")); };
      reader.readAsDataURL(blob);
    });
  }

  async function post(token, payload) {
    return request("/archive", {
      method: "POST",
      timeout: ARCHIVE_TIMEOUT,
      headers: { "Content-Type": "application/json", "X-OZK-Archive-Token": token },
      body: JSON.stringify(payload)
    });
  }

  /**
   * يحفظ نسخة من المستند في iCloud Drive عبر الجسر المحلي.
   * لا يرمي أبداً. يرجع { ok, status?, file?, reason? }.
   *
   * @param {{docType:string, html?:string, pdfBlob?:Blob, meta?:object, quiet?:boolean}} input
   */
  async function archive(input) {
    var options = input || {};
    if (!isEnabled()) { diag("الأرشفة موقوفة من هذا المتصفح"); return { ok: false, reason: "disabled" }; }
    if (!isSupportedPlatform()) { diag("جهاز غير مدعوم — تخطّي"); return { ok: false, reason: "unsupported_platform" }; }
    if (!options.docType) return { ok: false, reason: "no_doc_type" };
    if (!options.html && !options.pdfBlob) return { ok: false, reason: "no_content" };

    diag("بدء أرشفة", { docType: options.docType, meta: options.meta });
    try {
      var health = await probe(false);
      if (!health.ok) {
        diag("الجسر غير متاح", { reason: health.reason });
        notifyFailure(unreachableMessage(health.reason), options.quiet);
        return { ok: false, reason: health.reason || "unavailable" };
      }
      if (health.health && health.health.icloud && !health.health.icloud.ready) {
        diag("مجلدات iCloud ناقصة", health.health.icloud.missingFolders);
        notifyFailure("مجلدات iCloud غير مكتملة — لم تُحفظ نسخة.", options.quiet);
        return { ok: false, reason: "icloud_not_ready" };
      }

      var payload = {
        docType: options.docType,
        baseUrl: window.location.origin + "/",
        meta: options.meta || {}
      };
      if (options.pdfBlob) payload.pdfBase64 = await blobToBase64(options.pdfBlob);
      else payload.html = String(options.html);

      var token = await fetchToken(false);
      if (!token) {
        notifyFailure(unreachableMessage("unreachable"), options.quiet);
        return { ok: false, reason: "no_token" };
      }

      var res = await post(token, payload);
      if (res.status === 401) {
        // الرمز تغيّر (أُعيد توليده بعد حذف الملف مثلاً) — أعد الربط مرة واحدة.
        diag("رمز مرفوض — إعادة ربط");
        storageRemove(TOKEN_KEY);
        var fresh = await fetchToken(true);
        if (fresh) res = await post(fresh, payload);
      }

      if (res.ok && res.data && res.data.ok) {
        diag("تمت الأرشفة", { status: res.data.status, folder: res.data.folder, file: res.data.file });
        if (!options.quiet) {
          toast(res.data.status === "duplicate"
            ? "النسخة موجودة مسبقاً في iCloud Drive"
            : "تم حفظ نسخة في iCloud Drive", "ok");
        }
        return { ok: true, status: res.data.status, folder: res.data.folder, file: res.data.file };
      }

      var message = (res.data && res.data.error) ? res.data.error : "تعذّر حفظ النسخة في iCloud.";
      diag("رفض الجسر الطلب", { status: res.status, error: message });
      notifyFailure(message, options.quiet);
      return { ok: false, reason: (res.data && res.data.code) || "failed", error: message };
    } catch (error) {
      diag("خطأ غير متوقع", { message: error && error.message });
      notifyFailure("تعذّر حفظ نسخة في iCloud.", options.quiet);
      return { ok: false, reason: "exception" };
    }
  }

  // من صفحة https لا يكفي أن يعمل الجسر: المتصفحات الحديثة تحجب مخاطبة عناوين
  // الشبكة المحلية خلف إذن صريح. قياس فعلي (2026-08-31): الطلب نفسه فشل بلا
  // إذن ونجح بـ200 فور منحه. لذا لا نقول «الجسر غير متاح» ونحن لا نعرف — نذكر
  // السببين معاً كي لا يطارد المالك عطلاً غير موجود.
  function unreachableMessage(reason) {
    var onHttps = false;
    try { onHttps = window.location.protocol === "https:"; } catch (e) { onHttps = false; }
    if (reason === "needs_opt_in") {
      return "أرشفة iCloud غير مفعّلة على هذا العنوان. نفّذ ozkArchive.enable() مرة واحدة من وحدة التحكّم واسمح بالوصول إلى الشبكة المحلية.";
    }
    if (reason === "unreachable" && onHttps) {
      return "تعذّر حفظ نسخة في iCloud. تأكد أن الجسر يعمل، واسمح للموقع بالوصول إلى الشبكة المحلية عند طلب المتصفح.";
    }
    return "تعذّر حفظ نسخة في iCloud (الجسر المحلي غير متاح).";
  }

  // تنبيه الفشل مكتوم ومحدود: الأرشفة ليست جزءاً من العملية التجارية، فلا يجوز
  // أن تُغرق المالك بالرسائل كلما كان الجسر متوقفاً.
  function notifyFailure(message, quiet) {
    if (quiet) return;
    var now = Date.now();
    if (now - lastFailureNoticeAt < NAG_INTERVAL) return;
    lastFailureNoticeAt = now;
    toast(message, "warn");
  }

  function toast(message, kind) {
    if (typeof document === "undefined" || !document.body) return;
    var existing = document.querySelector("[data-ozk-archive-toast]");
    if (existing) existing.remove();
    var box = document.createElement("div");
    box.setAttribute("data-ozk-archive-toast", "");
    box.setAttribute("role", "status");
    box.dir = "rtl";
    box.textContent = message;
    box.style.cssText = [
      "position:fixed", "inset-inline-start:16px", "bottom:52px", "z-index:99999",
      "max-width:min(420px,86vw)", "padding:10px 14px", "border-radius:10px",
      "font:600 0.9rem/1.5 Tahoma,Arial,sans-serif", "color:#fff",
      "box-shadow:0 8px 24px rgba(0,0,0,.35)", "pointer-events:none",
      "background:" + (kind === "ok" ? "#1c6b3a" : "#8a5a10")
    ].join(";");
    document.body.appendChild(box);
    setTimeout(function () { box.remove(); }, 3600);
  }

  // ===== مؤشر الحالة =====
  // شارة صغيرة هادئة أسفل الشاشة تخبر المالك بحالة الأرشفة **قبل** التصدير،
  // بلا أي تفصيل تقني. تظهر على الماك وحده فلا يراها مستخدم ويندوز أو الآيفون.
  function renderStatus(value) {
    if (typeof document === "undefined" || !document.body) return;
    if (!isSupportedPlatform() || !isEnabled()) {
      if (statusEl) { statusEl.remove(); statusEl = null; }
      return;
    }
    var connected = Boolean(value && value.ok);
    // التفريق ضروري: «غير متصلة» تعني حاولنا وفشلنا، و«غير مفعّلة» تعني لم
    // نحاول أصلاً — ولو خُلطتا لطارد المالك عطلاً في جسرٍ يعمل.
    var dormant = !connected && Boolean(value && value.reason === "needs_opt_in");
    if (!statusEl || !statusEl.isConnected) {
      statusEl = document.createElement("div");
      statusEl.setAttribute("data-ozk-archive-status", "");
      statusEl.dir = "rtl";
      statusEl.style.cssText = [
        "position:fixed", "inset-inline-start:16px", "bottom:14px", "z-index:99998",
        "display:flex", "align-items:center", "gap:6px",
        "padding:4px 9px", "border-radius:999px",
        "font:600 11px/1.6 Tahoma,Arial,sans-serif",
        "pointer-events:none", "user-select:none", "opacity:.72",
        "background:rgba(20,16,10,.72)", "color:#efe7d8",
        "border:1px solid rgba(255,255,255,.12)"
      ].join(";");
      document.body.appendChild(statusEl);
    }
    statusEl.textContent = "";
    var dot = document.createElement("span");
    dot.style.cssText = "width:7px;height:7px;border-radius:50%;flex:0 0 auto;background:"
      + (connected ? "#3ecf7a" : "#b98b3a");
    var label = document.createElement("span");
    label.textContent = "أرشفة iCloud: " + (connected ? "متصلة" : (dormant ? "غير مفعّلة" : "غير متصلة"));
    statusEl.appendChild(dot);
    statusEl.appendChild(label);
  }

  /**
   * تشخيص كامل بخطوة واحدة — للدعم لا للمستخدم العادي.
   * يجيب: هل المنصة مدعومة؟ هل /health يصل؟ هل /pair ينجح؟ وأين توقّف بالضبط.
   */
  async function diagnose() {
    var report = {
      platformSupported: isSupportedPlatform(),
      enabled: isEnabled(),
      pageOrigin: window.location.origin,
      pageProtocol: window.location.protocol,
      bridgeBase: BASE,
      hasStoredToken: Boolean(storageGet(TOKEN_KEY))
    };
    try {
      var h = await request("/health", { timeout: 3000 });
      report.health = { reached: true, status: h.status, body: h.data };
    } catch (e) {
      report.health = { reached: false, error: String(e && e.message) };
    }
    try {
      var p = await request("/pair", { timeout: 3000 });
      report.pair = { reached: true, status: p.status, gotToken: Boolean(p.data && p.data.token) };
    } catch (e) {
      report.pair = { reached: false, error: String(e && e.message) };
    }
    report.verdict = report.health.reached
      ? (report.health.status === 200 ? "الجسر متاح" : "الجسر يرد لكنه رفض الطلب")
      : "لم يصل أي طلب — راجع سجل الجسر للتفريق بين إطفائه وحجب المتصفح للطلب";
    try { console.info("[OZK Archive] تشخيص", report); } catch (e) { /* تجاهل */ }
    return report;
  }

  window.ozkArchive = {
    archive: archive,
    probe: probe,
    diagnose: diagnose,
    trace: function () { return trace.slice(); },
    isEnabled: isEnabled,
    isSupportedPlatform: isSupportedPlatform,
    mayReachBridge: mayReachBridge,
    // تفعيل صريح: يفتح بوابة الأصل العام ويُطلق طلباً حقيقياً — وهو ما يُظهر
    // طلب إذن «الوصول إلى الشبكة المحلية» في كروم.
    enable: function () { storageSet(ENABLED_KEY, "1"); healthCache = null; probe(true); },
    disable: function () { storageSet(ENABLED_KEY, "0"); renderStatus(null); },
    reset: function () { storageRemove(TOKEN_KEY); healthCache = null; },
    base: BASE
  };

  // فحص أولي واحد عند التحميل كي يعرف المالك الحالة **قبل** أن يضغط تصدير.
  // على غير الماك لا يُرسل أي طلب إطلاقاً.
  function boot() {
    diag("تحمّل العميل", { origin: window.location.origin, supported: isSupportedPlatform() });
    if (!isSupportedPlatform() || !isEnabled()) return;
    probe(true).catch(function () { /* probe لا يرمي أصلاً */ });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
