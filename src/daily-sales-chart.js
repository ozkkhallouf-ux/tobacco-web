// ============================================================================
// daily-sales-chart.js — «حركة المبيعات اليومية» في صفحة التقارير.
//
// المصدر: تقرير `ameen_daily_profit` في `inventory_reports` — صف واحد لكل تاريخ
// (فهرس فريد جزئي)، يكتبه `tools/push-daily-profit.ps1` قراءةً من الأمين على
// نفس عالم فواتير «ملخص الحركة اليومية» (bu000 بـBillType 1 مبيع و3 مرتجع).
// القيمة المرسومة هي `net_sales` كما يحسبها السكربت نفسه:
//   المبيعات − الحسومات + الإضافات − (المرتجعات − حسمها + إضافتها)
// وكل قيم bu000 بعملة الأساس في الأمين (الدولار) حتى لفاتورة بالليرة، فلا
// تحويل عملة هنا ولا إعادة حساب. سندات القبض والدفعات والمصاريف خارج net_sales.
//
// الحالات لكل يوم (لا تُخلط):
//   value   — يوم له تقرير: قيمة صافي المبيعات (قد تكون صفراً = لا مبيعات).
//   missing — يوم مضى بلا أي تقرير: «لا تتوفر بيانات»، ليس صفراً.
//   future  — يوم لم يأتِ بعد بتوقيت دمشق: فارغ.
//
// ملف مستقل بلا اعتماد على app.js: الحساب (buildMonth/monthStats) نقي وقابل
// للفحص في Node، والرسم SVG يدوي بلا مكتبة خارجية.
// ============================================================================
(function (root) {
  "use strict";

  const TIME_ZONE = "Asia/Damascus";
  const MONTHS = ["كانون الثاني", "شباط", "آذار", "نيسان", "أيار", "حزيران", "تموز", "آب", "أيلول", "تشرين الأول", "تشرين الثاني", "كانون الأول"];
  const WEEKDAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
  const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
  const MONTH_KEY = /^(\d{4})-(\d{2})$/;

  const pad2 = (n) => String(n).padStart(2, "0");
  let activeObserver = null;

  // «اليوم» بتوقيت دمشق بصيغة YYYY-MM-DD، مستقلاً عن منطقة جهاز المستخدم.
  function damascusToday(now) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(now instanceof Date ? now : new Date());
    const get = (type) => parts.find((p) => p.type === type)?.value || "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  }

  function monthKeyOf(isoDate) {
    const m = ISO_DATE.exec(String(isoDate || ""));
    return m ? `${m[1]}-${m[2]}` : "";
  }

  function parseMonthKey(key) {
    const m = MONTH_KEY.exec(String(key || ""));
    if (!m) return null;
    const year = Number(m[1]);
    const month = Number(m[2]);
    if (month < 1 || month > 12) return null;
    return { year, month };
  }

  // عدد أيام الشهر الفعلي (28/29/30/31) — اليوم 0 من الشهر التالي.
  function daysInMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
  }

  function shiftMonth(key, delta) {
    const p = parseMonthKey(key);
    if (!p) return "";
    const index = p.year * 12 + (p.month - 1) + Number(delta || 0);
    return `${Math.floor(index / 12)}-${pad2((index % 12) + 1)}`;
  }

  function monthRange(key) {
    const p = parseMonthKey(key);
    if (!p) return null;
    return { from: `${key}-01`, to: `${key}-${pad2(daysInMonth(p.year, p.month))}` };
  }

  function monthLabel(key) {
    const p = parseMonthKey(key);
    return p ? `${MONTHS[p.month - 1]} ${p.year}` : "";
  }

  function weekdayOf(isoDate) {
    const m = ISO_DATE.exec(String(isoDate || ""));
    if (!m) return "";
    return WEEKDAYS[new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay()];
  }

  function finiteNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  // صفوف المصدر ← خريطة تاريخ → صف. المصدر فريد بالتاريخ أصلاً؛ ولو وصل صفّان
  // لنفس اليوم (نسخة محلية أو تغيّر مستقبلي) يُعتمد الأحدث مزامنةً ولا يُجمعان
  // أبداً، كي لا يُحتسب يوم مرتين.
  function indexRows(rows) {
    const byDate = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const date = String(row?.report_date || "").slice(0, 10);
      if (!ISO_DATE.test(date)) continue;
      const prev = byDate.get(date);
      if (!prev || String(row?.synced_at || "") > String(prev?.synced_at || "")) byDate.set(date, row);
    }
    return byDate;
  }

  function buildMonth(rows, key, today) {
    const p = parseMonthKey(key);
    if (!p) return { key: "", days: [] };
    const byDate = indexRows(rows);
    const todayIso = ISO_DATE.test(String(today || "")) ? today : damascusToday();
    const total = daysInMonth(p.year, p.month);
    const days = [];
    for (let d = 1; d <= total; d += 1) {
      const date = `${key}-${pad2(d)}`;
      if (date > todayIso) { days.push({ day: d, date, state: "future", value: null }); continue; }
      const row = byDate.get(date);
      const value = row ? finiteNumber(row.net_sales) : null;
      if (value === null) { days.push({ day: d, date, state: "missing", value: null }); continue; }
      days.push({
        day: d,
        date,
        state: "value",
        // القيمة كما وردت بلا تقريب: التقريب عند العرض وحده، كي يطابق إجمالي
        // الشهر مجموع المصدر حرفياً ولا تتراكم فروق السنتات.
        value,
        salesBills: finiteNumber(row.sales_bill_count),
        returnBills: finiteNumber(row.return_bill_count),
        syncedAt: row.synced_at ? String(row.synced_at) : "",
        isToday: date === todayIso
      });
    }
    return { key, days };
  }

  // المؤشرات: الإجمالي ومتوسط الأيام المنقضية ذات البيانات وأعلى/أدنى يوم.
  // الأيام بلا بيانات لا تدخل المقام: «صفر» لم يُقَس لا يساوي «لا مبيعات».
  // عند التعادل يُعتمد أول يوم في الشهر.
  // minPositive («أدنى مبيع فعلي»): أقل صافي مبيع **موجب** بين أيام البيانات —
  // أيام الصفر (عطلة/إغلاق) والسالبة وبلا بيانات والمستقبل خارجه؛ null إن لم يوجد.
  // `min` باقٍ كما هو (أدنى قيمة مطلقاً) ولا يدخل في minPositive.
  function lowestPositiveDay(known) {
    let best = null;
    for (const d of known) {
      if (d.value > 0 && (!best || d.value < best.value)) best = d;
    }
    return best ? { value: best.value, date: best.date } : null;
  }

  function monthStats(month) {
    const known = (month?.days || []).filter((d) => d.state === "value");
    const missing = (month?.days || []).filter((d) => d.state === "missing").length;
    if (!known.length) return { total: 0, average: null, max: null, min: null, minPositive: null, knownDays: 0, missingDays: missing };
    const sum = known.reduce((acc, d) => acc + d.value, 0);
    let max = known[0];
    let min = known[0];
    for (const d of known) {
      if (d.value > max.value) max = d;
      if (d.value < min.value) min = d;
    }
    return {
      total: Math.round(sum * 100) / 100,
      average: Math.round((sum / known.length) * 100) / 100,
      max: { value: max.value, date: max.date },
      min: { value: min.value, date: min.date },
      minPositive: lowestPositiveDay(known),
      knownDays: known.length,
      missingDays: missing
    };
  }

  function formatUsd(value, digits) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    const places = digits === undefined ? 2 : digits;
    const body = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: places, maximumFractionDigits: places });
    return `${n < 0 ? "-" : ""}$${body}`;
  }

  // تسمية محور مختصرة: $0 · $500 · $12K · $1.2M
  function formatAxisUsd(value) {
    const n = Number(value) || 0;
    const abs = Math.abs(n);
    const sign = n < 0 ? "-" : "";
    const trim = (x) => String(Math.round(x * 10) / 10);
    if (abs >= 1e6) return `${sign}$${trim(abs / 1e6)}M`;
    if (abs >= 1e3) return `${sign}$${trim(abs / 1e3)}K`;
    return `${sign}$${Math.round(abs)}`;
  }

  function formatDay(isoDate) {
    const m = ISO_DATE.exec(String(isoDate || ""));
    if (!m) return "";
    return `${weekdayOf(isoDate)} ${Number(m[3])}/${Number(m[2])}/${m[1]}`;
  }

  function formatSyncTime(value) {
    const date = new Date(value);
    if (!value || Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  }

  // تدريج «لطيف» للمحور العمودي يشمل الصفر دائماً.
  function niceScale(minValue, maxValue, ticks) {
    let lo = Math.min(0, minValue);
    let hi = Math.max(0, maxValue);
    if (hi === lo) hi = lo + 100;
    const rough = (hi - lo) / Math.max(1, ticks);
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((s) => s >= rough) || 10 * mag;
    lo = Math.floor(lo / step) * step;
    hi = Math.ceil(hi / step) * step;
    const values = [];
    for (let v = lo; v <= hi + step / 2; v += step) values.push(Math.round(v * 1e6) / 1e6);
    return { lo, hi, values };
  }

  function escapeXml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // يبني SVG بعرض الحاوية الفعلي بالبكسل (لا تمطيط للنص على الموبايل).
  function layout(month, width) {
    const w = Math.max(280, Math.round(width || 0));
    const narrow = w < 520;
    const h = narrow ? 190 : 220;
    const pad = { top: 14, right: 12, bottom: 26, left: narrow ? 44 : 54 };
    const days = month.days;
    const known = days.filter((d) => d.state === "value");
    const scale = niceScale(
      known.length ? Math.min(...known.map((d) => d.value)) : 0,
      known.length ? Math.max(...known.map((d) => d.value)) : 0,
      narrow ? 3 : 4
    );
    const plotW = w - pad.left - pad.right;
    const plotH = h - pad.top - pad.bottom;
    const n = Math.max(1, days.length);
    const x = (day) => pad.left + (n === 1 ? plotW / 2 : ((day - 1) / (n - 1)) * plotW);
    const y = (v) => pad.top + plotH - ((v - scale.lo) / (scale.hi - scale.lo)) * plotH;
    return { w, h, pad, narrow, scale, plotW, plotH, x, y, n };
  }

  function renderSvg(month, width) {
    const days = month?.days || [];
    if (!days.length) return "";
    const L = layout(month, width);
    const { w, h, pad, scale, x, y } = L;
    const zeroY = y(0);

    const grid = scale.values.map((v) => {
      const gy = y(v).toFixed(1);
      return `<line class="dsc-grid${v === 0 ? " dsc-zero" : ""}" x1="${pad.left}" x2="${w - pad.right}" y1="${gy}" y2="${gy}"/>`
        + `<text class="dsc-ylab" x="${pad.left - 6}" y="${gy}" dy="0.32em" text-anchor="end">${escapeXml(formatAxisUsd(v))}</text>`;
    }).join("");

    const step = L.narrow ? 5 : (w < 860 ? 3 : 2);
    const xLabels = days.filter((d) => d.day === 1 || d.day === days.length || (d.day % step === 0 && days.length - d.day >= Math.ceil(step / 2)))
      .map((d) => `<text class="dsc-xlab" x="${x(d.day).toFixed(1)}" y="${h - 8}" text-anchor="middle">${d.day}</text>`).join("");

    // المقاطع المتصلة: يوم بلا بيانات أو يوم مستقبلي يقطع الخط ولا يُرسم صفراً.
    const segments = [];
    let current = [];
    for (const d of days) {
      if (d.state === "value") current.push(d);
      else if (current.length) { segments.push(current); current = []; }
    }
    if (current.length) segments.push(current);

    const pt = (d) => `${x(d.day).toFixed(1)},${y(d.value).toFixed(1)}`;
    const areas = segments.map((seg) => {
      const first = x(seg[0].day).toFixed(1);
      const last = x(seg[seg.length - 1].day).toFixed(1);
      return `<path class="dsc-area" d="M${first},${zeroY.toFixed(1)} L${seg.map(pt).join(" L")} L${last},${zeroY.toFixed(1)} Z"/>`;
    }).join("");
    const lines = segments.map((seg) => `<path class="dsc-line" d="M${seg.map(pt).join(" L")}"/>`).join("");
    const dots = days.map((d) => {
      if (d.state === "value") {
        return `<circle class="dsc-dot${d.isToday ? " dsc-today" : ""}" cx="${x(d.day).toFixed(1)}" cy="${y(d.value).toFixed(1)}" r="${d.isToday ? 3.6 : 2.6}"/>`;
      }
      if (d.state === "missing") {
        return `<circle class="dsc-missing" cx="${x(d.day).toFixed(1)}" cy="${zeroY.toFixed(1)}" r="3"/>`;
      }
      return "";
    }).join("");

    return `<svg class="dsc-svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${escapeXml(`حركة المبيعات اليومية — ${monthLabel(month.key)}`)}" focusable="false">
      <defs><linearGradient id="dscFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="currentColor" stop-opacity="0.26"/><stop offset="100%" stop-color="currentColor" stop-opacity="0.02"/></linearGradient></defs>
      ${grid}${xLabels}${areas}${lines}${dots}
      <line class="dsc-guide" x1="0" x2="0" y1="${pad.top}" y2="${h - pad.bottom}" visibility="hidden"/>
      <circle class="dsc-focus" r="5" cx="0" cy="0" visibility="hidden"/>
    </svg>`;
  }

  function tooltipHtml(d) {
    if (!d) return "";
    const head = `<div class="dsc-tip-date">${escapeXml(formatDay(d.date))}</div>`;
    if (d.state === "missing") return `${head}<div class="dsc-tip-na">لا تتوفر بيانات لهذا اليوم</div>`;
    if (d.state === "future") return `${head}<div class="dsc-tip-na">يوم قادم</div>`;
    const bills = [];
    if (d.salesBills !== null && d.salesBills !== undefined) bills.push(`${d.salesBills} فاتورة`);
    if (d.returnBills) bills.push(`${d.returnBills} مرتجع`);
    const sync = d.isToday && d.syncedAt ? ` · حتى ${formatSyncTime(d.syncedAt)}` : "";
    return `${head}<div class="dsc-tip-val">${escapeXml(formatUsd(d.value))}</div>`
      + (bills.length || sync ? `<div class="dsc-tip-sub">${escapeXml(bills.join(" · "))}${escapeXml(sync)}</div>` : "");
  }

  // يرسم داخل الحاوية ويربط التفاعل. يُستدعى بعد كل render للصفحة؛ يعيد
  // الرسم عند تغيّر العرض فقط. التمرير/اللمس لا يعيد رسم الصفحة.
  function mount(host, month) {
    if (!host || !month?.days?.length) return;
    const canvas = host.querySelector("[data-dsc-canvas]");
    const tip = host.querySelector("[data-dsc-tip]");
    if (!canvas || !tip) return;
    let L = null;
    let active = -1;

    const draw = () => {
      const width = canvas.clientWidth || host.clientWidth || 600;
      canvas.innerHTML = renderSvg(month, width);
      L = layout(month, width);
      active = -1;
      tip.hidden = true;
    };

    const show = (index) => {
      const svg = canvas.querySelector("svg");
      if (!svg || !L) return;
      const d = month.days[index];
      if (!d) return;
      active = index;
      const cx = L.x(d.day);
      const cy = d.state === "value" ? L.y(d.value) : L.y(0);
      const guide = svg.querySelector(".dsc-guide");
      const focus = svg.querySelector(".dsc-focus");
      guide.setAttribute("x1", cx); guide.setAttribute("x2", cx); guide.setAttribute("visibility", "visible");
      focus.setAttribute("cx", cx); focus.setAttribute("cy", cy);
      focus.setAttribute("visibility", d.state === "future" ? "hidden" : "visible");
      focus.setAttribute("class", `dsc-focus${d.state === "missing" ? " is-missing" : ""}`);
      tip.innerHTML = tooltipHtml(d);
      tip.hidden = false;
      const tipW = tip.offsetWidth || 150;
      const left = Math.min(Math.max(4, cx - tipW / 2), L.w - tipW - 4);
      tip.style.left = `${left}px`;
      tip.style.top = `${Math.max(0, cy - (tip.offsetHeight || 60) - 12)}px`;
    };

    const hide = () => {
      active = -1;
      tip.hidden = true;
      const svg = canvas.querySelector("svg");
      svg?.querySelector(".dsc-guide")?.setAttribute("visibility", "hidden");
      svg?.querySelector(".dsc-focus")?.setAttribute("visibility", "hidden");
    };

    const indexAt = (clientX) => {
      const svg = canvas.querySelector("svg");
      if (!svg || !L) return -1;
      const rect = svg.getBoundingClientRect();
      const px = clientX - rect.left;
      const ratio = (px - L.pad.left) / Math.max(1, L.plotW);
      const i = Math.round(ratio * (L.n - 1));
      return Math.min(L.n - 1, Math.max(0, i));
    };

    canvas.addEventListener("pointermove", (e) => { const i = indexAt(e.clientX); if (i >= 0 && i !== active) show(i); });
    canvas.addEventListener("pointerdown", (e) => { const i = indexAt(e.clientX); if (i >= 0) show(i); });
    canvas.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") hide(); });
    canvas.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Escape") return;
      e.preventDefault();
      if (e.key === "Escape") { hide(); return; }
      const lastKnown = month.days.reduce((acc, d, i) => (d.state !== "future" ? i : acc), 0);
      const next = active < 0 ? lastKnown : active + (e.key === "ArrowRight" ? 1 : -1);
      show(Math.min(month.days.length - 1, Math.max(0, next)));
    });
    canvas.addEventListener("blur", hide);

    draw();
    // مراقب واحد فقط: كل render للصفحة يبني حاوية جديدة، فيُفصل مراقب الحاوية السابقة.
    if (activeObserver) { activeObserver.disconnect(); activeObserver = null; }
    if (typeof ResizeObserver === "function") {
      let lastWidth = canvas.clientWidth;
      activeObserver = new ResizeObserver(() => {
        if (Math.abs(canvas.clientWidth - lastWidth) < 2) return;
        lastWidth = canvas.clientWidth;
        draw();
      });
      activeObserver.observe(canvas);
    }
  }

  const api = {
    TIME_ZONE,
    damascusToday,
    monthKeyOf,
    daysInMonth,
    shiftMonth,
    monthRange,
    monthLabel,
    buildMonth,
    monthStats,
    formatUsd,
    formatAxisUsd,
    formatDay,
    niceScale,
    renderSvg,
    tooltipHtml,
    mount
  };
  root.ozkDailySalesChart = api;
})(typeof window !== "undefined" ? window : globalThis);
