import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, webcrypto } from 'node:crypto';
import { canonicalize } from '../../src/attest/jcs.js';
import { publicJwk, thumbprint } from '../../src/attest/keys.js';
import { attest, attestBatch, createSigner, SPEC_VERSION } from '../../src/attest/sign.js';
import { verifyAttestation, verifyBatch, type KeySet } from '../../src/attest/verify.js';

function newKey() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicJwk(privateKey);
  const kid = thumbprint(jwk);
  return { privateKey, signer: createSigner(privateKey), published: { ...jwk, kid, alg: 'ES256', use: 'sig', status: 'active' as const } };
}

const result = () => ({
  target: 'https://a.example/x402',
  checkId: 'reliability',
  status: 'pass',
  score: 98.5,
  detail: { observations: 480, windowHours: 24, uptimePct: 100, p99LatencyMs: null, confidence: 'history' },
  observedAt: '2026-11-03T15:00:00.000Z',
});

// ---------- RFC 8785 ----------

test('JCS: RFC 8785 §3.2.4 example (numbers, string escapes, literals)', () => {
  const input = JSON.parse(
    '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],' +
      '"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/","literals":[null,true,false]}',
  );
  assert.equal(
    canonicalize(input),
    '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
  );
});

test('JCS: RFC 8785 §3.2.3 property sorting by UTF-16 code units', () => {
  const input = JSON.parse(
    '{"\\u20ac":"Euro Sign","\\r":"Carriage Return","\\ufb33":"Hebrew Letter Dalet With Dagesh","1":"One",' +
      '"\\ud83d\\ude00":"Emoji: Grinning Face","\\u0080":"Control","\\u00f6":"Latin Small Letter O With Diaeresis"}',
  );
  // Check the order in the canonical text itself (JSON.parse would re-order integer-like keys).
  const text = canonicalize(input);
  const positions = ['Carriage Return', 'One', 'Control', 'Latin Small', 'Euro Sign', 'Emoji', 'Hebrew'].map((s) => text.indexOf(s));
  assert.ok(positions.every((p) => p >= 0));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
});

test('JCS: rejects values another language would serialize differently', () => {
  assert.throws(() => canonicalize({ a: Number.NaN }));
  assert.throws(() => canonicalize({ a: Infinity }));
  assert.throws(() => canonicalize({ a: new Date() }));
  assert.throws(() => canonicalize({ a: 1n }));
  assert.equal(canonicalize({ b: 1, a: undefined, c: [undefined] }), '{"b":1,"c":[null]}');
});

// ---------- signing and verification ----------

test('a signed result verifies, carries spec_version and generated_at, and keeps every original field', () => {
  const k = newKey();
  const keys: KeySet = { keys: [k.published] };
  const signed = attest(k.signer, result(), '2026-11-03T15:00:01.000Z');
  assert.equal(signed.spec_version, SPEC_VERSION);
  assert.equal(signed.generated_at, '2026-11-03T15:00:01.000Z');
  assert.deepEqual({ ...signed, spec_version: undefined, generated_at: undefined, signature: undefined }, { ...result(), spec_version: undefined, generated_at: undefined, signature: undefined });
  assert.equal(signed.signature.alg, 'ES256');
  assert.equal(signed.signature.kid, k.published.kid);
  assert.equal(Buffer.from(signed.signature.sig, 'base64url').length, 64, 'raw r||s, not DER');
  assert.deepEqual(verifyAttestation(signed, keys), { ok: true, kid: k.published.kid });
});

test('the signature survives JSON transport and key reordering', () => {
  const k = newKey();
  const signed = attest(k.signer, result());
  const roundTripped = JSON.parse(JSON.stringify(signed));
  const reordered = Object.fromEntries(Object.entries(roundTripped).reverse());
  assert.equal(verifyAttestation(reordered, { keys: [k.published] }).ok, true);
});

