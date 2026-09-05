// ============================================================================
// مراقبة أخطاء الإنتاج — إرسال إلى Rollbar عبر Item API مباشرةً.
//
// لماذا لا حزمة rollbar.js الرسمية:
//   1. CSP في index.html هي `script-src 'self'` — لا سكربت من CDN إطلاقاً.
//      استعمال الحزمة كان يعني إمّا إرخاء CSP (تراجع أمني حقيقي مقابل أداة
//      رصد) أو نسخ حزمة ثالثة إلى public/vendor/ وحمل تحديثها.
//   2. أهم ما تضيفه الحزمة telemetry: التقاط النقرات وطلبات الشبكة وقيم
//      الحقول وتغيّرات DOM. هذا بالضبط ما لا يجوز أن يُرسَل من هذا التطبيق —
//      شاشاته تحمل أسماء زبائن وأرصدتهم وأسعاراً. فالميزة الكبرى للحزمة هي
//      المخاطرة الكبرى هنا.
//   3. خرائط المصدر (الميزة الثانية) بلا معنى: لا خطوة بناء في المستودع،
//      والملفات تُخدَم كما هي.
// فبقي من الحزمة غلافُ نداءٍ واحد على نقطة استقبال واحدة، وهو ما يفعله هذا
// الملف في أقل من مئتَي سطر مقروءة — وبسيطرة تامّة على ما يُرسَل.
//
// ما يُرسَل بالضبط، ولا شيء غيره:
//   • نصّ الخطأ ونوعه وأثر المكدّس، بعد تنقية.
//   • مسار الصفحة (pathname) بلا استعلام ولا شظية.
//   • البيئة، ومعرّف النشرة (commit)، وسلسلة المتصفح.
// ما لا يُرسَل أبداً: أي محتوى DOM، أي قيمة حقل، localStorage، الكوكيز،
// عناوين تحمل استعلامات، أي شيء من بيانات الزبائن.
//
// الإنتاج وحده: بلا رمز مُحقَن (وهو لا يُحقَن إلا في خطوة النشر) يبقى الملف
// خاملاً تماماً. وحتى مع رمز، يشترط https ومضيفاً غير محلي — فنسخة مطوّر أو
// نسخة مسروقة من HTML المنشور لا تلوّث بيانات الإنتاج.
// ============================================================================
(function () {
  "use strict";

  var ENDPOINT = "https://api.rollbar.com/api/1/item/";
  var MAX_ITEMS_PER_PAGE = 10;      // سقف الجلسة: خطأ في حلقة لا يُغرق الخدمة
  var MAX_MESSAGE_CHARS = 1000;
  var MAX_STACK_CHARS = 4000;

  var meta = document.querySelector('meta[name="ozk-monitoring"]');
  if (!meta) return;

  var token = meta.getAttribute("data-token") || "";
  var environment = meta.getAttribute("data-environment") || "";
  var release = meta.getAttribute("data-release") || "";

  // قيمة تبدأ بـ__ هي النائب الحرفي في المستودع ولم تُستبدَل عند النشر.
  function injected(value) {
    return typeof value === "string" && value.length > 0 && value.indexOf("__") !== 0;
  }

  var LOCAL_HOSTS = ["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"];
  function isProductionOrigin() {
    if (location.protocol !== "https:") return false;
    var host = location.hostname;
    if (LOCAL_HOSTS.indexOf(host) !== -1) return false;
    if (host.slice(-6) === ".local") return false;
    return true;
  }

  if (!injected(token) || !injected(environment) || !isProductionOrigin()) return;

  // ---------------------------------------------------------------------------
  // التنقية. تعمل على النصّ النهائي مهما كان مصدره، فلا تعتمد على معرفة أين
  // قد يظهر سرّ. الترتيب مقصود: العناوين أولاً (كي يُقتطع استعلامها قبل أن
  // يُخفي نمطُ السرّ العنوانَ كلّه)، ثم أنماط الأسرار، ثم القصّ.
  // ---------------------------------------------------------------------------
  var URL_WITH_QUERY = /(https?:\/\/[^\s"')]+?)[?#][^\s"')]*/g;
  var SECRET_PATTERNS = [
    /\b(?:sb|sbp|eyJ)[A-Za-z0-9_\-.]{16,}/g,                     // مفاتيح Supabase وJWT
    /\bgh[pousr]_[A-Za-z0-9]{16,}/g,                              // رموز GitHub
    // بلا \b قبل الأرقام عمداً: الرمز يظهر عملياً ملتصقاً بسابقة حرفية
    // (`bot123456789:AAH…` في عناوين واجهة تيليغرام)، و\b بين حرف ورقم لا
    // يقع أصلاً فكان النمط يمرّ فوق الرمز كاملاً. أمسكه حارس هذا الملف.
    /\d{6,}:[A-Za-z0-9_-]{30,}/g,                                 // رموز بوتات تيليغرام
    /((?:token|key|secret|password|passwd|pwd|authorization|bearer|apikey|api_key)\s*[=:]\s*)(\S+)/gi
  ];

  function scrub(text) {
    if (typeof text !== "string" || text.length === 0) return "";
    var out = text.replace(URL_WITH_QUERY, "$1?[محذوف]");
    for (var i = 0; i < SECRET_PATTERNS.length; i += 1) {
      var pattern = SECRET_PATTERNS[i];
      out = out.replace(pattern, function (match, prefix) {
        return prefix === undefined ? "[سرّ محذوف]" : prefix + "[سرّ محذوف]";
      });
    }
    return out;
  }

  function clamp(text, max) {
    var value = scrub(text);
    return value.length > max ? value.slice(0, max) + "…[مقتطع]" : value;
  }

  // ---------------------------------------------------------------------------
  // منع التكرار والفيضان. الحارس `reporting` يمنع الاستدعاء الارتدادي: خطأ
  // داخل المُرسِل نفسه لا يجوز أن يستدعي المُرسِل مرة أخرى.
  // ---------------------------------------------------------------------------
  var sent = 0;
  var seen = Object.create(null);
  var reporting = false;

  function send(level, title, stack, context) {
    if (reporting || sent >= MAX_ITEMS_PER_PAGE) return;
    var fingerprint = level + "|" + title + "|" + (context.filename || "") + ":" + (context.lineno || 0);
    if (seen[fingerprint]) return;
    seen[fingerprint] = true;
    sent += 1;
    reporting = true;

    try {
      var payload = {
        access_token: token,
        data: {
          environment: environment,
          level: level,
          platform: "browser",
          language: "javascript",
          timestamp: Math.floor(Date.now() / 1000),
          // معرّف النشرة: يربط الخطأ بالـcommit المنشور بالضبط. بلا حقن يبقى
          // فارغاً فلا نرسل حقلاً كاذباً.
          code_version: injected(release) ? release : undefined,
          notifier: { name: "ozk-error-monitoring", version: "1" },
          body: { message: { body: title, stack: stack || undefined } },
          request: {
            // pathname وحده: الاستعلام والشظية قد يحملان معرّفات مستندات أو رموزاً.
            url: location.origin + location.pathname
          },
          client: {
            javascript: {
              browser: String(navigator.userAgent || "").slice(0, 300),
              source_map_enabled: false
            }
          },
          custom: {
            filename: context.filename || undefined,
            lineno: context.lineno || undefined,
            colno: context.colno || undefined
          }
        }
      };

      // keepalive: يُكمِل الإرسال حتى لو أُغلقت الصفحة فوراً بعد الخطأ.
      // .catch فارغ متعمّد: فشل الشبكة إلى خدمة الرصد ليس حدثاً يستحق ضجيجاً
      // في وحدة تحكّم المستخدم، ولا يجوز أن يتحوّل إلى رفض غير مُعالَج.
      fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true,
        mode: "cors",
        credentials: "omit"
      }).catch(function () {});
    } catch (ignored) {
      // المُرسِل لا يُسقِط التطبيق تحت أي ظرف.
    } finally {
      reporting = false;
    }
  }

  window.addEventListener("error", function (event) {
    var error = event && event.error;
    var name = (error && error.name) || "Error";
    var message = (error && error.message) || (event && event.message) || "خطأ غير معروف";
    send("error", clamp(name + ": " + message, MAX_MESSAGE_CHARS), clamp(error && error.stack, MAX_STACK_CHARS), {
      // اسم الملف بلا استعلام: معامل ?v=tobacco-N يتغيّر كل نشرة فيمنع التجميع.
      filename: scrub(String((event && event.filename) || "").split("?")[0]),
      lineno: event && event.lineno,
      colno: event && event.colno
    });
  });

  window.addEventListener("unhandledrejection", function (event) {
    var reason = event && event.reason;
    var name = (reason && reason.name) || "UnhandledRejection";
    var message = (reason && reason.message) || String(reason === undefined ? "" : reason);
    send("error", clamp(name + ": " + message, MAX_MESSAGE_CHARS), clamp(reason && reason.stack, MAX_STACK_CHARS), {});
  });

  // كشف محدود للاختبار والتشخيص — لا يرسل شيئاً بذاته.
  window.ozkErrorMonitoring = {
    environment: environment,
    release: injected(release) ? release : null,
    scrub: scrub,
    sentCount: function () { return sent; }
  };
})();
