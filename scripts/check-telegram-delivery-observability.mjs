import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// المرحلة أ — رصد تسليم تيليغرام، بلا أي تغيير سلوك.
//
// العطل المرصود: dispatch_telegram_outbox يستدعي net.http_post — وهي غير
// متزامنة — ثم يكتب status='sent' فوراً بلا رؤية أي رد. فـ'sent' تعني
// "سُلّم إلى pg_net" لا "تيليغرام استلمه". قياس على الإنتاج في نافذة ست
// ساعات: 241 رسالة معلَّمة sent مقابل 230 رداً ناجحاً ⇒ 11 بلا رد نجاح.
//
// هذا الفحص يحرس حدود المرحلة أ تحديداً: تلتقط المعرّف ولا تغيّر شيئاً آخر.
// أي انزلاق نحو retry أو حالات جديدة أو مساس بـdedupe يجب أن يسقط هنا، لأن
// المرحلة ب لم تُصمَّم بعد وبياناتها لم تُجمع.
const REFERENCE = 'supabase/telegram-notifications.sql';
const MIGRATION = 'supabase/migrations/20260831120000_telegram_delivery_observability.sql';
const TESTS = 'supabase/tests/telegram-delivery-audit.sql';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reference = await readFile(path.join(repoRoot, REFERENCE), 'utf8');
const migration = await readFile(path.join(repoRoot, MIGRATION), 'utf8');
const tests = await readFile(path.join(repoRoot, TESTS), 'utf8');

const codeOnly = (t) => t.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
const refCode = codeOnly(reference);
const migCode = codeOnly(migration);

// ---------------------------------------------------------------------------
// 1) تعريف واحد للمُرسِل. كان في الملف تعريفان (سطر 65 والكانوني)، والأقدم
//    بلا reply_markup — أي إعادة ترتيب أو اقتطاع كانت تُعيد سلوكاً قديماً.
// ---------------------------------------------------------------------------
const dispatcherDefs = (refCode.match(/create or replace function public\.dispatch_telegram_outbox\(\)/g) ?? []);
assert.equal(
  dispatcherDefs.length, 1,
  `${REFERENCE}: عدد تعريفات dispatch_telegram_outbox = ${dispatcherDefs.length} — يجب أن يبقى واحداً`,
);

