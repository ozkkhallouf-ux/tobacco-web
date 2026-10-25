-- proposed/23-web-push-explicit-allowlist-rollback.sql
--
-- يعيد public.mirror_telegram_to_web_push() إلى جسم الإنتاج قبل 23 حرفياً (md5 d1e5f0e91bd925e3a6cd02cf1c5b6a66،
-- مرشِّح الأنماط القديم)، ويُسقط public.web_push_allowed_event_types().
-- يرفض إن لم يكن الجسم الحالي هو جسم 23 (2b7bf2592546534cca021a7f1a558f0c)، فلا يكتب فوق تعديل لاحق.
-- الأعمدة source_telegram_id وprovider_accepted وprovider_failed تبقى: غير ضارة، وقد تكتبها نسخة
-- Edge Function الجديدة، وحذفها يفقد سجل القبول. لا يمسّ أي سجل في web_push_outbox ولا يعيد إرسال شيء.
-- ترتيب التراجع الكامل: هذا الملف أولاً (توقف الأنواع الجديدة فوراً)، ثم Edge Function إن لزم.

begin;

do $pre$
declare
  v_body_md5 text;
begin
  select md5(p.prosrc) into v_body_md5
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'mirror_telegram_to_web_push';
  if v_body_md5 is distinct from '2b7bf2592546534cca021a7f1a558f0c' then
    raise exception 'proposed/23 rollback: mirror_telegram_to_web_push is not the 23 body (md5 %), refusing', v_body_md5;
  end if;
end
$pre$;

CREATE OR REPLACE FUNCTION public.mirror_telegram_to_web_push()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare first_line text; rest text;
begin
  if not (
    new.event_type = 'payment' or new.event_type like 'stock_%' or new.event_type like 'credit_%'
    or new.event_type like '%limit%' or new.event_type like 'inventory%'
    or new.event_type like 'sync_%' or new.event_type like 'daily_%'
  ) then return new; end if;
  first_line := split_part(new.message, chr(10), 1);
  rest := regexp_replace(new.message, '^[^' || chr(10) || ']*' || chr(10) || '?', '');
  if rest = '' then rest := first_line; end if;
  insert into public.web_push_outbox(event_type,title,body,tag)
  values(new.event_type,left(first_line,120),left(rest,1200),left(new.event_type,80));
  return new;
end; $function$;
revoke all on function public.mirror_telegram_to_web_push() from public, anon, authenticated;

drop function if exists public.web_push_allowed_event_types();

do $post$
declare
  v_body_md5 text;
begin
  select md5(p.prosrc) into v_body_md5
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'mirror_telegram_to_web_push';
  if v_body_md5 is distinct from 'd1e5f0e91bd925e3a6cd02cf1c5b6a66' then
    raise exception 'proposed/23 rollback: restored body mismatch (md5 %)', v_body_md5;
  end if;
end
$post$;

commit;
