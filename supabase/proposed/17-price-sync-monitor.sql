-- proposed/17-price-sync-monitor.sql
--
-- **غير مطبَّق على الإنتاج ويتطلب موافقة المالك الصريحة.** يُنشئ مهمة cron جديدة ويعطّل صف المراقب
-- القديم «price-sync» (راجع «منع التكرار» أدناه). **يتطلب 12 ثم 13 ثم 15 مطبَّقة فعلاً** (راجع «ترتيب التطبيق»).
--
-- OZK Price Sync Protection — المرحلة الثالثة: مراقبة مستقلة على Supabase لمزامنة الأسعار
-- (الموقع ← الأمين)، تعمل حتى لو كان OZK2026 مطفأً أو بلا إنترنت، وتنبّه في تيليغرام مرة واحدة
-- عند بداية الحادثة ومرة واحدة عند التعافي.
--
-- المصدر الوحيد: public.price_sync_heartbeats (proposed/16، مطبَّقة 2026-10-18). كل الأزمنة من ساعة
-- الخادم (received_at وnow())، لا من طوابع العميل. العرض بتوقيت دمشق.
--
-- نوعان من الأدلة في المحاولات:
--   * نجاح مثبت (proven): applied أو no_changes — الدالة 16 لا تقبلهما بلا إثبات وصول الأسعار للأمين.
--   * وصول حيّ (alive): المثبت + applied_with_conflicts — المزامنة وصلت الأمين وطبّقت، لكن بعض الأصناف
--     تعارضت أو غير موجودة فيه. يثبت أن المزامنة لم تنقطع كلياً، ولا يثبت سلامتها.
--
-- الحالات (private.price_sync_monitor_assess):
--   DISABLED  أحدث فحص مهمة (≤ 45 د) يقول إن «TOBACCO Approved Prices Pull» معطّلة أو غير مسجّلة،
--             **ولم يصل بعده وصول حيّ**. وصول حيّ أحدث من الفحص دليل أن المهمة عادت تعمل (لا انتظار
--             للفحص التالي)؛ ومحاولة فاشلة بعده لا تُسقطه؛ وفحص «معطّلة» أحدث من آخر نجاح يغلب دائماً.
--   UNKNOWN   لا أي محاولة مزامنة في الجدول. غياب البيانات مشكلة، لا نجاح.
--   STALE     لا وصول حيّ منذ أكثر من 15 د ولا محاولة حديثة: المهمة لا تعمل أو الجهاز مطفأ أو بلا
--             إنترنت أو DNS. نجاح قديم ليس دليلاً على السلامة.
--   FAILED    لا وصول حيّ منذ أكثر من 15 د رغم وصول محاولات حديثة، أو فشل محاولتين متتاليتين
--             (اكتشاف مبكر عند الدورة الثانية، نحو 10 د). فشل عابر واحد ثم نجاح لا يفتح حادثة.
--   PARTIAL   مشكلة جزئية: آخر وصول حيّ كان applied_with_conflicts (تعارض أو أصناف غير موجودة في الأمين).
--             المزامنة تعمل، لكنها ليست سليمة: **لا تُعلن HEALTHY أبداً**. تُفتح حادثتها (منفصلة عن الانقطاع
--             الكلي) بعد محاولتين جزئيتين متتاليتين، كي لا يُنبَّه عن تعارض عابر.
--   HEALTHY   آخر وصول حيّ نجاح مثبت خلال 15 د، وليس ضمن فشلين متتاليين.
--
-- دورة الحادثة (private.price_sync_monitor_tick، cron كل دقيقة):
--   * نوعان من الحوادث: «outage» (STALE/FAILED/DISABLED/UNKNOWN) و«partial» (PARTIAL)، وحادثة واحدة مفتوحة
--     على الأكثر (فهرس فريد جزئي). كل انتقال رسالة واحدة:
--       لا حادثة ← انقطاع: 🔴 «توقف/فشل مزامنة الأسعار».
--       لا حادثة ← جزئي مؤكَّد: 🟠 «تعارض في مزامنة الأسعار».
--       انقطاع ← جزئي مؤكَّد: 🟠 «عادت مزامنة الأسعار جزئياً» (تُغلق الانقطاع وتفتح الجزئية برسالة واحدة).
--       جزئي ← انقطاع: 🔴 الانقطاع (تُغلق الجزئية بصمت).
--       أي حادثة ← نجاح مثبت حديث: 🟢 التعافي، فقط إن كانت الحادثة قد أُعلنت. لا تعافٍ بلا حادثة مفتوحة.
--     ولا تكرار ما دامت الحادثة مفتوحة مهما تغيّرت حالتها الفرعية (STALE ← DISABLED…).
--   * التعافي: آخر محاولة نفسها نجاح مثبت خلال 15 د، ولا فحص «معطّلة» أحدث منها.
--   * أول تشغيل خط أساس: عطل قائم لحظة التفعيل يُفتح صامتاً (لا يُعدّ التاريخ حادثة جديدة)، ثم يُنبَّه
--     مرة واحدة إن بقي 30 د بعد التفعيل.
--   * قفل استشاري + قفل صف الحالة + الفهرس الفريد: تشغيلان متزامنان لا يرسلان مرتين.
--   * فشل إدراج رسالة تيليغرام يُفشل الدورة كلها (لا تُلتقط الاستثناءات)، فتُرجَع الحالة وتُعاد المحاولة
--     في الدقيقة التالية دون ضياع التنبيه. وتكرار فشل الدورة تكشفه مراقبة cron القائمة في
--     private.monitor_project_tasks (cron:price-sync-monitor) — فشل المراقب منفصل عن فشل المزامنة.
--   * مفتاح dedupe لكل حادثة: «price-sync-outage|price-sync-partial:<incident_key UUID>:open|recovered» بنافذة
--     أسبوع. UUID لا معرّف تسلسلي، فلا يصطدم بمفتاح حادثة سابقة بعد تراجع وإعادة تطبيق (Codex P1).
--
-- منع التكرار:
--   * المراقب القائم: private.monitor_project_tasks يراقب «price-sync» من ameen_price_sync_status (يُكتب
--     بعد النجاح فقط) بحد 30 د ويعيد التنبيه كل 60 د. هذا الملف يعطّل ذلك الصف (enabled=false) لأن المراقب
--     الجديد يحل محله، ولا يمسّ دالة monitor_project_tasks ولا بقية المهام.
--   * تنبيهات Windows من OZK2026 نفسه (بلا تعديل Windows): حين تُفتح حادثة FAILED وسببها له تنبيه Windows
--     مطابق في telegram_outbox خلال آخر 30 د ومنذ آخر وصول حيّ (سلسلة الفشل الحالية وحدها) (pull_failed ↔ winfail:pull-approved-prices، ameen_unreachable/
--     apply_failed ↔ winfail:apply-to-ameen، verify_mismatch ↔ price-sync:mismatch*، verify_failed ↔
--     price-sync:verify-failed) تُعدّ الحادثة مُعلنة بذلك التنبيه (announced_by='windows') فلا رسالة فتح ثانية،
--     وتبقى رسالة التعافي الواحدة. STALE/DISABLED/UNKNOWN لا تُمتص (Windows لا يبلّغ عنها).
--
-- توافق الحزم 12/13/15 (غير مطبَّقة): أنواع الأحداث price_sync_outage/price_sync_partial/price_sync_recovered
-- والمفتاحان «price-sync-outage:»/«price-sync-partial:» لا تطابق قواعد التوجيه إلى الملخص فيهما (sync_failure،
-- ‎^price-sync:، ‎^winfail:) فيبقى التنبيه فورياً. و12/15 تقرآن صفوف project_task_monitors المفعّلة فقط.
--
-- ترتيب التطبيق (قرار المالك 2026-10-20): **17 لا يُطبَّق إلا بعد 12 ثم 13 ثم 15 فعلياً**. الحارس في أول الملف
-- يتحقق من الواقع الحي لا من عدد الهجرات:
--   * 12: private.digest_bundle_snapshot وprivate.ops_events وprivate.project_task_incidents، وجسم
--     private.monitor_project_tasks() = md5 fcaf57eb… (جسم 12 بالضبط).
--   * 13: private.digest_routing_snapshot، وpublic.health_lifecycle = 1cd6b62f…، وprivate.ops_event_route = 7228700c….
--   * 15: private.sync_outage_snapshot، وprivate.notify_telegram_dispatch = c35b5c19… (جسم 15 النهائي)،
--     وprivate.daily_open_faults_section = d5bb80ca…، وprivate.sync_outage_tick = 91e6d4d8…، ومهمة cron
--     sync-outage-tick نشطة.
--   * الترتيب: أول taken_at في لقطة 12 < لقطة 13 < لقطة 15 (كل حزمة تأخذ لقطتها في معاملتها).
--   * سجل الهجرات: إن سُجّلت أيٌّ من الحزم الثلاث في supabase_migrations.schema_migrations (بأسمائها)
--     فيجب أن تُسجَّل الثلاث وبإصدارات تصاعدية 12 < 13 < 15. العدد وحده لا يكفي.
-- البصمات مأخوذة من ملفات 12/13/15 في main نفسها، وscripts/check-price-sync-monitor.mjs يفشل إن انجرفت.
-- ذرّية: كل جملة تنشئ شيئاً داخل كتلة تثبيت واحدة لا تعمل إلا إن نجح الحارس في المعاملة نفسها (إعداد
-- محلي app.price_sync_monitor_17). حارس فاشل لا ينشئ جدولاً ولا دالة ولا مهمة cron، حتى لو نُفِّذ الملف
-- أمراً بأمر (autocommit). بعد 17 يصبح عدد مهام cron 18 (17 بعد 15 + price-sync-monitor). وبعد 13 يذهب فشل
-- cron:price-sync-monitor نفسه (project-cron-failure:*) إلى الملخص المسائي لا فورياً.
--
-- الأمن: الدوال والجداول في private بلا أي منح لـ anon/authenticated/service_role؛ لا يستدعيها إلا
-- cron (postgres). الموظف لا يستطيع فتح حادثة أو إعلان تعافٍ، ولا كتابة نبض (16).
--
-- التراجع: 17-price-sync-monitor-rollback.sql. الاختبار: supabase/tests/price-sync-monitor.sql عبر
-- scripts/check-price-sync-monitor.mjs (PostgreSQL محلي في CI)، ومعه اختبارات الحارس لكل حالة تطبيق جزئي.
-- **طريقة التشغيل**: طلب واحد (apply_migration أو execute_sql) أو psql --single-transaction -v ON_ERROR_STOP=1.

