# هجرات خارج السلسلة — `supabase/superseded/`

هذا المجلد **خارج** `supabase/migrations/` عن قصد. Supabase CLI (`db push`، `--include-all`، Preview Branching) لا يقرأ إلا `supabase/migrations/*.sql`، فلا يُطبَّق أي ملف هنا آلياً أبداً. **لا تُعِد أي ملف منها إلى `supabase/migrations/`.**

نُقلت إلى هنا يوم 2026-10-03 بعد تدقيق قراءة فقط على الإنتاج (`dyxbirfpxeocqffnfdeb`). التقرير الكامل في `/mnt/project-files/migration-drift-audit/audit-2026-10-03.md` على مجلد المشروع.

ليس لأيٍّ منها إصدار مسجّل في `supabase_migrations.schema_migrations`. وصفُ ما على الإنتاج مأخوذ من الكتالوج الحي بتاريخ القراءة.

| الملف | الحالة على الإنتاج | لماذا هنا |
|---|---|---|
| `20260902070000_p2_security_definer_views_audit.sql` | ⛔ **لم يُطبَّق، وتشغيله خطير.** | خطوته الثالثة تنفّذ `grant select on public.approved_price_sync_feed to anon, authenticated` (التفصيل بعد الجدول). |
| `20260902090000_p2_pg_net_schema_analysis.sql` | تحقق فقط بلا DDL. شروطه متحققة على الإنتاج: pg_net بلا كائنات في `public`، والدوال الثلاث `dispatch_*` تستخدم `net.http_post`. | لا يغيّر شيئاً، فلا داعي لإبقائه معلّقاً بلا تسجيل. |
| `20260915140000_khalil_audit_migration_history_reconciliation.sql` | ملاحظة تسوية للتاريخ، بلا DDL. الكائنات التي يتحقق منها موجودة. | توثيقي فقط. |

تفصيل `20260902070000`: لو شُغّلت خطوته الثالثة لأعادت فتح قراءة anon التي أغلقتها `20260929235655_price_feeds_security_invoker` (#291). على الإنتاج اليوم الـView `security_invoker=on` وصلاحياته لـ`postgres` و`service_role` فقط. الجزءان الآخران معرَّفان في السلسلة الفعّالة نفسها، لا في هذا الملف وحده:
- `available_price_sync_feed` بصلاحية SELECT فقط: في `20260929235655_price_feeds_security_invoker`.
- `bot_health_alerts` بـ`security_invoker=on`: في `20260914130000_bot_health_alerts_dispatched_and_failed_windows`.

الحارس `scripts/check-migration-drift-guard.mjs` يرفض:
- عودة أي من هذه الملفات إلى `supabase/migrations/`.
- أي هجرة فعّالة تمنح anon أو authenticated صلاحية على `approved_price_sync_feed`.

## باقيان عمداً في `supabase/migrations/` رغم أنهما غير مسجّلين

- `20260921073000_approved_price_items_item_guid_unique.sql`: الفهرس الفريد `approved_price_items_item_guid_unique` على `upper(item_guid)`.
  - على الإنتاج: موجود بتعريف مطابق حرفياً، لكنه طُبّق خارج السجل. لا يوجد إصدار مسجّل بهذا الرقم ولا بغيره (قراءة 2026-10-03).
  - يبقى في السلسلة لأنه خط الدفاع الأخير ضد تكرار `item_guid`. أي قاعدة تُبنى من الهجرات (Preview، reset، استرجاع) يجب أن تحصل عليه (ملاحظة Codex P1 على #305).
  - الملف `create unique index if not exists`، فهو no-op على الإنتاج.
  - `check-migration-drift-guard.mjs` يفشل إذا خرج من `supabase/migrations/`.

- `20260914130000_bot_health_alerts_dispatched_and_failed_windows.sql`: يعيد إنشاء `bot_health_alerts` بـ`security_invoker=on`، مع نافذة `failed` بـ`sent_at` وفحص صفوف `dispatched` العالقة.
  - على الإنتاج: مطبّق خارج السجل. `pg_get_viewdef` الحي يطابقه، والتعليق مطابق حرفياً (قراءة 2026-10-03).
  - يبقى في السلسلة لأنه الهجرة الفعّالة الوحيدة التي تعرّف هذه الـview. بدونه تحصل أي قاعدة تُبنى من الهجرات على تعريف أقدم أو لا شيء (ملاحظة Codex P1 الثانية على #305).
  - `create or replace view` بنفس التعريف، فهو بلا أثر على الإنتاج.
  - `check-migration-drift-guard.mjs` يفشل إذا خرج من `supabase/migrations/`.

## لا ملف هنا هو التعريف الوحيد لشيء يُنفَّذ (مراجعة 2026-10-03)

- `20260902070000`: خطوته ١ معرّفة في `20260929235655`، وخطوته ٢ في `20260914130000`. أما خطوته ٣ فهي المنحة الخطرة المقصود حجبها.
- `20260902090000`: فحص قراءة فقط (`raise notice`/`raise exception`)، بلا DDL ولا تغيير حالة.
- `20260915140000`: فحص وجود كائنات بالقراءة فقط، بلا DDL ولا تغيير حالة.

## ما بقي معلّقاً عمداً في `supabase/migrations/`

ملفان غير مطبّقين وغير مسجّلين، تُركا كما هما بانتظار قرار المالك:

- `20260902050000_khalil_audit_tables_explicit_deny.sql`: يضيف سياستي `RESTRICTIVE ... USING(false)` على `khalil_audit_cursor` و`khalil_audit_notify_failures`.
  - لا يغيّر السلوك: المالك `postgres` يتجاوز RLS (force=off)، ولا صلاحية لغيره على الجدولين.
  - يُسكت تحذير Advisor `rls_enabled_no_policy` فقط.
- `20260902080000_p2_heartbeat_rls_initplan.sql`: يعيد إنشاء سياسة INSERT على `khalil_audit_sync_heartbeat` بـ`(select auth.uid())` بدل `auth.uid()`.
  - نفس الشرط الأمني.
  - الفائدة أداء (InitPlan)، وإسكات تحذير `auth_rls_initplan`.

## الملفات التي غيّرت رقمها في نفس التدقيق

أربعة ملفات كانت مطبّقة على الإنتاج برقم آخر. أجسام الدوال مطابقة حرفياً، بمقارنة md5 لـ`prosrc` مع الملف. أُعيدت تسميتها لتطابق الرقم المسجّل:

| قبل | بعد |
|---|---|
| `20260914120000_telegram_delivery_confirmation_retry` | `20260914121528_…` |
| `20260921120000_business_audit_log_item_identity_changes` | `20260921104828_…` |
| `20260926140000_evening_report_supplier_purchases_from_bills` | `20260926234241_…` |
| `20260928140000_prune_ameen_warehouse_stock_reports` | `20260928145121_…` |

ملاحظة على `20260914121528`: نص `statements` المسجّل في `supabase_migrations.schema_migrations` لهذا الإصدار نسخة أقدم من الملف (بلا إحياء `failed` بعد ساعة، وبلا مهلة 15 دقيقة لـ`no_response`، وبلا شرط `result.message_id`). الدالة الحية `dispatch_telegram_outbox` تطابق الملف، لأن المراجعات اللاحقة طُبّقت خارج السجل (قراءة 2026-10-03). المرجع هو الملف والدالة الحية، لا نص السجل.
