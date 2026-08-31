-- ============================================================================
-- المرحلة أ — اختبارات تصنيف تسليم تيليغرام وضمانة القراءة فقط.
--
-- التشغيل (بعد تطبيق الترحيل):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/telegram-delivery-audit.sql
-- كل ما يُنشأ هنا مؤقت في pg_temp ويختفي بانتهاء الجلسة. لا يُقرأ ولا يُكتب
-- أي صف من public.telegram_outbox ولا من net._http_response.
--
-- سبب وجوده: dispatch_telegram_outbox كان يكتب status='sent' بعد
-- net.http_post مباشرة — والدالة غير متزامنة — فـ"sent" كانت تعني "سُلّم إلى
-- pg_net" لا "تيليغرام استلمه". قياس على الإنتاج في نافذة ست ساعات: 241
-- رسالة معلَّمة sent مقابل 230 رداً ناجحاً ⇒ 11 بلا رد نجاح.
-- المرحلة أ لا تصلح هذا؛ هي عدسة تجعله مرئياً وقابلاً للقياس أولاً.
-- ============================================================================

create temporary table ob_probe   (id bigint, net_request_id bigint);
create temporary table resp_probe (id bigint, status_code integer, content text,
                                   timed_out boolean, error_msg text);

-- نفس تعبير التصنيف الموجود في public.telegram_delivery_audit حرفياً.
-- يفرض scripts/check-telegram-delivery-observability.mjs بقاءهما متطابقين.
create function pg_temp.audit_probe() returns table(outbox_id bigint, delivery_class text)
language sql stable as $$
  select o.id,
    case
      when o.net_request_id is null then 'no_request'
      when r.id is null then 'no_response'
      when r.status_code is null then 'network_error'
      when r.status_code between 200 and 299
       and b.body is not null
       and b.body ->> 'ok' = 'true'
       and jsonb_exists(b.body -> 'result', 'message_id') then 'ok_true'
      when r.status_code between 200 and 299
       and b.body is not null
       and b.body ->> 'ok' = 'false' then 'ok_false'
      when r.status_code between 200 and 299 then 'unparsed'
      else 'http_error'
    end
  from ob_probe o left join resp_probe r on r.id = o.net_request_id
  left join lateral (select private.safe_jsonb(r.content) as body) b on true
  order by o.id;
$$;

insert into ob_probe values (1,null),(2,201),(3,202),(4,203),(5,204),(6,205),(7,206),(8,207);
insert into resp_probe values
 -- خطأ شبكة: status_code = NULL مع error_msg. نص حقيقي مرصود في الإنتاج.
 (202, null, null, true,  'Timeout of 5000 ms reached. Total time: 5000.944 ms (DNS 9.8 ms, TCP/SSL handshake 4991.1 ms)'),
 -- نجاح تيليغرام الحقيقي: ok=true مع result.message_id
 (203, 200, '{"ok":true,"result":{"message_id":123,"date":1}}', false, null),
 -- رفض منطقي بجسم 200 — يبقى غير مثبت من API رسمياً (انظر الملاحظة أدناه)
 (204, 200, '{"ok":false,"error_code":403,"description":"bot was blocked by the user"}', false, null),
 -- شكل web-push: 200 وok=true لكن بلا result.message_id ⇒ ليس نجاح تيليغرام
 (205, 200, '{"ok":true,"sent":0,"failed":0}', false, null),
 -- رمز غير 2xx مرصود فعلياً من مِجَسّ example.com يوم 2026-08-31
 (206, 405, '<html>405 Not Allowed</html>', false, null),
 (207, 429, '{"ok":false,"error_code":429,"description":"Too Many Requests"}', false, null);

