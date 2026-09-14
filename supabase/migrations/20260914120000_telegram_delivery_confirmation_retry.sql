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
--   ٣) ملاحظة Codex الثانية على نفس PR (بعد نشر الإصلاح أعلاه): صف بلا ردّ
--      مسجَّل (`no_response`) كان يبقى 'dispatched' إلى الأبد — لا محاولة
--      ولا فشل — حتى لو تعطّل pg_net أو انتهت نافذة استبقاء ردوده (٦ ساعات
--      موثّقة). التنظيف الدوري يحذف الصف صامتاً بعد ١٤ يوماً فيضيع التنبيه
--      كلياً بلا أثر. الإصلاح: أي صف dispatched مضى على إرساله أكثر من ١٥
--      دقيقة (هامش كبير فوق زمن استجابة تيليغرام الطبيعي وتحت نافذة الست
--      ساعات بكثير) بلا ردّ يُعامَل معاملة network_error — إعادة محاولة حتى
--      ٥ مرات ثم 'failed' (غير نهائي — انظر البند ٥).
--   ٤) ملاحظة Codex الثالثة (بعد نشر الإصلاح أعلاه): تصنيف 'ok_true' كان
--      يقبل أي رد 2xx بجسم {"ok":true} حتى بلا result.message_id — وهو
--      نفس الشكل الذي يصنّفه telegram_delivery_audit() 'unparsed' لعدم
--      إثباته استلام تيليغرام فعلياً. الإصلاح: نفس شرط message_id مطلوب
--      هنا أيضاً قبل الانتقال إلى 'sent'، وإلا يُعامَل الصف 'unparsed'
--      (يُعاد إلى 'pending' لإعادة المحاولة مثل أي فشل آخر).
--   ٥) ملاحظة Codex الرابعة: 'failed' بعد استنفاد المحاولات الخمس لم يكن
--      نهائياً فحسب بل دائماً — وintervalالمنتِج (مثل monitor_project_tasks)
--      يعتبر تنبيهه "مُرسَلاً" فور قبول الإدراج في الطابور ولا يعيد المحاولة
--      بنفسه أبداً، فعطل تيليغرام/pg_net العابر الذي يتجاوز خمس محاولات
--      (دقائق معدودة، فالمُرسِل يعمل كل دقيقة) كان يُسقط التنبيه الحرج
--      كلياً حتى بعد عودة الخدمة. الإصلاح: صف 'failed' مضى على آخر محاولة
--      له أكثر من ساعة يُعاد تلقائياً إلى 'pending' بمحاولات صفرية — دورة
--      خمس محاولات كاملة أخرى إن كانت الخدمة عادت. الحد الطبيعي الوحيد
--      المتبقي هو تنظيف الصفوف الأقدم من ١٤ يوماً.
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
  -- ٠) إحياء الفاشل نهائياً بعد تهدئة ساعة (Codex P1 الثالث، PR #220): عطل
  --    تيليغرام/pg_net عابر أطول من دورة المحاولات الخمس (تُستهلَك خلال
  --    دقائق لأن dispatch_telegram_outbox يعمل كل دقيقة) لا يجوز أن يُسقط
  --    تنبيهاً حرجاً للأبد فقط لأن الخدمة كانت متعطلة وقت الاستنفاد —
  --    وخصوصاً أن الجهة المُنتِجة (مثل monitor_project_tasks) تعتبر تنبيهها
  --    "مُرسَلاً" فور قبول الإدراج في الطابور ولا تعيد المحاولة أبداً بنفسها.
  --    تُعاد كل صف 'failed' إلى 'pending' بمحاولات صفرية بعد ساعة من آخر
  --    محاولة، فتُمنح دورة خمس محاولات كاملة أخرى إن كانت الخدمة عادت. الحد
  --    الطبيعي الوحيد المتبقي هو تنظيف الصفوف الأقدم من 14 يوماً.
  update public.telegram_outbox
  set status = 'pending', attempts = 0
  where status = 'failed'
    and sent_at < now() - interval '1 hour';

  -- ١) حلقة المطابقة: تصنيف الصفوف المُرسَلة سابقاً حسب ردّها الحقيقي
  for r in
    select o.id, o.attempts, o.sent_at, resp.status_code, resp.timed_out, resp.error_msg, resp.content
    from public.telegram_outbox o
    left join net._http_response resp on resp.id = o.net_request_id
    where o.status = 'dispatched'
  loop
    v_delivery := case
      when r.status_code is null and r.error_msg is null and not coalesce(r.timed_out, false)
        then case
          -- لم يصل ردّ pg_net بعد وما زال ضمن الهامش الطبيعي — انتظر الدورة التالية
          when r.sent_at > now() - interval '15 minutes' then 'no_response'
          -- تجاوز الهامش بلا ردّ إطلاقاً: عامله كخطأ شبكة كي لا يُهمَل نهائياً
          else 'network_error'
        end
      when r.timed_out or r.error_msg is not null
        then 'network_error'
      when r.status_code between 200 and 299
        then case
          -- Codex P1 الرابع (PR #220): ok=true وحدها لا تثبت أن تيليغرام
          -- استلم الرسالة فعلاً — نفس شكل الجسم الذي يصنّفه
          -- telegram_delivery_audit() 'unparsed' لغياب result.message_id
          -- يجب أن يُعامَل هنا معاملة مطابقة تماماً، لا 'sent' نهائياً.
          when private.safe_jsonb(r.content) is null then 'unparsed'
          when (private.safe_jsonb(r.content) ->> 'ok') = 'true'
           and jsonb_exists(private.safe_jsonb(r.content) -> 'result', 'message_id') then 'ok_true'
          when (private.safe_jsonb(r.content) ->> 'ok') = 'false' then 'ok_false'
          else 'unparsed' -- ok=true بلا message_id، أو شكل جسم آخر غير متوقع
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
      update public.telegram_outbox set status = 'failed' where id = r.id; -- استنفدت المحاولات الآن (تُحيا لاحقاً)
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
