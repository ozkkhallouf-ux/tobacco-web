"use strict";
// عامل وهمي لاختبار run-scheduled.ps1: لا أمين ولا Drive ولا Supabase ولا Telegram.
// السلوك من FAKE_WORKER_MODE، ويُسجَّل كل تشغيل في FAKE_WORKER_RUNS (سطر لكل تشغيل).
const fs = require("fs");
const { spawn } = require("child_process");

const mode = process.env.FAKE_WORKER_MODE || "ok";
const runs = process.env.FAKE_WORKER_RUNS;
// يسجّل أيضاً وضع الإعداد الذي سيقرؤه lib/config.js فعلاً (المتغير أولاً ثم config.json المجاور).
const cfgPath = process.env.OZK_DRIVE_ARCHIVE_CONFIG || require("path").join(__dirname, "config.json");
let cfgMode = "missing";
try { cfgMode = JSON.parse(fs.readFileSync(cfgPath, "utf8").replace(/^\uFEFF/, "")).mode || "dry-run"; } catch { /* يبقى missing */ }
if (runs) fs.appendFileSync(runs, `${process.pid} ${process.argv.slice(2).join(" ")} mode=${cfgMode}\n`);

const cycle = (extra) => console.log(JSON.stringify({ detect: { rows: 0, created: 0, reconcile: false, complete: true }, upload: null, notify: null, report: null, driveState: "unknown", ...extra }));

switch (mode) {
  case "ok":
    cycle({});
    break;
  case "sleep": {
    const ms = Number(process.env.FAKE_WORKER_SLEEP_MS || 4000);
    setTimeout(() => cycle({}), ms);
    break;
  }
  case "hang": {
    // عملية حفيدة تحاكي Edge: يجب أن تُقتل مع الشجرة عند تجاوز المهلة.
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    if (process.env.FAKE_WORKER_CHILD_PID) fs.writeFileSync(process.env.FAKE_WORKER_CHILD_PID, String(child.pid));
    setInterval(() => {}, 1000);
    break;
  }
  case "detect_failed":
    cycle({ detect: null });
    break;
  case "drive_offline":
    cycle({ upload: { uploaded: 0, blocked: 2 }, driveState: "disconnected" });
    break;
  case "needs_reauth":
    cycle({ upload: { uploaded: 0, blocked: 1 }, driveState: "needs_reauth" });
    break;
  case "not_private_midway":
    cycle({ upload: { uploaded: 1 }, driveState: "not_private" });
    break;
  case "pilot_expired":
    console.log(JSON.stringify({ detect: null, upload: null, notify: null, report: null, pilotExpired: true }));
    process.exitCode = 2;
    break;
  case "pilot_expired_startup":
    // نص validate() الحقيقي حين تنتهي التجربة قبل الإقلاع (lib/config.js)، برمز 1.
    console.error("إعداد غير صالح: انتهت التجربة المحصورة (2026-10-20): احذف pilotInvoiceGuids وpilotExpiresAt أو جدّدها بقرار المالك");
    process.exitCode = 1;
    break;
  case "crash":
    console.error("ConnectionError: Failed to connect to OZK-TOBACCO password=hunter2-secret Bearer abc.def.ghi");
    process.exitCode = 1;
    break;
  case "no_output":
    break;
  case "leak":
    console.log("refresh_token=1//0gFAKEFAKEFAKEFAKEFAKEFAKE ya29.FAKEACCESS");
    cycle({});
    break;
  default:
    console.error(`unknown FAKE_WORKER_MODE ${mode}`);
    process.exitCode = 9;
}
