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
  var REDACTED = "[سرّ محذوف]";

  // قواعد التنقية: نمط وبديله. الترتيب مقصود — الأخصّ أولاً، كي تبتلع قاعدةُ
  // الترخيص القيمةَ كاملةً قبل أن تلتقط قاعدةٌ أعمّ جزءاً منها فتترك الباقي.
  //
  // ⚠️ إصلاح ملاحظة Codex P1 على PR #188: كانت `authorization` و`bearer`
  // مجرّد بديلين داخل قائمة «اسم حقل حسّاس متبوع بـ= أو :»، والبديل يلتقط
  // `\S+` واحدة بعد الفاصل. فعلى `Authorization: Bearer <رمز>` كان الملتقَط
  // كلمةَ `Bearer` نفسها ويبقى الرمز الفعلي سليماً فيُرسَل إلى Rollbar.
  // وأوسع من ذلك (وجدته عند التحقق، ولم تذكره الملاحظة):
  //   • `Bearer <رمز>` بلا اسم ترويسة لم يكن يُطابَق إطلاقاً — لأن `bearer`
  //     كانت تشترط `=` أو `:` بعدها، والمخطط العاري لا يحمل أيّاً منهما.
  //   • `Authorization: Basic <base64>` كان يسرّب اسم المستخدم وكلمة السرّ.
  // سبب فوات ذلك أصلاً: حالة الاختبار كانت `Authorization: eyJhbGci…` بلا
  // كلمة مخطط، فالتقطها نمط JWT وأعطت ثقة كاذبة بأن الترويسة محروسة.
  var SECRET_RULES = [
    // 1) ترويسة ترخيص — تُحجب القيمة كاملةً حتى نهاية السطر، بلا استثناء.
    //
    // ⚠️ إصلاح ملاحظة Codex P1 الرابعة على PR #188، وهي الثالثة من صنفها.
    // المحاولتان السابقتان حاولتا الإبقاء على شيء من القيمة لأجل التشخيص،
    // وكلتاهما سرّبت:
    //   • الأولى حجبت `\S+` واحدة بعد الفاصل، فعلى `Bearer <رمز>` حجبت كلمة
    //     `Bearer` وتركت الرمز.
    //   • الثانية أضافت قائمة مخططات معروفة (bearer|basic|digest|negotiate)
    //     وحجبت أول كلمة بعدها. فما إن يأتي مخطط خارج القائمة
    //     (`Authorization: Token …`، `Authorization: ApiKey …`) أو مخطط
    //     مُقتبَس (`Authorization: "Bearer …"`) حتى يعود السرّ إلى الظهور:
    //     تُحجب كلمة المخطط ويمرّ الرمز. أُثبت ذلك بالتشغيل على الحالات الثلاث.
    //
    // الخلاصة التي فرضتها ثلاث جولات: **قيمة ترويسة ترخيص ليس لها ذيل آمن.**
    // أي منطق يحاول تمييز «جزء السرّ» عن «الجزء المفيد» يفترض شكلاً للقيمة،
    // وكل افتراض شكلٍ كُسِر عملياً. فالحجب هنا شامل ولا يقرأ اسم المخطط
    // إطلاقاً — يبقى اسم الترويسة وحده، وهو ما يكفي للتشخيص.
    //
    // الثمن مقبول ومقصود: في رسالة مثل `Authorization: Bearer abc status=401`
    // نخسر `status=401` أيضاً. حُذف الشاهد الذي كان يفرض بقاءه — كان يحرس
    // السلوك المُسرِّب نفسه.
    //
    // `.` في JavaScript لا يطابق السطر الجديد، فالحجب يقف عند نهاية السطر
    // ولا يبتلع بقية أثر المكدّس.
    //
    // الحدّان اللذان يمنعان مسّ النصّ العادي:
    //   • `\s*[=:]` مباشرةً بعد الكلمة — فـ«Authorization failed: user lacks
    //     role» لا يُطابَق (بعد الكلمة فراغ ثم `failed` لا فاصل)، وكذلك
    //     `at checkAuthorization (auth.js:12:3)` في أثر المكدّس.
    //   • `(^|[^\w])` قبلها — فكلمة تنتهي بـ«authorization» مثل
    //     `unauthorization:` لا تُطابَق. وهي تسمح بالشرطة عمداً كي يبقى
    //     `X-Proxy-Authorization:` مشمولاً.
    {
      re: /(^|[^\w])((?:proxy-)?authorization\s*[=:]\s*).*/gim,
      to: function (match, before, prefix) { return before + prefix + REDACTED; }
    },
    // 3) ترويسة كوكيز — تُحجب قيمتها كاملةً حتى نهاية السطر.
    //
    // ⚠️ إصلاح ملاحظة Codex P1 الثالثة على PR #188: لم تكن أي قاعدة تعرف
    // الكوكيز، فـ`Cookie: session=…` و`Set-Cookie: sid=…` كانتا تمرّان بلا
    // مساس. `session` ليست في قائمة أسماء الحقول، و`session-token` لا يطابق
    // `\btoken\s*[=:]` لأن الفاصل لا يليه. جرّة الكوكيز كلها مادة اعتماد
    // فلا «ذيل آمن» يُترك، ولذلك الحجب حتى نهاية السطر لا حتى أول فراغ.
    //
    // الفاصل `:` وحده — لا `=` — عمداً: `document.cookie = "…"` نصٌّ برمجي
    // يظهر في آثار المكدّس ورسائل الأخطاء، ولا يجوز إتلافه. والمجموعة
    // `(^|[^.\w])` تمنع مطابقة `document.cookie:` داخل تفريغ كائن، وتُكتب
    // هكذا لا بـlookbehind لأن Safari قبل 16.4 يرمي SyntaxError على
    // lookbehind وقت التحليل — فيسقط الملف كله على أجهزة زبائن حقيقيين.
    {
      re: /(^|[^.\w])((?:set-)?cookie\s*:\s*).*/gim,
      to: function (match, before, prefix) { return before + prefix + REDACTED; }
    },
    // 4) مخطط مصادقة عارٍ بلا ترويسة. شرطان يمنعان إفساد النصّ العادي:
    //    ثمانية محارف على الأقل من طقم الرموز، **و**رقم أو رمز واحد بينها.
    //    فـ«basic authentication failed» و«Bearer token is missing» يمرّان
    //    سليمَين (كلمات حروف خالصة)، بينما `Bearer sk-live-…9911` يُحجب.
    //
    //    `digest` خرجت من هنا مع إصلاح الملاحظة الثانية: قيمة Digest ليست
    //    رمزاً واحداً بل قائمة معاملات، فكانت هذه القاعدة تحجب `username=`
    //    منها وتترك `response=` — تشويهٌ للنصّ بلا أي مكسب أمني.
    {
      re: /\b(bearer|basic)(\s+)(?=[A-Za-z0-9._~+\/=-]{8,})[A-Za-z0-9._~+\/=-]*[0-9._~+\/=-][A-Za-z0-9._~+\/=-]*/gi,
      to: function (match, scheme, gap) { return scheme + gap + REDACTED; }
    },
    // 5) مفاتيح Supabase وJWT
    { re: /\b(?:sb|sbp|eyJ)[A-Za-z0-9_\-.]{16,}/g, to: function () { return REDACTED; } },
    // 6) رموز GitHub بصيغتيها.
    //
    // ⚠️ إصلاح ملاحظة Codex P1 الخامسة على PR #188: النمط كان يعرف البادئات
    // الكلاسيكية وحدها (`ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`)، بينما الصيغة
    // الحديثة بادئتها `github_pat_` ولا تبدأ بـ`gh` متبوعاً بحرف واحد —
    // فكانت تمرّ بلا مساس. والأثر ليس نظرياً: التطبيق يخزّن رمز نشر GitHub
    // في localStorage تحت `gh_publish_token` (src/app.js:2740، 2770، 2775)،
    // فظهوره في رسالة خطأ يعني وصوله إلى Rollbar كاملاً.
    //
    // الحدّان الأدنيان للطول (16 و20) دون أطوال الرموز الحقيقية بكثير
    // (الكلاسيكي 36 محرفاً، ودقيق الصلاحية نحو 82) — عمداً: الحدّ يمنع
    // مطابقة نصّ قصير عابر، ولا يفترض طولاً ثابتاً قد يتغيّر مع صيغة جديدة.
    {
      re: /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{16,})/g,
      to: function () { return REDACTED; }
    },
    // 7) رموز بوتات تيليغرام. بلا \b قبل الأرقام عمداً: الرمز يظهر عملياً
    //    ملتصقاً بسابقة حرفية (`bot123456789:AAH…`)، و\b بين حرف ورقم لا يقع
    //    أصلاً فكان النمط يمرّ فوق الرمز كاملاً. أمسكه حارس هذا الملف.
    { re: /\d{6,}:[A-Za-z0-9_-]{30,}/g, to: function () { return REDACTED; } },
    // 8) إسناد صريح باسم حقل حسّاس. `authorization` و`bearer` خرجتا من هنا
    //    لأن قواعد الترخيص أعلاه تعالجهما معالجةً صحيحة. و`\b` البادئة تمنع
    //    مطابقة `key` داخل كلمة مثل «monkey:» فتُفسد نصّاً عادياً.
    //
    // ⚠️ إصلاح ملاحظة Codex P1 السادسة على PR #188: القيمة كانت `\S+` فتقف
    // عند أول فراغ. فعلى `password="correct horse battery staple"` كان
    // المحجوب `"correct` ويمرّ `horse battery staple"` إلى Rollbar. والفراغ
    // في كلمة السرّ وارد فعلاً: supabase-client.js يشترط طولاً أدنى فقط
    // (السطور 513-518) ولا يمنع الفراغات.
    //
    // البدائل مرتّبة عمداً: المقتبَس أولاً كي يبتلع القيمة حتى علامة الإغلاق
    // قبل أن تلتقطها `\S+` عند أول فراغ. وعلامة الإغلاق اختيارية (`"?`) كي
    // يُحجب اقتباسٌ غير مُغلَق أيضاً بدل أن يسقط إلى `\S+`؛ و`[^"\n]` يوقف
    // الابتلاع عند نهاية السطر فلا يمتدّ الحجب إلى بقية أثر المكدّس.
    //
    // ⚠️ إصلاح ملاحظة Codex P1 السابعة على PR #188: النمط كان يشترط `:` أو
    // `=` **مباشرةً** بعد اسم الحقل، وفي JSON يأتي اقتباس إغلاق المفتاح
    // أولاً: `{"password":"…"}`. فكانت الأجسام المُسلسلة تمرّ كاملةً — وهي
    // سياق واقعي جداً هنا: أخطاء Supabase وواجهات REST ترمي JSON في نصّ
    // الخطأ. أُثبت بالتشغيل: `{"password": "correct horse battery staple"}`
    // و`{"access_token":"…"}` كانا يمرّان بلا مساس.
    //
    // فصار اقتباس اسم المفتاح اختيارياً (مزدوج أو مفرد أو خلفي) قبله وبعده.
    // القائمة نفسها لم تتوسّع: مفاتيح الأسرار المعروفة وحدها، لا أي مفتاح.
    //
    // حدّا `\b` حول الاسم أساسيان لا تجميليان: بدونهما يطابق `key` داخل
    // `item_key` — وهو مفتاح المطابقة المركزي بين Supabase والأمين ويظهر في
    // كل رسالة خطأ تخصّ الأصناف تقريباً، فكان الحجب سيُفرغ تلك البلاغات من
    // معناها. `_` محرف كلمة، فلا حدّ بينه وبين `k`، فلا مطابقة (مُختبَر).
    {
      re: /(["'`]?\b(?:token|key|secret|password|passwd|pwd|apikey|api_key|access_token|refresh_token)\b["'`]?\s*[=:]\s*)("[^"\n]*"?|'[^'\n]*'?|`[^`\n]*`?|\S+)/gi,
      to: function (match, prefix) { return prefix + REDACTED; }
    }
  ];

  function scrub(text) {
    if (typeof text !== "string" || text.length === 0) return "";
    var out = text.replace(URL_WITH_QUERY, "$1?[محذوف]");
    for (var i = 0; i < SECRET_RULES.length; i += 1) {
      out = out.replace(SECRET_RULES[i].re, SECRET_RULES[i].to);
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
