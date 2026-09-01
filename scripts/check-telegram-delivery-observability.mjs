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


// ---------------------------------------------------------------------------
// 10) ملاحظة Codex P2 (2026-08-31) — لا cast مباشر في مسار الرصد.
//
//     r.content::jsonb داخل فروع CASE يرفع 22P02 على أي رد 2xx بجسم ليس JSON،
//     قبل أن يُبلَغ فرع 'unparsed'. والعدسة تُرجع مجموعة تعالج النافذة كلها،
//     فصفٌّ واحد سيّئ كان يُسقط الاستدعاء ويخفي كل صف آخر — أي تنطفئ العدسة
//     في لحظة التشخيص بالذات. البديل private.safe_jsonb: JSON صالح ⇒ jsonb،
//     وغيره ⇒ NULL، بلا إسقاط.
// ---------------------------------------------------------------------------
const safeJsonbOf = (code) => {
  const i = code.indexOf('create or replace function private.safe_jsonb(p_text text)');
  const j = code.indexOf('revoke all on function private.safe_jsonb(text)', i);
  assert.ok(i > 0 && j > i, 'دالة private.safe_jsonb غير موجودة');
  return code.slice(i, j).replace(/\s+/g, ' ').trim();
};

for (const [name, code] of [[REFERENCE, refCode], [MIGRATION, migCode]]) {
  // لا تحويل مباشر يستطيع إسقاط الاستعلام — هذه هي الثغرة بعينها
  assert.doesNotMatch(
    code, /r\.content::jsonb/,
    `${name}: عاد التحويل المباشر r.content::jsonb — ثغرة Codex P2 بعينها`,
  );
  assert.match(
    code, /left join lateral \(select private\.safe_jsonb\(r\.content\) as body\) b on true/,
    `${name}: الربط الجانبي الذي يحلّل الجسم مرة واحدة مفقود`,
  );
  assert.match(
    code, /revoke all on function private\.safe_jsonb\(text\) from public, anon, authenticated;/,
    `${name}: صلاحيات safe_jsonb يجب أن تُسحب من public وanon وauthenticated`,
  );

  const helper = safeJsonbOf(code);
  // أضيق صلاحية ممكنة: لا تلمس جدولاً فلا تحتاج تجاوز صلاحيات أحد
  assert.doesNotMatch(
    helper, /security definer/i,
    `${name}: safe_jsonb صارت security definer بلا ضرورة — الأضيق هو الصحيح`,
  );
  assert.match(helper, /immutable/, `${name}: safe_jsonb يجب أن تبقى immutable`);
  assert.match(
    helper, /set search_path to 'pg_catalog', 'pg_temp'/,
    `${name}: search_path لـsafe_jsonb غير مثبت — نوع في مخطط سابق يغيّر معنى التحويل`,
  );
  assert.match(
    helper, /p_text::pg_catalog\.jsonb/,
    `${name}: التحويل داخل safe_jsonb يجب أن يبقى مؤهَّلاً بـpg_catalog`,
  );
  // NULL يجب أن تعني «ليس JSON»، لا أن تبتلع خطأ بنية تحتية
  assert.match(
    helper, /when invalid_text_representation or untranslatable_character then/,
    `${name}: safe_jsonb يجب أن تلتقط فئتَي خطأ التحليل صراحةً`,
  );
  assert.doesNotMatch(
    helper, /when others then/,
    `${name}: safe_jsonb تبتلع others — NULL عندها تُقنّع خطأ بنية تحتية صفاً سليماً`,
  );
}

// نسخة واحدة لا نسختان: الترحيل والمرجع يجب ألا ينحرفا
assert.equal(
  safeJsonbOf(refCode), safeJsonbOf(migCode),
  `${REFERENCE}: تعريف safe_jsonb انحرف عن الترحيل — drift جديد`,
);

// مِجَسّ الاختبار الحقيقي نسخة من المشحون: بلا تحويل مباشر فيه
const realProbe = (() => {
  const i = tests.indexOf('create function pg_temp.audit_probe()');
  const j = tests.indexOf('$$;', i);
  assert.ok(i > 0 && j > i, `${TESTS}: مِجَسّ التصنيف غير موجود`);
  return tests.slice(i, j);
})();
assert.doesNotMatch(
  realProbe, /r\.content::jsonb/,
  `${TESTS}: مِجَسّ التصنيف يستعمل التحويل المباشر — يختبر غير ما يعمل`,
);
assert.match(
  realProbe, /private\.safe_jsonb\(r\.content\)/,
  `${TESTS}: مِجَسّ التصنيف لا يمرّ عبر safe_jsonb`,
);

// الشاهد السالب: بدونه قد تمرّ التأكيدات بلا أن تحرس شيئاً
assert.match(
  tests, /create function pg_temp\.audit_probe_unsafe\(\)/,
  `${TESTS}: الشاهد السالب مفقود — لا برهان أن الحالات الجديدة تُثير الخلل`,
);
assert.match(
  tests, /exception when invalid_text_representation then\s*\n\s*old_died := true;/,
  `${TESTS}: الشاهد السالب لا يتحقق من أن التعبير القديم يسقط فعلاً`,
);

