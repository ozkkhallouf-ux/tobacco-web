// ============================================================================
// تنسيق رسائل تيليغرام الموحّد — منطق نقي (Pure) بلا شبكة ولا DOM ولا إرسال.
//
// لماذا نص عادي لا HTML: كل التنبيهات تمرّ بـnotify_telegram ← telegram_outbox ←
// dispatch_telegram_outbox() الذي يرسل {chat_id, text} بلا parse_mode
// (supabase/telegram-notifications.sql). فأي وسم HTML يظهر حرفياً، وتفعيل
// parse_mode يحتاج هجرة على الإنتاج، و`left(p_message, 3900)` قد يقصّ وسماً من
// منتصفه فيرفض تيليغرام الرسالة كلها (تنبيه حرج يضيع). النص العادي آمن بطبيعته:
// `<` و`&` تظهر كما هي ولا تُفسَّر، فلا حاجة لـescaping ولا خطر حقن تنسيق.
//
// اتجاه النص (RTL) على الهواتف — خوارزمية Unicode Bidi تحدد اتجاه كل سطر من أول
// حرف «قوي» فيه، فاسم صنف لاتيني في أول السطر يقلب السطر كله، والرقم السالب
// «-5» يُعرض «5-» داخل جملة عربية. الحل:
//   • RLM (U+200F) في أول كل سطر ⇒ السطر عربي الاتجاه دائماً.
//   • الأسماء الديناميكية داخل FSI…PDI (U+2068/U+2069) ⇒ اسم مختلط لا يبعثر ما حوله.
//   • الأرقام داخل LRI…PDI (U+2066/U+2069) ⇒ «-5» و«1,234.5» تبقى كما هي.
//   • التاريخ والوقت داخل LRI…PDI أيضاً، وإلا انقلب «2026-10-14 23:00» إلى
//     «23:00 2026-10-14» (المسافة بين رقمين تأخذ اتجاه السطر العربي).
//   • الروابط لا تُعزل: تُوضع في آخر السطر كي يتعرّف عليها تيليغرام كاملة.
// وأي محارف اتجاه موجودة أصلاً في النص الوارد تُحذف قبل العزل كي لا يكسر اسمٌ
// العزلَ أو يقلب ما بعده.
//
// المستهلكون: src/stock-alert-priority.js (ونسخته في supabase/functions/_shared)،
// وscripts/health-check.mjs.
// النسخة ../supabase/functions/_shared/telegram-format.js مطابقة بايتاً ببايت
// (يفرضها scripts/check-telegram-format.mjs).
// ============================================================================
(function () {
  "use strict";

  const RLM = "\u200F";
  const LRI = "\u2066";
  const FSI = "\u2068";
  const PDI = "\u2069";
  const SEPARATOR = "┈┈┈┈┈┈┈┈┈┈┈┈";

  // حد تيليغرام 4096 وحدة UTF-16 للرسالة، وnotify_telegram يقتطع عند 3900 محرف.
  // نقسّم قبلهما بهامش، ونحسب بـ.length (وحدات UTF-16 ≥ عدد المحارف).
  const DEFAULT_MAX_CHARS = 3500;
  const MAX_NAME_CHARS = 120;
  const TIME_ZONE = "Asia/Damascus";
  const TIME_ZONE_LABEL = "دمشق";

  // مستويات الأهمية الموحّدة. المفتاح الإنجليزي للكود، والتسمية العربية للرسالة؛
  // ويُقبل كلاهما في severity() لأن بعض المنتجين يحملون التسمية العربية أصلاً.
  const SEVERITY = Object.freeze({
    critical: Object.freeze({ icon: "🔴", label: "حرج" }),
    high: Object.freeze({ icon: "🟠", label: "عالٍ" }),
    medium: Object.freeze({ icon: "🟡", label: "متوسط" }),
    low: Object.freeze({ icon: "🔵", label: "منخفض" }),
    ok: Object.freeze({ icon: "🟢", label: "سليم" }),
    info: Object.freeze({ icon: "ℹ️", label: "معلومة" })
  });
  const SEVERITY_ALIASES = Object.freeze({ "حرج": "critical", "عالٍ": "high", "عالي": "high", "عال": "high", "متوسط": "medium", "منخفض": "low", "سليم": "ok", "معلومة": "info" });

  // رموز العملات المعروفة؛ أي رمز آخر يُعرض بعد تنظيفه كما هو.
  const CURRENCY_SYMBOLS = Object.freeze({ USD: "$", "$": "$", SYP: "ل.س", "ل.س": "ل.س" });

  // محارف التحكم (عدا لا شيء) ومحارف الاتجاه الصريحة وفواصل الأسطر/الفقرات.
  const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2028\u2029\u2066-\u2069]/gu;

  // نص ديناميكي في سطر واحد: لا أسطر جديدة ولا محارف اتجاه ولا مسافات متكررة.
  function clean(value, maxChars = MAX_NAME_CHARS) {
    const flat = String(value ?? "").replace(CONTROL_RE, " ").replace(/\s+/gu, " ").trim();
    const chars = Array.from(flat);
    return chars.length > maxChars ? `${chars.slice(0, maxChars - 1).join("").trimEnd()}…` : flat;
  }

  // اسم ديناميكي (صنف/زبون/سير عمل) معزول الاتجاه.
  function name(value, fallback = "—", maxChars = MAX_NAME_CHARS) {
    const cleaned = clean(value, maxChars);
    return `${FSI}${cleaned || fallback}${PDI}`;
  }

  // تقريب «بعيداً عن الصفر» عند النصف، بالتمثيل العشري لا الثنائي:
  // 1.005 ⇒ 1.01 (لا 1)، و-2.25 ⇒ -2.3 (لا -2.2 كما يفعل Math.round).
  // يطابق round() على numeric في Postgres، فتتطابق رسائل SQL وJS لاحقاً.
  function roundHalfAway(n, digits) {
    const abs = Math.abs(n);
    const shifted = String(abs).includes("e") ? abs * 10 ** digits : Number(`${abs}e${digits}`);
    const back = Math.round(shifted);
    const value = String(back).includes("e") ? back / 10 ** digits : Number(`${back}e-${digits}`);
    return n < 0 ? -value : value;
  }

  // رقم بفواصل الآلاف وأرقام إنجليزية، معزول باتجاه LTR (السالب يبقى «-5»).
  function num(value, digits = 1) {
    const n = Number(value);
    if (!Number.isFinite(n)) return `${LRI}—${PDI}`;
    const rounded = roundHalfAway(n, digits);
    const [intPart, fraction] = Math.abs(rounded).toFixed(digits).split(".");
    const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    const trimmed = fraction && /[1-9]/.test(fraction) ? `${grouped}.${fraction.replace(/0+$/, "")}` : grouped;
    return `${LRI}${rounded < 0 ? "-" : ""}${trimmed}${PDI}`;
  }

  // مبلغ: الرقم معزولاً ثم رمز العملة بعده، «1,234.5 $» و«-350,000 ل.س».
  function money(value, currency = "$", digits = 2) {
    const raw = clean(currency, 12);
    const symbol = CURRENCY_SYMBOLS[raw.toUpperCase()] || CURRENCY_SYMBOLS[raw] || raw;
    return symbol ? `${num(value, digits)} ${symbol}` : num(value, digits);
  }

  // التاريخ والوقت بتوقيت دمشق «2026-10-14 23:00 (دمشق)»، والتاريخ معزول LTR.
  // يقبل Date أو نصاً أو رقماً (ms)؛ القيمة غير الصالحة «—».
  function time(value, { withZone = true, dateOnly = false } = {}) {
    const date = value instanceof Date ? value : new Date(value ?? NaN);
    if (value === null || value === undefined || Number.isNaN(date.getTime())) return `${LRI}—${PDI}`;
    const parts = {};
    for (const part of new Intl.DateTimeFormat("en-GB", {
      timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).formatToParts(date)) parts[part.type] = part.value;
    const day = `${parts.year}-${parts.month}-${parts.day}`;
    const stamp = dateOnly ? day : `${day} ${parts.hour}:${parts.minute}`;
    return `${LRI}${stamp}${PDI}${withZone && !dateOnly ? ` (${TIME_ZONE_LABEL})` : ""}`;
  }

  // مستوى الأهمية «🔴 حرج». يقبل المفتاح (critical) أو التسمية العربية (حرج)؛
  // المستوى غير المعروف يُعرض نصاً منظّفاً بلا رمز.
  function severity(level) {
    const key = SEVERITY[level] ? level : SEVERITY_ALIASES[clean(level)];
    if (!key) return clean(level) || "—";
    return `${SEVERITY[key].icon} ${SEVERITY[key].label}`;
  }

  // سطر عربي الاتجاه. الأسطر الفارغة تبقى فارغة.
  function line(textValue) {
    const value = String(textValue ?? "");
    return value ? `${RLM}${value}` : "";
  }

  // «التسمية: القيمة» في سطر مستقل. القيمة مُنسَّقة سلفاً (name/num/نص ثابت).
  function field(label, value) {
    return line(`${label}: ${value}`);
  }

  // يجمع كتلاً (كل كتلة مصفوفة أسطر لصنف/بند واحد) في رسائل لا تتجاوز maxChars،
  // دون شطر أي كتلة بين رسالتين. العنوان يتكرر في كل جزء مع ترقيم (1/3)،
  // والمقدمة (intro) في الجزء الأول وحده، والخاتمة (footer) في الأخير وحده.
  // كتلة أطول من المساحة المتاحة وحدها تُرسل منفردة مقصوصة بعلامة واضحة —
  // لا تحدث مع أسماء مقصوصة عند MAX_NAME_CHARS، لكنها تمنع رفض تيليغرام.
  function composeMessages({ title, intro = [], blocks = [], footer = [], maxChars = DEFAULT_MAX_CHARS } = {}) {
    const join = (lines) => lines.filter((l) => l !== null && l !== undefined).join("\n");
    const sep = line(SEPARATOR);
    const partLabelReserve = 12; // « (99/99)»
    const titleLine = (index, total) => line(total > 1 ? `${title} (${index}/${total})` : title);
    const introText = join(intro);
    const footerText = join(footer);
    const blockTexts = blocks.map((block) => join(block));

    const budget = (isFirst, isLast) => maxChars
      - (title.length + 1 + partLabelReserve + 1)
      - (isFirst && introText ? introText.length + 1 : 0)
      - (isLast && footerText ? footerText.length + 1 + sep.length + 1 : 0);

    // تعبئة جشعة؛ الخاتمة تُحجز لها مساحة في كل جزء كي لا تُدفع لجزء جديد فارغ.
    const parts = [];
    let current = [];
    let size = 0;
    const room = () => budget(parts.length === 0, true);
    for (const blockText of blockTexts) {
      const cost = sep.length + 1 + blockText.length + 1;
      if (current.length && size + cost > room()) {
        parts.push(current);
        current = [];
        size = 0;
      }
      if (!current.length && cost > room()) {
        const keep = Math.max(0, room() - sep.length - 3);
        current.push(`${truncateBlock(blockText, keep)}\n${line("…")}`);
        size = room();
        continue;
      }
      current.push(blockText);
      size += cost;
    }
    if (current.length || !parts.length) parts.push(current);

    return parts.map((part, index) => {
      const lines = [titleLine(index + 1, parts.length)];
      if (index === 0 && introText) lines.push(introText);
      for (const blockText of part) lines.push(sep, blockText);
      if (index === parts.length - 1 && footerText) lines.push(sep, footerText);
      return lines.join("\n");
    });
  }

  // قصّ كتلة ضخمة دون كسر: أسطر كاملة ما أمكن؛ وإن لم يتسع حتى السطر الأول قُصّ
  // بنقاط الترميز (لا نصف زوج بديل) بعد حذف محارف العزل كي لا يبقى LRI بلا PDI.
  function truncateBlock(blockText, keep) {
    const kept = [];
    let used = 0;
    for (const textLine of blockText.split("\n")) {
      const cost = textLine.length + (kept.length ? 1 : 0);
      if (used + cost > keep) break;
      kept.push(textLine);
      used += cost;
    }
    if (kept.length) return kept.join("\n");
    const first = blockText.split("\n")[0].replace(/[\u2066-\u2069]/gu, "");
    let out = "";
    for (const ch of first) {
      if (out.length + ch.length > keep) break;
      out += ch;
    }
    return out;
  }

  // للفحوص والمعاينة: النص بلا محارف الاتجاه غير المرئية.
  function stripBidi(value) {
    return String(value ?? "").replace(/[\u200E\u200F\u2066-\u2069]/gu, "");
  }

  const api = Object.freeze({
    RLM,
    LRI,
    FSI,
    PDI,
    SEPARATOR,
    DEFAULT_MAX_CHARS,
    MAX_NAME_CHARS,
    TIME_ZONE,
    SEVERITY,
    clean,
    name,
    num,
    money,
    time,
    severity,
    line,
    field,
    composeMessages,
    stripBidi
  });

  if (typeof window !== "undefined") window.ozkTelegramFormat = api;
  if (typeof globalThis !== "undefined") globalThis.ozkTelegramFormat = api;
})();
