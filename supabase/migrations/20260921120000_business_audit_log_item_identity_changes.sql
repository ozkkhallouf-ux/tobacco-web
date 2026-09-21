-- تغيير هوية البطاقة في approved_price_items يجب أن يترك أثراً في سجل التدقيق.
--
-- العطل: `public.write_business_audit_log()` تُعفي approved_price_items وحدها
-- من التسجيل عند UPDATE ما لم تتغيّر واحدة من خمس قيم: sale_price وunit1_price
-- وunit2_price وprice_payload وnotes. الإعفاء موجود لسبب صحيح — مهمة المزامنة
-- تُحدّث stock_qty وsource_synced_at كل دقيقة، فتسجيلها كان سيُغرق السجل — لكن
-- قائمة «القيم التجارية» أغفلت العمودين اللذين يحملان **هوية** الصف:
-- item_key وitem_guid. فتغيّر أيٍّ منهما وحده يسقط في فرع الإعفاء ويمرّ صامتاً.
--
-- الدليل على أن هذا ليس افتراضياً (قياس على الإنتاج 2026-09-21): من أصل
-- 1139 حدث UPDATE مسجّلاً على approved_price_items، عدد الأحداث التي يختلف
-- فيها item_key بين before_data وafter_data = **صفر**، وكذلك item_guid =
-- **صفر** — بينما جرت فعلياً 18 هجرة item_key و10 عمليات backfill لـitem_guid.
-- أي أن الـ28 عملية غيّرت هوية صفوف ولم يبقَ منها أثر واحد في السجل.
--
-- لماذا هذا خطير تحديداً: item_guid هو مفتاح ربط الصف ببطاقة الأمين — عليه
-- تُطابَق التكاليف (push-item-costs.ps1) وعليه بُني القيد الفريد
-- approved_price_items_item_guid_unique. وitem_key هو مفتاح المطابقة مع الأمين
-- في مزامنة الأسعار. فإعادة ربط صف ببطاقة أخرى هي أخطر تعديل ممكن على هذا
-- الجدول، وهي بالضبط التعديل الوحيد الذي كان غير مرئي.
--
-- الإصلاح: شرطان إضافيان داخل فرع الإعفاء نفسه، لا أكثر. أي UPDATE يغيّر
-- item_key أو item_guid يخرج من الإعفاء ويُسجَّل.
--
-- نطاق التغيير: الفرع محكوم أصلاً بـ`tg_table_name='approved_price_items'`،
-- والإضافة داخله. الجداول الثلاثة الأخرى المعلَّق عليها نفس الـtrigger
-- (customer_credit_limits، payment_records، purchase_invoices) لا تمرّ بهذا
-- الفرع إطلاقاً، فسلوكها لا يتغيّر بحرف. أُثبت ذلك بالتنفيذ لا بالقراءة: شُغّل
-- INSERT/UPDATE-لا-يغيّر-شيئاً/UPDATE-حقيقي/DELETE على customer_credit_limits
-- بالدالة الحالية ثم بالدالة الجديدة داخل معاملة مُلغاة، والنتيجة +1/+1/+1/+1
-- في الحالتين.
--
-- الحمولة: لا تتغيّر. before_data وafter_data لقطتان كاملتان للصف أصلاً
-- (to_jsonb(old) وto_jsonb(new))، فقيمتا item_key القديمة والجديدة — وكذلك
-- item_guid — تُقرآن منهما مباشرة بلا أي تغيير في بنية الجدول أو الأعمدة.
-- وتغيّر العمودين في نفس العبارة يُنتج حدثاً واحداً يحمل الاثنين، لأن
-- الـtrigger صفّي لا عمودي. توافق رجعي كامل: لا عمود جديد ولا معنى جديد لعمود
-- قائم، فأي قارئ للسجل يبقى يعمل كما هو.
--
-- دلالة حالة الأحرف (casing): المقارنة على القيمة الخام — `(a->'item_guid') is
-- not distinct from (b->'item_guid')` — فتغيير حالة الأحرف وحده يُسجَّل. هذا
-- مقصود ومفحوص، لا سهو: القيد الفريد على upper(item_guid) يجعل **التفرّد**
-- غير حسّاس للحالة، لكنه لا يجعل إعادة كتابة القيمة المخزَّنة حدثاً عدماً —
-- وهي إعادة كتابة لا يسجّلها أي شيء آخر في المنظومة. وهي لا تُنتج ضجيجاً
-- عملياً: مسار الاستبدال ومسار الـupsert كلاهما يُقدّم الهوية المخزَّنة
-- (`guidByKey[rec.item_key]`) على الهوية الحية القادمة بأحرف صغيرة
-- (src/supabase-client.js: 1291 و1394)، فالصفوف القائمة تحتفظ بحالتها ولا
-- تُعاد كتابتها. قياس وقت الكتابة: 313 صفاً، لا صف واحد منها بحالة غير كبيرة.
--
-- ما لا يفعله هذا الملف عمداً: لا يُنشئ أحداث تدقيق تعويضية للـ28 عملية
-- التاريخية. تلك موثّقة خارجياً، واختلاق أحداث بأثر رجعي يفسد سجلاً معناه
-- الوحيد أنه يسجّل ما جرى وقت جريانه.
--
-- ملاحظة توثيقية: هذه الدالة لم تكن موجودة في المستودع إطلاقاً — أُنشئت على
-- الإنتاج بهجرة `20260816181724_business_controls_audit_and_collection_followups`
-- التي لم تُلتزم في git. الجسم أدناه هو تعريف الإنتاج الحالي حرفياً + الشرطين،
-- فهذه الهجرة تُعيد الدالة إلى المستودع كما تُصلحها.
--
-- الصلاحيات والملكية: `create or replace` يحافظ على المالك (postgres) وعلى
-- الـACL المقيّدة ({postgres=X, service_role=X} — بلا PUBLIC). لا grant هنا
-- عن قصد؛ أي إضافة صلاحية كانت ستوسّع سطح دالة SECURITY DEFINER بلا سبب.

create or replace function public.write_business_audit_log()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare b jsonb; a jsonb; eid text;
begin
  b := case when tg_op='INSERT' then null else to_jsonb(old) end;
  a := case when tg_op='DELETE' then null else to_jsonb(new) end;
  -- مخزون/وقت مزامنة السعر يتغيران آلياً؛ لا نسجلهما ما لم تتغير قيمة تجارية حساسة.
  -- هوية الصف (item_key / item_guid) قيمة تجارية حساسة: إعادة ربط صف ببطاقة
  -- أخرى تُسجَّل دائماً ولو لم يتغيّر معها أي سعر.
  if tg_table_name='approved_price_items' and tg_op='UPDATE' and
     (a->'sale_price') is not distinct from (b->'sale_price') and
     (a->'unit1_price') is not distinct from (b->'unit1_price') and
     (a->'unit2_price') is not distinct from (b->'unit2_price') and
     (a->'price_payload') is not distinct from (b->'price_payload') and
     (a->'notes') is not distinct from (b->'notes') and
     (a->'item_key') is not distinct from (b->'item_key') and
     (a->'item_guid') is not distinct from (b->'item_guid') then
    return new;
  end if;
  eid := coalesce(a->>'id',b->>'id',a->>'customer_key',b->>'customer_key',a->>'item_key',b->>'item_key');
  insert into public.business_audit_log(actor_id,actor_email,entity_table,entity_id,action,before_data,after_data)
  values (auth.uid(),coalesce(auth.jwt()->>'email',current_user),tg_table_name,eid,tg_op,b,a);
  return case when tg_op='DELETE' then old else new end;
end;
$function$;
