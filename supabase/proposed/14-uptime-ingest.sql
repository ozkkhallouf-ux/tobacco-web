-- proposed/14-uptime-ingest.sql
--
-- **غير مطبَّق على الإنتاج ويتطلب موافقة المالك الصريحة.** لا يُنشئ أسراراً ولا يجدول cron ولا يرسل شيئاً.
--
-- الغرض: نقطة استقبال ذرّية لأحداث مراقب Cloudflare `ozk-uptime` (workers/uptime) تُدخلها إلى نظام
-- Telegram القائم (telegram_outbox ← dispatch_telegram_outbox) بنوع الحدث `uptime`.
--
-- الضمانات:
--   * ذرّية: تسجيل event_id وإدخال التنبيه إلى telegram_outbox في **معاملة واحدة** (نداء RPC واحد).
--     أي فشل في الإدخال (أو كتم صامت من notify_telegram_dispatch) يرمي استثناءً فيُلغى التسجيل كله،
--     فيبقى الحدث معلّقاً عند الـWorker ويُعاد إرساله. لا حالة «سُجّل ولم يُرسَل».
--   * idempotency: event_id مفتاح أساسي؛ التكرار يرجع `duplicate` بلا رسالة ثانية (حتى مع نداءين متزامنين).
--   * حادثة واحدة لكل انقطاع: حادثة مفتوحة واحدة لكل هدف (فهرس فريد جزئي + قفل استشاري)؛ معرّف حادثة جديد
--     لنفس الانقطاع (ضياع حالة KV أو قراءة قديمة) يُضاف كاسم بديل ولا يُرسل تنبيهاً ثانياً.
--   * النشرة تسجيل فقط: القرار على الخادم (target = 'site' وحده قابل للتنبيه)، لا على حقل يرسله العميل.
--   * أمان: توقيع HMAC-SHA256 على النص الحرفي للطلب بسرّ في public.app_secrets (`uptime_ingest_hmac`)،
--     ونافذة زمنية ±300 ثانية، وnonce لمرة واحدة (منع replay). بلا السرّ ⇒ الدالة ترفض كل طلب (خاملة).
--   * الإرسال الفعلي مقفل افتراضياً: private.uptime_config.notify_enabled = false ⇒ تسجيل فقط (وضع الظل).
--   * المراقب (watch_uptime_heartbeat) مقفل افتراضياً (watchdog_enabled = false) وغير مجدول هنا.
--
-- لا يمسّ: public.notify_telegram، private.notify_telegram_dispatch (تُستدعى فقط)، dispatch_telegram_outbox،
-- monitor_project_tasks، ولا أي cron قائم. مستقل عن proposed/12 و13 (النوع `uptime` غير مصنَّف ملخصاً
-- في 13، فيمرّ فورياً كما هو إن طُبّقت 13 لاحقاً).
--
-- يُشغَّل كطلب واحد (معاملة ضمنية) أو `psql --single-transaction`. التراجع: 14-uptime-ingest-rollback.sql.
-- الاختبار: supabase/tests/uptime-ingest.sim.mjs (PostgreSQL حقيقي، ومعه عقد التوقيع مع كود الـWorker).

do $pre$
begin
  if to_regprocedure('private.notify_telegram_dispatch(text,text,text,integer,jsonb)') is null then
    raise exception 'proposed/14 requires private.notify_telegram_dispatch';
  end if;
  if to_regclass('public.telegram_outbox') is null or to_regclass('public.app_secrets') is null then
    raise exception 'proposed/14 requires public.telegram_outbox and public.app_secrets';
  end if;
  if to_regprocedure('extensions.hmac(bytea,bytea,text)') is null then
    raise exception 'proposed/14 requires pgcrypto in schema extensions';
  end if;
end
$pre$;

-- ── الجداول (كلها في private: غير مكشوفة عبر PostgREST) ──────────────────────────────────────

create table if not exists private.uptime_config (
  id               smallint primary key default 1 check (id = 1),
  notify_enabled   boolean  not null default false,   -- false ⇒ تسجيل فقط (الظل)
  watchdog_enabled boolean  not null default false,   -- false ⇒ المراقب لا يفعل شيئاً
  stale_minutes    integer  not null default 20 check (stale_minutes between 10 and 240),
  updated_at       timestamptz not null default now()
);
insert into private.uptime_config (id) values (1) on conflict (id) do nothing;

