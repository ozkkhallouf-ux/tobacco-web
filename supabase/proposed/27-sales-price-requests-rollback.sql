-- تراجع Migration 27. يحذف الجدول بما فيه من طلبات تسعير — لا يُشغَّل إلا بموافقة صريحة من المالك
-- وبعد تصدير الطلبات إن وُجدت. لا يمسّ أي جدول آخر.
begin;

do $$ begin
  if to_regclass('public.sales_price_requests') is null then
    raise exception 'migration 27 is not applied';
  end if;
end $$;

drop function if exists public.sales_price_request_cancel(bigint, integer, text);
drop function if exists public.sales_price_request_mark_entered(bigint, integer, text);
drop function if exists public.sales_price_request_price(bigint, integer, numeric[], numeric);
drop function if exists public.sales_price_request_submit(text, text, text, jsonb, numeric, text);
drop table public.sales_price_requests;
drop function if exists public.sales_price_requests_lines_total(jsonb);
drop function if exists public.sales_price_requests_clean_lines(jsonb, boolean);
drop function if exists public.sales_price_requests_actor_ok();

commit;
