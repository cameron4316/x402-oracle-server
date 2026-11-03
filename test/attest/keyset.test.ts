import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicJwk, thumbprint } from '../../src/attest/keys.js';
import { DEFAULT_HISTORY_PATH, loadKeyHistory, loadSigner, publishedKeySet, type KeyHistory } from '../../src/attest/keyset.js';
import { attest } from '../../src/attest/sign.js';
import { verifyAttestation } from '../../src/attest/verify.js';

const dir = mkdtempSync(join(tmpdir(), 'attest-keyset-'));

function keyFile(name: string) {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const path = join(dir, name);
  writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, { mode: 0o400 });
  const jwk = publicJwk(privateKey);
  return { path, entry: { ...jwk, kid: thumbprint(jwk), status: 'active' as const, activated_at: '2026-11-03T00:00:00Z' } };
}

function historyFile(h: object) {
  const path = join(dir, `history-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(h));
  return path;
}

test('the committed key history is valid and contains public keys only', () => {
  const h = loadKeyHistory(DEFAULT_HISTORY_PATH);
  assert.ok(Array.isArray(h.keys) && Array.isArray(h.revoked_keys));
  assert.equal(readFileSync(DEFAULT_HISTORY_PATH, 'utf8').includes('"d"'), false);
});

test('no SIGNING_KEY_PATH: no signer, results stay unsigned', () => {
  assert.equal(loadSigner(undefined, { keys: [], revoked_keys: [] }), null);
  assert.equal(loadSigner('', { keys: [], revoked_keys: [] }), null);
});

test('a key published as active signs, and its signatures verify against the published key set', () => {
  const k = keyFile('active.pem');
  const history: KeyHistory = { keys: [k.entry], revoked_keys: [] };
  const signer = loadSigner(k.path, history);
  assert.ok(signer);
  assert.equal(signer.kid, k.entry.kid);
  const signed = attest(signer, { target: 'https://a.example', score: 99 });
  assert.equal(verifyAttestation(JSON.parse(JSON.stringify(signed)), publishedKeySet(history)).ok, true);
});

test('the server refuses to start with a key that is not published as active', () => {
  const k = keyFile('unpublished.pem');
  assert.throws(() => loadSigner(k.path, { keys: [], revoked_keys: [] }), /not published as "active"/);
  assert.throws(() => loadSigner(k.path, { keys: [{ ...k.entry, status: 'retired' }], revoked_keys: [] }), /not published as "active"/);
});

test('unreadable or invalid key files fail with a message that never contains key material', () => {
  assert.throws(() => loadSigner(join(dir, 'missing.pem'), { keys: [], revoked_keys: [] }), /cannot read the signing key at SIGNING_KEY_PATH \(ENOENT\)/);
  const bad = join(dir, 'bad.pem');
  writeFileSync(bad, 'SECRET-LOOKING-CONTENT');
  assert.throws(
    () => loadSigner(bad, { keys: [], revoked_keys: [] }),
    (err: Error) => /not contain a valid EC P-256 private key/.test(err.message) && !err.message.includes('SECRET'),
  );
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const wrongCurve = join(dir, 'k1.pem');
  writeFileSync(wrongCurve, privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
  assert.throws(() => loadSigner(wrongCurve, { keys: [], revoked_keys: [] }), /EC P-256/);
});

test('key history validation rejects private material, wrong kids, two active keys, revoked-but-listed', () => {
  const a = keyFile('a.pem').entry;
  const b = keyFile('b.pem').entry;
  assert.throws(() => loadKeyHistory(historyFile({ keys: [{ ...a, d: 'x' }] })), /PRIVATE/);
  assert.throws(() => loadKeyHistory(historyFile({ keys: [{ ...a, kid: b.kid }] })), /thumbprint/);
  assert.throws(() => loadKeyHistory(historyFile({ keys: [a, b] })), /more than one active/);
  assert.throws(() => loadKeyHistory(historyFile({ keys: [a], revoked_keys: [{ kid: a.kid, revoked_at: 'x' }] })), /still listed/);
  const ok = loadKeyHistory(historyFile({ keys: [a, { ...b, status: 'retired' }] }));
  assert.equal(ok.keys.length, 2);
});

test('the published key set marks every key ES256/sig and keeps revoked keys out of keys[]', () => {
  const a = keyFile('pa.pem').entry;
  const published = publishedKeySet({ keys: [a], revoked_keys: [{ kid: 'gone', revoked_at: '2026-11-03T00:00:00Z' }] });
  assert.equal(published.keys[0].alg, 'ES256');
  assert.equal(published.keys[0].use, 'sig');
  assert.deepEqual(published.revoked_keys.map((r) => r.kid), ['gone']);
});

// The keygen script runs under tsx; skipped where tsx is not installed.
const tsx = join(process.cwd(), 'node_modules', '.bin', 'tsx');
test('keygen writes a 0400 private key, refuses to overwrite, and prints only the public entry', { skip: !existsSync(tsx) }, () => {
  const out = join(dir, 'gen', 'signing.pem');
  const r = spawnSync(tsx, ['scripts/attest-keygen.ts', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(statSync(out).mode & 0o777, 0o400);
  assert.equal(/PRIVATE KEY|"d"/.test(r.stdout), false, 'stdout must not contain private key material');
  const entry = JSON.parse(r.stdout);
  assert.equal(entry.kid, thumbprint(entry));
  assert.equal(entry.status, 'active');

  const again = spawnSync(tsx, ['scripts/attest-keygen.ts', out], { encoding: 'utf8' });
  assert.equal(again.status, 1);
  assert.match(again.stderr, /refusing to write/);

  const show = spawnSync(tsx, ['scripts/attest-keygen.ts', '--show-public', out], { encoding: 'utf8' });
  assert.equal(JSON.parse(show.stdout).kid, entry.kid);
});
