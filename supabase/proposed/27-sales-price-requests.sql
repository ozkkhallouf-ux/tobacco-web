-- Migration 27: فواتير بانتظار تسعير المالك قبل إدخالها في الأمين (طلب عمر 2026-11-05).
--
-- الدورة:
--   submitted (المحاسب يرسل الأصناف والكميات، والأسعار مقترحة من النشرة)
--     → priced (المالك يعتمد الأسعار) → entered (المحاسب أدخلها يدوياً في الأمين ورقمها)
--   cancelled من أي حالة قبل entered.
--
-- قواعد ثابتة:
--   * لا شيء هنا يكتب في الأمين. الإدخال في الأمين يدوي، والجدول يسجّل رقمه فقط.
--   * لا INSERT/UPDATE/DELETE مباشر لأي دور؛ كل تغيير عبر دوال SECURITY DEFINER تتحقق من الدور والحالة والنسخة.
--   * التسعير للمالك وحده (is_owner)، ولا يغيّر الأصناف ولا الكميات — الأسعار والحسم فقط.
--   * الإجماليات تُحسب في الخادم من الأسطر، لا تُقبل من المتصفح.
--   * القراءة: الطاقم (is_staff) عدا موظف الجرد. لا شيء لـ anon.
--   * الهجرة لا تمسّ أي جدول قائم ولا أي بيانات.

begin;

do $$ begin
  if to_regclass('public.sales_price_requests') is not null then
    raise exception 'migration 27 guard: already applied (public.sales_price_requests exists)';
  end if;
end $$;

create table public.sales_price_requests (
  id bigint generated always as identity primary key,
  status text not null default 'submitted'
    check (status in ('submitted', 'priced', 'entered', 'cancelled')),
  mode text not null check (mode in ('jumla', 'mufrak')),
  rate numeric check (rate is null or rate > 0),
  customer_name text not null default '' check (length(customer_name) <= 120),
  pay_method text not null default 'credit' check (pay_method in ('cash', 'credit')),
  note text not null default '' check (length(note) <= 500),
  requested_lines jsonb not null check (jsonb_typeof(requested_lines) = 'array'),
  lines jsonb not null check (jsonb_typeof(lines) = 'array'),
  total numeric not null default 0,
  discount numeric not null default 0 check (discount >= 0),
  net numeric not null default 0,
  version integer not null default 1,
  created_by uuid not null,
  created_by_email text not null default '',
  created_at timestamptz not null default now(),
  priced_by uuid,
  priced_at timestamptz,
  ameen_bill_no text check (ameen_bill_no is null or length(ameen_bill_no) between 1 and 40),
  entered_by uuid,
  entered_by_email text,
  entered_at timestamptz,
  cancelled_by uuid,
  cancelled_at timestamptz,
  cancel_reason text check (cancel_reason is null or length(cancel_reason) <= 300),
  updated_at timestamptz not null default now()
);

create index sales_price_requests_status_idx on public.sales_price_requests (status, created_at desc);

alter table public.sales_price_requests enable row level security;
alter table public.sales_price_requests force row level security;

revoke all on table public.sales_price_requests from public, anon, authenticated;
grant select on table public.sales_price_requests to authenticated;

create policy sales_price_requests_staff_select on public.sales_price_requests
  for select to authenticated
  using (
    (select public.is_staff())
    and (select lower(coalesce(auth.jwt() -> 'app_metadata' ->> 'role', ''))) <> 'inventory_counter'
  );

-- ---------------------------------------------------------------------------
-- مساعدات داخلية
-- ---------------------------------------------------------------------------
create function public.sales_price_requests_actor_ok() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_staff()
     and lower(coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '')) <> 'inventory_counter'
     and auth.uid() is not null;
$$;

