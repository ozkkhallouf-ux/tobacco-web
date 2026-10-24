-- proposed/23-web-push-explicit-allowlist.sql
--
-- **غير مطبَّق على الإنتاج ويتطلب موافقة المالك الصريحة.** الرقم 22 محجوز لـ#359 (أرشفة Google Drive).
--
-- لماذا (تدقيق الإشعارات 2026-10-24، /mnt/project-files/notifications-audit/audit-2026-10-24.md):
-- مرآة Telegram ← Web Push كانت تمرّر الأحداث بمرشِّح أنماط (like 'stock_%' ...). خلال 7 أيام صار
-- 88 حدثاً فقط من 510 إشعار Push، وغابت الدفعات كلها: الدفعة الفعلية من الأمين نوعها `ameen_payment`،
-- والمرشِّح يطابق `payment` حرفياً. وطلبات العملاء (`customer_request`) لم تكن في المرشِّح أصلاً.
--
-- التغيير (دالة trigger واحدة + أعمدة سجل، بلا مساس بأي trigger أو Cron أو notify_telegram):
--   ١) قائمة أنواع صريحة موثّقة بدل الأنماط (public.web_push_allowed_event_types()). ما ليس فيها لا يُنشئ
--      سجل Push، ويبقى Telegram كما هو تماماً.
--   ٢) منع التكرار: النص نفسه (العنوان + المتن) لا يُنشئ سجلاً ثانياً خلال 30 دقيقة، أياً كان نوعه.
--      أجزاء التقارير الطويلة (morning_report_debts، evening_report_*) خارج القائمة: الرسالة الرئيسية وحدها.
--   ٣) source_telegram_id يربط سجل Push بحدث Telegram الأصلي للتتبّع.
--   ٤) provider_accepted / provider_failed: عدد الاشتراكات التي **قبل مزود Push** (FCM/Apple) الرسالة لها أو
--      رفضها. القبول ليس ظهوراً على الجهاز؛ لا يوجد إيصال ظهور، والتعليقات على الأعمدة تقول ذلك صراحةً.
--
-- المستثنى عمداً (Telegram فقط)، بالاسم: morning_report_debts، evening_report_expenses، evening_report_orders،
-- evening_report_payments، evening_report_prices، evening_report_purchase_returns، evening_report_purchases،
-- evening_cash_report، collection_followup (نحو 20 يومياً)، windows، price_change، price_item_new، project_task_failure،
-- project_task_recovered، item_costs، documents، automation_failure، github_actions_failure، CUSTOMER_INACTIVE_5D،
-- ameen_cost_anomaly، price_sync_partial، price_sync_mismatch، sync_outage_detector_failed، khalil_audit_event.
--
-- ما لا يفعله: لا يعيد إرسال أي حدث قديم (يعمل على الإدراجات الجديدة في telegram_outbox فقط، ولا backfill)،
-- ولا يغيّر المستلمين. تقييد المستلمين بدور المالك يتم في Edge Function `web-push` (dispatch)، ولذلك
-- **تُنشر الدالة قبل هذه الهجرة** كي لا تصل الأنواع المالية الجديدة لحساب غير مالك.
--
-- بصمة جسم الدالة: قبل d1e5f0e91bd925e3a6cd02cf1c5b6a66 (الإنتاج 2026-10-24) ⇒ بعد 2b7bf2592546534cca021a7f1a558f0c.
-- يُشغَّل كطلب واحد أو `psql --single-transaction`. التراجع: 23-web-push-explicit-allowlist-rollback.sql.
-- الاختبار: scripts/check-web-push-allowlist.mjs (PostgreSQL محلي، بلا شبكة ولا إرسال).

begin;

do $pre$
declare
  v_body_md5 text;
begin
  if to_regclass('public.web_push_outbox') is null or to_regclass('public.telegram_outbox') is null then
    raise exception 'proposed/23 requires public.web_push_outbox and public.telegram_outbox';
  end if;
  select md5(p.prosrc) into v_body_md5
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'mirror_telegram_to_web_push';
  if v_body_md5 is distinct from 'd1e5f0e91bd925e3a6cd02cf1c5b6a66' then
    raise exception 'proposed/23: mirror_telegram_to_web_push drifted from production body (md5 %), refusing', v_body_md5;
  end if;
end
$pre$;

alter table public.web_push_outbox
  add column if not exists source_telegram_id bigint,
  add column if not exists provider_accepted integer not null default 0,
  add column if not exists provider_failed integer not null default 0;

