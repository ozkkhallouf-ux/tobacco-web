// حارس «OZK TOBACCO» والكمية الكسرية على مسار PDF الهاتف الحقيقي (مرتجع #37).
//
// ── العطل (تحقق iPhone على PR #264، 2026-09-23) ──────────────────────────
// الملاحظة «هذا سند رسمي … إلى OZK TOBACCO.» والتذييل «صادر آليًا عن نظام
// OZK TOBACCO · …» خرجا في PDF الهاتف و«TOBACCO» مرسومة فوق «OZK». السبب في
// html2canvas: يرسم كل كلمة بـfillText من الحافة اليسرى لمستطيل نطاقها في DOM.
// والمحرف المحايد الملاصق لـ«TOBACCO» (النقطة أو « —» أو « ·») يأخذ اتجاه الفقرة
// RTL فيقع بصرياً يسار «OZK»، فيتّسع مستطيل «TOBACCO.» ليبدأ قبل «OZK».
// العلاج: `<bdi>OZK TOBACCO</bdi>` — العبارة في عزل اتجاهي مستقل، والمحايد خارجه.
//
// ── ما يقيسه ─────────────────────────────────────────────────────────────
// المسار الحقيقي: voucherPdfMarkup → createPortablePdfBlob → html2pdf، والقياس
// على الشجرة كما تصل إلى html2canvas (بعد ماشي NBSP). لكل كلمة لاتينية في الملاحظة
// والتذييل: مستطيل نطاقها كما يأخذه html2canvas لا يتجاوز عرض رسمها الفعلي، ولا
// يتقاطع مع جارتها، و«OZK» يسار «TOBACCO». ومعه خانة الكمية لأسطر #37:
// «107.6 كروز» و«11.4 كروز» سطراً واحداً بلا كسر كرتونة.
//
// Chromium لا يُثبت صحّة WebKit؛ هذا حارس الآلية المشخَّصة لا شهادة آيفون.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "playwright";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const indexPath = join(root, "index.html");
assert.ok(existsSync(indexPath), "index.html غائب — لا سبيل لتشغيل المسار الحقيقي");

const LINES_37 = [
  { material: "وينستون احمر حرة", qty: 107.6, qtyUnits: 2.152, unit1: "كروز", unit2: "كرتونة", price: 12.8, lineTotal: 1377.28, lineTotalSource: "derived" },
  { material: "وينستون ازرق حرة", qty: 11.4, qtyUnits: 0.228, unit1: "كروز", unit2: "كرتونة", price: 14.2, lineTotal: 161.88, lineTotalSource: "derived" }
];
const base = { name: "زبون", cur: "$", date: "2026-08-31", no: "37", amount: 1539.16, lines: LINES_37 };
const DOCS = [
  ["مرتجع بلا قيد مثبت (ملاحظة محايدة)", { ...base, type: "return" }],
  ["مرتجع بقيد مثبت (خُصمت من رصيد حسابكم)", { ...base, type: "return", prevBalance: 5000, newBalance: 3460.84 }],
  ["فاتورة بيع", { ...base, type: "invoice" }]
];

// قياس بطريقة html2canvas: كلمة = غير فراغ وفراغاتها اللاحقة، ومستطيلها مستطيل نطاقها.
const MEASURE = `(source) => {
  const ctx = document.createElement("canvas").getContext("2d");
  const words = (el) => {
    const out = [];
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walk.nextNode())) {
      ctx.font = getComputedStyle(node.parentElement).font;
      const re = /\\S+\\s*/g;
      let m;
      while ((m = re.exec(node.nodeValue))) {
        const r = document.createRange();
        r.setStart(node, m.index);
        r.setEnd(node, m.index + m[0].length);
        const box = r.getBoundingClientRect();
        // html2canvas يرسم الكلمة بـfillText (اتجاه ltr) من الحافة اليسرى لمستطيلها:
        // حروفها تقع إذن في [x0, x1] مهما كان موضعها الحقيقي.
        out.push({ t: m[0], x0: box.left, x1: box.left + ctx.measureText(m[0].trimEnd()).width, width: box.width, drawn: ctx.measureText(m[0]).width });
      }
    }
    return out;
  };
  const qtyRows = [...source.querySelectorAll(".items-table tbody tr")].map((tr) =>
    [...tr.children[1].querySelectorAll(".qg")].map((g) => g.textContent.replace(/[\\u200e\\u200f]/g, "").replace(/\\s+/g, " ").trim()));
  return { note: words(source.querySelector("p.muted")), foot: words(source.querySelector(".rfoot span")), qtyRows };
}`;

