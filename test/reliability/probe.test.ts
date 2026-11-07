// probe() in src/checks/reliability/monitor.ts: payment requirements on a 402, hand-followed
// redirects, and refusal of hops that lead to private addresses. fetch and DNS are faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probe, type Resolver } from '../../src/checks/reliability/monitor.js';

const ALGO_MAIN_LEGACY = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=';
const publicDns: Resolver = async () => [{ address: '93.184.216.34' }];

type Route = (method: string) => Response;
function fakeFetch(routes: Record<string, Route>) {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url}`);
    assert.equal(init?.redirect, 'manual', 'redirects must never be followed by fetch itself');
    const route = routes[url];
    if (!route) return new Response(null, { status: 404 });
    return route(method);
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}
const header = (obj: unknown) => ({ 'payment-required': Buffer.from(JSON.stringify(obj)).toString('base64') });

test('a v2 402 records its networks and discovery extension, as sent', async () => {
  const f = fakeFetch({
    'https://api.example.com/x': () =>
      new Response(null, {
        status: 402,
        headers: header({ x402Version: 2, accepts: [{ network: ALGO_MAIN_LEGACY }], extensions: { bazaar: {} } }),
      }),
  });
  const o = await probe('https://api.example.com/x', 5000, publicDns);
  f.restore();
  assert.equal(o.httpStatus, 402);
  assert.equal(o.demandedPayment, true);
  assert.equal(o.paymentRequiredParsed, true);
  assert.equal(o.x402Version, 2);
  assert.deepEqual(o.acceptedNetworks, [ALGO_MAIN_LEGACY]);
  assert.equal(o.hasBazaarExtension, true);
  assert.equal(typeof o.latencyMs, 'number');
  assert.equal(o.redirects, undefined);
});

test('a v1 402 is read from its JSON body; an unreadable 402 is recorded as unparsed', async () => {
  const f = fakeFetch({
    'https://v1.example.com/x': () =>
      new Response(JSON.stringify({ x402Version: 1, accepts: [{ network: 'base-sepolia' }] }), {
        status: 402,
        headers: { 'content-type': 'application/json' },
      }),
    'https://bare.example.com/x': () => new Response('pay me', { status: 402 }),
  });
  const v1 = await probe('https://v1.example.com/x', 5000, publicDns);
  const bare = await probe('https://bare.example.com/x', 5000, publicDns);
  f.restore();
  assert.deepEqual(v1.acceptedNetworks, ['base-sepolia']);
  assert.equal(v1.x402Version, 1);
  assert.equal(bare.paymentRequiredParsed, false);
  assert.deepEqual(bare.acceptedNetworks, []);
  assert.equal(bare.demandedPayment, true, 'still a 402: gating is unchanged');
});

test('non-402 responses carry no payment fields', async () => {
  const f = fakeFetch({ 'https://ok.example.com/x': () => new Response('free', { status: 200 }) });
  const o = await probe('https://ok.example.com/x', 5000, publicDns);
  f.restore();
  assert.equal(o.httpStatus, 200);
  assert.equal(o.paymentRequiredParsed, undefined);
  assert.equal(o.acceptedNetworks, undefined);
});

test('redirects are followed by hand, with fetch semantics (303 continues as GET)', async () => {
  const f = fakeFetch({
    'https://a.example.com/start': () => new Response(null, { status: 301, headers: { location: '/next' } }),
    'https://a.example.com/next': (m) =>
      m === 'GET'
        ? new Response(null, { status: 303, headers: { location: 'https://b.example.com/pay' } })
        : new Response(null, { status: 404 }),
    'https://b.example.com/pay': () => new Response(null, { status: 402, headers: header({ x402Version: 2, accepts: [{ network: 'base' }] }) }),
  });
  const o = await probe('https://a.example.com/start', 5000, publicDns);
  f.restore();
  assert.equal(o.httpStatus, 402);
  assert.equal(o.redirects, 2);
  assert.deepEqual(f.calls, ['GET https://a.example.com/start', 'GET https://a.example.com/next', 'GET https://b.example.com/pay']);
});

test('a redirect to a private address is refused, never fetched', async () => {
  const f = fakeFetch({
    'https://evil.example.com/x': () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } }),
  });
  const o = await probe('https://evil.example.com/x', 5000, publicDns);
  f.restore();
  assert.equal(o.reachable, false);
  assert.match(o.error ?? '', /^refused: .*private or reserved/);
  assert.ok(!f.calls.some((c) => c.includes('169.254')), 'the metadata address must never be requested');
  assert.equal(f.calls.length, 1, 'a refusal is not retried with POST');
});

test('a host name that resolves to a private address is refused before any request', async () => {
  const f = fakeFetch({ 'https://sneaky.example.com/x': () => new Response(null, { status: 402 }) });
  const o = await probe('https://sneaky.example.com/x', 5000, async () => [{ address: '93.184.216.34' }, { address: '10.0.0.5' }]);
  f.restore();
  assert.equal(o.reachable, false);
  assert.match(o.error ?? '', /resolves to a private or reserved address/);
  assert.equal(f.calls.length, 0);
});

test('an unresolvable host behaves as before: fetch decides', async () => {
  const f = fakeFetch({ 'https://gone.example.com/x': () => new Response(null, { status: 402 }) });
  const o = await probe('https://gone.example.com/x', 5000, async () => {
    throw new Error('ENOTFOUND');
  });
  f.restore();
  assert.equal(o.httpStatus, 402);
});

test('redirect loops stop', async () => {
  const f = fakeFetch({ 'https://loop.example.com/x': () => new Response(null, { status: 307, headers: { location: '/x' } }) });
  const o = await probe('https://loop.example.com/x', 5000, publicDns);
  f.restore();
  assert.equal(o.reachable, false);
  assert.match(o.error ?? '', /too many redirects/);
});
