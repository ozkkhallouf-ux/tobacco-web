// claude-assistant — بروكسي آمن لـ Claude API
// المفتاح ANTHROPIC_API_KEY يُخزَّن سرّاً في Supabase ولا يصل للموقع أبداً.
// الحماية: لازم المستخدم مسجّل دخول حقيقي (ليس مجرد المفتاح العام) لمنع استنزاف الرصيد.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-haiku-4-5-20251001"; // أرخص موديل افتراضي؛ يمكن تغييره من الطلب
const DEFAULT_MAX_TOKENS = 1024;
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json"
    }
  });
}
Deno.serve(async (req)=>{
  // طلب CORS التمهيدي
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders
    });
  }
  if (req.method !== "POST") {
    return json({
      error: "Method not allowed. Use POST."
    }, 405);
  }
  // —— التحقق من المستخدم الحقيقي ——
  const authHeader = req.headers.get("Authorization") ?? "";
  const supabase = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_ANON_KEY"), {
    global: {
      headers: {
        Authorization: authHeader
      }
    }
  });
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) {
    return json({
      error: "غير مصرّح: لازم تسجيل دخول."
    }, 401);
  }
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return json({
      error: "ANTHROPIC_API_KEY غير مضبوط في أسرار Supabase بعد."
    }, 500);
  }
  let payload;
  try {
    payload = await req.json();
  } catch  {
    return json({
      error: "الطلب يجب أن يكون JSON صالح."
    }, 400);
  }
  const messages = payload.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return json({
      error: "الحقل messages مطلوب ويجب أن يكون مصفوفة غير فارغة."
    }, 400);
  }
  const body = {
    model: payload.model ?? DEFAULT_MODEL,
    max_tokens: payload.max_tokens ?? DEFAULT_MAX_TOKENS,
    messages
  };
  if (payload.system) body.system = payload.system;
  if (payload.temperature !== undefined) body.temperature = payload.temperature;
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    return json(data, res.status);
  } catch (err) {
    return json({
      error: "فشل الاتصال بـ Claude",
      detail: String(err)
    }, 502);
  }
});
