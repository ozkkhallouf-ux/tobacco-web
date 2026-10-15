-- proposed/12-digest-only-rollback.sql
--
-- يعيد send_evening_report وmonitor_project_tasks إلى التعريفين المحفوظين في لقطة الحزمة
-- (private.digest_bundle_snapshot) في معاملة واحدة. **تنبيه**: بعد التراجع يعود المراقب إلى
-- سلوك 09 (رسائل «🚨 توقفت مهمة بالمشروع» المنفصلة)، وهو سيل الضجيج الذي أُنشئت السياسة لإيقافه؛
-- وتُترك الجداول/الدوال الجديدة (غير ضارة). لا يلمس notify_telegram ولا أي بيانات.
-- يُشغَّل كطلب واحد (معاملة ضمنية) أو psql --single-transaction.
do $rb$
declare r record; n int; body text; ev text;
  anchor constant text := $a$perform public.notify_telegram('evening_report', msg, 'evening:' || today, 720);$a$;
  addition constant text := $b$begin
    msg := msg || chr(10) || chr(10) || coalesce(private.daily_open_faults_section(now(), greatest(3900 - length(msg) - 2, 200)), '');
  exception when others then
    msg := msg || chr(10) || chr(10) || '🛠 حالة الأنظمة والأعطال' || chr(10) || '⚠️ تعذّر إعداد هذا القسم.';
  end;
  $b$;
  patched constant text := addition || anchor;
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
  -- لا نكتب فوق تعديل إنتاجي لاحق: المراقب والتقرير يجب أن يطابقا نسخة الحزمة 12 بالضبط
  ev := pg_get_functiondef(to_regprocedure('public.send_evening_report()'));
  if md5((select prosrc from pg_proc where oid = to_regprocedure('private.monitor_project_tasks()'))) <> 'fcaf57ebe99fd132762a426ffd4873e9'
     or (length(ev) - length(replace(ev, patched, ''))) / length(patched) <> 1 then
    raise exception 'rollback 12: monitor_project_tasks/send_evening_report drifted from the bundle-12 definitions; refusing to overwrite later changes';
  end if;
  -- القسم الذي سيُزال هو القارئ الوحيد للأعطال المسجَّلة: ما بقي مفتوحاً منها يُرسَل مرة واحدة موحَّداً
  select count(*), string_agg('• ' || left(label, 120), chr(10) order by first_seen_at)
    into n, body from private.ops_events where resolved_at is null and source <> 'cron';
  if n > 0 then
    insert into public.telegram_outbox (event_type, message, dedupe_key)
    values ('ops_rollback_drain',
            left('⚠️ أعطال مفتوحة عند إلغاء الملخص اليومي (' || n || ') — تُرسَل هذه المرة فقط:' || chr(10) || body, 3900),
            'rollback12-drain:' || to_char(now(), 'YYYY-MM-DD"T"HH24'));
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
