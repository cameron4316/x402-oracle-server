import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// config.ts reads process.env at import time, so set it before the dynamic imports below.
const tmpDir = mkdtempSync(join(tmpdir(), 'x402-routes-test-'));
process.env.NETWORK = 'testnet';
process.env.AVM_ADDRESS = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ';
process.env.OBSERVATION_LOG = join(tmpDir, 'observations.jsonl');
delete process.env.PUBLIC_BASE_URL;

const { routes, BATCH_TARGET_LIMIT } = await import('../src/routes.config.js');
const { MAX_BATCH_TARGETS } = await import('../src/checks/reliability/batch.js');
const { validateDiscoveryExtension } = await import('@x402-avm/extensions');

type Bazaar = {
  info: { input: Record<string, unknown> };
  schema: Record<string, unknown>;
};
const bazaarOf = (key: keyof typeof routes) =>
  (routes[key].extensions as unknown as { bazaar: Bazaar }).bazaar;

test('paid routes advertise a fixed https resource URL', () => {
  assert.equal(routes['GET /reliability'].resource, 'https://api.hosannaith.com/reliability');
  assert.equal(routes['POST /reliability/batch'].resource, 'https://api.hosannaith.com/reliability/batch');
});

test('GET /reliability declares its required `target` query parameter', () => {
  const b = bazaarOf('GET /reliability');
  assert.deepEqual(b.info.input.queryParams, { target: 'https://x402.goplausible.xyz/examples/weather' });
  const qp = (b.schema as any).properties.input.properties.queryParams;
  assert.deepEqual(qp.required, ['target']);
  assert.equal(qp.properties.target.type, 'string');
});

test('POST /reliability/batch is declared as a JSON-body route with a `targets` array', () => {
  const b = bazaarOf('POST /reliability/batch');
  assert.equal(b.info.input.bodyType, 'json');
  assert.deepEqual(b.info.input.body, { targets: ['https://x402.goplausible.xyz/examples/weather'] });
  const body = (b.schema as any).properties.input.properties.body;
  assert.deepEqual(body.required, ['targets']);
  assert.equal(body.properties.targets.maxItems, MAX_BATCH_TARGETS);
});

test('both discovery declarations pass the x402 Bazaar validator', () => {
  for (const key of ['GET /reliability', 'POST /reliability/batch'] as const) {
    const result = validateDiscoveryExtension(bazaarOf(key) as never) as { valid: boolean; errors?: unknown };
    assert.equal(result.valid, true, `${key}: ${JSON.stringify(result.errors)}`);
  }
});

test('the batch limit in the route config matches the batch implementation', () => {
  assert.equal(BATCH_TARGET_LIMIT, MAX_BATCH_TARGETS);
});