select set_config('app.price_sync_monitor_17', 'on', true);

-- ── الحارس: 16 ثم 12 ثم 13 ثم 15 مطبَّقة فعلاً وبالترتيب — قبل أي تعديل ─────────────────────────
do $guard17$
declare
  v_md5 text;
  t12 timestamptz; t13 timestamptz; t15 timestamptz;
  v12 text; v13 text; v15 text; n12 int; n13 int; n15 int;
begin
  -- تنفيذ أمر بأمر (autocommit) يُسقط الإعداد المحلي أعلاه فيتوقف هنا، وكتلة التثبيت تتوقف كذلك.
  if coalesce(current_setting('app.price_sync_monitor_17', true), '') <> 'on' then
    raise exception 'proposed/17 must run as a single transaction (one request or psql --single-transaction); refusing to apply statement-by-statement';
  end if;

  -- 16 والبنية الأساسية.
  if to_regclass('public.price_sync_heartbeats') is null then
    raise exception 'proposed/17 requires proposed/16 (public.price_sync_heartbeats)';
  end if;
  if to_regprocedure('public.notify_telegram(text,text,text,integer,jsonb)') is null then
    raise exception 'proposed/17 requires public.notify_telegram(text,text,text,integer,jsonb)';
  end if;
  if to_regclass('public.telegram_outbox') is null then
    raise exception 'proposed/17 requires public.telegram_outbox';
  end if;

  -- 12: الحزمة الذرّية للملخص.
  select md5(prosrc) into v_md5 from pg_proc where oid = to_regprocedure('private.monitor_project_tasks()');
  if to_regclass('private.digest_bundle_snapshot') is null or to_regclass('private.ops_events') is null
     or to_regclass('private.project_task_incidents') is null
     or v_md5 is distinct from 'fcaf57ebe99fd132762a426ffd4873e9' then
    raise exception 'proposed/17 requires proposed/12 (digest bundle) to be applied first (monitor_project_tasks md5 %)', coalesce(v_md5, 'missing');
  end if;

  -- 13: توجيه التنبيهات غير الحرجة إلى الملخص.
  if to_regclass('private.digest_routing_snapshot') is null
     or md5((select prosrc from pg_proc where oid = to_regprocedure('public.health_lifecycle(text,text,integer,text)'))) is distinct from '1cd6b62f9474327d3d32e0b993c548c4'
     or md5((select prosrc from pg_proc where oid = to_regprocedure('private.ops_event_route(text,text)'))) is distinct from '7228700c82cfc2948563abfc3d2025d1' then
    raise exception 'proposed/17 requires proposed/13 (digest routing) to be applied after 12';
  end if;

  -- 15: حادثة انقطاع مزامنة الأمين (الجسم النهائي للإرسال).
  select md5(prosrc) into v_md5 from pg_proc where oid = to_regprocedure('private.notify_telegram_dispatch(text,text,text,integer,jsonb)');
  if to_regclass('private.sync_outage_snapshot') is null
     or v_md5 is distinct from 'c35b5c198c2b10b3901471bf5b1cbec1'
     or md5((select prosrc from pg_proc where oid = to_regprocedure('private.daily_open_faults_section(timestamptz,integer)'))) is distinct from 'd5bb80ca095984e779928b57ab1f3a95'
     or md5((select prosrc from pg_proc where oid = to_regprocedure('private.sync_outage_tick(timestamptz)'))) is distinct from '91e6d4d8517fd766f048902d57e1a94e' then
    raise exception 'proposed/17 requires proposed/15 (Ameen sync outage incident) to be applied after 13 (notify_telegram_dispatch md5 %)', coalesce(v_md5, 'missing');
  end if;
  if to_regnamespace('cron') is not null then
    if not exists (select 1 from cron.job where jobname = 'sync-outage-tick' and active) then
      raise exception 'proposed/17 requires proposed/15: cron job sync-outage-tick missing or inactive';
    end if;
  end if;

  -- الترتيب الفعلي: كل حزمة أخذت لقطتها في معاملتها، فالترتيب الزمني للقطات هو ترتيب التطبيق.
  execute 'select min(taken_at) from private.digest_bundle_snapshot' into t12;
  execute 'select min(taken_at) from private.digest_routing_snapshot' into t13;
  execute 'select min(taken_at) from private.sync_outage_snapshot' into t15;
  if t12 is null or t13 is null or t15 is null or not (t12 < t13 and t13 < t15) then
    raise exception 'proposed/17 requires 12, 13, 15 applied in that order (snapshots: 12=%, 13=%, 15=%)', t12, t13, t15;
  end if;

  -- سجل الهجرات: معرّفات وإصدارات لا عدد. إن سُجّلت أيٌّ منها فيجب أن تُسجَّل الثلاث وبترتيب تصاعدي.
  if to_regclass('supabase_migrations.schema_migrations') is not null then
    execute $q$select count(*) filter (where name ~ 'digest_only_atomic_bundle'), max(version) filter (where name ~ 'digest_only_atomic_bundle'),
                      count(*) filter (where name ~ 'digest_routing'), max(version) filter (where name ~ 'digest_routing'),
                      count(*) filter (where name ~ 'ameen_sync_outage'), max(version) filter (where name ~ 'ameen_sync_outage')
                 from supabase_migrations.schema_migrations$q$
      into n12, v12, n13, v13, n15, v15;
    if n12 + n13 + n15 > 0 and not (n12 = 1 and n13 = 1 and n15 = 1 and v12 < v13 and v13 < v15) then
      raise exception 'proposed/17: schema_migrations records 12/13/15 inconsistently (12=% x%, 13=% x%, 15=% x%); expected each once, versions ascending', v12, n12, v13, n13, v15, n15;
    end if;
  end if;

  perform set_config('app.price_sync_monitor_17', 'guard-passed', true);
