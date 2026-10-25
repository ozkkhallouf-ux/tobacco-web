// سياسة الإرسال لدالة web-push: دوال صافية بلا أي استيراد ولا شبكة، كي تُختبر خارج Deno
// (scripts/check-web-push-policy.mjs). index.ts يستوردها؛ لا منطق قرار داخل حلقة الإرسال نفسها.

// مدة بقاء الرسالة لدى مزود Push (FCM/Apple) حتى يتصل الجهاز. كانت 300 ثانية، فكل ما أُرسل والماك نائم
// أو Chrome مغلق كلياً كان يُحذف بعد 5 دقائق ويُسجَّل «ناجحاً» لأن المزود قبله.
export const PUSH_TTL_SECONDS = 86400;
// رسالة الاختبار بلا قيمة بعد دقائق؛ تبقى قصيرة.
export const TEST_TTL_SECONDS = 300;
// رسالة بقيت في الصندوق أكثر من هذا لا تُرسل (لا دفعة إشعارات قديمة بعد نشر أو بعد عطل).
export const STALE_AFTER_MINUTES = 360;
// إعادة محاولة رسالة لم يقبلها أي اشتراك بسبب خطأ عابر فقط (429/5xx/شبكة)، بحدّ أقصى.
export const MAX_TRANSIENT_ATTEMPTS = 3;

// الأنواع التي تبقى ظاهرة حتى يغلقها المستخدم، إن سمح المتصفح والنظام بذلك (requireInteraction).
// لا شيء يفرض الصوت أو اللافتة: نمط العرض قرار إعدادات الجهاز.
const STICKY_EVENTS = new Set([
  "payment",
  "ameen_payment",
  "customer_request",
  "whatsapp_order",
  "credit_over",
  "sync_failure",
  "ameen_sync_outage",
  "price_sync_outage",
]);

const SITE = "https://ozktobacco.com";
const ICON = `${SITE}/public/icons/ozk-ios-full-notification-icon.png`;

type MaybeUser = { id?: string | null; app_metadata?: Record<string, unknown> | null } | null | undefined;

// مستلمو إشعارات المالك بالمعرّف الثابت في auth.users (قرار المالك 2026-10-24): ozkkhallouf@gmail.com وحده.
// لا يستلمها ozk.kh@outlook.com (employee) ولا ozkkhalouf@gmail.com (owner بلام واحدة). المعرّف لا يتغير بتغيير
// البريد، فلا تُعتمد المطابقة بالبريد. إضافة مستلم = إضافة معرّفه هنا بقرار صريح.
export const OWNER_PUSH_RECIPIENT_IDS: readonly string[] = ["3e5f16bb-1cc5-4acd-ade0-7189e54d7dde"];

// الشرطان معاً: المعرّف في القائمة، والدور owner في app_metadata (المصدر نفسه لـpublic.is_owner()).
// سحب دور owner من الحساب يوقف الاستلام حتى لو بقي معرّفه هنا.
export function isListedRecipientId(id: unknown): boolean {
  return OWNER_PUSH_RECIPIENT_IDS.includes(String(id ?? "").trim().toLowerCase());
}

export function isAuthorizedRecipient(user: MaybeUser): boolean {
  const role = String(user?.app_metadata?.role ?? "").trim().toLowerCase();
  return role === "owner" && isListedRecipientId(user?.id);
}

export type PushErrorKind = "expired" | "transient" | "rejected";

// 404/410: الاشتراك انتهى نهائياً ⇒ يُعطَّل. 429/5xx/بلا رمز (شبكة): عابر ⇒ يُسجَّل ويُعاد بحدود.
// غير ذلك (400/401/403/413...): رفض دائم لهذه الرسالة ⇒ يُسجَّل ولا يُعطَّل الاشتراك.
export function classifyPushError(statusCode: number): PushErrorKind {
  if (statusCode === 404 || statusCode === 410) return "expired";
  if (!statusCode || statusCode === 429 || statusCode >= 500) return "transient";
  return "rejected";
}

export function isStale(createdAt: string | null | undefined, now = Date.now()): boolean {
  const at = Date.parse(String(createdAt || ""));
  if (!Number.isFinite(at)) return false;
  return now - at > STALE_AFTER_MINUTES * 60_000;
}

type OutboxMessage = {
  id: number | string;
  event_type: string;
  title: string;
  body: string;
  tag?: string | null;
  navigate?: string | null;
};

// وسم فريد لكل رسالة: الوسم الثابت لكل نوع كان يجعل الإشعار الجديد يستبدل السابق بصمت.
// ويبقى الوسم ثابتاً للرسالة نفسها، فإن وصلت مرتين لاشتراك واحد استبدلت نفسها ولم تتكرر.
export function messageTag(message: OutboxMessage): string {
  const base = String(message.tag || message.event_type || "ozk-alert").slice(0, 60);
  return `${base}-${message.id}`;
}

export function buildMessagePayload(message: OutboxMessage) {
  const path = String(message.navigate || "/?route=overview");
  return {
    web_push: 8030,
    notification: {
      title: message.title,
      body: message.body,
      navigate: `${SITE}${path.startsWith("/") ? path : `/${path}`}`,
      tag: messageTag(message),
      renotify: true,
      require_interaction: STICKY_EVENTS.has(message.event_type),
      lang: "ar",
      dir: "rtl",
      icon: ICON,
      app_badge: "1",
    },
  };
}

export type DeliveryTally = { accepted: number; failed: number; transientOnly: boolean };

// حالة سجل الصندوق بعد جولة إرسال. «sent» تعني أن مزوداً واحداً على الأقل قبل الرسالة، لا أنها ظهرت.
export function outboxOutcome(tally: DeliveryTally, previousAttempts: number, lastError = "") {
  const attempts = Number(previousAttempts || 0) + 1;
  if (tally.accepted > 0) return { status: "sent" as const, attempts, last_error: null };
  if (tally.failed === 0) return { status: "failed" as const, attempts, last_error: "no_authorized_subscriptions" };
  if (tally.transientOnly && attempts < MAX_TRANSIENT_ATTEMPTS) {
    return { status: "pending" as const, attempts, last_error: "transient_retry" };
  }
  return { status: "failed" as const, attempts, last_error: lastError || "all_subscriptions_failed" };
}
