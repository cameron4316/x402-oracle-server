import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// npm packs files from the package directory only, so each published package carries its own copy
// of LICENSE and NOTICE. These must stay byte-identical to the repository root copies.
const PACKAGES = ['mcp', 'sdk/typescript'];

for (const file of ['LICENSE', 'NOTICE']) {
  const root = readFileSync(file, 'utf8');
  for (const dir of PACKAGES) {
    test(`${dir}/${file} matches the root ${file}`, () => {
      assert.equal(readFileSync(`${dir}/${file}`, 'utf8'), root);
    });
  }
}

test('root LICENSE is the Apache License 2.0', () => {
  const text = readFileSync('LICENSE', 'utf8');
  assert.match(text, /Apache License\s+Version 2\.0, January 2004/);
});

test('every package.json declares Apache-2.0', () => {
  for (const f of ['package.json', 'mcp/package.json', 'sdk/typescript/package.json']) {
    const pkg = JSON.parse(readFileSync(f, 'utf8')) as { license?: string };
    assert.equal(pkg.license, 'Apache-2.0', f);
  }
});

test('hosannaith-mcp publishes LICENSE and NOTICE', () => {
  const pkg = JSON.parse(readFileSync('mcp/package.json', 'utf8')) as { files?: string[] };
  assert.ok(pkg.files?.includes('LICENSE'), 'files must include LICENSE');
  assert.ok(pkg.files?.includes('NOTICE'), 'files must include NOTICE');
});
