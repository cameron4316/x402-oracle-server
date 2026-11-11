import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Observation } from '../../src/checks/reliability/store.js';

// config.ts reads process.env at import time, and static imports are always evaluated before
// this file's own top-level code — so these MUST be set via a dynamic import below, not a
// static one, or they'd have no effect (the singleton would already be wired to the real
// data/ directory before we got a chance to redirect it).
const tmpDir = mkdtempSync(join(tmpdir(), 'x402-oracle-test-'));
const observationLog = join(tmpDir, 'observations.jsonl');
const targetsFile = join(tmpDir, 'targets.json');

process.env.NETWORK = 'testnet';
process.env.AVM_ADDRESS = 'TESTNETDUMMYADDRESSFORUNITTESTSXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
process.env.FACILITATOR_URL = 'https://facilitator.invalid.test';
process.env.PORT = '0';
process.env.MONITOR_TARGETS = '';
process.env.MONITOR_INTERVAL_SECONDS = '60';
process.env.OBSERVATION_LOG = observationLog;

const { reliabilityCheck } = await import('../../src/checks/reliability/index.js');

function mockFetch(status: number) {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(null, { status });
  }) as typeof fetch;
  return {
    callCount: () => calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

// Directly appends synthetic history, bypassing probe(), so score.ts's behaviour can be
// exercised without waiting on real monitor ticks.
function seedHistory(target: string, count: number, overrides: Partial<Observation> = {}): void {
  const now = Date.now();
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    const obs: Observation = {
      target,
      at: new Date(now - (count - i) * 60_000).toISOString(),
      reachable: true,
      httpStatus: 402,
      demandedPayment: true,
      latencyMs: 100,
      ...overrides,
    };
    lines.push(JSON.stringify(obs));
  }
  writeFileSync(observationLog, lines.join('\n') + '\n', { flag: 'a' });
}

test('a never-before-seen target gets one live probe instead of a wasted "unknown"', async () => {
  const target = 'https://fresh.example/never-queried';
  const fetchMock = mockFetch(402);

  const result = await reliabilityCheck.run(target);
  fetchMock.restore();

  assert.equal(fetchMock.callCount(), 1, 'expected exactly one live probe');
  assert.equal(result.detail.confidence, 'one-shot');
  assert.equal(result.score, null, 'a single observation cannot stand behind a score');
  assert.equal(result.status, 'unknown');
  assert.equal((result.detail as { observations: number }).observations, 1);
});

test('a one-shot probe is persisted and the target enrolled for continuous monitoring', async () => {
  const target = 'https://fresh.example/enroll-me';
  const fetchMock = mockFetch(402);
  await reliabilityCheck.run(target);
  fetchMock.restore();

  const observedTargets = readFileSync(observationLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { target: string }).target);
  assert.ok(
    observedTargets.some((t) => t === target),
    'expected the probe to be appended to observation history',
  );

  const enrolled: string[] = JSON.parse(readFileSync(targetsFile, 'utf8'));
  assert.ok(
    enrolled.some((t) => t === target),
    'expected the queried target to be enrolled so the standalone monitor picks it up',
  );
});

test('a target with existing history is scored from history, without another live probe', async () => {
  const target = 'https://history.example/reliable';
  seedHistory(target, 10);

  const fetchMock = mockFetch(402);
  const result = await reliabilityCheck.run(target);
  fetchMock.restore();

  assert.equal(fetchMock.callCount(), 0, 'a target with history should not trigger a live probe');
  assert.equal(result.detail.confidence, 'history');
  assert.equal(result.status, 'pass');
  assert.ok(typeof result.score === 'number' && result.score >= 90);
});

test('a target with 50% downtime in its history is not marked as passing', async () => {
  const target = 'https://history.example/flaky';
  seedHistory(target, 5);
  seedHistory(target, 5, { reachable: false, httpStatus: null, demandedPayment: false, latencyMs: null });

  const result = await reliabilityCheck.run(target);

  assert.equal(result.detail.confidence, 'history');
  assert.notEqual(result.score, null);
  assert.ok((result.score as number) < 90, 'a 50% downtime target should not pass');
});

test('re-querying a one-shot target later reads its new history instead of probing again', async () => {
  const target = 'https://fresh.example/repeat-query';

  const first = mockFetch(402);
  const firstResult = await reliabilityCheck.run(target);
  first.restore();
  assert.equal(firstResult.detail.confidence, 'one-shot');

  const second = mockFetch(402);
  const secondResult = await reliabilityCheck.run(target);
  second.restore();

  assert.equal(second.callCount(), 0, 'the second query should read history, not probe again');
  assert.equal(secondResult.detail.confidence, 'history');
  assert.equal(secondResult.score, null, 'still below MIN_OBSERVATIONS, but now history-backed');
});

