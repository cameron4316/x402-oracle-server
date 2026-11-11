#!/usr/bin/env node
// HTTP smoke test for a running Hosannaith API. Read-only and UNPAID: it never sends a payment, so
// it never settles anything (safe to run against production).
//
//   node scripts/smoke-free-routes.mjs http://localhost:4021        # CI, testnet config
//   node scripts/smoke-free-routes.mjs https://api.hosannaith.com   # after a deploy
//
// Checks the free contract routes, Problem Details errors, that the paid routes still answer an
// unpaid request with 402 + a PAYMENT-REQUIRED header (i.e. the payment gate is untouched), and that
// targets we refuse to probe get a 400 before any payment is asked for.

const base = (process.argv[2] ?? '').replace(/\/+$/, '');
if (!/^https?:\/\//.test(base)) {
  console.error('usage: node scripts/smoke-free-routes.mjs <base-url>');
  process.exit(2);
}

// A server that was just restarted takes a few seconds to listen; until then a reverse proxy
// answers 502. Wait (up to 30 s) for /health before checking, so a deploy-then-check sequence
// doesn't report a false outage.
async function waitForHealth(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let announced = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(base + '/health');
      if (res.status === 200) return true;
    } catch {
      // not listening yet
    }
    if (!announced) {
      console.log('waiting for the server to come up...');
      announced = true;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}
if (!(await waitForHealth())) {
  console.log('FAIL  server did not answer /health with 200 within 30 s (is the service running?)');
  process.exit(1);
}

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok    ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL  ${name}: ${e.message}`);
  }
}
function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}
async function get(path, init) {
  return fetch(base + path, { redirect: 'manual', ...init });
}
const ctype = (res) => (res.headers.get('content-type') ?? '').split(';')[0].trim();

await check('GET /health -> 200 {ok:true}', async () => {
  const res = await get('/health');
  expect(res.status === 200, `status ${res.status}`);
  expect((await res.json()).ok === true, 'ok !== true');
});

await check('GET /openapi.json -> OpenAPI 3.1 with x402 terms on both paid operations', async () => {
  const res = await get('/openapi.json');
  expect(res.status === 200, `status ${res.status}`);
  const doc = await res.json();
  expect(doc.openapi === '3.1.0', `openapi ${doc.openapi}`);
  const single = doc.paths?.['/reliability']?.get?.['x-x402'];
  const batch = doc.paths?.['/reliability/batch']?.post?.['x-x402'];
  expect(single && /^\d+$/.test(single.amount), 'missing x-x402 on GET /reliability');
  expect(batch && /^\d+$/.test(batch.amount), 'missing x-x402 on POST /reliability/batch');
});

for (const name of ['check-result', 'batch-result', 'problem']) {
  await check(`GET /schema/${name}.json -> application/schema+json with matching $id`, async () => {
    const res = await get(`/schema/${name}.json`);
    expect(res.status === 200, `status ${res.status}`);
    expect(ctype(res) === 'application/schema+json', `content-type ${ctype(res)}`);
    const s = await res.json();
    expect(s.$id === `https://api.hosannaith.com/schema/${name}.json`, `$id ${s.$id}`);
  });
}

await check('GET /.well-known/hosannaith-keys.json -> public key set, no private material', async () => {
  const res = await get('/.well-known/hosannaith-keys.json');
  expect(res.status === 200, `status ${res.status}`);
  const ks = await res.json();
  expect(Array.isArray(ks.keys) && Array.isArray(ks.revoked_keys), 'keys[] and revoked_keys[] expected');
  for (const k of ks.keys) {
    expect(typeof k.kid === 'string' && k.alg === 'ES256' && k.use === 'sig', `bad key entry ${JSON.stringify(k)}`);
    expect(!('d' in k), `key ${k.kid} exposes private material`);
  }
});

async function expectProblem(res, status) {
  expect(res.status === status, `status ${res.status}`);
  expect(ctype(res) === 'application/problem+json', `content-type ${ctype(res)}`);
  const p = await res.json();
  expect(p.type === 'about:blank' && p.status === status && typeof p.title === 'string', JSON.stringify(p));
}

await check('GET /schema/constructor.json -> 404 Problem Details (no prototype lookup)', async () => {
  await expectProblem(await get('/schema/constructor.json'), 404);
});

await check('GET /reports/no-such-report.json -> 404 Problem Details', async () => {
  await expectProblem(await get('/reports/no-such-report.json'), 404);
});

await check('GET /no-such-route -> 404 Problem Details', async () => {
  await expectProblem(await get('/no-such-route'), 404);
});

