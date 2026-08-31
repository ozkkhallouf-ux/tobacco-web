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

  function withTimeout(ms) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, ms);
    return { signal: controller.signal, clear: function () { clearTimeout(timer); } };
  }

  async function request(path, options) {
    var opts = options || {};
    var guard = withTimeout(opts.timeout || PROBE_TIMEOUT);
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
      return { status: response.status, ok: response.ok, data: data };
    } finally {
      guard.clear();
    }
  }

  // فحص التوفّر مع ذاكرة قصيرة: يمنع طلباً على 127.0.0.1 مع كل ضغطة تصدير،
  // ويمنع الانتظار الطويل على الأجهزة التي لا جسر فيها (آيفون مثلاً).
  async function probe(force) {
    var now = Date.now();
    if (!force && healthCache) {
      var ttl = healthCache.value && healthCache.value.ok ? HEALTH_TTL_OK : HEALTH_TTL_DOWN;
      if (now - healthCache.at < ttl) return healthCache.value;
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
    return value;
  }

  async function fetchToken(force) {
    if (!force) {
      var cached = storageGet(TOKEN_KEY);
      if (cached) return cached;
    }
    var res = await request("/pair", { timeout: PROBE_TIMEOUT });
    if (res.ok && res.data && res.data.token) {
      storageSet(TOKEN_KEY, res.data.token);
      return res.data.token;
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
    if (!isEnabled()) return { ok: false, reason: "disabled" };
    if (!options.docType) return { ok: false, reason: "no_doc_type" };
    if (!options.html && !options.pdfBlob) return { ok: false, reason: "no_content" };

    try {
      var health = await probe(false);
      if (!health.ok) {
        notifyFailure(unreachableMessage(health.reason), options.quiet);
        return { ok: false, reason: health.reason || "unavailable" };
      }
      if (health.health && health.health.icloud && !health.health.icloud.ready) {
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
        notifyFailure("تعذّر الاتصال بجسر الأرشفة.", options.quiet);
        return { ok: false, reason: "no_token" };
      }

      var res = await post(token, payload);
      if (res.status === 401) {
        // الرمز تغيّر (أُعيد توليده بعد حذف الملف مثلاً) — أعد الربط مرة واحدة.
        storageRemove(TOKEN_KEY);
        var fresh = await fetchToken(true);
        if (fresh) res = await post(fresh, payload);
      }

      if (res.ok && res.data && res.data.ok) {
        if (!options.quiet) {
          toast(res.data.status === "duplicate"
            ? "النسخة موجودة مسبقاً في iCloud Drive"
            : "تم حفظ نسخة في iCloud Drive", "ok");
        }
        return { ok: true, status: res.data.status, folder: res.data.folder, file: res.data.file };
      }

      var message = (res.data && res.data.error) ? res.data.error : "تعذّر حفظ النسخة في iCloud.";
      notifyFailure(message, options.quiet);
      return { ok: false, reason: (res.data && res.data.code) || "failed", error: message };
    } catch (error) {
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
    if (reason === "unreachable" && onHttps) {
      return "تعذّر حفظ نسخة في iCloud. تأكد أن الجسر يعمل، واسمح للموقع بالوصول إلى الشبكة المحلية عند طلب المتصفح.";
    }
    return "تعذّر حفظ نسخة في iCloud (الجسر المحلي غير متاح).";
  }

  // تنبيه الفشل مكتوم ومحدود: الأرشفة ليست جزءاً من العملية التجارية، فلا يجوز
  // أن تُغرق المالك بالرسائل كلما كان الماك مطفأً أو الجسر متوقفاً.
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
      "position:fixed", "inset-inline-start:16px", "bottom:16px", "z-index:99999",
      "max-width:min(420px,86vw)", "padding:10px 14px", "border-radius:10px",
      "font:600 0.9rem/1.5 Tahoma,Arial,sans-serif", "color:#fff",
      "box-shadow:0 8px 24px rgba(0,0,0,.35)", "pointer-events:none",
      "background:" + (kind === "ok" ? "#1c6b3a" : "#8a5a10")
    ].join(";");
    document.body.appendChild(box);
    setTimeout(function () { box.remove(); }, 3600);
  }

  window.ozkArchive = {
    archive: archive,
    probe: probe,
    isEnabled: isEnabled,
    enable: function () { storageRemove(ENABLED_KEY); healthCache = null; },
    disable: function () { storageSet(ENABLED_KEY, "0"); },
    reset: function () { storageRemove(TOKEN_KEY); healthCache = null; },
    base: BASE
  };
})();
