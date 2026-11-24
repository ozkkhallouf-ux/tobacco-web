-- إعادة عد جماعية لقائمة مواد في كل مستودعات يوم الجرد بضغطة واحدة (قرار عمر 2026-10-31).
--
-- السلوك (الخيار المعتمد «أعمى + فتح الجلسة»):
--   * المادة تُعرَّف بمعرّف الأمين: coalesce(nullif(item_guid,''), item_key)، فهو ثابت بين المستودعات.
--   * لكل جلسة من جلسات التاريخ: المادة المعدودة تُفتح لإعادة عد عمياء بنفس قاعدة
--     smart_inventory_owner_open_recount (موظف غير الذي عدّها أول مرة)؛ غير المعدودة
--     والمفتوحة لإعادة العد سابقاً تُتجاوز ولا تُمس.
--   * الجلسة المكتملة التي فيها مادة مختارة بانتظار إعادة عد (جديدة أو عالقة من قبل)
--     تُعاد فتحها تلقائياً بالسبب نفسه وبسطر تدقيق session_reopened.
--   * لا تُحذف أي محاولة عد ولا تتغير الكميات المحفوظة؛ لا كتابة على الأمين.
-- دوال المالك فقط: authenticated + smart_inventory_is_owner()؛ لا تُمنح لـ anon ولا PUBLIC.

begin;