-- يطبّع أسطر المحاسب ويرفض أي سطر غير صالح. الأسعار المقترحة اختيارية (≥ 0).
create function public.sales_price_requests_clean_lines(p_lines jsonb, p_require_price boolean)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  v_line jsonb; v_out jsonb := '[]'::jsonb; v_qty numeric; v_price numeric; v_name text; v_unit text;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then raise exception 'lines_invalid'; end if;
  if jsonb_array_length(p_lines) = 0 then raise exception 'lines_required'; end if;
  if jsonb_array_length(p_lines) > 200 then raise exception 'too_many_lines'; end if;
  for v_line in select value from jsonb_array_elements(p_lines) loop
    if jsonb_typeof(v_line) <> 'object' then raise exception 'line_invalid'; end if;
    v_name := btrim(coalesce(v_line ->> 'name', ''));
    v_unit := coalesce(v_line ->> 'unitKey', '');
    begin
      v_qty := (v_line ->> 'qty')::numeric;
      v_price := coalesce(nullif(v_line ->> 'price', '')::numeric, 0);
    exception when others then raise exception 'line_number_invalid';
    end;
    if v_name = '' or length(v_name) > 200 then raise exception 'line_name_invalid'; end if;
    if v_unit not in ('unit1', 'unit2') then raise exception 'line_unit_invalid'; end if;
    if v_qty is null or v_qty <= 0 or v_qty > 1000000 then raise exception 'line_qty_invalid'; end if;
    if v_price < 0 or v_price > 1000000000 then raise exception 'line_price_invalid'; end if;
    if p_require_price and v_price <= 0 then raise exception 'line_price_required'; end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'key', left(coalesce(v_line ->> 'key', ''), 200),
      'num', left(coalesce(v_line ->> 'num', ''), 40),
      'name', v_name,
      'unit', left(coalesce(v_line ->> 'unit', ''), 40),
      'unitKey', v_unit,
      'qty', v_qty,
      'price', v_price,
      'total', round(v_qty * v_price, 2)
    ));
  end loop;
  return v_out;
end; $$;

create function public.sales_price_requests_lines_total(p_lines jsonb) returns numeric
language sql immutable set search_path = '' as $$
  select coalesce(round(sum((l ->> 'total')::numeric), 2), 0) from jsonb_array_elements(p_lines) l;
$$;

