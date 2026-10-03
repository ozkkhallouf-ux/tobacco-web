-- ============================================================================
-- تاريخ حد الائتمان الآلي (ذكاء الزبائن — STEP 2).
--
-- لقطة يومية لكل زبون: الحد الآلي (بعد التنعيم الأسبوعي)، والحد المحسوب قبله،
-- والرصيد، ونسبة الاستخدام، وأقدم دين متأخر بالأيام، والتغطية، والانضباط، ودرجة
-- الخطر، والحالة، ومكوّنات الصيغة (factors) التي يقرأ منها تفسير التغيير.
--
-- القواعد لا تُكرَّر هنا: كل رقم يحسبه src/customer-intelligence.js وحده
-- (buildCreditSnapshots). هذا الملف تخزين وصلاحيات وجدولة فقط.
--
-- الهوية `customer_guid` وحده (cu000.GUID)، لا الاسم: إعادة تسمية حساب في الأمين
-- لا تقطع تاريخه. نصّ لا uuid ليطابق شكل customerGuid في تقارير الأمين jsonb.
--
-- الصلاحيات: القراءة للمالك وحده (is_owner() من app_metadata)، ولا سياسة كتابة لأي
-- دور من المتصفح. الكتابة من الخادم وحده: الدالة الطرفية customer-credit-snapshot
-- بمفتاح الخدمة، تستدعيها pg_cron عبر pg_net برمز من app_secrets.
--
-- لا علاقة لهذا الملف بقاعدة الأمين (لا قراءة ولا كتابة عليها).
-- ============================================================================

create table if not exists public.customer_credit_history (
  customer_guid text not null,
  snapshot_date date not null,
  auto_status text not null,
  credit_status text not null,
  primary_segment text,
  credit_limit numeric,
  credit_limit_display numeric,
  credit_currency text not null default 'USD',
  limit_base numeric,
  limit_base_raw numeric,
  balance numeric,
  balance_display numeric,
  balance_currency text,
  utilization_percent numeric,
  oldest_overdue_days integer,
  oldest_open_days integer,
  coverage numeric,
  punctuality numeric,
  risk_score numeric not null,
  factors jsonb not null default '{}'::jsonb,
  engine_schema_version integer not null,
  computed_at timestamptz not null,
  written_at timestamptz not null default now(),
  primary key (customer_guid, snapshot_date),
  constraint customer_credit_history_guid_shape check (
    customer_guid ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and customer_guid <> '00000000-0000-0000-0000-000000000000'
  ),
  -- حالات الحد التي يكتبها المحرك وحدها؛ فجوات البيانات (unavailable/stale) لا تُكتب.
  constraint customer_credit_history_auto_status check (
    auto_status in ('normal', 'low_data', 'delinquent', 'inactive', 'prepaid', 'needs_review', 'non_customer')
  ),
  constraint customer_credit_history_factors_object check (jsonb_typeof(factors) = 'object')
);

comment on table public.customer_credit_history is
  'Daily automatic credit-limit snapshot per Ameen customer (customer_guid). Written only by the customer-credit-snapshot edge function from src/customer-intelligence.js; owner read-only.';

-- قراءة المتصفح بنافذة تاريخ (آخر 21 يوماً) عبر كل الزبائن.
create index if not exists customer_credit_history_snapshot_date_idx
  on public.customer_credit_history (snapshot_date);

alter table public.customer_credit_history enable row level security;
alter table public.customer_credit_history force row level security;

drop policy if exists customer_credit_history_owner_select on public.customer_credit_history;
create policy customer_credit_history_owner_select
  on public.customer_credit_history
  for select
  to authenticated
  using ((select public.is_owner()));

revoke all on table public.customer_credit_history from public, anon, authenticated;
grant select on table public.customer_credit_history to authenticated;
grant select, insert, update on table public.customer_credit_history to service_role;

-- ── الجدولة: كل ساعة، والدالة تكتب لقطة يوم المحاسبة الحالي (upsert) فقط حين تكون
-- المصادر حديثة وموسومة وعلى يوم واحد؛ آخر حساب صالح في اليوم هو لقطته. الرمز يُقرأ
-- من app_secrets على الخادم، وغيابه يجعل الجدولة عملية فارغة (لا كتابة بلا رمز).
create or replace function public.dispatch_customer_credit_snapshot()
returns void
language plpgsql
security definer
set search_path = public, net
as $$
declare
  snapshot_token text;
begin
  select value into snapshot_token from public.app_secrets where name = 'customer_credit_snapshot_token' limit 1;
  if snapshot_token is null or snapshot_token = '' then return; end if;

  perform net.http_post(
    url := 'https://dyxbirfpxeocqffnfdeb.supabase.co/functions/v1/customer-credit-snapshot',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-OZK-Credit-Snapshot-Token', snapshot_token
    ),
    body := jsonb_build_object('action', 'snapshot')
  );
end;
$$;
revoke all on function public.dispatch_customer_credit_snapshot() from public, anon, authenticated;

do $$
begin
  -- قاعدة بلا pg_cron (إعادة تشغيل محلية أو فرع معاينة): الجدول والدالة يُنشآن، والجدولة تُتخطّى.
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'customer-credit-snapshot: pg_cron absent, skipping schedule';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'customer-credit-snapshot') then
    perform cron.unschedule('customer-credit-snapshot');
  end if;
  perform cron.schedule('customer-credit-snapshot', '17 * * * *', 'select public.dispatch_customer_credit_snapshot();');
end $$;
