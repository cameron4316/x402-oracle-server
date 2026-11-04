import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The client SDK ships its own copy of the verifier so it has no dependency on the server code.
// The copies must stay byte-identical, or the SDK could verify differently from the server.
for (const file of ['format.ts', 'jcs.ts', 'keys.ts', 'verify.ts']) {
  test(`sdk/typescript/attest/${file} is identical to src/attest/${file}`, () => {
    assert.equal(readFileSync(`sdk/typescript/attest/${file}`, 'utf8'), readFileSync(`src/attest/${file}`, 'utf8'));
  });
}
