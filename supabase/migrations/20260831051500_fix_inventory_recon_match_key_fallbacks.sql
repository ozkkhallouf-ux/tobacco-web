-- إصلاح ملاحظة Codex P1 على PR #126: إعادة نشر
-- inventory_recon_create_session_with_lines بمسارات رجوع التكلفة الصحيحة بعد
-- فصل عمودَي item_costs في ترحيل 20260827110325_fix_item_costs_true_guid.sql.
--
-- السبب الجذري:
--   ذلك الترحيل أعاد تسمية item_costs.item_guid إلى match_key (مفتاح منع التكرار:
--   GUID أو كود أو اسم) وأضاف عموداً جديداً item_guid يحمل GUID الأمين الحقيقي فقط
--   أو NULL. لكن هذه الدالة بقيت تستعلم item_guid في مسارَي الرجوع بالكود وبالاسم،
--   وهو عمود لا يحوي كوداً ولا اسماً إطلاقاً بعد الترحيل. فكل صنف لم يجد له
--   tools/push-item-costs.ps1 GUID أمين حقيقي (item_guid = NULL) كان يسقط من كل
--   مسارات المطابقة بصمت ويُدرَج بـunit_cost وcurrency فارغَين، فتفسد قيمة التسوية
--   (settlement_value) في جلسات جرد المخزون الجديدة دون أي خطأ ظاهر.
--
-- الإصلاح: البحث المباشر بالـGUID يبقى على item_guid، ويُنقل الرجوع بالكود وبالاسم
-- إلى match_key، ويُضاف بحث GUID احتياطي على match_key يغطي الصفوف المكتوبة قبل
-- تشغيل push-item-costs.ps1 التالي (GUID فيها ما يزال في match_key وitem_guid فارغ).
--
-- الترحيل idempotent بالكامل: CREATE OR REPLACE FUNCTION لا غير، بلا أي تغيير مخطط،
-- ونص الدالة هنا مطابق حرفياً لنصها في supabase/inventory-reconciliation-table.sql
-- (يفرض هذا التطابق فحص scripts/check-inventory-recon-cost-fallbacks.mjs).

create or replace function inventory_recon_create_session_with_lines(
  p_session_date date,
  p_session_month date,
  p_warehouse_key text,
  p_warehouse_name text,
  p_notes text,
  p_idempotency_key text,
  p_source_report_id uuid,
  p_lines jsonb
)
returns public.inventory_recon_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.inventory_recon_sessions;
  v_existing public.inventory_recon_sessions;
  v_report_summary jsonb;
  v_report_items jsonb;
  v_report_date timestamptz;
  v_report_created_by uuid;
  v_report_created_at timestamptz;
  v_report_generated_at timestamptz;
  v_report_freshness_at timestamptz;
  v_missing_keys text;
  v_new_digest text;
  v_existing_digest text;
  v_empty_key_count int;
  v_requested_distinct_count int;
  v_inserted_count int;
