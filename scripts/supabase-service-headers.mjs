// ترويسات مصادقة مفتاح الخدمة لطلبات Supabase REST من GitHub Actions.
//
// المفتاح القديم (service_role) JWT يُرسل في apikey وAuthorization معاً — سلوك الإنتاج كما هو.
// المفاتيح الجديدة (sb_secret_...) ليست JWT: تُرسل في apikey وحدها، وإن أُرسلت في
// Authorization: Bearer رفضتها المنصة بـ«Invalid JWT». فالتبديل إلى مفتاح sb_secret_
// مستقل لـActions لا يحتاج تعديل كود ولا يكسر التشغيل لحظة النقل.
export function supabaseServiceHeaders(serviceKey) {
  const key = String(serviceKey || "");
  return key.startsWith("sb_") ? { apikey: key } : { apikey: key, Authorization: `Bearer ${key}` };
}
