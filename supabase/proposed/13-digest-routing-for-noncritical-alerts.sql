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
declare disp text; mon text; ev text;
  anchor constant text := $a$perform public.notify_telegram('evening_report', msg, 'evening:' || today, 720);$a$;
  addition constant text := $b$begin
    msg := msg || chr(10) || chr(10) || coalesce(private.daily_open_faults_section(now(), greatest(3900 - length(msg) - 2, 200)), '');
  exception when others then
    msg := msg || chr(10) || chr(10) || '🛠 حالة الأنظمة والأعطال' || chr(10) || '⚠️ تعذّر إعداد هذا القسم.';
  end;
  $b$;
  patched constant text := addition || anchor;
begin
  if to_regclass('private.ops_events') is null
     or to_regprocedure('private.observe_ops_event(text,text,text,text,timestamptz,text)') is null
     or to_regprocedure('private.resolve_ops_event(text,text,timestamptz)') is null
     or to_regprocedure('private.close_stale_ops_events(timestamptz,interval)') is null
     or to_regprocedure('private.daily_open_faults_section(timestamptz,integer)') is null then
    raise exception 'proposed/13 requires proposed/12 (digest bundle) to be applied first';
  end if;
  -- قسم الأعطال يجب أن يكون موصولاً بالتقرير المسائي، وإلا فالتسجيل بلا عرض = أعطال صامتة
  -- كتلة الاستدعاء الفعلية بالنص الدقيق (وجود الاسم في تعليق أو كتلة ميتة لا يكفي) مرة واحدة بالضبط
  ev := pg_get_functiondef(to_regprocedure('public.send_evening_report()'));
  if (length(ev) - length(replace(ev, patched, ''))) / length(patched) <> 1 then
    raise exception 'proposed/13: send_evening_report lacks the exact open-faults block from proposed/12; refusing (would silence faults)';
  end if;
  select prosrc into disp from pg_proc where oid = to_regprocedure('private.notify_telegram_dispatch(text,text,text,integer,jsonb)');
  if disp is null then raise exception 'proposed/13: private.notify_telegram_dispatch not found'; end if;
  -- بصمتان فقط: جسم الإنتاج الحالي، أو جسم 13 نفسه (إعادة التشغيل). وجود الوسم وحده لا يكفي.
  if md5(disp) not in ('60bbae6f1fed8ba5e66c9a9a91daed40', 'f7bee114d77cecea3bf9fceceb24425a') then
    raise exception 'proposed/13: private.notify_telegram_dispatch drifted from the known body (md5 %); refusing to overwrite', md5(disp);
  end if;
end $pre$;
-- مساعدا التوجيه يُستبدلان أدناه: يجب أن يكونا بجسم 12 (أول تطبيق) أو جسم 13 (إعادة)، وإلا تعديل لاحق يُفقَد بصمت
do $pre2$ begin
  if md5((select prosrc from pg_proc where oid = to_regprocedure('private.ops_event_route(text,text)'))) not in ('8c55e7855fd285e956506f7d0ebd10b2', 'f34f129268ee375c10006f004de2d00e')
     or md5((select prosrc from pg_proc where oid = to_regprocedure('private.close_stale_ops_events(timestamptz,interval)'))) not in ('a9519e09e396dbc5b99eb1872bd118b4', '24a5fcd5b080d461813a04940a02af17') then
    raise exception 'proposed/13: ops_event_route/close_stale_ops_events drifted from the known 12/13 bodies; refusing to overwrite later changes';
  end if;
  -- المساعدان الجديدان (يُنشآن هنا): إن وُجدا مسبقاً فيجب أن يطابقا جسم 13 بالضبط وإلا فُقد تعديل لاحق عليهما
  if to_regprocedure('private.refine_immediate_alert(text,text,text)') is not null
     and md5((select prosrc from pg_proc where oid = to_regprocedure('private.refine_immediate_alert(text,text,text)'))) is distinct from 'b62dddfef4aff64199722e5e1e5d57be' then
    raise exception 'proposed/13: refine_immediate_alert drifted from the proposed/13 body; refusing to overwrite later changes';
  end if;
  if (to_regprocedure('private.ops_event_silence(text)') is not null or to_regprocedure('private.absorb_digest_alert(text,text,text)') is not null)
     and (md5((select prosrc from pg_proc where oid = to_regprocedure('private.ops_event_silence(text)'))) is distinct from '2796ac5d112c557951d8fd3c837de6f7'
     or md5((select prosrc from pg_proc where oid = to_regprocedure('private.absorb_digest_alert(text,text,text)'))) is distinct from '88c6e3d972aa11368de77a7c7a2b52e0') then
    raise exception 'proposed/13: ops_event_silence/absorb_digest_alert drifted from the proposed/13 bodies; refusing to overwrite later changes';
  end if;
