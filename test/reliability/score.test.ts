import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, MIN_SAMPLES_FOR_P99 } from '../../src/checks/reliability/score.js';
import type { Observation } from '../../src/checks/reliability/store.js';

const T = 'https://slo.example/paid';

function obs(n: number, overrides: Partial<Observation> = {}, latency: (i: number) => number = () => 100): Observation[] {
  return Array.from({ length: n }, (_, i) => ({
    target: T,
    at: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(),
    reachable: true,
    httpStatus: 402,
    demandedPayment: true,
    latencyMs: latency(i),
    ...overrides,
  }));
}

test('SLO aliases mirror the existing fields exactly', () => {
  const s = summarize([...obs(18), ...obs(2, { reachable: false, httpStatus: null, latencyMs: null })], 24);
  assert.equal(s.uptimePct, 90);
  assert.equal(s.availability_pct, s.uptimePct);
  assert.equal(s.error_rate_pct, 10);
  assert.equal(s.protocol_conformance_pct, s.correct402Pct);
  assert.equal(s.score_normalized, (s.score as number) / 100);
});

test('error_rate_pct counts 5xx and unreachable, not client-side 4xx', () => {
  const s = summarize([...obs(6), ...obs(2, { httpStatus: 400 }), ...obs(2, { httpStatus: 503 })], 24);
  // 400 still means the server answered (indeterminate for an unpaid probe); 503 is an error.
  assert.equal(s.error_rate_pct, 20);
  assert.equal(s.availability_pct, 80);
});

test('error_rate_pct is rounded to one decimal (no float noise)', () => {
  const s = summarize([...obs(2), ...obs(1, { httpStatus: 500 })], 24); // uptime 66.7
  assert.equal(s.uptimePct, 66.7);
  assert.equal(s.error_rate_pct, 33.3);
});

test('aliases are null exactly when their source is null', () => {
  const empty = summarize([], 24);
  for (const k of ['availability_pct', 'error_rate_pct', 'protocol_conformance_pct', 'score_normalized', 'p99LatencyMs'] as const) {
    assert.equal(empty[k], null, k);
  }
  // Only indeterminate probes: uptime known, conformance unknown, so no score.
  const s = summarize(obs(10, { httpStatus: 404 }), 24);
  assert.equal(s.availability_pct, 100);
  assert.equal(s.protocol_conformance_pct, null);
  assert.equal(s.score, null);
  assert.equal(s.score_normalized, null);
});

test('score_normalized is in [0, 1] and keeps the score precision', () => {
  const s = summarize(obs(10, {}, () => 300), 24); // p95 300ms -> 3 point penalty -> 97
  assert.equal(s.score, 97);
  assert.equal(s.score_normalized, 0.97);
});

test(`p99 is null below ${MIN_SAMPLES_FOR_P99} latency samples, computed at or above it`, () => {
  const few = summarize(obs(MIN_SAMPLES_FOR_P99 - 1, {}, (i) => (i === 0 ? 5000 : 100)), 24);
  assert.equal(few.p99LatencyMs, null);
  const enough = summarize(obs(100, {}, (i) => i + 1), 24); // latencies 1..100
  assert.equal(enough.p99LatencyMs, 100);
  assert.equal(enough.p95LatencyMs, 96);
});

test('p99 counts latency samples, not observations: unreachable probes do not count', () => {
  const s = summarize([...obs(MIN_SAMPLES_FOR_P99 - 1), ...obs(10, { reachable: false, httpStatus: null, latencyMs: null })], 24);
  assert.equal(s.observations, MIN_SAMPLES_FOR_P99 + 9);
  assert.equal(s.p99LatencyMs, null);
});

test('existing fields and the score are unchanged by the additions', () => {
  const s = summarize(obs(10), 24);
  assert.deepEqual(
    {
      observations: s.observations,
      windowHours: s.windowHours,
      uptimePct: s.uptimePct,
      correct402Pct: s.correct402Pct,
      p50LatencyMs: s.p50LatencyMs,
      p95LatencyMs: s.p95LatencyMs,
      score: s.score,
    },
    { observations: 10, windowHours: 24, uptimePct: 100, correct402Pct: 100, p50LatencyMs: 100, p95LatencyMs: 100, score: 99 },
  );
});

test('payment signals: mainnetPayablePct, discoverablePct and networks over recorded 402s only', () => {
  const MAIN = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=';
  const TEST = 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=';
  const recorded = (networks: string[], bazaar = false, parsed = true) =>
    obs(1, { paymentRequiredParsed: parsed, acceptedNetworks: networks, hasBazaarExtension: bazaar, x402Version: 2 })[0];
  const s = summarize(
    [
      ...obs(6), // older 402s without recorded requirements: not counted
      recorded([MAIN], true),
      recorded([MAIN]),
      recorded([TEST]),
      recorded([], false, false),
    ],
    24,
  );
  assert.equal(s.paymentRequirementsSamples, 4);
  assert.equal(s.mainnetPayablePct, 50);
  assert.equal(s.discoverablePct, 25);
  assert.deepEqual(s.acceptedNetworks, [MAIN, TEST].sort());
});

test('payment signals never move the score', () => {
  const base = obs(10);
  const withTestnetOnly = base.map((o) => ({ ...o, paymentRequiredParsed: true, acceptedNetworks: ['eip155:84532'] }));
  const a = summarize(base, 24);
  const b = summarize(withTestnetOnly, 24);
  assert.equal(b.score, a.score);
  assert.equal(b.correct402Pct, a.correct402Pct);
  assert.equal(b.mainnetPayablePct, 0);
  assert.equal(a.mainnetPayablePct, null);
  assert.equal(a.paymentRequirementsSamples, 0);
  assert.equal(a.acceptedNetworks, null);
});

test('currentSdkPayablePct and algorandIdForm: legacy-only Algorand is payable on mainnet but not by the current SDK', () => {
  const LEGACY = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=';
  const SPEC = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k';
  const rec = (networks: string[]) => obs(1, { paymentRequiredParsed: true, acceptedNetworks: networks, hasBazaarExtension: false, x402Version: 2 })[0];
  const legacyOnly = summarize([rec([LEGACY]), rec([LEGACY])], 24);
  assert.equal(legacyOnly.mainnetPayablePct, 100);
  assert.equal(legacyOnly.currentSdkPayablePct, 0);
  assert.equal(legacyOnly.algorandIdForm, 'legacy');
  const both = summarize([rec([SPEC, LEGACY])], 24);
  assert.equal(both.currentSdkPayablePct, 100);
  assert.equal(both.algorandIdForm, 'both');
  const withBase = summarize([rec([LEGACY, 'eip155:8453'])], 24);
  assert.equal(withBase.currentSdkPayablePct, 100, 'Base keeps it payable');
  assert.equal(withBase.algorandIdForm, 'legacy');
  assert.equal(summarize(obs(5), 24).algorandIdForm, null);
  assert.equal(summarize(obs(5), 24).score, summarize([...obs(5)].map((o) => ({ ...o, paymentRequiredParsed: true, acceptedNetworks: [LEGACY] })), 24).score, 'never moves the score');
});
