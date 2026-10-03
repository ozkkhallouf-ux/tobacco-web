-- ============================================================================
-- حالة تنبيه غياب الزبون المهم (ذكاء الزبائن — CUSTOMER_INACTIVE_5D).
--
-- صف لكل زبون نُبِّه عنه لغيابه الحالي، مفتاحه dedupe_key = الزبون + تاريخ آخر فاتورة
-- بيع: تنبيه واحد لكل غياب، لا يُعاد يومياً. حين يعود الزبون ويشتري يتغيّر تاريخ آخر
-- فاتورته فيُحذف صفّه، وغيابه التالي يأخذ مفتاحاً جديداً.
--
-- القواعد لا تُكرَّر هنا: من هو «المهم» ومتى يُعدّ غائباً ونص الرسالة كلها في
-- src/customer-intelligence.js (buildInactivityAlert). هذا الملف تخزين وصلاحيات وجدولة.
--
-- الصلاحيات: القراءة للمالك وحده (is_owner())، ولا كتابة من المتصفح. الكتابة من
-- الدالة الطرفية customer-inactivity-alert بمفتاح الخدمة، تستدعيها pg_cron عبر pg_net
-- برمز من app_secrets. الإرسال عبر notify_telegram القائمة (لا تعديل عليها).
-- الوضع الافتراضي تجريبي (أعداد فقط بلا إرسال ولا حالة) حتى يضبط المالك
-- bot_config.customer_inactivity_alert_mode = 'live'.
--
-- لا علاقة لهذا الملف بقاعدة الأمين (لا قراءة ولا كتابة عليها).
-- ============================================================================

create table if not exists public.customer_inactivity_alerts (
  dedupe_key text primary key,
  customer_guid text,
  customer_key text,
  last_purchase_date date not null,
  alerted_at timestamptz not null default now(),
  constraint customer_inactivity_alerts_identity check (customer_guid is not null or customer_key is not null),
  constraint customer_inactivity_alerts_key_shape check (dedupe_key like 'CUSTOMER_INACTIVE_5D:%')
);

comment on table public.customer_inactivity_alerts is
  'One row per key customer already alerted for the current absence (customer + last sale date). Written only by the customer-inactivity-alert edge function; owner read-only.';

alter table public.customer_inactivity_alerts enable row level security;
alter table public.customer_inactivity_alerts force row level security;

drop policy if exists customer_inactivity_alerts_owner_select on public.customer_inactivity_alerts;
create policy customer_inactivity_alerts_owner_select
  on public.customer_inactivity_alerts
  for select
  to authenticated
  using ((select public.is_owner()));

revoke all on table public.customer_inactivity_alerts from public, anon, authenticated;
grant select on table public.customer_inactivity_alerts to authenticated;
grant select, insert, update, delete on table public.customer_inactivity_alerts to service_role;

-- ── الجدولة: يومياً 07:00 UTC (10:00 دمشق) بعد بدء مزامنة الفواتير الصباحية. تقرير
-- فواتير أقدم من 90 دقيقة يرسل بلاغ «البيانات قديمة» بدل التنبيهات. غياب الرمز في
-- app_secrets يجعل الجدولة عملية فارغة.
create or replace function public.dispatch_customer_inactivity_alert()
returns void
language plpgsql
security definer
set search_path = public, net
as $$
declare
  alert_token text;
begin
  select value into alert_token from public.app_secrets where name = 'customer_inactivity_alert_token' limit 1;
  if alert_token is null or alert_token = '' then return; end if;

  perform net.http_post(
    url := 'https://dyxbirfpxeocqffnfdeb.supabase.co/functions/v1/customer-inactivity-alert',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-OZK-Inactivity-Alert-Token', alert_token
    ),
    body := jsonb_build_object('action', 'daily_check')
  );
end;
$$;
revoke all on function public.dispatch_customer_inactivity_alert() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'customer-inactivity-alert') then
    perform cron.unschedule('customer-inactivity-alert');
  end if;
  perform cron.schedule('customer-inactivity-alert', '0 7 * * *', 'select public.dispatch_customer_inactivity_alert();');
end $$;
