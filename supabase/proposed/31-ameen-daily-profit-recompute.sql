-- Migration 31: إعادة احتساب الأيام الماضية في ameen_daily_profit (2026-11-25، بموافقة عمر على الدراسة).
--
-- لماذا: tools/push-daily-profit.ps1 يحسب اليوم الحالي وحده، فكل يوم ماضٍ يبقى
-- لقطة مجمّدة من آخر مزامنة له. مطابقة 2026-11-25 مع الأمين (قراءة فقط) وجدت
-- 80 يوماً من 99 لا تطابق، وسبعة أيام غائبة، لأن إعادة حساب التكلفة وتعديل
-- الفواتير والمصاريف المؤرّخة بتاريخ سابق لا تصل إلى Supabase أبداً.
--
-- ما تفعله:
--   * private.ameen_daily_profit_revisions: سجل إلحاقي لكل تغيير تحدثه إعادة
--     الاحتساب (الملخص القديم والجديد)، وهو مصدر التراجع.
--   * public.recompute_ameen_daily_profit(date, jsonb) لهوية المزامنة وحدها
--     (ameen_daily_profit_is_sync_writer، نفس حارس upsert_ameen_daily_profit):
--       - ترفض اليوم الحالي والمستقبل (اليوم يبقى لـupsert_ameen_daily_profit)،
--         وما هو أقدم من 400 يوم.
--       - لا تكتب إن لم يتغيّر المحتوى المالي (كل الملخص عدا synced_at وsync_mode).
--       - لا تلمس created_at لصف موجود: البوت والمساعد ومراقب المهام يقرؤون
--         «الأحدث» وحداثة المزامنة من created_at، فإعادة احتساب الماضي لا تخفي
--         توقف مزامنة اليوم ولا تعرض يوماً قديماً كأنه اليوم.
--       - تُرجع 'inserted' أو 'updated' أو 'unchanged'.
--   * private.ameen_daily_profit_revert_revisions(timestamptz): تعيد كل يوم تغيّر
--     منذ لحظة معيّنة إلى ملخصه السابق، وتحذف الأيام التي أُدرجت. للمالك/SQL Editor وحده.
--
-- قواعد ثابتة:
--   * لا شيء هنا يقرأ الأمين أو يكتب فيه.
--   * المعادلة لا تتغيّر: الملخص يُحسب على Windows بنفس tools/daily-profit-lib.ps1.
--   * لا يمسّ upsert_ameen_daily_profit ولا سياسات RLS ولا أي مصدر آخر في inventory_reports.

begin;

do $$ begin
  if to_regclass('public.inventory_reports') is null
     or to_regclass('public.inventory_reports_ameen_daily_profit_date_uidx') is null
     or to_regprocedure('public.ameen_daily_profit_is_sync_writer()') is null
     or to_regprocedure('public.upsert_ameen_daily_profit(date, jsonb, jsonb)') is null then
    raise exception 'migration 31 guard: ameen_daily_profit base objects are missing';
  end if;
  if to_regclass('private.ameen_daily_profit_revisions') is not null
     or to_regprocedure('public.recompute_ameen_daily_profit(date, jsonb)') is not null then
    raise exception 'migration 31 guard: already applied';
  end if;
end $$;

create schema if not exists private;

create table private.ameen_daily_profit_revisions (
  id bigint generated always as identity primary key,
  report_date date not null,
  action text not null check (action in ('inserted', 'updated')),
  report_id uuid not null,
  old_summary jsonb,
  new_summary jsonb not null,
  changed_by uuid,
  changed_at timestamptz not null default now()
);
create index ameen_daily_profit_revisions_changed_idx
  on private.ameen_daily_profit_revisions (changed_at desc, id desc);
revoke all on table private.ameen_daily_profit_revisions from public, anon, authenticated;

-- المحتوى المالي للملخص: كل شيء عدا ختم وقت المزامنة ونوعها.
create function private.ameen_daily_profit_financial(p_summary jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_summary, '{}'::jsonb) - 'synced_at' - 'sync_mode';
$$;
revoke all on function private.ameen_daily_profit_financial(jsonb) from public, anon, authenticated;

create function public.recompute_ameen_daily_profit(
  p_report_date date,
  p_summary jsonb
) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_today date := (now() at time zone 'Asia/Damascus')::date;
  v_row public.inventory_reports;
  v_key text;
