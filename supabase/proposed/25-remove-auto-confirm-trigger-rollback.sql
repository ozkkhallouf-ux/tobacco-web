-- ============================================================================
-- تراجع Migration 25: يعيد الدالة public.auto_confirm_new_user() بجسمها الأصلي حرفياً
-- (md5(prosrc) = 87419c26…) ويعيد المشغّل إن كان قد حُذف، أي يعيد التأكيد التلقائي.
-- إنشاء المشغّل يكفيه امتياز TRIGGER على auth.users (يملكه postgres). لا يمسّ أي مستخدم.
-- ============================================================================

begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

do $guard$
begin
  if to_regprocedure('public.auto_confirm_new_user()') is null
     or position('Migration 25' in coalesce(obj_description('public.auto_confirm_new_user()'::regprocedure, 'pg_proc'), '')) = 0 then
    raise exception 'migration 25 rollback guard: migration 25 is not applied';
  end if;
end
$guard$;

create or replace function public.auto_confirm_new_user()
returns trigger
language plpgsql
security definer
set search_path to 'auth', 'public', 'pg_temp'
as $function$
begin
  if new.email_confirmed_at is null then
    new.email_confirmed_at := now();
  end if;
  return new;
end;
$function$;

comment on function public.auto_confirm_new_user() is null;

do $trigger$
begin
  if not exists (select 1 from pg_trigger where tgrelid = 'auth.users'::regclass and tgname = 'auto_confirm_new_user_trg') then
    create trigger auto_confirm_new_user_trg before insert on auth.users
      for each row execute function public.auto_confirm_new_user();
  end if;
end
$trigger$;

do $verify$
begin
  if (select md5(prosrc) from pg_proc where oid = 'public.auto_confirm_new_user()'::regprocedure) <> '87419c26b8fbe5fd1e29a7e180829363' then
    raise exception 'rollback verify: function body not restored';
  end if;
end
$verify$;

commit;