end
$guard17$;

-- ── التثبيت: لا يعمل إلا إن نجح الحارس في المعاملة نفسها ─────────────────────────────────────
do $install17$
begin
  if coalesce(current_setting('app.price_sync_monitor_17', true), '') <> 'guard-passed' then
    raise exception 'proposed/17: guard did not pass in this transaction; nothing installed';
  end if;

  execute $s01$
create schema if not exists private
$s01$;

  -- ── الإعدادات والحالة ────────────────────────────────────────────────────────────────────────
  execute $s02$
create table if not exists private.price_sync_monitor_config (
  id                        boolean primary key default true check (id),
  stale_after_minutes       integer not null default 15 check (stale_after_minutes between 5 and 240),
  probe_fresh_minutes       integer not null default 45 check (probe_fresh_minutes between 5 and 240),
  early_failure_attempts    integer not null default 2  check (early_failure_attempts between 2 and 10),
  partial_confirm_attempts  integer not null default 2  check (partial_confirm_attempts between 1 and 10),
  baseline_escalate_minutes integer not null default 30 check (baseline_escalate_minutes between 5 and 1440),
  absorb_windows_minutes    integer not null default 30 check (absorb_windows_minutes between 0 and 240),
  device_label              text    not null default 'OZK2026'
)
$s02$;

  execute $s03$
