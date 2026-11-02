import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, statusFromScore } from '../../src/checks/reliability/score.js';
import type { Observation } from '../../src/checks/reliability/store.js';
import {
  batchResultSchema,
  checkResultSchema,
  problemSchema,
  reliabilityDetailSchema,
  PUBLISHED_SCHEMAS,
} from '../../src/contract/schema.js';
import { buildOpenApi, type PaidRouteLike } from '../../src/contract/openapi.js';
import { problem } from '../../src/contract/problem.js';
import { validate } from './mini-schema.js';

const T = 'https://contract.example/paid';

function history(n: number, overrides: Partial<Observation> = {}): Observation[] {
  return Array.from({ length: n }, (_, i) => ({
    target: T,
    at: new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString(),
    reachable: true,
    httpStatus: 402,
    demandedPayment: true,
    latencyMs: 100 + i,
    ...overrides,
  }));
}

// Mirrors how src/checks/reliability/index.ts and batch.ts assemble a result from a summary.
function asResult(obs: Observation[], confidence: 'history' | 'one-shot') {
  const summary = summarize(obs, 24);
  return {
    target: T,
    checkId: 'reliability',
    status: statusFromScore(summary.score),
    score: summary.score,
    detail: { ...summary, confidence },
    observedAt: new Date().toISOString(),
  };
}

const SCENARIOS: Record<string, ReturnType<typeof asResult>> = {
  healthy: asResult(history(50), 'history'),
  'one-shot': asResult(history(1), 'one-shot'),
  'all down': asResult(history(10, { reachable: false, httpStatus: null, latencyMs: null }), 'history'),
  'serves unpaid 2xx': asResult(history(10, { httpStatus: 200, demandedPayment: false }), 'history'),
  'indeterminate only': asResult(history(10, { httpStatus: 400, demandedPayment: false }), 'history'),
  'no history': asResult([], 'history'),
};

for (const [name, result] of Object.entries(SCENARIOS)) {
  test(`CheckResult schema accepts a real result: ${name}`, () => {
    assert.deepEqual(validate(checkResultSchema, result), []);
  });
}

test('BatchResult schema accepts history and pending items', () => {
  const batch = {
    results: [
      SCENARIOS.healthy,
      {
        target: 'https://contract.example/new',
        checkId: 'reliability',
        status: 'unknown',
        score: null,
        detail: { observations: 0, windowHours: 24, confidence: 'pending' },
        observedAt: new Date().toISOString(),
      },
    ],
    count: 2,
    requested: 2,
    capped: false,
    observedAt: new Date().toISOString(),
  };
  assert.deepEqual(validate(batchResultSchema, batch), []);
});

test('every field summarize() emits is documented in the detail schema', () => {
  const documented = new Set(Object.keys(reliabilityDetailSchema.properties));
  for (const result of Object.values(SCENARIOS)) {
    for (const k of Object.keys(result.detail)) assert.ok(documented.has(k), `undocumented detail field "${k}"`);
  }
});

test('the schema rejects what it should: bad status, out-of-range score, non-UTC timestamp, missing field', () => {
  const ok = SCENARIOS.healthy;
  assert.notDeepEqual(validate(checkResultSchema, { ...ok, status: 'great' }), []);
  assert.notDeepEqual(validate(checkResultSchema, { ...ok, score: 101 }), []);
  assert.notDeepEqual(validate(checkResultSchema, { ...ok, observedAt: '2026-11-02T10:00:00+02:00' }), []);
  const { detail: _d, ...noDetail } = ok;
  assert.notDeepEqual(validate(checkResultSchema, noDetail), []);
  assert.notDeepEqual(validate(checkResultSchema, { ...ok, detail: { ...ok.detail, score_normalized: 98.5 } }), []);
});

test('Problem Details bodies match the problem schema and carry the legacy error alias', () => {
  const p = problem(400, 'Missing required query param: target');
  assert.deepEqual(validate(problemSchema, p), []);
  assert.equal(p.type, 'about:blank');
  assert.equal(p.title, 'Bad Request');
  assert.equal(p.error, p.detail);
  assert.deepEqual(validate(problemSchema, problem(500)), []);
  assert.equal('detail' in problem(500), false);
});

test('published schemas have stable $id URLs under /schema/', () => {
  for (const [name, schema] of Object.entries(PUBLISHED_SCHEMAS)) {
    assert.equal(schema.$id, `https://api.hosannaith.com/schema/${name}.json`);
  }
});

const ROUTES: Record<string, PaidRouteLike> = {
  'GET /reliability': {
    description: 'single',
    accepts: [{ scheme: 'exact', price: '$1.00', network: 'algorand:test', payTo: 'PAYTO', extra: { asset: 31566704, tag: 'x402-global-challenge' } }],
  },
  'POST /reliability/batch': {
    description: 'batch',
    accepts: [{ scheme: 'exact', price: '$7.00', network: 'algorand:test', payTo: 'PAYTO', extra: { asset: 31566704, tag: 'x402-global-challenge' } }],
  },
};

test('OpenAPI: payment terms come from the route config; every $ref resolves', () => {
  const doc = buildOpenApi(ROUTES, { maxBatchTargets: 50 });
  assert.equal(doc.openapi, '3.1.0');
  assert.deepEqual(doc.paths['/reliability'].get['x-x402'], {
    scheme: 'exact', price: '$1.00', amount: '1000000', asset: '31566704', network: 'algorand:test', payTo: 'PAYTO', tag: 'x402-global-challenge',
  });
  assert.equal(doc.paths['/reliability/batch'].post['x-x402'].amount, '7000000');

  const refs = JSON.stringify(doc).match(/"\$ref":"[^"]+"/g) ?? [];
  assert.ok(refs.length > 0);
  for (const r of refs) {
    const name = r.match(/#\/components\/schemas\/(\w+)/)?.[1];
    assert.ok(name && name in doc.components.schemas, `unresolved ${r}`);
  }
  for (const s of Object.values(doc.components.schemas)) {
    assert.equal('$id' in s, false, 'embedded schemas must not carry $id');
  }
  for (const name of Object.keys(PUBLISHED_SCHEMAS)) assert.ok(`/schema/${name}.json` in doc.paths);
});