comment on column public.web_push_outbox.provider_accepted is
  'عدد الاشتراكات التي قبل مزود Push (FCM/Apple) الرسالة لها (HTTP 201). القبول ليس دليلاً على ظهور الإشعار على الجهاز.';
comment on column public.web_push_outbox.provider_failed is
  'عدد الاشتراكات التي رفض مزود Push الرسالة لها أو تعذّر الوصول إليه.';
comment on column public.web_push_outbox.source_telegram_id is
  'معرّف الحدث الأصلي في telegram_outbox.';
comment on column public.web_push_subscriptions.last_success_at is
  'آخر قبول من مزود Push لرسالة إلى هذا الاشتراك. ليس دليلاً على ظهورها على الجهاز.';

create index if not exists web_push_outbox_dedupe_idx on public.web_push_outbox (created_at desc);

-- القائمة الصريحة الوحيدة. أي نوع جديد يُضاف هنا بقرار، لا بنمط.
create or replace function public.web_push_allowed_event_types()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    -- الدفعات: من الموقع (payment_records) ومن الأمين (لقطات الحركة اليومية)
    'payment', 'ameen_payment',
    -- الطلبات
    'customer_request', 'whatsapp_order',
    -- المخزون والائتمان
    'stock_low', 'credit_over', 'credit_near', 'credit_limit',
    -- انقطاعات المزامنة وتعافيها
    'sync_failure', 'ameen_sync_outage', 'ameen_sync_outage_recovered', 'price_sync_outage', 'price_sync_recovered',
    -- الجرد والتقارير اليومية (كانت تصل قبل هذه الهجرة، وتبقى)
    'inventory_report', 'inventory_complete', 'inventory_late', 'inventory_daily_summary',
    'daily_movement', 'daily_bill_audit', 'daily_sales',
    -- التقريران الصباحي والمسائي: الرسالة الرئيسية وحدها
    'morning_report', 'evening_report'
  ]::text[];
$$;
comment on function public.web_push_allowed_event_types() is
  'الأنواع التي تُنسخ من telegram_outbox إلى web_push_outbox. مستثنى عمداً: أجزاء التقارير (morning_report_debts، evening_report_*، evening_cash_report)، collection_followup، windows، price_change، price_item_new، project_task_*، item_costs، documents، automation_failure، github_actions_failure، CUSTOMER_INACTIVE_5D، ameen_cost_anomaly، price_sync_partial، price_sync_mismatch، sync_outage_detector_failed، khalil_audit_event.';
revoke all on function public.web_push_allowed_event_types() from public, anon, authenticated;

create or replace function public.mirror_telegram_to_web_push()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  first_line text;
  rest text;
  v_title text;
  v_body text;
begin
  if new.event_type is null or not (new.event_type = any (public.web_push_allowed_event_types())) then
    return new;
  end if;
  first_line := split_part(new.message, chr(10), 1);
  rest := regexp_replace(new.message, '^[^' || chr(10) || ']*' || chr(10) || '?', '');
  if rest = '' then rest := first_line; end if;
  v_title := left(first_line, 120);
  v_body := left(rest, 1200);
  -- النص نفسه خلال 30 دقيقة = إشعار واحد (حدثان متشابهان من مصدرين، أو إعادة إدراج).
  if exists (
    select 1 from public.web_push_outbox o
    where o.created_at > now() - interval '30 minutes'
      and o.title = v_title and o.body = v_body
  ) then
    return new;
  end if;
  insert into public.web_push_outbox(event_type, title, body, tag, source_telegram_id)
  values (new.event_type, v_title, v_body, left(new.event_type, 80), new.id);
  return new;
end;
$function$;
revoke all on function public.mirror_telegram_to_web_push() from public, anon, authenticated;

do $post$
declare
  v_body_md5 text;
  v_trigger_enabled "char";
begin
  select md5(p.prosrc) into v_body_md5
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'mirror_telegram_to_web_push';
  if v_body_md5 is distinct from '2b7bf2592546534cca021a7f1a558f0c' then
    raise exception 'proposed/23: unexpected mirror_telegram_to_web_push body after apply (md5 %)', v_body_md5;
  end if;
  select t.tgenabled into v_trigger_enabled from pg_trigger t
  where t.tgname = 'trg_mirror_telegram_to_web_push' and t.tgrelid = 'public.telegram_outbox'::regclass;
  if v_trigger_enabled is distinct from 'O' then
    raise exception 'proposed/23: trg_mirror_telegram_to_web_push is missing or disabled';
  end if;
end
$post$;

commit;
