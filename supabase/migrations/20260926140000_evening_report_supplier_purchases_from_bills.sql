-- «🛒 مشتريات الموردين اليوم» في التقرير المسائي تُقرأ من فواتير الشراء الفعلية
-- في الأمين، لا من «دفعات» حسابات الموردين.
--
-- العطل (مُثبت قراءةً على AmnDb002، 2026-09-26): القسم 2ج في send_evening_report
-- كان يعرض كل عنصر recentPayments بتاريخ اليوم لحساب isSupplier=true من تقرير
-- ameen_customer_balances. واستعلام الأرصدة يعدّ للموردين «دفعةً» كلَّ سطر دائن
-- (Credit > 0 AND Type = 0) على حساب أبوه «الموردون» أياً كان مستنده. فدخل
-- «المشتريات»: سند قبض نقدي من المورد (مقابله صندوق من شجرة 13)، والقيد
-- الافتتاحي، وقيود يدوية (مقابل صندوق أو مصاريف أو حسم مكتسب)، ومرتجع مبيعات
-- ودفعة أولى لفاتورة مبيعات على حساب مورد. وفي المقابل غابت فواتير شراء حقيقية
-- حسابها خارج شجرة «الموردون» أو نقدية. تدقيق 2026-07-01 → 2026-09-26:
-- 171 سطراً معروضاً، منها 30 ليست شراءً (515,454.60$)، و24 فاتورة شراء غائبة.
--
-- التعريف المعتمد: الشراء = فاتورة bu000 نوعها TypeGUID «مشتريات»
-- (91377a56-ebfc-48c0-b79e-72063e1d7e3a)، والمرتجع = نوع «مرتجع مشتريات»
-- (c9aca8fe-f50e-46eb-91ac-29ee32acbb3e). هذه بالضبط بيانات
-- ameen_purchase_invoice_reports التي يكتبها tools/pull-purchase-invoices-from-ameen.ps1
-- كل 15 دقيقة (invoices[].isReturn يميّز النوعين). لا اسم مورد ولا مبلغ ولا تاريخ
-- مُثبّت هنا.
--
-- قرارات العرض (موافقة المالك 2026-09-26):
--   • القيمة = إجمالي الفاتورة (total) قبل الحسم؛ لا يُحتسب الحسم دفعةً ولا تسوية.
--   • المرتجعات رسالة مستقلة واضحة، لا تُطرح بصمت من إجمالي المشتريات.
--   • فاتورة بلا اسم مورد تُعرض تحت «نقدي بلا مورد».
--   • تقرير قديم أو مفقود أو غير صالح ⇒ تحذير صريح «تعذّر الحكم»، لا «0 مشتريات».
--
-- النطاق: دالة صِرفة جديدة + القسم 2ج وحده داخل send_evening_report. باقي جسم
-- الدالة منسوخ حرفياً من النسخة الحيّة (pg_get_functiondef، 2026-09-26) — لا
-- تغيير على الدفعات أو المصاريف أو الطلبات أو الأسعار أو المخزون. لا كتابة على
-- الأمين، ولا لمس لـameen_customer_balances أو قاعدة دفعات الزبائن (#267/#268).

create or replace function public.evening_supplier_purchases_digest(
  p_report_created_at timestamptz,
  p_summary jsonb,
  p_items jsonb,
  p_day date,
  p_now timestamptz,
  p_max_age interval default interval '3 hours'
)
returns table(kind text, label text, amount numeric, bills integer, currency text, synced_at timestamptz)
language plpgsql
stable
set search_path = public
as $$
declare
  v_synced timestamptz;
  v_from date;
  v_bad integer;
  v_rows integer;
begin
  -- لا تقرير إطلاقاً.
  if p_report_created_at is null then
    return query select 'missing'::text, null::text, null::numeric, null::integer, null::text, null::timestamptz;
    return;
  end if;

  -- وقت المزامنة الفعلي من الأمين (summary.syncedAt)، وإلا وقت الإدراج.
  begin
    v_synced := coalesce(nullif(p_summary->>'syncedAt', '')::timestamptz, p_report_created_at);
  exception when others then
    v_synced := p_report_created_at;
  end;
  begin
    v_from := nullif(p_summary->>'fromDate', '')::date;
  exception when others then
    v_from := null;
  end;

  -- قديم أو لا يغطي اليوم أو بنيته غير صالحة ⇒ لا حكم.
  if v_synced < p_now - p_max_age
     or v_synced > p_now + interval '10 minutes'
     or (v_from is not null and v_from > p_day)
     or p_items is null or jsonb_typeof(p_items) <> 'array' then
    return query select 'stale'::text, null::text, null::numeric, null::integer, null::text, v_synced;
    return;
  end if;

  -- فاتورة لليوم بلا إجمالي رقمي ⇒ لا نعرض رقماً ناقصاً.
  select count(*) into v_bad
  from jsonb_array_elements(p_items) s,
       jsonb_array_elements(case when jsonb_typeof(s->'invoices') = 'array' then s->'invoices' else '[]'::jsonb end) b
  where left(b->>'date', 10) = to_char(p_day, 'YYYY-MM-DD')
    and jsonb_typeof(b->'total') is distinct from 'number';
  if v_bad > 0 then
    return query select 'invalid'::text, null::text, null::numeric, v_bad, null::text, v_synced;
    return;
  end if;

  return query
  with inv as (
    -- فاتورة واحدة مرة واحدة حتى لو تكررت (المفتاح guid إن وُجد).
    select distinct on (coalesce(nullif(b->>'guid', ''), s->>'name' || '|' || (b->>'number') || '|' || (b->>'total')))
      coalesce(nullif(btrim(s->>'name'), ''), 'نقدي بلا مورد') as supplier,
      (b->>'total')::numeric as total,
      coalesce(nullif(upper(btrim(b->>'currency')), ''), 'USD') as cur,
      lower(coalesce(b->>'isReturn', 'false')) = 'true' as is_return
    from jsonb_array_elements(p_items) s,
         jsonb_array_elements(case when jsonb_typeof(s->'invoices') = 'array' then s->'invoices' else '[]'::jsonb end) b
    where left(b->>'date', 10) = to_char(p_day, 'YYYY-MM-DD')
    order by coalesce(nullif(b->>'guid', ''), s->>'name' || '|' || (b->>'number') || '|' || (b->>'total'))
  )
  select case when is_return then 'return' else 'purchase' end,
         supplier, sum(total), count(*)::integer, cur, v_synced
  from inv
  group by is_return, supplier, cur
  order by is_return, sum(total) desc, supplier;

  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    return query select 'none'::text, null::text, null::numeric, 0, null::text, v_synced;
  end if;
end;
$$;

revoke execute on function public.evening_supplier_purchases_digest(timestamptz, jsonb, jsonb, date, timestamptz, interval) from public;
revoke execute on function public.evening_supplier_purchases_digest(timestamptz, jsonb, jsonb, date, timestamptz, interval) from anon;
revoke execute on function public.evening_supplier_purchases_digest(timestamptz, jsonb, jsonb, date, timestamptz, interval) from authenticated;

comment on function public.evening_supplier_purchases_digest(timestamptz, jsonb, jsonb, date, timestamptz, interval) is
  'ملخص مشتريات يوم من تقرير ameen_purchase_invoice_reports (فواتير bu000 بنوع مشتريات/مرتجع مشتريات). kind: purchase/return/none/stale/missing/invalid. القيمة إجمالي الفاتورة قبل الحسم.';

-- evening-report:begin
create or replace function public.send_evening_report()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  today text := to_char(now(), 'YYYY-MM-DD');
  sales record;
  line_sales record;
  bal_report record;
  pur_report record;
  low_count int := 0;
  out_count int := 0;
  thr numeric := 50;
  msg text;
  r record;
  chunk_no int;
  chunk_lines text;
  line_no int;
  cnt int;
  total_amt numeric;
  total_cartons numeric;
  no_factor_cnt int;
  exp_cnt int;
  exp_total numeric;
  pur_kind text;
  pur_synced timestamptz;
  pur_bills int;
  pur_totals text;
begin
  select total_sales, total_cash, total_credit, created_at
  into sales
  from public.daily_sales_summary
  where created_at::date = current_date
  order by created_at desc limit 1;

  select count(*) as cnt, coalesce(sum(line_total),0) as rev
  into line_sales
  from public.sales_line_items
  where sale_date = current_date;

  select coalesce(sum(qty / nullif(unit2_factor, 0)), 0),
         count(*) filter (where coalesce(unit2_factor, 0) <= 0)
  into total_cartons, no_factor_cnt
  from public.sales_line_items
  where sale_date = current_date;

  begin
    select value::numeric into thr from public.bot_config where key = 'low_stock_threshold' limit 1;
  exception when others then thr := 50;
  end;
  thr := coalesce(thr, 50);

  select count(*) filter (where coalesce(stock_qty,0) > 0 and stock_qty <= thr),
         count(*) filter (where coalesce(stock_qty,0) <= 0)
  into low_count, out_count
  from public.approved_price_items;

  msg := '🌙 التقرير المسائي — ' || today || chr(10) || chr(10);

  if sales.created_at is not null then
    msg := msg || '📊 إجمالي مبيعات اليوم' || chr(10)
        || 'الإجمالي: ' || to_char(sales.total_sales, 'FM999,999,990.00') || ' $'
        || ' — نقدي: ' || to_char(sales.total_cash, 'FM999,999,990.00') || ' $'
        || ' — آجل: ' || to_char(sales.total_credit, 'FM999,999,990.00') || ' $' || chr(10);
  elsif line_sales.cnt > 0 then
    msg := msg || '📊 إجمالي مبيعات اليوم (من حركة الفواتير التفصيلية)' || chr(10)
        || 'المبيعات: ' || to_char(line_sales.rev, 'FM999,999,990.00') || ' $'
        || ' — عدد حركات البيع: ' || line_sales.cnt || chr(10);
  else
    msg := msg || '📊 لسه ما وصلت حركة مبيعات اليوم من الأمين' || chr(10) || chr(10);
  end if;

  if line_sales.cnt > 0 then
    msg := msg || '📦 الكمية: ' || to_char(total_cartons, 'FM999,999,990.##') || ' كرتونة';
    if no_factor_cnt > 0 then msg := msg || ' (+' || no_factor_cnt || ' حركة بدون عامل تحويل معروف)'; end if;
    msg := msg || chr(10) || chr(10);
  end if;

  select summary, items into bal_report
  from public.inventory_reports
  where source = 'ameen_customer_balances'
  order by created_at desc limit 1;

  -- دفعات اليوم = دفعات حسابات الزبائن فقط (نستثني حسابات الموردين حسب علامة isSupplier البنيوية)
  cnt := 0; total_amt := 0;
  if bal_report.items is not null and jsonb_typeof(bal_report.items) = 'array' then
    select count(*), coalesce(sum(amt),0) into cnt, total_amt
    from (
      select nullif(p->>'amount','')::numeric as amt
      from jsonb_array_elements(bal_report.items) e,
           jsonb_array_elements(coalesce(e->'recentPayments', '[]'::jsonb)) p
      where left(p->>'date', 10) = to_char(current_date, 'YYYY-MM-DD')
        and coalesce((e->>'isSupplier')::boolean, false) = false
    ) t;
  end if;
  msg := msg || '💵 الدفعات المستلمة اليوم: ' || cnt || ' دفعة — الإجمالي ' || to_char(total_amt, 'FM999,999,990.00') || ' $' || chr(10);

  select count(*), coalesce(sum(amount),0) into exp_cnt, exp_total
  from public.expense_entries where entry_date = current_date;
  msg := msg || '🧾 المصاريف اليوم: ' || exp_cnt || ' حركة — الإجمالي ' || to_char(exp_total, 'FM999,999,990.00') || ' $' || chr(10);

  select count(*) into cnt from public.customer_requests where created_at::date = current_date;
  msg := msg || '📩 طلبات العملاء اليوم: ' || cnt;
  select count(*) into cnt from public.whatsapp_orders where created_at::date = current_date;
  if cnt > 0 then msg := msg || ' — طلبات واتساب: ' || cnt; end if;
  msg := msg || chr(10);

  select count(*) into cnt from public.price_change_log where changed_at::date = current_date;
  msg := msg || '💰 مواد تغيّر سعرها اليوم: ' || cnt || chr(10) || chr(10);

  msg := msg || '📦 المخزون الآن: ';
  if out_count = 0 and low_count = 0 then
    msg := msg || 'كل شيء تمام ✅';
  else
    msg := msg || out_count || ' نافد ⛔ — ' || low_count || ' تحت الحد ⚠️';
  end if;

  perform public.notify_telegram('evening_report', msg, 'evening:' || today, 720);

  -- 2) دفعات الزبائن (بلا موردين)
  line_no := 0; chunk_no := 0; chunk_lines := '';
  if bal_report.items is not null and jsonb_typeof(bal_report.items) = 'array' then
    for r in
      select name, amt, notes
      from (
        select e->>'name' as name,
               nullif(p->>'amount','')::numeric as amt,
               nullif(p->>'notes', '') as notes
        from jsonb_array_elements(bal_report.items) e,
             jsonb_array_elements(coalesce(e->'recentPayments', '[]'::jsonb)) p
        where left(p->>'date', 10) = to_char(current_date, 'YYYY-MM-DD')
          and coalesce((e->>'isSupplier')::boolean, false) = false
      ) x
      order by amt desc nulls last
    loop
      if line_no = 0 then
        chunk_no := chunk_no + 1;
        chunk_lines := '💵 تفاصيل دفعات اليوم (' || chunk_no || ') — ' || today || chr(10) || chr(10);
      end if;
      chunk_lines := chunk_lines || '• ' || coalesce(r.name, 'غير محدد')
          || ' — ' || coalesce(to_char(r.amt, 'FM999,999,990.00'), '—') || ' $'
          || case when r.notes is not null then ' (' || left(r.notes, 40) || ')' else '' end
          || chr(10);
      line_no := line_no + 1;
      if line_no >= 20 then
        perform public.notify_telegram('evening_report_payments', chunk_lines, 'evening-pay:' || today || ':' || chunk_no, 720);
        line_no := 0;
      end if;
    end loop;
    if line_no > 0 then
      perform public.notify_telegram('evening_report_payments', chunk_lines, 'evening-pay:' || today || ':' || chunk_no, 720);
    end if;
  end if;

  -- supplier-purchases:begin
  -- 2ج) مشتريات الموردين = فواتير شراء الأمين الفعلية (ameen_purchase_invoice_reports)،
  -- ومرتجعات المشتريات برسالة مستقلة. تقرير قديم/مفقود ⇒ تحذير صريح لا «صفر».
  -- كتلة معزولة: أي خطأ غير متوقع هنا يُبلَّغ تحذيراً ولا يُسقط بقية التقرير المسائي.
  begin
  select created_at, summary, items into pur_report
  from public.ameen_purchase_invoice_reports
  order by created_at desc limit 1;

  select d.kind, d.synced_at, d.bills into pur_kind, pur_synced, pur_bills
  from public.evening_supplier_purchases_digest(pur_report.created_at, pur_report.summary, pur_report.items, current_date, now()) d
  limit 1;

  if pur_kind in ('missing', 'stale', 'invalid') then
    perform public.notify_telegram('evening_report_purchases',
      '🛒 مشتريات الموردين اليوم — ' || today || chr(10) || chr(10)
      || '⚠️ تعذّر الحكم على مشتريات اليوم: '
      || case pur_kind
           when 'missing' then 'لا يوجد تقرير فواتير مشتريات من الأمين.'
           when 'stale' then 'تقرير فواتير المشتريات من الأمين قديم (آخر مزامنة '
                             || coalesce(to_char(pur_synced at time zone 'Asia/Damascus', 'YYYY-MM-DD HH24:MI'), 'غير معروفة') || ' بتوقيت دمشق).'
           else 'في تقرير فواتير المشتريات ' || coalesce(pur_bills, 0) || ' فاتورة لليوم بلا إجمالي صالح.'
         end
      || chr(10) || 'لم يُعرض أي رقم كي لا يُفهم خطأً أنه لا توجد مشتريات.',
      'evening-pur:' || today || ':1', 720);
  elsif pur_kind = 'none' then
    perform public.notify_telegram('evening_report_purchases',
      '🛒 مشتريات الموردين اليوم — ' || today || chr(10) || chr(10)
      || 'لا توجد فواتير شراء في الأمين اليوم (آخر مزامنة '
      || to_char(pur_synced at time zone 'Asia/Damascus', 'HH24:MI') || ' بتوقيت دمشق).',
      'evening-pur:' || today || ':1', 720);
  elsif pur_kind is not null then
    -- المشتريات: سطر لكل مورد (ولكل عملة)، والإجمالي بعملته في آخر رسالة.
    line_no := 0; chunk_no := 0; chunk_lines := '';
    select string_agg(to_char(t.amt, 'FM999,999,990.00') || ' ' || case when t.cur = 'USD' then '$' else t.cur end
                      || ' — ' || t.n || ' فاتورة', ' + ' order by t.cur)
    into pur_totals
    from (
      select d.currency as cur, sum(d.amount) as amt, sum(d.bills) as n
      from public.evening_supplier_purchases_digest(pur_report.created_at, pur_report.summary, pur_report.items, current_date, now()) d
      where d.kind = 'purchase' group by d.currency
    ) t;
    for r in
      select d.label, d.amount, d.bills, d.currency
      from public.evening_supplier_purchases_digest(pur_report.created_at, pur_report.summary, pur_report.items, current_date, now()) d
      where d.kind = 'purchase'
    loop
      if line_no = 0 then
        chunk_no := chunk_no + 1;
        chunk_lines := '🛒 مشتريات الموردين اليوم (' || chunk_no || ') — ' || today || chr(10) || chr(10);
      end if;
      chunk_lines := chunk_lines || '• ' || r.label
          || ' — ' || to_char(r.amount, 'FM999,999,990.00') || ' ' || case when r.currency = 'USD' then '$' else r.currency end
          || case when r.bills > 1 then ' (' || r.bills || ' فواتير)' else '' end
          || chr(10);
      line_no := line_no + 1;
      if line_no >= 20 then
        perform public.notify_telegram('evening_report_purchases', chunk_lines, 'evening-pur:' || today || ':' || chunk_no, 720);
        line_no := 0;
      end if;
    end loop;
    if line_no > 0 then
      chunk_lines := chunk_lines || chr(10) || 'الإجمالي (قبل الحسم): ' || pur_totals;
      perform public.notify_telegram('evening_report_purchases', chunk_lines, 'evening-pur:' || today || ':' || chunk_no, 720);
    elsif pur_totals is not null then
      perform public.notify_telegram('evening_report_purchases',
        '🛒 مشتريات الموردين اليوم — الإجمالي (قبل الحسم): ' || pur_totals,
        'evening-pur:' || today || ':total', 720);
    else
      -- مرتجعات فقط بلا أي فاتورة شراء اليوم.
      perform public.notify_telegram('evening_report_purchases',
        '🛒 مشتريات الموردين اليوم — ' || today || chr(10) || chr(10)
        || 'لا توجد فواتير شراء في الأمين اليوم (آخر مزامنة '
        || to_char(pur_synced at time zone 'Asia/Damascus', 'HH24:MI') || ' بتوقيت دمشق).',
        'evening-pur:' || today || ':1', 720);
    end if;

    -- مرتجعات المشتريات: رسالة مستقلة، لا تُطرح من إجمالي المشتريات.
    line_no := 0; chunk_no := 0; chunk_lines := '';
    for r in
      select d.label, d.amount, d.bills, d.currency
      from public.evening_supplier_purchases_digest(pur_report.created_at, pur_report.summary, pur_report.items, current_date, now()) d
      where d.kind = 'return'
    loop
      if line_no = 0 then
        chunk_no := chunk_no + 1;
        chunk_lines := '↩️ مرتجعات المشتريات اليوم (' || chunk_no || ') — ' || today || chr(10)
            || '(منفصلة عن المشتريات ولم تُطرح من إجماليها)' || chr(10) || chr(10);
      end if;
      chunk_lines := chunk_lines || '• ' || r.label
          || ' — ' || to_char(r.amount, 'FM999,999,990.00') || ' ' || case when r.currency = 'USD' then '$' else r.currency end
          || case when r.bills > 1 then ' (' || r.bills || ' فواتير)' else '' end
          || chr(10);
      line_no := line_no + 1;
      if line_no >= 20 then
        perform public.notify_telegram('evening_report_purchase_returns', chunk_lines, 'evening-pret:' || today || ':' || chunk_no, 720);
        line_no := 0;
      end if;
    end loop;
    if line_no > 0 then
      perform public.notify_telegram('evening_report_purchase_returns', chunk_lines, 'evening-pret:' || today || ':' || chunk_no, 720);
    end if;
  end if;
  exception when others then
    perform public.notify_telegram('evening_report_purchases',
      '🛒 مشتريات الموردين اليوم — ' || today || chr(10) || chr(10)
      || '⚠️ تعذّر الحكم على مشتريات اليوم: خطأ أثناء قراءة تقرير فواتير المشتريات ('
      || left(sqlerrm, 120) || ').',
      'evening-pur:' || today || ':error', 720);
  end;
  -- supplier-purchases:end

  -- 2ب) المصاريف
  line_no := 0; chunk_no := 0; chunk_lines := '';
  for r in
    select account_name, amount, notes
    from public.expense_entries
    where entry_date = current_date
    order by created_at asc
  loop
    if line_no = 0 then
      chunk_no := chunk_no + 1;
      chunk_lines := '🧾 تفاصيل المصاريف اليوم (' || chunk_no || ') — ' || today || chr(10) || chr(10);
    end if;
    chunk_lines := chunk_lines || '• ' || coalesce(r.account_name, 'غير محدد')
        || ' — ' || to_char(r.amount, 'FM999,999,990.00') || ' $'
        || case when r.notes is not null and r.notes <> '' then ' (' || left(r.notes, 50) || ')' else '' end
        || chr(10);
    line_no := line_no + 1;
    if line_no >= 20 then
      perform public.notify_telegram('evening_report_expenses', chunk_lines, 'evening-exp:' || today || ':' || chunk_no, 720);
      line_no := 0;
    end if;
  end loop;
  if line_no > 0 then
    perform public.notify_telegram('evening_report_expenses', chunk_lines, 'evening-exp:' || today || ':' || chunk_no, 720);
  end if;

  -- 3) طلبات العملاء
  line_no := 0; chunk_no := 0; chunk_lines := '';
  for r in
    select customer, request_type, channel, status
    from public.customer_requests
    where created_at::date = current_date
    order by created_at asc
  loop
    if line_no = 0 then
      chunk_no := chunk_no + 1;
      chunk_lines := '📩 تفاصيل طلبات اليوم (' || chunk_no || ') — ' || today || chr(10) || chr(10);
    end if;
    chunk_lines := chunk_lines || '• ' || coalesce(r.customer, 'غير محدد')
        || case when r.request_type is not null then ' — ' || r.request_type else '' end
        || ' — ' || case when r.status = 'closed' then 'مغلق ✅' else 'مفتوح 🟡' end
        || chr(10);
    line_no := line_no + 1;
    if line_no >= 20 then
      perform public.notify_telegram('evening_report_orders', chunk_lines, 'evening-req:' || today || ':' || chunk_no, 720);
      line_no := 0;
    end if;
  end loop;
  if line_no > 0 then
    perform public.notify_telegram('evening_report_orders', chunk_lines, 'evening-req:' || today || ':' || chunk_no, 720);
  end if;

  -- 4) تغييرات الأسعار
  line_no := 0; chunk_no := 0; chunk_lines := '';
  for r in
    select item_name, old_price, new_price
    from public.price_change_log
    where changed_at::date = current_date
    order by changed_at asc
  loop
    if line_no = 0 then
      chunk_no := chunk_no + 1;
      chunk_lines := '💰 تفاصيل تغييرات الأسعار (' || chunk_no || ') — ' || today || chr(10) || chr(10);
    end if;
    chunk_lines := chunk_lines || '• ' || coalesce(r.item_name, 'غير معروف')
        || ': ' || coalesce('$ ' || to_char(r.old_price, 'FM999,999,999,990.00'), '—')
        || ' ← ' || coalesce('$ ' || to_char(r.new_price, 'FM999,999,999,990.00'), '—')
        || chr(10);
    line_no := line_no + 1;
    if line_no >= 20 then
      perform public.notify_telegram('evening_report_prices', chunk_lines, 'evening-prc:' || today || ':' || chunk_no, 720);
      line_no := 0;
    end if;
  end loop;
  if line_no > 0 then
    perform public.notify_telegram('evening_report_prices', chunk_lines, 'evening-prc:' || today || ':' || chunk_no, 720);
  end if;
end;
$function$;
-- evening-report:end
