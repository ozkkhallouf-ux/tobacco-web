// حارس رسم خانة الكمية في فاتورة المبيعات — المسار المحمول الحقيقي.
//
// ── ما الذي يحرسه بالضبط ─────────────────────────────────────────────────
// الشرط البصري المطلوب لكل سطر، حرفياً، سطران مستقلان:
//       <رقم> <وحدة>        ← الأساسي، والرقم يمين وحدته
//       <رقم> <وحدة>        ← التوضيح، أخفت وأصغر
// ولا يكفي «عدم تداخل المجموعتين»: انعكاس «كرتونة 1» مرفوض أيضاً.
//
// ── لماذا أُعيدت كتابته مرّتين ───────────────────────────────────────────
// نسختان سابقتان مرّتا بينما العطل قائم على آيفون حقيقي:
//   • الأولى فحصت خانة مفردة في صفحة اصطناعية ولم تمرّ على
//     `createPortablePdfBlob` إطلاقاً.
//   • الثانية قاست هندسة صناديق flex، و**اشترطت** `direction:ltr`
//     و`flex-direction:row-reverse` — فثبّتت العطل بدل أن ترصده. وفحص «قلب
//     الاتجاه» فيها قلب اتجاه الأب بينما الخانة تتجاوزه محلياً، فلم يصل
//     القلب إلى النصّ أصلاً.
//
// ── النماذج الأربعة ──────────────────────────────────────────────────────
// المتاح هنا Chromium وحده، و**Chromium لا يُثبت صحّة WebKit**. فبدل أن
// نسأل «هل خرج صحيحاً على هذا المحرّك»، نسأل ما هو أقوى: هل يبقى الترتيب
// صحيحاً تحت كل نموذج معقول لسلوك المحرّك؟
//   1. المسار المحمول الحقيقي: voucherPdfMarkup → createPortablePdfBlob →
//      html2pdf، مقيساً على الشجرة كما تصل إلى المحرّك.
//   2. rtl الطبيعي كما يُؤلَّف القالب.
//   3. طيّ بأساس rtl: محتوى كل كتلة السطري يُطوى إلى نصّ واحد، وحدود الكتل
//      محفوظة (وهي محفوظة فعلاً: الجدول نفسه رُسم سليماً على الآيفون).
//   4. احتياط ltr: الأساس ltr وكل تجاوزات `direction` داخل الخانة مُلغاة،
//      والتخطيط محفوظ. هذا النموذج هو الذي أسقط الصياغتين السابقتين.
//
// الضمانة تأتي من الهندسة الفيزيائية: `float:right` يضع كل جزء صندوقاً
// كتلياً في موضع لا علاقة له باتجاه الفقرة، وعلامة RLM تضمن الترتيب حتى لو
// طُوي كل شيء إلى نصّ. ولا شيء منهما يعتمد على خوارزمية BiDi في المتصفح.

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

// الحالات البصرية الحقيقية الأربع المطلوب دعمها.
const CASES = [
  { material: "ماستر طويل ورق",  qty: 50, unit1: "كروز", qtyUnits: 1,    unit2: "كرتونة", price: 7.418, value: "1",    detail: "50" },
  { material: "ماستر قصير أزرق", qty: 25, unit1: "كروز", qtyUnits: 0.5,  unit2: "كرتونة", price: 7.6,   value: "0.5",  detail: "25" },
  { material: "ماستر كوين أبيض", qty: 6,  unit1: "كروز", qtyUnits: 0.12, unit2: "كرتونة", price: 7.782, value: "0.12", detail: "6"  },
  { material: "معسل فاخر اسود",  qty: 25, unit1: "كروز", qtyUnits: 1,    unit2: "شرحة",   price: 6,     value: "1",    detail: "25" }
];
const expectedLines = (c) => [`${c.value} ${c.unit2}`, `${c.detail} ${c.unit1}`];

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

// ===== 2) الأسلوب نفسه: هندسة فيزيائية، لا BiDi ولا flex =====

