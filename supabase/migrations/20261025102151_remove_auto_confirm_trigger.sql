-- ============================================================================
-- Migration 25: إيقاف التأكيد التلقائي لأي حساب جديد في auth.users (2026-10-25) — مقترحة، غير مطبَّقة
--
-- المشكلة:
--   المشغّل auto_confirm_new_user_trg (BEFORE INSERT على auth.users) ينفّذ الدالة
--   public.auto_confirm_new_user() (SECURITY DEFINER) فتضع email_confirmed_at = now()
--   لكل مستخدم جديد بلا تأكيد. ليس في المستودع؛ أُنشئ يدوياً على الإنتاج.
--   أثره: لو فُتح التسجيل الذاتي يوماً (أو أُعيد تفعيل «Confirm email») صار كل تسجيل
--   مؤكَّداً فوراً ودخل بدور authenticated، متجاوزاً تأكيد البريد.
--
-- الإصلاح بأقل تغيير:
--   1) محاولة حذف المشغّل. حذف مشغّل يتطلب ملكية الجدول، وauth.users ملك
--      supabase_auth_admin لا postgres؛ فإن رُفض الحذف (42501) يبقى المشغّل غلافاً فارغاً.
--   2) جسم الدالة يصير تمريراً محضاً (return new) في الحالتين، فلا يغيّر أي صف.
--      هذا مضمون الصلاحية: postgres مالك الدالة.
--
-- لا يمسّ: إعدادات Auth (disable_signup يبقى كما هو)، ولا أي مستخدم قائم (الحسابات
-- العشرة مؤكَّدة كلها)، ولا مسار إنشاء الحسابات الإداري: inventory-auth يمرّر
-- email_confirm: true فيصل الصف مؤكَّداً من GoTrue نفسه. إنشاء مستخدم من لوحة Supabase
-- يحتاج بعدها خيار «Auto Confirm User» صراحة.
--
-- التطبيق: معاملة واحدة بحارس وتحقق داخلي. التراجع: 25-remove-auto-confirm-trigger-rollback.sql
-- ============================================================================

begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

-- --- الحارس: الدالة والمشغّل كما دُقِّقا على الإنتاج، والهجرة غير مطبَّقة --------
do $guard$
declare
  v_fn regprocedure := to_regprocedure('public.auto_confirm_new_user()');
begin
  if v_fn is null then
    raise exception 'migration 25 guard: public.auto_confirm_new_user() missing';
  end if;
  if exists (select 1 from pg_proc where oid = v_fn and position('Migration 25' in coalesce(obj_description(oid, 'pg_proc'), '')) > 0) then
    raise exception 'migration 25 guard: already applied';
  end if;
  if (select md5(prosrc) from pg_proc where oid = v_fn) <> '87419c26b8fbe5fd1e29a7e180829363' then
    raise exception 'migration 25 guard: function body differs from audited production';
  end if;
  if not exists (
    select 1 from pg_trigger t
    where t.tgrelid = 'auth.users'::regclass and t.tgname = 'auto_confirm_new_user_trg'
      and t.tgfoid = v_fn and not t.tgisinternal and t.tgenabled = 'O'
      and pg_get_triggerdef(t.oid) like 'CREATE TRIGGER auto_confirm_new_user_trg BEFORE INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION %auto_confirm_new_user()'
  ) then
    raise exception 'migration 25 guard: trigger missing or changed';
  end if;
  if exists (select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid
             where t.tgfoid = v_fn and t.tgname <> 'auto_confirm_new_user_trg') then
    raise exception 'migration 25 guard: function used by another trigger';
  end if;
end
$guard$;

-- --- 1) حذف المشغّل إن سمحت الملكية -------------------------------------------
do $drop$
begin
  drop trigger auto_confirm_new_user_trg on auth.users;
  raise notice 'migration 25: trigger dropped';
exception when insufficient_privilege then
  raise notice 'migration 25: trigger kept (auth.users not owned by %), function neutralized', current_user;
end
$drop$;

-- --- 2) الدالة تمرير محض -------------------------------------------------------
create or replace function public.auto_confirm_new_user()
returns trigger
language plpgsql
security definer
set search_path to 'auth', 'public', 'pg_temp'
as $function$
begin
  return new;
end;
$function$;

comment on function public.auto_confirm_new_user() is
  'Migration 25: معطّلة (تمرير محض). كانت تضع email_confirmed_at لكل مستخدم جديد. التراجع: proposed/25-...-rollback.sql';

-- --- تحقق داخل المعاملة -------------------------------------------------------
do $verify$
begin
  if exists (select 1 from pg_proc where oid = 'public.auto_confirm_new_user()'::regprocedure
             and prosrc ilike '%email_confirmed_at%') then
    raise exception 'verify: function still sets email_confirmed_at';
  end if;
  if exists (select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid
             where t.tgrelid = 'auth.users'::regclass and not t.tgisinternal
               and p.prosrc ilike '%email_confirmed_at%') then
    raise exception 'verify: another auth.users trigger still sets email_confirmed_at';
  end if;
end
$verify$;

commit;