end $pre2$;

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
  -- ناقل الملخص نفسه: فشل مهمة التقرير المسائي وغياب التقرير لا يظهران في ملخص لا يُرسَل ⇒ فوريان دائماً
  when coalesce(p_dedupe_key,'') ~ '^(project-cron-failure:send-evening-report|evening-missing:|evening:)' then 'immediate'
  -- بوابة نشر Windows ومشغّل المهام: رفض سكربت كتابة (بصمة غير معتمدة/قائمة مفقودة)، علامة نشر عالقة، انهيار البوابة
  -- أحداث سلامة لا تُحجَب في ملخص ⇒ فورية دائماً (kind='windows' عام لكل رسائل البوابة)
  when coalesce(p_dedupe_key,'') ~ '^(deploy-gate-|launcher-)' then 'immediate'
  -- فحص الصحة الآلي: انقطاع الموقع وانهيار المراقب نفسه فوريان؛ بقية المشاكل (workflow فاشل، نشرة، بحث) ملخص
  when p_kind = 'health_check' then
   case when coalesce(p_dedupe_key,'') ~ '^health-(site-down|health-check-crashed)' then 'immediate' else 'digest' end
  -- فشل GitHub Actions: دخان ما بعد النشر (الموقع الحي منهار) وانهيار فحص الصحة فوريان؛ الباقي ملخص
  when p_kind = 'github_actions_failure' then
   case when coalesce(p_dedupe_key,'') ~ '^gha-fail:(دخان ما بعد النشر|فحص صحة المشروع)' then 'immediate' else 'digest' end
  -- الأسعار (قرار المالك): أي فروقات/مواد ناقصة في مزامنة الأسعار وفشل التحقق ⇒ فوري دائماً
  -- (يُصاغ نص الاختلاف مقابل التأثير المؤكَّد في private.refine_immediate_alert، ويُمنع التكرار لنفس الحالة)
  when p_kind in ('price_sync_failure','price_sync_mismatch') then 'immediate'
  when coalesce(p_dedupe_key,'') ~ '^price-sync:' then 'immediate'
  -- فشل إحياء الخادم المحلي: يُرسَل بعد محاولة الإنعاش والتحقق الفعلي فقط (ensure-local-server.ps1)،
  -- تذكير كل 60 دقيقة (dedupe السكربت) ما دامت الخدمة متوقفة ⇒ فوري
  when coalesce(p_dedupe_key,'') = 'local-server-revive-fail' then 'immediate'
  -- sync_failure بحسب الأثر الفعلي: سلسلة الأسعار (تطبيق الأسعار على الأمين، سحب المعتمَد) تمسّ أسعار البيع
  -- فعلياً ⇒ فوري؛ بقية دفعات البيانات (ربح، مصاريف، تدقيق، بنود مبيعات) تتأخر بياناتها فقط وتُعاد كل دورة ⇒ ملخص
  when coalesce(p_dedupe_key,'') ~ '^winfail:(apply-to-ameen|pull-approved-prices)$' then 'immediate'
  when p_kind in ('sync_failure','windows','automation_failure') then 'digest'
  when coalesce(p_dedupe_key,'') ~ '^(winfail:|project-cron-failure:|automation-failure:)' then 'digest'
  else 'immediate'
 end
$$;
revoke all on function private.ops_event_route(text,text) from public, anon, authenticated;

-- نافذة الصمت (= قرينة التعافي) لكل حدث: سكربتات تعمل كل دقائق وتعيد الإبلاغ كل مرة تفشل
-- فيها ⇒ ثلاث ساعات تكفي؛ أحداث يومية أو مدفوعة بالأحداث (لا تكرار بلا فشل جديد) ⇒ 30 ساعة،
-- فيراها تقرير المساء التالي حتماً حتى لو لم تتكرر. (عامل أمين يُنذر مرة واحدة لكل حادثة ثم يصمت؛
-- يُغلق فقط برسالة التعافي، فلا تُغلقه نافذة الصمت قبل التقرير.)
create or replace function private.ops_event_silence(p_event_key text)
returns interval language sql immutable as $$
 select case
  when coalesce(p_event_key,'') ~ '^(daily-git-pull|gha-fail:|health-|automation-failure:|ameen-read-worker-)' then interval '30 hours'
  else interval '3 hours'
 end
$$;
revoke all on function private.ops_event_silence(text) from public, anon, authenticated;

create or replace function private.close_stale_ops_events(
  p_now timestamptz default now(), p_silence interval default interval '6 hours')
returns void language sql security definer set search_path=private,pg_temp as $$
 update private.ops_events set resolved_at=p_now, resolution='silence'
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

