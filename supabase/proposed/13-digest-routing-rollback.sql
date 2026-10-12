-- proposed/13-digest-routing-rollback.sql — يعيد الدوال الثلاث إلى لقطتها ويزيل الإضافات.
-- لا يلمس public.notify_telegram ولا بيانات ops_events (الأعطال المفتوحة تبقى ويقرؤها القسم).
-- التنبيهات غير الحرجة تعود فورية كما كانت قبل 13 (دون فيضان: لا يُعاد إرسال شيء مسجَّل).
do $rb$
declare r record; n int; body text;
begin
  if to_regclass('private.digest_routing_snapshot') is null then
    raise exception 'rollback 13: no snapshot table; nothing to restore (13 not applied?)';
  end if;
  -- لا نكتب فوق تعديل لاحق: الدوال الثلاث يجب أن تطابق جسم 13 بالضبط (وإلا يُوقَف التراجع ويُراجَع يدوياً)
  if md5((select prosrc from pg_proc where oid = to_regprocedure('private.notify_telegram_dispatch(text,text,text,integer,jsonb)'))) <> 'f7bee114d77cecea3bf9fceceb24425a'
     or md5((select prosrc from pg_proc where oid = to_regprocedure('private.ops_event_route(text,text)'))) <> 'f34f129268ee375c10006f004de2d00e'
     or md5((select prosrc from pg_proc where oid = to_regprocedure('private.close_stale_ops_events(timestamptz,interval)'))) <> '2c92ab4fdc95ce1696cb4d69920569c7'
     or md5((select prosrc from pg_proc where oid = to_regprocedure('private.ops_event_silence(text)'))) is distinct from '2796ac5d112c557951d8fd3c837de6f7'
     or md5((select prosrc from pg_proc where oid = to_regprocedure('private.absorb_digest_alert(text,text,text)'))) is distinct from 'b5b3a7d5f34083664813d25e96a043e8'
     or md5((select prosrc from pg_proc where oid = to_regprocedure('private.refine_immediate_alert(text,text,text)'))) is distinct from 'b62dddfef4aff64199722e5e1e5d57be' then
    raise exception 'rollback 13: a routed function drifted from the proposed/13 body; refusing to overwrite later changes';
  end if;
  -- RPC دورة الحياة: إن تغيّر جسمها بعد 13 يُوقَف التراجع (لا إسقاط عمل لاحق بصمت)
  if to_regprocedure('public.health_lifecycle(text,text,integer,text)') is not null
     and md5((select prosrc from pg_proc where oid = to_regprocedure('public.health_lifecycle(text,text,integer,text)'))) is distinct from '1cd6b62f9474327d3d32e0b993c548c4' then
    raise exception 'rollback 13: public.health_lifecycle drifted from the proposed/13 body; refusing to drop later changes';
  end if;
  for r in select fn, def from private.digest_routing_snapshot loop
    execute r.def;
  end loop;
  -- لقطة نظيفة: بدون هذا السطر يصبح التراجع بلا أثر إن كانت اللقطة ناقصة
  if position('digest-routing:v1' in (select prosrc from pg_proc
        where oid = to_regprocedure('private.notify_telegram_dispatch(text,text,text,integer,jsonb)'))) > 0 then
    raise exception 'rollback 13: dispatch still contains the routing hook (snapshot missing?)';
  end if;
  -- الأعطال المفتوحة التي امتصّها 13 لن تجد بعد التراجع مَن يعرضها في الوقت المناسب (نافذة الصمت تعود 6 ساعات
  -- فتُغلَق حوادث الإنذار الواحد قبل التقرير): تُرسَل مرة واحدة فقط في رسالة موحَّدة واحدة (لا فيضان).
  select count(*), string_agg('• ' || left(label, 120), chr(10) order by first_seen_at)
    into n, body from private.ops_events where resolved_at is null and source = 'telegram';
  if n > 0 then
    insert into public.telegram_outbox (event_type, message, dedupe_key)
    values ('ops_rollback_drain',
            left('⚠️ أعطال مفتوحة عند إلغاء التوجيه إلى الملخص (' || n || ') — تُرسَل هذه المرة فقط:' || chr(10) || body, 3900),
            'rollback13-drain:' || to_char(now(), 'YYYY-MM-DD"T"HH24'));
  end if;
  -- أُسقطت الـRPC أولاً: السكربت يعود تلقائياً إلى الوضع القديم (PGRST202 مؤكَّداً) بلا فيضان ولا إطفاء متغيّر
  drop function if exists public.health_lifecycle(text, text, integer, text);
  drop function if exists private.absorb_digest_alert(text,text,text);
  drop function if exists private.refine_immediate_alert(text,text,text);
  drop function if exists private.ops_event_silence(text);
  drop table private.digest_routing_snapshot;
end $rb$;
