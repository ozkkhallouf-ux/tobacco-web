// فحص انحدار (regression) لمشكلة تكرّر قصّ نشرة الأسعار عند PDF.
// السبب الجذري الموثّق في docs/ai/topics/price-bulletins.md: table-layout:auto
// الافتراضي يسمح لجدول الأسعار بالتمدد أوسع من حاويته حين يطول "الاسم — الملاحظة"،
// وoverflow:hidden على جذر القالب يقصّ الفائض بصمت بدل إظهاره. هذا الفحص يولّد
// PDF فعلياً (فاتح وداكن) بأصناف حقيقية وحالة متطرفة (اسم وملاحظة طويلان جداً)
// عبر نفس محرك الطباعة المستخدم في scripts/generate-pdfs.mjs، ثم يتحقق آلياً أن
// لا فيضان أفقي (scrollWidth > clientWidth) وأن كل الأصناف/الأسعار/الملاحظات
// ظهرت فعلياً في النص المرسوم — بدل الاكتفاء بفحص نصي على الكود المصدري.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import path from "node:path";

const templateSrc = readFileSync(path.resolve("src/price-list-template.js"), "utf8");

const LONG_NOTE_ITEM = {
  name: "صنف باسم طويل جداً جداً جداً يتجاوز عرض الخلية بشكل واضح جداً — مع ملاحظة طويلة أيضاً تشرح تفاصيل كثيرة عن هذا الصنف بالذات ولماذا هو مختلف",
  unit: "كرتونة",
  price: "$ 999.00"
};
const NOTED_ITEM = { name: "كابتن بلاك كور — مع قداحات", unit: "كرتونة", price: "$ 311.00" };
const UPDATED_PRICE_ITEM = { name: "صنف مسعّر حديثاً", unit: "كرتونة", price: "$ 777.00" };

const groups = [
  {
    name: "ماستر",
    items: [LONG_NOTE_ITEM, NOTED_ITEM, UPDATED_PRICE_ITEM]
  },
  {
    name: "غلواز",
    items: Array.from({ length: 8 }, (_, i) => ({ name: `صنف رقم ${i + 1}`, unit: "كرتونة", price: `$ ${100 + i}.00` }))
  }
];

function pageHtml(theme) {
  return `<!doctype html><html><head><meta charset="utf-8">
<script>${templateSrc}</script>
</head><body>
<script>
document.body.innerHTML = OZKPriceListTemplate.render({
  groups: ${JSON.stringify(groups)},
  logoSrc: "",
  issueDate: OZKPriceListTemplate.formatArabicIssueDate(new Date()),
  badgeClass: "badge-usd",
  badgeLabelHtml: "دولار — جملة",
  unitLabel: "سعر الكرتونة (جملة)",
  theme: "${theme}"
});
</script>
</body></html>`;
}

let failed = false;
const browser = await chromium.launch();
try {
  for (const theme of ["dark", "light"]) {
    const page = await browser.newPage();
    await page.setContent(pageHtml(theme), { waitUntil: "networkidle" });
    await page.waitForTimeout(150);

    const bodyText = await page.locator(".ozk-price-list").innerText();
    for (const [label, needle] of [
      ["updated price reflects immediately", "777.00"],
      ["bulletin note appears", "كابتن بلاك كور — مع قداحات"],
      ["long name + long note text is present", "ولماذا هو مختلف"]
    ]) {
      if (!bodyText.includes(needle)) {
        console.error(`[${theme}] FAIL: ${label} — expected text not found: ${needle}`);
        failed = true;
      }
    }

    // لا فيضان أفقي: أي عنصر أوسع من حاويته الفعلية يعني أن table-layout:auto
    // عاد أو أن word-break أُزيل — القصّ الصامت (overflow:hidden) سيخفي هذا دون
    // هذا الفحص الصريح.
    const overflow = await page.evaluate(() => {
      const root = document.querySelector(".ozk-price-list");
      const tables = [...document.querySelectorAll(".ozk-price-list table")];
      return {
        rootOverflow: root.scrollWidth - root.clientWidth,
        tableOverflows: tables
          .map((t) => t.scrollWidth - t.closest(".price-list-column-stack").clientWidth)
          .filter((d) => d > 1)
      };
    });
    if (overflow.rootOverflow > 1) {
      console.error(`[${theme}] FAIL: root element overflows horizontally by ${overflow.rootOverflow}px (would be silently clipped by overflow:hidden).`);
      failed = true;
    }
    if (overflow.tableOverflows.length) {
      console.error(`[${theme}] FAIL: ${overflow.tableOverflows.length} table(s) wider than their column (long name/note broke the layout).`);
      failed = true;
    }

    await page.close();
  }
} finally {
  await browser.close();
}

if (failed) {
  console.error("Price bulletin layout regression check FAILED.");
  process.exit(1);
}
console.log("Price bulletin layout regression check passed (no horizontal overflow, price/note render correctly in both themes).");