insert into private.price_sync_monitor_config (id) values (true) on conflict (id) do nothing
$s03$;

  execute $s04$
create table if not exists private.price_sync_monitor_state (
  id                boolean primary key default true check (id),
  baseline_at       timestamptz not null,
  last_evaluated_at timestamptz not null,
  last_state        text not null,
  last_reason       text
)
$s04$;

  execute $s05$
create table if not exists private.price_sync_incidents (
  id               bigint generated always as identity primary key,
  -- مفتاح الحادثة في dedupe: UUID لا يتكرر بعد تراجع وإعادة تطبيق (الهوية id تبدأ من 1 من جديد
  -- بينما يبقى telegram_outbox، فيصطدم مفتاح قديم ويُكتم التنبيه — Codex P1).
  incident_key     uuid not null default gen_random_uuid() unique,
  kind             text not null check (kind in ('outage','partial')),
  opened_at        timestamptz not null,
  opened_state     text not null,
  opened_reason    text,
  current_state    text not null,
  current_reason   text,
  last_seen_at     timestamptz not null,
  from_baseline    boolean not null default false,
  alert_sent_at    timestamptz,
  announced_by     text check (announced_by in ('monitor','windows')),
  closed_at        timestamptz,
  recovery_sent_at timestamptz,
  constraint price_sync_incidents_states check (
    opened_state in ('STALE','FAILED','DISABLED','UNKNOWN','PARTIAL')
    and current_state in ('STALE','FAILED','DISABLED','UNKNOWN','PARTIAL')),
  constraint price_sync_incidents_kind_state check (
    (kind = 'partial') = (opened_state = 'PARTIAL'))
)
$s05$;

  execute $s06$
create unique index if not exists price_sync_incidents_one_open
  on private.price_sync_incidents ((true)) where closed_at is null
$s06$;

  execute $s07$
revoke all on table private.price_sync_monitor_config, private.price_sync_monitor_state, private.price_sync_incidents
  from public, anon, authenticated, service_role
$s07$;

  -- ── التصنيف (قراءة فقط) ─────────────────────────────────────────────────────────────────────
  execute $s08$