const doc = {
  kind: "invoice", escapeHtml: (s) => String(s == null ? "" : s),
  no: "777", date: "2026-09-17", cur: "$", party: "زبون اختبار", amountText: "129.673",
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
assert.ok(/\.ozk-inv \.qg \.qv\{[^}]*float:right/.test(invJs), "الرقم لم يعد موضوعاً هندسياً بعائم");
assert.ok(/\.ozk-inv \.qg \.qu\{[^}]*float:right/.test(invJs), "الوحدة لم تعد موضوعة هندسياً بعائم");
assert.ok(/\.ozk-inv \.qg\{[^}]*display:block/.test(invJs), "المجموعة لم تعد كتلة مستقلة بسطرها");
// الشرطان اللذان شفّرا العطل سابقاً: ممنوع عودتهما إلى خانة الكمية.
assert.ok(!/\.ozk-inv \.qt?[yg][^{]*\{[^}]*display:flex/.test(invJs), "عاد flex إلى خانة الكمية");
assert.ok(!/\.ozk-inv \.qt?[yg][^{]*\{[^}]*direction:ltr/.test(invJs), "عاد direction:ltr إلى خانة الكمية");
assert.ok(tbody.includes("‏"), "علامة RLM غائبة — الترتيب بلا ضمانة عند طيّ النصّ");

// ماشي NBSP في createPortablePdfBlob مشروط بوجود حرف عربي في العقدة.
const walkerSrc = appJs.match(/const textWalker = document\.createTreeWalker[\s\S]*?\n  \}\n/);
assert.ok(walkerSrc, "تعذّر إيجاد ماشي NBSP — عقد PDF المحمول فقد هدفه");
assert.ok(/\[\\u0600-\\u06ff\]/.test(walkerSrc[0]), "ماشي NBSP لم يعد مشروطاً بوجود حرف عربي");

// ===== 3) القياس البصري: رمزاً رمزاً، لا عقدةً عقدة =====
//
// `Range.getClientRects()` يعيد مستطيلاً لكل **مقطع اتجاهي** لا لكل كلمة —
// وهذا بالذات ما أخفى العطل عن النسخة السابقة. فنبني نطاقاً لكل رمز وحده.
const MEASURE = `(rootSelector) => {
  const rows = [...document.querySelectorAll(rootSelector + " .items-table tbody tr")];
  return rows.map((tr) => {
    const cell = tr.children[1];
    const parts = [];
    const walk = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walk.nextNode())) {
      const text = node.nodeValue;
      const re = /\\S+/g;
      let m;
      while ((m = re.exec(text))) {
        const token = m[0].replace(/[\\u200e\\u200f\\u202a-\\u202e]/g, "");
        if (!token) continue;
        const r = document.createRange();
        r.setStart(node, m.index);
        r.setEnd(node, m.index + m[0].length);
        const box = r.getBoundingClientRect();
        if (!box.width && !box.height) continue;
        parts.push({ t: token, right: box.right, top: Math.round(box.top) });
      }
    }
    parts.sort((a, b) => (a.top - b.top) || (b.right - a.right));
    const lines = [];
    let cur = null;
    for (const p of parts) {
      if (!cur || Math.abs(cur.top - p.top) > 3) { cur = { top: p.top, t: [] }; lines.push(cur); }
      cur.t.push(p.t);
    }
    return lines.map((l) => l.t.join(" "));
  });
}`;

const assertRows = (rows, model) => {
  assert.ok(Array.isArray(rows) && rows.length === CASES.length,
    `${model}: لم تصل أسطر الفاتورة كاملة (${rows && rows.length})`);
  rows.forEach((lines, i) => {
    const want = expectedLines(CASES[i]);
    assert.deepEqual(lines, want,
      `${model} — السطر ${i + 1} (${CASES[i].material}): الترتيب البصري ${JSON.stringify(lines)} والمطلوب ${JSON.stringify(want)}`);
  });
};

assert.ok(existsSync(indexPath), "index.html غائب — لا سبيل لتشغيل المسار الحقيقي");

const browser = await chromium.launch({ args: ["--allow-file-access-from-files"] });
try {
  const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e && e.message ? e.message : e)));
  await page.goto(pathToFileURL(indexPath).href, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => typeof voucherPdfMarkup === "function" && typeof createPortablePdfBlob === "function",
    null, { timeout: 20000 }
  );

  // ---- النموذج ١: المسار المحمول الحقيقي ----
  const real = await page.evaluate(async ({ cases, measureSrc }) => {
    const lines = cases.map((c) => ({ ...c, lineTotal: Math.round(c.price * c.qty * 1000) / 1000 }));
    const amount = Math.round(lines.reduce((s, l) => s + l.lineTotal, 0) * 1000) / 1000;
    const markup = voucherPdfMarkup({
      type: "invoice", no: "777", date: "2026-09-17", name: "زبون اختبار",
      cur: "$", balanceCur: "$", amount, lines, prevBalance: 100, newBalance: 100 + amount
    });
    const captured = {};
    const original = window.html2pdf;
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
            captured.usesMasterTemplate = source.classList.contains("ozk-inv") || !!source.querySelector(".ozk-inv");
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
                  for (let i = 0; i < data.length; i += 4) if (data[i] < 200) ink++;
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
    try { await createPortablePdfBlob(markup, "فاتورة-اختبار.pdf", { width: 794 }); }
    catch (e) { error = String(e && e.message ? e.message : e); }
    finally { window.html2pdf = original; }
    return { error, markup, ...captured };
  }, { cases: CASES, measureSrc: MEASURE });

  assert.equal(pageErrors.length, 0, `أخطاء في الصفحة: ${pageErrors.join(" | ")}`);
  assert.equal(real.error, "", `فشل المسار المحمول الحقيقي: ${real.error}`);
  assert.ok(real.usesMasterTemplate, "المسار الحقيقي لم يستعمل قالب الفاتورة الرئيسي (ozk-inv)");
  assertRows(real.rows, "١) المسار المحمول الحقيقي");
  assert.ok(real.canvas, `لم أستطع قراءة لوحة الرسم${real.canvasError ? ": " + real.canvasError : ""}`);
  assert.ok(real.canvas.ink > 0, "لوحة الرسم خرجت بيضاء — الفاتورة لا تُرسَم على الهاتف");

  // ---- النماذج ٢ و٣ و٤ ----
  const models = await page.evaluate(({ markupHtml, measureSrc }) => {
    const out = {};
    const build = (model) => {
      document.getElementById("ozk-model-probe")?.remove();
      const host = document.createElement("div");
      host.id = "ozk-model-probe";
      host.style.cssText = "position:fixed;left:0;top:0;width:794px;background:#fff;z-index:-1";
      host.setAttribute("dir", model === "ltr-fallback" ? "ltr" : "rtl");
      host.style.direction = model === "ltr-fallback" ? "ltr" : "rtl";
      host.innerHTML = markupHtml;
      document.body.appendChild(host);
      if (model === "ltr-fallback") {
        // محرّك يتجاهل تجاوزات direction ويحترم صناديق التخطيط
        host.querySelectorAll(".qty, .qty *").forEach((el) => { el.style.direction = "inherit"; });
      }
      if (model === "flat-rtl") {
        // محرّك يطوي المحتوى السطري داخل كل كتلة إلى نصّ واحد
        host.querySelectorAll(".qg").forEach((g) => {
          g.textContent = [...g.childNodes].map((n) => n.textContent).join(" ").replace(/\s+/g, " ").trim();
        });
      }
      const rows = (0, eval)("(" + measureSrc + ")")("#ozk-model-probe");
      host.remove();
      return rows;
    };
    for (const m of ["rtl", "flat-rtl", "ltr-fallback"]) out[m] = build(m);
    return out;
  }, { markupHtml: real.markup, measureSrc: MEASURE });

  assertRows(models["rtl"], "٢) rtl الطبيعي");
  assertRows(models["flat-rtl"], "٣) طيّ بأساس rtl");
  assertRows(models["ltr-fallback"], "٤) احتياط ltr بلا تجاوز direction");
} finally {
  await browser.close();
}

console.log("✓ خانة الكمية: الترتيب البصري المطلوب تحت النماذج الأربعة، والمسار المحمول الحقيقي ضمنها");
console.log("  ملاحظة منهجية: Chromium لا يُثبت صحّة WebKit — نجاح هذا الفحص ليس شهادة نجاح على آيفون.");
