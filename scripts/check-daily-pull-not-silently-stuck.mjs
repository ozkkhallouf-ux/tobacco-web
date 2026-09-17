// ============================================================================
// يحرس السببين اللذين أبقيا جهاز Windows أحد عشر يوماً بلا أي تحديث
// (2026-09-07 → 2026-09-17)، فظلّ يطبع فواتير قديمة رغم دمج الإصلاح في main:
//
//   ١. `tools/ameen-autoprint/bin/SumatraPDF-settings.txt` — يكتبه SumatraPDF
//      عند كل طباعة، وكان غير متتبَّع وغير متجاهَل. وحارس daily-git-pull يتخطّى
//      السحب عند أي تغيير غير مُلتزَم، فتخطّاه كل يوم بلا نهاية.
//
//   ٢. مسار التخطّي كان يخرج **صامتاً** (exit 0 بلا أي إشعار)، فلم يُكتشف
//      الشلل إلا بفحص يدوي بعد أحد عشر يوماً. وللسابقة نظير مسجَّل في الملف
//      نفسه: قفل مهمة AI أوقف السحب ثلاثة أيام بنفس الصمت.
// ============================================================================
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
const ok = (m) => console.log(`  ✅ ${m}`);
const bad = (m) => { console.error(`  ❌ ${m}`); failed++; };

console.log("فحص: السحب اليومي لا يُشلّ صامتاً");

// ── ١) أصناف ملفات SumatraPDF متجاهَلة، والعلامة تبقى متتبَّعة ──────────────
const ignored = (p) => {
  try {
    execFileSync("git", ["check-ignore", "-q", p], { cwd: root, stdio: "ignore" });
    return true;
  } catch { return false; }
};

for (const f of [
  "tools/ameen-autoprint/bin/SumatraPDF-settings.txt",
  "tools/ameen-autoprint/bin/SumatraPDF.exe",
  "tools/ameen-autoprint/bin/anything-sumatra-writes.dat",
]) {
  if (ignored(f)) ok(`متجاهَل: ${path.basename(f)}`);
  else bad(`غير متجاهَل: ${f} — سيُشلّ السحب اليومي عند أول طباعة`);
}

if (!ignored("tools/ameen-autoprint/bin/.gitkeep")) ok("العلامة .gitkeep تبقى متتبَّعة");
else bad("bin/.gitkeep صار متجاهَلاً — سيختفي المجلد من المستودع");

// ── ٢) كل مسار تخطٍّ ينبّه عند التكرار ─────────────────────────────────────
const pull = readFileSync(path.join(root, "tools/daily-git-pull.ps1"), "utf8");

if (/function Send-StuckAlert/.test(pull)) ok("دالة التنبيه على الشلل موجودة");
else bad("لا دالة تنبيه على التخطّي المتكرّر — الشلل يبقى صامتاً");

if (/Get-TrailingSkipCount/.test(pull)) ok("عدّاد التخطّي المتتالي موجود");
else bad("لا عدّاد للتخطّي المتتالي");

const skipLines = pull.split("\n")
  .map((line, i) => ({ line, i }))
  .filter(({ line }) => /Add-Content .*SKIP:/.test(line));

if (skipLines.length >= 2) ok(`مسارات التخطّي المرصودة: ${skipLines.length}`);
else bad(`عدد مسارات التخطّي ${skipLines.length} — يُتوقّع مساران على الأقل`);

const lines = pull.split("\n");
for (const { line, i } of skipLines) {
  // التنبيه يجب أن يلي تسجيل التخطّي مباشرة وقبل أي exit
  const after = lines.slice(i + 1, i + 4).join("\n");
  const reason = line.match(/SKIP: ([^"]*)/)?.[1]?.trim() ?? `سطر ${i + 1}`;
  if (/Send-StuckAlert/.test(after)) ok(`ينبّه عند التكرار: «${reason}»`);
  else bad(`مسار التخطّي «${reason}» يخرج صامتاً — أضف Send-StuckAlert بعده`);
}

// عتبة معقولة: لا تنبيه من أول يوم، ولا صمت لأسبوع
const th = Number(pull.match(/\$SkipAlertThreshold = (\d+)/)?.[1]);
if (Number.isInteger(th) && th >= 2 && th <= 5) ok(`عتبة التنبيه = ${th} أيام`);
else bad(`عتبة التنبيه غير معقولة (${th}) — يُتوقّع بين 2 و5`);

if (failed) {
  console.error(`\n✗ فشل ${failed} تحقّقاً في فحص شلل السحب اليومي.`);
  process.exit(1);
}
console.log("\n✓ كل فحوص شلل السحب اليومي نجحت.");
