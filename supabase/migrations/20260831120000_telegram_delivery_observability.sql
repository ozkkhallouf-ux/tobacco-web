-- ============================================================================
-- المرحلة أ — رصد تسليم تيليغرام (Observability فقط، بلا أي تغيير سلوك)
--
-- المشكلة المثبتة على الإنتاج:
--   dispatch_telegram_outbox يستدعي net.http_post — وهي دالة *غير متزامنة*
--   تضع الطلب في طابور pg_net وتعود فوراً — ثم يكتب السطر التالي مباشرةً
--   status='sent', sent_at=now() بلا أن يرى أي رد. فمعنى 'sent' الفعلي هو
--   "سُلّم إلى pg_net"، لا "تيليغرام استلمه". ولا مسار فشل في النظام كله:
--   2801 صفاً في telegram_outbox، كلها 'sent' وattempts=1، وبحثٌ في كل دوال
--   القاعدة لم يجد أي موضع يضع 'failed'.
--
-- القياس (نافذة pg_net المحفوظة 6 ساعات، 05:49→11:44 بتاريخ 2026-08-31):
--   241 رسالة معلَّمة sent  ·  230 رداً ناجحاً بشكل تيليغرام ("message_id")
--   ⇒ 11 رسالة (4.6٪) بلا رد نجاح، ومع ذلك مكتوب عليها sent.
--   التمييز بين وجهتَي pg_net تم بشكل الجسم: تيليغرام يعيد result.message_id،
--   وweb-push يعيد {"ok":true,"sent":N,"failed":N}. لا شكل ثالث (other_200=0).
--
-- الذرّية — مثبتة تجريبياً لا استنتاجاً (2026-08-31، مِجَسّ على example.com):
--   طلب داخل معاملة مُلغاة  (id=10211): 0 رد · 0 صف في الطابور ⇒ لم يُنفَّذ.
--   طلب مثبَّت لنفس العنوان (id=10212): 1 رد · status_code=405 ⇒ نُفِّذ.
--   الشاهد الموجب ضروري: لولاه لاحتمل "لا رد" أن يعني "العنوان لا يردّ".
--   ⇒ net.http_post يُدرج داخل معاملة المستدعي، فحفظ request_id في نفس
--     المعاملة ذرّي: لا طلب بلا معرّف محفوظ، ولا معرّف بلا طلب.
--
-- نطاق هذا الترحيل — أقل أثر ممكن عمداً:
--   ✓ عمود net_request_id + فهرسه
--   ✓ dispatch_telegram_outbox يلتقط المعرّف بدل رميه؛ وما عدا ذلك لم يتغيّر
--     بحرف — status='sent' يُكتب كما كان تماماً
--   ✓ دالة رصد READ ONLY (stable، فالمحرّك نفسه يمنع الكتابة فيها)
--   ✗ لا تغيير لمعنى status ولا لقيد CHECK
--   ✗ لا حالات جديدة (submitted/unknown)
--   ✗ لا retry ولا backoff
--   ✗ لا مساس بـnotify_telegram أو notify_telegram_dispatch أو مفاتيح dedupe
--   ✗ لا مساس بـmonitor_project_tasks ولا بـweb-push
--
-- التراجع: انظر خطة الـrollback في وصف الـPR. جوهرها أن هذا الترحيل لا يغيّر
-- سلوكاً، فالتراجع الحقيقي غير مطلوب — ويكفي إعادة تعريف الدالة السابق إن
-- أُريد، والعمود يبقى غير مؤذٍ.
-- ============================================================================

-- ١) عمود الربط بين صف الرسالة وطلب pg_net
alter table public.telegram_outbox add column if not exists net_request_id bigint;

comment on column public.telegram_outbox.net_request_id is
  'معرّف طلب pg_net المقابل (net._http_response.id). للرصد فقط في المرحلة أ — لا يغيّر أي سلوك إرسال.';

create index if not exists telegram_outbox_net_request_idx
  on public.telegram_outbox (net_request_id) where net_request_id is not null;

-- ٢) المُرسِل: يلتقط request_id. لا شيء آخر تغيّر.
create or replace function public.dispatch_telegram_outbox()
returns void
language plpgsql security definer
set search_path to 'public', 'net', 'vault', 'extensions'
as $$
declare
  r    record;
  tok  text;
  chat bigint;
  body jsonb;
  rid  bigint;
