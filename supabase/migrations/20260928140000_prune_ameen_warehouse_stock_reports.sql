-- تنظيف ameen_warehouse_stock_reports على دفعات، بلا مسّ لجلسات الجرد.
--
-- العطل (قراءة فقط على المشروع الحي، 2026-09-28): مهمة Windows
-- «TOBACCO Ameen Warehouse Reports» تستدعي tools/push-ameen-warehouse-stock.ps1
-- كل ساعة. التنظيف كان DELETE واحداً عبر PostgREST:
--   DELETE /ameen_warehouse_stock_reports?created_at=lt.<الآن − يومين>
-- دور authenticated مهلته 8 ثوانٍ، والجدول نحو 4060 صفاً و130 ميغابايت
-- (أقدم صف 23 آب). البيان يُلغى (57014) ولا يُحذف شيء.
--
-- تقسيم الحذف إلى معرّفات لا يكفي وحده. المفتاح
-- smart_inventory_sessions.source_report_id يشير إلى هذا الجدول بلا ON DELETE
-- (NO ACTION). جلسات التجربة القديمة، وكل جلسة جرد جديدة، تُبقي التقرير
-- الذي بدأت منه. حذف ذلك التقرير يفشل البيان بخرق المفتاح الأجنبي، ولو كان
-- صفاً واحداً. تحويل المفتاح إلى ON DELETE CASCADE محظور: كان سيمسح جلسة
-- الجرد ثم يتسلسل إلى أصنافها وعدّها وسجل تدقيقها.
-- inventory_recon_sessions.source_report_id يستخدم ON DELETE SET NULL. الحفاظ
-- على الإشارة أفضل من تفريغها، لذلك تُستثنى هذه الصفوف أيضاً.
--
-- هذه الدالة تحذف دفعة محدودة (40 كحد أقصى) من الصفوف الأقدم تماماً من يومين
-- وغير المشار إليها. لا تعدّل أي صف في smart_inventory_* ولا في
-- inventory_recon_sessions، ولا تغيّر تعريف المفاتيح الأجنبية.
--
-- المالك على المشروع الحي هو postgres وبلا صلاحية superuser لكن مع
-- BYPASSRLS، وFORCE ROW LEVEL SECURITY مطفأ على الجداول الثلاثة (قراءة
-- 2026-09-28). الدالة SECURITY DEFINER فترى كل الإشارات حتى لو أخفتها
-- سياسات الجلسة عن حساب المزامنة. set_config('row_security','off') يجعل
-- مالكاً بلا BYPASSRLS يفشل بدل أن يظن أن الإشارة غير موجودة.
--
-- لا تُطبَّق هذه الهجرة تلقائياً. تُراجع وتُشغَّل يدوياً في محرر SQL.

create or replace function public.prune_ameen_warehouse_stock_reports(
  p_before timestamptz,
  p_limit integer
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_count integer;
  cutoff timestamptz;
begin
  perform set_config('row_security', 'off', true);

  if auth.uid() is distinct from '9724dbe4-ecb0-49f7-a6b4-12f7f73c68f3'::uuid then
    raise exception 'prune_ameen_warehouse_stock_reports: sync writer only'
      using errcode = '42501';
  end if;

  if p_before is null then
    raise exception 'prune_ameen_warehouse_stock_reports: p_before is required'
      using errcode = '22023';
  end if;

  if p_limit is null or p_limit < 1 or p_limit > 40 then
    raise exception 'prune_ameen_warehouse_stock_reports: p_limit must be between 1 and 40'
      using errcode = '22023';
  end if;

  -- لا يسمح المستدعي بحد أحدث من قاعدة اليومين، ولو أرسل وقتاً قريباً من الآن.
  cutoff := least(p_before, pg_catalog.now() - interval '2 days');

  -- أي مفتاح أجنبي غير الجدولين المعروفين، أو تغيّر عدد مفاتيحهما، يوقف
  -- الحذف. هكذا لا يمرّ ON DELETE CASCADE جديد بصمت.
  if (
    (
      select count(*)
      from pg_catalog.pg_constraint as c
      where c.contype = 'f'
        and c.confrelid = 'public.ameen_warehouse_stock_reports'::pg_catalog.regclass
        and c.conrelid in (
          'public.smart_inventory_sessions'::pg_catalog.regclass,
          'public.inventory_recon_sessions'::pg_catalog.regclass
        )
    ) is distinct from 2
    or exists (
      select 1
      from pg_catalog.pg_constraint as c
      where c.contype = 'f'
        and c.confrelid = 'public.ameen_warehouse_stock_reports'::pg_catalog.regclass
        and c.conrelid not in (
          'public.smart_inventory_sessions'::pg_catalog.regclass,
          'public.inventory_recon_sessions'::pg_catalog.regclass
        )
    )
  ) then
    raise exception 'prune_ameen_warehouse_stock_reports: unexpected foreign key; refusing to delete'
      using errcode = '55000';
  end if;

  with doomed as (
    select r.id
    from public.ameen_warehouse_stock_reports as r
    where r.created_at < cutoff
      and not exists (
        select 1
        from public.smart_inventory_sessions as s
        where s.source_report_id = r.id
      )
      and not exists (
        select 1
        from public.inventory_recon_sessions as i
        where i.source_report_id = r.id
      )
    order by r.created_at, r.id
    limit p_limit
  )
  delete from public.ameen_warehouse_stock_reports as r
  using doomed as d
  where r.id = d.id;

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

comment on function public.prune_ameen_warehouse_stock_reports(timestamptz, integer) is
  'يحذف دفعة من تقارير مخزون المستودعات الأقدم من يومين وغير المرتبطة بجلسة جرد. لا يمس smart_inventory_* ولا يغيّر المفاتيح الأجنبية.';

revoke all on function public.prune_ameen_warehouse_stock_reports(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.prune_ameen_warehouse_stock_reports(timestamptz, integer) to authenticated;
