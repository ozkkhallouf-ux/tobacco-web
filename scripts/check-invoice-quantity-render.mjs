// حارس رسم خانة الكمية في فاتورة المبيعات — مسار PDF على الهاتف.
//
// لماذا وُجد هذا الحارس:
//   خانة الكمية كانت تُرسَل إلى محرّك الرسم عقدةً نصّية واحدة مختلطة
//   («0.12 كرتونة (6 كروز)»). والنصّ المنطقي سليم — رُسم في المتصفح بستّ
//   صياغات مختلفة (مع bdi وبدونه، مع NBSP وبدونه، مع dir=rtl صريح) فخرجت
//   الستّ متطابقة وصحيحة. لكن `html2canvas` (مسار الهاتف، بلا
//   foreignObjectRendering) **لا يطبّق خوارزمية BiDi**: يأخذ مواضع الصناديق
//   من تخطيط المتصفح الحقيقي، ثم يرسم نصّ كل عقدة بنفسه. فكل عقدة تخلط رقماً
//   وعربياً وأقواساً يُعيد ترتيبها خطأً، ولا ينفع معها عزلٌ ولا `dir`.
//
//   وثبت بالقياس على المحرّك نفسه أمران:
//     • إصلاح NBSP في `createPortablePdfBlob` هو ما يُزيح «0.12» عن «كرتونة»
//       (بلا NBSP تبقى ملاصقة، ومعه تنفصل).
//     • القوسان لا ينجوان بأي شكل: حرفيَّين، أو كعنصرين مستقلين، أو
//       بـ`dir="ltr"` صريح، أو كـ`content` في CSS — ينقلبان في الحالات الأربع.
//
//   فالعلاج المعتمد: أجزاء ذرّية، كلٌّ في عنصر عزل مستقل، بلا أي قوس —
//   وهي الصياغة الوحيدة التي خرجت صحيحة بالكامل من المحرّك.
//
// ما يفحصه هذا الملف:
//   1. الترتيب **هندسياً** على التخطيط الحقيقي (المرجع القاطع للترتيب، إذ
//      مواضع الصناديق هي ما يأخذه html2canvas كما هي).
//   2. خلوّ الخانة من الأقواس، وأن كل جزء عقدة نصّية مستقلة — فلا يستطيع
//      ماشي NBSP أن يلحم جزأين في عقدة واحدة فيعود العطل.
//   3. أن المرور الفعلي على `html2canvas` يُخرج حبراً (لا لوحة بيضاء) وأنه
//      مستقرّ بين تشغيلين.
//   الفحص 3 عمداً ليس تأكيداً بصرياً للترتيب: لا سبيل لقراءة ترتيب الحروف من
//   لوحة رسم بلا OCR. الترتيب يحرسه الفحص 1، والبنية يحرسها الفحص 2 — وهما
//   معاً يمنعان عودة الصياغة المختلطة التي يخطئ فيها المحرّك.

import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { chromium } from "playwright";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const appJs = readFileSync(join(root, "src/app.js"), "utf8");
const invJs = readFileSync(join(root, "src/documents/invoice/ozk-invoice.js"), "utf8");
const bundlePath = join(root, "public/vendor/html2pdf.bundle.min.js");

// ===== 1) الدوال الحقيقية من المصدر، لا نسخة مبسّطة =====

const PATTERNS = {
  formatMoney: /function formatMoney\(value\) \{[\s\S]*?\n\}\n/,
  roundPrice: /function roundPrice\(value\) \{[\s\S]*?\n\}\n/,
  invoiceLineQtyParts: /function invoiceLineQtyParts\(line\) \{[\s\S]*?\n\}\n/,
  invoiceLineQty: /function invoiceLineQty\(line\) \{[\s\S]*?\n\}\n/
};

let src = "";
for (const [name, re] of Object.entries(PATTERNS)) {
  const m = appJs.match(re);
  assert.ok(m, `تعذّر استخراج ${name} من src/app.js — الحارس فقد هدفه`);
  src += m[0] + "\n";
}

const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(invJs, sandbox);
vm.runInContext(src, sandbox);
const OZK_INVOICE = vm.runInContext("OZK_INVOICE", sandbox);
const { invoiceLineQtyParts, invoiceLineQty } = sandbox;

// سطر الفاتورة 2046 الأول كما وصل من الأمين حرفياً.
const LINE_2046 = {
  material: "ماستر طويل ورق",
  qty: 6, unit1: "كروز",
  qtyUnits: 0.12, unit2: "كرتونة",
  price: 7.418, lineTotal: 44.509
};

const parts = invoiceLineQtyParts(LINE_2046);
assert.equal(parts.value, "0.12", "قيمة الكمية بالوحدة الكبرى تغيّرت");
assert.equal(parts.unit, "كرتونة", "الوحدة الكبرى تغيّرت");
assert.equal(parts.detailValue, "6", "قيمة التوضيح تغيّرت");
assert.equal(parts.detailUnit, "كروز", "وحدة التوضيح تغيّرت");

// النص المسطّح القديم يبقى كما كان حرفاً بحرف — تستعمله الشاشة والقالب القديم.
assert.equal(
  invoiceLineQty(LINE_2046),
  "0.12 كرتونة (6 كروز)",
  "النص المسطّح لـinvoiceLineQty تغيّر — ثلاثة مسارات أخرى تعتمده"
);

// ===== 2) بنية الخانة: ذرّية وبلا أقواس =====

const doc = {
  kind: "invoice", escapeHtml: (s) => String(s == null ? "" : s),
  no: "2046", date: "2026-09-21", cur: "$", party: "زبون",
  amountText: "129.673",
  lines: [{
    material: LINE_2046.material,
    qtyParts: parts,
    qtyText: invoiceLineQty(LINE_2046),
    priceText: "7.418 $ / كروز",
    valueText: "44.508 $"
  }],
  rows: []
};