create or replace function private.price_sync_monitor_assess(p_now timestamptz default now())
returns table (
  state text, reason text,
  last_success_at timestamptz, last_alive_at timestamptz, last_attempt_at timestamptz, last_outcome text,
  consecutive_failures integer, partial_streak integer,
  applied_wholesale integer, applied_retail integer, conflicts integer, not_in_ameen integer,
  probe_at timestamptz, probe_enabled boolean, probe_exists boolean, probe_superseded boolean, host text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  cfg      private.price_sync_monitor_config%rowtype;
  latest   record;
  alive    record;
  probe    record;
  v_stale  interval;
  v_proven text[] := array['applied','no_changes'];
  v_alive  text[] := array['applied','no_changes','applied_with_conflicts'];
begin
  select * into cfg from private.price_sync_monitor_config where id;
  if not found then
    cfg.stale_after_minutes := 15; cfg.probe_fresh_minutes := 45; cfg.early_failure_attempts := 2;
  end if;
  v_stale := pg_catalog.make_interval(mins => cfg.stale_after_minutes);

  select h.received_at, h.outcome, h.summary into latest
    from public.price_sync_heartbeats h
   where h.kind = 'attempt' and h.received_at <= p_now
   order by h.received_at desc, h.id desc limit 1;

  select h.received_at, h.outcome, h.summary into alive
    from public.price_sync_heartbeats h
   where h.kind = 'attempt' and h.outcome = any (v_alive) and h.received_at <= p_now
   order by h.received_at desc, h.id desc limit 1;

  select pg_catalog.max(h.received_at) into last_success_at
    from public.price_sync_heartbeats h
   where h.kind = 'attempt' and h.outcome = any (v_proven) and h.received_at <= p_now;

  last_alive_at := alive.received_at;

  select pg_catalog.count(*)::integer into consecutive_failures
    from public.price_sync_heartbeats h
   where h.kind = 'attempt' and h.received_at <= p_now
     and h.received_at > coalesce(price_sync_monitor_assess.last_alive_at, '-infinity'::timestamptz)
     and not (h.outcome = any (v_alive));

  -- كل وصول حيّ بعد آخر نجاح مثبت هو جزئي بالتعريف.
  select pg_catalog.count(*)::integer into partial_streak
    from public.price_sync_heartbeats h
   where h.kind = 'attempt' and h.outcome = 'applied_with_conflicts' and h.received_at <= p_now
     and h.received_at > coalesce(price_sync_monitor_assess.last_success_at, '-infinity'::timestamptz);

  select h.received_at, h.summary into probe
    from public.price_sync_heartbeats h
   where h.kind = 'task_probe' and h.received_at <= p_now
   order by h.received_at desc, h.id desc limit 1;

  last_attempt_at := latest.received_at;
  last_outcome    := latest.outcome;
  host := coalesce(nullif(latest.summary ->> 'host', ''), nullif(probe.summary ->> 'host', ''));

  -- أعداد آخر وصول حيّ (للرسالة الجزئية ولرسالة التعافي).
  applied_wholesale := case when pg_catalog.jsonb_typeof(alive.summary -> 'applied_wholesale') = 'number' then (alive.summary ->> 'applied_wholesale')::numeric::integer end;
  applied_retail    := case when pg_catalog.jsonb_typeof(alive.summary -> 'applied_retail') = 'number' then (alive.summary ->> 'applied_retail')::numeric::integer end;
  conflicts         := case when pg_catalog.jsonb_typeof(alive.summary -> 'conflict_count') = 'number' then (alive.summary ->> 'conflict_count')::numeric::integer end;
  not_in_ameen      := case when pg_catalog.jsonb_typeof(alive.summary -> 'not_in_ameen') = 'number' then (alive.summary ->> 'not_in_ameen')::numeric::integer end;

  probe_at := probe.received_at;
  probe_enabled := case when pg_catalog.jsonb_typeof(probe.summary -> 'task' -> 'enabled') = 'boolean' then (probe.summary -> 'task' ->> 'enabled')::boolean end;
  probe_exists  := case when pg_catalog.jsonb_typeof(probe.summary -> 'task' -> 'exists') = 'boolean' then (probe.summary -> 'task' ->> 'exists')::boolean end;
  -- وصول حيّ (تطبيق فعلي على الأمين) بعد الفحص يعني أن المهمة اشتغلت ونجحت بعده: الفحص «معطّلة» لم يعد
  -- الدليل الأحدث. محاولة فاشلة بعده لا تُسقطه، كي لا يتحوّل التعطيل إلى HEALTHY بفشل عابر.
  probe_superseded := probe_at is not null and alive.received_at is not null and alive.received_at > probe_at;

  if probe_at is not null and probe_at >= p_now - pg_catalog.make_interval(mins => cfg.probe_fresh_minutes)
     and (probe_exists is false or probe_enabled is false) and not probe_superseded then
    state := 'DISABLED';
    reason := case when probe_exists is false then 'task_missing' else 'task_disabled' end;
  elsif latest.received_at is null then
    state := 'UNKNOWN'; reason := 'no_data';
  elsif last_alive_at is null or last_alive_at < p_now - v_stale then
    if latest.received_at >= p_now - v_stale then
      state := 'FAILED'; reason := latest.outcome;
    else
      state := 'STALE'; reason := 'no_recent_attempt';
    end if;
  elsif consecutive_failures >= cfg.early_failure_attempts then
    state := 'FAILED'; reason := latest.outcome;
  elsif alive.outcome = 'applied_with_conflicts' then
    state := 'PARTIAL';
    reason := case
      when coalesce(conflicts, 0) > 0 and coalesce(not_in_ameen, 0) > 0 then 'conflicts_and_not_in_ameen'
      when coalesce(not_in_ameen, 0) > 0 then 'not_in_ameen'
      else 'conflicts' end;
  else
    state := 'HEALTHY';
    reason := case when consecutive_failures > 0 then 'transient_failure' else alive.outcome end;
  end if;
  return next;
end;
$$
$s08$;

  -- ── نصوص الرسائل (بلا HTML، بتوقيت دمشق) ────────────────────────────────────────────────────
  execute $s09$
create or replace function private.price_sync_monitor_time(p_at timestamptz, p_now timestamptz)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when p_at is null then 'لا يوجد'
    when pg_catalog.date(p_at at time zone 'Asia/Damascus') = pg_catalog.date(p_now at time zone 'Asia/Damascus')
      then pg_catalog.to_char(p_at at time zone 'Asia/Damascus', 'HH24:MI')
    else pg_catalog.to_char(p_at at time zone 'Asia/Damascus', 'YYYY-MM-DD HH24:MI')
  end;
$$
$s09$;

  execute $s10$
create or replace function private.price_sync_monitor_minutes(p_from timestamptz, p_now timestamptz)
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce((pg_catalog.floor(extract(epoch from (p_now - p_from)) / 60))::bigint::text || ' دقيقة', 'غير معروفة');
$$
$s10$;

  execute $s11$
create or replace function private.price_sync_monitor_reason_text(p_reason text)
returns text
language sql
stable
set search_path = ''
as $$
  select case p_reason
    when 'no_recent_attempt'      then 'لا محاولات مزامنة حديثة (المهمة لا تعمل أو الجهاز مطفأ أو بلا اتصال)'
    when 'no_data'                then 'لا توجد أي نبضة مزامنة مسجّلة'
    when 'task_disabled'          then 'مهمة TOBACCO Approved Prices Pull معطّلة على Windows'
    when 'task_missing'           then 'مهمة TOBACCO Approved Prices Pull غير مسجّلة على Windows'
    when 'pull_failed'            then 'تعذّر سحب الأسعار من الموقع'
    when 'ameen_unreachable'      then 'تعذّر الاتصال بقاعدة الأمين'
    when 'apply_failed'           then 'فشل تطبيق الأسعار على الأمين'
    when 'verify_failed'          then 'تعذّر التحقق من الأسعار في الأمين'
    when 'verify_mismatch'        then 'أسعار الأمين لا تطابق الموقع'
    when 'applied_with_conflicts' then 'طُبّقت الأسعار مع تعارض أو أصناف غير موجودة'
    when 'preview_only'           then 'المهمة تعمل بوضع المعاينة ولا تكتب في الأمين'
    else coalesce(p_reason, 'غير معروف')
  end;
$$
$s11$;

  execute $s12$
create or replace function private.price_sync_monitor_alert_text(
  p_state text, p_reason text, p_last_success timestamptz, p_since timestamptz, p_now timestamptz, p_device text)
returns text
language sql
stable
set search_path = ''
as $$
  select pg_catalog.concat_ws(pg_catalog.chr(10),
    case p_state
      when 'STALE'    then '🔴 OZK | توقف مزامنة الأسعار'
      when 'FAILED'   then '🔴 OZK | فشل مزامنة الأسعار'
      when 'DISABLED' then '🔴 OZK | مهمة مزامنة الأسعار معطّلة'
      else                 '🔴 OZK | حالة مزامنة الأسعار غير معروفة'
    end,
    '',
    'آخر مزامنة ناجحة: ' || private.price_sync_monitor_time(p_last_success, p_now),
    'مدة الانقطاع: ' || private.price_sync_monitor_minutes(coalesce(p_last_success, p_since), p_now),
    'الحالة: ' || p_state,
    'السبب: ' || private.price_sync_monitor_reason_text(p_reason),
    '',
    '⚠️ قد لا تصل تعديلات الأسعار',
    'من الموقع إلى برنامج الأمين.',
    '',
    'المراقبة: Supabase',
    'الجهاز: ' || coalesce(p_device, 'OZK2026'));
$$
$s12$;

  -- p_after_outage: الرسالة نفسها تُنهي حادثة انقطاع مُعلنة (انتقال انقطاع ← جزئي).
  execute $s13$
create or replace function private.price_sync_monitor_partial_text(
  p_after_outage boolean, p_outage_since timestamptz, p_last_alive timestamptz,
  p_wholesale integer, p_retail integer, p_conflicts integer, p_not_in_ameen integer,
  p_now timestamptz, p_device text)
returns text
language sql
stable
set search_path = ''
as $$
  select pg_catalog.concat_ws(pg_catalog.chr(10),
    case when p_after_outage then '🟠 OZK | عادت مزامنة الأسعار جزئياً' else '🟠 OZK | تعارض في مزامنة الأسعار' end,
    '',
    case when p_after_outage
      then 'انتهى الانقطاع بعد ' || private.price_sync_monitor_minutes(p_outage_since, p_now) || '، لكن بعض الأصناف لم تُطبَّق.'
      else 'المزامنة تعمل، لكن بعض الأصناف لم تُطبَّق.' end,
    'آخر مزامنة: ' || private.price_sync_monitor_time(p_last_alive, p_now),
    'طُبّق: جملة ' || coalesce(p_wholesale::text, '؟') || ' — مفرق ' || coalesce(p_retail::text, '؟'),
    'التعارضات: ' || coalesce(p_conflicts::text, '؟'),
    'غير موجودة في الأمين: ' || coalesce(p_not_in_ameen::text, '؟'),
    'الحالة: PARTIAL',
    '',
    '⚠️ أسعار هذه الأصناف في الأمين',
    'قد لا تطابق الموقع.',
    '',
    'المراقبة: Supabase',
    'الجهاز: ' || coalesce(p_device, 'OZK2026'));
$$
$s13$;

  execute $s14$
create or replace function private.price_sync_monitor_recovery_text(
  p_kind text, p_last_success timestamptz, p_wholesale integer, p_retail integer, p_conflicts integer,
  p_opened_at timestamptz, p_now timestamptz)
returns text
language sql
stable
set search_path = ''
as $$
  select pg_catalog.concat_ws(pg_catalog.chr(10),
    case when p_kind = 'partial' then '🟢 OZK | زالت تعارضات مزامنة الأسعار' else '🟢 OZK | عودة مزامنة الأسعار' end,
    '',
    case when p_kind = 'partial' then 'طُبّقت كل الأسعار بنجاح وبلا تعارض.' else 'عادت المزامنة للعمل بنجاح.' end,
    'آخر نجاح: ' || private.price_sync_monitor_time(p_last_success, p_now),
    'جملة: ' || coalesce(p_wholesale::text, '؟'),
    'مفرق: ' || coalesce(p_retail::text, '؟'),
    'التعارضات: ' || coalesce(p_conflicts::text, '0'),
    'مدة الحادثة: ' || private.price_sync_monitor_minutes(p_opened_at, p_now),
    '',
    'انتهت الحادثة.');
$$
$s14$;

  -- تنبيه Windows مطابق لسبب الفشل خلال النافذة **ومنذ آخر وصول حيّ** (أي من سلسلة الفشل الحالية نفسها)،
  -- لمنع التكرار بلا تعديل Windows. null إن لم يوجد. الحد الأدنى p_since ضروري: مفاتيح Windows ثابتة بنافذة
  -- 60 د، فانقطاع ثانٍ بعد تعافٍ قصير لا يُنتج صفاً جديداً، وصف الانقطاع الأول لا يجوز أن يُعلن الثاني (Codex P1).
  execute $s15$
create or replace function private.price_sync_monitor_windows_alert_at(p_reason text, p_now timestamptz, p_minutes integer, p_since timestamptz)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.max(o.created_at)
    from public.telegram_outbox o
   where p_minutes > 0
     and o.created_at <= p_now
     and o.created_at >= p_now - pg_catalog.make_interval(mins => p_minutes)
     and o.created_at > coalesce(p_since, '-infinity'::timestamptz)
     and coalesce(o.dedupe_key, '') ~ (case p_reason
           when 'pull_failed'       then '^winfail:pull-approved-prices$'
           when 'ameen_unreachable' then '^winfail:apply-to-ameen$'
           when 'apply_failed'      then '^winfail:apply-to-ameen$'
           when 'verify_mismatch'   then '^price-sync:mismatch'
           when 'verify_failed'     then '^price-sync:verify-failed'
           else '^$a' end);
$$
$s15$;

  -- ── دورة المراقبة ──────────────────────────────────────────────────────────────────────────
  execute $s16$
create or replace function private.price_sync_monitor_tick(p_now timestamptz default now())
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  cfg         private.price_sync_monitor_config%rowtype;
  a           record;
  st          private.price_sync_monitor_state%rowtype;
  inc         private.price_sync_incidents%rowtype;
  nw          private.price_sync_incidents%rowtype;
  v_outage    boolean;
  v_partial   boolean;
  v_recovered boolean;
  v_device    text;
  v_windows   timestamptz;
  v_result    text;
begin
  -- تشغيلان متزامنان (cron مكرر أو يدوي) يتسلسلان: الثاني يرى ما كتبه الأول.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('private.price_sync_monitor_tick'));

  select * into cfg from private.price_sync_monitor_config where id;
  select * into a from private.price_sync_monitor_assess(p_now);
  v_device    := coalesce(a.host, cfg.device_label);
  v_outage    := a.state in ('STALE','FAILED','DISABLED','UNKNOWN');
  v_partial   := a.state = 'PARTIAL' and a.partial_streak >= cfg.partial_confirm_attempts;
  -- التعافي يحتاج دليلاً حديثاً: آخر محاولة نفسها نجاح مثبت، لا مجرد غياب الخطأ.
  v_recovered := a.state = 'HEALTHY' and a.last_outcome in ('applied','no_changes')
                 and a.last_attempt_at = a.last_success_at;

  select * into st from private.price_sync_monitor_state where id for update;
  select * into inc from private.price_sync_incidents where closed_at is null for update;

  if st.id is null then
    -- أول تشغيل: خط أساس صامت. لا يُعدّ التاريخ حادثة جديدة.
    insert into private.price_sync_monitor_state (id, baseline_at, last_evaluated_at, last_state, last_reason)
    values (true, p_now, p_now, a.state, a.reason);
    if inc.id is null and (v_outage or v_partial) then
      insert into private.price_sync_incidents (kind, opened_at, opened_state, opened_reason, current_state, current_reason, last_seen_at, from_baseline)
      values (case when v_outage then 'outage' else 'partial' end, p_now, a.state, a.reason, a.state, a.reason, p_now, true);
      return 'baseline_open_silent';
    end if;
    return 'baseline';
  end if;

  if inc.id is null then
    if v_outage then
      v_windows := case when a.state = 'FAILED'
                     then private.price_sync_monitor_windows_alert_at(a.reason, p_now, cfg.absorb_windows_minutes, a.last_alive_at) end;
      insert into private.price_sync_incidents (kind, opened_at, opened_state, opened_reason, current_state, current_reason, last_seen_at, alert_sent_at, announced_by)
      values ('outage', p_now, a.state, a.reason, a.state, a.reason, p_now, coalesce(v_windows, p_now),
              case when v_windows is not null then 'windows' else 'monitor' end)
      returning * into inc;
      if v_windows is not null then
        v_result := 'alert_absorbed_windows';
      else
        -- بلا التقاط استثناء: فشل الإدراج يُرجع الدورة كلها فتُعاد المحاولة في الدقيقة التالية.
        perform public.notify_telegram('price_sync_outage',
          private.price_sync_monitor_alert_text(a.state, a.reason, a.last_success_at, p_now, p_now, v_device),
          'price-sync-outage:' || inc.incident_key || ':open', 10080, null);
        v_result := 'alert_sent';
      end if;
    elsif v_partial then
      insert into private.price_sync_incidents (kind, opened_at, opened_state, opened_reason, current_state, current_reason, last_seen_at, alert_sent_at, announced_by)
      values ('partial', p_now, a.state, a.reason, a.state, a.reason, p_now, p_now, 'monitor')
      returning * into inc;
      perform public.notify_telegram('price_sync_partial',
        private.price_sync_monitor_partial_text(false, null, a.last_alive_at, a.applied_wholesale, a.applied_retail, a.conflicts, a.not_in_ameen, p_now, v_device),
        'price-sync-partial:' || inc.incident_key || ':open', 10080, null);
      v_result := 'partial_alert_sent';
    elsif a.state = 'PARTIAL' then
      v_result := 'partial_pending';
    else
      v_result := 'healthy';
    end if;

  elsif v_recovered then
    update private.price_sync_incidents
       set closed_at = p_now, last_seen_at = p_now,
           recovery_sent_at = case when inc.alert_sent_at is not null then p_now end
     where id = inc.id;
    if inc.alert_sent_at is not null then
      perform public.notify_telegram('price_sync_recovered',
        private.price_sync_monitor_recovery_text(inc.kind, a.last_success_at, a.applied_wholesale, a.applied_retail, a.conflicts, inc.opened_at, p_now),
        (case when inc.kind = 'partial' then 'price-sync-partial:' else 'price-sync-outage:' end) || inc.incident_key || ':recovered', 10080, null);
      v_result := 'recovery_sent';
    else
      v_result := 'closed_silent';
    end if;

  elsif inc.kind = 'outage' and v_partial then
    -- انتقال انقطاع ← جزئي: رسالة واحدة تُنهي الانقطاع وتعلن المشكلة الجزئية.
    update private.price_sync_incidents
       set closed_at = p_now, last_seen_at = p_now,
           recovery_sent_at = case when inc.alert_sent_at is not null then p_now end
     where id = inc.id;
    insert into private.price_sync_incidents (kind, opened_at, opened_state, opened_reason, current_state, current_reason, last_seen_at, alert_sent_at, announced_by)
    values ('partial', p_now, a.state, a.reason, a.state, a.reason, p_now, p_now, 'monitor')
    returning * into nw;
    perform public.notify_telegram('price_sync_partial',
      private.price_sync_monitor_partial_text(inc.alert_sent_at is not null, inc.opened_at, a.last_alive_at, a.applied_wholesale, a.applied_retail, a.conflicts, a.not_in_ameen, p_now, v_device),
      'price-sync-partial:' || nw.incident_key || ':open', 10080, null);
    v_result := case when inc.alert_sent_at is not null then 'outage_to_partial' else 'partial_alert_sent' end;

  elsif inc.kind = 'partial' and v_outage then
    -- انتقال جزئي ← انقطاع: تُغلق الجزئية بصمت وتُفتح حادثة انقطاع برسالتها.
    update private.price_sync_incidents set closed_at = p_now, last_seen_at = p_now where id = inc.id;
    v_windows := case when a.state = 'FAILED'
                   then private.price_sync_monitor_windows_alert_at(a.reason, p_now, cfg.absorb_windows_minutes, a.last_alive_at) end;
    insert into private.price_sync_incidents (kind, opened_at, opened_state, opened_reason, current_state, current_reason, last_seen_at, alert_sent_at, announced_by)
    values ('outage', p_now, a.state, a.reason, a.state, a.reason, p_now, coalesce(v_windows, p_now),
            case when v_windows is not null then 'windows' else 'monitor' end)
    returning * into nw;
    if v_windows is not null then
      v_result := 'alert_absorbed_windows';
    else
      perform public.notify_telegram('price_sync_outage',
        private.price_sync_monitor_alert_text(a.state, a.reason, a.last_success_at, p_now, p_now, v_device),
        'price-sync-outage:' || nw.incident_key || ':open', 10080, null);
      v_result := 'partial_to_outage';
    end if;

  elsif (inc.kind = 'outage' and v_outage) or (inc.kind = 'partial' and a.state = 'PARTIAL') then
    update private.price_sync_incidents
       set current_state = a.state, current_reason = a.reason, last_seen_at = p_now
     where id = inc.id;
    if inc.alert_sent_at is null and inc.from_baseline
       and p_now >= st.baseline_at + pg_catalog.make_interval(mins => cfg.baseline_escalate_minutes) then
      update private.price_sync_incidents set alert_sent_at = p_now, announced_by = 'monitor' where id = inc.id;
      if inc.kind = 'partial' then
        perform public.notify_telegram('price_sync_partial',
          private.price_sync_monitor_partial_text(false, null, a.last_alive_at, a.applied_wholesale, a.applied_retail, a.conflicts, a.not_in_ameen, p_now, v_device),
          'price-sync-partial:' || inc.incident_key || ':open', 10080, null);
      else
        perform public.notify_telegram('price_sync_outage',
          private.price_sync_monitor_alert_text(a.state, a.reason, a.last_success_at, inc.opened_at, p_now, v_device),
          'price-sync-outage:' || inc.incident_key || ':open', 10080, null);
      end if;
      v_result := 'baseline_escalated';
    else
      v_result := 'incident_ongoing';
    end if;

  else
    -- لا دليل تعافٍ كامل بعد (فشل عابر بعد نجاح، أو جزئي غير مؤكَّد بعد انقطاع): الحادثة تبقى مفتوحة بلا رسائل.
    update private.price_sync_incidents set last_seen_at = p_now where id = inc.id;
    v_result := 'incident_waiting_proof';
  end if;

  update private.price_sync_monitor_state
     set last_evaluated_at = p_now, last_state = a.state, last_reason = a.reason
   where id;
  return v_result;