await check('GET /llms.txt documents the SLO fields', async () => {
  const res = await get('/llms.txt');
  expect(res.status === 200, `status ${res.status}`);
  const text = await res.text();
  for (const f of ['p99LatencyMs', 'availability_pct', 'error_rate_pct', 'protocol_conformance_pct', 'score_normalized', '/openapi.json']) {
    expect(text.includes(f), `missing ${f}`);
  }
});

await check('GET /reliability (unpaid) -> 402 with PAYMENT-REQUIRED header', async () => {
  const res = await get('/reliability?target=' + encodeURIComponent('https://example.com/x402'));
  expect(res.status === 402, `status ${res.status}`);
  expect(res.headers.get('payment-required'), 'no PAYMENT-REQUIRED header');
});

// Decodes the x402 v2 PAYMENT-REQUIRED header (base64 JSON).
function paymentRequired(res) {
  return JSON.parse(Buffer.from(res.headers.get('payment-required') ?? '', 'base64').toString('utf8'));
}

await check('402 offers both Algorand network ids, spec form first, otherwise identical', async () => {
  const pr = paymentRequired(await get('/reliability'));
  const nets = (pr.accepts ?? []).map((a) => a.network);
  expect(nets.length === 2, `accepts networks ${JSON.stringify(nets)}`);
  expect(/^algorand:[A-Za-z0-9_-]{32}$/.test(nets[0]), `first network is not the spec form: ${nets[0]}`);
  expect(nets[1].startsWith(nets[0]) && nets[1].length > nets[0].length, `second is not the legacy form of the first: ${nets[1]}`);
  const strip = ({ network, ...rest }) => JSON.stringify(rest);
  expect(strip(pr.accepts[0]) === strip(pr.accepts[1]), 'the two options differ in more than the network');
});

await check('402 for GET /reliability: https resource URL + `target` declared for discovery', async () => {
  const pr = paymentRequired(await get('/reliability'));
  expect(/^https:\/\/[^/]+\/reliability$/.test(pr.resource?.url ?? ''), `resource.url ${pr.resource?.url}`);
  const input = pr.extensions?.bazaar?.info?.input ?? {};
  expect(typeof input.queryParams?.target === 'string', `queryParams ${JSON.stringify(input.queryParams)}`);
});

await check('POST /reliability/batch (unpaid) -> 402: https resource URL + JSON body declared', async () => {
  const res = await get('/reliability/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targets: ['https://example.com/x402'] }),
  });
  expect(res.status === 402, `status ${res.status}`);
  expect(res.headers.get('payment-required'), 'no PAYMENT-REQUIRED header');
  const pr = paymentRequired(res);
  expect(/^https:\/\/[^/]+\/reliability\/batch$/.test(pr.resource?.url ?? ''), `resource.url ${pr.resource?.url}`);
  const input = pr.extensions?.bazaar?.info?.input ?? {};
  expect(input.bodyType === 'json' && Array.isArray(input.body?.targets), `input ${JSON.stringify(input)}`);
});

await check('GET /reliability with a private target -> 400 Problem Details before payment', async () => {
  const res = await get('/reliability?target=' + encodeURIComponent('http://169.254.169.254/latest/meta-data'));
  expect(res.status === 400, `status ${res.status}`);
  expect(!res.headers.get('payment-required'), 'a refused target must not get a payment requirement');
  expect(ctype(res) === 'application/problem+json', `content-type ${ctype(res)}`);
  expect(/not accepted/.test((await res.json()).detail ?? ''), 'detail does not explain the refusal');
});

await check('POST /reliability/batch with a private target -> 400 Problem Details before payment', async () => {
  const res = await get('/reliability/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targets: ['https://example.com/x402', 'http://127.0.0.1:4021/health'] }),
  });
  expect(res.status === 400, `status ${res.status}`);
  expect(!res.headers.get('payment-required'), 'a refused target must not get a payment requirement');
  expect(/127\.0\.0\.1/.test((await res.json()).detail ?? ''), 'detail does not name the refused target');
});

await check('windowHours: 168 still gets the 402; 48 gets a 400 before payment', async () => {
  const ok = await get('/reliability?target=' + encodeURIComponent('https://x402.goplausible.xyz/examples/weather') + '&windowHours=168');
  expect(ok.status === 402, `windowHours=168 status ${ok.status}`);
  const bad = await get('/reliability?target=' + encodeURIComponent('https://x402.goplausible.xyz/examples/weather') + '&windowHours=48');
  expect(bad.status === 400, `windowHours=48 status ${bad.status}`);
  expect(!bad.headers.get('payment-required'), 'a refused window must not get a payment requirement');
  expect(/one of 24, 168, 720/.test((await bad.json()).detail ?? ''), 'detail does not list the allowed windows');
  const badBatch = await get('/reliability/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targets: ['https://example.com/x402'], windowHours: 48 }),
  });
  expect(badBatch.status === 400, `batch windowHours=48 status ${badBatch.status}`);
});

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
