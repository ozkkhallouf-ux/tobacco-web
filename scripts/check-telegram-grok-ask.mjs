// حارس مسار السؤال الحر في بوت تيليغرام: Grok للنص، وWhisper للصوت.
//
// العطل الذي يمنعه: استبدال طبقة الذكاء الاصطناعي كان يمكن أن يقطع التفريغ
// الصوتي (كان يعتمد Whisper لا Claude)، أو أن يُرسل أرقام العمل لبحث ويب،
// أو أن يُخزَّن السياق المحاسبي على خوادم xAI (store الافتراضي true).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  GROK_URL,
  GROK_MODEL,
  GROK_MAX_OUTPUT_TOKENS,
  buildGrokRequestBody,
  parseGrokOutput,
} from "../supabase/functions/telegram-webhook/grok-ask.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webhookPath = path.join(repoRoot, "supabase/functions/telegram-webhook/index.ts");
const webhook = await readFile(webhookPath, "utf8");
const code = webhook.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");

let passed = 0;
const ok = (label) => { passed += 1; console.log(`  ✓ ${label}`); };

// ── أ) تحليل الرد: نص حقيقي، ورفض الفراغ والخطأ ─────────────────────────────
{
  const sample = {
    id: "resp_test",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "أعلى مدين: سامر 1,200$" }],
      },
    ],
  };
  assert.equal(parseGrokOutput(sample), "أعلى مدين: سامر 1,200$");

  const multi = {
    output: [
      { content: [{ type: "output_text", text: "سطر 1" }, { type: "output_text", text: "سطر 2" }] },
    ],
  };
  assert.equal(parseGrokOutput(multi), "سطر 1\nسطر 2");

  assert.throws(() => parseGrokOutput({ output: [] }), /رد فارغ من Grok/);
  assert.throws(() => parseGrokOutput({ output: [{ content: [{ type: "reasoning", text: "..." }] }] }), /رد فارغ من Grok/);
  assert.throws(() => parseGrokOutput({ error: { message: "quota" } }), /grok_error: quota/);
  ok("parseGrokOutput يستخرج النص ويرفض الرد الفارغ ورسالة الخطأ");
}

// ── ب) عقد الطلب: لا تخزين ولا بحث ويب ──────────────────────────────────────
{
  const body = buildGrokRequestBody({
    instructions: "جاوب من البيانات فقط",
    input: "بيانات العمل الحالية:\nمبيعات 10\n\nسؤال المالك: كم المبيعات؟",
  });
  assert.equal(body.model, GROK_MODEL);
  assert.equal(body.store, false);
  assert.equal("search_parameters" in body, false, "search_parameters يرفضه /v1/responses");
  assert.equal("tools" in body, false, "وجود tools قد يفعّل web_search");
  assert.equal(body.max_output_tokens, GROK_MAX_OUTPUT_TOKENS);
  assert.equal(typeof body.instructions, "string");
  assert.match(body.input, /سؤال المالك/);
  assert.throws(() => buildGrokRequestBody({ instructions: " ", input: "x" }), /تعليمات Grok فارغة/);
  ok("طلب Grok بلا تخزين وبلا بحث ويب");
}

