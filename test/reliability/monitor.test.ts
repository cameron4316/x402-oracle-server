import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probe, startMonitor } from '../../src/checks/reliability/monitor.js';
import type { Observation, ObservationStore } from '../../src/checks/reliability/store.js';

// In-memory store — these tests care about probing/scheduling behaviour, not file I/O.
class MemoryStore implements ObservationStore {
  readonly appended: Observation[] = [];
  async append(obs: Observation): Promise<void> {
    this.appended.push(obs);
  }
  async readForTarget(target: string): Promise<Observation[]> {
    return this.appended.filter((o) => o.target === target);
  }
}

test('probe() records a reachable target that correctly demands payment', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 402 })) as typeof fetch;
  try {
    const result = await probe('https://target.example/paid');
    assert.equal(result.reachable, true);
    assert.equal(result.httpStatus, 402);
    assert.equal(result.demandedPayment, true);
    assert.equal(typeof result.latencyMs, 'number');
    assert.equal(result.error, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('probe() records an unreachable target without throwing', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('ECONNREFUSED');
  }) as typeof fetch;
  try {
    const result = await probe('https://target.example/down');
    assert.equal(result.reachable, false);
    assert.equal(result.httpStatus, null);
    assert.equal(result.demandedPayment, false);
    assert.equal(result.latencyMs, null);
    assert.match(result.error ?? '', /ECONNREFUSED/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('probe() flags a 200 response as reachable but not correctly paywalled', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('ok', { status: 200 })) as typeof fetch;
  try {
    const result = await probe('https://target.example/free');
    assert.equal(result.reachable, true);
    assert.equal(result.httpStatus, 200);
    assert.equal(result.demandedPayment, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('probe() times out and records unreachable rather than hanging', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_url: string, init?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    })) as typeof fetch;
  try {
    const result = await probe('https://target.example/hangs', 30);
    assert.equal(result.reachable, false);
    assert.equal(result.httpStatus, null);
    assert.match(result.error ?? '', /abort/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('startMonitor() never runs two probes of the same target concurrently', async () => {
  let inFlight = 0;
  let maxConcurrent = 0;
  const store = new MemoryStore();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    inFlight++;
    maxConcurrent = Math.max(maxConcurrent, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 180));
    inFlight--;
    return new Response(null, { status: 402 });
  }) as typeof fetch;

  try {
    // intervalSeconds is far shorter than the (mocked) 180ms probe, so without the overlap
    // guard many overlapping ticks would fire during the 420ms window below.
    const stop = startMonitor({
      targets: ['https://target.example/slow'],
      intervalSeconds: 0.05,
      store,
    });
    await new Promise((resolve) => setTimeout(resolve, 420));
    stop();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(maxConcurrent, 1, 'a new probe started before the previous one finished');
  assert.ok(store.appended.length >= 1, 'expected at least one tick to complete');
  assert.ok(
    store.appended.length <= 3,
    `expected only non-overlapping ticks (~420ms / 180ms), got ${store.appended.length}`,
  );
});

test('startMonitor() re-reads a dynamic target getter on each tick', async () => {
  const store = new MemoryStore();
  let targets = ['https://target.example/a'];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 402 })) as typeof fetch;

  try {
    const stop = startMonitor({
      targets: async () => targets,
      intervalSeconds: 0.05,
      store,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    targets = ['https://target.example/a', 'https://target.example/b'];
    await new Promise((resolve) => setTimeout(resolve, 120));
    stop();
  } finally {
    globalThis.fetch = originalFetch;
  }

  const targetsSeen = new Set(store.appended.map((o) => o.target));
  assert.ok(targetsSeen.has('https://target.example/a'), 'expected the original target to be probed');
  assert.ok(targetsSeen.has('https://target.example/b'), 'expected the newly added target to be probed');
});
