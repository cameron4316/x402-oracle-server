import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
// The server's signer, used here only to produce realistic signed results.
import { attest, attestBatch, createSigner } from '../../../src/attest/sign.js';
import { publicJwk, thumbprint } from '../attest/keys.js';
import {
  HosannaithClient,
  HosannaithVerificationError,
  ReliabilityGuardError,
  getVerification,
  wrapFetchWithReliabilityGuard,
  type GuardDecision,
} from '../index.js';

const BASE = 'https://oracle.test';
const TARGET = 'https://endpoint.test/x402';

function newKey() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicJwk(privateKey);
  return { signer: createSigner(privateKey), entry: { ...jwk, kid: thumbprint(jwk), alg: 'ES256', use: 'sig', status: 'active' } };
}

const baseResult = (score = 97) => ({
  target: TARGET,
  checkId: 'reliability',
  status: score >= 90 ? 'pass' : 'fail',
  score,
  detail: { observations: 480, windowHours: 24, confidence: 'history' },
  observedAt: '2026-11-04T19:06:12.319Z',
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// Fake key-set server (global fetch) whose responses can change between calls.
function serveKeys(responses: Array<object | number>) {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    assert.equal(url, `${BASE}/.well-known/hosannaith-keys.json`);
    const r = responses[Math.min(calls++, responses.length - 1)];
    return typeof r === 'number' ? new Response('down', { status: r }) : json(r);
  }) as typeof fetch;
  return { calls: () => calls, restore: () => (globalThis.fetch = original) };
}

// Fake paid oracle (the client's paying fetch).
const oracle = (body: unknown) => (async () => json(body)) as unknown as typeof fetch;

test('a correctly signed result is returned unchanged and marked verified', async () => {
  const k = newKey();
  const signed = attest(k.signer, baseResult());
  const keys = serveKeys([{ keys: [k.entry], revoked_keys: [] }]);
  try {
    const client = new HosannaithClient({ payingFetch: oracle(signed), baseUrl: BASE });
    const r = await client.getReliability(TARGET);
    assert.deepEqual(r, JSON.parse(JSON.stringify(signed)), 'the result object is not modified');
    assert.equal(getVerification(r), 'verified');
  } finally {
    keys.restore();
  }
});

test('a tampered score throws signature_invalid', async () => {
  const k = newKey();
  const tampered = { ...attest(k.signer, baseResult(40)), score: 99, status: 'pass' };
  const keys = serveKeys([{ keys: [k.entry] }]);
  try {
    const client = new HosannaithClient({ payingFetch: oracle(tampered), baseUrl: BASE });
    await assert.rejects(client.getReliability(TARGET), (e: unknown) => e instanceof HosannaithVerificationError && e.reason === 'signature_invalid');
  } finally {
    keys.restore();
  }
});

test('an unsigned result throws signature_missing', async () => {
  const k = newKey();
  const keys = serveKeys([{ keys: [k.entry] }]);
  try {
    const client = new HosannaithClient({ payingFetch: oracle(baseResult()), baseUrl: BASE });
    await assert.rejects(client.getReliability(TARGET), (e: unknown) => (e as HosannaithVerificationError).reason === 'signature_missing');
  } finally {
    keys.restore();
  }
});

test('a revoked key throws revoked_kid', async () => {
  const k = newKey();
  const keys = serveKeys([{ keys: [], revoked_keys: [{ kid: k.entry.kid, revoked_at: '2026-11-04T00:00:00Z' }] }]);
  try {
    const client = new HosannaithClient({ payingFetch: oracle(attest(k.signer, baseResult())), baseUrl: BASE });
    await assert.rejects(client.getReliability(TARGET), (e: unknown) => (e as HosannaithVerificationError).reason === 'revoked_kid');
  } finally {
    keys.restore();
  }
});

test('a key published after the cache was filled is picked up with one refetch (rotation)', async () => {
  const oldKey = newKey();
  const newer = newKey();
  const keys = serveKeys([{ keys: [oldKey.entry] }, { keys: [oldKey.entry, newer.entry] }]);
  try {
    const client = new HosannaithClient({ payingFetch: oracle(attest(newer.signer, baseResult())), baseUrl: BASE });
    const r = await client.getReliability(TARGET);
    assert.equal(getVerification(r), 'verified');
    assert.equal(keys.calls(), 2);
  } finally {
    keys.restore();
  }
});

