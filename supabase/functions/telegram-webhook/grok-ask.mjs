// بناء طلب Grok وتحليل ردّه — ملف مشترك بين دالة تيليغرام وفحص العقد.
// لا مفاتيح هنا. لا بحث ويب. store=false حتى لا تُحفظ بيانات العمل على خوادم xAI.

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
    search_parameters: { mode: "off" },
    max_output_tokens: GROK_MAX_OUTPUT_TOKENS,
    instructions,
    input,
  };
}

export function parseGrokOutput(data) {
  if (!data || typeof data !== "object") throw new Error("رد غير صالح من Grok");
  const err = data.error;
  if (err) {
    const msg = typeof err === "string"
      ? err
      : typeof err.message === "string"
        ? err.message
        : JSON.stringify(err);
    throw new Error(`grok_error: ${String(msg).slice(0, 200)}`);
  }
  const parts = [];
  const output = data.output;
  if (Array.isArray(output)) {
    for (const item of output) {
      if (!item || typeof item !== "object") continue;
      const content = item.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "output_text" && typeof block.text === "string" && block.text.trim()) {
          parts.push(block.text.trim());
        }
      }
    }
  }
  const text = parts.join("\n").trim();
  if (!text) throw new Error("رد فارغ من Grok");
  return text;
}
