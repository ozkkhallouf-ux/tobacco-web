// حواجز أمان ساكنة: لا أسرار، لا Telegram/Supabase، لا نشر تلقائي، إعدادات Worker سليمة.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const here = (p) => new URL(p, import.meta.url);
const read = (p) => readFileSync(here(p), 'utf8');
const toml = read('../wrangler.toml');
const active = toml.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

test('wrangler.toml: الاسم والمدخل والـcron والوضع الافتراضي', () => {
  assert.match(active, /^name\s*=\s*"ozk-uptime"/m);
  const main = active.match(/^main\s*=\s*"([^"]+)"/m)?.[1];
  assert.equal(main, 'src/index.mjs');
  assert.ok(existsSync(here(`../${main}`)));
  assert.match(active, /^crons\s*=\s*\["\*\/5 \* \* \* \*"\]\s*$/m, 'cron واحد كل 5 دقائق بالضبط');
  assert.match(active, /^DRY_RUN\s*=\s*"1"\s*$/m, 'DRY_RUN=1 افتراضياً');
});
test('wrangler.toml: لا نشر عرضي ولا مسارات ولا حساب ولا أسرار', () => {
  assert.doesNotMatch(active, /^\s*(account_id|route|routes|zone_id)\b/m);
  assert.doesNotMatch(active, /\[\[routes\]\]|\[\[d1_databases\]\]|\[\[durable_objects|\[\[services\]\]|\[\[queues|\[\[r2_buckets\]\]|\[\[analytics_engine|\[\[hyperdrive|\[ai\]|\[triggers\.|custom_domain|pattern\s*=/);
  assert.match(active, /^workers_dev\s*=\s*false/m);
  const vars = active.split('[vars]')[1]?.split('\n[')[0] || '';
  const keys = [...vars.matchAll(/^([A-Z_]+)\s*=/gm)].map((m) => m[1]);
  assert.deepEqual(keys, ['DRY_RUN'], 'المتغير الوحيد DRY_RUN (لا أسرار في [vars])');
});
test('wrangler.toml: ربط KV واحد صحيح (UPTIME_STATE → ozk-uptime-state)', () => {
  const blocks = active.split('[[kv_namespaces]]').slice(1);
  assert.equal(blocks.length, 1, 'Namespace واحد فقط');
  const b = blocks[0].split(/\r?\n\[/)[0];
  assert.deepEqual([...b.matchAll(/^(\w+)\s*=/gm)].map((m) => m[1]), ['binding', 'id'], 'مفاتيح الربط المسموحة فقط');
  assert.match(b, /^binding\s*=\s*"UPTIME_STATE"\s*$/m);
  assert.match(b, /^id\s*=\s*"f64f49cc48b54d23adfff9923be09dad"\s*$/m, 'معرّف ozk-uptime-state الحقيقي');
  assert.ok(!/REPLACE_ME/.test(active), 'لا معرّف وهمي');
  assert.ok(/UPTIME_STATE/.test(read('../src/core.mjs')), 'الكود يقرأ نفس اسم الربط');
  assert.ok(toml.includes('ozk-uptime-state'), 'اسم الـNamespace موثّق في التعليق');
});
test('لا أسرار ولا رموز حساب في ملفات الـWorker', () => {
  // المعرّف الوحيد المسموح بصيغة 32-hex هو معرّف KV في wrangler.toml (ليس سراً)؛ يُفحص أعلاه بدقة.
  const kvId = 'f64f49cc48b54d23adfff9923be09dad';
  const files = ['../wrangler.toml', '../README.md', '../src/index.mjs', '../src/core.mjs', '../src/state-machine.mjs', '../src/ingest.mjs'];
  const bad = /(eyJ[\w-]{20,}\.|\bsb_secret_|\bsbp_|\d{8,10}:AA[\w-]{30,}|\bghp_[\w]{20,}|github_pat_|-----BEGIN|\b[0-9a-f]{32}\b)/;
  for (const f of files) assert.doesNotMatch(read(f).replaceAll(kvId, 'KV_ID'), bad, f);
});
test('الشيفرة بلا Telegram/service_role؛ Supabase وسرّ التوقيع محصوران في ingest.mjs', () => {
  for (const f of readdirSync(here('../src/'))) {
    const code = read(`../src/${f}`).split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.doesNotMatch(code, /telegram|sendMessage|service_role|notify_telegram|outbox/i, f);
    const secrets = [...code.matchAll(/env\??\.([A-Z_]*(TOKEN|KEY|SECRET)[A-Z_]*)/g)].map((m) => m[1]);
    if (f === 'ingest.mjs') {
      assert.deepEqual([...new Set(secrets)].sort(), ['SUPABASE_PUBLISHABLE_KEY', 'UPTIME_HMAC_SECRET'], 'المفتاح العام وسرّ التوقيع فقط');
      assert.match(code, /\/rest\/v1\/rpc\/uptime_ingest'/, 'نقطة واحدة فقط: public.uptime_ingest');
      assert.equal((code.match(/fetchImpl\(/g) || []).length, 1, 'طلب صادر واحد فقط');
    } else {
      assert.doesNotMatch(code, /supabase/i, f);
      assert.deepEqual(secrets, [], f);
    }
  }
});
test('لا نشر تلقائي لـCloudflare في أي workflow بالمستودع', () => {
  const dir = here('../../../.github/workflows/');
  for (const f of readdirSync(dir).filter((x) => /\.ya?ml$/.test(x))) {
    const y = readFileSync(new URL(f, dir), 'utf8').split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    assert.doesNotMatch(y, /wrangler-action|wrangler(@[\w.]+)?\s+(deploy|publish|versions\s+upload)|CLOUDFLARE_(API_TOKEN|ACCOUNT_ID)|cloudflare\/(pages|wrangler)/i, f);
  }
});
test('عقد الدفعة: حدّ الـWorker لكل طلب يساوي حدّ الخادم في proposed/14', async () => {
  const { INGEST_BATCH_MAX } = await import('../src/core.mjs');
  const sql = readFileSync(here('../../../supabase/proposed/14-uptime-ingest.sql'), 'utf8');
  const limit = Number(sql.match(/jsonb_array_length\(j -> 'events'\) > (\d+)/)?.[1]);
  assert.equal(INGEST_BATCH_MAX, limit);
});
