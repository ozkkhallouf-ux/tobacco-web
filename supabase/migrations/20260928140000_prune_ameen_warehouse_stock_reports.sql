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
-- السباق: تحت READ COMMITTED بيان واحد لا يرى إشارة التُزمت بعد لقطته.
-- إدراج جلسة يأخذ قفل KEY SHARE على صف التقرير. لذلك نقفله أولاً بـ
-- FOR UPDATE SKIP LOCKED (يتعارض مع KEY SHARE)، ثم بيان ثانٍ يعيد فحص
-- NOT EXISTS على الجدولين ويحذف والصف ما زال مقفولاً. هكذا لا يفشل البيان
-- على مفتاح الجرد الذكي، ولا يُفرَّغ source_report_id في جلسة المطابقة
-- (ON DELETE SET NULL كتابة على جدول المطابقة، وممنوعة هنا).
-- الصف المقفل من معاملة أخرى يُتجاوز هذه الجولة ويُعاد لاحقاً.
--
-- حارس المفاتيح (قراءة pg_constraint على الحي، 2026-09-28): مفتاحان فقط.
--   smart_inventory_sessions_source_report_id_fkey
--     العمود source_report_id، confdeltype a (NO ACTION). نقبل a أو r.
--   inventory_recon_sessions_source_report_id_fkey
--     العمود source_report_id، confdeltype n (SET NULL). نقبل n أو a أو r.
-- أي اسم أو عمود أو فعل آخر، وبالذات c أو d، يوقف الحذف بلا مسح.
--
-- inventory_recon_sessions موجود على الحي، لكن لا ينشئه ملف داخل
-- supabase/migrations. تعريفه المرجعي في supabase/inventory-reconciliation-table.sql
-- و رأس ذلك الملف يقول إنه غير مُطبَّق من المستودع. الفحص أدناه يوقف الهجرة
-- برسالة واضحة إذا نُفذت على قاعدة لا يوجد فيها الجدول.
--
-- حد المهمة على ويندوز 15 دقيقة (ExecutionTimeLimit) مع RestartCount 3.
-- السكربت يطلب 24 دفعة كحد أقصى حتى تبقى الجولة داخل هذه المهلة.
--
-- لا تُطبَّق هذه الهجرة تلقائياً. تُراجع وتُشغَّل يدوياً في محرر SQL.

do $$
begin
  if to_regclass('public.ameen_warehouse_stock_reports') is null then
    raise exception 'توقفت الهجرة: جدول public.ameen_warehouse_stock_reports غير موجود. طبّق جدول تقارير المستودعات أولاً.';
  end if;
  if to_regclass('public.smart_inventory_sessions') is null then
    raise exception 'توقفت الهجرة: جدول public.smart_inventory_sessions غير موجود. لا تُطبَّق هذه الهجرة قبل جداول الجرد الذكي.';
  end if;
  if to_regclass('public.inventory_recon_sessions') is null then
    raise exception 'توقفت الهجرة: جدول public.inventory_recon_sessions غير موجود. هذا الجدول موجود على القاعدة الحية، لكن لا ينشئه أي ملف داخل supabase/migrations (تعريفه المرجعي في supabase/inventory-reconciliation-table.sql). تأكد أنك على مشروع Supabase الصحيح ثم أعد المحاولة.';
  end if;
end
$$;

