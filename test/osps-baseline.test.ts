// docs/osps-baseline.md must list exactly the pinned OpenSSF Baseline Level 1 requirements, with
// summary counts that match its rows and evidence files that exist (scripts/check-osps-baseline.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/check-osps-baseline.mjs', import.meta.url));
const page = readFileSync(fileURLToPath(new URL('../docs/osps-baseline.md', import.meta.url)), 'utf8');
/** Runs the check on a changed copy of the page. */
function checkCopy(change: (text: string) => string) {
  const changed = change(page);
  assert.notEqual(changed, page, 'the change must alter the page');
  const file = join(mkdtempSync(join(tmpdir(), 'osps-')), 'osps-baseline.md');
  writeFileSync(file, changed);
  return spawnSync(process.execPath, [script, '--page', file], { encoding: 'utf8' });
}

test('the OpenSSF Baseline self-assessment lists every pinned Level 1 requirement, with evidence that exists', () => {
  const run = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /^ok /);
});

test('the check catches a page that drifts from the pinned list or from the repository', () => {
  const cases: Array<[string, (text: string) => string, RegExp]> = [
    ['an evidence file that does not exist', (t) => t.replace('(`LICENSE`)', '(`LICENSE-2`)'), /names LICENSE-2, which does not exist/],
    // A lowercase bare name used to be taken for a keyword and skipped.
    ['a misspelt lowercase file name', (t) => t.replace('(`LICENSE`)', '(`licence`)'), /names licence, which does not exist/],
    ['a requirement removed', (t) => t.replace(/^\| OSPS-VM-02\.01 .*\n/m, ''), /OSPS-VM-02\.01 is in the pinned list but not on the page/],
    ['a requirement invented', (t) => t.replace('| OSPS-VM-02.01 |', '| OSPS-VM-09.09 |'), /OSPS-VM-09\.09 is on the page but not in the pinned list/],
    ['a status that is not one of the four', (t) => t.replace('| Not applicable | The project', '| Mostly met | The project'), /unknown status "Mostly met"/],
    ['a summary count that differs from the rows', (t) => t.replace('| Met | 22 |', '| Met | 23 |'), /the summary says 23 "Met", the table has 22/],
  ];
  for (const [name, change, expected] of cases) {
    const run = checkCopy(change);
    assert.equal(run.status, 1, name);
    assert.match(run.stderr, expected, name);
  }
});
