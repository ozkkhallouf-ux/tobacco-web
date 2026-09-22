// بناء طلب Grok وتحليل ردّه — ملف مشترك بين دالة تيليغرام وفحص العقد.
// لا مفاتيح هنا. store=false حتى لا تُحفظ بيانات العمل على خوادم xAI.
// بحث الويب يبقى مطفأ: مسار Responses لا يبحث إلا إذا أُرسلت أداة بحث.
// حقل بحث Chat Completions لا يُرسل هنا لأنه يرفض الطلب قبل الاستدلال
// (P1 Codex على PR #261).

export const GROK_URL = "https://api.x.ai/v1/responses";
export const GROK_MODEL = "grok-4.6";
export const GROK_MAX_OUTPUT_TOKENS = 700;

export function buildGrokRequestBody({ instructions, input }) {
  if (typeof instructions !== "string" || !instructions.trim()) {
    throw new Error("تعليمات Grok فارغة");
  }
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("مدخل Grok فارغ");
  }
  return {
    model: GROK_MODEL,
    store: false,
    max_output_tokens: GROK_MAX_OUTPUT_TOKENS,
    instructions,
    input,
  };
}

function formatGrokError(err) {
  if (typeof err === "string") return err;
  if (err && typeof err.message === "string") return err.message;
  return JSON.stringify(err);
}

function collectOutputText(data) {
  const items = Array.isArray(data.output) ? data.output : [];
  return items.flatMap((item) => {
    const blocks = Array.isArray(item?.content) ? item.content : [];
    return blocks
      .filter((block) => block?.type === "output_text" && typeof block.text === "string")
      .map((block) => block.text.trim())
      .filter(Boolean);
  });
}

export function parseGrokOutput(data) {
  if (!data || typeof data !== "object") throw new Error("رد غير صالح من Grok");
  if (data.error) {
    throw new Error(`grok_error: ${String(formatGrokError(data.error)).slice(0, 200)}`);
  }
  const text = collectOutputText(data).join("\n").trim();
  if (!text) throw new Error("رد فارغ من Grok");
  return text;
}