test("key set unreachable: 'auto' returns the result marked jwks_unavailable, 'strict' throws", async () => {
  const k = newKey();
  const signed = attest(k.signer, baseResult());
  const keys = serveKeys([503]);
  try {
    const auto = await new HosannaithClient({ payingFetch: oracle(signed), baseUrl: BASE }).getReliability(TARGET);
    assert.equal(getVerification(auto), 'jwks_unavailable');
    const strict = new HosannaithClient({ payingFetch: oracle(signed), baseUrl: BASE, verify: 'strict' });
    await assert.rejects(strict.getReliability(TARGET), (e: unknown) => (e as HosannaithVerificationError).reason === 'jwks_unavailable');
  } finally {
    keys.restore();
  }
});

test("verify: 'off' skips verification entirely", async () => {
  const keys = serveKeys([500]);
  try {
    const r = await new HosannaithClient({ payingFetch: oracle(baseResult()), baseUrl: BASE, verify: 'off' }).getReliability(TARGET);
    assert.equal(getVerification(r), 'verification_skipped');
    assert.equal(keys.calls(), 0);
  } finally {
    keys.restore();
  }
});

test('batch: verified as a whole and per item; a swapped item is rejected', async () => {
  const k = newKey();
  const batch = attestBatch(k.signer, { results: [baseResult(97), { ...baseResult(95), target: 'https://other.test' }], count: 2, requested: 2, capped: false, observedAt: '2026-11-04T19:06:12.319Z' });
  const keys = serveKeys([{ keys: [k.entry] }]);
  try {
    const client = new HosannaithClient({ payingFetch: oracle(batch), baseUrl: BASE });
    const b = await client.getReliabilityBatch([TARGET, 'https://other.test']);
    assert.equal(getVerification(b), 'verified');
    assert.equal(getVerification(b.results[1]), 'verified');

    const swapped = { ...batch, results: [attest(k.signer, baseResult(10)), batch.results[1]] };
    const bad = new HosannaithClient({ payingFetch: oracle(swapped), baseUrl: BASE });
    await assert.rejects(bad.getReliabilityBatch([TARGET]), (e: unknown) => (e as HosannaithVerificationError).reason === 'signature_invalid');
  } finally {
    keys.restore();
  }
});

// ---------- the guard ----------

function guarded(oracleBody: unknown, extra: Record<string, unknown> = {}) {
  const decisions: GuardDecision[] = [];
  let paid = 0;
  const inner = (async () => {
    paid++;
    return new Response('paid content');
  }) as unknown as typeof fetch;
  const guard = wrapFetchWithReliabilityGuard(inner, {
    payingFetch: oracle(oracleBody),
    baseUrl: BASE,
    onDecision: (d) => decisions.push(d),
    ...extra,
  });
  return { guard, decisions, paid: () => paid };
}

test('guard: a verified passing score lets the payment through and records verified', async () => {
  const k = newKey();
  const keys = serveKeys([{ keys: [k.entry] }]);
  try {
    const g = guarded(attest(k.signer, baseResult(97)));
    const res = await g.guard(TARGET);
    assert.equal(await res.text(), 'paid content');
    assert.equal(g.decisions[0].allow, true);
    assert.equal(g.decisions[0].verification, 'verified');
  } finally {
    keys.restore();
  }
});

test('guard: a forged high score is blocked even with onError allow (fail-closed on signatures)', async () => {
  const k = newKey();
  const forged = { ...attest(k.signer, baseResult(20)), score: 98, status: 'pass' };
  const keys = serveKeys([{ keys: [k.entry] }]);
  try {
    const g = guarded(forged, { onError: 'allow' });
    await assert.rejects(g.guard(TARGET), (e: unknown) => e instanceof ReliabilityGuardError && e.decision.verification === 'signature_invalid');
    assert.equal(g.paid(), 0, 'nothing was paid');
  } finally {
    keys.restore();
  }
});

test("guard: an unreachable key set follows the fail-open default, and 'strict' blocks it", async () => {
  const k = newKey();
  const keys = serveKeys([503]);
  try {
    const open = guarded(attest(k.signer, baseResult(97)));
    await open.guard(TARGET);
    assert.equal(open.decisions[0].allow, true);
    assert.equal(open.decisions[0].verification, 'jwks_unavailable');

    const strict = guarded(attest(k.signer, baseResult(97)), { verify: 'strict' });
    await assert.rejects(strict.guard(TARGET), (e: unknown) => (e as ReliabilityGuardError).decision.verification === 'jwks_unavailable');
    assert.equal(strict.paid(), 0);
  } finally {
    keys.restore();
  }
});
