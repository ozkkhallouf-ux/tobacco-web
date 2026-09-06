-- ============================================================
-- OZK TOBACCO — استبدال ذرّي لنافذة حركة المصاريف + علامة اكتمالها
--
-- شغّل هذا الملف في Supabase → SQL Editor → New query.
-- يفترض أن expense-entries-table.sql طُبِّق قبله (الجدول وسياساته).
-- المنتِج لا يطبّق هذا الملف — يُراجَع ويُطبَّق مستقلاً.
--
-- ── لماذا وُجد هذا الملف ──────────────────────────────────────────────────
-- `tools/push-expense-entries.ps1` يحدّث آخر `-Days` يوماً فقط (7 افتراضاً،
-- و`register-expense-entries-task.ps1` لا يمرّر غيرها)، ويترك ما قبلها على
-- حاله. فصفوف ما قبل النافذة **لا تُحدَّث أبداً**: قيد مصروف عُدِّل أو حُذف في
-- الأمين بعد خروج تاريخه منها لا يصل إلى Supabase إطلاقاً.
--
-- وكان المساعد المالي يجمع كل ما يجده في المدى المطلوب ويعرضه بوصفه
-- «إجمالي» — فسؤال «مصاريف الشهر الماضي» يُجاب برقم قد يُسقط تاريخاً كاملاً
-- أو يحمل قيوداً بائدة، بلا أي إشارة. (رصدها Codex على PR #205.) لا يمكن
-- لأي قارئ أن يعرف حدود ما هو متحقَّق ما لم يُسجَّل ذلك الحدّ صراحةً — وهذا
-- ما يفعله `expense_entries_sync_state`.
--
-- ── فرق مقصود عن نظيره في المبيعات ───────────────────────────────────────
-- `replace_sales_line_items_window` يرفض حمولة فارغة. هنا **تُقبَل**، لأن
-- أسبوعاً بلا أي مصروف حالة مشروعة تماماً في هذا العمل. ورفضها كان يعيد
-- إنتاج العطل نفسه من الجهة الأخرى: السكريبت القديم كان يخرج مبكراً عند صفر
-- صفوف **قبل** الحذف، فلو مُسحت مصاريف النافذة كلها من الأمين لبقيت صفوفها
-- في Supabase تُعرض كأنها قائمة. فالنافذة الفارغة هنا تُستبدل وتُختم كغيرها.
-- ============================================================

begin;

create index if not exists idx_expense_entries_created_at
  on public.expense_entries (created_at desc);

-- ── متطلّب مسبق: الجدول وهوية كاتب المزامنة ──────────────────────────────
do $$
begin
  if to_regclass('public.expense_entries') is null then
    raise exception
      'أوقفت التنفيذ: الجدول public.expense_entries غير موجود. طبّق expense-entries-table.sql أولاً.';
  end if;
  if to_regprocedure('public.sales_line_items_is_sync_writer()') is null then
    raise exception
      'أوقفت التنفيذ: الدالة public.sales_line_items_is_sync_writer() غير موجودة. طبّق sales-line-items-atomic-refresh.sql أولاً.';
  end if;
end $$;

-- هوية كاتب المزامنة **مُفوَّضة** لا مكرَّرة. المنتِجان (المبيعات والمصاريف)
-- يصادقان بنفس TOBACCO_SYNC_EMAIL، فالمعرّف واحد. وتكراره حرفياً هنا كان
-- يخلق مصدرَي حقيقة: تغيير حساب المزامنة يوماً ما يُحدَّث في ملف ويُنسى في
-- الآخر، فيبقى بابٌ مفتوحاً لحساب لم يعد معتمَداً — بصمت.
create or replace function public.expense_entries_is_sync_writer()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select (select public.sales_line_items_is_sync_writer());
$$;

revoke all on function public.expense_entries_is_sync_writer()
  from public, anon, service_role;
grant execute on function public.expense_entries_is_sync_writer()
  to authenticated;

-- ── علامة اكتمال النافذة ─────────────────────────────────────────────────
create table if not exists public.expense_entries_sync_state (
  source text primary key,
  sync_run_id uuid not null,
  window_start date not null,
  window_end date not null,
  row_count integer not null check (row_count >= 0),
  completed_at timestamptz not null,
  completed_by uuid not null,
  constraint expense_entries_sync_state_source_check
    check (source = 'ameen_expense_entries'),
  constraint expense_entries_sync_state_window_check
    check (window_end >= window_start)
);

alter table public.expense_entries_sync_state enable row level security;
revoke all on table public.expense_entries_sync_state
  from public, anon, authenticated;
grant select, insert, update on table public.expense_entries_sync_state
  to authenticated;

drop policy if exists "authenticated can select expense entry sync state"
  on public.expense_entries_sync_state;
drop policy if exists "sync writer can insert expense entry sync state"
  on public.expense_entries_sync_state;
drop policy if exists "sync writer can update expense entry sync state"
  on public.expense_entries_sync_state;

create policy "authenticated can select expense entry sync state"
  on public.expense_entries_sync_state
  for select to authenticated
  using (true);

create policy "sync writer can insert expense entry sync state"
  on public.expense_entries_sync_state
  for insert to authenticated
  with check ((select public.expense_entries_is_sync_writer()));

create policy "sync writer can update expense entry sync state"
  on public.expense_entries_sync_state
  for update to authenticated
  using ((select public.expense_entries_is_sync_writer()))
  with check ((select public.expense_entries_is_sync_writer()));

-- ── الاستبدال الذرّي ─────────────────────────────────────────────────────
-- الحذف والإدراج وختم الاكتمال في معاملة واحدة: إما أن تُستبدل النافذة كاملةً
-- وتُختم، أو لا يتغيّر شيء. فلا تُوجد لحظة تحمل فيها القاعدة صفوفاً ناقصة
-- وعلامةَ اكتمالٍ تدّعي أنها كاملة.
create or replace function public.replace_expense_entries_window(
  p_window_start date,
  p_window_end date,
  p_rows jsonb
)
returns table(
  sync_run_id uuid,
  row_count integer,
  window_start date,
  window_end date,
  completed_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
set statement_timeout = '15s'
as $$
declare
  v_count integer;
  v_inserted integer;
  v_sync_run_id uuid := gen_random_uuid();
  v_refreshed_at timestamptz;
  v_completed_at timestamptz;
begin
  if not (select public.expense_entries_is_sync_writer()) then
    raise exception 'sync writer required';
  end if;
  if p_window_start is null or p_window_end is null or p_window_end < p_window_start then
    raise exception 'invalid replacement window';
  end if;
  if (p_window_end - p_window_start) > 31 then
    raise exception 'replacement window exceeds 31 days';
  end if;
  -- الحمولة الفارغة مقبولة عمداً (نافذة بلا مصاريف)، لكن غير المصفوفة مرفوضة.
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'expense payload must be an array';
  end if;

  -- النداءات المتزامنة تُسلسَل قبل أن تمسّ أي منها صفوف الإنتاج.
  perform pg_advisory_xact_lock(hashtextextended('public.expense_entries.atomic_refresh', 0));

  create temporary table staged_expense_entries on commit drop as
  select * from jsonb_to_recordset(p_rows) as x(
    entry_date date,
    account_name text,
    amount numeric,
    notes text
  );

  select count(*) into v_count from pg_temp.staged_expense_entries;
  if v_count <> jsonb_array_length(p_rows) then
    raise exception 'payload row count mismatch';
  end if;
  if exists (
    select 1 from pg_temp.staged_expense_entries s
    where s.entry_date is null
       or nullif(btrim(s.account_name), '') is null
       or s.amount is null
  ) then
    raise exception 'required expense field is missing';
  end if;
  if exists (
    select 1 from pg_temp.staged_expense_entries s
    where s.entry_date < p_window_start or s.entry_date > p_window_end
  ) then
    raise exception 'entry_date is outside replacement window';
  end if;
  if exists (
    select 1 from pg_temp.staged_expense_entries s
    where s.amount = 'NaN'::numeric
  ) then
    raise exception 'non-finite numeric value in payload';
  end if;

  v_refreshed_at := clock_timestamp();

  delete from public.expense_entries e
  where e.entry_date >= p_window_start
    and e.entry_date <= p_window_end;

  insert into public.expense_entries (entry_date, account_name, amount, notes, created_at)
  select s.entry_date, s.account_name, s.amount, s.notes, v_refreshed_at
  from pg_temp.staged_expense_entries s;

  get diagnostics v_inserted = row_count;
  if v_inserted <> v_count then
    raise exception 'inserted row count mismatch';
  end if;

  v_completed_at := clock_timestamp();
  insert into public.expense_entries_sync_state (
    source, sync_run_id, window_start, window_end, row_count,
    completed_at, completed_by
  ) values (
    'ameen_expense_entries', v_sync_run_id, p_window_start, p_window_end,
    v_count, v_completed_at, (select auth.uid())
  )
  on conflict (source) do update set
    sync_run_id = excluded.sync_run_id,
    window_start = excluded.window_start,
    window_end = excluded.window_end,
    row_count = excluded.row_count,
    completed_at = excluded.completed_at,
    completed_by = excluded.completed_by;

  return query select
    v_sync_run_id, v_count, p_window_start, p_window_end, v_completed_at;
end;
$$;

revoke all on function public.replace_expense_entries_window(date, date, jsonb)
  from public, anon, service_role;
grant execute on function public.replace_expense_entries_window(date, date, jsonb)
  to authenticated;

commit;
