// ============================================================================
// عقد هوية السعر: لا يجوز أن يحمل `item_guid` واحد أكثر من قيمة موجبة واحدة
// لأي حقل سعري مُدار. دوال معزولة بلا DOM وبلا شبكة — قابلة للاختبار مباشرة
// (نفس نمط src/inventory-recon-calc.js).
//
// لماذا وُجد هذا الملف: بطاقة أمين واحدة قد يشير إليها أكثر من `item_key` في
// `approved_price_items` (مفاتيح موروثة سبقت التطبيع الحالي — 74 مفتاحاً وقت
// كتابة هذا السطر). حين تختلف أسعارها، كان الفائز يُحسم بفارق أجزاء من الثانية
// في `updated_at`، فتتغيّر أسعار حقيقية بصمت عند أي إعادة حفظ تقلب الترتيب.
//
// القاعدة المعتمدة (قرار المالك، لا اجتهاد):
//   • تعارض ⟺ حقل مُدار واحد يحمل **أكثر من قيمة موجبة مميّزة** داخل صفوف
//     نفس `item_guid`.
//   • القيمة 0 تعني **«غير مسعّر»** لا «سعره صفر» — فلا تُحتسب طرفاً في
//     المقارنة ولا تُنشئ تعارضاً مع قيمة موجبة. (لولا ذلك لانكسرت مادتان
//     تُسعَّران بشكل صحيح اليوم: «نخلة صلاحية شهر 1» و«شهر 10»، حيث صفٌّ
//     غير مسعّر للمفرق وصفٌّ بسعر 325.)
//   • لا ترجيح بـ`updated_at` ولا بالاسم ولا بالأعلى ولا بالأحدث. التعارض
//     يُرفض ولا يُحسم تلقائياً.
//
// الحقول المُدارة هي وحدها التي تكتبها مزامنة الأسعار إلى الأمين. اختلاف
// `notes` أو `unit2_factor` أو أي حقل آخر ليس تعارضاً.
// ============================================================================
(function (root) {
  // تقريب المقارنة إلى 4 منازل = دقة `decimal(18,4)` في الأمين. يجعل 96 و96.00
  // قيمة واحدة، ويمنع ضجيج الفاصلة العائمة من اختلاق تعارض وهمي.
  function round4(value) {
    if (!Number.isFinite(value)) return Number.NaN;
    return Math.round(value * 10000) / 10000;
  }

  function toNumber(value) {
    if (value === null || value === undefined || value === "") return Number.NaN;
    const num = typeof value === "number" ? value : Number(String(value).trim());
    return Number.isFinite(num) ? num : Number.NaN;
  }

  function normalizeGuid(value) {
    const text = String(value ?? "").trim().toUpperCase();
    return text;
  }

  // سعر كرتونة المفرق يعيش داخل price_payload.retail.price — لا عمود مستقل له.
  function readRetailCarton(row) {
    const payload = (row && (row.price_payload ?? row.pricePayload)) || {};
    const retail = payload.retail;
    if (!retail || typeof retail !== "object") return Number.NaN;
    return toNumber(retail.price);
  }

  const MANAGED_FIELDS = [
    {
      key: "wholesaleCarton",
      label: "سعر كرتونة الجملة",
      read: (row) => toNumber(row && (row.unit2_price ?? row.unit2Price))
    },
    {
      key: "wholesaleUnit1",
      label: "سعر كروز الجملة",
      read: (row) => toNumber(row && (row.sale_price ?? row.salePrice))
    },
    {
      key: "retailCarton",
      label: "سعر كرتونة المفرق",
      read: readRetailCarton
    }
  ];

  function rowLabel(row) {
    const key = String((row && (row.item_key ?? row.itemKey)) || "").trim();
    const name = String((row && (row.item_name ?? row.itemName)) || "").trim();
    if (key && name && key !== name) return `${name} (${key})`;
    return name || key || "(بلا اسم)";
  }

  /**
   * يعيد قائمة التعارضات. مصفوفة فارغة = لا تعارض.
   * كل عنصر: { guid, field, label, values: [{ value, rows: [{ itemKey, itemName }] }] }
   */
  function findGuidPriceConflicts(rows) {
    const byGuid = new Map();
    for (const row of rows || []) {
      const guid = normalizeGuid(row && (row.item_guid ?? row.itemGuid));
      // بلا هوية لا يمكن التجميع إطلاقاً. هذه ليست حالة آمنة بل حالة غير قابلة
      // للفحص هنا — يلتقطها الدفاع الثاني في apply-approved-prices-to-ameen.ps1
      // بعد أن تختم مهمة أرقام الأصناف المعرّفات.
      if (!guid) continue;
      if (!byGuid.has(guid)) byGuid.set(guid, []);
      byGuid.get(guid).push(row);
    }

    const conflicts = [];
    for (const [guid, group] of byGuid) {
      if (group.length < 2) continue; // صف واحد لا يعارض نفسه
      for (const field of MANAGED_FIELDS) {
        const byValue = new Map();
        for (const row of group) {
          const value = round4(field.read(row));
          // 0 أو سالب أو غير رقمي = «لا رأي» — لا يدخل المقارنة.
          if (!(value > 0)) continue;
          if (!byValue.has(value)) byValue.set(value, []);
          byValue.get(value).push(row);
        }
        if (byValue.size < 2) continue; // قيمة موجبة واحدة (أو لا شيء) = اتفاق
        conflicts.push({
          guid,
          field: field.key,
          label: field.label,
          values: [...byValue.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([value, valueRows]) => ({
              value,
              rows: valueRows.map((row) => ({
                itemKey: String((row.item_key ?? row.itemKey) || ""),
                itemName: String((row.item_name ?? row.itemName) || "")
              }))
            }))
        });
      }
    }
    return conflicts;
  }

  /**
   * يبني الحالة التي يجب فحصها لحفظ **جزئي** (upsert).
   *
   * لماذا النطاق ضروري: الـupsert يعالج بضعة أصناف، لكن فحص الجدول كله يعني أن
   * أي تعارض قديم على بطاقة أخرى يُفشِل كل حفظ لاحق مهما كان سليماً — فيتجمّد
   * تسعير اللائحة بأسرها ويستحيل حلّ التعارضات القديمة واحداً واحداً. (Codex P1
   * ثانٍ على PR #256.) لذلك نضمّ من الصفوف القائمة **فقط** ما يشترك في هوية
   * تلمسها الحمولة الحالية.
   *
   * ما يبقى مضموناً: الحفظ لا يستطيع إنشاء ولا إدامة تعارض على بطاقة يلمسها.
   * ما يزول: شلل التسعير بسبب تعارض في بطاقة لا علاقة لها بهذا الحفظ.
   */
  function buildScopedConflictState(incomingRows, existingRows, guidByKey) {
    const byKey = guidByKey || {};
    const withGuid = (incomingRows || []).map((rec) => ({
      ...rec,
      item_guid: (rec && (rec.item_guid ?? rec.itemGuid)) ?? byKey[rec && rec.item_key] ?? null
    }));
    const incomingKeys = new Set(withGuid.map((rec) => rec.item_key));
    const touchedGuids = new Set(
      withGuid.map((rec) => normalizeGuid(rec.item_guid)).filter((guid) => guid)
    );
    const scopedExisting = (existingRows || []).filter(
      (row) =>
        row &&
        row.item_key &&
        !incomingKeys.has(row.item_key) &&
        touchedGuids.has(normalizeGuid(row.item_guid ?? row.itemGuid))
    );
    return [...withGuid, ...scopedExisting];
  }

  /** رسالة عربية مفصّلة للمستخدم — تعرض الهوية والمفاتيح والقيم المتعارضة. */
  function formatConflictMessage(conflicts) {
    const list = Array.isArray(conflicts) ? conflicts : [];
    if (!list.length) return "";
    const lines = [
      `تعذّر الحفظ: ${list.length} تعارض سعر على بطاقة أمين واحدة. لم يُحفظ أي سعر.`,
      "البطاقة الواحدة لا يجوز أن تحمل سعرين مختلفين، ولن يُختار أحدهما تلقائياً.",
      ""
    ];
    for (const conflict of list) {
      lines.push(`• ${conflict.label} — item_guid: ${conflict.guid}`);
      for (const entry of conflict.values) {
        for (const row of entry.rows) {
          lines.push(`    ${entry.value} ← ${rowLabel(row)}`);
        }
      }
    }
    lines.push("");
    lines.push("صحّح ملف الأسعار ليحمل سعراً واحداً لهذه المادة ثم أعد الرفع.");
    return lines.join("\n");
  }

  root.priceGuidConflict = {
    MANAGED_FIELDS,
    findGuidPriceConflicts,
    buildScopedConflictState,
    formatConflictMessage,
    normalizeGuid,
    round4
  };
})(window);
