// The FINOS AI Governance Framework ids we use must all come from calm/aigf-sources.json, and every
// link and CALM control must point at the source file named there (scripts/check-aigf-ids.mjs, run
// offline here; CI also checks the manifest against the framework repository itself).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('every AIGF id in the mapping page and the CALM controls has a source file in the manifest', () => {
  const script = fileURLToPath(new URL('../scripts/check-aigf-ids.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /^ok /);
});
