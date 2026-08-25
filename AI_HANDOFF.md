# دفتر تسليم العمل — OZK TOBACCO

يقرأه Claude وCodex قبل كل مهمة. أحدث سجل يكون في الأعلى. لا تحذف السجلات السابقة.

## 2026-08-25 - Claude - reliability-hardening-phase1

- Status: completed
- Branch: task branch pending for: reliability-hardening-phase1
- Files: tools/ameen-read-worker.ps1,tools/push-customer-movements.ps1,tools/ensure-ameen-sync.ps1
- Result: PR #114 merged (merge commit b7ae578bbfc0c95de9b3933286464feb2f39941c). Reliability Hardening Phase 1 complete: Ameen Read Worker timeout+heartbeat, Customer Movements HTTP timeout, isolated watchdog recovery for the worker task only. Ameen remained READ ONLY throughout.
- Handoff UTC: 2026-08-25T11:44:42Z
## 2026-08-24 - Claude - Collection Priority user-facing fix (command-center.js)

- Status: completed
- Branch: task branch pending for: Collection Priority user-facing fix (command-center.js)
- Files: src/command-center.js
- Result: Merged PR #112 (merge commit 9ae0684). Collection shortlist shipped in src/command-center.js + src/business-snapshot.js. SW v589. npm run check green post-merge.
- Handoff UTC: 2026-08-24T20:54:31Z
## 2026-08-24 - Claude - FIX PR #111 blocker: Ameen Live stock partial-failure freshness masking

- Status: completed
- Branch: task branch pending for: FIX PR #111 blocker: Ameen Live stock partial-failure freshness masking
- Files: src/command-center.js
- Result: Task completed and handed off.
- Handoff UTC: 2026-08-24T18:48:07Z
## 2026-08-24 - Claude - AUTO-REFRESH AMEEN LIVE STOCK FOR COMMAND CENTER

- Status: completed
- Branch: task branch pending for: AUTO-REFRESH AMEEN LIVE STOCK FOR COMMAND CENTER
- Files: src/command-center.js, src/command-center-hotfix.js
- Result: Task completed and handed off.
- Handoff UTC: 2026-08-24T18:02:27Z
## 2026-08-24 - Codex - إصلاح صلاحيات Ameen Live للمالك والتحقق الحي

- Status: completed
- Branch: codex/ameen-live-owner-authorization
- Files: supabase/functions/ameen-read-broker/index.ts, scripts/check-ameen-read-gateway.mjs, docs/ai/topics/ameen-sync.md
- Result: اكتمل إصلاح تفويض المالك والتحقق الحي؛ الفرع codex/ameen-live-owner-authorization عند 69712ad7ca3c9f53fe728fe599dd530a0104cfd4 ومزامن مع origin، وجاهز لمراجعة مستقلة قبل الدمج.
- Handoff UTC: 2026-08-23T22:41:03Z
## 2026-08-23 - Codex - منع فتح PDF نشرة قديم وإصلاح تصدير RTL الموحد

- Status: completed
- Branch: task branch pending for: منع فتح PDF نشرة قديم وإصلاح تصدير RTL الموحد
- Files: src/app.js, src/price-list-template.js, scripts/check.mjs, index.html, public/service-worker.js, docs/ai/topics/price-bulletins.md
- Result: أُخلي القفل القديم بإذن المستخدم بعد التحقق من عدم وجود عملية مرتبطة به؛ لم يُعدّل كود الموقع.
- Handoff UTC: 2026-08-23T16:37:03Z
## 2026-08-23 - Codex - إصلاح العربية واتجاه التاريخ في نشرات الدولار والليرة

- Status: completed
- Branch: task branch pending for: إصلاح العربية واتجاه التاريخ في نشرات الدولار والليرة
- Files: src/app.js, src/price-list-template.js, scripts/generate-price-lists.mjs, scripts/generate-pdfs.mjs, scripts/check.mjs, public/downloads/price-list-usd.html, public/downloads/price-list-usd.pdf, public/downloads/price-list-usd-light.pdf, public/downloads/price-list-syp-14050.html, public/downloads/price-list-syp-14050.pdf, public/downloads/price-list-syp-14050-light.pdf, public/downloads/price-list-wazari-usd.html, public/downloads/price-list-wazari-usd.pdf, public/downloads/price-list-wazari-usd-light.pdf, public/downloads/price-list-wazari-syp-14050.html, public/downloads/price-list-wazari-syp-14050.pdf, public/downloads/price-list-wazari-syp-14050-light.pdf, index.html, public/service-worker.js, docs/ai/topics/price-bulletins.md
- Result: دُمج PR #107 للإصلاح وPR #108 لتحصين التوليد المتزامن. نُشر tobacco-169/cache v575، وتحقق حي من 4 HTML و8 PDF/16 صفحة بالعربية الصحيحة؛ سعر الصرف 13,100. تضارب مفتاح الفحم القديم موثق كمهمة بيانات منفصلة ولا يدخل النشرات الحالية.
- Handoff UTC: 2026-08-23T13:12:48Z
## 2026-08-23 - Codex - إصلاح انعكاس النص العربي في PDF النشرة المصدرة من الموقع

- Status: completed
- Branch: codex/fix-bulletin-arabic-pdf-final
- Files: src/app.js, src/price-list-template.js, scripts/check.mjs, scripts/check-smart-inventory.mjs, index.html, public/service-worker.js, docs/ai/topics/price-bulletins.md
- Result: Merged PRs #103, #104 and #106. Live tobacco-168 and cache v570 verified. All 12 live PDF pages passed visual RTL, badge, light/dark and English-number checks.
- Handoff UTC: 2026-08-23T10:52:38Z
## 2026-08-23 - Codex - دمج ونشر الجرد الذكي والتحقق الحي

- Status: completed
- Branch: task branch pending for: دمج ونشر الجرد الذكي والتحقق الحي
- Files: index.html, public/service-worker.js, src/app.js, src/styles.css, src/smart-inventory.js, src/supabase-client.js, supabase/smart-inventory.sql, supabase/functions/inventory-auth/index.ts, docs/ai/topics/inventory.md, scripts/check-smart-inventory.mjs
- Result: تم دمج ونشر الجرد الذكي وإصلاح عزل inventory_counter. Edge inventory-auth v7 ACTIVE، والهجرة مطبقة، والحسابات الثلاثة تعمل، والمستودعات الفعلية ظاهرة. اختبار حي: RPC الجرد مسموح، والوصول المباشر إلى snapshot/froقات/مبيعات/لوحة المالك مرفوض 401، وسياسات العزل 62/62، ولا توجد كتابة أو تسوية في الأمين. التشغيل التجريبي الفعلي التالي: عد 20-30 صنفاً حقيقياً في مستودع واحد.
- Handoff UTC: 2026-08-23T09:03:00Z
## 2026-08-23 - Codex - تطبيق Backend الجرد الذكي وإنشاء حسابات موظفي الجرد

- Status: completed
- Branch: task branch pending for: تطبيق Backend الجرد الذكي وإنشاء حسابات موظفي الجرد
- Files: supabase/smart-inventory.sql,supabase/functions/inventory-auth/index.ts,docs/ai/topics/inventory.md
- Result: طُبق Backend الجرد الذكي وEdge Function على Supabase، وأُنشئت حسابات أمين المستودع وعثمان ومنذر وتحقق دخولها وعزل الفروقات. الفرع codex/smart-inventory-counting عند e5b8513 مدفوع؛ الموقع غير مدمج وغير منشور، ولا كتابة إلى الأمين. نجحت npm run check وgit diff --check وفحوص RLS/REST الحية.
- Handoff UTC: 2026-08-23T06:45:22Z
## 2026-08-23 - Codex - Smart inventory counting with owner dashboard and counter isolation

- Status: completed
- Branch: task branch pending for: Smart inventory counting with owner dashboard and counter isolation
- Files: src/app.js, src/styles.css, src/supabase-client.js, src/config.js, src/inventory-recon-calc.js, src/smart-inventory.js, scripts/check.mjs, index.html, public/service-worker.js, supabase/smart-inventory.sql, docs/ai/topics/inventory.md
- Result: Implemented and pushed branch codex/smart-inventory-counting at cc5f01b. Checks and mobile counter isolation passed. No merge, deployment, Supabase apply, Ameen write, or scheduler change.
- Handoff UTC: 2026-08-23T05:21:37Z
## 2026-08-23 - Codex - منع أخطاء تنسيق ملفات تنسيق عمل OZK

- Status: completed
- Branch: task branch pending for: منع أخطاء تنسيق ملفات تنسيق عمل OZK
- Files: tools/ai-work-coordination.ps1, scripts/check.mjs, AI_ACTIVE_TASK.json, AI_HANDOFF.md
- Result: دُمج الفرع codex/fix-ai-coordination-line-endings في main بالكوميت 59014b2. الأداة توحّد CRLF/CR إلى LF قبل الكتابة، وفحص المشروع وPowerShell 5.1 والتجربة المعزولة نجحت.
- Handoff UTC: 2026-08-23T01:48:05Z
## 2026-08-23 - Codex - تنظيم معرفة مشروع OZK حسب المواضيع وخريطة التأثير

- Status: completed
- Branch: task branch pending for: تنظيم معرفة مشروع OZK حسب المواضيع وخريطة التأثير
- Files: AGENTS.md, AI_WORK_SYNC.md, scripts/check.mjs, docs/ai/**
- Result: دُمج الفرع codex/project-knowledge-system في main بالكوميت 9fb0e39. أضيف مرجع موحد وخريطة تأثير وعقد مهمة وثمانية تقارير مواضيع وفحص يمنع فقدانها. نجح npm.cmd run check وgit diff --check، ولم تتغير وظائف الموقع أو البيانات أو النشر.
- Handoff UTC: 2026-08-23T01:28:15Z
## 2026-08-23 - Codex - تحويل أرقام نشرة الليرة السورية إلى الإنجليزية

- Status: completed
- Branch: `codex/english-syp-digits`
- PR: #100
- Merge commit: `8a9c17d572f11ec9731c9d18419a63e4bbb09e77`
- Files: src/app.js, scripts/generate-price-lists.mjs, scripts/check.mjs, index.html, public/service-worker.js, public/downloads/*
- Result: تم الدمج في PR #100 والنشر الحي. فحوص المشروع وGitHub ناجحة؛ مطابقة الأسعار mismatches=0 missing=0؛ النشرات العامة والوزارية فاتح وداكن بأرقام إنجليزية فقط وسعر صرف 13,100.
- Handoff UTC: 2026-08-23T00:28:33Z

## 2026-08-20 - Codex - إصلاح توليد PDF الفاتح ومنع رجوعه

- Status: completed
- Branch: `codex/fix-light-bulletin-pdf`
- PRs: #93, #95
- Merge commits: `9cf037ff294bd9e7808c3c891dcea360af162911`, `48ee81abeab02b9a517a5e10fa2281f9f8da01f5`
- Files: scripts/generate-pdfs.mjs,scripts/generate-price-lists.mjs,scripts/check.mjs,public/downloads/*
- Result: أصلح PR #93 الثيم الفاتح داخل قالب PDF نفسه، وأضاف PR #95 إصدار روابط يعتمد القالب والمولّد والتاريخ لمنع عرض ملفات قديمة من الكاش. نجحت فحوص المشروع وتطابق الأسعار، والنشر الحي، والفحص البصري لجميع صفحات PDF الداكنة والفاتحة.
- Handoff UTC: 2026-08-20T17:54:52Z
## 2026-08-20 - Codex - إصلاح سعر الصرف وخيارات ألوان النشرة

- Status: completed
- Branch: `codex/fix-bulletin-rate-theme`
- PR: #92
- Merge commit: `3303de22ed11aff9b73d8e179123708aba8f1abf`
- Files: src/app.js,scripts/generate-price-lists.mjs,scripts/check.mjs,index.html,public/service-worker.js
- Result: تم دمج PR #92 ونشر الاختيار الداكن والفاتح وحماية السعر المحلي من الرجوع وإضافة بصمة محتوى لملفات PDF. npm run check ناجح، فحص PDF بصري ناجح، PRICE_VERIFY mismatches=0 missing=0، والتحقق الحي ناجح.
- Handoff UTC: 2026-08-20T13:23:00Z
## 2026-08-20 - Codex - توحيد معاينة PDF مع تصميم النشرة الجديدة

- Status: completed
- Branch: `codex/fix-newsletter-preview-template`
- PR: #91
- Merge commit: `9245b988d2eb0172624df51afb04548f65a8b1dc`
- Files: 'src/price-list-template.js','src/app.js','scripts/generate-price-lists.mjs','scripts/check.mjs','index.html','public/service-worker.js'
- Result: تم دمج PR #91 ونشر القالب المشترك الجديد. npm run check ناجح، فحص PDF بصري ناجح، PRICE_VERIFY mismatches=0 missing=0، والتحقق الحي ناجح.
- Handoff UTC: 2026-08-20T12:41:58Z
## 2026-08-20 - Codex - منع تعليق الموقع عند انقطاع Supabase وإضافة إعادة محاولة آمنة

- Status: completed
- Branch: task branch pending for: منع تعليق الموقع عند انقطاع Supabase وإضافة إعادة محاولة آمنة
- Files: src/app.js,index.html,public/service-worker.js,scripts/check.mjs
- Result: أضيفت مهلة تهيئة 12 ثانية مع خروج مضمون من شاشة التحميل، تنبيه انقطاع وزر إعادة محاولة دون تغييرات قاعدة بيانات. نجح npm check واختبار Chrome بمحاكاة جلسة معلقة، ونُشرت النسخة tobacco-157 مع cache v544.
- Handoff UTC: 2026-08-20T11:36:47Z
## 2026-08-20 - Codex - إصلاح اعتماد سعر الصرف الجديد في معاينة ونشر PDF السوري

- Status: completed
- Branch: task branch pending for: إصلاح اعتماد سعر الصرف الجديد في معاينة ونشر PDF السوري
- Files: src/app.js,index.html,public/service-worker.js,scripts/check.mjs
- Result: تم التقاط سعر الصرف المرئي قبل حفظ الأسعار، توحيد المعاينة وPDF والنشر على القيمة الجديدة، تصحيح مستودع GitHub، نجاح npm check واختبار Chrome والنشر الحي tobacco-156.
- Handoff UTC: 2026-08-20T11:05:41Z
## 2026-08-20 - Codex - إصلاح تصدير PDF للنشرة ليستخدم الأسعار المعدلة فوراً

- Status: completed
- Branch: task branch pending for: إصلاح تصدير PDF للنشرة ليستخدم الأسعار المعدلة فوراً
- Files: src/app.js,scripts/check.mjs,index.html,public/service-worker.js
- Result: دُمج 0593f4d؛ نجحت فحوص المشروع والمتصفح، ونُشر tobacco-154 مع cache v541 وتحقق الموقع الحي.
- Handoff UTC: 2026-08-20T10:10:23Z
## 2026-08-20 - Codex - إظهار شعار OZK في إشعارات iPhone

- Status: completed
- Branch: task branch pending for: إظهار شعار OZK في إشعارات iPhone
- Files: "public/icons/ozk-ios-notification-icon.png","index.html","public/manifest.webmanifest","public/service-worker.js","supabase/functions/web-push/index.ts"
- Result: PR #89 merged and deployed; Supabase web-push v4 active; full OZK TOBACCO image confirmed on Home Screen and lock-screen notification; stale subscription disabled; final test #58 delivered once with no error.
- Handoff UTC: 2026-08-20T07:35:05Z
## 2026-08-19 - Codex - إصلاح وتفعيل اشتراك Web Push للأجهزة

- Status: completed
- Branch: task branch pending for: إصلاح وتفعيل اشتراك Web Push للأجهزة
- Files: supabase/functions/web-push/index.ts
- Result: PR #87 merged; Supabase web-push v2 active; one iPhone subscription enabled; physical lock-screen notification delivery confirmed.
- Handoff UTC: 2026-08-19T02:47:14Z
## 2026-08-19 - Codex - قبول طول رمز Supabase OTP المضبوط

- Status: completed
- Branch: task branch pending for: Accept configured 8-digit Supabase recovery OTP
- Files: "src/supabase-client.js","src/app.js","scripts/check.mjs","index.html","public/service-worker.js"
- Result: PR #85 merged; verified Supabase expiry 3600 seconds and OTP length 8; live tobacco-151/v534 accepts 6-10 digits; all checks passed.
- Handoff UTC: 2026-08-19T02:05:50Z
## 2026-08-19 - Codex - استعادة كلمة المرور برمز OTP يدوي

- Status: completed
- Branch: task branch pending for: Make password recovery resistant to email prefetching with a manual OTP code
- Files: 'src/supabase-client.js','src/app.js','scripts/check.mjs','index.html','public/service-worker.js'
- Result: PR #84 merged; hosted recovery template uses Token; project and GitHub checks passed; live tobacco-150/v532 verified.
- Handoff UTC: 2026-08-19T01:24:02Z
## 2026-08-18 - Codex - Fix password recovery link and iPhone owner-only navigation

- Status: completed
- Branch: task branch pending for: Fix password recovery link and iPhone owner-only navigation
- Files: src/supabase-client.js,src/app.js,src/decision-engine.js,src/command-center.js,scripts/check.mjs,index.html,public/service-worker.js
- Result: Recovery callbacks now always open the password form; stale PWA clients reload on v531; npm, browser recovery, iPhone employee route tests, and PR 82 checks passed.
- Handoff UTC: 2026-08-18T18:59:29Z
## 2026-08-18 - Codex - Restrict employee executive tabs and assign Gmail owners

- Status: completed
- Branch: task branch pending for: Restrict employee executive tabs and assign Gmail owners
- Files: src/config.js, src/supabase-client.js, src/app.js, src/decision-engine.js, src/command-center.js, scripts/check.mjs, index.html, public/service-worker.js
- Result: Employee Outlook access restricted; both Gmail accounts assigned owner; recovery UI added; npm checks and browser validation passed; PR 81 merged.
- Handoff UTC: 2026-08-18T18:30:23Z
## 2026-08-18 - Codex - Close merged PR 66 stale lock

- Status: completed
- Branch: task branch pending for: Hotfix عرض توصيات الشراء وعميل Supabase
- Files: src/business-snapshot.js, src/purchase-recommendation.js, src/command-center.js, src/supabase-client.js, src/ameen-live-client.js, src/supplier-obligations-client.js, src/web-push.js, scripts/check-purchase-recommendation.mjs, scripts/check-command-center.mjs, index.html, public/service-worker.js
- Result: PR 66 merged at 2026-08-17T11:56:39Z; stale lock released before employee access work.
- Handoff UTC: 2026-08-18T18:01:28Z
## 2026-08-17 - Codex - محرك توصية كمية شراء آمن من Ameen Live

- Status: completed
- Branch: agent/safe-purchase-recommendation
- Files: src/purchase-recommendation.js, src/business-snapshot.js, src/command-center.js, scripts/check-purchase-recommendation.mjs, package.json, index.html, public/service-worker.js
- Result: PR #67 merged at 891e6d2; checks and Deploy #968 succeeded.
- Handoff UTC: 2026-08-17T13:17:31Z
## 2026-08-10 - Codex - تحسين SEO للصفحة الرئيسية: H1 وcanonical وOpen Graph وOrganization JSON-LD

- Status: completed
- Branch: task branch pending for: تحسين SEO للصفحة الرئيسية: H1 وcanonical وOpen Graph وOrganization JSON-LD
- Files: index.html,public/service-worker.js
- Result: دُمج PR #51 بطريقة squash بالـcommit f9bb1f6؛ نجح workflow Deploy TOBACCO Web رقم 31355034852؛ تحقق HTTPS 200 وH1 على الهاتف وcanonical وOpen Graph وOrganization JSON-LD والشعار وCACHE_NAME v475.
- Handoff UTC: 2026-08-10T04:26:39Z
## 2026-08-10 - Claude - سند القيد

- Status: completed
- Branch: task branch pending for: سند القيد: واجهة وتخزين مسودات القيود المحاسبية الداخلية بدون كتابة للأمين
- Files: src/app.js,src/styles.css,src/journal-entries.js,public/service-worker.js,supabase/journal-entries-tables.sql
- Result: Task completed and handed off.
- Handoff UTC: 2026-08-10T04:01:30Z

## 2026-08-05 - Codex - ترتيب فواتير ومرتجعات ودفعات الزبون في ثلاثة أعمدة وإخفاء معلومات التواصل

- Status: completed
- Branch: task branch pending for: ترتيب فواتير ومرتجعات ودفعات الزبون في ثلاثة أعمدة وإخفاء معلومات التواصل
- Files: 'src/app.js','src/styles.css','public/service-worker.js'
- Result: دُمج PR #45 بعد تحديثه من main؛ Copilot راجع 3/3 ملفات بلا ملاحظات؛ npm.cmd run check وgit diff --check ناجحان.
- Handoff UTC: 2026-08-05T20:18:06Z

## 2026-08-04 - Claude - الجرد الشهري: مستودعات ديناميكية من الأمين بدل "جملة"/"مركز" ثابتين (مسودة، بانتظار مراجعة Codex)

- Status: pushed, awaiting Codex review (Draft PR — لم يُدمج)
- Branch/Worktree: `fix/ameen-warehouse-stock-dynamic` (`.claude/worktrees/warehouse-stock-dynamic`)
- Files: `tools/push-ameen-warehouse-stock.ps1` (جديد)، `src/supabase-client.js`، `src/app.js`، `scripts/check.mjs`، `public/service-worker.js` (v455→v456)
- المشكلة: لا يوجد مستودع مخصص لـ"جملة" أو "مركز" في الأمين — واجهة الجرد كانت تعرض خيارين ثابتين مخترَعين لا يطابقان أي مستودع حقيقي، ولا يجوز ربط المستودع بنوع البيع.
- الحل:
  1. سكريبت جديد `push-ameen-warehouse-stock.ps1` يقرأ `dbo.st000`/`bi000`/`bu000`/`bt000` (SELECT فقط، نفس منطق `bIsInput`/`bIsOutput` بـ`ameen-stock-query.sql`) ويرفع تقريراً مستقلاً لكل مستودع فعلي إلى `inventory_reports` بمصدر `ameen_warehouse_stock`، بمفتاح `summary.warehouseKey` = GUID الأمين و`summary.warehouseName` = الاسم للعرض فقط. يدعم `-WhatIf` (يطبع أسماء المستودعات وعدد الأصناف والمجموع فقط، بلا كتابة ولا أسرار).
  2. `supabase-client.js`: أُضيف `listReconWarehouses()` (يبني قائمة المستودعات من أحدث تقارير `ameen_warehouse_stock`) و`getLatestWarehouseStockReport(warehouseKey)`.
  3. `app.js`: حُذف تماماً أي خيار "جملة"/"مركز" ثابت بالجرد؛ `state.reconWarehouses` أصبحت ديناميكية عبر `loadReconWarehouses()`، وزر اختيار المستودع بالواجهة (`data-recon-warehouse`) يُبنى فقط من `state.reconWarehouses` بمفتاح GUID، مع حالة فارغة واضحة إن لم تتوفر تقارير بعد. أُضيف تحذير حداثة التقرير (عتبة 24 ساعة) ومنع الحفظ إن كان التقرير غير موثوق.
  4. `scripts/check.mjs`: 4 اختبارات جديدة (a) تمنع رجوع "جملة"/"مركز" الثابتين بمنطقة اختيار مستودع الجرد تحديداً (بلا مساس بالاستخدامات الأخرى غير المرتبطة للكلمة jumla بوضع البيع أو سلسلة فواتير المبيعات)، (b) تثبت الاعتماد على `warehouseKey` (GUID)، (c) تثبت رفع تقرير مستقل لكل مستودع (حلقة `foreach ($s in $stores)`)، (d) تثبت عدم وجود أي `INSERT`/`UPDATE`/`DELETE`/`MERGE`/`EXEC` بمنطق SQL الخاص بالأمين + تثبت أن `push-inventory-reconciliation-to-ameen.ps1` ما زال سكريبتاً مقفلاً (`exit 1`).
- التحقق: `npm run check` ✅ ("Project check passed.")، `git diff --check` ✅ (بلا مشاكل مسافات).
- تشغيل فعلي: نُفِّذ Dry Run أولاً (بلا كتابة) ثم التشغيل الفعلي — رُفعت 5 تقارير مستقلة إلى `inventory_reports` (المصدر `ameen_warehouse_stock`) للمستودعات الخمسة الحقيقية: مركز، دوما الأساسي، دوما الاحتياطي، مستودع المشترك، حرستا (419 صنف لكل مستودع). تحقّقتُ من الفصل الحقيقي بين المستودعات عبر استعلام SQL مباشر على Supabase (Supabase MCP، بلا استخدام psql أو أسرار): نفس الصنف رقم 1 له كميات مختلفة فعلاً بكل مستودع (مثال: 0 بحرستا، 100 بدوما الأساسي، 48 بمركز) — يثبت أن الحساب لكل مستودع مستقل وليس مكرّراً.
- لم يُختبَر: التصفّح الفعلي لصفحة الجرد بالمتصفح (يتطلب تسجيل دخول بحساب موظف حقيقي — لم أُدخل بيانات اعتماد نيابة عن المستخدم وفق سياسة الأمان). يُنصَح بفحص بصري سريع لصفحة "الجرد الشهري" واختيار مستودعين مختلفين والتأكد من تغيّر الكميات المعروضة.
- لم يُلمس: أي جدول أو رصيد أو سعر بالأمين (قراءة SELECT فقط)، و`push-inventory-reconciliation-to-ameen.ps1` ما زال مقفلاً كما هو (`exit 1`) ولم يُفعَّل.
- Handoff UTC: 2026-08-04T21:05:00Z

## 2026-08-01 - Codex - إصلاح دمج أصناف ماستر في نشرتي الدولار والسوري

- Status: completed
- Branch: task branch pending for: إصلاح دمج أصناف ماستر في نشرتي الدولار والسوري
- Files: src/app.js,scripts/generate-price-lists.mjs,scripts/bulletin-merge-names.json,scripts/check.mjs,public/service-worker.js
- Result: دُمج codex/fix-master-bulletin-merge إلى main بـmerge commit عادي (8d3d27e)، ثم أعاد الـworkflow توليد النشرات تلقائياً (447952a)، وتحقّق Claude من نشر GitHub Pages وأن كل نشرة تعرض سطراً واحداً لماستر طويل ورق وسطراً واحداً لماستر قصير أزرق. لم يُلمس PR #37.
- Handoff UTC: 2026-08-01T10:16:04Z
## 2026-08-01 - Claude - إصلاح 10 ملاحظات مراجعة المالك على PR #37 (مسودة، لم تُدمج)

- Status: pushed, awaiting fresh independent Codex review (لا يزال Draft)
- Branch: feature/sales-purchase-returns (PR #37: https://github.com/fhwvtqdc2q-svg/tobacco-web/pull/37)
- Commit: `16e09c6` "fix(returns): إصلاح 10 ملاحظات مراجعة المالك على PR #37"
- Result: أُصلحت العشرة ملاحظات كاملة: (1) سعر مرتجع المشتريات أصبح من سعر سطر الفاتورة
  الأصلي item.price بدل lastPrice/avgPrice، والتكلفة UnitCostPrice منفصلة تماماً؛ (2) الوحدة
  الأصلية للسطر تُحفظ كما هي بلا تحويل قسري إلى unit2؛ (3) هوية السطر أصبحت GUID الفاتورة +
  مفتاح المادة + رقم السطر بدل رقم الفاتورة وحده، ومطابقة المرتجعات السابقة عبر
  original_invoice_guid؛ (4) أُضيف حارس ذري (قفل استشاري Postgres) في مقترح SQL غير المُطبَّق
  ضد تجاوز الكمية عند التزامن؛ (5) الحقول المالية تُقفل بعد الاعتماد بمقترح SQL وبكود العميل
  معاً؛ (6) السبب أصبح إلزامياً قبل الاعتماد بالواجهة والكود وقيد SQL؛ (7) سكريبت
  discover-ameen-returns-schema.ps1 لم يعد يقرأ tools\.env ويرفض العمل صراحة إن وُجد متغير
  الكتابة بالبيئة (لم يُشغَّل)؛ (8) أُدخلت GUID السلاسل الثلاث الفعلية في
  tools/ameen-returns-config.json كما زوّدها المالك (مرتجع مبيعات
  2F20674C-2D81-45FF-A513-A0A160C3BFEE، مرتجع مبيعات مركز BA87AC60-A404-4C68-80C4-7DB1DDF6B5CF،
  مرتجع مشتريات C9ACA8FE-F50E-46EB-91AC-29EE32ACBB3E)؛ (9) مسار الاعتماد الفعلي أصبح يستدعي
  ويُثبِّت فعلياً أثر عكس الربح/التكلفة وأثر المخزون الحقيقي — لكن لا يوجد بعد دفتر تسوية
  خارجي لحساب الزبون/المورد، فالتسوية تبقى مسجّلة على مستند المرتجع نفسه فقط (مذكور بصراحة،
  غير مغلق كلياً)؛ (10) أُضيفت 6 اختبارات انحدار جديدة تغطي كل ما سبق، منها اختبار يشغّل مسار
  الاعتماد الفعلي لا دوال معزولة. `npm run check` و`git diff --check` نظيفان، وسكريبت
  الـPowerShell محلَّل وبقي UTF-8 BOM. أُضيف تعليق على PR #37 يطلب مراجعة Codex جديدة. لم
  تُطبَّق أي SQL على الإنتاج، ولم يُشغَّل أي سكريبت كتابة، ولم يُقرأ tools/.env.
- Known blocker (لتتولاه جلسة Codex منفصلة بعد إخلاء القفل): PR #37 أصبح
  `mergeStateStatus: DIRTY` / `mergeable: CONFLICTING` مقابل `main` لأن `main` تقدّم بتغييرات
  أخرى (تعارض نصي في src/app.js وindex.html). **لم يُدمج PR #37 ولم تُحل هذه التعارضات في هذا
  السجل بناءً على تعليمات المالك** — إصلاح دمج أصناف main يُترك لجلسة/فرع مستقل يتولاه Codex
  بعد إخلاء قفل المهمة أدناه. سلاسل ترقيم الأمين (البند 8 أعلاه) أصبحت معروفة ومحدَّثة، فبند
  "discover-ameen-returns-schema.ps1 لم يُشغَّل بعد" في السجل السابق (2026-07-31) لا يزال
  قائماً فقط للتحقق النهائي من صحة الاتصال الفعلي، لا لاكتشاف الـGUID (أصبحت معروفة).
- Handoff UTC: 2026-08-01T00:00:00Z (تقريبي)

## 2026-07-31 - Claude - مرتجعات المبيعات جملة/مفرق ومرتجعات المشتريات

- Status: completed
- Branch: task branch pending for: مرتجعات المبيعات جملة/مفرق ومرتجعات المشتريات
- Files: src/app.js,src/returns-calc.js
- Result: Task completed and handed off.
- Handoff UTC: 2026-07-31T03:23:51Z
## 2026-07-31 - Claude - مرتجعات المبيعات (جملة/مركز) والمشتريات — PR #37 (مسودة)

- Status: draft PR opened, awaiting review
- Branch: feature/sales-purchase-returns (PR #37: https://github.com/fhwvtqdc2q-svg/tobacco-web/pull/37)
- Files: src/returns-calc.js (جديد), src/app.js, src/supabase-client.js, scripts/check.mjs,
  supabase/returns-table.sql (جديد، مرجعي فقط)، tools/ameen-returns-config.json (جديد)،
  tools/discover-ameen-returns-schema.ps1 (جديد، قراءة فقط)، tools/sync-returns-to-ameen.ps1
  (جديد، مقفل بـ exit 1)، index.html، public/service-worker.js، .gitattributes.
- Result: تطوير كامل لواجهة مرتجعات المبيعات (جملة/مركز) والمشتريات: بحث عن الفاتورة
  الأصلية، منع تجاوز الكمية الأصلية (بعد خصم المرتجعات السابقة)، عكس ربح/تكلفة نسبي فقط،
  أثر تسوية (ذمم زبون/مورد أو استرداد نقدي من نفس الصندوق الأصلي)، دورة حالة مستند، طباعة
  PDF وسجل مستندات بتصفية وتنقل. اختبارات retCalc كاملة + عقد ربط واجهة في scripts/check.mjs
  — npm run check ناجح. اكتُشف أن git diff --check كان يُعلِّم أسطر index.html المعدَّلة
  خطأً كـ"مسافات زائدة" لأن .gitattributes لم يكن يضع whitespace=cr-at-eol لملف CRLF أصلي
  (كما هو مطبَّق على src/styles.css) — أُضيف نفس الإعداد لـ index.html، وأصبح git diff
  --check نظيفاً. لم تُطبَّق أي SQL على الإنتاج، ولم يُشغَّل أي سكريبت كتابة على الأمين.
- Blocker: اكتشاف سلاسل ترقيم الأمين الثلاث الفعلية (مرتجع مبيعات/مرتجع مبيعات مركز/مرتجع
  مشتريات) لم يتم — خدمة SQL Server كانت متوقفة وقت التطوير، فـ GUID السلاسل في
  tools/ameen-returns-config.json لا تزال null. يتطلب تشغيل discover-ameen-returns-schema.ps1
  فعلياً بعد تشغيل الخدمة ومراجعة المالك قبل أي تفعيل مستقبلي لسكريبت الكتابة المقفل.
- Handoff UTC: 2026-07-31T00:00:00Z (تقريبي)
## 2026-07-30 - Claude - إغلاق مهمة فواتير المشتريات: عرض قراءة فقط من الأمين

- Status: completed (merged)
- Branch: feat/purchase-invoices-ameen-readonly (PR #35، مدموج، الفرع محفوظ لم يُحذف)
- Files: AI_ACTIVE_TASK.json, AI_HANDOFF.md (توثيق فقط بهذا السجل — لا كود)
- Result: بعد ثماني جولات مراجعة Codex ودمج origin/main مرتين بلا force، PR #35 حُوِّل من
  Draft إلى Ready بموافقة المالك واندُمج بـmerge commit عادي `1a40f9a` (parents
  `ce503b0`/`be2df11`) في main. `npm run check` وgit diff --check نظيفان بعد الدمج،
  وworkflow "Deploy TOBACCO Web" نجح. AI_ACTIVE_TASK.json أعيد لحالة `idle` (السكيما تقبل
  فقط `idle`/`active`) مع تفريغ بيانات المهمة السابقة — لا مهمة نشطة حالياً.
- Pending: `tools/pull-purchase-invoices-from-ameen.ps1` لا يزال مقفلاً بـ`exit 1`، وملف
  `supabase/ameen-purchase-invoice-reports.sql` لا يزال مرجعياً غير مُطبَّق (يحتاج استبدال
  بريد TOBACCO_SYNC_EMAIL يدوياً قبل أي تطبيق). لم تُشغَّل أي مزامنة ولم يُقرأ tools/.env
  بهذا السجل.
- Handoff UTC: 2026-07-30T17:20:00Z

## 2026-07-30 - Codex - تحديث التصميم الخارجي لنشرات الأسعار في المعاينة وPDF العام

- Status: completed
- Branch: task branch pending for: تحديث التصميم الخارجي لنشرات الأسعار في المعاينة وPDF العام
- Files: src/app.js,src/styles.css,scripts/generate-price-lists.mjs,public/service-worker.js,AI_HANDOFF.md
- Result: تم اعتماد تخطيط النشرة المرجعي الداكن والفاتح، ثلاث صفحات، والمعسل كاملاً في الصفحة الثالثة. نجحت فحوص المشروع والتوليد والنشر الحي عبر PR #34، والكاش v427.
- Handoff UTC: 2026-07-30T13:04:27Z

## 2026-07-29 - Claude - تطوير شامل لفاتورة المشتريات ومزامنة الأمين (تطوير فقط، لا تفعيل)

- Status: completed
- Branch: task branch pending for: تطوير شامل لفاتورة المشتريات ومزامنة الأمين (تطوير فقط، لا تفعيل)
- Files: src/app.js,src/styles.css,src/supabase-client.js,supabase/purchase-invoices-table.sql,tools/
- Result: اكتمل التطوير على فرع worktree-purchase-invoices-ameen-v2 (commits 812f2f9, 8dda9aa) — migration SQL جديد غير مطبَّق، سكريبتات PowerShell جديدة غير مُشغَّلة (exit 1 مطلق)، واجهة فاتورة مشتريات كاملة، اختبارات في check.mjs. بانتظار مراجعة Codex وموافقة المالك قبل أي دمج أو تفعيل.
- Handoff UTC: 2026-07-29T17:30:12Z

## 2026-07-29 - Claude - تطوير فواتير المشتريات v2 (واجهة + مزامنة أمين مؤجَّلة)

- Status: completed (تطوير/تجهيز فقط — لا تفعيل)
- Branch: worktree-purchase-invoices-ameen-v2 (worktree منفصل، لم يُدمَج ولم يُدفَع)
- Files: src/app.js, src/purchase-invoice-calc.js (جديد), src/styles.css, src/supabase-client.js, src/number-normalizer.js, index.html, public/service-worker.js (v418), scripts/check.mjs, supabase/purchase-invoices-ameen-sync.sql (جديد، غير مُطبَّق), tools/discover-ameen-purchase-schema.ps1 (جديد، قراءة فقط)، tools/push-purchase-item-snapshot.ps1 (جديد، مقفل)، tools/sync-purchase-invoices-to-ameen.ps1 (جديد، مقفل)، tools/ameen-purchase-config.json (جديد)
- Result: تبويب «فواتير المشتريات» أصبح نظاماً كاملاً بالدولار/الليرة يحاكي نمط فاتورة المبيعات (بحث مورد+صنف بوحدات أمين حقيقية، لوحة معلومات صنف، أصناف مقترحة، عملة صريحة بلا تحويل ضمني، نقدي/آجل مع دفعة جزئية، دورة حياة 5 حالات، إجراء تصحيحي لفاتورة "مُزامَنة"، طباعة/PDF). أُضيفت أول اختبارات وحدة حقيقية (vm) لـpoCalc في scripts/check.mjs. نجح npm.cmd run check بالكامل؛ git diff --check لا يُظهر إلا تحذيرات مسافات لاحقة معروفة قديمة في src/styles.css (فرق سطر فعلي 30 سطراً فقط بعد تجاهل نهايات الأسطر)؛ لا أسرار أو .env أو سجلات في الفرق. سكريبتات الكتابة الثلاثة الجديدة تحت tools/ ما زالت مقفلة بـexit 1 غير مشروط ولم تُشغَّل ولو تجربة.
- Pending: (1) اكتشاف فعلي لأكواد BillType/GUID/حساب/صندوق الأمين عبر discover-ameen-purchase-schema.ps1 قبل أي فك قفل، (2) تطبيق supabase/purchase-invoices-ameen-sync.sql على قاعدة الإنتاج، (3) اختبار حي على iPhone فعلي (390px) لم يحدث بعد، (4) مراجعة Codex مستقلة قبل أي دمج لـmain، (5) لا دمج ولا دفع حتى إذن صريح من المستخدم.
- Handoff UTC: 2026-07-29T00:00:00Z

## 2026-07-29 - Codex - تصحيح مراجع قاعدة الأمين النشطة إلى AmnDb002

- Status: completed
- Branch: codex/ameen-db002-defaults
- Files: CLAUDE.md, AI_WORK_SYNC.md, tools/ameen-stock-query.sql, tools/setup-ameen-sync-env.ps1
- Result: ثبت الفحص القرائي أن AmnDb002 نشطة بـ402 مادة؛ حُدث الافتراضي والتوثيق وتعليق الاستعلام وسجل القرار فقط. نجح npm.cmd run check وgit diff --check وتحليل PowerShell 5.1؛ لم تُقرأ tools/.env ولم تُشغّل مزامنة ولم تُلمس قاعدة الأمين.
- Handoff UTC: 2026-07-29T15:48:27Z
## 2026-07-28 - Codex - تحديث الطباعة وPDF فوراً من الأسعار المدخلة

- Status: completed
- Branch: codex/instant-bulletin-export
- Files: src/app.js, scripts/check.mjs, public/service-worker.js
- Result: أصبحت المعاينة وPDF تحفظ تلقائياً أي أسعار معدلة غير محفوظة ثم تبني النشرة فوراً من الحالة الجديدة؛ أضيفت أزرار واضحة للدولار والسوري؛ نجحت الفحوص واختبار الواجهة ونشر Pages.
- Handoff UTC: 2026-07-28T10:10:30Z
## 2026-07-28 - Codex - تحديث النشرة تلقائياً من الأسعار اليدوية وإصلاح تغيير سعر الصرف

- Status: completed
- Branch: task branch pending for: تحديث النشرة تلقائياً من الأسعار اليدوية وإصلاح تغيير سعر الصرف
- Files: .github/workflows/generate-price-lists.yml,src/app.js,scripts/check.mjs,public/service-worker.js
- Result: اعتماد أسعار Supabase اليدوية تلقائياً كل 15 دقيقة؛ تخطي توليد PDF عند عدم وجود فرق؛ إصلاح ضياع النقرة الأولى بعد تغيير سعر الصرف؛ الفحوص والنشر وتشغيل workflow التجريبي نجحت.
- Handoff UTC: 2026-07-28T09:35:33Z
## 2026-07-28 - Codex - إصلاح حفظ وطباعة أسعار النشرة: فصل الجملة والمفرق ومعاينة فورية

- Status: completed
- Branch: task branch pending for: إصلاح حفظ وطباعة أسعار النشرة: فصل الجملة والمفرق ومعاينة فورية
- Files: src/app.js,src/styles.css,public/service-worker.js
- Result: دُمج الإصلاح في main عند 60b155d؛ نجح npm.cmd run check وgit diff --check وnode --check واختبار الهاتف والمتصفح، ونجح نشر GitHub Pages والتحقق الحي من الحقلين وأزرار المعاينة وCACHE v406.
- Handoff UTC: 2026-07-28T08:57:32Z
## 2026-07-28 10:04:50 +03:00 - Codex - مراجعة نهائية لتهريب حساب الخدمة وجرد مسارات الكتابة

- النطاق: مراجعة ساكنة فقط للنسخة الحالية من
  `tools/convert-task-to-service-account.ps1`، ثم تتبع جميع سكربتات
  `tools` التي تشغلها المهام الخمس الحرجة في
  `tools/ensure-ameen-sync.ps1` واعتمادياتها المتعدية. لم يُنفّذ أي سكربت
  تشغيلي، ولم يُنشأ حساب، ولم تُعدّل مهمة أو أسعار أو مزامنة، ولم تُقرأ
  `tools/.env`.
- هوية النسخة: SHA256
  `FA0F20550F00DC5077446EADFD7C2DD42C240C265524FCA3C282E364C7F4CC1B`،
  وعددها 224 سطراً.
- الحكم: **لا يوجد مانع يمنع الدمج ضمن الأسئلة الأربعة المطلوبة؛ الموانع
  الثلاثة السابقة أُصلحت في النسخة الحالية.**

### (أ) مانع يمنع الدمج

- لا يوجد.

### (ب) ملاحظة تُسجَّل

- لا يوجد تضمين غير مهرّب في محتوى تنفيذي مولّد: تعليق الحالة يمر عبر
  `ConvertTo-CommentSafe`، وكل قيم سكربت التراجع تمر عبر
  `ConvertTo-PsLiteral`، وكذلك سطرا `Write-Host` القابلان للنسخ. بقيت
  قيم ديناميكية خام في رسائل تشخيص بشرية مثل اسم الحساب والمهمة والمسار،
  لكنها لا تُعاد إلى parser ولا تتحول إلى أمر قابل للتنفيذ؛ أقصى أثر
  لقيمة غريبة هو تشويه العرض، لا حقن كود.
- `ConvertTo-CommentSafe` كافية لمنع الخروج من تعليق PowerShell أحادي
  السطر: تعبير .NET `\s+` طوى CR وLF وVT وFF وNEL (`U+0085`) و
  `U+2028` و`U+2029`. اختبار parser تحت Windows PowerShell 5.1 بيّن أن
  CR/LF وحدهما من الحالات المختبرة كانا ينهيان التعليق الخام، وأن
  النسخة المطوية بقيت statement واحداً بلا أخطاء أو حقن. محارف التحكم
  غير المصنفة whitespace قد تشوّه العرض بصرياً لكنها لا تنهي التعليق؛
  يمكن حذف `Cc/Cf` كتقوية عرض اختيارية لا كمانع أمني.
- جرد المهام الخمس واعتمادياتها:
  - `TOBACCO Ameen Sync`: يكتب
    `$RepoRoot\logs\ameen-sync.log`؛ ويشغّل
    `push-daily-profit.ps1` الذي يكتب `tools\logs\daily-profit-push.log`
    و`push-daily-movement.ps1` الذي يكتب
    `tools\logs\daily-movement-last-sync.txt`.
  - `TOBACCO Invoice Series Push`: يكتب
    `tools\logs\invoice-series-push.log`.
  - `TOBACCO Approved Prices Pull`: سلسلة
    `sync-approved-prices-to-ameen.ps1` تكتب CSV تحت `reports\prices`
    وسجلها تحت `tools\logs`، وتستعمل ملف تحقق من
    `[IO.Path]::GetTempFileName()` تحت `%TEMP%`. توابع الإشعار والنشر لا
    تكتب ملفات محلية.
  - `TOBACCO Customer Invoices Push`: يكتب
    `tools\logs\customer-invoices-push.log`.
  - `TOBACCO Customer Movements Push`: يكتب
    `tools\logs\customer-movements-push.log`.
  لا يوجد ضمن هذه السلاسل مسار كتابة محلي خارج
  `$RepoRoot\logs` و`tools\logs` و`reports\prices` و`%TEMP%`.
- `ameen-daily-summary.ps1` ليس سكربتاً تشغّله أي من المهام الخمس، لكنه
  يكتب تقريريه أيضاً إلى `$RepoRoot\reports\daily` إضافة إلى سجله في
  `$RepoRoot\logs`. لذلك إذا استُعمل المحوّل مستقبلاً مع مهمة الملخص
  اليومي، يلزم منح `reports\daily` صلاحية `Modify`؛ هذا لا ينقص ACL
  المطلوب للمهام الخمس الحالية.
- `ConvertTo-PsLiteral` معرّفة في السطر 69 و
  `ConvertTo-CommentSafe` في السطر 73 قبل أول استعمال لهما في الأسطر
  79-87، والتعريفان في المسار العام غير المشروط. لا يوجد فرع يصل إلى
  استعمال أي منهما قبل التعريف.
- نجح التحليل النحوي بلا تنفيذ للملف ولكل السكربتات المتعدية تحت Windows
  PowerShell `5.1.26100.8875` بلا أخطاء. الاختبارات النصية شُغّلت عبر
  `-EncodedCommand` في الذاكرة ولم يُنشأ أي ملف اختبار؛ الملف محل
  المراجعة نفسه يبدأ بـUTF-8 BOM.
- نجح `npm.cmd run check` و`git diff --check` وفحص whitespace المنفصل
  للملف غير المتعقب. لم يحدث commit أو push أو merge. لم يُنفّذ
  `git pull --rebase` لأن الشجرة غير نظيفة مسبقاً.

## 2026-07-28 09:33:19 +03:00 - Codex - مراجعة التهريب ومسارات سجلات حساب الخدمة

- النطاق: مراجعة ساكنة فقط للنسخة الحالية من
  `tools/convert-task-to-service-account.ps1`، وتتبع مسارات الكتابة الفعلية
  لمهمتي الأسعار ومزامنة الأمين. لم يُنفّذ السكربت، ولم يُنشأ حساب، ولم
  تُعدّل مهمة أو أسعار أو مزامنة، ولم تُقرأ `tools/.env`.
- هوية النسخة: SHA256
  `665756F1D73A608429DC7AFD870AE54E0DE045624CF73201FDD8A5D73DEF0031`،
  وعددها 215 سطراً.
- الحكم: **غير جاهز للدمج؛ بقيت ثلاثة موانع ضمن معايير المراجعة المطلوبة.**

### (أ) مانع يمنع الدمج

1. **ليست كل القيم المضمّنة في `rollbackLines` محمية.** تعيينات القيم
   التنفيذية في الأسطر 77-81 تمر كلها عبر `ConvertTo-PsLiteral`، لكن سطر
   التعليق 75 ما زال يضمّن `UserId` و`LogonType` و`RunLevel` مباشرة.
   الفاصلة العليا وحدها لا تكسر تعليق PowerShell، لكن القيمة متعددة الأسطر
   تستطيع إنهاء التعليق وإدخال سطر جديد؛ كما أن شرط «كل قيمة بلا استثناء»
   غير متحقق. يلزم حذف التضمين الديناميكي من التعليق أو تنقية CR/LF
   صراحةً قبل إدراجه.
2. **أوامر `Write-Host` القابلة للنسخ ما زالت غير مهرّبة.** السطر 211
   يضع `$TaskName` داخل double quotes، والسطر 215 يفعل ذلك مع
   `$rollbackPath`. قيمة تحوي backtick أو `$()` قد تغيّر معنى الأمر عند
   نسخه وتشغيله. يلزم بناء الوسيطين بواسطة `ConvertTo-PsLiteral` أيضاً
   بدلاً من إحاطتهما بعلامتي اقتباس مزدوجتين.
3. **ACL لا يغطي سجل مهمة الأمين.** المنح الجديد
   `$RepoRoot\tools\logs` صحيح لمهمة
   `TOBACCO Approved Prices Pull`، التي تكتب
   `tools\logs\approved-prices-sync.log`، وتكتب CSV في
   `reports\prices`. لكن `register-ameen-sync-task.ps1` يمرر صراحةً
   `-LogPath $RepoRoot\logs\ameen-sync.log`، وهو أيضاً الافتراضي الفعلي
   لـ`ameen-sync-agent.ps1` عبر `..\logs`. هذا المسار لا يملك Modify ضمن
   المنح الحالي. وبما أن المحوّل يقبل أي `TaskName`، يلزم منح
   `$RepoRoot\logs` عند تحويل مهمة الأمين أو قصر السكربت والتحقق صراحةً
   من المهمة الافتراضية الوحيدة.

### (ب) ملاحظة تُسجَّل فقط

- تعريف `ConvertTo-PsLiteral` في السطر 69 يسبق أول استعمال فعلي في السطر
  77 ضمن التدفق التسلسلي؛ لا توجد مشكلة ترتيب تعريف.
- داخل سلسلة مهمة الأسعار الافتراضية لا يوجد مسار كتابة آخر في المستودع:
  السجل تحت `tools\logs` وCSV تحت `reports\prices`، وملف الفحص المؤقت
  ينشأ عبر `GetTempFileName()` خارج المستودع. داخل سلسلة مهمة الأمين،
  `push-daily-profit.ps1` وmarker الخاص بـ`push-daily-movement.ps1`
  يكتبان تحت `tools\logs` المغطى؛ المسار غير المغطى الذي بقي هو سجل
  الوكيل الجذري `$RepoRoot\logs\ameen-sync.log`.
- النسخة الاحتياطية وسكربت التراجع يُكتبان في
  `$PSScriptRoot\logs` أثناء تشغيل أداة التحويل نفسها بصلاحيات المسؤول؛
  هذا ليس مسار كتابة لحساب الخدمة بعد التحويل، لكنه يعني أن تشغيل الأداة
  من worktree يحفظ ملفي الاستعادة في worktree لا في `RepoRoot`.
- نجح التحليل النحوي بلا تنفيذ تحت Windows PowerShell
  `5.1.26100.8875` (`ParseErrors: 0`)، ونجح `npm.cmd run check` برسالة
  `Project check passed.`، ونجح `git diff --check` بلا مخرجات.
- لم يُنفّذ `git pull --rebase` لأن الشجرة كانت غير نظيفة مسبقاً
  (`AI_HANDOFF.md` معدّل والسكربت محل المراجعة غير متعقب). لم يحدث commit
  أو push أو merge.

## 2026-07-28 09:24:02 +03:00 - Codex - إعادة مراجعة تحويل المهمة بعد الإصلاحين

- النطاق: إعادة قراءة ومراجعة ساكنة للنسخة الحالية من
  `tools/convert-task-to-service-account.ps1` وتتبّع مسارات الكتابة في
  `sync-approved-prices-to-ameen.ps1` وتوابعها. لم يُنفّذ أي سكربت تشغيل،
  ولم يُنشأ حساب، ولم تُعدّل مهمة أو أسعار أو مزامنة، ولم تُقرأ
  `tools/.env`.
- هوية النسخة: SHA256
  `61850B4848F10707CA63164958584BB2D07A627FE36183143566D969E320BA66`،
  وعددها 208 أسطر. السطران 109 و110 هما التفكيك على الفواصل ثم
  `Equals(...OrdinalIgnoreCase)`؛ لا يوجد
  `-match [regex]::Escape` في الملف.
- الحكم: **غير جاهز للدمج بسبب مانع جديد واحد في سكربت التراجع.**
  المانعان السابقان نفسيهما أُصلحا ولا يتكرر الحكم القديم.

### (أ) مانع يمنع الدمج

1. **القيم المضمّنة في سكربت التراجع لا تهرّب الفاصلة العليا.** الأسطر
   72-76 تبني literals أحادية الاقتباس مباشرة من `$backupPath` و`$TaskName`
   و`$before.TaskPath` و`$before.UserId`. اسم مهمة مثل `Owner's Task` أو
   `TaskPath` مثل `\Ops'Night\` ينتج ملفاً غير صالح نحوياً. اختبار parser
   نصّي تحت Windows PowerShell 5.1 أعطى خطأين: missing string terminator
   وunexpected token، من دون إنشاء ملف أو تسجيل مهمة. يلزم مضاعفة `'` إلى
   `''` لكل قيمة قبل تضمينها، أو توليد القيم بطريقة serialization آمنة.

### (ب) ملاحظة تُسجَّل فقط

- **مطابقة SID الجديدة لا تعطي false positive ولا تحرم الحساب من الحق.**
  الإدخال القياسي `*SID` والمسافات/التبويبات الخارجية يطابقان حرفياً.
  إذا كان الإدخال اسماً مثل `MACHINE\OZKSync` أو وُجد فراغ بين `*` وSID،
  فلن يتعرف إليه الكود، لكنه يلحق `*$sid` الصحيح؛ النتيجة فشل آمن مع
  تكرار دلالي محتمل لا إسقاط للامتياز. يمكن تحسين idempotence بعمل
  `Trim()` بعد `TrimStart('*')` ومحاولة ترجمة `NTAccount` إلى SID.
- **RunLevel الأصلي يبقى ضمن XML.** مجموعة معاملات
  `Register-ScheduledTask -Xml` لا تملك معامل `-RunLevel`، وRunLevel عنصر
  داخل `Principal` في تعريف Task Scheduler؛ لذلك `-TaskPath` يختار مجلد
  التسجيل و`-User/-Password` يثبتان الاعتماد، بينما RunLevel يأتي من XML
  المصدر. السكربت يقرأ النتيجة ويطبعها، لكن لا يرمي خطأ عند اختلافها؛
  إضافة assert على UserId/LogonType/RunLevel ستكون تقوية مفيدة. لم يحصل
  تسجيل فعلي التزاماً بنطاق المراجعة.
- **تقسيم ACL يغطي كتابات مسار المزامنة الافتراضي.** التتبّع الفعلي وجد:
  CSV في `reports\prices`، والسجل في `tools\logs`، وملف تحقق مؤقت عبر
  `GetTempFileName()` خارج المستودع؛ سكربتا النشر والإشعار لا يكتبان
  ملفات محلية. لذلك ReadAndExecute على الجذر وModify على المجلدين كافيان
  في التخطيط الافتراضي، وحساب الخدمة يقرأ `tools\.env` عمداً كما يحذر
  السكربت. ملاحظة قابلية نقل: منح logs يستعمل `$PSScriptRoot\logs` بينما
  CSV يستعمل `$RepoRoot\reports\prices`؛ عند تشغيل المحوّل من worktree أو
  مع `RepoRoot` مختلف قد تُمنح Modify لمجلد logs الخطأ. الأفضل استعمال
  `$RepoRoot\tools\logs` أو التحقق أن `$PSScriptRoot` تابع لـ`RepoRoot`.
- نجح التحليل النحوي للملف الحالي تحت Windows PowerShell
  `5.1.26100.8875` بلا أخطاء. نجح `npm.cmd run check` برسالة
  `Project check passed.`، ونجح `git diff --check` بلا مخرجات، وكذلك
  فحص whitespace للملف غير المتعقّب عبر `git diff --no-index --check`.
- نُفّذ `git fetch origin main`؛ الفرع خلف `origin/main` بكوميت نشر آلي
  واحد. رفض `git pull --rebase origin main` البدء لأن الشجرة كانت غير
  نظيفة مسبقاً. لم يحدث stash أو commit أو push أو merge.

## 2026-07-28 - Codex - مراجعة تحويل مهمة إلى حساب خدمة

- النطاق: مراجعة ساكنة فقط لـ
  `tools/convert-task-to-service-account.ps1`. لم يُنفّذ السكربت، ولم يُنشأ
  حساب، ولم تُعدّل مهمة مجدولة أو أسعار أو مزامنة، ولم تُقرأ
  `tools/.env`.
- الحكم: **غير جاهز للدمج؛ يوجد مانعان يجب إصلاحهما.**

### (أ) مانع يمنع الدمج

1. **فحص وجود SID ليس مقارنةً كاملة.** السطر 76 يستعمل
   `-match [regex]::Escape($sid)` على السطر كله. لذلك SID مثل
   `...-1001` يُعد موجوداً خطأً إذا كانت القائمة تحوي `...-10010` فقط،
   فيتخطى السكربت منح `SeBatchLogonRight` للحساب المقصود. بناء السطر في
   السطر 80 صحيح من حيث صيغة INF (`*SID`) ويحافظ على القائمة الحالية،
   لكن مقاومة التكرار تحتاج تقسيم الطرف الأيمن على الفواصل، وإزالة `*`
   من كل token، ثم مقارنة SID كاملاً.
2. **أمر التراجع المطبوع غير موثوق ولا يعيد الحالة العامة السابقة.**
   السطر 160 يمرر `-User` بلا `-Password` مهما كانت قيمة
   `$before.LogonType`. إذا كانت المهمة قبل التحويل من نوع `Password`،
   فـTask Scheduler يشترط كلمة المرور وقت التسجيل، وبالتالي لا يعيد هذا
   الأمر النسخة الاحتياطية كما يدّعي. وإذا كان نوعها تفاعلياً فهو يعتمد
   ضمنياً على سلوك `-User` بدلاً من إعادة `LogonType` الملتقط صراحةً.
   يلزم طباعة مسار تراجع يفرّق حسب النوع السابق، ويطلب كلمة المرور بأمان
   عند `Password`، ويحافظ أيضاً على `TaskPath`.

### (ب) ملاحظة تُسجَّل فقط

- **INF الجزئي لا يمسح بقية حقوق المستخدمين.** الاستدعاء يقيّد التطبيق
  إلى `USER_RIGHTS`، والقالب لا يعرّف إلا `SeBatchLogonRight`؛ لذلك لا
  يعيد ضبط الحقوق الأخرى. أما قيمة هذا الحق نفسه فهي replacement كامل،
  والسكريبت يتجنب فقد الأسماء الحالية بتصدير السطر القائم ثم إلحاق SID.
  تبقى نافذة race بين التصدير والاستيراد، كما تستطيع Group Policy
  استبدال الحق لاحقاً؛ يستحسن إعادة التصدير والتحقق بعد `secedit`.
- **معالجة كلمة المرور معقولة لكنها ليست سرية بالكامل في الذاكرة.**
  `Read-Host -AsSecureString` لا يطبع الإدخال، و`ZeroFreeBSTR` موجود داخل
  `finally`، ولا يوجد في الكود إخراج لقيمة كلمة المرور. لكن
  `PtrToStringBSTR` ينشئ `System.String` managed غير قابل للمسح المضمون؛
  تعيين `$plain = $null` و`GC.Collect()` لا يضمنان تصفير النسخة. transcript
  العادي يرى prompt/نص السكربت لا القيمة الموسعة، ولا توجد رسالة خطأ
  محلية تُضمّن السر، لكن لا يمكن ضمان أن CIM/provider أو Module Logging
  مخصص لن يسجل وسيطاً حساساً. ينبغي إضافة catch برسالة منقحة، وتحرير
  `$password` بعد الاستخدام، وعدم ادعاء انعدام الأثر في الذاكرة.
- **تعديل RunLevel الثاني لا يظهر أنه يعيد المهمة إلى Interactive، لكنه
  غير ذري.** السطر 128 يثبت المستخدم وكلمة المرور أولاً، ثم السطران
  138-139 يعيدان إرسال كائن المهمة الحالي، بما فيه Principal الحالي.
  وفحص السطر 150 يرفض `LogonType` غير `Password`. مع ذلك لا يُعاد تمرير
  كلمة المرور في التحديث الثاني، ولا يوجد assert أن `UserId` ما زال
  `$machineUser` وأن `RunLevel` صار المطلوب؛ وإذا فشل التحديث الثاني تكون
  المهمة قد تحولت جزئياً. الأفضل تعديل RunLevel على الكائن ثم إجراء
  `Set-ScheduledTask` واحداً مع `-User` و`-Password`، ثم التحقق من الحقول
  الثلاثة.
- **ACL على جذر المستودع يكفي عادةً للوصول بالمسار الكامل، لا كضمان
  مطلق.** ACE من نوع `Modify` مع `ContainerInherit,ObjectInherit` وبدون
  `InheritOnly` يطبّق على الجذر وينتقل للأبناء الذين يسمحون بالوراثة.
  كون الجذر تحت ملف تعريف LOQ لا يمنع العبور افتراضياً لأن
  `SeChangeNotifyPrivilege` (Bypass traverse checking) ممنوح للمستخدمين
  عادةً. لكنه يفشل إذا سُحب هذا الحق، أو وُجد deny، أو عطّل مجلد/ملف ابن
  الوراثة. كما أن `Modify` على المستودع كله أوسع من اللازم ويمنح قراءة
  `tools/.env` وكتابة الكود؛ الأفضل ACLs محددة ومرحلة تحقق فعلية بهوية
  الحساب.
- الملف يبدأ بـUTF-8 BOM (`EF BB BF`) ونجح تحليله بلا تنفيذ تحت
  Windows PowerShell `5.1.26100.8875`.
- نجح `npm.cmd run check` برسالة `Project check passed.` (exit 0)، ونجح
  `git diff --check` بلا مخرجات (exit 0). ولأن السكربت غير متعقب، شُغّل
  أيضاً `git diff --no-index --check` عليه ولم يسجل خطأ whitespace.
- لم يُنفّذ `git pull --rebase` لأن الشجرة غير نظيفة مسبقاً والملف محل
  المراجعة untracked. لم يحدث commit أو push أو merge.

## 2026-07-28 - Codex - مراجعة نهائية لـcanonical path وhardlink في حارس الأمين

- النطاق: مراجعة مستقلة للنسخة الحالية من
  `tools/register-ameen-sync-watchdog.ps1`، وتحديداً
  `Get-CanonicalWatchdogPath` وفحص `fsutil hardlink list`.
- الحكم: **جاهز للدمج ضمن النطاق المطلوب؛ لا يوجد مانع يمنع الدمج.**

### (أ) مانع يمنع الدمج

- **لا يوجد.** بناء المسار مقطعاً مقطعاً يعيد أسماء القرص الفعلية، ويفرض
  تطابقاً `Ordinal` عند وجود أكثر من مرشح يختلف بالحالة، ثم يقارن المسار
  القانوني كله حرفياً بقائمة السماح. هذا يغلق حالة وجود اسمين مختلفين
  بالحالة داخل مجلد case-sensitive، ولا يقبل worktree أو junction أو subst
  كهوية بديلة للملف المعتمد.
- مقارنة `Ordinal` لا تكسر استدعاءً مشروعاً باختلاف حالة الأحرف على المسار
  الحالي غير الحساس للحالة: جُرّب المسار كله بحروف صغيرة، فاحتفظ
  `FileInfo.FullName` بحالة المستدعي ثم أعادت الدالة الحالة الفعلية لكل مقطع
  وانتهت إلى المسار الأصلي. أما داخل مجلد case-sensitive فاختلاف الحالة
  يعني اسماً آخر أو اسماً غير موجود، ورفضه هو السلوك المطلوب.
- قراءة `$LASTEXITCODE` صحيحة لأنها تأتي مباشرة بعد `fsutil`. في اختبار
  نجاح القراءة فقط كانت القيمة `0`، وفي اختبار ملف مفقود داخل
  Windows PowerShell وصلت السيطرة إلى السطر التالي وكانت القيمة `1`.

### (ب) ملاحظة تُسجَّل فقط

- عدّ الروابط يعتمد على أن كل سطر غير فارغ من مخرج
  `fsutil hardlink list` هو رابط. المخرج الفعلي على هذا الجهاز كان سطراً
  واحداً يحوي المسار فقط، بلا ترويسة، ونجح برمز `0`. لو أضاف إصدار أو لغة
  أخرى ترويسة/سطر معلومات فسيُعدّ كرابط إضافي ويؤدي إلى **رفض آمن كاذب**
  (fail closed)، لا إلى قبول ملف متعدد الروابط. لذلك تحسين parser مفيد
  للتوافق، لكنه ليس مانعاً أمنياً.
- الحالات القديمة تبقى مرفوضة من ناحية الهوية: مسار worktree يفشل في
  مقارنة قائمة السماح؛ النسبي العادي يفشل `IsPathRooted`؛ UNC يُرفض قبل
  الحل؛ المجلد يفشل `PSIsContainer`؛ ADS لا ينتج `FullName` صالحاً للدالة؛
  junction/symlink يفشل `ReparsePoint`؛ وsubst يبقى بحرف محرك مختلف ثم
  يفشل المقارنة الحرفية. المساران الحرفيان `/` و`..` يُرفضان أيضاً لأنهما
  مجلد ونسبي على الترتيب.
- تنبيه دقة لا يغير الحكم الأمني: `Path.IsPathRooted` يقبل صيغة Windows
  النسبية إلى محرك مثل `C:tools\...`، كما أن `/` كفاصل و`..` داخل مسار مطلق
  يُطبّعان بواسطة `Get-Item`. إذا انتهت هذه الصيغ إلى **الملف المسموح نفسه**
  فسوف تُقبل؛ لا يمكنها اختيار ملف آخر بسبب المقارنة النهائية `Ordinal`.
  إن كان العقد المطلوب هو رفض الكتابة البديلة نفسها لا رفض الهوية البديلة،
  فينبغي استعمال `Path.IsPathFullyQualified` ورفض المقاطع/الفواصل قبل
  `Get-Item`، لكنه hardening شكلي لا مانع دمج في قائمة السماح الحالية.
- حالة case sensitivity الفعلية كانت `disabled` لكل مقاطع المسار من `C:\`
  حتى مجلد `tools`. ومع ذلك راجعت الدالة حالة التصادم المستقبلية ولا تعتمد
  على بقاء هذا الإعداد معطلاً.
- نجح PowerShell parser بلا أخطاء. نجح `npm.cmd run check` برسالة
  `Project check passed.` (exit 0)، ونجح `git diff --check` بلا مخرجات
  (exit 0). الملفان ما زالا untracked، لذلك `git diff --check` لا يفحص
  محتواهما غير المتعقب.
- لم يُنفّذ `git pull --rebase` لأن الشجرة كانت غير نظيفة مسبقاً
  (`AI_HANDOFF.md` معدل والملفان جديدان)، تفادياً لخلط عمل قائم. لم تُسجّل
  مهمة ولم يُشغّل الحارس أو أي مزامنة، ولم تُكتب بيانات في الأمين أو
  Supabase، ولم تُقرأ `tools/.env`، ولم يُنفّذ commit أو push أو merge.

## 2026-07-28 - Codex - مراجعة مستقلة لقائمة سماح حارس مزامنة الأمين

- الملفات المراجعة: `tools/register-ameen-sync-watchdog.ps1` و
  `tools/ensure-ameen-sync.ps1`.
- الحكم: **غير جاهز للدمج؛ تبقى ثغرة هوية ملف في قائمة السماح الصارمة.**
- الحدود: لم تُسجّل مهمة، ولم يُشغّل الحارس أو أي مزامنة، ولم تُقرأ
  `tools/.env`، ولم يحدث commit أو push أو merge.

### (أ) مانع يمنع الدمج

1. **الـhardlink غير مكتشف.** فحص `ReparsePoint` في الأسطر 49-57 لا يكشف
   hardlinks. يمكن أن يكون الاسم المعتمد نفسه hardlink لملف له اسم آخر خارج
   الشجرة؛ عندها يمر `FullName` وتبقى وسائط المهمة حاملة للمسار المعتمد،
   لكن يمكن تعديل المحتوى الذي ستنفذه المهمة لاحقاً عبر الاسم الخارجي، من
   دون الكتابة داخل مجلد `tools`. لذلك لا تكفي صلاحيات مجلد `tools` وحدها
   لتغطية الادعاء في الأسطر 65-67. يلزم التحقق من file identity/link count
   عبر handle ورفض تعدد الروابط، أو ضمان سلامة الملف وقت كل تشغيل بآلية
   موثوقة.
2. **المقارنة `OrdinalIgnoreCase` تقبل ملفاً آخر إذا أصبحت أي مرحلة من
   السلسلة case-sensitive.** على الوضع الحالي كل المجلدات المفحوصة تعطّل
   case sensitivity، ولذلك اختلاف الحالة يشير للملف نفسه الآن. لكن الكود
   لا يتحقق من هذا الشرط؛ في مجلد case-sensitive يمكن إنشاء اسم مختلف
   بالحالة فقط، ويمر السطر 43 ثم يوضع ذلك الاسم الفعلي في المهمة. لقائمة
   سماح صارمة ينبغي استعمال مطابقة ordinal دقيقة للمسار canonical المعتمد
   أو إثبات أن السلسلة كلها case-insensitive قبل قبول المقارنة الحالية.

### (ب) ملاحظة تُسجَّل فقط

- 8.3 لا يفتح تجاوزاً في الاختبار الحالي: `Get-Item(...).FullName` وسّع
  المسار القصير إلى الاسم الطويل نفسه، ثم تُستخدم القيمة الموسّعة.
- ADS لا يفتح تجاوزاً: named stream غير الموجود يفشل، وصيغة
  `::$DATA` لم تنتج `FullName` يساوي القائمة، فتفشل بأمان. وحتى لو قُبل
  input alias، فإن السطر 70 يبني `-File` من `$resolvedWatchdogPath` لا من
  `$WatchdogPath`.
- المسار مقتبس في `-File`؛ المسافات و`&` تبقيانه وسيطاً واحداً. والسطر 70
  يستخدم فعلياً `$resolvedWatchdogPath`.
- المسار المعتمد في المستودع الأساسي غير موجود حالياً، ولذلك محاولة
  التسجيل من هذه الحالة تفشل بأمان عند الأسطر 31-34 إلى أن يوجد الملف في
  موضعه المعتمد.
- بقيت نافذة TOCTOU الموثقة في الأسطر 65-67: حتى بعد فحص آمن وقت التسجيل،
  تعيد المهمة حل الاسم عند كل تشغيل لاحق.
- `tools/ensure-ameen-sync.ps1` لم يُشغّل؛ اكتفى الفحص بالقراءة والتحليل
  النحوي (`PARSE=OK` للملفين).
- التحقق: `npm.cmd run check` نجح (`Project check passed`, exit 0)، و
  `git diff --check` نجح بلا مخرجات (exit 0). الملفان ما زالا untracked،
  لذا نجاح `git diff --check` وحده لا يفحص محتواهما غير المتعقب.

## 2026-07-28 - Codex - مراجعة canonicalization لمسار حارس مزامنة الأمين

- الملفات المراجعة: `tools/register-ameen-sync-watchdog.ps1` و
  `tools/ensure-ameen-sync.ps1`.
- الحكم: **غير جاهز للدمج؛ بقي مانع واحد في التحقق من الهوية النهائية
  للمسار.**

### مانع يمنع الدمج

1. **`Resolve-Path.ProviderPath` يطبّع الكتابة الظاهرية للمسار، لكنه لا يحل
   aliases نظام الملفات إلى الهدف النهائي؛ لذلك ما زال رفض الـworktree
   قابلاً للتجاوز.** الشرط في
   `tools/register-ameen-sync-watchdog.ps1:20-25` نجح مع المسار المباشر
   ومع اختلاف حالة الأحرف، لكنه فشل فعلياً في الحالات التالية، وكلها وصلت
   إلى `tools/ensure-ameen-sync.ps1` الموجود داخل الـworktree الحالي:

   | الحالة | `ProviderPath` بعد `Resolve-Path` | نتيجة الرفض |
   |---|---|---|
   | junction خارج المستودع يشير إلى الـworktree | بقي مسار الـjunction الخارجي | `False` |
   | directory symlink خارج المستودع يشير إلى الـworktree | بقي مسار الـsymlink الخارجي | `False` |
   | محرك `subst` يشير إلى الـworktree | بقي `Z:\tools\...` | `False` |
   | مسار 8.3 قصير | بقي `...\CLAUDE~1\WORKTR~1\...` | `False` |

   مسار UNC الإداري المباشر
   `\\localhost\c$\...\.claude\worktrees\...` رُفض لأنه ما زال يحمل
   المقطعين نصياً، لكن مشاركة UNC يكون جذرها داخل الـworktree أو فوقه باسم
   alias يخفي هذين المقطعين ستتجاوز الفحص للسبب نفسه: `ProviderPath` يحتفظ
   باسم المشاركة ولا يكشف المسار المحلي النهائي على الخادم.

   المطلوب ألا يعتمد قرار الأمان على regex للمسار الظاهري. بما أن العقد
   يقول إن المهمة تشير دائماً إلى نسخة المستودع الأساسي، فالخيار الأبسط
   هو allowlist صارمة للملف المتوقع في المستودع الأساسي مع رفض UNC ومحركات
   الشبكة، والتحقق من `FileSystem` و`PathType Leaf`. وإذا أريد قبول aliases
   محلية، فيلزم فتح الملف ثم استعمال canonical path/file identity من handle
   يحل reparse points و`subst` و8.3، ومقارنته بهوية ملف المستودع الأساسي.

### ملاحظة تُسجَّل

- **حساسية حالة الأحرف سليمة:** عامل PowerShell `-match` غير حساس للحالة
  افتراضياً؛ المسار المحوّل إلى uppercase رُفض فعلياً.
- **ترتيب `Test-Path` ثم `Resolve-Path` يفشل بأمان عند ملف مفقود، لكنه ليس
  تحققاً قوياً.** إذا اختفى الملف بعد `Test-Path` يرمي `Resolve-Path` تحت
  `ErrorActionPreference=Stop` ولا تُسجّل المهمة، لذلك لا يوجد bypass من
  هذه النافذة وحدها. لكنه يبقي TOCTOU، ولا يطلب `-PathType Leaf`، ولا يثبت
  أن المزود `FileSystem`. والأهم أن الهدف يمكن تبديله عبر reparse point
  بعد الحل وقبل تشغيل المهمة لاحقاً. الأفضل حل/فتح الهدف مرة واحدة،
  التحقق من الملف عبر handle، ثم بناء القرار من الهوية النهائية نفسها؛
  وجود `Test-Path` المنفصل ليس ضماناً أمنياً.
- **اقتباس مسار `-File` سليم للمسارات العادية ذات المسافات والمحارف
  الخاصة.** تفكيك command line وفق قواعد Windows أعاد المسار ذي المسافات
  و`&` وسيطاً واحداً مطابقاً تماماً. علامة الاقتباس المزدوجة نفسها محرف
  غير صالح في اسم ملف Windows، فلا توجد حالة ملف `FileSystem` مشروع تحتاج
  escaping لها. مع ذلك يلزم تقييد المزود إلى `FileSystem` وملف leaf حتى
  يكون هذا الافتراض صريحاً. أما `$SqlHost` فيُضمّن بلا اقتباس أو validation؛
  القيمة الافتراضية آمنة، وتبقى قيمة مخصصة ذات مسافات/اقتباس عرضة لكسر
  argument binding، لذا يفضّل تقييدها إلى hostname أو IP صالح.
- **`tools/ensure-ameen-sync.ps1` لم يظهر فيه انكسار جديد في المراجعة
  السريعة:** نجح PowerShell parser بلا أخطاء، وما زال يميّز
  `0` و`0x41301` و`0x41303`، ويرفض المهمة العالقة القديمة، ويتحقق من
  `LastRunTime` بعد طلب التشغيل، ولا يكتب `ALERT sent` بلا
  `TELEGRAM-NOTIFY OK`. لم يُشغّل السكربت لأن تشغيله قد يعيد تشغيل مهام
  المزامنة ويكتب إلى Supabase، وهو خارج نطاق المراجعة الآمنة.
- نجح PowerShell parser للملفين. الاختبارات الخاصة بالمسارات استعملت
  junction وsymlink و`subst` مؤقتة خارج المستودع ثم أزيلت؛ لم تُسجّل مهمة
  مجدولة. نجح أيضاً `npm.cmd run check` برسالة `Project check passed.`،
  ونجح `git diff --check`.
- لم يُنفّذ `git pull --rebase` لأن الشجرة كانت غير نظيفة مسبقاً
  (`AI_HANDOFF.md` معدل والملفان جديدان)، تفادياً للمساس بعمل الجلسة
  الحالية.
- لم تُشغّل أي مزامنة، ولم تُكتب بيانات في الأمين أو Supabase، ولم يُقرأ
  `tools/.env`، ولم يُنفّذ commit أو push أو merge، ولم يُعدّل أي سعر.

## 2026-07-28 - Codex - إعادة مراجعة حارس مزامنة الأمين بعد الإصلاحات

- الملفات المراجعة: `tools/ensure-ameen-sync.ps1` و
  `tools/register-ameen-sync-watchdog.ps1`، مع قراءة عقد المخرجات في
  `tools/send-telegram-notification.ps1` فقط.
- الحكم: **غير جاهز للدمج بسبب مانع واحد متبقٍ في رفض مسار الـworktree.**

### مانع يمنع الدمج

1. **رفض مسار الـworktree ما زال قابلاً للتجاوز لأنه يفحص النص الخام قبل
   تطبيع المسار.** الشرط الحالي في
   `register-ameen-sync-watchdog.ps1:18-23` يرفض فقط النص الذي يطابق
   `\.claude\worktrees\` بشرطات Windows. ثبت قراءةً فقط أن القيمتين
   `.\tools\ensure-ameen-sync.ps1` و`./tools/ensure-ameen-sync.ps1` موجودتان
   وتُحلّان إلى ملف داخل الـworktree الحالي، لكن `RegexReject=False` لهما.
   وكذلك قُبل نص مسار worktree مطلق يستخدم `/`. في الحالة النسبية تُحفظ
   القيمة النسبية نفسها في Action المهمة، فتُفسر لاحقاً من working directory
   مختلف وقد تنكسر؛ وفي حالة `/` تبقى المهمة مرتبطة فعلياً بمجلد مؤقت قابل
   للحذف. المطلوب أولاً حلّ `WatchdogPath` إلى مسار Windows مطلق canonical،
   ثم إجراء الرفض على المسار المحلول، ثم تمرير ذلك المسار المطلق نفسه إلى
   `powershell.exe`.

### ملاحظة تُسجَّل

- **تمييز النتائج صار صحيحاً:** `0` نجاح مكتمل،
  `267009 = 0x00041301` قيد التشغيل، و
  `267011 = 0x00041303` لم تعمل بعد. لا تُقبل `0x41303` كنجاح؛ تُطلب
  إعادة التشغيل ثم تُفحص النتيجة مجدداً.
- **منطق العالقة سليم عملياً:** إذا كانت النتيجة `0x41301` وكان
  `LastRunTime` أقدم من حد المهمة، تُسجّل المهمة عالقة ولا يُطلب تشغيل جديد
  لن يفيد مع `MultipleInstances=IgnoreNew`. أما التشغيل الحديث فلا يُعد
  عطلاً.
- **التحقق بعد طلب التشغيل سليم تشغيلياً:** ينتظر 30 ثانية، ويتطلب
  `LastRunTime >= attemptedAt - 5 seconds` مع نتيجة `0` أو `0x41301`.
  هامش الخمس ثواني يعني بدقة أنه يقبل تشغيلاً بدأ خلال خمس ثوانٍ قبل لحظة
  الطلب أيضاً، لا أنه يثبت السببية الحرفية «بدأ بسبب الطلب». هذا مقبول
  كدليل عافية حديثة وليس مانعاً؛ إن أريد إثبات السببية الصارم فيلزم حفظ
  `LastRunTime` السابق وإثبات تغيّره.
- **ثغرة وسيط `C:\tmp` أزيلت من مسار التنفيذ الافتراضي:** السكربت لا ينشئ
  CMD/VBS ويستدعي
  `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` مباشرة.
  الفحص الحالي أكد أن
  `C:\tmp\tobacco-sync-watchdog.cmd` و
  `C:\tmp\tobacco-sync-watchdog.vbs` غير موجودين. الاستدعاء المباشر آمن
  بالنسبة للمسار الافتراضي المطلق والمقتبس، ويبقى تطبيع
  `WatchdogPath` هو المانع أعلاه. يفضّل أيضاً تقييد `SqlHost` إلى hostname
  أو IP صالح لتفادي argument binding غير مقصود عند تمرير قيمة مخصصة.
- **تسجيل تيليغرام صار مطابقاً لعقد الأداة:** لا تُكتب `ALERT sent` إلا إذا
  احتوت مخرجات أداة الإرسال على `TELEGRAM-NOTIFY OK`، وهو النص الذي لا
  تطبعه الأداة إلا بعد نجاح استدعاء RPC. حالات `SKIPPED` و`FAILED` تسجّل
  `ALERT NOT sent`. هذا يثبت قبول/صفّ الطلب في Supabase، لا وصول الرسالة
  النهائي من `pg_cron` إلى تطبيق تيليغرام؛ لذلك الوصف الأدق تشغيلياً هو
  accepted/queued إن أريد التفريق، لكنه ليس مانعاً ضمن العقد المطلوب.
- **`LogonType=Interactive` ملاحظة مقصودة وليست مانعاً** وفق قرار المالك:
  المهام التسع كلها تعمل بهذا النمط، وتحويلها يحتاج قراراً موحداً منفصلاً.
- المهمة `TOBACCO Sync Watchdog` غير مسجلة حالياً، ونسخة المسار الأساسي
  `C:\Users\LOQ\Documents\OZK-TOBACCO\tobacco-web\tools\ensure-ameen-sync.ps1`
  غير موجودة بعد؛ لذلك لم يُجرّب التسجيل الفعلي، وهو متوقع قبل الدمج.
- نجح PowerShell parser للملفين، ونجح `npm.cmd run check` برسالة
  `Project check passed.`، ونجح `git diff --check`.
- لم يُنفّذ `git pull --rebase` لأن الشجرة كانت غير نظيفة مسبقاً
  (`AI_HANDOFF.md` معدل والملفان جديدان)، تفادياً للمساس بعمل الجلسة
  الحالية.
- لم تُشغّل أي مزامنة أو مهمة مجدولة، ولم تُكتب بيانات في الأمين أو
  Supabase، ولم يُقرأ `tools/.env`، ولم يُنفّذ commit أو push أو merge،
  ولم يُعدّل أي سعر.

## 2026-07-28 - Codex - مراجعة مستقلة لحارس مزامنة الأمين

- الملفات المراجعة: `tools/ensure-ameen-sync.ps1` و
  `tools/register-ameen-sync-watchdog.ps1`.
- البيئة المتحققة قراءةً فقط: الجهاز `OZK2026`، المستخدم `OZK2026\LOQ`،
  وخادم SQL المقصود `OZK-TOBACCO:1433`.
- الحكم: **غير جاهز للدمج** قبل معالجة الموانع أدناه.

### مانع يمنع الدمج

1. **قبول `267009` و`267011` يخفي فشل الإحياء.**
   `0x00041301` يعني أن المهمة ما زالت تعمل، لا أن تشغيلها اكتمل بنجاح،
   و`0x00041303` يعني أنها لم تعمل بعد. مع ذلك يقبلهما الفحص بعد مهلة
   30 ثانية ويكتب `task revived` (`ensure-ameen-sync.ps1:35-36,95-106`).
   وبما أن المهام مضبوطة `MultipleInstances=IgnoreNew`، فإن محاولة تشغيل
   مهمة معلّقة قد لا تنشئ نسخة جديدة، ثم تُعدّ النسخة القديمة ناجحة. هذا
   خطر فعلي خصوصاً أن مهمة `TOBACCO Ameen Sync` الحالية حد تنفيذها `PT72H`.
   المطلوب اعتبار `0` نجاحاً لا لبس فيه فقط بعد اكتمال تشغيل جديد، ومعالجة
   `267009` كحالة مؤقتة بحد زمني والتحقق من تغيّر `LastRunTime`/الحالة،
   واعتبار بقاء `267011` بعد محاولة التشغيل فشلاً.

2. **المهمة الحالية مرتبطة بالـworktree المؤقت وبسلسلة تشغيل قابلة للتعديل.**
   سكربت التسجيل يضمّن `$watchdogPath` المطلق داخل
   `C:\tmp\tobacco-sync-watchdog.cmd` (`register-ameen-sync-watchdog.ps1:12-35`).
   الملف الفعلي الآن يشير إلى
   `.claude\worktrees\fervent-northcutt-e92aad\tools\ensure-ameen-sync.ps1`؛
   حذف الـworktree سيكسر الحارس. كذلك ACL الفعلي لـ`C:\tmp` يمنح
   `Authenticated Users` صلاحية `Modify`، فتستطيع عملية محلية أخرى استبدال
   ملفي CMD/VBS اللذين تنفذهما المهمة. المطلوب منع التسجيل من worktree
   وتثبيت المسار على النسخة الأساسية، وإزالة الوسيط القابل للكتابة أو وضعه
   في مسار محمي بصلاحيات ضيقة.

3. **الحارس لا يعمل بعد خروج LOQ من الجلسة.**
   التسجيل لا يحدد `Principal` أو `LogonType` أو `RunLevel`
   (`register-ameen-sync-watchdog.ps1:53-54`). القراءة الفعلية للمهمة الحالية
   أظهرت `UserId=LOQ`, `LogonType=Interactive`, `RunLevel=Limited`.
   لذلك بعد logoff أو إعادة التشغيل وقبل دخول LOQ لا يعمل الحارس، فلا
   يستطيع اكتشاف توقف أي مهمة أو إرسال إنذار. يجب تسجيل principal صريح
   مناسب للتشغيل غير التفاعلي مع مراعاة أن الوصول الشبكي إلى
   `OZK-TOBACCO` يحتاج نوع دخول يحتفظ بصلاحيات الشبكة، وتحديد RunLevel
   المقصود صراحةً.

4. **نجاح إرسال الإنذار غير متحقق ويُسجّل بصورة مضللة.**
   الحارس يستدعي `send-telegram-notification.ps1` ثم يكتب دائماً
   `ALERT sent` (`ensure-ameen-sync.ps1:117-122`)، بينما أداة الإرسال
   الحالية تتعمد إنهاء التنفيذ بالرمز `0` عند غياب بيانات الدخول أو فشل
   المصادقة/الشبكة. النتيجة الممكنة: لا تصل أي رسالة ويؤكد السجل أنها
   أُرسلت. يلزم مسار إرسال يعيد نتيجة قابلة للتحقق، وألا يسجّل الحارس
   «أُرسل» إلا بعد إقرار نجاح حقيقي.

### ملاحظة تُسجَّل

- القيم الرقمية صحيحة: `267009 = 0x00041301` (قيد التشغيل) و
  `267011 = 0x00041303` (لم تعمل بعد)، لكنهما حالتا Scheduler وليستا
  نتيجة نجاح مكافئة للرمز `0`.
- تعيين `Repetition.Duration = ""` سليم للتكرار غير المحدود على هذا الجهاز:
  النموذج في الذاكرة احتفظ بمدة فارغة، والمهمة المسجلة فعلياً تعرض
  `RepetitionDuration=null` مع `NextRunTime` دوري كل خمس دقائق. لا يوجد
  مانع في هذه النقطة.
- الحدود الثابتة `20` دقيقة لا تطابق القيم الافتراضية في مسجّلي
  `Customer Invoices` (كل 60 دقيقة) و`Customer Movements` (كل 30 دقيقة).
  المهام الحية الآن كل خمس دقائق، لذلك لا يظهر الإنذار الكاذب حالياً؛ لكن
  إعادة تسجيل أي منهما بالقيمة الافتراضية ستجعل الحارس يشغّل مهمة سليمة
  قبل موعدها باستمرار. الأفضل اشتقاق الحد من trigger الفعلي أو توحيد
  الإعدادات.
- مفتاح منع التكرار ثابت لكل الأعطال لمدة ساعة؛ عطل جديد مختلف خلال ساعة
  من عطل سابق قد يُحجب. يفضّل أن يتضمن المفتاح فئة العطل/اسم المهمة.
- فحص TCP إلى `OZK-TOBACCO:1433` مناسب لإثبات الوصول إلى المنفذ ولا يكشف
  وحده جاهزية SQL أو نجاح المصادقة/الاستعلام؛ يلزم ألا يوصف وحده بأنه تحقق
  من حياة سلسلة المزامنة.
- لم يظهر تسريب سر مباشر في السجل أو رسالة تيليغرام: المحتوى يقتصر على
  اسم الجهاز/الخادم والمنفذ وأسماء المهام والأعمار وأكواد النتائج ورسائل
  أخطاء Scheduler. سجل `tools/logs/` مستبعد من Git. تبقى هذه معلومات
  تشغيلية داخلية ويجب إبقاء قناة تيليغرام مقيدة بالمالك.
- نجح محلل PowerShell للملفين بلا أخطاء. صياغة CMD/VBS الناتجة صحيحة
  للمسارات الحالية، لكن `$SqlHost` يُضمّن في CMD بلا quoting أو تحقق؛
  القيمة الافتراضية آمنة، أما قبول قيمة مخصصة فيستحسن تقييده باسم
  DNS/عنوان IP صالح.
- لم يُنفّذ `git pull --rebase` لأن الشجرة كانت غير نظيفة مسبقاً
  (`AI_HANDOFF.md` معدل والملفان جديدان)، تفادياً للمساس بعمل جلسة أخرى.
- لم تُشغّل أي مزامنة أو مهمة مجدولة، ولم تُكتب بيانات في الأمين أو
  Supabase، ولم يُقرأ `tools/.env`، ولم يُنفّذ commit أو push أو merge،
  ولم يُعدّل أي سعر.

## 2026-07-27 - Codex - مراجعة `e5124fa` لحذف الصفحة البيضاء وتجميع الذيل

- SHA المراجع فعلياً: `e5124fa449375029dedad714c42fed00f3376e4c`.
- الأب المباشر: `0c5cfa53ec00eae05f68d68d4887739e846018f0`.
- ناتج `git rev-parse HEAD` عند المراجعة:
  `e5124fa449375029dedad714c42fed00f3376e4c`.
- الفرع: `claude/pdf-ios-hardening`.
- الحكم: **جاهز للدمج — لا يوجد مانع يمنع الدمج في النطاق المطلوب.**

### نتائج الأحجام المطلوبة — دقة الهاتف `1.5`

| الأصناف | الصفحات النهائية | صفحة بيضاء | صف/كتلة مقسومة | المجاميع والتذييل |
|---:|---:|---|---|---|
| 20 | 1 | لا | لا | كلاهما في الأولى داخل `pdf-tail` |
| 24 | 1 | لا | لا | كلاهما في الأولى؛ حُذفت الثانية البيضاء |
| 25 | 2 | لا | لا | كلاهما معاً في الثانية |
| 26 | 2 | لا | لا | كلاهما معاً في الثانية |
| 28 | 2 | لا | لا | كلاهما معاً في الثانية |
| 30 | 2 | لا | لا | كلاهما معاً في الثانية |
| 31 | 2 | لا | لا | كلاهما معاً في الثانية |
| 40 | 2 | لا | لا | كلاهما معاً في الثانية |

### مانع يمنع الدمج

- **لا يوجد.** لم يعبر أي `tr` أو `.pdf-tail` أو `.pdf-summary` أو
  `.pdf-foot` حد صفحة في الحالات المطلوبة، ولم تبق صفحة بيضاء بعد الحذف.

### ملاحظة تُسجَّل

- فاتورة 24 صنفاً كانت صفحتين قبل التنظيف؛ شريحة الصفحة الثانية 11 بكسل
  بيضاء بنسبة حبر `0`، فحذفها `pdf.deletePage` وصار الملف صفحة A4 واحدة.
  الفحص البصري للـPDF المرندر أكد عدم وجود الورقة البيضاء.
- عند 25 صنفاً انتقلت المجاميع والتذييل معاً إلى الصفحة الثانية. الفراغ أسفل
  الأولى `276px`، أي `17.08%` أو نحو `48.7mm`. هو ملحوظ لكنه لا يجعل الصفحة
  شبه فارغة: جدول الأصناف يملأ قرابة 83% منها، والفحص البصري أظهر توزيعاً
  طبيعياً (25 صفاً في الأولى والذيل كاملاً في الثانية).
- فراغ الصفحة الأولى يتناقص إلى `14.36%` عند 26، و`8.97%` عند 28،
  و`3.59%` عند 30، و`0.93%` عند 31 و40.
- حذف الصفحة لا يبتلع محتوى خفيفاً مشروعاً:
  - صف وحيد في آخر صفحة: نسبة الحبر `8.25%` عند دقة 1.5 و`7.77%` عند 2.
  - تذييل وحيد: `7.55%` عند 1.5 و`6.44%` عند 2.
  - حالة التذييل الوحيد الفعلية من الأب بقيت بنسبة `4.46%`.
  القيم كلها بعيدة جداً عن عتبة الحذف `0.05%`.
- حساب الدقة صحيح مع المقياسين:
  - الهاتف: اللوحة `1123px`، `pxPerMm=5.6717`، وارتفاع الصفحة المحسوب
    `1616.439px` مقابل حد العامل `1616px`.
  - الابتوب: اللوحة `1498px`، `pxPerMm=7.5657`، والمحسوب `2156.212px`
    مقابل حد العامل `2156px`.
  استخدام `Math.floor` داخل `canvasInkRatio` يشمل بكسل الحد ولا يترك فجوة.
- `pdf.output("blob")` أعاد `Blob` بنوع `application/pdf` وتوقيع `%PDF-`.
  حجمه مطابق تماماً لـ`worker.outputPdf("blob")` من كائن PDF نفسه، وعدد
  الصفحات ومقاس A4 والهوامش بقيت صحيحة.
- فاتورة الصنف الواحد سليمة: صفحة واحدة، قماش `1123×627`، ونسبة حبر
  `12.02%` وملف `89,249` بايت.
- في ست جولات لفاتورة 40 صنفاً كان الحجم مطابقاً للأب (`403,316` بايت)،
  ووسيط الزمن `194.0ms` للأب مقابل `194.6ms` للحالي (+`0.31%`)؛ لا تضخم.
- عند تعذّر قراءة حبر الشريحة تعيد الدالة `1`، فتُبقي الصفحة بدلاً من المخاطرة
  بحذف محتوى مشروع؛ هذا فشل آمن للحذف وإن كان قد يترك بياضاً في حالة نادرة.
- فرق `src/app.js` محصور في `canvasInkRatio`, `pdf-tail`، وتنظيف آخر صفحة.
  قوالب الطباعة الأخرى، وفاتورة الرول، و`exportBulletinPdf` ودوال النشرة
  متطابقة مع الأب ولم تتأثر.
- `node --check src/app.js`، و`npm.cmd run check`، و
  `git diff --check 0c5cfa5 e5124fa`: ناجحة.
- لم يُنفّذ commit أو push أو merge، ولم يُعدّل سعر أو رصيد، ولم تُشغّل
  مزامنة أو كتابة في الأمين أو Supabase.

## 2026-07-27 - Claude - دمج ونشر إصلاح تصدير PDF (`bdebe1c`)

- Status: **مدموج في `main` ومنشور ومُتحقَّق منه على الموقع الحيّ.** لا تعديل
  أسعار ولا مزامنة ولا كتابة في الأمين أو Supabase ولا دفع قسري.

### ما أُصلح (العطل الذي بلّغ عنه المالك بملف 3 ك.ب فارغ)

- **السبب الجذري:** تمرير حاوية `position:absolute` إلى html2canvas يُنتج لوحة
  بارتفاع صفر. صار يُمرَّر العنصر الداخلي.
- **سبب ثانٍ مستقل:** تمرير الصفحة للأسفل يُفشل الالتقاط. صار يُرجَع إلى أعلى
  الصفحة قبل الالتقاط ثم يُستعاد الموضع (بشرط ألا يكون المستخدم قد مرّر).
- **بوابة الحبر:** ترفض أي لوحة فارغة قبل بناء الملف فلا يصل ملف تالف للزبون.
- **تنسيق الصفحات:** منع قطع الصفوف والكتل، وكتلة `pdf-tail` تجمع المجاميع
  والتذييل، وحذف الصفحة الأخيرة إن خرجت بيضاء.
- دقة 1.5 على الهاتف بدل 2 (ذاكرة iOS).

### اعتماد Codex النهائي (`e5124fa`)

- ثمانية أحجام (20، 24، 25، 26، 28، 30، 31، 40): **لا صفحة بيضاء، ولا قطع
  صف أو كتلة**، والمجاميع والتذييل معاً دائماً. الحجم بلا تغيير والزمن +0.31%.
  الحكم: **جاهز للدمج بلا موانع**.

### التحقق الفعلي بعد النشر

- workflow `30297651852` على `bdebe1c`: **completed / success**.
- `index.html` الحيّ: **7 مراجع `tobacco-122`** وصفر بقايا.
- `service-worker.js` الحيّ: `web-platform-tobacco-v400`.
- `src/app.js?v=tobacco-122` الحيّ (418,969 بايت) يحوي: `canvasInkRatio`،
  `deletePage`، `pdf-tail`، `pdf-summary`، `keepScrollY`،
  `firstElementChild || container`، وقائمة `avoid`.

### معلّق على المالك — الاختبار الحاسم

- من الهاتف: **فاتورة مبيعات ← وضع الجملة ← «📄 حفظ / مشاركة PDF»**.
  المتوقّع ملف نحو 100 ك.ب مرسوماً بالكامل (كان 3 ك.ب فارغاً). وإن فشل
  التوليد لأي سبب تظهر رسالة صريحة ولا يُشارَك ملف فارغ.

## 2026-07-27 - Claude - حذف الصفحة البيضاء وجمع المجاميع مع التذييل

- Status: **منجز على `claude/pdf-ios-hardening` فوق `0c5cfa5`، غير مدموج.**

### المانع الأول — صفحة A4 بيضاء بالكامل (24 صنفاً)

- تحدث حين يتجاوز المحتوى حدّ الصفحة ببضعة بكسلات فقط.
- **الحل:** بعد بناء المستند نقيس **حبر الشريحة الأخيرة من اللوحة** (بحساب
  `pxPerMm` من عرض اللوحة مقابل عرض الصفحة المفيد)، وإن كانت بيضاء نحذف
  الصفحة بـ`pdf.deletePage`. أنظف من العبث بالهوامش لأنه يعالج كل الأطوال.
- `canvasInkRatio` صارت تقبل نطاقاً رأسياً لهذا الغرض.
- **قياس فعلي:** 24 صنفاً **صفحتان ← صفحة واحدة** (`deleted: true`)، وبقية
  الأحجام بلا تغيير: 20 صنفاً صفحة واحدة، و25–40 صفحتان بمحتوى حقيقي.

### المانع الثاني — التذييل وحده في صفحة ثانية (25 صنفاً)

- **الحل:** كتلة `.pdf-tail` تضم المجاميع والتذييل معاً وتُمنع من الانقسام،
  وأُدرجت في `avoid`. فبدل تذييل يتيم تنتقل الكتلة كاملة إلى الصفحة الثانية.
- قياس موضع الكتلة: عند 25 و26 و28 و30 صنفاً تتقاطع الكتلة مع حدّ الصفحة
  فتنتقل كوحدة؛ وعند 31 و40 تقع كاملة في الصفحة الثانية أصلاً.

### حدود التحقق

- ما قِستُه: عدد الصفحات قبل/بعد، وحذف الصفحة البيضاء، ومواضع الكتل مقابل
  حدّ الصفحة، والحجم. **ما لم أستطع قياسه:** الشكل النهائي للصفحات مرسوماً —
  فليُعده Codex على 24 و25 و26 و28 و30.
- `node --check`، `npm.cmd run check`، `git diff --check`: ناجحة، وفحص
  `canvasInkRatio` 5 حالات ✅.

## 2026-07-27 - Codex - مراجعة `0c5cfa5` لكتل صفحات PDF

- SHA المراجع فعلياً: `0c5cfa53ec00eae05f68d68d4887739e846018f0`.
- الأب المباشر: `5f2b353ade16c58711e21c81b036dfa42535588c`.
- ناتج `git rev-parse HEAD` عند المراجعة:
  `0c5cfa53ec00eae05f68d68d4887739e846018f0`.
- الفرع: `claude/pdf-ios-hardening`.
- الحكم: **غير جاهز للدمج** بسبب صفحة فارغة عند 24 صنفاً وفصل التذييل وحده
  إلى صفحة ثانية عند 25 صنفاً.

### نتائج الأحجام المطلوبة

| الأصناف | صف مقسوم | المجاميع مقسومة | التذييل مقسوم | النتيجة |
|---:|---|---|---|---|
| 24 | لا | لا | لا | صفحتان؛ **الثانية فارغة تماماً** |
| 25 | لا | لا، تبقى في الأولى | لا، ينتقل كاملاً | **التذييل وحده في الثانية** |
| 26 | لا | لا، في الثانية | لا، في الثانية | صفحتان؛ فراغ الأولى `232px` (`14.36%`) |
| 28 | لا | لا، في الثانية | لا، في الثانية | صفحتان؛ فراغ الأولى `145px` (`8.97%`) |
| 30 | لا | لا، في الثانية | لا، في الثانية | صفحتان؛ فراغ الأولى `58px` (`3.59%`) |
| 31 | لا | لا، في الثانية | لا، في الثانية | صفحتان؛ فراغ الأولى `15px` (`0.93%`) |
| 40 | لا | لا، في الثانية | لا، في الثانية | صفحتان؛ فراغ الأولى `15px` (`0.93%`) |

### مانع يمنع الدمج

1. **فاتورة 24 صنفاً تولّد صفحة A4 ثانية فارغة.** القماش ارتفاعه `1627px`
   بينما حد الصفحة `1616px`; آخر 11 بكسل كلها بيضاء، ومع ذلك يحوّلها jsPDF
   إلى صفحة ثانية. تحليل البكسلات أعطى صفراً من الحبر، والفحص البصري للـPDF
   المرندر أكد أنها ورقة بيضاء كاملة.
2. **فاتورة 25 صنفاً تفصل التذييل عن المجاميع.** المجاميع تبقى في الصفحة
   الأولى (`y=906..1052`)، ثم يزيح `avoid` التذييل كاملاً إلى بداية الصفحة
   الثانية (`y=1077..1101`). الفحص البصري أكد أن الصفحة الثانية لا تحمل إلا
   خط التذييل والهواتف/السجل في أعلاها وباقي الورقة أبيض. الكتل لم تعد تُقطع
   داخلياً، لكن إضافتها منفردة إلى `avoid` لم تربط التذييل بالمجاميع.

### ملاحظة تُسجَّل

- الإصلاح نجح في هدفه الجزئي: في الأحجام السبعة المطلوبة لا يعبر أي `tr` أو
  `.pdf-summary` أو `.pdf-foot` حد صفحة. لا يوجد صف صنف مقسوم.
- الفراغ الأكبر في نهاية الصفحة الأولى هو `14.36%` عند 26 صنفاً لأن كتلة
  المجاميع والتذييل تنتقل إلى الثانية. هذا فراغ ملحوظ، لكنه نتيجة طبيعية
  لإبقاء الكتلتين كاملتين؛ المانعان الصريحان هما الصفحة الفارغة وفصل التذييل.
- فاتورة الصنف الواحد بقيت صفحة واحدة (`1123×627`, `89,249` بايت)، وفاتورة
  20 صنفاً بقيت صفحة واحدة (`1123×1453`, `273,575` بايت).
- في الفواتير القصيرة بقيت `.pdf-head` ثم `.pdf-meta` ثم الجدول في الصفحة
  الأولى، بفاصل 12 بكسل بين كل قسم والذي يليه؛ لا انفصال غريب.
- اختبار 40 صنفاً بست جولات متبادلة: الحجم مطابق للأب تماماً
  (`403,316` بايت في الاختبار نفسه)، ووسيط الزمن `190.00ms` للأب مقابل
  `192.95ms` للحالي، زيادة `1.55%` ضمن ضجيج القياس؛ لا تضخم ملحوظ.
- فرق `src/app.js` محصور في أصناف قالب PDF وقائمة `pagebreak.avoid`.
  `exportBulletinPdf` ودوال نشرة الأسعار وفاتورة الرول متطابقة نصياً مع الأب،
  وقوالب الطباعة الأخرى لم تتأثر.
- `node --check src/app.js`، و`npm.cmd run check`، و
  `git diff --check 5f2b353 0c5cfa5`: ناجحة.
- لم يُنفّذ commit أو push أو merge، ولم يُعدّل سعر أو رصيد، ولم تُشغّل
  مزامنة أو كتابة في الأمين أو Supabase.

## 2026-07-27 - Claude - منع انقسام كتلتي المجاميع والتذييل

- Status: **منجز على `claude/pdf-ios-hardening` فوق `5f2b353`، غير مدموج.**

### المانع

- بعد إصلاح قطع الصفوف بقي القطع في الكتل غير الجدولية: عند **25 صنفاً**
  ينقسم التذييل، وعند **26–30 صنفاً** تنقسم كتلة المجاميع — لأن `avoid` كان
  مطبّقاً على `tr` وحده.

### الإصلاح

- أصناف CSS صريحة على الكتل الأربع: `.pdf-head` (الترويسة)، `.pdf-meta`
  (بيانات الزبون)، `.pdf-summary` (المجاميع)، `.pdf-foot` (التذييل)، وكلها
  تحمل `break-inside: avoid` سطرياً.
- قائمة `avoid` في html2pdf صارت:
  `["tr", ".pdf-summary", ".pdf-foot", ".pdf-head", ".pdf-meta"]`.

### تحقق من الحالات الحدّية

- قِستُ ارتفاع المستند وحدود الصفحة (المساحة المفيدة **1077px** عند A4 بهامش
  6mm) وأين تقع الحدود من كل كتلة، فتأكّدت حالات Codex بالضبط:
  n=20 و24 و26 بلا تقاطع، **n=25 يتقاطع مع `pdf-foot`**، و**n=28/30/31
  يتقاطعان مع `pdf-summary` وصف**، وn=40 مع صف.
- هذا يثبت **صحة الحالات المختارة** ومواضع القطع؛ أما إثبات أن `avoid` أزاح
  الحدّ فعلاً فيحتاج رسم صفحات PDF — وهو خارج أدواتي، فليُعده Codex على
  الأحجام 25 و26 و28 و30 تحديداً.
- `node --check`، `npm.cmd run check`، `git diff --check`: ناجحة.

## 2026-07-27 - Codex - مراجعة `5f2b353` لمنع قطع صفوف PDF

- SHA المراجع فعلياً: `5f2b353ade16c58711e21c81b036dfa42535588c`.
- الأب المباشر: `9575b765bbba4c0e5ff64e88550a400afcc4c8ba`.
- ناتج `git rev-parse HEAD` عند المراجعة:
  `5f2b353ade16c58711e21c81b036dfa42535588c`.
- الفرع: `claude/pdf-ios-hardening`.
- الحكم: **غير جاهز للدمج**. إصلاح صفوف الأصناف نجح، لكن كتلة المجاميع
  والتذييل ما زالتا تنقسمان عند أعداد أصناف واقعية.

### مانع يمنع الدمج

1. **منع الكسر مطبّق على كل صف منفرداً، لا على كتلة المجاميع والتذييل.**
   مسح القالب من صنف واحد إلى 80 صنفاً أثبت عدم انقسام أي `tr`، لكنه كشف:
   - عند 25 صنفاً تبقى المجاميع في الصفحة الأولى (`y=906..1052`)، بينما
     التذييل نفسه يعبر حد الصفحة `y=1077` (`y=1070..1094`) فيُقسم إلى جزأين.
   - عند 26 إلى 30 صنفاً تنقسم **كتلة المجاميع** بين الصفحتين. مثال 26
     صنفاً: المجاميع تمتد من `y=935` إلى `1107.5` حول الحد `1077`؛ الصفوف
     الفردية لا تُقطع، لكن بعض المجاميع تبقى في الأولى والبقية تنتقل للثانية.
   - تتكرر الحالة نفسها عند 62–67 صنفاً حول حد الصفحة الثالثة.

   هذا يخالف شرط بقاء المجاميع والتذييل معاً بشكل طبيعي. يلزم منع كسر جدول
   المجاميع ككتلة، وربط التذييل به أو منعه ككتلة، لا الاكتفاء بـ`avoid tr`.

### ملاحظة تُسجَّل

- **اختبار 40 صنفاً المطلوب أساساً ناجح:** لا يوجد أي صف مقسوم بين
  الصفحتين. الصفحة الأولى تنتهي بالصنف 31، والثانية تبدأ بالصنف 32 كاملاً
  وتعرض حتى 40. كان القماش `1123×2340` وحد الصفحة `1616`، ولم يعبره أي
  `tr`.
- الصفحتان غير فارغتين. الفراغ أسفل الصفحة الأولى 15 بكسل فقط، وأعلى الثانية
  بكسل واحد؛ لا توجد قفزة كبيرة. الفحص البصري من PDF المرندر أكد النتيجة.
- في حالة 40 صنفاً بقي جدول المجاميع والتذييل كلاهما في الصفحة الثانية،
  والفاصل بينهما 18 بكسل. المشكلة المانعة تظهر في الأعداد المذكورة أعلاه،
  لا في الأربعين.
- فاتورة الصنف الواحد بقيت صفحة واحدة: قماش `1123×627` وملف `89,249`
  بايت، بلا صفحة فارغة.
- الحجم لم يتضخم عملياً في فاتورة الأربعين: `478,640` بايت في الأب مقابل
  `480,139` بايت حالياً، زيادة `0.31%`. في ست جولات متبادلة كان وسيط الزمن
  `208.35ms` للأب و`203.60ms` للحالي؛ لا زيادة زمنية قابلة للقياس.
- ملاحظة عرض غير مانعة: الصفحة الثانية لا تكرر رأس أعمدة الجدول، بل تبدأ
  مباشرة بالصنف 32. هذا السلوك كان موجوداً في الأب ولم ينشأ من هذا الكوميت.
- فرق `src/app.js` محصور في `salesInvoicePdfMarkup` وخيار `pagebreak` داخل
  `saveSalesInvoicePdf`. دوال نشرة الأسعار، `exportBulletinPdf`، وفاتورة
  الرول متطابقة نصياً مع الأب؛ ولم تتأثر قوالب الطباعة الأخرى.
- `node --check src/app.js`، و`npm.cmd run check`، و
  `git diff --check 9575b76 5f2b353`: ناجحة.
- لم يُنفّذ commit أو push أو merge، ولم يُعدّل سعر أو رصيد، ولم تُشغّل
  مزامنة أو كتابة في الأمين أو Supabase.

## 2026-07-27 - Claude - منع قطع صف الفاتورة بين صفحتي PDF

- Status: **منجز على `claude/pdf-ios-hardening` فوق `9575b76`، غير مدموج.**

### المانع

- في فاتورة 40 صنفاً انقسم صف الصنف رقم 32 بين صفحتين. المحتوى لم يُفقد، لكن
  قطع صف كمية/سعر/إجمالي في منتصفه غير مقبول على مستند يُسلَّم للزبون.

### الإصلاح — آليتان معاً

1. **أنماط سطرية على كل صف** في `salesInvoicePdfMarkup`:
   `page-break-inside:avoid;break-inside:avoid` — على صفوف الأصناف ورأس
   الجدول وصفوف المجاميع (46 موضعاً في مخرجات فاتورة 40 صنفاً).
2. **خيار html2pdf**: `pagebreak: { mode: ["css", "legacy"], avoid: ["tr"] }`
   — يقرأ الأنماط أعلاه ويزيح نقطة القطع إلى حدّ الصف.

### القياس

- فاتورة 40 صنفاً (45 صفاً بالمجموع، ارتفاع الصف 29px، ارتفاع المستند 1538px):
  الناتج **صفحتان و532 ك.ب** قبل الخيار وبعده — أي لا انحدار في الحجم أو عدد
  الصفحات.
- **لم أستطع التحقق بصرياً من اختفاء القطع نفسه** بالأدوات المتاحة لي (يحتاج
  رسم صفحات PDF)، والفحص السابق الذي كشف القطع كان بأداة Codex — فليُعد
  التحقق بها على هذا الكوميت تحديداً.
- `node --check`، `npm.cmd run check`، `git diff --check`: ناجحة. الكاش
  `v399` وأصول `tobacco-121`.

## 2026-07-27 - Codex - مراجعة `9575b76` لإصلاح مصدر PDF والتمرير

- SHA المراجع فعلياً: `9575b765bbba4c0e5ff64e88550a400afcc4c8ba`.
- الأب المباشر: `6793c73f094a02ed1a6a0a1167e90727691a8663`.
- ناتج `git rev-parse HEAD` عند المراجعة:
  `9575b765bbba4c0e5ff64e88550a400afcc4c8ba`.
- الفرع: `claude/pdf-ios-hardening`.
- الحكم: **غير جاهز للدمج** بسبب تقسيم الصفوف في الفاتورة الطويلة.

### مانع يمنع الدمج

1. **الفاتورة الطويلة قد تُقسّم في منتصف صف صنف.** القماش يشمل المحتوى كله
   ولا يقص أسفله، وعدد صفحات jsPDF يطابق العدد الحسابي، لكن لا توجد قاعدة
   تمنع كسر `tr` عند حد الصفحة. في اختبار حقيقي بقالب الفاتورة و40 صنفاً:
   كان العنصر `754×1549px`، والقماش `1123×2323px`، وحد الصفحة الأولى عند
   `canvasY=1616` (`CSS y=1077.33`). هذا الحد وقع داخل صف الصنف رقم 32
   (`top=1067.5`, `bottom=1096.5`) فقُسّم الصف بين الصفحتين. هذه ليست قسمة
   مستندية سليمة لسطر كمية/سعر/إجمالي، حتى لو لم تُفقد البكسلات. يلزم منع
   كسر صفوف الجدول أو إضافة إعداد page-break مناسب قبل الدمج.

### ملاحظة تُسجَّل

- `salesInvoicePdfMarkup` ينتج عنصراً جذرياً واحداً دائماً: مع صفر، صنف واحد،
  20، 25، و40 صنفاً كان `container.childElementCount=1` والعنصر الجذري
  `DIV`. الفراغات النصية حوله لا تؤثر في `firstElementChild`.
- سقوط `container.firstElementChild || container` آمن من الصمت: عند محاكاة
  غياب العنصر الداخلي استُخدمت الحاوية، وخرج قماش `1123×0` ونسبة حبر `0`،
  وبالتالي تمسكه بوابة `inkRatio <= 0.001` قبل بناء الملف.
- فاتورة الصنف الواحد خرجت بقماش `1123×627`، ونسبة حبر فعلية
  `0.120259` (`12.0259%`) مقابل العتبة `0.001` (`0.1%`) وملف
  `87,911` بايت؛ لا رفض زائف.
- فاتورة 20 صنفاً خرجت كاملة في صفحة واحدة: العنصر `754×969px`، والقماش
  `1123×1453px`، وآخر حبر يسبقه هامش أبيض 29 بكسل. فاتورة 25 صنفاً خرجت
  بقماش `1123×1671px` وصفحتين كما هو متوقع، لكن الصفحة الثانية لا تحمل إلا
  ذيل المحتوى القصير؛ واختبار 40 صنفاً هو الذي أثبت كسر صف فعلي.
- شرط التمرير الجديد يعمل في الحالتين المطلوبتين: من موضع محفوظ `1500`،
  عدم تدخل المستخدم أبقى التمرير عند صفر حتى `finally` فأعاده إلى `1500`؛
  وعند تمرير المستخدم إلى `600` بقي عند `600` ولم يُختطف إلى الموضع القديم.
  وبعد `toCanvas` بقي التمرير صفراً في المسار الشائع، لذلك لا يفشل الشرط بسبب
  العامل نفسه.
- `salesInvoicePdfMarkup` ودوال النشرة
  `customerPriceListItems`, `consolidateGeneralPriceItems`,
  `prepareBulletinItems`, `customerPricePdfMarkup`, `exportBulletinPdf`,
  `exportPricePreview`, و`downloadCustomerPricePdf` متطابقة نصياً مع الأب
  `6793c73`. التعديلان لم يمتدا إليها.
- `node --check src/app.js`، و`npm.cmd run check`، و
  `git diff --check 6793c73 9575b76`: ناجحة.
- لم يُنفّذ commit أو push أو merge، ولم يُعدّل سعر أو رصيد، ولم تُشغّل
  مزامنة أو كتابة في الأمين أو Supabase.

## 2026-07-27 - Claude - السبب الحقيقي: تمرير الحاوية المطلقة إلى html2canvas

- Status: **منجز على `claude/pdf-ios-hardening` فوق `6793c73`، غير مدموج.**

### مانعا Codex — كلاهما صحيح، والأول هو الجذر الفعلي

1. **`.from(container)` والحاوية `position:absolute` ⇒ لوحة بارتفاع صفر.**
   أُعيد إنتاجه في متصفح حقيقي: ارتفاع الحاوية 501 بكسل، ومع ذلك تخرج اللوحة
   **1123×0** والملف **3 ك.ب** — الحجم نفسه الذي وصل المالك بالضبط.
   **التصحيح:** يُمرَّر **العنصر الداخلي** لا الحاوية.
2. **إرجاع التمرير غير المشروط** كان سيمحو تمريراً جديداً للمستخدم أثناء
   التوليد. صار الإرجاع مشروطاً بأن يكون التمرير ما زال حيث تركناه (صفر).

### مصفوفة القياس النهائية (متصفح حقيقي)

| الحالة | اللوحة | الحبر | الملف |
|---|---|---|---|
| الحاوية المطلقة، بلا تمرير | 1123×**0** | — | **3 ك.ب** ❌ |
| العنصر الداخلي، بلا تمرير | 1123×751 | 11.6% | 99 ك.ب ✅ |
| العنصر الداخلي، مع تمرير، بلا إصلاح | 1123×751 | **0** | 9 ك.ب ❌ |
| العنصر الداخلي، مع تمرير، **مع الإصلاح** | 1123×751 | **11.6%** | **99 ك.ب** ✅ |

- أي أن العطلين مستقلان: الحاوية المطلقة تُفشل التوليد دائماً، وتمرير الصفحة
  يُفشله عند الضغط من أسفل شاشة طويلة. الإصلاحان معاً مطلوبان، وبوابة الحبر
  تمسك أي فشل ثالث قبل أن يصل ملف فارغ إلى الزبون.

### تصحيح لتشخيصي السابق

- نسبتُ العطل كله إلى تمرير الصفحة. كان ذلك جزءاً من الحقيقة فقط: قياسي
  السابق مرّر العنصر الداخلي بينما يمرّر التطبيق الحاوية، فاختلف الظرف.
  الحجم 3 ك.ب في ملف المالك هو بصمة عطل الحاوية لا عطل التمرير.

### الفحوص

- فحص `canvasInkRatio`: 5 حالات ✅. `node --check`، `npm.cmd run check`،
  `git diff --check`: ناجحة. الكاش `v399` وأصول `tobacco-121`.

## 2026-07-27 - Codex - مراجعة `6793c73` لتحصين PDF على iOS

- SHA المراجع فعلياً: `6793c73f094a02ed1a6a0a1167e90727691a8663`.
- الأب المباشر الفعلي في Git: `2b6e8f1804ec259bd68b010d0c19493c497c664c`.
- قاعدة المقارنة التي طلبها المالك: `dc069c666134730e992db86395938186dc8f8611`.
  وهي جدّ الكوميت وليست أباه المباشر؛ النطاق `dc069c6..6793c73` يضم أيضاً
  `2b6e8f1`.
- ناتج `git rev-parse HEAD` عند المراجعة:
  `6793c73f094a02ed1a6a0a1167e90727691a8663`.
- الفرع: `claude/pdf-ios-hardening`.
- الحكم: **غير جاهز للدمج**.

### مانع يمنع الدمج

1. **[P1] الحاوية المطلقة تجعل لوحة الفاتورة بارتفاع صفر، فتُرفض كل فاتورة.**
   في `src/app.js:6492` صارت الحاوية
   `position:absolute;left:-10000px;top:0`. في Chromium حقيقي بقي ارتفاع عنصر
   الصنف الواحد قبل الالتقاط `418px`، لكن `worker.toCanvas()` أعاد لوحة
   `1123×0`، ونسبة الحبر `0`، والملف الناتج `3,058` بايت. لذلك بوابة
   `inkRatio <= 0.001` تنهي التصدير دائماً في هذه الحالة. المقارنة العازلة
   أثبتت أن نفس القالب حين يكون في التدفق الطبيعي يعطي لوحة `1123×627`،
   ونسبة حبر `0.118117` (أي `11.8117%`) وملفاً `80,205` بايت. النتيجة تكررت
   عند `scrollY=0` و`1500` للحاويتين `absolute` و`fixed`; الرجوع إلى أعلى
   الصفحة لا يصلح انهيار ارتفاع اللوحة الناتج عن إخراج المصدر من التدفق.

2. **[P1] الاستعادة غير المشروطة تمحو تمريراً جديداً أجراه المستخدم أثناء
   التوليد.** الموضع القديم يُلتقط مرة واحدة في `src/app.js:6501-6502` ثم
   يُعاد بلا شرط في `src/app.js:6572`. لا يوجد قفل للتمرير أو فحص أن الصفحة
   ما زالت عند موضع الالتقاط القسري؛ فإذا مرّر المستخدم أثناء انتظار
   `toCanvas`/`toPdf` أو المشاركة، يعيده `finally` إلى الموضع القديم خلاف
   البند المطلوب. أمّا إذا لم يتدخل المستخدم، فكل مخارج ما بعد
   `window.scrollTo(0, 0)` — رفض الحبر، رفض الحجم، نجاح/إلغاء المشاركة،
   التنزيل والاستثناء — تمر فعلاً عبر `finally` وتعيد الموضع. الحراس التي
   تسبق `try` لا تغيّر التمرير أصلاً.

### ملاحظة تُسجَّل

- الرجوع إلى أعلى الصفحة ظاهر للمستخدم طوال التوليد وحتى انتهاء ورقة
  المشاركة؛ ثم يعود موضعه الأصلي إذا لم يمرّر بنفسه. لا يضيع الموضع في
  المسار الهادئ، لكنه يسبب قفزة مرئية في شاشة طويلة.
- فاتورة بصنف واحد بعناصر القالب الحقيقية بعيدة جداً عن العتبة:
  `11.8117%` مقابل `0.1%`. إذن العتبة نفسها لا تمنع الفاتورة القليلة؛ المانع
  الحالي هو ارتفاع اللوحة الصفري.
- `canvasInkRatio` يفشل مفتوحاً: عند رمي `getImageData` يعيد `1`. قالب
  الفاتورة الحالي نصي بلا صورة خارجية، لذلك خطأ CORS غير مرجح حالياً، لكن
  الحارس الثانوي لا يكفي وحده: لوحة بيضاء حقيقية أعطت `8,697` بايت، فتتجاوز
  حد `8 KiB`. لذلك أي تعذّر قراءة واقعي (مثل فقد سياق اللوحة على الهاتف)
  يستطيع نظرياً تمرير ملف فارغ؛ الأفضل أن يكون التعذّر رفضاً صريحاً لا نجاحاً
  مصطنعاً.
- تسلسل `await worker.toCanvas()` ثم `worker.toPdf()` لا يعيد الرسم: القياس
  سجل استدعاء `toCanvas` واحداً فقط. بقيت الهوامش `[6,6,6,6]`، والمساحة
  الداخلية للصفحة `198.0016×285.0001mm`، وصفحة PDF واحدة.
- دوال النشرة `customerPriceListItems`, `consolidateGeneralPriceItems`,
  `prepareBulletinItems`, `customerPricePdfMarkup`, `exportBulletinPdf`,
  `exportPricePreview`, و`downloadCustomerPricePdf` متطابقة نصياً مع
  `dc069c6`. لم يمتد استبدال `finally` إليها.
- `CACHE_NAME` صحيح: `web-platform-tobacco-v399`. في `index.html` سبعة مراجع
  كلها `tobacco-121`، بلا `tobacco-120` وبلا أصل مفقود. أصول كاش الـservice
  worker كلها موجودة.
- نهايات `index.html` لم تتغير عن `dc069c6`: `CR=19`, `LF=26`,
  `CRLF=19`, وسبعة أسطر LF منفردة.
- `node --check src/app.js`، و`npm.cmd run check`، و
  `git diff --check dc069c6 6793c73`: ناجحة.
- لم يُنفّذ commit أو push أو merge، ولم يُعدّل سعر أو رصيد، ولم تُشغّل
  مزامنة أو كتابة في الأمين أو Supabase.

## 2026-07-27 - Claude - إصلاح ملف PDF الفارغ على الهاتف (السبب: تمرير الصفحة)

- Status: **منجز على `claude/pdf-ios-hardening` فوق `dc069c6`، غير مدموج وغير
  منشور.**

### البلاغ والدليل

- شارك المالك الفاتورة من الهاتف: ورقة المشاركة فتحت ووصل الملف إلى واتساب
  بالتعليق الصحيح، لكن واتساب فشل بالإرسال والمعاينة رمادية. وبحفظه في
  «الملفات» ظهر **`invoice225…pdf` بحجم 3,058 بايت**.
- تفكيك الملف أثبت أنه **فارغ فعلاً**: صفحة واحدة، ثلاثة مراجع `/Image` بلا أي
  بيانات صورة (لا `DCTDecode` ولا `/Width`)، ومحتوى الصفحة كله **25 بايت**:
  `0.567 w  0 G` — ضبط قلم ولون بلا أي رسم.

### السبب الجذري — قياس لا تخمين

- أُعيد إنتاج العطل في متصفح حقيقي بقياس نسبة الحبر في اللوحة:
  - عنصر في التدفق الطبيعي والصفحة **غير مُمرَّرة**: حبر **11.84%** ✅
  - عنصر **خارج الشاشة** والصفحة غير مُمرَّرة: حبر **11.84%** ✅
  - عنصر في التدفق والصفحة **مُمرَّرة إلى 1500px**: حبر **0** ❌
- أي أن الحاوية خارج الشاشة **بريئة**، والسبب **تمرير الصفحة**: html2canvas
  يلتقط منطقة مزاحة. وهذه حالة الهاتف دائماً — الأزرار أسفل شاشة طويلة.
- جُرِّبت بدائل لم تنفع: `scrollX/scrollY`، و`x/y`، و`position:fixed`،
  والوضع خلف المحتوى — كلها صفر حبر مع التمرير.
- **الحل الذي نجح:** الرجوع إلى أعلى الصفحة قبل الالتقاط ثم إرجاع التمرير.
  النتيجة: حبر **11.84%** وملف **104 ك.ب** بدل 3 ك.ب، والتمرير عاد لموضعه.

### ما نُفِّذ

- حفظ `scrollX/scrollY` ← `window.scrollTo(0, 0)` ← التوليد ← الإرجاع في
  `finally` (وتُرجَع أيضاً عند أي استثناء).
- **بوابة الحبر** `canvasInkRatio`: تقيس البكسل غير الأبيض في اللوحة قبل بناء
  الملف؛ إن كانت ≤ 0.1% تُرفض العملية برسالة صريحة تنبّه ألا يُرسل أي ملف.
  حجم الملف وحده مؤشر ضعيف — اللوحة الفارغة أعطت 9 ك.ب في القياس.
- حدّ حجم ثانوي 8 ك.ب، ودقة 1.5 على الهاتف بدل 2 (ذاكرة iOS).

### خطأ أمسكتُه في تعديلي نفسه

- أول استبدال لإرجاع التمرير أصاب **دالة نشرة الأسعار** بدل دالة الفاتورة
  (نمط `finally { container.remove(); }` متكرر)، فكان سيرمي `ReferenceError`
  عند تصدير النشرة. `node --check` لا يمسك هذا — أمسكه فحص مواضع الاستبدال
  بعد التعديل، وأُعيدت الدالة كما كانت ووُضع الإرجاع في مكانه الصحيح.

### الفحوص

- فحص `canvasInkRatio` بلوحات وهمية: 5 حالات ✅ (بيضاء → صفر، فيها نص →
  موجب، لوحة معدومة، بلا أبعاد، وتعذّر القراءة → لا يمنع التصدير).
- `node --check`، `npm.cmd run check`، `git diff --check`: ناجحة.
- الكاش `v399` وأصول `tobacco-121` بلا بقايا. `index.html` CR=19.

### ملاحظة للمالك

- ملف `.txt` الصغير الذي ظهر مع الحفظ في «الملفات» هو عنوان المشاركة
  («فاتورة مبيعات 225») يحفظه iOS ملفاً مستقلاً. هو نفسه ما يصبح تعليقاً
  للرسالة على واتساب — أُبقيه لأن التعليق مفيد للزبون، ويمكن حذفه بطلبك.

## الحالة الحالية

- الحالة: **مدموج ومنشور** — إصلاح تصدير PDF من الهاتف دُمج ونُشر عند `bdebe1c`
  (2026-07-27). النسخة المنشورة **tobacco-122 / v400** ومُتحقَّق منها حيّاً.
  قبله في اليوم نفسه: فواتير PDF/الكاشير وسند القبض ودمج النشرة عند `b10e945`.
- **معلّق على المالك:** تجربة الهاتف — وأهمها زر «📄 حفظ / مشاركة PDF» في وضع
  الجملة: هل تفتح ورقة المشاركة ويصل الملف على واتساب؟ وبقية البنود: الطباعة،
  اقتراح الزبون، رقم الفاتورة (يتقدّم مع كل فاتورة حقيقية)، كود الأمين،
  ثبات عمود الصنف، آخر سعر للزبون، وتحذير تجاوز حد الائتمان.
- النشرة المنشورة تأخذ الدمج الجديد عند أول تشغيل لمولّد النشرات (المجدول أو
  «اعتماد ونشر») — لم يُشغَّل يدوياً لأنه ينشر أسعاراً.
- قرارات تسعير معلّقة: أربعة أصناف تحت التكلفة ولها مخزون (البيع تحت التكلفة
  مسموح ومقصود أحياناً — التنبيه معلوماتي فقط)، و54 صنفاً سعرها أقدم من 30
  يوماً مع مخزون منها 16 هامشها تحت 5٪.
- حدّ معروف في الترقيم: الموقع لا يحجز رقماً في الأمين؛ نافذة التكرار ≤5 دقائق
  ولم تُغلق تماماً. الإغلاق الكامل يحتاج حقل رقم قابل للتعديل — لم يُطلب بعد.
- المسؤول: —
- آخر تحديث: 2026-07-27

## 2026-07-27 - Claude - دمج ونشر الفروع الثلاثة (`b10e945`)

- Status: **مدموج في `main` ومنشور ومُتحقَّق منه على الموقع الحيّ.** لا تعديل
  أسعار، ولا تشغيل لمولّد النشرات، ولا كتابة في الأمين، ولا حذف من Supabase،
  ولا دفع قسري.

### المانع الأخير قبل الدمج — أُغلق

- نشرة السوري كانت تدمج المعسل **قبل** ترشيح ما له سعر مفرق، فلو اختير ممثّل
  بلا سعر مفرق تسقط المجموعة كلها لاحقاً رغم وجود صنف مسعّر فيها — بينما
  المولّد يرشّح أولاً. صار الترشيح كاملاً قبل الدمج في النشرتين (`535303c`).

### الدمج

- `c8f64f4` فواتير PDF/الكاشير · `a852886` سند القبض · `fe6e1f1` دمج النشرة.
- التعارضات كلها في أرقام الإصدار فقط، حُسمت بالأعلى ثم رُفعت مرة واحدة في
  النهاية. تعارض `AI_HANDOFF.md` حُسم **بالإبقاء على الجانبين** (السجلات لا
  تُحذف)، وأُعيدت كتلة «الحالة الحالية» إلى أعلى الملف بعد أن أزاحها الدمج.
- `index.html` عُولج ببرنامج بايتي لا بأداة تحرير: CR=19 قبل التعارض و26
  أثناءه و**19 بعد الحسم** — نهايات الأسطر المختلطة لم تتبدّل.

### الفحوص قبل الدفع

- أُعيدت كل المحاكاة **على `main` بعد الدمج**: تطابق الموقع/المولّد في كل
  الحالات، ودمج النشرة 13، وقالب السند 9، وشاشة الفواتير السابقة 31 — صفر
  إخفاق.
- `npm.cmd run check`، `node --check` لـ`src/app.js` وللمولّد،
  `git diff --check`: ناجحة.

### التحقق الفعلي بعد النشر

- workflow «Deploy TOBACCO Web» `30279711310` على `b10e945`: **success**.
- `index.html` الحيّ: **7 مراجع `tobacco-120`** وصفر بقايا.
- `service-worker.js` الحيّ: `CACHE_NAME = "web-platform-tobacco-v398"`.
- `src/app.js?v=tobacco-120` الحيّ (413,166 بايت) يحوي فعلياً:
  `saveSalesInvoicePdf`, `salesReceiptDocument`, `SALES_TRADE_REGISTER_NO`,
  `voucherExportBusy`, `currentBalance`, `bulletinMergePriceKey`,
  `salesHistoryPanel`, `isHandheldDevice`.
- الرابط: `https://fhwvtqdc2q-svg.github.io/tobacco-web`


## 2026-07-27 - Codex - مراجعة إغلاق موانع سند القبض (`0a9ee96`)

- Status: **لا يوجد مانع يمنع الدمج ضمن النطاق المطلوب.** روجع الكوميت
  الفعلي `0a9ee9609ec491f3d06eb608ace9ce8e22be53d3` مقابل أبيه المباشر
  `4838c71cd2a9c2cae26a7017daddf12570aab9e1` على الفرع
  `claude/receipt-voucher-balance` داخل worktree المحدد. وكان ناتج
  `git rev-parse HEAD` وقت المراجعة
  `0a9ee9609ec491f3d06eb608ace9ce8e22be53d3`.
- المراجعة والاستعلام والمحاكاة قرائية ومحلية فقط. لم يحدث commit أو push
  أو merge، ولم يُعدّل أي رصيد أو سعر أو صف في Supabase، ولم تُشغّل أي
  مزامنة أو كتابة في الأمين. الملف الوحيد المعدّل بواسطة المراجعة هو
  `AI_HANDOFF.md`.

### موانع تمنع الدمج

- **لا يوجد.**

### ما اجتاز المراجعة

- **حذف `gen-receipt`:** البحث في الأب `4838c71` وجد الاسم مرة واحدة فقط:
  معالج الربط المحذوف نفسه، ولم يجد أي زر أو عنصر يحمل هذا الإجراء. والبحث
  في `0a9ee96` لم يجد أي مرجع خارج سجل التسليم. الزر الفعلي في بطاقات
  الحركات كان وما زال `gen-movement-doc`، سواء في صفحة التطبيق
  `index.html` أو مسار `404.html` اللذين يحملان `src/app.js`. لذلك لم يُحذف
  سلوك قابل للاستدعاء ولم يبق selector أو زر معلّق.
- **حارس النقر المزدوج:** شُغّل callback الفعلي لـ`gen-movement-doc` بساعة
  متحكم بها. نقرتان متتاليتان أعطتا تصديراً واحداً واستدعاءً واحداً
  لـ`docNumber`. بعد تنفيذ مؤقت `1500ms` قُبل مستند ثانٍ مشروع وصار العدد
  تصديرين ورقمين. وعندما رمى `selectedCustomer` استثناءً بعد تثبيت الحارس،
  بقي المؤقت المجدول قائماً ثم أعاد `voucherExportBusy=false`؛ أي لم يعلق
  الحارس في وضع مشغول.
- **فصل عملة المبلغ عن عملة الرصيد:** محاكاة
  `voucherPdfMarkup` الفعلية لزبون وصل بالليرة طبعت مبلغ الدفعة
  `3,700 ل.س` كما كان، وطبعت الرصيدين `6,727.5 $` و`7,794.5 $`، ولم تطبع
  أيّاً منهما بوسم `ل.س`. استعمال `balCur` محصور باستدعاءات
  `balanceText` الخاصة بصفوف الرصيد؛ سطر المبلغ وسطر قيمة الفاتورة/المرتجع
  والحسم والتسوية ما زالت تستعمل `cur`.
- **عدم تغيير المستندات الأخرى أو زبون الدولار:** قورنت المخرجات الكاملة
  للقالب بين الأب والكوميت لحالات فاتورة بالدولار، مرتجع بالدولار، سند صرف
  بالليرة، وسند قبض بالدولار بلا سطر حركات لاحقة؛ كانت متطابقة حرفياً في
  الحالات الأربع. إصلاح عزل `currentBalance` وحده يزيل السطر الذي كان
  يمكن أن يتسرّب إلى نوع آخر إذا مُرّر الحقل إليه.
- **عزل الرصيد الحالي:** تمرير `currentBalance` إلى فاتورة أو مرتجع أو سند
  صرف أعطى صفر سطر «الرصيد الحالي». سند القبض المختلف أعطى سطراً واحداً،
  والمتساوي تماماً أو المختلف بمقدار `0.005` أعطى صفراً؛ شرط الفرق
  `> 0.009` يعمل كما هو مقصود.
- **`shortDateTime`:** أعادت القيمة الفارغة نصاً فارغاً من دون استثناء،
  والتاريخ غير الصالح نصاً احتياطياً من دون انهيار، والتاريخ الصحيح
  `2026-07-27T13:46:00` بالشكل `27-07 13:46`.
- **رقم السند:** المسار الفعلي استدعى `docNumber("R")` مرة واحدة لكل تصدير
  ومرّر الناتج في `opts.no`. استدعاء القالب بهذه الخيارات لم يستدعِ
  fallback الخاص بـ`docNumber` إطلاقاً.
- **الأرقام المحاسبية:** استعلام مباشر قرائي من الأمين للزبون
  «ابو محمد مركز الكوثر /عين ترما» ولدفعة `3,700` بتاريخ `2026-07-26`
  أعاد `docPrev=10,427.5` و`docNew=6,727.5` والرصيد الحالي من `ac000`
  `7,794.5`. محاكاة زر الحركة الفعلي مرّرت إلى القالب
  `balance=6,727.5` و`currentBalance=7,794.5`، فتظل الأرقام المطبوعة
  صحيحة.
- نجحت `node --check src/app.js` و`npm.cmd run check` برسالة
  `Project check passed`، ونجح `git diff --check 4838c71 0a9ee96`.

### ملاحظات تُسجّل ولا تمنع الدمج

- `paymentMovementBalance` بقيت معرفة في `src/app.js` بلا أي مستدعٍ بعد حذف
  معالج `gen-receipt`. لا تؤثر في السلوك الحالي، لكنها كود ميت يمكن حذفه
  لاحقاً أو تغطيته باختبار إذا كان المقصود الاحتفاظ به كمرجع.
- حارس `voucherExportBusy` عام لكل أزرار `gen-movement-doc` خلال نافذة
  `1.5` ثانية، لا مفتاح خاص بكل حركة. هذا يحقق السلوك المطلوب ويعود للسماح
  بعد المهلة، لكنه قد يهمل نقرة مقصودة على حركة أخرى خلال النافذة نفسها.
- `shortDateTime` لا ينهار مع التاريخ غير الصالح، لكنه يعيد أول 16 محرفاً
  من القيمة الخام بدلاً من إخفاء وسم الوقت. لا يحدث ذلك مع بيانات التقرير
  الصحيحة، لكن إرجاع نص فارغ للقيمة غير الصالحة سيكون أكثر تحفظاً لمستند
  مالي.

## 2026-07-27 - Claude - إغلاق موانع سند القبض الخمسة

- Status: **منجز على `claude/receipt-voucher-balance` فوق `4838c71`، غير مدموج
  وغير منشور.**

### المانع الأهم — إصلاح في مسار غير مستعمل

- `gen-receipt` **لا وجود له في الواجهة إطلاقاً** (صفر تطابق في المخرجات)؛
  الزر الفعلي «📄 سند قبض PDF» يستعمل `gen-movement-doc`. أي أن الإصلاح
  السابق كان على كود ميت.
- حُذف المعالج الميت بالكامل، ونُقلت الفائدة إلى المسار الحقيقي. وقد تبيّن أن
  المسار الحقيقي **كان أصلاً** يستعمل `docNew` (لذلك طُبع 6,727.5 الصحيح).
- سقط معه المانعان 1 (فشل السحب يُعامل نجاحاً) و... لم يعد هناك سحب أصلاً:
  رصيد القيد المخزَّن صحيح بغضّ النظر عن حداثة الصفحة.

### بقية الموانع

- **النقر المزدوج:** حارس `voucherExportBusy` على مستوى الوحدة (يصمد أمام
  إعادة الرسم) يتجاهل أي نقرة ثانية خلال 1.5 ثانية، فلا يصدر سندان برقمين
  مختلفين للحركة نفسها.
- **سطر الرصيد الحالي:** محصور صراحةً بـ`v.type === "receipt"` — لا يظهر
  للفاتورة ولا المرتجع ولا سند الصرف ولو مُرِّر الحقل.
- **عملة الرصيد:** أرصدة الذمم من `ac000` بعملة الأساس (الدولار) ولا تُحوَّل،
  فصارت صفوف الرصيد الثلاثة تستعمل `balCur` (الدولار افتراضاً) بدل عملة
  الوصل. زبون الليرة لم يعد يرى رصيداً دولارياً موسوماً «ل.س»، بينما يبقى
  **مبلغ الدفعة** بعملة الوصل كما كان.
- **حداثة الرقم:** سطر الرصيد الحالي يذكر وقت التقرير («حتى 27-07 13:46»)
  فلا يُدَّعى أنه رصيد اللحظة على صفحة محمَّلة منذ ساعات.

### الفحوص

- محاكاة قالب السند من الدالة الفعلية: **9 فحوص، صفر إخفاق** — الرصيدان
  يظهران، بالدولار لا بالليرة، مع وقت المزامنة، ومبلغ الدفعة بعملة الوصل،
  ولا سطر ثانٍ عند التساوي، ولا يظهر للفاتورة/الصرف.
- محاكاة `paymentMovementBalance` على حركات الزبون الحقيقية: **6 فحوص، صفر
  إخفاق** (الدالة أُبقيت لأنها المرجع الصحيح لأي مسار لاحق).
- `node --check`، `npm.cmd run check`، `git diff --check`: ناجحة.
- الكاش والأصول كما هما (v396 / tobacco-118). `src/app.js` CR=0،
  `index.html` CR=19.

### ملاحظة تُسجَّل

- مبلغ الدفعة نفسه يُطبع بعملة الوصل (`customerCurrency`) بينما مصدره
  `ac000` بالدولار. لم أغيّره لأنه خارج نطاق البلاغ ويحتاج قرار المالك:
  هل وصل زبون الليرة يجب أن يعرض المبلغ محوّلاً أم بالدولار؟

## 2026-07-27 - Codex - مراجعة رصيد سند القبض (`4838c71`)

- Status: **توجد خمسة موانع تمنع الدمج.** روجع الكوميت الفعلي
  `4838c71cd2a9c2cae26a7017daddf12570aab9e1` مقابل أبيه المباشر
  `f8a8eb52e70b502902bd3b07a86f6f4018685ce9` على الفرع
  `claude/receipt-voucher-balance` داخل worktree المحدد. وكان ناتج
  `git rev-parse HEAD` وقت المراجعة
  `4838c71cd2a9c2cae26a7017daddf12570aab9e1`.
- المراجعة والاستعلامات والمحاكاة قرائية ومحلية فقط. لم يحدث commit أو push
  أو merge، ولم يُعدّل أي رصيد أو سعر أو صف في Supabase، ولم تُشغّل أي
  مزامنة أو كتابة في الأمين. الملف الوحيد المعدّل بواسطة المراجعة هو
## 2026-07-27 - Codex - الجولة الأخيرة قبل دمج أصناف النشرة (`28776f5`)

- Status: **يوجد مانع واحد يمنع الدمج.** روجع الكوميت الفعلي
  `28776f57fb449a08eeebc9d7bf7ddb9788485b0e` مقابل أبيه المباشر
  `b4bb4c1e2e822c477ac94d5d8ef0cf23a0aa41e7` على الفرع
  `claude/bulletin-merge-cigarettes` داخل worktree المحدد. وكان ناتج
  `git rev-parse HEAD` قبل بدء المراجعة وعند نهايتها
  `28776f57fb449a08eeebc9d7bf7ddb9788485b0e`.
- حُصرت المراجعة بتغييري `skipMerge` و`sourceKeys`. لم يُشغّل مولّد
  النشرات، ولم يُعدّل أي سعر، ولم يحدث commit أو push أو merge أو حذف من
  Supabase أو كتابة في الأمين. الملف الوحيد المعدّل بواسطة المراجعة هو
  `AI_HANDOFF.md`.

### مانع يمنع الدمج

- **ترتيب «الترشيح ثم الدمج» ما زال غير مطابق للمولّد في نشرة السوري عند
  تجميع المعسل.** `prepareBulletinItems(true)` يستدعي
  `customerPriceListItems("mufrak", { skipMerge: true })`، لكنه لا يرشّح
  بسعر المفرق قبل `consolidateGeneralPriceItems`; ترشيح
  `itemRetailPrice > 0` يحدث لاحقاً بعد أن يكون تجميع المعسل قد اختار
  ممثلاً وحذف البقية. المولّد، في المقابل، يبني `sypItems` من الصفوف ذات
  `retail_carton_usd > 0` أولاً ثم يستدعي `consolidateGeneral`.
- إعادة إنتاج معزولة من الترتيب الحالي: صنف
  `مزايا ابيض` بسعر جملة `132` وبلا سعر مفرق، وهو يسبق أبجدياً صنف
  `مزايا ياسمين` بسعر جملة `132` ومفرق `150`. الموقع أبقى الأول ممثلاً
  لـ«مزايا مشكل»، ثم أسقط المجموعة عند تحويل السوري لأن مفرق الممثل صفر؛
  النتيجة `[]`. المولّد استبعد الأول قبل التجميع وأبقى الثاني؛ النتيجة
  `[retail-second]`. وأكد `localeCompare("ar")` أن «مزايا ابيض» يسبق
  «مزايا ياسمين».
- الجذر نفسه يكسر الاتساق المطلوب: قائمة الموقع في وضع المفرق قد تعرض
  السطر المدموج ممثلاً غير مسعّر، بينما معاينة/تصدير السوري تسقطه،
  والمولّد يعرض الصنف المسعّر. يلزم في وضع `mufrak` ترشيح العناصر بـ
  `itemRetailPrice(item) > 0` قبل
  `consolidateGeneralPriceItems`، كما صار شرط الوحدة الثانية يُطبّق قبل
  الدمج في الجملة.

### ما اجتاز المراجعة

- **كل مستدعيات `customerPriceListItems` صحيحة من ناحية `skipMerge`:**
  المستدعي في `prepareBulletinItems` وحده يطلب `skipMerge` ثم يستدعي
  `consolidateGeneralPriceItems` صراحةً بعد الترشيح؛ لذلك لا يخرج بلا دمج.
  المستدعي الآخر `customerPriceListItems()` لحساب بطاقة «مواد النشرة» لا
  يطلب التخطي، فيبقى مدموجاً ويسقط إلى `state.priceMode` كما كان.
- **الجملة أصبحت مطابقة في ترتيب المخزون:** حالة الاسم القانوني بمخزون
  `5/10` والنسخة الزرقاء بمخزون `20/10` أعادت في الموقع والمولّد النسخة
  ذات الوحدة الكاملة فقط قبل الدمج؛ لم يعد الممثل ناقص المخزون يبتلع
  الصنف الصالح ثم يسقط.
- **الأصناف العادية ومجموعات الأسماء الثلاثة في السوري** تطبق قرار السعر
  داخل `mergeBulletinNamedGroups` على المسعّرين في الوضع فقط؛ المانع
  محصور بتجميع المعسل السابق لهذه الدالة داخل
  `consolidateGeneralPriceItems`.
- **رجوع `sourceKeys` صحيح وآمن للتغيير المطلوب:** السطر المدموج من صنفين
  مسعّرين يحمل مفتاحيهما فقط، والصنف الثالث غير المسعّر يبقى خارجها.
  `savePricingItem` يحول المفاتيح إلى سجل لكل صنف، ويحافظ في وضع المفرق
  على سعر الجملة الخاص بكل سجل ويغير `retail.price` له.
- **رسالة عدد الأصناف ما زالت صحيحة:** العدد مأخوذ من `records.length`
  بعد إزالة المفاتيح غير القابلة للمطابقة، و`skippedLabel` يذكر ما تم
  تخطيه. في محاكاة صنفين مدموجين صالحين كانت الرسالة
  «على 2 أصناف مدمجة»، مطابقة للسجلين المرسلين للحفظ.
- المعاينة والتصدير يستخدمان كائن `prepared.items` نفسه، وقائمة الموقع
  تمر بترشيح المخزون ثم الدمج مثل مسار الجملة الجديد. الاتساق اجتاز
  الجملة ومجموعات الأسماء العادية؛ الاستثناء الوحيد هو حالة المعسل السوري
  المانعة أعلاه.
- نجحت `node --check src/app.js` و
  `node --check scripts/generate-price-lists.mjs` و`npm.cmd run check`
  برسالة `Project check passed`، ونجح
  `git diff --check b4bb4c1 28776f5`. بقي
  `CACHE_NAME=web-platform-tobacco-v397` وسبعة مراجع `tobacco-119`،
  ونهايات الأسطر بلا تدهور.

### ملاحظات تُسجّل ولا تمنع الدمج

- قبلت المراجعة دليل المالك بشأن
  `90071992547400.01 / 90071992547400.02`: بعد التحويل إلى JavaScript
  `Number` هما القيمة نفسها و`String` متطابق، لذلك لم يُعَد تسجيلهما
  مانعاً في هذه الجولة.
- حذف البادئة الرقمية هو السلوك القائم في `normalizeItemName` بالموقع،
  وإضافته إلى المولّد حققت التطابق بين الطرفين. لم يظهر في تغيير
  `28776f5` ما يبطل هذا الدليل، فسُجّل ملاحظة فقط لا مانعاً.

### الحكم النهائي

- **غير جاهز للدمج حالياً** بسبب مانع ترتيب ترشيح سعر المفرق قبل تجميع
  المعسل في نشرة السوري. لا توجد موانع أخرى ضمن التغيير المحصور.

## 2026-07-27 - Claude - الترشيح قبل الدمج، وحصر sourceKeys، وردّ على مانعين نظريين

- Status: **منجز على `claude/bulletin-merge-cigarettes` فوق `b4bb4c1`، غير
  مدموج وغير منشور.**

### المانعان الحقيقيان — أُغلقا

1. **الدمج كان يسبق الترشيح في نشرة الجملة:** كان الصف يُدمج ثم يُستبعد ما دون
   وحدة ثانية كاملة، فقد يسقط الممثّل ويختفي صنف صالح كان سيظهر في المولّد.
   صار **الترشيح أولاً ثم الدمج** (`skipMerge` في `customerPriceListItems`)،
   تماماً كترتيب المولّد.
2. **`sourceKeys` كانت تضم غير المسعّر:** وهذا يمنح سعر السطر المدمج لصنف قد
   يكون **منتجاً آخر** يبدأ بالاسم نفسه. **رجعتُ عن توسيعها في الجولة السابقة**
   بعد أن رجّح Codex الخطر المالي: خسارة تحديث alias غير مسعّر أهون بكثير من
   كتابة سعر على منتج مختلف. تحقّق: صنف ثالث غير مسعّر بقي **خارج**
   `sourceKeys` (`["k1","k2"]`).

### مانعان أُثبت أنهما نظريان — يُسجَّلان ولا يُلاحَقان

3. **«المفتاح الضخم لا يميّز `90071992547400.01` عن `.02`»** — الرقمان
   **عدد واحد بالضبط في JavaScript**: `a !== b` تعطي `false`، و`String()`
   تعطي `90071992547400.02` لكليهما. لا مفتاح ولا خوارزمية تستطيع التمييز
   بينهما لأن الفرق تحت دقة النوع نفسه. وأسعار العمل أصغر من هذا الحدّ
   بعشرة مليارات ضعف.
4. **«حذف بادئة رقمية يغيّر اسماً مثل `1970 - ماستر طويل ورق`»** — هذا سلوك
   `normalizeItemName` **القائم في الموقع أصلاً** ويُستعمل في كل المطابقات.
   إضافته للمولّد هي ما حقّق التطابق المطلوب؛ وحذفه يكسر التطابق مجدداً.
   تغيير قاعدة التطبيع في الموقع قرار أوسع من هذا الفرع ويمسّ مطابقة الأسعار
   والمخزون كلها — يُعرض على المالك منفصلاً إن أراد.

### الفحوص

- محاكاة التطابق: 26 مقارنة، القراران متطابقان في كلها.
- فحص `sourceKeys` الجديد ✅. `npm.cmd run check`، `node --check`،
  `git diff --check`: ناجحة. الكاش والأصول كما هما (v397 / tobacco-119).

### توصية

- هذه الجولة الخامسة على فرع مكسبه سطر واحد بدل اثنين لثلاثة أصناف. أرى
  التوقّف عند هذا الحدّ ودمجه، وأي تحسين لاحق يُفتح كمهمة مستقلة بطلب صريح.

## 2026-07-27 - Codex - مراجعة إغلاق موانع وضع الدمج (`b4bb4c1`)

- Status: **توجد أربعة موانع تمنع الدمج.** روجع الكوميت الفعلي
  `b4bb4c1e2e822c477ac94d5d8ef0cf23a0aa41e7` مقابل أبيه المباشر
  `8de5d35e2c2fd130ab7e053d7f89c2ec5aa175bf` على الفرع
  `claude/bulletin-merge-cigarettes` داخل worktree المحدد. وكان ناتج
  `git rev-parse HEAD` قبل بدء المراجعة وعند نهايتها
  `b4bb4c1e2e822c477ac94d5d8ef0cf23a0aa41e7`.
- لم يُشغّل مولّد النشرات، ولم يُعدّل أي سعر، ولم يحدث commit أو push أو
  merge أو حذف من Supabase أو كتابة في الأمين. الاختبارات محاكاة قرائية
  معزولة، والملف الوحيد المعدّل بواسطة المراجعة هو `AI_HANDOFF.md`.

### موانع تمنع الدمج

- **مسار PDF للجملة ما زال لا يطابق ترتيب تصفية المولّد، وقد يسقط صنفاً
  صالحاً بالكامل.** `customerPriceListItems("jumla")` يدمج كل الأصناف ذات
  المخزون الموجب أولاً، ثم `prepareBulletinItems(false)` يطبق
  `hasFullSecondUnit` على الممثل بعد الدمج؛ بينما المولّد يستبعد ما دون
  الوحدة الثانية الكاملة **قبل** الدمج. مثال مثبت في `b4bb4c1`:
  الاسم القانوني بسعر `190` ومخزون `5/10`، والنسخة الزرقاء بالسعر نفسه
  ومخزون `20/10`. الموقع اختار الاسم القانوني ممثلاً، حذف النسخة الزرقاء،
  ثم أسقط الممثل لنقص مخزونه فخرجت نشرة الجملة بلا أي منهما؛ المولّد
  استبعد الأول أولاً وأبقى النسخة الزرقاء. يلزم تمرير/تطبيق شرط المخزون
  قبل `consolidateGeneralPriceItems` في مسار PDF للجملة، كما يحدث في
  `generalPricingWorklistItems` والمولّد.
- **توسيع `sourceKeys` إلى كل مطابق بالاسم يستطيع تحديث منتج مختلف لمجرد
  أنه غير مسعّر.** قرار الدمج يستخدم المسعّرين فقط، لكن السطر الناتج يجمع
  مفاتيح `named` كلها بلا شرط آخر. في محاكاة الاسم القانوني والنسخة
  الزرقاء بسعر `190` مع صنف ثالث
  `ماستر طويل ورق اصدار فاخر` غير مسعّر، اندمج الأولان وأصبحت
  `sourceKeys = [base, blue, premium-unpriced]`. حفظ السطر يكتب السعر
  للثالث أيضاً، وبعدها يصبح مؤهلاً للدمج رغم أنه قد يكون منتجاً مختلفاً؛
  وهي الحالة التي كان اختلاف السعر يحميها سابقاً، لكن غياب السعر أزال
  الحماية. يلزم ألا يتوسع الحفظ إلى غير المسعّر إلا عبر قائمة aliases
  صريحة/هوية مجموعة موثوقة، أو إبقاؤه صفاً مستقلاً حتى يُسعّر ويُثبت
  تطابقه.
- **سقوط السعر الضخم إلى «النص الخام» يحدث بعد أن يكون النص الخام قد ضاع.**
  المولّد يحوّل حقول feed إلى `Number` في `mapRow` ثم يعيد `priceOf`
  تحويلها إلى `Number`، والموقع يعيد أرقاماً من `itemUnit2Price` أو
  `itemRetailPrice`. لذلك `mergePriceKey` و`bulletinMergePriceKey`
  يستقبلان رقماً لا النص الأصلي. المثال السابق ما زال يفشل داخل
  `b4bb4c1`: النصان `90071992547400.01` و`90071992547400.02` يتحولان
  كلاهما إلى الرقم `90071992547400.02`، ثم إلى المفتاح نفسه
  `raw:90071992547400.02` فيُدمجان. اختبار `1e13 + 0.01` ينجح فقط لأن
  القرش ما زال قابلاً للتمثيل عند ذلك المقدار، ولا يثبت المجال الأعلى.
  يلزم الاحتفاظ بالنص العشري من المصدر حتى بناء المفتاح، أو رفض قيمة لا
  تحقق دقة قرش آمنة قبل الدمج.
- **حذف البادئة الرقمية لا يميّز رقم الصنف من اسم مشروع يبدأ برقم.**
  النمط `^\d{2,}\s*[-–—]\s*` يحذف أي رقم من خانتين فأكثر؛ لذلك الاسم
  المشروع `1970 - ماستر طويل ورق` يُطبّع حرفياً إلى
  `ماستر طويل ورق` ويصبح مطابقاً لمجموعة ماستر. المشروع يحتوي فعلياً
  علامة `1970` وأسماء تبدأ بها، وإن كانت بيانات `price-data.json` الحالية
  لا تستعمل شرطة بعد السنة. يلزم ربط الحذف بحقل رقم الصنف المنفصل أو نمط
  موثوق لأرقام الأمين (مثلاً الطول الفعلي المعروف)، لا اعتبار كل
  رقم-شرطة بادئة تقنية.

### ما اجتاز المراجعة

- **تمرير الوضع أُغلق فعلاً:** `prepareBulletinItems` يمرر `mufrak` للسوري
  و`jumla` للدولار، و`customerPriceListItems` يمرره إلى
  `consolidateGeneralPriceItems` ثم `mergeBulletinNamedGroups`.
  `generalPricingWorklistItems` يمرر الوضع الحالي صراحةً. المستدعي الوحيد
  بلا وضع هو `customerPriceListItems()` لحساب بطاقة «مواد النشرة»، وسقوطه
  إلى `state.priceMode` صحيح لأنه يعرض عدّاد التبويب الحالي. لا يوجد
  مستدعٍ يمرر قيمة وضع خاطئة.
- التغيير المقصود أصلح حالة تصدير السوري أثناء بقاء التبويب على الجملة
  والعكس: قرار الدمج الآن يتبع نوع ملف PDF المطلوب لا حالة الصفحة. ولم
  يتغير تحويل السوري بسعر الصرف أو عرض سعر الجملة بعد مرحلة التجهيز.
- **تقرير المخزون لم يتأثر:** مساره يبدأ من
  `reportItems(latestStockReport())` داخل `inventoryReportPdfMarkup` ولا
  يستدعي أياً من دوال دمج النشرة المعدلة. كما لم يمس فرق الكوميت أي دالة
  من دوال التقرير، فيبقى كل صنف مستقلاً كما هو مطلوب.
- عند إعطاء الموقع والمولّد الاسم والسعر والوضع ومجموعة المخزون نفسها،
  بقي القرار متطابقاً في شبكة شملت السالب والصفر وغير الرقمي وحدود
  التقريب والأسعار المعتادة، وأُغلقت مطابقة البادئة ذات الست خانات
  `123456 -`. اختلاف القرار المثبت أعلاه سببه ترتيب فلتر المخزون لا قلب
  دالتي القرار.
- `sourceKeys` الموسعة تحدّث جميع النسخ المقصودة إذا كانت قائمة المطابقات
  نفسها موثوقة، وحفظ وضع المفرق يحافظ على سعر الجملة الخاص بكل مفتاح
  ويغيّر `retail.price` لكل سجل مستهدف. المانع هو توسيع الثقة إلى صنف غير
  مسعّر قد يكون منتجاً آخر، لا تنفيذ الحفظ بعد وصول المفاتيح.
- ترتيب الصفوف وحذف الفهارس وفرز الموقع لم تتغير. كما بقي
  `CACHE_NAME=web-platform-tobacco-v397` وسبعة مراجع
  `tobacco-119` بلا تغيير عن الأب، وهو سليم لأن السلسلة السابقة لم تُنشر.
- نهايات الأسطر لم تتدهور: `index.html` بقي `1700` بايت و`CR=19` و
  `LF=26` مع LF أخير؛ و`src/app.js` بقي LF فقط (`CR=0`) مع LF أخير.
- نجحت `node --check src/app.js` و
  `node --check scripts/generate-price-lists.mjs` و`npm.cmd run check`
  برسالة `Project check passed`، ونجح
  `git diff --check 8de5d35 b4bb4c1`.

### ملاحظات تُسجّل ولا تمنع الدمج

- لا توجد حالياً أسماء في `scripts/price-data.json` تطابق صيغة
  `رقم - اسم`؛ توجد سبعة أسماء تبدأ بعلامة `1970` بلا شرطة. خطر حذف الاسم
  المشروع مستقبلي/قادِم من feed الحي، لكنه سُجّل مانعاً لأن النمط نفسه لا
  يملك وسيلة للتمييز ويمكن أن يوجّه حفظ سعر إلى منتج خاطئ.
- حد `1e12` محافظ ويعمل للقيم الضخمة التي ما زالت ممثلة بدقة كافية؛ المشكلة
  ليست اختيار الحد بل فقد النص قبل وصوله إلى الدالة.

## 2026-07-27 - Claude - إغلاق موانع الدمج الأربعة (وضع التصدير والمفاتيح والتطبيع)

- Status: **منجز على `claude/bulletin-merge-cigarettes` فوق `8de5d35`، غير
  مدموج وغير منشور.** لم يُشغَّل المولّد ولم يُعدَّل أي سعر.

### الموانع الأربعة

1. **وضع التصدير كان يتبع تبويب الصفحة:** تصدير نشرة السوري والصفحة على وضع
   الجملة كان يدمج بقرار الوضع الخاطئ، لأن `useSyria` لا يصل إلى الدمج. صار
   الوضع يُمرَّر صراحةً عبر السلسلة كاملة:
   `prepareBulletinItems(useSyria)` ← `customerPriceListItems(mode)` ←
   `consolidateGeneralPriceItems(items, mode)` ← `mergeBulletinNamedGroups(items, mode)`.
   وقائمة الموقع تمرّر `state.priceMode` صراحةً بدل الاعتماد على السقوط.
2. **`sourceKeys` كانت تفقد غير المسعّر:** القرار يبقى على المسعّرين في ذلك
   الوضع، لكن **مفاتيح المصدر صارت تضم كل المتطابقين بالاسم** فيحدّث حفظ سعر
   السطر المدمج حتى الصنف غير المسعّر. تحقّق: ثلاثة أصناف أحدها بلا سعر →
   `sourceKeys = ["k1","k2","k3"]`.
3. **الأرقام الضخمة:** فوق `1e12` تفقد الفاصلة العائمة دقة القرش، فصار
   المفتاح يسقط إلى مقارنة النص الخام في الطرفين بدل رقم قد يوحّد سعرين
   مختلفين. تحقّق: `1e13` مقابل `1e13 + 0.01` لم يُدمجا.
4. **تطبيع الاسم:** الموقع يحذف بادئة رقم الصنف («123456 - اسم») والمولّد لا،
   فاختلف القراران. أُضيف الحذف نفسه إلى `normalizeMergeName`.

### الفحوص

- محاكاة التطابق: **13 حالة × وضعين = 26 مقارنة**، القراران متطابقان في كلها،
  بما فيها الحالات الأربع الجديدة (بادئة رقمية، سعر ضخم، سعر سالب، وسعر
  موجود بوضع واحد).
- فحص `sourceKeys` منفصل ✅. محاكاة الدمج الأصلية: 13 فحصاً ✅.
- `npm.cmd run check`، `node --check` للملفين، `git diff --check`: ناجحة.
- الكاش والأصول كما هما (v397 / tobacco-119) لأن ما قبله لم يُنشر.
  `index.html` CR=19، `src/app.js` CR=0.

## 2026-07-27 - Codex - مراجعة قرار الدمج لكل وضع (`8de5d35`)

- Status: **توجد أربعة موانع تمنع الدمج.** روجع الكوميت الفعلي
  `8de5d35e2c2fd130ab7e053d7f89c2ec5aa175bf` مقابل أبيه المباشر
  `d8de3ce8645152c5ef5d57e1acdc3f9ec71e2b9f` على الفرع
  `claude/bulletin-merge-cigarettes` داخل worktree المحدد. وكان ناتج
  `git rev-parse HEAD` وقت المراجعة
  `8de5d35e2c2fd130ab7e053d7f89c2ec5aa175bf`.
- لم يُشغّل مولّد النشرات، ولم يُعدّل أي سعر، ولم يحدث commit أو push أو
  merge أو حذف من Supabase أو كتابة في الأمين. الاختبارات محاكاة قرائية
  معزولة، والملف الوحيد المعدّل بواسطة المراجعة هو `AI_HANDOFF.md`.

### موانع تمنع الدمج

- **الوضع الافتراضي صحيح لقائمة التسعير، لكنه خاطئ لمسار تصدير نشرة مخالفة
  للتبويب الحالي.** المستدعي الوحيد المباشر
  `consolidateGeneralPriceItems` يستدعي
  `mergeBulletinNamedGroups` بلا وسيط، فيسقط إلى `state.priceMode`.
  هذا صحيح داخل `generalPricingWorklistItems` لأن التبويب هو المطلوب، لكنه
  غير صحيح داخل `prepareBulletinItems(useSyria)`: الدالة تستدعي
  `customerPriceListItems()` أولاً بلا تمرير `useSyria`، ثم تطبق وضع
  التصدير **بعد أن يكون الدمج قد حذف الصفوف ولا يمكن فكّه**. أثبتت
  المحاكاة:
  - مع تبويب `jumla` وتصدير السوري، سعرَا جملة متساويان `190/190` ومفرق
    مختلفان `210/220` اندمجا حسب الجملة، بينما قرار السوري الصحيح هو عدم
    الدمج.
  - مع تبويب `mufrak` وتصدير الدولار، مفرق متساوٍ `210/210` وجملة مختلفة
    `190/200` اندمجا حسب المفرق، بينما قرار الدولار الصحيح هو عدم الدمج.
  مستدعيا المولّد يمرران `usd` و`syp` بصورة صحيحة، ولا يوجد مستدعٍ يمرّر
  وضعاً صريحاً خاطئاً؛ الخلل هو غياب الوسيط في مسار PDF. يلزم تمرير الوضع
  من `prepareBulletinItems` إلى `customerPriceListItems` ثم
  `consolidateGeneralPriceItems`.
- **استبعاد غير المسعّر في الوضع يحذفه أيضاً من `sourceKeys` للسطر
  المدموج.** عند وجود `A` و`B` مسعّرين مفرقاً و`C` مطابق بالاسم بلا سعر
  مفرق، يدمج الموقع `A/B` ويضع فقط `[A,B]` في `sourceKeys`؛ يبقى `C`
  كسطر مستقل لكنه لا يتلقى السعر عند حفظ السطر المدموج. التوسعة اللاحقة
  في `generalPricingWorklistItems` لا تعالج أسماء السجائر الثلاثة لأنها
  مقيدة بـ`isGeneralShishaPriceItem(candidate)`، أي بالمعسل فقط. مسار
  الحفظ في وضع المفرق يحدّث كل المفاتيح التي وصلته بصورة صحيحة ويحافظ على
  سعر جملة كل صنف، لكنه لا يستطيع تحديث `C` لأنه لم يصله أصلاً. يلزم فصل
  أعضاء قرار السعر عن مفاتيح التحديث: القرار يستعمل المسعّر في الوضع،
  بينما `sourceKeys` تجمع كل مطابقات الاسم المقصودة، بما فيها غير المسعّر.
- **مفتاح القروش الرقمي يدمج فرق قرش واحد عند تجاوز دقة الفاصلة
  العائمة.** الدالتان متطابقتان، لكنهما تعيدان `Number` بعد ضرب السعر في
  100؛ فوق حد الأعداد الصحيحة الآمنة لا يمكن تمثيل كل قرش. مثال مثبت:
  `90071992547400.01` و`90071992547400.02` أعطيا المفتاح نفسه
  `9007199254740002`، فيُدمجان رغم فرق قرش حقيقي. وكذلك
  `1000000000000000.00` و`1000000000000000.01` يتحولان إلى قيمة
  `Number` واحدة. في المجال العملي، `190.01` و`190.02` بقيا مفتاحين
  مختلفين. لكن شرط المراجعة طلب صراحة القيم التي تتجاوز دقة الفاصلة
  العائمة؛ يلزم مفتاح عشري نصي/BigInt بالقروش قبل فقد الدقة، أو حد صريح
  يرفض الأسعار غير الآمنة بدلاً من دمجها.

### مانع تطابق إضافي قائم في الكوميت نفسه

- **تطبيع الاسم ليس متطابقاً بين الطرفين.** الموقع يحذف بادئة رقمية من
  شكل `123456 - ` في `normalizeItemName`، بينما `normalizeMergeName` في
  المولّد لا يحذفها. محاكاة
  `123456 - ماستر طويل ورق` مع `ماستر طويل ورق ازرق` بالسعر نفسه أعطت
  `merge` في الموقع و`none` في المولّد. هذا ليس منطق السعر الجديد، لكنه
  ينقض شرط أن القرارين متطابقان في كل الحالات داخل `8de5d35`، ولا سيما
  أن دعم البادئة الرقمية موجود عمداً في الموقع. يلزم توحيد تطبيع الاسم
  نفسه أو مشاركته بين الطرفين.

### ما اجتاز المراجعة

- عند إعطاء الطرفين **الأسماء والقيم والوضع نفسيهما**، أعطى فحص شبكي
  للقيم السالبة والصفرية وغير الرقمية والصغيرة وحدود التقريب والأسعار
  المعتادة صفر اختلاف في القرار. حالة سعر جملة موجب مع مفرق سالب أو
  `NaN` اندمجت في وضع الجملة عند تساوي الجملة، واستُبعدت بالكامل من قرار
  المفرق في الطرفين.
- التقريب المزدوج موحّد نصياً، وأغلق حالة
  `190.0049 / 190.005` كما قصد الكوميت. كما لم يدمج فرق قرش واحد في
  المجال الآمن: `190.01 / 190.02` بقيا مختلفين. الفشل محصور بالأرقام التي
  تفقد القروش عند تحويلها إلى `Number`.
- مفتاح التنبيه `الاسم|الوضع` مستقل: الاسم نفسه طبع تنبيهين منفصلين لـ
  `usd` و`syp`، واسم مختلف لم يُكتم. ويظل الحارس جديداً في كل عملية Node.
- حفظ الموضع والحذف التنازلي لم يتغيرا: محاكاة مجموعتي دمج متداخلتين
  أبقت الصفوف الفاصلة بترتيبها، وحل الممثل القانوني محل أول ظهور بلا نسخة
  زائدة. فرز الموقع ما زال بالمجموعة ثم الاسم بالعربية.
- `sourceKeys` ما زالت تضم كل الأصناف **المسعّرة في الوضع والتي اندمجت
  فعلاً**، وحفظ المفرق يبني سجلاً لكل مفتاح منها ويحافظ على
  `unit2Price` الموجود لكل صنف. المانع أعلاه يخص المطابق غير المسعّر الذي
  استُبعد من `entries` قبل جمع المفاتيح.
- الكاش والأصول لم يتغيرا عن الأب: `CACHE_NAME` هو
  `web-platform-tobacco-v397`، و`index.html` يحتوي سبعة مراجع فقط إلى
  `tobacco-119` وكل الأصول موجودة. عدم رفعهما سليم لأن سلسلة الفرع
  السابقة لم تُنشر.
- نهايات الأسطر لم تتدهور: `index.html` بقي حرفياً `1700` بايت،
  `CR=19` و`LF=26` (`7` LF منفردة) مع LF أخير؛ و`src/app.js` بقي LF فقط
  (`CR=0`) مع LF أخير.
- نجحت `node --check src/app.js` و
  `node --check scripts/generate-price-lists.mjs` و`npm.cmd run check`
  برسالة `Project check passed`، ونجح
  `git diff --check d8de3ce 8de5d35`.

### ملاحظات تُسجّل ولا تمنع الدمج

- اختيار الوضع داخل الدالتين نفسه واضح ومتطابق: المولّد يعامل `syp`
  كمفرق وما عداه جملة، والموقع يعامل `mufrak` كمفرق وما عداه جملة.
  الاستدعاءان الفعليان للمولّد صحيحان؛ المشكلة في الموقع هي أن مسار PDF
  لا يمرّر الوضع أصلاً.
- الأسعار الواقعية الحالية بعيدة جداً عن حد `Number.MAX_SAFE_INTEGER`
  بالقروش، لذلك مانع الأعداد الضخمة لن يظهر في النشرات التشغيلية المعتادة؛
  سُجّل مانعاً لا ملاحظة فقط لأن الطلب اشترط هذه الحالة وفرق القرش صراحة.

## 2026-07-27 - Claude - قرار الدمج صار لكل نشرة على حدة

- Status: **منجز على `claude/bulletin-merge-cigarettes` فوق `d8de3ce`، غير
  مدموج وغير منشور.** لم يُشغَّل المولّد ولم يُعدَّل أي سعر.

### المانع الأول — اختلاف القرار عند سعر مفقود بأحد الوضعين

- الجذر: المولّد يبني **نشرة لكل وضع** من قائمة مفلترة بسعر ذلك الوضع، بينما
  كان الموقع يقرّر مرة واحدة بسعرَي الجملة والمفرق معاً. فصنف مسعّر جملةً بلا
  مفرق كان يغيّر قرار الموقع ولا يظهر أصلاً في نشرة الدولار.
- التوحيد: **القرار صار لكل وضع على حدة في الطرفين** — نشرة الدولار/وضع
  الجملة يقارنان سعر الكرتونة وحده، ونشرة السوري/وضع المفرق يقارنان سعر
  المفرق وحده، وغير المسعّر في ذلك الوضع لا يشارك في القرار ولا يظهر.
  `mergeBulletinNamedGroups(items, mode)` تأخذ الوضع (وتسقط إلى
  `state.priceMode`)، و`mergeNamedGroups(items, mode)` كذلك.

### المانع الثاني — حدّ التقريب

- الموقع يقرّب إلى ثلاث منازل قبل المقارنة والمولّد كان يقارن الخام، فاختلف
  القراران عند `190.0049` مقابل `190.005`. صار **التقريب المزدوج نفسه** في
  الطرفين: ثلاث منازل ثم قروش.

### فحص التطابق

- المحاكاة تشغّل الدالتين الفعليتين على **عشر حالات × وضعين = 20 مقارنة**،
  والقراران متطابقان في **كلها**: متطابقان تماماً، مفرق مفقود للاثنين، ثالث
  بلا سعر، اختلاف بالجملة فقط، اختلاف بالمفرق فقط، **أحدهما بسعر جملة فقط**،
  **أحدهما بسعر مفرق فقط**، صنف جديد أغلى، وحدّا التقريب `190.0049/190.005`
  (يُدمجان) و`190.004/190.006` (لا يُدمجان بالجملة ويُدمجان بالمفرق).
- محاكاة الدمج الأصلية: 13 فحصاً صفر إخفاق. `npm.cmd run check`،
  `node --check` للملفين، `git diff --check`: ناجحة.
- التنبيه صار مفتاحه `الاسم|الوضع` فلا يُكتم تنبيه نشرة بسبب الأخرى.
- الكاش والأصول كما هما (v397 / tobacco-119). `index.html` CR=19،
  `src/app.js` CR=0.

## 2026-07-27 - Codex - مراجعة توحيد قرار دمج النشرة (`d8de3ce`)

- Status: **يوجد مانعان يمنعان الدمج.** روجع الكوميت الفعلي
  `d8de3ce8645152c5ef5d57e1acdc3f9ec71e2b9f` مقابل أبيه المباشر
  `7a3284391efb2c4dd90407597799d037938eb263` على الفرع
  `claude/bulletin-merge-cigarettes` داخل worktree المحدد. وكان ناتج
  `git rev-parse HEAD` وقت المراجعة
  `d8de3ce8645152c5ef5d57e1acdc3f9ec71e2b9f`.
- لم يُشغّل مولّد النشرات، ولم يُعدّل أي سعر، ولم يحدث commit أو push أو
  merge أو حذف من Supabase أو كتابة في الأمين. الاختبارات محاكاة قرائية
  معزولة، والملف الوحيد المعدّل بواسطة المراجعة هو `AI_HANDOFF.md`.

### موانع تمنع الدمج

- **الموقع والمولّد ما زالا لا يقرران على المجموعة نفسها عند وجود صنف
  مسعّر في وضع واحد فقط.** مفتاح القروش الجديد متطابق نصياً، لكن المولّد
  ينشئ `usdItems` و`sypItems` بتصفية مختلفة قبل استدعاء
  `mergeNamedGroups`، بينما الموقع يمرّر كل صنف له أي سعر موجب إلى قرار
  واحد. أثبتت المحاكاة حالتين مباشرتين:
  - صنفان بسعري `190|210` وثالث بسعر جملة موجب ومفرق مفقود `190|0`:
    الموقع ومولّد الدولار يريان غموضاً ولا يدمجان، لكن مولّد السوري يستبعد
    الثالث ويدمج الصنفين.
  - صنفان بسعري `190|210` وثالث مسعّر مفرقاً فقط `0|210`: الموقع ومولّد
    السوري لا يدمجان، لكن مولّد الدولار يستبعد الثالث ويدمج الصنفين.
  لذلك شرط «بلا **أي** سعر موجب» عالج الصنف الصفري كلياً فقط، ولم يحقق
  تطابق القرار في حالتي السعر الجزئي المطلوبتين. يلزم حساب قرار المجموعة
  مرة واحدة من المصدر الكامل ثم تطبيقه على النشرتين، أو تمرير قرار موحد
  إليهما بعد ذلك.
- **مفتاح القروش لا يستقبل القيمة نفسها في الطرفين عند حدود التقريب.**
  `pricingWorklistItems` و`customerPriceListItems` يمران السعر في
  `itemUnit2Price` الذي يطبّق `roundPrice` إلى ثلاث منازل قبل
  `bulletinMergePriceKey`، بينما المولّد يمرّر `unit2_price` الخام مباشرة
  إلى `mergePriceKey`. لذلك زوج `190.0049` و`190.005` أعطى في المولّد
  `19000` و`19001` فرفض الدمج، بينما قرّب الموقع الأول مسبقاً إلى
  `190.005` فأعطى `19001` للاثنين ودمجهما. القيمة `190.005` وحدها
  مستقرة ومتطابقة، لكن القرار ليس متطابقاً لجميع القيم حول الحد كما طُلب.
  يلزم أن يستقبل مفتاح الطرفين القيمة الخام نفسها أو أن يطبّقا مرحلة
  التطبيع السابقة نفسها حرفياً.

### ما اجتاز المراجعة

- **الصنف غير المسعّر كلياً لا يُحذف من نتيجة الدمج:** الفلتر الجديد يزيله
  من `entries` فقط ولا يزيله من `result`. محاكاة مجموعتين متداخلتين مع صفوف
  فاصلة وصنف غير مسعّر أبقته كما هو. ويظل استبعاده من نشرة الزبون اللاحقة
  مقصوداً لأنها لا تعرض سعراً صفرياً، بينما يبقى في قائمة التسعير داخل
  الموقع كي يمكن تسعيره.
- **`mergeWarned` صحيح:** استدعاءات متكررة للاسم نفسه طبعت تنبيهاً واحداً،
  واسم مختلف طبع تنبيهه المستقل. الحارس `Set` على مستوى وحدة المولّد،
  ولذلك يبدأ فارغاً عند تشغيل عملية Node جديدة ولا يكتم تنبيه تشغيلة لاحقة.
- **`sourceKeys` ومسار الحفظ صحيحان للأصناف التي اندمجت فعلاً:** السطر
  المدموج يجمع `item.key` لكل أعضاء `entries`، ونموذج التسعير ينقلها في
  `data-source-keys`. ثم يستخدم `savePricingItem` القائمة كلها في
  `requestedKeys` ويزيل التكرار قبل بناء سجل لكل مفتاح؛ لا توجد كتابة
  تجريبية إلى Supabase أثناء المراجعة.
- **الموضع والحذف التنازلي صحيحان:** في محاكاة مجموعتي دمج متداخلتين مع
  صفوف غير مستهدفة، حلّ كل سطر مدموج مكان أول ظهور له، واختيار ممثل موجود
  لاحقاً لم يترك نسخة إضافية. حذف الفهارس من الأكبر للأصغر لم يزح صفاً
  مجاوراً. وفرز الموقع النهائي ما زال بالمجموعة ثم الاسم بالعربية دون
  تغيير.
- **الكاش والأصول:** `CACHE_NAME` هو
  `web-platform-tobacco-v397`، و`index.html` يحتوي سبعة مراجع فقط إلى
  `tobacco-119` ولا يحتوي نسخة `tobacco-*` أخرى، وكل الأصول المشار إليها
  موجودة. لم يتغير `index.html` ولا `public/service-worker.js` عن الأب.
  و`main` المحلي ما زال عند `v396`، لذلك إبقاء v397/tobacco-119 في هذا
  الكوميت سليم لأن سلسلة الفرع السابقة لم تُنشر بعد.
- نجحت `node --check src/app.js` و
  `node --check scripts/generate-price-lists.mjs` و`npm.cmd run check`
  برسالة `Project check passed`، ونجح
  `git diff --check 7a32843 d8de3ce`.

### ملاحظات تُسجّل ولا تمنع الدمج

- `mergePriceKey` و`bulletinMergePriceKey` متطابقتان نصياً، كما أن منطق
  «كل المجموعة أو لا شيء» داخل الدالتين متطابق عند إعطائهما العناصر
  والقيم نفسها. المانعان يقعان قبل المفتاح: اختلاف أعضاء المجموعة بعد
  تصفية النشرة، واختلاف تطبيع السعر قبل تمريره إلى المفتاح.
- لم تُرفع هوية الكاش في هذا الكوميت نفسه، وهذا ليس انحداراً ما دام
  v397/tobacco-119 السابقان لم يصلا إلى الإنتاج؛ عند نشر السلسلة كاملة
  سيصل المتصفح مباشرة إلى الهوية الجديدة الموجودة في الفرع.

## 2026-07-27 - Claude - توحيد قرار الدمج بين الموقع والمولّد

- Status: **منجز على `claude/bulletin-merge-cigarettes` فوق `7a32843`، غير
  مدموج وغير منشور.** لم يُشغَّل مولّد النشرات ولم يُعدَّل أي سعر.

### المانع الأول — الطرفان يقرّران على مجموعتين مختلفتين

- المولّد يستبعد الصنف غير المسعّر **قبل** الدمج (قوائمه مفلترة أصلاً)، بينما
  كان الموقع يُدخله في قرار الغموض فيمنع دمجاً مشروعاً. وكان الموقع يقارن
  سعراً مشتقاً مقرَّباً بينما يقارن المولّد الرقم الخام.
- التوحيد: **دالة مفتاح واحدة بنصّها في الطرفين** (`mergePriceKey` /
  `bulletinMergePriceKey`) تقارن بالقروش (خانتان عشريتان) لسعرَي الجملة
  والمفرق معاً؛ **وكلا الطرفين يستبعد الصنف بلا أي سعر موجب** من القرار.

### المانع الثاني — تنبيه مكرر

- الدالة تُستدعى مرتين (دولار ثم سوري) فكان التنبيه يُطبع مرتين للاسم نفسه.
  أُضيف `mergeWarned` على مستوى الوحدة: **تنبيه واحد لكل اسم** مهما تكرّر
  الاستدعاء. تحقّق فعلي: استدعاءان ← تنبيه واحد.

### فحص التطابق (الأهم)

- محاكاة جديدة تشغّل **الدالتين الفعليتين** — من المولّد ومن `src/app.js` —
  على المدخلات نفسها وتقارن القرارين في سبع حالات: متطابقان تماماً؛ سعر مفرق
  صفر للاثنين؛ ثالث بلا أي سعر؛ اختلاف بالجملة فقط؛ **اختلاف بالمفرق فقط**؛
  صنف جديد بسعر أعلى؛ فرق كسري دون القرش. **القراران متطابقان في السبع.**
- (أمسكت المحاكاة أولاً خطأً في تجهيزة الاختبار نفسها — `pricePayload` بلا
  `approvedPrice` — فصُحّحت التجهيزة لا الكود.)
- محاكاة الدمج الأصلية: 13 فحصاً ناجحاً. `npm.cmd run check`،
  `node --check` للملفين، `git diff --check`: ناجحة.
- الكاش والأصول كما هما (v397 / tobacco-119) لأن ما قبله لم يُنشر.
  `index.html` CR=19، `src/app.js` CR=0.

## 2026-07-27 - Codex - مراجعة إغلاق موانع دمج النشرة (`7a32843`)

- Status: **يوجد مانعان يمنعان الدمج.** روجع الكوميت الفعلي
  `7a3284391efb2c4dd90407597799d037938eb263` مقابل أبيه المباشر
  `29a6cd176818399be15fd498a96ac052ff35cbdd` على الفرع
  `claude/bulletin-merge-cigarettes` داخل worktree المحدد. وكان ناتج
  `git rev-parse HEAD` وقت المراجعة
  `7a3284391efb2c4dd90407597799d037938eb263`.
- لم يُشغّل مولّد النشرات ولم يُعدّل أي سعر، ولم يحدث commit أو push أو
  merge أو حذف من Supabase أو كتابة في الأمين. الاختبارات محاكاة قرائية
  معزولة للدوال الفعلية، والملف الوحيد المعدّل بواسطة المراجعة هو
  `AI_HANDOFF.md`.

### موانع تمنع الدمج

- **فشل التحديث لا يُكتشف ويُفرغ التقارير والاختيار.**
  `loadCustomerBalanceReports()` تبتلع أخطاء كل طلب داخلياً وتصفّر
  `state.customerBalanceReports` و`state.customerMovementsReport` ثم تنتهي
  بنجاح؛ لذلك `try/await` في معالج `gen-receipt` يعيّن
  `refreshed=true` حتى عند فشل الشبكة. محاكاة الدالتين الفعليتين أعطت:
  `reportCount=0` و`customerMovementsReport=null` والزبون المختار غير موجود
  بعد العملية. السند يُصدر من كائن `before` بوسم «الرصيد الحالي»، لكن من
  دون تحذير لأن فرع `!refreshed` لا يعمل. هذا يخالف شرط إبقاء القائمة
  والاختيار وإبلاغ المستخدم بأن الرقم من نسخة قديمة.
- **النقر المزدوج يصدر سندين مختلفين للدفعة نفسها.** لا يوجد قفل in-flight
  ولا تعطيل للزر قبل `await loadCustomerBalanceReports()`. استدعاء callback
  الفعلي مرتين قبل اكتمال التحميل شغّل طلبَي تحميل وصدّر سندين؛ ومع
  `docNumber("R")` بعد الانتظار أخذا رقمين مختلفين (`R-1` و`R-2` في
  المحاكاة). يلزم حارس مشترك لكل عنصر/دفعة أو تعطيل الزر داخل
  `try/finally`.
- **المعالج المعدّل غير موصول بأي زر مولّد.** البحث في المستودع كله وجد
  `gen-receipt` مرة واحدة فقط: selector الخاص بربط المعالج. أزرار «سند قبض
  PDF» الفعلية تحمل `data-action="gen-movement-doc"`، وهذا المسار بقي
  مطابقاً بايتياً للأب ويستعمل `data-doc-new` مباشرة. لذلك
  `paymentMovementBalance` والسحب الطازج و`currentBalance` الجديدة لا تعمل
  عند الضغط على زر سند القبض الموجود حالياً، ولا يظهر سطر الرصيد الحالي
  الإضافي في المسار الفعلي.
- **سطر `currentBalance` غير محصور بسند القبض داخل القالب.** شرط
  `voucherPdfMarkup` يفحص وجود الحقل واختلافه فقط، بلا
  `v.type === "receipt"`. اختبار القالب الفعلي بتمرير الحقل أظهر السطر
  للفاتورة والمرتجع وسند الصرف أيضاً. صحيح أن المستدعين الحاليين لهذه
  الأنواع لا يمررونه، لكن شرط العزل المطلوب غير موجود في القالب نفسه؛ يلزم
  حارس نوع صريح. شرط تساوي الرصيدين يعمل ولا يضيف السطر.
- **عملة زبون الليرة تُوسَم خطأً.** أرصدة `ac000.Debit-ac000.Credit` ودفعات
  `en000.Credit` في هذا المسار هي مبالغ عملة الأساس بالدولار، وهو موثّق
  أيضاً في تعليق `customerBalanceSortValue` واستعلام المزامنة. مع ذلك يمرر
  المعالج `cur: customerCurrency(item)`؛ وعند override أو ملف زبون بالليرة
  يطبع المبلغ و`docNew` والرصيد الحالي نفسيهما بوسم `ل.س` بلا أي تحويل.
  محاكاة القالب طبعت `6727.5 ل.س` و`7794.5 ل.س` لقيم الدولار. يلزم إبقاء
  هذه الأرقام بالدولار، أو تحويل موثوق بسعر واتجاه صريح قبل تغيير الوسم.

### ما اجتاز المراجعة

- القراءة المباشرة من الأمين للزبون «ابو محمد مركز الكوثر /عين ترما» أثبتت
  دفعة `3,700` بتاريخ `2026-07-26`: الرصيد الزمني
  `balanceChrono=6,727.5` و`docPrev=10,427.5` و`docNew=6,727.5`.
  رصيد الحساب الحالي من `ac000` هو `7,794.5$`. لذلك الرقم الصحيح لسند
  الدفعة هو `6,727.5`، لا الرصيد الحالي.
- `paymentMovementBalance()` أعادت `6,727.5` للحركة الحقيقية. وعند إضافة
  مرشح ثانٍ بالمبلغ واليوم نفسيهما أعادت `null`؛ شرط
  `candidates.length !== 1` يمنع اختيار مرشح عشوائي كما هو مطلوب.
- في `voucherPdfMarkup` ظهر «الرصيد الحالي (بعد حركات لاحقة)» لسند القبض
  عندما اختلف `7,794.5` عن `6,727.5`، ولم يظهر عندما تساويا.
- تحويل callback إلى `async` لم يمنع ربط المعالجات اللاحقة في `render`.
  وكتلتا `gen-movement-doc` و`gen-invoice-doc` مطابقتان بايتياً للأب:
  SHA-256 للأولى
  `6c693cc04a20c4a1eb8c32a7f228ae0922fc35d98c9d3c1402276ddc572fd1ec`
  وللثانية
  `ba958b3f52c49e8039e7d71c6d61f717f4126640c3b88758994e81fba89130a1`.
- `CACHE_NAME` هو `web-platform-tobacco-v396`، أي أعلى بواحد من الأب و
  `main` (`v395`). يحتوي `index.html` سبعة مراجع فقط إلى
  `tobacco-118` ولا توجد بقايا إصدار آخر، وكل أصول service worker الأربعة
  عشر موجودة فعلياً.
- نهايات أسطر `index.html` لم تتغير عن الأب: في الحالتين `CR=19` و`LF=26`
  (`19` CRLF و`7` LF منفردة)، وحجم الملف `1700` بايت.
- نجحت `node --check src/app.js` و`npm.cmd run check` برسالة
  `Project check passed`، ونجح `git diff --check f8a8eb5 4838c71`.

### ملاحظات تُسجّل ولا تمنع الدمج

- المسار الفعلي `gen-movement-doc` كان قبل هذا الكوميت يطبع
  `storedDocNew=6,727.5` بصورة صحيحة؛ التغيير الجديد لا يصحح ذلك الرقم بل
  يحاول إضافة التحديث الطازج وسطر الرصيد الحالي لمسار legacy غير مستخدم.
  ينبغي توحيد مساري سند القبض أو حذف المسار الميت بعد نقل السلوك المطلوب
  إلى الزر الفعلي، كي لا يتكرر إصلاح أحدهما وترك الآخر.
- مطابقة المبلغ في `paymentMovementBalance` تستخدم سماحية `±0.5`. التصادم
  المتطابق محمي، لكن تضييق السماحية إلى دقة المبالغ المخزنة سيكون تحصيناً
  مناسباً لمستند مالي بعد إصلاح الموانع أعلاه.

## 2026-07-27 - Claude - رصيد سند القبض: الرصيد الزمني بدل الرصيد الحالي

- Status: **منجز على `claude/receipt-voucher-balance` فوق `f8a8eb5`، غير مدموج
  وغير منشور.** لا كتابة في الأمين أو Supabase ولا تعديل أي رصيد أو سعر.

### البلاغ والتشخيص الحقيقي

- بلّغ المالك أن سند قبض لـ«ابو محمد مركز الكوثر /عين ترما» (دفعة 3,700)
  طبع «الرصيد بعد الدفعة: 6,727.5» بينما رصيد الأمين 7,794.5.
- **الفحص أثبت أن المزامنة سليمة تماماً**: الأمين الحيّ 7,794.5 وSupabase
  7,794.5 (تقرير عمره ثوانٍ) — مطابقان.
- والأهم: القيود المخزّنة تقول إن **6,727.5 هو فعلاً الرصيد بعد تلك الدفعة**
  (`docPrev=10,427.5` → `docNew=6,727.5`)، ثم جاءت فاتورة 1,067 بعدها في اليوم
  نفسه فصار 7,794.5. أي أن الرقم المطبوع كان صحيحاً بمعناه، والفرق ليس خطأ
  حسابياً ولا خسارة مال.

### العطل الكامن الذي كُشف أثناء الفحص (وهو الخطر الحقيقي)

- الكود كان يمرّر `balance: customerBalance(item)` أي **الرصيد الحالي**، بينما
  القالب يسمّيه «الرصيد بعد الدفعة». في حالة المالك تصادف أن الصفحة كانت
  محمَّلة قبل فاتورة الـ1,067 فطابق الرقمان بالصدفة. **على صفحة محدَّثة كان
  سيطبع 7,794.5 تحت وسم «الرصيد بعد الدفعة» — رقم خاطئ على مستند رسمي.**

### الإصلاح

- `paymentMovementBalance()` جديدة: تجد قيد الدفعة في حركات الزبون وتُرجع
  رصيد المستند الزمني (`docNew`/`balanceChrono`) — نفس قاعدة مستند الفاتورة
  الموثّقة. **وعند تصادم** (دفعتان بالمبلغ واليوم نفسيهما) تُرجع `null` ولا
  تخمّن.
- زر سند القبض صار **يسحب أحدث الأرصدة والحركات قبل الإصدار** (`await
  loadCustomerBalanceReports()`)؛ وإن فشل السحب لا تُلغى العملية بل يُطبع
  «الرصيد الحالي» بوسمه الصريح مع تحذير أحمر.
- **سطر ثانٍ جديد**: إن اختلف الرصيد الحالي عن رصيد ما بعد الدفعة يُعرض
  «الرصيد الحالي (بعد حركات لاحقة)» تحته — كي لا يقارن الزبون السند برصيده
  اليوم ويظنّ الفرق خطأً. هذا جوهر ما أراده المالك: لا نزاع على الأرصدة.

### الفحوص

- محاكاة تقتطع الدوال الفعلية من `src/app.js` وتشغّلها على **حركات الزبون
  الحقيقية**: دفعة 3,700 → 6,727.5 ✓، دفعة 2,200 → 7,791.5 ✓، مبلغ غير
  موجود → null ✓، مبلغ صفر → null ✓، مبلغ فريد بلا تاريخ → يُحسم ✓،
  وتصادم دفعتين متطابقتين → null بلا تخمين ✓. ستة فحوص، صفر إخفاق.
- `node --check`، `npm.cmd run check`، `git diff --check`: ناجحة.
- `CACHE_NAME` → **v396** (الأعلى على main كان v395) وأصول `index.html` →
  **tobacco-118** بلا بقايا. `index.html` CR=19 قبل وبعد (perl).
- **الموقع والمولّد لا يقرران على مجموعة الأصناف نفسها عند السعر الصفري أو
  الغائب.** المولّد يصفّي قبل `mergeNamedGroups`: قائمة الدولار تستبعد
  `unit2_price <= 0` وقائمة السوري تستبعد `retail_carton_usd <= 0`.
  بالمقابل، `generalPricingWorklistItems` في الموقع يمرّر كل صنف ذي مخزون
  مناسب إلى `mergeBulletinNamedGroups` حتى لو كان سعر الوضع الحالي صفراً.
  لذلك، في محاكاة ثلاثة أسماء متطابقة بالبداية:
  - عند كون الثالث بسعر مفرق `0` أو retail غائباً، رفض الموقع دمج الثلاثة
    بسبب الغموض، بينما استبعده مولّد السوري ودمج الاثنين الباقيين.
  - عند كون سعر جملة الثالث `0`، رفض الموقع الدمج، بينما استبعده مولّد
    الدولار ودمج الاثنين الباقيين.
  ويوجد اختلاف ثانٍ في تعريف السعر نفسه: `itemUnit2Price` في الموقع يستنتج
  سعر الوحدة الثانية من `salePrice × unit2Factor` عند غياب `unit2Price`،
  بينما المولّد يقارن `unit2_price` الخام فقط ولا يجلب `sale_price`.
  محاكاة صنف `unit2Price=0` و`salePrice=10` ومعامل `10` مقابل صنف
  `unit2Price=100` جعلت الموقع يراهما `100|50` ويدمجهما، بينما أبقاهما
  مولّد السوري منفصلين (`0|50` مقابل `100|50`) واستبعد الأول كلياً من
  الدولار. كذلك الموقع يقرّب السعرين إلى ثلاث منازل عبر `roundPrice`
  والمولّد يقارن أرقاماً خاماً؛ `100.0004` و`100.00049` اندمجا في الموقع
  ولم يندمجا في المولّد. يلزم بناء قرار الدمج من المجموعة الكاملة قبل
  تصفية كل نشرة، وتعريف tuple سعر موحّد حرفياً للطرفين (المصدر، fallback،
  والدقة).
- **التنبيه لا يُطبع مرة واحدة لكل اسم في تشغيل المولّد.**
  `mergeNamedGroups` تطبع تنبيهاً واحداً لكل اسم في الاستدعاء الواحد، لكن
  المولّد يستدعيها مرتين: مرة لـ`usdItems` ومرة لـ`sypItems`. عندما تكون
  المجموعة الغامضة مؤهلة للنشرتين، طبعت المحاكاة الفعلية الرسالة نفسها
  مرتين للاسم نفسه. يلزم `Set` مشترك على مستوى التشغيل لحراسة الأسماء التي
  نُبّه عنها، أو حساب الغموض مرة واحدة على المصدر الكامل ثم تطبيق القرار
  على القائمتين.

### ما اجتاز المراجعة

- **لا توجد حالة دمج وسط داخل الاستدعاء الواحد:** عند `groups.size > 1`
  يحدث `continue` قبل أي تعديل إلى `result`، فتبقى كل الأسماء الأصلية.
  وعند تطابق tuple السعر يوجد bucket واحد يضم كل المطابقات ويُدمج كاملاً؛
  لا يدمج زوجاً ويترك ثالثاً بالاسم القانوني نفسه.
- **حفظ الموضع والحذف التنازلي صحيحان:** في قائمة
  `[أزرق، ماستر كوين، الاسم القانوني، ولسون، أخضر]` حلّ السطر المدمج محل
  أول ظهور، وبقي «ماستر كوين» ثم «ولسون» بترتيبهما النسبي. وعند وجود
  مجموعتي «ماستر» و«اليغانس» متداخلتين مع صفوف فاصلة، أعادت كل دورة حساب
  الفهارس بعد تعديلات الدورة السابقة، وحذف
  `sort((a,b) => b-a)` الفهارس من الأكبر للأصغر من دون انزياح أو حذف صف
  مجاور.
- **`sourceKeys` صحيحة للمجموعة التي اندمجت فعلاً:** محاكاة ثلاثة أصناف
  متطابقة السعر، وكان الممثل ذو الاسم القانوني في وسط القائمة لا عند
  `anchor`، أعادت السطر المدمج بالمفاتيح الثلاثة
  `[v1, base, v2]`. مسار الحفظ يستخدم هذه القائمة كلها ثم يزيل التكرار
  لاحقاً، فيحدّث جميع الأصناف المدموجة. وعند الغموض لا يحدث دمج ولا تُنشأ
  `sourceKeys` كاذبة.
- **الفرز النهائي للموقع لم يتغير:** ما زال
  `mergeBulletinNamedGroups` يعيد `result.sort` بالمقارن نفسه: المجموعة
  أولاً ثم الاسم بالعربية. محاكاة مجموعات وأسماء غير مستهدفة أعطت الترتيب
  الأبجدي نفسه، وحفظ `anchor` لا يغيّر هذا الفرز النهائي؛ فائدته العملية
  للمولّد الذي لا يطبق هذا الفرز.
- **الكاش والأصول:** `CACHE_NAME` هو
  `web-platform-tobacco-v397`، بينما الأب و`main` المحلي `v395`. يحتوي
  `index.html` سبعة مراجع فقط إلى `tobacco-119` وصفر بقايا لأي
  `tobacco-*` آخر، وكل أصول service worker الأربعة عشر موجودة فعلياً.
  رفع الكاش صحيح لأن `src/app.js` ملف مخدوم وتغيّر في هذا الكوميت.
- **نهايات أسطر `index.html`:** بقي الحجم `1700` بايت في الأب والكوميت،
  و`CR=19` و`LF=26` (`19` CRLF و`7` LF منفردة) في كليهما؛ لا يوجد انحدار
  أو إعادة كتابة شاملة للنهايات.
- نجحت `node --check src/app.js` و
  `node --check scripts/generate-price-lists.mjs` و`npm.cmd run check`
  برسالة `Project check passed`، ونجح
  `git diff --check 29a6cd1 7a32843`.

### ملاحظات تُسجّل ولا تمنع الدمج

- الدالتان تطبّقان منطق «كل المجموعة أو لا شيء» نفسه بعد وصول **نفس
  العناصر ونفس tuple السعر**؛ الانحراف ليس في `groups.size` أو splice بل
  في تجهيز المدخلات وتعريف السعر قبل الدالتين. لذلك اختبار الدالتين على
  fixture موحد وحده لا يكفي؛ يلزم اختبار مساري التجهيز الكاملين.
- الموقع لا يعرض تنبيهاً عند الغموض، بل يترك الأسطر مستقلة بصمت. الطلب ذكر
  طباعة التنبيه في سياق المولّد، لذلك لم يُسجّل هذا مانعاً مستقلاً؛ إن كان
  مطلوباً للمدير داخل صفحة التسعير فيلزم notice مرئي منفصل.
- `sourceKeys` تجمع `item.key` لكل عضو مباشر في bucket ولا توسّع
  `item.sourceKeys` متداخلة. الأسماء الثلاثة الحالية سجائر عادية تصل
  بمفاتيح مباشرة، لذلك تغطي كل ما اندمج فعلياً الآن؛ إذا سُمِح مستقبلاً
  بدمج سطر مركب سابقاً، يلزم flatten للمفاتيح.

## 2026-07-27 - Claude - إغلاق موانع دمج النشرة الثلاثة

- Status: **منجز على `claude/bulletin-merge-cigarettes` فوق `29a6cd1`، غير
  مدموج وغير منشور.** لم يُشغَّل مولّد النشرات ولم يُعدَّل أي سعر.

### قاعدة واحدة حسمت الموانع الثلاثة

- **الدمج مشروط بتطابق السعرين معاً** (دولار وسوري). سطران بالسعر نفسه تكرار
  بصري، أما صنف يبدأ بالاسم القانوني وسعره مختلف فهو **منتج آخر** ولا يجوز
  ابتلاعه وإخفاء سعره (مانع «ماستر طويل ورق إصدار فاخر»).
- **وعند اختلاف الأسعار داخل المجموعة يتوقف الدمج كلياً** ويُطبع تنبيه في سجل
  المولّد. جرّبت أولاً «دمج المتطابق فقط» فأنتج **سطرين بالاسم القانوني نفسه
  وسعرين مختلفين** — أسوأ من التكرار الأصلي، فرُفض. الغموض يوقف الدمج، ويعود
  تلقائياً حين يصحّح المالك السعر.
- **الترتيب محفوظ**: الصف المدموج يحلّ محلّ أول ظهور (`anchor`) بدل الدفع إلى
  آخر القائمة، فلا تتبدّل صفوف النشرة.
- **اختيار السعر لم يعد موجوداً أصلاً**: لا يُدمج إلا المتطابق، فلا heuristic
  يمكن أن يخفي سعراً أحدث (المانع الثاني سقط من جذره).

### التطابق بين الموقع والنشرة

- طُبِّقت القاعدة نفسها حرفياً في `mergeBulletinNamedGroups` داخل `src/app.js`
  (بالسعرين عبر `itemUnit2Price` و`itemRetailPrice`)، فلا يدمج الموقع ما لا
  تدمجه النشرة. و`npm run check` يحرس تطابق قائمة الأسماء.

### الفحوص

- المحاكاة تقتطع `mergeNamedGroups` الفعلية: **12 فحصاً صفر إخفاق** — الدمج
  الصحيح لثلاثة أسماء، وعدم ابتلاع «ماستر كوين أبيض»، وتوقّف الدمج عند
  الغموض مع بقاء الأسماء الأصلية، **وعدم وجود اسمين متطابقين بسعرين
  مختلفين**، وحفظ الموضع في الترتيب، وصنف وحيد يبقى بلا دمج.
- `node --check` للملفين، `npm.cmd run check`، `git diff --check`: ناجحة.
- **رُفع الكاش**: بعكس الكوميت السابق (الذي مسّ `scripts/` فقط) هذا الكوميت
  يعدّل `src/app.js` المخدوم للمستخدم، فرُفع `CACHE_NAME` إلى **v397**
  (الأعلى على main كان v395) وأصول `index.html` إلى **tobacco-119** بلا
  بقايا، و`index.html` CR=19 قبل وبعد (perl).

## 2026-07-27 - Codex - مراجعة دمج أصناف النشرة (`29a6cd1`)

- Status: **توجد ثلاثة موانع تمنع الدمج.** روجع الكوميت الفعلي
  `29a6cd176818399be15fd498a96ac052ff35cbdd` مقابل أبيه المباشر
  `f8a8eb52e70b502902bd3b07a86f6f4018685ce9` على الفرع
  `claude/bulletin-merge-cigarettes` داخل worktree المحدد. وكان ناتج
  `git rev-parse HEAD` وقت المراجعة
  `29a6cd176818399be15fd498a96ac052ff35cbdd`.
- لم يُشغّل مولّد النشرات ولم يُعدّل أي سعر، ولم يحدث commit أو push أو
  merge أو حذف من Supabase أو كتابة في الأمين. كل الاختبارات محاكاة قرائية
  معزولة للدوال الفعلية، والملف الوحيد المعدّل بواسطة المراجعة هو
  `AI_HANDOFF.md`.

### موانع تمنع الدمج

- **المطابقة تبتلع أي صنف مختلف يبدأ بالاسم ثم مسافة.**
  شرط `n === base || n.startsWith(base + " ")` يمنع المطابقة الجزئية داخل
  الكلمة فقط: نجحت حالة «ماستر طويل ورق» مع «ماستر طويل ورقة» وبقيت
  «ورقة» مستقلة لأن التطبيع يجعلها «ورقه» بلا مسافة بعد «ورق». لكنه لا
  يحمي صنفاً مختلفاً من عدة كلمات؛ محاكاة الدالة الفعلية على
  «ماستر طويل ورق» و«ماستر طويل ورق أزرق» و
  «ماستر طويل ورق إصدار فاخر» بسعر `700` ابتلعت الأصناف الثلاثة وأبقت
  سطراً واحداً بسعر `100`. يلزم تعريف الأعضاء/اللواحق المسموح دمجها صراحةً
  لكل مجموعة، أو رفض المجموعة عند وجود لاحقة أو فرق سعر غير متوقع، لا
  اعتبار كل ما بعد المسافة مرادفاً.
- **اختيار السعر قد يخفي سعراً أحدث مقصوداً.** `mapRow` لا يحمل
  `updated_at` إلى `mergeNamedGroups`، والدالة تختار الأكثر تكراراً ثم
  الأعلى سعراً ثم آخر عنصر يحمل السعر المختار. محاكاة عنصر أساس قديم بسعر
  `100` بتاريخ `2026-01-01` وعنصر أزرق أحدث بسعر `90` بتاريخ
  `2026-07-27` اختارت القديم `100`. نعم، هذا يطابق حساب السعر الموجود في
  `consolidateGeneral` للمعسل حرفياً، وقد أعطت محاكاة المعسل النتيجة نفسها،
  لكنه لا يحقق شرط عدم إخفاء سعر أحدث. كما أن موقع الويب يختار الصنف ذي
  الاسم القانوني أو أول عنصر ولا يطبق تصويت الأسعار، لذلك يمكن أن تعرض
  النشرة والموقع سعرين مختلفين مع بقاء فحص الأسماء ناجحاً. يلزم حمل وقت
  السعر وحسم واضح يفضّل الأحدث، أو رفض التعارض وطباعته كخطأ يحتاج قراراً.
- **ترتيب صفوف النشرة يتغير.** الدالة تحذف كل `matches` من مواضعها ثم
  `push` للسطر المدمج في نهاية المصفوفة. محاكاة الترتيب
  `[ماستر طويل ورق، ماستر كوين، ماستر طويل ورق أزرق، ولسون أحمر]`
  أعادت
  `[ماستر كوين، ولسون أحمر، ماستر طويل ورق]`. `buildGroups` وبنية الأعمدة
  لم يتغيرا، وأسماء مجموعات الأصناف المستهدفة تبقى «ماستر» و«اليغانس»،
  لكن موضع السطر داخل مجموعته يتأخر، وقد يتغير ترتيب إنشاء المجموعة في
  المدخلات غير المحجوزة. يلزم إدراج السطر المدمج في موضع أول مطابق بدل
  دفعه إلى النهاية، ثم إثبات ثبات ترتيب الصفوف والمجموعات.

### ما اجتاز المراجعة

- **حد الكلمة:** «ماستر طويل ورقة» لا تطابق «ماستر طويل ورق»؛ شرط المسافة
  يمنع المطابقة داخل الكلمة كما هو مطلوب. المانع أعلاه يخص صنفاً مختلفاً
  يبدأ بالاسم الكامل ثم كلمة جديدة.
- **الوزاري والمعسل والمزايا والنخلة:** الوزاري يُفصل بواسطة `toWazari`
  قبل تمرير القائمة العامة إلى `mergeNamedGroups`، فلا يدخل الدمج الجديد.
  كتل `isWazari` و`buildGroups/buildColumnLayout` مطابقة للأب، وقائمة
  الدمج لا تحتوي أسماء معسل أو مزايا أو نخلة. محاكاة هذه الأنواع أعطت
  التسميات والأسعار السابقة نفسها بعد `consolidateGeneral`; التغيير
  الملحوظ الوحيد خارجها هو ترتيب العناصر المستهدفة المذكور كمانع.
- **فحص تطابق القائمتين:** تشغيل المقطع الفعلي من `check.mjs` أمسك:
  ترتيباً مختلفاً، اسماً زائداً، فرق همزة (`أزرق`/`ازرق`)، JSON تالفاً،
  وقيمة JSON كائناً بدل مصفوفة. الحالة المتطابقة وحدها نجحت. الفحص يقارن
  القائمتين حرفياً وبالترتيب، وهو صحيح للشروط المطلوبة.
- **غياب/تعطل ملف JSON:** المولّد لا يملك fallback، لكنه أيضاً لا يفشل
  بصمت؛ `readFileSync`/`JSON.parse` غير محاطتين بـ`try`، فيتوقف فوراً برسالة
  Node صريحة تحمل `ENOENT` ومسار الملف عند الغياب، أو `SyntaxError` عند
  تلف JSON. و`check.mjs` يعطي رسالة مخصصة للتلف وللقيمة غير المصفوفة؛ أما
  غياب الملف فيوقفه أيضاً بـ`ENOENT`. هذا يحقق بديل «فشل صريح» ولا يدّعي
  استمراراً احتياطياً.
- **الكاش والنطاق المخدوم:** فرق الكوميت البرمجي محصور في
  `scripts/generate-price-lists.mjs` و`scripts/check.mjs` وملف JSON الجديد.
  لا يشير `index.html` أو `404.html` أو service worker إلى هذه الملفات،
  وقائمة `ASSETS` لا تحتويها. بقي `CACHE_NAME` في الكوميت والأب
  `web-platform-tobacco-v395`، وعدم رفعه صحيح لأن أي HTML/PDF ناتج لم
  يُولّد أو يُعدّل في هذا الكوميت.
- نجحت `node --check scripts/generate-price-lists.mjs` و
  `node --check scripts/check.mjs` و`npm.cmd run check` برسالة
  `Project check passed`، ونجح `git diff --check f8a8eb5 29a6cd1`.

### ملاحظات تُسجّل ولا تمنع الدمج

- فحص `check.mjs` يحرس تطابق **الأسماء وترتيبها فقط**، ولا يثبت أن الموقع
  والمولّد يستعملان خوارزمية المطابقة أو اختيار السعر أو ترتيب المخرجات
  نفسها. لذلك بقي ناجحاً رغم الموانع الثلاثة؛ بعد الإصلاح يستحسن نقل
  تعريف المجموعات وخوارزمية الدمج إلى وحدة مشتركة قابلة للاختبار، أو إضافة
  fixtures متطابقة للمسارين.
- بيانات `scripts/price-data.json` الحالية تحوي الزوجين المقصودين
  لـ«ماستر طويل ورق»، وثلاثة أسماء لليغانس («فضي»، «فضي غير مخصص»،
  «فضي مخصص»)، ولا تحوي حالياً حالة «ورقة». هذا لا يلغي خطر ابتلاع اسم
  جديد من المصدر الحي مستقبلاً، وهو سبب اعتبار المطابقة الواسعة مانعاً.
- رسائل غياب/تلف ملف JSON في المولّد صريحة وغير صامتة، لكنها رسائل Node
  خام وليست رسالة عربية إرشادية مثل فحص `check.mjs`. تحسين الرسالة مفيد
  تشغيلياً ولا يمنع الدمج بعد إصلاح الموانع.

## 2026-07-27 - Claude - دمج الأصناف المتشابهة في النشرة العامة

- Status: **منجز على `claude/bulletin-merge-cigarettes` فوق `f8a8eb5`، غير
  مدموج وغير منشور.** لا تعديل أسعار ولا تشغيل مولّد ولا نشر نشرات.

### البلاغ

- «ماستر طويل ورق» و«ماستر طويل ورق أزرق» يظهران سطرين بالسعر نفسه في نشرة
  الأسعار المنشورة؛ المطلوب سطر واحد.

### السبب

- الدمج بالاسم موجود **في الموقع فقط** (`BULLETIN_MERGE_NAMES` و
  `mergeBulletinNamedGroups` في `src/app.js`) ويضم أصلاً الأسماء الثلاثة:
  «ماستر طويل ورق»، «ماستر قصير أزرق»، «اليغانس طويل فضي».
- **مولّد النشرات لم يكن يعرف هذه القائمة إطلاقاً**: `consolidateGeneral` يدمج
  المعسل والمزايا والنخلة فقط، والسجائر تمرّ كما هي. فخالفت النشرة المنشورة
  قائمة الموقع — بينما القاعدة المتفق عليها أن يتطابقا.

### الإصلاح

- `scripts/bulletin-merge-names.json`: **مصدر واحد** للأسماء القانونية.
- `scripts/generate-price-lists.mjs`: يقرأ القائمة ويطبّق `mergeNamedGroups`
  بعد `consolidateGeneral` للنشرتين (دولار وسوري). المطابقة على الاسم بعد
  التطبيع (همزة/تاء مربوطة/تشكيل): الاسم نفسه أو ما يبدأ به متبوعاً بمسافة.
  السعر المعتمد هو الأكثر تكراراً ثم الأعلى ثم آخر ظهور — نفس قاعدة المعسل.
- `scripts/check.mjs`: **يرفض أي اختلاف** بين قائمة الموقع وقائمة المولّد،
  فلا يعود ممكناً أن يدمج أحدهما ويترك الآخر سطرين. جُرِّب فعلياً: عند حذف
  اسم من الـJSON فشل `npm run check` وطبع الفرق، وعاد ناجحاً بعد الإرجاع.

### الفحوص

- محاكاة تقتطع `mergeNamedGroups` الفعلية من المولّد: **9 فحوص صفر إخفاق** —
  عشرة أصناف صارت ستة، وكل اسم قانوني سطر واحد (اليغانس من ثلاثة إلى واحد)،
  والسعر محفوظ، و«ماستر كوين أبيض» و«ماستر سليم أزرق» لم يُدمجا بالخطأ،
  وعند تعارض الأسعار يُعتمد الأكثر تكراراً، وصنف وحيد يبقى باسمه بلا دمج.
- `node --check` للمولّد وللفحص، و`npm.cmd run check`، و`git diff --check`:
  ناجحة.
- **لم يُرفع `CACHE_NAME` ولا نسخة الأصول**: التغيير في `scripts/` وملف بيانات
  فقط — لا شيء منها يُخدَّم للمستخدم. `src/app.js` و`index.html` لم يُمسّا.

### ما يلزم بعد الدمج

- النشرة المنشورة تتحدّث عند أول تشغيل لمولّد النشرات (المجدول أو عند
  «اعتماد ونشر»). لم أشغّله يدوياً لأنه ينشر أسعاراً.
- لإضافة أي زوج آخر لاحقاً: اسم واحد في `scripts/bulletin-merge-names.json`
  ونفسه في `BULLETIN_MERGE_NAMES`، و`npm run check` يحرس التطابق.

## 2026-07-26 - Codex - مراجعة فصل عناصر سطر حساب رول الكاشير (`66279b8`)

- Status: **لا يوجد مانع يمنع الدمج ضمن نطاق الكوميت.** روجع الكوميت الفعلي
  `66279b8454fdb11c454c40ad24f6d4c81a4eb16b` مقابل أبيه المباشر
  `f25cee7e199d8c2f4eebf5ad1657d176cc9b6949` على الفرع
  `claude/sales-invoice-pdf-ios` داخل worktree المحدد. وكان ناتج
  `git rev-parse HEAD` وقت المراجعة
  `66279b8454fdb11c454c40ad24f6d4c81a4eb16b`.
- المراجعة واختبارات Chromium محلية وقرائية فقط. لم يحدث commit أو push أو
  merge، ولم يُعدّل أي سعر أو صف في Supabase، ولم تُشغّل أي مزامنة أو كتابة
  في الأمين. الملف الوحيد المعدّل بواسطة هذه المراجعة هو `AI_HANDOFF.md`.

### موانع تمنع الدمج

- **لا يوجد.** الكمية والوحدة والسعر عناصر مستقلة، والأرقام الثلاثة مع إجمالي
  السطر تحمل `flex: 0 0 auto` ولا تُضغط أو تُقص، بينما اسم الوحدة وحده مرن
  بـ`min-width:0` وellipsis، والسطر نفسه يحمل `overflow:hidden`.

### ما اجتاز المراجعة

- اختبار Chromium في وضع الطباعة جمع الحالة القصوى المطلوبة في مستند واحد:
  40 صنفاً، كمية عشرية `123.75`، كود ست خانات، السعرين
  `12,500,000` و`37,500,000`، إجماليات بالقيم نفسها، اسم وحدة عربي طويل
  متصل، اسم زبون طويل، ورقم فاتورة طويل
  `INV-2026-12345678901234567890`.
- كل عناصر الأرقام في أسطر الحساب، وعددها 120 عنصراً (`qty` و`price`
  و`total` لكل واحد من 40 سطراً)، حققت
  `scrollWidth === clientWidth`. وحققت أكواد الأصناف الأربعون، التاريخ،
  رقم الفاتورة الطويل الواقعي، وجميع مبالغ المجاميع الشرط نفسه؛ لم توجد
  قيمة `nb` واقعية مقصوصة.
- بقي عرض المحتوى `80mm` فعلياً في Chromium:
  `getComputedStyle(body).width=302.35px` و
  `body.getBoundingClientRect().width=302.350006px`، مع
  `body.clientWidth=302px` و`body.scrollWidth=302px`. ظهرت الأسطر الأربعون
  وازداد ارتفاع المستند تلقائياً إلى 2073px بلا overflow أفقي.
- عند جمع اسم الزبون الطويل مع رقم الفاتورة الطويل، بقي رقم الفاتورة كاملاً
  (`clientWidth=scrollWidth=180px`) والتف اسم الزبون كاملاً على سطرين
  (`clientWidth=scrollWidth=248px` وارتفاع 33px)، وبقي عرض الرول ثابتاً.
- العناصر الوحيدة ذات `overflow:hidden` و
  `scrollWidth > clientWidth` كانت عناصر `ln-unit` الأربعين. في أقسى سطر
  بقي للوحدة الطويلة نحو 100px من 254px، بينما ظهرت الوحدة النظامية
  «كرتونة» كاملة (`clientWidth=scrollWidth=28px`). الكمية والسعر وإجمالي
  السطر ظلت كاملة؛ لذلك لا يخفي القص أي مبلغ أو كمية أو كود، وتبقى أسماء
  الوحدات العملية القصيرة كاملة.
- `align-items:baseline` على `ln-calc` و`ln-qp` أعطى قاع النص نفسه للعناصر
  الأربعة بفارق `0px`. ارتفاع سطر الحساب بقي `16.5px`، مساوياً
  لـline-height، وكل عنصر رقمي بقي بارتفاع `16.5px`؛ لم يضف
  `inline-block` سطراً أو ارتفاعاً زائداً.
- لا يوجد backtick داخل أي تعليق CSS في القالب
  (`3` تعليقات، `0` backticks)، ولا backtick حرفي escaped داخل نص القالب.
  نجحت `node --check src/app.js`، كما نجح `npm.cmd run check` برسالة
  `Project check passed` ونجح `git diff --check f25cee7 66279b8`.
- فرق كود `src/app.js` محصور في `salesReceiptDocument`. بقيت الدوال التالية
  مطابقة بايتياً بين الأب والكوميت:
  - `salesInvoicePdfMarkup`: طول 3861 وSHA-256
    `7abc6c1675424fef86d4e6481eee799139fe666dccf266a077d0aafa7b140e1e`.
  - `saveSalesInvoicePdf`: طول 4581 وSHA-256
    `067c4fc243fd9b38d2f8becf0b5f0493fb2638d5ca78d86a55cbdccbefd8e08b`.
  - `printSalesInvoice`، بما فيه قالب A4 واختيار قالب الكاشير: طول 7790
    وSHA-256
    `a578f2d8696456fc811a001fd8791e4db72ab30372fb25cdc5b61557ac46e73b`.
  - `isHandheldDevice`: طول 484 وSHA-256
    `c9172c1e2f900cf6676d1865648e6d89fa205a648b1db5ca39be2de6ccf046ca`.
- بقي شرطي إظهار زر PDF للجملة وإخفاء زر الطباعة على الهاتف، وربطا
  `sales-print` و`sales-pdf` بالدالتين، موجودة ومطابقة في الأب والكوميت.
  لذلك لم تتأثر مسارات A4 أو PDF الجملة أو المشاركة/التنزيل أو كشف الهاتف.

### ملاحظات تُسجّل ولا تمنع الدمج

- قاعدة المصدر ما زالت تكتب `@page { size: 80mm auto; margin: 0; }`، لكن
  Chromium أسقط تصريح `size:80mm auto` غير المدعوم من CSSOM وأبقى
  `@page { margin:0 }`. هذا سابق للكوميت وغير ناتج من إصلاحه؛ عرض المحتوى
  نفسه مثبت ومقاس فعلياً عند 80mm بلا overflow، وعرض ورق الطابعة الحرارية
  يبقى من إعداد رول/تعريف الطابعة. إذا أريد لاحقاً أن يفرض القالب مقاس صفحة
  PDF مستقلاً عن الطابعة، فيحتاج ذلك معالجة منفصلة لا تخص هذا الكوميت.

## 2026-07-26 - Codex - مراجعة تحجيم أرقام رول الكاشير (`f25cee7`)

- Status: **يوجد مانعان مرتبطان بسطر الصنف يمنعان الدمج.** روجع الكوميت
  `f25cee7e199d8c2f4eebf5ad1657d176cc9b6949` على الفرع
  `claude/sales-invoice-pdf-ios` داخل worktree المحدد، مقابل أبيه المباشر
  `b45e69a2d3983c0280775ac7145faf60ea1bfa87`.
- المراجعة والمحاكاة واختبار Chromium محلية فقط. لم يحدث commit أو push أو
  merge، ولم يُعدّل أي سعر أو صف في Supabase، ولم تُشغّل أي مزامنة أو كتابة
  في الأمين.

### موانع تمنع الدمج

- **`nb` مطبق على عبارة الحساب كاملة لا على الكمية والسعر كلٌّ على حدة.**
  صار span الذي يحتوي
  `row.qty + row.unit + × + row.price` كله `class="nb"`. لذلك اسم الوحدة
  النصي دخل داخل منع الالتفاف والقص، مع أنه يجب أن يبقى قابلاً للالتفاف،
  ولا توجد عقدة مستقلة تحمي الكمية وأخرى تحمي السعر. التغطية الشكلية موجودة
  لأن الرقمين داخل ancestor يحمل `nb`، لكنها تقص النص والرقمين كوحدة واحدة
  ولا تحقق سلوك القيم المطلوب.
- **قيمة واقعية تُقص عند اجتماعها مع وحدة طويلة.** في اختبار Chromium بـ
  `qty=123.75` و`price=12,500,000` و`total=12,500,000` ووحدة طويلة، أخذ
  span الحساب 250px وكان `scrollWidth=864px`، بينما انضغط إجمالي السطر
  المقابل إلى `clientWidth=16px` مع `scrollWidth=57px`. أي إن المبلغ
  الواقعي نفسه ظهر مقصوصاً رغم أن الشرط يطلب
  `scrollWidth === clientWidth`.
- الإصلاح المطلوب بنيوياً: فصل عبارة الحساب إلى عناصر؛ `nb` مستقل للكمية،
  نص وحدة مرن قابل للالتفاف، و`nb` مستقل للسعر، مع حجز مساحة معقولة لإجمالي
  السطر أو منع flex من ضغطه دون حد. وضع ellipsis على العبارة كلها لا يصلح.

### ما اجتاز المراجعة

- بقية القيم الرقمية الديناميكية تحمل `nb`: رقم الفاتورة، التاريخ، كود
  الصنف، إجمالي السطر، وجميع قيم المجاميع. اسم الصنف واسم الزبون بقيا بلا
  `nb` ويلتفان بسبب قواعد body. المانع أعلاه محصور في تجميع الكمية والوحدة
  والسعر داخل عنصر `nb` واحد.
- القيم الواقعية في meta والمجاميع لم تُقص: رقم فاتورة `123456` كان
  `clientWidth=scrollWidth=38px`، التاريخ `60px`، والكود ذو ست خانات
  `38px`. قيم المجاميع `12,500,000` و`11,250,000` وغيرها كان لكل منها
  `clientWidth=scrollWidth`، وظلت عناوين «الإجمالي» و«الصافي» و
  «المتبقّي (مستحق)» بعرض وارتفاع موجبين.
- `min-width:0` لم يخف عناوين المجاميع في الاختبار: «الصافي» بقي 44px،
  و«المتبقّي (مستحق)» 102px، مع مبالغ كبيرة مقابلة كاملة. ولا توجد قيمة
  meta واقعية بعرض أو ارتفاع صفري.
- بقي الرول ثابتاً مع 40 صنفاً وأسماء أصناف وزبون طويلة:
  `body.clientWidth=302px` و`body.scrollWidth=302px`، وظهرت الأسطر الأربعون
  وازداد الارتفاع تلقائياً إلى 4225px. ثبات العرض تحقق هنا بواسطة القص؛
  لكنه قص غير مقبول للقيم الواقعية في سطر الصنف كما في المانع.
- `display:inline-block` لم يغير ارتفاع أرقام meta والمجاميع ذات السطر
  الواحد، وبقي اتجاهها عبر `dir=ltr`. مشكلة المحاذاة العملية هي ضغط عنصري
  `ln-calc` المتبادل، لا inline-block في بقية المواضع.
- قالب PDF الجملة `salesInvoicePdfMarkup` مطابق بايتياً بين الأب والكوميت:
  الطول `3598` وSHA-256
  `999338b271fdeaf5c90a5c2aa0b1908c226c9c3528067d9c495580ca6e6923d0`.
  `saveSalesInvoicePdf` مطابق أيضاً: الطول `4373` وSHA-256
  `2a1857368bcc49751d17bb684a6a8d2eb359469242d83c0b088d264b694b6608`.
  ودالة `printSalesInvoice` كاملة، بما فيها قالب A4 ومسار اختيار الكاشير،
  مطابقة: الطول `7656` وSHA-256
  `8ec78d2ae0dfe42d8e8a32686fe7885d40e999d72f969cde8112d2065b75b26a`.
- لذلك لم تتغير حراس التصدير أو المشاركة/التنزيل أو كشف الهاتف وإخفاء زر
  الطباعة؛ فرق الكوميت محصور في markup/CSS قالب الكاشير.
- نجحت `node --check src/app.js` و`npm.cmd run check` و
  `git diff --check b45e69a f25cee7`.

### ملاحظات تُسجّل ولا تمنع الدمج

- أرقام الهاتف الثابتة في التذييل ليست ضمن `nb`. هي نص ثابت قصير داخل div
  مستقل ولا تدخل في بيانات الفاتورة أو مشكلة flex، لذلك لا تمنع الدمج ضمن
  المقصود بالقيم الرقمية الديناميكية.
- `text-overflow:ellipsis` مناسب كدفاع أخير لقيمة رقمية شاذة أطول من الرول،
  لكنه لا يجوز أن يبدأ بقص مبلغ واقعي مثل 12,500,000 نتيجة منافسة اسم وحدة
  طويل على المساحة.

## 2026-07-26 - Codex - مراجعة صنف الأرقام في رول الكاشير (`b45e69a`)

- Status: **يوجد مانعان يمنعان الدمج.** روجع الكوميت
  `b45e69a2d3983c0280775ac7145faf60ea1bfa87` على الفرع
  `claude/sales-invoice-pdf-ios` داخل worktree المحدد، مقابل أبيه المباشر
  `5fcdf4ed15da13d557b08322504ec30b6d8d1c12`.
- المراجعة والمحاكاة واختبار Chromium محلية فقط. لم يحدث commit أو push أو
  merge، ولم يُعدّل أي سعر أو صف في Supabase، ولم تُشغّل أي مزامنة أو كتابة
  في الأمين.

### موانع تمنع الدمج

- **صنف `nb` غير مطبق على كل القيم الرقمية.** طُبق على رقم الفاتورة، كود
  الصنف، إجمالي السطر، وقيم المجاميع. لكنه غير موجود على `row.qty` و
  `row.price`؛ كلاهما ما زال نصاً داخل span واحد مع اسم الوحدة وعلامة الضرب.
  كما أن قيمة التاريخ الرقمية في meta لا تحمل `nb`. اسم الصنف واسم الزبون
  لا يحملان `nb` كما هو مطلوب، لكن شرط «كل قيمة رقمية بلا استثناء» غير محقق.
- **`nb` يعيد تمديد الرول عند رقم طويل جداً.** القاعدة تمنع الكسر فقط:
  `white-space:nowrap; overflow-wrap:normal; word-break:keep-all`، من دون
  `max-width` أو `overflow:hidden`. اختبار Chromium بأرقام من 150 خانة أعاد
  `body.scrollWidth=1253px` و`document.scrollWidth=1253px` مقابل عرض
  `302px` (80mm تقريباً). رقم الفاتورة وحده كان
  `scrollWidth=949px` داخل مساحة 254px، فتخرج بقيته خارج الورقة بدلاً من أن
  يبقى العرض ثابتاً ويُقص عند الضرورة.
- الأثر نفسه يعني أن كتلة meta لا تحقق الشرطين معاً عند اسم زبون ورقم فاتورة
  طويلين: اسم الزبون يلتف داخل 259px ويظهر، لكن رقم الفاتورة غير المقصوص
  يخرج خارج عرض الرول، فيصبح جزء منه خارج الصفحة المطبوعة. يلزم إعطاء
  العناصر الرقمية حداً متاحاً و`overflow:hidden`/قصاً واضحاً، مع إبقاء اسم
  الزبون قابلاً للالتفاف.

### ما اجتاز المراجعة

- مواضع `nb` الموجودة صحيحة: رقم الفاتورة، كود الصنف، إجمالي كل سطر، وكل
  قيمة تنتجها دالة `sum` (الإجمالي والحسم والصافي والمدفوع والمتبقي). ولم
  يضف الصنف إلى اسم الصنف أو اسم الزبون.
- في اختبار بأرقام واقعية ووحدة طويلة جداً و30 صنفاً بقي عرض body
  `302px` بلا overflow، وظهرت الأسطر الثلاثون. التف اسم الوحدة/عبارة
  `كمية × سعر` داخل 209px، وبقي إجمالي السطر المقابل مقروءاً في 57px؛
  `ln-calc.scrollWidth` ساوى عرضه 272px. لذلك بنية السطر سليمة للقيم
  الواقعية، والمانع هو غياب `nb` عن مكوناته الرقمية وعدم تحجيم الحالات
  الطويلة جداً.
- `min-width:0` وgap لم يتغيرا في هذا الكوميت. اسم الزبون الطويل التف داخل
  meta، ولم تختفِ قيم ذات طول واقعي.
- قالب PDF الجملة `salesInvoicePdfMarkup` مطابق بايتياً بين الأب والكوميت:
  الطول `3598` وSHA-256
  `999338b271fdeaf5c90a5c2aa0b1908c226c9c3528067d9c495580ca6e6923d0`.
  ودالة `printSalesInvoice` كاملة، بما فيها قالب A4 واختيار الكاشير، مطابقة
  بايتياً: الطول `7656` وSHA-256
  `8ec78d2ae0dfe42d8e8a32686fe7885d40e999d72f969cde8112d2065b75b26a`.
- `saveSalesInvoicePdf` مطابق بايتياً أيضاً: الطول `4373` وSHA-256
  `2a1857368bcc49751d17bb684a6a8d2eb359469242d83c0b088d264b694b6608`.
  لذلك لم يتغير أي حارس أو مسار مشاركة/تنزيل، ولم يتغير كشف الهاتف أو إخفاء
  زر الطباعة؛ فرق الكوميت محصور في markup/CSS رول الكاشير.
- نجحت `node --check src/app.js` و`npm.cmd run check` و
  `git diff --check 5fcdf4e b45e69a`.

### ملاحظات تُسجّل ولا تمنع الدمج

- `white-space:nowrap` يحمي الأرقام الواقعية من الانقسام كما هو مقصود، لكن
  الحماية يجب أن تقترن بحد عرض وقص للحالة الاستثنائية؛ وإلا يتعارض منع
  الكسر مع ثبات 80mm.
- امتداد box الخاص بإجمالي السطر إلى ارتفاع السطر الملتف ناتج من
  `align-items:stretch` الافتراضي في flex، لكنه لا يخفي النص ولا يغير
  محاذاته الأفقية؛ يمكن تحسين المحاذاة العمودية لاحقاً ولا يمنع الدمج وحده.

## 2026-07-26 - Codex - مراجعة إصلاح Blob وعرض رول 80mm (`5fcdf4e`)

- Status: **بقي مانع واحد يمنع الدمج.** روجع الكوميت
  `5fcdf4ed15da13d557b08322504ec30b6d8d1c12` على الفرع
  `claude/sales-invoice-pdf-ios` داخل worktree المحدد، مقابل أبيه المباشر
  `4854d96d0071ba482e9dd561ecf7a26dad706927`.
- المراجعة والمحاكاة واختبار Chromium محلية فقط. لم يحدث commit أو push أو
  merge، ولم يُعدّل أي سعر أو صف في Supabase، ولم تُشغّل أي مزامنة أو كتابة
  في الأمين.

### مانع يمنع الدمج

- **قاعدة كسر الكلمات العامة ما زالت قادرة على كسر رقم الفاتورة.** أضيف
  `overflow-wrap:anywhere; word-break:break-word` إلى `body` كله، بينما
  `.meta b` يحمل `min-width:0` فقط ولا يحمل `white-space:nowrap`. لذلك يرث
  رقم الفاتورة قاعدة الكسر. اختبار Chromium برقم طويل أعطى ارتفاع
  `33px` مقابل line-height `16.5px`، أي التفّ الرقم إلى سطرين فعلياً.
- مبالغ `.ln-calc b` و`.sum b` محمية بـ`white-space:nowrap`، لكن رقم
  الفاتورة غير محمي. يلزم تمييز قيمة رقم الفاتورة بكلاس/قاعدة nowrap مستقلة
  مع السماح لاسم الزبون الطويل وحده بالالتفاف، أو حصر `overflow-wrap` في
  حقول النصوص بدلاً من `body`. المطلوب ألا يعاد توسيع عرض 80mm أثناء ذلك.

### ما اجتاز المراجعة

- جدولة `URL.revokeObjectURL(url)` أصبحت السطر التالي مباشرةً لنجاح
  `createObjectURL`. لذلك فشل `createElement` أو `appendChild` أو
  `link.click` أو `render` لا يمنع تحرير الرابط لاحقاً. و`link.remove()`
  داخل `finally` يغطي نجاح النقرة وفشلها بعد إضافة الرابط.
- مهلة 30 ثانية أكثر من نافذة بدء التنزيل: `link.click()` يبدأ معالجة
  التنزيل تزامنياً، والمتصفح يحتفظ بمرجع المورد بعد بدء الطلب؛ تحرير object
  URL لاحقاً يمنع استعمالاً جديداً للرابط ولا يوقف التنزيل الذي بدأ. كما أن
  التأخير يتجنب اختلافات المتصفحات التي تجعل الإلغاء الفوري بعد النقرة مبكراً.
- اختبار ضغط Chromium لقالب الكاشير شمل 40 صنفاً، أسماء أصناف ووحدات بلا
  مسافات، اسم زبون طويلاً، أكواداً ومبالغ كبيرة. بقي
  `body.scrollWidth=302px` و`document.scrollWidth=302px`، ظهرت الأسطر
  الأربعون كلها، وازداد الارتفاع تلقائياً إلى `8305px` بلا قص.
- `min-width:0` في قيم meta سمح لاسم الزبون الطويل بالالتفاف داخل المساحة،
  و`gap:6px` أبقى فصلاً بين العنوان والقيمة. في سطر الحساب كان العرض
  `272px`، مجموع الابنين مع gap مطابقاً له، و`scrollWidth=clientWidth`؛
  لم يحدث تداخل أو overflow أو قيمة بعرض/ارتفاع صفري.
- المبالغ النهائية في `.ln-calc b` و`.sum b` بقيت قطعة واحدة بسبب
  `white-space:nowrap`. اسم الوحدة الطويل التف داخل الجزء المرن ولم يخف
  الإجمالي. المانع المحصور أعلاه هو رقم الفاتورة في meta.
- قالب PDF الجملة `salesInvoicePdfMarkup` مطابق بايتياً بين الأب والكوميت:
  الطول `3598` وSHA-256
  `999338b271fdeaf5c90a5c2aa0b1908c226c9c3528067d9c495580ca6e6923d0`.
  ودالة `printSalesInvoice` كاملة، بما فيها قالب A4، مطابقة بايتياً أيضاً:
  الطول `7656` وSHA-256
  `8ec78d2ae0dfe42d8e8a32686fe7885d40e999d72f969cde8112d2065b75b26a`.
- فرق الكوميت لا يمس الحراس أو المشاركة أو كشف الهاتف أو ربط الأزرار.
  لذلك بقيت حراس الأسطر/المكتبة/الوضع/السلسلة، معالجة AbortError والسقوط
  للتنزيل، وشرطا `(pointer:coarse)` و`(max-width:900px)` كما راجعتها الجولة
  السابقة.
- نجحت `node --check src/app.js` و`npm.cmd run check` و
  `git diff --check 4854d96 5fcdf4e`.

### ملاحظات تُسجّل ولا تمنع الدمج

- الأرقام الواقعية الحالية أقصر من أن تلتف في 80mm، لكن الشرط المطلوب
  بنيوي، والقالب نفسه يسمح بكسر رقم أطول؛ لذلك صُنّف مانعاً لا ملاحظة.
- السلسلة الأولى في `.ln-calc` (كمية + وحدة + سعر) مسموح لها بالالتفاف،
  بينما الإجمالي المقابل يبقى nowrap. هذا يحافظ على عرض الرول مع الوحدات
  الطويلة، ولا يغير القيمة أو يخفيها.

## 2026-07-26 - Codex - مراجعة PDF الهاتف وفاتورة الكاشير (`4854d96`)

- Status: **يوجد مانعان يمنعان الدمج.** روجع الفرع
  `claude/sales-invoice-pdf-ios` داخل worktree المحدد، والكوميتات
  `a9f9fe6` و`1757044` و`4854d96` حتى الرأس
  `4854d96d0071ba482e9dd561ecf7a26dad706927`، مقابل الأساس
  `d8b6a0871535fc04d503e63e4574b34d929fbd54`.
- المراجعة والمحاكاة واختبار Chromium محلية فقط. لم يحدث commit أو push أو
  merge، ولم يُعدّل أي سعر أو صف في Supabase، ولم تُشغّل أي مزامنة أو كتابة
  في الأمين.

### موانع تمنع الدمج

- **Blob URL يتسرّب في مسار فشل التنزيل بعد إنشائه.** ينشئ الكود
  `URL.createObjectURL(blob)` ثم ينشئ الرابط ويضيفه وينقره، ولا يجدول
  `URL.revokeObjectURL(url)` إلا بعد نجاح `link.click()` و`link.remove()`.
  إذا رمى `appendChild` أو `click` استثناءً، ينتقل التنفيذ إلى `catch` الخارجي
  قبل جدولة الإلغاء؛ فيبقى Blob URL بلا تحرير، وقد يبقى عنصر `<a>` أيضاً إذا
  نجحت إضافته وفشلت النقرة. يلزم `try/finally` محلي حول رابط التنزيل يزيل
  العنصر ويحرر URL في كل مسار، مع إمكان إبقاء تأخير التحرير بعد النقرة
  الناجحة إن كان مطلوباً للمتصفح.
- **اسم صنف طويل بلا نقاط كسر يكسر عرض فاتورة 80mm.** لا تحمل `.ln-name`
  `overflow-wrap:anywhere` أو `word-break`. اختبار Chromium بقالب الدالة
  الفعلي وعرض 302px أعطى `body.scrollWidth=1501px` و
  `.ln-name.scrollWidth=1486px` مقابل عرض 272px عند اسم طويل متصل. بذلك
  يتجاوز النص عرض الرول وقد يُقص أو يصغر المستند في الطباعة. يلزم قاعدة كسر
  داخل اسم الصنف، ويستحسن تطبيقها أيضاً على الكود/قيم الحساب الطويلة.

### ما اجتاز المراجعة

- مقطع قالب A4 الذي يبنيه `printSalesInvoice` مطابق حرفياً بين الأساس والرأس:
  `chars=3682` وSHA-256 نفسه
  `55d7abde6c9901a133ec0e664de56dce4e40c07c252298a29a3116773843d071`.
  التغيير بعد القالب فقط: `mode === "mufrak"` يختار
  `salesReceiptDocument`، وإلا يمرر `html` الأصلي نفسه إلى
  `printHtmlDocument` بالعنوان الأصلي. متغيرات الكاشير محصورة في الفرع
  الشرطي ولا تعدّل HTML أو CSS الجملة.
- `salesInvoicePdfMarkup` لا يحتوي أي `<style>`؛ الفحص أعاد صفر وسوم style
  عامة، وكل الأنماط البالغ عددها 29 سمات `style=""` داخل عناصر الحاوية، فلا
  توجد قاعدة CSS تتسرّب إلى واجهة التطبيق.
- بعد إضافة حاوية PDF، تغطيها `finally { container.remove(); }` عند نجاح
  التوليد، فشله، نجاح المشاركة، أو `AbortError`. وإذا فشل إنشاء/إضافة
  الحاوية قبل دخول `try` فلا تكون هناك حاوية مضافة باقية. مانع Blob URL
  مستقل ومذكور أعلاه.
- المشاركة تعالج `AbortError` كإلغاء: لا تعرض error ولا تنزّل الملف رغماً عن
  المستخدم، ثم يزيل `finally` الحاوية. عند غياب `navigator.canShare` أو
  إرجاعه false يسقط المسار إلى التنزيل. وعند خطأ مشاركة غير AbortError يسقط
  أيضاً إلى التنزيل.
- حراس التصدير واضحة: لا أسطر صالحة، غياب `html2pdf`، وضع `mufrak`، سلسلة
  غير موثوقة، أو تعذر الحصول على رقم؛ كلها تعرض رسالة وتعود قبل إنشاء
  الحاوية أو الملف. لا يستدعي المسار `salesReserveInvoiceNo` ولا يحفظ
  مستنداً، لذلك لا يستهلك رقماً؛ `ensureSalesInvoiceNo` يعرض/يخبئ الرقم
  التالي فقط كما كان يفعل مسار الطباعة.
- `isHandheldDevice` يعيد false فوراً عند غياب `matchMedia`. وعلى لابتوب
  عادي بمؤشر دقيق يفشل شرط `(pointer: coarse)` حتى إن كان العرض أقل من
  900px؛ فلا يختفي زر الطباعة. الشرطان لا يخفيانه إلا لجهاز ذي مؤشر خشن
  وشاشة ضيقة معاً.
- كل قيمة بيانات تدخل قالب الكاشير تمر عبر `escapeHtml`: رقم الفاتورة،
  التاريخ، الزبون، الدفع، اسم الصنف، الكود، الكمية، الوحدة، السعر، الإجمالي،
  المجاميع، ووسم المتبقي. اختبار محارف `<&"` لم ينشئ markup خاماً.
- اختبار 12 صنفاً بأسماء طويلة قابلة للالتفاف أبقى الأسطر الاثني عشر ورفع
  طول body تلقائياً إلى 1020px، فلا يوجد حد ثابت يقطع القائمة. المانع يخص
  السلاسل الطويلة بلا مسافات/نقاط كسر.
- `CACHE_NAME` يساوي حرفياً `web-platform-tobacco-v390`. يحتوي
  `index.html` سبعة أصول `tobacco-117` ولا توجد بقايا `tobacco-116` في
  الأصول المطلوبة؛ وأضيف `html2pdf.bundle.min.js` إلى كاش الـservice worker.
  نهايات أسطر `index.html` لم تتبدل عن الأساس:
  `bytes=1700`, و`LF=26`, منها `CRLF=19` و`bare LF=7`.
- نجحت `node --check src/app.js` و`npm.cmd run check` و
  `git diff --check d8b6a08 4854d96`.

### ملاحظات تُسجّل ولا تمنع الدمج

- على جهاز هجين صغير في وضع اللمس قد يطابق الشرطين ويُعامل كجهاز محمول،
  حتى لو كان نظامه Windows. هذا يوافق تعريف التنفيذ «مؤشر خشن + عرض
  ≤900px» ولا يؤثر في اللابتوب العادي ذي المؤشر الدقيق.
- `navigator.share` يأتي بعد توليد PDF غير المتزامن؛ بعض إصدارات iOS قد
  تعتبر إيماءة المستخدم منتهية فترفض المشاركة. الكود يتوقع ذلك ويسقط إلى
  التنزيل، لذا هو حد منصة لا مانع وظيفي.

## 2026-07-26 - Codex - مراجعة الحارس النهائي لمؤقّت الأرشيف (`3329ff9`)

- Status: **جاهز للدمج؛ لا توجد موانع ضمن نطاق المراجعة.** روجع الكوميت
  `3329ff9107fb319ecf8a8a7a0cbbe0e80a60299e` على الفرع
  `claude/sales-invoice-history` داخل worktree المحدد، مقابل أبيه المباشر
  `ba79d0e4cd740340c61bbdb10d5ace0b503636b9`.
- المراجعة والمحاكاة محليتان فقط. لم يحدث commit أو push أو merge، ولم
  يُعدّل أي سعر أو صف في Supabase، ولم تُشغّل أي مزامنة أو كتابة في الأمين.

### موانع تمنع الدمج

- **لا توجد موانع ضمن الشروط الخمسة المطلوبة.**

### تسجيل الخروج

- نقل `cancelSalesHistorySearch()` وإغلاق `salesHistoryOpen` وتفريغ
  `salesHistoryQuery` إلى أول `logout` وقبل `try` يضمن تنفيذها قبل أول
  `await`، سواء نجح `signOut` أو تأخر أو رمى خطأ.
- مسار النجاح لم يتغير بعد التنظيف المبكر: ما زال يصفر `session` وتقارير
  المخزون والأرصدة والحركات والحدود والأسعار وفواتير المشتريات، ثم يعرض
  إشعار النجاح ويرسم مرة واحدة.
- في مسار الفشل تبقى الجلسة والبيانات كما كانت، ويظهر إشعار الخطأ كما سابقاً،
  لكن الأرشيف مغلق والبحث والمؤقّت وعلم التركيز مصفرة. فيعود المستخدم إلى
  نموذج المبيعات داخل جلسته القائمة بدل شاشة أرشيف لها مؤقّت قديم؛ هذه حالة
  متّسقة ولا تدّعي نجاح الخروج.
- محاكاة الدالة الفعلية بحالتي نجاح وفشل `signOut` نجحت: الإلغاء مرة واحدة
  في الحالتين، رسم واحد، جلسة `null` في النجاح وجلسة باقية مع notice خطأ في
  الفشل، ومن دون `salesHistoryOpen/query/focus`.

### اسم المسار والحارس

- اسم مسار فاتورة المبيعات هو حرفياً `sales`: خريطة الصفحات تربط
  `sales: salesInvoice`، اختصار Alt+9 يوجّه إلى `sales`، وتعليقات الحالة
  والمعالجات تستعمل الاسم نفسه. `invoice` هو نموذج مستقل وليس مسار هذه
  الشاشة.
- لا يوجد مسار ثالث يفتح الأرشيف: بحث المستودع وجد تعيين
  `salesHistoryOpen = true` مرة واحدة فقط، داخل معالج
  `sales-history-open`. وهذا الزر يظهر مرة واحدة فقط داخل HTML الذي تبنيه
  `salesInvoice()`، أي عند route `sales`.
- شرط الإطلاق
  `!state.salesHistoryOpen || !state.session || state.route !== "sales"`
  صحيح. عند بقاء المستخدم في الأرشيف تبقى الجلسة والعلم والمسار صحيحة، فلا
  يمنع البحث المشروع. وعند تحويل مباشر إلى `login` يمنع شرط المسار إعادة
  الرسم حتى لو بقيت الجلسة والعلم صادقين.
- الإلغاء الصريح والحارس دفاعان متوافقان: الإلغاء يمحو المؤقّت ويصفر
  `salesHistoryFocus`; وإذا أفلت callback من الإلغاء، فهو يصفّر مرجع
  المؤقّت أولاً ثم يرجع قبل ضبط علم التركيز عند فساد أي شرط. لذلك لا يترك
  `salesHistoryFocus=true` ليسرق التركيز لاحقاً.

### عدم الانحدار

- التصفية ما زالت تُبنى من جميع `invoices` قبل
  `filtered.slice(0, LIMIT)`. محاكاة على 201 فاتورة وجدت الفاتورة رقم 8200
  بعد أول 150 وعرضتها وحدها.
- فتح الأرشيف ما زال يغيّر `salesHistoryOpen` فقط ثم يرسم. فرع
  `salesInvoice()` الخاص بالأرشيف ما زال قبل `ensureSalesInvoiceNo`، ولا
  يوجد في فرق الكوميت أي تعديل إلى `salesRows` أو منطق رقم الفاتورة.
- نجحت محاكاة نجاح/فشل logout ومحاكاة البحث لما بعد 150، و
  `node --check src/app.js`، و`npm.cmd run check`، و
  `git diff --check ba79d0e 3329ff9`.

### ملاحظات تُسجّل ولا تمنع الدمج

- عند فشل `signOut` يُمسح استعلام الأرشيف رغم بقاء الجلسة. هذا ناتج مقصود
  ومتّسق مع خروج المستخدم من شاشة الأرشيف فور طلب تسجيل الخروج؛ ولا يؤثر في
  بيانات الفاتورة الحالية أو بيانات الحساب.
- التحويلان القديمان إلى `login` ما زالا يعيّنان `state.route` مباشرة بدل
  `setRoute`، لكن شرط المسار الجديد يمنع callback المؤجّل من الرسم أو ضبط
  التركيز. توحيدهما مستقبلاً عبر `setRoute` تحسين نظافة فقط، وليس مانعاً
  لهذه الميزة بعد إضافة الحارس.

## 2026-07-26 - Codex - مراجعة إلغاء مؤقّت أرشيف الفواتير (`ba79d0e`)

- Status: **ما زال يوجد مانع يمنع الدمج.** روجع الكوميت
  `ba79d0e4cd740340c61bbdb10d5ace0b503636b9` على الفرع
  `claude/sales-invoice-history` داخل worktree المحدد، مقابل أبيه المباشر
  `eda434dccea8d967595c4fd5b0fafcc88813b2e4`.
- المراجعة ومحاكاة البحث محليتان فقط. لم يحدث commit أو push أو merge، ولم
  يُعدّل أي سعر أو صف في Supabase، ولم تُشغّل أي مزامنة أو كتابة في الأمين.

### مانع يمنع الدمج

- **إلغاء مؤقّت `logout` يحدث بعد فوات الأوان، وقد لا يحدث إطلاقاً.**
  الدالة تنتظر أولاً `await dataStore.signOut()`، وبعد نجاحه فقط تستدعي
  `cancelSalesHistorySearch()` وتغلق الأرشيف وتصفر الاستعلام. إذا استغرق
  `signOut` أكثر من 250ms، يبقى `state.session` و`state.salesHistoryOpen`
  صادقين خلال الانتظار، فيجتاز callback الحارس وينفذ إعادة الرسم. وإذا رمى
  `signOut` خطأ، يقفز التنفيذ إلى `catch` ولا يصل إلى الإلغاء أو إغلاق
  الأرشيف أصلاً. يلزم الإلغاء وإغلاق الأرشيف قبل أول `await`، مع إبقاء
  التنظيف آمناً في مسار الفشل أيضاً.
- **يوجد مسارا تحويل رابع وخامس إلى `login` لا يمران عبر `setRoute`:**
  معالج خطأ `addRequest` ومعالج خطأ `savePurchaseInvoice` يعيّنان
  `state.route = "login"` مباشرة ثم يرسمان. لا يلغي أي منهما المؤقّت، ولا
  يصفر `salesHistoryOpen` أو `session`. لذلك إذا انتهت عملية غير متزامنة
  قديمة بخطأ جلسة بعد أن انتقل المستخدم إلى الأرشيف وبدأ البحث، يجتاز
  callback الحارس لأن العلم والجلسة ما زالا صادقين، ثم يرسم صفحة الدخول
  مجدداً ويترك `salesHistoryFocus` معلّقاً.
- هذان السببان يثبتان أيضاً أن حارس
  `if (!state.salesHistoryOpen || !state.session) return` **لا يكفي وحده**
  عند فشل الإلغاء: بدء تسجيل الخروج لا يغيّر الشرطين قبل انتهاء الشبكة،
  والتحويلان المباشران إلى `login` لا يغيرانهما أصلاً. الأفضل توحيد كل
  تحويل إلى login عبر مسار يلغي البحث، وإضافة تحقق المسار نفسه داخل الحارس
  (مثل بقاء route المبيعات) كدفاع ثانٍ، لا الاعتماد على العلم والجلسة فقط.

### ما اجتاز المراجعة

- `setRoute` يغلق `salesHistoryOpen` ثم يستدعي
  `cancelSalesHistorySearch()` قبل الرسم؛ وزر الرجوع يستدعي الدالة نفسها ثم
  يغلق الأرشيف ويرسم. هذان المساران يلغيان المؤقّت ويصفران مرجعه وعلم
  التركيز فعلاً.
- الحارس لا يمنع الاستخدام المشروع: عند بقاء المستخدم مسجلاً وفي الأرشيف
  يظل الشرطان صادقين، فيضبط callback `salesHistoryFocus` ويعيد الرسم بعد
  250ms كما هو مقصود. المشكلة فقط أنه لا يميز بعض حالات المغادرة المذكورة
  في المانع.
- استدعاء `cancelSalesHistorySearch` من `setRoute` سليم زمنياً. الدالة
  معرفة بصيغة function declaration فتُرفع، ومتغير المؤقّت `let` يُهيأ أثناء
  تقييم الوحدة قبل استدعاء `boot()` الموجود في آخر الملف. لا يوجد استدعاء
  top-level لـ`setRoute` قبل تهيئة المتغير؛ والاستدعاءات المبكرة الفعلية
  تأتي لاحقاً من أحداث أو عمليات async بعد اكتمال تقييم الملف.
- عند نجاح `logout`، تصفير `salesHistoryQuery` لا يخلق تعارضاً: يُصفّر
  المصدر الوحيد قبل الرسم، ولا تُعرض شاشة الأرشيف بعد تصفير
  `salesHistoryOpen`. وعند فتحها في جلسة لاحقة يستعمل كل من التصفية وقيمة
  الحقل النص الفارغ نفسه. المانع هو توقيت/مسار الوصول إلى هذا التنظيف، لا
  نتيجة التنظيف عند تنفيذه.
- التصفية ما زالت تسبق القص. محاكاة بالدوال الفعلية على 251 فاتورة وجدت
  الفاتورة رقم 5250 في آخر المجموعة وعرضتها وحدها، وبلا بحث عرضت 150 بطاقة
  ورسالة `150 من أصل 251 مطابقة`.
- نجحت محاكاة البحث، و`node --check src/app.js`، و`npm.cmd run check`،
  و`git diff --check eda434d ba79d0e`.

### ملاحظات تُسجّل ولا تمنع الدمج

- `setRoute` يضبط `salesHistoryOpen=false` قبل إلغاء المؤقّت، وهو ترتيب آمن:
  حتى لو تعذر الإلغاء لسبب استثنائي، يرى callback العلم مغلقاً ويرجع. لا
  حاجة لعكس السطرين.
- لا يوجد اشتراك مستمر في تغيّر حالة مصادقة Supabase داخل `app.js`؛
  `refreshSession()` يُستدعى عند الإقلاع فقط. لذلك لا يوجد حالياً مسار
  منفصل لانتهاء جلسة تلقائي يعيد التوجيه فوراً، لكن أخطاء العمليات التي
  تعيد التوجيه إلى login هي مسارات الجلسة المنتهية الفعلية الواجب توحيدها.

## 2026-07-26 - Codex - مراجعة إصلاح بحث أرشيف الفواتير (`eda434d`)

- Status: **يوجد مانع واحد يمنع الدمج.** روجع الكوميت
  `eda434dccea8d967595c4fd5b0fafcc88813b2e4` على الفرع
  `claude/sales-invoice-history` داخل worktree المحدد، مقابل أبيه المباشر
  `e50532d6660fa6148d1633fb352db0b2ef4b6dc4`.
- المراجعة ومحاكاة البحث محليتان فقط. لم يحدث commit أو push أو merge، ولم
  يُعدّل أي سعر أو صف في Supabase، ولم تُشغّل أي مزامنة أو كتابة في الأمين.

### مانع يمنع الدمج

- **مؤقّت البحث لا يُلغى عند مغادرة الأرشيف بالتنقل أو عند تسجيل الخروج.**
  الإلغاء موجود فقط في معالج زر `sales-history-close`. أما `setRoute` فيغلق
  `salesHistoryOpen` ثم يرسم من دون `clearTimeout`، و`logout` يرسم بعد تصفير
  الجلسة من دون إلغاء المؤقّت أيضاً.
- السيناريو القابل للتكرار من الكود: يكتب المستخدم حرفاً، فيُجدول callback
  بعد 250ms؛ ثم ينتقل إلى صفحة أخرى قبل انقضائها. التنقل يرسم الصفحة الجديدة،
  وبعده ينفّذ callback القديم:
  `salesHistoryFocus = true; render();`. بذلك يحدث رسم ثانٍ غير مطلوب بعد
  مغادرة الشاشة، ويمكن أن يفقد أي حقل ركّز عليه المستخدم في الصفحة الجديدة
  تركيزه لأن `app.innerHTML` يُستبدل. وعند تسجيل الخروج يحدث الرسم المتأخر
  نفسه بعد تصفير الجلسة.
- لأن الصفحة الجديدة لا تحتوي `#sales-history-q`، لا يُستهلك
  `salesHistoryFocus` ويبقى `true` حتى فتح الأرشيف لاحقاً، وعندها يفرض
  التركيز على حقل البحث بسبب مؤقّت قديم. المطلوب إلغاء المؤقّت وتصفير علم
  التركيز في كل مسار يغادر الأرشيف، وخصوصاً `setRoute` و`logout`، أو جعل
  callback يتحقق من بقاء الجلسة والمسار و`salesHistoryOpen` قبل تغيير الحالة
  أو الرسم. زر الإغلاق وحده غير كافٍ.

### ما اجتاز المراجعة

- التصفية تسبق القص فعلاً: يبني الكود `filtered` من مجموعة `invoices` كاملة
  ثم ينفّذ `filtered.slice(0, LIMIT)`. محاكاة بالدوال الفعلية وتقرير من 201
  فاتورة وجدت الفاتورة رقم 1200 الموضوعة في آخر المجموعة، وعرضتها وحدها؛
  وبلا بحث عرضت 150 بطاقة فقط.
- رسائل النتائج تطابق التنفيذ: عدم التطابق يذكر نص البحث وإجمالي المجموعة،
  وعند بقاء أكثر من 150 نتيجة يقول إنه يعرض 150 من عدد **المطابقات** ويطلب
  تضييق البحث. لا يعود النص يعد بأن البحث الحالي يعرض عناصر غير موجودة في
  DOM؛ تضييق الاسم أو الرقم يعيد التصفية على المجموعة الكاملة.
- حُذفت سمتا `data-hist-row` و`data-hist-no` مع المعالج القديم كاملاً. بحث
  المستودع، باستثناء سجلات التسليم، لم يجد أي مرجع إلى السمتين أو
  `dataset.histRow` أو `dataset.histNo`.
- زر الإغلاق نفسه يلغي المؤقّت إن كان قائماً، يصفر مرجعه وعلم التركيز، ثم
  يغلق الأرشيف ويرسم. هذا المسار منفرداً سليم؛ المانع يخص بقية مسارات
  المغادرة.
- أثناء البقاء في الأرشيف لا تسرق `salesHistoryFocus` التركيز من حقل آخر:
  لا يُضبط العلم إلا داخل callback بحث، ولا يُنفّذ `focus()` إلا عند وجود
  `#sales-history-q`. بعد استعماله يُصفّر مباشرة. الخلل خارج الأرشيف ناتج من
  الرسم المتأخر والعلم المتبقي كما هو موضح في المانع.
- آخر حرف لا يضيع: حدث `input` يكتب `event.target.value` كاملاً إلى
  `state.salesHistoryQuery` قبل إلغاء المؤقّت السابق وجدولة الجديد. كل حرف
  جديد يؤخر الرسم 250ms أخرى، وآخر callback يقرأ الحالة الأحدث. الرسم يستعمل
  `state.salesHistoryQuery` نفسها في التصفية وفي `value` للحقل، ثم يضع المؤشر
  في نهاية القيمة نفسها.
- فتح الأرشيف لم يتغير: يضبط `salesHistoryOpen` فقط. فرع الأرشيف في
  `salesInvoice()` ما زال قبل `ensureSalesInvoiceNo`، ولا يوجد في فرق الكوميت
  أي تعديل لـ`salesRows` أو `salesInvoiceNo`.
- نجحت محاكاة التصفية، و`node --check src/app.js`، و`npm.cmd run check`،
  و`git diff --check e50532d eda434d`.

### ملاحظات تُسجّل ولا تمنع الدمج

- البحث يطابق اسم الزبون بعد التطبيع أو رقم الفاتورة كنص، ولا يطابق التاريخ.
  الرسالة والـplaceholder يقولان صراحة «اسم الزبون أو رقم الفاتورة»، لذلك
  هذا مطابق للعقد الحالي وليس وعداً ناقصاً.
- الاستعلام المؤلف من مسافات فقط يبقى ظاهراً في الحقل كما كتبه المستخدم،
  لكنه يُعامل كبحث فارغ بسبب `trim()` وتظهر أحدث 150 فاتورة. هذا سلوك متسق
  مع تجاهل المسافات ولا يمنع الدمج.

## 2026-07-26 - Codex - مراجعة شاشة أرشيف فواتير المبيعات (`e50532d`)

- Status: **يوجد مانع واحد يمنع الدمج.** روجع الكوميت
  `e50532d6660fa6148d1633fb352db0b2ef4b6dc4` على الفرع
  `claude/sales-invoice-history` داخل worktree المحدد، مقابل أبيه المباشر
  `a918aad02825d113d4a0a8b28247800104b7ecd8`.
- المراجعة قراءة ومحاكاة محلية فقط. لم يحدث commit أو push أو merge، ولم
  يُعدّل أي سعر أو صف في Supabase، ولم تُشغّل أي مزامنة أو كتابة في الأمين.

### مانع يمنع الدمج

- **الفواتير الأقدم من حد 150 غير قابلة للبحث أو الوصول، خلافاً للنص المعروض.**
  في `salesHistoryPanel` تُنفّذ
  `shown = invoices.slice(0, LIMIT)` ثم لا يُنشأ DOM إلا من `shown`. معالج
  البحث لاحقاً لا يبحث في `salesHistoryInvoices()` ولا يعيد الرسم، بل يمرّ
  فقط على `[data-hist-row]` الموجودة في DOM. لذلك عند 151 فاتورة مثلاً لا
  يمكن للبحث إظهار الفاتورة رقم 151 مهما كان الاستعلام مطابقاً لها.
- النص الظاهر عند تجاوز الحد يقول:
  `استعمل البحث للوصول إلى الأقدم`، وهو ادعاء غير صحيح مع التنفيذ الحالي.
  يلزم إما أن يطبّق البحث على المجموعة الكاملة قبل أخذ أول 150، أو إضافة
  تحميل/ترقيم صفحات حقيقي؛ حذف الجملة وحده لا يحقق وظيفة الوصول للأرشيف
  الأقدم.

### ما اجتاز المراجعة

- فتح الأرشيف من النموذج القائم يغيّر `salesHistoryOpen` فقط ثم يعيد الرسم.
  فرع الأرشيف في `salesInvoice()` يسبق `salesCurrentMode` و
  `ensureSalesInvoiceNo`، فلا يستدعي الترقيم ولا يغيّر `salesRows` أو
  `salesCustomer` أو `salesInvoiceNo`. الإغلاق يغيّر العلم فقط؛ وعند الرجوع
  إلى نموذج سبق رسمه يبقى الرقم نفسه لأن `ensureSalesInvoiceNo` يعيد القيمة
  المخبأة ما دام الوضع لم يتغير.
- إضافة `state.salesHistoryOpen = false` إلى `setRoute` لا تغيّر توقيعه أو
  قيمة `route` أو منطق `clearNotice`. فُحصت مواضع الاستدعاء الثمانية؛ لا
  يستعمل أي منها قيمة إرجاع أو يعتمد بقاء شاشة داخلية مفتوحة، وإغلاق الأرشيف
  عند التنقل هو السلوك المقصود.
- أزرار الأرشيف تستعمل السمات الثلاث التي يقرأها المعالج القائم:
  `data-customer` و`data-inv-number` و`data-inv-date`. مصدر المزامنة يحفظ
  التاريخ بصيغة `yyyy-MM-dd`، وهي الصيغة التي يمررها الأرشيف. اسم الزبون
  مقصوص الأطراف أصلاً في استعلام PowerShell، و`customerInvoicesFor` يستعمل
  `smartNameMatch`، فلا تفشل المطابقة بسبب التطبيع المعتاد. المعالج يضبط
  `type` إلى `return` عندما تكون `inv.isReturn` صحيحة، فلا يُصدّر المرتجع
  كفاتورة بيع.
- البحث يعدّل `style.display` بلا `render()` أثناء حدث `input`، لذلك يبقى
  التركيز في الحقل. أي إعادة رسم تستبدل `app.innerHTML` بالكامل بصفوف جديدة
  بلا `display:none`، فلا تبقى الصفوف القديمة مخفية.
- كل قيمة تقرير تدخل HTML تمر عبر `escapeHtml`: اسم الزبون، الرقم، التاريخ،
  الإجمالي، عدد الأصناف، اسم المادة، الكمية، السعر، وسمات `data-*`.
  و`escapeHtml` يهرب `& < > " '`، بما في ذلك علامات الاقتباس داخل السمات.
- حالات غياب التقرير والتقرير الفارغ وفاتورة بلا أصناف لها رسائل مستقلة ولا
  ترمي خطأ. حالة أكثر من 150 لا تنهار، لكنها تفشل وظيفياً كما في المانع أعلاه.
- `CACHE_NAME` يساوي حرفياً `web-platform-tobacco-v387`. يحتوي
  `index.html` سبعة أصول `tobacco-116` ولا توجد بقايا `tobacco-115` في
  الأصول المطلوبة. بصمة نهايات أسطر `index.html` متطابقة بين الأب والكوميت:
  `bytes=1700`, و`LF=26`, منها `CRLF=19` و`bare LF=7`.
- نجحت `node --check src/app.js` و`npm.cmd run check` و
  `git diff --check a918aad e50532d`.

### ملاحظات تُسجّل ولا تمنع الدمج

- يحتفظ `salesHistoryQuery` بنص البحث عند إعادة الرسم، لكن الرسم الجديد لا
  يعيد تطبيق المرشح حتى يحدث إدخال جديد؛ فتظهر كل الصفوف مع بقاء نص البحث في
  الحقل. هذا لا يترك صفوفاً مخفية ولا يضيّع التركيز أثناء الكتابة، لكنه عدم
  اتساق بصري يمكن إغلاقه مع إصلاح حد 150 بتطبيق الاستعلام قبل الرسم.
- ترتيب الفواتير عند رقم غير رقمي أو تاريخ متساوٍ يبقى معتمداً على ثبات
  `Array.sort` وترتيب التقرير الأصلي. لا يؤثر ذلك في العثور على الفاتورة
  بالسمات الثلاث ضمن عقد بيانات المزامنة الحالي.

## 2026-07-26 - Claude - ترتيب سطر الصنف على الرول وفحص التداخل

- Status: **منجز على `claude/sales-invoice-pdf-ios` فوق `66279b8`، غير مدموج
  وغير منشور.**

### ما لاحظه المالك

- أرسل لقطة لصفحة اختبار متطرفة (رابط `data:` بعنوان «فاتورة كاشير
  999999999999999999»، أسماء أصناف وهمية متصلة، وثلاث فواتير مكدّسة في مستند
  واحد) ظهر فيها تداخل عند كتلة «الإجمالي».

### الفحص

- بُنيت فاتورة من **الدالة الفعلية** بأربعين صنفاً وأسماء متصلة وقيست هندسة
  كل كتلة: **صفر تداخل** بين 44 كتلة، وكتلة المجاميع تبدأ 6px تحت آخر صنف،
  والعرض 302px = 80mm، والارتفاع 1966px (رول طويل كما يجب).
- الخلاصة: التداخل في اللقطة من تكديس ثلاث فواتير في مستند واحد داخل رابط
  `data:` (مستندات كاملة متسلسلة بأنماطها) لا من القالب.

### إصلاح ظهر أثناء الفحص

- كان `dir="ltr"` على مجموعة الكمية/الوحدة/السعر كلها، فبدا ترتيبها معكوساً
  في ورقة عربية. صار الاتجاه RTL كاتجاه الورقة مع `dir="ltr"` **لكل رقم على
  حدة**، وفاصل `×` عنصراً مستقلاً. الترتيب من اليمين الآن:
  الكمية ← الوحدة ← × ← السعر، والإجمالي على اليسار.
- قياس بعد الإصلاح ببيانات واقعية بالليرة: الترتيب `3 · كروز · × · 106,500`،
  صفر قصّ، صفر تداخل، العرض 302px.

### الفحوص

- `node --check`، `npm.cmd run check`، `git diff --check`: ناجحة. الكاش
  والأصول كما هما (v390 / tobacco-117).

## 2026-07-26 - Claude - إغلاق مانعَي سطر الصنف على الرول

- Status: **منجز على `claude/sales-invoice-pdf-ios` فوق `f25cee7`، غير مدموج
  وغير منشور.**

### المانعان

1. `nb` كان يغلّف الكمية واسم الوحدة والسعر **في عنصر واحد**، فمنع التفاف
   الوحدة وقصّ العبارة كاملة.
2. مع وحدة طويلة انضغط مبلغ واقعي `12,500,000` إلى 16px بينما يحتاج 57px،
   فظهر مقصوصاً — وهو مبلغ ليرة سورية عادي لا حالة متطرفة.

### الإصلاح — أولوية قصّ صريحة داخل السطر

- سطر الحساب صار ثلاثة عناصر مستقلة: الكمية (`nb`)، اسم الوحدة
  (`ln-unit`)، السعر (`nb`)، إضافة إلى الإجمالي (`nb`).
- الأرقام كلها `flex: 0 0 auto` — **لا تُضغط ولا تُقصّ إطلاقاً**. اسم الوحدة
  وحده `min-width:0` مع قصّ بالنقاط الثلاث، فهو الوحيد الذي يتنازل عند الضيق.
- `overflow:hidden` على السطر يضمن ألا يمدّ أي مدخل عرض الرول.

### القياسان (Chromium فعلي)

- **حالة Codex بالضبط** (وحدة متصلة من 31 محرفاً + `12,500,000`):
  السعر 67px من أصل 67 مطلوب و**غير مقصوص**، الإجمالي `37,500,000` 57/57
  غير مقصوص، الكمية سليمة، **اسم الوحدة وحده** قُصّ (128 من 131).
  `bodyScrollWidth = 302px` = 80mm.
- **بيانات واقعية** (كرتونة + 12,500,000 + 37,500,000): **صفر عنصر مقصوص**،
  وصفر عنوان منضغط تحت 20px، والعرض 302px.

### خطأ نحوي أُمسك أثناء العمل

- تعليق CSS كتبته داخل قالب نصّي احتوى علامتَي backtick فأنهى القالب مبكراً
  وكسر الملف. أمسكه `node --check` فوراً وصُحّح قبل أي حفظ. الدرس: لا backtick
  داخل تعليقات القوالب النصية.

### الفحوص

- `node --check`، `npm.cmd run check`، `git diff --check`: ناجحة. الكاش
  والأصول كما هما (v390 / tobacco-117).

## 2026-07-26 - Claude - إغلاق مانعَي شمول nb وحدّ عرض الأرقام

- Status: **منجز على `claude/sales-invoice-pdf-ios` فوق `b45e69a`، غير مدموج
  وغير منشور.**

### المانع الأول — قيم رقمية خارج `nb`

- الكمية والسعر (سطر `ln-calc`) والتاريخ لم تكن تحمل الصنف، فكانت عرضة
  للكسر داخل الرقم. صارت كلها `nb`. المجموع الآن **16 عنصراً** بالصنف.

### المانع الثاني — الأرقام غير مكسورة وغير محدودة العرض

- منع الكسر وحده أعاد التمدّد (قياس Codex: 302px ← **1253px**) لأن الرقم
  الطويل لا يُكسر ولا يُقصّ فيدفع العرض أمامه.
- الحلّ: `nb` صار `display:inline-block` مع `max-width:100%` و
  `overflow:hidden` و`text-overflow:ellipsis`، مع `min-width:0` لأبناء
  الصفوف المرنة. أي رقم مهما طال **يُقصّ بثلاث نقاط ولا يمدّ الرول أبداً**.

### القياسان (Chromium فعلي)

- **حالة متطرفة** (مبالغ من 24 خانة، وحدة باسم متصل من 22 محرفاً، تاريخ طويل،
  رقم فاتورة طويل، اسم صنف وزبون متصلان): `bodyScrollWidth = 302px` = 80mm
  بالضبط، أعرض عنصر 272px، **صفر التفاف**، وعنصران قُصّا بالنقاط الثلاث.
- **بيانات حقيقية** (616، ٢٦ يوليو ٢٠٢٦، `3 كروز × 7,100`، 21,300، أكواد
  الأصناف): `bodyScrollWidth = 302px` و**صفر قيمة مقصوصة** — القصّ لا يمسّ
  أي مدخل واقعي.

### الفحوص

- `node --check`، `npm.cmd run check`، `git diff --check`: ناجحة. الكاش
  والأصول كما هما (v390 / tobacco-117).

## 2026-07-26 - Claude - إغلاق مانع التفاف رقم الفاتورة على الرول

- Status: **منجز على `claude/sales-invoice-pdf-ios` فوق `5fcdf4e`، غير مدموج
  وغير منشور.**

### المانع

- قاعدة كسر الكلمات التي أُضيفت لعلاج تمدّد العرض كانت **عامة على الجسم**،
  فشملت رقم الفاتورة نفسه: رقم طويل يلتف إلى سطرين (أثبته Codex على Chromium).

### الإصلاح

- صنف `.nb` (`white-space: nowrap` + `overflow-wrap: normal` +
  `word-break: keep-all`) طُبّق على **كل ما هو رقم**: رقم الفاتورة، كود الصنف،
  إجمالي السطر، وكل قيم كتلة المجاميع.
- الكسر داخل الكلمة بقي **للنصوص وحدها**: اسم الصنف واسم الزبون — وهما مصدر
  التمدّد الأصلي.

### القياس بعد الإصلاح (Chromium فعلي)

- رقم فاتورة `MUF-2607-000616-CENTER-XL`: **سطر واحد** (`getClientRects` = 1).
- **صفر** عنصر رقمي ملتفّ من بين كل عناصر `.nb`.
- اسم صنف متصل من 56 محرفاً: التفّ على سطرين كما يجب (ارتفاع 36px = سطران).
- اسم زبون متصل: 197px عرضاً بلا قصّ (`scrollWidth == clientWidth`).
- `bodyScrollWidth = 302px` = **80mm بالضبط**، بلا تمدّد.

### الفحوص

- `node --check`، `npm.cmd run check`، `git diff --check`: ناجحة. الكاش
  والأصول كما هما (v390 / tobacco-117).

## 2026-07-26 - Claude - إغلاق مانعَي تسرّب Blob وكسر عرض الرول

- Status: **منجز على `claude/sales-invoice-pdf-ios` فوق `4854d96`، غير مدموج
  وغير منشور.**

### المانع الأول — تسرّب Blob URL

- كان `URL.revokeObjectURL` مجدولاً **بعد** إنشاء الرابط والنقر عليه، فأي فشل
  بينهما يترك الرابط معلّقاً في الذاكرة إلى حين إغلاق الصفحة.
- صار **التحرير يُجدول فور الإنشاء** وقبل أي عملية أخرى، وإزالة العنصر داخل
  `finally`. لا مسار يترك رابطاً حياً بعد ذلك.

### المانع الثاني — اسم صنف طويل يمدّ عرض الرول

- قياس Codex: العرض ينتفخ من 302px إلى **1501px** مع اسم متصل بلا مسافات.
- الإصلاح: `max-width: 80mm` مع `overflow-wrap: anywhere` و`word-break:
  break-word` على الجسم، و`gap` وحماية `min-width:0` لصفوف flex، مع
  `white-space: nowrap` للأرقام وحدها كي لا ينكسر مبلغ في منتصفه.
- **قياس بعد الإصلاح على Chromium فعلي** بصنف باسم متصل من 56 محرفاً واسم
  زبون متصل مثله: `bodyScrollWidth = 302px` (أي 80mm بالضبط)، وأعرض عنصر
  داخلي 272px. **مطابق للحدّ، لا تمدّد.**

### الفحوص

- `node --check`، `npm.cmd run check`، `git diff --check`: ناجحة. الكاش
  والأصول كما هما (v390 / tobacco-117) لأن ما قبله لم يُنشر.

## 2026-07-26 - Claude - الطباعة للابتوب فقط، والهاتف تصدير PDF

- Status: **منجز على `claude/sales-invoice-pdf-ios`، غير مدموج وغير منشور.**

### القرار

- المالك: **لا لزوم للطباعة من الهاتف إطلاقاً — لا جملة ولا مفرق.** الطباعة
  للابتوب وحده، والهاتف للتصدير PDF.

### التنفيذ

- `isHandheldDevice()` يشترط **الأمرين معاً**: `(pointer: coarse)` **و**
  `(max-width: 900px)`. الشرطان معاً بقصد: لابتوب بشاشة لمس لا يُحسب هاتفاً
  فيفقد زر الطباعة. `index.html` يحمل `viewport width=device-width` فتُقاس
  الشاشة بعرض الجهاز الحقيقي.
- زر الطباعة لا يُعرض على الهاتف. الجدول الناتج:

  | الجهاز | الجملة | المفرق |
  |---|---|---|
  | لابتوب | PDF + طباعة A4 | طباعة فاتورة كاشير |
  | هاتف | PDF فقط | (لا زر مخرجات) |

- خانة «هاتف + مفرق» فارغة عمداً تنفيذاً لقرارين معاً: لا PDF للمفرق، ولا
  طباعة من الهاتف. **مرفوعة للمالك**: إن احتاج مخرجاً للمفرق من الهاتف
  فالإضافة سطر واحد.

### التحقق وحدود التحقق

- على متصفح فعلي بعرض 1280: `pointer:coarse=false` و`handheld=false` — أي
  **اللابتوب يحتفظ بزر الطباعة**، وهو الجانب الخطِر من الكشف.
- محاكاة الجوال في المتصفح لا تفعّل `pointer: coarse`، فالتحقق النهائي من
  إخفاء الزر يحتاج جهاز المالك. **نمط الفشل حميد**: لو فشل الكشف على الهاتف
  يبقى الزر ظاهراً كما هو اليوم، ولا يضيع شيء.
- `node --check`، `npm.cmd run check`، `git diff --check`: ناجحة.

## 2026-07-26 - Claude - فصل مخرجات الجملة والمفرق (قرار المالك)

- Status: **منجز على `claude/sales-invoice-pdf-ios` فوق `a9f9fe6`، غير مدموج
  وغير منشور.**

### القرار كما طلبه المالك

- **الجملة:** ملف PDF معتمَد لفاتورة الموقع (زر «حفظ / مشاركة PDF»).
- **المفرق:** لا داعي لتصدير PDF إطلاقاً، والطباعة تكون **فاتورة كاشير**
  على رول حراري لا ورقة A4.

### التنفيذ

- `salesReceiptDocument()`: مستند مستقل بمقاس `@page { size: 80mm auto }`
  وهوامش صفر، بعرض جسم 80mm. كل صنف بسطرين (الاسم ثم «كمية × سعر = إجمالي»)
  لأن سبعة أعمدة لا تُقرأ على رول ضيّق. الطول تلقائي فلا تُقطع الورقة.
- `printSalesInvoice` صار يختار: المفرق ← فاتورة الكاشير، والجملة ← **قالب A4
  كما هو بلا أي تعديل**. عنوان نافذة الطباعة يتبع النوع.
- زر «حفظ / مشاركة PDF» يظهر **في وضع الجملة فقط**، ومع ذلك يوجد حارس داخل
  `saveSalesInvoicePdf` يرفض التصدير في المفرق برسالة واضحة حتى لو استُدعي
  بأي طريق آخر.
- زر الطباعة في المفرق صار نصّه «🖨 طباعة فاتورة كاشير» ليعرف المستخدم النوع
  قبل الضغط.

### التحقق

- بُنيت معاينة من **دالة `salesReceiptDocument` المقتطعة من `src/app.js`
  نفسه** وسُلّمت للمالك للمعاينة البصرية.
- `node --check`، `npm.cmd run check`، `git diff --check`: ناجحة.

### حدّ يُسجَّل

- الطباعة على iOS داخل التطبيق المثبَّت لا تفتح نافذة أصلاً (نفس علّة الجملة).
  فاتورة الكاشير عملياً تُطبع من جهاز الكاشير (ويندوز) الموصول بالطابعة
  الحرارية. إن أراد المالك طباعة مفرق من الهاتف فهذه مسألة منفصلة تحتاج
  حلاً آخر (طابعة شبكية أو تطبيق وسيط).

## 2026-07-26 - Claude - تصدير الفاتورة PDF من الهاتف (عطل iOS)

- Status: **منجز على `claude/sales-invoice-pdf-ios` فوق `d8b6a08`، غير مدموج
  وغير منشور.** لا كتابة في الأمين أو Supabase ولا تعديل أسعار.

### العطل كما بلّغ عنه المالك

- على الهاتف: زر «طباعة / PDF» في فاتورة المبيعات **لا يفتح أي نافذة إطلاقاً**،
  بينما تظهر رسالة نجاح. السبب: `window.print()` داخل الإطار المخفي **لا يعمل
  ولا يرمي استثناءً** في وضع التطبيق المثبَّت على iOS (standalone)، فلا يلتقطه
  `onError` ويبدو للمستخدم أن العملية نجحت.

### الحل — ملف PDF حقيقي بدل الاعتماد على ورقة الطباعة

- زر جديد **«📄 حفظ / مشاركة PDF»** بجانب زر الطباعة (الطباعة بقيت كما هي
  للويندوز، بلا أي تعديل على `printSalesInvoice`).
- `salesInvoicePdfMarkup()` نسخة من الفاتورة **بأنماط سطرية بالكامل** بلا وسم
  `<style>` عام: حاوية التوليد تعيش داخل صفحة التطبيق، وأي قاعدة `body{}` أو
  `table{}` كانت ستتسرّب على الواجهة. الخلفية بيضاء صراحةً (قاعدة CLAUDE.md).
- `saveSalesInvoicePdf()` يولّد Blob عبر `html2pdf` (المحمّلة أصلاً محلياً في
  `public/vendor/`)، ثم:
  1. `navigator.share({files})` إن دعمها النظام — على iOS هي الطريق العملي
     للحفظ في «الملفات» أو الإرسال على واتساب مباشرةً.
  2. إلغاء المستخدم للمشاركة (`AbortError`) لا يُنزّل الملف رغماً عنه.
  3. وإلا تنزيل مباشر عبر رابط Blob (الويندوز).
- الحراس نفسها المستعملة في الطباعة: أسطر صالحة + سلسلة ترقيم موثوقة + وجود
  المكتبة، وإلا رسالة خطأ واضحة بلا توليد.

### التحقق الفعلي (متصفح حقيقي، لا افتراض)

- بُنيت صفحة معاينة مؤقتة من **دالة `salesInvoicePdfMarkup` المقتطعة من
  `src/app.js` نفسه** وشُغّلت على سيرفر محلي بمتصفح فعلي:
  - الناتج ملف حقيقي: **141 KB**، النوع `application/pdf`، والبصمة `%PDF-`.
  - تحليل بكسلات لوحة html2canvas (1498×2004 قبل التقطيع): **83% أبيض،
    1% داكن (نص)، 16% حدود وعناوين** — أي صفحة بيضاء بنص ظاهر، لا فارغة ولا
    سوداء (العطل الموثّق سابقاً مع html2canvas).
- `node --check`، `npm.cmd run check`: ناجحة.
- `CACHE_NAME` رُفع إلى **v390** وأصول `index.html` السبعة إلى **tobacco-117**
  بلا بقايا. نهايات الأسطر: `index.html` CR=19 قبل وبعد (perl)، `src/app.js`
  CR=0.

### حدود تُسجَّل

- `navigator.share` يتطلب إيماءة مستخدم؛ التوليد يستغرق وقتاً قد يُنهي صلاحية
  الإيماءة على بعض إصدارات iOS، ولذلك يوجد سقوط تلقائي إلى التنزيل المباشر.
  التحقق النهائي من ورقة المشاركة يحتاج جهاز المالك.
- الطباعة القديمة لم تُلمس: من يطبع من ويندوز يبقى على المسار نفسه.

## 2026-07-26 - Claude - دمج ونشر شاشة الفواتير السابقة (`3618746`)

- Status: **مدموج في `main` ومنشور، ومُتحقَّق منه على الموقع الحيّ.**
  لم يُعدَّل أي سعر، ولم تُشغَّل أي مزامنة أسعار، ولا كتابة في الأمين، ولا حذف
  من Supabase. الدفع عادي بلا `--force`.

### الكاش قبل الدمج

- `origin/main` كان قد رُفع تلقائياً إلى **v387** بكوميت مولّد النشرات
  `223fc38` (بأصول `tobacco-115`)، والفرع كان أيضاً على v387 (بأصول
  `tobacco-116`). الأعلى = v387 → رُفع إلى **v388** بعد دمج `origin/main` في
  الفرع (`-Xignore-all-space`، بلا تعارض)، ثم fast-forward لـ`main`.

### الكوميتات المدموجة

- `e50532d` شاشة الفواتير السابقة · `eda434d` التصفية تسبق القصّ ·
  `ba79d0e` إلغاء مؤقّت البحث وحارس الإطلاق · `3329ff9` الإلغاء قبل الانتظار
  وحارس المسار · `2d4f300` توثيق اعتماد Codex · `3618746` رفع الكاش.
- أربع جولات مراجعة Codex، آخرها: **جاهز للدمج بلا موانع**.

### التحقق الفعلي بعد النشر

- workflow «Deploy TOBACCO Web» رقم `30203243982` على `3618746`:
  **completed / success**.
- `index.html` الحيّ: **7 مراجع `tobacco-116`** وصفر `tobacco-115`.
- `public/service-worker.js` الحيّ: `CACHE_NAME = "web-platform-tobacco-v388"`.
- `src/app.js?v=tobacco-116` الحيّ (389,299 بايت) يحوي `salesHistoryPanel`
  و`salesHistoryInvoices` و`cancelSalesHistorySearch` ونصّي «الفواتير السابقة»
  و«رجوع للفاتورة الحالية».
- الرابط: `https://fhwvtqdc2q-svg.github.io/tobacco-web`

### الفحوص قبل الدفع

- المحاكاة: **31 فحصاً، صفر إخفاق** (بعد دمج `origin/main` أيضاً).
- `node --check`، `npm.cmd run check`، `git diff --check`: ناجحة.
- نهايات الأسطر: `index.html` CR=19 قبل وبعد (عُدِّل بـperl)،
  `src/app.js` و`public/service-worker.js` و`AI_HANDOFF.md` CR=0.

## 2026-07-26 - Claude - إغلاق مانعَي نافذة logout والتحويل المباشر إلى login

- Status: **منجز على `claude/sales-invoice-history` فوق `ba79d0e`، غير مدموج
  وغير منشور.** لا كتابة في الأمين أو Supabase ولا تعديل أسعار.

### المانع الأول — الإلغاء بعد `await signOut()`

- كان الإلغاء يقع بعد انتظار `signOut()`، فبقيت نافذة يمكن للمؤقّت أن يعمل
  فيها، ولم يكن يُلغى إطلاقاً لو فشل الخروج (المسار يذهب إلى `catch`).
- صار الإلغاء **أول سطر في `logout` قبل `try` وقبل أي انتظار**، ومعه إغلاق
  الأرشيف وتفريغ نص البحث. فحصٌ ثابت يتحقق أن موضع الإلغاء يسبق `try` ويسبق
  `await dataStore.signOut()` نصياً.

### المانع الثاني — تحويلان إلى `login` لا يمران بـ`setRoute`

- بدل ملاحقة كل موضع تحويل، قُوِّي **حارس الإطلاق** نفسه ليشترط المسار:
  `if (!state.salesHistoryOpen || !state.session || state.route !== "sales") return;`
- بذلك يتوقف المؤقّت عند أي تحويل — الموضعين الحاليين (`src/app.js:972`
  و`6572`) وأي تحويل يُضاف مستقبلاً — من دون الاعتماد على أن يتذكّر أحد
  استدعاء الإلغاء هناك. الإلغاء الصريح في `setRoute` و`logout` وزر الرجوع
  يبقى طبقة أولى، والحارس طبقة ثانية مستقلة عنها.

### الفحوص

- المحاكاة صارت **31 فحصاً، صفر إخفاق**. الجديد: الحارس يشمل المسار والجلسة
  والأرشيف معاً؛ ترتيب الإلغاء في `logout` قبل `try` و`await`؛ وعدّ مواضع
  التحويل المباشر إلى `login` (اثنان، يغطيهما شرط المسار).
- `node --check`، `npm.cmd run check`، `git diff --check`: ناجحة. الكاش
  والأصول كما هما (v387 / tobacco-116) لأن ما قبله لم يُنشر.

## 2026-07-26 - Claude - إغلاق مانع تسرّب مؤقّت البحث

- Status: **منجز على `claude/sales-invoice-history` فوق `eda434d`، غير مدموج
  وغير منشور.** لا كتابة في الأمين أو Supabase ولا تعديل أسعار.

### المانع — إعادة رسم متأخرة على شاشة أخرى

- كان المؤقّت يُلغى عند زر الرجوع فقط. الكتابة في البحث ثم التنقّل أو تسجيل
  الخروج خلال 250ms كانا يتركانه يُطلق `render()` على الشاشة الجديدة فيسرق
  تركيز الحقل الذي يكتب فيه المستخدم هناك.
- أُضيفت `cancelSalesHistorySearch()` (تلغي المؤقّت وتصفّر `salesHistoryFocus`)
  وتُستدعى من **ثلاثة مواضع**: `setRoute` (كل تنقّل)، `logout`، وزر الرجوع.
  `logout` يغلق الأرشيف ويفرّغ نص البحث أيضاً.
- **وحارس ثانٍ عند الإطلاق** لا يعتمد على الإلغاء إطلاقاً:
  `if (!state.salesHistoryOpen || !state.session) return;` — أي مسار خروج لم
  نتوقّعه لا يزال آمناً لأن إعادة الرسم لا تحدث أصلاً خارج الأرشيف.

### الفحوص

- المحاكاة صارت 29 فحصاً، كلها ناجحة. الجديد: وجود الحارس داخل استدعاء
  `setTimeout` الفعلي، واستدعاء الإلغاء في `setRoute` و`logout` وزر الرجوع،
  وعدم بقاء أي `clearTimeout` يدوي خارج الدالة الموحّدة، **وفحص تشغيلي** لدالة
  الإلغاء المقتطعة من الملف: الاستدعاء المؤجَّل لم يُنفَّذ بعد الإلغاء
  (`fired=false`) والمقبض والعلَم صُفّرا.
- `node --check`، `npm.cmd run check`، `git diff --check`: ناجحة. الكاش
  والأصول كما هما (v387 / tobacco-116) لأن ما قبله لم يُنشر.

## 2026-07-26 - Claude - إغلاق مانع بحث الأرشيف

- Status: **منجز على `claude/sales-invoice-history` فوق `e50532d`، غير مدموج
  وغير منشور.** لا كتابة في الأمين أو Supabase ولا تعديل أسعار.

### المانع — البحث لا يتجاوز أول 150 فاتورة

- كان القصّ يسبق التصفية، والبحث يخفي صفوفاً في DOM فقط، فبقيت الفواتير بعد
  الـ150 غير قابلة للوصول رغم أن الرسالة تَعِد بالعكس.
- **التصفية صارت تسبق القصّ داخل `salesHistoryPanel()`**، والبحث صار يعيد
  الرسم (بتأخير 250ms) بدل إخفاء DOM. حُذفت سمتا `data-hist-row`
  و`data-hist-no` فلا تبقى آلية تصفية ثانية.
- الرسائل صارت تصف الواقع: «تُعرض 150 فاتورة من أصل N مطابقة. ضيّق البحث
  للوصول إلى الباقي»، ورسالة صريحة عند عدم وجود مطابق.

### الملاحظة غير المانعة — نص بحث بلا أثر

- أُغلقت أيضاً: بما أن التصفية تحدث عند الرسم، فأي إعادة رسم تُبقي القائمة
  متوافقة مع النص الظاهر في الحقل.
- `state.salesHistoryFocus` يعيد التركيز وموضع المؤشر إلى آخر النص بعد إعادة
  الرسم، فلا تنقطع الكتابة. مؤقّت التأجيل على مستوى الوحدة (لا داخل دالة
  الربط) ويُلغى عند إغلاق الأرشيف.

### الفحوص

- المحاكاة صارت 22 فحصاً، كلها ناجحة. الجديد منها: بلا بحث تُعرض 150 بطاقة
  والرسالة تذكر «من أصل 201»؛ والفاتورة رقم 7 (الترتيب 201) لا تظهر بلا بحث،
  وتظهر وحدها عند البحث بالاسم؛ والبحث برقم `1199` يصل إلى ما بعد الحدّ؛
  ورسالة عدم التطابق تظهر بلا أي بطاقة؛ ولا بقايا لسمات إخفاء DOM.
- `node --check`، `npm.cmd run check`، `git diff --check`: ناجحة. الكاش
  والأصول كما هما (v387 / tobacco-116) لأن `e50532d` لم يُنشر.

## 2026-07-26 - Claude - شاشة «الفواتير السابقة» في فاتورة المبيعات

- Status: **منجز على الفرع `claude/sales-invoice-history` فوق `a918aad`، غير
  مدموج وغير منشور.** لا كتابة في الأمين ولا Supabase ولا تعديل أسعار.

### الطلب والقرار

- طلب المالك سهم رجوع فوق شاشة فاتورة المبيعات يفتح الفواتير السابقة، واختار
  صراحةً أن المصدر هو **كل فواتير الأمين** (لا فواتير الموقع وحدها).
- المصدر: تقرير `ameen_customer_invoices` نفسه الذي تستعمله صفحة التقارير
  (آخر `periodDays`، افتراضياً 60 يوماً) — مصدر واحد فلا يختلف رقم أو مبلغ بين
  الشاشتين. لا استعلام جديد ولا تغيير صلاحيات: سياسة
  `shared_documents_staff_select` وسياسات `inventory_reports` كما هي.

### ما أُضيف (`src/app.js` فقط)

- `salesHistoryInvoices()` يسطّح فواتير كل الزبائن ويرتّبها بالتاريخ ثم الرقم
  تنازلياً، ويعلّم المرتجعات.
- `salesHistoryPanel()` يبني الشاشة: زر «↩ رجوع للفاتورة الحالية»، بحث،
  وبطاقة لكل فاتورة (الزبون، الرقم، التاريخ، الإجمالي، عدد الأصناف) مع
  `<details>` لعرض الأصناف. أحدث 150 فاتورة مع سطر صريح يذكر العدد المحجوب.
- زر التصدير يعيد استعمال **معالج `gen-invoice-doc` نفسه** المستعمل في صفحة
  التقارير بالسمات نفسها (`data-inv-number/date/customer`) — لا مسار تصدير
  ثانٍ يمكن أن يختلف عنه، ولا مساس بـ`printSalesInvoice`.
- زر «↩ الفواتير السابقة» في شريط أدوات المبيعات، و`state.salesHistoryOpen`
  يعرض الأرشيف **قبل** استدعاء `ensureSalesInvoiceNo` كي لا يُستهلك رقم لمجرد
  التصفّح. `setRoute` يغلق الأرشيف عند أي تنقّل.
- البحث يخفي الصفوف بتعديل `style.display` بلا إعادة رسم، فلا يضيع تركيز
  الكتابة (نفس علّة حقل اسم الزبون المعالجة سابقاً).

### الفحوص

- محاكاة تقتطع الدوال الفعلية من `src/app.js` وتنفّذها بتقرير وهمي: 14 فحصاً
  ناجحاً — التسطيح والترتيب (209، 207، 12، 150)، وسم المرتجع، وجود زر الرجوع،
  أربعة أزرار `gen-invoice-doc` بالسمات الصحيحة، الاسم المطبّع في
  `data-hist-row`، ولا قوالب غير مستبدلة. وثلاث حالات حدّية: غياب التقرير،
  تقرير فارغ (يعرض المدة الصحيحة)، وبيانات ناقصة/مشوّهة بلا انهيار.
- `node --check`، `npm.cmd run check`، و`git diff --check`: ناجحة.
- `CACHE_NAME=web-platform-tobacco-v387` وأصول `index.html` السبعة
  `tobacco-116` بلا بقايا. نهايات الأسطر: `index.html` CR=19 قبل وبعد
  (عُدِّل بـperl)، `src/app.js` و`public/service-worker.js` CR=0.

### حدود معروفة تُسجَّل

- الأرشيف يعرض ما وصل من مزامنة الأمين فقط؛ فاتورة أُصدرت للتوّ قد تتأخر حتى
  الدورة التالية. وفاتورة محذوفة من الأمين تختفي من الأرشيف (سلوك مقصود).
- لا تعديل ولا إعادة فتح فاتورة قديمة داخل النموذج — عرض وتصدير فقط.

## 2026-07-26 - Claude - دمج ونشر `de6ee23`، تنظيف صفوف مزايا، وتحقق المزامنة

- Status: **منجز ومتحقَّق منه فعلياً على الموقع الحيّ وفي الأمين.** لم يُعدَّل أي
  سعر، ولم يُستعمل force push.

### الدمج والنشر (تحقّق فعلي لا ادّعاء)

- دُمج الفرع `claude/fervent-northcutt-e92aad` في `main` بالكوميت `de6ee23`
  (`--no-ff -Xignore-all-space`). قبله ثُبّت على `main` عملٌ غير محفوظ لم أكتبه:
  سجل مراجعة Codex الأول + إضافة BOM لسكربتي ترقيم الفواتير (`61729a3`).
- **تعارضان حُلّا يدوياً:** `AI_HANDOFF.md` (أُبقي الجانبان معاً بلا حذف أي سجل)،
  و`public/service-worker.js` حيث كان `main` عند **v385** لأن مولّد النشرات
  يرفع الكاش تلقائياً. لذلك نُشر **v386** بدل v382 المطلوب أصلاً — النزول إلى
  v382 كان سيُبطل إبطال الكاش. أصول `index.html` السبعة بقيت `tobacco-115`.
- Actions: `Deploy TOBACCO Web` رقم 30193608185 على `de6ee23` = success.
- تحقّق حيّ من `https://fhwvtqdc2q-svg.github.io/tobacco-web`:
  `public/service-worker.js` يُرجع `web-platform-tobacco-v386`؛ `index.html`
  يحوي 7 مراجع `tobacco-115` بلا بقايا؛ و`src/app.js` المنشور يحوي
  `skippedCount`/`belowCostLine` (5 مطابقات).
- `npm.cmd run check` و`git diff --check` ناجحان قبل الدمج وبعده.

### تنظيف الصفوف المشوَّهة (بعد تأكيد النشر فقط)

- نسخة احتياطية محلية كاملة (كل الأعمدة مع `id` و`price_payload`) في
  `tools/logs/backup-mazaya-corrupted-rows-2026-07-26.json` — 7862 بايت،
  ثمانية صفوف، تحقّق آلي: كلها `item_name="معسل مزايا بولو"`، ولا يوجد 25002،
  والمعرّفات الثمانية فريدة. المجلد مُتجاهَل في Git (`.gitignore:29`).
- الحذف تمّ **بالمعرّفات الثمانية حصراً** مع شرطين إضافيين
  (`item_name='معسل مزايا بولو'` و`item_code <> '25002'`). أعاد `RETURNING`
  ثمانية صفوف بالضبط: 25007, 25010, 25014, 25017, 25024, 25027, 25029, 25033.
- تحقّق بعد الحذف: كل كود من التسعة صار له **صف واحد** باسمه الصحيح ومعامله
  الصحيح ومخزونه الخاص (24 للفصول الأربعة وفواكه الجنة، 6 لعلكة 1 كيلو، 12
  للبقية)، و25002 سليم كما هو. على مستوى الجدول: صف واحد فقط اسمه «معسل مزايا
  بولو»، وصفر أسماء مشتركة بين أكواد مختلفة، والمجموع 308 صفوف.

### المزامنة والتحقق في الأمين

- `tools\sync-approved-prices-to-ameen.ps1 -Apply`: سُحب 308 سعراً، وطُبّق بعد
  التجميع على **253 مادة جملة** و**244 مادة مفرق**، والحالة `PRICE-SYNC-STATUS OK`.
- الأصناف الثمانية استلمت أسعارها **كلٌّ بسعر وحدته الأولى الصحيح** في قائمة
  «جملة الجملة»: 5.875 للفصول الأربعة وفواكه الجنة، 23.5 لعلكة 1 كيلو، 11.75
  للبقية، وسعر الوحدة الثانية 141 للجميع. لم يتغيّر أي سعر عن قيمته الصحيحة
  السابقة — العطل كان يُجمّد التحديثات مستقبلاً لا يفسد الأسعار الحالية.
- **إثبات قاعدة «الصفر = غير مسعّر» في الإنتاج:** في CSV المسحوب، أحدث صف لـ
  «معسل روز مسكة» سعره 0 (11:44:39) وأقدم منه 100 (11:06:31)، وأحدث صف
  لـ«معسل الصفوة جميع نكهات» سعره 0 (4:11:03) وأقدم منه 85 (4:11:02). بعد
  المزامنة يحمل الأمين **100 و85** وصفر أسطر بسعر صفري لهما. قبل الإصلاح كان
  الصف الصفري الأحدث يفوز فيُتخطّى الصنف كلياً ويتجمّد سعره.

### ملاحظات تُسجَّل

- ملاحظة Codex غير المانعة باقية: المفتاح التابع غير القابل للحسم يُتجاوز، وصار
  عدده الآن ظاهراً في رسالة النجاح بدل التجاوز الصامت.
- فاتورة الزبون «علي الحوت/ مضايا» بمبلغ 42,074$ (رقم 209) أنشئت 22:54 وحُذفت
  23:03 من الأمين بحسب `log000` (عملية type=2 على `مبيع:209`)، ولذلك فشل زر
  «فاتورة PDF»: الحركة كانت لا تزال في تقرير الحركات بينما اختفت الفاتورة
  التفصيلية. الأمين **لا يحتفظ بنسخة من الفاتورة المحذوفة** — `log000` يسجّل
  الأثر (مَن ومتى) لا المحتوى، وجداول Archive الموجودة تخص الفوترة السعودية.
  تقارير Supabase تنظّفت تلقائياً بعدها.

## 2026-07-26 - Codex - مراجعة الشفافية وتجميع أحدث سعر موجب (`f3c74da`)

- Status: **جاهز للدمج؛ لا يوجد مانع متبقٍ في نطاق المراجعة.** روجع الكوميت
  `f3c74da3ea1466fa0192a327eb6e84c48b535ed9` على الفرع
  `claude/fervent-northcutt-e92aad` داخل worktree المحدد، مقابل أبيه المباشر
  `e92b9a8756f743805033581d85a17a37b0bfd53a`.
- نُفّذت محاكاة JavaScript ومجموعة اختبارات PowerShell ببيانات وهمية فقط.
  لم يحدث commit أو push أو merge، ولم يُعدّل أي سعر أو يُحذف أي صف من
  Supabase، ولم تُشغّل أي مزامنة، ولم تحدث كتابة في الأمين.

### الموانع

- **لا توجد موانع تمنع الدمج ضمن الشروط الخمسة المطلوبة.**

### رسالة شفافية السطر المدمج

- فرق `savePricingItem` لا يمس مقطع بناء `targetKeys` أو المطابقة أو
  `return null` أو `.filter(Boolean)` أو ترتيب `records` أو استدعاء
  `upsertApprovedPriceItems`. الإضافة كلها بعد نجاح الحفظ وتحديث الحالة.
- شُغّلت دالة `savePricingItem` الفعلية من الأب والكوميت على أربع حالات:
  مفتاحان صالحان، مفتاح صالح وآخر متجاوز، صف محفوظ بلا جرد حي، ومسار
  المفرق. في الحالات الأربع كان `JSON.stringify(records)` متطابقاً بين
  الطرفين، وبقي ترتيب المفاتيح نفسه (`a,b` في الحالة المتعددة).
- `skippedCount = targetKeys.length - records.length` صحيح لأن `records`
  ناتج `map(...).filter(Boolean)` من `targetKeys` نفسها، فلا يمكن أن يزيد
  طولها على طول المصدر أو يصبح العدد سالباً. مع مفتاحين صالحين لم يظهر
  تنبيه، ومع مفتاح صالح وآخر مجهول ظهرت:
  `وتُخطّي 1 مفتاح غير واضح المطابقة`. العدد يصف مفاتيح المطابقة المتجاوزة
  قبل الإرسال، ولا يدّعي أنه عدّ أخطاء Supabase.

### تنبيه تحت التكلفة

- التنبيه معلوماتي بحت. في البطاقة هو متغير markup فقط، وبعد الحفظ لا
  يُحسب إلا بعد رجوع `upsertApprovedPriceItems` بنجاح. لا يوجد منه مسار
  `throw` أو `return` أو تعديل لـ`records` أو السعر أو `pricePayload`، ولا
  مساس بسكربت المزامنة بسبب التنبيه.
- محاكاة الحفظ نفسها بلا تكلفة ومع تكلفة موجبة أعطت سجلات متطابقة حرفياً؛
  الفرق الوحيد كان لاحقة رسالة النجاح. السعر المدخل 100 بقي 100 رغم تكلفة
  كرتونة 240، وظهرت عبارة `حُفظ كما هو`.
- التكلفة لا تتسرب لغير المدير: `itemCostFor` يبدأ في
  `src/app.js:506` بـ`if (!isOwner() || !item) return null`،
  و`loadItemCosts` يفرغ `state.itemCosts` لغير المدير. لذلك كل من
  `costLine` و`belowCostLine` و`belowCostLabel` يصبح فارغاً لغير المدير
  حتى لو بقيت حالة قديمة في الذاكرة.
- التكلفة الغائبة أو الصفرية أو غير الرقمية تعطي `0` ولا تنشئ تنبيهاً.
  السعر الصفري نفسه لا يظهر كـ«تحت التكلفة» في البطاقة لأن `priced=false`؛
  ولا يغير ذلك قواعد الحفظ القائمة التي ترفض إدخال سعر غير موجب.

### تجميع أسعار PowerShell

- الهوية محفوظة من أحدث صف زمني: `$row = $ordered[0].PSObject.Copy()`.
  اختبار ثلاثة صفوف باسم واحد أعاد `item_key=id-new` ووقت أحدث صف، مع سعر
  جملة `100.5` من أحدث صف جملة موجب وسعر مفرق `150.75` من أحدث صف مفرق
  موجب مختلف. أي إن مساري الجملة والمفرق مستقلان كما هو مطلوب.
- `PSObject.Copy()` آمن هنا: مدخلات `Import-Csv` خصائصها نصوص scalar،
  والكود لا يعدّل كائناً متداخلاً. بعد تغيير حقول النسخة بقي JSON لكل
  الصفوف الأصلية مطابقاً لما قبل التجميع، كما بقيت مجموعات المواد الأخرى
  مستقلة.
- `$toNum` يستخدم `InvariantCulture` و`NumberStyles.Float`. الاختبار أعاد:
  الفراغ و`null` والنص غير الرقمي → `0`، و`11.75` → `11.75`،
  و`-2.5` → `-2.5`. لا استثناء على القيم الفارغة أو الكسور العشرية ذات
  النقطة التي ينتجها CSV.
- تحليل `updated_at` بثقافة `ar-SY` نجح مع صيغة Supabase الكاملة ذات الكسر
  والمنطقة، مثل `2026-07-25T17:51:31.072805+00:00`؛ والقيمة الفارغة تنتقل
  إلى `DateTime.MinValue` كما كان السلوك السابق.
- حالة الصف الواحد بلا انحدار: بقيت هويته وأسعار الجملة والمفرق نفسها
  (`88.25` و`99.5`). تحليل PowerShell للملف أعاد صفر أخطاء.

### السعر الصفري

- عندما كانت كل صفوف المجموعة بصفر/فراغ لم يجد التجميع
  `jumlaSource` أو `retailSource` موجباً، فبقي صف الهوية بقيم صفر.
  الشرطان القائمان `jumlaCarton -gt 0` و`retailCarton -gt 0` لم يستدعيا
  `Apply-ListPrice`، وانتهت المادة ضمن `skipped`. لذلك لا يُرسل سعر صفري
  إلى الأمين.

### ملاحظات تُسجّل ولا تمنع الدمج

- `skippedCount` يقيس مفاتيح المطابقة المتجاوزة، لا الفرق بين
  `records.length` و`saved.length`. هذا صحيح لنص الرسالة الحالي، لكنه لا
  يمثل عداداً مستقلاً لاستجابة جزئية نادرة من Supabase.
- رسالة الحفظ تعرض **قيمة التكلفة الكاملة** بين القوسين، بينما سطر البطاقة
  يعرض **مقدار الفرق تحت التكلفة**. كلاهما صحيح سياقياً، لكن توحيد الصياغة
  مستقبلاً قد يقلل الالتباس.
- التجميع الجديد لا يصلح الصفوف الثمانية المشوّهة الموجودة مسبقاً؛ ما زالت
  هويتها الأحدث باسم بولو حتى تنفيذ تنظيف البيانات المصرح به بعد النشر.
  هذا حد تشغيلي معروف وليس انحداراً في الكوميت.

### الكاش ونهايات الأسطر والفحوص

- `CACHE_NAME` ما زال حرفياً `web-platform-tobacco-v382`، و`index.html`
  يحتوي سبعة مراجع `tobacco-115` وصفر `tobacco-114`.
- blob كل من `index.html` و`src/styles.css` مطابق حرفياً بين الأب والكوميت.
  العد البايتـي لـ`index.html`: `bytes=1700`, `CRLF=19`, `CR=0`, `LF=7`.
  ولـ`styles.css`: `bytes=66425`, `CRLF=2573`, `CR=0`, `LF=873`.
  لم تتبدل نهايات الأسطر.
- `npm.cmd run check`: ناجح (`Project check passed`).
  `git diff --check e92b9a8..f3c74da`: ناجح.
  PowerShell parser: صفر أخطاء.
- كان worktree نظيفاً قبل التوثيق. التغيير الوحيد بعد المراجعة هو هذا
  السجل في `AI_HANDOFF.md`.
- Handoff UTC: 2026-07-26T01:14:52.6461105Z

## 2026-07-25 - Codex - اعتماد إغلاق مانعَي السطر المدمج (`e92b9a8`)

- Status: **جاهز للدمج؛ لا يوجد مانع متبقٍ في نطاق المراجعة.** روجع الكوميت
  `e92b9a8756f743805033581d85a17a37b0bfd53a` على الفرع
  `claude/fervent-northcutt-e92aad` داخل worktree المحدد، مقابل أبيه المباشر
  `663c993a57aaf874c0d47c82fab918590484adc9`.
- نُفّذت محاكاة مقتطعة من `savePricingItem` الفعلية ببيانات وهمية فقط. لم
  يحدث commit أو push أو merge، ولم يُعدّل أي سعر أو يُحذف أي صف من
  Supabase، ولم تُشغّل أي مزامنة، ولم تحدث كتابة في الأمين.

### الموانع

- **لا توجد موانع تمنع الدمج ضمن الشروط الستة المطلوبة.**

### المطابقة والسقوط

- المطابقة الحرفية ما زالت أولاً في `src/app.js:2317`. المطابقة بالتطبيع
  تجمع كل المرشحين في `normalizedMatches` ولا تقبل المرشح إلا إذا كان
  `length === 1` في 2318. محاكاة مفتاح يختلف بالتاء المربوطة/التطويل مع
  مرشح حي وحيد اختارت ذلك المرشح وحفظت اسمه ومعامله ومخزونه الصحيح.
- عند تصادم صنفين حيّين بعد التطبيع، وغياب مطابقة حرفية، لم يُختَر أول
  عنصر من التقرير. مع صف محفوظ للمفتاح استُعملت بيانات
  `sourceExisting` حرفياً: الاسم المحفوظ، الوحدتان، المعامل 24، المخزون
  47، والحالة `low`؛ ثم حُدّث السعر المدخل. ترتيب الصنفين الحيين لم يعد
  مؤثراً في النتيجة.
- سقوط المفتاح الأساسي إلى `latestItem` باقٍ في 2319 ومحصور بشرط
  `targetKey === itemKey`. جرى اختبار حالة قابلة للوصول يكون فيها المفتاح
  الأساسي alias محفوظاً ضمن `targetKeys` ولا يطابق الجرد حرفياً أو
  بالتطبيع؛ أخذ `latestItem` الصحيح وحفظ معامله ومخزونه.

### `return null` و`filter(Boolean)`

- **الصنف الأساسي الجديد الذي يُسعّر لأول مرة لا يسقط.** عندما
  `sourceKeys=[]` يصبح `requestedKeys=[itemKey]`؛ المطابقة الحرفية أخذت
  الصنف الحي وحُفظ سجل واحد بالاسم الصحيح، معامل 24، مخزون 30، وسعر جملة
  144/سعر وحدة أولى 6.
- **الصف المحفوظ الغائب عن الجرد الحي لا يسقط.** مفتاح تابع بلا
  `sourceItem` ومعه `sourceExisting` بقي في `records` وحافظ على اسمه
  ووحدتيه ومعامله 24 ومخزونه 47 وحالته `low`، مع تحديث السعر.
- تحليل مصادر `targetKeys` يؤكد أن الإسقاط لا يصيب مفتاحاً مشروعاً:
  `requestedKeys` الأساسية مصدرها عناصر الجرد عند بناء النموذج، والمفتاح
  الأساسي مستثنى صراحة، و`aliasKeys` تأتي من
  `state.approvedPriceItems` ولذلك لها `sourceExisting`. الذي يرجع `null`
  هو فقط مفتاح تابع فقد الجرد ولا يملك صفاً محفوظاً، أي لا توجد بيانات
  موثوقة تسمح بإنشاء سجله.
- خطأ خلو السجلات لا يمنع حفظاً مشروعاً: الصنف الأساسي الجديد ينتج سجلاً،
  والصف المحفوظ بلا جرد ينتج سجلاً. المحاكاة لم تصل إلى الخطأ إلا عندما
  كانت كل المفاتيح تابعة ومفقودة من الجرد والأسعار المحفوظة؛ عندها كان
  `upsert` صفراً وظهرت الرسالة الصريحة المطلوبة.

### أسعار الجملة والمفرق

- مسار المفرق لم يتغير عن الأب في حساب `sourceUnit2Price` و
  `sourceSalePrice` وبناء `sourcePayload`. صف بسعر جملة 120، سعر وحدة أولى
  10، وسعر مفرق قديم 90، ثم إدخال مفرق 150 أعطى
  `unit2Price=120`, `salePrice=10`, و
  `pricePayload.retail.price=150`. أي إن السعر المدخل الجديد لم يتجمّد
  بسبب `sourceExisting`، بينما بقي سعر الجملة مستقلاً كما تقضي القاعدة.
- في وضع الجملة، صف محفوظ بلا جرد بسعر قديم 120 ومعامل 24 ثم إدخال 144
  أعطى `unit2Price=144` و`salePrice=6`. لذلك
  `sourceExisting` لا يجمّد سعر الجملة القديم أيضاً.

### ملاحظة تُسجّل ولا تمنع الدمج

- إذا احتوى السطر المدمج على مفتاح تابع غير قابل للحسم، مع وجود مفاتيح
  أخرى صالحة، يسقط المفتاح المجهول بصمت وتنجح بقية السجلات. هذا هو السلوك
  الآمن للبيانات ولا يسقط مفتاحاً يملك مصدراً موثوقاً، لكنه لا يعرض اسم
  المفتاح المتجاوز للمستخدم. يمكن مستقبلاً إضافة تحذير/عداد للمفاتيح
  المتجاوزة لتحسين الرصد، ولا يلزم ذلك لإغلاق مانع الفساد الحالي.

### الكاش والأصول ونهايات الأسطر والفحوص

- `CACHE_NAME` ما زال حرفياً `web-platform-tobacco-v382`، و`index.html`
  يحتوي سبعة مراجع `tobacco-115` وصفر `tobacco-114`.
- لم يتغير blob كل من `index.html` و`public/service-worker.js` إطلاقاً بين
  `663c993` و`e92b9a8`. عدم رفع النسخة ثانيةً سليم لأن الأب غير موجود في
  `main` ولا `origin/main` محلياً، والكوميت الحالي يكمل إصلاحه قبل نشر
  الحزمة `v382/tobacco-115`.
- فحص بايتات `index.html` متطابق في الطرفين:
  `bytes=1700`, `CRLF=19`, `CR=0`, `LF=7`. لم تتبدّل نهايات الأسطر.
- `npm.cmd run check`: ناجح (`Project check passed`).
  `git diff --check 663c993..e92b9a8`: ناجح.
- كان worktree نظيفاً قبل التوثيق. التغيير الوحيد بعد المراجعة هو هذا
  السجل في `AI_HANDOFF.md`.
- Handoff UTC: 2026-07-25T19:42:52.7182263Z

## 2026-07-25 - Claude - شفافية السطر المدمج، تنبيه تحت التكلفة، والصفر = غير مسعّر

- Status: **منجز على الفرع `claude/fervent-northcutt-e92aad` فوق `e92b9a8`،
  ينتظر مراجعة Codex قبل الدمج.** لم يُعدَّل أي سعر، ولم يُحذف أي صف، ولم
  تُشغَّل أي مزامنة، ولا كتابة في الأمين.

### ١) شفافية حفظ السطر المدمج (`src/app.js`)

- رسالة النجاح صارت تذكر عدد المفاتيح المتخطّاة:
  «… — وتُخطّي N مفاتيح غير واضحة المطابقة». العدد =
  `targetKeys.length - records.length`. **لا تغيير في منطق الحفظ** المعتمد في
  `e92b9a8`: نفس المطابقة، ونفس شرط التخطي، ونفس السجلات المكتوبة.

### ٢) تنبيه معلوماتي لا مانع عند البيع تحت التكلفة (`src/app.js`)

- البيع تحت التكلفة مسموح ومقصود أحياناً (تصفية صلاحية مثلاً)، فالتنبيه
  **إعلامي فقط**: لا يمنع الحفظ ولا المزامنة ولا يغيّر أي سعر.
- في بطاقة التسعير: سطر أحمر «ℹ️ سعر الجملة/المفرق تحت التكلفة بـ X$ لل…»
  يظهر عندما يكون السعر المعروض أقل من التكلفة. بلا تعديل على
  `src/styles.css` (تنسيق مضمّن بـ`var(--danger)`) لأن نهايات أسطره مختلطة.
- عند الحفظ: تُلحق برسالة النجاح «· ℹ️ تحت التكلفة (X$ لل…) — حُفظ كما هو».
- التكلفة تبقى محصورة بالمدير كما هي (`itemCostFor` → RLS `is_owner`)، فلا
  تظهر لأي موظف آخر.

### ٣) سعر الجملة الصفري = «غير مسعّر» (`tools/apply-approved-prices-to-ameen.ps1`)

- كان تجميع الأسعار يأخذ الصف الأحدث فقط؛ فإن كان أحدث صف بسعر صفر (حالة
  المفاتيح المكررة بعد التطبيع) حجب السعر الحقيقي الأقدم فلم يصل الأمين
  شيء — وهذا واقع `معسل روز مسكة` (0 مقابل 100) و`معسل الصفوة` (0 مقابل 85).
- الآن: هوية الصف من الأحدث، وكل سعر يُؤخذ من **أحدث صف يحمل قيمة موجبة له**
  (الجملة والمفرق كلٌّ على حدة). إن كانت كل الصفوف صفراً يبقى الصنف غير
  مسعّر ولا يُرسل إلى الأمين (شرط `-gt 0` القائم).
- في الموقع بطاقة الجملة تعرض أصلاً «غير مسعر» عند سعر صفر — لم يُغيَّر
  `hasApprovedPrice` عمداً لأن سعر المفرق مستقل ويجوز مع جملة صفر.

### الفحوص

- اختبار PowerShell معزول يقتطع مقطع التجميع الفعلي من السكربت وينفّذه على
  بيانات وهمية — أربع حالات ناجحة: الصفر لا يحجب سعراً أقدم، والأحدث الموجب
  يفوز كالمعتاد (لا انحدار)، ومفرق صفر لا يحجب مفرقاً أقدم، وكل الصفوف صفر
  تبقى غير مسعّرة.
- محاكاة السطر المدمج (ثلاثة سيناريوهات) ما زالت ناجحة بالكامل — لا انحدار.
- `npm.cmd run check` ناجح، `git diff --check` ناجح، وتحليل السكربت
  بـPowerShell ناجح.
- `CACHE_NAME` يبقى `web-platform-tobacco-v382` وأصول `tobacco-115` (لم يُنشر
  شيء بعد). نهايات الأسطر: `index.html` CR=19، `src/app.js` CR=0،
  `tools/apply-approved-prices-to-ameen.ps1` CR=0.

## 2026-07-25 - Claude - إغلاق مانعَي مراجعة السطر المدمج

- Status: **منجز على الفرع `claude/fervent-northcutt-e92aad` فوق `663c993`،
  غير مدموج وغير منشور.** لا حذف ولا تعديل أسعار ولا مزامنة ولا كتابة في
  الأمين أو Supabase.

### المانع الأول — تصادم التطبيع

- المطابقة بالتطبيع صارت تُقبل **فقط إذا كان المرشح وحيداً**. عند وجود أكثر
  من صنف حيّ يتطابق بعد التطبيع لا يُختار أيّهما، ويُعتمد الصف المحفوظ
  (`sourceExisting`) — انسجاماً مع قاعدة رفض التصادمات غير المحسومة في
  `tools/pull-item-numbers.ps1` (سجل 2026-07-23).

### المانع الثاني — غياب المصدرين معاً

- مفتاح تابع لا يوجد في الجرد الحي ولا في الأسعار المحفوظة **لا يُنشأ له صف
  إطلاقاً** (`return null` ثم `.filter(Boolean)`)، بدل كتابة اسم السطر
  المدمج ووحداته ومعامله بمخزون صفر. المفتاح الأساسي (`targetKey === itemKey`)
  مستثنى لأنه الصنف المقصود بالتسعير فعلاً.
- إن خلت القائمة من كل صف يُرمى خطأ صريح: «لم يُعثر على الصنف في الجرد الحي
  ولا في الأسعار المحفوظة» بدل حفظ صامت بلا سجلات.

### الفحوص

- المحاكاة تقتطع نص المقطع الفعلي وتنفّذه بثلاثة سيناريوهات على ثلاث نسخ:
  `6c2b383` (خمسة إخفاقات)، `663c993` (ثلاثة)، وبعد الإغلاق **صفر**.
  السيناريوهات: السطر المدمج بمفاتيح تختلف بالتاء المربوطة، وتصادم تطبيع
  بين صنفين حيّين، ومفتاح تابع مجهول تماماً.
- `npm.cmd run check` ناجح، و`git diff --check` ناجح.
- لم يُرفع `CACHE_NAME` ثانيةً: يبقى `web-platform-tobacco-v382` وأصول
  `tobacco-115` لأن `663c993` لم يُنشر بينهما. نهايات الأسطر: `index.html`
  CR=19، `src/app.js` CR=0، `public/service-worker.js` CR=0.

## 2026-07-25 - Codex - مراجعة إصلاح تشويه أصناف السطر المدمج (`663c993`)

- Status: **غير جاهز للدمج — مانعان متبقيان في المطابقة بالتطبيع وحالة غياب
  المصدرين.** روجع الكوميت
  `663c993a57aaf874c0d47c82fab918590484adc9` على الفرع
  `claude/fervent-northcutt-e92aad` داخل worktree
  `tobacco-web/.claude/worktrees/fervent-northcutt-e92aad`، مقابل أبيه المباشر
  `6c2b3838a105055801466f01561fd880c344e98f`.
- المراجعة ومحاكاة `savePricingItem` كانتا معزولتين بلا أي اتصال كتابة. لم
  يحدث commit أو push أو merge، ولم يُعدّل أي سعر أو يُحذف أي صف من
  Supabase، ولم تُشغّل أي مزامنة، ولم تحدث كتابة في الأمين.

### موانع تمنع الدمج

1. **المطابقة بالتطبيع لا ترفض التصادم، وقد تربط المفتاح بصنف خاطئ.**
   المطابقة الحرفية في `src/app.js:2312` تسبق المطابقة بالتطبيع، وهذا صحيح.
   لكن 2313–2314 تستعمل `liveItems.find(...)` فتأخذ أول عنصر يطابق الاسم
   المطبّع، من دون عدّ المرشحين أو التحقق من أن المطابقة فريدة. محاكاة من
   نص الدالة الفعلي وضعت صنفين مختلفين، `صنفة` (معامل 6، مخزون 6) و`صنفه`
   (معامل 24، مخزون 24)، وهما يتطبعان إلى المفتاح نفسه. عند مفتاح تابع
   `صنـفة` لا يطابق أياً منهما حرفياً اختار الكود الصنف الأول حسب ترتيب
   التقرير، وكتب اسمه ومعامله ومخزونه؛ عكس ترتيب العنصرين يعكس النتيجة.
   هذا اختيار غير حتمي لهوية محاسبية، لا مجرد فرق عرض. يجب قبول المطابقة
   بالتطبيع فقط إذا أعادت مرشحاً واحداً، وإلا رفض الحفظ/تسجيل الغموض أو
   حسمه بمفتاح أمين فريد. المسح الحالي لـ`mt000` لم يجد تصادماً قائماً في
   لقطة اليوم، لكن الكود نفسه لا يحقق شرط الأمان المطلوب عند حدوث التصادم.

2. **صف بلا `sourceItem` وبلا `sourceExisting` ما زال يُنشأ ببيانات
   مصطنعة.** في 2318–2320 يسقط المعامل إلى `unit2Factor` الخاص بالنموذج
   المدمج، وفي 2330–2332 يسقط الاسم والوحدتان إلى بيانات النموذج المدمج،
   وفي 2337 يصبح المخزون `0` وفي 2338 تصبح الحالة حالة النموذج. محاكاة
   مفتاح تابع مفقود مع `latestItem` معاملُه 12 ومخزونه 45 أثبتت أن السقوط
   الصريح إلى `latestItem` لم يحدث، لكنها أنتجت مع ذلك:
   `itemName="السطر المدمج"`, `unit2Factor=12`, `stockQty=0`,
   `stockStatus="active"`. لا توجد حقيقة مصدرية تبرر هذه القيم للمفتاح
   التابع. الحالة ممكنة عند إرسال نموذج قديم بعد تغيّر تقرير الجرد، أو عند
   بقاء مفتاح تابع لم يعد موجوداً ولم يُسعّر سابقاً. يجب ألا يُنشأ السجل:
   إمّا رفض العملية برسالة واضحة، أو استبعاد المفتاح المفقود مع إبلاغ
   المستخدم؛ لا يجوز اختراع مخزونه أو معامله.

### ما نجح

- **شرط السقوط الصريح إلى `latestItem` أُغلق كما طُلب.** داخل بناء السجلات
  يوجد سقوط واحد فقط:
  `(targetKey === itemKey ? latestItem : null)` في 2315. مفتاح تابع غير
  مطابق أعاد `sourceItem=null` ولم يأخذ مخزون `latestItem` أو معامله.
  المانع الثاني أعلاه يخص القيم البديلة اللاحقة، لا عودة السقوط القديم
  نفسه.
- **أولوية المطابقة الحرفية محفوظة.** مع مرشح مطبّع يأتي أولاً في
  `liveItems` ومطابقة حرفية تأتي بعده، اختارت المحاكاة المطابقة الحرفية
  الصحيحة: الاسم المقصود، المعامل 24، والمخزون 24.
- **مسار المفرق لم يتراجع.** تعبيرا `sourceUnit2Price` و
  `sourceSalePrice` ومنطق `sourcePayload.retail` لم تتغير عن الأب. محاكاة
  صف مخزّن بسعر جملة 120، سعر وحدة أولى 10، وسعر مفرق قديم 90 ثم إدخال
  مفرق 150 أعطت: الجملة 120 والوحدة الأولى 10 كما كانتا، و
  `pricePayload.retail.price=150`. أي إن `sourceExisting` يحفظ سعر الجملة
  أثناء تعديل المفرق ولا يجمّد سعر المفرق القديم. وفي وضع الجملة مع
  `sourceItem` غائب و`sourceExisting` موجود، إدخال 144 استبدل الجملة القديمة
  120 وأعاد حساب الوحدة الأولى إلى 6 حسب المعامل 24، مع إبقاء الاسم
  والمخزون 47 والحالة `low`.
- **حالة غياب الجرد مع وجود صف مخزّن سليمة.** سواء في الجملة أو المفرق،
  استُعيد الاسم والوحدتان والمعامل والمخزون والحالة من `sourceExisting`
  ولم تُستبدل ببيانات السطر المدمج.

### الكاش والأصول والفحوص

- `public/service-worker.js` يحمل حرفياً
  `CACHE_NAME="web-platform-tobacco-v382"`.
- `index.html` يحتوي سبعة مراجع `tobacco-115` وصفر بقايا
  `tobacco-114`.
- فحص البايتات من Git للأب والكوميت أعطى النتيجة نفسها تماماً لـ
  `index.html`: `bytes=1700`, `CRLF=19`, `CR=0`, `LF=7`. أي إن نمط نهايات
  الأسطر لم يتبدّل.
- `npm.cmd run check`: ناجح (`Project check passed`).
  `git diff --check 6c2b383..663c993`: ناجح.
- كان worktree نظيفاً قبل هذا السجل. التغيير الوحيد بعد المراجعة هو هذا
  التوثيق في `AI_HANDOFF.md`.
- Handoff UTC: 2026-07-25T19:34:22.9606802Z

## 2026-07-25 - Claude - إصلاح تشويه أصناف السطر المدمج عند حفظ السعر

- Status: **منجز على الفرع `claude/fervent-northcutt-e92aad`، غير مدموج وغير منشور.**
  لم يُحذف أي صف من Supabase ولم يُعدَّل أي سعر ولم تُشغَّل أي مزامنة.

### العطل

- حفظ سعر «سطر مدمج» يبني سجلاً لكل صنف من أصنافه. عند فشل مطابقة مفتاح صنف
  تابع مع الجرد الحي (فروق التاء المربوطة بين مفاتيح السطر المدمج ومفاتيح
  التقرير) كان `src/app.js` يسقط على `latestItem` — أي الصنف المدمج نفسه —
  فينسخ **اسمه ووحدته ومعامله ومخزونه** فوق الصنف التابع.
- الأثر الحي: حفظ «معسل مزايا بولو» الساعة 2026-07-25 17:51 UTC شوّه ثمانية
  أصناف مزايا (25007, 25010, 25014, 25017, 25024, 25027, 25029, 25033) فصار
  في `approved_price_items` تسعة صفوف باسم «معسل مزايا بولو».
  ولأن `tools/apply-approved-prices-to-ameen.ps1` يجمع بـ`Group-Object` على
  `item_name` ويأخذ الأحدث، انهارت التسعة إلى مجموعة واحدة وتوقّفت أسعار
  ثمانية أصناف عن الوصول إلى الأمين. الأسعار كلها 141$ فلا خسارة مالية.
- راجعه Codex باستقلال واعتبر الادعاءين مانعَي دمج.

### الإصلاح (`src/app.js`، مقطع بناء السجلات في `savePricingItem`)

- المطابقة صارت: حرفية أولاً، ثم بالتطبيع، ثم — فقط لمفتاح الصنف المطلوب
  نفسه — `latestItem`. لا سقوط على الصنف المدمج لأي مفتاح تابع.
- عند غياب الصنف من الجرد الحي تُحفظ بيانات صفّه المخزّن كما هي
  (`sourceExisting`: الاسم، الوحدتان، المعامل، المخزون، الحالة) ولا يتغيّر
  إلا السعر.

### الفحوص

- محاكاة تقتطع نص المقطع الفعلي من `src/app.js` وتنفّذه بمدخلات وهمية:
  قبل الإصلاح صفّان تابعان مشوَّهان من اثنين (اسم «معسل مزايا بولو»،
  معامل 12، مخزون 45.5)؛ بعده صفر تشويه، وعاد لكل صنف اسمه ومعامله
  (6 و24) ومخزونه (12 و47) وسعر وحدته الأولى الصحيح (23.5 و5.875).
- `npm.cmd run check`: ناجح. `git diff --check`: ناجح.
- `CACHE_NAME` رُفع إلى `web-platform-tobacco-v382`، وأصول `index.html`
  السبعة إلى `tobacco-115` بلا بقايا `tobacco-114`.
- نهايات الأسطر: `index.html` CR=19 قبل وبعد، `src/app.js` CR=0،
  `public/service-worker.js` CR=0. عُدِّل `index.html` بـperl لا بأداة تحرير.

### معلّق على المالك (لم يُنفَّذ)

- حذف الصفوف الثمانية المشوَّهة من `approved_price_items` — عملية حذف
  بيانات، تنتظر موافقة صريحة. حتى تُحذف يبقى تعطّل مزامنة الأسعار قائماً
  لأن الصفوف الحالية أحدث من الصفوف السليمة.
- قرارات تسعير: نخلة صلاحية شهر 10 (325$ مقابل تكلفة 434.55$، تعرّض
  −$767)، فحم الزعيم 250غ (−$182)، ومعسل روز مسكة والصفوة بسعر جملة صفر.
## 2026-07-25 - Codex - مراجعة مستقلة لادعاءات فساد حفظ الأسعار وتطبيقها على الأمين

- Status: **غير جاهز للدمج — الادعاءان (1) و(2) مانعان مثبتان. الادعاء
  (3) صحيح كسلوك، لكنه ملاحظة تُسجّل ولا يمنع الدمج وحده من دون متطلب صريح
  يعتبر الصفر أمراً لمسح سعر الأمين.**
- المراجعة كانت قراءة فقط. لم يحدث commit أو push أو merge، ولم يُشغّل أي
  سكربت سحب/تطبيق/تحقق/مزامنة، ولم تُكتب أي قيمة في الأمين أو Supabase، ولم
  يُعدّل أي سعر. نُفّذ فقط `SELECT` محدود من `mt000` لربط الأكواد التسعة
  بأسمائها، مع تحليل الكود وملف CSV المحلي الموجود مسبقاً.

### موانع تمنع الدمج

1. **الادعاء (1) صحيح، مع قيد إثبات واضح بشأن قيمة المخزون المخزنة فعلياً.**
   في `src/app.js:2306`، إذا لم يجد `targetKey` في عناصر تقرير الجرد، يستعمل
   `latestItem` كبديل. بعد ذلك لا ينسخ السعر فقط، بل يبني سجل المفتاح الأصلي
   من الصنف البديل: الاسم في 2318، الوحدتان في 2319–2320، عامل التحويل في
   2321، والمخزون والحالة في 2325–2326. ثم يحوّل
   `src/supabase-client.js:240-268` هذه الحقول نفسها إلى أعمدة
   `item_name/unit1_name/unit2_name/unit2_factor/stock_qty/stock_status`
   ويعمل upsert على `item_key` في 755–761. لذلك ففشل المطابقة يكتب هوية
   الصنف البديل وبياناته فوق صف المفتاح الأصلي فعلاً.
   - ملف `reports/prices/tobacco-approved-prices.csv` المحلي الموجود قبل
     المراجعة يحتوي **تسعة** مفاتيح مختلفة كلها باسم
     `معسل مزايا بولو`، وبالوحدتين `كروز/شرحة` والعامل `12` والسعر `141`.
     المفاتيح هي: `مزايا برتقال بالكريمة`، `مزايا علكة 1 كيلو`،
     `مزايا فواكه الجنة 250 غ`، `معسل مزايا علكة`،
     `معسل مزايا علكة ونعنع مثلج`، `معسل مزايا بولو`,
     `معسل مزايا علكة مثلج`، `مزايا الفصول الاربعة 250 غ`،
     `مزايا قهوة بالهيل`.
   - استعلام القراءة المحدود من `mt000.Code/Name` أكد أن هذه المفاتيح
     تطابق على الترتيب مجموعة الأكواد المذكورة: 25002 = بولو،
     25007 = علكة، 25010 = الفصول الأربعة، 25014 = علكة مثلج،
     25017 = علكة ونعنع مثلج، 25024 = فواكه الجنة،
     25027 = برتقال بالكريمة، 25029 = قهوة بالهيل،
     25033 = علكة 1 كيلو. أي إن الأمين نفسه يحتفظ بتسعة أسماء مستقلة، بينما
     لقطة السعر المحلية تحمل الاسم البديل نفسه للتسعة.
   - هذا النمط، مع أزمنة تحديث متتالية بين
     `2026-07-25T17:51:14Z` و`17:51:31Z`، يطابق مسار الحفظ الجماعي والفشل
     إلى `latestItem`، وليس مجرد تشابه عرض في النشرة. ملف السحب لا يتضمن
     `stock_qty`، لذلك لم تُقرأ القيمة المخزنة فعلياً للمخزون من Supabase؛
     لكن مسار الكود الذي يكتب مخزون البديل مثبت مباشرة في 2325 ثم
     `supabase-client.js:249,255`.

2. **الادعاء (2) صحيح ويحوّل الفساد السابق إلى فقدان تطبيق أسعار فعلي.**
   `tools/apply-approved-prices-to-ameen.ps1:88-93` يجمع السجلات حسب
   `Resolve-AmeenItemName($_.item_name)`، لا حسب `item_key` أو كود الأمين،
   ويرتب كل مجموعة حسب `updated_at` تنازلياً ثم يأخذ سجلاً واحداً فقط.
   محاكاة هذا الجزء قراءةً فقط على CSV المحلي أعطت:
   `316` صفاً ← `253` مجموعة، والتسعة المذكورة ← **مجموعة واحدة** باسم
   `معسل مزايا بولو`. الفائز هو صف المفتاح `مزايا قهوة بالهيل` لأنه الأحدث
   عند `17:51:31.072805Z`، لكن السكربت يرمي مفتاحه ويستعمل
   `item_name = معسل مزايا بولو`.
   `Apply-ListPrice` يطابق `mt000.Name` فقط في الأسطر 60–75؛ لذلك يحدّث
   بطاقة بولو 25002 وحدها، ولا توجد دورة مستقلة للأسماء الثمانية الأخرى.
   النتيجة الدقيقة: ثمانية أصناف لا تستلم أسعار صفوفها من هذه الدفعة.

### ملاحظة تُسجّل ولا تمنع الدمج وحدها

- **الادعاء (3) صحيح حرفياً:** `jumlaCarton -gt 0` في 122 و
  `retailCarton -gt 0` في 128 يمنعان استدعاء `Apply-ListPrice` عندما تكون
  قيمة القائمة صفراً. إذا كان الاثنان صفراً يزيد `skipped` في 134، وإذا
  كانت الجملة صفراً والمفرق موجباً يُكتب المفرق فقط وتبقى الجملة القديمة
  في الأمين بلا تغيير، والعكس صحيح.
- لا أعدّه مانعاً مستقلاً في النطاق الحالي لأن قواعد المشروع الحالية تعامل
  سعر الجملة الصفري كـ«غير مسعّر»، وتسمح بسعر مفرق مستقل مع
  `unit2_price = 0`؛ لا يوجد متطلب موثّق يقول إن الصفر يجب أن يمسح سعراً
  موجوداً في الأمين. يصبح هذا **مانعاً** فوراً إذا كان معنى الصفر المطلوب
  هو «صفّر/امسح السعر في قائمة الأمين»، لأن التطبيق الحالي لا يحقق ذلك،
  و`tools/verify-prices.ps1:112,123` يتجاهل الصفر أيضاً فلا يكشف بقاء السعر
  القديم.

### حدود المراجعة وحالة الشجرة

- لم يُنفّذ `npm.cmd run check` لأن المهمة مراجعة بلا تعديل كود، ولأن الفحص
  العام لا يثبت السلوكين المحاسبيين أعلاه. استُخدمت محاكاة PowerShell
  معزولة لتجميع CSV فقط، بلا اتصال كتابة.
- التغييران السابقان في `tools/push-invoice-series.ps1` و
  `tools/register-invoice-series-task.ps1` (BOM في أول الملف) كانا موجودين
  قبل المراجعة ولم يُلمسا. التغيير الوحيد لهذه المهمة هو هذا السجل في
  `AI_HANDOFF.md`.
- Handoff UTC: 2026-07-25T19:24:59.1222149Z

## 2026-07-25 - Codex - اعتماد إغلاق موانع حفظ ترقيم الأمين (`8f6492e`)

- Status: **جاهز للدمج؛ لا يوجد مانع متبقٍ في نطاق المراجعة.** روجع الكوميت
  `8f6492e9a8ff8238d513714d20f6e9905b78764a` المطابق حرفياً لـ
  `origin/feat/ameen-invoice-series`، فوق أبيه المباشر
  `58271b8be9fe43f3af035af327765500326bf0ef`. نُفّذت محاكاة مستقلة لدالة
  `salesSaveInvoice` الفعلية بوعود مؤجلة وعدادات كتابة وهمية فقط. لم يحدث
  commit/push/merge، ولا كتابة في الأمين أو Supabase، ولا لمس أسعار.

### الموانع التي كانت تمنع الدمج

- **أُغلق مانع الحفظ المتزامن.** صار فحص `state.salesSaving` أول المسار،
  ويُرفع القفل ويُعطّل زر الحفظ قبل أول `await`. محاكاة عملية واحدة مع نقرة
  ثانية أثناء `refreshInvoiceSeries` ونقرة ثالثة أثناء
  `createSharedDocument` أعطت:
  `fetches=1`, `writes=1`, `docNos=["205"]`. بقي
  `salesSaving=true` والزر معطلاً في المرحلتين، ثم عادا
  `false/false`. ثلاث نقرات متزامنة مستقلة أعطت أيضاً جلباً واحداً وكتابة
  واحدة للرقم `205`.
- **أُغلق مانع تبديل الوضع أثناء الجلب.** بدأت المحاكاة بوضع الجملة ثم
  استُدعي `salesSetMode("mufrak")` قبل تحرير Promise الجلب. النتيجة:
  `writes=0`, `jumlaSeq=null`, `mufrakSeq=null`، وبقي الرقم `202` بلا
  استهلاك، وظهرت رسالة الإلغاء المخصصة. مرّ الخروج عبر `finally` فعاد القفل
  والزر `false/false`.
- إعادة اختبار التبديل أثناء **الكتابة** بقيت سليمة: المستند المبني قبل
  `await createSharedDocument` بقي
  `{no:"205", mode:"jumla", item.price:100}`، ثم حُجز
  `jumlaSeq=205` فقط وبقي `mufrakSeq=null`. الاستدعاء الفعلي ما زال
  `salesReserveInvoiceNo(doc.no, doc.mode)`.

### تدقيق اللقطة عبر نقاط الانتظار

- قبل جلب السلسلة توجد قراءة تحقق أولية لـ`salesResolvedRows` ولقطة واحدة
  لـ`salesCurrentMode`. بعد الجلب يُقارن الوضع الحالي باللقطة، ثم تُعاد قراءة
  `salesResolvedRows` و`salesTotals` وتُبنى نسخة `doc` كاملة قبل آخر
  `await`.
- بعد `await dataStore.createSharedDocument(doc)` يوجد **صفر** قراءة لـ
  `salesRows`، وصفر `salesCurrentMode()`، وصفر `salesTotals()`. الشيء الوحيد
  الذي يعبر آخر `await` هو المستند المبني نفسه؛ وبعد النجاح يُستعمل
  `doc.no/doc.mode` للحجز. تغيير الأسطر أثناء الجلب إلى حالة غير صالحة اختُبر
  وألغى العملية بصفر كتابة.

### القفل والزر في مسارات الخروج والفشل

- جرى فحص: النجاح، تقرير جلب قديم، تبديل الوضع، إبطال الأسطر أثناء الجلب،
  استثناء في حساب المجاميع، استثناء من `createSharedDocument`، وفشل شبكة
  الجلب مع كاش حديث. في جميع المسارات التي رفعت القفل كانت النتيجة النهائية
  `state.salesSaving=false` و`saveBtn.disabled=false`.
- فشل الكتابة أعطى `writes=0` ورسالة
  `تعذّر حفظ الفاتورة: write failed` ثم حرّر القفل والزر. استثناء منتصف
  المسار أعطى النتيجة نفسها. مسارا «لا أسطر صالحة» و«الفاتورة محفوظة
  مسبقاً» يخرجان قبل رفع القفل أصلاً، فلا يتركان شيئاً معلّقاً.
- فشل شبكة الجلب بقي best-effort كما صُمّم: `refreshInvoiceSeries` لا يرمي
  ولا يمسح الكاش؛ مع كاش عمره دقيقة اكتمل حفظ واحد ثم تحرر القفل والزر.

### انحدار المانعين الأول والثاني

- «كاش قديم `nextNo=202` + جلب طازج `nextNo=205`» أعطى كتابة واحدة:
  `doc.no="205"`, `doc.mode="jumla"`, `jumlaSeq=205`.
- حين كان التقرير **الراجع من الجلب نفسه** بعمر 16 دقيقة كانت النتيجة
  `writes=0` ورسالة خطأ، ثم `salesSaving=false` والزر غير معطّل.
- `doc.mode` ما زال يصل صراحةً إلى `salesReserveInvoiceNo`، فلا توجد قراءة
  للوضع الحالي بعد كتابة المستند.

### الطباعة ونطاق الانحدار

- `printSalesInvoice` مطابق byte-for-byte للأب المباشر؛ SHA-256 للمقطع
  `3bafde8ec646ea33f4cfe03a9eac6602a17ccf5272c5596045f56195c459c9f2`.
  لا تغيير في قرار عدم إعادة الجلب داخل الطباعة ولا في iframe أو القالب.
- بعد حذف مقطع `salesSaveInvoice` من الطرفين صار باقي `src/app.js` مطابقاً
  byte-for-byte. أي أن إعادة الهيكلة لم تغيّر صفحة أو مستمعاً أو مساراً آخر.
  بقية فرق الكوميت محصور برفع نسخ الأصول والكاش.

### ملاحظات تُسجّل ولا تمنع الدمج

- ملاحظة عتبة 15 دقيقة السابقة باقية كما هي: مناسبة تشغيلياً لمهمة كل
  5 دقائق، لكنها ليست حجز تفرد لحظياً؛ الضمان الصارم يحتاج حجزاً ذرياً أو
  قراءة مباشرة. لا يضيف `8f6492e` مخاطرة جديدة في هذا الجانب.
- عناصر النموذج الأخرى لا تُعطّل أثناء الحفظ، لكن أي نقرة حفظ جديدة—حتى لو
  أعاد `render()` إنشاء الزر—تُرفض بحارس الحالة قبل أي قراءة أو جلب. تعديل
  الأسطر أثناء الجلب يُعاد التقاطه بعد الجلب، وتبديل الوضع يلغي العملية.

### الكاش والفحوص والحدود

- `CACHE_NAME="web-platform-tobacco-v381"` صحيح. الأصول السبعة المرقمة في
  `index.html` كلها `tobacco-114`، وصفر بقايا `tobacco-113`.
- `npm.cmd run check`: ناجح (`Project check passed`).
  `git diff --check` للشجرة قبل هذا السجل ولفرق
  `8f6492e^..8f6492e`: ناجحان.
- نهايات الأسطر قبل هذا السجل:
  `src/app.js CR=0 LF=7729`، `src/styles.css CR=2573 LF=3446`،
  `AI_HANDOFF.md CR=0 LF=1607`، `public/service-worker.js CR=0 LF=62`،
  و`index.html CR=19 LF=26` بالنمط المختلط السابق.
- نطاق كوميت الإغلاق ثلاثة ملفات فقط: `src/app.js`, `index.html`,
  `public/service-worker.js`. التغيير الوحيد بعد المراجعة هو هذا السجل غير
  المثبّت في `AI_HANDOFF.md` داخل worktree الفرع المحدد.
- Handoff UTC: 2026-07-25T18:43:39.7089444Z

## 2026-07-25 - Codex - إعادة مراجعة ترقيم الأمين (`678b697`)

- Status: **غير جاهز للدمج — المانعان السابقان أُغلقا، لكن ظهر مانعان جديدان
  في نافذة الجلب المضافة قبل الحفظ.** روجع الكوميت
  `678b69746664b3ad09e6cbbd26786f26f68df62d` المطابق حرفياً لـ
  `origin/feat/ameen-invoice-series`، مع إعادة محاكاة كود `src/app.js` الفعلي
  في بيئة معزولة وعدادات كتابة وهمية فقط. لم يحدث commit/push/merge، ولا كتابة
  في الأمين أو Supabase، ولا لمس أسعار.

### موانع تمنع الدمج

1. **الحماية من الحفظ المزدوج صارت متأخرة عن أول `await`.** يفحص
   `state.salesSaving` عند السطر 5983، ثم ينتظر `refreshInvoiceSeries()` عند
   5993، ولا يضبط `salesSaving=true` أو يعطّل زر الحفظ حتى 6049–6051. ضغطتان
   أثناء انتظار الجلب دخلتا المسار معاً؛ وبعد تحرير الجلب نفذتا
   `createSharedDocument` مرتين وحفظتا مستندين بالرقم نفسه `205`
   (`fetch=2`, `writes=2`, `docNos=["205","205"]`, `uniqueNos=1`). هذا يعيد
   بالضبط التكرار الذي تقول تعليقات 5981–5982 إن الحارس يمنعه. يجب أن يشمل
   القفل كامل العملية ابتداءً من قبل جلب السلسلة، مع تحريره في `finally`
   لجميع مسارات المنع والفشل.
2. **تبديل الوضع أثناء انتظار جلب السلسلة يخلط وضع المستند بأسعاره.** يُثبّت
   `mode="jumla"` قبل الجلب، لكن `resolved` يحتفظ بمراجع أسطر الحالة، ثم
   `salesSetMode("mufrak")` أثناء `await` يعيد تسعير تلك الأسطر. بعد وصول
   الجلب بُني المستند من الوضع المثبّت والأسطر المتحولة: المحاكاة أعطت
   `{no:"205", mode:"jumla", cur:"$", item.price:500000}`؛ أي سعر مفرق
   سوري داخل فاتورة جملة بالدولار، وحدثت كتابة واحدة. لا توجد قراءة
   `salesCurrentMode()` تنفيذية بعد `await` داخل دالة الحفظ، لكن هذا لا يكفي
   لأن البيانات المقروءة بعده قابلة للتغيير. يلزم منع تبديل الوضع طوال
   العملية أو أخذ لقطة متسقة للوضع والأسطر بعد الجلب وقبل أي `await` تالٍ.

### إغلاق المانعين السابقين

- صار `refreshInvoiceSeries()` يُستدعى مرة واحدة في كل محاولة حفظ صالحة تتجاوز
  حراس الإدخال/التكرار. حالة «كاش قديم `nextNo=202` + جلب طازج
  `nextNo=205`» حفظت مستنداً واحداً بالرقم `205` وحجزت عداد الجملة `205`.
  أما حين كانت القراءة الراجعة من الجلب نفسها بعمر 16 دقيقة فكان
  `writes=0` ورسالة منع، وحين غاب `summary.syncedAt/created_at` كان
  `writes=0` أيضاً. أي إن عتبة `SALES_SERIES_MAX_AGE_MS` تُطبّق على التقرير
  الذي استبدل الحالة بعد الجلب، لا على الكاش القديم.
- إعادة المحاكاة السابقة حرفياً أثناء انتظار
  `createSharedDocument(doc)` نجحت: المستند بقي
  `{no:"205", mode:"jumla", item.price:100}` بعد التبديل إلى المفرق،
  واستُدعي `salesReserveInvoiceNo(doc.no, doc.mode)`. النتيجة:
  `jumlaSeq=205`, `mufrakSeq=null`, `jumlaNext=206`. كذلك `doc.no` يأتي
  من `state.salesInvoiceNo` لا من `ensureSalesInvoiceNo()`.
- البحث الساكن داخل `salesSaveInvoice` أعطى استدعاءً واحداً فقط لـ
  `refreshInvoiceSeries()` وصفر استدعاءات تنفيذية لـ`salesCurrentMode()`
  بعد `await refreshInvoiceSeries()`. القراءة الوحيدة للوضع في مسار الحفظ
  عند 5989 قبل أول `await`.

### الطباعة، الفشل، والعتبة

- الطباعة لا تعيد الجلب عمداً: صفر `refreshInvoiceSeries()` داخل
  `printSalesInvoice`، فتحافظ على استدعاء الطباعة ضمن إيماءة iOS. التقرير
  القديم يُمنع عند 6084–6088 قبل `ensureSalesInvoiceNo` وقبل
  `printHtmlDocument`; المحاكاة أعطت `fetch=0`, `printCalls=0` وصفر iframe
  منشأ، فلا يترك مسار المنع إطاراً معلقاً.
- فشل شبكة `getInvoiceSeriesReport()` لم يرمِ ولم يمسح القراءة السابقة؛ بقي
  مرجع التقرير نفسه في الحالة. وإذا كانت القراءة المحفوظة ما زالت ضمن العتبة
  يسمح بها التصميم الحالي، أما إذا تجاوزتها فيمنعها فحص العمر.
- **ملاحظة تُسجّل ولا تمنع الدمج وحدها:** عتبة 15 دقيقة منطقية كحارس
  تشغيل لمهمة كل 5 دقائق لأنها تعني فوات ثلاث دورات كاملة وتتفادى منعاً بسبب
  تأخير عابر. لكنها ليست ضمان تفرد لحظياً: قد تبقى قراءة عمرها 14 دقيقة
  «صالحة» رغم صدور فاتورة في الأمين خلالها. تقليلها إلى 10 دقائق أكثر تحفظاً،
  أما الضمان الصارم فيحتاج حجزاً ذرياً/قراءة مباشرة لا مجرد timestamp.

### الكاش والفحوص والحدود

- `CACHE_NAME="web-platform-tobacco-v380"` صحيح، والأصول السبعة المرقمة في
  `index.html` كلها `tobacco-113` بلا بقايا `tobacco-112`.
- `npm.cmd run check` على worktree detached للكوميت نفسه ناجح
  (`Project check passed`). و`git diff --check c8133be..678b697` ناجح.
- نهايات الأسطر المطلوبة مطابقة: `src/app.js CR=0 LF=7715` و
  `src/styles.css CR=2573 LF=3446`. كذلك
  `public/service-worker.js CR=0 LF=62`، و`index.html CR=19 LF=26`
  (النمط المختلط السابق).
- نطاق كوميت الإغلاق فوق `c8133be` ثلاثة ملفات فقط: `src/app.js`,
  `index.html`, `public/service-worker.js`. التغيير الوحيد في شجرة العمل
  الأصلية بعد المراجعة هو هذا السجل غير المثبّت في `AI_HANDOFF.md`.
- Handoff UTC: 2026-07-25T18:30:09.9946821Z


## 2026-07-25 - Codex - مراجعة ترقيم فواتير الموقع من سلاسل الأمين (`77c7d12`)

- Status: **مانعان يمنعان الدمج.** روجع الكوميت
  `77c7d128bdd000ab8a85106d3fde471004b39bc2` وحده فوق أبيه المباشر
  `fd0190327887d18f3f3474efb8b16b27b3eb8040`، وهو مطابق لـ
  `origin/feat/ameen-invoice-series`. لم يحدث commit/push/merge، ولا كتابة
  في الأمين أو Supabase، ولا لمس أسعار.

### موانع تمنع الدمج

1. **التقرير القديم لا يوقف الإصدار، والأرقام المعروضة الآن مصطدمة فعلياً
   بأرقام الأمين.** أحدث `ameen_invoice_series` في Supabase منشأ عند
   `2026-07-25T14:14:27Z` ويحمل: مبيعات `lastNo=201/nextNo=202` ومبيعات
   مركز `lastNo=600/nextNo=601`. القراءة الحية المستقلة من `AmnDb002`
   عند نحو `17:51Z` أعطت مبيعات `204` ومبيعات مركز `611`؛ أي إن `202`
   و`601` اللذين ستقترحهما الواجهة مستعملان بالفعل. السبب في الكود:
   `salesInvoiceNoHint()` يضيف تحذيراً بعد 20 دقيقة فقط، بينما
   `peekSalesInvoiceNumber()` لا يفحص `syncedAt/created_at` إطلاقاً،
   والحفظ والطباعة يمنعان عند غياب السلسلة فقط لا عند قدمها. يلزم اعتبار
   التقرير المتجاوز لعتبة آمنة غير صالح ومنع الحفظ والطباعة، مع التأكد من
   تثبيت/مراقبة المهمة المجدولة.
2. **تبديل الوضع أثناء انتظار الحفظ يسرّب الحجز إلى عدّاد السلسلة الأخرى.**
   بعد إنشاء `doc` بوضع الجملة، ينفذ الكود
   `await dataStore.createSharedDocument(doc)` ثم يستدعي
   `salesReserveInvoiceNo(doc.no)` بلا تمرير `mode`. إن بدّل المستخدم إلى
   المفرق أثناء الانتظار، تستعمل الدالة الوضع الحالي. المحاكاة الفعلية:
   المستند المحفوظ `{no:"205", mode:"jumla"}`، ثم
   `jumlaSeq=null` و`mufrakSeq=205` و`jumlaNext=205`؛ أي يعود رقم الجملة
   نفسه للفـاتورة التالية. يلزم الحجز بـ
   `salesReserveInvoiceNo(doc.no, mode)` (ويُفضّل تعطيل تبديل الوضع أثناء
   الحفظ أيضاً).

### ما نجح

- `push-invoice-series.ps1 -Discover` نفذ قراءة فقط وأعاد ست سلاسل. نص SQL
  لا يحوي أي `INSERT/UPDATE/DELETE` على الأمين؛ عمليات `POST/DELETE` فيه
  تخص `inventory_reports` بعد إغلاق اتصال SQL. تحليل PowerShell للسكريبتين
  أعاد صفر أخطاء.
- نتيجة السكربت الحية: مبيعات آخرها `204` (203 فاتورة)، ومبيعات مركز آخرها
  `611` (609 فواتير). استعلام مستقل بصياغة مختلفة مباشرة من `bt000/bu000`
  أعاد الأرقام والأعداد والتواريخ نفسها والمعرّفين المثبتين في الواجهة.
- الاستعلام يجمع القاعدة الحالية كاملة بلا مرشح تاريخ، ولذلك لا يقتصر على
  سنة تقويمية داخل الملف بعد التدوير. `MAX(TRY_CAST(... AS int))` يحمي
  الترتيب الرقمي لو كان العمود نصياً؛ العمود الحي حالياً `int`.
- المطابقة بالـGUID نجحت، والاحتياط بالاسم يستعمل مساواة بعد التطبيع لا
  بادئة/احتواء. محاكاة `مبيعات` و`مبيعات مركز` و`مبيعات ل.س` أبقتها ثلاث
  قيم منفصلة؛ الجملة التقطت `مبيعات` والمفرق التقط `مبيعات مركز`.
- عند غياب التقرير أعاد الرقم `""`، ومنعت محاكاة الحفظ إنشاء أي مستند
  (`createSharedDocument=0`) ومنعت الطباعة (`printHtmlDocument=0`). لا
  مستند برقم فارغ.
- في المسار العادي: الجملة `205` والمفرق `612`، والعودة للجملة أعادت
  `205`. حجز `205` رفع الجملة إلى `206`، ومحاولة حجز رقم أدنى لم تنقصها،
  ولم يتغير المفرق. تحديث التقرير من `nextNo=205` إلى `206` بين العرض
  والحفظ جعل المستند يُحفظ بالرقم `206`، أي إن الحسم عند الحفظ يعمل.
- حذف التقارير القديمة مقيّد في عنوان الطلب بشرطَي
  `source=eq.ameen_invoice_series` و`created_at=lt...`، فلا يمس أي
  `source` آخر.
- فحص حي لـRLS: `inventory_reports` عليه RLS، والسياسات الأربع كلها
  `authenticated + is_staff()` (`SELECT/DELETE using`،
  `INSERT with_check`، و`UPDATE` بكليهما). طلب `anon` رأى صفراً، وحساب
  المزامنة سجّل الدخول ونجح في القراءة؛ وبما أن شروط الكتابة هي
  `is_staff()` نفسها فالسكريبت مخوّل. لا سياسة جديدة ولا تسريب جديد في
  فرق الكوميت. هذا يوافق مبدأ Supabase بأن جداول `public` المكشوفة تحتاج
  RLS وسياسات أدوار صريحة.
- عند `390×844`: الصفحة `scrollWidth=clientWidth=390`؛ التمرير بقي داخل
  غلاف الجدول (`700/328`) ولم يظهر تمرير أفقي للصفحة. عند `1440×900`:
  `scrollWidth=clientWidth=1440`. الفحص البصري في المقاسين سليم.
- بعد حذف service workers والكاش وإعادة التحميل كان مفتاح الكاش الوحيد
  `web-platform-tobacco-v379`، وكل الأصول السبعة المرقمة في `index.html`
  حملت `tobacco-112`.
- `npm.cmd run check`: ناجح (`Project check passed`). و`git diff --check`
  لفرق الكوميت وللشجرة: ناجحان.
- نهايات الأسطر لم تتراجع: `src/app.js CR=0`، `src/supabase-client.js CR=0`،
  `public/service-worker.js CR=0`، والسكريبتان الجديدان `CR=0`.
  `styles.css CR=2573` في `main` والأب والكوميت، وفرقها `+8/-0` فقط.
  `index.html CR=19/LF=26` مختلط مسبقاً وبالأعداد نفسها في الأب والكوميت.
- Boundaries: التغيير الوحيد بعد المراجعة هو هذا السجل غير المثبّت في
  `AI_HANDOFF.md`.
- Handoff UTC: 2026-07-25T17:59:34.2115890Z

## 2026-07-25 - Codex - مراجعة اقتراح اسم الزبون في فاتورة المبيعات (`713b8c0`)

- Status: **جاهز للدمج؛ لا يوجد مانع.** روجع الكوميت
  `713b8c0ed9d7e6e424f5445a024b73fa36e56ca1` وحده فوق الأب المباشر
  `f42691a74c7fff8ce556720cbb18d8c550884192` كما طُلب، وهو مطابق لـ
  `origin/fix/sales-customer-suggest`. لم يحدث commit/push/merge أو تعديل
  كود أو كتابة قاعدة أو لمس أسعار/مزامنة.

### المصدر وبنية القائمة

- فرق الكوميت ثلاثة ملفات فقط: `src/app.js` و`index.html` و
  `public/service-worker.js`. الأسطر المضافة في `app.js` تحوي
  `latestCustomerBalanceItems()` فقط، وصفر `fetch()` وصفر `dataStore.*`.
- `latestCustomerBalanceItems()` تقرأ حصراً
  `state.customerBalanceReports[0].items` ثم تطبق حدود الائتمان المحمّلة؛
  وهو المسار نفسه الذي كان `salesCustomerPanel()` يستعمله مسبقاً عبر
  `findBalanceCustomerByText()`. لا loader جديد ولا استدعاء شبكة جديد.
  اختبار المتصفح مع حجب HTTPS كله سجّل طلباً ديناميكياً محلياً وحيداً لملف
  سعر الصرف، وصفر طلب قاعدة.
- في DOM الفعلي: `#sales-customer-list` عدده واحد، ومرجعه في حقل
  `#sales-customer` صحيح، وهو خارج `[data-sales-cust-host]`. بعد `render()`
  مرتين بقي العدد واحد. تبديل الصفحات أعطى قوائم منفصلة:
  `sales-customer-list` للمبيعات، `report-customer-list` للتقارير،
  و`po-items-list` للمشتريات؛ لا تعارض IDs ولا تكرار في الصفحة.

### الأسماء والتركيز والربط

- محاكاة تقرير فيه 7 صفوف واسم مكرر مرتين أعطت 6 خيارات فريدة. الترتيب
  العربي الفعلي:
  `آدم الزبون، إبراهيم الزبون، أحمد اليوسف، بدر الزبون، عروة خلوف، مركز شريفة`.
  بقيت الهمزة والتاء المربوطة حرفياً (`أحمد`، `عروة`، `شريفة`) ولم يُستعمل
  `normalizeItemName` لبناء الخيارات.
- ملاحظة غير مانعة: قبل `Set` يُطبّق `String(...).trim()`، أي تُقص الفراغات
  الطرفية فقط. لا يتغير أي حرف عربي أو تهجئة، والمطابقة الوظيفية لا تتأثر؛
  لكن الفراغ الطرفي المقصود افتراضياً—إن وجد في المصدر—لن يظهر في الخيار.
- الكتابة الجزئية `مركز` أبقت `document.activeElement.id=sales-customer`،
  وبقيت القائمة واحدة. السبب مؤكد في الكود: مستمع `input` السابق لم يتغير
  ولا يستدعي `render()`؛ يستبدل محتوى `[data-sales-cust-host]` فقط، والقائمة
  خارجه.
- اختيار `مركز شريفة` من قيمة الخيارات حدّث الحالة إلى الاسم نفسه وأظهر:
  الرصيد `$14,000.00`، الحد `$15,000.00`، آخر دفعة `$300.00` بتاريخ
  `2026-07-24`، وآخر سعر بيع للصنف `$100.00 / كرتونة` من فاتورة 55. بقي
  التركيز في الحقل أثناء تحديث لوحة الرصيد وبطاقة الصنف.
- اسم يدوي غير موجود بقي مقبولاً في الحقل والحالة، ظهرت له رسالة «غير مطابق»
  فقط، وظهر حرفياً في مستند الطباعة. تفريغ الحقل أبقى التركيز، أخفى لوحة
  الرصيد، وأعطى «زبون نقدي» في مستند الطباعة كما قبل التغيير.

### الهاتف والكاش والفحوص

- عند `390×844`: `clientWidth=scrollWidth=bodyScrollWidth=390`، ومستطيل الحقل
  من `31` إلى `359` بعرض `328px`، فلا تمرير أفقي والحقل كامل داخل الشاشة.
- بعد حذف service workers والكاش في جلسة الاختبار المحلية وإعادة التحميل،
  كان مفتاح الكاش الوحيد `web-platform-tobacco-v378`، وكل الأصول السبعة
  المرقمة حملت `tobacco-111`، ونسخة `app.js` المخدومة تحوي القائمة الجديدة.
- `npm.cmd run check`: ناجح (`Project check passed`). و`git diff --check`
  للشجرة ولفرق `f42691a..713b8c0`: ناجحان.
- نهايات الأسطر لم تتراجع: `src/app.js CR=0` (LF من 7561 إلى 7576)،
  `public/service-worker.js CR=0 LF=62`، و`AI_HANDOFF.md CR=0`.
  `index.html CR=19 LF=26` مختلط مسبقاً وبالأعداد نفسها في الأب والكوميت.
- Boundaries: التغيير الوحيد بعد المراجعة هو هذا السجل غير المثبّت في
  `AI_HANDOFF.md`.
- Handoff UTC: 2026-07-25T13:53:39.6137546Z

## 2026-07-25 - Codex - مراجعة مستقلة لطباعة PWA داخل iframe (`8e644c4`)

- Status: **جاهز للدمج في نطاق مراجعة الكود؛ لا يوجد مانع.** روجع
  `8e644c4cfc79dd2b8efe5bc1d43b3f3567f3a830` المطابق حرفياً لـ
  `origin/fix/pwa-print-iframe`، بلا commit/push/merge أو تعديل كود أو كتابة
  قاعدة أو لمس أسعار/مزامنة. نطاق الكوميت ثلاثة ملفات فقط:
  `src/app.js` و`index.html` و`public/service-worker.js`.

### التحويل وCSP

- البحث في `src/` أعطى أربع استدعاءات فقط لـ`printHtmlDocument`: تصدير
  التقارير، فاتورة المبيعات، طلب الشراء، والفاتورة القديمة. لا يوجد
  `window.open` تنفيذي للطباعة؛ التطابقان الباقيان داخل تعليق الدالة فقط،
  والاستدعاء التنفيذي الوحيد لـ`.print()` هو `win.print()` داخل المحرك
  المشترك.
- أزيل السكربت المضمّن القديم من مستند التقرير، والبحث أعطى صفر
  `<script>`/`<scr...` أو `onload=` داخل قوالب الطباعة. اختبار المستند الفعلي
  الناتج من `exportReportPdf` تحت CSP نفسها أعطى `scriptCount=0`،
  `styleSheets=1`, `styleRules=8`، وطبّق اللون المضمّن فعلياً. لا توجد رسالة
  CSP من نوع رفض `srcdoc` أو style؛ `style-src 'unsafe-inline'` يسمح بالنمط.
  تحذير Chromium الوحيد هو أن `frame-ancestors` لا يعمل عبر meta، وهو معروف
  وموثق سابقاً ولا يخص هذا التغيير.

### السلوك والتنظيف والخطأ

- على Chromium في Windows وبقياس `390×844`: عرض الصفحة/المحتوى
  `390/390` قبل الإطار وأثناءه وبعده، فلا تمرير أفقي. مستطيل الإطار
  `x=-10000`, `width=794`, `opacity=0`, مع `aria-hidden=true` و
  `pointer-events:none`؛ لم يظهر للمستخدم.
- طباعتان متتاليتان أعطتا `printCalls=2` و`maxFrames=1`: الاستدعاء الثاني
  يزيل السابق قبل إنشاء الجديد، فلا تراكم. مسار الخطأ المحاكى برمي استثناء
  من `print()` أعطى `onError=1`, `removed=1`, `frames=0`.
- ملاحظة غير مانعة: في Chromium لا يبقى مستمع `afterprint` مربوطاً بعد انتقال
  الإطار من `about:blank` إلى `srcdoc` بسبب ترتيب append ثم تعيين `srcdoc`؛
  لذلك لا يحدث التنظيف السريع بهذا الحدث. المهلة الاحتياطية الأصلية، بلا
  تسريع، حذفت الإطار فعلياً بعد `61016ms` من استدعاء الطباعة. ومع حذف السابق
  عند بدء أي طباعة جديدة يبقى شرط عدم التراكم محققاً.

### محتوى الفاتورة والكاش

- جزء `printSalesInvoice` من بداية الدالة حتى تسليم HTML للمحرك متطابق
  byte-for-byte مع الأب `baaa70a` بعد توحيد LF؛ SHA-256 للطرفين
  `3c26272342280111fd1c6ed3f91f9f1f5b9dd64fd30b9921fcbde0ce6eeb9cf8`.
  أي أن بناء المحتوى لم يتغير، بل استُبدل مقصد الطباعة فقط.
- محاكاة مستقلة للقالب بصنف كوده `240022` ورقمه الداخلي `399` واسم عربي طويل
  أعطت خلايا الصنف: الكود `240022`، الاسم كاملاً، الوحدة، الكمية،
  `$100.00` والإجمالي `$200.00`. وظهرت المجاميع: إجمالي `$200.00`، حسم
  `$10.00`، صافي `$190.00`، مدفوع `$50.00`، ومتبقٍّ عليه `$140.00`.
- بعد حذف service workers والكاش في جلسة الاختبار المحلية وإعادة التحميل،
  كان مفتاح الكاش الوحيد `web-platform-tobacco-v377`، وكل الأصول السبعة
  المرقمة في `index.html` حملت `tobacco-110`، ونسخة `app.js` المخدومة تحوي
  `printHtmlDocument`.

### الفحوص والحدود

- `npm.cmd run check`: ناجح (`Project check passed`). و`git diff --check`
  للشجرة و`8e644c4^..8e644c4`: ناجحان.
- نهايات الأسطر قبل هذا السجل: `src/app.js CR=0 LF=7561`،
  `public/service-worker.js CR=0 LF=62`، و`AI_HANDOFF.md CR=0`.
  `index.html CR=19 LF=26` مختلط مسبقاً، والأعداد نفسها حرفياً في الأب
  `baaa70a`؛ الكوميت لم يغيّر نمط نهاياته.
- لا يمكن من Chromium/Windows إثبات النتيجة النهائية داخل PWA مثبت على iOS؛
  الدليل الحالي يثبت منطق الإصلاح، سلامة Windows، وغياب الانحدارات المطلوبة.
  تجربة iPhone الفعلية تبقى ملاحظة تحقق لاحقة لا مانع كود.
- Boundaries: التغيير الوحيد بعد المراجعة هو هذا السجل غير المثبّت في
  `AI_HANDOFF.md`.
- Handoff UTC: 2026-07-25T13:32:37.5340396Z

## 2026-07-25 - Codex - تحقق مستقل من حفظ حدود ائتمان 25 زبوناً

- Status: **ناجح؛ لا يوجد مانع.** تحقق قراءة فقط من كتابة قاعدة البيانات
  المنفذة عند `2026-07-25T12:02:33.532381Z`، بلا commit/push/merge أو تعديل
  كود أو كتابة قاعدة أو لمس أسعار أو تجربة هاتف.
- ثُبتت لقطة المصدر الأحدث أثناء الفحص بمعرّفين صريحين منعاً لتحرك `latest`:
  - الأرصدة `257d476c-1530-44d3-8c50-7b1b3ad5d408` عند
    `2026-07-25T12:20:15.838882Z`، وفيها 287 زبوناً.
  - الفواتير `e231d06f-cbc8-43a4-9cb6-4f99e401a4a3` عند
    `2026-07-25T12:21:06.723612Z`، نافذة 60 يوماً من 2026-05-26،
    وفيها 232 مستنداً لـ52 زبوناً.

### إعادة الحساب والمقارنة

- أُعيد الحساب من JSON المصدر: الرصيد `>=2000` أعطى **25 زبوناً و25 مفتاح
  تقرير فريداً**. جُمعت الفواتير العادية موجبة والمرتجعات سالبة، وعُدّت
  الفواتير العادية مستقلةً عن المرتجعات.
- التصنيف المحسوب: **17 في (أ)** لهم فاتورة عادية واحدة على الأقل، وحد كل
  منهم `greatest(500, round((net60 / 2) / 500) * 500)`؛ و**8 في (ب)** بلا
  فاتورة عادية، وحد كل منهم رصيده الخام.
- `customer_credit_limits` يحوي **25 صفاً و25 customer_key فريداً**. الربط
  المباشر بمفتاح التقرير أعطى `linked=25`، والمقارنة الرقمية
  `exact_matches=25`, `mismatches=0`. لا صف زائد ولا زبون رصيده دون 2000
  له حد.
- قيم (ب) المشتقة من أحدث تقرير والمحفوظة تطابقت حرفياً إلى ثلاث خانات:
  `3832.210`, `3811.411`, `3800.000`, `3571.600`, `3181.208`,
  `2751.848`, `2715.700`, `2225.200`.
- مركز شريفة: صف واحد فقط بالمفتاح المطبّع
  `مركز شريفه اسعد شريفه`، وصفر صف بالمفتاح القديم ذي التاء، والحد
  `15000.000` والملاحظة اليدوية **«لبل»** ما زالت موجودة.
- أثر الكتابة: 22 صفاً جديداً وثلاثة صفوف سابقة حُدثت. توزيع الملاحظات الحالي
  واحد «لبل»، و16 ملاحظة المجموعة (أ)، و8 ملاحظات المجموعة (ب)، وصفر صياغة
  أخرى. لا يوجد جدول تاريخ للملاحظات يثبت الحالة السابقة للحقلين القديمين
  الآخرين، لكن ملاحظة المالك الوحيدة المطلوبة موجودة ولم تُستبدل.

### ربط الواجهة والسلوك

- طُبقت دوال `normalizeItemName` و`customerLimitMap` و`applyCustomerLimits`
  نفسها من `main` على لقطة الأرصدة والحدود الحية: **25/25**
  `limitSource=internal`، وصفر فشل ربط وصفر حالة «بلا حد محدّد».
- الحالات مطابقة:
  - `over_limit=8`: الحجي ابو ياسين 111%، مركز أوسكار 109%، بدر خلوف
    دولار 209%، ابو حسان ناجي 154%، مركز الوليد 246%، أحمد اليوسف 157%،
    جهاد التلي 156%، وابو محمد عسكر 444%.
  - `near_limit=9`: ابو علي اسعد 88% والثمانية في (ب) عند 100%.
- محاكاة شرط `salesCustomerPanel` على الثمانية في (ب): الثمانية تظهر
  `near_limit` في صفحة الأرصدة؛ متبقّي أجل `$1` أعطى تحذير `over` للثمانية؛
  ومتَبقّي صفر أعطى **صفر** تحذير `over`.

### نطاق الكتابة وسلامة الأسعار وGit

- `approved_price_items`: ما زال **316 صفاً** و**316/316** لها
  `item_code`، وصفر صف محدث في نافذة الحفظ ±2 ثانية. آخر تحديث للأسعار
  `2026-07-25T11:27:07.667594Z`، أي قبل كتابة الحدود.
- `telegram_outbox` في نافذة الحفظ ±2 ثانية: **25 إشعاراً**، كلها
  `event_type=credit_limit` وكلها `sent`؛ صفر نوع آخر. الرسائل تثبت 22
  insert وثلاثة update (ابو علي 0→31500، الحجي ابو ياسين 0→9500، وشريفة
  25000→15000).
- قبل إضافة هذا السجل كانت شجرة `main` نظيفة، و
  `HEAD=origin/main=c40c755173c5c177b31fe05b5aae216ba73a3bc0`. لا فرع
  اسمه متعلق بـcredit/limit، ولا reflog أو commit في نافذة حفظ القاعدة.
- الملاحظات غير المانعة المتوقعة مؤكدة: المجموعة (ب) `near_limit` في صفحة
  الأرصدة لا `over_limit`؛ عتبة الصفحة 80% وعتبة لوحة الفاتورة 90%؛ وحساب
  «بدر خلوف» الثاني رصيده `-0.074` (فعلياً قريب من الصفر) وبلا حد، بينما
  الحد يخص «بدر خلوف دولار» فقط.
- Boundaries: التغيير الوحيد بعد التحقق هو هذا السجل غير المثبّت في
  `AI_HANDOFF.md`.
- Handoff UTC: 2026-07-25T12:22:11.5423782Z

## 2026-07-25 - Codex - اعتماد إغلاق مانعَي حاجز جدول الأسعار (`c7ed069`)

- Status: **جاهز للدمج؛ لا يوجد مانع متبقٍ.** المراجعة فقط عند
  `c7ed069bc87a167b21b3b447035f8fcc5f2e6015` المطابق لـ
  `origin/fix/sql-guard-prices`، بلا commit/push/merge أو تعديل أسعار أو تنفيذ
  DDL على الإنتاج أو تجربة هاتف.
- نطاق الفرع فوق `main` محصور في `supabase/approved-prices-table.sql` وسجل
  المراجعة السابقة في `AI_HANDOFF.md`.

### إغلاق المانعين

- بعد استبعاد أسطر التعليقات، عدد أوامر `drop` القابلة للتنفيذ **صفر**. التطابقات
  الباقية الثلاثة في الملف توثيق تاريخي ضمن تعليقات فقط. أُزيل
  `drop table ... cascade` فعلياً، ولا توجد صيغة ديناميكية بديلة له.
- السياسات الأربع تطابق `pg_policies` الحيّة في الإنتاج:
  - `select`: الدور `authenticated` و`qual=is_staff()`.
  - `insert`: الدور `authenticated` و`with_check=is_staff()`.
  - `update`: الدور `authenticated` و`qual/with_check=is_staff()`.
  - `delete`: الدور `authenticated` و`qual=is_staff()`.
  الفحص الساكن أعطى أربع سياسات، وصفر `using(true)` أو `with check(true)`
  قابل للتنفيذ.

### محاكاة PostgreSQL المحلية

- استُخرجت كتلة المتطلب وكتلة الحاجز من الملف نفسه وشُغّلتا محلياً، بلا أي
  تنفيذ على الإنتاج:
  - غياب `public.is_staff()`: `MISSING_IS_STAFF=BLOCKED`.
  - وجود الدالة وغياب الجدول: `MISSING_TABLE=PASS`.
  - جدول موجود فارغ: `EMPTY_TABLE=BLOCKED_COUNT_0 REMAINS=0`.
  - جدول موجود وفيه 316 صفاً:
    `POPULATED_TABLE=BLOCKED_COUNT_316 REMAINS=316`.
- شُغّل الملف كاملاً على قاعدة محلية جديدة بعد تجهيز دور `authenticated`
  ودالة `is_staff()`: `FIRST_BUILD=PASS`, `COLUMNS=20`, `REQUIRED=2`,
  `ITEM_CODE_INDEX=1`, `POLICIES=4`. أي أن `item_code` و`item_number`
  موجودان، وفهرس `idx_item_code` يُنشأ فعلياً.

### التوثيق والفحوص

- الملف يسمي التوابع الستة المطابقة للفحص القرائي الحي: الواجهات
  `approved_price_sync_feed` و`available_price_sync_feed` و
  `bot_health_alerts`، وtriggers المسماة `trg_notify_price_changes` و
  `trg_notify_new_price_items` و`trg_notify_stock_alerts`. ويوجّه صراحةً إلى
  ملف ترحيل إضافي لأي تعديل على قاعدة عاملة.
- `npm.cmd run check` ناجح (`Project check passed`). `git diff --check` وفرق
  `c7ed069^..c7ed069` نظيفان. نهايات الأسطر قبل هذا السجل:
  `supabase/approved-prices-table.sql CR=0` و`AI_HANDOFF.md CR=0`.
- لا ملاحظة جديدة. صياغة الرسائل والتعليقات وترتيب الكتل لا تؤثر في القبول.
- Boundaries: التغيير الوحيد بعد المراجعة هو هذا السجل غير المثبّت في
  `AI_HANDOFF.md`.
- Handoff UTC: 2026-07-25T10:19:24.4886347Z

## 2026-07-25 - Codex - مراجعة حاجز جدول الأسعار (`fix/sql-guard-prices`، `7352104`)

- Status: **غير جاهز للدمج — مانعان في ملف الحماية نفسه.** المراجعة فقط عند
  `735210456ffe362c1dca1bfdf1ff3b086a374a89` المطابق لـ
  `origin/fix/sql-guard-prices`، بلا commit/push/merge أو تعديل أسعار أو تنفيذ
  DDL على الإنتاج. تجربة الهاتف مؤجلة كما طلب المالك.
- نطاق الفرع فوق `main` ملف واحد فقط:
  `supabase/approved-prices-table.sql`.

### الموانع

1. **سياسات RLS لا تطابق الإنتاج وتفتح الأسعار لكل حساب authenticated.**
   السياسات الأربع الجديدة تحمل أسماء سياسات الإنتاج، لكنها تستعمل
   `using (true)` / `with check (true)`. الفحص القرائي المباشر لـ`pg_policies`
   في الإنتاج أثبت أن `select/insert/update/delete` كلها مقيّدة فعلياً بـ
   `is_staff()` وقائمة `staff_allowlist`. لذلك البناء من هذا الملف يسمح لأي
   حساب authenticated بقراءة الأسعار وإضافتها وتعديلها وحذفها، ولو لم يكن
   موظفاً مسموحاً. يلزم نسخ شروط `is_staff()` الفعلية إلى السياسات الأربع
   (مع ضمان وجود الدالة/قائمة السماح في مسار البناء) لا الاكتفاء بدور
   `authenticated`.
2. **الحاجز يسمح بـ`drop ... cascade` على جدول موجود فارغ ويكسر اعتماداته.**
   شرط المنع هو `row_count > 0` فقط، ولذلك يعدّ الجدول الموجود الفارغ «إعادة
   بناء مشروعة» ثم يحذفه بـ`cascade`. الفحص القرائي للإنتاج وجد ثلاث واجهات
   تعتمد على الجدول: `approved_price_sync_feed` و
   `available_price_sync_feed` و`bot_health_alerts`، وثلاثة triggers:
   `trg_notify_new_price_items` و`trg_notify_price_changes` و
   `trg_notify_stock_alerts`. الملف لا يعيد إنشاء أي منها. محاكاة PostgreSQL
   محلية أثبتت أن اعتماد view على جدول فارغ اختفى بعد مسار `drop ... cascade`.
   الحل الآمن لملف «بناء من الصفر فقط» هو إزالة `drop ... cascade` وترك
   `create table` يفشل بأمان عند وجود الجدول، أو منع التنفيذ عند وجود الجدول
   أياً كان عدد صفوفه؛ أما إعادة البناء فتكون بترحيل منفصل ومقصود.

### ما نجح

- الإنتاج ما زال يحتوي **316** صفاً، وعمودا `item_code` و`item_number` موجودان
  ومملوءان في **316/316**. تعريف العمودين في ملف البناء يطابق نوعهما الحالي
  (`text` nullable).
- محاكاة كتلة الحاجز نفسها على PostgreSQL محلي أعطت:
  `MISSING=PASS`، و`EMPTY=PASS`، و`POPULATED=BLOCKED COUNT_OK`؛ أي إن الرسالة
  والعدّ يعملان، لكن نجاح مسار الجدول الفارغ هو سبب المانع الثاني أعلاه.
- قصر السياسات على `to authenticated` يغلق وصول `anon` السابق، لكنه لا يحقق
  قيد الموظفين الفعلي الموجود في الإنتاج.
- `npm.cmd run check` ناجح (`Project check passed`). `git diff --check` وفرق
  الكوميت نظيفان. `supabase/approved-prices-table.sql` بقي LF فقط
  (`CR=0`, `LF=79`)، و`AI_HANDOFF.md` كان LF قبل هذا السجل.
- Boundaries: التغيير الوحيد بعد المراجعة هو هذا السجل غير المثبّت في
  `AI_HANDOFF.md`.
- Handoff UTC: 2026-07-25T09:56:31.0916060Z

## 2026-07-25 - Codex - اعتماد إغلاق مانع استجابة حفظ كود الصنف (`c71fcea`)

- Status: **جاهز للدمج؛ لا يوجد مانع متبقٍ.** المراجعة فقط عند
  `c71fceacbb3fd58090f2119f7c5b854402cf80c1` المطابق لـ
  `origin/fix/ameen-item-code`، بلا commit/push/merge أو مزامنة أو حفظ إنتاجي أو
  تعديل أسعار.
- نطاق كوميت الإغلاق أربعة ملفات فقط: سجل المراجعة السابق في `AI_HANDOFF.md`،
  رفع الأصول إلى `tobacco-109`، رفع الكاش إلى `v376`، وإضافة
  `item_number,item_code` إلى جملتَي `select` الراجعتين بعد upsert/insert في
  `src/supabase-client.js`. لا تغيير في حقول الأسعار أو منطق العرض والبحث.

### إغلاق المانع

- فحص آلي لكل جمل `select` داخل الدوال الثلاث أعطى **5/5 سليمة**:
  `listApprovedPriceItems` فيها جملة واحدة، و`upsertApprovedPriceItems` فيها
  الجلب المسبق والجملة الراجعة، و`replaceApprovedPriceItems` فيها الجلب المسبق
  والجملة الراجعة؛ كل واحدة تحمل `item_number` و`item_code` معاً.
- أُعيدت المحاكاة السابقة حرفياً على الكود الفعلي وبتطبيق
  `priceMap.set(item.itemKey, item)` نفسه:
  - قبل الحفظ: `240022 → long-code` و`399 → long-code`.
  - كائن upsert الراجع: `itemCode="240022"` و`itemNumber="399"`.
  - بعد الحفظ: `240022 → long-code` و`399 → long-code`، والرقم المعروض
    `240022`؛ لم تعد أي نتيجة `[]`.
- الإصلاح يغلق `item_number` القديم أيضاً، لا `item_code` وحده: جملتا الإرجاع
  والمحول `normalizeDbApprovedPrice` أعادا القيمتين معاً، والبحث بعد الحفظ نجح
  بالرقم الداخلي `399` كما نجح بالكود `240022`.
- حماية الكتابة بقيت سليمة في المحاكاة:
  1. نجاح الجلب أعاد ربط الرقمين في payload المسارين (`399/240022`).
  2. فشل الجلب في upsert ترك الحقلين خارج payload، فلا يلمسهما الصف القائم،
     واستجابة القاعدة احتفظت بهما.
  3. فشل الجلب في replace، سواء عاد كـerror أو رمى استثناءً، أعطى رسالة
     «لم يُحذف شيء» وكانت العمليات المسجلة قراءة واحدة فقط؛ صفر delete وصفر insert.

### إعادة تأكيد بقية القبول

- بعد إلغاء تسجيل Service Worker وحذف Cache Storage وlocal/session storage صارت
  الحالة `registrations=0` و`cacheKeys=[]`، ثم أعادت الصفحة تسجيل عامل واحد
  وكاش `web-platform-tobacco-v376` وحده. كل JS وCSS المحمّل يحمل
  `tobacco-109`.
- المقارنة المستقلة القرائية بين `mt000` وSupabase بقيت:
  `SITE_ROWS=316`, `MATCHED=316`, `BY_NAME=2`, `MISMATCH=0`,
  `NO_PEER=0`؛ أي `Code/item_code` و`Number/item_number` مطابقان 316/316.
- `tools\pull-item-numbers.ps1 -WhatIf`: «مطابق: 316 من 316
  (منها 2 بالاسم بعد فشل المفتاح)» و«سيُحدَّث: 0».
- العرض الفعلي بأطول كود `240022` بقي صحيحاً في الاقتراح وخلية الجدول وبطاقة
  المعلومات. حمولة المستند المحفوظ حملت `items[0].num="240022"`، وقالب
  `printSalesInvoice` حمل `<td dir="ltr">240022</td>` بلا `399`.
  إعادة الفحص السريع وجدت أيضاً `0000/134` و`1111/103` و`24007/220`
  بالرقمين والاسم، وصنفاً بلا كود رجع إلى `777`.
- 390×844: الصفحة `390/390` بلا تمرير أفقي، الخلية الثابتة `170/170px`،
  الاسم العربي الطويل أربعة أسطر كلها داخل الخلية، الكمية `53.16px` ظاهرة
  ومركّزة، والتداخل `0`. 1440×900: الصفحة `1440/1440`، الخلية
  `position:static` وعرضها `443.94px`، النص داخلها والتداخل `0`.
  الفحص البصري والقياسات متفقان، وصفر أخطاء JavaScript.
- `npm.cmd run check` ناجح (`Project check passed`). `git diff --check` وفرق
  `c71fcea^..c71fcea` نظيفان. نهايات الأسطر:
  `src/app.js CR=0` و`src/supabase-client.js CR=0`
  و`tools/pull-item-numbers.ps1 CR=0`.
- لا ملاحظة جديدة. ملاحظتا المراجعة السابقة حول أولوية الكود عند تعادل البحث
  وتحذير `approved-prices-table.sql` تبقيان غير مانعتين كما حُدّد.
- Boundaries: التغيير الوحيد بعد المراجعة هو هذا السجل غير المثبّت في
  `AI_HANDOFF.md`. أُغلقت جلسات المتصفح والخادم المحلي بعد الفحص.
- Handoff UTC: 2026-07-25T09:16:06.5471245Z

## 2026-07-25 - Codex - مراجعة كود صنف الأمين (`fix/ameen-item-code`، `3e53b26`)

- Status: **غير جاهز للدمج — مانع واحد في دورة حفظ السعر.** المراجعة فقط عند
  `3e53b26fcd76672fecacf637cae69a14274bb9ee` المطابق لـ
  `origin/fix/ameen-item-code`، بلا commit/push/merge أو مزامنة أو حفظ إنتاجي أو
  تعديل أسعار.
- المانع: مسارا `upsertApprovedPriceItems` و`replaceApprovedPriceItems` يعيدان ربط
  `item_number` و`item_code` صحيحاً داخل حمولة الكتابة، لكن جملتَي `select` الراجعتين
  بعد الكتابة في `src/supabase-client.js` لا تطلبان العمودين. لذلك تعيد
  `normalizeDbApprovedPrice` الكائن المحفوظ بـ`itemNumber=""` و`itemCode=""`، ثم يستبدل
  به `saveApprovedPrice()` الصنف الحالي داخل `state.approvedPriceItems`. محاكاة الكود
  الفعلي أعطت قبل الحفظ بحثاً ناجحاً بـ`240022` و`399`، وبعد تطبيق استجابة الحفظ
  نفسها أعاد البحث `[]` لكليهما وصار الرقم المعروض فارغاً حتى إعادة تحميل الصفحة.
  هذا يخرق شرط البحث بالرقمين بعد حفظ سعر ويُغلق بإضافة العمودين إلى جملتَي
  `select` الراجعتين (أو دمجهما صراحةً في النتيجة قبل الإرجاع).

### ما نجح

- المقارنة المستقلة القرائية بين `mt000` وSupabase: `316/316` لها نظير، منها اثنان
  بالاسم بعد فشل المفتاح، و`316/316` يطابق فيها `Code ↔ item_code` و
  `Number ↔ item_number` معاً؛ صفر اختلاف وصفر بلا نظير. العينات الحية:
  `0000/134` لماستر طويل ورق، `1111/103` لغلواز كوين أحمر،
  و`24007/220` لنخلة صلاحية شهر 10.
- `tools\pull-item-numbers.ps1 -WhatIf` نجح قراءةً فقط: «مطابق: 316 من 316
  (منها 2 بالاسم بعد فشل المفتاح)» و«سيُحدَّث: 0».
- بعد إلغاء تسجيل Service Worker وحذف Cache Storage وlocal/session storage ثم إعادة
  التحميل ظهر تسجيل واحد وكاش `web-platform-tobacco-v375` فقط؛ كل ملفات JS وCSS
  المحمّلة تحمل `tobacco-108`.
- مواضع العرض الخمسة تستخدم `salesItemCode()` ونجحت حياً بأطول كود اختباري
  `240022`: الاقتراح، خلية الجدول، بطاقة المعلومات، حمولة المستند المحفوظ
  (`items[0].num="240022"`)، وقالب `printSalesInvoice`
  (`<td dir="ltr">240022</td>` بلا `399`).
- البحث بمدخلات مستخدم فعلية وجد الأصناف بـ`0000` و`1111` و`24007`، وبالأرقام
  الداخلية `134` و`103` و`220`، وبالاسم. صنف معزول بلا `item_code` ظهر وبُحث عنه
  بالرقم الاحتياطي `777` بلا انكسار.
- حماية قاعدة البيانات نفسها ناجحة في المحاكاة: عند نجاح القراءة حمل المساران
  `item_code="0000"` و`item_number="134"` إلى الكتابة؛ وعند فشل القراءة أو رميها
  توقف المسار الحاذف قبل أي `delete` أو `insert`. لم تُنفّذ كتابة إنتاجية.
- 390×844 مع الاسم العربي الطويل: الصفحة `390/390` بلا تمرير أفقي، الخلية الثابتة
  `170/170px`، النص أربعة أسطر كلها داخل الخلية، حقل الكمية `53.16px` ظاهر ومركّز،
  والتداخل بينه وبين العمود الثابت `0`. على 1440×900 الصفحة `1440/1440`، الخلية
  `position:static` وعرضها `443.94px`، النص داخلها والتداخل `0`. صفر أخطاء JavaScript.
- `npm.cmd run check` ناجح (`Project check passed`). `git diff --check` وفرق الكوميت
  نظيفان. نهايات الأسطر: `src/app.js CR=0` و`src/supabase-client.js CR=0`
  و`tools/pull-item-numbers.ps1 CR=0`.

### ملاحظات غير مانعة حسب شرط القبول

1. تعليق البحث يقول إن الكود يفوز عند التعادل، لكن الكود والرقم الداخلي يأخذان
   الدرجة نفسها ثم يُحسم التعادل بالاسم؛ محاكاة تعارض أعادت مطابق الرقم الداخلي قبل
   مطابق الكود. ترتيب الأولوية فقط غير مانع.
2. صياغة تعليقات SQL لا تغيّر التنفيذ. والتحذير حول
   `supabase/approved-prices-table.sql` صحيح ومهم: الملف يبدأ بـ
   `drop table if exists approved_price_items cascade` ولا يعرّف العمودين الجديدين.

- Boundaries: التغيير الوحيد بعد المراجعة هو هذا السجل غير المثبّت في
  `AI_HANDOFF.md`. أُغلقت جلسات المتصفح والخادم المحلي بعد الفحص.
- Handoff UTC: 2026-07-25T08:59:02.7037516Z

## 2026-07-25 - Codex - مراجعة متطلب 22 — آخر سعر بيع للزبون (`feat/last-customer-price`، `f16494c`)

- Status: **جاهز للدمج؛ لا يوجد مانع يمنع الدمج.** المراجعة فقط عند
  `f16494cd8fccb851f6386932a0e0c91f35d665ed` المطابق لـ
  `origin/feat/last-customer-price`، بلا commit/push/merge أو مزامنة أو كتابة في القاعدة أو
  لمس أسعار. الفرع ما زال مبنياً فوق `fix/sales-name-column-sticky` غير المدموج.
- النطاق: كود الميزة في `8f84e84` محصور في `index.html` و`public/service-worker.js`
  و`src/app.js`، وسجل التوثيق في `f16494c`. لم يُلمس `styles.css`. بقي `src/app.js`
  بـLF فقط (`CR=0`، قبل الميزة وبعدها)، والنسخ هي `tobacco-107` و`v373`.
- مُسح كاش Service Worker وتسجيله فعلياً قبل القياس: كانت مفاتيح `v371/v372/v373`
  موجودة، ثم صارت التسجيلات والكاشات صفراً، وبعد إعادة التحميل ظهر `v373` وحده وحملت كل
  أصول التطبيق `tobacco-107` بلا `105/106`.

### حسم الوحدة والصحة الوظيفية

- تأكدت قراءةً من أحدث تقرير حي `ameen_customer_invoices` (قراءة فقط، تاريخ
  2026-07-25): فاتورة 187 لجهاد التلي تحمل `price=7.1`, `qty=25`,
  `qtyUnits=0.5`، وفاتورة 188 لحسن عباس تحمل `price=355`, `qty=100`,
  `qtyUnits=2`. التجميع المستقل مقابل إجمالي كل فاتورة يحسم أن الأولى بأساس الكروز
  والثانية بأساس الكرتونة.
- في التدفق الحي للبطاقة ظهر للصنف نفسه **`355 $ / كرتونة` في الحالتين**: حسن عباس
  من الفاتورة 188، وجهاد التلي من الفاتورة 187. لم يظهر الرقم الخام `7.1`.
- مرتجع أحدث بسعر 999 استُبعد، وبقي أحدث بيع عادي بسعر 330 من الفاتورة 101 متقدماً
  على بيع أقدم بسعر 300. أي أن المرتجع لا يتسرب والأحدث يفوز.
- حالات الغياب الأربع أعطت رسائل صريحة ومختلفة: لا زبون، لا تقرير، لا مبيعات للزبون،
  والصنف لم يُبع له؛ لا صفر مضلل ولا سطر مخفي. محاكاة `summary.periodDays=47` ظهرت
  في الرسائل كـ47، فتأكد عدم تثبيت المدة.
- التطبيع على الطرفين نجح عملياً في مطابقة `أحمر بحرينى` مع `احمر بحريني`.
- لم ينحدر `invoiceLinePrice` بعد استخراج `invoiceLineUnitPrice`: الحالات الخمس
  أعطت على الترتيب كروز→355/كرتونة، كرتونة→355/كرتونة، سعر صفر→`—`، بلا وحدة
  ثانية→7.1/كروز، و`inv=null`→7.1/كرتونة.
- بعد فتح البطاقة وكتابة اسم الزبون بقي التركيز مستقراً، واستمر الإغلاق بالزر
  وبالخلفية بعد التحديث الجراحي.

### الحدود والواجهة والفحوص

- لا مصدر بيانات جديد ولا استدعاء كتابة جديد. في اختبار موظف غير مالك كانت استدعاءات
  `listItemCosts=0` وكل عمليات الكتابة المسجلة `[]`؛ لم تُقرأ `item_costs` ولم تظهر
  قيمة تكلفة أو ربح.
- على 390×844: `documentElement.scrollWidth=390` والبطاقة 358px داخل الشاشة.
  على 1440×900: `scrollWidth=1440` والبطاقة 360px داخل الشاشة. لا قصّ ولا تمرير
  أفقي على الصفحة، وصفر أخطاء JavaScript.
- `npm.cmd run check`: ناجح (`Project check passed`). `git diff --check` نظيف،
  وكذلك فحص فرق الميزة منفرداً وفرق الفرع كاملاً.
- النتيجة عند 2026-07-25 07:52:08 UTC: **لا مانع متبقٍ يمنع الدمج.**

## 2026-07-25 - Claude - متطلب 22 — آخر سعر بيع للزبون (feat/last-customer-price، 8f84e84)

- Status: **منجَز ومحفوظ، بانتظار مراجعة Codex ثم طلب دمج صريح من المالك.** لم يُدمج ولم يُنشر.
- **الفرع مبنيّ فوق `fix/sales-name-column-sticky` غير المدموج** تفادياً لتعارض مؤكّد في
  `CACHE_NAME` ونسخ الأصول. الترتيب الصحيح للدمج: الإصلاح أولاً ثم هذه الميزة.

### ما نُفِّذ

في بطاقة معلومات الصنف يظهر قسم «آخر بيع لهذا الزبون»: السعر بالوحدة الكبرى، وتاريخ ورقم
الفاتورة، وفرقه عن سعر النشرة الحالي عند اتحاد الوحدة.

### الفحص المسبق (قاعدة: ابحث عن الموجود وافحص RLS قبل البناء)

- البنية كانت موجودة فعلاً فلم يُبنَ جدول ولا سكربت ولا مزامنة: `customerInvoicesFor` للمطابقة
  الذكية باسم الزبون، و`invoicePriceBasis` لحسم الوحدة، و`salesInfoCard` للعرض.
- RLS: المصدر تقرير `ameen_customer_invoices` داخل `inventory_reports` وسياساته `SELECT` لدور
  `authenticated`، والتقرير يُقرأ أصلاً في صفحة كشف الحساب. الميزة **قراءة صرفة بلا أي كتابة**
  وبلا تغيير سياسات. التكلفة بقيت في `item_costs` المحمي للمالك وحده.

### حسم وحدة السعر — جوهر المتطلب، والدليل من البيانات الحقيقية

أساس سعر السطر في الأمين قد يكون الكرتونة أو الكروز ويختلف من فاتورة لأخرى. الدليل الحاسم:
**نفس الصنف (ماستر طويل ورق) بِيع في اليوم نفسه (2026-07-23) بفاتورتين بأساسين مختلفين** —
فاتورة 188 بأساس الكرتونة (`price=355`, `qtyUnits=2`) وفاتورة 187 بأساس الكروز
(`price=7.1`, `qty=25`, `qtyUnits=0.5`) — وكلتاهما تعرض الآن **355$/كرتونة**.
عرض 7.1 خاماً كان سيوهم البائع أن الكرتونة بسبعة دولارات.

وقياس شامل على 228 فاتورة في التقرير: النسبة بين مجموعَي الأساسين **وسطها 49× وأدناها 5×،
وصفر فاتورة يتقارب فيها المرشحان (< 2×)** — فالحسم قطعي ولا يقلبه حسم أو خصم. (177 فاتورة
يطابق فيها الفائز الإجمالي ضمن 0.5٪، و44 يزيد فرقها عن 2٪ بسبب الحسومات ولا يؤثر ذلك على
اختيار الأساس للسبب نفسه.)

استُخرجت نواة الحسم في `invoiceLineUnitPrice` ليبقى **مصدراً واحداً** لكشف الحساب وللبطاقة بدل
تكرار المنطق؛ و`invoiceLinePrice` صار غلافاً حوله ونتائجه مطابقة حرفياً للسابق (فُحصت خمس
حالات: أساس كروز، أساس كرتونة، سعر صفر، بلا وحدة ثانية، وبلا فاتورة).

### حالات مفحوصة حياً

- تطبيع الطرفين إلزامي لأن أسطر التقرير **بلا رقم صنف** فالمطابقة بالاسم فقط:
  «احمر»↔«أحمر» و«ازرق»↔«أزرق» و«بحرينى»↔«بحريني» — الثلاثة تطابقت.
- **فواتير المرتجع مستثناة:** مرتجع بتاريخ أحدث بيوم وسعر 999 لم يسرّب رقمه، وبقي 355 من
  الفاتورة الحقيقية. لولا الاستثناء لظهر سعر مرتجع مكان سعر البيع.
- الأحدث يفوز: فاتورة 07-23 بسعر 355 تغلب فاتورة 06-01 بسعر 340؛ وعند تساوي التاريخ يفوز
  الأعلى رقم فاتورة.
- الغياب يُشرح صريحاً بدل رقم مضلّل أو سطر مخفي — أربع حالات: لا اسم زبون، لا تقرير فواتير،
  لا فواتير لهذا الزبون، ولم يُبَع هذا الصنف له. **مدة النافذة تُقرأ من `summary.periodDays`**
  لا مثبّتة في الكود (حالياً 60 يوماً، 52 زبوناً، 228 فاتورة).
- فرق سعر النشرة: يظهر فقط عند اتحاد الوحدة واختلاف يزيد عن نصف سنت (355 مقابل 356 ← يظهر،
  330 مقابل 330 ← لا يظهر).

### عطل أدخلتُه أثناء العمل وأصلحته

لجعل البطاقة المفتوحة تتبع اسم الزبون وهو يُكتب، حدّثتها جراحياً باستبدال `innerHTML` (بلا
`render` حفاظاً على التركيز). لكن **مستمعات إغلاق البطاقة مربوطة بالعناصر مباشرة لا بالتفويض**
(`app.querySelectorAll("[data-sales-info-close]")`)، فالاستبدال كان يقتل زر ✕ والخلفية معاً.
استُخرج `bindSalesInfoClose` ويُعاد ربطه بعد كل استبدال. فُحص الإغلاق بالزر وبالخلفية قبل
التحديث الجراحي وبعده. **درس عام: أي استبدال لـinnerHTML في هذا الملف يجب أن يُعيد ربط
مستمعات ما استُبدل.**

- القياسات: 390×844 البطاقة 358px داخل الشاشة بلا قصّ ولا تمرير أفقي، و1440×900 بلا قصّ.
  صفر أخطاء JavaScript. **لم يُلمس `styles.css` إطلاقاً** (إعادة استعمال الأصناف الموجودة)،
  و`app.js` بقي LF بالكامل (CR=0). الفرق: `+115/-20` في ثلاثة ملفات.
- الفحوص: `npm run check` ناجح و`git diff --check` نظيف. `CACHE_NAME → v373` والأصول
  `→ tobacco-107`.
- الحدود: لا مزامنة ولا لمس أسعار ولا مخزون؛ لا كتابة في أي جدول. الفرع مدفوع كنسخة احتياطية.

## 2026-07-25 - Claude - تثبيت عمود اسم الصنف — التنفيذ (fix/sales-name-column-sticky، bfbe8ff)

- Status: **جاهز للدمج** — راجعه Codex على الرأس نفسه ولم يبقَ مانع. لم يُدمج ولم يُنشر؛ بانتظار طلب المالك الصريح.
- المانع الذي أُغلق: PR #24 وسّع خلية الاسم إلى 170px لكنها بقيت غير مرئية عملياً على 390px، لأن
  `salesFocusField` ينقل التركيز تلقائياً إلى الكمية بعد اختيار الصنف (أساس العمل بلا ماوس) فيمرّر
  المتصفح `.inv-table-wrap` إلى `scrollLeft=-274` ولا يبقى من الخلية إلا 50px من 170px (29%).
  أُعيد إنتاج العطل بنفس الأرقام قبل الإصلاح، وأكّده Codex مستقلاً.
- الإصلاح جزآن، والثاني لا يُستغنى عنه:
  1. `position:sticky` على خلية ورأس عمود الاسم داخل `@media (max-width:900px)` — وهو الحدّ نفسه الذي
     يبدأ عنده تمرير الجدول (مقيس: 905px لا تمرير، 820px تثبيت فعّال) فلا نافذة تمرير بلا تثبيت.
  2. `scroll-padding-inline-start:178px` على `.inv-table-wrap`: التثبيت وحده أنتج عطلاً جديداً —
     تمرير التركيز كان يُظهر حقل الكمية على حافة الحاوية بالضبط فيقع 32px منه تحت العمود الثابت
     ويبقى 21px مرئياً، أي كتابة الكمية بلا رؤيتها. بعد الإضافة: 0 محجوب و0 مقصوص.

### درس تقني يجب أن تعرفه أي جلسة قادمة

`src/styles.css` فيه **نهايات أسطر مختلطة**: 2573 CRLF مقابل 830 سطراً بـLF منفرد. أي محرّر يوحّدها
إلى CRLF ينتج فرقاً وهمياً بـ**830 سطراً** يصطدم بأي جلسة أخرى. وقع هذا فعلاً في هذه الجلسة، فرُجع
الملف بـ`git checkout --` وأُعيد الإدخال بسكربت Node يكتب بنهايات LF مطابقة لمحيط الموضع. القاعدة:
بعد أي تعديل على `src/styles.css` تحقّق أن `git diff --numstat` يعطي عدد الأسطر المضافة فعلاً لا آلافاً.
الشيء نفسه ينطبق على `AI_HANDOFF.md` (LF).

- تنظيم السجلات: كان سجلا Codex (المانع والموافقة) في مجلدَي عمل مختلفين ويُدرجان في **نفس السطر**
  من `AI_HANDOFF.md`، أي تعارض مؤكّد عند الدمج. نُقل سجل المانع حرفياً إلى ملف الفرع أسفل سجل الموافقة
  ليحمل الدمج الواحد كليهما. **نسخة `AI_HANDOFF.md` غير المحفوظة في مجلد العمل الرئيسي صارت زائدة**
  ويجوز إسقاطها بـ`git checkout -- AI_HANDOFF.md` بعد دمج هذا الفرع.
- الفحوص: `npm run check` ناجح، `git diff --check` نظيف، توازن أقواس CSS 555/555،
  `CACHE_NAME → v372` والأصول `→ tobacco-106`.
- الحدود: لا مزامنة ولا لمس أسعار ولا مخزون. الفرع مدفوع إلى origin كنسخة احتياطية فقط، بلا PR ولا دمج.

## 2026-07-25 - Codex - مراجعة تثبيت عمود اسم الصنف (bfbe8ff)

- Status: ready to merge from the reviewed scope — **لا يوجد مانع متبقٍ**. أُغلق مانع PR #24: الاسم والحقول المركّزة والأعمدة الطرفية بقيت ظاهرة كما يطلب شرط القبول، ولا overflow للصفحة ولا تغير على سطح المكتب.
- Target: `fix/sales-name-column-sticky` عند `bfbe8ffda9a91fe31a4dc80d2b59109f8b8661dd` بالضبط، مطابقاً لـ`origin/fix/sales-name-column-sticky` المحلي. بدأ وانتهى الـworktree على هذا الرأس.
- النطاق:
  1. الفرق أربعة ملفات فقط: تحديث نسخ الأصول في `index.html`، `CACHE_NAME` في `public/service-worker.js`، إضافة `sales-th-name` في `src/app.js`، و35 سطر CSS مضافة في `src/styles.css`.
  2. القواعد الجديدة محصورة بـ`@media (max-width:900px)`: تثبيت خلية ورأس الاسم عند حافة البداية، وخلفية/ظل فاصل، و`scroll-padding-inline-start:178px` على `.inv-table-wrap`.
  3. لا تغيير في الأسعار أو المخزون أو منطق الحفظ/المزامنة.
- تنظيف الكاش والتحقق من النسخة — نُفّذ قبل القياس:
  1. جرى تجهيز `v371`/`tobacco-105` ككاش قديم اختباري؛ قبل المسح ظهر تسجيل واحد ومفتاحا `v372` و`v371`.
  2. أُلغي التسجيل وحُذفت Cache Storage وlocal/session storage بالكامل: `registrations=0` و`cacheKeys=[]`.
  3. بعد إعادة التحميل ظهر `v372` فقط، وحُمّلت `src/styles.css?v=tobacco-106` وكل JS ذي النسخة `tobacco-106`، وصفر موارد `tobacco-105`.
  4. سياقا قياس 390×844 و1440×900 حجبا Service Worker وأكدا رابط `tobacco-106` مستقلاً، كي لا يتدخل كاش أثناء القياس.
- التدفق الحقيقي على 390×844 بالصنف `ماستر كوين سوبر سليم أزرق إصدار خاص طويل للاختبار` (#900):
  1. بعد الاختيار نقل `salesPickItem` التركيز فعلياً إلى الكمية. عند `scrollLeft=-185` بقيت خلية الاسم `170/170px` ظاهرة عند `189..359px`، والنص مطابقاً وكاملاً داخلها. حقل الكمية `53.125/53.125px` ظاهر عند `79.06..132.19px`، وصفر تداخل مع العمود الثابت.
  2. Enter من الكمية نقل التركيز فعلياً إلى السعر. عند `scrollLeft=-233` بقيت خلية الاسم نفسها `170/170px`، والنص كاملاً، وصفر تداخل مع السعر. حافة السعر وقعت على حد الحاوية بفارق هندسي كسري `0.47px` فقط (`30.53` مقابل حافة wrap `31`)؛ كامل محتوى الحقل ظاهر ولا يوجد قصّ بكسل عملي، وهي ملاحظة subpixel غير مانعة.
  3. في الخطوتين بقي `document clientWidth=scrollWidth=390`، والتمرير داخلياً `wrap 328 < 700`.
- نهايتا التمرير:
  1. عند نهاية RTL (`scrollLeft=-372`) ظهر عمود الإجمالي كاملاً `98.016/98.016px` وصفر تداخل مع الاسم الثابت.
  2. بعد الرجوع إلى `scrollLeft=0` عاد عمود البحث كاملاً `153.078/153.078px` وحقل البحث `141.078/141.078px`، وصفر تداخل مع الاسم.
- قائمة الاقتراحات: ظهرت فعلياً بالنص والسعر، وطبقتها `z-index:1200` مقابل `2` للعمود الثابت؛ لذلك ترتيب الرسم فوقه صحيح. لم تتقاطع المستطيلات هندسياً في هذه اللقطة تحديداً، فتُسجّل هذه كملاحظة غير مانعة لا كفشل.
- 1440×900: الخلية والرأس `position:static`، خلية البيانات `background:transparent` و`background-image:none` و`box-shadow:none`، والرأس بلا ظل. الاسم كامل والخلية ظاهرة، والجدول `1074/1074` والصفحة `1440/1440`. صفر أخطاء JavaScript.
- نهايات الأسطر: قبل الكوميت كان `src/styles.css` يحوي 2573 CRLF و830 LF منفرداً؛ بعده بقيت CRLF عند 2573 وصارت LF المنفردة 865، أي أضيفت 35 LF فقط. `git diff --numstat` يعيد `35 0` للملف؛ لا تحويل جماعي لنهايات الأسطر.
- Checks: `npm.cmd run check` ناجح (`Project check passed`)، و`git diff --check` و`git diff --check bfbe8ff^..bfbe8ff` نظيفان. أُزيل اختبار Playwright المؤقت وأُغلق خادم الاختبار.
- Boundaries: مراجعة فقط؛ لا commit/push/merge ولا pull/fetch ولا مزامنة ولا تعديل أسعار أو مخزون. التغيير الوحيد الحالي هو هذا السجل.
- Handoff UTC: 2026-07-25T07:23:38.3039824Z

## 2026-07-25 - Codex - مراجعة مستقلة لإصلاح عمود اسم الصنف بعد PR #24 (7345355)

- Status: **مانع في شرط القبول — الإصلاح لا يمنع قصّ الاسم المرئي على iPhone بعد اعتماد الصنف**. الخلية نفسها أصبحت بعرض صحيح والنص غير مبتور داخلها، لكن انتقال التركيز التلقائي إلى حقل الكمية يحرّك الجدول أفقياً فتخرج معظم خلية الاسم خارج نافذة الجدول على 390px، ولا تُرى كاملة بلا تمرير يدوي.
- Target: `main` عند `73453550be538e748568c18c78ab955b0d612117` بالضبط، بعد دمج PR #24 في `b392202` والإصلاح التنفيذي `3785030`. بدأ وانتهى الفحص على هذا الرأس.
- النطاق: القاعدتان موجودتان فعلاً في `src/styles.css`: `.sales-table { min-width: 700px; }` و`.sales-cell-name { min-width: 170px; }`. `index.html` يشير إلى `tobacco-105` و`public/service-worker.js` إلى `web-platform-tobacco-v371`.
- تنظيف الكاش والتحقق من النسخة — نُفّذ قبل قياس الواجهة:
  1. جرى تجهيز كاش قديم اختباري `v370` مع تسجيل Service Worker واحد لإثبات أن مسار التنظيف يعمل؛ قبل المسح ظهرت المفاتيح `v371` و`v370`.
  2. أُلغي تسجيل Service Worker وحُذفت كل Cache Storage وlocal/session storage: بعد المسح `registrations=0` و`cacheKeys=[]`.
  3. بعد إعادة التحميل ظهر تسجيل واحد وكاش `v371` فقط. حُمّلت `src/styles.css?v=tobacco-105` وكل JS ذي النسخة `tobacco-105`، وصفر موارد `tobacco-104`.
  4. قياسات DOM اللاحقة استعملت Service Worker محجوباً مع تأكيد رابط `tobacco-105` داخل كل viewport، كي يستحيل تدخل كاش قديم.
- 390×844 — **فشل شرط ظهور الخلية بلا تمرير**:
  1. أُدخل الصنف العربي الطويل `ماستر كوين سوبر سليم أزرق إصدار خاص طويل للاختبار` بالرقم 900 واعتمد بـEnter.
  2. النص في DOM مطابق حرفياً، ويلتف داخل خلية الاسم بلا ellipsis أو `overflow:hidden`: عرض الخلية `170px` و`clientWidth=scrollWidth=170`، ومستطيلات النص كلها داخل حدود الخلية. أي أن قاعدتي PR #24 منعتا انضغاط الخلية الداخلي.
  3. لكن اعتماد الصنف ينقل التركيز إلى الكمية؛ هذا حرّك `.inv-table-wrap` تلقائياً من `scrollLeft=0` إلى `-274`. حدود الـwrap `31..359px`، بينما خلية الاسم صارت `309.92..479.92px`: المرئي منها نحو `49px` فقط من أصل `170px`، ومعظم النص يقع خارج نافذة الـwrap. النتيجة المرئية هي قصّ الاسم ويتطلب تمريراً أفقياً يدوياً لرؤيته، خلاف الشرط الصريح.
  4. التمرير نفسه داخلي كما يجب: `wrap clientWidth=328 < scrollWidth=700`، بينما الصفحة سليمة `document clientWidth=scrollWidth=390`.
- 1440×900 — ناجح: الخلية بعرض `443.53px` وحدودها `503.47..947px` داخل الـwrap `53..1127px`، والاسم كامل على سطر واحد، بلا قص أو تمرير. الصفحة `1440/1440` ولا أخطاء JavaScript.
- التصنيف وفق شرط القبول: ليست مشكلة كاش ولا انضغاطاً داخلياً للخلية؛ لكنها **قصّ فعلي مرئي للاسم على 390px** لأن autofocus للكمية يغيّر موضع التمرير ويخرج الاسم من النافذة. لذلك تُسجّل كمانع، بينما نجاح التمرير الداخلي وعدم overflow الصفحة لا يلغيان هذا المانع.
- Checks: `npm.cmd run check` ناجح (`Project check passed`)، و`git diff --check` و`git diff --check 3785030^..3785030` نظيفان. أُزيل اختبار Playwright المؤقت وأُغلق خادم الاختبار.
- Boundaries: مراجعة فقط؛ لا commit/push/merge ولا pull/fetch ولا مزامنة ولا تعديل أسعار أو مخزون. التغيير الوحيد الحالي هو هذا السجل.
- Handoff UTC: 2026-07-25T07:04:16.4104965Z

## 2026-07-25 - Claude - تحقّق مستقل بعد الدمج: حد مركز شريفة ولوحة رصيد الفاتورة

- Status: **لا مانع** — كل البنود الستة نجحت. مراجعة قراءة فقط: بلا commit ولا push ولا merge ولا مزامنة ولا لمس أسعار.
- ملاحظة على الحالة: الفرع `feat/invoice-customer-balance` كان قد **دُمج فعلاً** في `main` عبر PR #23 (`5e7efdb`) أثناء بدء هذه المراجعة، فجرى الفحص على الكود المدمج (محتوى `src/app.js` متطابق بايت-ببايت بين الفرع و`main`).
- ١) لوحة الفاتورة حياً (التطبيق المحلي 5173، الدوال الحقيقية `salesCustomerPanel()`/`applyCustomerLimits()`/`findBalanceCustomerByText()`، بيانات مطابقة حرفياً لما في القاعدة، بلا أي كتابة):
  - الحد `$25,000.00` والرصيد الحالي `$10,518.86` يظهران فعلاً، وآخر دفعة `$300.00 — 2026-07-20`.
  - أجل بمتبقّي `$20,000` ← متوقّع `$30,518.86` ← `⛔ سيتجاوز حدّه الائتماني ($25,000.00) بـ$5,518.86` (الصنف `sales-cust-warn over`، اللون `rgb(184,50,40)`).
  - أجل بمتبقّي `$12,500` ← متوقّع `$23,018.86` ← `⚠ سيقترب… المتاح $1,981.14`.
  - أجل بمتبقّي `$3,000` ← متوقّع `$13,518.86` ← بلا تحذير (ضمن الحد).
  - نقدي بصافي `$20,000` ← المتبقّي صفر ← المتوقّع = الرصيد الحالي ← بلا تحذير. صحيح محاسبياً.
  - المفرق: فاتورة `268,000,000 ل.س` على صرف `13,400` ← متوقّع `$30,518.86` و`⛔` — التحويل للدولار يعمل.
  - زبون غير مطابق ← رسالة «زبون غير مطابق في كشف الأرصدة». خانة فارغة ← لا لوحة.
- ٢) بلا ترحيل بيانات — مؤكَّد من القاعدة مباشرة (SELECT فقط):
  - `customer_credit_limits`: المفتاح ما زال `مركز شريفة اسعد شريفة` (بالتاء المربوطة)، الحد `25000.000`، آخر تحديث `2026-05-17`.
  - أحدث `ameen_customer_balances` (`2026-07-25 06:33`): المفتاح `مركز شريفه اسعد شريفه` (بالهاء)، الرصيد `10518.86`، حد الأمين `0`.
  - `customerLimitMap()` أنتج المفتاح `مركز شريفه اسعد شريفه` فارتبط السجل القديم بلا أي تعديل عليه.
  - حجم الأثر: الجدول فيه 3 سجلات فقط، واحد بحد موجب، وواحد يحتاج تطبيعاً — هو شريفة نفسه.
- ٣) حفظ حد جديد يطبّع: `saveCustomerLimit()` → `normalizeItemName(form.dataset.customerKey || customerName)` ثم `upsert` على `onConflict: customer_key`. فحص كود فقط — لم يُحفظ أي سجل إنتاجي.
- ٤) صفحة الأرصدة صارت تطبّق الحد: `customerBalancesPage()` → `customerBalanceSection()` → `applyCustomerLimits()`، وأظهرت لشريفة `creditLimit=25000`، `limitSource=internal`، `remainingLimit=14481.14`.
  - `over_limit`/`near_limit` **لا تنطبق على شريفة**: رصيده `10,518.86` = ٤٢٪ من حده. تحققت الحالتان بزبونين مصطنعين: رصيد `30,000` ← `over_limit` (المتبقّي `-5,000`)، ورصيد `21,000` ← `near_limit` (المتبقّي `4,000`).
- ٥) الحدود الصفرية: حد `0` ← «بلا حد محدّد» ولا تحذير حتى مع متوقّع `$109,518.86`. سليم.
- ٦) `npm run check` نجح في الـworktree وفي `main` كليهما، و`git diff --check` نظيف (على العمل الحالي وعلى الفرق المدمج `8f955b3..24530ef`). القياسات: على 1440×900 اللوحة `320px` بلا قصّ وبلا تمرير أفقي؛ على 390×844 تتوسّع إلى `328px` (كامل عرض الحاوية) والتحذير يلتف على سطرين (`46px`) بلا قصّ وبلا تمرير أفقي. `CACHE_NAME=v370` و`styles.css?v=tobacco-104` مرفوعان.

### ثلاث ملاحظات غير مانعة (للنظر لاحقاً، لم يُعدَّل شيء)

1. **عتبتان مختلفتان للاقتراب من الحد:** صفحة الأرصدة تحذّر عند ٨٠٪ (`deriveCustomerStatus`: `balance >= limit * 0.8`) بينما لوحة الفاتورة عند ٩٠٪ (`projected >= limit * 0.9`)، وإشعار تيليغرام موثّق بـ٩٠٪. النتيجة: زبون على ٨٥٪ يظهر «قريب من الحد» في صفحة الأرصدة ولا يعطي `⚠` في الفاتورة. يُستحسن توحيد الرقم بمكان واحد.
2. **خطر سجل مكرّر عند أول تعديل لحد شريفة:** الحفظ الجديد سيكتب مفتاحاً مطبّعاً (بالهاء) ولن يطابق `onConflict` السجل القديم (بالتاء)، فيصبح للزبون سجلان. الصواب يظل صحيحاً اليوم فقط لأن جلب القائمة مرتّب `updated_at` تنازلياً و`customerLimitMap()` يحتفظ بأول ظهور (`if (!map.has(key))`) — أي أن الأحدث يفوز. تحقّقت من الاتجاهين حياً: الأحدث أولاً ← `40000`، والقديم أولاً ← `25000`. الاعتماد على ترتيب الاستعلام غير موثّق في الكود، ويكفي تنظيف السجل الوحيد غير المطبّع لإزالة الهشاشة.
3. **فرع سعر صرف = صفر:** في المفرق لو كان `syriaExchangeRate = 0` يصبح متبقّي الفاتورة بالدولار صفراً فيختفي التحذير بصمت. عملياً محجوب — نشر النشرة يرفض `rate <= 0` وحوار الصرف يفرض `|| 1` — فهو احتياطي نظري لا عطل قائم.

## 2026-07-25 - Codex - إعادة مراجعة تطبيع حد مركز شريفة (e1eeaa6)

- Status: ready to merge from the reviewed scope — **لا يوجد مانع متبقٍ**. أُغلق مانع ربط حد «مركز شريفة» حياً، ونجحت المقارنة والتحذيرات وصفحة الأرصدة على المقاسين المطلوبين.
- Target: `feat/invoice-customer-balance` عند `e1eeaa6d76d2f8677de355ed34127ae4e1f7074f` بالضبط. بدأ وانتهى الـworktree على هذا الرأس.
- الدليل الحي بلا ترحيل أو كتابة:
  1. أحدث تقرير `ameen_customer_balances` وقت الفحص (`54f317f9-c9bd-4fb4-a793-c1287b42a4db`، `2026-07-25T05:44:15.815331Z`) ما زال يحمل المفتاح المطبّع `مركز شريفه اسعد شريفه` والرصيد `$10,518.86`.
  2. سجل `customer_credit_limits` ما زال فعلياً بالمفتاح القديم غير المطبّع `مركز شريفة اسعد شريفة` وحده `$25,000`: `exact_match=false` و`normalized_match=true`. لم يُرحّل السجل، ومع ذلك ربطه الكود بعد أن صار `customerLimitMap()` يطبّع المفتاح المحفوظ و`applyCustomerLimits()` يطبّع مفتاح التقرير عند البحث.
  3. جميع استعلامات Supabase كانت `SELECT` فقط. التقرير يحوي 287 زبوناً، صفر حدود موجبة من الأمين، وحداً موجباً داخلياً واحداً مرتبطاً، و286 زبوناً بلا حد فعلي.
- لوحة الفاتورة بالقيم الحية:
  1. كتابة «مركز شريفة» أظهرت الحد `$25,000.00` والرصيد الحالي `$10,518.86`.
  2. فاتورة أجل متبقّيها `$10,000` أعطت رصيداً متوقعاً `$20,518.86` وبقيت ضمن الحد بلا تحذير.
  3. فاتورة أجل متبقّيها `$15,000` أعطت `$25,518.86` وأظهرت `⛔` وقيمة تجاوز `$518.86`؛ أي أن المقارنة تتم فعلياً مع الحد المرتبط وعلى الرصيد المتوقع.
  4. تحديث اسم الزبون والسعر بقي جراحياً بلا فقدان التركيز.
- حفظ حد جديد: `saveCustomerLimit()` يمرر `form.dataset.customerKey || customerName` عبر `normalizeItemName()` قبل `upsertCustomerCreditLimit`. محاكاة كاملة دون قاعدة بيانات بدأت بالمفتاح غير المطبّع `مركز شريفة اسعد شريفة` والتقطت payload محفوظاً بالمفتاح `مركز شريفه اسعد شريفه`.
- صفحة الأرصدة:
  1. السجل الحي عرض `الحد: 25,000` و`المصدر: حد داخلي` وطبّق الحد على الرصيد.
  2. محاكاة الرصيد `$26,000` أظهرت `over_limit`/«تجاوز الحد» مع تنسيق الصف السلبي، ومحاكاة `$21,000` أظهرت `near_limit`/«قريب من الحد» مع تنسيق الاقتراب. الرصيد الحي `$10,518.86` بقي `open_balance` كما يجب.
  3. حد صريح بقيمة صفر ظهر «بلا حد محدّد» ولم ينتج أي تحذير؛ وهذا متسق مع 286/287 زبوناً بلا حد فعلي.
- اختبار الواجهة: على 390×844 كانت الفاتورة وصفحة الأرصدة `clientWidth=390` و`scrollWidth=390`. وعلى 1440×900 كانتا `1440/1440`. نجحت الحالات نفسها بلا أخطاء JavaScript. الاختبار استخدم التطبيق المحلي عند هذا الرأس مع dataStore قرائي محاكى بالقيم المستخرجة فوراً من Supabase، وحالات الفاتورة/الحالة المصطنعة فقط لتجنب أي حفظ إنتاجي.
- Checks: `npm.cmd run check` ناجح (`Project check passed`) و`git diff --check` نظيف قبل إضافة هذا السجل. أُزيل اختبار Playwright المؤقت وأُغلق خادم الاختبار.
- Boundaries: لا commit/push/merge ولا pull/fetch ولا مزامنة ولا تعديل أسعار أو مخزون؛ التغيير الوحيد الحالي هو هذا السجل.
- Handoff UTC: 2026-07-25T05:45:06.1116738Z

## 2026-07-25 - Codex - إعادة مراجعة التصحيح التوثيقي للحدود (3b03fc2)

- Status: not ready to merge — `3b03fc2` توثيقي بحت والرقم 286/287 صحيح، لكن المانع البرمجي الحي المسجل في المراجعة السابقة ما زال قائماً؛ الكوميت لم يغيّر المنطق الذي يسبب عدم ربط الحد الوحيد الموجب.
- Target: `feat/invoice-customer-balance` عند `3b03fc2eb47ae4f73910810988f6dac4c9eaebec` بالضبط. بدأ وانتهى الـworktree على هذا الرأس.
- نطاق `3b03fc2`: `git show --stat` و`git diff --name-status 3b03fc2^..3b03fc2` يعرضان `AI_HANDOFF.md` فقط (28 سطراً مضافاً). لا فرق في `src/app.js` أو `src/styles.css` أو أي HTML/JS/CSS أو منطق أو بيانات.
- تصحيح الرقم ناجح: أحدث تقرير الأرصدة يحوي 287 زبوناً؛ `customer_credit_limits` يحوي 3 سجلات، واحد فقط `credit_limit>0`، وصفر حدود موجبة آتية من تقرير الأمين. النتيجة: زبون واحد له حد فعلي و286/287 بلا حد فعلي.
- إعادة الفحص السريع للوظائف:
  1. «ابو علي اسعد» ظهر برصيده `$27,867.24`، ومع فاتورة أجل متبقّيها `$100` صار المتوقع `$27,967.24`؛ أي ما زال يضيف المتبقّي لا الإجمالي.
  2. تحديث اسم الزبون بقي جراحياً والتركيز على `#sales-customer`، والاختبار 390×844 بقي بلا overflow (`scrollWidth=390`).
  3. نتائج النقدي/الأجل الجزئي/تحويل المفرق وحدود 90% و100% من المراجعة السابقة تبقى على الكود نفسه؛ لم يتغير أي سطر منطق بين `d0c1409` و`3b03fc2`.
- المانع ما زال قائماً بدليل حي محدث:
  1. أحدث تقرير `ameen_customer_balances` (`6ba5a7e0-cb4c-473b-b18b-c9e973291e77`، `2026-07-25T05:28:15.229179Z`) يحمل مفتاح `مركز شريفه اسعد شريفه`.
  2. سجل الحد الوحيد الموجب `$25,000` ما زال يحمل `مركز شريفة اسعد شريفة`: `exact_match=false` و`normalized_match=true`.
  3. `customerLimitMap()` ما زال يخزن `limit.customerKey` خاماً، و`customerKey(item)` يعيد `item.key` الخام. اختبار الواجهة بالقيم الحية أظهر «بلا حد محدّد» لمركز شريفة، لذلك لا يعمل تحذير الحد على الزبون الوحيد ذي حد فعلي.
- Checks: `npm.cmd run check` ناجح (`Project check passed`)، و`git diff --check 3b03fc2^..3b03fc2` و`git diff --check` نظيفان قبل إضافة هذا السجل. أُزيل اختبار Playwright المؤقت وأُغلق سيرفر المنفذ 18858.
- Boundaries: لا commit/push/merge ولا pull/fetch ولا مزامنة ولا تعديل أسعار؛ التغيير الوحيد الحالي هو هذا السجل.
- Handoff UTC: 2026-07-25T05:29:52.2086279Z

## 2026-07-25 - Codex - مراجعة رصيد الزبون وحد الائتمان داخل الفاتورة (d0c1409)

- Status: not ready to merge — الحسابات وتحديث الواجهة صحيحة، لكن يوجد **مانع P1 حيّ**: حد «مركز شريفة» الوحيد الموجب (`$25,000`) لا يرتبط بسجل رصيده بسبب اختلاف تطبيع `customer_key`، فتظهر اللوحة «بلا حد محدّد» ولا يعمل أي تحذير حد للزبون الوحيد ذي حد فعّال.
- Target: `feat/invoice-customer-balance` عند `d0c14090d5f624a1aa7aedce0a8db203e530504a` بالضبط، مطابق للرأس المحلي المطلوب. بدأ وانتهى الـworktree على هذا الرأس.
- النطاق والسلامة:
  1. الكوميت يغيّر أربعة ملفات فقط: `src/app.js` و`src/styles.css` ونسخ الأصول في `index.html` و`public/service-worker.js` (`CACHE_NAME=v369`). لا مصدر بيانات جديد ولا تعديل في `src/supabase-client.js`.
  2. `salesCustomerPanel()` يعيد استعمال `findBalanceCustomerByText` و`customerBalance` و`customerLimit` و`customerLastPaymentAmount`، ويُحمّل الرصيد والحد عبر المسارات الموجودة مسبقاً.
  3. لا تغيير في أسعار أو مخزون أو أدوات مزامنة؛ استعلامات Supabase في المراجعة كانت `SELECT` فقط.
- الصحة المحاسبية — ناجحة:
  1. على رصيد «ابو علي اسعد / جرمانا» الحي `$27,867.24`: فاتورة نقدية إجماليها `$200` وحسمها `$20` جعلت المدفوع `$180` والمتبقّي `$0`، فبقي الرصيد المتوقع `$27,867.24`.
  2. الفاتورة نفسها عند تحويلها إلى أجل بلا دفعة أعطت متبقّياً `$180` ورصيداً `$28,047.24`. مع دفعة `$80` صار المتبقّي `$100` والرصيد `$27,967.24`؛ أي أضيف المتبقّي لا الإجمالي. تغيير الكمية جعل المتبقّي `$200` والرصيد `$28,067.24`.
  3. المفرق نجح برقم فعلي وسعر الصرف المنشور `13,400 ل.س/$`: متبقّي `67,000 ل.س ÷ 13,400 = $5`، فتحوّل الرصيد من `$27,867.24` إلى `$27,872.24`.
  4. حد صفر لم ينتج أي تحذير. بيانات Supabase الحالية: 287 زبوناً وثلاثة سجلات في `customer_credit_limits`، لكن اثنين منها صفر وواحد فقط موجب؛ لذلك العدد الفعلي بلا حد هو 286/287، لا 284/287 الوارد في رسالة الكوميت.
  5. عند حد مطابق معزول `$1,000`: لا تحذير عند `$899.99`، تحذير اقتراب عند `$900.00` (90% بالضبط)، بقي اقتراباً عند `$1,000.00`، وصار تجاوزاً عند `$1,000.01`. الشروط `> الحد` و`≥90%` صحيحة.
- المانع P1 — مطابقة الحد الحي:
  1. أحدث تقرير أرصدة حي (`ec48053f-e57b-4ee5-8189-11e89ecc1acc`، `2026-07-25T05:19:13.7265Z`) يحمل مفتاح مركز شريفة `مركز شريفه اسعد شريفه`.
  2. سجل الحد الموجب في `customer_credit_limits` يحمل `مركز شريفة اسعد شريفة`. الاستعلام أثبت `exact_key_match=false` ونجاح المطابقة فقط بعد تحويل `ة→ه`.
  3. `customerLimitMap()` يخزن `String(limit.customerKey)` خاماً، و`customerKey(item)` يعيد `item.key` الخام؛ لذلك `applyCustomerLimits()` لا يجد السجل. اختبار المتصفح بالقيم الحية أظهر «بلا حد محدّد» بدلاً من `$25,000`.
  4. النتيجة العملية: لا يوجد حالياً أي زبون يرتبط بحد موجب، فتنجح صيغة التحذير نظرياً فقط ولا تعمل على بيانات الإنتاج الحالية. يلزم تطبيع مفتاحي الخريطة والبحث بالمنطق نفسه.
- الواجهة:
  1. كتابة «ابو علي اسعد» حرفاً حرفاً أبقت التركيز على `#sales-customer` في 12/12 حدثاً على المقاسين. تحديثات الكمية والسعر والحسم والدفعة بقيت جراحية عبر `refreshSalesTotals()` بلا `render`.
  2. الاسم غير المطابق عرض «زبون غير مطابق في كشف الأرصدة — لن يظهر رصيد سابق.» بلا أي رقم مختلق، وبقي التركيز ثابتاً في 21/21 حدثاً.
  3. 390×844: `document.scrollWidth=390`، الجدول يتمرر داخلياً `328 < 463`، ولوحة الزبون بعرض 328 ضمن `31..359px`.
  4. 1440×900: `document.scrollWidth=1440`، والجدول `1074/1074`، ولوحة الزبون بعرض 320 ضمن الشاشة. لا أخطاء page/console.
- Checks: `npm.cmd run check` ناجح (`Project check passed`)، و`git diff --check d0c1409^..d0c1409` و`git diff --check` نظيفان قبل إضافة هذا السجل. أُزيل اختبار Playwright المؤقت وأُغلق سيرفر المنفذ 18857.
- Boundaries: لا commit/push/merge ولا pull/fetch ولا مزامنة ولا تعديل أسعار؛ التغيير الوحيد الحالي هو هذا السجل.
- Handoff UTC: 2026-07-25T05:23:02.1010524Z

## 2026-07-25 - Codex - إعادة مراجعة الكميات الكسرية وتوحيد «مخزون النشرة» (3fcbcca)

- Status: ready from the reviewed scope — **لا يوجد مانع متبقٍ** وفق شرط القبول المصحح. كل كمية مستودع وكل كمية «مخزون النشرة» الحية تُفك من النص إلى قيمتها الحقيقية بفارق `0` (المطلوب ≤`0.005`)، ولا توجد أجزاء صفرية ملتبسة.
- Target: `feat/item-details-panel` عند `3fcbccac20f587ea8f01c14d3dc2059f5c2fce92` بالضبط. بدأ وانتهى الـworktree على هذا الرأس.
- النطاق: فرق `280cde5..3fcbcca` ملفان فقط: سجل `AI_HANDOFF.md` السابق وتعديل 4 أسطر/4 أسطر في `src/app.js`. التغيير يحفظ باقي الكمية حتى خانتين عشريتين، ويحذف formatter المنفصل لسطر «مخزون النشرة» ويستعمل `fmtQty` نفسها. لا تغيير في CSS أو أدوات المزامنة أو الأسعار.
- التحقق العكسي على البيانات الحية:
  1. أحدث تقرير `ameen_item_details` (`b5ed6988-5dbd-4ec5-87c3-ac7350bf3ec5`، `2026-07-25T03:55:06.225711Z`) يحوي 399 صنفاً و386 سطر مستودع غير صفري؛ فُك نص كل سطر إلى `كراتين×المعامل + كروز` مع الإشارة: 386/386 صحيحة، وأقصى فرق `0`.
  2. فُحصت أسطر «مخزون النشرة» لكل 316 صفاً حياً في `approved_price_items`: 316/316 صحيحة، وأقصى فرق `0`. المجموع الكلي للتحقق النصي 702 سطر كمية.
  3. الأسطر الكسرية العشرة السابقة كلها صحيحة: `53.88/50 → 1 كرتونة + 3.88 كروز`، `0.8/25 → 0.8 كروز`، وكذلك 33.5 و56.76 و115.3 و26.4 و552.04 و46.6 و49.9 و574.8، وكلها أعادت القيمة الأصلية بفارق `0`.
  4. الصفوف الـ63 الحية التي كان مخزونها موجباً وأقل من معامل الكرتونة لم تعد تعرض `0 كرتونة + …`. عبر 386 سطر مستودع + 316 سطر نشرة: صفر ظهور لجزء أول صفري مع `+`، وصفر ظهور لـ`−0`.
- وحدة منطق العرض: يوجد تعريف واحد فقط لـ`fmtQty` داخل البطاقة وثلاثة مستهلكين له: سطر المستودع، سطر مجموع المستودعات، وسطر «مخزون النشرة». أزيل الحساب المنفصل السابق لـ`cartons/loose`.
- الاتساق والفصل:
  1. جميع الأصناف الـ242 ذات أسطر مستودعات متسقة: مجموع القيم المفكوكة من الأسطر يساوي مجموع المستودعات المعروض والحقيقي؛ 242/242 ناجحة وأقصى فرق `0`، بما فيها السوالب.
  2. «مخزون النشرة» و«مجموع المستودعات» ما زالا عنوانين ورقمين مستقلين، والمجموع مشتق حصراً من أسطر تقرير المستودعات.
  3. المطابقة بعد التطبيع بقيت 316/316 بين صفوف النشرة وتقرير التفاصيل.
- P1-1 بقي مغلقاً:
  1. `salesUnitCost()` يقرأ عبر `itemCostFor()`/`item_costs` فقط؛ لا توجد قراءة تكلفة من تقرير `inventory_reports`.
  2. أحدث تقرير التفاصيل خالٍ من أي مفتاح تكلفة/ربح (`AvgPrice`/`LastPrice`/cost/profit/margin = صفر مفاتيح)، و`push-item-details.ps1` يقرأ `item_number/item_name/unit2_factor/store_name/store_qty` فقط.
  3. محاكاة RLS بدور `authenticated` غير مالك أعادت `is_owner=false` وصفر صفوف مرئية من `item_costs`. في اختبار الواجهة لم تُستدعَ `listItemCosts` للموظف وعُرض صفر صفوف تكلفة وصفر صفوف ربح أو قيم مالية؛ المالك وحده استدعاها ورأى الصفوف.
- اختبار الواجهة:
  1. 390×844: `document.scrollWidth=390`، والجدول يتمرر داخلياً (`clientWidth=328 < scrollWidth=458–461`)، والبطاقة ضمن `16..374px`. ظهرت 53.88 و0.8 بقيمتيهما، وظهر السالب `− 9 كروز` بلونه، ونجح الفتح والإغلاق بالزر والخلفية.
  2. 1440×900: `document.scrollWidth=1440` و`wrap=1074/1074`، والبطاقة ضمن الشاشة. نجحت القيم نفسها والفتح والإغلاق.
  3. لا أخطاء تنفيذ في الصفحة؛ ظهر فقط تحذير CSP المعروف بأن `frame-ancestors` لا يُطبّق من `<meta>`.
- Checks: `npm.cmd run check` ناجح (`Project check passed`)، و`git diff --check 280cde5..3fcbcca` و`git diff --check` نظيفان قبل إضافة هذا السجل. أُزيل اختبار Playwright المؤقت وأُغلق سيرفر المنفذ 18856.
- Boundaries: لا commit/push/merge ولا pull/fetch ولا مزامنة ولا تعديل أسعار؛ التغيير الوحيد الحالي هو هذا السجل.
- Handoff UTC: 2026-07-25T04:54:41.8408323Z

## 2026-07-25 - Codex - مراجعة القيمة الحقيقية وحذف الأجزاء الصفرية (280cde5)

- Status: not ready to merge — تصحيح شرط القبول معتمد، وحذف الجزء الصفري من الموجب والسالب تحسين مقصود؛ لكن بقي مانعان حقيقيان: 10/366 أسطر موجبة كسرية تُقرَّب فلا تساوي القيمة الحقيقية، و`مخزون النشرة` ما زال يعرض `0 كرتونة + …` في 63 صفاً حياً.
- Target: `feat/item-details-panel` عند `280cde5301da005ca596669016852234c7e7bf25` بالضبط، مطابق لـ`origin/feat/item-details-panel`. بدأ وانتهى الـworktree على هذا الرأس.
- النطاق: `280cde5` يضيف سجل مراجعة `e17432b` السابق ويعدّل تعليق `fmtQty` فقط لتوثيق القرار المصحح؛ لا يغيّر المنطق التنفيذي ولا CSS ولا المزامنة أو الأسعار.
- تحقق أسطر المستودعات:
  1. التقرير الحي يحتوي 386 سطر مستودع غير صفري: 366 موجباً و20 سالباً.
  2. كل الأسطر العشرين السالبة صحيحة حسابياً؛ ولا يظهر `−0`. ومن 366 موجباً، 356 صحيحة تماماً و10 تُقرَّب بسبب `Math.round(abs - c*factor)`.
  3. أمثلة الفشل الحية: `53.88/50` تُعرض `1 كرتونة + 4 كروز = 54`؛ `33.5/12 → 34`؛ `0.8/25 → 1 كروز`؛ `46.6/50 → 47 كروز`. جميع الفروقات العشرة موثقة من التقرير الحالي.
  4. داخل أسطر المستودعات نفسها: صفر ظهور لـ`0 كرتونة +` وصفر ظهور لـ`−0` في 386/386.
- الجزء الصفري خارج أسطر المستودعات:
  1. سطر `مخزون النشرة` يستعمل formatter منفصلاً يبدأ دائماً بعدد الكراتين؛ لذلك يبقى `0 كرتونة + 9 كروز` عند مخزون أقل من معامل الكرتونة.
  2. استعلام حي على `approved_price_items` وجد 63 صفاً موجباً بهذه الحالة. وأكّد المتصفح حالة `9/24`: سطر المستودع `9 كروز` لكن سطر `مخزون النشرة` بقي `0 كرتونة + 9 كروز`.
- الاتساق:
  1. الاتساق الداخلي ناجح 242/242: مجموع الأسطر **المقربة المعروضة** يساوي `مجموع المستودعات` المعروض.
  2. لكنه لا يساوي المجموع الحقيقي في 10/242 أصناف كسرية؛ مثال #127 مجموع حقيقي `503.88` ويعرض `10 كرتونة + 4 كروز = 504`.
  3. `مخزون النشرة` و`مجموع المستودعات` ما زالا منفصلين اسماً ورقماً.
- P1-1 بقي مغلقاً: تقرير `ameen_item_details` الحالي 399 صنفاً و`stores_only_no_cost` بلا أي مفتاح تكلفة/ربح؛ محاكاة RLS غير المالك أعادت صفر صف من `item_costs`. واجهة الموظف لم تستدعِ `listItemCosts` وعرضت صفر صفوف تكلفة وربح، بينما المالك وحده رآها.
- اختبار الواجهة:
  1. 390×844: `scrollWidth=390`، البطاقة ضمن `16..374px`، وتمرير الجدول داخلي `328 < 458`. الفتح والإغلاق بلا أخطاء page.
  2. 1440×900: `scrollWidth=1440` وwrap/table=`1074px` والبطاقة ضمن الشاشة. ظهرت حالة التقريب نفسها كما هو متوقع من الكود.
  3. تنسيق السالب والمجموع ما زال فعلياً: لون السالب `rgb(184, 50, 40)` مقابل الموجب `rgb(34, 24, 8)`، والمجموع بحد متقطع ووزن `700`.
- Checks: `npm.cmd run check` ناجح (`Project check passed`)، و`git diff --check e17432b..280cde5` و`git diff --check` نظيفان قبل إضافة هذا السجل. أُزيل اختبار Playwright المؤقت وأُغلق سيرفر المنفذ 18855.
- Boundaries: لا commit/push/merge ولا pull/fetch ولا مزامنة ولا تعديل أسعار؛ التغيير الوحيد الحالي هو هذا السجل.
- Handoff UTC: 2026-07-25T04:30:49.1878221Z

## 2026-07-25 - Codex - إعادة مراجعة صيغة السالب وتنسيق المستودعات (e17432b)

- Status: not ready to merge under the stated acceptance criteria — ملاحظتا السالب وCSS أُغلقتا فعلياً، لكن شرط «الموجب لم يتغيّر» غير محقق نصياً: 117 من 366 سطر مستودع موجب حيّ حُذفت منها بادئة `0 <الوحدة الثانية> +`.
- Target: `feat/item-details-panel` عند `e17432b3a612e9f4b08ccb777bbfb499927a8c54` بالضبط، مطابق لـ`origin/feat/item-details-panel`. بدأ وانتهى الـworktree على هذا الرأس.
- النطاق: `e17432b` يضيف سجل مراجعة `955ec29` السابق، ويعدّل `fmtQty` في `src/app.js` ويضيف تنسيق السالب والمجموع في `src/styles.css`. لا تغييرات مزامنة أو أسعار أو قاعدة بيانات.
- صيغة السالب:
  1. أُعيد فحص الأسطر السالبة العشرين نفسها من تقرير `ameen_item_details` الحي؛ كلها أعادت القيمة المطلقة الصحيحة وصفر ظهور لـ`−0`.
  2. أمثلة فعلية/معزولة على الدالة الحالية: `-9/24 → − 9 كروز`، `-50/50 → − 1 كرتونة`، `-64/50 → − 1 كرتونة + 14 كروز`. ونجحت معاملات 12 و25 و40 و50، بما فيها `-64/40 → − 1 كرتونة + 24 كروز`.
  3. انحراف الموجب: الدالة الجديدة تبني الأجزاء الموجودة فقط لكلا الإشارتين. لذلك موجب `9/24` صار `9 كروز` بعد أن كان في `955ec29` يعرض `0 كرتونة + 9 كروز`. هذا وقع في 117/366 سطر موجب بالتقرير الحالي؛ القيمة الحسابية لم تتغير لكن النص تغيّر خلاف الطلب الصريح.
- التنسيق البصري:
  1. `.sales-info-store.neg strong` موجودة في `src/styles.css`. القياس الفعلي أعطى لون السالب `rgb(184, 50, 40)` مقابل الموجب `rgb(34, 24, 8)`؛ ليست مجرد class في DOM.
  2. سطر المجموع مميّز فعلياً: `border-top: 1px dashed`، و`font-weight:700`، و`padding-top:6px`.
- الاتساق:
  1. فحص جميع 242 صنفاً ذي مستودعات: صفر اختلاف بين مجموع الكميات المعروضة بعد التقريب ومجموع الأسطر المعروضة، بما فيها السالب.
  2. اختبار الواجهة أبقى `مخزون النشرة` و`مجموع المستودعات` عنوانين ورقمين منفصلين. مثال #105: `3 كرتونة − 9 كروز + 2 كرتونة = 4 كرتونة + 15 كروز`.
- P1-1 بقي مغلقاً:
  1. تقرير `ameen_item_details` الحي ما زال 399 صنفاً، `stores_only_no_cost`، ولا يحوي أي مفتاح تكلفة أو ربح.
  2. محاكاة RLS لدور `authenticated` غير مالك أعادت 0 صف من `item_costs`. وفي الواجهة لم يُستدعَ `listItemCosts` للموظف وظهرت صفر صفوف تكلفة وصفر صفوف ربح؛ المالك وحده رأى صفوفهما.
- اختبار الواجهة:
  1. 390×844: `document.scrollWidth=390`، البطاقة ضمن `16..374px`، والجدول يتمرر داخلياً `328 < 458`. نجح فتح البطاقة وإغلاقها ولا أخطاء page.
  2. 1440×900: `document.scrollWidth=1440`، wrap/table=`1074px`، والبطاقة ضمن الشاشة. التنسيق والصلاحيات والاتساق نفسها ناجحة.
- Checks: `npm.cmd run check` ناجح (`Project check passed`)، و`git diff --check 955ec29..e17432b` و`git diff --check` نظيفان قبل إضافة هذا السجل. أُزيل اختبار Playwright المؤقت وأُغلق سيرفر المنفذ 18854.
- Boundaries: لا commit/push/merge ولا pull/fetch ولا مزامنة ولا تعديل أسعار؛ التغيير الوحيد الحالي هو هذا السجل.
- Handoff UTC: 2026-07-25T04:23:13.3467206Z

## 2026-07-25 - Codex - إعادة مراجعة إغلاق مانعي معلومات الصنف (955ec29)

- Status: not ready to merge — **P1-1 أُغلق أمنياً، لكن P1-2 لم يُغلق بالكامل**: المجموع الخام للمستودعات صحيح، إلا أن 15 من 20 سطر مستودع سالب ذي باقي وحدة أولى يُعرض بصيغة موجبة ملتبسة مثل `−0 كرتونة + 9 كروز`، وكلاس `neg` لا يملك قاعدة CSS تميّزه لونياً.
- Target: `feat/item-details-panel` عند `955ec29bbdb228cc1fdc254b0de52eb0b3fe0c77` بالضبط، وأبوه `d156b92`. بدأ وانتهى الـworktree على هذا الرأس، مطابقاً لـ`origin/feat/item-details-panel`.
- النطاق والسلامة:
  1. `d156b92` غيّر `AI_HANDOFF.md` و`src/app.js` و`tools/push-item-details.ps1` فقط؛ `955ec29` كوميت بلا فرق ملفات لتوثيق تنظيف البيانات الحي. `tools/ameen-sync-agent.ps1` لم يُلمس.
  2. لا commit/push/merge ولا pull/fetch ولا مزامنة ولا تعديل أسعار. استعلامات Supabase كانت SELECT/محاكاة RLS داخل transaction مع rollback فقط.
  3. `tools\push-item-details.ps1 -WhatIf` نجح: قرأ 399 صنفاً، 242 لها مخزون موزع، وخرج عند «لن يُكتب شيء». السكربت لا يحتوي `AvgPrice`/`LastPrice` ومسار الكتابة العادي الوحيد إلى `inventory_reports` بمصدر `ameen_item_details`.
- P1-1 — التكلفة للمدير فقط (ناجح):
  1. `salesUnitCost()` يقرأ حصراً عبر `itemCostFor()` من `state.itemCosts`; لا توجد قراءة `avgCost`/`lastCost` من `inventory_reports` في `app.js`. فتح البطاقة كموظف غير مالك لم يستدعِ `listItemCosts` أصلاً وعرض صفر صفوف تكلفة وصفر صفوف ربح؛ المالك استدعاها مرة وعرض التكلفة والربح.
  2. RLS الحي مفعّل على `item_costs` والسياسات الأربع `is_owner()`. محاكاة دور `authenticated` ببريد غير مالك أعادت 0/401 صفاً، ومحاكاة المالك أعادت 401/401.
  3. يوجد تقرير `ameen_item_details` واحد فقط حالياً، أنشئ `2026-07-25 03:55:06Z`: 399 صنفاً، مفاتيح العناصر فقط `key/name/num/stores/unit2Factor`، وصفر تقرير يحوي أي مفتاح تكلفة/ربح. التقرير المسرّب القديم غير موجود.
  4. ملاحظة UX غير أمنية: بطاقة الموظف ما زالت تعرض عبارة «لا توجد تكلفة مسجّلة لهذا الصنف في الأمين»؛ لا تكشف رقماً، لكنها تخالف معنى الإخفاء الكامل وتوحي خطأً أن التكلفة غير موجودة بدلاً من كونها محجوبة.
- P1-2 — المستودعات (فشل جزئي مانع):
  1. الفصل الاسمي ناجح: البطاقة تعرض `مخزون النشرة` و`مجموع المستودعات` كرقمين منفصلين، و`storesSum` محسوب حصراً بـ`reduce` من أسطر التقرير. فحص جميع 242 صنفاً ذي مستودعات أثبت أن مجموع العرض المدوّر يطابق مجموع أسطره في البيانات الحالية.
  2. أمثلة التقرير الحي: #357 = `−12 + 66 = 54`، #105 = `72 − 9 + 48 = 111`، #405 = `100 − 2 = 98`. المثال #357 يظهر سليماً `−1 شرحة` والمجموع `4 شرحة + 6 كروز`.
  3. الخلل: `fmtQty()` يضع إشارة السالب قبل عدد الوحدة الثانية فقط ثم يضيف الباقي بعلامة `+`. لذلك #105 يظهر `−0 كرتونة + 9 كروز` و#405 يظهر `−0 كرتونة + 2 كروز`، و#137 سيظهر `−1 كرتونة + 35 كروز` بدلاً من كمية سالبة كاملة. يوجد 15/20 سطر سالب بهذه الحالة؛ وهذا يكسر الاتساق الحسابي المقروء رغم أن `storesSum` الداخلي صحيح.
  4. الكود يضيف class باسم `neg`، لكن `src/styles.css` لا يحتوي `.sales-info-store.neg` ولا أي قاعدة عامة `.neg`؛ لذلك لا يوجد تمييز لوني فعلي للسطر السالب.
- الاختبار الحي المعزول على كود `955ec29`:
  1. 390×844: الصفحة بلا overflow (`scrollWidth=390`)، والجدول يتمرر داخلياً (`328 < 458–469`)، والبطاقة ضمن الشاشة (`left=16`, `right=374`, `width=358`). نجح فتح `i` والإغلاق بالزر والخلفية وبقي إدخال الكمية/Enter قابلاً للاستعمال.
  2. 1440×900: `scrollWidth=1440`، wrap/table كلاهما `1074`، والبطاقة ضمن الشاشة. نجح الفتح والإغلاق والإدخال. لا أخطاء page؛ تحذير CSP المعروف لـ`frame-ancestors` فقط.
  3. #105 و#405 ليسا حالياً ضمن `approved_price_items` برقميهما، لذلك اختُبر renderer لهما ببيانات التقرير الحية مع صف فاتورة معزول؛ #357 اختُبر بمطابقته الحية الموجودة.
- Checks: `npm.cmd run check` ناجح (`Project check passed`)، و`git diff --check aaa6aac..955ec29` و`git diff --check` نظيفان قبل إضافة هذا السجل. أُزيل ملف الاختبار المؤقت وأُغلق سيرفر المنفذ 18853.
- Handoff UTC: 2026-07-25T04:13:25.4953686Z

## 2026-07-25 - Codex - مراجعة معلومات الصنف والتكلفة والمستودعات (c3195fe + 24ccb4e)

- Status: not ready to merge — المطابقة والتكلفة والواجهة نجحت، لكن تحقق المخزون الحي فشل بسبب قدم `approved_price_items.stock_qty` وبقي تعارض بنيوي مع المستودعات السالبة، كما أن التكلفة/الربح مكشوفان لكل موظف مسموح لا للمدير فقط.
- Target reviewed: `feat/item-details-panel` عند `24ccb4e` (بعد `c3195fe`) ومبني من `origin/main` عند `b1aeea3`. بدأ الـworktree على هذا الهدف، ثم تقدّم بالتوازي أثناء المراجعة إلى `aaa6aac`؛ لذلك أُعيد اختبار الواجهة من snapshot معزول للكوميت `24ccb4e` نفسه، ولم تُخلط إضافة `aaa6aac` اللاحقة بنتيجة الهدف.
- النطاق والسلامة:
  1. `c3195fe` يضيف الميزة في ستة ملفات فقط؛ و`24ccb4e` يعدّل `src/app.js` وسطر `created_by` في `tools/push-item-details.ps1`. `tools/ameen-sync-agent.ps1` لم يُلمس إطلاقاً.
  2. مسار الكتابة الوحيد في `push-item-details.ps1` هو `POST /rest/v1/inventory_reports` بحمولة `source="ameen_item_details"`؛ لا توجد كتابة إلى `approved_price_items` ولا تعديل أسعار.
  3. تشغيل `tools\push-item-details.ps1 -WhatIf` نجح وخرج قبل المصادقة/REST: قرأ 399 صنفاً من الأمين، 380 لها تكلفة و242 لها توزيع مستودعات، وصرّح «لن يُكتب شيء».
- أساس التكلفة — تحقق SQL مستقل من الأمين:
  1. من آخر حركة ذات تكلفة لـ258 صنفاً بمعامل وحدة ثانية أكبر من 1: `UnitCostPrice` كان أقرب إلى `mt000.AvgPrice` في 258/258، وصفر أقرب إلى `AvgPrice×unit2Factor`; 256/258 تطابقت ضمن سنت واحد. متوسط الفرق عن AvgPrice كان `$0.000233` مقابل `$244.363010` عن أساس الكرتونة.
  2. النتيجة: `AvgPrice` تكلفة الوحدة الأولى (كروز/علبة)، وتكلفة الكرتونة = `AvgPrice × unit2Factor`.
  3. مقارنة خمسة أصناف مع سعر البيع في Supabase: #3 تكلفة `$260.84` مقابل بيع `$262` (ربح `$1.16`، 0.4%)؛ #50 بارسا `$260` مقابل `$245` (خسارة `$15`، −6.1%)؛ #136 `$252` مقابل `$360` (ربح `$108`، 30%)؛ #198 `$185` مقابل `$190` (ربح `$5`، 2.6%)؛ #273 `$339.24` مقابل `$350` (ربح `$10.76`، 3.1%).
  4. «بارسا» ليست تكلفة أمين خاطئة: فاتورة شراء الأمين #44 بتاريخ 2026-07-23 سجّلت `$260` للكرتونة و`UnitCostPrice=$5.20` للكروز، و`AvgPrice=LastPrice=$5.20`. آخر بيع بالأمين #194 كان `$265` للكرتونة. الخسارة ناتجة عن سعر Supabase الحالي `$245`؛ لم يُعدّل Codex السعر.
- المستودعات والمخزون:
  1. CTE `per_store` في السكربت مطابق لمنطق `ameen-stock-query.sql` v2: `bIsInput=+Qty` و`bIsOutput=-Qty` وتجميع `MatGUID,StoreGUID`، ولا قراءة من `ms000`.
  2. التقرير الأحدث `ameen_item_details` يحوي 399 صنفاً بتاريخ `2026-07-25 03:22:47Z`، لكن أحدث `source_synced_at` في `approved_price_items` هو `2026-07-23 20:17:22Z`؛ لا صفوف مزامنة خلال آخر ساعة.
  3. بالمطابقة الرقمية 314 صفاً: 167 فقط طابقت فيها `sum(stores)=stock_qty` و147 اختلفت؛ لا اختلاف واحد كان ضمن 15 دقيقة، وأقل فجوة زمنية نحو 1865 دقيقة. لذلك لا يمكن اعتماد مقارنة «تسامح دقائق» دون مزامنة مخزون حديثة، ولم يشغّلها Codex.
  4. تعارض بنيوي مستقل عن القدم: v2 يجعل `stock_qty=stock_qty_positive` عند وجود مخزون موجب، بينما `stores` يضمّ المستودعات السالبة أيضاً فيكون مجموعها الصافي. التقرير الحالي فيه 20 صنفاً بمستودع سالب، منها 13 تجمع موجباً وسالباً؛ مثال #137: مجموع stores الصافي `15` لكن الموجب `100`. يلزم توحيد قاعدة العرض/المجموع قبل الاعتماد.
- التغطية:
  1. تحقق SQL مستقل بنفس التطبيع على اسم ومفتاح الطرفين: `316/316` من `approved_price_items` لها تفاصيل مطابقة، وصفر مفقود.
  2. اختبار الواجهة بصنف بلا تفاصيل أكد ظهور «التكلفة غير متاحة» و«تفاصيل المستودعات غير متاحة» دون عرض `$0.00` مزيف.
- اختبار الواجهة الفعلي على snapshot `24ccb4e` ببيانات معزولة:
  1. على 390×844 وسطح المكتب نجح فتح زر `i`، والإغلاق بزر ✕ وبالخلفية، وظهرت أرقام بارسا الصحيحة (`4` كراتين، `$5.20` للكروز، `$260` للكرتونة، `−$15.00`).
  2. بقي إدخال الفاتورة وسلسلة Enter سليماً. الهاتف بقي بلا overflow (`scrollWidth=390`) والجدول يتمرر داخلياً (`328 < 459` و`scrollLeft=-100`)؛ سطح المكتب `scrollWidth=1440`.
  3. لا أخطاء page؛ تحذير CSP المعروف لـ`frame-ancestors` فقط.
- صلاحيات P1: `salesInfoCard()` يعرض التكلفة والربح بلا `isOwner()`، و`getLatestItemDetailsReport()` متاح لأي جلسة موظف؛ سياسة RLS هي `inventory_reports_staff_select using is_staff()`. أي موظف في `staff_allowlist` يستطيع قراءة التقرير، وهذا يخالف قاعدة أن التكلفة/الربح للمدير فقط.
- Checks: `npm.cmd run check` ناجح (`Project check passed`) و`git diff --check origin/main...HEAD` وفرق العمل نظيفان قبل إضافة هذا السجل.
- Boundaries: لا commit/push/merge ولا fetch/pull ولا مزامنة إنتاج ولا تعديل أسعار. استعلامات الأمين وSupabase كانت SELECT فقط، والتغيير الوحيد هو سجل المراجعة الحالي أعلى `AI_HANDOFF.md`.
- Handoff UTC: 2026-07-25T03:37:13Z

## 2026-07-25 - Claude - إصلاح انضغاط عمود اسم الصنف (PR #24) + تسجيل مهمة تفاصيل الأصناف

- Status: completed — دُمج (`b392202`)، وسُحب على الجهاز. CACHE v371، الأصول tobacco-105. **بانتظار تأكيد المالك بصرياً بعد تحديث الصفحة.**
- بلاغ المالك: اسم الصنف لا يظهر كاملاً، والصنف لا يظهر بالجدول حتى بإدخال رقمه.
- **السبب — ارتداد من PR #19 (خطأ Claude):** `min-width: 0` على `.inv-table-wrap` جعل الجدول **ينكمش** ليناسب عرض الحاوية (~328px) بدل أن **يتمرّر** داخلها. مجموع الأعمدة الثابتة ~626px وعمود «الصنف» بلا عرض محدّد، فابتلعه الانكماش.
- الإصلاح: `.sales-table { min-width: 700px }` (يحتفظ بعرضه الطبيعي ويتمرّر داخل الحاوية، والصفحة تبقى بلا تجاوز) و`.sales-cell-name { min-width: 170px }`.
- **درس تشخيصي:** قبل لمس أي منطق، أُثبت بـ12 اختباراً على الكود الفعلي أن البحث بالرقم والاسم والهمزات سليم تماماً — فحُصر الخلل في العرض ولم يُعبث بمنطق المطابقة.
- **مهمة `TOBACCO Item Details Push` سُجّلت فعلياً** (المالك شغّل `register-item-details-task.ps1` كمسؤول): كل 60 دقيقة، الحالة Ready، رمز النتيجة 0، والمسار يشير للمستودع الأساسي لا الـworktree.
- Handoff UTC: 2026-07-25T07:00:00Z

## 2026-07-25 - Claude - إنزال رصيد الزبون الحيّ وحد الائتمان (PR #23) — متطلب ٢٣

- Status: completed — دُمج في main (`5e7efdb`)، وسُحب على الجهاز. CACHE v370، الأصول tobacco-104.
- Branch: `feat/invoice-customer-balance` → merged عبر PR #23؛ راجعه Codex ٤ جولات والأخيرة بلا مانع.
- الميزة: عند كتابة اسم الزبون تظهر لوحة أسفل الفاتورة: رصيده الحالي (عليه/له/مسدّد)، حدّه الائتماني، آخر دفعة، و**الرصيد المتوقّع بعد الفاتورة** يتحدّث جراحياً مع كل صنف/كمية/حسم/دفعة (بلا render حفاظاً على التركيز)، مع ⛔ عند التجاوز و⚠ عند بلوغ 90%.
- قرارات محاسبية موثّقة:
  1. الرصيد المتوقّع = الرصيد + **المتبقّي** لا الإجمالي — دَين الزبون يزيد بالجزء غير المدفوع فقط، فالفاتورة النقدية المسدَّدة لا تغيّره.
  2. متبقّي فاتورة المفرق يُقسم على سعر الصرف (الأرصدة بالدولار من `ac000`).
  3. الحد صفر/غائب = «لا حد محدّد» فلا تحذير — **286 من 287** زبوناً بلا حد فعلي (زبون واحد فقط له حد: مركز شريفة $25,000).
- **خلل قديم مكتشَف ومُصلَح:** حدود الائتمان لم تكن تُطبَّق **إطلاقاً** (لا في الفاتورة ولا في صفحة الأرصدة) لأن مفتاح الحد المحفوظ غير مطبّع («مركز شريفة» بالتاء المربوطة) بينما مزامنة الأرصدة تطبّع («شريفه» بالهاء). أُصلح بالتطبيع على الطرفين في `customerLimitMap` و`applyCustomerLimits`، مع التطبيع عند الحفظ في `saveCustomerLimit` — **بلا ترحيل بيانات**.
- **نمط متكرر يستحق الانتباه:** هذه ثالث مرة اليوم يسبّب فيها اختلاف تطبيع المفاتيح العربية (ة/ه، أ/ا) عطلاً صامتاً: أرقام الأصناف (85 صنفاً)، تفاصيل المستودعات (85 صنفاً)، وحدود الائتمان. يُنصح بفحص دوري يكشف المفاتيح غير المطبّعة قبل أن تسبّب عطلاً.
- التحقق (Codex): حد $25,000 ارتبط رغم بقاء مفتاح القاعدة غير مطبّع؛ الرصيد $10,518.86؛ المتوقّع $20,518.86 بلا تحذير و$25,518.86 بـ⛔ وتجاوز $518.86؛ صفحة الأرصدة صارت تطبّق `near_limit`/`over_limit`؛ الحد الصفري بلا تحذير؛ التركيز ثابت حرفاً حرفاً؛ 390×844 و1440×900 سليمان.
- Handoff UTC: 2026-07-25T06:00:00Z

## 2026-07-25 - Claude - إنزال بطاقة معلومات الصنف (PR #21) — متطلبا ٩ و١٦

- Status: completed — دُمج في main (`5dde318`)، Deploy نجح، وسُحب على الجهاز
- Branch: `feat/item-details-panel` → merged عبر PR #21؛ راجعه Codex أربع جولات والأخيرة بلا مانع
- الميزة: زر **i** بكل سطر فاتورة يفتح بطاقة: مخزون النشرة، سعر الكرتونة، آخر تسعير (بتحذير عند ≥30 يوماً)، التكلفة وربح الكرتونة **للمدير فقط**، وتوزيع المخزون على المستودعات الخمسة بمجموعه ووقته.
- **درس مهم (خطأ ارتُكب وأُصلح):** بنيتُ نظام تكلفة جديداً بينما المشروع فيه أصلاً `item_costs` محمي بـRLS (`is_owner`) + `isOwner()`/`itemCostFor()` + `tools/push-item-costs.ps1` — بقيم مطابقة حرفياً. والأسوأ أن نسختي كتبت التكلفة في `inventory_reports` الذي تقرؤه كل الأدوار `authenticated` = **تسريب فعلي** (رُفع صفّ فيه تكلفة 260 صنفاً، وحُذف بموافقة المالك ورُفع بديل نظيف). **القاعدة: ابحث عن بنية موجودة قبل بناء أي ميزة، وتحقّق من سياسات RLS للجدول قبل الكتابة فيه.**
- قرارات تصميمية موثّقة:
  1. `push-item-details.ps1` (جديد، منفصل عمداً عن `ameen-sync-agent.ps1`) يرفع **المستودعات فقط** إلى `inventory_reports/ameen_item_details`. التكلفة لا تُرفع إطلاقاً.
  2. «مخزون النشرة» و«مجموع المستودعات» رقمان **منفصلان بالتصميم**: الأول لا يُحدَّث إلا عند تغيّر عدد الكراتين الكاملة فيتأخر ساعات، والثاني حيّ بوقت التقرير؛ كما أن الأول يجمع الموجب فقط بينما لبعض المستودعات أرصدة سالبة فعلية في الأمين. عرضهما كرقم واحد كان يوهم بتناقض.
  3. عرض الكميات موحَّد في `fmtQty` واحدة: تحذف الجزء الصفري، تُظهر السالب بإشارة واحدة في المقدمة، وتحفظ الكسور بخانتين (تقريبها كان يغيّر القيمة: 53.88 تظهر 54).
- التحقق النهائي (Codex): تحقق عكسي يفكّ النص ويعيد حساب القيمة — **386 سطر مستودع + 316 سطر مخزون، أقصى فرق = 0**؛ اتساق المجاميع 242/242؛ RLS يحجب `item_costs` عن غير المالك (0/401)؛ 390×844 و1440×900 ناجحان.
- **المتبقّي:** جدولة `push-item-details.ps1` دورياً (غير مجدول بعد — التوزيع يبقى على آخر رفع يدوي)؛ والأدوار الكاملة (متطلبا 17 و20) ما زالت غير مبنية — الحماية الحالية تعتمد `OWNER_EMAILS` + RLS.
- CACHE_NAME → v368، الأصول → tobacco-102.
- Handoff UTC: 2026-07-25T04:15:00Z

## 2026-07-25 - Claude - إنزال حماية أرقام الأصناف item_number (PR #20)

- Status: completed — دُمج في main (`0e78778`)، Deploy نجح، وسُحب على الجهاز. **يبقى تأكيد حيّ واحد** (أدناه).
- Branch: `fix/supabase-item-number-save` → merged عبر PR #20
- تصحيح مهم لتقدير الخطر (فُحص هذه الجلسة): **التسعير اليومي من الهاتف (`upsertApprovedPriceItems`) لم يكن يمسح الأرقام أصلاً** — `normalizeApprovedPriceInput` لا يضع `item_number` في الحمولة، فلا تلمسه القاعدة. الخطر الحقيقي محصور في **`replaceApprovedPriceItems`** (مسار لائحة الأسعار الجماعية، [src/app.js:1499](src/app.js:1499)) الذي يحذف كل الصفوف ثم يعيدها بلا أرقام → يمسح الـ314 دفعة واحدة.
- الإصلاح: الدالتان تقرآن `item_key, item_number` وتعيدان ربط الرقم بمفتاحه قبل الحفظ؛ و`replace` **يرمي خطأ آمن قبل الحذف** إن تعذّرت القراءة بدل حذف أعمى.
- التحقق قبل الدمج (قراءة فقط على بيانات الإنتاج عبر Supabase MCP + السكربت):
  1. RLS: سياسة `approved_price_items_staff_select` متاحة لدور `authenticated` — الإصلاح لن يعطّل حفظ الأسعار (كان أكبر خطر محتمل).
  2. `item_key` فريد (صفر تكرار) فالخريطة لا تنكسر؛ 314 صفاً تدخلها؛ صفر مفاتيح فارغة؛ صفر تجاوز لحد 5000.
  3. `pull-item-numbers.ps1 -WhatIf`: مطابق بالاسم **314/316**، سيُحدَّث 0. والقاعدة تؤكد: 316 صفاً، 314 برقم، 2 بلا رقم (الصنفان المكرّران المعروفان).
- شبكة الأمان للاسترجاع: `tools/pull-item-numbers.ps1` (بلا `-WhatIf`) يعيد توليد كل الأرقام من `mt000.Number` بأمر واحد — أقوى من نسخة نصية.
- الفحوص: `npm check` ناجح، `git diff --check` نظيف، `CACHE_NAME → v367`، الأصول `→ tobacco-101`، وDeploy نجح.
- **المتبقّي (تأكيد حيّ):** بعد أول حفظ سعر فعلي من الموقع، أعِد `tools\pull-item-numbers.ps1 -WhatIf` وتأكد أن «مطابق بالاسم» ما زال **314** و«سيُحدَّث» = 0.
- Handoff UTC: 2026-07-25T03:30:00Z

## 2026-07-25 - Claude - إنزال إصلاح عرض iPhone لشاشة الفاتورة (PR #19)

- Status: completed — دُمج في main (`fb458f5`)، Deploy نجح، وسُحب على الجهاز
- Branch: `fix/sales-iphone-layout` → merged عبر PR #19
- المشكلة: شاشة «فاتورة مبيعات» كانت تُقصّ أفقياً على iPhone (قياس Codex: عرض الصفحة 594px على viewport 390px).
- الجذر (اكتُشف بعد أن أثبت قياس Codex أن الإصلاح الأول لم يكفِ — 498px): شبكة `.app-shell` على الموبايل كانت `grid-template-columns: 1fr` = `minmax(auto, 1fr)`، فيتبع العمود min-content الجدول ويتجاوز الشاشة؛ لذلك `min-width:0` على حاوية الجدول وحدها كان عاجزاً.
- الإصلاح: `minmax(0, 1fr)` لشبكة app-shell (media 900) + `min-width:0` على `.main` و`.inv-table-wrap` + `-webkit-overflow-scrolling:touch` وتضييق هوامش/خلايا تحت 480px.
- التحقق الحي (Codex، 390×844): `documentElement.scrollWidth = 390` بلا قصّ؛ التمرير الداخلي فعلي (`.inv-table-wrap` clientWidth 328 مقابل scrollWidth 436)؛ اللمسات وسلسلة Enter والطباعة سليمة؛ سطح المكتب 1440×900 بلا overflow.
- ملاحظة تقنية مهمة للجلسات القادمة: `src/styles.css` و`index.html` مخزّنان بأسطر **مختلطة (LF/CRLF)**، وأدوات التحرير توحّدها فتُنتج ~580 سطر ضجيج في الـdiff. التعديل عليهما يجب أن يتم بسكربت يحفظ البايتات (طُبّق هنا) — ويُستحسن تنظيفها لاحقاً بـ`.gitattributes` موحّد.
- الفحوص: `npm check` ناجح، `git diff --check` نظيف، `CACHE_NAME → v366`، الأصول `→ tobacco-100`، وDeploy TOBACCO Web نجح.
- Handoff UTC: 2026-07-25T02:45:00Z

## 2026-07-25 - Codex - اعتماد إصلاح تخطيط فاتورة المبيعات على iPhone بعد c88c2f2

- Status: acceptance passed, ready from reviewed scope — اختفى تمدد الصفحة وأصبح التمرير الأفقي داخل جدول المبيعات فعليًا؛ لا commit أو push أو merge من Codex.
- Branch/worktree: `fix/sales-iphone-layout` في `.claude/worktrees/agent-aba8cb3159c146563` عند `c88c2f2`، مطابق لـ`origin/fix/sales-iphone-layout`.
- النطاق والفحوص:
  1. أب `c88c2f2` هو `b1cfdfd`. الكوميت يغيّر `src/styles.css` ويضمّ سجل مراجعة Codex السابق في `AI_HANDOFF.md`؛ لا ملفات كود أخرى.
  2. فرق CSS محصور في media `max-width:900px`: تبديل عمود `.app-shell` من `1fr` إلى `minmax(0, 1fr)` وإضافة `.main { min-width:0; }`. لا تغييرات أسعار أو وظائف أو ضجيج line-ending خارج الكتلة المقصودة.
  3. `npm.cmd run check` ناجح (`Project check passed`)؛ `git diff --check c88c2f2^ c88c2f2` وفرق العمل الحالي نظيفان قبل إضافة هذا السجل.
- القياس الحي على iPhone 390×844:
  1. عند فتح «فاتورة مبيعات»: `innerWidth=390` و`visualViewport.width=390` و`documentElement.clientWidth=390` و`scrollWidth=390` و`body.scrollWidth=390`. شرط عدم تمديد الصفحة ناجح.
  2. عروض الطبقات: `.app-shell=390px`، `.main=390px`، `.sales-panel=358px`، `.inv-form-area=356px`، و`.inv-table-wrap=328px`.
  3. التمرير الداخلي ناجح عند الفتح: `.inv-table-wrap.clientWidth=328` مقابل `scrollWidth=436`، وعرض `.sales-table=435.6px`.
  4. بعد اختيار صنف وإضافة السطر التالي بقي `documentElement.scrollWidth=390`، وأصبح wrap `328 < 458` والجدول `458px`. تغيير `scrollLeft` داخل wrap من `0` إلى `-100` نجح، ما يؤكد أن التمرير يحدث داخل الحاوية لا على الصفحة.
  5. لا توجد طبقة خارجية تتجاوز 390px؛ العنصر الأعرض من الشاشة هو `.sales-table` فقط، وهو مقصود ومحجوز داخل `.inv-table-wrap`.
- استقرار الوظائف والنقر:
  1. نجحت سلسلة بحث `123` ثم Enter → الكمية → Enter → السعر → Enter → بحث السطر التالي.
  2. نجحت لمسة طبيعية على زر «أجل»، ثم كمية `2` وسعر إدخال اختباري `125` وحسم `20` ومدفوع `100` أعطت إجمالي `$250.00` وصافي `$230.00` و«عليه `$130.00`».
  3. نجحت لمسة طبيعية على «طباعة / PDF»؛ استُدعيت الطباعة مرة واحدة واحتوى القالب الصنف الوهمي و«المتبقّي (عليه)» و`$130.00`.
  4. لا أخطاء page؛ ظهر تحذير CSP المعروف فقط بأن `frame-ancestors` لا يُطبّق من `<meta>`.
- سطح المكتب 1440×900:
  1. `documentElement.clientWidth=scrollWidth=1440`، `.main=1180px`، `.sales-panel=1124px`، وwrap/table كلاهما `1074px`.
  2. لا overflow أفقي، والنقرات الطبيعية وسلسلة Enter والحساب والطباعة جميعها ناجحة.
- بيئة الاختبار وحدوده: جلسة وصنف وهميان داخل browser context معزول، مع حجب الاتصالات الخارجية وservice workers. لم تُكتب أسعار أو مخزون أو مستندات إنتاجية، ولم تُشغّل مزامنة.
- Boundaries: لا commit/push/merge ولا fetch/pull ولا نشر. التغيير الوحيد بعد الاختبار هو سجل المراجعة الحالي أعلى `AI_HANDOFF.md`.
- Handoff UTC: 2026-07-25T02:31:00Z

## 2026-07-25 - Codex - إعادة تحقق مستقلة من إصلاح تخطيط فاتورة المبيعات على iPhone

- Status: failed acceptance, not ready to merge — التحسن حقيقي لكنه لا يحقق شرط حصر التمرير الأفقي داخل الجدول؛ لا commit أو push أو merge من Codex.
- Branch/worktree: `fix/sales-iphone-layout` في `.claude/worktrees/agent-aba8cb3159c146563` عند `b1cfdfd`، مطابق لـ`origin/fix/sales-iphone-layout`.
- النطاق والقاعدة:
  1. أب `b1cfdfd` و`origin/main` المحلي متطابقان عند `93a40b3`.
  2. الـcommit يغيّر ثلاثة ملفات فقط: `src/styles.css` و`index.html` و`public/service-worker.js`.
  3. فرق CSS جراحي ضمن `.inv-table-wrap` وmedia `max-width:480px`؛ ولا يوجد ضجيج line-ending خارج المواضع المقصودة. `index.html` يرفع نسخة الأصول إلى `tobacco-100` وservice worker يرفع الكاش إلى `v366`.
  4. `npm.cmd run check` ناجح (`Project check passed`)؛ `git diff --check origin/main...b1cfdfd` وفرق العمل الحالي نظيفان.
- القياس الحي 390×844، على نسختين محليتين معزولتين وبالإعداد والبيانات الوهمية نفسيهما:
  1. `origin/main`: `visualViewport.width=390` و`documentElement.clientWidth=390`، لكن `scrollWidth=594` و`innerWidth=594`؛ عرض `.sales-panel=561.6px`. حاوية الجدول `clientWidth=512` و`scrollWidth=512`.
  2. الفرع: `visualViewport.width=390` و`documentElement.clientWidth=390`، لكن `scrollWidth=498` و`innerWidth=498`؛ عرض `.sales-panel=465.6px`. أي تحسن بنحو `96px`، مع بقاء الصفحة أعرض من الشاشة بـ`108px`.
  3. شرط عدم تمديد الصفحة فاشل (`498 > 390`)، وشرط التمرير الداخلي فاشل أيضًا: `.inv-table-wrap.clientWidth=436` و`scrollWidth=436`، والجدول نفسه `435.6px`. لا يوجد محتوى أعرض داخل الحاوية كي تتمرّر؛ الـshell/`main` ما زال بعرض `497.6px`.
  4. الاستنتاج: `min-width:0` على `.inv-table-wrap` وحدها يقلّل min-content width لكنه لا يقيّد عرض shell/عمود المحتوى بالـvisual viewport، والجدول ما زال يتقلص مع الحاوية بدل امتلاك حد أدنى يُنتج تمريرًا داخليًا.
- الوظائف على رأس الفرع:
  1. في الهاتف وسطح المكتب نجح بحث `123` ثم Enter → الكمية → Enter → السعر → Enter → بحث السطر التالي.
  2. كمية `2` وسعر إدخال اختباري `125` وحسم `20` ومدفوع `100` أعطت إجمالي `$250.00` وصافي `$230.00` و«عليه `$130.00`».
  3. قالب الطباعة استُدعي واحتوى الصنف الوهمي و«المتبقّي (عليه)» و`$130.00`.
  4. سطح المكتب 1440×900 سليم: `scrollWidth=clientWidth=1440`، عرض اللوحة `1124px`، والنقرات الطبيعية والحساب والطباعة نجحت.
  5. على محاكاة اللمس، سلسلة حقول Enter نجحت، لكن Playwright لم يستطع تنفيذ نقرات طبيعية مستقرة على «أجل» و«طباعة» بسبب اختلاف layout viewport (`498px`) عن visual viewport (`390px`) وبقاء الصفحة متمددة؛ استُدعيت أحداث الزرين مباشرة فقط لعزل صحة منطق الحساب/قالب الطباعة. لذلك لا يُعد الهاتف ناجحًا وظيفيًا بالكامل قبل إصلاح الامتداد وإعادة النقر الفعلي.
- المتصفح: لا أخطاء page؛ ظهر تحذير CSP المعروف فقط بأن `frame-ancestors` لا يُطبّق من `<meta>`.
- بيئة الاختبار وحدوده: شُغّل `origin/main` والفرع محليًا جنبًا إلى جنب، مع جلسة وصنف وهميين في browser context معزول، وحُجبت الاتصالات الخارجية وservice workers. لم تُكتب أسعار أو مخزون أو مستندات إنتاجية، ولم تُشغّل مزامنة.
- Boundaries: لا commit/push/merge ولا fetch/pull ولا نشر. التغيير الوحيد المقصود هو سجل المراجعة الحالي أعلى `AI_HANDOFF.md` مع الإبقاء على السجل السابق غير المثبّت.
- Handoff UTC: 2026-07-25T02:17:03Z

## 2026-07-25 - Codex - مراجعة إصلاح قصّ فاتورة المبيعات على iPhone

- Status: partially fixed, not ready to merge — العرض تقلّص بوضوح لكن شرط عدم تمديد الصفحة لم يتحقق؛ لا commit أو push أو merge من Codex.
- Branch/worktree: `fix/sales-iphone-layout` في `.claude/worktrees/agent-aba8cb3159c146563`، مطابق لـ`origin/fix/sales-iphone-layout`.
- commit reviewed: `b1cfdfd`، وأبوه يطابق `origin/main` عند `93a40b3`.
- النطاق والفحوص:
  1. الـcommit يغيّر ثلاثة ملفات فقط: `src/styles.css` و`index.html` و`public/service-worker.js`.
  2. فرق CSS محصور بكتلة `.inv-table-wrap` (`min-width:0` وtouch scrolling) وإضافات media `max-width:480px` لهوامش `.inv-form-area` وخلايا جدول المبيعات وحجم خط الجدول. لا ضجيج line-ending خارج الكتل المقصودة.
  3. `index.html` يرفع نسخة الأصول من `tobacco-99` إلى `tobacco-100`، وservice worker يرفع `CACHE_NAME` من `v365` إلى `v366`.
  4. `npm.cmd run check` ناجح (`Project check passed`)؛ `git diff --check` و`git diff --check b1cfdfd^ b1cfdfd` نظيفان.
- القياس الحي 390×844، بالمحاكي نفسه والبيانات نفسها:
  1. `origin/main`: `documentElement.clientWidth=390` و`scrollWidth=594`؛ عرض `.sales-panel=561.6px`. حاوية الجدول `clientWidth=512` و`scrollWidth=512`.
  2. الفرع: `clientWidth=390` و`scrollWidth=498`؛ عرض `.sales-panel=465.6px`. أي تحسن بمقدار نحو `96px`، لكنه ما زال يتجاوز الشاشة بـ`108px`.
  3. شرط التمرير الداخلي لم يتحقق: `.inv-table-wrap.clientWidth=436` و`scrollWidth=436`، أي لا يوجد محتوى داخلي أعرض من الحاوية؛ الصفحة نفسها ما زالت هي التي تتمدد.
  4. الفحص البنيوي أظهر أن `aside.sidebar` و`main` ما زالا بعرض `498px`، وأن topbar/notice/`.sales-panel` بعرض نحو `466px`. لذلك `min-width:0` على حاوية الجدول وحدها لا يكفي لضبط عرض shell/المحتوى على visual viewport.
- الوظائف:
  1. على الفرع في محاكاة iPhone وسطح المكتب 1440×900 نجح بحث `123` ثم Enter → الكمية → السعر → بحث السطر التالي.
  2. كمية `2` وسعر `125` وحسم `20` ومدفوع `100` أعطت إجمالي `$250.00` وصافي `$230.00` و«عليه `$130.00`».
  3. الطباعة استُدعيت في البيئتين واحتوت الصنف و«المتبقّي (عليه)» و`$130.00`. لا أخطاء page أو console.
  4. سطح المكتب سليم: `scrollWidth=clientWidth=1440`، وعرض اللوحة `1124px`.
- بيئة الاختبار: كود `origin/main` والفرع شُغّلا محلياً جنباً إلى جنب في متصفح فعلي، مع جلسة وبيانات وهمية معزولة؛ لم تُكتب بيانات إنتاجية.
- Boundaries: لم تُشغّل مزامنة، ولم تُلمس أسعار أو مخزون، ولم يحدث commit/push/merge. التغيير الوحيد هو سجل المراجعة الحالي غير المثبّت في `AI_HANDOFF.md`.
- Handoff UTC: 2026-07-25T01:10:02Z

## 2026-07-25 - Codex - مراجعة سلامة إنزال دفعة ١ من وحدة الفاتورة

- Status: verified for Git/history and desktop functionality; mobile functionality passed but iPhone viewport fit did not pass. لا commit أو push أو merge من Codex.
- `main` على GitHub والجهاز:
  1. بعد `git fetch origin --prune` كان `HEAD` و`origin/main` متطابقين عند `2d3fc3d`، و`git status -sb` نظيفاً قبل إضافة هذا السجل. دمج دفعة الفاتورة موجود عبر PR #18 عند `d72c27c`.
  2. `src/app.js` على `origin/main` يحتوي route `sales` ضمن `allowedRoutes` ودالتَي `salesInvoice` و`salesSaveInvoice`.
  3. `public/service-worker.js` يحتوي `CACHE_NAME = "web-platform-tobacco-v365"`.
  4. `npm.cmd run check` ناجح (`Project check passed`) و`git diff --check` نظيف. فحص كل الملفات المتتبعة على `origin/main` والنسخة المحلية لم يجد أياً من markers التعارض `<<<<<<< / ======= / >>>>>>>`.
  5. مقارنة عناوين سجلات `AI_HANDOFF.md` مع مصدرَي الدمج وجدت: سجلات الفاتورة `4/4` محفوظة، وسجلات تصادم 273/274 `4/4` محفوظة، وصفر عناوين مفقودة.
- فرع `fix/supabase-item-number-save`:
  1. `origin/fix/supabase-item-number-save` مطابق للكوميت `814df70`، وقاعدته `695b69d`. الفرق عن القاعدة ملفان فقط: `src/supabase-client.js` و`AI_HANDOFF.md` (`74` إضافة و`2` حذف).
  2. `upsertApprovedPriceItems` يجلب `item_key,item_number` ويحافظ على الرقم عند نجاح الجلب؛ وعند فشل الجلب لا يرسل حقل `item_number` فلا يغيّره.
  3. `replaceApprovedPriceItems` يحافظ على الرقم لكل `item_key`، ويرمي خطأ قبل الحذف إذا فشل الجلب. لا تعديل في حقول السعر أو المخزون أو أي دالة أخرى.
  4. فرق `AI_HANDOFF.md` يحتوي سجلّي مراجعة Codex المطلوبين فقط: المراجعة الأولى ثم اعتماد fallback الآمن.
  5. `814df70` ليس ancestor لـ`origin/main` (`merge-base --is-ancestor` أعاد 1)، والفرع البعيد الوحيد الذي يحتويه هو `origin/fix/supabase-item-number-save`; أي أن تعديل #1 محفوظ ولم يُدمج في `main`.
- اختبار متصفح حي على كود `main` المحلي، مع جلسة Supabase ومخزن بيانات وهميين لمنع أي كتابة إنتاجية:
  1. نجح تسجيل الدخول من نموذج الدخول على سطح المكتب 1440×900 ومحاكاة iPhone 390×844، ثم فتح «فاتورة مبيعات» من القائمة.
  2. نجحت الدورة في البيئتين: بحث `123` ثم Enter نقل إلى الكمية، وEnter نقل إلى السعر ثم بحث السطر التالي. كمية `2` وسعر `125` وحسم `20` ومدفوع `100` أعطت إجمالي `$250.00` وصافي `$230.00` و«عليه `$130.00`»؛ المدفوع `230` أعطى «مسدّد `$0.00`»، و`300` أعطى «له `$70.00`».
  3. الطباعة استُدعيت في البيئتين، واحتوى قالبها الصنف و«المتبقّي (عليه)» و`$130.00`. لم تظهر أخطاء page أو console.
  4. سطح المكتب ملائم بلا overflow أفقي (`scrollWidth=clientWidth=1440`). محاكاة iPhone نجحت وظيفياً لكنها فشلت بصرياً: `clientWidth=390` مقابل `scrollWidth=608`، وبطاقة الفاتورة عرضها نحو `576px` وظهرت مقصوصة أفقياً. هذا يعيد الملاحظة السابقة؛ لا يجوز اعتماد ملاءمة iPhone قبل إصلاحها والتحقق على جهاز فعلي.
- حدود الدليل الحي: الاختبار شغّل واجهة `main` الحقيقية محلياً بمدخلات ماوس/لمس ولوحة مفاتيح، لكنه لم يستخدم حساب Supabase إنتاجياً ولا iPhone مادياً، ولم ينشئ مستنداً إنتاجياً.
- Boundaries: لم تُشغّل مزامنة فعلية، ولم تُلمس أسعار أو مخزون، ولم يحدث commit/push/merge. التغيير الوحيد هو سجل المراجعة الحالي غير المثبّت في `AI_HANDOFF.md`.
- Handoff UTC: 2026-07-25T00:25:46Z

## 2026-07-25 - Claude - إنزال دفعة ١ من وحدة الفاتورة على main + نشر + حفظ تعديل #1

- Status: completed — دُمجت دفعة ١ في main (PR #18) ونُشرت على الموقع؛ حُفظ تعديل #1 على فرعه؛ سُحبت النسخة على الجهاز
- Branch: `feat/invoice-module` → merged في main عبر PR #18 (`d72c27c`)
- ما نُفّذ:
  1. **دفعة ١ من وحدة الفاتورة**: وصل route `sales` بـ`allowedRoutes`؛ رقم فاتورة تسلسلي شهري `SAL-YYMM-0001` يُحجز بعد نجاح الحفظ فقط (لا فجوات، حارس ضد القيم التالفة)؛ منع الحفظ المكرر (`salesSaving`)؛ تركيز تلقائي واختصارات Enter؛ حالة المتبقّي (عليه/له/مسدّد) في الشاشة والمطبوعة.
  2. راجعها Codex ٤ مرات؛ أُصلحت ملاحظاته (0NaN، سباق الحفظ، الفجوات). القيد المتبقّي **P1 مؤجّل بموافقة المالك**: عدّاد الأرقام محلي لكل جهاز، قد يتكرّر رقم بين جهازين متزامنين — الحل الكامل عدّاد مركزي في Supabase يأتي مع مرحلة خصم المخزون/تقييد الذمم. الفاتورة الآن **مستند + طباعة فقط** (لا مخزون/ذمم)، محجوبة خلف تسجيل الدخول.
  3. دُمج origin/main في الفرع قبل الدمج (حُلّ تعارض AI_HANDOFF بدمج كل السجلات، وCACHE_NAME → v365، الأصول tobacco-99).
  4. **تعديل #1** (إصلاح حفظ item_number في upsert/replace، كان غير محفوظ على main worktree) حُفظ على فرع `fix/supabase-item-number-save` (`814df70`) — **ينتظر تحقّقاً حياً** (نشر أسعار ثم `pull-item-numbers.ps1 -WhatIf` واعتماد «مطابق بالاسم»=314) قبل دمجه في main.
- الفحوص: `npm check` ناجح، `git diff --check` نظيف، ٢٧ اختباراً منطقياً معزولاً ناجحاً، وDeploy TOBACCO Web على main نجح.
- التالي: تحقّق حي من تعديل #1 ودمجه؛ ثم دفعات وحدة الفاتورة التالية (معلومات الصنف/المستودعات/التكلفة/الربح، الرصيد الحي وحد الائتمان، آخر سعر للزبون، الأدوار مدير/محاسب، المرتجعات، ثم خصم المخزون/تقييد الذمم بالتوازي مع الأمين).
- Handoff UTC: 2026-07-25T00:15:00Z

## 2026-07-25 - Codex - مراجعة إصلاح ترقيم الفواتير وسباق الحفظ

- Status: partially verified — أصلح `cf02228` الأخطاء السابقة داخل التبويب الواحد، لكن بقي خلل تحقق بالقيم التالفة وسباق عابر للتبويبات؛ لا commit أو push أو merge من Codex.
- Branch/worktree: `feat/invoice-module` في `.claude/worktrees/agent-aba8cb3159c146563`، مطابق لـ`origin/feat/invoice-module`.
- commit reviewed: `cf02228` «إصلاح ملاحظات مراجعة Codex على دفعة ١ (ترقيم الفواتير وسباق الحفظ)».
- النطاق:
  1. الـcommit يغيّر ملفين فقط: `src/app.js` و`AI_HANDOFF.md`.
  2. فرق الكود محصور بحالة `salesSaving` ودوال تسلسل/حجز رقم فاتورة `sales` وحفظها. لم يتغير route/dالة `invoice` القديمة، ولا الأسعار أو المخزون أو أي مسار مزامنة.
- القيم التالفة:
  1. `seq="broken"` و`null` والسالب والكائن وJSON المكسور أعادت جميعها `SAL-2607-0001`، ولم يظهر `0NaN`.
  2. الشرط المطلوب لم يتحقق كاملاً: `seq=3.7` أعطى `SAL-2607-0004` بسبب `Math.floor`، والنص الرقمي `seq="7"` أعطى `SAL-2607-0008` بسبب التحويل بـ`Number`. إذا كانت أي قيمة غير integer number تُعد تالفة، فيجب فحص `typeof saved.seq === "number" && Number.isInteger(saved.seq) && saved.seq > 0`.
- الفجوات والفشل:
  1. بعد حذف المفتاح، أربع مرات فتح/إعادة تحميل متتالية بقيت على `SAL-2607-0001` وبقي `localStorage["sales-invoice-seq"]` غير موجود؛ العرض لم يعد يستهلك الرقم.
  2. بعد حفظ ناجح حُجز `seq=1`، و«فاتورة جديدة» أخذت `SAL-2607-0002` بلا قفزة.
  3. فشل شبكة معزول (`TypeError: Failed to fetch`) أثناء حفظ `0002` لم يضف مستنداً، ولم يغيّر `seq=1`، وبقيت الفاتورة التالية `0002` بعد reload. الزر كان معطلاً أثناء الانتظار وعاد مفعّلاً بعد الفشل.
- السباق:
  1. نقرتان سريعتان فعليتان داخل التبويب نفسه أنشأتا مستنداً واحداً فقط برقم `0001`. زر الحفظ تعطّل أثناء مهلة الحفظ وعاد بعدها، ثم ظهر الرقم التالي `0002`.
  2. تبويبان في browser context واحد يشتركان في `localStorage`: عند الحفظ المتسلسل من الأول ثم الثاني حُفظ الرقمان `0001` ثم `0002` بلا تكرار.
  3. خلل P1 استكشافي: عند بدء الحفظ من التبويبين معاً قبل اكتمال أي منهما، حُفظ مستندان كلاهما `SAL-2607-0001`. `salesSaving` محلي لكل تبويب، والرقم لا يُحجز إلا بعد `await createSharedDocument`؛ يلزم قيد uniqueness/عداد ذري في مخزن مشترك، أو حجز عابر للتبويبات قبل إنشاء المستند مع آلية تراجع آمنة.
- Checks: `npm.cmd run check` ناجح (`Project check passed`)؛ `git diff --check` و`git diff --check cf02228^ cf02228` نظيفان.
- بيئة الاختبار: متصفح محلي معزول ومخزن `createSharedDocument` وهمي مشترك بين التبويبات؛ لم تُكتب أي بيانات في Supabase أو `shared_documents` الإنتاجية.
- Boundaries: لم تُشغّل مزامنة فعلية، ولم تُلمس أسعار أو مخزون، ولم يحدث commit/push/merge. التغيير الوحيد بعد الفحوص هو سجل المراجعة الحالي غير المثبّت في `AI_HANDOFF.md`.
- Handoff UTC: 2026-07-24T23:40:15Z

## 2026-07-23 - Codex - مراجعة «وحدة الفاتورة (دفعة ١)»

- Status: reviewed — نطاق الـcommit سليم والفحوص ناجحة، لكن وُجد خللان وظيفيان يجب إصلاحهما قبل اعتماد الدفعة؛ لا commit أو push أو merge من Codex.
- Branch/worktree: `feat/invoice-module` في `.claude/worktrees/agent-aba8cb3159c146563`
- commit reviewed: `5afa28e` «وحدة الفاتورة (دفعة ١)»
- النطاق:
  1. `git show 5afa28e --stat` و`git show 5afa28e` وفرق الأسماء أكدت أن الـcommit يغيّر `src/app.js` فقط (`74` إضافة و`7` حذف).
  2. التغيير محصور بقبول route `sales` المباشر، وتسلسل رقمها، وحالة المتبقّي، وتركيز/Enter، ومنع الحفظ المكرر في وحدة المبيعات. لم يتغير route/dالة `invoice` القديمة، ولا التسعير أو المخزون أو أي دالة مزامنة.
- نتائج الرقم التسلسلي:
  1. الصيغة الصحيحة `SAL-YYMM-0001`، والانتقال إلى شهر آخر يعيد العداد إلى `0001`. JSON غير صالح نحوياً يرجع بأمان إلى `0001`.
  2. خلل: تخزين صالح نحوياً لكن `seq` تالف دلالياً، مثل `{"period":"2607","seq":"broken"}`، يولّد فعلياً `SAL-2607-0NaN`. يلزم قبول عدد صحيح غير سالب فقط وإلا البدء من `1`.
  3. الرقم يُستهلك عند رسم شاشة `sales` لا عند نجاح الحفظ: فتح `?route=sales` أعطى `0001`، وإعادة التحميل من دون أي حفظ أعطت `0002` مع صفر استدعاءات حفظ. هذا يخلق فجوات مزعجة لكل reload أو مسودة متروكة؛ الأفضل حجز/زيادة الرقم عند الحفظ الناجح أو اعتماد عداد مركزي لاحقاً.
- نتائج الحفظ:
  1. بعد اكتمال الحفظ، إعادة الضغط لا تحفظ ثانية (`1` استدعاء و`1` مستند)، وبعد «فاتورة جديدة» سُمح بالحفظ برقم جديد (`0002`) كما هو مطلوب.
  2. خلل سباق: نقرتان متزامنتان قبل انتهاء `await createSharedDocument` نفّذتا استدعاءين وحفظتا مستندين بالرقم نفسه `SAL-2607-0003`. `salesSavedNo` لا يُضبط إلا بعد انتهاء الاستدعاء؛ يلزم حارس in-flight/تعطيل الزر قبل `await`.
- اختبار حي مع مخزن وهمي معزول كلياً:
  1. الهاتف 390×844: لمسة حقيقية على اقتراح الصنف نقلت التركيز فوراً إلى `qty` داخل سياق اللمس، ثم نجح المسار بحث/Enter → كمية/Enter → سعر/Enter → بحث السطر التالي.
  2. سطح المكتب 1440×900 والهاتف: كمية `2` وسعر `125` وحسم `20` ومدفوع `100` أعطت إجمالي `$250.00` وصافي `$230.00` و«عليه `$130.00`». المدفوع `230` أعطى «مسدّد `$0.00`»، و`300` أعطى «له `$70.00`» بالقيمة المطلقة.
  3. المفرق: سعر الوحدة التلقائي `201000` ل.س وصافي `400000` ل.س؛ الحالات الثلاث ظهرت صحيحة، و«عليه/له» عرضتا `100,000 ل.س` بالقيمة المطلقة.
  4. قالب الطباعة المولّد احتوى «المتبقّي (عليه)» و`$130.00` للدولار، و«المتبقّي (له)» و`100,000 ل.س` للمفرق، بلا إشارة سالبة. الرابط `?route=sales` بقي نفسه بعد إعادة التحميل.
  5. Enter في `#inv-customer` داخل الفاتورة القديمة أبقى القيمة والتركيز كما هما، ولا توجد `data-sales-field` خارج route `sales`; لم يظهر تداخل مع الحقول القديمة.
- ملاحظة من اختبار رأس الفرع الحالي، خارج فرق `5afa28e`: محاكاة iPhone الفعلية (`isMobile + hasTouch`) أعطت `clientWidth=390` لكن layout/scroll بعرض `594`، فظهر جزء من صفحة المبيعات وقائمة الاقتراح خارج الحافة اليسرى. اختبار اللمس ظل قابلاً للتنفيذ ونجح، لكن يلزم إعادة تحقق على iPhone فعلي لأن اختبار viewport المكتبي المصغّر السابق لا يعيد هذه الحالة.
- Checks: `npm.cmd run check` ناجح (`Project check passed`)؛ `git diff --check` نظيف قبل إضافة هذا السجل؛ والفرع كان مطابقاً لـ`origin/feat/invoice-module`.
- Boundaries: لم تُشغّل مزامنة فعلية، ولم تُلمس أسعار أو مخزون، ولم يحدث commit/push/merge. التغيير الوحيد هو سجل المراجعة الحالي غير المثبّت في `AI_HANDOFF.md` حسب طلب المستخدم.
- Handoff UTC: 2026-07-23T20:42:27Z

## 2026-07-23 - Codex - مراجعة سلامة حفظ تحسين اقتراحات فاتورة المبيعات

- Status: reviewed and verified — عملية الحفظ سليمة ولا توجد ملاحظة مانعة؛ لا commit أو push أو merge من Codex.
- Branch/worktree: `feat/invoice-module` في `.claude/worktrees/agent-aba8cb3159c146563`
- commit reviewed: `564dcc4` «حفظ تحسين تموضع اقتراحات فاتورة المبيعات على iPhone»
- نطاق الحفظ:
  1. `git show 564dcc4 --stat` و`diff-tree` أكدا أن الـcommit يغيّر ملفين فقط: `src/app.js` و`AI_HANDOFF.md`.
  2. فرق `src/app.js` عبارة عن hunk واحد داخل `positionSalesSuggest` من بدايتها حتى قبل `salesPickItem`; لا سطر مضافاً أو محذوفاً في `salesPickItem` أو التسعير أو المجاميع.
  3. فرق `AI_HANDOFF.md` يضيف سجلّي التسليم السابقين فقط: مراجعة نواة الفاتورة، واعتماد تموضع اقتراحات iPhone.
- مطابقة Git بعد `git fetch origin --prune`: `HEAD` و`origin/feat/invoice-module` متطابقان تماماً عند `564dcc42c1a1ffb2d4ebb1cb6b07d52825581f26`، والتباعد `0/0`. قبل إضافة سجل المراجعة الحالي كان `git status -sb` نظيفاً ويعرض `feat/invoice-module...origin/feat/invoice-module`. بقي `origin/main` عند `695b69d`، وهو Merge PR #17.
- إعادة برهان متصفح معزول 390×844:
  1. الحافة اليمنى RTL: عرض 240px وحدود `left=142`, `right=382`.
  2. الحافة اليسرى: `left=8`, `right=248`.
  3. الحقل قرب الأسفل (`top=780`): انقلبت القائمة فوقه إلى `top=458`, `bottom=738`.
  الحالات الثلاث بقيت ضمن viewport أفقياً وعمودياً؛ الاختبار لم يفتح بيانات أو خدمات الإنتاج.
- Checks: `npm.cmd run check` ناجح (`Project check passed`)؛ `git diff --check` نظيف؛ وفحص patch الـcommit نفسه `git diff --check 564dcc4^ 564dcc4` نظيف.
- Boundaries: لم تُشغّل مزامنة فعلية، ولم تُلمس أسعار، ولم يحدث commit/push/merge. التغيير الوحيد بعد الفحوص هو سجل المراجعة الحالي غير المثبّت في `AI_HANDOFF.md` حسب طلب المستخدم.
- Handoff UTC: 2026-07-23T20:04:27Z

## 2026-07-23 - Codex - اعتماد تموضع اقتراحات فاتورة المبيعات على iPhone

- Status: reviewed and verified — تعديل `positionSalesSuggest` يحقق حدود العرض والتموضع والانقلاب العمودي المطلوبة.
- Branch/worktree: `feat/invoice-module` في `.claude/worktrees/agent-aba8cb3159c146563`؛ لا commit أو push أو merge.
- اختبار متصفح فعلي مع viewport بعرض 390 وارتفاع 844:
  1. الحالة الفعلية RTL: عرض القائمة 240px داخل عرض الشاشة، وحدودها `left=142` و`right=382` مع هامش 8px؛ لا تجاوز يميناً أو يساراً.
  2. اختبار الحافة اليسرى: ثُبّتت القائمة عند `left=8` وانتهت عند `right=248`؛ بقيت ضمن الحافتين.
  3. اختبار ضيق المساحة تحت الحقل: عند وضع الحقل قرب الأسفل (`top=780`) انقلبت القائمة فوقه (`top=458`, `bottom=739`) وبقيت كاملة ضمن viewport.
  4. فرق `src/app.js` غير المثبّت محصور بدالة `positionSalesSuggest`; لم يتغير `salesPickItem` ولا منطق التسعير أو المجاميع. اختبار التدفق اختار `item-1` بسعر 120 وكمية 2 وأظهر الإجمالي `$240.00` مع السطر الفارغ اللاحق كما كان.
- الفحوص: `npm.cmd run check` ناجح (`Project check passed`) و`git diff --check` ناجح.
- Handoff UTC: 2026-07-23T18:39:46Z

## 2026-07-23 - Codex - مراجعة مزامنة رقم الصنف ونواة وحدة الفاتورة

- Status: reviewed — الفحوص الآلية ناجحة، مع نواقص ومخاطر يجب إصلاحها قبل الدمج أو الاعتماد.
- Branch: `feat/invoice-module` عند `a055aee` (لم يُدمج، ولا commit/push من Codex).
- ما أنجزه Claude:
  1. أضاف العمود `approved_price_items.item_number` وسكربت `tools/pull-item-numbers.ps1` للقراءة من `mt000.Number` وتحديث هذا العمود وحده، مع `-WhatIf` وfallback إلى `192.168.1.200,1433`.
  2. بنى نواة route مستقلة باسم `sales`: جملة/دولار ومفرق/سوري، كرتونة/كروز، بحث بالرقم أو الاسم، سعر تلقائي قابل للتعديل، حسم ومدفوع ومتبقٍّ، حفظ في `shared_documents`، وطباعة.
- تحقق رقم الصنف الحي (قراءة فقط، 2026-07-23): `314/316` صفاً لها رقم صحيح مطابق للأمين، و`2/316` فقط بلا رقم، وصفر أرقام خاطئة. رقم `231/316` ثم «85 غير مطابق» كان مرحلة أقدم؛ عولج 83 منها وبقي الصنفان المعروفان. السكربت اجتاز PowerShell parser وتشغيل `-WhatIf` لم يكتب بيانات.
- ملاحظات السكربت:
  1. سطر ملخص `-WhatIf` يحسب خطأً «سيُحدَّث: 83» رغم أن التغييرات الفعلية صفر؛ المقارنة هناك لا تطبّع `item_key`.
  2. يوجد تصادم تطبيع فعلي في الأمين: «غلواز كوين اصفر اس سبعة» بالرقمين 273 و274 (اختلاف نقطة فقط). الخريطة الحالية تستبدل أحدهما بالآخر بلا كشف وبلا `ORDER BY`، وقد تقلب الرقم في تشغيل لاحق؛ يجب كشف التصادمات وتخطيها أو حسمها صراحة.
- نتيجة مراجعة الفرع:
  1. `npm.cmd run check` ناجح، و`git diff --check origin/main...HEAD` ناجح.
  2. حسابات الاختبار مستقلة وصحيحة: جملة كرتونة 120$، جملة كروز 12$ عند factor=10؛ مفرق كرتونة 201000 ل.س، ومفرق كروز 20100 ل.س عند retail=15$ وصرف 13400. تحويل الأرقام العربية/الفارسية إلى الإنجليزية نجح.
  3. route `invoice` الحالي بقي قابلاً للرسم والطباعة، ومسار طباعة `sales` ولّد الصنف والمجاميع بنجاح في اختبار متصفح معزول. لا يوجد تغيير في سكربتات المزامنة أو منطق الأسعار المخزنة.
  4. نطاق commit ليس محصوراً بـ`src/app.js` و`public/service-worker.js`: عدّل أيضاً `index.html` و`src/styles.css` و`src/number-normalizer.js` و`src/supabase-client.js` (6 ملفات إجمالاً). رفع `CACHE_NAME` صحيح من v353 إلى v354 ونسخة الأصول إلى tobacco-99.
- العوائق قبل الدمج:
  1. على عرض iPhone (390px) قائمة اقتراح الصنف تمتد من x=226 إلى x=466 خارج الشاشة، فلا يمكن ضغط النتيجة؛ هذا يعطل الإدخال الأساسي على الجهاز المستهدف.
  2. مسار استبدال لائحة الأسعار يفضّل `replaceApprovedPriceItems`، وهو يحذف الصفوف كلها ثم يعيد إدخال payload لا يحمل `item_number`؛ أول استخدام لاحق لهذا المسار قد يمسح الأرقام الـ314. يجب حفظ العمود أو إعادة ربطه ذرّياً قبل تشغيل الاستبدال.
  3. بعد اختيار الصنف لا ينتقل التركيز إلى الكمية (يبقى على `BODY`)، ولا توجد اختصارات Enter/Tab/Space المطلوبة؛ البحث الجزئي موجود لكن اختصارات أوائل الكلمات غير منفذة.
  4. رقم الفاتورة عشوائي `SAL-YYMM-NNNN` وليس تسلسلياً، ويمكن حفظ المستند نفسه أكثر من مرة بلا منع أو قيد uniqueness.
  5. الرابط المباشر `?route=sales` يرجع إلى `overview` لأن `sales` غير مضاف إلى `allowedRoutes`.
  6. المتبقّي السالب يظهر رقماً فقط (مثلاً `-99,000`) بلا حالة «له»، وبقية المتطلبات المؤجلة ما زالت غير منفذة: معلومات الصنف والمستودعات والتكلفة/الربح، الأدوار، المرتجعات، آخر سعر للزبون، الرصيد الحي وحد الائتمان، وخصم المخزون/تقييد الذمم.
  7. الفرع مبني على `17e6ac1` ومتأخر عن `origin/main` بكوميت توليد أسعار واحد؛ عند التحديث لاحقاً يجب الحفاظ على ملفات التوليد الأحدث وحل نسخة الكاش من دون دمج الآن.
- الخطوات القادمة: إصلاح عداد `-WhatIf` وتصادم 273/274، إغلاق القائمة القديمة التي كانت 85 بمعالجة الصنفين المتبقيين، إصلاح عوائق iPhone/التركيز/الاختصارات والتسلسل ومنع التكرار، ثم إكمال متطلبات الفاتورة 1–23 بالتدرج والتشغيل الموازي مع الأمين والمقارنة اليومية قبل أي اعتماد.
- Handoff UTC: 2026-07-23T17:54:51Z

## 2026-07-23 - Codex - مراجعة ثانية لتحصين تصادم 273/274

- Status: reviewed — التحصينان صحيحان، ولا توجد ملاحظة مانعة أو خطأ جديد؛ لا merge
- Branch: `claude/sales-invoice-normalization-issue-30bbb3` (worktree: `.claude/worktrees/sales-invoice-normalization-issue-30bbb3`)
- Scope reviewed: آخر تحصين في `tools/pull-item-numbers.ps1`، وسطر التحذير وما يلزمه من أسماء داخل `Sync-PriceListStockOnFullUnitChange` في `tools/ameen-sync-agent.ps1`
- النتيجة:
  1. مرشحو التصادم أصبحوا كائنات `num/name`، وتُبنى `candidateNums` من كل الأرقام الفعلية. لا يُطبّق override إلا مع `$candidateNums -contains $override`. اختبار كتلة الكود نفسها أكد: المرشحان 273/274 يبقيان الحسم 273؛ وإذا صارت المرشحات 274/275 يُرفض الحسم القديم ويُحذف المفتاح؛ والتصادم بلا override يُرفض أيضاً.
  2. تشغيل `tools\pull-item-numbers.ps1 -WhatIf` بقي قرائياً وأكد البيانات الحالية: التصادم الوحيد 273/274 محسوم إلى 273، مطابق بالاسم 314/316، والتحديثات المطلوبة 0.
  3. تحذير التصادم الجديد في `Sync-PriceListStockOnFullUnitChange` يضيف `Names` إلى بنية التجميع الداخلية ويستدعي `Write-AgentLog` فقط؛ لا يغيّر `Qty` أو `Rep` أو شروط المقارنة أو عنوان PATCH أو payload. محاكاة معزولة أكدت: تصادم جديد = تحذير واحد ونفس PATCH بقيمة التجميع 7؛ التصادم المعروف 273/274 = صفر تحذيرات ونفس PATCH بقيمة 136؛ وحقل `Names` لا يتسرّب إلى payload.
- Checks: PowerShell parser للملفين = 0 أخطاء؛ `npm.cmd run check` ناجح؛ `git diff --check` نظيف.
- Boundaries: لم تُشغّل مزامنة فعلية، ولم يُكتب إلى الأمين أو Supabase، ولم يتغير أي سعر، ولم يحدث commit/push/merge.
- Handoff UTC: 2026-07-23T19:13:06Z

## 2026-07-23 - Claude - تحصين حسب ملاحظتَي مراجعة Codex (تصادم 273/274)

- Status: completed — بانتظار مراجعة Codex ثانية ثم قرار الدمج من المستخدم
- Branch: `claude/sales-invoice-normalization-issue-30bbb3`؛ لا merge
- Files: tools/pull-item-numbers.ps1، tools/ameen-sync-agent.ps1 (نفس الدالة فقط)
- طبّقت ملاحظتَي التحصين اللتين رفعهما Codex بمراجعته (غير مانعتين لكن رخيصتان):
  1. **pull-item-numbers.ps1:** `$collisionOverrides` الآن يتحقق أن الرقم المحسوم (273) لا يزال أحد بطاقات التصادم الفعلية قبل اعتماده؛ إن لم يعد كذلك (تغيّرت بطاقات الأمين لاحقاً) يُستبعد المفتاح من التحديث مع تحذير مطبوع صريح بدل تطبيق حسم قديم أعمى.
  2. **ameen-sync-agent.ps1:** أي تصادم تطبيع مستقبلي غير 273/274 المعروف يُسجَّل الآن بتحذير بالسجل (`Write-AgentLog`) قبل تجميعه — لا يُرفض (فقد يكون سطراً حياً بمخزون فعلي يستحق النشر)، لكنه يصير مرئياً للمراجعة بدل أن يُدمج بصمت.
- الفحوص: PSParser صفر أخطاء للملفين؛ تشغيل حي `pull-item-numbers.ps1 -WhatIf`: نفس النتيجة السابقة (314/316 مطابق، 0 تحديثات، الحسم 273 مؤكد)؛ `npm.cmd run check` ناجح؛ `git diff --check` نظيف.
- Handoff UTC: 2026-07-23T19:20:00Z

## 2026-07-23 - Codex - مراجعة إصلاح تصادم 273/274 وتذبذب مخزون النشرة

- Status: reviewed — الإصلاح صحيح وآمن على البيانات الحالية، مع ملاحظتي تحصين مستقبليتين أدناه؛ لا merge
- Branch: `claude/sales-invoice-normalization-issue-30bbb3` (worktree: `.claude/worktrees/sales-invoice-normalization-issue-30bbb3`)
- Scope reviewed: `tools/pull-item-numbers.ps1` و`Sync-PriceListStockOnFullUnitChange` في `tools/ameen-sync-agent.ps1`
- نتيجة المراجعة:
  1. فحص قرائي مستقل من `mt000` وحركات `bi000`/`bu000`/`bt000` أكد أن 273 «غلواز كوين اصفر اس سبعة.» هي الحية: مخزون المزامنة 136، حركة واحدة وآخرها 2026-07-01؛ و274 بلا مخزون وبلا أي حركة. الوحدات متطابقة: كروز/كرتونة ومعامل 50. لذلك الحسم إلى 273 صحيح.
  2. `pull-item-numbers.ps1` صار يجمع أرقام المفتاح المطبّع، يحسم التصادم المعروف إلى 273، ويستبعد أي تصادم آخر غير محسوم بدلاً من رقم عشوائي. الـPATCH الوحيد الممكن يحتوي `item_number` فقط، فلا يمس سعراً أو مخزوناً. عدّاد `-WhatIf` يحصي الفرق الفعلي بعد تطبيع `item_key`.
  3. تشغيل `tools\pull-item-numbers.ps1 -WhatIf` كان قرائياً ونتيجته: 399 مفتاح أمين بعد التطبيع، التصادم الوحيد 273/274 محسوم إلى 273، **مطابق بالاسم 314 من 316**، وسيُحدَّث 0.
  4. دالة مزامنة مخزون النشرة تجمع داخل المفتاح المطبّع نفسه فقط، وتفحص `ContainsKey` قبل الوصول إلى صفوف النشرة، لذلك لا ترسل PATCH بمفتاح فارغ ولا تكتب إلى صنف باسم مختلف. للبيانات الحالية المجموعة الوحيدة المتصادمة هي 273+274؛ مجموعها 136 وممثلها 273، وبقية الأصناف المفردة تحافظ على السلوك السابق. الحمولة لا تحتوي أي حقل سعر أو `item_number`.
  5. محاكاة معزولة بلا شبكة: التشغيلة الأولى أرسلت تحديثين لسطرَي alias فقط بقيمة 136، والثانية صفر تحديثات؛ لم يظهر أي تحديث لصنف غير منشور أو مفتاح آخر.
- ملاحظات المخاطر:
  1. `$collisionOverrides` يفرض 273 إذا وُجد المفتاح، لكنه لا يتحقق أن 273 ما زال واحداً من مرشحي التصادم. لا يؤثر الآن، لكن الأفضل قبل الاعتماد الطويل إضافة تحقق عضوية الرقم كي لا يصبح الحسم قديماً إذا تغيرت بطاقات الأمين.
  2. مزامنة المخزون تجمع تلقائياً أي تصادم تطبيع مستقبلي، بخلاف سكربت الأرقام الذي يرفض غير المحسوم. لا أثر حالي لأن الفحص وجد تصادماً واحداً فقط ووحدتاه متطابقتان وإحداهما فارغة؛ لكن إذا ظهر لاحقاً تصادم لصنفين حيين مختلفين أو معاملي وحدة مختلفين فقد تُجمع كمياتهما تحت مفتاح واحد وتُؤخذ وحدة/حالة ممثل واحد. يوصى بتسجيل تحذير ورفض التصادم غير المعروف أو اعتماد allowlist صريحة.
  3. يوجد تغيير تنسيق نهاية سطر واحد خارج الدالة عند `customerAccountGuid`، بلا تغيير دلالي.
- Checks: PowerShell parser للملفين = 0 أخطاء؛ `npm.cmd run check` ناجح؛ `git diff --check` نظيف.
- Boundaries: لم تُشغّل مزامنة الإنتاج، ولم يُكتب إلى الأمين أو Supabase، ولم يتغير أي سعر، ولم يحدث commit/push/merge.
- Handoff UTC: 2026-07-23T19:06:15Z

## 2026-07-23 - Claude - حسم تصادم تطبيع 273/274 وإيقاف تذبذب مخزون النشرة

- Status: completed — بانتظار مراجعة Codex ثم قرار الدمج من المستخدم
- Branch: `claude/sales-invoice-normalization-issue-30bbb3` (worktree: `.claude/worktrees/sales-invoice-normalization-issue-30bbb3`)؛ لا merge
- Files: tools/pull-item-numbers.ps1 (نسخة من ملف main غير المثبّت + إصلاحان)، tools/ameen-sync-agent.ps1 (دالة Sync-PriceListStockOnFullUnitChange فقط)
- التشخيص (قراءة فقط من الأمين وSupabase):
  1. بالأمين بطاقتان: **273** «غلواز كوين اصفر اس سبعة**.**» (بنقطة آخر الاسم — الحية: مخزون 136 وحركة فواتير آخرها 07/01/2026) و**274** «غلواز كوين اصفر اس سبعة» (فارغة تماماً: صفر مخزون وصفر حركة منذ الإنشاء). فحص شامل لكل mt000: هذا هو التصادم الوحيد.
  2. اكتشاف أخطر أثناء التشخيص: حلقة مزامنة مخزون النشرة تمرّ على البطاقتين المتصادمتين فتكتبان بالتناوب 136 ثم 0 على سطرَي النشرة (سبعة/سبعه) — **تذبذب مُشاهد حياً**: 18:52 UTC صفر/«نافد» ثم 18:53 عاد 136/«low»، والسجل يظهر `BoundaryChanges=17` بكل تشغيلة (200/200 من آخر التشغيلات): منها كتابتا التذبذب و~15 PATCH وهمياً لأصناف أمين غير منشورة، لأن غياب المفتاح يعيد `@($null)` فيمرّ فحص `.Count` ويُرسل PATCH بـ`item_key=eq.` فارغ لا يطابق شيئاً.
- الإصلاحان:
  1. **pull-item-numbers.ps1:** كشف تصادمات التطبيع عند بناء خريطة الأمين؛ حسم صريح موثّق («غلواز كوين اصفر اس سبعه» → 273)؛ أي تصادم مستقبلي غير محسوم يُستبعد من التحديث مع تحذير مطبوع بكل بطاقاته؛ `order by Number` للثبات؛ إصلاح عدّاد `-WhatIf` (كان يقارن بلا تطبيع فيطبع «83» وهمياً — الآن يعدّ التغييرات الفعلية).
  2. **ameen-sync-agent.ps1:** تجميع أصناف التقرير حسب المفتاح المطبّع قبل مقارنة النشرة (جمع كميات البطاقات المتصادمة؛ الممثل = الأكبر مخزوناً لوحداته وحالته)، وشرط `ContainsKey` يوقف الكتابات الوهمية. بعد الدمج ستتغير أرقام السجل طبيعياً (Matched≈316 بدل 464، وBoundaryChanges تقارب صفراً عند الاستقرار).
- الفحوص: PSParser على PowerShell 5.1 صفر أخطاء للملفين؛ محاكاة معزولة بلا شبكة (صفر كتابات عند التطابق، كتابتا تصحيح ثم استقرار تام بالتشغيلة التالية، لا كتابات وهمية)؛ تشغيل حي `pull-item-numbers.ps1 -WhatIf` من الـworktree: «تصادم محسوم صراحة → 273»، «مطابق بالاسم: 314 من 316»، «سيُحدَّث: 0»؛ `npm.cmd run check` ناجح؛ `git diff --check` نظيف. لا رفع CACHE_NAME (لا تعديل على ملفات الموقع المنشورة).
- ملاحظات:
  1. **الجذر بطاقة 274 المكررة في الأمين** — التوصية: حذفها أو إعادة تسميتها باسم مميز من برنامج الأمين (فارغة تماماً فالإجراء آمن). بعدها يختفي التصادم نهائياً ويبقى الإصلاحان حمايةً من أي تكرار مستقبلي.
  2. الإنتاج لم يُلمس: المهمة المجدولة تشغّل نسخة main، **فالتذبذب مستمر كل دقيقة حتى دمج هذا الفرع أو تنظيف الأمين**. نسخة tools/pull-item-numbers.ps1 غير المثبّتة على main بقيت كما هي — عند الدمج تُعتمد نسخة هذا الفرع (الملف نفسه + الإصلاحان).
  3. لم أمسّ التعديلين غير المثبّتين (src/supabase-client.js على main، واقتراحات iPhone على `feat/invoice-module`) حسب الاتفاق.
- Handoff UTC: 2026-07-23T19:05:00Z

## 2026-07-23 - Codex - اعتماد إصلاح fallback في replaceApprovedPriceItems

- Status: reviewed and verified — الإصلاح يمنع حذف الأسعار أو أرقام الأصناف عند فشل جلب `item_number`.
- Branch/worktree: `main`، تعديل غير مثبّت؛ لا commit أو push أو merge، ولا كتابة على الأسعار أو المزامنة.
- نتيجة اختبار محاكاة محلي معزول:
  1. فشل جلب `item_key,item_number` أدّى إلى رمي الخطأ الآمن قبل بناء مسار الحذف؛ `deleteCalled=false` و`insertCalled=false`.
  2. نجاح الجلب حفظ `item_number` الحالي لكل صف مطابق بـ`item_key`؛ صف الاختبار احتفظ بالرقم `123`.
  3. لم تتغير حقول السعر أو المخزون: بقيت قيم الاختبار `sale_price=10` و`unit1_price=10` و`unit2_price=20` و`price_payload.retail.price=25` و`stock_qty=7` و`stock_status=active`.
- الفحوص: `npm.cmd run check` ناجح (`Project check passed`) و`git diff --check` ناجح.
- ملاحظة: بنية الاستبدال الأصلية ما زالت حذفاً ثم إدخالاً بطلبين منفصلين بعد نجاح الجلب؛ هذا خارج الإصلاح الحالي، لكنه يبقى خطراً مستقلاً إذا فشل الإدخال بعد نجاح الحذف.
- Handoff UTC: 2026-07-23T18:32:51Z

## 2026-07-23 - Codex - مراجعة الحفاظ على item_number عند حفظ الأسعار

- Status: reviewed — `upsertApprovedPriceItems` سليم، لكن fallback في `replaceApprovedPriceItems` غير آمن ويمنع اعتماد التعديل كما هو.
- Branch/worktree: `main`، تعديل غير مثبّت في `src/supabase-client.js` فقط ضمن هذه المراجعة؛ لم ينفذ Codex commit أو push أو merge ولم يغيّر أسعاراً أو مزامنة.
- نتيجة المراجعة:
  1. عند نجاح جلب `item_key,item_number`، تحافظ الدالتان على الرقم الحالي بحسب `item_key`، ولا تغيّران حقول الأسعار. اختبار محاكاة محلي حافظ على `sale_price=10` و`unit1_price=10` و`unit2_price=20` و`price_payload.retail.price=25`.
  2. عند فشل الجلب، `upsertApprovedPriceItems` يحذف حقل `item_number` من payload؛ لذلك لا يحدّث العمود في الصف الموجود، وهذا fallback صحيح.
  3. عند فشل الجلب، `replaceApprovedPriceItems` يستمر في حذف جميع الصفوف ثم يعيد إدخالها بلا `item_number`؛ لذلك يمسح الأرقام بدلاً من «عدم لمسها». الحل الآمن هو إيقاف الاستبدال قبل الحذف عند تعذر الجلب، أو تنفيذ حفظ/استبدال ذري يحافظ على العمود.
  4. مسار `replaceApprovedPriceItems` ما زال حذفاً ثم إدخالاً بطلبين منفصلين؛ فشل الإدخال بعد الحذف يظل مخاطرة قديمة بفقد لائحة الأسعار كاملة.
- الفحص القرائي: `tools\pull-item-numbers.ps1 -WhatIf` أعطى السطر المعتمد `مطابق بالاسم: 314 من 316`. تم تجاهل سطر «سيُحدَّث» حسب الخطأ المعروف.
- الفحوص: `npm.cmd run check` ناجح، و`git diff --check` ناجح. اختبار المحاكاة كان محلياً بالكامل ولم يتصل بكتابة إنتاجية.
- Handoff UTC: 2026-07-23T18:26:46Z

## 2026-07-22 - Claude - عمل بدون اتصال + تحصين Supabase + سحب نسخ الأمين + تنبيه فشل الإنعاش

- Status: completed
- Branch: main (باتفاق صريح مع المستخدم)
- Files: service-worker.js (جديد), public/service-worker.js, src/app.js, tools/pull-ameen-backup.ps1 (جديد), tools/register-ameen-backup-pull-task.ps1 (جديد), tools/ensure-local-server.ps1, CLAUDE.md, AI_WORK_SYNC.md + ترحيلان في Supabase
- Result: (1) التطبيق يفتح من الكاش حتى لو السيرفر واقف — مُختبر فعلياً بقتل السيرفر (CACHE v342، نطاق جذري). (2) تحصين Supabase مطبق ومُتحقق منه: سحب الأسعار 314 صنفاً ✓ وإشعار تيليغرام ✓ بعد التحصين؛ أُعيدت SELECT لواجهتَي الأسعار لدور anon لأنها التصميم الأصلي (كسرت السحب مؤقتاً وأُصلحت خلال دقائق). (3) مهمة «TOBACCO Ameen Backup Pull» يومياً 23:00 تنسخ أحدث نسخ الأمين إلى OneDrive — تنتظر تفعيل مشاركة \\OZK-TOBACCO\AmeenBackup على جهاز الخادم. (4) الحارس يتحقق بعد محاولة الإنعاش ويرسل تنبيه تيليغرام عند الفشل. نسخ AmnDb002 على الخادم يومية سليمة؛ AmnConfig غير منسوخة أبداً — على المستخدم إضافتها بنسخ الأمين.
- Handoff UTC: 2026-07-22T16:25:00Z

## 2026-07-22 - Claude - حارس السيرفر المحلي وسحب يومي من GitHub وتحديث قاعدة الحفظ والتوثيق

- Status: completed
- Branch: main (أدوات تشغيل Windows وتوثيق، باتفاق صريح مع المستخدم)
- Files: tools/ensure-local-server.ps1, tools/register-local-server-watchdog.ps1, tools/daily-git-pull.ps1, tools/register-daily-git-pull-task.ps1, .gitignore, AI_WORK_SYNC.md, CLAUDE.md, README_AR.md
- Result: مهمة «TOBACCO Local Web Server» كل 5 دقائق تعيد تشغيل سيرفر localhost:5173 إذا توقف (التطبيق المثبّت PWA يعتمد عليه)؛ مهمة «TOBACCO Daily Git Pull» يومياً 07:30 تسحب من GitHub فقط عند نظافة المستودع وغياب قفل نشط؛ تعديل قاعدة الحفظ في AI_WORK_SYNC (المهمة المكتملة تُحفظ فوراً بكوميت على فرعها والنشر يبقى بطلب المستخدم)؛ تجاهل tmp/ و*.bak في Git؛ تصحيح مسارات جهاز DELL القديمة إلى المسار الفعلي على جهاز LOQ.
- Handoff UTC: 2026-07-22T14:05:00Z

## 2026-07-22 - Claude - حفظ أعمال Codex غير المحفوظة ومزامنة main مع GitHub

- Status: completed
- Branch: main (عملية حفظ ومزامنة تنظيمية بطلب صريح من المستخدم، ليست مهمة كود جديدة)
- Files: كل تعديلات Codex المتراكمة 2026-07-15 → 2026-07-21 (17 ملفاً معدّلاً) + الملف الجديد supabase/telegram-daily-cash-report.sql
- Result: أعمال Codex الموثقة أدناه كمكتملة كانت كلها بلا أي commit، والنسخة المحلية متأخرة 31 كوميتاً عن origin/main. حُفظت بكوميت واحد ثم rebase على origin/main؛ التعارض الوحيد كان سطر CACHE_NAME في public/service-worker.js (v309 محلياً مقابل v339 على GitHub) وحُلّ برفعه إلى v340. نجح npm run check قبل الدفع. ملفات tmp/ و‎*.bak تُركت خارج Git عمداً.
- Handoff UTC: 2026-07-22T13:56:00Z

## 2026-07-21 - Codex - إصلاح تفاصيل الدفعات اليومية وحركة الصناديق في بوت تيليغرام

- Status: completed
- Branch: task branch pending for: إصلاح تفاصيل الدفعات اليومية وحركة الصناديق في بوت تيليغرام
- Files: supabase/functions/telegram-webhook/index.ts,tools/push-daily-movement.ps1,tools/ameen-sync-agent.ps1,supabase/telegram-notifications.sql,CLAUDE.md
- Result: نُشر telegram-webhook v40، أضيف أمر دفعات اليوم وحركة الصندوق، فُعّلت مزامنة كل 5 دقائق والتقرير المسائي 23:02، وصُحح توافق PowerShell 5.1. نجح npm check والاختبار الحي وحالة HTTP 200.
- Handoff UTC: 2026-07-21T01:13:10Z
## 2026-07-16 - Codex - تصحيح مصدر أرصدة الذمم إلى ac000 بالدولار

- Status: completed
- Branch: task branch pending for: تصحيح مصدر أرصدة الذمم إلى ac000 بالدولار
- Files: tools/ameen-customer-balances-query.sql,src/app.js,scripts/check.mjs,AI_WORK_SYNC.md,index.html,public/service-worker.js
- Result: أصبحت المزامنة تستخدم ac000 بالدولار، أزيل التحويل الثاني من الترتيب، وشُغلت مزامنة حية ناجحة لـ284 زبوناً.
- Handoff UTC: 2026-07-16T10:31:09Z
## 2026-07-16 - Codex - تصحيح ترتيب تقرير الذمم حسب قيمة الدين بعد توحيد العملة

- Status: completed
- Branch: task branch pending for: تصحيح ترتيب تقرير الذمم حسب قيمة الدين بعد توحيد العملة
- Files: src/app.js,scripts/check.mjs,index.html,public/service-worker.js
- Result: صار ترتيب أرصدة الدولار والسوري بحسب القيمة المرجعية بعد التحويل، مع بقاء العرض بالعملة الأصلية؛ نجح npm check واختبار الترتيب.
- Handoff UTC: 2026-07-16T10:00:46Z
## 2026-07-15 - Codex - إضافة تقرير الربح اليومي الحقيقي إلى بوت تيليغرام

- Status: completed
- Branch: task branch pending for: إضافة تقرير الربح اليومي الحقيقي إلى بوت تيليغرام
- Files: tools/push-daily-profit.ps1,supabase/functions/telegram-webhook/index.ts,CLAUDE.md
- Result: حساب مباشر من الأمين للمبيعات والتكلفة والحسومات والمرتجعات والمصاريف؛ نُشرت Edge Function v39؛ تحقق التشغيل التلقائي والمقارنة الفعلية.
- Handoff UTC: 2026-07-15T11:00:50Z
## 2026-07-15 - Codex - إضافة أمر حالة النظام إلى بوت تيليغرام

- Status: completed
- Branch: task branch pending for: إضافة أمر حالة النظام إلى بوت تيليغرام
- Files: supabase/functions/telegram-webhook/index.ts,CLAUDE.md
- Result: أضيف أمر وزر حالة النظام لفحص حداثة المخزون والأرصدة والفواتير والحركات والأسعار والنشرة وحركة المبيعات. نُشرت Edge Function v38، البيانات الحية ضمن الحدود، ولا توجد أخطاء 5xx حديثة.
- Handoff UTC: 2026-07-15T10:17:23Z
## 2026-07-15 - Codex - إضافة فحص مزامنة الأسعار وتنبيهاتها إلى بوت تيليغرام

- Status: completed
- Branch: task branch pending for: إضافة فحص مزامنة الأسعار وتنبيهاتها إلى بوت تيليغرام
- Files: tools/sync-approved-prices-to-ameen.ps1,tools/publish-price-sync-status.ps1,supabase/functions/telegram-webhook/index.ts,CLAUDE.md
- Result: أضيف أمر فحص الأسعار وزر بالقائمة، حفظ نتيجة فحص Windows في inventory_reports، وتنبيه تلقائي عند الفروقات أو فشل الفحص. نُشرت Edge Function v36 وتحققت المهمة المجدولة برمز 0 وصفر فروق.
- Handoff UTC: 2026-07-15T09:30:49Z
## 2026-07-15 - Codex - تصحيح والتحقق من مزامنة أسعار النشرة مع الأمين

- Status: completed
- Branch: task branch pending for: تصحيح والتحقق من مزامنة أسعار النشرة مع الأمين
- Files: tools/apply-approved-prices-to-ameen.ps1,tools/verify-prices.ps1
- Result: اعتماد أحدث سجل لكل اسم قبل التطبيق والفحص؛ مزامنة فعلية وفحص مستقل: صفر فروق، جملة 248 ومفرق 241.
- Handoff UTC: 2026-07-15T09:10:16Z
## 2026-07-15 - Codex - تصحيح سعري ماستر كوين و1970 كوين

- Status: completed
- Branch: task branch pending for: تصحيح سعري ماستر كوين و1970 كوين
- Files: scripts/generate-price-lists.mjs,scripts/check.mjs,public/downloads/*,public/service-worker.js,AI_WORK_SYNC.md
- Result: صُححت النشرة واعتمد تأكيد المستخدم: ماستر كوين أبيض 340$ و1970 كوين أبيض 275$. أُعيد توليد PDF وتحقق السعران على الموقع الحي.
- Handoff UTC: 2026-07-15T08:55:39Z
## 2026-07-15 - Codex - تصحيح مزامنة أسعار النشرة ومنع الأسعار القديمة

- Status: completed
- Branch: task branch pending for: تصحيح مزامنة أسعار النشرة ومنع الأسعار القديمة
- Files: src/app.js,scripts/generate-price-lists.mjs,scripts/check.mjs,public/downloads/*,public/service-worker.js,index.html,AI_WORK_SYNC.md
- Result: دُققت 27 مجموعة مفاتيح مكررة، ووُحّد حفظ aliases، وأضيف نشر تلقائي بعد آخر تعديل. أُعيد التوليد بصرف 13300 وتحقق الموقع الحي: ماستر كوين أبيض 350 و1970 كوين أبيض 260.
- Handoff UTC: 2026-07-15T08:51:15Z
## 2026-07-15 - Codex - السماح بتسعير نشرة السوري دون سعر جملة

- Status: completed
- Branch: task branch pending for: السماح بتسعير نشرة السوري دون سعر جملة
- Files: src/app.js,scripts/check.mjs,index.html,public/service-worker.js,AI_WORK_SYNC.md
- Result: أتيح سعر المفرق دون الجملة، أضيف سعر صرف يومي محفوظ ومُرسل للتوليد، حُذف عداد المواد، استُبدل علم سوريا، وأزيل البياض من جميع صفحات PDF الداكنة. نجحت الفحوص والنشر الحي.
- Handoff UTC: 2026-07-15T08:38:05Z
## 2026-07-15 - Codex - إصلاح نشر تحديثات أسعار النشرة تلقائياً

- Status: completed
- Branch: task branch pending for: إصلاح نشر تحديثات أسعار النشرة تلقائياً
- Files: .github/workflows/generate-price-lists.yml,scripts/check.mjs,AI_WORK_SYNC.md
- Result: ثبت أن Supabase والملف المولد يحملان 355$ لماستر طويل ورق، وأزيل skip ci من دفع المولد لتشغيل Pages تلقائياً. تحقق السعر الحي 355$ ونجح النشر والفحوص.
- Handoff UTC: 2026-07-15T08:16:23Z
## 2026-07-15 - Codex - توحيد قائمة التسعير داخل الموقع مع قواعد النشرة العامة

- Status: completed
- Branch: task branch pending for: توحيد قائمة التسعير داخل الموقع مع قواعد النشرة العامة
- Files: src/app.js,scripts/check.mjs,index.html,public/service-worker.js,AI_WORK_SYNC.md
- Result: استبعاد الوزاري من القائمة العامة، تطبيق الدمج المعتمد، شرط الوحدة الثانية الكاملة للجملة، وحفظ السعر على جميع المصادر المدمجة. نجح npm check وفحص المتصفح على الهاتف.
- Handoff UTC: 2026-07-15T07:58:42Z
## 2026-07-15 - Codex - تثبيت ودمج بوت تيليغرام وحذف المبيعات من التقرير الصباحي

- Status: completed
- Branch: task branch pending for: تثبيت ودمج بوت تيليغرام وحذف المبيعات من التقرير الصباحي
- Files: supabase/functions/telegram-webhook/index.ts,supabase/telegram-notifications.sql,tools/push-sales-line-items.ps1,tools/push-expense-entries.ps1,tools/register-sales-line-items-task.ps1,tools/register-expense-entries-task.ps1,CLAUDE.md
- Result: دُمج فرع البوت كاملاً في main، حُذفت المبيعات من التقرير الصباحي، بقيت في المسائي والأوامر، وصُححت تسميات أسعار البوت للدولار. نجح npm check وDeno check.
- Handoff UTC: 2026-07-15T07:47:12Z
## 2026-07-15 - Codex - فصل أرصدة الزبائن في تبويب مستقل

- Status: completed
- Branch: task branch pending for: فصل أرصدة الزبائن في تبويب مستقل
- Files: src/app.js,scripts/check.mjs,index.html,public/service-worker.js
- Result: فُصلت أرصدة الزبائن والحد المسموح عن الأمين إلى تبويب مستقل محمي بعد الدخول، مع ربط البحث والتحديث والتصدير، وفحوص ونشر ناجح.
- Handoff UTC: 2026-07-15T07:28:07Z
## 2026-07-15 - Codex - إضافة قيمة آخر دفعة إلى تقرير أرصدة الزبائن

- Status: completed
- Branch: task branch pending for: إضافة قيمة آخر دفعة إلى تقرير أرصدة الزبائن
- Files: src/app.js,scripts/check.mjs,index.html,public/service-worker.js
- Result: أضيف عمود قيمة آخر دفعة بجانب تاريخها في تقرير الذمم PDF من حقل مزامنة الأمين، مع فحص منع الرجوع ورفع نسخ الأصول والكاش، والنشر ناجح.
- Handoff UTC: 2026-07-15T07:20:07Z
## 2026-07-15 - Codex - إصلاح كاش تقرير المخزون القديم

- Status: completed
- Branch: task branch pending for: إصلاح كاش تقرير المخزون القديم
- Files: index.html,public/service-worker.js,scripts/check.mjs
- Result: ثبت أن الصورة تستخدم app.js القديم. رُفعت نسخة أصول index إلى tobacco-88 وكاش PWA إلى v272، وأضيف فحص منع الرجوع، وتحقق النشر من الروابط الحية.
- Handoff UTC: 2026-07-15T07:13:42Z
## 2026-07-15 - Codex - تحويل تقرير المخزون الفاتح إلى عمودين متقابلين

- Status: completed
- Branch: task branch pending for: تحويل تقرير المخزون الفاتح إلى عمودين متقابلين
- Files: src/app.js,public/service-worker.js,scripts/check.mjs
- Result: تم تقسيم التقرير إلى صفحات A4 بعمودين متقابلين، الغلواز يميناً والماستر يساراً، مع موازنة المجموعات وفحص PDF بصرياً ونشر ناجح.
- Handoff UTC: 2026-07-15T07:06:30Z
## 2026-07-15 - Codex - إعادة تصميم تقرير المخزون وترتيبه وتصحيح تصنيف الحالات

- Status: completed
- Branch: task branch pending for: إعادة تصميم تقرير المخزون وترتيبه وتصحيح تصنيف الحالات
- Files: src/app.js,scripts/check.mjs,public/service-worker.js,AI_WORK_SYNC.md
- Result: تم اعتماد تقرير مخزون فاتح مرتب حسب النشرة، مع كل صنف مستقل وتصنيف يعتمد حركة المبيع، ونجحت الفحوص والنشر.
- Handoff UTC: 2026-07-15T03:11:42Z
## 2026-07-15 - Codex - إضافة طباعة هاتف مباشرة وملفات PDF فاتحة وداكنة

- Status: completed
- Branch: task branch pending for: إضافة طباعة هاتف مباشرة وملفات PDF فاتحة وداكنة
- Files: scripts/generate-price-lists.mjs,scripts/generate-pdfs.mjs,scripts/check.mjs,src/app.js,public/downloads/*,public/service-worker.js
- Result: تم إنشاء PDF فاتح وداكن لكل نشرة، إضافة طباعة مباشرة وفتح وتنزيل متوافق مع الهاتف، وربط اللون المختار بالملف الصحيح. تم التحقق من الملفات الثمانية ومن تبديل الرابط على الموقع المنشور بواجهة هاتف دون overflow.
- Handoff UTC: 2026-07-15T01:13:49Z
## 2026-07-14 - Codex - إصلاح زر الطباعة على الهاتف ومنع حجب التبويب الجديد

- Status: completed
- Branch: task branch pending for: إصلاح زر الطباعة على الهاتف ومنع حجب التبويب الجديد
- Files: src/app.js,scripts/generate-price-lists.mjs,public/downloads/price-list-usd.html,public/downloads/price-list-syp-14050.html,public/downloads/price-list-wazari-usd.html,public/downloads/price-list-wazari-syp-14050.html,public/service-worker.js,scripts/check.mjs
- Result: تم إلغاء فتح PDF في تبويب جديد، واعتماد الفتح في الصفحة نفسها مع زر تنزيل احتياطي في النشرات الأربع، وإعادة التوليد من Supabase، وفحص الروابط المنشورة. نجحت الفحوص والنشر.
- Handoff UTC: 2026-07-14T19:53:28Z
## 2026-07-14 - Codex - إصلاح طباعة نشرات الأسعار وتوحيدها على PDF الرسمي

- Status: completed
- Branch: task branch pending for: إصلاح طباعة نشرات الأسعار وتوحيدها على PDF الرسمي
- Files: src/app.js,scripts/generate-price-lists.mjs,public/downloads/index.html,public/downloads/price-list-usd.html,public/downloads/price-list-syp-14050.html,public/downloads/price-list-wazari-usd.html,public/downloads/price-list-wazari-syp-14050.html,public/service-worker.js,scripts/check.mjs
- Result: تم استبدال التوليد القديم داخل المتصفح بروابط PDF الرسمية، وإضافة زر فتح PDF للطباعة لكل نشرة، وإعادة توليد وفحص A4 والخلفيات والصفحات، والتحقق من الروابط المنشورة. جميع الفحوص والنشر ناجحة.
- Handoff UTC: 2026-07-14T19:30:32Z
## 2026-07-14 - Codex - تحويل صفحة التسعير إلى مركز نشرة الأسعار داخل الموقع

- Status: completed
- Branch: task branch pending for: تحويل صفحة التسعير إلى مركز نشرة الأسعار داخل الموقع
- Files: index.html,src/app.js,src/styles.css,public/service-worker.js
- Result: تم دمج مركز النشرة داخل الموقع، وربط النسخ الأربع والمعاينة والنشر، وتحسين الهاتف، وإضافة فحوص منع الرجوع. نجح npm check وnode check وgit diff check، وفحص المتصفح للكمبيوتر والهاتف والفاتح والداكن والروابط والكونسول، ونجح النشر الفعلي.
- Handoff UTC: 2026-07-14T18:28:18Z
## 2026-07-14 - Codex - إكمال ملفات PDF النهائية للنشرات وإزالة الهوامش البيضاء

- Status: completed
- Branch: task branch pending for: إكمال ملفات PDF النهائية للنشرات وإزالة الهوامش البيضاء
- Files: scripts/generate-pdfs.mjs,public/service-worker.js
- Result: تم إنشاء PDF للدولار والسوري والوزاري بهوامش صفرية وخلفية داكنة كاملة، ومنع صفحة الوزاري الفارغة، وفحص كل الصفحات بصرياً. npm check وgit diff check ناجحان.
- Handoff UTC: 2026-07-14T17:18:20Z
## 2026-07-14 - Codex - Redesign price list with light and dark themes

- Status: completed
- Branch: task branch pending for: Redesign price list with light and dark themes
- Files: 'scripts/generate-price-lists.mjs','public/downloads/index.html','public/downloads/price-list-usd.html','public/service-worker.js'
- Result: تم اعتماد ودمج نشرات الدولار والسوري والوزاري، مزامنة حد الوحدة الثانية، تنسيق الطباعة، العنوان والتواصل، وتجميع السيغار. جميع الفحوص نجحت.
- Handoff UTC: 2026-07-14T15:11:42Z
## 2026-07-14 - Codex - اعتماد نشرات الأسعار والمزامنة

- Status: completed and verified
- Branch: `feat/price-list-light-dark`
- Files: `scripts/generate-price-lists.mjs`, `tools/ameen-sync-agent.ps1`, `public/downloads/*`, `public/service-worker.js`, `supabase/available-price-sync-feed.sql`, `AI_WORK_SYNC.md`
- Result: نشرتا الدولار والسوري بتنسيق فاتح/داكن وعمودين متوازنين؛ فصل الوزاري؛ صفحة مستقلة للمعسل والفحم؛ طباعة بخلفية كاملة ومسطرة ذهبية؛ تكبير أرقام التواصل وإضافة «دوما – ساحة الغنم»؛ ربط مخزون النشرة بتغيّر العدد الصحيح للكرتونة/الطرد/الشرحة.
- Inventory verification: مهمة `TOBACCO Ameen Sync` تعمل كل دقيقة، وآخر تشغيل نجح. بعد تحديث الأمين بقي في نشرة الدولار من كورسير فقط «كورسير قصير فضي» (52/50).
- Checks: `npm.cmd run check`, `git diff --check`, PowerShell parser, uniqueness checks for all four lists.
- Generated lists: general USD 125 rows, general SYP 165 rows, wazari USD 7 rows, wazari SYP 9 rows at final generation.

## 2026-07-14 - Codex - Enable Claude Codex coordination

- Status: completed
- Branch: chore/ai-work-coordination
- Files: 'AI_WORK_SYNC.md','AI_HANDOFF.md','AI_ACTIVE_TASK.json','tools/ai-work-coordination.ps1','scripts/check.mjs'
- Result: Coordination files and lock workflow implemented; project checks passed.
- Handoff UTC: 2026-07-14T12:39:33Z
## 2026-07-14 — Codex — إنشاء نظام التنسيق

- الحالة: مكتمل محلياً
- تم: إضافة قواعد التنسيق، قفل المهمة، دفتر التسليم، وأداة فتح وإغلاق المهام.
- الملفات: `AI_WORK_SYNC.md`, `AI_ACTIVE_TASK.json`, `AI_HANDOFF.md`, `tools/ai-work-coordination.ps1`, `AGENTS.md`, `CLAUDE.md`, `scripts/check.mjs`.
- التحقق: `npm.cmd run check` و`git diff --check`.
- المتبقي: لا شيء بعد رفع التغييرات إلى GitHub.
- ملاحظة للمتابع: اقرأ آخر سجل وملف القفل قبل تعديل أي ملف.

## 2026-08-17 - Codex - ربط مركز القيادة بمخزون Ameen Live الحالي

- Status: completed and deployed
- PR: #66
- Merge commit: `3e2c008f41339327009867d88a4652f4708f3c99`
- Files: `src/business-snapshot.js`, `src/command-center.js`, `scripts/check.mjs`, `index.html`, `public/service-worker.js`
- Result: Business Snapshot now prefers a fresh 15-minute read-only Ameen Live stock cache; Command Center counts live items/out-of-stock/low-cover, shows last live read, and answers «شو لازم أشتري؟» with actual current quantities and «بحاجة مراجعة شراء» without inventing order quantities. Live customers remain reference-only; receivables stay on trusted accounting reports.
- Safety: No Ameen SQL, Worker, Broker, permissions, write scripts, or browser secrets changed. Ameen access remains SELECT-only.
- Checks: PR workflows Business OS Foundation, Decision Engine Check, and فحص المشروع succeeded. Deploy TOBACCO Web run 32027372040 succeeded; production assets verified on ozktobacco.com.