test('real check results (one-shot and history) match the published JSON Schema', async () => {
  const { checkResultSchema } = await import('../../src/contract/schema.js');
  const { validate } = await import('../contract/mini-schema.js');

  const fetchMock = mockFetch(402);
  const oneShot = await reliabilityCheck.run('https://contract.example/one-shot');
  fetchMock.restore();
  assert.deepEqual(validate(checkResultSchema, oneShot), []);

  const target = 'https://contract.example/history';
  seedHistory(target, 30);
  const withHistory = await reliabilityCheck.run(target);
  assert.deepEqual(validate(checkResultSchema, withHistory), []);
  assert.equal((withHistory.detail as { availability_pct: number }).availability_pct, 100);
  assert.equal(typeof (withHistory.detail as { p99LatencyMs: unknown }).p99LatencyMs, 'number');
});

test('a disallowed target is refused: never probed, stored or enrolled', async () => {
  const fetchMock = mockFetch(402);
  for (const target of ['http://169.254.169.254/latest/meta-data', 'http://localhost:4021/health', 'file:///etc/passwd']) {
    await assert.rejects(() => reliabilityCheck.run(target), /target rejected/);
  }
  fetchMock.restore();
  assert.equal(fetchMock.callCount(), 0, 'a refused target must never be fetched');
  const observed = (() => { try { return readFileSync(observationLog, 'utf8'); } catch { return ''; } })();
  assert.ok(!observed.includes('169.254.169.254') && !observed.includes('localhost:4021'));
  const enrolled = (() => { try { return readFileSync(targetsFile, 'utf8'); } catch { return ''; } })();
  assert.ok(!enrolled.includes('169.254.169.254') && !enrolled.includes('localhost:4021'));
});

test('a batch skips disallowed targets and enrolls only the allowed ones', async () => {
  const { reliabilityBatch } = await import('../../src/checks/reliability/batch.js');
  const batch = await reliabilityBatch(['http://10.0.0.1/x', 'https://batch.example/allowed', 'http://[::1]/', 42]);
  assert.deepEqual(batch.results.map((r) => r.target), ['https://batch.example/allowed']);
  const enrolled: string[] = JSON.parse(readFileSync(targetsFile, 'utf8'));
  assert.ok(enrolled.some((t) => t === 'https://batch.example/allowed'));
  assert.ok(!enrolled.some((t) => t === 'http://10.0.0.1/x' || t === 'http://[::1]/'));
});

test('windowHours: 168 and 720 read older history that the default 24 h window leaves out', async () => {
  const target = 'https://history.example/windows';
  const day = 24 * 3600 * 1000;
  seedHistory(target, 6, { at: new Date(Date.now() - 3 * day).toISOString() }); // 3 days ago
  seedHistory(target, 6, { at: new Date(Date.now() - 20 * day).toISOString(), reachable: false, httpStatus: null, demandedPayment: false, latencyMs: null }); // 20 days ago, down
  seedHistory(target, 6); // the last few minutes

  const fetchMock = mockFetch(402);
  const d1 = await reliabilityCheck.run(target);
  const d7 = await reliabilityCheck.run(target, { windowHours: 168 });
  const d30 = await reliabilityCheck.run(target, { windowHours: 720 });
  fetchMock.restore();

  assert.equal(fetchMock.callCount(), 0, 'all three windows have history: no live probe');
  assert.equal(d1.detail.windowHours, 24);
  assert.equal(d1.detail.observations, 6);
  assert.equal(d7.detail.windowHours, 168);
  assert.equal(d7.detail.observations, 12);
  assert.equal(d7.detail.uptimePct, 100);
  assert.equal(d30.detail.windowHours, 720);
  assert.equal(d30.detail.observations, 18);
  assert.ok((d30.detail.uptimePct as number) < 100, 'the 30-day window includes the outage 20 days ago');
});

test('windowHours: any other value is refused', async () => {
  await assert.rejects(() => reliabilityCheck.run('https://history.example/windows', { windowHours: 48 }), /windowHours must be one of 24, 168, 720/);
  const { reliabilityBatch } = await import('../../src/checks/reliability/batch.js');
  await assert.rejects(() => reliabilityBatch(['https://history.example/windows'], 1), /windowHours must be one of/);
  const batch = await reliabilityBatch(['https://history.example/windows'], 168);
  assert.equal(batch.results[0].detail.windowHours, 168);
  assert.equal(batch.results[0].detail.observations, 12);
});
