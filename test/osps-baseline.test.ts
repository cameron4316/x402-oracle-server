// docs/osps-baseline.md must list exactly the pinned OpenSSF Baseline Level 1 requirements, with
// summary counts that match its rows and evidence files that exist (scripts/check-osps-baseline.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('the OpenSSF Baseline self-assessment lists every pinned Level 1 requirement, with evidence that exists', () => {
  const script = fileURLToPath(new URL('../scripts/check-osps-baseline.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /^ok /);
});
