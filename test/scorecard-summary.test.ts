// scripts/scorecard-summary.mjs writes the Scorecard job summary. It must never fail on a low
// score, must fail on a file that is not a Scorecard result, and must keep result text inside its
// table cell.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/scorecard-summary.mjs', import.meta.url));
const run = (content: unknown) => {
  const file = join(mkdtempSync(join(tmpdir(), 'scorecard-')), 'scorecard.json');
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
};

test('a low score is summarised, not treated as a failure', () => {
  const out = run({
    date: '2026-11-19T00:00:00Z',
    repo: { name: 'github.com/example/example', commit: '0123456789abcdef0123456789abcdef01234567' },
    scorecard: { version: 'v5.0.0' },
    score: 2.5,
    checks: [
      { name: 'Token-Permissions', score: 0, reason: 'detected GitHub workflow tokens with excessive permissions' },
      { name: 'Binary-Artifacts', score: 10, reason: 'no binaries found in the repo' },
      { name: 'Signed-Releases', score: -1, reason: 'no releases found' },
    ],
  });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /Overall: \*\*2\.5 \/ 10\*\*/);
  assert.match(out.stdout, /\| Binary-Artifacts \| 10 \/ 10 \| no binaries found in the repo \|/);
  assert.match(out.stdout, /\| Signed-Releases \| not determined \| no releases found \|/);
  assert.match(out.stdout, /commit `0123456789ab`/);
  // Checks come out in name order, whatever order Scorecard used.
  assert.ok(out.stdout.indexOf('Binary-Artifacts') < out.stdout.indexOf('Token-Permissions'));
});

test('text from the result cannot break out of its table cell', () => {
  const out = run({ score: 5, checks: [{ name: 'A | B', score: 5, reason: 'line one\nline two | <img src=x> `code` \\' }] });
  assert.equal(out.status, 0, out.stderr);
  const row = out.stdout.split('\n').find((l) => l.startsWith('| A'));
  assert.equal(row, '| A \\| B | 5 / 10 | line one line two \\| img src=x code \\\\ |');
});

test('a file that is not a Scorecard result is an error', () => {
  assert.equal(run({ error: 'rate limited' }).status, 1);
  assert.equal(run('not json').status, 1);
});