// التغطية: تصنيف صحيح + عزل. الأول وحده لا يثبت أن العدسة لم تنطفئ.
for (const [needle, why] of [
  ['(208, 200,', 'حالة 2xx بجسم HTML'],
  ["(209, 200, ''", 'حالة 2xx بجسم فارغ'],
  ['(210, 204, null', 'حالة 2xx بلا جسم'],
  ['14: العزل', 'تصنيف الصفوف الأصلية لم يتغيّر بوجود ردود غير JSON'],
  ['15: العزل', 'صف النجاح ما زال مرئياً رغم الردود السيّئة'],
  ['16: الشاهد السالب', 'إثبات أن الحالات الجديدة تُثير خلل P2 فعلاً'],
]) {
  assert.ok(tests.includes(needle), `${TESTS}: تغطية P2 ناقصة — ${why}`);
}


// ---------------------------------------------------------------------------
// 11) الشاهد السالب يجب أن يفرض تقييم التعبير القديم فعلاً.
//
//     الصيغة الأولى كانت `perform count(*) from pg_temp.audit_probe_unsafe();`
//     وهي لا تحتاج قيم الأعمدة، فيُسقط مخطِّط PostgreSQL تقييم تعبير CASE كله
//     ولا ينفجر التحويل — فيمرّ التأكيد بلا أن يحرس شيئاً. اكتُشف ذلك حين فشل
//     التأكيد 16 على الإنتاج (2026-08-31، PostgreSQL 17.6)، وقِيست الصيغ:
//       perform count(*)              ⇒ لم يسقط
//       select … into على قيمة العمود ⇒ سقط 22P02
//       التحويل وحده بلا CASE          ⇒ سقط 22P02
//
//     الحارس هنا يفحص **موضع الاستدعاء** لا التعريف: التعريف يجب أن يحتفظ
//     بالتحويل المباشر (فهو محاكاة الخلل)، والاستدعاء يجب أن يستهلك القيمة.
// ---------------------------------------------------------------------------
const negativeControlCall = (() => {
  const defAt = tests.indexOf('create function pg_temp.audit_probe_unsafe()');
  assert.ok(defAt > 0, `${TESTS}: تعريف الشاهد السالب مفقود`);
  const defEnd = tests.indexOf('$$;', defAt);
  const callAt = tests.indexOf('pg_temp.audit_probe_unsafe()', defEnd);
  assert.ok(callAt > 0, `${TESTS}: الشاهد السالب معرَّف ولا يُستدعى — لا يحرس شيئاً`);
  const blockStart = tests.lastIndexOf('begin', callAt);
  const blockEnd = tests.indexOf('end;', callAt);
  assert.ok(blockStart > 0 && blockEnd > callAt, `${TESTS}: كتلة الشاهد السالب غير مكتملة`);
  return tests.slice(blockStart, blockEnd);
})();

// count(*) وأخواتها تسمح للمخطِّط بتجاهل الإسقاط ⇒ شاهد فارغ المعنى
assert.doesNotMatch(
  negativeControlCall, /count\s*\(/,
  `${TESTS}: الشاهد السالب يستعمل count(...) — المخطِّط يُسقط تقييم التعبير فلا يبرهن شيئاً`,
);
assert.doesNotMatch(
  negativeControlCall, /\bperform\b/,
  `${TESTS}: الشاهد السالب يستعمل perform — النتيجة تُرمى، فقد لا يُقيَّم التعبير`,
);
assert.doesNotMatch(
  negativeControlCall, /\bexists\s*\(|\blimit\s+0\b/,
  `${TESTS}: الشاهد السالب يستعمل صيغة قد تتفادى تقييم الصفوف`,
);
// يجب أن تُستهلك القيمة المصنَّفة فعلاً
assert.match(
  negativeControlCall, /\binto\b/,
  `${TESTS}: الشاهد السالب لا يُسند القيمة إلى متغيّر — التقييم غير مفروض`,
);
assert.match(
  negativeControlCall, /delivery_class/,
  `${TESTS}: الشاهد السالب لا يستهلك delivery_class — وهو العمود الذي يحمل التحويل`,
);
// ويجب أن يلتقط فئة الخطأ الصحيحة وحدها
assert.match(
  negativeControlCall, /exception when invalid_text_representation then/,
  `${TESTS}: الشاهد السالب لا يلتقط invalid_text_representation تحديداً`,
);
assert.doesNotMatch(
  negativeControlCall, /when others then/,
  `${TESTS}: الشاهد السالب يلتقط others — قد يبتلع خطأً آخر ويدّعي أنه 22P02`,
);

// والتعريف نفسه يجب أن يبقى حاملاً للتحويل المباشر: هو محاكاة الخلل لا إصلاحه
const negativeControlDef = (() => {
  const i = tests.indexOf('create function pg_temp.audit_probe_unsafe()');
  return tests.slice(i, tests.indexOf('$$;', i));
})();
assert.match(
  negativeControlDef, /r\.content::jsonb/,
  `${TESTS}: تعريف الشاهد السالب فقد التحويل المباشر — لم يعد يحاكي الخلل`,
);

console.log(
  `Telegram delivery observability checks passed (تعريف مُرسِل واحد، المعرّف مُلتقَط، `
  + `صفر حالات جديدة، صفر retry، dedupe سليم، عدسة stable، بلا cast غير محروس، `
  + `شاهد سالب يفرض التقييم، `
  + `${testAsserts.length} تأكيداً).`,
);