create or replace function public.smart_inventory_owner_day_items(p_date date default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_date date:=coalesce(p_date,(now() at time zone 'Asia/Beirut')::date); v_result jsonb;
begin
  if not public.smart_inventory_is_owner() then raise exception 'owner_only' using errcode='42501'; end if;
  with rows as (
    select coalesce(nullif(i.item_guid,''),i.item_key) item_ref,
      min(i.item_code) item_code, min(i.item_name) item_name,
      count(*) sessions,
      count(*) filter (where i.count_state<>'uncounted' and not i.recount_requested) counted,
      count(*) filter (where i.recount_requested) recount_open
    from public.smart_inventory_items i
    join public.smart_inventory_sessions s on s.id=i.session_id
    where s.inventory_date=v_date
    group by 1
  ) select coalesce(jsonb_agg(jsonb_build_object('itemRef',item_ref,'itemCode',item_code,'itemName',item_name,
      'sessions',sessions,'counted',counted,'recountOpen',recount_open) order by item_name),'[]'::jsonb)
    into v_result from rows;
  return jsonb_build_object('date',v_date,'items',v_result);
end; $$;

create or replace function public.smart_inventory_owner_bulk_recount(p_date date,p_item_refs text[],p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_date date:=coalesce(p_date,(now() at time zone 'Asia/Beirut')::date);
  v_actor text:=public.smart_inventory_actor_name();
  v_reason text:=trim(coalesce(p_reason,''));
  v_refs text[];
  v_session record;
  v_opened integer; v_skipped_uncounted integer; v_skipped_already integer; v_reopened boolean;
  v_total_opened integer:=0; v_total_reopened integer:=0;
  v_summary jsonb:='[]'::jsonb;
begin
  if not public.smart_inventory_is_owner() then raise exception 'owner_only' using errcode='42501'; end if;
  if length(v_reason)<3 then raise exception 'reason_required'; end if;
  select coalesce(array_agg(distinct r),'{}') into v_refs
    from unnest(coalesce(p_item_refs,'{}'::text[])) r where nullif(trim(r),'') is not null;
  if cardinality(v_refs)=0 then raise exception 'items_required'; end if;
  if cardinality(v_refs)>1000 then raise exception 'too_many_items'; end if;

  -- ترتيب الأقفال مطابق لحفظ الموظف (smart_inventory_save_item): الأصناف أولاً ثم الجلسة،
  -- وإلا قد يتقاطع قفلنا للجلسة مع FOR SHARE الذي يأخذه الحفظ بعد قفل صنفه فيحدث deadlock.
  perform 1 from public.smart_inventory_items i
    join public.smart_inventory_sessions s on s.id=i.session_id
    where s.inventory_date=v_date and coalesce(nullif(i.item_guid,''),i.item_key)=any(v_refs)
    order by i.id for update of i;

  -- ثم الجلسات بترتيب ثابت؛ القراءة تحت القفل ترى آخر حالة ملتزمة (إغلاق متزامن يُعاد فتحه).
  for v_session in
    select s.* from public.smart_inventory_sessions s
    where s.inventory_date=v_date
      and exists (select 1 from public.smart_inventory_items i where i.session_id=s.id
                  and coalesce(nullif(i.item_guid,''),i.item_key)=any(v_refs))
    order by s.id for update
  loop
    select count(*) filter (where count_state='uncounted'),
           count(*) filter (where count_state<>'uncounted' and recount_requested)
      into v_skipped_uncounted, v_skipped_already
      from public.smart_inventory_items
      where session_id=v_session.id and coalesce(nullif(item_guid,''),item_key)=any(v_refs);

    with target as (
      select i.id,i.recount_requested from public.smart_inventory_items i
      where i.session_id=v_session.id and coalesce(nullif(i.item_guid,''),i.item_key)=any(v_refs)
        and i.count_state<>'uncounted' and not i.recount_requested
      order by i.id for update
    ), upd as (
      update public.smart_inventory_items i set recount_requested=true,recount_requested_at=now(),recount_requested_by=auth.uid(),
        recount_reason=v_reason,claimed_by=null,claimed_by_display_name=null,claimed_at=null,claim_expires_at=null,
        row_version=i.row_version+1,updated_at=now()
      from target t where i.id=t.id returning i.id
    ), log as (
      insert into public.smart_inventory_audit_log(session_id,item_id,action,actor_user_id,actor_display_name,before_data,after_data,reason)
      select v_session.id,u.id,'recount_opened',auth.uid(),v_actor,jsonb_build_object('recountRequested',false),
        jsonb_build_object('recountRequested',true,'bulk',true),v_reason from upd u returning 1
    ) select count(*) into v_opened from log;

    v_reopened:=false;
    if v_session.status='completed' and exists (
      select 1 from public.smart_inventory_items i where i.session_id=v_session.id and i.recount_requested
        and coalesce(nullif(i.item_guid,''),i.item_key)=any(v_refs)) then
      update public.smart_inventory_sessions set status='in_progress',reopened_by=auth.uid(),reopened_at=now(),
        reopen_reason=v_reason,updated_at=now() where id=v_session.id;
      insert into public.smart_inventory_audit_log(session_id,action,actor_user_id,actor_display_name,before_data,after_data,reason)
        values(v_session.id,'session_reopened',auth.uid(),v_actor,jsonb_build_object('status','completed'),
          jsonb_build_object('status','in_progress','bulkRecount',true),v_reason);
      v_reopened:=true; v_total_reopened:=v_total_reopened+1;
    end if;

    v_total_opened:=v_total_opened+v_opened;
    v_summary:=v_summary||jsonb_build_array(jsonb_build_object('sessionId',v_session.id,'warehouseName',v_session.warehouse_name,
      'opened',v_opened,'skippedUncounted',v_skipped_uncounted,'skippedAlready',v_skipped_already,'reopened',v_reopened));
  end loop;

  return jsonb_build_object('ok',true,'code','bulk_recount_opened','date',v_date,
    'opened',v_total_opened,'reopenedSessions',v_total_reopened,
    'notFound',(select count(*) from unnest(v_refs) r where not exists (
      select 1 from public.smart_inventory_items i join public.smart_inventory_sessions s on s.id=i.session_id
      where s.inventory_date=v_date and coalesce(nullif(i.item_guid,''),i.item_key)=r)),
    'warehouses',(select coalesce(jsonb_agg(w order by w->>'warehouseName'),'[]'::jsonb) from jsonb_array_elements(v_summary) w));
end; $$;

revoke all on function public.smart_inventory_owner_day_items(date),
 public.smart_inventory_owner_bulk_recount(date,text[],text) from public,anon;
grant execute on function public.smart_inventory_owner_day_items(date),
 public.smart_inventory_owner_bulk_recount(date,text[],text) to authenticated;

comment on function public.smart_inventory_owner_bulk_recount(date,text[],text) is 'Owner-only: opens a blind recount for the given Ameen item refs in every session of the date and reopens completed sessions that now wait on a selected recount. Never deletes attempts, never writes to Ameen.';

commit;
