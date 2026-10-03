-- تصحيح موظف الجرد لصنفه قبل إغلاق الجلسة.
--
-- السبب: smart_inventory_claim_item و smart_inventory_save_item كانتا
-- تُرجعان already_counted لكل صف حالته ليست uncounted إلا إذا فتح المالك
-- إعادة عد. الواجهة تعطّل الخانات في الوقت نفسه. الموظف الذي أخطأ في العدد
-- لا يستطيع إصلاح صنفه، وإعادة العد تتطلب مالكاً ثم موظفاً آخر.
--
-- طُبِّق على المشروع الحي في 2026-10-03 بموافقة المالك (الإصدار المسجَّل 20261003014153).
-- لا يُعاد تشغيله، ولا يمنح دوال المالك لدور anon.
-- حسابات الجرد تبقى بدور anon، و smart_inventory_is_counter() كما هو:
-- الموظف يعدّل فقط صفاً counted_by = auth.uid() وهو مشارك في الجلسة،
-- والجلسة ما زالت in_progress. محاولة جديدة attempt_kind = self_correction
-- تُحدّث الكمية والحالة وتُبقي المحاولة السابقة في السجل.

begin;

do $$
declare r record;
begin
  for r in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'smart_inventory_count_attempts'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%attempt_kind%'
  loop
    execute format('alter table public.smart_inventory_count_attempts drop constraint %I', r.conname);
  end loop;
end $$;

alter table public.smart_inventory_count_attempts
  add constraint smart_inventory_count_attempts_attempt_kind_check
  check (attempt_kind in ('primary','recount','owner_correction','self_correction'));

create or replace function public.smart_inventory_counter_session(p_session_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_session public.smart_inventory_sessions%rowtype; v_items jsonb;
begin
  if not (public.smart_inventory_is_counter() or public.smart_inventory_is_owner()) then raise exception 'forbidden' using errcode='42501'; end if;
  select * into v_session from public.smart_inventory_sessions where id=p_session_id;
  if v_session.id is null then raise exception 'session_not_found'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',i.id,'itemKey',i.item_key,'itemGuid',i.item_guid,'itemCode',i.item_code,'itemName',i.item_name,
    'shelfLocation',i.shelf_location,'unit1Name',i.unit1_name,'unit2Name',i.unit2_name,'unit2Factor',i.unit2_factor,
    'countState',i.count_state,
    'countedByMe',coalesce(i.counted_by = auth.uid() and not exists (select 1 from public.smart_inventory_count_attempts a where a.item_id=i.id and a.attempt_kind in ('recount','owner_correction')), false),
    'unit1Qty',case when i.recount_requested and i.counted_by<>auth.uid() and not public.smart_inventory_is_owner() then null else i.unit1_qty end,
    'unit2Qty',case when i.recount_requested and i.counted_by<>auth.uid() and not public.smart_inventory_is_owner() then null else i.unit2_qty end,
    'damagedUnit1Qty',case when i.recount_requested and i.counted_by<>auth.uid() and not public.smart_inventory_is_owner() then null else i.damaged_unit1_qty end,
    'actualQtyUnit1',case when i.recount_requested and i.counted_by<>auth.uid() and not public.smart_inventory_is_owner() then null else i.actual_qty_unit1 end,
    'countedByDisplayName',i.counted_by_display_name,'countedAt',i.counted_at,
    'recountRequested',i.recount_requested,'recountCompletedAt',i.recount_completed_at,
    'claimedByDisplayName',case when i.claim_expires_at>now() then i.claimed_by_display_name else null end,
    'claimedByMe',case when i.claim_expires_at>now() then i.claimed_by=auth.uid() else false end,
    'claimExpiresAt',case when i.claim_expires_at>now() then i.claim_expires_at else null end,'rowVersion',i.row_version
  ) order by i.sort_index,i.item_name),'[]'::jsonb) into v_items
  from public.smart_inventory_items i where i.session_id=p_session_id;
  return jsonb_build_object('id',v_session.id,'inventoryDate',v_session.inventory_date,'warehouseKey',v_session.warehouse_key,
    'warehouseName',v_session.warehouse_name,'status',v_session.status,'cutoffAt',v_session.cutoff_at,
    'startedAt',v_session.created_at,'completedAt',v_session.completed_at,'totalItems',v_session.total_items,'items',v_items);