begin
  if v_uid is null then
    raise exception 'recompute_ameen_daily_profit requires an authenticated caller';
  end if;
  if not public.ameen_daily_profit_is_sync_writer() then
    raise exception 'recompute_ameen_daily_profit is restricted to the trusted sync identity';
  end if;
  if p_report_date is null or p_report_date >= v_today or p_report_date < v_today - 400 then
    raise exception 'recompute_ameen_daily_profit: report_date % is outside the past-days window', p_report_date;
  end if;
  if jsonb_typeof(p_summary) is distinct from 'object'
     or p_summary ->> 'report_date' is distinct from p_report_date::text
     or p_summary ->> 'sync_mode' is distinct from 'recompute'
     or jsonb_typeof(p_summary -> 'complete') is distinct from 'boolean' then
    raise exception 'recompute_ameen_daily_profit: summary does not describe %', p_report_date;
  end if;
  foreach v_key in array array['sales_gross', 'sales_cost', 'discounts', 'sales_extras', 'returns',
    'returns_cost', 'net_sales', 'net_cost', 'gross_profit', 'expenses', 'net_profit',
    'sales_bill_count', 'return_bill_count', 'expense_entry_count', 'line_count', 'missing_cost_lines'] loop
    if jsonb_typeof(p_summary -> v_key) is distinct from 'number' then
      raise exception 'recompute_ameen_daily_profit: summary.% must be a number', v_key;
    end if;
  end loop;
  if (p_summary ->> 'complete')::boolean is distinct from ((p_summary ->> 'missing_cost_lines')::numeric = 0) then
    raise exception 'recompute_ameen_daily_profit: complete must equal (missing_cost_lines = 0)';
  end if;

  select * into v_row from public.inventory_reports
   where source = 'ameen_daily_profit' and report_date = p_report_date
   for update;

  if not found then
    insert into public.inventory_reports (source, report_date, summary, items, created_by)
    values ('ameen_daily_profit', p_report_date, p_summary, '[]'::jsonb, v_uid)
    on conflict (report_date) where source = 'ameen_daily_profit' do nothing
    returning * into v_row;
    if v_row.id is not null then
      insert into private.ameen_daily_profit_revisions (report_date, action, report_id, old_summary, new_summary, changed_by)
      values (p_report_date, 'inserted', v_row.id, null, p_summary, v_uid);
      return 'inserted';
    end if;
    -- صف أُدرج للتو من جلسة أخرى: نكمل على مسار التحديث.
    select * into v_row from public.inventory_reports
     where source = 'ameen_daily_profit' and report_date = p_report_date
     for update;
  end if;

  if private.ameen_daily_profit_financial(v_row.summary) = private.ameen_daily_profit_financial(p_summary) then
    return 'unchanged';
  end if;

  update public.inventory_reports set summary = p_summary where id = v_row.id;
  insert into private.ameen_daily_profit_revisions (report_date, action, report_id, old_summary, new_summary, changed_by)
  values (p_report_date, 'updated', v_row.id, v_row.summary, p_summary, v_uid);
  return 'updated';
end;
$$;

revoke all on function public.recompute_ameen_daily_profit(date, jsonb) from public, anon, service_role;
grant execute on function public.recompute_ameen_daily_profit(date, jsonb) to authenticated;

-- تراجع البيانات: كل تغيير منذ p_since، من الأحدث إلى الأقدم.
create function private.ameen_daily_profit_revert_revisions(p_since timestamptz)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  r record;
  n integer := 0;
begin
  if p_since is null then raise exception 'p_since is required'; end if;
  for r in
    select * from private.ameen_daily_profit_revisions
     where changed_at >= p_since
     order by changed_at desc, id desc
  loop
    if r.action = 'updated' then
      update public.inventory_reports set summary = r.old_summary
       where id = r.report_id and source = 'ameen_daily_profit';
    else
      delete from public.inventory_reports
       where id = r.report_id and source = 'ameen_daily_profit';
    end if;
    delete from private.ameen_daily_profit_revisions where id = r.id;
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke all on function private.ameen_daily_profit_revert_revisions(timestamptz) from public, anon, authenticated, service_role;

commit;