test('WebCrypto (an independent ECDSA implementation) verifies our signature over the canonical bytes', async () => {
  const k = newKey();
  const signed = attest(k.signer, result());
  const { signature, ...unsigned } = signed;
  const key = await webcrypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: k.published.x, y: k.published.y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await webcrypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    Buffer.from(signature.sig, 'base64url'),
    Buffer.from(canonicalize(unsigned), 'utf8'),
  );
  assert.equal(ok, true);
});

test('every failure mode reports its own reason', () => {
  const k = newKey();
  const other = newKey();
  const signed = attest(k.signer, result());
  const keys: KeySet = { keys: [k.published] };

  const tampered = { ...signed, score: 12 };
  assert.deepEqual(verifyAttestation(tampered, keys), { ok: false, reason: 'signature_invalid', kid: k.published.kid });

  const tamperedDetail = { ...signed, detail: { ...signed.detail, uptimePct: 50 } };
  assert.equal((verifyAttestation(tamperedDetail, keys) as { reason: string }).reason, 'signature_invalid');

  const { signature: _s, ...stripped } = signed;
  assert.deepEqual(verifyAttestation(stripped, keys), { ok: false, reason: 'signature_missing' });

  assert.equal((verifyAttestation(signed, { keys: [other.published] }) as { reason: string }).reason, 'unknown_kid');
  assert.equal((verifyAttestation(signed, { keys: [k.published], revoked_keys: [{ kid: k.published.kid }] }) as { reason: string }).reason, 'revoked_kid');
  assert.equal((verifyAttestation({ ...signed, signature: { ...signed.signature, alg: 'none' } }, keys) as { reason: string }).reason, 'unsupported_alg');
  assert.equal((verifyAttestation({ ...signed, signature: { ...signed.signature, sig: 'abc' } }, keys) as { reason: string }).reason, 'malformed_signature');

  // A key-set entry whose kid does not match its own key material is not trusted.
  const lying = { keys: [{ ...other.published, kid: k.published.kid }] };
  assert.equal((verifyAttestation(signed, lying) as { reason: string }).reason, 'unknown_kid');

  // Re-signing with another key under the original kid fails.
  const forged = { ...attest(other.signer, result()), signature: { ...attest(other.signer, result()).signature, kid: k.published.kid } };
  assert.equal((verifyAttestation(forged, keys) as { reason: string }).reason, 'signature_invalid');
});

test('signing an already-signed object is refused', () => {
  const k = newKey();
  const signed = attest(k.signer, result());
  assert.throws(() => k.signer.sign(signed as unknown as Record<string, unknown>));
});

// ---------- batches ----------

test('batch: outer and every per-result signature verify; one result extracted still verifies alone', () => {
  const k = newKey();
  const keys: KeySet = { keys: [k.published] };
  const batch = attestBatch(k.signer, { results: [result(), { ...result(), target: 'https://b.example/x402' }], count: 2, requested: 2, capped: false, observedAt: '2026-11-03T15:00:00.000Z' });
  const v = verifyBatch(batch, keys);
  assert.equal(v.ok, true);
  assert.equal(v.results.length, 2);
  const extracted = JSON.parse(JSON.stringify(batch.results[1]));
  assert.equal(verifyAttestation(extracted, keys).ok, true);
});

test('batch: the outer signature covers the per-result signatures and the batch metadata', () => {
  const k = newKey();
  const keys: KeySet = { keys: [k.published] };
  const batch = attestBatch(k.signer, { results: [result()], count: 1, requested: 1, capped: false, observedAt: '2026-11-03T15:00:00.000Z' });

  // Swapping in a different (validly signed) result breaks the outer signature.
  const swapped = { ...batch, results: [attest(k.signer, { ...result(), score: 10 })] };
  const v1 = verifyBatch(swapped, keys);
  assert.equal(v1.results[0].ok, true);
  assert.equal(v1.outer.ok, false);

  // Changing batch metadata breaks the outer signature only.
  const v2 = verifyBatch({ ...batch, capped: true }, keys);
  assert.equal(v2.outer.ok, false);
  assert.equal(v2.results[0].ok, true);

  // Dropping a result breaks the outer signature.
  assert.equal(verifyBatch({ ...batch, results: [] }, keys).ok, false);
});
