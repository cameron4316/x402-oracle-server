import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { evaluate, type Evaluation } from '../src/evaluate.ts';
import { contractDoc, makeOracle, NOW, spec } from './helpers.ts';

const oracle = makeOracle();
const loaded = (value: unknown) => ({ ok: true as const, value });
const run = (overrides: Record<string, unknown>, document: unknown, keySet: unknown = oracle.keySet, now = NOW): Evaluation =>
  evaluate({ spec: spec(overrides), document: loaded(document), keySet: loaded(keySet), now });
const failed = (result: Evaluation): string[] => result.checks.filter((c) => !c.ok).map((c) => c.id);

test('good, fresh, signed evidence meets the control', () => {
  const result = run({}, contractDoc(oracle.signer));
  assert.equal(result.decision, 'pass');
  assert.equal(result.met, true);
  assert.equal(result.kid, oracle.kid);
  assert.equal(result.keyStatus, 'active');
  assert.equal(result.measurement?.availability, 0.999);
  assert.deepEqual(
    result.checks.map((c) => c.id),
    ['signature', 'issuer', 'freshness', 'window', 'confidence', 'observations', 'reliability-score', 'availability', 'error-rate', 'latency-p95'],
  );
});

test('a changed number breaks the signature, and nothing in the document is then treated as a measurement', () => {
  const doc = contractDoc(oracle.signer, { availability_pct: 0.5 });
  doc['availability_pct'] = 0.999;
  const result = run({}, doc);
  assert.equal(result.decision, 'fail');
  assert.deepEqual(failed(result), ['signature']);
  assert.equal(result.checks.length, 1);
  assert.equal(result.measurement, null);
  assert.match(result.checks[0]?.actual ?? '', /signature_invalid/);
});

test('signature failures each stop the evaluation with their own reason', () => {
  const stranger = makeOracle();
  const cases: Array<[string, unknown, unknown]> = [
    ['unknown_kid', contractDoc(stranger.signer), oracle.keySet],
    ['revoked_kid', contractDoc(oracle.signer), { keys: [], revoked_keys: [{ kid: oracle.kid }] }],
    ['signature_missing', (({ signature: _s, ...rest }) => rest)(contractDoc(oracle.signer)), oracle.keySet],
    ['unsupported_alg', { ...contractDoc(oracle.signer), signature: { alg: 'none', kid: oracle.kid, sig: 'x' } }, oracle.keySet],
  ];
  for (const [reason, document, keySet] of cases) {
    const result = run({}, document, keySet);
    assert.equal(result.decision, 'fail', reason);
    assert.equal(result.checks.at(-1)?.actual, reason);
    assert.equal(result.measurement, null, reason);
  }
});

test('the keys named by the control are the trust anchor, not keys the document points at', () => {
  // An attacker signs with their own key and points the document at their own key set.
  const attacker = makeOracle();
  const doc = contractDoc(attacker.signer, { oracle: { id: 'https://oracle.example', jwks_uri: 'https://attacker.example/keys.json' } });
  assert.deepEqual(failed(run({}, doc)), ['signature']);
});

test('a pinned key id must match', () => {
  const doc = contractDoc(oracle.signer);
  const evidence = { format: 'openeago-contract', from: 'e.json', keys: 'k.json' };
  assert.equal(run({ evidence: { ...evidence, 'trusted-kids': [oracle.kid] } }, doc).decision, 'pass');
  const result = run({ evidence: { ...evidence, 'trusted-kids': ['some-other-key'] } }, doc);
  assert.deepEqual(failed(result), ['key-pinned']);
  assert.equal(result.measurement, null);
});

test('evidence dated outside the life of its key is refused', () => {
  const late = makeOracle('2026-11-15T11:59:30Z'); // activated after the document's date, beyond clock tolerance
  const early = contractDoc(late.signer, {}, '2026-11-15T11:00:00.000Z');
  assert.deepEqual(failed(run({}, early, late.keySet)), ['key-valid-at-signing']);
  const retired = { keys: [{ ...oracle.keySet.keys[0], status: 'retired', retired_at: '2026-11-01T00:00:00Z' }] };
  const result = run({}, contractDoc(oracle.signer), retired);
  assert.deepEqual(failed(result), ['key-valid-at-signing']);
  // A retired key still verifies what it signed while it was in use.
  const old = contractDoc(oracle.signer, {}, '2026-10-20T00:00:00.000Z');
  assert.deepEqual(failed(run({ 'max-evidence-age-hours': 10000 }, old, retired)), []);
});

test('the issuer must be the oracle the control names', () => {
  const doc = contractDoc(oracle.signer, { oracle: { id: 'https://another-oracle.example' } });
  assert.deepEqual(failed(run({}, doc)), ['issuer']);
  const anonymous = contractDoc(oracle.signer, { oracle: undefined });
  assert.match(run({}, anonymous).checks.at(-1)?.actual ?? '', /does not name its oracle/);
});

