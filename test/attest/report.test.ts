import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { buildReport, REPORT_ID_PATTERN, REPORT_TYPE, type ReportCard } from '../../src/attest/report.js';
import { createSigner, attest } from '../../src/attest/sign.js';
import { publicJwk, thumbprint } from '../../src/attest/keys.js';
import { verifyAttestation } from '../../src/attest/verify.js';
import { loadKeyHistory, publishedKeySet } from '../../src/attest/keyset.js';

function card(target: string, first: string, last: string, observations: number, extra: Partial<ReportCard> = {}): ReportCard {
  return {
    target,
    status: 'PASS',
    summary: {
      observations,
      windowHours: 336,
      score: 96.5,
      uptimePct: 100,
      correct402Pct: 100,
      p50LatencyMs: 207,
      p95LatencyMs: 354,
      p99LatencyMs: 900,
      firstObservedAt: first,
      lastObservedAt: last,
    },
    sustained: [],
    transientDown: 0,
    transientUngated: 0,
    spikes: [{ at: '2026-10-29T19:44:13.592Z', latencyMs: 2867 }],
    ...extra,
  };
}

const META = { id: 'example-2026-11', subject: 'Example Co', scope: 'Covers only the two endpoints listed below.' };
const A = card('https://example.com/a', '2026-10-21T04:00:00.000Z', '2026-11-04T03:57:00.000Z', 6719);
const B = card('https://example.com/b', '2026-10-21T04:01:00.000Z', '2026-11-04T03:58:00.000Z', 6718);

test('a report states its window, method, scope and disclaimer, and keeps every endpoint figure', () => {
  const r = buildReport(META, [A, B]);
  assert.equal(r.type, REPORT_TYPE);
  assert.deepEqual(r.window, { from: '2026-10-21T04:00:00.000Z', to: '2026-11-04T03:58:00.000Z', hours: 336 });
  assert.match(r.method, /about every 3 minutes/);
  assert.equal(r.scope, META.scope);
  assert.match(r.disclaimer, /not a guarantee/);
  assert.match(r.disclaimer, /not an audit, certification or endorsement/);
  assert.equal(r.endpoints.length, 2);
  assert.deepEqual(
    { ...r.endpoints[0], latencySpikes: undefined },
    {
      target: 'https://example.com/a', status: 'pass', score: 96.5, probes: 6719, uptimePct: 100, correct402Pct: 100,
      p50LatencyMs: 207, p95LatencyMs: 354, p99LatencyMs: 900, firstObservedAt: A.summary.firstObservedAt,
      lastObservedAt: A.summary.lastObservedAt, sustainedOutages: [], transientErrors: 0, latencySpikes: undefined,
    },
  );
});

test('a signed report verifies, and changing any figure breaks it', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicJwk(privateKey);
  const keys = { keys: [{ ...jwk, kid: thumbprint(jwk) }] };
  const signed = JSON.parse(JSON.stringify(attest(createSigner(privateKey), buildReport(META, [A, B]))));
  assert.equal(verifyAttestation(signed, keys).ok, true);
  const tampered = structuredClone(signed);
  tampered.endpoints[1].uptimePct = 99.9;
  assert.equal(verifyAttestation(tampered, keys).ok, false);
  assert.equal(verifyAttestation({ ...signed, scope: 'Covers everything.' }, keys).ok, false);
});

test('report ids are lowercase words joined by single hyphens', () => {
  for (const ok of ['a-identity-2026-11', 'x', 'abc123']) assert.ok(REPORT_ID_PATTERN.test(ok), ok);
  for (const bad of ['A-Identity', 'a--b', '-a', 'a-', 'a/b', '../etc', 'a.json', '']) assert.ok(!REPORT_ID_PATTERN.test(bad), bad);
  assert.throws(() => buildReport({ ...META, id: '../x' }, [A]));
  assert.throws(() => buildReport(META, []));
});

test('every committed public report is signed by a published, non-revoked key', () => {
  const keys = publishedKeySet(loadKeyHistory());
  const files = readdirSync('public-reports').filter((f) => f.endsWith('.json'));
  for (const f of files) {
    assert.ok(REPORT_ID_PATTERN.test(f.replace(/\.json$/, '')), `bad report file name ${f}`);
    const doc = JSON.parse(readFileSync(`public-reports/${f}`, 'utf8'));
    assert.equal(doc.type, REPORT_TYPE, f);
    assert.equal(`${doc.id}.json`, f, `${f}: id does not match the file name`);
    const v = verifyAttestation(doc, keys);
    assert.equal(v.ok, true, `${f}: ${JSON.stringify(v)}`);
  }
});

test('report cards with recorded payment requirements add a payment block and a method note; older cards do not', () => {
  const withPayment = {
    ...A,
    summary: {
      ...A.summary,
      paymentRequirementsSamples: 480,
      mainnetPayablePct: 100,
      currentSdkPayablePct: 100,
      algorandIdForm: 'spec' as const,
      acceptedNetworks: ['algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k'],
    },
  };
  const r = buildReport(META, [withPayment, B]) as any;
  assert.deepEqual(r.endpoints[0].payment, {
    samples: 480,
    acceptedNetworks: ['algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k'],
    algorandIdForm: 'spec',
    mainnetPayablePct: 100,
    currentSdkPayablePct: 100,
  });
  assert.equal(r.endpoints[1].payment, undefined, 'a card without recorded payment data gets no payment block');
  assert.match(r.method, /Payment figures .* cover only the 402 responses recorded since 2026-11-09T18:44:00Z/);
  assert.match(r.method, /not part of the score/);
  const old = buildReport(META, [A, B]) as any;
  assert.doesNotMatch(old.method, /Payment figures/, 'reports from older cards are unchanged');
});