do $$
declare n int := 0; a int := 0;
begin
  select count(*) into n from pg_temp.audit_probe();
  assert n = 8, format('عدد الصفوف %s ≠ 8', n); a:=a+1;

  assert (select delivery_class from pg_temp.audit_probe() where outbox_id=1)='no_request',
    '1: صف بلا net_request_id (أُرسل قبل المرحلة أ) ⇒ no_request'; a:=a+1;
  assert (select delivery_class from pg_temp.audit_probe() where outbox_id=2)='no_response',
    '2: معرّف بلا رد (لم يُعالَج بعد أو انقضى TTL) ⇒ no_response'; a:=a+1;
  assert (select delivery_class from pg_temp.audit_probe() where outbox_id=3)='network_error',
    '3: status_code=NULL مع error_msg ⇒ network_error'; a:=a+1;
  assert (select delivery_class from pg_temp.audit_probe() where outbox_id=4)='ok_true',
    '4: النجاح الوحيد المعتبَر — ok=true مع result.message_id'; a:=a+1;
  assert (select delivery_class from pg_temp.audit_probe() where outbox_id=5)='ok_false',
    '5: 200 بجسم ok=false ⇒ ok_false لا نجاح'; a:=a+1;
  assert (select delivery_class from pg_temp.audit_probe() where outbox_id=6)='unparsed',
    '6: شكل web-push (ok=true بلا message_id) لا يُحتسب نجاح تيليغرام'; a:=a+1;
  assert (select delivery_class from pg_temp.audit_probe() where outbox_id=7)='http_error',
    '7: 405 ⇒ http_error'; a:=a+1;
  assert (select delivery_class from pg_temp.audit_probe() where outbox_id=8)='http_error',
    '8: 429 ⇒ http_error (سياسة التعامل معه تُقرَّر في المرحلة ب لا هنا)'; a:=a+1;

  -- لا صنف واحد يُحتسب نجاحاً إلا ok_true
  assert (select count(*) from pg_temp.audit_probe() where delivery_class='ok_true')=1,
    '9: صنف نجاح واحد فقط في مجموعة الاختبار'; a:=a+1;

  assert a >= 9, format('عدد التأكيدات %s أقل من 9', a);
  raise notice 'telegram delivery classification: % تأكيداً — كلها نجحت', a;
end $$;

-- ============================================================================
-- ملاحظة Codex P2 (2026-08-31) — رد 2xx بجسم ليس JSON.
--
-- التعبير القديم كان يكتب r.content::jsonb داخل فرعَي ok_true/ok_false. حين
-- يكون رمز الحالة ضمن 2xx والجسم غير فارغ وغير JSON، يُقيَّم التحويل حتماً —
-- أياً كان ترتيب تقييم AND الذي يختاره المخطِّط — فيرفع 22P02 قبل أن يُبلَغ
-- فرع 'unparsed'. ولأن العدسة دالة تُرجع مجموعة تعالج النافذة كلها دفعة
-- واحدة، فصفٌّ واحد سيّئ كان يُسقط الاستدعاء بأكمله ويخفي كل صف آخر.
--
-- لماذا لم تكشفه المجموعة السابقة: الصف الوحيد بجسم HTML فيها (206) رمزه
-- 405 — خارج 2xx — فكان يسقط إلى else 'http_error' بلا أن يلمس التحويل.
--
-- الحالات الثلاث أدناه تُثير الخلل فعلياً، ولا يكفي أن تُصنَّف صحيحاً: يجب
-- أن يبقى بقية صفوف النافذة ظاهراً معها. ذلك ما يثبته تأكيد العزل.
-- ============================================================================
insert into ob_probe values (9,208),(10,209),(11,210);
insert into resp_probe values
 -- صفحة عطل من وسيط: 200 مع HTML. هذه بالضبط الحالة التي كانت تُطفئ العدسة.
 (208, 200, '<html><body>502 Bad Gateway</body></html>', false, null),
 -- جسم فارغ برمز 200 — ''::jsonb يرفع 22P02 نفسه
 (209, 200, '', false, null),
 -- 2xx بلا جسم إطلاقاً (204 No Content)
 (210, 204, null, false, null);

-- شاهد سالب: نسخة مصغَّرة من التعبير القديم بتحويله المباشر. وجودها يمنع أن
-- يكون الاختبار أعلاه فارغ المعنى — فلو لم تسقط هذه، لكانت الحالات الجديدة
-- لا تُثير الخلل أصلاً وكان التأكيد يمرّ بلا أن يحرس شيئاً.
create function pg_temp.audit_probe_unsafe() returns table(outbox_id bigint, delivery_class text)
language sql stable as $$
  select o.id,
    case
      when r.status_code between 200 and 299
       and r.content is not null
       and r.content::jsonb ->> 'ok' = 'true' then 'ok_true'
      else 'other'
    end
  from ob_probe o left join resp_probe r on r.id = o.net_request_id order by o.id;
