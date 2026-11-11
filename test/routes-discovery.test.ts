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

test('every paid route offers both Algorand network ids, spec form first, otherwise identical', async () => {
  const { CONFIG } = await import('../src/config.js');
  const { ALGORAND_TESTNET_CAIP2 } = await import('@x402/avm');
  assert.equal(CONFIG.caip2, ALGORAND_TESTNET_CAIP2, 'spec form comes from @x402/avm');
  assert.equal(CONFIG.caip2, 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe');
  assert.equal(CONFIG.caip2Legacy, 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=');
  assert.ok(CONFIG.caip2Legacy.startsWith(CONFIG.caip2), 'the spec form is the legacy form truncated');
  for (const key of Object.keys(routes) as Array<keyof typeof routes>) {
    const accepts = routes[key].accepts;
    assert.deepEqual(accepts.map((a) => a.network), [CONFIG.caip2, CONFIG.caip2Legacy], key);
    const { network: _a, ...first } = accepts[0];
    const { network: _b, ...second } = accepts[1];
    assert.deepEqual(first, second, `${key}: the two options differ only in network`);
    assert.equal(first.extra.tag, 'x402-global-challenge');
  }
});

test('both routes declare the optional windowHours for discovery', () => {
  const declared = (key: keyof typeof routes) => JSON.stringify(routes[key].extensions);
  for (const key of Object.keys(routes) as Array<keyof typeof routes>) {
    const ext = declared(key);
    assert.match(ext, /"windowHours"/, `${key} declares windowHours`);
    assert.match(ext, /168/);
    assert.match(ext, /720/);
  }
});