test('stale, future-dated and undated evidence is not fresh', () => {
  const stale = contractDoc(oracle.signer, {}, '2026-11-14T11:00:00.000Z'); // 25 h old
  assert.deepEqual(failed(run({}, stale)), ['freshness']);
  const future = contractDoc(oracle.signer, {}, '2026-11-15T13:00:00.000Z');
  assert.match(run({}, future).checks.find((c) => c.id === 'freshness')?.actual ?? '', /in the future/);
  // Signed just now over observations that are days old: age counts from the observations.
  const reSigned = contractDoc(oracle.signer, { observed_at: '2026-11-10T00:00:00.000Z' });
  assert.deepEqual(failed(run({}, reSigned)), ['freshness']);
  // A few minutes ahead of the gate's clock is tolerated.
  assert.deepEqual(failed(run({}, contractDoc(oracle.signer, {}, '2026-11-15T12:03:00.000Z'))), []);
});

test('weak evidence does not satisfy a control', () => {
  assert.deepEqual(failed(run({}, contractDoc(oracle.signer, { window_hours: 24 }))), ['window']);
  assert.deepEqual(failed(run({}, contractDoc(oracle.signer, { confidence: 'one-shot' }))), ['confidence']);
  assert.deepEqual(failed(run({}, contractDoc(oracle.signer, { observations: 12 }))), ['observations']);
  assert.deepEqual(failed(run({ 'min-confidence': 'one-shot' }, contractDoc(oracle.signer, { confidence: 'one-shot' }))), []);
});

test('every unmet threshold is reported, and a value the evidence lacks is unmet', () => {
  const doc = contractDoc(oracle.signer, { reliability_score: 0.88, availability_pct: 0.97, latency_p95_ms: 2100, error_rate: undefined });
  const result = run({}, doc);
  assert.deepEqual(failed(result), ['reliability-score', 'availability', 'error-rate', 'latency-p95']);
  assert.equal(result.checks.find((c) => c.id === 'error-rate')?.actual, 'not measured');
  assert.equal(result.checks.find((c) => c.id === 'availability')?.required, 'availability >= 0.99');
  // Exactly on the threshold is met.
  assert.deepEqual(failed(run({}, contractDoc(oracle.signer, { availability_pct: 0.99, reliability_score: 0.95, error_rate: 0.05, latency_p95_ms: 1500 }))), []);
});

test('an advisory control warns instead of failing', () => {
  const result = run({ enforcement: 'advisory' }, contractDoc(oracle.signer, { availability_pct: 0.9 }));
  assert.equal(result.decision, 'warn');
  assert.equal(result.met, false);
});

test('no evidence, unreadable evidence and unreadable keys are all "not met"', () => {
  const none = evaluate({ spec: spec({ evidence: undefined }), document: null, keySet: null, now: NOW });
  assert.deepEqual(failed(none), ['evidence-source']);
  const unreadable = evaluate({ spec: spec(), document: { ok: false, error: 'HTTP 503' }, keySet: loaded(oracle.keySet), now: NOW });
  assert.deepEqual(failed(unreadable), ['evidence-retrieved']);
  assert.equal(unreadable.checks[0]?.actual, 'HTTP 503');
  const noKeys = evaluate({ spec: spec(), document: loaded(contractDoc(oracle.signer)), keySet: { ok: false, error: 'HTTP 404' }, now: NOW });
  assert.deepEqual(failed(noKeys), ['keys-retrieved']);
  assert.deepEqual(failed(run({}, contractDoc(oracle.signer), { keys: 'nope' })), ['keys-retrieved']);
  assert.deepEqual(failed(run({}, contractDoc(oracle.signer), { keys: [null] })), ['keys-retrieved']);
  assert.deepEqual(failed(run({}, { target: 'https://other.example/' })), ['evidence-covers-target']);
});

test("Hosannaith's committed report verifies against its committed public key, pinned", () => {
  const read = (path: string): unknown => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
  const report = read('../../public-reports/a-identity-2026-11.json') as Record<string, unknown>;
  const keys = read('../../attest/jwks-history.json');
  const overrides = {
    target: 'https://a-identity.xyz/api/x402/algorand/tools/risk_check',
    oracle: 'https://api.hosannaith.com',
    evidence: { format: 'hosannaith-report', from: 'r.json', keys: 'k.json', 'trusted-kids': ['tva-5LvOz8DrLJKcj3pYlryzOtKpgAcos-56dyWRA-k'] },
    thresholds: { 'min-reliability-score': 0.95, 'min-availability': 0.99, 'max-error-rate': 0.05, 'max-latency-p95-ms': 1500, 'min-protocol-conformance': 1 },
    'max-evidence-age-hours': 744,
  };
  const result = run(overrides, report, keys);
  assert.equal(result.decision, 'pass');
  assert.equal(result.measurement?.reliabilityScore, 0.965);
  // The same report a year on is too old to rely on.
  assert.deepEqual(failed(run(overrides, report, keys, new Date('2027-11-15T00:00:00Z'))), ['freshness']);
  // One endpoint's score nudged upward: the report's signature no longer verifies.
  const edited = structuredClone(report) as { endpoints: Array<{ score: number }> };
  (edited.endpoints[1] as { score: number }).score = 99;
  assert.deepEqual(failed(run(overrides, edited, keys)), ['signature']);
});
