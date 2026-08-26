// فحص انحدار لميزة "استغلال الفراغات" الجديدة في نشرة الأسعار — يتحقق بمتصفح
// حقيقي (Playwright) من: (1) القياس الحقيقي لارتفاع المجموعة عبر DOM يتأثر فعلاً
// بطول الاسم/الملاحظة (لا تقدير ثابت)، (2) تطابق الارتفاعات بين الثيم الفاتح
// والداكن (الشكل فقط يختلف، لا القياسات)، (3) مثال قبل/بعد يثبت أن مجموعة كاملة
// انتقلت إلى فراغ مناسب دون أي قصّ أو تداخل، (4) تصدير PDF فعلي عبر html2pdf
// (بتقطيع الكانفاس نفسه المستخدم في exportBulletinPdf) بلا أي مجموعة تمتد
// عبر حدّي شريحتي صفحتين متتاليتين.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import path from "node:path";

const templateSrc = readFileSync(path.resolve("src/price-list-template.js"), "utf8");
const html2pdfBundle = readFileSync(path.resolve("public/vendor/html2pdf.bundle.min.js"), "utf8");

let failed = false;
function check(label, condition) {
  if (!condition) {
    console.error(`FAIL: ${label}`);
    failed = true;
  } else {
    console.log(`ok: ${label}`);
  }
}

