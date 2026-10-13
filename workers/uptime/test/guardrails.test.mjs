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
  assert.doesNotMatch(active, /\[\[routes\]\]|\[\[kv_namespaces\]\]|\[\[d1_databases\]\]|\[\[durable_objects/);
  assert.match(active, /^workers_dev\s*=\s*false/m);
  const vars = active.split('[vars]')[1]?.split('\n[')[0] || '';
  const keys = [...vars.matchAll(/^([A-Z_]+)\s*=/gm)].map((m) => m[1]);
  assert.deepEqual(keys, ['DRY_RUN'], 'المتغير الوحيد DRY_RUN (لا أسرار في [vars])');
});
test('لا أسرار ولا رموز حساب في ملفات الـWorker', () => {
  const files = ['../wrangler.toml', '../README.md', '../src/index.mjs', '../src/core.mjs', '../src/state-machine.mjs'];
  const bad = /(eyJ[\w-]{20,}\.|\bsb_secret_|\bsbp_|\d{8,10}:AA[\w-]{30,}|\bghp_[\w]{20,}|github_pat_|-----BEGIN|\b[0-9a-f]{32}\b)/;
  for (const f of files) assert.doesNotMatch(read(f), bad, f);
});
test('الشيفرة بلا Telegram/Supabase/service_role وبلا قراءة أسرار', () => {
  for (const f of readdirSync(here('../src/'))) {
    const code = read(`../src/${f}`).split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.doesNotMatch(code, /telegram|supabase|sendMessage|service_role|notify_telegram|env\.[A-Z_]*(TOKEN|KEY|SECRET)/i, f);
  }
});
test('لا نشر تلقائي لـCloudflare في أي workflow بالمستودع', () => {
  const dir = here('../../../.github/workflows/');
  for (const f of readdirSync(dir).filter((x) => /\.ya?ml$/.test(x))) {
    const y = readFileSync(new URL(f, dir), 'utf8').split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
    assert.doesNotMatch(y, /wrangler-action|wrangler(@[\w.]+)?\s+(deploy|publish|versions\s+upload)|CLOUDFLARE_(API_TOKEN|ACCOUNT_ID)|cloudflare\/(pages|wrangler)/i, f);
  }
});
