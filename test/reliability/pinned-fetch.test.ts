// pinned-fetch.ts: a probe's connection may only use the addresses that were checked for its host.
// The lookup tests are pure; the dispatcher tests make real requests to a server on 127.0.0.1 under
// host names that cannot exist in DNS (.invalid), so they pass only if the pin is what connected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { failHost, pinHost, pinnedDispatcher, pinnedLookup } from '../../src/checks/reliability/pinned-fetch.js';
import { probe, type Resolver } from '../../src/checks/reliability/monitor.js';

type Answer = { err: NodeJS.ErrnoException | null; address?: unknown; family?: number };
const lookup = (host: string, options: object = {}) =>
  new Promise<Answer>((resolve) => pinnedLookup(host, options, (err: NodeJS.ErrnoException | null, address?: unknown, family?: number) => resolve({ err, address, family })));

async function withServer<T>(run: (port: number, hits: string[]) => Promise<T>): Promise<T> {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    hits.push(`${req.method} ${req.headers.host}${req.url}`);
    res.writeHead(402, { 'payment-required': Buffer.from(JSON.stringify({ x402Version: 2, accepts: [{ network: 'eip155:8453' }] })).toString('base64') }).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run((server.address() as AddressInfo).port, hits);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('the lookup returns only the pinned addresses, in both calling conventions', async () => {
  pinHost('Pinned.Example', [{ address: '93.184.216.34' }, { address: '2606:2800:220:1:248:1893:25c8:1946' }]);
  const all = await lookup('pinned.example', { all: true });
  assert.equal(all.err, null);
  assert.deepEqual(all.address, [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
  ]);
  const single = await lookup('PINNED.example');
  assert.deepEqual([single.address, single.family], ['93.184.216.34', 4]);
  const v6 = await lookup('pinned.example', { family: 6 });
  assert.deepEqual([v6.address, v6.family], ['2606:2800:220:1:248:1893:25c8:1946', 6]);
  const v6All = await lookup('pinned.example', { family: 6, all: true });
  assert.deepEqual(v6All.address, [{ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }]);
});

test('a host that was never checked, or has no usable address, cannot be looked up', async () => {
  const never = await lookup('never-checked.example', { all: true });
  assert.equal(never.err?.code, 'ENOTFOUND');
  assert.equal(never.address, undefined);

  pinHost('v4-only.example', [{ address: '93.184.216.34' }]);
  assert.equal((await lookup('v4-only.example', { family: 6 })).err?.code, 'ENOTFOUND');

  pinHost('garbage.example', [{ address: 'not-an-address' }]);
  assert.equal((await lookup('garbage.example', { all: true })).err?.code, 'ENOTFOUND');
});

test('a failed host gives every connection that same error; a later pin replaces it', async () => {
  const dnsError = Object.assign(new Error('getaddrinfo ENOTFOUND gone.example'), { code: 'ENOTFOUND' });
  failHost('gone.example', dnsError);
  assert.equal((await lookup('gone.example', { all: true })).err, dnsError);
  pinHost('gone.example', [{ address: '93.184.216.34' }]);
  assert.equal((await lookup('gone.example')).address, '93.184.216.34');
});

test('the lookup answers asynchronously, like dns.lookup', () => {
  pinHost('async.example', [{ address: '93.184.216.34' }]);
  let called = false;
  pinnedLookup('async.example', {}, () => (called = true));
  assert.equal(called, false);
});

test('a request goes to the pinned address and nowhere else (real sockets)', async () => {
  const dispatcher = await pinnedDispatcher();
  await withServer(async (port, hits) => {
    const name = 'pinned-here.invalid';
    // Pinned to an address where nothing listens: the request must fail, proving it did not look
    // anywhere else for the name.
    pinHost(name, [{ address: '127.0.0.2' }]);
    await assert.rejects(fetch(`http://${name}:${port}/a`, { dispatcher } as RequestInit));
    assert.deepEqual(hits, []);

    // Pinned to the server: now it arrives, with the original host name in the request.
    pinHost(name, [{ address: '127.0.0.1' }]);
    const res = await fetch(`http://${name}:${port}/b`, { dispatcher } as RequestInit);
    await res.body?.cancel();
    assert.equal(res.status, 402);
    assert.deepEqual(hits, [`GET ${name}:${port}/b`]);

    // A host that was never checked cannot connect through this dispatcher at all.
    await assert.rejects(fetch(`http://unchecked.invalid:${port}/c`, { dispatcher } as RequestInit));
    // Nor can one whose check failed.
    failHost(name, new Error('refused: host resolves to a private or reserved address'));
    await assert.rejects(fetch(`http://${name}:${port + 1}/d`, { dispatcher } as RequestInit));
    assert.equal(hits.length, 1);
  });
});

test('probe() resolves a host once per hop and pins that answer: a resolver that changes its answer cannot move the connection', async () => {
  // First answer is public, every later answer is private (the DNS rebinding pattern).
  const answers: string[] = [];
  const flipping: Resolver = async (host) => {
    const address = answers.length === 0 ? '93.184.216.34' : '10.0.0.5';
    answers.push(`${host} -> ${address}`);
    return [{ address }];
  };
  const original = globalThis.fetch;
  const expected = await pinnedDispatcher();
  const seen: Array<{ url: string; pinned: unknown; sameDispatcher: boolean }> = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit & { dispatcher?: unknown }) => {
    // What the real connection would be told at this moment, without asking the resolver again.
    const pinned = (await lookup(new URL(String(input)).hostname, { all: true })).address;
    seen.push({ url: String(input), pinned, sameDispatcher: init?.dispatcher === expected });
    return new Response(null, { status: 402 });
  }) as typeof fetch;
  try {
    const o = await probe('https://rebind.example.com/x', 5000, flipping);
    assert.equal(o.httpStatus, 402);
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(answers, ['rebind.example.com -> 93.184.216.34'], 'resolved exactly once for the one hop');
  assert.deepEqual(seen, [{ url: 'https://rebind.example.com/x', pinned: [{ address: '93.184.216.34', family: 4 }], sameDispatcher: true }]);

  // The next probe resolves again, gets the private answer, and is refused before any request.
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched++;
    return new Response(null, { status: 402 });
  }) as typeof fetch;
  try {
    const o = await probe('https://rebind.example.com/x', 5000, flipping);
    assert.equal(o.reachable, false);
    assert.match(o.error ?? '', /resolves to a private or reserved address/);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(fetched, 0);
  // And the host is left unconnectable, not pinned to the earlier public answer.
  assert.match((await lookup('rebind.example.com', { all: true })).err?.message ?? '', /private or reserved/);
});

test('an unresolvable host fails the same way as before, without a second lookup', async () => {
  let asked = 0;
  const o = await probe('https://unresolvable-host.invalid/x', 3000, async () => {
    asked++;
    throw Object.assign(new Error('getaddrinfo ENOTFOUND unresolvable-host.invalid'), { code: 'ENOTFOUND' });
  });
  assert.equal(o.reachable, false);
  assert.equal(o.error, 'fetch failed');
  assert.equal(asked, 2, 'once per method (GET, then POST), never by the connection itself');
});
