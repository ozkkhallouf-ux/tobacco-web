-- اختبار سلوكي حيّ لـ`public.write_business_audit_log()` على approved_price_items.
--
-- كيف يعمل بأمان: يبني جدولاً **مؤقتاً** اسمه approved_price_items (الاسم مهم:
-- الدالة تتفرّع على `tg_table_name`) ويعلّق عليه نفس الـtrigger، ثم ينفّذ
-- السيناريوهات عليه. لا يلمس صفاً واحداً من `public.approved_price_items`.
-- وينتهي بـ`raise exception` فتُلغى المعاملة كاملةً بما فيها صفوف
-- business_audit_log التي كتبها الاختبار نفسه — فلا يبقى أثر بعد التشغيل.
--
-- التشغيل: الصق الملف في محرّر SQL على القاعدة. النتيجة تصل كنص رسالة الخطأ
-- (هذا مقصود: الخطأ هو ما يضمن الإلغاء). كل سطر يطبع الملاحظ مقابل المتوقَّع.
--
-- خط الأساس قبل الإصلاح (مُشغَّل على الإنتاج 2026-09-21): B وC وD وH1 وH2
-- كانت كلها +0 — أي أن تغيير الهوية كان لا يُسجَّل إطلاقاً. وبعد نشر الهجرة
-- شُغّل الملف على الدالة المنشورة فعلياً فخرجت الخمسة عشر سطراً مطابقة
-- للمتوقَّع، وبقي business_audit_log على 1267 صفاً وapproved_price_items على
-- 313 صفاً ببصمة أسعار وهويات لم تتغيّر — أي أن الاختبار لم يترك أثراً.

do $test$
declare
  r text := E'\n';
  c int; c2 int; p int;
  ida uuid := '11111111-1111-1111-1111-111111111111';
  idb uuid := '22222222-2222-2222-2222-222222222222';
  idc uuid := '33333333-3333-3333-3333-333333333333';
  idd uuid := '44444444-4444-4444-4444-444444444444';
begin
  create temp table approved_price_items (like public.approved_price_items including defaults) on commit drop;
  create trigger trg_business_audit after insert or delete or update on pg_temp.approved_price_items
    for each row execute function public.write_business_audit_log();

  -- F) INSERT — السلوك القائم محفوظ
  insert into pg_temp.approved_price_items(id,item_key,item_name,sale_price,unit1_price,unit2_price,stock_qty,item_guid)
  values (ida,'k-a','A',10,10,100,5,'AAAAAAAA-0000-0000-0000-000000000001'),
         (idb,'k-b','B',20,20,200,5,null),
         (idc,'k-c','C',30,30,300,5,'CCCCCCCC-0000-0000-0000-000000000003'),
         (idd,'k-d','D',40,40,400,5,'DDDDDDDD-0000-0000-0000-000000000004');
  select count(*) into c from public.business_audit_log where entity_id=ida::text and action='INSERT';
  r := r || format('F  INSERT                  -> %s (expect 1)%s', c, E'\n');

  -- A) تعديل سعر فقط — السلوك القائم محفوظ
  p := (select count(*) from public.business_audit_log where entity_id=ida::text and action='UPDATE');
  update pg_temp.approved_price_items set sale_price=11 where id=ida;
  select count(*) into c from public.business_audit_log where entity_id=ida::text and action='UPDATE';
  r := r || format('A  price-only              -> +%s (expect +1)%s', c-p, E'\n');

  -- E) مزامنة المخزون وحدها — لا ضجيج (سبب وجود فرع الإعفاء أصلاً)
  p := c;
  update pg_temp.approved_price_items set stock_qty=99, source_synced_at=now(), updated_at=now() where id=ida;
  select count(*) into c from public.business_audit_log where entity_id=ida::text and action='UPDATE';
  r := r || format('E  stock/sync-only         -> +%s (expect +0)%s', c-p, E'\n');

  -- E2) إسناد الهوية إلى نفسها — UPDATE بلا تغيير فعلي، لا حدث
  p := c;
  update pg_temp.approved_price_items set item_key=item_key, item_guid=item_guid where id=ida;
  select count(*) into c from public.business_audit_log where entity_id=ida::text and action='UPDATE';
  r := r || format('E2 self-assign key+guid    -> +%s (expect +0)%s', c-p, E'\n');

  -- B) item_key وحده — جوهر الإصلاح
  p := c;
  update pg_temp.approved_price_items set item_key='k-a-renamed' where id=ida;
  select count(*) into c from public.business_audit_log where entity_id=ida::text and action='UPDATE';
  r := r || format('B  item_key-only           -> +%s (expect +1)%s', c-p, E'\n');
  select count(*) into c2 from public.business_audit_log where entity_id=ida::text and action='UPDATE'
    and before_data->>'item_key'='k-a' and after_data->>'item_key'='k-a-renamed';
  r := r || format('B  old+new item_key        -> %s (expect 1)%s', c2, E'\n');

  -- C) item_guid وحده — جوهر الإصلاح
  p := c;
  update pg_temp.approved_price_items set item_guid='AAAAAAAA-0000-0000-0000-00000000000F' where id=ida;
  select count(*) into c from public.business_audit_log where entity_id=ida::text and action='UPDATE';
  r := r || format('C  item_guid-only          -> +%s (expect +1)%s', c-p, E'\n');
  select count(*) into c2 from public.business_audit_log where entity_id=ida::text and action='UPDATE'
    and before_data->>'item_guid'='AAAAAAAA-0000-0000-0000-000000000001'
    and after_data->>'item_guid'='AAAAAAAA-0000-0000-0000-00000000000F';
  r := r || format('C  old+new item_guid       -> %s (expect 1)%s', c2, E'\n');

  -- D) الاثنان في عبارة واحدة — حدث واحد يحملهما، لا حدثان
  p := c;
  update pg_temp.approved_price_items set item_key='k-a-both', item_guid='AAAAAAAA-0000-0000-0000-0000000000BB' where id=ida;
  select count(*) into c from public.business_audit_log where entity_id=ida::text and action='UPDATE';
  r := r || format('D  key+guid one statement  -> +%s (expect exactly +1)%s', c-p, E'\n');
  select count(*) into c2 from public.business_audit_log where entity_id=ida::text and action='UPDATE'
      and before_data->>'item_key'='k-a-renamed' and after_data->>'item_key'='k-a-both'
      and before_data->>'item_guid'='AAAAAAAA-0000-0000-0000-00000000000F'
      and after_data->>'item_guid'='AAAAAAAA-0000-0000-0000-0000000000BB';
  r := r || format('D  both old+new in ONE row -> %s (expect 1)%s', c2, E'\n');

  -- G) DELETE — السلوك القائم محفوظ
  p := (select count(*) from public.business_audit_log where entity_id=ida::text and action='DELETE');
  delete from pg_temp.approved_price_items where id=ida;
  select count(*) into c from public.business_audit_log where entity_id=ida::text and action='DELETE';
  r := r || format('G  DELETE                  -> +%s (expect +1)%s', c-p, E'\n');

  -- H) NULL ↔ GUID — الـbackfill الصامت الذي ضاع 10 مرات
  p := (select count(*) from public.business_audit_log where entity_id=idb::text and action='UPDATE');
  update pg_temp.approved_price_items set item_guid='BBBBBBBB-0000-0000-0000-000000000002' where id=idb;
  select count(*) into c from public.business_audit_log where entity_id=idb::text and action='UPDATE';
  r := r || format('H1 NULL -> GUID            -> +%s (expect +1)%s', c-p, E'\n');
  p := c;
  update pg_temp.approved_price_items set item_guid=null where id=idb;
  select count(*) into c from public.business_audit_log where entity_id=idb::text and action='UPDATE';
  r := r || format('H2 GUID -> NULL            -> +%s (expect +1)%s', c-p, E'\n');

  -- I) حالة الأحرف وحدها — مقارنة القيمة الخام، فيُسجَّل (دلالة موثّقة بالهجرة)
  p := (select count(*) from public.business_audit_log where entity_id=idc::text and action='UPDATE');
  update pg_temp.approved_price_items set item_guid=lower('CCCCCCCC-0000-0000-0000-000000000003') where id=idc;
  select count(*) into c from public.business_audit_log where entity_id=idc::text and action='UPDATE';
  r := r || format('I  casing-only guid        -> +%s (expect +1)%s', c-p, E'\n');

  -- K) item_name وحده — خارج نطاق هذا الإصلاح، سلوكه القائم يبقى كما هو
  p := (select count(*) from public.business_audit_log where entity_id=idd::text and action='UPDATE');
  update pg_temp.approved_price_items set item_name='D-renamed' where id=idd;
  select count(*) into c from public.business_audit_log where entity_id=idd::text and action='UPDATE';
  r := r || format('K  item_name-only          -> +%s (expect +0, unchanged)%s', c-p, E'\n');

  raise exception 'AUDIT ITEM-IDENTITY TEST (transaction rolled back):%', r;
