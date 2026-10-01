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

// Free, unpaid health check for your OWN uptime monitoring (not payment-gated).
app.get('/health', (c) => c.json({ ok: true, network: CONFIG.network }));

// Root route: free, unpaid. Content-negotiates between a human/crawler-facing HTML page (with
// Open Graph tags — the GoPlausible facilitator dashboard scrapes these for merchant branding)
// and a small JSON info object for API tooling that hits `/` without an HTML Accept header.
app.get('/', (c) => {
  const accept = c.req.header('Accept') ?? '';
  if (accept.includes('text/html')) {
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
<meta property="og:image" content="https://hosannaith.com/og-image.png">
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
  }
  return c.json({
    service: 'Hosannaith',
    description:
      "x402 reliability oracle on Algorand — verify any x402 endpoint's reliability before you pay it.",
    usage: 'GET /reliability?target=<x402-endpoint-url>',
    docs: 'https://hosannaith.com',
  });
});

serve({ fetch: app.fetch, port: CONFIG.port }, () => {
  console.log(
    `x402 oracle server listening on http://localhost:${CONFIG.port} (network=${CONFIG.network})`,
  );
  console.log('Reminder: run `pnpm monitor` in a separate terminal so observation history accrues.');
});