end;
$$
$s16$;

  execute $s17$
revoke all on function private.price_sync_monitor_assess(timestamptz) from public, anon, authenticated, service_role
$s17$;

  execute $s18$
revoke all on function private.price_sync_monitor_time(timestamptz, timestamptz) from public, anon, authenticated, service_role
$s18$;

  execute $s19$
revoke all on function private.price_sync_monitor_minutes(timestamptz, timestamptz) from public, anon, authenticated, service_role
$s19$;

  execute $s20$
revoke all on function private.price_sync_monitor_reason_text(text) from public, anon, authenticated, service_role
$s20$;

  execute $s21$
revoke all on function private.price_sync_monitor_alert_text(text, text, timestamptz, timestamptz, timestamptz, text) from public, anon, authenticated, service_role
$s21$;

  execute $s22$
revoke all on function private.price_sync_monitor_partial_text(boolean, timestamptz, timestamptz, integer, integer, integer, integer, timestamptz, text) from public, anon, authenticated, service_role
$s22$;

  execute $s23$
revoke all on function private.price_sync_monitor_recovery_text(text, timestamptz, integer, integer, integer, timestamptz, timestamptz) from public, anon, authenticated, service_role
$s23$;

  execute $s24$
revoke all on function private.price_sync_monitor_windows_alert_at(text, timestamptz, integer, timestamptz) from public, anon, authenticated, service_role
$s24$;

  execute $s25$
