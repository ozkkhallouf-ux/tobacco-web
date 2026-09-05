// انتظار جهوزية خط النشرة داخل صفحة التطبيق — مشترك بين حرّاس الطباعة.
//
// لماذا يلزم الحرّاس: التصدير يختم قرار الخط على الترميز
// (`data-fallback-font` — راجع src/price-list-template.js). فإن لم يجهز الخط
// وقت الضغط، يُقاس المستند ويُطبع بالسلسلة الاحتياطية — وهي تختلف بين الأنظمة
// وقد لا تُشكّل العربية أصلاً على لينكس. فتفشل مطابقةُ نصّ الصفوف لسببٍ يخصّ
// **نظام التشغيل** لا الكود (وقع فعلاً على CI: «أصناف كل ورقة = [0, 0, 0]»).
//
// المستخدم الحقيقي يفتح المعاينة ثم يضغط، والخط يكون قد وصل. فينتظره الحارس
// كذلك قبل التصدير، ويُصرّح بالانتظار كشرطٍ صريح بدل أن يمرّ بصمت.
//
// الكشف من **نفس المسار الذي يرسم به المتصفح**: عرضُ نصٍّ في DOM بخط النشرة
// مقابل خطّ ضابط. لا `document.fonts.check` (يُرجع true بعد فشل التحميل أيضاً)
// ولا `canvas.measureText` (مسار مطابقة منفصل يتأخّر عن الرسم، فيعطي نتائج
// متضاربة بين تشغيل وآخر). ويشمل كل وزن × كل مجموعة محارف يطلبها القالب.
export const FONT_USABLE_PROBE = `() => {
  const T = window.OZKPriceListTemplate;
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;left:-10000px;top:0;visibility:hidden;pointer-events:none;white-space:pre;font-size:40px;line-height:1";
  document.body.appendChild(probe);
  try {
    const widthOf = (family, weight, text) => {
      probe.style.fontFamily = family;
      probe.style.fontWeight = String(weight);
      probe.textContent = text;
      return probe.getBoundingClientRect().width;
    };
    return T.BULLETIN_FONT_WEIGHTS.every((weight) => T.BULLETIN_FONT_SAMPLES.every((sample) => {
      const control = widthOf("monospace", weight, sample);
      const candidate = widthOf('"' + T.BULLETIN_FONT_FAMILY + '",monospace', weight, sample);
      return Math.abs(candidate - control) > 0.5;
    }));
  } finally { probe.remove(); }
}`;

export async function waitForBulletinFont(page, timeout = 20000) {
  try {
    await page.waitForFunction(`(${FONT_USABLE_PROBE})()`, null, { timeout });
    return true;
  } catch {
    return false;
  }
}
