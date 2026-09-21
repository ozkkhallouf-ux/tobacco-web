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


  // ==========================================================================
  // منع إنشاء صف مكرر جديد على بطاقة أمين مسعّرة أصلاً (السبب الجذري).
  //
  // العلّة البنيوية: هدف التعارض في الـupsert هو `item_key`، وهو سلسلة **مشتقّة**
  // من اسم المادة عبر تطبيع قابل للتغيّر (همزة/تاء مربوطة/تشكيل/ترقيم). فحين
  // يتغيّر ناتج التطبيع لصنف قائم — بتشديد قاعدة التطبيع أو بإعادة تسمية بطاقة
  // في الأمين — لا يُحدَّث الصف القديم بل **يُولد صف ثانٍ**، ثم تختم مهمة أرقام
  // الأصناف الصفّين بنفس `item_guid`. هكذا وُلدت الـ53 مجموعة القائمة اليوم.
  //
  // ما يمنعه هذا الحارس: **الولادة وحدها**. لا يمسّ مجموعة قائمة ولا يجمّدها —
  // تحديث صف بمفتاح موجود مسموح دائماً مهما بلغ عدد توائمه. القاعدة:
  //
  //   صف وارد مفتاحه غير موجود في الجدول (= سيُنشئ صفاً)
  //   + يحلّ إلى `item_guid` غير فارغ
  //   + ذلك الـGUID مملوك أصلاً لصف قائم بمفتاح آخر (أو لصف وارد آخر جديد)
  //   ⇒ رفض قبل أي كتابة.
  //
  // كيف يُحلّ GUID لصف وارد جديد: حمولة الموقع لا تحمل `item_guid` إطلاقاً
  // (راجع normalizeApprovedPriceInput)، فلا يكفي البحث بالمفتاح الحرفي — المفتاح
  // الجديد بطبيعته غير موجود. لذلك نحلّه بالاسم المطبّع مقابل الصفوف القائمة:
  // وهو **نفس المسار الذي يُنتج الازدواج**، فمطابقته هي عين ما يجب اعتراضه.
  // وعند الالتباس (اسم مطبّع واحد يحمل أكثر من GUID) لا نخمّن ولا نمنع: الحظر
  // على تخمين هوية خطأ أسوأ من تركه، والتعارض السعري يبقى خط الدفاع الثاني.
  // ==========================================================================

  // مرآة `normalizeItemName` في src/app.js. مكرّرة هنا عمداً لأن هذه الوحدة
  // نقية بلا اعتماد على ترتيب التحميل؛ ويمنع الانحراف بينهما اختبارُ تطابقٍ
  // يقارن التنفيذين على مجموعة حالات حقيقية (check-price-guid-conflict-guard.mjs).
  const IDENTITY_ALIASES = new Map([
    ["كابتن بلاك كوين ازرق", "كابتن بلاك كور ازرق جديد"],
    ["كابتن بلاك كوين اسود", "كابتن بلاك كور اسود جديد"]
  ]);

  function normalizeIdentityName(value) {
    const normalized = String(value ?? "")
      .trim()
      .replace(/^\d{2,}\s*[-–—]\s*/u, "")
      .replace(/[ـًٌٍَُِّْ]/gu, "")
      .replace(/[إأآٱ]/gu, "ا")
      .replace(/ى/gu, "ي")
      .replace(/ة/gu, "ه")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    return IDENTITY_ALIASES.get(normalized) || normalized;
  }

  function readKey(row) {
    return String((row && (row.item_key ?? row.itemKey)) ?? "").trim();
  }

  function readName(row) {
    return String((row && (row.item_name ?? row.itemName)) ?? "").trim();
  }

  function readGuid(row) {
    return normalizeGuid(row && (row.item_guid ?? row.itemGuid));
  }

  /**
   * يحلّ هوية صف وارد: هوية صريحة، ثم مفتاح حرفي قائم، ثم اسم مطبّع قائم.
   * يعيد "" حين تتعذّر الهوية أو تلتبس — وغيابها لا يمنع الحفظ إطلاقاً.
   */
  function resolveIncomingGuid(rec, guidByKey, guidsByNormalizedName) {
    const explicit = readGuid(rec);
    if (explicit) return explicit;

    const key = readKey(rec);
    const byKey = normalizeGuid((guidByKey || {})[key]);
    if (byKey) return byKey;

    for (const candidate of [normalizeIdentityName(key), normalizeIdentityName(readName(rec))]) {
      if (!candidate) continue;
      const guids = guidsByNormalizedName.get(candidate);
      // أكثر من هوية لنفس الاسم المطبّع = التباس: لا تخمين ولا منع.
      if (guids && guids.size === 1) return [...guids][0];
    }
    return "";
  }

  /**
   * يعيد قائمة الصفوف الواردة التي ستُنشئ صفاً مكرراً جديداً على بطاقة مأهولة.
   * مصفوفة فارغة = لا شيء يُمنع.
   *
   * كل عنصر: { guid, itemName, newKey, existingKeys: [...] }
   */
  function findNewDuplicateGuidRows(incomingRows, existingRows, guidByKey) {
    const existing = Array.isArray(existingRows) ? existingRows : [];
    const existingKeys = new Set(existing.map(readKey).filter(Boolean));

    const keysByGuid = new Map();
    const guidsByNormalizedName = new Map();
    // صفوف قائمة **بلا هوية مسجّلة**، مفهرسة بالاسم المطبّع. وجودها واقع لا
    // فرضية: صفّ أي بطاقة جديدة يُسعَّر يبقى بهوية NULL حتى تعمل مهمة أرقام
    // الأصناف (كل ٦ ساعات افتراضياً) — قيست 7 صفوف كهذه لحظة كتابة السطر.
    // إسقاطها من الفهرسة كان يجعل الحارس يسمح بمفتاح ثانٍ لنفس البطاقة، لأن
    // المالك لا يملك هوية يُقارَن بها (Codex P1 ثالث على #257).
    const keylessKeysByNormalizedName = new Map();
    for (const row of existing) {
      const key = readKey(row);
      if (!key) continue;
      const guid = readGuid(row);
      const names = [normalizeIdentityName(key), normalizeIdentityName(readName(row))];
      if (!guid) {
        for (const name of names) {
          if (!name) continue;
          if (!keylessKeysByNormalizedName.has(name)) keylessKeysByNormalizedName.set(name, []);
          const bucket = keylessKeysByNormalizedName.get(name);
          if (!bucket.includes(key)) bucket.push(key);
        }
        continue;
      }
      if (!keysByGuid.has(guid)) keysByGuid.set(guid, []);
      keysByGuid.get(guid).push(key);
      for (const name of names) {
        if (!name) continue;
        if (!guidsByNormalizedName.has(name)) guidsByNormalizedName.set(name, new Set());
        guidsByNormalizedName.get(name).add(guid);
      }
    }

    /** مفاتيح صفوف بلا هوية يطابقها الوارد بالاسم المطبّع. */
    function keylessOwnersFor(rec, key) {
      const owners = [];
      for (const candidate of [normalizeIdentityName(key), normalizeIdentityName(readName(rec))]) {
        if (!candidate) continue;
        for (const owned of keylessKeysByNormalizedName.get(candidate) || []) {
          if (!owners.includes(owned)) owners.push(owned);
        }
      }
      return owners;
    }

    const found = [];
    // مفاتيح جديدة حُجزت داخل هذه الحمولة نفسها: حمولة واحدة تحمل مفتاحين
    // جديدين لنفس البطاقة تُنشئ الازدواج بذاتها، فتُرفض كذلك.
    const claimedInPayload = new Map();
    const seenNewKeys = new Set();
    for (const rec of Array.isArray(incomingRows) ? incomingRows : []) {
      const key = readKey(rec);
      // مفتاح موجود = تحديث لا إنشاء. مسموح دائماً — هنا تمرّ إعادة تسعير
      // المجموعات المكررة القائمة بلا مساس.
      if (!key || existingKeys.has(key)) continue;
      // نفس المفتاح مكرراً داخل الحمولة يُنشئ **صفاً واحداً** (الـupsert يتعارض
      // على item_key)، فلا يجوز أن يُحسب ازدواجاً على نفسه.
      if (seenNewKeys.has(key)) continue;
      seenNewKeys.add(key);

      // صفّ قائم بلا هوية يطابق الوارد بالاسم المطبّع: مالكٌ فعليّ رغم غياب
      // هويته المسجّلة. يُفحص قبل حلّ الهوية لأن الهوية لا تربطهما أصلاً.
      const keylessOwners = keylessOwnersFor(rec, key);

      const guid = resolveIncomingGuid(rec, guidByKey, guidsByNormalizedName);
      if (!guid) {
        // بلا هوية للوارد، يبقى مالك الاسم المطبّع وحده دليلاً كافياً.
        if (keylessOwners.length) {
          found.push({
            guid: "(بلا هوية مسجّلة بعد)",
            itemName: readName(rec) || key,
            newKey: key,
            existingKeys: keylessOwners
          });
        }
        continue;
      }

      const owners = [
        ...(keysByGuid.get(guid) || []),
        ...(claimedInPayload.get(guid) || []),
        ...keylessOwners
      ];
      if (owners.length) {
        found.push({
          guid,
          itemName: readName(rec) || key,
          newKey: key,
          existingKeys: owners.slice()
        });
      }
      if (!claimedInPayload.has(guid)) claimedInPayload.set(guid, []);
      claimedInPayload.get(guid).push(key);
    }
    return found;
  }

  // ==========================================================================
  // منع إعادة إسناد هوية صفٍّ قائم (Codex P1 على #257).
  //
  // العلّة: مسار الحفظ صار يكتب `item_guid` مع الصف. فلو وصلت هوية «موثوقة»
  // خاطئة — مثل بطاقتَي أمين تتصادمان على نفس الاسم المطبّع (حالة 273/274،
  // يحلّها `savePricingItem` بـ`find` فيأخذ أولاهما) — لدهست الهويةَ المخزّنة
  // الصحيحة وأعادت إسناد الصف لبطاقة أخرى **صامتاً**، فتنكسر مطابقة متوسط
  // التكلفة (push-item-costs.ps1) حتى تُصلحها المهمة المجدولة.
  //
  // القاعدة: الهوية المخزّنة لصفٍّ قائم **مرجع لا يُدهَس**. الهوية الواردة
  // تُثبَّت فقط حين لا هوية مخزّنة. واختلافهما ليس ترجيحاً بل تعارضاً يُرفض.
  // ==========================================================================
  function findGuidReassignments(incomingRows, storedByKey, trustedByKey) {
    const stored = storedByKey || {};
    const trusted = trustedByKey || {};
    const found = [];
    for (const rec of Array.isArray(incomingRows) ? incomingRows : []) {
      const key = readKey(rec);
      if (!key) continue;
      const storedGuid = normalizeGuid(stored[key]);
      const incomingGuid = normalizeGuid(trusted[key]);
      // بلا هوية مخزّنة لا دهس ممكن؛ وبلا هوية واردة لا دعوى.
      if (!storedGuid || !incomingGuid) continue;
      if (storedGuid === incomingGuid) continue;
      found.push({
        itemKey: key,
        itemName: readName(rec) || key,
        storedGuid,
        incomingGuid
      });
    }
    return found;
  }

  /** رسالة عربية صريحة: المادة وهويتها المخزّنة والهوية الواردة المخالفة. */
  function formatGuidReassignmentMessage(reassignments) {
    const list = Array.isArray(reassignments) ? reassignments : [];
    if (!list.length) return "";
    const lines = [
      `تعذّر الحفظ: ${list.length} مادة وصلت بهوية بطاقة تخالف هويتها المحفوظة. لم يُحفظ أي سعر.`,
      "هوية الصف المحفوظة لا تُستبدل تلقائياً — قد تكون بطاقتان مختلفتان بنفس الاسم.",
      ""
    ];
    for (const entry of list) {
      lines.push(`• ${entry.itemName} (${entry.itemKey})`);
      lines.push(`    المحفوظة: ${entry.storedGuid}`);
      lines.push(`    الواردة:  ${entry.incomingGuid}`);
    }
    lines.push("");
    lines.push("وحّد اسم المادة في الأمين أو راجع بطاقتها، ثم أعد المحاولة.");
    return lines.join("\n");
  }

  /** رسالة عربية صريحة: الاسم والهوية والمفتاح القائم والمفتاح الجديد. */
  function formatNewDuplicateMessage(duplicates) {
    const list = Array.isArray(duplicates) ? duplicates : [];
    if (!list.length) return "";
    const lines = [
      `تعذّر الحفظ: ${list.length} مادة ستُنشئ صفاً مكرراً جديداً على بطاقة أمين مسعّرة أصلاً. لم يُحفظ أي سعر.`,
      "البطاقة الواحدة لا يجوز أن تُمثَّل بأكثر من صف، ولن يُنشأ الصف الثاني تلقائياً.",
      ""
    ];
    for (const dup of list) {
      lines.push(`• ${dup.itemName} — item_guid: ${dup.guid}`);
      lines.push(`    المفتاح الموجود: ${dup.existingKeys.join(" ، ")}`);
      lines.push(`    المفتاح الجديد: ${dup.newKey}`);
    }
    lines.push("");
    lines.push("سعّر المادة من صفّها الموجود، أو وحّد اسمها في الأمين ثم أعد المحاولة.");
    return lines.join("\n");
  }

  root.priceGuidConflict = {
    MANAGED_FIELDS,
    findGuidPriceConflicts,
    buildScopedConflictState,
    formatConflictMessage,
    findNewDuplicateGuidRows,
    formatNewDuplicateMessage,
    findGuidReassignments,
    formatGuidReassignmentMessage,
    normalizeIdentityName,
    normalizeGuid,
    round4
  };
})(window);
