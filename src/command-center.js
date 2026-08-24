(function () {
  "use strict";

  const ROUTE = "command";
  const REFRESH_MS = 60000;
  let refreshTimer = null;
  let loading = false;
  let ameenLoading = false;
  let ameenStatus = null;
  let snapshot = null;
  let metrics = null;
  let executiveBrief = null;
  let answer = null;
  let lastError = null;
  let lastUpdatedAt = null;
  let lastAmeenAttemptAt = 0;
  const AMEEN_LIVE_MAX_AGE_MINUTES = 15;
  const AMEEN_LIVE_RETRY_COOLDOWN_MS = 5 * 60 * 1000;

  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
  const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
  const money = (value, currency = "USD") => `${Math.round(number(value)).toLocaleString("en-US")} ${currency === "USD" ? "$" : escape(currency || "")}`;
  const liveCache = () => window.ozkAmeenLiveCache || null;
  function liveTime(value) { const date = value ? new Date(value) : null; return date && !Number.isNaN(date.getTime()) ? date.toLocaleTimeString("ar", { hour: "2-digit", minute: "2-digit" }) : "—"; }
  function friendlyAmeenError(error) {
    const message = String(error?.message || error || "").toLowerCase();
    if (/auth|unauthorized|forbidden|session/.test(message)) return "انتهت جلسة الدخول أو لا تملك صلاحية القراءة. سجّل الدخول ثم حاول مجدداً.";
    if (/timed out|expired|timeout/.test(message)) return "استغرقت قراءة الأمين وقتاً أطول من المتوقع. حاول التحديث مرة أخرى.";
    if (/fetch|network|offline/.test(message)) return "تعذر الوصول إلى خدمة القراءة حالياً. تحقق من الاتصال وحاول مجدداً.";
    return "تعذر إكمال القراءة من الأمين حالياً. حاول مجدداً بعد قليل.";
  }

  async function readAmeenLiveResources(client) {
    const resourceNames = ["health", "stock", "customers"];
    const settled = await Promise.allSettled(resourceNames.map((resource) => Promise.resolve().then(() => {
      const read = client?.[resource];
      if (typeof read !== "function") throw new Error(`Ameen Live ${resource} resource غير متاح.`);
      return read.call(client);
    })));
    const values = { health: null, stock: null, customers: null };
    const errors = {};
    let successCount = 0;
    settled.forEach((result, index) => {
      const resource = resourceNames[index];
      if (result.status === "fulfilled") {
        values[resource] = result.value ?? null;
        successCount += 1;
      } else {
        errors[resource] = result.reason;
      }
    });
    const cache = successCount > 0
      ? Object.freeze({ health: values.health, stock: values.stock, customers: values.customers, updatedAt: new Date().toISOString() })
      : null;
    return Object.freeze({ cache, errors: Object.freeze(errors) });
  }

  function levelLabel(level) { return ({ critical: "حرج", high: "مرتفع", watch: "مراقبة", stable: "مستقر", normal: "طبيعي", strong: "قوية", usable: "مقبولة", weak: "ضعيفة", poor: "ضعيفة جداً" }[level] || "غير محدد"); }
  function severityClass(score) { return score >= 70 ? "critical" : score >= 40 ? "high" : score >= 20 ? "watch" : "stable"; }
  function qty(value) { return number(value).toLocaleString("en-US", { maximumFractionDigits: 3 }); }
  function purchaseRecommendationHtml(row) {
    const rec = row.purchaseRecommendation;
    if (!rec) return "";
    const velocity = rec.velocityTrusted ? `${qty(rec.sold30d)} خلال 30 يوماً` : (rec.sold30d === null ? "غير متوفرة" : `${qty(rec.sold30d)} · غير معتمدة للحساب`);
    const coverage = rec.coverageDays === null ? "غير محسوبة" : `${qty(rec.coverageDays)} يوم`;
    const priority = ({ high: "عالية", medium: "متوسطة", review: "مراجعة", normal: "طبيعية" }[rec.priority] || "مراجعة");
    const velocityState = ({ fresh: "حديثة", stale: "قديمة", missing: "مفقودة", missing_as_of: "بلا تاريخ", freshness_unapproved: "غير معتمدة" }[rec.velocityState] || "غير محددة");
    const stockState = rec.stockTrusted ? "حديث وموثوق من Ameen Live" : "غير محدث/غير موثوق";
    const unit1 = rec.unit1Name || "وحدة أولى";
    const numberLine = rec.number ? `<span style="display:block">رقم الصنف: ${escape(rec.number)}</span>` : "";
    const unit2Line = rec.unit2Name || rec.unit2Factor
      ? `<span style="display:block">الوحدة الثانية: ${escape(rec.unit2Name || "غير مسماة")}${rec.unit2Factor ? ` · المعامل ${qty(rec.unit2Factor)}` : ""}</span>`
      : "";
    const proposal = rec.proposal?.eligible
      ? `${qty(rec.proposal.quantity)} ${escape(unit1)}${rec.proposal.basis === "unit2" && rec.unit2Name ? ` (${qty(rec.proposal.quantity / rec.unit2Factor)} ${escape(rec.unit2Name)})` : ""}`
      : `بحاجة مراجعة شراء — ${escape(rec.proposal?.reason || "بحاجة اعتماد قاعدة الشراء")}`;
    return `<li class="command-purchase-item"><strong>${escape(rec.name)}</strong>${numberLine}<span style="display:block">المخزون الحالي: ${qty(rec.stock)} ${escape(unit1)}</span><span style="display:block">حالة المخزون: ${escape(stockState)}</span><span style="display:block">الوحدة الأولى: ${escape(unit1)}</span>${unit2Line}<span style="display:block">حركة المبيعات: ${escape(velocity)}</span><span style="display:block">حالة الحركة: ${escape(velocityState)}</span><span style="display:block">التغطية: ${escape(coverage)}</span><span style="display:block">الأولوية: ${escape(priority)}</span><span style="display:block">السبب: ${escape(rec.reason)}</span><span style="display:block">الكمية المقترحة: ${proposal}</span></li>`;
  }

  function dedupeRecommendations(items) {
    const unique = new Map();
    for (const item of Array.isArray(items) ? items : []) {
      const key = String(item?.itemGuid || item?.key || "").trim().toUpperCase();
      if (key && !unique.has(key)) unique.set(key, item);
    }
    return [...unique.values()];
  }

  function executiveCard(row, index) {
    const agent = executiveBrief?.agents?.[row.agent] || { icon: "🧠", name: "الفريق التنفيذي" };
    return `<article class="command-priority ${severityClass(row.severity)}"><div class="command-priority-rank">${index + 1}</div><div class="command-priority-body"><div class="command-priority-head"><strong>${escape(row.title)}</strong><span class="command-agent">${escape(agent.icon)} ${escape(agent.name)}</span></div><p><strong>ليش؟</strong> ${escape(row.why)}</p><p><strong>الإجراء:</strong> ${escape(row.action)}</p><div class="command-priority-actions"><span class="command-score">ضغط ${Math.round(number(row.severity))}/100</span><button class="button secondary" type="button" data-route="${escape(row.route || "overview")}">فتح القسم</button></div></div></article>`;
  }

  function answerQuestion(question) {
    if (!executiveBrief) return null;
    const items = executiveBrief.executiveOrder || [], q = String(question || "today");
    if (q === "today") return { title: "شو أعمل اليوم؟", body: executiveBrief.headline, items: items.slice(0, 3) };
    if (q === "risk") { const risky = items.filter((x) => x.severity >= 40).slice(0, 3); return { title: "وين أكبر خطر؟", body: risky.length ? `عندك ${risky.length} ملفات ضغط مرتفع تحتاج انتباه.` : "ما في ضغط مرتفع ظاهر حالياً.", items: risky }; }
    if (q === "collections") { const rows = items.filter((x) => x.agent === "collections"); return { title: "مين لازم أراجع للتحصيل؟", body: rows.length ? rows[0].action : "ما في إشارة تحصيل مرتفعة حالياً من البيانات المتاحة.", items: rows.slice(0, 2) }; }
    if (q === "buy") {
      const recommendation = snapshot?.inventory?.purchaseRecommendations;
      const candidates = dedupeRecommendations(recommendation?.items).filter((item) => item.priority !== "normal" || number(item.proposal?.quantity) > 0);
      const rows = candidates.slice(0, 8).map((item) => ({ agent: "inventory", action: item.reason, purchaseRecommendation: item }));
      const source = snapshot?.inventory?.meta?.source === "ameen_live.stock" ? "مخزون Ameen Live الحالي" : "آخر مصدر مخزون متاح";
      const settingsNote = recommendation?.settingsApproved ? "قاعدة كمية الشراء معتمدة." : "كمية الطلب الرقمية معطلة حتى اعتماد إعدادات الشراء.";
      const stockNote = snapshot?.inventory?.stockTrusted ? "المخزون الحالي موثوق وحديث." : "المخزون الحالي غير محدث؛ الكميات الرقمية معطلة.";
      return { title: "شو لازم أشتري؟", body: rows.length ? `الأولوية حسب ${source}. ${settingsNote} ${stockNote}` : `لا تظهر أصناف تحتاج توصية في ${source}. ${stockNote}`, items: rows };
    }
    return { title: "الخلاصة التنفيذية", body: executiveBrief.headline, items: items.slice(0, 3) };
  }

  function quickAnswerHtml() {
    if (!answer) return '<p class="muted">اختر سؤالاً حتى يعطيك الفريق جواباً موحداً من البيانات الحالية.</p>';
    const rows = (answer.items || []).map((row) => { if (row.purchaseRecommendation) return purchaseRecommendationHtml(row); const agent = executiveBrief?.agents?.[row.agent] || { icon: "🧠", name: "الفريق" }; return `<li><strong>${escape(agent.icon)} ${escape(agent.name)}:</strong> ${escape(row.action)}</li>`; }).join("");
    return `<div class="command-answer"><h3>${escape(answer.title)}</h3><p>${escape(answer.body)}</p>${rows ? `<ol>${rows}</ol>` : ""}</div>`;
  }

  function commandPage() {
    if (!state?.session) return shell(`<section class="panel"><h2>مركز القيادة</h2><p class="muted">سجّل الدخول أولاً.</p></section>`);
    if (!window.ozkCanAccessRoute?.(ROUTE)) return shell(`<section class="panel"><h2>غير متاح</h2><p class="muted">مركز القيادة متاح لحساب المالك فقط.</p></section>`);
    if (!snapshot || !metrics || !executiveBrief) return shell(`<section class="panel wide command-center"><h2>🧠 مركز القيادة</h2><p class="muted">${loading ? "جاري تجميع صورة الشركة وتشغيل الفريق التنفيذي…" : escape(lastError || "لم تُحمّل البيانات بعد.")}</p></section>`);
    const updated = lastUpdatedAt ? lastUpdatedAt.toLocaleTimeString("ar", { hour: "2-digit", minute: "2-digit" }) : "—";
    const receivables = number(snapshot.receivables?.total), debtors = number(snapshot.receivables?.debtorCount), collectedToday = snapshot.collections?.todayTotal ?? null, currency = snapshot.collections?.currency || "USD", urgentInventory = number(snapshot.inventory?.urgentReorderCount) + number(snapshot.inventory?.outOfStockCount), suppliers = number(snapshot.supplierObligations?.supplierCount);
    const cachedLive = liveCache(), liveConnected = snapshot.inventory?.meta?.source === "ameen_live.stock";
    const liveText = ameenLoading ? "جاري القراءة من الأمين…" : (liveConnected ? "الأمين مباشر: متصل" : (ameenStatus && !ameenStatus.startsWith("الأمين مباشر: متصل") ? escape(ameenStatus) : (cachedLive ? "انتهت حداثة القراءة الحية؛ اضغط تحديث من الأمين." : "قراءة مباشرة وآمنة من جهاز الأمين")));
    const liveUpdated = liveTime(cachedLive?.updatedAt);
    return shell(`
      <section class="panel wide command-center"><div class="command-hero"><div><span class="command-kicker">OZK BUSINESS OS · EXECUTIVE TEAM</span><h2>🧠 مركز القيادة</h2><p>${escape(executiveBrief.headline)}</p></div><div class="command-health ${escape(metrics.overall.level)}"><small>ضغط العمل</small><strong>${Math.round(number(metrics.overall.riskScore))}/100</strong><span>${levelLabel(metrics.overall.level)}</span></div></div><div class="command-meta"><span>ثقة البيانات: <strong>${Math.round(number(metrics.overall.confidenceScore))}%</strong></span><span>آخر تحديث: <strong>${escape(updated)}</strong></span><span>وضع الفريق: <strong>قراءة وتحليل فقط</strong></span>${lastError ? `<span class="command-warning">${escape(lastError)}</span>` : ""}</div><div class="command-kpis"><article><small>إجمالي الذمم</small><strong dir="ltr">${money(receivables, "USD")}</strong><span>${debtors} زبون مدين</span></article><article><small>تحصيل اليوم</small><strong dir="ltr">${collectedToday === null ? "غير متاح" : money(collectedToday, currency)}</strong><span>من تقرير الحركة اليومي</span></article><article><small>مخزون يحتاج تدخل</small><strong>${urgentInventory}</strong><span>نافد + شراء عاجل</span></article><article><small>موردون عليهم التزامات</small><strong>${suppliers}</strong><span>بدون خلط العملات</span></article></div></section>
      <section class="panel wide"><div class="panel-title-row"><div><h2 style="margin:0">🔌 الأمين مباشر</h2><p class="muted" style="margin:4px 0 0">${liveText}</p><p class="muted" style="margin:4px 0 0">آخر قراءة حية: <strong>${escape(liveUpdated)}</strong> · المواد <strong>${number(snapshot.inventory?.itemCount)}</strong> · النافد <strong>${number(snapshot.inventory?.outOfStockCount)}</strong> · منخفض التغطية <strong>${number(snapshot.inventory?.urgentReorderCount) + number(snapshot.inventory?.lowCoverCount)}</strong></p></div><button class="button" type="button" data-action="ameen-live-refresh" ${ameenLoading ? "disabled" : ""}>${ameenLoading ? "جاري التحديث…" : "تحديث من الأمين"}</button></div></section>
      <section class="panel wide command-questions"><div class="panel-title-row"><div><h2 style="margin:0">💬 اسأل فريقك التنفيذي</h2><p class="muted" style="margin:4px 0 0">أسئلة سريعة مبنية على بياناتك الحالية، بدون تخمين.</p></div><button class="button secondary" type="button" data-action="command-refresh">تحديث البيانات</button></div><div class="command-question-buttons"><button class="button secondary" data-question="today">شو أعمل اليوم؟</button><button class="button secondary" data-question="risk">وين أكبر خطر؟</button><button class="button secondary" data-question="collections">مين لازم أراجع للتحصيل؟</button><button class="button secondary" data-question="buy">شو لازم أشتري؟</button></div><div class="command-answer-wrap">${quickAnswerHtml()}</div></section>
      <section class="panel wide command-priorities"><div class="panel-title-row"><div><h2 style="margin:0">👥 رأي الفريق الموحّد</h2><p class="muted" style="margin:4px 0 0">الأقسام لا ترمي عليك تقارير منفصلة. المدير يجمعها ويرتبها هنا.</p></div></div><div class="command-priority-list">${executiveBrief.executiveOrder.map(executiveCard).join("") || '<p class="muted">الوضع مستقر ولا توجد أولوية مرتفعة حالياً.</p>'}</div></section>
      <section class="panel wide command-team"><h2>🧩 الفريق الحالي</h2><div class="command-team-grid">${Object.values(executiveBrief.agents).map((agent) => `<article><strong>${escape(agent.icon)} ${escape(agent.name)}</strong><span>${agent.id === "ceo" ? "يجمع الأولويات ويعطيك الخلاصة" : agent.id === "controller" ? "يراقب جودة وحداثة البيانات" : "يحلل نطاقه ويرفع توصية للمدير"}</span></article>`).join("")}</div></section>
      <section class="panel wide command-data-quality"><h2>🩺 صحة البيانات</h2><div class="command-quality-grid"><span>مصادر قديمة <strong>${number(snapshot.syncHealth?.staleCount)}</strong></span><span>مصادر ناقصة <strong>${number(snapshot.syncHealth?.missingCount)}</strong></span><span>الحالة <strong>${snapshot.dataQuality?.degraded ? "تحتاج انتباه" : "جيدة"}</strong></div></section>`);
  }

  async function refreshCommandCenter() {
    if (loading || state?.route !== ROUTE || !state?.session) return;
    loading = true; lastError = null;
    try { snapshot = await window.ozkBusinessOS?.getSnapshot?.(); if (!snapshot) throw new Error("Business Snapshot غير متاح."); metrics = await window.ozkBusinessMetrics?.getMetrics?.(snapshot); if (!metrics) throw new Error("Metrics Engine غير متاح."); executiveBrief = window.ozkExecutiveTeam?.buildBrief?.(snapshot, metrics) || null; if (!executiveBrief) throw new Error("Executive Team غير متاح."); answer = answerQuestion("today"); lastUpdatedAt = new Date(); }
    catch (error) { lastError = String(error?.message || error || "تعذر تحديث مركز القيادة."); console.error("[OZK Command Center]", error); }
    finally { loading = false; if (state?.route === ROUTE) render(); }
  }

  async function refreshFromAmeen() {
    if (ameenLoading || !state?.session) return;
    ameenLoading = true; ameenStatus = null; render();
    try {
      const { cache, errors } = await readAmeenLiveResources(window.ozkAmeenLive);
      window.ozkAmeenLiveCache = cache;
      const { health, stock, customers } = cache || {};
      const stockCount = number(stock?.rowCount ?? stock?.rows?.length), customerCount = number(customers?.rowCount ?? customers?.rows?.length);
      Object.entries(errors).forEach(([resource, error]) => console.warn(`[OZK Ameen Live ${resource}]`, error));
      if (stock) {
        const details = [`الأمين مباشر: متصل · مخزون ${stockCount} مادة`];
        details.push(customers ? `زبائن ${customerCount}` : "الزبائن غير متاحة");
        if (!health) details.push("فحص الحالة غير متاح");
        ameenStatus = details.join(" · ");
      } else {
        ameenStatus = friendlyAmeenError(errors.stock || new Error("Ameen Live stock resource غير متاح."));
      }
      await refreshCommandCenter();
    } catch (error) { window.ozkAmeenLiveCache = null; ameenStatus = friendlyAmeenError(error); console.error("[OZK Ameen Live]", error); }
    finally { ameenLoading = false; if (state?.route === ROUTE) render(); }
  }

  // ملاحظة حرجة: cache.updatedAt يتجدد إذا نجح أي مورد واحد فقط (health/stock/customers)، وليس
  // بالضرورة stock تحديداً. لذا لا يكفي فحص عمر updatedAt وحده لاعتبار stock طازجة — يجب أن يكون
  // cache.stock نفسها موجودة، وإلا فشل جزئي لـstock (مع نجاح health/customers) يُعتبر خطأً "طازجاً"
  // لغاية 15 دقيقة بدل أن يخضع لفترة تهدئة الخمس دقائق الفعلية أدناه.
  function ameenLiveFresh() {
    const cache = liveCache();
    if (!cache?.updatedAt || !cache.stock) return false;
    const updated = new Date(cache.updatedAt);
    if (Number.isNaN(updated.getTime())) return false;
    return (Date.now() - updated.getTime()) <= AMEEN_LIVE_MAX_AGE_MINUTES * 60 * 1000;
  }

  // تحديث تلقائي واحد فقط عند غياب/انتهاء صلاحية مخزون الأمين الحي — بلا استقصاء كل 60 ثانية.
  // يُستدعى مع كل Render لصفحة مركز القيادة؛ الحراسات الثلاث (ameenLoading، حداثة stock تحديداً،
  // وفترة التهدئة) تضمن ألا يخرج أكثر من طلب شبكة تلقائي واحد فعلي كل خمس دقائق كحد أقصى عند فشل
  // stock (كلياً أو جزئياً مع نجاح health/customers)، ودون تعطيل زر "تحديث من الأمين".
  function ensureFreshAmeenLiveStock() {
    if (ameenLoading || !state?.session || !window.ozkCanAccessRoute?.(ROUTE)) return;
    if (ameenLiveFresh()) return;
    const now = Date.now();
    if (now - lastAmeenAttemptAt < AMEEN_LIVE_RETRY_COOLDOWN_MS) return;
    lastAmeenAttemptAt = now;
    refreshFromAmeen();
  }

  function addCommandNav() { if (!window.ozkCanAccessRoute?.(ROUTE)) { document.querySelectorAll('[data-route="command"]').forEach((node) => node.remove()); return; } if (document.querySelector('[data-route="command"]')) return; const nav = document.querySelector("aside .sidebar nav, aside nav, .sidebar nav"); if (!nav) return; const template = nav.querySelector("[data-route]"); const button = document.createElement(template?.tagName === "A" ? "a" : "button"); button.className = template?.className || "nav-link"; button.textContent = "🧠 مركز القيادة"; button.dataset.route = ROUTE; if (button.tagName === "A") button.href = "?route=command"; button.addEventListener("click", (event) => { event.preventDefault(); setRoute(ROUTE); }); nav.insertBefore(button, nav.firstChild); }
  function bindCommandEvents() { app.querySelectorAll("[data-route]").forEach((button) => button.addEventListener("click", (event) => { event.preventDefault(); setRoute(button.dataset.route); })); app.querySelector("[data-action='command-refresh']")?.addEventListener("click", refreshCommandCenter); app.querySelector("[data-action='ameen-live-refresh']")?.addEventListener("click", refreshFromAmeen); app.querySelectorAll("[data-question]").forEach((button) => button.addEventListener("click", () => { answer = answerQuestion(button.dataset.question); render(); })); }
  function syncTimer() { if (refreshTimer) clearInterval(refreshTimer); refreshTimer = state?.route === ROUTE && state?.session && window.ozkCanAccessRoute?.(ROUTE) ? setInterval(refreshCommandCenter, REFRESH_MS) : null; }

  try { allowedRoutes.add(ROUTE); if (new URLSearchParams(window.location.search).get("route") === ROUTE && window.ozkCanAccessRoute?.(ROUTE)) state.route = ROUTE; const baseRender = render; render = function commandAwareRender() { if (state.route === ROUTE && window.ozkCanAccessRoute?.(ROUTE)) { app.innerHTML = commandPage(); bindCommandEvents(); addCommandNav(); syncTimer(); ensureFreshAmeenLiveStock(); return; } baseRender(); addCommandNav(); syncTimer(); }; window.ozkCommandCenter = Object.freeze({ answerQuestion, dedupeRecommendations, refresh: refreshCommandCenter, refreshFromAmeen, ensureFreshAmeenLiveStock }); render(); if (state?.route === ROUTE && window.ozkCanAccessRoute?.(ROUTE)) setTimeout(refreshCommandCenter, 0); }
  catch (error) { console.error("[OZK Command Center Init]", error); }
})();
