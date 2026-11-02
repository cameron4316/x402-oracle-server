#!/usr/bin/env node
// Dependency license gate. Reads `pnpm licenses list --prod --json` on stdin and fails if any
// production dependency is under a license outside the allowlist (no AGPL / SSPL / GPL).
//
//   pnpm licenses list --prod --json | node scripts/check-licenses.mjs
//
// SPDX expressions are evaluated: "A OR B" passes if either side is allowed, "A AND B" only if both
// are. Anything unparseable or "Unknown" fails, so a human looks at it rather than the gate guessing.

const ALLOWED = new Set([
  'Apache-2.0',
  'MIT',
  'MIT-0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  '0BSD',
  'CC0-1.0',
  'Unlicense',
  'BlueOak-1.0.0',
]);

// Minimal SPDX expression evaluator: identifiers, AND, OR, parentheses, "WITH <exception>".
export function allowed(expr, allow = ALLOWED) {
  const tokens = String(expr)
    .replace(/[()]/g, (m) => ` ${m} `)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];

  function primary() {
    const t = next();
    if (t === undefined) throw new Error('unexpected end');
    if (t === '(') {
      const v = or();
      if (next() !== ')') throw new Error('missing )');
      return v;
    }
    if (peek() === 'WITH') {
      next();
      next(); // exceptions only widen permissions; judge the base license
    }
    return allow.has(t.replace(/\+$/, ''));
  }
  function and() {
    let v = primary();
    while (peek() === 'AND') {
      next();
      v = primary() && v;
    }
    return v;
  }
  function or() {
    let v = and();
    while (peek() === 'OR') {
      next();
      v = and() || v;
    }
    return v;
  }

  const v = or();
  if (i !== tokens.length) throw new Error('trailing tokens');
  return v;
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  if (!input.trim()) {
    console.error('check-licenses: no input (pipe `pnpm licenses list --prod --json` into this script)');
    process.exit(2);
  }
  const byLicense = JSON.parse(input);
  const bad = [];
  let count = 0;
  for (const [license, pkgs] of Object.entries(byLicense)) {
    let ok;
    try {
      ok = allowed(license);
    } catch {
      ok = false;
    }
    for (const p of pkgs) {
      count++;
      if (!ok) bad.push(`${p.name}@${(p.versions ?? [p.version]).join(',')}: ${license}`);
    }
  }
  if (bad.length) {
    console.error(`check-licenses: ${bad.length} dependency(ies) outside the allowlist:`);
    for (const b of bad) console.error('  - ' + b);
    console.error('Allowed: ' + [...ALLOWED].join(', '));
    process.exit(1);
  }
  console.log(`check-licenses: ${count} production dependencies, all allowed.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error('check-licenses: ' + e.message);
    process.exit(2);
  });
}