$$;

do $$
declare n int := 0; a int := 0; old_died boolean;
begin
  -- ١) الاستدعاء لا يرمي، ويُرجع النافذة كاملة. لو رمى لما وُصل السطر التالي.
  select count(*) into n from pg_temp.audit_probe();
  assert n = 11, format('10: عدد الصفوف %s ≠ 11 — العدسة لم تُرجع النافذة كاملة', n); a:=a+1;

  -- ٢) الصفوف الثلاثة السيّئة تُصنَّف unparsed بدل أن تُسقط الاستعلام
  assert (select delivery_class from pg_temp.audit_probe() where outbox_id=9)='unparsed',
    '11: 200 بجسم HTML ⇒ unparsed لا انفجار'; a:=a+1;
  assert (select delivery_class from pg_temp.audit_probe() where outbox_id=10)='unparsed',
    '12: 200 بجسم فارغ ⇒ unparsed'; a:=a+1;
  assert (select delivery_class from pg_temp.audit_probe() where outbox_id=11)='unparsed',
    '13: 204 بلا جسم ⇒ unparsed'; a:=a+1;

  -- ٣) العزل — جوهر الملاحظة. لا يكفي أن يُصنَّف الصف السيّئ صحيحاً؛ يجب أن
  --    يبقى تصنيف الصفوف الثمانية الأصلية كما هو تماماً وهي بجواره.
  assert (select string_agg(delivery_class, ',' order by outbox_id)
            from pg_temp.audit_probe() where outbox_id <= 8)
         = 'no_request,no_response,network_error,ok_true,ok_false,unparsed,http_error,http_error',
    '14: العزل — تصنيف الصفوف الثمانية الأصلية تغيّر بوجود ردود غير JSON'; a:=a+1;
  assert (select count(*) from pg_temp.audit_probe() where delivery_class='ok_true')=1,
    '15: العزل — صف النجاح ما زال مرئياً ووحيداً رغم الردود السيّئة'; a:=a+1;

  -- ٤) الشاهد السالب: التعبير القديم يسقط فعلاً على هذه المجموعة نفسها.
  begin
    perform count(*) from pg_temp.audit_probe_unsafe();
    old_died := false;
  exception when invalid_text_representation then
    old_died := true;
  end;
  assert old_died,
    '16: الشاهد السالب لم يسقط — الحالات الجديدة لا تُثير خلل P2 فالحراسة وهمية'; a:=a+1;

  assert a >= 7, format('عدد تأكيدات P2 %s أقل من 7', a);
  raise notice 'telegram delivery P2 (non-JSON 2xx): % تأكيداً — كلها نجحت', a;
end $$;

-- ---------------------------------------------------------------------------
-- ضمانة القراءة فقط مفروضة من المحرّك: دالة stable لا يمكنها الكتابة إطلاقاً.
-- مثبت على الإنتاج 2026-08-31:
--   ERROR: 0A000: UPDATE is not allowed in a non-volatile function
-- ---------------------------------------------------------------------------
create function pg_temp.stable_write_probe() returns void language sql stable as $$
  update ob_probe set net_request_id = 999 where id = 1;
$$;

do $$
begin
  begin
    perform pg_temp.stable_write_probe();
    raise exception 'FAIL: دالة stable سمحت بالكتابة — الضمانة غير قائمة';
  exception
    when feature_not_supported then
      raise notice 'stable guard enforced by engine: %', sqlerrm;
  end;
  assert (select net_request_id from ob_probe where id=1) is null,
    'الصف تغيّر رغم فشل الاستدعاء';
  raise notice 'read-only guarantee: مفروضة من PostgreSQL نفسه ✓';
end $$;

-- ملاحظة مسجَّلة للمرحلة ب (لا تُبنى عليها سياسة الآن):
--   'ok_false' مع HTTP 200 مصنَّف هنا احتياطاً، لكنه **غير مثبت** من Telegram
--   Bot API — الشائع أن تيليغرام يعيد 4xx لأخطاء كهذه. يلزم مثال موثق أو
--   اختبار آمن قبل اعتباره مساراً طبيعياً. القياس في المرحلة أ هو ما سيحسمه.

