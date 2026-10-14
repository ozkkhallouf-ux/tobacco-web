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
// وأي محارف اتجاه موجودة أصلاً في النص الوارد تُحذف قبل العزل كي لا يكسر اسمٌ
// العزلَ أو يقلب ما بعده.
//
// المستهلكون: src/stock-alert-priority.js (ونسخته في supabase/functions/_shared).
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

  // محارف التحكم (عدا لا شيء) ومحارف الاتجاه الصريحة وفواصل الأسطر/الفقرات.
  const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2028\u2029\u2066-\u2069]/gu;

  // نص ديناميكي في سطر واحد: لا أسطر جديدة ولا محارف اتجاه ولا مسافات متكررة.
  function clean(value, maxChars = MAX_NAME_CHARS) {
    const flat = String(value ?? "").replace(CONTROL_RE, " ").replace(/\s+/gu, " ").trim();
    const chars = Array.from(flat);
    return chars.length > maxChars ? `${chars.slice(0, maxChars - 1).join("").trimEnd()}…` : flat;
  }

  // اسم ديناميكي (صنف/زبون/سير عمل) معزول الاتجاه.
  function name(value, fallback = "—") {
    const cleaned = clean(value);
    return `${FSI}${cleaned || fallback}${PDI}`;
  }

  // رقم بفواصل الآلاف وأرقام إنجليزية، معزول باتجاه LTR (السالب يبقى «-5»).
  function num(value, digits = 1) {
    const n = Number(value);
    if (!Number.isFinite(n)) return `${LRI}—${PDI}`;
    const factor = 10 ** digits;
    const rounded = Math.round(n * factor) / factor;
    const [intPart, fraction] = Math.abs(rounded).toFixed(digits).split(".");
    const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    const trimmed = fraction && /[1-9]/.test(fraction) ? `${grouped}.${fraction.replace(/0+$/, "")}` : grouped;
    return `${LRI}${rounded < 0 ? "-" : ""}${trimmed}${PDI}`;
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
        current.push(`${blockText.slice(0, keep)}\n${line("…")}`);
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
    clean,
    name,
    num,
    line,
    field,
    composeMessages,
    stripBidi
  });

  if (typeof window !== "undefined") window.ozkTelegramFormat = api;
  if (typeof globalThis !== "undefined") globalThis.ozkTelegramFormat = api;
})();