create table if not exists private.uptime_heartbeat (
  id                smallint primary key default 1 check (id = 1),
  last_received_at  timestamptz not null,   -- ساعة الخادم (لا ساعة الـWorker)
  last_scheduled_at timestamptz,            -- scheduledTime لآخر تشغيل (للتشخيص فقط)
  runs              bigint not null default 0,
  stale_alerted_for timestamptz             -- قيمة last_received_at التي أُرسل عنها تنبيه التوقف
);

create table if not exists private.uptime_incidents (
  id            bigserial primary key,
  target        text not null check (target in ('site', 'bulletin')),
  incident_key  text not null unique,             -- معرّف الحادثة الأول من الـWorker
  aliases       text[] not null default '{}',     -- معرّفات أخرى للانقطاع نفسه
  opened_at     timestamptz not null default now(),
  closed_at     timestamptz,
  down_notified boolean not null default false,
  reminders     text[] not null default '{}',     -- تذكيرات أُرسلت (1h/6h/24h)
  -- تعافٍ مُعلَّق: إشارة تعافٍ وصلت (حدث recovered أو نبض بحالة UP) ولم تُؤكَّد بعد. التأكيد على دورتين:
  -- دورة مرشّحة أحدث من التعافي قال فيها الـWorker UP، ثم دورة أحدث منها تقول UP. وأي تشغيل يقول DOWN/RECOVERING
  -- بعد التعافي (بأي ترتيب وصول، حتى الشقيق المتأخر لنفس الدقيقة) أو تذكير أحدث يلغيه («اعتراض الشقيق»).
  recover_at    timestamptz,                      -- وقت التعافي المُعلَّق (= closed_at عند التأكيد)
  recover_event text,                             -- event_id لحدث recovered (null ⇒ من مطابقة النبض)
  confirm_tick  timestamptz,                      -- الدورة المرشّحة (scheduledTime) التي قالت UP بلا اعتراض بعد
  reopened      integer not null default 0        -- إعادة فتح بعد تأكيد ناقضه الـWorker (شبكة أمان)
);
create unique index if not exists uptime_incidents_one_open
  on private.uptime_incidents (target) where closed_at is null;

create table if not exists private.uptime_events (
  event_id           text primary key,
  target             text not null,
  type               text not null,
  incident_key       text not null,
  canonical_incident bigint references private.uptime_incidents (id) on delete set null,
  alertable          boolean not null,
  at                 timestamptz not null,
  detail             text,
  outcome            text not null,     -- notified | recorded | suppressed:<سبب>
  outbox_dedupe_key  text,
  received_at        timestamptz not null default now()
);
create index if not exists uptime_events_received_idx on private.uptime_events (received_at);

create table if not exists private.uptime_ingest_nonces (
  nonce       text primary key,
  request_ts  timestamptz not null,
  received_at timestamptz not null default now()
);

revoke all on private.uptime_config, private.uptime_heartbeat, private.uptime_incidents,
              private.uptime_events, private.uptime_ingest_nonces from public, anon, authenticated;
revoke all on sequence private.uptime_incidents_id_seq from public, anon, authenticated;

-- ── نص الرسالة (نص عادي، بلا parse_mode) ───────────────────────────────────────────────────

create or replace function private.uptime_message(
  p_type text, p_label text, p_detail text, p_at timestamptz, p_opened timestamptz
) returns text
language sql immutable set search_path = pg_catalog
as $$
  select case p_type
    when 'down' then
      '🔴 الموقع لا يستجيب' || chr(10) ||
      'الموقع: ozktobacco.com' || chr(10) ||
      'السبب: ' || coalesce(nullif(p_detail, ''), 'غير معروف') || chr(10) ||
      'التأكيد: 3 فحوص فاشلة من آخر 4' || chr(10) ||
      'الوقت: ' || to_char(p_at at time zone 'Asia/Damascus', 'YYYY-MM-DD HH24:MI') || ' (دمشق)' || chr(10) ||
      'المصدر: مراقب Cloudflare (ozk-uptime)'
    when 'reminder' then
      '⏳ الموقع ما زال لا يستجيب' || chr(10) ||
      'المدة: ' || case p_label when '1h' then 'ساعة' when '6h' then '6 ساعات' else '24 ساعة' end || ' أو أكثر' || chr(10) ||
      'منذ: ' || to_char(p_opened at time zone 'Asia/Damascus', 'YYYY-MM-DD HH24:MI') || ' (دمشق)' || chr(10) ||
      'المصدر: مراقب Cloudflare (ozk-uptime)'
    when 'recovered' then
      '✅ عاد الموقع للعمل' || chr(10) ||
      'مدة الانقطاع: نحو ' || greatest(1, round(extract(epoch from (p_at - p_opened)) / 60))::int || ' دقيقة' || chr(10) ||
      'الوقت: ' || to_char(p_at at time zone 'Asia/Damascus', 'YYYY-MM-DD HH24:MI') || ' (دمشق)' || chr(10) ||
      'المصدر: مراقب Cloudflare (ozk-uptime)'
  end
