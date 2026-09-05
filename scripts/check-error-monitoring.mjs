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
function boot({ meta, protocol = "https:", hostname = "ozktobacco.com", fetchImpl } = {}) {
  const calls = [];
  const listeners = new Map();
  const metaElement = meta
    ? { getAttribute: (name) => (name in meta ? meta[name] : null) }
    : null;

  const context = {
    console,
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
    fetch: fetchImpl || ((url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return { catch: () => {} };
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

// ===== 5) التوصيل في المستودع =====
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
