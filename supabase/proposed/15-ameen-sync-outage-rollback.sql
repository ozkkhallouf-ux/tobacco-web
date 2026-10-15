-- proposed/15-ameen-sync-outage-rollback.sql
--
-- يعيد private.notify_telegram_dispatch (جسم 13) وprivate.daily_open_faults_section (جسم 12) من لقطة 15،
-- ويلغي مهمة sync-outage-tick، ويُسقط دوال 15. **يُبقي جداول الحوادث** (سجل تدقيق، غير ضارة).
-- يجب تشغيله قبل 13-digest-routing-rollback.sql (الذي يرفض العمل ما دام خطّاف 15 في dispatch).
-- بعده: انقطاع الأمين لا يُرسل أي إنذار فوري (سلوك 12)، وتقادم المخزون يعود فورياً مستقلاً.
-- يُشغَّل كطلب واحد (معاملة ضمنية) أو psql --single-transaction.
do $rb$
declare r record; n int; body text;
begin
  if to_regclass('private.sync_outage_snapshot') is null then
    raise exception 'rollback 15: no snapshot table; nothing to restore (15 not applied?)';
  end if;
  if (select count(*) from private.sync_outage_snapshot) <> 2 then
    raise exception 'rollback 15: snapshot incomplete; restore manually';
  end if;
  -- لا نكتب فوق تعديل لاحق: الدالتان يجب أن تطابقا جسم 15 بالضبط
  if md5((select prosrc from pg_proc where oid = to_regprocedure('private.notify_telegram_dispatch(text,text,text,integer,jsonb)'))) <> 'c35b5c198c2b10b3901471bf5b1cbec1'
     or md5((select prosrc from pg_proc where oid = to_regprocedure('private.daily_open_faults_section(timestamptz,integer)'))) <> 'd5bb80ca095984e779928b57ab1f3a95' then
    raise exception 'rollback 15: dispatch/section drifted from the proposed/15 bodies; refusing to overwrite later changes';
  end if;
  -- انقطاع مستمر لم يُنذر عنه بعد: بعد التراجع لا شيء يُنذر عنه (12 لا يُرسل للمهام). رسالة واحدة الآن فقط.
  select count(*), string_agg('• ' || c.label || ' منذ ' || to_char(o.started_at at time zone 'Asia/Damascus', 'YYYY-MM-DD HH24:MI'), chr(10))
    into n, body
    from private.sync_outage_incidents o join private.sync_outage_config c on c.device = o.device
   where o.ended_at is null and o.alerted_at is null;
  if n > 0 then
    insert into public.telegram_outbox (event_type, message, dedupe_key)
    values ('ops_rollback_drain',
            left('⚠️ انقطاع مزامنة مستمر عند إلغاء تجميع الانقطاع (' || n || ') — يُرسَل هذه المرة فقط:' || chr(10) || body, 3900),
            'rollback15-drain:' || to_char(now(), 'YYYY-MM-DD"T"HH24'));
  end if;
  for r in select fn, def from private.sync_outage_snapshot order by fn loop
    execute r.def;
  end loop;
  if position('ameen-outage:v1' in (select prosrc from pg_proc
        where oid = to_regprocedure('private.notify_telegram_dispatch(text,text,text,integer,jsonb)'))) > 0
     or position('sync-outage-section:v1' in (select prosrc from pg_proc
        where oid = to_regprocedure('private.daily_open_faults_section(timestamptz,integer)'))) > 0 then
    raise exception 'rollback 15: a restored function still carries the proposed/15 tag (snapshot wrong?)';
  end if;
  if exists (select 1 from cron.job where jobname = 'sync-outage-tick') then
    perform cron.unschedule('sync-outage-tick');
  end if;
  drop function if exists private.sync_outage_absorb_stock_stale(text,text);
  drop function if exists private.sync_outage_tick(timestamptz);
  drop function if exists private.sync_outage_step(text,timestamptz,boolean);
  drop function if exists private.sync_outage_message(bigint,timestamptz);
  drop function if exists private.sync_outage_observe(text,timestamptz);
  drop function if exists private.sync_outage_in_business(timestamptz,time,time,text);
  drop function if exists private.sync_outage_business_minutes(timestamptz,timestamptz,time,time,text);
  drop function if exists private.ops_fmt_time(timestamptz,timestamptz);
  drop function if exists private.ops_fmt_duration(numeric);
  drop function if exists private.ops_fmt_iso(text);
  drop table private.sync_outage_snapshot;
end $rb$;