begin
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
    -- التغيير الوحيد: التقاط المعرّف بدل رميه بـperform.
    rid := net.http_post(
      url     := 'https://api.telegram.org/bot' || tok || '/sendMessage',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body    := body
    );
    update public.telegram_outbox
    set status = 'sent', sent_at = now(), attempts = attempts + 1, net_request_id = rid
    where id = r.id;
  end loop;
end;
$$;

-- ٣) عدسة الرصد — READ ONLY. stable لا volatile: المحرّك يرفض الكتابة داخلها.
create or replace function public.telegram_delivery_audit(p_since interval default interval '6 hours')
returns table (
  outbox_id       bigint,
  event_type      text,
  dedupe_key      text,
  created_at      timestamptz,
  sent_at         timestamptz,
  net_request_id  bigint,
  has_response    boolean,
  status_code     integer,
  timed_out       boolean,
  error_msg       text,
  delivery_class  text,
  age             interval
)
language plpgsql
stable
security definer
-- pg_temp مذكورة صراحةً وأخيراً. بدونها تُبحث أولاً ضمنياً، فيستطيع جدول
-- مؤقت باسم telegram_outbox أن يختطف القراءة داخل security definer. مثبت
-- بالقياس (2026-08-31): بلا ذكرها عاد المِجَسّ بـ"TEMP_SHADOWED_THE_REAL_TABLE"،
-- ومع ذكرها أخيراً عاد بـ"PUBLIC_WON". نفس نمط is_owner()/is_staff() في المستودع.
set search_path to 'public', 'net', 'pg_temp'
as $$
declare
  v_jwt_role text := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role';
begin
  -- ملاحظة Codex P1 (2026-08-31): كانت الدالة ممنوحة لـauthenticated كاملاً.
  -- وهي security definer تتجاوز RLS الخاص بـtelegram_outbox، فكان أي موظف
  -- مسجَّل الدخول يقرأ تاريخ التسليم كله ومعه dedupe_key — وتلك المفاتيح تحمل
  -- بيانات زبائن حرفياً: 'creditover:' || r.name و'creditnear:' || r.name في
  -- هذا الملف نفسه، و'collection:<customer_uuid>:<date>' كما هي في الإنتاج.
  --
  -- المرحلة أ أداة خدمة داخلية بحتة: لا واجهة تستدعيها ولا مستخدم بشري
  -- يحتاجها — فلا استثناء حتى للمالك. كلما ضاقت فتحة القراءة كان أفضل.
  --
  -- لماذا ليست is_owner(): تحققتُ من تعريفها — تقرأ JWT المستدعي
  -- (auth.jwt() -> app_metadata ->> role). ومستدعي service_role أو cron أو
  -- اتصال مباشر لا يحمل JWT إطلاقاً، فتُرجع false وتحجب المستدعي الوحيد
  -- المقصود. الحارس هنا يتبع نمط notify_telegram نفسه في هذا الملف.
  --
  -- والحماية لا تعتمد على GRANT وحده: هذا الحارس يرفض حتى لو مُنح التنفيذ
  -- بالخطأ لاحقاً.
  if v_jwt_role is not null and v_jwt_role <> 'service_role' then
    raise exception 'telegram_delivery_audit: unauthorized' using errcode = '42501';
  end if;

  return query
  select
    o.id,
    o.event_type,
    o.dedupe_key,
    o.created_at,
    o.sent_at,
    o.net_request_id,
    (r.id is not null),
    r.status_code,
    r.timed_out,
    r.error_msg,
    case
      when o.net_request_id is null then 'no_request'
      when r.id is null then 'no_response'
      when r.status_code is null then 'network_error'
      when r.status_code between 200 and 299
       and r.content is not null
       and r.content::jsonb ->> 'ok' = 'true'
       and jsonb_exists(r.content::jsonb -> 'result', 'message_id') then 'ok_true'
      when r.status_code between 200 and 299
       and r.content is not null
       and r.content::jsonb ->> 'ok' = 'false' then 'ok_false'
      when r.status_code between 200 and 299 then 'unparsed'
      else 'http_error'
    end,
    now() - o.created_at
  from public.telegram_outbox o
  left join net._http_response r on r.id = o.net_request_id
  where o.created_at > now() - p_since
  order by o.created_at desc;
end $$;

revoke all on function public.telegram_delivery_audit(interval) from public, anon, authenticated;
grant execute on function public.telegram_delivery_audit(interval) to service_role;