-- ============================================================================
-- اختبارات الصلاحيات — ملاحظة Codex P1 (2026-08-31).
--
-- كانت telegram_delivery_audit ممنوحة لـauthenticated كاملاً، وهي
-- security definer تتجاوز RLS الخاص بـtelegram_outbox — فأي موظف مسجَّل كان
-- يقرأ تاريخ التسليم كله ومعه dedupe_key. وتلك المفاتيح تحمل بيانات زبائن
-- حرفياً: 'creditover:' || r.name و'creditnear:' || r.name في
-- telegram-notifications.sql، و'collection:<customer_uuid>:<date>' كما هي في
-- الإنتاج.
--
-- الحارس هنا نسخة طبق الأصل من المشحون. يفرض
-- scripts/check-telegram-delivery-observability.mjs تطابقهما.
-- ============================================================================
create function pg_temp.guard_probe() returns text
language plpgsql stable security definer
set search_path to 'public', 'net', 'pg_temp'
as $$
declare
  v_jwt_role text := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role';
begin
  if v_jwt_role is not null and v_jwt_role <> 'service_role' then
    raise exception 'telegram_delivery_audit: unauthorized' using errcode = '42501';
  end if;
  return 'ALLOWED';
end $$;

create function pg_temp.try_as(p_claims text) returns text language plpgsql as $$
begin
  perform set_config('request.jwt.claims', p_claims, true);
  begin
    return pg_temp.guard_probe();
  exception when insufficient_privilege then
    return 'DENIED_42501';
  end;
end $$;

do $$
declare a int := 0;
begin
  assert pg_temp.try_as('') = 'ALLOWED',
    'أ1: بلا JWT (cron / اتصال مباشر / أدوات الخدمة) ⇒ مسموح'; a:=a+1;
  assert pg_temp.try_as('{"role":"service_role"}') = 'ALLOWED',
    'أ2: service_role ⇒ مسموح — وهو المستدعي المقصود الوحيد'; a:=a+1;
  assert pg_temp.try_as('{"role":"authenticated"}') = 'DENIED_42501',
    'أ3: موظف مسجَّل عادي ⇒ مرفوض (جوهر ملاحظة Codex P1)'; a:=a+1;
  assert pg_temp.try_as('{"role":"anon"}') = 'DENIED_42501',
    'أ4: anon ⇒ مرفوض'; a:=a+1;
  assert pg_temp.try_as('{"role":"authenticated","app_metadata":{"role":"owner"}}') = 'DENIED_42501',
    'أ5: حتى المالك مرفوض — لا واجهة بشرية تستدعيها في المرحلة أ'; a:=a+1;
  assert a = 5, format('تأكيدات الصلاحيات %s ≠ 5', a);
  raise notice 'authorization guard: % تأكيداً — كلها نجحت', a;
end $$;

-- ---------------------------------------------------------------------------
-- خطر object shadowing داخل security definer — مثبت بالقياس لا بالتوثيق.
-- pg_temp تُبحث أولاً ضمنياً إن لم تُذكر، فيستطيع جدول مؤقت باسم جدول حقيقي
-- أن يختطف القراءة. ذكرها *أخيراً* يعيد الأولوية للمخطط الحقيقي.
-- ---------------------------------------------------------------------------
create temporary table telegram_outbox (marker text);
insert into telegram_outbox values ('TEMP_SHADOWED_THE_REAL_TABLE');

create function pg_temp.sp_without() returns text
language plpgsql stable security definer set search_path to 'public', 'net'
as $$ begin return (select marker from telegram_outbox limit 1);
      exception when undefined_column then return 'PUBLIC_WON'; end $$;

create function pg_temp.sp_with_last() returns text
language plpgsql stable security definer set search_path to 'public', 'net', 'pg_temp'
as $$ begin return (select marker from telegram_outbox limit 1);
      exception when undefined_column then return 'PUBLIC_WON'; end $$;

do $$
begin
  assert pg_temp.sp_without() = 'TEMP_SHADOWED_THE_REAL_TABLE',
    'ش1: بلا ذكر pg_temp يقع الاختطاف فعلاً — هذا سبب ذكرها أخيراً';
  assert pg_temp.sp_with_last() = 'PUBLIC_WON',
    'ش2: بذكر pg_temp أخيراً يفوز المخطط الحقيقي';
  raise notice 'search_path shadowing: مثبت بالاتجاهين ✓';
end $$;
