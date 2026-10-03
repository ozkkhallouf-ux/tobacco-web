-- ============================================================================
-- جدولة تنبيه النفاد حسب أولوية المبيعات بـpg_cron كل 15 دقيقة.
--
-- لماذا: جدولة GitHub Actions (cron '*/15' في .github/workflows/stock-priority-alerts.yml)
-- غير مضمونة؛ يوم 2026-10-03 شغّلها GitHub تلقائياً مرة واحدة في 6 ساعات. قرار المالك:
-- النقل إلى pg_cron بنفس حماية customer-inactivity-alert (رمز في app_secrets).
--
-- لا قواعد هنا: الحساب والرسالة ومنع التكرار (6 ساعات) في src/stock-alert-priority.js،
-- تشغّله الدالة الطرفية stock-priority-alert. هذا الملف دالة استدعاء وجدولة فقط.
--
-- الرمز: صف app_secrets.name = 'stock_priority_alert_token' يُضاف عند التطبيق ولا يُكتب
-- في المستودع. غيابه يجعل الجدولة عملية فارغة. لا تعديل على notify_telegram ولا
-- telegram_outbox، ولا علاقة بقاعدة الأمين.
--
-- طُبِّق على المشروع الحي في 2026-10-03 بموافقة المالك، بعد نشر الدالة وإنشاء الرمز
-- (الإصدار المسجَّل 20261003113851). اسم الملف كان 20261003110000_… وأُعيدت تسميته
-- ليطابق الإصدار المسجَّل. لا يُعاد تشغيله.
-- ============================================================================

create or replace function public.dispatch_stock_priority_alert()
returns void
language plpgsql
security definer
set search_path = public, net
as $$
declare
  alert_token text;
begin
  select value into alert_token from public.app_secrets where name = 'stock_priority_alert_token' limit 1;
  if alert_token is null or alert_token = '' then return; end if;

  perform net.http_post(
    url := 'https://dyxbirfpxeocqffnfdeb.supabase.co/functions/v1/stock-priority-alert',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-OZK-Stock-Alert-Token', alert_token
    ),
    body := jsonb_build_object('action', 'scheduled_check')
  );
end;
$$;
revoke all on function public.dispatch_stock_priority_alert() from public, anon, authenticated;

do $$
begin
  -- قاعدة بلا pg_cron (إعادة تشغيل محلية أو فرع معاينة): الدالة تُنشأ، والجدولة تُتخطّى.
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'stock-priority-alert: pg_cron absent, skipping schedule';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'stock-priority-alert') then
    perform cron.unschedule('stock-priority-alert');
  end if;
  perform cron.schedule('stock-priority-alert', '*/15 * * * *', 'select public.dispatch_stock_priority_alert();');
end $$;

-- ============================================================================
-- مراقبة الجدولة (طلب المالك 2026-10-03): فشل الدالة مرتين متتاليتين، أو لا تشغيل ناجح
-- أكثر من 45 دقيقة ⇒ تنبيه «فشل الأتمتة» في تيليغرام، مرة كل 6 ساعات على الأكثر
-- (dedupe_key ثابت ونافذة 360 دقيقة داخل notify_telegram).
--
-- الدالة الطرفية تسجّل نتيجة كل تشغيل مجدول (لا dryRun ولا رمز خاطئ) عبر
-- record_stock_priority_alert_run (service_role وحده). فشل لا يصل إلى التسجيل أصلاً
-- (الدالة غير منشورة، رمز لا يطابق، انقطاع) يظهر هنا كغياب نجاح أكثر من 45 دقيقة.
-- ============================================================================
create schema if not exists private;

create table if not exists private.stock_priority_alert_runs (
  id bigserial primary key,
  ran_at timestamptz not null default now(),
  ok boolean,             -- null = علامة بدء المراقبة، لا تشغيل
  detail text
);
create index if not exists stock_priority_alert_runs_ran_at_idx on private.stock_priority_alert_runs (ran_at desc);
revoke all on table private.stock_priority_alert_runs from public, anon, authenticated;

-- علامة البدء: «آخر نجاح» قبل أول تشغيل هو وقت تطبيق الهجرة، فلا إنذار فوري ولا صمت دائم.
insert into private.stock_priority_alert_runs (ok, detail)
select null, 'monitor_started'
where not exists (select 1 from private.stock_priority_alert_runs);

create or replace function public.record_stock_priority_alert_run(p_ok boolean, p_detail text default null)
returns void
language sql
security definer
set search_path = private, public
as $$
  insert into private.stock_priority_alert_runs (ok, detail) values (p_ok, left(p_detail, 200));
$$;
revoke all on function public.record_stock_priority_alert_run(boolean, text) from public, anon, authenticated;
grant execute on function public.record_stock_priority_alert_run(boolean, text) to service_role;

create or replace function public.watch_stock_priority_alert()
returns void
language plpgsql
security definer
set search_path = private, public
as $$
declare
  last_two boolean[];
  last_ok timestamptz;
  last_success timestamptz;
  reason text;
begin
  -- الميزة غير مفعّلة (لا رمز) ⇒ لا مراقبة.
  if not exists (select 1 from public.app_secrets where name = 'stock_priority_alert_token' and coalesce(value, '') <> '') then
    return;
  end if;

  select array_agg(ok order by ran_at desc) into last_two
  from (select ok, ran_at from private.stock_priority_alert_runs where ok is not null order by ran_at desc limit 2) r;
  select max(ran_at) into last_ok from private.stock_priority_alert_runs where ok is not false;
  select max(ran_at) into last_success from private.stock_priority_alert_runs where ok;

  if coalesce(array_length(last_two, 1), 0) = 2 and last_two[1] = false and last_two[2] = false then
    reason := 'فشلت دالة تنبيه النفاد مرتين متتاليتين';
  elsif last_ok is null or last_ok < now() - interval '45 minutes' then
    reason := 'لا تشغيل ناجح لتنبيه النفاد منذ أكثر من 45 دقيقة';
  end if;

  if reason is not null then
    perform public.notify_telegram(
      'automation_failure',
      format(E'🚨 فشل الأتمتة: تنبيه النفاد حسب الأولوية (pg_cron)\n%s\nآخر نجاح: %s',
        reason,
        coalesce(to_char(last_success at time zone 'Asia/Damascus', 'YYYY-MM-DD HH24:MI') || ' (دمشق)', 'لا نجاح منذ بدء المراقبة')),
      'automation-failure:stock-priority-alert',
      360
    );
  end if;

  delete from private.stock_priority_alert_runs where ran_at < now() - interval '3 days' and ok is not null;
end;
$$;
revoke all on function public.watch_stock_priority_alert() from public, anon, authenticated;

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'stock-priority-alert-watch: pg_cron absent, skipping schedule';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'stock-priority-alert-watch') then
    perform cron.unschedule('stock-priority-alert-watch');
  end if;
  perform cron.schedule('stock-priority-alert-watch', '*/5 * * * *', 'select public.watch_stock_priority_alert();');
end $$;