$$;
revoke all on function private.uptime_message(text, text, text, timestamptz, timestamptz) from public, anon, authenticated;

-- إدخال ذرّي إلى telegram_outbox: الكتم الصامت (نص فارغ أو مفتاح مكرر) يُعامل فشلاً ⇒ تُلغى المعاملة.
create or replace function private.uptime_enqueue(p_message text, p_dedupe_key text)
returns void
language plpgsql security definer set search_path = pg_catalog, public
as $$
declare v_before bigint;
begin
  if p_message is null or length(trim(p_message)) = 0 or p_dedupe_key is null then
    raise exception 'uptime_enqueue: empty message or key' using errcode = 'P0001';
  end if;
  select coalesce(max(id), 0) into v_before from public.telegram_outbox where dedupe_key = p_dedupe_key;
  perform private.notify_telegram_dispatch('uptime', p_message, p_dedupe_key, 1440, null);
  if not exists (select 1 from public.telegram_outbox where dedupe_key = p_dedupe_key and id > v_before) then
    raise exception 'uptime_enqueue: outbox row was not inserted for %', p_dedupe_key using errcode = 'P0001';
  end if;
end;
$$;
revoke all on function private.uptime_enqueue(text, text) from public, anon, authenticated;

-- إلغاء تعافٍ معلّق: الحادثة تستمر بمعرّفها وتذكيراتها؛ أثره في سجل الحدث (للتشخيص)، ولا رسالة.
create or replace function private.uptime_cancel_recovery(p_incident bigint)
returns void
language plpgsql security definer set search_path = pg_catalog
as $$
declare v_event text;
begin
  select recover_event into v_event from private.uptime_incidents
   where id = p_incident and closed_at is null and recover_at is not null for update;
  if not found then return; end if;
  update private.uptime_incidents set recover_at = null, recover_event = null, confirm_tick = null where id = p_incident;
  if v_event is not null then
    update private.uptime_events set outcome = 'suppressed:recovery-cancelled' where event_id = v_event;
  end if;
end;
$$;
revoke all on function private.uptime_cancel_recovery(bigint) from public, anon, authenticated;

-- مفتاح رسالة تعافٍ فريد لكل إغلاق (حادثة قد تُغلق مرة ثانية بعد إعادة فتحها، والمفتاح المكرر يُكتم ⇒ فشل المعاملة)
create or replace function private.uptime_close_key(p_incident_key text, p_kind text, p_at timestamptz)
returns text
language sql immutable set search_path = pg_catalog
as $$ select 'uptime:' || p_incident_key || ':' || p_kind || ':' || floor(extract(epoch from p_at) * 1000)::bigint $$;
revoke all on function private.uptime_close_key(text, text, timestamptz) from public, anon, authenticated;

-- ── نقطة الاستقبال ──────────────────────────────────────────────────────────────────────────
-- p_payload: نص JSON الحرفي كما وقّعه الـWorker (التوقيع على النص لا على JSON معاد تسلسله).
-- {"v":1,"ts":<ms>,"nonce":"…","scheduledTime":<ms>,"events":[{id,type,target,incident,at,detail}]}
create or replace function public.uptime_ingest(p_payload text, p_signature text)
returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, private
as $$
declare
  v_secret   text;
  v_expected text;
  j          jsonb;
  v_ts       timestamptz;
  v_nonce    text;
  v_sched    timestamptz;
  v_prev_sched timestamptz;
  v_tstatus  text;
  v_cfg      private.uptime_config;
  e          jsonb;
  v_id text; v_type text; v_target text; v_inc text; v_label text; v_detail text; v_at timestamptz;
  v_alertable boolean;
  v_row      private.uptime_incidents;
  v_outcome  text;
  v_key      text;
  v_results  jsonb := '[]'::jsonb;
