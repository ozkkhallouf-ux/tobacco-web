// فحص انحدار لإزاحة التمرير في تصدير PDF عبر html2pdf.
//
// العطل الذي يحرسه (2026-10-24): html2canvas يطرح إزاحة تمرير النافذة من موضع
// الالتقاط ما لم يُمرَّر له scrollX/scrollY صفراً. وزر «طباعة تقرير المتأخرين»
// يقع أسفل صفحة الزبائن، فكانت الصفحة ممرّرة دائماً تقريباً عند الضغط: تمرير
// 250px أخرج الجدول مُزاحاً لأسفل بمساحة بيضاء كبيرة فوقه ومقصوص الصفوف الأخيرة،
// وتمرير 1500px أخرج ورقة بيضاء كاملة. قيس بطباعة حقيقية في Chromium قبل الإصلاح
// وبعده، والعطل قائم قبل تعديل الخط Cairo (#346) وبعده — لا علاقة للخط به.
//
// الجزء الأول ثابت: كل استدعاء html2pdf().set في src/ يمرّر scrollY: 0 أو يرجع
// بالنافذة إلى الأعلى قبله. الجزء الثاني يصدّر بـhtml2pdf الحقيقي من public/vendor
// وبخيارات html2canvas المستخرجة حرفياً من printOverdueReport، والصفحة ممرّرة.

import { chromium } from "playwright";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
let failed = false;
function check(label, condition) {
  if (!condition) { console.error(`FAIL: ${label}`); failed = true; }
  else console.log(`ok: ${label}`);
}

// ---- 1) ثابت: لا html2pdf بلا تصفير التمرير ----
const srcFiles = readdirSync(join(root, "src")).filter((f) => f.endsWith(".js"));
for (const file of srcFiles) {
  const code = readFileSync(join(root, "src", file), "utf8");
  for (const match of code.matchAll(/html2pdf\(\)\.set\(\{/g)) {
    const call = code.slice(match.index, code.indexOf(".from(", match.index));
    const before = code.slice(Math.max(0, match.index - 1500), match.index);
    const line = code.slice(0, match.index).split("\n").length;
    check(`src/${file}:${line} html2pdf يصفّر إزاحة التمرير`,
      /scrollY:\s*0/.test(call) || /window\.scrollTo\(0,\s*0\)/.test(before));
  }
}

// ---- 2) فعلي: تقرير المتأخرين والصفحة ممرّرة ----
const appJs = readFileSync(join(root, "src/app.js"), "utf8");
const overdue = appJs.match(/async function printOverdueReport\(\) \{[\s\S]*?\n\}\n/)?.[0] || "";
const canvasOptions = overdue.match(/window\.html2pdf\(\)\.set\(\{[\s\S]*?html2canvas: (\{[^}]*\})/)?.[1];
check("استخراج خيارات html2canvas من مسار المكتب في printOverdueReport", Boolean(canvasOptions));
if (!canvasOptions) process.exit(1);

const vendor = readFileSync(join(root, "public/vendor/html2pdf.bundle.min.js"), "utf8");
const rows = Array.from({ length: 18 }, (_, i) =>
  `<tr><td style="padding:8px 10px;border:1px solid #d8c890">${i + 1}</td><td style="padding:8px 10px;border:1px solid #d8c890">زبون اختبار ${i + 1}</td><td style="padding:8px 10px;border:1px solid #d8c890">${(i + 1) * 100}</td></tr>`).join("");
const reportHtml = `<div dir="rtl" style="color:#221808;padding:20px"><h2 style="text-align:center">OZK TOBACCO</h2>
  <table style="width:100%;border-collapse:collapse"><thead><tr style="background:#d7a83f"><th>#</th><th>اسم الزبون</th><th>الرصيد</th></tr></thead><tbody>${rows}</tbody></table></div>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.setContent(`<!doctype html><html dir="rtl"><body style="margin:0;min-height:4000px"><p>صفحة التطبيق</p></body></html>`);
  await page.addScriptTag({ content: vendor });
  let baseline = null;
  for (const scrollY of [0, 250, 1500]) {
    const result = await page.evaluate(async ({ html, optionsSrc, scrollY }) => {
      window.scrollTo(0, scrollY);
      const container = document.createElement("div");
      container.innerHTML = html;
      document.body.appendChild(container);
      const html2canvas = Function(`return (${optionsSrc});`)();
      const worker = window.html2pdf().set({
        margin: [10, 15, 10, 15],
        html2canvas,
        jsPDF: { unit: "mm", format: "a4", orientation: "portrait" }
      }).from(container);
      await worker.toCanvas();
      const canvas = worker.prop.canvas;
      container.remove();
      window.scrollTo(0, 0);
      // أول صف بكسلات فيه حبر (غير أبيض)، كنسبة من ارتفاع الـcanvas، وحبر أسفل الجدول.
      const ctx = canvas.getContext("2d");
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let firstInk = -1, lastInk = -1;
      for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x += 4) {
          const i = (y * canvas.width + x) * 4;
          if (data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200) {
            if (firstInk < 0) firstInk = y;
            lastInk = y;
            break;
          }
        }
      }
      return { height: canvas.height, firstInk, lastInk };
    }, { html: reportHtml, optionsSrc: canvasOptions, scrollY });
    check(`تمرير ${scrollY}px: المحتوى مرسوم (لا ورقة بيضاء)`, result.firstInk >= 0);
    // المرجع: نفس التقرير بلا تمرير. أي إزاحة عنه = مساحة بيضاء مضافة فوق الجدول.
    if (scrollY === 0) baseline = result;
    check(`تمرير ${scrollY}px: المحتوى في موضعه بلا إزاحة لأسفل (أول حبر ${result.firstInk}px، المرجع ${baseline.firstInk}px)`,
      result.firstInk >= 0 && Math.abs(result.firstInk - baseline.firstInk) <= 4 && result.height === baseline.height);
    check(`تمرير ${scrollY}px: الجدول كامل حتى آخر صف (آخر حبر ${result.lastInk}/${result.height})`,
      result.lastInk > 0.85 * result.height);
  }
} finally {
  await browser.close();
}

if (failed) { console.error("\nفحص إزاحة التمرير في PDF: فشل"); process.exit(1); }
console.log("\nفحص إزاحة التمرير في PDF: نجاح");