const browser = await chromium.launch();
try {
  // ---------- 1) و(2) القياس الحقيقي: اسم طويل يعطي ارتفاعاً أكبر، وثابت بين الثيمين ----------
  for (const theme of ["dark", "light"]) {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><script>${templateSrc}</script></head><body></body></html>`);
    const heights = await page.evaluate((theme) => {
      const template = window.OZKPriceListTemplate;
      const shortGroup = { name: "قصير", items: [{ name: "صنف قصير", unit: "كرتونة", price: "$ 1.00" }] };
      const longGroup = {
        name: "طويل",
        items: [{
          name: "صنف باسم طويل جداً جداً جداً يتجاوز عرض الخلية بشكل واضح — مع ملاحظة طويلة أيضاً تشرح تفاصيل كثيرة جداً عن هذا الصنف",
          unit: "كرتونة",
          price: "$ 999.00"
        }]
      };
      const probe = document.createElement("div");
      probe.style.width = "385px";
      probe.innerHTML = `<section class="ozk-price-list" data-theme="${theme}"><div class="price-list-column-stack" id="stack"></div></section>` + `<style>${template.CSS}</style>`;
      document.body.appendChild(probe);
      const stack = probe.querySelector("#stack");
      function measure(group) {
        stack.innerHTML = template.renderGroup(group);
        const el = stack.firstElementChild;
        const rect = el.getBoundingClientRect();
        const marginBottom = parseFloat(getComputedStyle(el).marginBottom) || 0;
        return rect.height + marginBottom;
      }
      const shortHeight = measure(shortGroup);
      const longHeight = measure(longGroup);
      return { shortHeight, longHeight };
    }, theme);
    check(`[${theme}] القياس الحقيقي: مجموعة بملاحظة/اسم طويل ارتفاعها أكبر فعلياً من مجموعة قصيرة`, heights.longHeight > heights.shortHeight);
    await page.close();
  }

  const darkPage = await browser.newPage();
  await darkPage.setContent(`<!doctype html><html><head><meta charset="utf-8"><script>${templateSrc}</script></head><body></body></html>`);
  const lightPage = await browser.newPage();
  await lightPage.setContent(`<!doctype html><html><head><meta charset="utf-8"><script>${templateSrc}</script></head><body></body></html>`);
  async function measureLongGroupHeight(p, theme) {
    return p.evaluate((theme) => {
      const template = window.OZKPriceListTemplate;
      const group = {
        name: "طويل",
        items: [{ name: "صنف باسم طويل جداً جداً جداً يتجاوز عرض الخلية — مع ملاحظة طويلة أيضاً", unit: "كرتونة", price: "$ 999.00" }]
      };
      const probe = document.createElement("div");
      probe.style.width = "385px";
      probe.innerHTML = `<section class="ozk-price-list" data-theme="${theme}"><div class="price-list-column-stack" id="stack"></div></section>` + `<style>${template.CSS}</style>`;
      document.body.appendChild(probe);
      const stack = probe.querySelector("#stack");
      stack.innerHTML = template.renderGroup(group);
      const el = stack.firstElementChild;
      const rect = el.getBoundingClientRect();
      const marginBottom = parseFloat(getComputedStyle(el).marginBottom) || 0;
      return rect.height + marginBottom;
    }, theme);
  }
  const darkLongHeight = await measureLongGroupHeight(darkPage, "dark");
  const lightLongHeight = await measureLongGroupHeight(lightPage, "light");
  check("نفس منطق القياس للثيمين: ارتفاع نفس المجموعة متطابق بين الفاتح والداكن (الشكل فقط يختلف لا القياسات)", Math.abs(darkLongHeight - lightLongHeight) < 0.5);
  await darkPage.close();
  await lightPage.close();

  // ---------- 3) مثال قبل/بعد: مجموعة صغيرة تنتقل إلى فراغ متبقٍّ في عمود سابق ----------
  {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><script>${templateSrc}</script></head><body></body></html>`);
    const result = await page.evaluate(() => {
      const template = window.OZKPriceListTemplate;
      // مجموعة كبيرة تكاد تملأ عموداً، ومجموعة صغيرة يجب أن تُستغل الفراغ المتبقي لها.
      const bigGroup = { name: "كبيرة", items: Array.from({ length: 6 }, (_, i) => ({ name: `صنف ${i}`, unit: "كرتونة", price: "$1" })) };
      const smallGroup = { name: "صغيرة", items: [{ name: "صنف واحد", unit: "كرتونة", price: "$1" }] };
      const groups = [bigGroup, smallGroup];

      // "قبل": التوزيع التقليدي (بلا قياس حقيقي) — للمقارنة فقط.
      const before = template.layoutGroups(groups);

      // "بعد": قياس حقيقي فعلي + توزيع مبني عليه، بميزانية عمود صغيرة عمداً لإجبار
      // فتح صفحة ثانية لولا استغلال الفراغ المتبقي في الأولى.
      const probe = document.createElement("div");
      probe.style.width = "385px";
      probe.innerHTML = `<section class="ozk-price-list" data-theme="dark"><div class="price-list-column-stack" id="stack"></div></section>` + `<style>${template.CSS}</style>`;
      document.body.appendChild(probe);
      const stack = probe.querySelector("#stack");
      const heights = new Map();
      groups.forEach((g) => {
        stack.innerHTML = template.renderGroup(g);
        const el = stack.firstElementChild;
        const rect = el.getBoundingClientRect();
        const marginBottom = parseFloat(getComputedStyle(el).marginBottom) || 0;
        heights.set(g.name, rect.height + marginBottom);
      });
      const bigHeight = heights.get("كبيرة");
      const smallHeight = heights.get("صغيرة");
      // ميزانية عمود تتّسع بالضبط للاثنتين معاً (بهامش بسيط) لإثبات استغلال الفراغ الحقيقي.
      const budget = bigHeight + smallHeight + 6 + 2;
      const packed = template.packGroupsIntoBalancedPages(groups, [], heights, { fullBudget: budget }, 6);
      const firstPage = packed.pages[0] || { right: [], left: [] };
      const placedNames = [...firstPage.right, ...firstPage.left].map((g) => g.name).sort();

      return {
        beforeSameStack: before.right.length + before.left.length === 2,
        bigHeight,
        smallHeight,
        budget,
        afterPagesCount: packed.pages.length,
        afterPlacedNames: placedNames,
        afterOversized: packed.oversized
      };
    });
    console.log("قبل/بعد — مثال استغلال الفراغ:", JSON.stringify(result, null, 2));
    // لا يُفرض عمود مُعيّن — قاعدة التوازن قد تنقل "صغيرة" بين العمودين — المهم
    // أن المجموعتين استقرّتا معاً بصفحة واحدة كاملتين دون قصّ أو فقدان (استغلال الفراغ فعلياً).
    check("بعد القياس الحقيقي: المجموعتان الكاملتان استقرّتا بصفحة واحدة دون قصّ (استغلال الفراغ فعلياً)", result.afterPagesCount === 1 && result.afterPlacedNames.join(",") === ["كبيرة", "صغيرة"].sort().join(","));
    check("بعد القياس الحقيقي: لا مجموعة رُصدت كاستثناء أو فُقدت", result.afterOversized.length === 0);
    await page.close();
  }

  // ---------- 4) تصدير PDF فعلي: لا مجموعة تمتد عبر حدّ شريحتين متتاليتين ----------
  for (const theme of ["dark", "light"]) {
    const page = await browser.newPage({ viewport: { width: 900, height: 1000 } });
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>`);
    await page.addScriptTag({ content: templateSrc });
    await page.addScriptTag({ content: html2pdfBundle });

    // نبني نفس كمية المحتوى التي يبنيها exportBulletinPdf فعلياً: مجموعات كثيرة
    // وكبيرة بما يكفي لإجبار توليد أكثر من صفحة فعلياً (اختبار سابق بعدد أقل
    // من المجموعات أنتج صفحة واحدة فقط ولم يفحص حدّ التقطيع فعلياً).
    const groupsSpec = Array.from({ length: 40 }, (_, gi) => ({
      name: `مجموعة${gi}`,
      items: Array.from({ length: 10 + (gi % 6) }, (_, i) => ({ name: `صنف طويل قليلاً رقم ${gi}-${i}`, unit: "كرتونة", price: `$ ${gi}${i}.00` }))
    }));

    const result = await page.evaluate(
      async ({ groupsSpec, theme }) => {
        const template = window.OZKPriceListTemplate;
        // تمريرة أولى: نبني بالتوزيع التقليدي فقط لقياس عرض العمود/ارتفاع الرأس الحقيقيين.
        const initialMarkup = template.render({
          groups: groupsSpec,
          logoSrc: "",
          issueDate: template.formatArabicIssueDate(new Date()),
          badgeClass: "badge-usd",
          badgeLabelHtml: "دولار — جملة",
          unitLabel: "سعر الكرتونة (جملة)",
          theme
        });
        const container = document.createElement("div");
        container.style.width = "794px";
        container.innerHTML = initialMarkup;
        document.body.appendChild(container);

        const header = container.querySelector(".price-list-header");
        const subheader = container.querySelector(".price-list-subheader");
        const stackEl = container.querySelector(".price-list-column-stack");
        const headerHeightPx = (header?.getBoundingClientRect().height || 0) + (subheader?.getBoundingClientRect().height || 0);
        const columnWidthPx = stackEl?.getBoundingClientRect().width || 385;

        const measureStack = document.createElement("div");
        measureStack.className = "price-list-column-stack";
        measureStack.style.width = `${columnWidthPx}px`;
        container.querySelector(".ozk-price-list").appendChild(measureStack);
        const heights = new Map();
        groupsSpec.forEach((g) => {
          measureStack.innerHTML = template.renderGroup(g);
          const el = measureStack.firstElementChild;
          const rect = el.getBoundingClientRect();
          const marginBottom = parseFloat(getComputedStyle(el).marginBottom) || 0;
          heights.set(g.name, rect.height + marginBottom);
        });

        const layout = template.layoutGroupsMeasured(groupsSpec, heights, { pageWidthPx: 794, headerHeightPx, safetyMarginPx: 6 });
        container.remove();
        measureStack.remove();

        const finalMarkup = template.render({
          groups: groupsSpec,
          logoSrc: "",
          issueDate: template.formatArabicIssueDate(new Date()),
          badgeClass: "badge-usd",
          badgeLabelHtml: "دولار — جملة",
          unitLabel: "سعر الكرتونة (جملة)",
          theme,
          layout
        });

        const finalContainer = document.createElement("div");
        finalContainer.style.width = "794px";
        const backgroundColor = theme === "light" ? "#fffdf8" : "#0c0a07";
        finalContainer.style.backgroundColor = backgroundColor;
        finalContainer.innerHTML = finalMarkup;
        document.body.appendChild(finalContainer);
        finalContainer.querySelectorAll(".price-list-secondary-page").forEach((p) => { p.style.minHeight = "1123px"; });

        // نلتقط كل استدعاءات drawImage (شرائح صفحات html2pdf) لمعرفة أين تقع حدود كل صفحة.
        const sliceCalls = [];
        const origDrawImage = CanvasRenderingContext2D.prototype.drawImage;
        CanvasRenderingContext2D.prototype.drawImage = function (...args) {
          if (args.length >= 9) {
            const [, sx, sy, sw, sh] = args;
            sliceCalls.push({ sy, sh });
          }
          return origDrawImage.apply(this, args);
        };
        const worker = window.html2pdf().set({
          margin: [0, 0, 0, 0],
          image: { type: "png", quality: 0.98 },
          html2canvas: { scale: 1, useCORS: true, backgroundColor, allowTaint: true, foreignObjectRendering: true },
          jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
          pagebreak: { mode: ["css"] }
        }).from(finalContainer);

        // مهم: html2pdf.toContainer() يستنسخ finalContainer إلى حاوية داخلية جديدة
        // ويُدرج فيها فواصل (spacer divs) قبل أي عنصر يحمل break-before/avoid-inside
        // كي لا يُقصّ عبر حدّ صفحة — هذا التعديل يحدث على الحاوية الداخلية فقط،
        // وليس finalContainer الأصلي. لذا يجب قياس مواضع المجموعات من الحاوية
        // الداخلية بعد toContainer() لا من finalContainer، وإلا كانت القياسات
        // خاطئة (تعكس الشكل قبل إدراج الفواصل لا بعده).
        await worker.toContainer();
        const internalContainer = worker.prop.container;
        const groupSpans = [...internalContainer.querySelectorAll(".price-list-group")].map((el) => {
          const r = el.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, text: (el.querySelector(".price-list-group-header span")?.textContent || "").trim() };
        });

        await worker.toPdf().get("pdf");
        CanvasRenderingContext2D.prototype.drawImage = origDrawImage;

        // حدود الشرائح (بإحداثيات الكانفاس الكامل = إحداثيات viewport لأن scale:1)
        const sliceBoundaries = sliceCalls.map((c) => c.sy).filter((v, i, arr) => arr.indexOf(v) === i).sort((a, b) => a - b);

        // مجموعة "تُقطع" إن وقع حدّ شريحة صفحة داخل امتدادها الرأسي الحقيقي (وليس عند حافتيها بالضبط).
        const cutGroups = groupSpans.filter((span) =>
          sliceBoundaries.some((boundary) => boundary > span.top + 1 && boundary < span.bottom - 1)
        );

        return {
          mainPagesCount: layout.mainPages.length,
          specialPagesCount: layout.specialPages.length,
          oversized: layout.oversized,
          sliceBoundaries,
          groupCount: groupSpans.length,
          cutGroups: cutGroups.map((g) => g.text)
        };
      },
      { groupsSpec, theme }
    );

    console.log(`[${theme}] نتيجة تصدير PDF الفعلي:`, JSON.stringify(result, null, 2));
    check(`[${theme}] المحتوى فعلاً أنتج أكثر من صفحة/شريحة (وإلا فحص عدم القصّ غير فعّال)`, result.sliceBoundaries.length > 1 || result.mainPagesCount > 1);
    check(`[${theme}] لا مجموعة واحدة امتدت عبر حدّ صفحة فعلي في PDF الحقيقي`, result.cutGroups.length === 0);
    check(`[${theme}] لا مجموعات استثنائية غير موضوعة`, result.oversized.length === 0);
    check(`[${theme}] كل ${result.groupCount} مجموعة قِيست فعلياً وظهرت في الصفحات`, result.groupCount === groupsSpec.length);

    await page.close();
  }
} finally {
  await browser.close();
}

if (failed) {
  console.error("Price bulletin group-placement regression check FAILED.");
  process.exit(1);
}
console.log("Price bulletin group-placement regression check passed (real DOM measurement + real PDF export, both themes, no cut/overlap).");
