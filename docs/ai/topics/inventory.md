# تقرير موضوع المخزون والجرد

آخر تحديث: 2026-09-28

تنظيف `ameen_warehouse_stock_reports`: مهمة Windows «TOBACCO Ameen Warehouse Reports» (كل ساعة عبر `tools/sync-ameen-warehouse-reports.ps1`، حد التنفيذ 15 دقيقة و`RestartCount` 3 في `tools/register-ameen-warehouse-reports-task.ps1`) كانت تحذف الصفوف الأقدم من يومين بطلب DELETE واحد. دور `authenticated` مهلته 8 ثوانٍ. الفهرس `ameen_warehouse_stock_reports_created_at_idx` موجود. `smart_inventory_sessions_source_report_id_fkey` على `source_report_id` بلا ON DELETE (`confdeltype` a)، و`inventory_recon_sessions_source_report_id_fkey` على نفس العمود بـ`ON DELETE SET NULL` (`confdeltype` n). لا يُحوَّل أي منهما إلى CASCADE. الدالة `prune_ameen_warehouse_stock_reports` (هجرة `20260928140000`، لا تُطبَّق من المستودع، وتتوقف إذا غاب `inventory_recon_sessions` لأنه ليس ضمن `supabase/migrations`) تقفل حتى 40 تقريراً بـ`FOR UPDATE SKIP LOCKED` ثم تعيد فحص الإشارتين وتحذف والقفلة ما زالت ممسوكة، حتى لا يُفرَّغ `source_report_id` في المطابقة ولا تفشل الدفعة على مفتاح الجرد الذكي. السكربت يناديها حتى 24 دفعة (حوالي 8 دقائق مع مهلة الطلب 20 ثانية) كي تبقى الجولة داخل حد الـ15 دقيقة. مهلة البيان 57014 تُعاد بحد 3 ثم تتوقف الجولة؛ مفتاح أجنبي غير متوقع يوقفها فوراً. بلا كتابة على `smart_inventory_*` أو `inventory_recon_*`. الفحوص: `tools/tests/Test-WarehouseStockRetentionBatch.ps1` و`supabase/tests/prune-ameen-warehouse-stock-reports.sql`. بعد الدمج: طبّق الهجرة يدوياً ثم اسحب السكربت، بلا إعادة تسجيل المهمة وبلا مسّ لبيانات الجرد.

## الحالة الحالية

دُمج ونُشر تنفيذ الجرد الذكي اليومي على الموقع الحي في 2026-08-23. طُبّق Backend الجرد على مشروع Supabase الحي ونُشرت Edge Function `inventory-auth`. الواجهة تسمح لموظف `inventory_counter` باختيار أي مستودع فعلي وبدء/متابعة جلسة يومية مشتركة، مع قفل ذري قصير لكل صنف وأول حفظ يفوز. الموظف لا يستلم كمية الأمين أو الفرق، بينما يرى المالك لوحة كل المستودعات والتقرير المقارن والحركات بعد وقت القطع وإعادة العد/التصحيح وسجل التدقيق والتصدير.

تسجيل موظف الجرد مستقل باسم مستخدم وكلمة مرور: المالك ينشئ الحساب من لوحة الجرد؛ الاسم يطبع ويجب أن يكون فريداً، والهوية الفعلية هي `auth.users.id`. كلمة المرور يحفظها Supabase Auth فقط. التحويل من اسم المستخدم إلى هوية Auth داخلية يتم داخل Edge Function ولا يرجع البريد الاصطناعي أو service role إلى الواجهة. تعطيل الحساب أو إعادة تعيين كلمة المرور يحذف جلسات Auth، وكل RPC حساس يتحقق أيضاً من وجود `session_id` في `auth.sessions` حتى لا تستمر جلسة قديمة برمز وصول لم تنته صلاحيته بعد.

أُنشئت ثلاثة حسابات داخلية مفعلة بدور `inventory_counter`: أمين المستودع، عثمان، ومنذر. تم التحقق من دخول الحسابات الثلاثة ومن وصول حساب الموظف إلى قائمة المستودعات الفعلية فقط. تحقق الاختبار الحي من ظهور 5 مستودعات، ومن رفض الوصول المباشر إلى `smart_inventory_expectations` ولوحة المالك وجدول حسابات الموظفين بحالة HTTP 403. الحد الأدنى الحالي لكلمة مرور الموظف 8 محارف وفق الموافقة الصريحة، ويُنصح بتغيير كلمات المرور الأولية المتوقعة بعد أول دخول.

في 2026-08-23 نُشرت `inventory-auth` v8 بعد أن كان تحقق المالك يعيد 403 رغم صحة الدور والجلسة. أصبح التحقق من Bearer token يتم بخادم Auth الإداري، مع بقاء شرط `app_metadata.role=owner` وفحص `session_id` الحي عبر `smart_inventory_has_session_for_service` دون تخفيف. تحقق الموقع الحي من ظهور حسابات الجرد الثلاثة للمالك. لم تُغيّر كلمة مرور منذر؛ المستخدم تذكر الكلمة الحالية ونجح في فتح الحساب، والحساب فعال وغير مقفل حالياً.

