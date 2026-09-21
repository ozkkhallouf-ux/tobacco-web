// حارس رسم خانة الكمية في فاتورة المبيعات — **المسار المحمول الحقيقي**.
//
// ── لماذا أُعيدت كتابة هذا الحارس ─────────────────────────────────────────
// نسخته الأولى كانت تمرّ بينما العطل قائم فعلاً على آيفون حقيقي. وسبب ذلك
// ثغرتان منهجيتان، كلتاهما مُصلَحة هنا:
//   1. كانت تفحص **خانة مفردة** مزروعة في صفحة اصطناعية، ولا تمرّ إطلاقاً
//      على `createPortablePdfBlob` — وهي الدالة التي يستعملها الهاتف فعلاً
//      (الحاوية، ماشي NBSP، الاستنساخ). فكانت تحرس شيئاً غير الذي يُصدَّر.
//   2. كانت تقيس **هندسة DOM** فقط، وتعتبر الترتيب الصحيح فيها إثباتاً.
//
// ── حدّ هذا الحارس، منصوصاً عليه كي لا يُقرأ أكثر من حجمه ────────────────
// المتاح هنا Chromium وحده. و**Chromium لا يُثبت صحّة WebKit**: العطل الذي
// أوجب هذا التغيير خرج صحيحاً على Chromium ومقلوباً على آيفون حقيقي على
// نفس الـcommit. فنجاح هذا الملف في CI ليس شهادة نجاح على آيفون، ولا يجوز
// تقديمه على أنه كذلك — التحقّق من الآيفون يبقى بشرياً على جهاز حقيقي.
//
// ولذلك لا يقيس هذا الحارس «هل خرج الترتيب صحيحاً على هذا المحرّك» وحسب،
// بل يقيس ما هو أقوى ومستقلّ عن المحرّك: **أن الترتيب البصري ليس ناتج
// خوارزمية BiDi أصلاً**. والفحص القاطع لذلك هو فحص ٤: يُقلب اتجاه المستند
// كلّه إلى ltr، فلو كان التركيب يعتمد BiDi لانقلب الترتيب — وثباته يعني أن
// مصدره التخطيط وحده، وهو ما لا يختلف بين المحرّكات.
//
// ما يفحصه الملف:
//   1. الدوال الحقيقية: الأجزاء، والنص المسطّح القديم بلا تغيير.
//   2. بنية الخانة في القالب للحالات الأربع الحقيقية، بلا أقواس.
//   3. المسار المحمول الفعلي: voucherPdfMarkup → createPortablePdfBlob →
//      html2pdf، مع التقاط الـDOM **كما يصل إلى المحرّك** بعد كل معالجة،
//      وقياس الهندسة لكل سطر من الأسطر الأربعة، ثم حبر اللوحة واستقرارها.
//   4. استقلال الترتيب عن اتجاه المستند (الفحص القاطع أعلاه).
//   5. التصاق الرقم بوحدته: الفجوة داخل المجموعة أصغر من الفجوة بين
//      المجموعتين — وهو شرط «primary number adjacent to its Arabic unit».

import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { chromium } from "playwright";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const appJs = readFileSync(join(root, "src/app.js"), "utf8");
const invJs = readFileSync(join(root, "src/documents/invoice/ozk-invoice.js"), "utf8");
const indexPath = join(root, "index.html");
const bundlePath = join(root, "public/vendor/html2pdf.bundle.min.js");

// الحالات البصرية الحقيقية الأربع المطلوب دعمها.
const CASES = [
  { material: "ماستر طويل ورق",  qty: 50, unit1: "كروز", qtyUnits: 1,    unit2: "كرتونة", price: 7.418, value: "1",    detail: "50" },
  { material: "ماستر قصير أزرق", qty: 25, unit1: "كروز", qtyUnits: 0.5,  unit2: "كرتونة", price: 7.6,   value: "0.5",  detail: "25" },
  { material: "ماستر كوين أبيض", qty: 6,  unit1: "كروز", qtyUnits: 0.12, unit2: "كرتونة", price: 7.782, value: "0.12", detail: "6"  },
  { material: "معسل فاخر اسود",  qty: 25, unit1: "كروز", qtyUnits: 1,    unit2: "شرحة",   price: 6,     value: "1",    detail: "25" }
];

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

