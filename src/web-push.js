(function () {
  const config = window.appConfig?.supabase || {};
  const supported = () =>
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window &&
    Boolean(window.supabase?.createClient && config.url && config.publishableKey);

  let client = null;

  function getClient() {
    if (!client) {
      client = window.ozkSupabaseClient || window.supabase.createClient(config.url, config.publishableKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      });
      if (!window.ozkSupabaseClient) window.ozkSupabaseClient = client;
    }
    return client;
  }

  function base64UrlToUint8Array(value) {
    const padding = "=".repeat((4 - (value.length % 4)) % 4);
    const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    return Uint8Array.from(raw, (char) => char.charCodeAt(0));
  }

  async function sessionToken() {
    const { data, error } = await getClient().auth.getSession();
    if (error) throw error;
    const token = data?.session?.access_token;
    if (!token) throw new Error("سجّل الدخول أولاً لتفعيل الإشعارات.");
    return token;
  }

  async function callPush(action, payload = {}) {
    const token = await sessionToken();
    const response = await fetch(`${config.url.replace(/\/$/, "")}/functions/v1/web-push`, {
      method: "POST",
      headers: {
        apikey: config.publishableKey,
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ action, ...payload })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result?.error || `push_${response.status}`);
    return result;
  }

  async function enable() {
    if (!supported()) throw new Error("هذا الجهاز أو المتصفح لا يدعم Web Push.");

    // On iPhone/iPadOS this must happen directly from a user gesture.
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw new Error("لم يتم السماح بالإشعارات.");

    const registration = await navigator.serviceWorker.ready;
    await setDetachGuard(false);
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      const { publicKey } = await callPush("config");
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToUint8Array(publicKey)
      });
    }

    await callPush("subscribe", { subscription: subscription.toJSON() });
    await callPush("test");
    return subscription;
  }

  // فصل الجهاز عن الحساب عند الخروج (تدقيق الأجهزة المشتركة 2026-10-25): بلا ذلك يبقى اشتراك المتصفح
  // وصفّه في الخادم مفعّلين باسم المالك، فيعرض الجهاز إشعاراته المالية بعد الخروج ولمن يدخل بعده.
  const DETACH_TIMEOUT_MS = 3000;
  // علامة «خروج لم يكتمل فصله» (مهلة أو بلا شبكة أو أُغلق التبويب): تُستكمل عند الفتح التالي.
  const DETACH_PENDING_KEY = "ozk-push-detach-pending";

  function withTimeout(promise, ms, fallback) {
    return Promise.race([
      Promise.resolve(promise).catch(() => fallback),
      new Promise((done) => setTimeout(() => done(fallback), ms))
    ]);
  }

  function setDetachPending(pending) {
    try {
      if (pending) localStorage.setItem(DETACH_PENDING_KEY, "1");
      else localStorage.removeItem(DETACH_PENDING_KEY);
    } catch {}
  }

  function detachPending() {
    try { return localStorage.getItem(DETACH_PENDING_KEY) === "1"; } catch { return false; }
  }

  // علامة يقرؤها Service Worker (public/service-worker.js: ozkPushDetached) فيعرض نصاً عاماً بدل محتوى
  // المالك إن بقي اشتراك على جهاز مفصول. IndexedDB لا Cache Storage (activate يحذف الكاشات القديمة).
  // لا ترمي أبداً، وبمهلة: فشلها لا يمنع الخروج ولا التفعيل.
  function setDetachGuard(detached) {
    return withTimeout(new Promise((resolve) => {
      if (typeof indexedDB === "undefined") return resolve(false);
      const open = indexedDB.open("ozk-push-guard", 1);
      open.onupgradeneeded = () => { open.result.createObjectStore("state"); };
      open.onerror = () => resolve(false);
      open.onsuccess = () => {
        try {
          const db = open.result;
          const tx = db.transaction("state", "readwrite");
          tx.objectStore("state").put(detached === true, "detached");
          tx.oncomplete = () => { db.close(); resolve(true); };
          tx.onerror = () => { db.close(); resolve(false); };
        } catch {
          resolve(false);
        }
      };
    }), 1000, false);
  }

  // getRegistration لا ready: ready لا يُحسم أبداً إن لم يُسجَّل عامل، فيعلق الخروج.
  async function currentSubscription() {
    if (!("serviceWorker" in navigator) || typeof navigator.serviceWorker.getRegistration !== "function") return null;
    const registration = await navigator.serviceWorker.getRegistration();
    return (await registration?.pushManager?.getSubscription?.()) || null;
  }

  // إلغاء المتصفح هو ما يمنع العرض على هذا الجهاز، فلا يُشترط نجاح الخادم. نداء الخادم يعطّل صف
  // هذا الجهاز وحده (user_id + endpoint) ويحتاج الجلسة، فيُستدعى قبل signOut. الاثنان معاً بمهلة،
  // ولا يرمي أبداً: فشل الفصل لا يمنع الخروج.
  async function disable({ timeoutMs = DETACH_TIMEOUT_MS, server = true } = {}) {
    setDetachPending(true);
    const result = { subscribed: false, browser: false, server: false };
    const run = async () => {
      // العلامة أولاً: إن فشل الإلغاء أو علق، يبقى Service Worker يعرض نصاً عاماً لا محتوى المالك.
      await setDetachGuard(true);
      const subscription = await currentSubscription();
      if (!subscription) {
        result.browser = true;
        return;
      }
      result.subscribed = true;
      const endpoint = subscription.endpoint;
      await Promise.allSettled([
        Promise.resolve(subscription.unsubscribe()).then((ok) => { result.browser = ok !== false; }),
        server
          ? callPush("unsubscribe", { endpoint }).then(() => { result.server = true; })
          : Promise.resolve()
      ]);
    };
    await withTimeout(run(), timeoutMs, undefined);
    if (result.browser) setDetachPending(false);
    return { ...result };
  }

  // يُستدعى بعد كل تغيّر للجلسة (إقلاع، دخول، خروج). owner: يمسح علامة الفصل المعلّق ولا يلمس الاشتراك.
  // غير ذلك: يُستكمل فصل خروج سابق لم يكتمل. وتنظيف اشتراك المالك عند دخول حساب غير مالك (الخيار ج)
  // مفعّل بقرار المالك (2026-10-25: إشعاراته على Mac وiPhone وحدهما)، ويُطفأ بـappConfig.webPush.detachNonOwnerSessions = false.
  // المتصفح وحده: جلسة الموظف لا تملك صف المالك في الخادم، والمزود يرد 404/410 فيُعطَّل الصف تلقائياً.
  async function syncSession({ signedIn = false, owner = false, timeoutMs = DETACH_TIMEOUT_MS } = {}) {
    if (signedIn && owner) {
      setDetachPending(false);
      await setDetachGuard(false);
      return { action: "kept" };
    }
    const nonOwnerCleanup = signedIn && window.appConfig?.webPush?.detachNonOwnerSessions !== false;
    if (!detachPending() && !nonOwnerCleanup) return { action: "none" };
    const result = await disable({ timeoutMs, server: false });
    return { action: result.subscribed ? "detached" : "none", ...result };
  }

  async function status() {
    if (!supported()) return { supported: false, permission: "unsupported", subscribed: false };
    const subscription = await withTimeout(currentSubscription(), DETACH_TIMEOUT_MS, null);
    return { supported: true, permission: Notification.permission, subscribed: Boolean(subscription) };
  }

  // لا مستمع نقر هنا بعد الآن: زر «تفعيل» في app.js يستدعي enable() مباشرة داخل
  // النقرة. كان هذا الملف يضيف مستمعاً ثانياً على الزر نفسه، فيُطلب الإذن مرتين
  // في نقرة واحدة، ويُبتلع فشل الاشتراك في console فقط.

  window.ozkWebPush = { enable, disable, syncSession, status, supported };
})();