create or replace function public.prune_ameen_warehouse_stock_reports(
  p_before timestamptz,
  p_limit integer
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_count integer := 0;
  cutoff timestamptz;
  locked_ids uuid[];
  pass_limit integer;
  got integer;
  skips integer := 0;
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

  if to_regclass('public.ameen_warehouse_stock_reports') is null
     or to_regclass('public.smart_inventory_sessions') is null
     or to_regclass('public.inventory_recon_sessions') is null then
    raise exception 'prune_ameen_warehouse_stock_reports: required tables are missing'
      using errcode = '55000';
  end if;

  -- العدد، والاسم، والعمود، وفعل الحذف. a = NO ACTION، r = RESTRICT،
  -- n = SET NULL. c و d وغيرهما يرفضان.
  if (
    select count(*)
    from pg_catalog.pg_constraint as c
    where c.contype = 'f'
      and c.confrelid = 'public.ameen_warehouse_stock_reports'::pg_catalog.regclass
  ) is distinct from 2
  or not exists (
    select 1
    from pg_catalog.pg_constraint as c
    join pg_catalog.pg_attribute as src
      on src.attrelid = c.conrelid
     and src.attnum = c.conkey[1]
    join pg_catalog.pg_attribute as dst
      on dst.attrelid = c.confrelid
     and dst.attnum = c.confkey[1]
    where c.contype = 'f'
      and c.conname = 'smart_inventory_sessions_source_report_id_fkey'
      and c.conrelid = 'public.smart_inventory_sessions'::pg_catalog.regclass
      and c.confrelid = 'public.ameen_warehouse_stock_reports'::pg_catalog.regclass
      and pg_catalog.cardinality(c.conkey) = 1
      and src.attname = 'source_report_id'
      and dst.attname = 'id'
      and c.confdeltype in ('a', 'r')
  )
  or not exists (
    select 1
    from pg_catalog.pg_constraint as c
    join pg_catalog.pg_attribute as src
      on src.attrelid = c.conrelid
     and src.attnum = c.conkey[1]
    join pg_catalog.pg_attribute as dst
      on dst.attrelid = c.confrelid
     and dst.attnum = c.confkey[1]
    where c.contype = 'f'
      and c.conname = 'inventory_recon_sessions_source_report_id_fkey'
      and c.conrelid = 'public.inventory_recon_sessions'::pg_catalog.regclass
      and c.confrelid = 'public.ameen_warehouse_stock_reports'::pg_catalog.regclass
      and pg_catalog.cardinality(c.conkey) = 1
      and src.attname = 'source_report_id'
      and dst.attname = 'id'
      and c.confdeltype in ('n', 'a', 'r')
  )
  then
    raise exception 'prune_ameen_warehouse_stock_reports: unexpected foreign key; refusing to delete'
      using errcode = '55000';
  end if;

  -- قفل المرشحين أولاً، ثم بيان حذف ثانٍ يعيد الفحص والقفل ما زال معنا.
  -- التكرار الداخلي فقط عندما يتغيّر مرشح بعد القفل؛ صفحة قصيرة حُذفت
  -- كلها تعني أن الدفعة انتهت.
  while deleted_count < p_limit and skips < p_limit loop
    pass_limit := p_limit - deleted_count;
    select coalesce(pg_catalog.array_agg(s.id), '{}'::uuid[])
      into locked_ids
    from (
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
      limit pass_limit
      for update of r skip locked
    ) as s;

    exit when locked_ids is null or pg_catalog.cardinality(locked_ids) = 0;

    delete from public.ameen_warehouse_stock_reports as r
    where r.id = any(locked_ids)
      and not exists (
        select 1
        from public.smart_inventory_sessions as s
        where s.source_report_id = r.id
      )
      and not exists (
        select 1
        from public.inventory_recon_sessions as i
        where i.source_report_id = r.id
      );

    get diagnostics got = row_count;
    deleted_count := deleted_count + got;

    if got = pg_catalog.cardinality(locked_ids) then
      exit when pg_catalog.cardinality(locked_ids) < pass_limit;
    else
      skips := skips + 1;
    end if;
  end loop;

  return deleted_count;
end;
$$;

comment on function public.prune_ameen_warehouse_stock_reports(timestamptz, integer) is
  'يحذف دفعة من تقارير مخزون المستودعات الأقدم من يومين وغير المرتبطة بجلسة جرد. لا يمس smart_inventory_* ولا يغيّر المفاتيح الأجنبية.';

revoke all on function public.prune_ameen_warehouse_stock_reports(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.prune_ameen_warehouse_stock_reports(timestamptz, integer) to authenticated;