end;
$$;

create or replace function public.smart_inventory_claim_item(p_item_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_item public.smart_inventory_items%rowtype; v_session public.smart_inventory_sessions%rowtype;
  v_actor text:=public.smart_inventory_actor_name(); v_minutes integer;
begin
  if not public.smart_inventory_is_counter() then raise exception 'forbidden' using errcode='42501'; end if;
  select * into v_item from public.smart_inventory_items where id=p_item_id for update;
  if v_item.id is null then raise exception 'item_not_found'; end if;
  select * into v_session from public.smart_inventory_sessions where id=v_item.session_id;
  if v_session.status<>'in_progress' then return jsonb_build_object('ok',false,'code','session_closed'); end if;
  -- A saved row stays locked for everyone except the counter who saved it, and only while this session is still open.
  if v_item.count_state<>'uncounted' and not v_item.recount_requested and v_item.counted_by is distinct from auth.uid() then
    return jsonb_build_object('ok',false,'code','already_counted','countedByDisplayName',v_item.counted_by_display_name,'countedAt',v_item.counted_at);
  end if;
  if v_item.count_state<>'uncounted' and not v_item.recount_requested and v_item.counted_by=auth.uid()
     and not exists (select 1 from public.smart_inventory_participants p where p.session_id=v_item.session_id and p.user_id=auth.uid()) then
    return jsonb_build_object('ok',false,'code','already_counted','countedByDisplayName',v_item.counted_by_display_name,'countedAt',v_item.counted_at);
  end if;
  -- After an owner recount or owner correction the original counter may not self-correct: it would supersede that attempt.
  if v_item.count_state<>'uncounted' and not v_item.recount_requested and v_item.counted_by=auth.uid()
     and exists (select 1 from public.smart_inventory_count_attempts a where a.item_id=v_item.id and a.attempt_kind in ('recount','owner_correction')) then
    return jsonb_build_object('ok',false,'code','already_counted','countedByDisplayName',v_item.counted_by_display_name,'countedAt',v_item.counted_at);
  end if;
  if v_item.recount_requested and v_item.counted_by=auth.uid() then
    return jsonb_build_object('ok',false,'code','recount_requires_other_counter');
  end if;
  if v_item.claim_expires_at>now() and v_item.claimed_by<>auth.uid() then
    return jsonb_build_object('ok',false,'code','claimed','claimedByDisplayName',v_item.claimed_by_display_name,'claimExpiresAt',v_item.claim_expires_at);
  end if;
  select claim_minutes into v_minutes from public.smart_inventory_settings where singleton;
  update public.smart_inventory_items set claimed_by=auth.uid(),claimed_by_display_name=v_actor,claimed_at=now(),
    claim_expires_at=now()+make_interval(mins=>coalesce(v_minutes,2)),updated_at=now()
    where id=p_item_id returning * into v_item;
  insert into public.smart_inventory_participants(session_id,user_id,display_name) values(v_item.session_id,auth.uid(),v_actor)
    on conflict(session_id,user_id) do update set last_activity_at=now(),display_name=excluded.display_name;
  return jsonb_build_object('ok',true,'code','claimed','claimExpiresAt',v_item.claim_expires_at,'claimedByDisplayName',v_actor);
end;
$$;

create or replace function public.smart_inventory_save_item(
  p_item_id uuid,p_request_id uuid,p_count_state text,p_unit1_qty numeric default 0,
  p_unit2_qty numeric default 0,p_damaged_unit1_qty numeric default 0,p_expected_version bigint default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_item public.smart_inventory_items%rowtype; v_session public.smart_inventory_sessions%rowtype;
  v_attempt public.smart_inventory_count_attempts%rowtype; v_actor text:=public.smart_inventory_actor_name();
  v_actual numeric; v_no integer; v_kind text;
begin
  if not public.smart_inventory_is_counter() then raise exception 'forbidden' using errcode='42501'; end if;
  if p_request_id is null then raise exception 'request_id_required'; end if;
  select * into v_attempt from public.smart_inventory_count_attempts where request_id=p_request_id;
  if v_attempt.id is not null then return jsonb_build_object('ok',true,'code','saved','idempotent',true,'countedAt',v_attempt.counted_at); end if;
  if p_count_state not in ('counted','zero','not_found','damaged') then raise exception 'invalid_count_state'; end if;
  if coalesce(p_unit1_qty,0)<0 or coalesce(p_unit2_qty,0)<0 or coalesce(p_damaged_unit1_qty,0)<0 then raise exception 'negative_quantity'; end if;
  select * into v_item from public.smart_inventory_items where id=p_item_id for update;
  if v_item.id is null then raise exception 'item_not_found'; end if;
  select * into v_session from public.smart_inventory_sessions where id=v_item.session_id for share;
  if v_session.status<>'in_progress' then return jsonb_build_object('ok',false,'code','session_closed'); end if;
  -- Same counter may correct their own row before the session is completed. Another counter still loses with already_counted.
  if v_item.count_state<>'uncounted' and not v_item.recount_requested and v_item.counted_by is distinct from auth.uid() then
    return jsonb_build_object('ok',false,'code','already_counted','countedByDisplayName',v_item.counted_by_display_name,'countedAt',v_item.counted_at);
  end if;
  if v_item.count_state<>'uncounted' and not v_item.recount_requested and v_item.counted_by=auth.uid()
     and not exists (select 1 from public.smart_inventory_participants p where p.session_id=v_item.session_id and p.user_id=auth.uid()) then
    return jsonb_build_object('ok',false,'code','already_counted','countedByDisplayName',v_item.counted_by_display_name,'countedAt',v_item.counted_at);
  end if;
  -- After an owner recount or owner correction the original counter may not self-correct: it would supersede that attempt.
  if v_item.count_state<>'uncounted' and not v_item.recount_requested and v_item.counted_by=auth.uid()
     and exists (select 1 from public.smart_inventory_count_attempts a where a.item_id=v_item.id and a.attempt_kind in ('recount','owner_correction')) then
    return jsonb_build_object('ok',false,'code','already_counted','countedByDisplayName',v_item.counted_by_display_name,'countedAt',v_item.counted_at);
  end if;
  if p_expected_version is not null and v_item.row_version<>p_expected_version then
    return jsonb_build_object('ok',false,'code','version_conflict','rowVersion',v_item.row_version);
  end if;
  if v_item.recount_requested and v_item.counted_by=auth.uid() then return jsonb_build_object('ok',false,'code','recount_requires_other_counter'); end if;
  if v_item.claim_expires_at>now() and v_item.claimed_by<>auth.uid() then
    return jsonb_build_object('ok',false,'code','claimed','claimedByDisplayName',v_item.claimed_by_display_name,'claimExpiresAt',v_item.claim_expires_at);
  end if;
  v_actual:=round(coalesce(p_unit1_qty,0)+coalesce(p_unit2_qty,0)*v_item.unit2_factor,3);
  if p_count_state in ('zero','not_found') and v_actual<>0 then raise exception 'zero_state_requires_zero'; end if;
  select coalesce(max(attempt_no),0)+1 into v_no from public.smart_inventory_count_attempts where item_id=p_item_id;
  v_kind:=case when v_item.recount_requested then 'recount' when v_item.count_state<>'uncounted' and v_item.counted_by=auth.uid() then 'self_correction' else 'primary' end;
  insert into public.smart_inventory_count_attempts(request_id,session_id,item_id,attempt_no,attempt_kind,count_state,
    unit1_qty,unit2_qty,damaged_unit1_qty,actual_qty_unit1,counted_by,counted_by_display_name)
  values(p_request_id,v_item.session_id,p_item_id,v_no,v_kind,p_count_state,coalesce(p_unit1_qty,0),coalesce(p_unit2_qty,0),
    coalesce(p_damaged_unit1_qty,0),v_actual,auth.uid(),v_actor) returning * into v_attempt;
  if v_kind in ('primary','self_correction') then
    update public.smart_inventory_items set count_state=p_count_state,unit1_qty=coalesce(p_unit1_qty,0),unit2_qty=coalesce(p_unit2_qty,0),
      damaged_unit1_qty=coalesce(p_damaged_unit1_qty,0),actual_qty_unit1=v_actual,counted_by=auth.uid(),counted_by_display_name=v_actor,
      counted_at=v_attempt.counted_at,claimed_by=null,claimed_by_display_name=null,claimed_at=null,claim_expires_at=null,
      row_version=row_version+1,updated_at=now() where id=p_item_id;
  else
    update public.smart_inventory_items set recount_requested=false,recount_completed_at=v_attempt.counted_at,recount_completed_by=auth.uid(),
      claimed_by=null,claimed_by_display_name=null,claimed_at=null,claim_expires_at=null,row_version=row_version+1,updated_at=now() where id=p_item_id;
  end if;
  insert into public.smart_inventory_participants(session_id,user_id,display_name) values(v_item.session_id,auth.uid(),v_actor)
    on conflict(session_id,user_id) do update set last_activity_at=now(),display_name=excluded.display_name;
  insert into public.smart_inventory_audit_log(session_id,item_id,action,actor_user_id,actor_display_name,before_data,after_data)
  values(v_item.session_id,p_item_id,case when v_kind='primary' then 'item_counted' when v_kind='self_correction' then 'item_self_corrected' else 'item_recounted' end,auth.uid(),v_actor,
    case when v_kind='self_correction' then jsonb_build_object('countState',v_item.count_state,'unit1Qty',v_item.unit1_qty,'unit2Qty',v_item.unit2_qty,'damagedUnit1Qty',v_item.damaged_unit1_qty,'actualQtyUnit1',v_item.actual_qty_unit1,'rowVersion',v_item.row_version)
      else jsonb_build_object('countState',v_item.count_state,'rowVersion',v_item.row_version) end,
    jsonb_build_object('countState',p_count_state,'unit1Qty',coalesce(p_unit1_qty,0),'unit2Qty',coalesce(p_unit2_qty,0),'actualQtyUnit1',v_actual,'attemptNo',v_no,'attemptKind',v_kind));
  return jsonb_build_object('ok',true,'code','saved','attemptKind',v_kind,'countedByDisplayName',v_actor,'countedAt',v_attempt.counted_at,'actualQtyUnit1',v_actual,'rowVersion',v_item.row_version+1);
exception when unique_violation then
  select * into v_attempt from public.smart_inventory_count_attempts where request_id=p_request_id;
  if v_attempt.id is not null then return jsonb_build_object('ok',true,'code','saved','idempotent',true,'countedAt',v_attempt.counted_at); end if;
  raise;
end;
$$;

-- الإبقاء على منح العد الستة لدور anon. لا منح لدوال المالك.
grant execute on function public.smart_inventory_counter_session(uuid),
  public.smart_inventory_claim_item(uuid),
  public.smart_inventory_save_item(uuid,uuid,text,numeric,numeric,numeric,bigint)
to anon, authenticated;

revoke all on function public.smart_inventory_owner_dashboard(date),
  public.smart_inventory_owner_report(uuid),
  public.smart_inventory_owner_open_recount(uuid,text),
  public.smart_inventory_owner_reopen_session(uuid,text),
  public.smart_inventory_owner_correct_item(uuid,numeric,text)
from anon;

commit;
