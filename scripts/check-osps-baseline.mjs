#!/usr/bin/env node
// Keeps docs/osps-baseline.md honest about its own shape. No dependencies.
//
// Offline (run by the tests): the page lists exactly the Level 1 requirement ids pinned in
// docs/osps-baseline-l1.json, each once, each with a known status; the summary counts match the
// rows; and every file named in an evidence column exists.
//
//   node scripts/check-osps-baseline.mjs
//   node scripts/check-osps-baseline.mjs --source <checkout of ossf/security-baseline>
//   node scripts/check-osps-baseline.mjs --page <file>     check a copy of the page (used by the tests)
//
// With --source it also confirms the pinned list against the baseline's own checklist file, so the
// ids cannot drift from the version the page names.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'docs/osps-baseline-l1.json'), 'utf8'));
const pageAt = process.argv.indexOf('--page');
const pageFile = pageAt === -1 ? join(root, 'docs/osps-baseline.md') : process.argv[pageAt + 1];
const page = readFileSync(pageFile, 'utf8');
// Words the page puts in code spans that are not files in this repository. Anything else in a code
// span in an evidence cell must exist as a path, unless it is a URL or an address on the service.
const NOT_PATHS = new Set(['main', 'pull_request', 'pull_request_target', 'contents: read', '.env']);
const STATUSES = ['Met', 'Not applicable', 'To confirm', 'Not met'];
const problems = [];
let checks = 0;
const check = (ok, message) => {
  checks++;
  if (!ok) problems.push(message);
};

// --- the rows
const rows = new Map();
for (const line of page.split('\n')) {
  const cells = line.split('|').map((c) => c.trim());
  if (!/^OSPS-[A-Z]{2}-\d{2}\.\d{2}$/.test(cells[1] ?? '')) continue;
  const [, id, asks, status, evidence] = cells;
  check(!rows.has(id), `${id} is listed more than once`);
  rows.set(id, { asks, status, evidence });
  check(STATUSES.includes(status), `${id}: unknown status "${status}"`);
  check(asks.length > 0 && evidence.length > 0, `${id}: the row is incomplete`);
  for (const match of evidence.matchAll(/`([^`]+)`/g)) {
    const path = match[1];
    if (/^https?:\/\/|^\//.test(path) || NOT_PATHS.has(path)) continue;
    check(existsSync(join(root, path)), `${id}: the evidence names ${path}, which does not exist`);
  }
}

// --- exactly the pinned requirements
for (const id of manifest.requirements) check(rows.has(id), `${id} is in the pinned list but not on the page`);
for (const id of rows.keys()) check(manifest.requirements.includes(id), `${id} is on the page but not in the pinned list`);
check(new Set(manifest.requirements).size === manifest.requirements.length, 'the pinned list repeats an id');

// --- no id anywhere on the page that is not pinned (prose included)
for (const match of page.matchAll(/OSPS-[A-Z]{2}-\d{2}\.\d{2}/g)) {
  check(manifest.requirements.includes(match[0]), `${match[0]} is mentioned on the page but is not a pinned Level 1 requirement`);
}

// --- the summary says what the rows say
const count = (status) => [...rows.values()].filter((r) => r.status === status).length;
const summary = (label) => Number(page.match(new RegExp(`\\| ${label} \\| (\\d+) \\|`))?.[1] ?? NaN);
check(summary('Level 1 requirements') === manifest.requirements.length, 'the summary total does not match the pinned list');
for (const status of STATUSES) check(summary(status) === count(status), `the summary says ${summary(status)} "${status}", the table has ${count(status)}`);

// --- the page names the version and commit it was checked against
check(page.includes(manifest.baseline.version), 'the page does not name the pinned baseline version');
check(page.includes(manifest.baseline.commit), 'the page does not name the pinned commit');

// --- optionally, against the baseline's own file
const sourceAt = process.argv.indexOf('--source');
if (sourceAt !== -1) {
  const file = join(process.argv[sourceAt + 1] ?? '', manifest.baseline.path);
  if (!existsSync(file)) {
    problems.push(`--source: ${file} does not exist`);
  } else {
    const text = readFileSync(file, 'utf8');
    const start = text.indexOf('## Level 1');
    const end = text.indexOf('## Level 2');
    const upstream = [...text.slice(start, end === -1 ? undefined : end).matchAll(/\*\*(OSPS-[A-Z]{2}-\d{2}\.\d{2})\*\*/g)].map((m) => m[1]);
    check(start !== -1 && upstream.length > 0, '--source: no Level 1 section found in the checklist');
    for (const id of upstream) check(manifest.requirements.includes(id), `${id} is a Level 1 requirement upstream but is not in the pinned list`);
    for (const id of manifest.requirements) check(upstream.includes(id), `${id} is pinned but is not a Level 1 requirement upstream`);
  }
}

if (problems.length > 0) {
  console.error(`FAILED: ${problems.length} problem(s) in ${pageAt === -1 ? 'docs/osps-baseline.md' : pageFile}`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`ok    ${checks} checks: ${rows.size} Level 1 requirements, ${STATUSES.map((s) => `${count(s)} ${s.toLowerCase()}`).join(', ')}.`);
