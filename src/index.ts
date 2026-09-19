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

serve({ fetch: app.fetch, port: CONFIG.port }, () => {
  console.log(
    `x402 oracle server listening on http://localhost:${CONFIG.port} (network=${CONFIG.network})`,
  );
  console.log('Reminder: run `pnpm monitor` in a separate terminal so observation history accrues.');
});
