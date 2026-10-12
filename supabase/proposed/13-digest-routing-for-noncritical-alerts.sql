-- proposed/13-digest-routing-for-noncritical-alerts.sql
--
-- **غير مطبَّق على الإنتاج ويتطلب موافقة المالك الصريحة، ويُطبَّق بعد الحزمة 12 فقط.**
--
-- الغرض: أعطال Windows / المزامنة / الأسعار / GitHub غير الحرجة تصل اليوم إلى Telegram فوراً
-- لأنها تمرّ عبر public.notify_telegram مباشرة (سكربتات tools/*.ps1 وworkflow وscripts/health-check.mjs).
-- سياسة «الملخص اليومي فقط» تقتضي أن تُسجَّل في private.ops_events وتظهر في قسم
-- «حالة الأنظمة والأعطال» من التقرير المسائي، بلا رسالة مستقلة، دون تعديل أي سكربت مزامنة.
--
-- النقطة الوحيدة المشتركة: private.notify_telegram_dispatch (تستدعيها public.notify_telegram).
-- **public.notify_telegram نفسها لا تُمَس** (بصمتها تبقى كما هي). تُعدَّل الدالة الداخلية فقط
-- وبشكل «يفشل مفتوحاً»: كل ما ليس مصنَّفاً «ملخصاً» صراحةً، وكل ما يفشل تسجيله، يُدرَج في
-- telegram_outbox كما كان تماماً — فلا رسالة مهمة تضيع.
--
-- تغيّر أيضاً: ops_event_route (تصنيف أدق: health_check يفصل انقطاع الموقع عن غيره، وgithub_actions
-- يُبقي دخان ما بعد النشر فورياً)، وclose_stale_ops_events (نافذة صمت لكل مصدر: 3 ساعات للسكربتات
-- الدورية، و30 ساعة للأحداث اليومية/المدفوعة بالأحداث حتى يراها تقرير المساء التالي حتماً).
--
-- يُشغَّل كطلب واحد (معاملة ضمنية). التراجع: 13-digest-routing-rollback.sql.
do $pre$
declare disp text; mon text;
begin
  if to_regclass('private.ops_events') is null
     or to_regprocedure('private.observe_ops_event(text,text,text,text,timestamptz,text)') is null
     or to_regprocedure('private.resolve_ops_event(text,text,timestamptz)') is null
     or to_regprocedure('private.close_stale_ops_events(timestamptz,interval)') is null
     or to_regprocedure('private.daily_open_faults_section(timestamptz,integer)') is null then
    raise exception 'proposed/13 requires proposed/12 (digest bundle) to be applied first';
  end if;
  -- قسم الأعطال يجب أن يكون موصولاً بالتقرير المسائي، وإلا فالتسجيل بلا عرض = أعطال صامتة
  if position('daily_open_faults_section' in pg_get_functiondef(to_regprocedure('public.send_evening_report()'))) = 0 then
    raise exception 'proposed/13: send_evening_report does not include the open-faults section; refusing (would silence faults)';
  end if;
  select prosrc into disp from pg_proc where oid = to_regprocedure('private.notify_telegram_dispatch(text,text,text,integer,jsonb)');
  if disp is null then raise exception 'proposed/13: private.notify_telegram_dispatch not found'; end if;
  if md5(disp) not in ('60bbae6f1fed8ba5e66c9a9a91daed40') and position('digest-routing:v1' in disp) = 0 then
    raise exception 'proposed/13: private.notify_telegram_dispatch drifted from the known body (md5 %); refusing to overwrite', md5(disp);
  end if;
end $pre$;

-- لقطة قبل التعديل (مرة واحدة فقط: إعادة التطبيق لا تُسجّل النسخة المعدَّلة كأصل)
create table if not exists private.digest_routing_snapshot(
  fn text primary key, def text not null, taken_at timestamptz not null default now());
alter table private.digest_routing_snapshot enable row level security;
revoke all on private.digest_routing_snapshot from public, anon, authenticated;
insert into private.digest_routing_snapshot(fn, def)
  select 'private.notify_telegram_dispatch(text,text,text,integer,jsonb)',
         pg_get_functiondef(to_regprocedure('private.notify_telegram_dispatch(text,text,text,integer,jsonb)'))
  where position('digest-routing:v1' in (select prosrc from pg_proc where oid = to_regprocedure('private.notify_telegram_dispatch(text,text,text,integer,jsonb)'))) = 0
  on conflict (fn) do nothing;
insert into private.digest_routing_snapshot(fn, def)
  select 'private.ops_event_route(text,text)', pg_get_functiondef(to_regprocedure('private.ops_event_route(text,text)'))
  on conflict (fn) do nothing;
insert into private.digest_routing_snapshot(fn, def)
  select 'private.close_stale_ops_events(timestamptz,interval)', pg_get_functiondef(to_regprocedure('private.close_stale_ops_events(timestamptz,interval)'))
  on conflict (fn) do nothing;

-- التصنيف: 'digest' فقط لما ثبت أنه غير حرج؛ كل ما سواه (والمجهول) فوري.
create or replace function private.ops_event_route(p_kind text, p_dedupe_key text)
returns text language sql immutable as $$
 select case
  when coalesce(p_kind,'')       ~* '(secur|auth|breach)'  then 'immediate'
  when coalesce(p_dedupe_key,'') ~* '(backup|secur|auth|breach)' then 'immediate'
  -- فحص الصحة الآلي: انقطاع الموقع وانهيار المراقب نفسه فوريان؛ بقية المشاكل (workflow فاشل، نشرة، بحث) ملخص
  when p_kind = 'health_check' then
   case when coalesce(p_dedupe_key,'') ~ '^health-(site-down|health-check-crashed)' then 'immediate' else 'digest' end
  -- فشل GitHub Actions: دخان ما بعد النشر (الموقع الحي منهار) وانهيار فحص الصحة فوريان؛ الباقي ملخص
  when p_kind = 'github_actions_failure' then
   case when coalesce(p_dedupe_key,'') ~ '^gha-fail:(دخان ما بعد النشر|فحص صحة المشروع)' then 'immediate' else 'digest' end
  when p_kind in ('sync_failure','price_sync_failure','price_sync_mismatch','windows','automation_failure') then 'digest'
  when coalesce(p_dedupe_key,'') ~ '^(price-sync:|winfail:|project-cron-failure:|automation-failure:)' then 'digest'
  else 'immediate'
 end
$$;
revoke all on function private.ops_event_route(text,text) from public, anon, authenticated;

-- نافذة الصمت (= قرينة التعافي) لكل حدث: سكربتات تعمل كل دقائق وتعيد الإبلاغ كل مرة تفشل
-- فيها ⇒ ثلاث ساعات تكفي؛ أحداث يومية أو مدفوعة بالأحداث (لا تكرار بلا فشل جديد) ⇒ 30 ساعة،
-- فيراها تقرير المساء التالي حتماً حتى لو لم تتكرر.
create or replace function private.ops_event_silence(p_event_key text)
returns interval language sql immutable as $$
 select case
  when coalesce(p_event_key,'') ~ '^(daily-git-pull|gha-fail:|health-|automation-failure:)' then interval '30 hours'
  else interval '3 hours'
 end
$$;
revoke all on function private.ops_event_silence(text) from public, anon, authenticated;

create or replace function private.close_stale_ops_events(
  p_now timestamptz default now(), p_silence interval default interval '6 hours')
returns void language sql security definer set search_path=private,pg_temp as $$
 update private.ops_events set resolved_at=p_now
  where resolved_at is null and source<>'cron'
    and last_seen_at < p_now - (case when source='telegram' then private.ops_event_silence(event_key) else p_silence end)
$$;
revoke all on function private.close_stale_ops_events(timestamptz,interval) from public, anon, authenticated;

-- يمتصّ التنبيه غير الحرج في السجلّ الموحَّد. يعيد true فقط إذا سُجِّل فعلاً (أو كان رسالة تعافٍ
-- أغلقت عطلها). أي خطأ ⇒ false ⇒ يُرسَل التنبيه فورياً كما كان (لا رسالة تضيع).
create or replace function private.absorb_digest_alert(p_kind text, p_message text, p_key text)
returns boolean language plpgsql security definer set search_path=private,pg_temp as $$
declare ek text; lbl text; rid text;
begin
 if private.ops_event_route(p_kind, p_key) <> 'digest' then return false; end if;
 -- رسالة تعافي عامل قراءة الأمين: تُغلق عطلَي stuck/degraded لنفس الحادثة ولا تُرسَل
 if p_key ~ '^ameen-read-worker-recovered:' then
  rid := substr(p_key, length('ameen-read-worker-recovered:') + 1);
  perform private.resolve_ops_event('telegram', 'ameen-read-worker-stuck:' || rid);
  perform private.resolve_ops_event('telegram', 'ameen-read-worker-degraded:' || rid);
  return true;
 end if;
 ek := regexp_replace(coalesce(nullif(p_key,''), p_kind), '-noissue-[0-9]+$', '-noissue');
 lbl := left(btrim(split_part(btrim(p_message), chr(10), 1)), 120);
 perform private.observe_ops_event('telegram', ek, coalesce(nullif(lbl,''), ek), left(btrim(p_message), 300));
 return true;
exception when others then
 raise warning 'absorb_digest_alert failed (%), falling back to immediate delivery', sqlerrm;
 return false;
end $$;
revoke all on function private.absorb_digest_alert(text,text,text) from public, anon, authenticated;

create or replace function private.notify_telegram_dispatch(
  p_event_type     text,
  p_message        text,
  p_dedupe_key     text default null,
  p_dedupe_minutes int  default 60,
  p_reply_markup   jsonb default null
) returns void
language plpgsql security definer set search_path = public
as $$
begin
  -- digest-routing:v1  (proposed/13) — غير الحرج يذهب للسجلّ الموحَّد؛ أي فشل ⇒ يُرسَل كالمعتاد
  if p_message is not null and length(trim(p_message)) > 0 and p_reply_markup is null
     and private.absorb_digest_alert(p_event_type, p_message, p_dedupe_key) then
    return;
  end if;
  if p_message is null or length(trim(p_message)) = 0 then return; end if;
  if p_dedupe_key is not null and exists (
    select 1 from public.telegram_outbox
    where dedupe_key = p_dedupe_key
      and created_at > now() - make_interval(mins => greatest(p_dedupe_minutes, 1))
  ) then
    return;
  end if;
  insert into public.telegram_outbox (event_type, message, dedupe_key, reply_markup)
  values (p_event_type, left(p_message, 3900), p_dedupe_key, p_reply_markup);
end;
$$;
revoke all on function private.notify_telegram_dispatch(text, text, text, int, jsonb) from public, anon, authenticated;
grant execute on function private.notify_telegram_dispatch(text, text, text, int, jsonb) to service_role;