for (const c of CASES) {
  const parts = invoiceLineQtyParts(c);
  assert.equal(parts.value, c.value, `قيمة الكمية تغيّرت (${c.material})`);
  assert.equal(parts.unit, c.unit2, `الوحدة الكبرى تغيّرت (${c.material})`);
  assert.equal(parts.detailValue, c.detail, `قيمة التوضيح تغيّرت (${c.material})`);
  assert.equal(parts.detailUnit, c.unit1, `وحدة التوضيح تغيّرت (${c.material})`);
  // النص المسطّح القديم يبقى كما كان حرفاً بحرف — تستعمله الشاشة والقالب القديم.
  assert.equal(
    invoiceLineQty(c),
    `${c.value} ${c.unit2} (${c.detail} ${c.unit1})`,
    `النص المسطّح لـinvoiceLineQty تغيّر (${c.material}) — مسارات أخرى تعتمده`
  );
}

// ===== 2) بنية الخانة في القالب: مجموعات تخطيطية، بلا أقواس =====

const doc = {
  kind: "invoice", escapeHtml: (s) => String(s == null ? "" : s),
  no: "777", date: "2026-09-17", cur: "$", party: "زبون اختبار",
  amountText: "129.673",
  lines: CASES.map((c) => ({
    material: c.material,
    qtyParts: invoiceLineQtyParts(c),
    qtyText: invoiceLineQty(c),
    priceText: `${c.price} $ / ${c.unit1}`,
    valueText: `${Math.round(c.price * c.qty * 1000) / 1000} $`
  })),
  rows: []
};

const markup = OZK_INVOICE.markup(doc);
const tbody = markup.split("<tbody>")[1].split("</tbody>")[0];

assert.ok(!/[()]/.test(tbody), "عاد القوسان إلى خانة الكمية — لا ينجوان من محرّك الرسم");
for (const c of CASES) {
  const cell = `<span class="qty">`
    + `<span class="qg"><span class="qv">${c.value}</span><span class="qu">${c.unit2}</span></span>`
    + `<span class="qg q-det"><span class="qv">${c.detail}</span><span class="qu">${c.unit1}</span></span>`
    + `</span>`;
  assert.ok(tbody.includes(cell), `خانة الكمية ليست مجموعات تخطيطية بالترتيب (${c.material})`);
}
// الترتيب البصري يأتي من التخطيط لا من BiDi — فالقاعدتان شرط في الأسلوب نفسه.
assert.ok(/\.ozk-inv \.qty\{[^}]*display:flex/.test(invJs), "حاوية الكمية لم تعد flex");
assert.ok(/\.ozk-inv \.qty\{[^}]*flex-direction:row-reverse/.test(invJs), "ترتيب الحاوية لم يعد row-reverse");
assert.ok(/\.ozk-inv \.qty\{[^}]*direction:ltr/.test(invJs), "حاوية الكمية لم تعد تثبّت اتجاهها صراحةً");
assert.ok(/\.ozk-inv \.qg\{[^}]*flex-direction:row-reverse/.test(invJs), "مجموعة الكمية لم تعد row-reverse");
assert.ok(/\.ozk-inv \.qg\{[^}]*direction:ltr/.test(invJs), "مجموعة الكمية لم تعد تثبّت اتجاهها صراحةً");

// ماشي NBSP في createPortablePdfBlob يستبدل المسافة داخل **عقدة** فيها عربي.
// لا عقد نصّية بين الأجزاء هنا أصلاً (المسافات `gap`) — فلا شيء يمسّه.
const walkerSrc = appJs.match(/const textWalker = document\.createTreeWalker[\s\S]*?\n  \}\n/);
assert.ok(walkerSrc, "تعذّر إيجاد ماشي NBSP — عقد PDF المحمول فقد هدفه");
assert.ok(
  /\[\\u0600-\\u06ff\]/.test(walkerSrc[0]),
  "ماشي NBSP لم يعد مشروطاً بوجود حرف عربي في العقدة"
);

// ===== 3) المسار المحمول الحقيقي داخل التطبيق المحمَّل =====

assert.ok(existsSync(bundlePath), "حزمة html2pdf غائبة — مسار PDF على الهاتف يعتمدها");
assert.ok(existsSync(indexPath), "index.html غائب — لا سبيل لتشغيل المسار الحقيقي");

// قياس الهندسة يقرأ الصناديق كما يقرؤها html2canvas تماماً.
const MEASURE = `(rootSelector) => {
  const rows = [...document.querySelectorAll(rootSelector + " .items-table tbody tr")];
  return rows.map((tr) => {
    const cell = tr.children[1];
    const wrap = cell.querySelector(".qty");
    const atoms = [...cell.querySelectorAll(".qv,.qu")].map((el) => {
      const r = el.getBoundingClientRect();
      return { text: el.textContent, cls: el.className, left: r.left, right: r.right };
    });
    return {
      atoms,
      textNodesBetween: [...(wrap ? wrap.childNodes : [])].filter((n) => n.nodeType === 3).length,
      hasParens: /[()]/.test(cell.textContent),
      display: wrap ? getComputedStyle(wrap).display : "",
      flexDirection: wrap ? getComputedStyle(wrap).flexDirection : ""
    };
  });
}`;

