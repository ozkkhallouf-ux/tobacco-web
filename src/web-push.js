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

  async function disable() {
    if (!("serviceWorker" in navigator)) return;
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager?.getSubscription();
    if (!subscription) return;
    try { await callPush("unsubscribe", { endpoint: subscription.endpoint }); } catch {}
    await subscription.unsubscribe();
  }

  async function status() {
    if (!supported()) return { supported: false, permission: "unsupported", subscribed: false };
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    return { supported: true, permission: Notification.permission, subscribed: Boolean(subscription) };
  }

  // لا مستمع نقر هنا بعد الآن: زر «تفعيل» في app.js يستدعي enable() مباشرة داخل
  // النقرة. كان هذا الملف يضيف مستمعاً ثانياً على الزر نفسه، فيُطلب الإذن مرتين
  // في نقرة واحدة، ويُبتلع فشل الاشتراك في console فقط.

  window.ozkWebPush = { enable, disable, status, supported };
})();
