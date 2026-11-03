#!/usr/bin/env node
// HTTP smoke test for a running Hosannaith API. Read-only and UNPAID: it never sends a payment, so
// it never settles anything (safe to run against production).
//
//   node scripts/smoke-free-routes.mjs http://localhost:4021        # CI, testnet config
//   node scripts/smoke-free-routes.mjs https://api.hosannaith.com   # after a deploy
//
// Checks the free contract routes, Problem Details errors, and that the paid routes still answer
// an unpaid request with 402 + a PAYMENT-REQUIRED header (i.e. the payment gate is untouched).

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

async function expectProblem(res, status) {
  expect(res.status === status, `status ${res.status}`);
  expect(ctype(res) === 'application/problem+json', `content-type ${ctype(res)}`);
  const p = await res.json();
  expect(p.type === 'about:blank' && p.status === status && typeof p.title === 'string', JSON.stringify(p));
}

await check('GET /schema/constructor.json -> 404 Problem Details (no prototype lookup)', async () => {
  await expectProblem(await get('/schema/constructor.json'), 404);
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

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
