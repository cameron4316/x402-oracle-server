import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { paymentMiddleware, x402ResourceServer } from '@x402/hono';
import { HTTPFacilitatorClient } from '@x402/core/server';
import type { ResourceServerExtension } from '@x402/core/types';
import { ExactAvmScheme } from '@x402/avm/exact/server';
import { bazaarResourceServerExtension } from '@x402-avm/extensions';

import { CONFIG } from './config.js';
import { routes } from './routes.config.js';
import { getCheck } from './checks/registry.js';
import { reliabilityBatch } from './checks/reliability/batch.js';

// --- x402 resource server wiring (mirrors the official Algorand tutorial) ---
const facilitatorClient = new HTTPFacilitatorClient({ url: CONFIG.facilitatorUrl });
const server = new x402ResourceServer(facilitatorClient);
server.register(CONFIG.caip2, new ExactAvmScheme());
server.registerExtension(bazaarResourceServerExtension as unknown as ResourceServerExtension);

const app = new Hono();

// Payment gate for the declared paid routes.
app.use(paymentMiddleware(routes, server));

// --- Paid handler: reliability score for a target endpoint ---
app.get('/reliability', async (c) => {
  const target = c.req.query('target');
  if (!target) {
    return c.json({ error: 'Missing required query param: target' }, 400);
  }
  const check = getCheck('reliability');
  if (!check) return c.json({ error: 'reliability check not registered' }, 500);
  const result = await check.run(target);
  return c.json(result);
});

// --- Paid handler: batch reliability — score up to 50 endpoints in one call ---
// Payment is gated by the middleware before this runs, so a 400 here only happens on a malformed
// body from a client that already paid (the SDK always sends a well-formed body).
app.post('/reliability/batch', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Expected a JSON body: { "targets": ["<endpoint-url>", ...] }' }, 400);
  }
  const targets = (body as { targets?: unknown } | null)?.targets;
  if (!Array.isArray(targets)) {
    return c.json({ error: 'Body must be { "targets": ["<endpoint-url>", ...] }' }, 400);
  }
  const result = await reliabilityBatch(targets);
  return c.json(result);
});

// Free, unpaid health check for your OWN uptime monitoring (not payment-gated).
app.get('/health', (c) => c.json({ ok: true, network: CONFIG.network }));

// --- Agent discovery (free, unpaid): let autonomous agents find and understand this oracle ---
const API_BASE = 'https://api.hosannaith.com';

// Machine-readable x402 discovery document, generated from the live route config so it never
// drifts. Shape follows the x402 v2 discovery convention (name / description / resources[]).
function wellKnownX402() {
  const resources = Object.entries(routes).map(([route, cfg]) => {
    const [method, path] = route.split(' ');
    const accept = (cfg as { accepts: Array<Record<string, any>> }).accepts[0];
    const dollars = Number(String(accept.price).replace(/[^0-9.]/g, '')) || 0;
    const amount = String(Math.round(dollars * 1_000_000)); // USDC has 6 decimals
    return {
      url: `${API_BASE}${path}`,
      method,
      description: (cfg as { description: string }).description,
      network: accept.network,
      asset: String(accept.extra.asset),
      amount,
      payTo: accept.payTo,
      extra: { tag: accept.extra.tag, route },
    };
  });
  return {
    x402Version: 2,
    name: 'Hosannaith',
    description:
      "Reliability oracle for x402 endpoints on Algorand — verify an endpoint's uptime, " +
      'correct-402 behaviour and latency before you route USDC to it. ' +
      'Call GET /reliability?target=<x402-endpoint-url>.',
    resources,
  };
}
app.get('/.well-known/x402', (c) => c.json(wellKnownX402()));

// Agent-facing guide (served as text/plain): what this is, how to pay it, how to read the result.
app.get('/llms.txt', (c) =>
  c.text(`# Hosannaith — x402 reliability oracle

Reliability scoring for x402 endpoints on Algorand. Hosannaith independently and continuously
monitors other x402 endpoints and sells a verified reliability score — uptime, correct-402
behaviour, and latency percentiles — so an agent can decide whether an endpoint is safe to pay
before routing USDC to it. Hosannaith is itself an x402 endpoint.

Website: https://hosannaith.com
API base: ${API_BASE}
Discovery: ${API_BASE}/.well-known/x402

## Network
- Protocol: x402 v2
- Chain: Algorand mainnet
- Facilitator: ${CONFIG.facilitatorUrl}
- Network (CAIP-2): ${CONFIG.caip2}
- Asset: USDC, ASA ${CONFIG.usdcAsaId} (6 decimals)
- payTo: ${CONFIG.avmAddress}
- Challenge tag: ${CONFIG.competitionTag} (present on every paid 402)

## How to pay (x402 flow)
1. GET the paid endpoint with no payment -> HTTP 402 Payment Required, with a PAYMENT-REQUIRED
   header describing the requirement.
2. Pay the advertised requirement with any x402 client (exact scheme on the Algorand AVM).
3. Retry the same request with the PAYMENT-SIGNATURE header.
4. On success -> HTTP 200 with the JSON result below, settled in USDC on Algorand mainnet.

## Paid endpoint
GET /reliability?target=<x402-endpoint-url>   -   $0.01 (10000 uUSDC)
Score the reliability of a target x402 endpoint.

Request
- target (query, required): full URL of the x402 endpoint to score.

Response (application/json)
{
  "target": "<url>",
  "checkId": "reliability",
  "status": "pass" | "degraded" | "fail" | "unknown",
  "score": <number 0-100 | null>,
  "detail": {
    "observations": <int>,
    "windowHours": 24,
    "uptimePct": <number 0-100 | null>,
    "correct402Pct": <number 0-100 | null>,
    "p50LatencyMs": <int | null>,
    "p95LatencyMs": <int | null>,
    "confidence": "history" | "one-shot"
  },
  "observedAt": "<ISO-8601 timestamp>"
}

How to use the result
- status: pass = score >= 90, degraded = 60-89, fail = < 60, unknown = not enough data yet.
- confidence: "history" = backed by accumulated monitoring; "one-shot" = first sighting, a single
  live probe (score may be null). A target queried for the first time is enrolled for ongoing
  monitoring, so confidence improves on subsequent calls.
- Decision rule for agents: before routing USDC to an unfamiliar x402 endpoint, call this first.
  If status is "fail" or the score is low, treat the endpoint as risky.

## Free endpoints
GET /health            - liveness check: {"ok":true,...}
GET /                  - service info (send Accept: application/json for JSON)
GET /.well-known/x402  - machine-readable discovery document
GET /llms.txt          - this file
`),
);

