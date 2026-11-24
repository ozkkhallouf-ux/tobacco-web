#!/usr/bin/env node
// OZK Auto-Repair — patch guard (ALLOWLIST, fail-closed). The patch is UNTRUSTED content.
// Usage: node guard.mjs <workdir> <baseRef>   → prints JSON {ok, violations, files, stats}; exit 0 only if ok.
// Must be loaded from a TRUSTED location (default branch / outside the patched tree) and run BEFORE any test,
// so a patch can never weaken the guard, the tests, or the commands that run them.
import { spawnSync } from 'node:child_process';

export const POLICY = {
  // Phase-1 allowlist: modify existing app source only.
  allow: [/^src\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*\.(js|css)$/],
  // Sensitive even inside src/ (auth, keys, Ameen, telemetry).
  deny: [/^src\/config\.js$/, /^src\/supabase-client\.js$/, /^src\/ameen-live-client\.js$/, /^src\/error-monitoring\.js$/],
  allowedStatus: ['M'],               // no add / delete / rename / type-change in phase 1
  allowedMode: '100644',              // no symlink (120000), exec (100755), submodule (160000)
  maxFiles: 5,
  maxChangedLines: 200,
  secretPatterns: [
    /sk-ant-[A-Za-z0-9_-]{8,}/, /\bgh[pousr]_[A-Za-z0-9]{20,}/, /github_pat_[A-Za-z0-9_]{20,}/,
    /\bsb_secret_[A-Za-z0-9_-]{10,}/, /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}/,           // Supabase/JWT
    /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/,                                                           // Telegram bot token
    /AKIA[0-9A-Z]{16}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /xox[abprs]-[A-Za-z0-9-]{10,}/,
  ],
  dangerousCode: [/\beval\s*\(/, /new\s+Function\s*\(/, /child_process/, /process\.env/, /document\.cookie/, /\bimportScripts\s*\(/],
};

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

// --raw with -z: ":oldmode newmode oldsha newsha STATUS\0path\0"
function listChangedFiles(workdir, baseRef) {
  const raw = git(workdir, ['diff', '--cached', '--raw', '-z', '--no-renames', '--no-ext-diff', baseRef]).split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i < raw.length; i += 2) {
    const [oldMode, newMode, , , status] = raw[i].slice(1).split(' ');
    files.push({ path: raw[i + 1], status, oldMode, newMode });
  }
  return files;
}

const BAD_PATH = /[\x00-\x1f\x7f]|(^|\/)\.\.?(\/|$)|^\//;
const NON_ASCII = /[^\x20-\x7e]/;

function fileViolations(f, policy) {
  const v = [];
  if (BAD_PATH.test(f.path) || NON_ASCII.test(f.path)) v.push(`bad_path:${JSON.stringify(f.path)}`);
  if (!policy.allow.some((re) => re.test(f.path))) v.push(`path_not_allowlisted:${f.path}`);
  if (policy.deny.some((re) => re.test(f.path))) v.push(`path_denied:${f.path}`);
  if (!policy.allowedStatus.includes(f.status)) v.push(`status_not_allowed:${f.status}:${f.path}`);
  if (f.status !== 'D' && f.newMode !== policy.allowedMode) v.push(`mode_not_allowed:${f.newMode}:${f.path}`);
  if (f.status !== 'A' && f.oldMode !== policy.allowedMode) v.push(`mode_not_allowed_base:${f.oldMode}:${f.path}`);
  return v;
}

// numstat: binary shows "-\t-"
function sizeViolations(workdir, baseRef, policy) {
  const v = [];
  let changed = 0;
  for (const line of git(workdir, ['diff', '--cached', '--numstat', '--no-renames', baseRef]).split('\n').filter(Boolean)) {
    const [a, d, p] = line.split('\t');
    if (a === '-' || d === '-') v.push(`binary_change:${p}`);
    else changed += Number(a) + Number(d);
  }
  if (changed > policy.maxChangedLines) v.push(`too_many_lines:${changed}`);
  return { v, changed };
}

function addedLineViolations(line, removedText, policy) {
  const v = [];
  if (policy.secretPatterns.some((re) => re.test(line))) v.push('secret_pattern_in_added_line');
  if (policy.dangerousCode.some((re) => re.test(line))) v.push(`dangerous_code:${line.slice(1, 80).trim()}`);
  for (const url of line.match(/https?:\/\/[^\s'"`)<>]+/g) || []) {
    if (!removedText.includes(url)) v.push(`new_external_url:${url}`);
  }
  return v;
}

// content checks on ADDED lines only
function contentViolations(workdir, baseRef, policy) {
  const lines = git(workdir, ['diff', '--cached', '--no-renames', '--no-ext-diff', '-U0', baseRef]).split('\n');
  const removedText = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).join('\n');
  return lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).flatMap((l) => addedLineViolations(l, removedText, policy));
}

export function guard(workdir, baseRef, policy = POLICY) {
  git(workdir, ['add', '-A']);                                          // include untracked files
  const files = listChangedFiles(workdir, baseRef);
  const size = sizeViolations(workdir, baseRef, policy);
  const v = [
    ...(files.length === 0 ? ['empty_patch'] : []),
    ...(files.length > policy.maxFiles ? [`too_many_files:${files.length}`] : []),
    ...files.flatMap((f) => fileViolations(f, policy)),
    ...size.v,
    ...contentViolations(workdir, baseRef, policy),
  ];
  return { ok: v.length === 0, violations: [...new Set(v)], files, stats: { files: files.length, changed_lines: size.changed } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [workdir, baseRef] = process.argv.slice(2);
  if (!workdir || !baseRef) { console.error('usage: guard.mjs <workdir> <baseRef>'); process.exit(2); }
  let res;
  try { res = guard(workdir, baseRef); } catch (e) { res = { ok: false, violations: ['guard_error:' + e.message.slice(0, 200)] }; }   // fail-closed
  console.log(JSON.stringify(res));
  process.exit(res.ok ? 0 : 1);
}
