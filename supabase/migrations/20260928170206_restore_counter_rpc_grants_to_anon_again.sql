-- حسابات موظفي الجرد تعمل بدور Postgres «anon» عن قصد، لا كانحراف صلاحيات.
-- smart_inventory_set_counter_auth_role يضبط auth.users.role = 'anon'،
-- فـ PostgREST يستدعي دوال العدّ بهذا الدور. كل دالة من الست تتحقق من
-- smart_inventory_is_counter() (app_metadata + جلسة حية + حساب مفعّل)
-- قبل أي عمل، لذلك EXECUTE لـ anon مطلوب. سحبه يعيد لكل دخول موظف
-- 401 «ليس لديك صلاحية لتنفيذ هذه العملية».
-- تكرر العطل: 20260826081831 سحب المنح، وأعاده 20260831134213؛ ثم
-- 20260914061335 (fix_smart_inventory_anon_grant_drift) سحبه ثانيةً
-- باعتباره انحرافاً. هذه الهجرة (20260928170206) أُعيد تطبيقها على
-- الإنتاج في 2026-09-28 بموافقة عمر. دوال smart_inventory_owner_* تبقى
-- بلا EXECUTE لـ anon.
--
-- النص التنفيذي أدناه يطابق بيان schema_migrations للنسخة المطبَّقة.
-- لا تُطبَّق مرة ثانية من المستودع: الإصدار مسجَّل على الإنتاج فيتخطاه CLI.

grant execute on function
  public.smart_inventory_available_warehouses(date),
  public.smart_inventory_start_or_join(text),
  public.smart_inventory_counter_session(uuid),
  public.smart_inventory_claim_item(uuid),
  public.smart_inventory_save_item(uuid, uuid, text, numeric, numeric, numeric, bigint),
  public.smart_inventory_complete_session(uuid)
to anon;

revoke execute on function
  public.smart_inventory_owner_dashboard(date),
  public.smart_inventory_owner_report(uuid),
  public.smart_inventory_owner_open_recount(uuid, text),
  public.smart_inventory_owner_reopen_session(uuid, text),
  public.smart_inventory_owner_correct_item(uuid, numeric, text)
from anon;

do $$
declare v text;
begin
  select string_agg(p.proname, ', ') into v from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname in ('smart_inventory_available_warehouses','smart_inventory_start_or_join','smart_inventory_counter_session','smart_inventory_claim_item','smart_inventory_save_item','smart_inventory_complete_session')
     and not has_function_privilege('anon', p.oid, 'execute');
  if v is not null then raise exception 'counter RPC grants still missing for anon: %', v; end if;
  select string_agg(p.proname, ', ') into v from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname like 'smart_inventory_owner_%' and has_function_privilege('anon', p.oid, 'execute');
  if v is not null then raise exception 'owner RPCs must never be executable by anon: %', v; end if;
end $$;
