// ============================================================================
// حارس مراقبة أخطاء الإنتاج (src/error-monitoring.js).
//
// هذا الملف الوحيد من الإضافة الجديدة الذي **يُشحَن إلى متصفح الزبون**، وهو
// يقرأ أخطاء تطبيق تعرض شاشاته أسماء زبائن وأرصدتهم وأسعارهم ثم يرسل إلى طرف
// ثالث. فالعقد المطلوب حراسته عقدان لا واحد:
//
//   أ) **لا يعمل إلا في الإنتاج.** بلا رمز مُحقَن، أو على http، أو على مضيف
//      محلي — يبقى خاملاً تماماً: لا مستمعات ولا طلبات. بلا هذا الحارس يكفي
//      خطأ في شرط واحد كي ترسل نسخة المطوّر بلاغات إلى بيانات الإنتاج.
//   ب) **لا يسرّب.** ما يُرسَل محصور في نصّ الخطأ وأثر مكدّسه ومسار الصفحة —
//      بلا استعلام، بلا شظية، بلا كوكيز، بلا تخزين محلي، بلا محتوى DOM، ومع
//      حذف كل ما يشبه السرّ. هذه فحوص سلوكية على الحمولة المرسَلة فعلاً، لا
//      قراءةً للنصّ: التأكيد على الحمولة يمسك تسريباً تضيفه صياغة جديدة،
//      بينما مطابقة النصّ تمسك صياغةً بعينها وحدها.
//
// كل الفحوص أدناه تُشغّل الملف فعلاً داخل node:vm بسياق متصفح مُصطنَع، وتُطلق
// أحداثاً حقيقية، وتفحص ما وصل إلى fetch. لا تأكيد واحد على وجود سلسلة نصية.
// ============================================================================
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = readFileSync(resolve(root, "src/error-monitoring.js"), "utf8");

let failed = 0;
const check = (name, condition, detail) => {
  if (condition) console.log(`  ✅ ${name}`);
  else { failed += 1; console.error(`  ❌ ${name}\n     ${detail}`); }
};

// ---------------------------------------------------------------------------
// سياق متصفح مُصطنَع. `meta` = null يعني «لا وسم في الصفحة».
// ---------------------------------------------------------------------------
function boot({ meta, protocol = "https:", hostname = "ozktobacco.com", fetchImpl, respondWith } = {}) {
  const calls = [];
  const consoleErrors = [];
  const listeners = new Map();
  const metaElement = meta
    ? { getAttribute: (name) => (name in meta ? meta[name] : null) }
    : null;

  const context = {
    // مرصد: أي `console.error` من المُرسِل يُلتقَط. «دخان ما بعد النشر» يعتبره
    // فشلاً، فأداة الرصد لا يجوز أن تكون هي مصدره.
    console: Object.assign(Object.create(Object.getPrototypeOf(console)), console, {
      error: (...args) => { consoleErrors.push(args); },
    }),
    Date,
    Math,
    JSON,
    String,
    Number,
    Object,
    Array,
    document: {
      querySelector: (selector) => (selector === 'meta[name="ozk-monitoring"]' ? metaElement : null),
      // فخّ: أي محاولة لقراءة محتوى الصفحة أو الكوكيز تُسقِط الفحص فوراً.
      get body() { throw new Error("مُنِع: قراءة DOM"); },
      get cookie() { throw new Error("مُنِع: قراءة الكوكيز"); },
    },
    get localStorage() { throw new Error("مُنِع: قراءة localStorage"); },
    get sessionStorage() { throw new Error("مُنِع: قراءة sessionStorage"); },
    location: {
      protocol,
      hostname,
      origin: `${protocol}//${hostname}`,
      pathname: "/",
      search: "?token=SECRET-IN-QUERY&customer=%D8%B2%D8%A8%D9%88%D9%86",
      hash: "#hash-secret",
    },
    navigator: { userAgent: "Mozilla/5.0 (Test)" },
    // وعد حقيقي: `fetch` لا يرفض على 4xx/5xx، فالمحاكي يعكس ذلك بدقّة كي
    // يُمارَس مسار `response.ok` فعلاً بدل أن يُفترَض.
    fetch: fetchImpl || ((url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return Promise.resolve(respondWith || { ok: true, status: 200 });
    }),
  };
  context.window = context;
  context.globalThis = context;
  context.window.addEventListener = (type, handler) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(handler);
  };

  vm.createContext(context);
  vm.runInContext(SOURCE, context, { filename: "error-monitoring.js" });

  return {
    calls,
    consoleErrors,
    listeners,
    context,
    emit(type, event) {
      for (const handler of listeners.get(type) || []) handler(event);
    },
  };
}

const LIVE_META = {
  "data-token": "0123456789abcdef0123456789abcdef",
  "data-environment": "production",
  "data-release": "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
};

