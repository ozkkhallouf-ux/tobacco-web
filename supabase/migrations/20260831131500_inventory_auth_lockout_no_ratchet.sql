-- ============================================================================
-- قفل دخول موظفي الجرد: إزالة "السقّاطة" التي تجعل الانتظار ١٥ دقيقة بلا فائدة.
--
-- العطل (مُشخَّص على الإنتاج 2026-08-31):
--   smart_inventory_auth_record كانت تزيد failed_attempts وتُعيد ضبط
--   locked_until = now() + 15 دقيقة عند كل محاولة فاشلة بلا استثناء، بينما
--   الدالة تُستدعى أيضاً من المسار الذي رفضته smart_inventory_auth_preflight
--   أصلاً. النتيجة عطلان متلازمان:
--
--   (١) تمديد لا نهائي: كل محاولة أثناء القفل تُجدّد القفل ١٥ دقيقة كاملة من
--       لحظتها. الموظف الذي يعيد المحاولة كل دقيقة — وهو السلوك الطبيعي —
--       لا يخرج من القفل أبداً، ورسالة «انتظر ١٥ دقيقة» تصير وعداً كاذباً.
--
--   (٢) عدّاد لا يُصفَّر: بعد انتهاء القفل يبقى failed_attempts ≥ ٥، فأول خطأ
--       لاحق واحد يُعيد القفل ١٥ دقيقة فوراً بدل أن تعود الميزانية كاملة.
--       عملياً: قفل دائم بالاسم، وأي طرف يعرف اسم المستخدم يستطيع إبقاء موظف
--       جرد خارج النظام بمحاولة خاطئة واحدة كل ١٥ دقيقة.
--
-- الإصلاح: قرار القفل يخرج إلى دالة نقية قابلة للاختبار حالةً حالة
-- (smart_inventory_auth_lock_state)، بثلاثة فروع صريحة لا رابع لها:
--   • قفل سارٍ    ⇒ لا يُمدَّد ولا يُزاد العدّاد (لم يُفحص أي كلمة مرور أصلاً).
--   • قفل منتهٍ   ⇒ العدّاد يعود إلى ١ والقفل يُرفع — الانتظار يعيد الميزانية.
--   • بلا قفل     ⇒ العدّاد يزيد، ويُقفل ١٥ دقيقة عند بلوغ ٥ محاولات.
--
-- لا يمسّ هذا الملف أي حساب قائم ولا كلمة مرور ولا جلسة جرد.
-- ============================================================================

do $$
begin
  if to_regtype('public.inventory_auth_lock_state') is null then
    create type public.inventory_auth_lock_state as (
      failed_attempts integer,
      locked_until timestamptz
    );
  end if;
end $$;

-- دالة نقية بلا أي أثر جانبي: كل وسائطها صريحة (بما فيها اللحظة) تحديداً كي
-- يكون جدول الحقيقة في supabase/tests/inventory-auth-lockout-truth-table.sql
-- حتمياً على الحدود بدل أن يعتمد على لحظة التنفيذ.
create or replace function public.smart_inventory_auth_lock_state(
  p_failed_attempts integer,
  p_locked_until timestamptz,
  p_now timestamptz
) returns public.inventory_auth_lock_state
language sql immutable parallel safe set search_path = '' as $$
  select row(
    case
      when p_locked_until is not null and p_locked_until >  p_now then coalesce(p_failed_attempts, 0)
      when p_locked_until is not null and p_locked_until <= p_now then 1
      else coalesce(p_failed_attempts, 0) + 1
    end,
    case
      when p_locked_until is not null and p_locked_until >  p_now then p_locked_until
      when p_locked_until is not null and p_locked_until <= p_now then null
      when coalesce(p_failed_attempts, 0) + 1 >= 5 then p_now + interval '15 minutes'
      else null
    end
  )::public.inventory_auth_lock_state;
$$;

comment on function public.smart_inventory_auth_lock_state(integer, timestamptz, timestamptz) is
  'قرار قفل الدخول، نقي وقابل للاختبار. القفل السارٍ لا يُمدَّد أبداً، والقفل المنتهي يُصفّر العدّاد.';

create or replace function public.smart_inventory_auth_record(p_key_hash text, p_username text, p_success boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz := now();
  v_state public.inventory_auth_lock_state;
begin
  if current_user not in ('service_role','postgres','supabase_admin') then
    raise exception 'service_role_only' using errcode='42501';
  end if;

  if p_success then
    update public.inventory_auth_rate_limits set failed_attempts=0, locked_until=null, last_attempt_at=v_now
     where key_hash=p_key_hash;
    update public.inventory_counter_accounts set failed_attempts=0, locked_until=null, updated_at=v_now
     where username_normalized=p_username;
    return;
  end if;

  select public.smart_inventory_auth_lock_state(r.failed_attempts, r.locked_until, v_now)
    into v_state from public.inventory_auth_rate_limits r where r.key_hash=p_key_hash for update;
  if found then
    update public.inventory_auth_rate_limits
       set failed_attempts=v_state.failed_attempts, locked_until=v_state.locked_until, last_attempt_at=v_now
     where key_hash=p_key_hash;
  end if;

  select public.smart_inventory_auth_lock_state(a.failed_attempts, a.locked_until, v_now)
    into v_state from public.inventory_counter_accounts a where a.username_normalized=p_username for update;
  if found then
    update public.inventory_counter_accounts
       set failed_attempts=v_state.failed_attempts, locked_until=v_state.locked_until, updated_at=v_now
     where username_normalized=p_username;
  end if;
end; $$;

revoke all on function public.smart_inventory_auth_lock_state(integer, timestamptz, timestamptz)
  from public, anon, authenticated;
revoke all on function public.smart_inventory_auth_record(text, text, boolean)
  from public, anon, authenticated;
grant execute on function public.smart_inventory_auth_lock_state(integer, timestamptz, timestamptz) to service_role;
grant execute on function public.smart_inventory_auth_record(text, text, boolean) to service_role;