begin
  -- ١) السرّ والتوقيع (قبل أي قراءة أو كتابة)
  select value into v_secret from public.app_secrets where name = 'uptime_ingest_hmac';
  if v_secret is null or length(v_secret) < 32 then
    raise exception 'uptime_ingest: disabled' using errcode = '42501';
  end if;
  if p_payload is null or length(p_payload) > 65536
     or p_signature is null or p_signature !~ '^[0-9a-f]{64}$' then
    raise exception 'uptime_ingest: bad request signature' using errcode = '42501';
  end if;
  v_expected := encode(extensions.hmac(convert_to(p_payload, 'UTF8'), convert_to(v_secret, 'UTF8'), 'sha256'), 'hex');
  -- مقارنة بصمتين بدل النصّين مباشرةً: التوقيت لا يكشف بادئة التوقيع الصحيح
  if extensions.digest(v_expected, 'sha256') <> extensions.digest(p_signature, 'sha256') then
    raise exception 'uptime_ingest: bad request signature' using errcode = '42501';
  end if;

  -- ٢) البنية والنافذة الزمنية وnonce (منع replay)
  begin
    j := p_payload::jsonb;
  exception when others then
    raise exception 'uptime_ingest: payload is not json' using errcode = '22023';
  end;
  if jsonb_typeof(j) is distinct from 'object' or (j ->> 'v') is distinct from '1'
     or jsonb_typeof(j -> 'ts') is distinct from 'number'
     or jsonb_typeof(j -> 'events') is distinct from 'array'
     or jsonb_typeof(j -> 'nonce') is distinct from 'string' then
    raise exception 'uptime_ingest: bad payload shape' using errcode = '22023';
  end if;
  v_ts := to_timestamp((j ->> 'ts')::numeric / 1000);
  if abs(extract(epoch from (now() - v_ts))) > 300 then
    raise exception 'uptime_ingest: request outside time window' using errcode = '42501';
  end if;
  v_nonce := j ->> 'nonce';
  if v_nonce !~ '^[A-Za-z0-9:_-]{16,100}$' then
    raise exception 'uptime_ingest: bad nonce' using errcode = '22023';
  end if;
  insert into private.uptime_ingest_nonces (nonce, request_ts) values (v_nonce, v_ts)
    on conflict (nonce) do nothing;
  if not found then
    raise exception 'uptime_ingest: replayed request' using errcode = '42501';
  end if;
  if jsonb_array_length(j -> 'events') > 50 then
    raise exception 'uptime_ingest: too many events' using errcode = '22023';
  end if;
  if jsonb_typeof(j -> 'scheduledTime') = 'number' then
    v_sched := to_timestamp((j ->> 'scheduledTime')::numeric / 1000);
  end if;

  if (j -> 'targets') is not null and (jsonb_typeof(j -> 'targets') is distinct from 'object'
      or exists (select 1 from jsonb_each(j -> 'targets') t
                  where t.key not in ('site', 'bulletin') or jsonb_typeof(t.value) is distinct from 'string'
                     or (t.value #>> '{}') not in ('UP', 'SUSPECT', 'DOWN', 'RECOVERING'))) then
    raise exception 'uptime_ingest: bad targets' using errcode = '22023';
  end if;

  select * into v_cfg from private.uptime_config where id = 1;
  -- قفل الطلب: طلبان متزامنان يُسلسلان هنا (حتى قبل أول نبض)، فيقرأ الثاني ما ثبّته الأول
  perform pg_advisory_xact_lock(hashtext('ozk-uptime:request'));
  select last_scheduled_at into v_prev_sched from private.uptime_heartbeat where id = 1;

  -- ٣) نبض الحياة: ساعة الخادم، رتيب (لا يعيده طلب متأخر إلى الوراء)
  insert into private.uptime_heartbeat as h (id, last_received_at, last_scheduled_at, runs)
  values (1, now(), v_sched, 1)
  on conflict (id) do update
    set last_received_at  = greatest(h.last_received_at, excluded.last_received_at),
        last_scheduled_at = greatest(h.last_scheduled_at, excluded.last_scheduled_at),
        runs              = h.runs + 1;

  -- ٤) الأحداث بترتيبها الزمني (down قبل recovered في نفس اللحظة)
  for e in
    select x from jsonb_array_elements(j -> 'events') x
    order by case when jsonb_typeof(x -> 'at') = 'number' then (x ->> 'at')::numeric end nulls first,
             case x ->> 'type' when 'down' then 0 when 'reminder' then 1 else 2 end
  loop
    v_id := e ->> 'id'; v_type := e ->> 'type'; v_target := e ->> 'target'; v_inc := e ->> 'incident';
    if v_target is null or v_target not in ('site', 'bulletin')
       or v_type is null or v_type not in ('down', 'recovered', 'reminder')
       or v_inc is null or v_inc !~ ('^' || v_target || ':[0-9]{1,15}$')
       or v_id is null or v_id !~ ('^' || v_inc || ':(down|recovered|reminder:(1h|6h|24h))$')
       or split_part(v_id, ':', 3) <> v_type
       or jsonb_typeof(e -> 'at') is distinct from 'number' then
      raise exception 'uptime_ingest: bad event %', left(coalesce(v_id, '?'), 80) using errcode = '22023';
    end if;
    v_label  := nullif(split_part(v_id, ':', 4), '');
    v_detail := left(regexp_replace(coalesce(e ->> 'detail', ''), '[^A-Za-z0-9:._-]', '', 'g'), 60);
    v_at     := to_timestamp((e ->> 'at')::numeric / 1000);
    v_alertable := (v_target = 'site');   -- النشرة تسجيل فقط، بقرار الخادم
    v_outcome := 'recorded'; v_key := null; v_row := null;

    perform pg_advisory_xact_lock(hashtext('ozk-uptime:' || v_target));

    insert into private.uptime_events (event_id, target, type, incident_key, alertable, at, detail, outcome)
    values (v_id, v_target, v_type, v_inc, v_alertable, v_at, v_detail, 'pending')
    on conflict (event_id) do nothing;
    if not found then
      v_results := v_results || jsonb_build_object('id', v_id, 'outcome', 'duplicate');
      continue;
    end if;

    if v_type = 'down' then
      select * into v_row from private.uptime_incidents
       where incident_key = v_inc or v_inc = any (aliases) limit 1;
      if v_row.id is not null then
        v_outcome := case when v_row.closed_at is null then 'suppressed:incident-open' else 'suppressed:incident-closed' end;
      else
        select * into v_row from private.uptime_incidents where target = v_target and closed_at is null for update;
        if v_row.recover_event is not null and v_at > v_row.recover_at
           and to_timestamp(split_part(v_inc, ':', 2)::numeric / 1000) >= v_row.recover_at + interval '25 minutes' then
          -- انقطاع ثانٍ مستقل بعد تعافٍ سجّله الـWorker صراحةً (طابور أُعيد بعد تعذّر Supabase: down A, recovered A, down B).
          -- معرّف B = بداية أول فشل في انقطاعه. بين التعافي وتلك البداية فحوص كلها UP أو SUSPECT عاد UP،
          -- وأقلها 4 دورات (25 دقيقة على دورة 5 دقائق) تضم دورتي UP على الأقل (3 إخفاقات متتالية = DOWN)
          -- = نفس دليل التأكيد على دورتين في ٤أ. فتُختم A عند وقت تعافيها برسالتها، ويُفتح B بتنبيه مستقل.
          -- أقرب من ذلك (تأرجح خلال نافذة التأكيد) يبقى اسماً بديلاً يلغي التعافي كما في الأسفل.
          update private.uptime_incidents set closed_at = v_row.recover_at where id = v_row.id and closed_at is null;
          if v_alertable and v_cfg.notify_enabled and v_row.down_notified then
            v_key := private.uptime_close_key(v_row.incident_key, 'recovered', v_row.recover_at);
            perform private.uptime_enqueue(
              private.uptime_message('recovered', null, null, v_row.recover_at, v_row.opened_at), v_key);
            update private.uptime_events set outcome = 'notified', outbox_dedupe_key = v_key
             where event_id = v_row.recover_event;
            v_key := null;
          else
            update private.uptime_events set outcome = 'recorded' where event_id = v_row.recover_event;
          end if;
          v_row := null;
        end if;
        if v_row.id is not null then
          -- معرّف جديد لنفس الانقطاع. وإن جاء بعد تعافٍ لم يُؤكَّد فهو دليل أن الهدف ما زال/عاد واقفاً:
          -- يُلغى التعافي المعلّق ويستمر الانقطاع نفسه (لا حادثة ثانية ولا تنبيه ثانٍ ولا تعافٍ كاذب).
          update private.uptime_incidents set aliases = array_append(aliases, v_inc) where id = v_row.id;
          if v_at > v_row.recover_at then
            perform private.uptime_cancel_recovery(v_row.id);
          end if;
          v_outcome := 'suppressed:same-outage';
        else
          insert into private.uptime_incidents (target, incident_key, opened_at)
          values (v_target, v_inc, v_at) returning * into v_row;
          if v_alertable and v_cfg.notify_enabled then
            v_key := 'uptime:' || v_id;
            perform private.uptime_enqueue(private.uptime_message('down', null, v_detail, v_at, v_at), v_key);
            update private.uptime_incidents set down_notified = true where id = v_row.id;
            v_outcome := 'notified';
          end if;
        end if;
      end if;

    elsif v_type = 'reminder' then
      select * into v_row from private.uptime_incidents
       where (incident_key = v_inc or v_inc = any (aliases)) and closed_at is null for update;
      if v_row.id is not null and v_row.recover_at is not null and v_at > v_row.recover_at then
        -- تذكير أحدث من التعافي المعلّق: الـWorker ما زال يرى الانقطاع نفسه ⇒ التعافي لم يحدث
        perform private.uptime_cancel_recovery(v_row.id);
      end if;
      if v_row.id is null then
        v_outcome := 'suppressed:no-open-incident';
      elsif v_label = any (v_row.reminders) then
        v_outcome := 'suppressed:reminder-sent';
      else
        update private.uptime_incidents set reminders = array_append(reminders, v_label) where id = v_row.id;
        if v_alertable and v_cfg.notify_enabled and v_row.down_notified then
          v_key := 'uptime:' || v_id;
          perform private.uptime_enqueue(private.uptime_message('reminder', v_label, null, v_at, v_row.opened_at), v_key);
          v_outcome := 'notified';
        end if;
      end if;

    else -- recovered: يخصّ الحادثة المفتوحة للهدف أيّاً كان معرّفها (الانقطاع واحد)، لكنه لا يُغلقها فوراً.
      -- تشغيلان متداخلان لنفس الدقيقة قد يختلف فحصهما: أحدهما يرسل recovered والآخر يبقى DOWN، وKV يحفظ
      -- آخر كاتب. فالحدث يُسجَّل تعافياً معلّقاً، ويُغلق ويُبلَّغ فقط حين يؤكده تشغيل أحدث تماماً (٤أ).
      select * into v_row from private.uptime_incidents where target = v_target and closed_at is null for update;
      if v_row.id is null then
        v_outcome := 'suppressed:no-open-incident';
      elsif v_at < v_row.opened_at
         or (v_inc <> v_row.incident_key and not v_inc = any (v_row.aliases)
             and exists (select 1 from private.uptime_incidents x where x.incident_key = v_inc or v_inc = any (x.aliases))) then
        -- تعافٍ قديم لانقطاع سابق (إعادة إرسال متأخرة) لا يمسّ حادثة أحدث
        v_row := null;
        v_outcome := 'suppressed:stale-recovery';
      elsif v_row.recover_at is not null then
        v_outcome := 'suppressed:recovery-pending';
      else
        update private.uptime_incidents set recover_at = v_at, recover_event = v_id where id = v_row.id;
        v_outcome := 'recovery-pending';
      end if;
    end if;

    update private.uptime_events
       set outcome = v_outcome, canonical_incident = v_row.id, outbox_dedupe_key = v_key
     where event_id = v_id;
    v_results := v_results || jsonb_build_object('id', v_id, 'outcome', v_outcome);
  end loop;

  -- ٤أ) حالة كل هدف كما رآها الـWorker في هذا التشغيل (targets):
  --   * DOWN/RECOVERING = الـWorker يحمل حادثة. بعد تعافٍ معلّق (scheduledTime > recover_at) يُلغيه «اعتراض الشقيق»
  --     بأي ترتيب وصول — حتى طلب أقدم أو تشغيل مكرر لنفس الدقيقة وصل بعد غيره (الإلغاء آمن: يؤخر التعافي فقط).
  --     وبلا حادثة مفتوحة إطلاقاً للهدف = الخادم أغلق ما يحمله الـWorker (لا يحدث إلا بشذوذ KV مركّب)
  --     ⇒ تُعاد فتح آخر حادثة برسالة تصحيح، فتستمر تذكيراتها ولا يبقى صمت.
  --   * UP، من طلب أحدث تماماً من آخر طلب مقبول فقط:
  --       - بلا تعافٍ معلّق والحادثة مفتوحة (ضياع حالة KV قبل إرسال recovered) ⇒ تعافٍ معلّق من النبض.
  --       - تعافٍ معلّق بلا دورة مرشّحة ⇒ هذه الدورة مرشّحة (confirm_tick). شقيقها لنفس الدقيقة يصل خلال ثوانٍ،
  --         فإن قال DOWN/RECOVERING ألغى قبل الدورة التالية.
  --       - دورة أحدث من المرشّحة بلا اعتراض ⇒ إغلاق ذرّي مشروط (closed_at = recover_at) ورسالة تعافٍ واحدة.
  --   * SUSPECT = الـWorker بلا حادثة ولم يثبت التعافي: لا قرار.
  if v_sched is not null then
    for v_target, v_tstatus in select t.key, t.value from jsonb_each_text(coalesce(j -> 'targets', '{}'::jsonb)) t loop
      perform pg_advisory_xact_lock(hashtext('ozk-uptime:' || v_target));
      select * into v_row from private.uptime_incidents
       where target = v_target and closed_at is null and opened_at <= v_sched for update;

      if v_tstatus in ('DOWN', 'RECOVERING') then
        if v_row.id is not null then
          if v_sched > v_row.recover_at then perform private.uptime_cancel_recovery(v_row.id); end if;
        elsif not exists (select 1 from private.uptime_incidents where target = v_target and closed_at is null) then
          select * into v_row from private.uptime_incidents where target = v_target order by id desc limit 1 for update;
          if v_row.id is not null and v_row.closed_at < v_sched then
            update private.uptime_incidents
               set closed_at = null, recover_at = null, recover_event = null, confirm_tick = null, reopened = reopened + 1
             where id = v_row.id;
            if v_target = 'site' and v_cfg.notify_enabled and v_row.down_notified then
              perform private.uptime_enqueue(
                '⚠️ تصحيح: الموقع ما زال لا يستجيب' || chr(10) ||
                'رسالة التعافي السابقة لم تتأكد؛ الانقطاع مستمر' || chr(10) ||
                'منذ: ' || to_char(v_row.opened_at at time zone 'Asia/Damascus', 'YYYY-MM-DD HH24:MI') || ' (دمشق)' || chr(10) ||
                'المصدر: مراقب Cloudflare (ozk-uptime)',
                private.uptime_close_key(v_row.incident_key, 'reopened', v_row.closed_at));
            end if;
          end if;
        end if;
        continue;
      end if;

      continue when v_tstatus <> 'UP' or v_row.id is null or not (v_prev_sched is null or v_sched > v_prev_sched);
      if v_row.recover_at is null then
        update private.uptime_incidents set recover_at = v_sched, recover_event = null, confirm_tick = null where id = v_row.id;
      elsif v_sched <= v_row.recover_at then
        null;
      elsif v_row.confirm_tick is null then
        update private.uptime_incidents set confirm_tick = v_sched where id = v_row.id;
      elsif v_sched > v_row.confirm_tick then
        update private.uptime_incidents set closed_at = v_row.recover_at
         where id = v_row.id and closed_at is null and recover_at = v_row.recover_at and confirm_tick = v_row.confirm_tick;
        if v_target = 'site' and v_cfg.notify_enabled and v_row.down_notified then
          v_key := private.uptime_close_key(v_row.incident_key, 'recovered', v_row.recover_at);
          perform private.uptime_enqueue(
            private.uptime_message('recovered', null, null, v_row.recover_at, v_row.opened_at), v_key);
          update private.uptime_events set outcome = 'notified', outbox_dedupe_key = v_key
           where event_id = v_row.recover_event;
        else
          update private.uptime_events set outcome = 'recorded' where event_id = v_row.recover_event;
        end if;
      end if;
    end loop;
  end if;

  -- ٤ب) ترقية حادثة فُتحت أثناء الظل: إن فُعّل الإرسال والحادثة ما زالت مفتوحة بلا تنبيه، يُرسل تنبيه
  --     الانقطاع الآن (مرة واحدة، بنفس مفتاح down الأصلي)؛ وإلا تُكتم تذكيراتها وتعافيها فيضيع أول انقطاع بعد التفعيل.
  if v_cfg.notify_enabled then
    perform pg_advisory_xact_lock(hashtext('ozk-uptime:site'));
    for v_row in
      select * from private.uptime_incidents
       where target = 'site' and closed_at is null and not down_notified and recover_at is null
       for update
    loop
      v_key := 'uptime:' || v_row.incident_key || ':down';
      select ev.detail into v_detail from private.uptime_events ev
       where ev.event_id = v_row.incident_key || ':down';
      perform private.uptime_enqueue(private.uptime_message('down', null, v_detail, v_row.opened_at, v_row.opened_at), v_key);
      update private.uptime_incidents set down_notified = true where id = v_row.id;
      update private.uptime_events set outbox_dedupe_key = v_key
       where event_id = v_row.incident_key || ':down' and outbox_dedupe_key is null;
    end loop;
  end if;

  -- ٥) تنظيف محدود (nonce يكفيه يوم لأن النافذة 300 ثانية؛ السجل 90 يوماً > تنظيف outbox 14 يوماً)
  delete from private.uptime_ingest_nonces where received_at < now() - interval '1 day';
  delete from private.uptime_events where received_at < now() - interval '90 days';
  delete from private.uptime_incidents where closed_at < now() - interval '90 days';

  return jsonb_build_object('ok', true, 'results', v_results, 'notify', v_cfg.notify_enabled);
