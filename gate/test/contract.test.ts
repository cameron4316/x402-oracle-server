import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { extractMeasurement, sameTarget } from '../src/contract.ts';
import { GOOD_FIGURES, TARGET } from './helpers.ts';

const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const report = readJson('../../public-reports/a-identity-2026-11.json');
const liveResult = readJson('./fixtures/hosannaith-check-result.json');
const RISK_CHECK = 'https://a-identity.xyz/api/x402/algorand/tools/risk_check';

test('contract documents are read in their own units', () => {
  const doc = { target: TARGET, ...GOOD_FIGURES, observed_at: '2026-11-15T11:00:00Z', generated_at: '2026-11-15T11:00:01Z', oracle: { id: 'https://oracle.example' } };
  const out = extractMeasurement('openeago-contract', doc, TARGET);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.signed, doc);
  assert.deepEqual(out.measurement, {
    target: TARGET,
    reliabilityScore: 0.99,
    availability: 0.999,
    errorRate: 0.001,
    latencyP50Ms: 100,
    latencyP95Ms: 200,
    latencyP99Ms: 400,
    protocolConformance: 1,
    observations: 3360,
    windowHours: 168,
    confidence: 'history',
    observedAt: '2026-11-15T11:00:00Z',
    generatedAt: '2026-11-15T11:00:01Z',
    oracle: 'https://oracle.example',
  });
});

test('a contract document that sends a percentage as a fraction is refused, not guessed at', () => {
  const out = extractMeasurement('openeago-contract', { target: TARGET, ...GOOD_FIGURES, availability_pct: 99.9 }, TARGET);
  assert.deepEqual(out, { ok: false, reason: 'malformed_document', detail: 'availability_pct is 99.9, not a fraction between 0 and 1' });
});

test('values a document leaves out are null, and wrong types are malformed', () => {
  const sparse = extractMeasurement('openeago-contract', { target: TARGET, availability_pct: 0.99 }, TARGET);
  assert.equal(sparse.ok && sparse.measurement.reliabilityScore, null);
  assert.equal(sparse.ok && sparse.measurement.confidence, null);
  for (const bad of [{ observations: '3360' }, { confidence: 'certain' }, { generated_at: 'yesterday' }, { latency_p95_ms: -1 }]) {
    const out = extractMeasurement('openeago-contract', { target: TARGET, ...bad }, TARGET);
    assert.equal(!out.ok && out.reason, 'malformed_document', JSON.stringify(bad));
  }
});

test('a document about another service does not count', () => {
  const out = extractMeasurement('openeago-contract', { target: 'https://other.example/' }, TARGET);
  assert.equal(!out.ok && out.reason, 'target_not_in_document');
  assert.equal(extractMeasurement('openeago-contract', [], TARGET).ok, false);
  assert.equal(sameTarget('HTTPS://Service.Example:443/v1/thing', TARGET), true);
  assert.equal(sameTarget('https://service.example/v1/thing?x=1', TARGET), false);
  assert.equal(sameTarget('not a url', TARGET), false);
});

test("a real Hosannaith report: one endpoint's figures, converted to fractions; the whole report is what is signed", () => {
  const out = extractMeasurement('hosannaith-report', report, RISK_CHECK);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.signed, report);
  assert.deepEqual(out.measurement, {
    target: RISK_CHECK,
    reliabilityScore: 0.965,
    availability: 1,
    errorRate: 0,
    latencyP50Ms: 207,
    latencyP95Ms: 354,
    latencyP99Ms: 422,
    protocolConformance: 1,
    observations: 6718,
    windowHours: 336,
    confidence: 'history',
    observedAt: '2026-11-04T03:52:42.976Z',
    generatedAt: '2026-11-04T04:01:24.896Z',
    oracle: null,
  });
  const other = extractMeasurement('hosannaith-report', report, 'https://a-identity.xyz/api/x402/algorand/tools/other');
  assert.equal(!other.ok && other.reason, 'target_not_in_document');
  assert.equal(extractMeasurement('hosannaith-report', liveResult, RISK_CHECK).ok, false);
});

test('a real Hosannaith check result, as the live API returned it', () => {
  const target = 'https://x402.goplausible.xyz/examples/weather';
  const out = extractMeasurement('hosannaith-result', liveResult, target);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.signed, liveResult);
  assert.deepEqual(out.measurement, {
    target,
    reliabilityScore: 0.983,
    availability: 1,
    errorRate: 0,
    latencyP50Ms: 101,
    latencyP95Ms: 168,
    latencyP99Ms: 2708,
    protocolConformance: 1,
    observations: 480,
    windowHours: 24,
    confidence: 'history',
    observedAt: '2026-11-04T19:04:54.078Z',
    generatedAt: '2026-11-04T19:06:12.319Z',
    oracle: null,
  });
});

test('in a Hosannaith batch, the matching result is the signed object', () => {
  const other = { ...liveResult, target: 'https://other.example/' };
  const batch = { results: [other, liveResult], count: 2 };
  const out = extractMeasurement('hosannaith-result', batch, 'https://x402.goplausible.xyz/examples/weather');
  assert.equal(out.ok && out.signed, liveResult);
  const missing = extractMeasurement('hosannaith-result', batch, TARGET);
  assert.equal(!missing.ok && missing.reason, 'target_not_in_document');
});