// ===== 1) بوابة الإنتاج =====
console.log("\n— بوابة الإنتاج —");
{
  const noMeta = boot({ meta: null });
  check("بلا وسم إعداد: خامل تماماً",
    noMeta.listeners.size === 0 && noMeta.context.ozkErrorMonitoring === undefined,
    "سُجِّلت مستمعات رغم غياب الوسم");

  const placeholder = boot({ meta: { ...LIVE_META, "data-token": "__ROLLBAR_CLIENT_TOKEN__" } });
  check("النائب غير المُستبدَل يُعامَل كغير مُهيَّأ",
    placeholder.listeners.size === 0,
    "النائب `__ROLLBAR_CLIENT_TOKEN__` فُهم رمزاً صالحاً — سيرسل المستودع نفسه بلاغات");

  const emptyToken = boot({ meta: { ...LIVE_META, "data-token": "" } });
  check("رمز فارغ: خامل", emptyToken.listeners.size === 0, "رمز فارغ فعّل المراقبة");

  const placeholderEnv = boot({ meta: { ...LIVE_META, "data-environment": "__DEPLOY_ENVIRONMENT__" } });
  check("بيئة غير مُستبدَلة: خامل", placeholderEnv.listeners.size === 0, "بيئة نائبة فعّلت المراقبة");

  const insecure = boot({ meta: LIVE_META, protocol: "http:" });
  check("http: خامل", insecure.listeners.size === 0, "عملت المراقبة على اتصال غير مشفّر");

  for (const host of ["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "dev.local"]) {
    const local = boot({ meta: LIVE_META, hostname: host });
    check(`مضيف محلي (${host}): خامل`, local.listeners.size === 0,
      `نسخة محلية سترسل بلاغات إلى بيانات الإنتاج (${host})`);
  }

  const live = boot({ meta: LIVE_META });
  check("إنتاج فعلي: تُسجَّل مستمعات error وunhandledrejection",
    live.listeners.has("error") && live.listeners.has("unhandledrejection"),
    "لم تُسجَّل المستمعات رغم اكتمال الشروط — المراقبة معطّلة في الإنتاج");
}

// ===== 2) الحمولة المرسَلة =====
console.log("\n— الحمولة —");
{
  const live = boot({ meta: LIVE_META });
  live.emit("error", {
    message: "boom",
    filename: "https://ozktobacco.com/src/app.js?v=tobacco-179",
    lineno: 12,
    colno: 3,
    error: Object.assign(new Error("boom"), { name: "TypeError", stack: "TypeError: boom\n  at https://ozktobacco.com/src/app.js?v=tobacco-179:12:3" }),
  });

  check("أُرسل بلاغ واحد", live.calls.length === 1, `عدد الطلبات: ${live.calls.length}`);
  const call = live.calls[0];
  check("العنوان هو نقطة استقبال Rollbar",
    call?.url === "https://api.rollbar.com/api/1/item/", `العنوان: ${call?.url}`);
  check("الرمز يُرسَل في الجسم لا في العنوان",
    call?.body?.access_token === LIVE_META["data-token"] && !String(call?.url).includes(LIVE_META["data-token"]),
    "الرمز في العنوان يظهر في سجلات الوسطاء");
  check("البيئة والمستوى ومعرّف النشرة مُرفَقة",
    call?.body?.data?.environment === "production" &&
    call?.body?.data?.level === "error" &&
    call?.body?.data?.code_version === LIVE_META["data-release"],
    `environment/level/code_version ناقصة: ${JSON.stringify(call?.body?.data?.code_version)}`);
  check("الاعتماديات لا تُرسَل (credentials: omit)",
    call?.init?.credentials === "omit", "قد تُرسَل كوكيز النطاق مع البلاغ");

  const url = call?.body?.data?.request?.url || "";
  check("عنوان الصفحة بلا استعلام ولا شظية",
    url === "https://ozktobacco.com/" && !url.includes("?") && !url.includes("#"),
    `تسرّب الاستعلام أو الشظية: ${url}`);

  const serialized = JSON.stringify(call?.body || {});
  for (const leak of ["SECRET-IN-QUERY", "hash-secret", "%D8%B2%D8%A8%D9%88%D9%86"]) {
    check(`لا تسريب لـ"${leak}" من استعلام الصفحة`, !serialized.includes(leak),
      `وُجد ${leak} في الحمولة`);
  }
  check("معامل النسخة يُقصّ من اسم الملف (وإلا تشتّت التجميع كل نشرة)",
    !String(call?.body?.data?.custom?.filename || "").includes("?v=tobacco-"),
    `filename ما زال يحمل المعامل: ${call?.body?.data?.custom?.filename}`);
}

// ===== 3) تنقية الأسرار =====
console.log("\n— تنقية الأسرار —");
{
  const live = boot({ meta: LIVE_META });
  const scrub = live.context.ozkErrorMonitoring.scrub;
  const cases = [
    ["مفتاح Supabase", "failed with sb_publishable_FAKEKEY0000TESTONLY0000000000", "sb_publishable_FAKEKEY"],
    ["رمز JWT", "Authorization: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcdef", "eyJhbGciOiJIUzI1NiI"],
    ["رمز GitHub", "token ghp_0123456789abcdefghijABCDEFGHIJ012345", "ghp_0123456789abcdef"],
    ["رمز بوت تيليغرام", "bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw", "AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"],
    ["password= صريحة", "login failed password=Hunter2Hunter2", "Hunter2Hunter2"],
    ["استعلام داخل عنوان", "GET https://x.example/api?apikey=abcdef123456 failed", "apikey=abcdef123456"],
  ];
  for (const [label, input, secret] of cases) {
    check(`تُحذف: ${label}`, !scrub(input).includes(secret), `بقي «${secret}» بعد التنقية`);
  }

  // ---------------------------------------------------------------------
  // انحدار ملاحظة Codex P1 على PR #188 — مخططات المصادقة.
  //
  // العطل الأصلي: `authorization` و`bearer` كانتا بديلين في نمط «اسم حقل
  // متبوع بفاصل» يلتقط `\S+` واحدة، فعلى `Authorization: Bearer <رمز>`
  // كان الملتقَط كلمةَ `Bearer` ويبقى الرمز سليماً فيُرسَل إلى Rollbar.
  // الحالتان الثالثة والرابعة أوسع من الملاحظة، وظهرتا عند التحقق منها:
  // مخطط عارٍ بلا ترويسة لم يكن يُطابَق إطلاقاً، وBasic كان يسرّب
  // اسم المستخدم وكلمة السرّ مُرمَّزَين.
  // ---------------------------------------------------------------------
  // العقد بعد ملاحظة Codex P1 الرابعة: قيمة ترويسة الترخيص تُحجب **كاملةً**
  // حتى نهاية السطر، بلا قراءة اسم المخطط إطلاقاً. جولتان سابقتان حاولتا
  // الإبقاء على جزء منها لأجل التشخيص وكلتاهما سرّبت — الأولى تركت الرمز بعد
  // كلمة `Bearer`، والثانية تركته بعد أي مخطط خارج قائمة المعروفين أو مُقتبَس.
  const authCases = [
    ["Bearer", "Authorization: Bearer opaque-session-token-9911", "opaque-session-token-9911"],
    ["bearer حالة صغيرة", "authorization: bearer 9f8e7d6c5b4a", "9f8e7d6c5b4a"],
    ["Basic", "Authorization: Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNzd29yZA=="],
    ["Token (مخطط خارج أي قائمة)", "Authorization: Token opaque-session-token-9911", "opaque-session-token-9911"],
    ["ApiKey (مخطط خارج أي قائمة)", "Authorization: ApiKey secret-value-12345678", "secret-value-12345678"],
    ["قيمة بين علامتَي اقتباس", 'Authorization: "Bearer opaque-session-token-9911"', "opaque-session-token-9911"],
    ["بلا مخطط إطلاقاً", "Authorization: rawopaquetokenvalue123", "rawopaquetokenvalue123"],
    ["Proxy-Authorization", "Proxy-Authorization: Bearer proxy-secret-99887766", "proxy-secret-99887766"],
    ["X-Proxy-Authorization", "X-Proxy-Authorization: Token opaque-session-token-9911", "opaque-session-token-9911"],
    ["ترخيص وسط جملة", "request failed Authorization: Bearer leak-me-1234 status=401", "leak-me-1234"],
    ["Bearer عارٍ بلا ترويسة", "Bearer sk-live-CUSTOMER-SESSION-9911", "sk-live-CUSTOMER-SESSION-9911"],
    ["Basic عارٍ بلا ترويسة", "Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNzd29yZA=="],
  ];
  for (const [label, input, secret] of authCases) {
    check(`تُحذف الاعتمادية: ${label}`, !scrub(input).includes(secret),
      `بقي «${secret}» بعد التنقية — الاعتمادية ستصل إلى طرف ثالث`);
  }

  // اسم الترويسة يبقى — وهو كل ما يبقى. لا اسم مخطط ولا ذيل.
  check("اسم الترويسة يبقى للتشخيص",
    scrub("Authorization: Bearer opaque-session-token-9911").startsWith("Authorization: "),
    "حُذف اسم الترويسة أيضاً — يصير البلاغ أعمى بلا مقابل");
  check("لا يبقى اسم المخطط (الحجب شامل لا انتقائي)",
    !scrub("Authorization: Bearer opaque-session-token-9911").includes("Bearer"),
    "بقي اسم المخطط — أي إبقاء انتقائي يفترض شكلاً للقيمة، وكل افتراض شكلٍ كُسِر");
  check("الحجب يقف عند نهاية السطر",
    scrub("err\nAuthorization: Bearer opaque-session-token-9911\nat foo.js:3:4").includes("at foo.js:3:4"),
    "ابتلع الحجبُ بقية أثر المكدّس — `.` يجب ألّا تطابق السطر الجديد");

  // -------------------------------------------------------------------
  // انحدار ملاحظة Codex P1 السابعة عشرة — حقل تأكيد كلمة المرور.
  //
  // `passwordConfirmation` لم يُطابَق لأن `C` بعد `password` يمنع حدّ `\b`
  // اللاحق. وهو حقل حقيقي في أربعة مواضع من `src/app.js`، وقيمته كلمة
  // المرور الجديدة نفسها.
  //
  // ⚠️ وهذا الشاهد كشف عطلاً أعمّ وأخطر: كان التقاط القيمة `(.*)` يبتلع
  // السطر كله ثم يُقتطع في الدالة، فيقفز `lastIndex` للنمط العام إلى نهاية
  // السطر بعد أوّل مطابقة — فينجو كل حقل سرّي تالٍ على السطر نفسه. لذلك
  // تُفحص هنا أزواج متعدّدة في سطر واحد، لا الحقل الجديد وحده.
  // -------------------------------------------------------------------
  {
    const resetForm = '{"email":"owner@example.com","password":"OldPass123","passwordConfirmation":"OldPass123"}';
    const scrubbed = scrub(resetForm);
    check("نموذج إعادة التعيين: password وpasswordConfirmation كلاهما يُحجب",
      !scrubbed.includes("OldPass123"),
      `بقيت كلمة المرور — صار: ${scrubbed}`);
    check("نموذج إعادة التعيين: بقية الرسالة تبقى مفهومة",
      scrubbed.includes("owner@example.com") && scrubbed.includes("passwordConfirmation"),
      `ضاع سياق البلاغ — صار: ${scrubbed}`);
  }
  for (const [label, input, secrets] of [
    ["passwordConfirmation في سجلّ", "reset failed passwordConfirmation=MySecretPass123", ["MySecretPass123"]],
    ["حقلان سرّيان مختلفان في سطر", '{"token":"AAA","password":"BBB"}', ["AAA", "BBB"]],
    ["حقلان سرّيان آخران في سطر", '{"api_key":"AAA","secret":"BBB"}', ["AAA", "BBB"]],
  ]) {
    check(`تُحجب كل الحقول السرّية: ${label}`,
      secrets.every((x) => !scrub(input).includes(x)),
      `نجا حقل سرّي على السطر نفسه — صار: ${scrub(input)}`);
  }

  // -------------------------------------------------------------------
  // انحدار ملاحظة Codex P1 الخامسة عشرة — رموز الاستعادة لمرة واحدة.
  //
  // `recoveryCode` ليس حقلاً افتراضياً: `src/app.js` يجمعه من نموذج استعادة
  // كلمة المرور، و`src/supabase-client.js` يمرّره إلى `auth.verifyOtp` بنوع
  // `"recovery"`. فبلوغه Rollbar مقروناً بالبريد = رمز إعادة تعيين صالح.
  // -------------------------------------------------------------------
  const RECOVERY_CASES = [
    ["JSON: بريد ورمز استعادة", '{"email":"owner@example.com","recoveryCode":"123456"}', "123456"],
    ["سجلّ نصّي", "password recovery failed email=owner@example.com recoveryCode=123456", "123456"],
    ["recovery_code بصيغة snake_case", '{"recovery_code":"8675309"}', "8675309"],
    ["otp", '{"otp":"445566"}', "445566"],
    ["نقطتان بدل مساواة", "verifyOtp rejected: recoveryCode: 987654", "987654"],
  ];
  for (const [label, input, secret] of RECOVERY_CASES) {
    check(`يُحجب رمز الاستعادة: ${label}`, !scrub(input).includes(secret),
      `بقي «${secret}» — رمز استعادة صالح يصل إلى طرف ثالث`);
  }

  // الحجب يزيل الرمز ويُبقي الرسالة مفهومة: البريد ليس اعتمادية بذاته،
  // وحذفه يُفقد البلاغ سياقه بلا مكسب أمني — الرمز وحده هو ما يُستعمل.
  {
    const scrubbed = scrub('{"email":"owner@example.com","recoveryCode":"123456"}');
    check("رمز الاستعادة في JSON: يُحجب الرمز ويبقى البريد للسياق",
      !scrubbed.includes("123456") && scrubbed.includes("owner@example.com"),
      `الحجب أفقد الرسالة معناها أو أبقى الرمز — صار: ${scrubbed}`);
    const line = scrub("password recovery failed email=owner@example.com recoveryCode=123456");
    check("رمز الاستعادة في سجلّ: يُحجب الرمز ويبقى وصف العطل",
      !line.includes("123456") && line.includes("password recovery failed"),
      `ضاع وصف العطل — صار: ${line}`);
  }

  // شواهد سالبة: كلمة recovery وحدها ليست اسم حقل سرّي.
  for (const intact of [
    '{"email":"owner@example.com","status":"recovery"}',
    "password recovery email sent successfully",
  ]) {
    check(`نصّ استعادة عادي لا يُحجب: «${intact.slice(0, 42)}…»`, scrub(intact) === intact,
      `أُفسد نصّ عادي — صار: ${scrub(intact)}`);
  }

  // -------------------------------------------------------------------
  // انحدار ملاحظة Codex P1 الرابعة عشرة — تمييز الاعتمادية العارية عن الكلام.
  //
  // القاعدة كانت تشترط رقماً أو رمزاً، فمرّ `Bearer abcdefghijklmnop` و
  // `Basic dXNlcjpwYXNz` (ترميز صالح لـ`user:pass`). وذلك الشرط وُضع عمداً
  // كي لا يُحجب `Bearer token is missing`. فالشاهدان المتقابلان أدناه هما
  // العقد: لا تسريب اعتمادية، ولا إتلاف نصّ خطأ بشري.
  // -------------------------------------------------------------------
  for (const [label, input] of [
    ["رمز حروفي خالص (طول ≥ 16)", "Bearer abcdefghijklmnop"],
    ["اعتمادية Basic حروفية (base64)", "Basic dXNlcjpwYXNz"],
    ["اعتمادية Basic بعلامات ترقيم", "Basic dXNlcjpwYXNzd29yZA=="],
    ["رمز بعلامات ترقيم وأرقام", "Bearer sk-live-CUSTOMER-SESSION-9911"],
    ["رمز JWT عارٍ", "Bearer eyJhbGciOiJIUzI1NiJ9abcdefgh"],
  ]) {
    check(`تُحجب اعتمادية عارية: ${label}`, scrub(input).includes("[سرّ محذوف]"),
      `مرّ «${input}» بلا حجب — اعتمادية حقيقية تصل إلى طرف ثالث`);
  }
  for (const intact of [
    "Bearer token is missing",
    "basic authentication failed",
    "Bearer authorization required",
    "Basic AUTHENTICATION",
    "Bearer credentials not provided",
  ]) {
    check(`نصّ بشري بعد مخطط لا يُحجب: «${intact}»`, scrub(intact) === intact,
      `أُفسد نصّ خطأ بشري — صار: ${scrub(intact)}`);
  }

  // -------------------------------------------------------------------
  // انحدار ملاحظات Codex P1 العاشرة والحادية عشرة والثانية عشرة على PR #188.
  // الحالات هي التي ذكرها Codex حرفياً، لا أكثر.
  // -------------------------------------------------------------------
  const CODEX_ROUND_10 = [
    ["كوكيز خلف مفتاح JSON", '{"Cookie":"session=opaque-session-token-9911"}', "opaque-session-token-9911"],
    ["Set-Cookie خلف مفتاح JSON", '{"Set-Cookie":"sid=abc123def456"}', "abc123def456"],
    ["client_secret مركّب", '{"client_secret":"opaque-client-secret-9911"}', "opaque-client-secret-9911"],
    ["session_token مركّب", '{"session_token":"opaque-session-9911"}', "opaque-session-9911"],
    ["public_token مركّب", '{"public_token":"opaque-public-9911"}', "opaque-public-9911"],
    ["كلمة سرّ غير مقتبَسة بفراغات", "password: correct horse battery staple", "horse battery staple"],
  ];
  for (const [label, input, secret] of CODEX_ROUND_10) {
    check(`تُحجب: ${label}`, !scrub(input).includes(secret),
      `بقي «${secret}» بعد التنقية`);
  }
  // ⚠️ انحدار ملاحظة Codex P1 الثالثة عشرة. كان هنا شاهد يفرض وقوف الحجب
  // عند فاصل بنيوي — وقد حُذف لأنه كان يحرس تسريباً: تلك الفواصل نفسها
  // (`,` `;` `}` `]`) محارف مشروعة داخل كلمة السرّ، فعلى
  // `password: correct,horse,battery` كان يُحجب `correct` ويمرّ الباقي.
  // فأي محرف يُختار حدّاً هو محرف قد يكون من السرّ نفسه — والقيمة غير
  // المقتبَسة بلا حدّ موثوق. الحالات هي التي ذكرها Codex حرفياً.
  for (const [label, input, secret] of [
    ["فاصلة داخل كلمة السرّ", "password: correct,horse,battery", "horse,battery"],
    ["فاصلة منقوطة داخل كلمة السرّ", "password: correct, horse; battery staple", "horse; battery"],
    ["قوس إغلاق داخل كلمة السرّ", "password: secret}with]brackets", "with]brackets"],
  ]) {
    check(`تُحجب القيمة غير المقتبَسة كاملةً: ${label}`, !scrub(input).includes(secret),
      `بقي «${secret}» — الفاصل البنيوي محرف مشروع داخل كلمة السرّ`);
  }
  // وJSON الحقيقي يقتبس قيمه دائماً، فيمرّ من الفرع المقتبَس وتبقى حقوله.
  check("JSON مقتبَس: بقية الحقول تبقى للتشخيص",
    scrub('{"refresh_token":"opaque-token-9911","user":"x"}').includes('"user":"x"'),
    "ابتلع الحجبُ الجسم كله رغم أن القيمة مقتبَسة وحدّها موثوق");

  // -------------------------------------------------------------------
  // انحدار ملاحظتَي Codex P1 الثامنة والتاسعة على PR #188.
  //
  // (8) قاعدة الترخيص قبلت مفتاحاً غير مقتبَس وحده، فترويسات مُسلسلة
  //     كـ`{"Authorization":"Token abc…"}` مرّت كاملةً — اقتباس إغلاق
  //     المفتاح يسبق النقطتين فلا يصل النمط إليهما.
  // (9) ابتلاع القيمة المقتبَسة استعمل `[^"\n]*` فاعتبر أوّل اقتباس نهايةً
  //     حتى لو كان مهروباً: `password="foo\"bar baz secret"` حُجب منه
  //     `"foo\"` ومرّ الباقي.
  // -------------------------------------------------------------------
  const JSON_AUTH = [
    ["مفتاح Authorization مقتبَس", '{"Authorization":"Token abcdefghijklmnop"}', "abcdefghijklmnop"],
    ["قيمة بلا مخطط", '{"Authorization":"rawopaquetokenvalue"}', "rawopaquetokenvalue"],
    ["حالة صغيرة", '{"authorization":"Bearer opaque-session-9911"}', "opaque-session-9911"],
    ["Proxy-Authorization مقتبَس", '{"Proxy-Authorization":"Digest response=\\"abc123\\""}', "abc123"],
  ];
  for (const [label, input, secret] of JSON_AUTH) {
    check(`تُحجب قيمة مفتاح ترخيص مقتبَس: ${label}`, !scrub(input).includes(secret),
      `بقي «${secret}» — اقتباس إغلاق المفتاح يسبق الفاصل في JSON`);
  }
  // الشكل المقتبَس جسمُ JSON لا سطرَ ترويسة، فالحجب يقتصر على قيمته وحدها.
  check("ترخيص في JSON: بقية الحقول تبقى للتشخيص",
    scrub('{"Authorization":"Token abc","user":"ozk"}').includes('"user":"ozk"'),
    "ابتلع الحجبُ الجسم كله — الحجب حتى نهاية السطر للترويسة لا لـJSON");

  const ESCAPED_QUOTES = [
    ["اقتباس مهروب داخل password", 'password="foo\\"bar baz secret"', "bar baz secret"],
    ["اقتباس مهروب داخل token في JSON", '{"token":"a\\"b more-secret-here"}', "more-secret-here"],
    ["اقتباس مفرد مهروب داخل secret", "secret='it\\'s a secret phrase'", "s a secret phrase"],
  ];
  for (const [label, input, secret] of ESCAPED_QUOTES) {
    check(`الهروب لا يُنهي القيمة: ${label}`, !scrub(input).includes(secret),
      `بقي «${secret}» — الاقتباس المهروب ليس نهاية القيمة`);
  }

  // -------------------------------------------------------------------
  // انحدار ملاحظة Codex P1 السابعة على PR #188 — مفاتيح JSON المقتبَسة.
  //
  // النمط كان يشترط `:` أو `=` مباشرةً بعد اسم الحقل، وفي JSON يأتي اقتباس
  // إغلاق المفتاح أولاً — فمرّت الأجسام المُسلسلة كاملةً. وهو سياق واقعي
  // هنا: أخطاء Supabase وواجهات REST ترمي JSON في نصّ الخطأ.
  // -------------------------------------------------------------------
  const JSON_SECRETS = [
    ["password في JSON", '{"password":"correct horse battery staple"}', "horse battery staple"],
    ["access_token في JSON", '{"access_token":"opaque-session-value-9911"}', "opaque-session-value-9911"],
    ["api_key في JSON", '{"api_key":"secret-value-12345678"}', "secret-value-12345678"],
    ["token في JSON", '{"token":"abc def ghi"}', "abc def ghi"],
    ["فراغ بعد النقطتين", '{"password": "spaced value here"}', "spaced value here"],
    ["مفتاح وقيمة بين اقتباسين مفردين", "'api_key': 'secret-value-12345678'", "secret-value-12345678"],
    ["refresh_token وسط جسم أكبر", '{"refresh_token":"opaque-token-9911","user":"x"}', "opaque-token-9911"],
  ];
  for (const [label, input, secret] of JSON_SECRETS) {
    check(`تُحجب قيمة مفتاح مقتبَس: ${label}`, !scrub(input).includes(secret),
      `بقي «${secret}» — اقتباس إغلاق المفتاح يسبق النقطتين في JSON`);
  }
  check("الحجب في JSON محدود بقيمة المفتاح السرّي وحده",
    scrub('{"refresh_token":"opaque-token-9911","user":"x"}').includes('"user":"x"'),
    "ابتلع الحجبُ بقية الجسم — الحقول غير السرّية يجب أن تبقى للتشخيص");

  // شواهد سالبة على JSON عادي. أهمّها `item_key`: هو مفتاح المطابقة المركزي
  // بين Supabase والأمين ويظهر في كل رسالة خطأ تخصّ الأصناف تقريباً — لولا
  // حدّا `\b` حول اسم الحقل لطابَق `key` داخله ولأُفرغت تلك البلاغات من معناها.
  for (const intact of [
    '{"item_key":"TOB-001","name":"غلواز قصير أحمر","price":403}',
    '{"monkey":"banana"}',
    '{"keyboard":"qwerty","donkey":"kong"}',
    '{"status":500,"message":"Internal Server Error","hint":null}',
    "TypeError: Cannot read properties of undefined (reading 'approved_price_items')",
  ]) {
    check(`JSON عادي لا يُحجب: «${intact.slice(0, 42)}…»`, scrub(intact) === intact,
      `أُفسد جسم JSON تشخيصي — صار: ${scrub(intact)}`);
  }

  // -------------------------------------------------------------------
  // انحدار ملاحظتَي Codex P1 الخامسة والسادسة على PR #188.
  //
  // (5) رموز GitHub: النمط كان يعرف البادئات الكلاسيكية وحدها، والصيغة
  //     الحديثة `github_pat_` تمرّ. والأثر ليس نظرياً — التطبيق يخزّن رمز
  //     النشر في localStorage تحت `gh_publish_token` (src/app.js:2740).
  // (6) القيم المقتبَسة: `\S+` تقف عند أول فراغ، فعلى
  //     `password="correct horse battery staple"` كان المحجوب `"correct`
  //     ويمرّ الباقي. والفراغ في كلمة السرّ وارد: supabase-client.js يشترط
  //     طولاً أدنى فقط ولا يمنع الفراغات.
  // -------------------------------------------------------------------
  const GITHUB_TOKENS = [
    ["github_pat_ (دقيق الصلاحية)",
     "github_pat_11FAKE0000TESTONLY_NOTAREALTOKEN0000000000000000000000"],
    ["ghp_ (كلاسيكي)", "ghp_0123456789abcdefghijABCDEFGHIJ012345"],
    ["gho_ (OAuth)", "gho_0123456789abcdefghijABCDEFGHIJ012345"],
    ["ghu_ (مستخدم-إلى-خادم)", "ghu_0123456789abcdefghijABCDEFGHIJ012345"],
    ["ghs_ (خادم-إلى-خادم)", "ghs_0123456789abcdefghijABCDEFGHIJ012345"],
    ["ghr_ (تحديث)", "ghr_0123456789abcdefghijABCDEFGHIJ012345"],
  ];
  for (const [label, token] of GITHUB_TOKENS) {
    check(`يُحذف رمز GitHub: ${label}`,
      !scrub(`publish failed with ${token} at app.js`).includes(token.slice(0, 20)),
      `بقي الرمز — التطبيق يخزّن gh_publish_token فعلاً، فتسريبه تسريب حقيقي`);
  }

  const QUOTED_VALUES = [
    ["password بفراغات بين اقتباسين مزدوجين", 'password="correct horse battery staple"', "horse battery staple"],
    ["token بفراغات بين اقتباسين مفردين", "token='secret value with spaces'", "value with spaces"],
    ["api_key بين اقتباسين مزدوجين", 'api_key="abc def ghi"', "def ghi"],
    ["secret بين اقتباسين مفردين", "secret: 'my secret phrase'", "secret phrase"],
    ["token بلا اقتباس", "token=abc123def456", "abc123def456"],
    ["اقتباس غير مُغلَق", 'password="unterminated secret here', "unterminated secret here"],
  ];
  for (const [label, input, secret] of QUOTED_VALUES) {
    check(`تُحجب القيمة كاملةً: ${label}`, !scrub(input).includes(secret),
      `بقي «${secret}» — الحجب يقف عند علامة الإغلاق لا عند أول فراغ`);
  }

  // شواهد سالبة على نصوص **طويلة** تحديداً: الحجب مبني على سياق سرّ معروف،
  // لا على طول السلسلة ولا على عشوائيتها. بلا هذه الشواهد قد تتسلّل قاعدة
  // عامة تحجب أي نصّ طويل فتُفرغ البلاغات من محتواها.
  for (const long of [
    "Failed to load resource: the server responded with a status of 500 (Internal Server Error)",
    "TypeError: Cannot read properties of undefined (reading 'approved_price_items') at renderInventoryReport",
    "The quick brown fox jumps over the lazy dog repeatedly for a very long time indeed",
  ]) {
    check(`نصّ طويل بلا سياق سرّ لا يُحجب: «${long.slice(0, 40)}…»`, scrub(long) === long,
      `أُفسد نصّ تشخيصي طويل — صار: ${scrub(long)}`);
  }

  // -------------------------------------------------------------------
  // انحدار ملاحظتَي Codex P1 الثانية والثالثة على PR #188.
  //
  // (2) Digest: القاعدة السابقة كانت تنهي القيمة عند أول فراغ، وقيمة Digest
  //     قائمة معاملات مفصولة بفواصل — فحُجب `username="ozk",` وحده ومرّ
  //     `response` (توقيع المصادقة نفسه) و`nonce` سليمَين.
  // (3) الكوكيز: لم تكن أي قاعدة تعرفها. `session` ليست باسم حقل حسّاس،
  //     و`session-token` لا يطابق `\btoken\s*[=:]` لأن الفاصل لا يليه —
  //     فمرّت جرّة الكوكيز كاملةً.
  // -------------------------------------------------------------------
  const DIGEST_HEADER =
    'Authorization: Digest username="ozk", realm="ozktobacco", ' +
    'nonce="dcd98b7102dd2f0e", response="6629fae49393a05397450978507c4ef1"';
  for (const part of ["username", "realm", "nonce", "response", "dcd98b7102dd2f0e",
                      "6629fae49393a05397450978507c4ef1"]) {
    check(`Digest: لا يبقى «${part}»`, !scrub(DIGEST_HEADER).includes(part),
      `بقي «${part}» — قيمة Digest تُحجب حتى نهاية السطر لا حتى أول فراغ`);
  }

  const cookieCases = [
    ["Cookie: session=", "Cookie: session=opaque-session-token-9911", "opaque-session-token-9911"],
    ["Set-Cookie: sid=", "Set-Cookie: sid=abc123def456; HttpOnly; Secure", "abc123def456"],
    ["set-cookie حالة صغيرة", "set-cookie: sb-access=zzzz9999; Path=/", "sb-access=zzzz9999"],
    ["كوكيز وسط أثر مكدّس", "request failed\nCookie: a=secretvalue1; b=secretvalue2\nat foo.js:3:4", "secretvalue2"],
  ];
  for (const [label, input, secret] of cookieCases) {
    check(`تُحجب جرّة الكوكيز: ${label}`, !scrub(input).includes(secret),
      `بقي «${secret}» — قيمة الكوكيز كلها مادة اعتماد، لا ذيل آمن فيها`);
  }
  check("الكوكيز: الحجب يقف عند نهاية السطر",
    scrub("request failed\nCookie: a=secretvalue1\nat foo.js:3:4").includes("at foo.js:3:4"),
    "ابتلع الحجبُ بقية أثر المكدّس — `.` يجب ألّا تطابق السطر الجديد");

  // `document.cookie` نصّ برمجي يظهر في آثار المكدّس ورسائل الأخطاء. الفاصل
  // في قاعدة الكوكيز `:` وحده — لا `=` — تحديداً كي لا يُتلَف هذا النصّ.
  const COOKIE_CODE = 'at Object.set [as cookie] (document.cookie = "theme=dark")';
  check("document.cookie كنصّ برمجي لا يُمَسّ", scrub(COOKIE_CODE) === COOKIE_CODE,
    `أُتلف نصّ برمجي — صار: ${scrub(COOKIE_CODE)}`);


  // شواهد سالبة: نصّ إنجليزي عادي يحمل هذه الكلمات ولا يحمل اعتمادية.
  // بلا هذه الشواهد يمرّ نمط جشع يحجب «basic authentication failed» كلها.
  for (const intact of [
    "basic authentication failed",
    "Bearer token is missing",
    "digest algorithm not supported",
    "cookie consent banner failed to load",
    "at checkAuthorization (auth.js:12:3)",
    "unauthorization: not a header",
    "TypeError: Cannot set property cookie of #<Document>",
    "Authorization failed: user lacks role",
    "TypeError: cannot read property x of undefined",
  ]) {
    check(`نصّ عادي يبقى كما هو: «${intact}»`, scrub(intact) === intact,
      `أُفسد نصّ عادي — صار: ${scrub(intact)}`);
  }

  check("النصّ المفيد يبقى", scrub("TypeError: cannot read x").includes("cannot read x"),
    "التنقية أتلفت رسالة الخطأ نفسها فصارت البلاغات بلا قيمة");
}

// ===== 4) الحدّ والتكرار والمتانة =====
console.log("\n— الحدّ والمتانة —");
{
  const live = boot({ meta: LIVE_META });
  const sameError = () => live.emit("error", {
    message: "same", filename: "https://ozktobacco.com/src/app.js", lineno: 1, colno: 1,
    error: Object.assign(new Error("same"), { name: "Error", stack: "Error: same" }),
  });
  sameError(); sameError(); sameError();
  check("الخطأ المتكرّر يُرسَل مرة واحدة", live.calls.length === 1,
    `أُرسل ${live.calls.length} مرات — حلقة خطأ ستغرق الخدمة`);

  for (let i = 0; i < 50; i += 1) {
    live.emit("error", {
      message: `distinct-${i}`, filename: "https://ozktobacco.com/src/app.js", lineno: i + 100, colno: 1,
      error: Object.assign(new Error(`distinct-${i}`), { name: "Error", stack: `Error: distinct-${i}` }),
    });
  }
  check("سقف الجلسة عشرة بلاغات", live.calls.length === 10,
    `أُرسل ${live.calls.length} — لا سقف فعّال`);
}
{
  // ⚠️ انحدار ملاحظة Codex P1 الثانية على PR #202. بعد حجب العربية صارت كل
  // رسالة عربية `Error: [نص عربي محذوف]`، ومعالج الوعود لا يعطي filename ولا
  // lineno — فالبصمة تطابقت لكل رفض عربي وابتُلع كل ما بعد الأوّل. أُثبت
  // بالتشغيل: رفضان مختلفان أنتجا بلاغاً واحداً.
  const live = boot({ meta: LIVE_META });
  const reject = (msg, fn, file, line) => live.emit("unhandledrejection", {
    reason: Object.assign(new Error(msg), {
      name: "Error", stack: `Error: ${msg}\n  at ${fn} (https://ozktobacco.com/src/${file}:${line}:1)`,
    }),
  });
  reject("فشل حفظ الطلب", "saveOrder", "app.js", 10);
  reject("تعذر جلب الأسعار", "fetchPrices", "supabase-client.js", 99);
  check("رفضان عربيان مختلفان يُرسَلان بلاغين لا بلاغاً واحداً",
    live.calls.length === 2,
    `أُرسل ${live.calls.length} — الحجب وحّد العناوين فابتلعت البصمةُ أخطاءً مختلفة`);
  reject("فشل حفظ الطلب", "saveOrder", "app.js", 10);
  check("الرفض المتطابق فعلاً ما زال يُبتلَع مرة واحدة",
    live.calls.length === 2, `فقد منعُ التكرار أثره — ${live.calls.length}`);
}
{
  const live = boot({ meta: LIVE_META });
  live.emit("unhandledrejection", { reason: Object.assign(new Error("rejected"), { name: "RangeError", stack: "RangeError: rejected" }) });
  check("الوعود المرفوضة تُلتقَط", live.calls.length === 1, "لم يُلتقَط unhandledrejection");
  check("رسالة الرفض تصل كاملة",
    String(live.calls[0]?.body?.data?.body?.message?.body || "").includes("rejected"),
    "ضاعت رسالة الرفض");
}
{
  // fetch يرمي مباشرةً (حاجب إعلانات، CSP، شبكة مقطوعة): يجب ألّا يصعد الاستثناء
  // إلى معالج الخطأ العام فيتحوّل عطلُ رصدٍ إلى عطل تطبيق.
  const live = boot({ meta: LIVE_META, fetchImpl: () => { throw new Error("network down"); } });
  let threw = false;
  try {
    live.emit("error", { message: "x", filename: "a.js", lineno: 1, colno: 1, error: new Error("x") });
  } catch { threw = true; }
  check("فشل الإرسال لا يُسقِط التطبيق", !threw, "استثناء المُرسِل تسرّب إلى معالج الخطأ العام");
}

// ===== 5) حجب بيانات العمل والأشخاص (P1-1) =====
//
// ⚠️ كل البيانات أدناه **صناعية بالكامل**: أسماء وأرقام وهواتف وبُرد مُختلَقة
// لهذا الفحص وحده. لا بيانات زبون حقيقي في هذا الملف، ولا حمولة تغادر إلى أي
// خدمة أثناء الفحص — `fetch` محاكاة محلية تُجمّع الطلبات في مصفوفة.
//
// العقد: `scrub` تحجب الأسرار، وهذه الطبقة تحجب **بيانات العمل والأشخاص**.
// أثبت التدقيق أن الثانية كانت غائبة تماماً: مرّت ست حالات حرفيةً بلا تغيير.
console.log("\n— حجب بيانات العمل والأشخاص —");
{
  const live = boot({ meta: LIVE_META });
  const redact = live.context.ozkErrorMonitoring.redactBusinessData;
  const redactStack = live.context.ozkErrorMonitoring.redactStack;

  const BUSINESS = [
    ["اسم زبون ورصيده", 'فشل حفظ رصيد الزبون "محمد العلي" = 1,250,000 ل.س', ["محمد", "العلي", "1,250,000"]],
    ["JSON رصيد وحدّ ائتمان", '{"customer_name":"أبو زياد","balance":1250000,"credit_limit":500000}', ["أبو", "زياد", "1250000", "500000"]],
    ["رقم فاتورة وقيمتها", "فاتورة INV-2291 بمبلغ 3,400,000", ["2291", "3,400,000"]],
    ["هاتف دولي", "تعذر إرسال رسالة إلى +963991234567", ["963991234567"]],
    ["هاتف محلي", "phone 0991234567 unreachable", ["0991234567"]],
    ["بريد إلكتروني", "notify failed for owner@example.com", ["owner@example.com"]],
    ["اسم موظف من تعارض جرد", "تم جرد هذا الصنف بواسطة سامر الحلبي", ["سامر", "الحلبي"]],
    ["اسم صنف تجاري", '{"item_key":"TOB-001","name":"غلواز قصير أحمر"}', ["غلواز", "قصير", "أحمر"]],
    ["اسم عربي داخل نصّ إنجليزي", 'saveCustomer failed for زبون تجريبي', ["زبون", "تجريبي"]],
  ];
  for (const [label, input, leaks] of BUSINESS) {
    const out = redact(input);
    check(`تُحجب: ${label}`, leaks.every((x) => !out.includes(x)),
      `بقي شيء من ${JSON.stringify(leaks)} — صار: ${out}`);
  }

  // الاسم الثنائي يُجمَع في علامة واحدة: علامتان متجاورتان تكشفان عدد الكلمات.
  check("الاسم الثنائي علامة واحدة لا علامتان",
    (redact("الزبون محمد العلي").match(/\[نص عربي محذوف\]/g) || []).length === 1,
    `عدد العلامات يكشف بنية الاسم — صار: ${redact("الزبون محمد العلي")}`);

  // ⚠️ انحدار ملاحظة Codex P1 الثالثة على PR #202 — الهاتف المحلي المفصول.
  // لا `+` فيه ولا فواصل آلاف، فكانت قاعدة الأربع خانات تبتلع مجموعة واحدة
  // وتترك الباقي: `0991 234 567` صار `[رقم محذوف] 234 567`. أُثبت بالتشغيل.
  for (const [label, input, leaks] of [
    ["هاتف بفواصل فراغ", "phone 0991 234 567", ["234", "567"]],
    ["هاتف بشرطات", "phone 099-123-4567", ["099", "123"]],
    ["هاتف بأقواس", "call (099) 123-4567", ["123", "4567"]],
    ["هاتف متّصل", "phone 0991234567", ["0991234567"]],
  ]) {
    const out = redact(input);
    check(`يُحجب الهاتف كاملاً: ${label}`, leaks.every((x) => !out.includes(x)),
      `بقي جزء من الهاتف — صار: ${out}`);
  }
  // والحدّ الذي يمنع ابتلاع نصّ عادي: سبع خانات فأكثر بعد طرح الفواصل.
  check("تسلسل أرقام قصير لا يُعَدّ هاتفاً", redact("at 1 2 3") === "at 1 2 3",
    `أُفسد نصّ عادي — صار: ${redact("at 1 2 3")}`);

  // ⚠️ انحدار ملاحظة Codex P1 الرابعة على PR #202 — القيم المالية القصيرة.
  // حدّ الأربع خانات كان يحمي رموز الحالة لكنه يترك الأرصدة والأسعار الصغيرة،
  // وهي بالضبط ما طُلب حجبه. الحجب هنا بالسياق لا بالطول.
  for (const [label, input, leak] of [
    ["رصيد ثلاثي", "balance=999", "999"],
    ["سعر بفراغ", "price 350 USD", "350"],
    ["سعر في JSON", '{"price":403}', "403"],
    ["رصيد وحدّ ائتمان قصيران", '{"balance":880,"credit_limit":500}', "880"],
    ["حدّ الائتمان نفسه", '{"balance":880,"credit_limit":500}', "500"],
    ["رقم فاتورة ثلاثي", "invoice_no=221", "221"],
    ["مبلغ مستحق", '{"total_due":75}', "75"],
  ]) {
    check(`تُحجب القيمة المالية القصيرة: ${label}`, !redact(input).includes(leak),
      `بقي «${leak}» — الأرصدة والأسعار بيانات عمل مهما قصرت: ${redact(input)}`);
  }
  // والجانب المقابل: `status` ليست حقلاً تجارياً، ورموز الحالة تبقى للتشخيص.
  for (const intact of [
    "Failed to load resource: the server responded with a status of 500",
    "Uncaught Error: Request failed with status code 404",
    "the price of the item is unavailable",
    "ChunkLoadError: Loading chunk 12 failed",
  ]) {
    check(`نصّ تشخيصي لا يُمَسّ: «${intact.slice(0, 44)}…»`, redact(intact) === intact,
      `أُفسد نصّ تشخيصي — صار: ${redact(intact)}`);
  }

  // الجانب المقابل: ما يجب أن **يبقى** كي تظل المراقبة مفيدة.
  for (const [label, input, kept] of [
    ["اسم صنف الخطأ", "TypeError: Cannot read properties of undefined", "TypeError"],
    ["اسم الخاصية المعطوبة", "Cannot read properties of undefined (reading 'approved_price_items')", "approved_price_items"],
    ["رمز حالة HTTP", "Failed to load resource: the server responded with a status of 500", "500"],
    ["نصّ تشخيصي إنجليزي", "Cannot read properties of undefined", "Cannot read properties"],
    ["اسم دالة", "at renderInventoryReport", "renderInventoryReport"],
  ]) {
    check(`يبقى للتشخيص: ${label}`, redact(input).includes(kept),
      `ضاع «${kept}» — صارت البلاغات بلا قيمة: ${redact(input)}`);
  }

  // ترتيب القواعد ليس تجميلياً: الفاصلة العربية (\u060C) والأرقام الهندية
  // (\u0660-\u0669) تقعان **داخل** نطاق الحروف العربية. فلو سبقت قاعدةُ
  // العربية قواعدَ الأرقام لالتقطت الفواصل وحدها وحوّلت `1،250،000` إلى
  // ثلاث مجموعات من ثلاث خانات لا يطابقها حدّ الأربع خانات — فيتسرّب الرصيد.
  for (const [label, input, leak] of [
    ["رصيد بفاصلة عربية", "رصيد 1،250،000 ل.س", "250"],
    ["رصيد بأرقام هندية", "رصيد \u0661\u0662\u0665\u0660\u0660\u0660\u0660 ل.س", "\u0661\u0662\u0665"],
    ["رصيد بأرقام هندية وفاصلة", "\u0661\u060C\u0662\u0665\u0660\u060C\u0660\u0660\u0660", "\u0662\u0665\u0660"],
  ]) {
    check(`ترتيب القواعد يحمي: ${label}`, !redact(input).includes(leak),
      `تسرّب «${leak}» — قاعدة الأرقام يجب أن تسبق قاعدة العربية: ${redact(input)}`);
  }

  // تركيب الطبقتين: علامة السرّ عربيةُ النصّ، فلو لم تُحمَ لالتهمتها قاعدةُ
  // العربية وتحوّل «سرّ محذوف» إلى «نص عربي محذوف» — فيضيع تمييز نوع الحجب.
  // ولو عُكس الترتيب لحُجبت أرقامُ رمزٍ سرّي قبل أن تتعرّف عليه قواعد الأسرار.
  for (const [label, input, gone] of [
    ["كلمة سرّ + اسم + رصيد", 'فشل تسجيل الزبون محمد password="Hunter2Hunter2" رصيد 1,250,000',
     ["Hunter2Hunter2", "محمد", "1,250,000"]],
    ["ترويسة ترخيص + اسم زبون", "Authorization: Bearer opaque-session-9911 للزبون أبو زياد",
     ["opaque-session-9911", "زياد"]],
  ]) {
    const out = redact(live.context.ozkErrorMonitoring.scrub(input));
    check(`الطبقتان معاً: ${label}`,
      gone.every((x) => !out.includes(x)) && out.includes("[سرّ محذوف]"),
      `إمّا تسرّب شيء وإمّا ضاع تمييز علامة السرّ — صار: ${out}`);
  }

  // --- أثر المكدّس: قائمة سماح، لا قائمة منع ---
  const STACK = 'Error: فشل حفظ رصيد الزبون "محمد العلي" = 1,250,000\n'
    + "  at saveBalance (https://ozktobacco.com/src/app.js:11830:25)\n"
    + "  at HTMLButtonElement.onclick (https://ozktobacco.com/src/app.js:9002:11)";
  const rs = redactStack(STACK);
  check("الأثر: سطر الرسالة (غير الإطار) يسقط كاملاً",
    !rs.includes("محمد") && !rs.includes("1,250,000"),
    `تسرّبت بيانات من سطر رسالة الأثر — صار: ${rs}`);
  check("الأثر: الإطارات تبقى كاملة بأرقام سطورها وأعمدتها",
    rs.includes("src/app.js:11830:25") && rs.includes("src/app.js:9002:11") && rs.includes("saveBalance"),
    `ضاعت أطر المكدّس — لا يبقى ما يُشخَّص به: ${rs}`);
  check("الأثر: صيغة Firefox/Safari مقبولة كإطار",
    redactStack("saveBalance@https://ozktobacco.com/src/app.js:11830:25").includes("11830:25"),
    "أُسقطت أطر متصفحات غير V8 — تصير بلاغات Safari بلا أثر");
  // ⚠️ انحدار ملاحظة Codex P1 الأولى على PR #202. V8 يضع نصّ الرسالة حرفياً
  // في أوّل `error.stack`، فرسالة تحمل سطراً يبدأ بـ`at ` كانت تُصنَّف إطاراً،
  // والإطار مُعفى من قاعدة الأرقام عمداً — فمرّ الرصيد كاملاً. الشاهد يثبت
  // الأمرين: السطر المزيّف يسقط، **و**لا رقم يمرّ تحت غطاء إطار.
  {
    const forged = "Error: x\n at customer balance 1,250,000 و رصيد 987654\n  at f (https://h.com/a.js:1:2)";
    const out = redactStack(forged);
    check("الأثر: سطر رسالة يبدأ بـ«at » لا يُعَدّ إطاراً",
      !out.includes("1,250,000") && !out.includes("987654"),
      `مرّ رقم تحت غطاء إطار مزيّف — صار: ${out}`);
    check("الأثر: الإطار الحقيقي بعده يبقى سليماً",
      out.includes("a.js:1:2"), `أُسقط إطار حقيقي — صار: ${out}`);
  }
  // ⚠️ انحدار ملاحظة Codex P1 السادسة على PR #202 — لاحقة موقع مُصطنَعة.
  // كان صون اللاحقة غير مشروط، فسطر `at invoice:1250000:987654` يُقبل إطاراً
  // (ينتهي بـ`:رقم:رقم`) وتُصان لاحقته حرفياً — فيمرّ رصيد ورقم فاتورة تحت
  // غطاء «سطر وعمود». الآن تُصان اللاحقة فقط إن حمل رأسُ السطر مرجعَ مصدر.
  for (const [label, input, leaks] of [
    ["لاحقة مُصطنَعة بلا مسار", "Error: x\n at invoice:1250000:987654", ["1250000", "987654"]],
    ["لاحقة مُصطنَعة باسم عربي", "Error: x\n at رصيد:1250000:99", ["1250000"]],
  ]) {
    const out = redactStack(input);
    check(`الأثر: ${label}`, leaks.every((x) => !out.includes(x)),
      `مرّ رقم تحت غطاء لاحقة موقع — صار: ${out}`);
  }
  // ⚠️ انحدار ملاحظة Codex P1 الثامنة على PR #202. الجولة السابقة اشترطت
  // «أثر مصدر» لكنها قبلت أي شرطة أو امتداد في **أي موضع**، فيكفي إقحام `/`
  // أو `.js` قبل الرقمين كي تُصان اللاحقة حرفياً. الشرط الآن مزدوج: رأس
  // السطر ينتهي فعلاً باسم ملف أو جذر مسار، والرقمان محدودان بستّ خانات.
  for (const [label, input, leaks] of [
    ["شرطة مقحمة", "Error: x\n at invoice/path:1250000:987654", ["1250000", "987654"]],
    ["امتداد مقحم", "Error: x\n at bal.js:1250000:987654", ["1250000"]],
    ["امتداد مقحم وسط النصّ", "Error: x\n at a.js/customer:1250000:99", ["1250000"]],
  ]) {
    const out = redactStack(input);
    check(`الأثر: لاحقة مُصطنَعة تسقط رغم إقحام أثر مصدر (${label})`,
      leaks.every((x) => !out.includes(x)),
      `مرّ رقم تحت غطاء لاحقة موقع — صار: ${out}`);
  }

  // والمقابل: الإطار الحقيقي يحمل مسار ملفه دائماً، فلاحقته تبقى.
  for (const [label, input, kept] of [
    ["مسار كامل", "Error: x\n  at saveBalance (https://h.com/src/app.js:11830:25)", "app.js:11830:25"],
    ["مسار نسبي", "Error: x\n    at Object.<anonymous> (/src/app.js:1234:9)", "app.js:1234:9"],
    ["صيغة Firefox", "Error: x\nsaveBalance@https://h.com/src/app.js:11830:25", "app.js:11830:25"],
  ]) {
    check(`الأثر: لاحقة الإطار الحقيقي تبقى (${label})`, redactStack(input).includes(kept),
      `ضاعت لاحقة موقع حقيقية — صار: ${redactStack(input)}`);
  }

  // ⚠️ انحدار ملاحظة Codex P1 السابعة على PR #202 — إشارة أو رمز عملة قبل القيمة.
  for (const [label, input, leak] of [
    ["إشارة سالبة", "balance -999", "999"],
    ["رمز دولار", "price $350", "350"],
    ["فراغ بعد الإشارة", "total - 480", "480"],
    ["عملة مع فاصل", "amount $1,200", "1,200"],
  ]) {
    check(`تُحجب القيمة المُشارة: ${label}`, !redact(input).includes(leak),
      `بقي «${leak}» — الإشارة ورمز العملة أشيع ما يسبق مبلغاً: ${redact(input)}`);
  }
  // ⚠️ انحدار ملاحظة Codex P1 التاسعة على PR #202: البديل غير المقتبَس كان
  // يقف عند أوّل فراغ، فعلى `price: USD 350` حُجبت `USD` ومرّ `350` —
  // والقاعدة العامة تُبقي الثلاثيات عمداً فلا شيء يلتقطه بعدها.
  for (const [label, input, leak] of [
    ["عملة نصّية قبل الرقم", "price: USD 350", "350"],
    ["إشارة مفصولة بفراغ", "balance = - 999", "999"],
    ["ليرة سورية", "total: SYP 480", "480"],
    ["عملة نصّية بصيغة الفراغ", "amount EUR 250", "250"],
  ]) {
    check(`تُبتلَع القيمة المالية كاملةً: ${label}`, !redact(input).includes(leak),
      `بقي «${leak}» — القيمة تُبتلَع كوحدة لا حتى أوّل فراغ: ${redact(input)}`);
  }

  check("«the price of the item» لا يُمَسّ رغم توسيع القاعدة",
    redact("the price of the item is unavailable") === "the price of the item is unavailable",
    "توسيع القاعدة أفسد نصّاً إنجليزياً عادياً");

  // الحزام الثاني: حتى داخل إطار حقيقي، لا يبقى رقم إلا لاحقة الموقع.
  check("الأثر: الأرقام داخل الإطار تُحجب إلا لاحقة الموقع",
    (() => {
      const out = redactStack("Error: x\n  at pay1250000 (https://h.com/a.js:4321:7)");
      return !out.includes("1250000") && out.includes(":4321:7");
    })(),
    "إمّا مرّ رقم داخل الإطار وإمّا ضاعت لاحقة الموقع");

  check("الأثر: إطار Safari الداخلي يبقى (لا موقع فيه ولا بيانات)",
    redactStack("Error: x\nrequestAnimationFrame@[native code]").includes("requestAnimationFrame"),
    "أُسقط إطار داخلي لا يحمل بيانات — بتر لأثر Safari بلا مكسب");
  check("الأثر: نصّ حرّ مدسوس بين الأطر يسقط",
    !redactStack("Error: x\nزبون سرّي هنا\n  at f (a.js:1:2)").includes("زبون"),
    "نصّ غير إطار وجد طريقه إلى الخارج");
  check("الأثر: أسطر السقوط المتتالية تُدمَج",
    (redactStack("Error: a\nb\nc\n  at f (a.js:1:2)").match(/سطر غير إطار/g) || []).length === 1,
    "امتلأ الأثر بعلامات السقوط");

  // --- الفحص الأقوى: الحمولة المرسَلة فعلاً، من طرف إلى طرف ---
  const e2e = boot({ meta: LIVE_META });
  e2e.emit("error", {
    message: "m",
    filename: "https://ozktobacco.com/src/app.js?v=tobacco-179",
    lineno: 11830,
    colno: 25,
    error: Object.assign(
      new Error('فشل حفظ رصيد الزبون "محمد العلي" = 1,250,000 ل.س فاتورة INV-2291 هاتف +963991234567 بريد owner@example.com'),
      { name: "Error",
        stack: 'Error: فشل حفظ رصيد الزبون "محمد العلي"\n  at saveBalance (https://ozktobacco.com/src/app.js:11830:25)' }),
  });
  const wire = JSON.stringify(e2e.calls[0] || {});
  for (const leak of ["محمد", "العلي", "1,250,000", "2291", "963991234567", "owner@example.com", "زبون"]) {
    check(`لا يغادر الحمولةَ: «${leak}»`, !wire.includes(leak),
      `وصل «${leak}» إلى طرف ثالث في الحمولة المرسَلة فعلاً`);
  }
  check("الحمولة تبقى مفيدة: الموقع كامل رغم الحجب",
    e2e.calls[0]?.body?.data?.custom?.lineno === 11830 &&
    e2e.calls[0]?.body?.data?.custom?.colno === 25 &&
    String(e2e.calls[0]?.body?.data?.body?.message?.stack || "").includes("app.js:11830:25"),
    "ضاع الموقع مع البيانات — الحجب أفرغ البلاغ بدل أن يؤمّنه");
}

// ===== 6) رصد فشل التسليم (P1-2) =====
//
// `fetch` لا يرفض على 4xx/5xx، و`.catch` الفارغة كانت تبتلع كل شيء — فرمز
// مرفوض أو حصة مستنفدة كانت تمرّ بصمت تامّ ويبقى «مفعّل» ادّعاءً بلا سند.
console.log("\n— رصد فشل التسليم —");
{
  const boom = (i = 0) => ({
    message: `e${i}`, filename: "https://ozktobacco.com/src/app.js", lineno: 100 + i, colno: 1,
    error: Object.assign(new Error(`e${i}`), { name: "Error", stack: `Error: e${i}\n  at f (app.js:${100 + i}:1)` }),
  });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  for (const status of [401, 403, 429, 500, 503]) {
    const live = boot({ meta: LIVE_META, respondWith: { ok: false, status } });
    live.emit("error", boom());
    await tick();
    const d = live.context.ozkErrorMonitoring.delivery();
    check(`${status} لا يُعامَل إرسالاً ناجحاً`,
      d.delivered === 0 && d.failures === 1 && d.lastFailureStatus === status,
      `حالة ${status} حُسبت نجاحاً أو ضاعت — ${JSON.stringify(d)}`);
    check(`${status} لا يُنتج console.error`, live.consoleErrors.length === 0,
      `أداة الرصد صارت مصدر ضجيج يكسر دخان ما بعد النشر`);
  }

  {
    const live = boot({ meta: LIVE_META });
    live.emit("error", boom());
    await tick();
    const d = live.context.ozkErrorMonitoring.delivery();
    check("200 يُحصى نجاحاً", d.delivered === 1 && d.failures === 0, JSON.stringify(d));
  }

  {
    const live = boot({ meta: LIVE_META, fetchImpl: () => Promise.reject(new Error("network down")) });
    live.emit("error", boom());
    await tick();
    const d = live.context.ozkErrorMonitoring.delivery();
    check("رفض الشبكة يُسجَّل فشلاً بلا حالة HTTP",
      d.failures === 1 && d.lastFailureStatus === 0, JSON.stringify(d));
    check("رفض الشبكة لا يكسر التطبيق ولا يُنتج ضجيجاً",
      live.consoleErrors.length === 0, "ظهر console.error عند انقطاع الشبكة");
  }

  {
    const live = boot({ meta: LIVE_META, respondWith: { ok: false, status: 401 } });
    for (let i = 0; i < 6; i += 1) { live.emit("error", boom(i)); await tick(); }
    check("قاطع الدارة: يتوقف الإرسال بعد ثلاثة إخفاقات قاتلة متتالية",
      live.calls.length === 3, `أُرسل ${live.calls.length} — رمز مرفوض يغرق شبكة الزبون بلا مقابل`);
    check("قاطع الدارة: الحالة تُبلّغ عن التوقف",
      live.context.ozkErrorMonitoring.delivery().stopped === true, "لا سبيل لاكتشاف أن الإرسال توقف");
  }

  // ⚠️ انحدار ملاحظة Codex P1 الخامسة على PR #202 — التعافي بعد عطل عابر.
  // كان قاطع الدارة يَعُدّ كل إخفاق ومنها انقطاع الشبكة (حالة 0)، فثلاثة
  // أخطاء أثناء انقطاع مؤقّت على الهاتف تُعطّل المراقبة **نهائياً** لبقية عمر
  // الصفحة: البوّابة تمنع كل طلب تالٍ، ومسارُ النجاح الذي يصفّر العدّاد لا
  // يعمل إلا بطلب. الآن: القاتل وحده يوقف، والعابر يُسجَّل ولا يوقف.
  {
    let offline = true;
    const live = boot({
      meta: LIVE_META,
      fetchImpl: () => (offline
        ? Promise.reject(new Error("network down"))
        : Promise.resolve({ ok: true, status: 200 })),
    });
    for (let i = 0; i < 4; i += 1) { live.emit("error", boom(i)); await tick(); }
    check("انقطاع الشبكة لا يوقف المراقبة نهائياً",
      live.context.ozkErrorMonitoring.delivery().stopped === false,
      "عطل عابر عطّل المراقبة لبقية عمر الصفحة");
    offline = false;
    live.emit("error", boom(90));
    await tick();
    check("المراقبة تتعافى فعلاً بعد عودة الاتصال",
      live.context.ozkErrorMonitoring.delivery().delivered === 1,
      "لم يصل أي بلاغ بعد عودة الشبكة — لا تعافي");
  }
  for (const status of [429, 500, 503]) {
    const live = boot({ meta: LIVE_META, respondWith: { ok: false, status } });
    for (let i = 0; i < 4; i += 1) { live.emit("error", boom(i)); await tick(); }
    check(`${status} عابر: لا يوقف المراقبة نهائياً`,
      live.context.ozkErrorMonitoring.delivery().stopped === false,
      `حالة ${status} عابرة (حصة أو عطل خدمة) عُوملت كعطل إعداد دائم`);
  }
  for (const status of [401, 403]) {
    const live = boot({ meta: LIVE_META, respondWith: { ok: false, status } });
    for (let i = 0; i < 6; i += 1) { live.emit("error", boom(i)); await tick(); }
    check(`${status} قاتل: يوقف بعد ثلاثة`,
      live.calls.length === 3 && live.context.ozkErrorMonitoring.delivery().stopped === true,
      `رمز مرفوض يجب أن يوقف الإرسال — أُرسل ${live.calls.length}`);
  }

  {
    const live = boot({ meta: LIVE_META, respondWith: { ok: false, status: 401 } });
    live.emit("error", boom());
    await tick();
    const d = live.context.ozkErrorMonitoring.delivery();
    check("حالة التسليم لا تكشف الرمز ولا الحمولة",
      !JSON.stringify(d).includes(LIVE_META["data-token"]) && !("payload" in d) && !("token" in d),
      `تسرّب الرمز أو الحمولة عبر واجهة التشخيص: ${JSON.stringify(d)}`);
    check("فشل التسليم لا يولّد بلاغاً جديداً (لا ارتداد)",
      live.calls.length === 1, `أنتج الفشلُ إرسالاً إضافياً — حلقة ارتداد: ${live.calls.length}`);
  }

  {
    // غياب Rollbar كلياً: لا وسم ⇒ لا مستمعات ⇒ التطبيق يعمل كأن الملف غير موجود.
    const absent = boot({ meta: null });
    check("غياب الإعداد لا يكسر شيئاً ولا يكشف واجهة",
      absent.listeners.size === 0 && absent.context.ozkErrorMonitoring === undefined && absent.calls.length === 0,
      "الملف ترك أثراً رغم غياب الإعداد");
  }
}

// ===== 7) التوصيل في المستودع =====
console.log("\n— التوصيل —");
{
  const html = readFileSync(resolve(root, "index.html"), "utf8");
  const sw = readFileSync(resolve(root, "public/service-worker.js"), "utf8");

  check("index.html يحمل النوّاب الثلاثة (لا رمز في Git)",
    html.includes("__ROLLBAR_CLIENT_TOKEN__") &&
    html.includes("__DEPLOY_ENVIRONMENT__") &&
    html.includes("__DEPLOY_COMMIT__"),
    "اختفى نائب — إمّا الحقن صار صامتاً وإمّا الرمز الحقيقي التُزم في المستودع");

  const tokenAttr = html.match(/data-token="([^"]*)"/)?.[1] || "";
  check("قيمة data-token في المستودع نائب لا رمز حقيقي",
    tokenAttr.startsWith("__"),
    `data-token يحمل قيمة غير نائبة — سرّ في المستودع: ${tokenAttr.slice(0, 8)}…`);

  check("CSP تسمح بنقطة استقبال Rollbar على connect-src وحدها",
    /connect-src[^;]*https:\/\/api\.rollbar\.com/.test(html) &&
    !/script-src[^;]*rollbar/.test(html),
    "إمّا connect-src تمنع الإرسال، وإمّا رُخِّيت script-src لطرف ثالث");

  check("السكربت مُحمَّل مع معامل النسخة",
    /src\/error-monitoring\.js\?v=tobacco-\d+/.test(html),
    "بلا معامل النسخة يبقى الملف مخبّأً في متصفح الزبون بعد كل نشر");

  check("الملف مُحمَّل قبل src/app.js (وإلا فاتته أخطاء الإقلاع)",
    html.indexOf("src/error-monitoring.js") < html.indexOf("src/app.js"),
    "تحميل المراقبة بعد التطبيق يُضيّع أخطاء أول ثانية");

  check("service worker يُخبّئ الملف مسبقاً",
    sw.includes('"src/error-monitoring.js"'),
    "بلا تخبئة مسبقة يفشل تحميله عند انقطاع الشبكة");

  const pages = readFileSync(resolve(root, ".github/workflows/pages.yml"), "utf8");
  check("خط النشر يحقن الإعداد من سرّ GitHub",
    pages.includes("ROLLBAR_POST_CLIENT_ITEM_TOKEN") && pages.includes("Inject error monitoring configuration"),
    "اختفت خطوة الحقن — ستُنشَر المراقبة معطّلة بلا إنذار");
  check("الحقن يسبق رفع معامل النسخة",
    pages.indexOf("Inject error monitoring configuration") < pages.indexOf("Bump asset version marker"),
    "ترتيب معكوس يخاطر بتداخل الاستبدالين على index.html");
}

if (failed > 0) {
  console.error(`\n✗ فشل ${failed} تأكيداً في حارس مراقبة الأخطاء.`);
  process.exit(1);
}
console.log("\n✓ حارس مراقبة الأخطاء: البوابة الإنتاجية والتنقية والحدّ والتوصيل كلها سليمة.");
