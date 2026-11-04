// Reference verifier for Hosannaith signed results. Verifies a single result or a batch (the batch
// signature and every per-result signature) against the published key set.
//
//   node_modules/.bin/tsx scripts/verify-signature.ts result.json
//   cat result.json | node_modules/.bin/tsx scripts/verify-signature.ts -
//   ... --keys https://api.hosannaith.com/.well-known/hosannaith-keys.json   (default)
//   ... --keys ./attest/jwks-history.json                                    (offline)
//
// Exit code 0 only if every signature verifies.
import { readFileSync } from 'node:fs';
import { verifyAttestation, verifyBatch, type KeySet, type VerifyOutcome } from '../src/attest/verify.js';

const DEFAULT_KEYS = 'https://api.hosannaith.com/.well-known/hosannaith-keys.json';

async function readInput(arg: string): Promise<string> {
  if (arg !== '-') return readFileSync(arg, 'utf8');
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

async function loadKeys(src: string): Promise<KeySet> {
  if (/^https?:\/\//.test(src)) {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`could not fetch keys from ${src} (HTTP ${res.status})`);
    return (await res.json()) as KeySet;
  }
  return JSON.parse(readFileSync(src, 'utf8')) as KeySet;
}

const describe = (o: VerifyOutcome) => (o.ok ? `valid (kid ${o.kid})` : `INVALID: ${o.reason}${o.kid ? ` (kid ${o.kid})` : ''}`);

async function main() {
  const args = process.argv.slice(2);
  const ki = args.indexOf('--keys');
  const keysSrc = ki >= 0 ? args[ki + 1] : DEFAULT_KEYS;
  const input = args.find((a, i) => (ki < 0 || (i !== ki && i !== ki + 1)) && a !== '--keys');
  if (!input || !keysSrc) {
    console.error('usage: verify-signature.ts <result.json | -> [--keys <url-or-file>]');
    process.exit(2);
  }
  const doc = JSON.parse(await readInput(input));
  const keys = await loadKeys(keysSrc);

  if (Array.isArray(doc?.results)) {
    const v = verifyBatch(doc, keys);
    console.log(`batch signature: ${describe(v.outer)}`);
    v.results.forEach((r, i) => console.log(`result ${i} (${doc.results[i]?.target ?? '?'}): ${describe(r)}`));
    console.log(v.ok ? 'OK: every signature verifies' : 'FAILED');
    process.exit(v.ok ? 0 : 1);
  }
  const v = verifyAttestation(doc, keys);
  const label = doc?.type === 'hosannaith.reliability-report' ? `report ${doc.id}` : `result (${doc?.target ?? '?'})`;
  console.log(`${label}: ${describe(v)}`);
  process.exit(v.ok ? 0 : 1);
}

main().catch((e) => {
  console.error('verify-signature: ' + (e as Error).message);
  process.exit(2);
});
