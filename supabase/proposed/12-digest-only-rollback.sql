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
  -- سقف 5 أعطال لكل تراجع (الأحدث رصداً أولاً) كي لا يتدفّق سيل رسائل دفعة واحدة؛ والباقي
  -- يُبلَّغ عنه بتحذير ويُعالَج يدوياً.
  update private.project_task_health_state
     set last_alert_at = null, last_alerted_terminal_at = null,
         last_alerted_health = null, last_alerted_health_since = null
   where task_key in (select task_key from private.project_task_health_state
                       where task_key like 'cron:%' and is_healthy = false
                       order by last_observed_at desc nulls last limit 5);
  if (select count(*) from private.project_task_health_state where task_key like 'cron:%' and is_healthy = false) > 5 then
    raise warning 'rollback: more than 5 unhealthy cron jobs; only the 5 most recent will be re-alerted';
  end if;
  delete from private.digest_bundle_snapshot;
end $rb$;