يعزل ترحيل `smart_inventory_counter_isolation` حسابات الجرد عن دور قاعدة البيانات الإداري `authenticated`: تُصدر جلساتها بدور قاعدة البيانات `anon` وتُمنح فقط RPCs العد الأعمى التي تتحقق من `app_metadata` و`auth.uid()` والجلسة الحية. توجد أيضاً سياسة RLS تقييدية تمنع أي token قديم بدور `authenticated` ويحمل `inventory_counter` من قراءة أو تعديل جداول النظام. لا توجد منح جداول مباشرة للحساب الجديد.

## المصدر الموثوق

حركات فواتير الأمين في `AmnDb002` مع أعلام الإدخال والإخراج، لا حقل `ms000` بعد تدوير السنة. مصدر جلسة الجرد هو أحدث `ameen_warehouse_stock_reports` للمستودع عند وقت القطع، مع `smart_inventory_movement_adjustments` للحركات الموقعة بعد القطع. لا توجد أي كتابة أو تسوية إلى الأمين.

## نطاق الملفات

`src/business-snapshot.js`, `src/inventory-recon-calc.js`, `src/smart-inventory.js`, `src/supabase-client.js`, `src/app.js`, `src/styles.css`, `tools/ameen-stock-query.sql`, `tools/ameen-sync-agent.ps1`, `tools/push-ameen-warehouse-stock.ps1`, `tools/ameen-warehouse-stock-retention.ps1`, `scripts/item-snapshot-*.mjs`, `scripts/check-smart-inventory.mjs`, `scripts/check-warehouse-stock-prune.mjs`, `supabase/inventory-reconciliation-table.sql`, `supabase/smart-inventory.sql`, `supabase/migrations/20260928140000_prune_ameen_warehouse_stock_reports.sql`, `supabase/migrations/*smart_inventory_counter_isolation.sql`, `supabase/functions/inventory-auth/index.ts`, `supabase/tests/smart-inventory-security.sql`, `supabase/tests/prune-ameen-warehouse-stock-reports.sql`.

## قيود ثابتة

- تجميع الأصناف المتطابقة بعد تطبيع الاسم قبل مقارنة مخزون النشرة.
- تقرير المخزون لا يدمج الأصناف الموجبة؛ النافد يظهر وفق قواعد المبيع الحديث.
- «قريب النفاد» يعتمد تغطية حركة 30 يوماً مع حدود الأمان الخاصة، لا حداً ثابتاً فقط.
- جلسة واحدة مشتركة لكل مستودع/يوم بتوقيت `Asia/Beirut`، وتعدد الموظفين مسموح على أصناف مختلفة.
- الصنف المحفوظ لا يُفتح تلقائياً ولا يستطيع موظف الكتابة فوق عد موظف آخر. إعادة العد تحتاج فتحاً من المالك وموظفاً آخر، والتصحيح/إعادة فتح الجلسة للمالك فقط مع سبب.
- الفراغ ليس صفراً؛ الحالات المنفصلة: معدود، صفر فعلي، غير موجود في موقعه، تالف، وغير معدود.
- `inventory_counter` مساره الوحيد `smartInventory` ولا تبدأ له loaders القديمة. لا تُمنح جداول الجرد صلاحيات REST مباشرة؛ الوصول عبر RPC ضيقة فقط.
- `smart_inventory_expectations` والفروقات وسجل المقارنة owner-only، ولا تظهر في Counter RPC أو HTML/JS state للموظف.
- لا تعتمد صلاحيات الجرد على `user_metadata` أو الاسم المعروض أو البريد؛ الدور في `app_metadata` والهوية `auth.uid()`.
- دفتر الجرد المطبوع أعمى: مستودع/صفحة/كود/اسم/وحدة وحقل فارغ، بلا كمية أمين.
- إغلاق المستودع يضع إشعاراً فورياً في قناة الإشعارات الموجودة إن كانت مفعلة. `smart_inventory_enqueue_daily_summary()` يجهز تنبيه التأخر والملخص اليومي بمفاتيح منع تكرار، لكنه غير مجدول عمداً؛ ربطه بمهمة الإنتاج يحتاج موافقة نشر منفصلة.

## فحوص إلزامية

`npm.cmd run check` (يتضمن `scripts/check-smart-inventory.mjs`)، `git diff --check`، وفحوص المتصفح للمسار والواجهة. شغّل `supabase/tests/smart-inventory-security.sql` بعد أي تغيير Backend، ثم اختبارات تكامل بحسابي جرد ومالك: سباق صنف واحد، صنفين مختلفين، انتهاء claim، منع REST، صفر مقابل فراغ، إعادة العد العمياء، إعادة فتح owner-only، تعطيل/reset، ورفض JWT قديم. قارن عينة مستقلة من حركات أمين وتحقق من حداثة snapshot وعدد الصفوف.

## الخطوة التالية

نفّذ Pilot تشغيلياً في مستودع واحد و20–30 صنفاً بإدخال كميات حقيقية من موظف جرد؛ لا تنشئ كميات اختبارية وهمية في الإنتاج. بعد نجاح العينة يمكن توسيع الجرد لبقية المستودعات.