const browser = await chromium.launch({ args: ["--allow-file-access-from-files"] });
try {
  const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e && e.message ? e.message : e)));
  await page.goto(pathToFileURL(indexPath).href, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => typeof voucherPdfMarkup === "function" && typeof createPortablePdfBlob === "function",
    null,
    { timeout: 20000 }
  );

  // نمرّر الفاتورة كاملة عبر المسار الذي يسلكه الهاتف حرفياً، ونعترض html2pdf
  // كي نلتقط الجذر **كما يصل إلى المحرّك** بعد الحاوية وماشي NBSP والاستنساخ.
  const real = await page.evaluate(async ({ cases, measureSrc }) => {
    const lines = cases.map((c) => ({ ...c, lineTotal: Math.round(c.price * c.qty * 1000) / 1000 }));
    const amount = Math.round(lines.reduce((s, l) => s + l.lineTotal, 0) * 1000) / 1000;
    const voucher = {
      type: "invoice", no: "777", date: "2026-09-17",
      name: "زبون اختبار", cur: "$", balanceCur: "$",
      amount, lines, prevBalance: 100, newBalance: 100 + amount
    };
    const markup = voucherPdfMarkup(voucher);

    const captured = {};
    const original = window.html2pdf;
    // `.set()` يعيد كائن عامل جديد، فنغلّف كل كائن يمرّ بنا حتى نمسك `from`
    // الحقيقية أياً كان موضعها في السلسلة.
    const wrap = (worker) => {
      if (!worker || worker.__ozkWrapped) return worker;
      worker.__ozkWrapped = true;
      for (const key of ["set", "from", "toContainer", "toCanvas"]) {
        const fn = worker[key];
        if (typeof fn !== "function") continue;
        worker[key] = function (...a) {
          if (key === "from" && a[0] && a[0].querySelector) {
            const source = a[0];
            source.id = source.id || "ozk-prerender-root";
            captured.rootId = source.id;
            captured.rootHtml = source.innerHTML;
            // `createPortablePdfBlob` يمرّر أول ابن غير <style>، وهو جذر الفاتورة نفسه.
            captured.usesMasterTemplate = source.classList.contains("ozk-inv") || !!source.querySelector(".ozk-inv");
            // نقيس على الشجرة التي سلّمها createPortablePdfBlob للمحرّك.
            captured.rows = (0, eval)("(" + measureSrc + ")")("#" + source.id);
          }
          const r = fn.apply(this, a);
          if (key === "toCanvas") {
            return Promise.resolve(r).then((x) => {
              const c = (this.prop && this.prop.canvas) || this.canvas;
              if (c) {
                try {
                  const { data } = c.getContext("2d").getImageData(0, 0, c.width, c.height);
                  let ink = 0;
                  for (let i = 0; i < data.length; i += 4) {
                    if (data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200) ink++;
                  }
                  captured.canvas = { ink, width: c.width, height: c.height };
                } catch (e) { captured.canvasError = String(e && e.message ? e.message : e); }
              }
              return x;
            });
          }
          return wrap(r);
        };
      }
      return worker;
    };
    window.html2pdf = function patched(...args) { return wrap(original.apply(this, args)); };

    let error = "";
    try {
      await createPortablePdfBlob(markup, "فاتورة-اختبار.pdf", { width: 794 });
    } catch (e) {
      error = String(e && e.message ? e.message : e);
    } finally {
      window.html2pdf = original;
    }
    return { error, markup, ...captured };
  }, { cases: CASES, measureSrc: MEASURE });

  assert.equal(pageErrors.length, 0, `أخطاء في الصفحة أثناء المسار الحقيقي: ${pageErrors.join(" | ")}`);
  assert.equal(real.error, "", `فشل المسار المحمول الحقيقي: ${real.error}`);
  assert.ok(real.usesMasterTemplate, "المسار الحقيقي لم يستعمل قالب الفاتورة الرئيسي (ozk-inv)");
  assert.ok(real.rows && real.rows.length === CASES.length, "لم تصل أسطر الفاتورة كاملة إلى المحرّك");

  real.rows.forEach((row, i) => {
    const c = CASES[i];
    const where = `السطر ${i + 1} (${c.material})`;
    assert.ok(!row.hasParens, `${where}: عاد القوسان إلى الخانة`);
    assert.equal(row.display, "flex", `${where}: حاوية الكمية لم تعد flex عند المحرّك`);
    assert.equal(row.flexDirection, "row-reverse", `${where}: ترتيب الحاوية لم يعد تخطيطياً`);
    assert.equal(row.textNodesBetween, 0, `${where}: ظهرت عقدة نصّية بين المجموعتين — يمكن لماشي NBSP أن يلحمها`);
    assert.equal(row.atoms.length, 4, `${where}: عدد أجزاء الخانة تغيّر`);

    const [value, unit, detValue, detUnit] = row.atoms;
    assert.equal(value.text, c.value, `${where}: الجزء الأول ليس قيمة الكمية`);
    assert.equal(unit.text, c.unit2, `${where}: الجزء الثاني ليس الوحدة الكبرى`);
    assert.equal(detValue.text, c.detail, `${where}: الجزء الثالث ليس قيمة التوضيح`);
    assert.equal(detUnit.text, c.unit1, `${where}: الجزء الرابع ليس وحدة التوضيح`);

    // في القراءة العربية: الأسبق منطقياً هو الأيمن بصرياً.
    assert.ok(value.right > unit.right, `${where}: «${c.value}» ليست يمين «${c.unit2}» — العطل عاد`);
    assert.ok(unit.right > detValue.right, `${where}: الكمية الأساسية لم تعد تسبق توضيحها`);
    assert.ok(detValue.right > detUnit.right, `${where}: التوضيح نفسه مقلوب`);

    // فحص ٥: الرقم ملاصق لوحدته. الفجوة داخل المجموعة أضيق من الفجوة بينهما.
    const insideGap = value.left - unit.right;
    const betweenGap = unit.left - detValue.right;
    assert.ok(insideGap >= 0 && insideGap < 8, `${where}: الرقم ابتعد عن وحدته (${insideGap}px)`);
    assert.ok(
      betweenGap > insideGap + 2,
      `${where}: المجموعتان التصقتا فضاع تمييز الأساسي عن التوضيح (${insideGap}px داخل / ${betweenGap}px بين)`
    );
  });

  assert.ok(real.canvas, `لم أستطع قراءة لوحة الرسم${real.canvasError ? ": " + real.canvasError : ""}`);
  assert.ok(real.canvas.width > 0 && real.canvas.height > 0, "لوحة الرسم خرجت بأبعاد صفرية");
  assert.ok(real.canvas.ink > 0, "لوحة الرسم خرجت بيضاء بالكامل — الفاتورة لا تُرسَم على الهاتف");

  // ===== 4) الفحص القاطع: الترتيب مستقلّ عن اتجاه المستند =====
  //
  // لو كان التركيب البصري يعتمد خوارزمية BiDi لانقلب الترتيب بقلب اتجاه
  // المستند. ثباتُه يعني أن مصدره التخطيط وحده — وهذا ما لا يختلف بين
  // Chromium وWebKit، وهو أقوى ما يمكن لهذه البيئة أن تُثبته.
  const orderOf = (rows) => rows.map((r) => r.atoms.map((a) => a.text).join("|")).join(" // ");
  const flipped = await page.evaluate(({ markupHtml, measureSrc }) => {
    const host = document.createElement("div");
    host.id = "ozk-bidi-probe";
    host.setAttribute("dir", "ltr");
    host.style.cssText = "direction:ltr;position:fixed;left:0;top:0;width:794px;background:#fff;z-index:-1";
    host.innerHTML = markupHtml;
    document.body.appendChild(host);
    const measure = (0, eval)("(" + measureSrc + ")");
    const ltr = measure("#ozk-bidi-probe");
    host.setAttribute("dir", "rtl");
    host.style.direction = "rtl";
    const rtl = measure("#ozk-bidi-probe");
    host.remove();
    return { ltr, rtl };
  }, { markupHtml: real.markup, measureSrc: MEASURE });

  assert.equal(
    orderOf(flipped.ltr),
    orderOf(flipped.rtl),
    "ترتيب أجزاء الكمية تغيّر بتغيّر اتجاه المستند — فهو ما زال ناتج BiDi لا ناتج التخطيط"
  );
  flipped.ltr.forEach((row, i) => {
    const [value, unit] = row.atoms;
    assert.ok(
      value.right > unit.right,
      `السطر ${i + 1}: الرقم لم يبقَ يمين وحدته في سياق ltr — التركيب يعتمد BiDi`
    );
  });
} finally {
  await browser.close();
}

console.log("✓ خانة الكمية: مجموعات تخطيطية بلا BiDi، ملاصقة ومرتّبة، عبر المسار المحمول الحقيقي");
console.log("  ملاحظة منهجية: Chromium لا يُثبت صحّة WebKit — نجاح هذا الفحص ليس شهادة نجاح على آيفون.");