const markup = OZK_INVOICE.markup(doc);
const cellMatch = markup.match(/<td><bdi>ماستر طويل ورق<\/bdi><\/td>|<td>ماستر طويل ورق<\/td>/);
assert.ok(cellMatch, "تعذّر إيجاد سطر المادة في القالب");

const qtyCell = markup.split("<tbody>")[1].split("</tbody>")[0];
assert.ok(!/[()]/.test(qtyCell), "عاد القوسان إلى خانة الكمية — لا ينجوان من محرّك الرسم");
assert.ok(
  qtyCell.includes("<bdi>0.12</bdi>") && qtyCell.includes("<bdi>كرتونة</bdi>"),
  "الكمية لم تعد أجزاءً ذرّية في عناصر عزل مستقلة"
);
assert.ok(
  qtyCell.includes("<bdi>6</bdi>") && qtyCell.includes("<bdi>كروز</bdi>"),
  "التوضيح لم يعد أجزاءً ذرّية في عناصر عزل مستقلة"
);
assert.ok(qtyCell.includes("q-det"), "التوضيح فقد تمييزه البصري الثانوي");

// ماشي NBSP في createPortablePdfBlob يستبدل المسافة داخل **عقدة** فيها عربي.
// كل جزء هنا عقدة مستقلة، والمسافات بينها عقد بيضاء بلا حرف عربي — فلا يمسّها.
const walkerSrc = appJs.match(/const textWalker = document\.createTreeWalker[\s\S]*?\n  \}\n/);
assert.ok(walkerSrc, "تعذّر إيجاد ماشي NBSP — عقد PDF المحمول فقد هدفه");
assert.ok(
  /\[\\u0600-\\u06ff\]/.test(walkerSrc[0]),
  "ماشي NBSP لم يعد مشروطاً بوجود حرف عربي في العقدة"
);

// ===== 3) الترتيب الهندسي والرسم الفعلي =====

assert.ok(existsSync(bundlePath), "حزمة html2pdf غائبة — مسار PDF على الهاتف يعتمدها");

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 820, height: 420 } });
  const page = await context.newPage();
  await page.setContent(
    `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">`
    + `<script>${readFileSync(bundlePath, "utf8")}<\/script></head>`
    + `<body style="margin:0;background:#fff">${markup}</body></html>`,
    { waitUntil: "domcontentloaded" }
  );

  const geometry = await page.evaluate(() => {
    const cells = document.querySelectorAll(".ozk-inv .items-table tbody tr td");
    const qty = cells[1];
    const atoms = [...qty.querySelectorAll("bdi")].map((b) => ({
      text: b.textContent,
      right: b.getBoundingClientRect().right
    }));
    return { atoms, direction: getComputedStyle(qty).direction };
  });

  assert.equal(geometry.direction, "rtl", "خانة الكمية لم تعد تُخطَّط من اليمين لليسار");
  assert.equal(geometry.atoms.length, 4, "عدد الأجزاء الذرّية في الخانة تغيّر");

  const [value, unit, detValue, detUnit] = geometry.atoms;
  assert.equal(value.text, "0.12", "الجزء الأول ليس قيمة الكمية");
  assert.equal(unit.text, "كرتونة", "الجزء الثاني ليس الوحدة");
  assert.equal(detValue.text, "6", "الجزء الثالث ليس قيمة التوضيح");
  assert.equal(detUnit.text, "كروز", "الجزء الرابع ليس وحدة التوضيح");

  // في سياق من اليمين لليسار: الأسبق منطقياً هو الأيمن بصرياً.
  // هذا هو الترتيب الذي انكسر على الآيفون: «0.12» كانت تُزاح عن «كرتونة».
  assert.ok(
    value.right > unit.right,
    `«0.12» ليست يمين «كرتونة» — العطل الأصلي عاد (${value.right} ≤ ${unit.right})`
  );
  assert.ok(
    unit.right > detValue.right,
    "«كرتونة» ليست يمين التوضيح — الكمية الأساسية لم تعد تسبق توضيحها"
  );
  assert.ok(
    detValue.right > detUnit.right,
    "«6» ليست يمين «كروز» — التوضيح نفسه مقلوب"
  );

  // المرور الفعلي على المحرّك: حبر حقيقي، ونتيجة مستقرّة.
  const renderInk = async () => page.evaluate(async () => {
    const source = document.querySelector(".ozk-inv");
    const worker = window.html2pdf().set({
      margin: [4, 4, 4, 4],
      html2canvas: { scale: 1.25, backgroundColor: "#ffffff", foreignObjectRendering: false, scrollX: 0, scrollY: 0 },
      jsPDF: { unit: "mm", format: "a4", orientation: "portrait" }
    }).from(source);
    await worker.toContainer();
    await worker.toCanvas();
    const canvas = (worker.prop && worker.prop.canvas) || worker.canvas;
    const { data } = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
    let ink = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200) ink++;
    }
    return { ink, width: canvas.width, height: canvas.height };
  });

  const first = await renderInk();
  assert.ok(first.width > 0 && first.height > 0, "لوحة الرسم خرجت بأبعاد صفرية");
  assert.ok(first.ink > 0, "لوحة الرسم خرجت بيضاء بالكامل — الفاتورة لا تُرسَم على الهاتف");

  const second = await renderInk();
  assert.equal(second.ink, first.ink, "الرسم غير مستقرّ بين تشغيلين متطابقين");
} finally {
  await browser.close();
}

console.log("✓ خانة الكمية: أجزاء ذرّية، بلا أقواس، بترتيب صحيح، وترسم فعلياً على مسار الهاتف");
