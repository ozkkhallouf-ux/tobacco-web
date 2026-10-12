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
  delete from private.digest_bundle_snapshot;
end $rb$;
