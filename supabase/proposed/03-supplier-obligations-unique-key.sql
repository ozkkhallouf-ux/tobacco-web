-- ============================================================================
-- مقترح — غير مطبَّق. استبدال ذرّي لالتزامات الموردين.
--
-- الوضع الحالي: tools/push-supplier-obligations.ps1 يحذف كل صفوف المصدر ثم
-- يُدخل البديل. بين الحذف والإدخال نافذة يكون فيها الجدول فارغاً، وأي انقطاع
-- شبكة داخلها يترك الالتزامات ممسوحة.
--
-- ⚠️ لماذا لا يكفي قيد فريد + upsert وحده (ملاحظة Codex P1، صحيحة):
-- الحمولة تحمل الموردين ذوي الرصيد الموجب فقط. فحين يسدّد مورد حسابه يسقط من
-- الحمولة التالية، فلا يلمسه الـupsert ويبقى صفّه القديم معروضاً إلى الأبد —
-- أي يظهر دَين على مورد سدّد فعلاً. الاستبدال يجب أن يكون كاملاً وذرّياً:
-- إدراج/تحديث الجيل الحالي **وحذف ما ليس فيه** داخل معاملة واحدة.
-- ============================================================================
begin;

-- (1) يُفشل التطبيق مبكراً وبوضوح إن كان في الجدول ازدواج قائم.
do $$
begin
  if exists (
    select 1 from public.supplier_obligations
    group by source, supplier_key having count(*) > 1
  ) then
    raise exception 'duplicate (source, supplier_key) rows exist; resolve them before adding the constraint';
  end if;
end $$;

create unique index if not exists supplier_obligations_source_supplier_key
  on public.supplier_obligations (source, supplier_key);

-- (2) استبدال ذرّي: جيل كامل في معاملة واحدة، بلا نافذة فراغ.
create or replace function public.replace_supplier_obligations(
  p_source text,
  p_rows jsonb,
  -- يقابل حارس -AllowEmpty في المنتج على Windows: حين يسدّد آخر مورد دائن تكون
  -- الحمولة الفارغة **حقيقة محاسبية** لا عطلاً، والرفض المطلق كان سيُبقي دَيناً
  -- على من سدّد. التفريغ يبقى قراراً صريحاً لا أثراً جانبياً.
  p_allow_empty boolean default false
) returns table (row_count integer, generated_at timestamptz)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_count integer;
  v_now timestamptz := clock_timestamp();
begin
  if nullif(btrim(coalesce(p_source, '')), '') is null then
    raise exception 'source is required';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'rows payload must be a JSON array';
  end if;

  -- حمولة فارغة بلا إذن صريح لا تمسح جيلاً قائماً.
  if jsonb_array_length(p_rows) = 0 and not coalesce(p_allow_empty, false) then
    raise exception 'refusing to replace % with an empty payload; pass p_allow_empty to authorize', p_source;
  end if;

  -- التفريغ المأذون: احذف الجيل كاملاً وارجع بلا مرور على التحقّقات التالية.
  if jsonb_array_length(p_rows) = 0 then
    delete from public.supplier_obligations where source = p_source;
    return query select 0, v_now;
    return;
  end if;

  create temporary table staged_supplier_obligations on commit drop as
  select * from jsonb_to_recordset(p_rows) as x(
    supplier_key text, supplier_name text, amount_due numeric, currency text,
    due_date date, strategic_weight numeric, supply_risk text, notes text
  );

  if exists (select 1 from pg_temp.staged_supplier_obligations
             where nullif(btrim(supplier_key), '') is null) then
    raise exception 'supplier_key is required';
  end if;
  if exists (select supplier_key from pg_temp.staged_supplier_obligations
             group by supplier_key having count(*) > 1) then
    raise exception 'duplicate supplier_key in payload';
  end if;
  if exists (select 1 from pg_temp.staged_supplier_obligations where amount_due < 0) then
    raise exception 'negative amount_due is not allowed';
  end if;

  insert into public.supplier_obligations as t (
    supplier_key, supplier_name, amount_due, currency, due_date,
    strategic_weight, supply_risk, notes, source, updated_at
  )
  select s.supplier_key, s.supplier_name, s.amount_due, coalesce(s.currency, 'USD'),
         s.due_date, coalesce(s.strategic_weight, 1.0),
         coalesce(s.supply_risk, 'normal'), s.notes, p_source, v_now
  from pg_temp.staged_supplier_obligations s
  on conflict (source, supplier_key) do update set
    supplier_name = excluded.supplier_name,
    amount_due = excluded.amount_due,
    currency = excluded.currency,
    due_date = excluded.due_date,
    strategic_weight = excluded.strategic_weight,
    supply_risk = excluded.supply_risk,
    notes = excluded.notes,
    updated_at = excluded.updated_at;

  -- ← الشطر الحاسم: المورد الذي سدّد حسابه يسقط من الحمولة، فيُحذف صفّه هنا
  --    بدل أن يبقى معروضاً كدَين قائم.
  delete from public.supplier_obligations t
  where t.source = p_source
    and not exists (
      select 1 from pg_temp.staged_supplier_obligations s
      where s.supplier_key = t.supplier_key
    );

  select count(*)::integer into v_count
  from public.supplier_obligations where source = p_source;
  return query select v_count, v_now;
end;
$$;

revoke all on function public.replace_supplier_obligations(text, jsonb, boolean)
  from public, anon, service_role;
grant execute on function public.replace_supplier_obligations(text, jsonb, boolean)
  to authenticated;

commit;

-- بعد التطبيق: يُستبدل مسار delete+insert في tools/push-supplier-obligations.ps1
-- باستدعاء واحد:
--   POST /rest/v1/rpc/replace_supplier_obligations
--   { "p_source": "ameen_ac000_credit_minus_debit", "p_rows": [...] }
-- ويُمرَّر p_allow_empty فقط حين يمرَّر -AllowEmpty للمنتج — لا افتراضياً أبداً.