// ── ج) الويبهوك يستعمل الملف المشترك ويستدعي Grok لا Claude ─────────────────
{
  assert.ok(webhook.includes('from "./grok-ask.mjs"'), "telegram-webhook يجب أن يستورد grok-ask.mjs");
  assert.ok(code.includes("buildGrokRequestBody"), "telegram-webhook يجب أن يبني طلب Grok من الملف المشترك");
  assert.ok(code.includes("parseGrokOutput"), "telegram-webhook يجب أن يحلّل رد Grok من الملف المشترك");
  assert.ok(code.includes('Deno.env.get("XAI_API_KEY")'), "مفتاح Grok يجب أن يُقرأ من أسرار الدالة لا من الكود");
  assert.ok(code.includes("fetch(GROK_URL"), "استدعاء Grok يجب أن يمر عبر GROK_URL");
  assert.ok(code.includes("const answer = await askGrok(question, context)"), "handleAiQuestion يجب أن يستدعي askGrok");
  // لا نفحص اسم مضيف بنص جزئي (js/incomplete-url-substring-sanitization).
  // دوال Claude القديمة تُرصد بأسمائها ورؤوسها لا بقطعة من الـhost.
  assert.ok(!code.includes("askClaude"), "askClaude ما زال في مسار السؤال الحر");
  assert.ok(!code.includes("ANTHROPIC_API_KEY"), "ANTHROPIC_API_KEY ما زال في مسار التيليغرام");
  assert.ok(!code.includes("anthropic-version"), "سؤال التيليغرام ما زال يرسل إلى Anthropic");
  const grokAsk = await readFile(path.join(repoRoot, "supabase/functions/telegram-webhook/grok-ask.mjs"), "utf8");
  const grokCode = grokAsk.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  assert.ok(grokAsk.includes(GROK_URL), `grok-ask.mjs يجب أن يعرّف ${GROK_URL}`);
  assert.ok(grokCode.includes("store: false"), "grok-ask.mjs يجب أن يعطّل تخزين المحادثة على xAI");
  assert.ok(!grokCode.includes("search_parameters"), "search_parameters لا يُرسل على /v1/responses");
  assert.ok(!grokCode.includes("web_search"), "web_search يجب أن يبقى غائباً حتى لا يُبحث في الويب");
  ok("سؤال الذكاء الاصطناعي في التيليغرام يمر عبر Grok فقط");
}

// ── د) الصوت يبقى Whisper قبل أي نموذج لغوي ─────────────────────────────────
{
  assert.match(code, /async function transcribeVoice\(/);
  assert.match(code, /Deno\.env\.get\("OPENAI_API_KEY"\)/);
  assert.ok(code.includes("/v1/audio/transcriptions"), "مسار تفريغ Whisper مفقود");
  assert.match(code, /form\.append\("model", "whisper-1"\)/);
  assert.match(code, /form\.append\("language", "ar"\)/);
  assert.match(code, /msg\.voice\?\.file_id/);
  assert.match(code, /text = await transcribeVoice\(voiceFileId\)/);
  assert.doesNotMatch(code, /askGrok\([^)]*voice/);
  assert.doesNotMatch(code, /fetch\(GROK_URL[\s\S]{0,400}voice/);
  const voiceBlock = code.match(/const voiceFileId = msg\.voice\?\.file_id;[\s\S]*?if \(!text\) \{/)?.[0] ?? "";
  assert.match(voiceBlock, /transcribeVoice/);
  assert.doesNotMatch(voiceBlock, /askGrok/);
  ok("الرسالة الصوتية تُفرَّغ بـ Whisper قبل الأوامر وقبل Grok");
}

// ── هـ) الأوامر الرقمية لا تمر من النموذج اللغوي ────────────────────────────
{
  const cmdStart = code.indexOf("async function handleCommand");
  const cmdEnd = code.indexOf("\nasync function", cmdStart + 1);
  const handleCommand = cmdStart >= 0
    ? code.slice(cmdStart, cmdEnd > cmdStart ? cmdEnd : undefined)
    : "";
  assert.match(handleCommand, /await handleSales\(/);
  assert.match(handleCommand, /await handleLowStock\(/);
  assert.match(handleCommand, /await handleDebts\(/);
  assert.match(handleCommand, /await handleProfitToday\(/);
  assert.match(handleCommand, /await handleDailyCash\(/);
  assert.doesNotMatch(handleCommand, /askGrok/);
  ok("أوامر الرصيد والمبيعات والنواقص تبقى قراءة مباشرة بلا Grok");
}

console.log(`Telegram Grok ask + voice contract: ${passed} checks OK`);
