-- بيئة اختبار محلية لـ proposed/23: الجدولان والدالة والـtrigger بنسختها الإنتاجية الحرفية
-- (بصمة الجسم d1e5f0e91bd925e3a6cd02cf1c5b6a66 بتاريخ 2026-10-24). لا بيانات إنتاج.
create table public.telegram_outbox (
  id bigint generated always as identity primary key,
  event_type text not null,
  message text not null,
  created_at timestamptz not null default now()
);
create table public.web_push_subscriptions (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  endpoint text not null unique,
  p256dh text not null,
  auth_key text not null,
  enabled boolean not null default true,
  last_success_at timestamptz,
  last_error text
);
create table public.web_push_outbox (
  id bigint generated always as identity primary key,
  event_type text not null,
  title text not null,
  body text not null,
  tag text,
  navigate text not null default '/?route=overview',
  status text not null default 'pending' check (status in ('pending','sent','failed')),
  attempts int not null default 0,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  last_error text
);
do $roles$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $roles$;

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

create trigger trg_mirror_telegram_to_web_push
after insert on public.telegram_outbox
for each row execute function public.mirror_telegram_to_web_push();