end;
$$;
revoke all on function public.uptime_ingest(text, text) from public, authenticated;
-- الـWorker يتصل بالمفتاح العام (دور anon)؛ الحماية بالتوقيع لا بالدور. لا service_role في Cloudflare.
grant execute on function public.uptime_ingest(text, text) to anon, service_role;

-- ── مراقب توقف الـWorker (غير مجدول هنا؛ الجدولة مرحلة لاحقة بموافقة) ─────────────────────────
-- تنبيه واحد لكل توقف (مفتاحه قيمة last_received_at)، ورسالة تعافٍ واحدة عند عودة النبض.
create or replace function public.watch_uptime_heartbeat()
returns text
language plpgsql security definer set search_path = pg_catalog, public, private
as $$
declare v_cfg private.uptime_config; hb private.uptime_heartbeat; v_stale boolean;
begin
  select * into v_cfg from private.uptime_config where id = 1;
  if v_cfg.id is null or not v_cfg.watchdog_enabled then return 'disabled'; end if;
  if not exists (select 1 from public.app_secrets where name = 'uptime_ingest_hmac' and length(coalesce(value, '')) >= 32) then
    return 'disabled';
  end if;
  select * into hb from private.uptime_heartbeat where id = 1 for update;
  if hb.id is null then return 'no-heartbeat-yet'; end if;
  v_stale := hb.last_received_at < now() - make_interval(mins => v_cfg.stale_minutes);
  if v_stale then
    if hb.stale_alerted_for is distinct from hb.last_received_at then
      perform private.uptime_enqueue(
        '🚨 مراقب الموقع متوقف' || chr(10) ||
        'لم يصل نبض من ozk-uptime منذ أكثر من ' || v_cfg.stale_minutes || ' دقيقة' || chr(10) ||
        'آخر نبض: ' || to_char(hb.last_received_at at time zone 'Asia/Damascus', 'YYYY-MM-DD HH24:MI') || ' (دمشق)' || chr(10) ||
        'فحص GitHub الدوري يبقى احتياطياً',
        'uptime:watchdog:stale:' || floor(extract(epoch from hb.last_received_at))::bigint);
      update private.uptime_heartbeat set stale_alerted_for = hb.last_received_at where id = 1;
      return 'stale-alerted';
    end if;
    return 'stale';
  end if;
  if hb.stale_alerted_for is not null then
    perform private.uptime_enqueue(
      '✅ عاد مراقب الموقع للعمل' || chr(10) ||
      'آخر نبض: ' || to_char(hb.last_received_at at time zone 'Asia/Damascus', 'YYYY-MM-DD HH24:MI') || ' (دمشق)',
      'uptime:watchdog:recovered:' || floor(extract(epoch from hb.stale_alerted_for))::bigint);
    update private.uptime_heartbeat set stale_alerted_for = null where id = 1;
    return 'recovered';
  end if;
  return 'ok';
end;
$$;
revoke all on function public.watch_uptime_heartbeat() from public, anon, authenticated;
grant execute on function public.watch_uptime_heartbeat() to service_role;

notify pgrst, 'reload schema';
