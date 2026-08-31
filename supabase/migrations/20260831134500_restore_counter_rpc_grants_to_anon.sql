-- ============================================================================
-- استعادة صلاحية تنفيذ RPCs الجرد لدور anon — عطل إنتاجي حيّ (2026-08-31).
--
-- العطل: جلسات موظفي الجرد تحمل دور قاعدة البيانات 'anon' عمداً
-- (migration 20260823084956، أقل امتياز ممكن)، وذلك الملف منح الدوال الست
-- للـanon. لكن المخطط المرجعي supabase/smart-inventory.sql كان ينتهي بـ
--   revoke all on function ... from public,anon;
--   grant  execute on function ... to authenticated;
-- فمن أعاد تشغيل المخطط المرجعي على الإنتاج بعد ذلك سحب الصلاحية من anon.
--
-- النتيجة كانت مضلّلة تماماً: تسجيل الدخول نفسه يبقى ناجحاً لأن Edge Function
-- تُصادق بـservice_role، ثم تموت صفحة الجرد الذكي عند أول RPC برسالة
-- «permission denied for function smart_inventory_available_warehouses».
-- مُثبَت حياً بتوكن موظف جرد حقيقي قبل تطبيق هذا الملف.
--
-- الحارس الأمني ليس المنحة بل داخل كل دالة: smart_inventory_is_counter و
-- smart_inventory_is_owner تشترطان app_metadata.role (لا يضبطه إلا service_role)
-- + صفّاً حيّاً في auth.sessions + حساباً مفعّلاً غير مقفول. فزائر مجهول يحمل
-- المفتاح العام وحده يبقى يتلقى 'forbidden'.
--
-- لا يمسّ هذا الملف أي حساب ولا كلمة مرور ولا جلسة جرد ولا أي كمية.
-- ============================================================================

grant execute on function
  public.smart_inventory_available_warehouses(date),
  public.smart_inventory_start_or_join(text),
  public.smart_inventory_counter_session(uuid),
  public.smart_inventory_claim_item(uuid),
  public.smart_inventory_save_item(uuid, uuid, text, numeric, numeric, numeric, bigint),
  public.smart_inventory_complete_session(uuid)
to anon;

-- دوال المالك تبقى محجوبة عن دور موظف الجرد.
revoke execute on function
  public.smart_inventory_owner_dashboard(date),
  public.smart_inventory_owner_report(uuid),
  public.smart_inventory_owner_open_recount(uuid, text),
  public.smart_inventory_owner_reopen_session(uuid, text),
  public.smart_inventory_owner_correct_item(uuid, numeric, text)
from anon;

do $$
declare v_missing text;
begin
  select string_agg(p.proname, ', ')
    into v_missing
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('smart_inventory_available_warehouses','smart_inventory_start_or_join',
                       'smart_inventory_counter_session','smart_inventory_claim_item',
                       'smart_inventory_save_item','smart_inventory_complete_session')
     and not has_function_privilege('anon', p.oid, 'execute');
  if v_missing is not null then
    raise exception 'counter RPC grants still missing for anon: %', v_missing;
  end if;

  select string_agg(p.proname, ', ')
    into v_missing
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname like 'smart_inventory_owner_%'
     and has_function_privilege('anon', p.oid, 'execute');
  if v_missing is not null then
    raise exception 'owner RPCs must never be executable by anon: %', v_missing;
  end if;
end $$;