-- يُحسّن نص/مفتاح التنبيه الفوري لمزامنة الأسعار (المعيار: اكتشاف اختلاف ≠ تأثير مؤكَّد):
--   فروقات > 0  ⇒ «تأثير مؤكَّد»: الفحص المستقل بعد الكتابة وجد في الأمين سعراً يخالف المعتمَد فعلاً.
--   فروقات = 0 ومواد ناقصة > 0 ⇒ «اكتُشف اختلاف»: مواد معتمدة غير موجودة للمقارنة؛ لم يثبت أن سعراً خاطئاً يُباع.
-- المفتاح يحمل الشدة والأعداد، والمقارنة مع **آخر** تنبيه سعري فقط: نفس الحالة المتتالية لا تتكرر (يومياً كحد أقصى)،
-- وأي تغيّر في الشدة أو الأعداد يمرّ فوراً حتى لو عاد إلى حالة سبق إرسالها قبل ساعات (لا إخفاء لتبدّل الشدة).
-- أي نص غير مفهوم ⇒ يعيد null ⇒ يُرسَل الأصلي كما هو (لا رسالة تضيع).
create or replace function private.refine_immediate_alert(p_kind text, p_message text, p_key text)
returns table(msg text, dkey text, mins int, skip boolean) language plpgsql stable as $$
declare d int; m int; nk text; lk text; lt timestamptz;
begin
 -- فشل التحقق: فوري مع توضيح أن الحالة غير مؤكَّدة؛ التكرار بنفس مفتاح السكربت خلال 60 دقيقة يُحجب
 if p_kind = 'price_sync_failure' then
  nk := coalesce(nullif(p_key,''), 'price-sync:verify-failed');
  select o.created_at into lt from public.telegram_outbox o where o.dedupe_key = nk order by o.id desc limit 1;
  return query select '🚨 مزامنة الأسعار: تعذّر التحقق من نتيجتها مع الأمين' || chr(10)
                      || 'الحالة غير مؤكَّدة: لا يُعرف إن كانت الأسعار الفعلية في الأمين سليمة أم لا؛ يلزم فحص يدوي.',
                      nk, 60, (lt is not null and lt > now() - interval '60 minutes');
  return;
 end if;
 if p_kind is distinct from 'price_sync_mismatch' then return; end if;
 d := substring(p_message from 'فروقات:\s*([0-9]+)')::int;
 m := substring(p_message from 'مواد ناقصة:\s*([0-9]+)')::int;
 if d is null or m is null or (d = 0 and m = 0) then return; end if;
 -- وجود فروقات أو نواقص لا يثبت وحده أن سعراً خاطئاً طُبِّق فعلاً (الرسالة تحمل أعداداً فقط، لا دليل على السعر الفعلي)
 -- ⇒ لا نصف أي حالة بأنها «تأثير مؤكَّد»؛ التأثير المؤكَّد يتطلب دليلاً موثوقاً غير متوفر في هذا المصدر.
 nk := 'price-sync:mismatch:detected:' || d || ':' || m;
 select o.dedupe_key, o.created_at into lk, lt from public.telegram_outbox o
  where o.dedupe_key like 'price-sync:mismatch:%' order by o.id desc limit 1;
 return query select '⚠️ مزامنة الأسعار: اكتُشف اختلاف (التأثير على الأسعار الفعلية غير مؤكَّد)' || chr(10)
                     || 'فروقات: ' || d || ' — مواد ناقصة: ' || m || chr(10)
                     || 'لم يثبت أن سعراً خاطئاً طُبِّق في الأمين؛ يلزم تحقق.', nk, 1440,
                     (lk = nk and lt > now() - interval '1440 minutes');
end $$;
revoke all on function private.refine_immediate_alert(text,text,text) from public, anon, authenticated;

create or replace function private.notify_telegram_dispatch(
  p_event_type     text,
  p_message        text,
  p_dedupe_key     text default null,
  p_dedupe_minutes int  default 60,
  p_reply_markup   jsonb default null
) returns void
language plpgsql security definer set search_path = public
as $$
declare rf record; refined boolean := false;
begin
  -- digest-routing:v1  (proposed/13) — غير الحرج يذهب للسجلّ الموحَّد؛ أي فشل ⇒ يُرسَل كالمعتاد
  if p_message is not null and length(trim(p_message)) > 0 and p_reply_markup is null then
    begin
      if private.absorb_digest_alert(p_event_type, p_message, p_dedupe_key) then return; end if;
    exception when others then null;  -- عطل في آلية الملخص لا يمنع التنبيه (أمن/فشل التقرير المسائي مستقلان)
    end;
  end if;
  if p_message is null or length(trim(p_message)) = 0 then return; end if;
  if p_reply_markup is null and p_event_type in ('price_sync_mismatch','price_sync_failure') then
    begin
      select * into rf from private.refine_immediate_alert(p_event_type, p_message, p_dedupe_key);
      if rf.msg is not null and rf.skip then return; end if;
      if rf.msg is not null then
        p_message := rf.msg; p_dedupe_key := rf.dkey; refined := true; -- التكرار حُسم في refine (skip)؛ لا يحجب تبدّلَ الشدة صفٌّ أقدم
      end if;
    exception when others then null;  -- يفشل مفتوحاً: يُرسَل النص الأصلي
    end;
  end if;
  if not refined and p_dedupe_key is not null and exists (
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