begin
  if auth.uid() is null then
    raise exception 'inventory_recon: يجب تسجيل الدخول لإنشاء جلسة جرد';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'inventory_recon: لا يمكن إنشاء جلسة جرد بلا سطور';
  end if;

  -- item_key فارغ/مسافات فقط كان سيسقط بصمت من الـjoin مع v_report_items
  -- لاحقاً (لن يطابق أي itemKey فعلي) فيقل عدد السطور المُدرجة بلا أي خطأ
  -- ظاهر للعميل — نرفض الطلب صراحة قبل حساب البصمة بدل ذلك.
  select count(*) into v_empty_key_count
  from jsonb_array_elements(p_lines) as line
  where trim(coalesce(line ->> 'item_key', '')) = '';
  if v_empty_key_count > 0 then
    raise exception 'inventory_recon: % سطر بمفتاح صنف فارغ — لا يمكن إرسال جلسة تحوي item_key فارغاً', v_empty_key_count;
  end if;

  if p_source_report_id is null then
    raise exception 'inventory_recon: يجب اختيار تقرير مخزون مستودع موثوق قبل إنشاء الجلسة';
  end if;

  -- مراجعة Codex على PR #40 (الجولة الثانية): source='ameen_warehouse_stock'
  -- وحده لم يكن كافياً على مستوى INSERT بجدول inventory_reports المشترك —
  -- التقرير أصبح يُقرأ الآن من ameen_warehouse_stock_reports المستقل
  -- (supabase/ameen-warehouse-stock-reports.sql)، الذي تحصر سياسة INSERT
  -- الخاصة به الكتابة بحساب المزامنة الموثوق فقط، فـcreated_by هنا موثوق
  -- بنيوياً بمجرد وجود الصف — لا اعتماد على source كقيمة وحيدة للثقة.
  select report_date::timestamptz, summary, items, created_by, created_at
    into v_report_date, v_report_summary, v_report_items, v_report_created_by, v_report_created_at
  from public.ameen_warehouse_stock_reports
  where id = p_source_report_id;

  if not found then
    raise exception 'inventory_recon: تقرير مخزون المستودع (%) غير موجود', p_source_report_id;
  end if;

  -- دفاع مضاعف: حتى لو أُنشئ الصف فعلاً بجدول ameen_warehouse_stock_reports،
  -- نتحقق مجدداً أن created_by يطابق حساب المزامنة الموثوق عبر auth.users —
  -- يحمي من أي خطأ مستقبلي بسياسة INSERT الخاصة بذلك الجدول بلا اعتماد
  -- كامل على RLS طبقة واحدة فقط.
  if not public.inventory_recon_warehouse_stock_report_is_trusted(v_report_created_by) then
    raise exception 'inventory_recon: تقرير مخزون المستودع (%) ليس من حساب المزامنة الموثوق', p_source_report_id;
  end if;

  -- مراجعة Codex على PR #40: فحص حداثة التقرير يجب أن يُطبَّق داخل RPC على
  -- الخادم أيضاً (فحص الواجهة إضافي فقط ويمكن تجاوزه من طلب مباشر).
  -- نعتمد summary.generated_at إن وُجد (وقت السحب الفعلي من الأمين)، وإلا
  -- created_at كبديل، ونرفض أي تقرير أقدم من 24 ساعة.
  v_report_generated_at := nullif(v_report_summary ->> 'generated_at', '')::timestamptz;
  v_report_freshness_at := coalesce(v_report_generated_at, v_report_created_at);
  if v_report_freshness_at is null or v_report_freshness_at < now() - interval '24 hours' then
    raise exception 'inventory_recon: تقرير مخزون المستودع (%) أقدم من 24 ساعة — اسحب تقريراً جديداً قبل إنشاء الجلسة', p_source_report_id;
  end if;

  if coalesce(v_report_summary ->> 'warehouseKey', '') <> p_warehouse_key then
    raise exception 'inventory_recon: تقرير المخزون المحدد لا يطابق المستودع المختار (%)', p_warehouse_key;
  end if;

  if v_report_items is null or jsonb_typeof(v_report_items) <> 'array' then
    raise exception 'inventory_recon: تقرير مخزون المستودع لا يحوي بيانات أصناف صالحة';
  end if;

  -- محتوى الطلب (item_key + actual_qty + reason فقط — هذا ما يملكه العميل
  -- فعلياً) يُستخدم لبناء بصمة idempotency ولمقارنة أي تكرار لاحقاً بنفس المفتاح.
  select md5(string_agg(
           coalesce(line ->> 'item_key', '') || '|' ||
           coalesce(trim_scale(nullif(line ->> 'actual_qty', '')::numeric)::text, '') || '|' ||
           coalesce(line ->> 'reason', ''),
           E'\n' order by line ->> 'item_key'
         ))
    into v_new_digest
  from jsonb_array_elements(p_lines) as line;

  -- تحقق أن كل item_key أرسله العميل موجود فعلاً في التقرير الموثوق —
  -- وإلا يُرفض الطلب بالكامل بدل تجاهل السطر المجهول بصمت.
  select string_agg(k, ', ')
    into v_missing_keys
  from (
    select distinct line ->> 'item_key' as k
    from jsonb_array_elements(p_lines) as line
    where not exists (
      select 1
      from jsonb_array_elements(v_report_items) as it
      where coalesce(it ->> 'itemKey', it ->> 'item_key') = (line ->> 'item_key')
    )
  ) missing;

  if v_missing_keys is not null then
    raise exception 'inventory_recon: الأصناف التالية غير موجودة في تقرير المستودع الموثوق: %', v_missing_keys;
  end if;

  -- idempotency: التفرد على (created_by, idempotency_key) — لا يمكن أبداً
  -- أن نرجع جلسة مستخدم آخر. النسخة السابقة كانت SELECT ثم INSERT منفصلين —
  -- بينهما نافذة سباق: طلبان متزامنان بنفس المفتاح كلاهما يجد "not found" ثم
  -- يحاول الإدخال، فيفشل أحدهما بخطأ تعارض قيد فريد خام بدل رسالة idempotency
  -- واضحة. INSERT ... ON CONFLICT DO NOTHING RETURNING * ذرّي على مستوى
  -- القاعدة: يضمن أن إدخالاً واحداً فقط ينجح مهما تزامنت الطلبات.
  insert into public.inventory_recon_sessions
    (session_date, session_month, warehouse_key, warehouse_name, notes, idempotency_key,
     source_report_id, source_report_date, status, created_by)
  values
    (p_session_date, p_session_month, p_warehouse_key, p_warehouse_name, p_notes, p_idempotency_key,
     p_source_report_id, v_report_date, 'draft', auth.uid())
  on conflict (created_by, idempotency_key) do nothing
  returning * into v_session;

  if not found then
    -- تعارض: مفتاح idempotency مستخدم مسبقاً (بهذا الطلب أو بطلب متزامن سبقنا
    -- بمايكروثانية). نتحقق أن المستودع/الشهر/التقرير المصدر/محتوى السطور
    -- مطابقة تماماً؛ خلاف ذلك نرفض بخطأ واضح بدل نجاح وهمي يعيد جلسة قديمة
    -- لا تطابق الطلب الجديد.
    select * into v_existing
    from public.inventory_recon_sessions
    where created_by = auth.uid()
      and idempotency_key = p_idempotency_key;

    if v_existing.warehouse_key is distinct from p_warehouse_key
       or v_existing.session_month is distinct from p_session_month
       or v_existing.source_report_id is distinct from p_source_report_id
    then
      raise exception 'inventory_recon: مفتاح idempotency % مستخدم مسبقاً لجلسة مختلفة (مستودع/شهر/تقرير مصدر مختلف) — أعد تحميل الصفحة وحاول من جديد', p_idempotency_key;
    end if;

    select md5(string_agg(
             coalesce(item_key, '') || '|' ||
             coalesce(trim_scale(actual_qty)::text, '') || '|' ||
             coalesce(reason, ''),
             E'\n' order by item_key
           ))
      into v_existing_digest
    from public.inventory_recon_lines
    where session_id = v_existing.id;

    if v_existing_digest is distinct from v_new_digest then
      raise exception 'inventory_recon: مفتاح idempotency % مستخدم مسبقاً بمحتوى سطور مختلف — أعد تحميل الصفحة وحاول من جديد', p_idempotency_key;
    end if;

    return v_existing;
  end if;

  -- مطابقة تكلفة item_costs تتبع نفس أولوية المفتاح المستعملة عند كتابته في
  -- tools/push-item-costs.ps1، لكن بعد فصل العمودين في ترحيل
  -- 20260827110325_fix_item_costs_true_guid.sql صار لكل عمود دلالة مختلفة:
  --   * item_costs.item_guid  = GUID الأمين الحقيقي فقط، أو NULL.
  --   * item_costs.match_key  = مفتاح منع التكرار (GUID أو كود أو اسم)، non-null دائماً.
  --
  -- ⚠️ إصلاح ملاحظة Codex P1 على PR #126: قبل هذا الإصلاح بقي الرجوعان بالكود
  -- وبالاسم يستعلمان العمود item_guid، وهو عمود لا يحوي كوداً ولا اسماً إطلاقاً
  -- بعد الترحيل — فكان كل صنف تعذّر على push-item-costs.ps1 إيجاد GUID أمين
  -- حقيقي له (item_guid = NULL) يسقط من كل مسارات المطابقة بصمت، فيأخذ
  -- unit_cost وcurrency فارغَين وتفسد قيمة التسوية دون أي خطأ ظاهر.
  --
  -- الترتيب الصحيح بعد الفصل:
  --   1) item_guid = GUID الصنف            (المسار المباشر الدقيق)
  --   2) match_key = GUID الصنف            (صفوف كُتبت قبل تشغيل push التالي،
  --      فالـGUID فيها ما يزال في match_key وitem_guid لم يُملأ بعد)
  --   3) match_key = رقم/كود الصنف         (رجوع بالكود)
  --   4) item_name = اسم الصنف             (رجوع بالاسم على العمود المخصَّص،
  --      غير حسّاس لحالة الأحرف والفراغات)
  --
  -- ⚠️ إصلاح ملاحظة Codex P1 الثانية على PR #126: الرجوع بالاسم يجب أن يكون على
  -- العمود المخصَّص item_name لا على match_key. السبب أن match_key يحمل كود الأمين
  -- حين يتوفّر كود بلا GUID، والكود يأتي من عمود Code/MaterialCode/ItemCode/Barcode
  -- في view التكلفة، بينما تقرير المخزون يرسل itemNumber من عمود mt.Number المختلف
  -- (tools/push-ameen-warehouse-stock.ps1) — فلا المسار (3) ولا رجوع بالاسم على
  -- match_key يلتقط تلك الصفوف. أما item_name فيكتبه push-item-costs.ps1 لكل صف
  -- ويضمن عدم فراغه (يُصفّي الأسماء الفارغة في مصدره)، فهو مفتاح الرجوع المتوافق.
  insert into public.inventory_recon_lines
    (session_id, item_key, item_number, item_name, unit_name, system_qty, actual_qty, unit_cost, currency, reason)
  select
    v_session.id,
    it ->> 'itemKey' as item_key,
    coalesce(it ->> 'itemNumber', it ->> 'item_number') as item_number,
    coalesce(it ->> 'itemName', it ->> 'item_name') as item_name,
    coalesce(it ->> 'unitName', it ->> 'unit_name') as unit_name,
    coalesce((coalesce(it ->> 'qty', it ->> 'stockQty', it ->> 'stock_qty'))::numeric, 0) as system_qty,
    nullif(line ->> 'actual_qty', '')::numeric as actual_qty,
    ic.avg_cost as unit_cost,
    -- item_costs.currency تُخزَّن حرفياً "$" من push-item-costs.ps1 (لا "USD")
    -- — بدون هذا التطبيع كانت كل الأسعار المشتقة ترفض قيد التحقق على العملة.
    case
      when ic.currency in ('$', 'USD', 'usd') then 'USD'
      when ic.currency in ('SYP', 'syp', 'ل.س') then 'SYP'
      else null
    end as currency,
    line ->> 'reason' as reason
  from jsonb_array_elements(p_lines) as line
  join jsonb_array_elements(v_report_items) as it
    on coalesce(it ->> 'itemKey', it ->> 'item_key') = (line ->> 'item_key')
  left join lateral (
    select ic1.avg_cost, ic1.currency
    from public.item_costs ic1
    where ic1.item_guid = nullif(trim(coalesce(it ->> 'itemGuid', it ->> 'item_guid', '')), '')
    limit 1
  ) ic_by_guid on true
  left join lateral (
    select ic2.avg_cost, ic2.currency
    from public.item_costs ic2
    where ic_by_guid.avg_cost is null
      and ic2.match_key = nullif(trim(coalesce(it ->> 'itemGuid', it ->> 'item_guid', '')), '')
    limit 1
  ) ic_by_legacy_guid on true
  left join lateral (
    select ic3.avg_cost, ic3.currency
    from public.item_costs ic3
    where ic_by_guid.avg_cost is null
      and ic_by_legacy_guid.avg_cost is null
      and ic3.match_key = nullif(trim(coalesce(it ->> 'itemNumber', it ->> 'item_number', '')), '')
    limit 1
  ) ic_by_number on true
  left join lateral (
    select ic4.avg_cost, ic4.currency
    from public.item_costs ic4
    where ic_by_guid.avg_cost is null
      and ic_by_legacy_guid.avg_cost is null
      and ic_by_number.avg_cost is null
      and lower(trim(ic4.item_name)) = lower(nullif(trim(coalesce(it ->> 'itemName', it ->> 'item_name', '')), ''))
    limit 1
  ) ic_by_name on true
  left join lateral (
    select coalesce(ic_by_guid.avg_cost, ic_by_legacy_guid.avg_cost, ic_by_number.avg_cost, ic_by_name.avg_cost) as avg_cost,
           coalesce(ic_by_guid.currency, ic_by_legacy_guid.currency, ic_by_number.currency, ic_by_name.currency) as currency
  ) ic on true;

  -- تحقق ذرّي أن كل مفتاح صنف فريد طلبه العميل فعلاً أُدرج كسطر — الـjoin
  -- أعلاه يُسقط بصمت أي item_key كان قد اجتاز فحص v_missing_keys لكن لسبب
  -- آخر (تكرار v_report_items لنفس itemKey، تعارض unique(session_id,item_key)
  -- من صف كُتب بالتزامن، إلخ) لم يُدرج فعلاً؛ بدون هذا الفحص تنجح الدالة
  -- وترجع جلسة أنقص من الطلب الأصلي بصمت.
  select count(distinct line ->> 'item_key') into v_requested_distinct_count
  from jsonb_array_elements(p_lines) as line;

  select count(*) into v_inserted_count
  from public.inventory_recon_lines
  where session_id = v_session.id;

  if v_inserted_count <> v_requested_distinct_count then
    raise exception 'inventory_recon: عدد السطور المُدرجة (%) لا يطابق عدد الأصناف المطلوبة (%) — تراجع كامل عن إنشاء الجلسة', v_inserted_count, v_requested_distinct_count;
  end if;

  return v_session;
end;
$$;

revoke execute on function inventory_recon_create_session_with_lines(date, date, text, text, text, text, uuid, jsonb) from public;
revoke execute on function inventory_recon_create_session_with_lines(date, date, text, text, text, text, uuid, jsonb) from anon;
grant execute on function inventory_recon_create_session_with_lines(date, date, text, text, text, text, uuid, jsonb) to authenticated;
