(function () {
  const store = window.tobaccoData;
  const OUTBOX_KEY = "ozk-smart-inventory-outbox-v1";
  const DRAFT_KEY = "ozk-smart-inventory-drafts-v1";
  const DEVICE_KEY = "ozk-inventory-device-id";
  const state = {
    loadedForRole: "",
    loading: false,
    warehouses: [],
    dashboard: [],
    session: null,
    ownerReport: null,
    accounts: [],
    query: "",
    filter: "all",
    busyItemId: "",
    accountBusy: false,
    lastError: "",
    localNotice: ""
  };
  let callbacks = { render() {}, notice() {} };
  let autoRefreshTimer = null;

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }
  function jsonRead(key, fallback) { try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); } catch { return fallback; } }
  function jsonWrite(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }
  function uuid() { return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
  function isOwner(session) { return session?.accessRole === "owner"; }
  function fmtDate(value) { if (!value) return "—"; try { return new Intl.DateTimeFormat("ar-LB", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Beirut" }).format(new Date(value)); } catch { return String(value); } }
  function fmtNum(value) { const number = Number(value); return Number.isFinite(number) ? number.toLocaleString("en-US", { maximumFractionDigits: 3 }) : "—"; }
  function normalizeSearch(value) { return String(value || "").normalize("NFKC").toLowerCase().replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/\s+/g, " ").trim(); }
  function deviceId() {
    let value = "";
    try { value = localStorage.getItem(DEVICE_KEY) || ""; } catch {}
    if (!value) { value = uuid(); try { localStorage.setItem(DEVICE_KEY, value); } catch {} }
    return value;
  }
  function onlineLabel() { return navigator.onLine ? '<span class="smart-online">● متصل</span>' : '<span class="smart-offline">● دون اتصال — المسودة محفوظة على الجهاز</span>'; }
  function statusLabel(status) { return ({ not_started: "لم يبدأ", in_progress: "قيد الجرد", completed: "مكتمل", late: "متأخر" })[status] || status || "لم يبدأ"; }
  function itemStatusLabel(status) { return ({ uncounted: "غير معدود", counted: "معدود", zero: "صفر فعلي", not_found: "غير موجود في موقعه", damaged: "تالف" })[status] || status; }
  function classificationLabel(value) { return ({ matched: "مطابق", shortage: "نقص", increase: "زيادة", uncounted: "غير معدود", unknown: "غير معروف" })[value] || value; }

  function drafts() { return jsonRead(DRAFT_KEY, {}); }
  function saveDraft(itemId, patch) {
    const all = drafts();
    all[itemId] = { ...(all[itemId] || {}), ...patch, updatedAt: new Date().toISOString() };
    jsonWrite(DRAFT_KEY, all);
  }
  function clearDraft(itemId) { const all = drafts(); delete all[itemId]; jsonWrite(DRAFT_KEY, all); }
  function outbox() { return jsonRead(OUTBOX_KEY, []); }
  function queueOutbox(entry) {
    const all = outbox().filter((row) => row.itemId !== entry.itemId);
    all.push(entry); jsonWrite(OUTBOX_KEY, all);
  }
  function removeOutbox(requestId) { jsonWrite(OUTBOX_KEY, outbox().filter((row) => row.requestId !== requestId)); }

  async function load(session, force = false) {
    if (!session) return;
    const role = session.accessRole;
    if (state.loading || (!force && state.loadedForRole === role)) return;
    state.loading = true; state.lastError = ""; callbacks.render();
    try {
      if (isOwner(session)) {
        const [dashboard, accounts] = await Promise.all([
          store.getSmartInventoryOwnerDashboard(),
          store.listInventoryCounterAccounts().catch(() => ({ accounts: [] }))
        ]);
        state.dashboard = Array.isArray(dashboard) ? dashboard : [];
        state.accounts = Array.isArray(accounts?.accounts) ? accounts.accounts : [];
      } else {
        const warehouses = await store.listSmartInventoryWarehouses();
        state.warehouses = Array.isArray(warehouses) ? warehouses : [];
      }
      state.loadedForRole = role;
      await flushOutbox(session);
    } catch (error) { state.lastError = error.message || String(error); }
    finally { state.loading = false; callbacks.render(); }
  }

  async function refreshCurrent(session) {
    if (!state.session?.id) return load(session, true);
    try {
      state.session = await store.getSmartInventoryCounterSession(state.session.id);
      if (isOwner(session) && state.ownerReport) state.ownerReport = await store.getSmartInventoryOwnerReport(state.session.id);
      callbacks.render();
    } catch (error) { callbacks.notice("error", error.message); }
  }

  async function startOrJoin(warehouseKey, session) {
    state.loading = true; callbacks.render();
    try {
      state.session = await store.startOrJoinSmartInventory(warehouseKey);
      state.ownerReport = isOwner(session) ? await store.getSmartInventoryOwnerReport(state.session.id) : null;
      state.query = "";
      callbacks.notice("success", `تم فتح جرد ${state.session.warehouseName}. الجلسة اليومية مشتركة بين موظفي الجرد.`);
    } catch (error) { callbacks.notice("error", error.message); }
    finally { state.loading = false; callbacks.render(); }
  }

  async function openSession(sessionId, session) {
    state.loading = true; callbacks.render();
    try {
      state.session = await store.getSmartInventoryCounterSession(sessionId);
      state.ownerReport = isOwner(session) ? await store.getSmartInventoryOwnerReport(sessionId) : null;
    } catch (error) { callbacks.notice("error", error.message); }
    finally { state.loading = false; callbacks.render(); }
  }

  function warehouseCards(rows, session) {
    if (!rows.length) return '<section class="panel wide"><p class="muted">لا توجد تقارير مستودعات أمين متاحة بعد.</p></section>';
    return `<section class="smart-warehouse-grid">${rows.map((row) => {
      const status = row.status || "not_started";
      const progress = row.totalItems ? Math.round(Number(row.countedItems || 0) / Number(row.totalItems) * 100) : 0;
      const people = (row.contributors || []).map((p) => typeof p === "string" ? p : p.displayName).filter(Boolean).join("، ");
      return `<article class="panel smart-warehouse-card status-${esc(status)}">
        <div class="panel-title-row"><h3>${esc(row.warehouseName)}</h3><span class="smart-status">${esc(statusLabel(status))}</span></div>
        <p><strong>${fmtNum(row.countedItems || 0)}</strong> من <strong>${fmtNum(row.totalItems || 0)}</strong> صنف</p>
        <div class="smart-progress"><span style="width:${progress}%"></span></div>
        ${people ? `<p class="muted">المشاركون: ${esc(people)}</p>` : ""}
        ${row.completedAt ? `<p class="muted">الإغلاق: ${esc(fmtDate(row.completedAt))}</p>` : ""}
        <button class="button primary" type="button" data-smart-warehouse="${esc(row.warehouseKey)}" data-smart-session="${esc(row.sessionId || "")}">${row.sessionId ? "فتح الجرد" : "بدء الجرد"}</button>
      </article>`;
    }).join("")}</section>`;
  }

  function counterRow(item) {
    const allDrafts = drafts();
    const draft = allDrafts[item.id] || {};
    const saved = item.countState !== "uncounted" && !item.recountRequested;
    const claimed = item.claimedByDisplayName && new Date(item.claimExpiresAt || 0) > new Date();
    const lockedByOther = claimed && !item.claimedByMe;
    const unit1 = draft.unit1Qty ?? (item.unit1Qty ?? "");
    const unit2 = draft.unit2Qty ?? (item.unit2Qty ?? "");
    const damaged = draft.damagedUnit1Qty ?? (item.damagedUnit1Qty ?? "");
    const countState = draft.countState || (item.recountRequested ? "counted" : item.countState);
    const disabled = saved || lockedByOther || state.session?.status === "completed";
    let lockText = "";
    if (saved) lockText = `تم جرد هذا الصنف بواسطة ${esc(item.countedByDisplayName || "موظف")}${item.countedAt ? ` — ${esc(fmtDate(item.countedAt))}` : ""}`;
    else if (lockedByOther) lockText = `يقوم ${esc(item.claimedByDisplayName)} بجرده الآن`;
    else if (item.recountRequested) lockText = "إعادة عد مطلوبة من موظف آخر — الكمية المتوقعة مخفية";
    return `<article class="panel smart-item ${saved ? "is-counted" : ""}" data-smart-item-card="${esc(item.id)}">
      <div class="smart-item-head"><div><small>${esc(item.itemCode || item.itemKey)}</small><h3>${esc(item.itemName)}</h3></div><span class="smart-line-state">${esc(itemStatusLabel(item.countState))}</span></div>
      <div class="smart-count-grid">
        <label>${esc(item.unit1Name || "الوحدة الأولى")}<input type="number" min="0" step="0.001" inputmode="decimal" data-smart-qty="unit1Qty" data-item-id="${esc(item.id)}" value="${esc(unit1)}" ${disabled ? "disabled" : ""}></label>
        ${item.unit2Name && Number(item.unit2Factor) > 1 ? `<label>${esc(item.unit2Name)} <small>× ${fmtNum(item.unit2Factor)}</small><input type="number" min="0" step="0.001" inputmode="decimal" data-smart-qty="unit2Qty" data-item-id="${esc(item.id)}" value="${esc(unit2)}" ${disabled ? "disabled" : ""}></label>` : ""}
        <label>الحالة<select data-smart-state data-item-id="${esc(item.id)}" ${disabled ? "disabled" : ""}>
          <option value="counted" ${countState === "counted" ? "selected" : ""}>معدود</option>
          <option value="zero" ${countState === "zero" ? "selected" : ""}>صفر فعلي</option>
          <option value="not_found" ${countState === "not_found" ? "selected" : ""}>غير موجود في موقعه</option>
          <option value="damaged" ${countState === "damaged" ? "selected" : ""}>تالف</option>
        </select></label>
        <label class="smart-damaged">تالف (${esc(item.unit1Name || "الوحدة الأولى")})<input type="number" min="0" step="0.001" inputmode="decimal" data-smart-qty="damagedUnit1Qty" data-item-id="${esc(item.id)}" value="${esc(damaged)}" ${disabled ? "disabled" : ""}></label>
      </div>
      <div class="button-row"><button class="button primary" type="button" data-smart-save="${esc(item.id)}" ${disabled || state.busyItemId === item.id ? "disabled" : ""}>${state.busyItemId === item.id ? "جاري الحفظ…" : "حفظ الصنف"}</button></div>
      ${lockText ? `<p class="smart-lock-note">${lockText}</p>` : '<p class="muted">الخانة الفارغة ليست صفراً. اختر «صفر فعلي» عند التأكد.</p>'}
    </article>`;
  }

  function counterSession(session) {
    const items = Array.isArray(state.session?.items) ? state.session.items : [];
    const q = normalizeSearch(state.query);
    const filtered = items.filter((item) => {
      if (state.filter === "uncounted" && item.countState !== "uncounted") return false;
      if (state.filter === "counted" && item.countState === "uncounted") return false;
      return !q || normalizeSearch(`${item.itemName} ${item.itemCode || ""} ${item.itemKey || ""}`).includes(q);
    });
    const counted = items.filter((item) => item.countState !== "uncounted").length;
    const progress = items.length ? Math.round(counted / items.length * 100) : 0;
    return `<section class="panel wide smart-session-head">
      <div><button class="button secondary" data-smart-back type="button">← المستودعات</button><h2>${esc(state.session.warehouseName)}</h2>
      <p class="muted">وقت القطع المرجعي: ${esc(fmtDate(state.session.cutoffAt))} · ${onlineLabel()}</p></div>
      <div class="smart-session-progress"><strong dir="ltr">${counted} / ${items.length}</strong><div class="smart-progress"><span style="width:${progress}%"></span></div></div>
    </section>
    <section class="panel wide smart-toolbar"><input data-smart-search placeholder="ابحث بالاسم أو الكود" value="${esc(state.query)}" autocomplete="off"><div class="button-row">
      <button class="button ${state.filter === "all" ? "primary" : "secondary"}" data-smart-filter="all">الكل</button>
      <button class="button ${state.filter === "uncounted" ? "primary" : "secondary"}" data-smart-filter="uncounted">غير المعدود</button>
      <button class="button ${state.filter === "counted" ? "primary" : "secondary"}" data-smart-filter="counted">المعدود</button>
      <button class="button secondary" data-smart-refresh>تحديث</button>
    </div></section>
    <section class="smart-items-grid">${filtered.map(counterRow).join("") || '<article class="panel"><p class="muted">لا توجد نتائج.</p></article>'}</section>
    <section class="panel wide smart-finalize"><p>بعد حفظ كل الأصناف اضغط الإغلاق النهائي. بعد الإغلاق لا يستطيع الموظف تعديل الجرد.</p>
      <button class="button success" data-smart-complete ${state.session.status === "completed" ? "disabled" : ""}>${state.session.status === "completed" ? "الجرد مكتمل" : "حفظ الجرد وإغلاقه"}</button></section>`;
  }

  function ownerReport() {
    const report = state.ownerReport;
    if (!report) return "";
    const lines = Array.isArray(report.lines) ? report.lines : [];
    const summary = lines.reduce((acc, line) => { acc[line.classification] = (acc[line.classification] || 0) + 1; return acc; }, {});
    return `<section class="panel wide"><div class="panel-title-row"><div><button class="button secondary" data-smart-owner-back>← لوحة اليوم</button><h2>${esc(report.warehouseName)}</h2><p class="muted">Snapshot: ${esc(fmtDate(report.cutoffAt))} · أي حركة بعد القطع ظاهرة بشكل مستقل</p></div>
      <div class="button-row"><button class="button secondary" data-smart-print-book>طباعة دفتر أعمى</button><button class="button secondary" data-smart-export-xlsx>Excel</button><button class="button secondary" data-smart-export-pdf>PDF</button>${report.status === "completed" ? '<button class="button warning" data-smart-reopen>إعادة فتح</button>' : ""}</div></div>
      <div class="smart-summary"><span>مطابق <strong>${summary.matched || 0}</strong></span><span>نقص <strong>${summary.shortage || 0}</strong></span><span>زيادة <strong>${summary.increase || 0}</strong></span><span>غير معدود <strong>${summary.uncounted || 0}</strong></span></div>
      <div class="table-wrap"><table class="smart-owner-table"><thead><tr><th>الكود</th><th>الصنف</th><th>وحدة</th><th>الأمين عند القطع</th><th>حركة بعد القطع</th><th>المتوقع المعدّل</th><th>العد</th><th>الفرق</th><th>الحالة</th><th>الجارد</th><th></th></tr></thead><tbody>
      ${lines.map((line) => `<tr class="class-${esc(line.classification)}"><td>${esc(line.itemCode || "")}</td><td>${esc(line.itemName)}</td><td>${esc(line.unit1Name)}</td><td>${fmtNum(line.expectedQtyUnit1)}</td><td>${fmtNum(line.movementQtyUnit1)}</td><td>${fmtNum(line.adjustedExpectedQtyUnit1)}</td><td>${fmtNum(line.latestQtyUnit1)}</td><td>${fmtNum(line.differenceQtyUnit1)}</td><td>${esc(classificationLabel(line.classification))}</td><td>${esc(line.latestCountedBy || "—")}<small>${esc(fmtDate(line.latestCountedAt))}</small></td><td><div class="button-row">${line.classification !== "matched" && line.classification !== "uncounted" ? `<button class="button secondary compact-button" data-smart-recount="${esc(line.itemId)}">إعادة عد</button>` : ""}${line.classification !== "uncounted" ? `<button class="button secondary compact-button" data-smart-correct="${esc(line.itemId)}">تصحيح</button>` : ""}</div></td></tr>`).join("")}
      </tbody></table></div></section>`;
  }

  function ownerAccounts() {
    return `<section class="panel wide"><div class="panel-title-row"><div><h2>حسابات موظفي الجرد</h2><p class="muted">المالك فقط ينشئ الحساب. لا بريد حقيقي ولا Google ولا OTP.</p></div></div>
      <form class="smart-account-form" data-smart-account-create><label>اسم الموظف<input name="displayName" required maxlength="80"></label><label>اسم المستخدم<input name="username" required maxlength="48" autocomplete="off"></label><label>كلمة المرور<input name="password" type="password" minlength="8" maxlength="128" autocomplete="new-password" required></label><button class="button primary" ${state.accountBusy ? "disabled" : ""}>إنشاء حساب</button></form>
      <div class="smart-account-list">${state.accounts.map((account) => `<article><div><strong>${esc(account.display_name)}</strong><small>@${esc(account.username_display)} · ${account.enabled ? "فعال" : "معطل"}${account.locked_until ? ` · مقفل حتى ${esc(fmtDate(account.locked_until))}` : ""}</small></div><div class="button-row"><button class="button secondary compact-button" data-smart-account-reset="${esc(account.user_id)}">تغيير كلمة المرور</button><button class="button ${account.enabled ? "warning" : "success"} compact-button" data-smart-account-toggle="${esc(account.user_id)}" data-enabled="${account.enabled}">${account.enabled ? "تعطيل" : "تفعيل"}</button></div></article>`).join("") || '<p class="muted">لا توجد حسابات جرد بعد.</p>'}</div></section>`;
  }

  function render(session) {
    state.currentDisplayName = session?.name || "";
    if (state.loading && !state.loadedForRole) return '<section class="panel wide"><h2>جاري تجهيز الجرد الذكي…</h2></section>';
    if (state.lastError) return `<section class="notice-panel error"><span>${esc(state.lastError)}</span><button class="button primary" data-smart-retry>إعادة المحاولة</button></section>`;
    if (state.session) return isOwner(session) ? ownerReport() : counterSession(session);
    if (isOwner(session)) return `<section class="panel wide"><div class="panel-title-row"><div><h2>متابعة الجرد اليومية</h2><p class="muted">توقيت اليوم Asia/Beirut. تظهر المستودعات التي لم تبدأ أيضاً.</p></div><span>${onlineLabel()}</span></div></section>${warehouseCards(state.dashboard, session)}${ownerAccounts()}`;
    return `<section class="panel wide"><div class="panel-title-row"><div><h2>اختر المستودع</h2><p class="muted">يمكنك بدء أو متابعة أي مستودع. لا تظهر كمية الأمين أو الفروقات في حسابك.</p></div><span>${onlineLabel()}</span></div></section>${warehouseCards(state.warehouses, session)}`;
  }

  function readRow(itemId, root) {
    const card = root.querySelector(`[data-smart-item-card="${CSS.escape(itemId)}"]`);
    const get = (name) => card?.querySelector(`[data-smart-qty="${name}"]`)?.value ?? "";
    const countState = card?.querySelector("[data-smart-state]")?.value || "counted";
    const unit1Raw = get("unit1Qty"), unit2Raw = get("unit2Qty"), damagedRaw = get("damagedUnit1Qty");
    if (countState === "counted" && unit1Raw === "" && unit2Raw === "") throw new Error("أدخل كمية فعلية أو اختر «صفر فعلي». الخانة الفارغة ليست صفراً.");
    const unit1Qty = Number(unit1Raw || 0), unit2Qty = Number(unit2Raw || 0), damagedUnit1Qty = Number(damagedRaw || 0);
    if (![unit1Qty, unit2Qty, damagedUnit1Qty].every((n) => Number.isFinite(n) && n >= 0)) throw new Error("الكميات يجب أن تكون أرقاماً موجبة أو صفراً.");
    if (["zero", "not_found"].includes(countState) && (unit1Qty !== 0 || unit2Qty !== 0)) throw new Error("حالة الصفر أو غير الموجود يجب أن تكون كميتها صفراً.");
    return { countState, unit1Qty, unit2Qty, damagedUnit1Qty };
  }

  async function saveItem(itemId, root, session, queued = null) {
    const item = state.session.items.find((row) => row.id === itemId);
    if (!item) return;
    let input;
    try { input = queued || readRow(itemId, root); } catch (error) { callbacks.notice("error", error.message); return; }
    const entry = { itemId, requestId: queued?.requestId || uuid(), expectedVersion: item.rowVersion, ...input };
    state.busyItemId = itemId; callbacks.render();
    try {
      const result = await store.saveSmartInventoryItem(entry);
      if (!result?.ok) {
        if (result.code === "already_counted") throw new Error(`تم جرد هذا الصنف بواسطة ${result.countedByDisplayName || "موظف آخر"} — ${fmtDate(result.countedAt)}`);
        if (result.code === "claimed") throw new Error(`يقوم ${result.claimedByDisplayName || "موظف آخر"} بجرده الآن.`);
        if (result.code === "version_conflict") throw new Error("تغيّر الصنف على جهاز آخر. تم تحديث الصفحة دون الكتابة فوقه.");
        if (result.code === "recount_requires_other_counter") throw new Error("إعادة العد يجب أن ينفذها موظف آخر.");
        throw new Error("لم يتم حفظ الصنف.");
      }
      removeOutbox(entry.requestId); clearDraft(itemId);
      state.session = await store.getSmartInventoryCounterSession(state.session.id);
      callbacks.notice("success", "حُفظ الصنف وربط باسم الموظف ووقت العد.");
    } catch (error) {
      if (!navigator.onLine || /network|fetch|الاتصال/i.test(error.message)) {
        queueOutbox(entry); callbacks.notice("warning", "انقطع الاتصال. احتفظ الجهاز بالعملية وسيعيد إرسالها دون تكرار عند عودة الإنترنت.");
      } else {
        callbacks.notice("error", error.message);
        state.session = await store.getSmartInventoryCounterSession(state.session.id).catch(() => state.session);
      }
    } finally { state.busyItemId = ""; callbacks.render(); }
  }

  async function flushOutbox(session) {
    if (!navigator.onLine || !session || session.accessRole !== "inventory_counter") return;
    for (const entry of outbox()) {
      try {
        const result = await store.saveSmartInventoryItem(entry);
        if (result?.ok || ["already_counted", "version_conflict", "session_closed"].includes(result?.code)) removeOutbox(entry.requestId);
      } catch { break; }
    }
  }

  function exportOwnerXlsx() {
    const rows = (state.ownerReport?.lines || []).map((line) => ({
      "كود الصنف": line.itemCode || "", "اسم الصنف": line.itemName, "الوحدة الأولى": line.unit1Name,
      "كمية الأمين عند القطع": line.expectedQtyUnit1, "حركات بعد القطع": line.movementQtyUnit1,
      "المتوقع المعدل": line.adjustedExpectedQtyUnit1, "الكمية المعدودة": line.latestQtyUnit1,
      "الفرق": line.differenceQtyUnit1, "الحالة": classificationLabel(line.classification),
      "من قام بالجرد": line.latestCountedBy || "", "وقت العد": line.latestCountedAt || ""
    }));
    if (!window.XLSX) return callbacks.notice("error", "مكتبة Excel غير محملة.");
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "الجرد");
    XLSX.writeFile(wb, `smart-inventory-${state.ownerReport.warehouseName}-${state.ownerReport.inventoryDate}.xlsx`);
  }

  function exportOwnerPdf(root) {
    if (!window.html2pdf) return callbacks.notice("error", "مكتبة PDF غير محملة.");
    const source = root.querySelector(".smart-owner-table")?.closest(".panel")?.cloneNode(true);
    if (!source) return;
    source.querySelectorAll("button").forEach((button) => button.remove());
    window.html2pdf().set({ filename: `smart-inventory-${state.ownerReport.warehouseName}.pdf`, margin: 8,
      image: { type: "jpeg", quality: 0.96 }, html2canvas: { scale: 2 }, jsPDF: { unit: "mm", format: "a4", orientation: "landscape" } }).from(source).save();
  }

  function printBlindBook() {
    const lines = state.session?.items || [];
    const pageSize = 25; const pages = [];
    for (let i = 0; i < lines.length; i += pageSize) pages.push(lines.slice(i, i + pageSize));
    const popup = window.open("", "_blank", "noopener,noreferrer");
    if (!popup) return callbacks.notice("error", "اسمح بفتح نافذة الطباعة أولاً.");
    popup.document.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>دفتر جرد أعمى</title><style>@page{size:A4;margin:10mm}body{font-family:Arial;color:#111}.page{page-break-after:always}table{width:100%;border-collapse:collapse}th,td{border:1px solid #333;padding:6px}h1,p{text-align:center}.count{height:26px;width:110px}</style></head><body>${pages.map((page,index)=>`<section class="page"><h1>دفتر جرد — ${esc(state.session.warehouseName)}</h1><p>صفحة ${index+1} من ${pages.length} · الكمية النظامية مخفية</p><table><thead><tr><th>الكود</th><th>الصنف</th><th>الوحدة</th><th>الكمية الفعلية</th></tr></thead><tbody>${page.map(line=>`<tr><td>${esc(line.itemCode||line.itemKey)}</td><td>${esc(line.itemName)}</td><td>${esc(line.unit1Name)}</td><td class="count"></td></tr>`).join("")}</tbody></table></section>`).join("")}</body></html>`);
    popup.document.close(); popup.focus(); popup.print();
  }

  function bind(root, session, api) {
    callbacks = api || callbacks;
    root.querySelector("[data-smart-retry]")?.addEventListener("click", () => { state.loadedForRole = ""; load(session, true); });
    root.querySelectorAll("[data-smart-warehouse]").forEach((button) => button.addEventListener("click", () => button.dataset.smartSession ? openSession(button.dataset.smartSession, session) : startOrJoin(button.dataset.smartWarehouse, session)));
    root.querySelector("[data-smart-back]")?.addEventListener("click", () => { state.session = null; state.ownerReport = null; state.loadedForRole = ""; load(session, true); });
    root.querySelector("[data-smart-owner-back]")?.addEventListener("click", () => { state.session = null; state.ownerReport = null; state.loadedForRole = ""; load(session, true); });
    root.querySelector("[data-smart-search]")?.addEventListener("input", (event) => { state.query = event.currentTarget.value; callbacks.render(); });
    root.querySelectorAll("[data-smart-filter]").forEach((button) => button.addEventListener("click", () => { state.filter = button.dataset.smartFilter; callbacks.render(); }));
    root.querySelector("[data-smart-refresh]")?.addEventListener("click", () => refreshCurrent(session));
    root.querySelectorAll("[data-smart-qty],[data-smart-state]").forEach((input) => {
      const claim = () => store.claimSmartInventoryItem(input.dataset.itemId).then((result) => {
        if (!result?.ok && result?.code === "claimed") callbacks.notice("warning", `يقوم ${result.claimedByDisplayName} بجرده الآن.`);
        if (!result?.ok && result?.code === "already_counted") refreshCurrent(session);
      }).catch(() => {});
      input.addEventListener("focus", claim, { once: true });
      input.addEventListener("input", () => {
        const card = input.closest("[data-smart-item-card]");
        const itemId = input.dataset.itemId;
        const patch = {};
        card.querySelectorAll("[data-smart-qty]").forEach((field) => { patch[field.dataset.smartQty] = field.value; });
        patch.countState = card.querySelector("[data-smart-state]")?.value || "counted";
        saveDraft(itemId, patch);
      });
    });
    root.querySelectorAll("[data-smart-save]").forEach((button) => button.addEventListener("click", () => saveItem(button.dataset.smartSave, root, session)));
    root.querySelector("[data-smart-complete]")?.addEventListener("click", async () => {
      try { const result = await store.completeSmartInventorySession(state.session.id); if (!result.ok) throw new Error(`بقي ${result.remaining} صنفاً غير معدود أو بانتظار إعادة عد.`); callbacks.notice("success", "تم إغلاق الجرد. لا يمكن للموظفين تعديله الآن."); await refreshCurrent(session); }
      catch (error) { callbacks.notice("error", error.message); }
    });
    root.querySelectorAll("[data-smart-recount]").forEach((button) => button.addEventListener("click", async () => {
      const reason = prompt("سبب إعادة العد (إلزامي):"); if (!reason) return;
      try { await store.openSmartInventoryRecount(button.dataset.smartRecount, reason); state.ownerReport = await store.getSmartInventoryOwnerReport(state.session.id); callbacks.notice("success", "فُتحت إعادة عد عمياء لموظف آخر."); callbacks.render(); } catch (error) { callbacks.notice("error", error.message); }
    }));
    root.querySelectorAll("[data-smart-correct]").forEach((button) => button.addEventListener("click", async () => {
      const quantity = prompt("الكمية الصحيحة بالوحدة الأولى:"); if (quantity === null) return;
      const reason = prompt("سبب التصحيح (إلزامي):"); if (!reason) return;
      try { await store.correctSmartInventoryItem(button.dataset.smartCorrect, Number(quantity), reason); state.ownerReport = await store.getSmartInventoryOwnerReport(state.session.id); callbacks.notice("success", "حُفظ التصحيح كمحاولة جديدة وبقي العد الأصلي في السجل."); callbacks.render(); } catch (error) { callbacks.notice("error", error.message); }
    }));
    root.querySelector("[data-smart-reopen]")?.addEventListener("click", async () => {
      const reason = prompt("سبب إعادة فتح الجرد (إلزامي):"); if (!reason) return;
      try { await store.reopenSmartInventorySession(state.session.id, reason); await openSession(state.session.id, session); callbacks.notice("success", "أعيد فتح الجلسة وسُجل السبب."); } catch (error) { callbacks.notice("error", error.message); }
    });
    root.querySelector("[data-smart-export-xlsx]")?.addEventListener("click", exportOwnerXlsx);
    root.querySelector("[data-smart-export-pdf]")?.addEventListener("click", () => exportOwnerPdf(root));
    root.querySelector("[data-smart-print-book]")?.addEventListener("click", printBlindBook);
    root.querySelector("[data-smart-account-create]")?.addEventListener("submit", async (event) => {
      event.preventDefault(); const form = new FormData(event.currentTarget); state.accountBusy = true; callbacks.render();
      try { await store.createInventoryCounterAccount({ displayName: form.get("displayName"), username: form.get("username"), password: form.get("password") }); callbacks.notice("success", "تم إنشاء حساب موظف الجرد."); state.loadedForRole = ""; await load(session, true); }
      catch (error) { callbacks.notice("error", error.message); } finally { state.accountBusy = false; callbacks.render(); }
    });
    root.querySelectorAll("[data-smart-account-reset]").forEach((button) => button.addEventListener("click", async () => {
      const password = prompt("كلمة المرور الجديدة (8 أحرف على الأقل):"); if (!password) return;
      try { await store.updateInventoryCounterAccount("reset_password", { userId: button.dataset.smartAccountReset, password, reason: "إعادة تعيين بواسطة المالك" }); callbacks.notice("success", "تغيرت كلمة المرور وأُلغيت الجلسات القديمة."); } catch (error) { callbacks.notice("error", error.message); }
    }));
    root.querySelectorAll("[data-smart-account-toggle]").forEach((button) => button.addEventListener("click", async () => {
      const action = button.dataset.enabled === "true" ? "disable" : "enable";
      try { await store.updateInventoryCounterAccount(action, { userId: button.dataset.smartAccountToggle, reason: action === "disable" ? "تعطيل بواسطة المالك" : "إعادة تفعيل بواسطة المالك" }); callbacks.notice("success", action === "disable" ? "عُطل الحساب وأُلغيت جلساته." : "أُعيد تفعيل الحساب."); state.loadedForRole = ""; await load(session, true); } catch (error) { callbacks.notice("error", error.message); }
    }));
    if (autoRefreshTimer) clearInterval(autoRefreshTimer);
    autoRefreshTimer = setInterval(() => { if (document.visibilityState === "visible" && state.session) refreshCurrent(session); }, 30000);
  }

  window.addEventListener("online", () => { state.localNotice = "عاد الاتصال"; flushOutbox(window.__ozkSession).then(() => refreshCurrent(window.__ozkSession)); });
  window.SmartInventory = { state, load, render, bind, deviceId, reset() { state.loadedForRole = ""; state.session = null; state.ownerReport = null; state.warehouses = []; state.dashboard = []; } };
})();