end
$test$;

-- الجداول الثلاثة الأخرى الحاملة لنفس الـtrigger لا تمرّ بفرع الإعفاء أصلاً.
-- هذا الجزء يثبته بالتنفيذ على customer_credit_limits (نفس الأمان: جدول مؤقت
-- ومعاملة مُلغاة). المتوقَّع +1 على كل عملية بما فيها UPDATE لا يغيّر شيئاً.
do $scope$
declare r text := E'\n'; c int; p int;
begin
  create temp table customer_credit_limits (like public.customer_credit_limits including defaults) on commit drop;
  create trigger trg_business_audit after insert or delete or update on pg_temp.customer_credit_limits
    for each row execute function public.write_business_audit_log();

  p := (select count(*) from public.business_audit_log where entity_table='customer_credit_limits');
  insert into pg_temp.customer_credit_limits(customer_key, credit_limit) values ('cust-scope', 100);
  c := (select count(*) from public.business_audit_log where entity_table='customer_credit_limits');
  r := r || format('SCOPE INSERT               -> +%s (expect +1)%s', c-p, E'\n');
  p := c;
  update pg_temp.customer_credit_limits set credit_limit=100 where customer_key='cust-scope';
  c := (select count(*) from public.business_audit_log where entity_table='customer_credit_limits');
  r := r || format('SCOPE no-op UPDATE         -> +%s (expect +1)%s', c-p, E'\n');
  p := c;
  update pg_temp.customer_credit_limits set credit_limit=250 where customer_key='cust-scope';
  c := (select count(*) from public.business_audit_log where entity_table='customer_credit_limits');
  r := r || format('SCOPE real UPDATE          -> +%s (expect +1)%s', c-p, E'\n');
  p := c;
  delete from pg_temp.customer_credit_limits where customer_key='cust-scope';
  c := (select count(*) from public.business_audit_log where entity_table='customer_credit_limits');
  r := r || format('SCOPE DELETE               -> +%s (expect +1)%s', c-p, E'\n');

  raise exception 'AUDIT SCOPE TEST (transaction rolled back):%', r;
end
$scope$;
