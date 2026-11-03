// Generates a new attestation signing key on the machine that will use it.
//
//   node_modules/.bin/tsx scripts/attest-keygen.ts <private-key-path>
//   node_modules/.bin/tsx scripts/attest-keygen.ts --show-public <private-key-path>
//
// Writes the PRIVATE key (PKCS#8 PEM, EC P-256) to <private-key-path> with mode 0400, refusing to
// overwrite an existing file, and prints ONLY the public key entry to add to
// attest/jwks-history.json. The private key is never printed. Deliberately no backup: losing it
// means rotating to a new key, and prior attestations stay verifiable through the published history.
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { publicJwk, thumbprint } from '../src/attest/keys.js';

function entryFor(key: Parameters<typeof publicJwk>[0], activatedAt: string | null) {
  const jwk = publicJwk(key);
  return {
    ...jwk,
    kid: thumbprint(jwk),
    alg: 'ES256',
    use: 'sig',
    status: 'active',
    activated_at: activatedAt,
  };
}

const args = process.argv.slice(2);
const show = args[0] === '--show-public';
const target = show ? args[1] : args[0];
if (!target) {
  console.error('usage: attest-keygen.ts <private-key-path> | --show-public <private-key-path>');
  process.exit(2);
}
const path = resolve(target);

if (show) {
  const key = createPrivateKey(readFileSync(path, 'utf8'));
  console.log(JSON.stringify(entryFor(key, null), null, 2));
  process.exit(0);
}

mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
try {
  writeFileSync(path, pem, { mode: 0o400, flag: 'wx' }); // wx: never overwrite an existing key
} catch (err) {
  console.error(`attest-keygen: refusing to write ${path} (${(err as NodeJS.ErrnoException).code}). Nothing was changed.`);
  process.exit(1);
}
chmodSync(path, 0o400);

console.error(`attest-keygen: private key written to ${path} (mode 0400). It is not printed and must never leave this machine.`);
console.error('attest-keygen: add this PUBLIC entry to attest/jwks-history.json "keys" (set activated_at when you enable it):');
console.log(JSON.stringify(entryFor(privateKey, null), null, 2));