// Root route: free, unpaid. Nothing in the x402 payment flow calls `/`, so it's safe to default
// to the human/crawler-facing HTML page (with Open Graph tags — the GoPlausible facilitator
// dashboard scrapes these for merchant branding, and sends Accept: */*, so HTML must be the
// default rather than something only served for an explicit text/html Accept). JSON is opt-in via
// an explicit Accept: application/json, for API tooling that wants the small info object instead.
app.get('/', (c) => {
  const accept = c.req.header('Accept') ?? '';
  if (accept.includes('application/json')) {
    return c.json({
      service: 'Hosannaith',
      description:
        "x402 reliability oracle on Algorand — verify any x402 endpoint's reliability before you pay it.",
      usage: 'GET /reliability?target=<x402-endpoint-url>',
      docs: 'https://hosannaith.com',
    });
  }
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Hosannaith — x402 Reliability Oracle</title>
<meta name="description" content="Verify any x402 endpoint's reliability — uptime, correct-402 behaviour, latency — before you route USDC to it. Live on Algorand Mainnet.">
<meta property="og:site_name" content="Hosannaith">
<meta property="og:title" content="Hosannaith — x402 Reliability Oracle">
<meta property="og:description" content="Verify any x402 endpoint's reliability — uptime, correct-402 behaviour, latency — before you route USDC to it. Live on Algorand Mainnet.">
<meta property="og:image" content="https://api.hosannaith.com/og-image.png">
<meta property="og:url" content="https://api.hosannaith.com/">
<meta property="og:type" content="website">
<style>
  body { margin: 0; padding: 64px 24px; background: #1A1229; color: #F4EFE6;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    text-align: center; }
  h1 { color: #D4AF37; font-size: 1.75rem; margin-bottom: 12px; }
  p { color: #C7BFD6; max-width: 520px; margin: 0 auto 28px; line-height: 1.6; }
  a { color: #D4AF37; }
</style>
</head>
<body>
  <h1>Hosannaith</h1>
  <p>x402 reliability oracle on Algorand — verify any x402 endpoint's reliability before you pay it.</p>
  <p><a href="https://hosannaith.com">hosannaith.com</a> &middot; <code>GET /reliability?target=&lt;x402-endpoint-url&gt;</code></p>
</body>
</html>`);
});

// OG image, served same-origin from this host so the GoPlausible facilitator's scraper (which
// fetches api.hosannaith.com/ for merchant branding) can pull the logo without a cross-origin hop
// to the apex site. The asset itself lives on the apex; mirror it once into memory and serve it
// here, falling back to a redirect if the apex is briefly unreachable at boot.
const OG_IMAGE_SOURCE = 'https://hosannaith.com/og-image.png';
let ogImageCache: { body: ArrayBuffer; type: string } | null = null;
async function loadOgImage(): Promise<void> {
  try {
    const res = await fetch(OG_IMAGE_SOURCE);
    if (res.ok) {
      ogImageCache = {
        body: await res.arrayBuffer(),
        type: res.headers.get('content-type') ?? 'image/png',
      };
    }
  } catch {
    // leave the cache empty; the route redirects to the source until a later load succeeds
  }
}
void loadOgImage();

app.get('/og-image.png', async (c) => {
  if (!ogImageCache) await loadOgImage();
  if (!ogImageCache) return c.redirect(OG_IMAGE_SOURCE, 302);
  c.header('Content-Type', ogImageCache.type);
  c.header('Cache-Control', 'public, max-age=86400');
  return c.body(ogImageCache.body);
});

serve({ fetch: app.fetch, port: CONFIG.port }, () => {
  console.log(
    `x402 oracle server listening on http://localhost:${CONFIG.port} (network=${CONFIG.network})`,
  );
  console.log('Reminder: run `pnpm monitor` in a separate terminal so observation history accrues.');
});