const assertBrand = (words, where) => {
  const i = words.findIndex((w) => w.t.trim() === "OZK");
  const ozk = words[i];
  const tob = words[i + 1];
  const prev = words[i - 1];
  assert.ok(ozk && tob && /^TOBACCO/.test(tob.t) && prev, `${where}: لم أجد «… OZK TOBACCO» (${JSON.stringify(words.map((w) => w.t))})`);
  for (const w of [ozk, tob]) {
    assert.ok(w.width <= w.drawn + 1.5,
      `${where}: مستطيل «${w.t.trim()}» (${w.width.toFixed(1)}px) أعرض من رسمها (${w.drawn.toFixed(1)}px) — html2canvas سيرسمها في غير موضعها`);
  }
  assert.ok(ozk.x1 <= tob.x0 + 0.5,
    `${where}: «TOBACCO» تُرسم من ${tob.x0.toFixed(1)} قبل نهاية «OZK» عند ${ozk.x1.toFixed(1)} — تداخل`);
  // الكلمة العربية السابقة يمين العبارة، وبينهما مسافة مرئية كما في النص.
  assert.ok(prev.x0 - tob.x1 >= 2,
    `${where}: «${prev.t.trim().slice(-6)}» تُرسم ملاصقة لـ«TOBACCO» (فرق ${(prev.x0 - tob.x1).toFixed(1)}px) — ضاعت المسافة`);
};

const browser = await chromium.launch({ args: ["--allow-file-access-from-files"] });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e && e.message ? e.message : e)));
  await page.goto(pathToFileURL(indexPath).href, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => typeof voucherPdfMarkup === "function" && typeof createPortablePdfBlob === "function",
    null, { timeout: 20000 }
  );

  for (const [label, v] of DOCS) {
    const got = await page.evaluate(async ({ v, measureSrc }) => {
      const captured = {};
      const original = window.html2pdf;
      // `set()` يعيد عاملاً جديداً، فالتغليف يتبع السلسلة حتى `from()`.
      const wrap = (worker) => {
        if (!worker || worker.__ozkWrapped) return worker;
        worker.__ozkWrapped = true;
        for (const key of ["set", "from"]) {
          const fn = worker[key];
          if (typeof fn !== "function") continue;
          worker[key] = function (...a) {
            if (key === "from" && a[0] && a[0].querySelector) {
              captured.master = a[0].classList.contains("ozk-inv");
              captured.m = (0, eval)("(" + measureSrc + ")")(a[0]);
            }
            return wrap(fn.apply(this, a));
          };
        }
        return worker;
      };
      window.html2pdf = function patched(...args) { return wrap(original.apply(this, args)); };
      let error = "";
      try { await createPortablePdfBlob(voucherPdfMarkup(v), "اختبار.pdf", { width: 794 }); }
      catch (e) { error = String(e && e.message ? e.message : e); }
      finally { window.html2pdf = original; }
      return { error, ...captured };
    }, { v, measureSrc: MEASURE });

    assert.equal(got.error, "", `${label}: فشل المسار المحمول: ${got.error}`);
    assert.ok(got.master, `${label}: لم يصل إلى القالب الرئيسي`);
    assertBrand(got.m.note, `${label} — الملاحظة`);
    assertBrand(got.m.foot, `${label} — التذييل`);
    assert.deepEqual(got.m.qtyRows, [["107.6 كروز"], ["11.4 كروز"]], `${label}: خانة الكمية ${JSON.stringify(got.m.qtyRows)}`);
    console.log(`  ✅ ${label}: OZK TOBACCO بلا تداخل في الملاحظة والتذييل، والكمية 107.6 كروز / 11.4 كروز`);
  }
  assert.equal(pageErrors.length, 0, `أخطاء في الصفحة: ${pageErrors.join(" | ")}`);
} finally {
  await browser.close();
}

console.log("✓ عزل OZK TOBACCO والكمية الكسرية على مسار PDF الهاتف (Chromium)");
console.log("  ملاحظة منهجية: Chromium لا يُثبت صحّة WebKit — نجاح هذا الفحص ليس شهادة نجاح على آيفون.");