// ---------------------------------------------------------------------------
// 2) المعرّف يُلتقط ولا يُرمى — وهذا هو كل ما تفعله المرحلة أ في مسار الإرسال.
// ---------------------------------------------------------------------------
for (const [name, code] of [[REFERENCE, refCode], [MIGRATION, migCode]]) {
  assert.match(
    code, /rid := net\.http_post\(/,
    `${name}: net.http_post يجب أن يُسنَد إلى rid لا أن يُرمى`,
  );
  assert.doesNotMatch(
    code, /perform net\.http_post\(/,
    `${name}: عاد "perform net.http_post" — المعرّف يُرمى فيستحيل ربط الصف بردّه`,
  );
  // الإسناد للصف الصحيح: نفس الدورة، ونفس المفتاح.
  assert.match(
    code,
    /set status = 'sent', sent_at = now\(\), attempts = attempts \+ 1, net_request_id = rid\n\s*where id = r\.id;/,
    `${name}: التحديث يجب أن يربط rid بصف الدورة نفسها (where id = r.id)`,
  );
}

// ---------------------------------------------------------------------------
// 3) لا انتقال حالات جديد. status='sent' كما كان، ولا 'submitted'/'unknown'.
// ---------------------------------------------------------------------------
for (const [name, code] of [[REFERENCE, refCode], [MIGRATION, migCode]]) {
  for (const forbidden of ['submitted', 'unknown', 'retryable']) {
    assert.doesNotMatch(
      code, new RegExp(`'${forbidden}'`),
      `${name}: ظهرت حالة "${forbidden}" — المرحلة أ لا تُدخل أي حالة جديدة`,
    );
  }
  assert.doesNotMatch(
    code, /alter table public\.telegram_outbox\s+drop constraint/i,
    `${name}: قيد CHECK يجب ألا يُمَسّ في المرحلة أ`,
  );
}
assert.match(
  reference, /check \(status in \('pending','sent','failed'\)\)/,
  `${REFERENCE}: قيد CHECK تغيّر عن صيغته الأصلية`,
);

// ---------------------------------------------------------------------------
// 4) لا retry ولا backoff — المرحلة ب لم تُصمَّم بعد وبياناتها لم تُجمع.
// ---------------------------------------------------------------------------
const dispatcherBody = migCode.slice(
  migCode.indexOf('create or replace function public.dispatch_telegram_outbox()'),
  migCode.indexOf('create or replace function public.telegram_delivery_audit('),
);
for (const forbidden of [/backoff/i, /retry/i, /max_attempts/i, /attempts\s*<\s*\d/]) {
  assert.doesNotMatch(
    dispatcherBody, forbidden,
    `${MIGRATION}: منطق إعادة محاولة تسرّب إلى المُرسِل — خارج نطاق المرحلة أ`,
  );
}
// المُرسِل ما زال يلتقط الدفعة نفسها بالشرط نفسه
assert.match(
  dispatcherBody, /where status = 'pending'\n\s*order by created_at asc\n\s*limit 20/,
  `${MIGRATION}: شرط التقاط الدفعة تغيّر`,
);

// ---------------------------------------------------------------------------
// 5) لا مساس بـdedupe ولا بـnotify_telegram*. حارس الكتم يبقى حرفياً كما هو.
// ---------------------------------------------------------------------------
assert.match(
  reference,
  /if p_dedupe_key is not null and exists \(/,
  `${REFERENCE}: حارس الـdedupe تغيّر — خارج نطاق المرحلة أ`,
);
for (const [name, code] of [[MIGRATION, migCode]]) {
  assert.doesNotMatch(
    code, /create or replace function (public|private)\.notify_telegram/,
    `${name}: الترحيل يعيد تعريف notify_telegram* — ممنوع في المرحلة أ`,
  );
  assert.doesNotMatch(
    code, /dedupe_key\s*=/,
    `${name}: الترحيل يقارن/يُسنِد dedupe_key — منطق الكتم خارج نطاق المرحلة أ`,
  );
  assert.doesNotMatch(
    code, /insert into public\.telegram_outbox/,
    `${name}: الترحيل يُدرج في الطابور — المرحلة أ لا تُنتج رسائل`,
  );
}

// ---------------------------------------------------------------------------
// 6) عدسة الرصد READ ONLY — والضمانة من المحرّك: stable لا volatile.
//    مثبت على الإنتاج: "UPDATE is not allowed in a non-volatile function".
// ---------------------------------------------------------------------------
const auditStart = migCode.indexOf('create or replace function public.telegram_delivery_audit(');
assert.ok(auditStart > 0, `${MIGRATION}: دالة الرصد مفقودة`);
const auditBody = migCode.slice(auditStart);
assert.match(
  auditBody, /\nlanguage plpgsql\nstable\n/,
  `${MIGRATION}: دالة الرصد يجب أن تبقى "stable" — هي الضمانة التي تمنع الكتابة`,
);
assert.doesNotMatch(
  auditBody, /\nvolatile\n/,
  `${MIGRATION}: دالة الرصد صارت volatile — ضمانة منع الكتابة سقطت`,
);
for (const write of [/\binsert\s+into\b/i, /\bupdate\s+public\./i, /\bdelete\s+from\b/i]) {
  assert.doesNotMatch(
    auditBody, write,
    `${MIGRATION}: دالة الرصد تكتب — المرحلة أ قراءة فقط بلا استثناء`,
  );
}

// ---------------------------------------------------------------------------
// 7) تعبير التصنيف متطابق حرفياً بين الترحيل والملف المرجعي والاختبارات، وإلا
//    اختبرنا نسخة غير التي تعمل.
// ---------------------------------------------------------------------------
const classifier = (text) => {
  const i = text.indexOf("when o.net_request_id is null then 'no_request'");
  const j = text.indexOf("else 'http_error'", i);
  assert.ok(i > 0 && j > i, 'تعبير التصنيف غير موجود');
  return text.slice(i, j).replace(/\s+/g, ' ').trim();
};
const cMig = classifier(migration);
assert.equal(classifier(reference), cMig, `${REFERENCE}: تعبير التصنيف انحرف عن الترحيل`);
assert.equal(classifier(tests), cMig, `${TESTS}: الاختبار يفحص تعبير تصنيف مختلفاً عن المطبَّق`);

// ---------------------------------------------------------------------------
// 8) الاختبارات تغطي الأصناف السبعة والضمانة.
// ---------------------------------------------------------------------------
const testAsserts = tests.match(/\bassert /g) ?? [];
assert.ok(testAsserts.length >= 10, `${TESTS}: عدد التأكيدات ${testAsserts.length} أقل من 10`);
for (const cls of ['no_request', 'no_response', 'network_error', 'ok_true', 'ok_false', 'unparsed', 'http_error']) {
  assert.ok(tests.includes(`='${cls}'`), `${TESTS}: الصنف "${cls}" غير مختبَر`);
}
assert.match(
  tests, /language sql stable as \$\$\s*\n?\s*update /,
  `${TESTS}: مِجَسّ الكتابة داخل دالة stable مفقود`,
);
assert.match(
  tests, /when feature_not_supported then/,
  `${TESTS}: الاختبار لا يتحقق من أن المحرّك رفض الكتابة (feature_not_supported)`,
);
assert.match(
  tests, /FAIL: دالة stable سمحت بالكتابة/,
  `${TESTS}: لا يسقط الاختبار إن سمحت stable بالكتابة`,
);
assert.doesNotMatch(
  tests, /from public\.telegram_outbox|from net\._http_response/,
  `${TESTS}: الاختبار يقرأ بيانات إنتاج — يجب أن يبني حالاته في pg_temp`,
);

// ---------------------------------------------------------------------------
// 9) الصلاحيات — ملاحظة Codex P1 (2026-08-31). الدالة security definer تتجاوز
//    RLS، وdedupe_key يحمل بيانات زبائن حرفياً ('creditover:'||name و
//    'collection:<uuid>:<date>'). المرحلة أ أداة خدمة داخلية بحتة.
// ---------------------------------------------------------------------------
for (const [name, code] of [[REFERENCE, refCode], [MIGRATION, migCode]]) {
  assert.match(
    code,
    /revoke all on function public\.telegram_delivery_audit\(interval\) from public, anon, authenticated;/,
    `${name}: التنفيذ يجب أن يُسحب من public وanon وauthenticated جميعاً`,
  );
  assert.match(
    code,
    /grant execute on function public\.telegram_delivery_audit\(interval\) to service_role;/,
    `${name}: التنفيذ يُمنح لـservice_role وحده`,
  );
  assert.doesNotMatch(
    code,
    /grant execute on function public\.telegram_delivery_audit\(interval\) to [^;]*authenticated/,
    `${name}: عاد منح التنفيذ لـauthenticated — هذه هي ثغرة Codex P1 بعينها`,
  );
  // الحماية لا تعتمد على GRANT وحده.
  assert.match(
    code,
    /if v_jwt_role is not null and v_jwt_role <> 'service_role' then\n\s*raise exception 'telegram_delivery_audit: unauthorized' using errcode = '42501';/,
    `${name}: الحارس الداخلي مفقود أو تغيّر — الحماية يجب ألا تعتمد على GRANT وحده`,
  );
  // pg_temp أخيراً: بدونها يختطف جدول مؤقت القراءة داخل security definer.
  assert.match(
    code,
    /set search_path to 'public', 'net', 'pg_temp'/,
    `${name}: search_path لدالة الرصد يجب أن يذكر pg_temp أخيراً (خطر object shadowing)`,
  );
  // is_owner() لا تصلح هنا: تقرأ JWT المستدعي، وservice_role/cron بلا JWT.
  assert.doesNotMatch(
    code,
    /telegram_delivery_audit[\s\S]{0,1200}is_owner\(\)/,
    `${name}: is_owner() تحجب service_role (لا JWT له) — ليست الحارس الصحيح هنا`,
  );
}

// اختبارات الصلاحيات موجودة وتغطي السيناريوهات الأربعة + المالك
for (const [needle, why] of [
  ["أ1: بلا JWT", 'المسار المصرَّح له (cron/service tooling)'],
  ["أ2: service_role", 'المستدعي المقصود'],
  ["أ3: موظف مسجَّل عادي ⇒ مرفوض", 'جوهر ملاحظة P1'],
  ["أ4: anon ⇒ مرفوض", 'anon'],
  ["أ5: حتى المالك مرفوض", 'لا استثناء بشري في المرحلة أ'],
  ["ش1: بلا ذكر pg_temp يقع الاختطاف", 'إثبات الـshadowing بالاتجاه السالب'],
  ["ش2: بذكر pg_temp أخيراً يفوز المخطط الحقيقي", 'إثباته بالاتجاه الموجب'],
]) {
  assert.ok(tests.includes(needle), `${TESTS}: تغطية أمنية ناقصة — ${why}`);
}

// حارس الاختبار نسخة طبق الأصل من المشحون، وإلا اختبرنا غير ما يعمل
const guardOf = (t) => {
  const i = t.indexOf('v_jwt_role text :=');
  const j = t.indexOf("errcode = '42501';", i);
  assert.ok(i > 0 && j > i, 'الحارس غير موجود');
  return t.slice(i, j).replace(/\s+/g, ' ').trim();
};
assert.equal(guardOf(codeOnly(tests)), guardOf(migCode), `${TESTS}: حارس الاختبار انحرف عن المشحون`);

console.log(
  `Telegram delivery observability checks passed (تعريف مُرسِل واحد، المعرّف مُلتقَط، `
  + `صفر حالات جديدة، صفر retry، dedupe سليم، عدسة stable، ${testAsserts.length} تأكيداً).`,
);