revoke all on function private.price_sync_monitor_tick(timestamptz) from public, anon, authenticated, service_role
$s25$;

  -- ── منع التكرار: المراقب الجديد يحل محل صف «price-sync» القديم ──────────────────────────────
  execute $s26$
do $retire$
begin
  if to_regclass('private.project_task_monitors') is not null then
    update private.project_task_monitors set enabled = false where task_key = 'price-sync' and enabled;
  end if;
end
$retire$
$s26$;

  -- ── الجدولة (cron كل دقيقة) ─────────────────────────────────────────────────────────────────
  execute $s27$
do $schedule$
begin
  if to_regnamespace('cron') is not null then
    if exists (select 1 from cron.job where jobname = 'price-sync-monitor') then
      perform cron.unschedule('price-sync-monitor');
    end if;
    perform cron.schedule('price-sync-monitor', '* * * * *', 'select private.price_sync_monitor_tick();');
  end if;
end
$schedule$
$s27$;
end
$install17$;

-- ── تحقق بعدي ────────────────────────────────────────────────────────────────────────────────
do $post17$
begin
  if to_regprocedure('private.price_sync_monitor_tick(timestamptz)') is null or to_regclass('private.price_sync_incidents') is null then
    raise exception 'postflight 17: monitor objects missing';
  end if;
  if to_regnamespace('cron') is not null then
    if not exists (select 1 from cron.job where jobname = 'price-sync-monitor') then
      raise exception 'postflight 17: cron job price-sync-monitor missing';
    end if;
  end if;
end
$post17$;
