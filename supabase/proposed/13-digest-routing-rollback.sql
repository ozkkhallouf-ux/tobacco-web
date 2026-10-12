-- proposed/13-digest-routing-rollback.sql — يعيد الدوال الثلاث إلى لقطتها ويزيل الإضافات.
-- لا يلمس public.notify_telegram ولا بيانات ops_events (الأعطال المفتوحة تبقى ويقرؤها القسم).
-- التنبيهات غير الحرجة تعود فورية كما كانت قبل 13 (دون فيضان: لا يُعاد إرسال شيء مسجَّل).
do $rb$
declare r record;
begin
  if to_regclass('private.digest_routing_snapshot') is null then
    raise exception 'rollback 13: no snapshot table; nothing to restore (13 not applied?)';
  end if;
  for r in select fn, def from private.digest_routing_snapshot loop
    execute r.def;
  end loop;
  -- لقطة نظيفة: بدون هذا السطر يصبح التراجع بلا أثر إن كانت اللقطة ناقصة
  if position('digest-routing:v1' in (select prosrc from pg_proc
        where oid = to_regprocedure('private.notify_telegram_dispatch(text,text,text,integer,jsonb)'))) > 0 then
    raise exception 'rollback 13: dispatch still contains the routing hook (snapshot missing?)';
  end if;
  drop function if exists private.absorb_digest_alert(text,text,text);
  drop function if exists private.ops_event_silence(text);
  drop table private.digest_routing_snapshot;
end $rb$;
