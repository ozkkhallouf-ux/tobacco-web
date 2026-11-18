// Tests for gate's failure classification (ported from pipeline/policy.js), inlined in
// .github/workflows/ozk-autorepair.yml's gate job (no new permissions, no checkout needed).
// Manual: `node .github/autorepair/test-gate-classify.mjs`. Not wired into CI on purpose
// (same convention as test-guard.mjs) — this only exercises gate's own bash logic.
//
// Extracts the REAL `run: |` script of the gate step straight from the workflow YAML (no
// copy/paste of the bash into the test), then runs it under a mocked `gh`, so a change to the
// deployed script is tested as it actually is, not a separately-maintained copy.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW = path.join(HERE, '..', 'workflows', 'ozk-autorepair.yml');

function extractGateScript() {
  const lines = fs.readFileSync(WORKFLOW, 'utf8').split('\n');
  const idIdx = lines.findIndex((l) => l.trim() === '- id: g');
  if (idIdx === -1) throw new Error('gate step "- id: g" not found in ' + WORKFLOW);
  const runIdx = lines.findIndex((l, i) => i > idIdx && /^\s*run:\s*\|\s*$/.test(l));
  if (runIdx === -1) throw new Error('run: | block not found after "- id: g"');
  const indentOf = (l) => l.match(/^(\s*)/)[1].length;
  const blockIndent = indentOf(lines[runIdx]);
  const body = [];
  let bodyIndent = null;
  for (let i = runIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') { body.push(''); continue; }
    const thisIndent = indentOf(l);
    if (bodyIndent === null) {
      if (thisIndent <= blockIndent) break;
      bodyIndent = thisIndent;
    }
    if (thisIndent < bodyIndent) break;
    body.push(l.slice(bodyIndent));
  }
  if (!body.join('').trim()) throw new Error('extracted gate script is empty — extraction logic is out of sync with the YAML');
  return body.join('\n');
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ozk-gate-classify-test-'));
const BIN = path.join(ROOT, 'bin');
fs.mkdirSync(BIN);
fs.writeFileSync(
  path.join(BIN, 'gh'),
  `#!/usr/bin/env bash
if [ "$1" = "run" ] && [ "$2" = "view" ]; then
  printf '%s' "\${MOCK_LOG:-}"
  exit "\${MOCK_LOG_EXIT:-0}"
fi
if [ "$1" = "api" ]; then
  case "$*" in
    *created=*) echo "\${MOCK_TODAY:-0}";;
    *) echo "\${MOCK_SAME:-0}";;
  esac
  exit 0
fi
echo "unexpected gh call: $*" >&2
exit 1
`,
  { mode: 0o755 },
);

const scriptPath = path.join(ROOT, 'gate.sh');
fs.writeFileSync(scriptPath, extractGateScript());

let n = 0, pass = 0;
function run(overrides) {
  const outFile = path.join(ROOT, 'out-' + (++n) + '.txt');
  fs.writeFileSync(outFile, '');
  const env = Object.assign(
    {
      PATH: BIN + ':' + process.env.PATH,
      GH_TOKEN: 'x',
      REPO: 'o/r',
      RUN_ID: '123',
      CONCLUSION: 'failure',
      HEAD_REPO: 'o/r',
      HEAD_BRANCH: 'feature/x',
      HEAD_SHA: 'a'.repeat(40),
      ACTOR_TYPE: 'User',
      RUN_ATTEMPT: '1',
      MODE: 'shadow',
      ALLOWED_RUN_ID: '',
      MOCK_TODAY: '0',
      MOCK_SAME: '0',
      MOCK_LOG: '',
      GITHUB_OUTPUT: outFile,
    },
    overrides,
  );
  const r = spawnSync('bash', [scriptPath], { env, encoding: 'utf8' });
  const out = fs.readFileSync(outFile, 'utf8');
  const get = (k) => (out.match(new RegExp('^' + k + '=(.*)$', 'm')) || [, undefined])[1];
  return { status: r.status, stderr: r.stderr, proceed: get('proceed'), category: get('category'), attempt: get('attempt') };
}

function expect(name, overrides, wantProceed, wantCategory) {
  const r = run(overrides);
  const good = r.proceed === wantProceed && (wantCategory === undefined || r.category === wantCategory);
  if (good) pass++;
  console.log(`${good ? '✅' : '❌'} ${name} → proceed=${r.proceed} category=${r.category}${r.status !== 0 && r.proceed === undefined ? ' [script error: ' + r.stderr.trim().split('\n').pop() + ']' : ''}`);
}

// فئات قابلة للإصلاح تلقائياً — يجب أن تستمر (proceed=true) كما كانت قبل التعديل
expect('C1 test_failure -> proceed', { MOCK_LOG: '1) sums\n  AssertionError: expected 1 to equal 2\n  tests failed' }, 'true', 'test_failure');
expect('C2 lint_failure -> proceed', { MOCK_LOG: 'src/x.js\n  3 problems (3 errors, 0 warnings)\neslint found issues' }, 'true', 'lint_failure');
expect('C3 type_error -> proceed', { MOCK_LOG: "src/x.ts(10,5): error TS2322: Type 'string' is not assignable" }, 'true', 'type_error');
// مطابقة حرفية لـpolicy.js: /\d+ problems? \(\d+ errors?/ بلا قوس إغلاق إلزامي — سجل بلا
// كلمة eslint/prettier ومقطوع فور "N errors" (بلا ")") يجب أن يُصنَّف lint_failure مثل
// policy.js تماماً، لا unknown (كان هذا الفارق النصي يحجبه خطأً قبل الإصلاح).
expect('C3b lint_failure truncated before ")" -> proceed (matches policy.js exactly)', { MOCK_LOG: 'src/x.js\n2 problems (2 errors' }, 'true', 'lint_failure');

// فئات غير قابلة للإصلاح آلياً — يجب أن تُحجَب (proceed=false) قبل أي استدعاء لـClaude
expect('C4 secret_or_permission -> blocked', { MOCK_LOG: 'Error: 403 Forbidden\nResource not accessible by integration' }, 'false', 'secret_or_permission');
expect('C5 infra_network -> blocked', { MOCK_LOG: 'connect ECONNRESET 10.0.0.1:443\nrate limit exceeded' }, 'false', 'infra_network');
expect('C6 timeout_or_flaky -> blocked', { MOCK_LOG: 'Error: Timeout of 30000ms exceeded for a hook' }, 'false', 'timeout_or_flaky');

// حالات الالتباس — fail-closed عند عدم اليقين
expect('C7 unrelated/unknown log -> blocked (fail-closed)', { MOCK_LOG: 'npm notice new version available\nDeploying to staging...' }, 'false', 'unknown');
expect('C8 log fetch fails entirely -> blocked (fail-closed)', { MOCK_LOG_EXIT: '1', MOCK_LOG: '' }, 'false', 'unknown');
expect('C9 mixed signals: not-our-fault rule wins (AssertionError + 403)', { MOCK_LOG: '403 Forbidden calling GitHub API\n...\nAssertionError: expected true' }, 'false', 'secret_or_permission');
expect('C10 empty log -> blocked (fail-closed)', { MOCK_LOG: '' }, 'false', 'unknown');

// لا رجوع في الحراسات القائمة سابقاً (غير متعلقة بالتصنيف)
expect('C11 bot actor still blocked regardless of category', { ACTOR_TYPE: 'Bot', MOCK_LOG: 'tests failed' }, 'false', undefined);
expect('C12 autorepair branch still blocked (loop guard)', { HEAD_BRANCH: 'autorepair/9-a1', MOCK_LOG: 'tests failed' }, 'false', undefined);

// فحص ارتدادي: السقوف تبقى سليمة بعد إدراج التصنيف
expect('C13 repairable category but daily cap reached -> blocked', { MOCK_LOG: 'tests failed', MOCK_TODAY: '4' }, 'false', 'test_failure');
expect('C14 repairable category, under caps -> proceed', { MOCK_LOG: 'tests failed', MOCK_TODAY: '1', MOCK_SAME: '1' }, 'true', 'test_failure');

// قفل اختبار Propose المؤقت (OZK_AUTOREPAIR_PROPOSE_TEST_RUN_ID) — خمس حالات صريحة
expect('P1 propose + RUN_ID مطابق -> proceed (يستمر إلى التصنيف الطبيعي)', { MODE: 'propose', ALLOWED_RUN_ID: '123', MOCK_LOG: 'tests failed' }, 'true', 'test_failure');
expect('P2 propose + RUN_ID غير مطابق -> blocked', { MODE: 'propose', ALLOWED_RUN_ID: '999', MOCK_LOG: 'tests failed' }, 'false', undefined);
expect('P3 propose + ALLOWED_RUN_ID فارغ (غياب التسجيل) -> blocked (fail-closed)', { MODE: 'propose', ALLOWED_RUN_ID: '', MOCK_LOG: 'tests failed' }, 'false', undefined);
expect('P4 propose + ALLOWED_RUN_ID غير صالح (ليس رقماً) -> blocked', { MODE: 'propose', ALLOWED_RUN_ID: 'abc', MOCK_LOG: 'tests failed' }, 'false', undefined);
expect('P5 shadow غير متأثر بالقفل (حتى مع ALLOWED_RUN_ID مضبوطاً وغير مطابق) -> proceed كما كان', { MODE: 'shadow', ALLOWED_RUN_ID: '999', MOCK_LOG: 'tests failed' }, 'true', 'test_failure');

console.log(`\n${pass}/${n} passed`);
process.exit(pass === n ? 0 : 1);
