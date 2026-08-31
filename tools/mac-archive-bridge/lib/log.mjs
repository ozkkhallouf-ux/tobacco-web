// سجل واضح لكل عملية أرشفة: سطر JSON واحد لكل حدث + سطر عربي مقروء على stdout
// (يلتقطه LaunchAgent إلى ملف السجل). لا نسجّل محتوى المستند ولا الرمز.

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { LOG_DIR } from "./config.mjs";

const LEVEL_LABEL = { info: "معلومة", success: "نجاح", warn: "تنبيه", error: "فشل" };

function currentLogFile(now = new Date()) {
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return path.join(LOG_DIR, `archive-${month}.jsonl`);
}

export function logEvent(level, event, details = {}) {
  const entry = { at: new Date().toISOString(), level, event, ...details };
  const line = JSON.stringify(entry);
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
    appendFileSync(currentLogFile(), line + "\n", { mode: 0o600 });
  } catch {
    // فشل الكتابة على السجل لا يجوز أن يُسقط الخدمة.
  }
  const label = LEVEL_LABEL[level] || level;
  const summary = [details.docType, details.file, details.reason].filter(Boolean).join(" | ");
  process.stdout.write(`[${entry.at}] ${label}: ${event}${summary ? " — " + summary : ""}\n`);
}
