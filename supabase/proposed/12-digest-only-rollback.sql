-- proposed/12-digest-only-rollback.sql
--
-- يعيد send_evening_report وmonitor_project_tasks إلى التعريفين المحفوظين في لقطة الحزمة
-- (private.digest_bundle_snapshot) في معاملة واحدة. **تنبيه**: بعد التراجع يعود المراقب إلى
-- سلوك 09 (رسائل «🚨 توقفت مهمة بالمشروع» المنفصلة)، وهو سيل الضجيج الذي أُنشئت السياسة لإيقافه؛
-- وتُترك الجداول/الدوال الجديدة (غير ضارة). لا يلمس notify_telegram ولا أي بيانات.
-- يُشغَّل كطلب واحد (معاملة ضمنية) أو psql --single-transaction.
do $rb$
declare r record;
begin
  -- 13 يمتصّ التنبيهات في ops_events ويعتمد على قسم الأعطال؛ إزالة القسم قبل 13 تُصمت الأعطال
  if to_regclass('private.digest_routing_snapshot') is not null then
    raise exception 'rollback 12 refused: proposed/13 is active; run 13-digest-routing-rollback.sql first';
  end if;
  if to_regclass('private.digest_bundle_snapshot') is null then
    raise exception 'rollback: no snapshot table; apply proposed/09 and migration 20260926234241 manually';
  end if;
  if (select count(*) from private.digest_bundle_snapshot) = 0 then
    raise exception 'rollback: snapshot is empty; nothing to restore';
  end if;
  for r in select fn, def from private.digest_bundle_snapshot order by fn loop
    execute r.def;
  end loop;
  drop function if exists private.check_evening_report_delivered(timestamptz);
  -- أثناء الحزمة تتقدّم حقول «أُنذر» لأعطال cron دون إرسال Telegram؛ لو بقيت لظلّ مراقب 09
  -- المستعاد صامتاً عن عطل قائم. تُصفَّر لتُنذَر الأعطال القائمة مرة واحدة بعد التراجع.
  -- كل عطل cron قائم يُنذَر مرة واحدة (رسالة لكل مهمة فاشلة فعلاً، مفتاح dedupe ثابت)؛ لا سقف،
  -- لأن أي عطل متروك بلا تصفير يصير صامتاً تماماً بعد التراجع (التقرير بلا قسم الأعطال).
  update private.project_task_health_state
     set last_alert_at = null, last_alerted_terminal_at = null,
         last_alerted_health = null, last_alerted_health_since = null
   where task_key like 'cron:%' and is_healthy = false;
  delete from private.digest_bundle_snapshot;
end $rb$;
