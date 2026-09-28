// ساعة فحص توجيه المساعد.
//
// check-assistant-routing.mjs يسأل المساعد عن «هذا الأسبوع» و«آخر 7 أيام»
// و«هذا الشهر»، والمساعد يحسب الفترة من Date.now() بتوقيت دمشق (+180 دقيقة،
// بلا توقيت صيفي). نتيجة بعض التأكيدات تتغيّر مع شكل التقويم:
//   - الجمعة: الأسبوع السوري (السبت → الجمعة) هو نفسه آخر 7 أيام.
//   - السبت/الأحد: «هذا الأسبوع» يوم أو يومان، وقد يغطيها تقريرا اليوم وأمس
//     بالكامل فلا تبقى فجوة تُعلَن.
//   - اليوم 1–3 من الشهر: «هذا الشهر» أقصر من أن يجمع ثلاثة أيام مع فجوة.
//
// هذا الملف يُستورد قبل assistant-harness.mjs لأن الحمولة تثبّت «اليوم» لحظة
// الاستيراد. إن وُجد CHECK_ASSISTANT_ROUTING_NOW=YYYY-MM-DD تُستبدل Date
// العالمية بذلك اليوم (12:00 UTC، فيبقى التاريخ نفسه بتوقيت دمشق). بلا المتغير
// تبقى ساعة العملية، فيمرّ الفحص على أي يوم تشغيل حقيقي بالتوقعات المحسوبة
// من الساعة نفسها لا من يوم ثابت مخفي.
const RAW_NOW = (process.env.CHECK_ASSISTANT_ROUTING_NOW || "").trim();

if (RAW_NOW) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(RAW_NOW)) {
    throw new Error(`CHECK_ASSISTANT_ROUTING_NOW يجب أن يكون YYYY-MM-DD، وصل: ${RAW_NOW}`);
  }
  const [year, month, day] = RAW_NOW.split("-").map(Number);
  const fixed = Date.UTC(year, month - 1, day, 12, 0, 0, 0);
  const check = new Date(fixed);
  if (
    check.getUTCFullYear() !== year
    || check.getUTCMonth() !== month - 1
    || check.getUTCDate() !== day
  ) {
    throw new Error(`CHECK_ASSISTANT_ROUTING_NOW ليس تاريخاً تقويمياً: ${RAW_NOW}`);
  }
  const RealDate = Date;
  class FixedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fixed);
      else super(...args);
    }
    static now() {
      return fixed;
    }
  }
  globalThis.Date = FixedDate;
}

const DAMASCUS_OFFSET_MINUTES = 180;

export function damascusDate(offsetDays = 0) {
  const now = new Date(Date.now() + DAMASCUS_OFFSET_MINUTES * 60_000 + offsetDays * 86_400_000);
  return now.toISOString().slice(0, 10);
}

export function isoAddDays(iso, offsetDays) {
  return new Date(Date.parse(`${iso}T00:00:00.000Z`) + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

export function datesInInclusiveRange(from, to) {
  const dates = [];
  let day = from;
  while (day <= to && dates.length < 366) {
    dates.push(day);
    day = isoAddDays(day, 1);
  }
  return dates;
}

// مواصفة الأسبوع المستقلة عن تنفيذ المساعد: الأسبوع يبدأ السبت،
// و«آخر 7 أيام» نافذة متحركة تنتهي اليوم، و«الأسبوع الماضي» السبت→الجمعة السابقان.
export function syrianWeekWindows() {
  const today = damascusDate(0);
  const weekday = new Date(Date.now() + DAMASCUS_OFFSET_MINUTES * 60_000).getUTCDay();
  const sinceSaturday = (weekday + 1) % 7;
  const thisFrom = damascusDate(-sinceSaturday);
  const prevEnd = isoAddDays(thisFrom, -1);
  const prevStart = isoAddDays(prevEnd, -6);
  const rollingFrom = damascusDate(-6);
  return {
    today,
    sinceSaturday,
    thisFrom,
    thisTo: today,
    prevStart,
    prevEnd,
    rollingFrom,
    rollingTo: today,
    thisWeek: `${thisFrom}→${today}`,
    lastWeek: `${prevStart}→${prevEnd}`,
    rolling: `${rollingFrom}→${today}`
  };
}
