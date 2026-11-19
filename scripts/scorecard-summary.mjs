#!/usr/bin/env node
// Turns an OpenSSF Scorecard JSON result into a short Markdown summary. No dependencies.
//
//   node scripts/scorecard-summary.mjs scorecard.json
//
// Used by .github/workflows/scorecard.yml. Exits 1 only if the file is not a Scorecard result, so a
// low score never fails the job.
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: scorecard-summary.mjs <scorecard.json>');
  process.exit(1);
}
let result;
try {
  result = JSON.parse(readFileSync(file, 'utf8'));
} catch (err) {
  console.error(`scorecard-summary: cannot read ${file}: ${err.message}`);
  process.exit(1);
}
if (!result || typeof result !== 'object' || !Array.isArray(result.checks)) {
  console.error(`scorecard-summary: ${file} is not a Scorecard result (no "checks" list)`);
  process.exit(1);
}

// Text from the result goes into a table cell: one line, no pipes, no markup.
const cell = (value) =>
  String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/[<>`]/g, '')
    .slice(0, 300)
    .trim();
// Scorecard uses -1 for "could not be determined".
const score = (n) => (typeof n === 'number' && n >= 0 ? `${n} / 10` : 'not determined');

const checks = [...result.checks].sort((a, b) => String(a.name).localeCompare(String(b.name)));
const lines = [
  '## OpenSSF Scorecard',
  '',
  `Overall: **${score(result.score)}**`,
  '',
  `Scorecard ${cell(result.scorecard?.version) || 'version unknown'}, commit \`${cell(result.repo?.commit).slice(0, 12) || 'unknown'}\`, ${cell(result.date) || 'date unknown'}.`,
  '',
  '| Check | Score | Reason |',
  '|---|---|---|',
  ...checks.map((c) => `| ${cell(c.name)} | ${score(c.score)} | ${cell(c.reason)} |`),
  '',
  'Informational: this result is not published and does not fail the job.',
];
console.log(lines.join('\n'));
