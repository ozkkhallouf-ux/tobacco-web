import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Contract checks for .github/workflows/alert-on-automation-failure.yml —
// the workflow that pages Telegram (via the shared notify_telegram RPC)
// whenever an operationally important GitHub Actions workflow fails. This
// exists because a real ~21h silent outage of the price-bulletin generator
// went undetected until a human noticed stale prices.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const yamlPath = path.join(repoRoot, '.github', 'workflows', 'alert-on-automation-failure.yml');
const yml = await readFile(yamlPath, 'utf8');

// The header comment explains (in prose) why "Codex Review Gate" is
// intentionally excluded, which means it names it — same false-positive
// trap as elsewhere in this repo's check scripts (SQL files quoting old
// vulnerable policies for documentation). Strip full-line "#" comments
// before checking for its ABSENCE from the live `workflows:` list.
const codeOnly = yml
  .split('\n')
  .filter((line) => !line.trim().startsWith('#'))
  .join('\n');

// Must only fire on actual failures, never on success/cancelled — a noisy
// "everything is fine" ping defeats the purpose and trains people to ignore
// the channel.
assert.match(
  yml,
  /if:\s*github\.event\.workflow_run\.conclusion == 'failure'/,
  'the notify job must be gated to conclusion == failure only',
);

// Must NOT watch the Codex Review Gate — failing is its expected default
// state before a review lands, not an operational outage.
assert.doesNotMatch(
  codeOnly,
  /"Codex Review Gate"/,
  'must not include "Codex Review Gate" in the watched workflows — its default failing state is expected, not an outage',
);

// Must watch the deploy and price-bulletin pipelines specifically — these
// are the ones a silent failure directly harms customers (stale prices /
// stale site).
assert.match(yml, /"Deploy TOBACCO Web"/, 'must watch the deploy workflow');
assert.match(yml, /"توليد نشرات الأسعار"/, 'must watch the price-bulletin generation workflow');

// Must fail loudly (non-zero exit) if the required secret is missing,
// rather than silently doing nothing — a misconfigured alert pipeline
// should be visible in the Actions tab, not fail invisibly forever.
assert.match(
  yml,
  /if \[ -z "\$SUPABASE_SERVICE_ROLE_KEY" \][\s\S]{0,200}exit 1/,
  'must exit non-zero with a clear error if SUPABASE_SERVICE_ROLE_KEY is unset',
);

// Must route through the project's single canonical notification RPC
// (notify_telegram) rather than calling the Telegram Bot API directly —
// keeps dedupe/logging/bot-token handling in one place.
assert.match(yml, /\/rest\/v1\/rpc\/notify_telegram/, 'must call the notify_telegram RPC, not the Telegram API directly');
assert.match(yml, /p_dedupe_key/, 'must pass a dedupe key so repeated failures of the same workflow do not spam');

// Must check the RPC call's own HTTP status and fail the job on error —
// a curl call with no status check would silently swallow delivery
// failures (e.g. an expired/revoked service_role key). Checked as
// independent assertions rather than one long spanning regex, so a
// harmless reflow of the surrounding echo/cat lines can't break this
// check the same way the tightly-bounded version just did.
assert.match(yml, /HTTP_CODE=\$\(curl/, 'must capture the curl response status code into HTTP_CODE');
assert.match(yml, /-w\s+"%\{http_code\}"/, 'curl must request the HTTP status code via -w "%{http_code}"');
assert.match(yml, /if \[ "\$HTTP_CODE" -ge 300 \]/, 'must branch on HTTP_CODE >= 300');

console.log('alert-on-automation-failure.yml contract checks passed.');