-- ---------------------------------------------------------------------------
-- 1) إرسال للتسعير (الطاقم)
-- ---------------------------------------------------------------------------
create function public.sales_price_request_submit(
  p_mode text, p_customer_name text, p_pay_method text, p_lines jsonb, p_rate numeric default null, p_note text default ''
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_lines jsonb; v_total numeric; v_id bigint; v_customer text := btrim(coalesce(p_customer_name, ''));
begin
  if not public.sales_price_requests_actor_ok() then raise exception 'not_allowed' using errcode = '42501'; end if;
  if p_mode not in ('jumla', 'mufrak') then raise exception 'mode_invalid'; end if;
  if coalesce(p_pay_method, '') not in ('cash', 'credit') then raise exception 'pay_method_invalid'; end if;
  if p_mode = 'mufrak' and not (coalesce(p_rate, 0) > 0) then raise exception 'rate_required'; end if;
  v_lines := public.sales_price_requests_clean_lines(p_lines, false);
  v_total := public.sales_price_requests_lines_total(v_lines);
  insert into public.sales_price_requests
    (mode, rate, customer_name, pay_method, note, requested_lines, lines, total, discount, net, created_by, created_by_email)
  values
    (p_mode, case when p_mode = 'mufrak' then p_rate end, left(v_customer, 120), p_pay_method,
     left(btrim(coalesce(p_note, '')), 500), v_lines, v_lines, v_total, 0, v_total,
     auth.uid(), lower(coalesce(auth.jwt() ->> 'email', '')))
  returning id into v_id;

  begin
    perform public.notify_telegram(
      'sales_price_request',
      format(E'📝 فاتورة بانتظار تسعيرك #%s\nالزبون: %s\nالأصناف: %s\nمن: %s',
        v_id, coalesce(nullif(v_customer, ''), 'نقدي'), jsonb_array_length(v_lines),
        coalesce(nullif(auth.jwt() ->> 'email', ''), 'موظف')),
      'sales-price-request:' || v_id, 0);
  exception when others then null; -- الإشعار best-effort ولا يُسقط حفظ الطلب
  end;

  return jsonb_build_object('id', v_id, 'status', 'submitted', 'version', 1);
end; $$;

-- ---------------------------------------------------------------------------
-- 2) اعتماد التسعير (المالك وحده) — الأسعار والحسم فقط، بنفس ترتيب الأسطر.
-- ---------------------------------------------------------------------------
create function public.sales_price_request_price(
  p_id bigint, p_version integer, p_prices numeric[], p_discount numeric default 0
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.sales_price_requests; v_in jsonb := '[]'::jsonb; v_lines jsonb; v_total numeric; v_disc numeric := coalesce(p_discount, 0); i integer;
begin
  if not public.is_owner() then raise exception 'owner_only' using errcode = '42501'; end if;
  select * into r from public.sales_price_requests where id = p_id for update;
  if not found then raise exception 'not_found'; end if;
  if r.status not in ('submitted', 'priced') then raise exception 'status_locked'; end if;
  if r.version <> p_version then raise exception 'version_conflict'; end if;
  if p_prices is null or cardinality(p_prices) <> jsonb_array_length(r.lines) then raise exception 'prices_length_mismatch'; end if;
  for i in 0 .. jsonb_array_length(r.lines) - 1 loop
    v_in := v_in || jsonb_build_array(jsonb_set(r.lines -> i, '{price}', to_jsonb(p_prices[i + 1])));
  end loop;
  v_lines := public.sales_price_requests_clean_lines(v_in, true);
  v_total := public.sales_price_requests_lines_total(v_lines);
  if v_disc < 0 or v_disc > v_total then raise exception 'discount_invalid'; end if;
  update public.sales_price_requests
     set lines = v_lines, total = v_total, discount = v_disc, net = v_total - v_disc,
         status = 'priced', priced_by = auth.uid(), priced_at = now(),
         version = version + 1, updated_at = now()
   where id = p_id;
  return jsonb_build_object('id', p_id, 'status', 'priced', 'version', r.version + 1, 'net', v_total - v_disc);
end; $$;

-- ---------------------------------------------------------------------------
-- 3) تم الإدخال في الأمين (الطاقم) — يسجّل رقم فاتورة الأمين فقط.
-- ---------------------------------------------------------------------------
create function public.sales_price_request_mark_entered(p_id bigint, p_version integer, p_ameen_bill_no text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.sales_price_requests; v_no text := btrim(coalesce(p_ameen_bill_no, ''));
begin
  if not public.sales_price_requests_actor_ok() then raise exception 'not_allowed' using errcode = '42501'; end if;
  if v_no = '' or length(v_no) > 40 then raise exception 'ameen_bill_no_required'; end if;
  select * into r from public.sales_price_requests where id = p_id for update;
  if not found then raise exception 'not_found'; end if;
  if r.status <> 'priced' then raise exception 'not_priced'; end if;
  if r.version <> p_version then raise exception 'version_conflict'; end if;
  update public.sales_price_requests
     set status = 'entered', ameen_bill_no = v_no, entered_by = auth.uid(),
         entered_by_email = lower(coalesce(auth.jwt() ->> 'email', '')), entered_at = now(),
         version = version + 1, updated_at = now()
   where id = p_id;
  return jsonb_build_object('id', p_id, 'status', 'entered', 'version', r.version + 1);
end; $$;

-- ---------------------------------------------------------------------------
-- 4) إلغاء: صاحب الطلب قبل التسعير، أو المالك قبل الإدخال في الأمين.
-- ---------------------------------------------------------------------------
create function public.sales_price_request_cancel(p_id bigint, p_version integer, p_reason text default '')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.sales_price_requests; v_owner boolean := public.is_owner();
begin
  if not public.sales_price_requests_actor_ok() then raise exception 'not_allowed' using errcode = '42501'; end if;
  select * into r from public.sales_price_requests where id = p_id for update;
  if not found then raise exception 'not_found'; end if;
  if r.version <> p_version then raise exception 'version_conflict'; end if;
  if r.status in ('entered', 'cancelled') then raise exception 'status_locked'; end if;
  if not v_owner and (r.created_by <> auth.uid() or r.status <> 'submitted') then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  update public.sales_price_requests
     set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(),
         cancel_reason = left(btrim(coalesce(p_reason, '')), 300),
         version = version + 1, updated_at = now()
   where id = p_id;
  return jsonb_build_object('id', p_id, 'status', 'cancelled', 'version', r.version + 1);
end; $$;

revoke all on function public.sales_price_requests_actor_ok() from public, anon;
revoke all on function public.sales_price_requests_clean_lines(jsonb, boolean) from public, anon, authenticated;
revoke all on function public.sales_price_requests_lines_total(jsonb) from public, anon, authenticated;
revoke all on function public.sales_price_request_submit(text, text, text, jsonb, numeric, text) from public, anon;
revoke all on function public.sales_price_request_price(bigint, integer, numeric[], numeric) from public, anon;
revoke all on function public.sales_price_request_mark_entered(bigint, integer, text) from public, anon;
revoke all on function public.sales_price_request_cancel(bigint, integer, text) from public, anon;
grant execute on function public.sales_price_requests_actor_ok() to authenticated;
grant execute on function public.sales_price_request_submit(text, text, text, jsonb, numeric, text) to authenticated;
grant execute on function public.sales_price_request_price(bigint, integer, numeric[], numeric) to authenticated;
grant execute on function public.sales_price_request_mark_entered(bigint, integer, text) to authenticated;
grant execute on function public.sales_price_request_cancel(bigint, integer, text) to authenticated;

commit;
