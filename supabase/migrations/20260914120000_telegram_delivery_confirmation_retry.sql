-- المرحلة ب: تأكيد تسليم تيليغرام الحقيقي + إعادة المحاولة
-- (رد على ملاحظة Codex P1 على PR #220، تعليق على dispatch_telegram_outbox
--  في supabase/telegram-notifications.sql:484 من نسخة PR الأصلية)
--
-- المرحلة أ (migration: telegram_delivery_observability، 2026-08-31) رصدت
-- المشكلة فقط دون تغيير سلوك: status='sent' كانت تُكتب فور استدعاء
-- net.http_post غير المتزامن، بلا أي تحقق من ردّ تيليغرام الفعلي. قياس
-- الإنتاج وقتها: 241 رسالة معلَّمة sent مقابل 230 رداً ناجحاً فعلياً من
-- تيليغرام خلال 6 ساعات — 11 رسالة (4.6%) فشل تسليمها الحقيقي ولم تُعَد أبداً.
--
-- هذه الهجرة تنفّذ الإصلاح الحقيقي:
--   ١) توسيع قيد telegram_outbox.status ليقبل 'dispatched' — حالة انتقالية
--      جديدة بين "أُرسل الطلب لِـ pg_net" و"تأكّد تيليغرام أنه استلمه".
--   ٢) إعادة تعريف dispatch_telegram_outbox() بحلقتين: مطابقة أولاً على
--      الصفوف dispatched من الدورة السابقة (بنفس منطق تصنيف
--      telegram_delivery_audit)، ثم إرسال كالمعتاد لكن بحالة ناتجة
--      'dispatched' لا 'sent'. الفشل الحقيقي يعيد الصف إلى 'pending'
--      (حتى 5 محاولات) ثم 'failed' نهائياً بعدها.
--
-- لا تغيير على notify_telegram()/دالة التصنيف telegram_delivery_audit()/
-- private.safe_jsonb() — هذه الثلاثة تبقى كما في المرحلة أ تماماً.

alter table public.telegram_outbox drop constraint if exists telegram_outbox_status_check;
alter table public.telegram_outbox add constraint telegram_outbox_status_check
  check (status in ('pending','dispatched','sent','failed'));

create or replace function public.dispatch_telegram_outbox()
returns void
language plpgsql security definer
set search_path to 'public', 'net', 'vault', 'extensions'
as $$
declare
  r             record;
  tok           text;
  chat          bigint;
  body          jsonb;
  rid           bigint;
  v_delivery    text;
  max_attempts  constant int := 5;
begin
  -- ١) حلقة المطابقة: تصنيف الصفوف المُرسَلة سابقاً حسب ردّها الحقيقي
  for r in
    select o.id, o.attempts, resp.status_code, resp.timed_out, resp.error_msg, resp.content
    from public.telegram_outbox o
    left join net._http_response resp on resp.id = o.net_request_id
    where o.status = 'dispatched'
  loop
    v_delivery := case
      when r.status_code is null and r.error_msg is null and not coalesce(r.timed_out, false)
        then 'no_response'   -- لم يصل ردّ pg_net بعد — انتظر الدورة التالية
      when r.timed_out or r.error_msg is not null
        then 'network_error'
      when r.status_code between 200 and 299
        then case
          when (private.safe_jsonb(r.content) ->> 'ok') = 'true' then 'ok_true'
          when private.safe_jsonb(r.content) is null then 'unparsed'
          else 'ok_false'
        end
      else 'http_error'
    end;

    if v_delivery = 'no_response' then
      continue; -- يبقى 'dispatched'، لا تغيير
    elsif v_delivery = 'ok_true' then
      update public.telegram_outbox set status = 'sent', sent_at = now() where id = r.id;
    elsif r.attempts < max_attempts then
      update public.telegram_outbox set status = 'pending' where id = r.id; -- إعادة محاولة
    else
      update public.telegram_outbox set status = 'failed' where id = r.id; -- استنفدت المحاولات
    end if;
  end loop;

  -- ٢) حلقة الإرسال: كما كانت تماماً، فقط الحالة الناتجة 'dispatched' لا 'sent'
  select decrypted_secret into tok
  from vault.decrypted_secrets where name = 'telegram_bot_token' limit 1;
  if tok is null then return; end if;

  select value::bigint into chat
  from public.bot_config where key = 'owner_chat_id' limit 1;
  if chat is null then return; end if;

  for r in
    select id, message, reply_markup from public.telegram_outbox
    where status = 'pending'
    order by created_at asc
    limit 20  -- ضمن حدود تيليغرام
  loop
    body := jsonb_build_object('chat_id', chat, 'text', r.message);
    if r.reply_markup is not null then
      body := body || jsonb_build_object('reply_markup', r.reply_markup);
    end if;
    rid := net.http_post(
      url     := 'https://api.telegram.org/bot' || tok || '/sendMessage',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body    := body
    );
    update public.telegram_outbox
    set status = 'dispatched', sent_at = now(), attempts = attempts + 1, net_request_id = rid
    where id = r.id;
  end loop;
end;
$$;
