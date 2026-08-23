/**
 * توليد ملفات PDF من نشرات الأسعار HTML
 * الاستخدام: node scripts/generate-pdfs.mjs
 *
 * المخرجات:
 *   public/downloads/price-list-usd.pdf
 *   public/downloads/price-list-usd-light.pdf
 *   public/downloads/price-list-syp-14050.pdf
 *   public/downloads/price-list-syp-14050-light.pdf
 *   public/downloads/price-list-wazari-usd.pdf
 *   public/downloads/price-list-wazari-usd-light.pdf
 *   public/downloads/price-list-wazari-syp-14050.pdf
 *   public/downloads/price-list-wazari-syp-14050-light.pdf
 *
 * متطلبات: npx playwright install chromium
 */

import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dir, "..");
const downloadsDir = resolve(root, "public/downloads");

const files = [
  {
    html: resolve(downloadsDir, "price-list-usd.html"),
    pdf: resolve(downloadsDir, "price-list-usd.pdf"),
    lightPdf: resolve(downloadsDir, "price-list-usd-light.pdf"),
    label: "نشرة الدولار",
  },
  {
    html: resolve(downloadsDir, "price-list-syp-14050.html"),
    pdf: resolve(downloadsDir, "price-list-syp-14050.pdf"),
    lightPdf: resolve(downloadsDir, "price-list-syp-14050-light.pdf"),
    label: "نشرة الليرة السورية",
  },
  {
    html: resolve(downloadsDir, "price-list-wazari-usd.html"),
    pdf: resolve(downloadsDir, "price-list-wazari-usd.pdf"),
    lightPdf: resolve(downloadsDir, "price-list-wazari-usd-light.pdf"),
    label: "نشرة الوزاري بالدولار",
  },
  {
    html: resolve(downloadsDir, "price-list-wazari-syp-14050.html"),
    pdf: resolve(downloadsDir, "price-list-wazari-syp-14050.pdf"),
    lightPdf: resolve(downloadsDir, "price-list-wazari-syp-14050-light.pdf"),
    label: "نشرة الوزاري بالليرة السورية",
  },
];

// تحقق من وجود الملفات
for (const { html, label } of files) {
  if (!existsSync(html)) {
    console.error(`✗ ملف HTML غير موجود: ${html}`);
    console.error("  شغّل أولاً: node scripts/generate-price-lists.mjs");
    process.exit(1);
  }
}

console.log("جارٍ تشغيل المتصفح...");
const localChromiumPath = String(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "").trim();
const browser = await chromium.launch(localChromiumPath ? { executablePath: localChromiumPath } : undefined);
const page = await browser.newPage();

const applyPdfTheme = async (selectedTheme) => {
  await page.evaluate((theme) => {
    const sheet = document.querySelector(".ozk-price-list");
    if (!sheet) throw new Error("تعذر العثور على قالب النشرة داخل صفحة PDF.");
    sheet.dataset.theme = theme;
    document.body.dataset.theme = theme;
    const background = theme === "light" ? "#fffdf8" : "#0c0a07";
    document.documentElement.style.background = background;
    document.body.style.background = background;
  }, selectedTheme);
};

for (const { html, pdf, lightPdf, label } of files) {
  process.stdout.write(`توليد ${label}... `);
  await page.goto(`file://${html}`, { waitUntil: "networkidle" });
  await applyPdfTheme("dark");
  const darkBackground = await page.addStyleTag({ content: `
    @media print {
      html, body { background: #0c0a07 !important; }
      html { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
    }
  ` });
  await page.pdf({
    path: pdf,
    format: "A4",
    printBackground: true,
    preferCSSPageSize: true,
    margin: { top: "0", bottom: "0", left: "0", right: "0" },
  });
  await darkBackground.evaluate((element) => element.remove());
  await applyPdfTheme("light");
  const lightBackground = await page.addStyleTag({ content: `
    @media print {
      html, body { background: #fffdf8 !important; }
      html { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
    }
  ` });
  await page.pdf({
    path: lightPdf,
    format: "A4",
    printBackground: true,
    preferCSSPageSize: true,
    margin: { top: "0", bottom: "0", left: "0", right: "0" },
  });
  await lightBackground.evaluate((element) => element.remove());
  console.log(`✓ ${pdf.split("/").pop()} + ${lightPdf.split("/").pop()}`);
}

await browser.close();
console.log("\nتم توليد ملفات PDF بنجاح.");
