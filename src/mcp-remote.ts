import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { createPaymentWrapper, x402ResourceServer, type PaymentWrapperConfig } from '@x402/mcp';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactAvmScheme } from '@x402/avm/exact/server';
import { declareDiscoveryExtension } from '@x402-avm/extensions';

import { CONFIG } from './config.js';
import { reliabilityCheck } from './checks/reliability/index.js';
import { MAX_BATCH_TARGETS, reliabilityBatch } from './checks/reliability/batch.js';

// Remote, x402-gated MCP server (Streamable HTTP) — runs as its own process (hosannaith-mcp.service
// on :4022, nginx /mcp) so a crash or spike here never touches the live reliability API on :4021.
// Paid tool calls settle to the SAME payTo as the HTTP API, so they roll up into the same merchant.

const MCP_PUBLIC_URL = 'https://api.hosannaith.com/mcp';

// --- x402 resource server wiring (mirrors src/index.ts) ---
// x402ResourceServer comes from @x402/mcp's re-export (pinned @x402/core ~2.28) rather than the
// root @x402/core (2.26): createPaymentWrapper calls 2.28-only methods on it (getRegisteredScheme,
// getPaymentFlow, ...). Keeping the root at 2.26 leaves the live API's dependency tree untouched.
const facilitatorClient = new HTTPFacilitatorClient({ url: CONFIG.facilitatorUrl });
const resourceServer = new x402ResourceServer(
  facilitatorClient as unknown as ConstructorParameters<typeof x402ResourceServer>[0],
);
resourceServer.register(
  CONFIG.caip2,
  new ExactAvmScheme() as unknown as Parameters<typeof resourceServer.register>[1],
);

type PaidTool = {
  name: string;
  price: string; // dollars, e.g. '$1.00'
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema, for Bazaar discovery only
  exampleInput: Record<string, unknown>;
  exampleOutput: unknown;
};

// Resolve a tool's payment requirements through the scheme (price -> atomic amount, feePayer from
// the facilitator's /supported), exactly as the HTTP middleware does for `routes.config.ts`.
async function paymentConfig(tool: PaidTool): Promise<PaymentWrapperConfig> {
  const accepts = await resourceServer.buildPaymentRequirements({
    scheme: 'exact',
    network: CONFIG.caip2,
    price: tool.price,
    payTo: CONFIG.avmAddress,
    // `tag` attributes the settlement to the Global x402 Challenge leaderboard.
    extra: { asset: CONFIG.usdcAsaId, tag: CONFIG.competitionTag },
  });
  return {
    accepts,
    resource: {
      url: `mcp://tool/${tool.name}`,
      description: tool.description,
      mimeType: 'application/json',
      serviceName: 'Hosannaith',
      tags: [CONFIG.competitionTag],
    },
    extensions: declareDiscoveryExtension({
      toolName: tool.name,
      description: tool.description,
      transport: 'streamable-http',
      inputSchema: tool.inputSchema,
      example: tool.exampleInput,
      output: { example: tool.exampleOutput },
    }),
  };
}

const exampleResult = {
  target: 'https://example.com/some-x402-endpoint',
  checkId: 'reliability',
  status: 'pass',
  score: 98.5,
  detail: {
    observations: 1440,
    windowHours: 24,
    uptimePct: 99.9,
    correct402Pct: 100,
    p50LatencyMs: 120,
    p95LatencyMs: 240,
    confidence: 'history',
  },
  observedAt: '2026-09-08T00:00:00.000Z',
};

const SINGLE: PaidTool = {
  name: 'check_x402_reliability',
  price: '$1.00',
  description:
    'Paid — $1.00 USDC per call via x402 on Algorand mainnet. Returns the Hosannaith reliability ' +
    'score (0-100: uptime, correct 402 behaviour, latency percentiles) for a target x402 endpoint ' +
    'URL so you can decide whether to trust it before routing payment to it. Same JSON as ' +
    'GET https://api.hosannaith.com/reliability.',
  inputSchema: {
    type: 'object',
    properties: { target: { type: 'string', format: 'uri' } },
    required: ['target'],
  },
  exampleInput: { target: 'https://x402.goplausible.xyz/examples/weather' },
  exampleOutput: exampleResult,
};

const BATCH: PaidTool = {
  name: 'check_x402_reliability_batch',
  price: '$7.00',
  description:
    `Paid — $7.00 USDC flat per call via x402 on Algorand mainnet, for up to ${MAX_BATCH_TARGETS} ` +
    'targets. Scores many x402 endpoints in one call (same per-target shape as ' +
    'check_x402_reliability). Monitored targets return a history-based score; unmonitored targets ' +
    'return "unknown" and are enrolled for ongoing monitoring.',
  inputSchema: {
    type: 'object',
    properties: {
      targets: { type: 'array', items: { type: 'string', format: 'uri' }, minItems: 1, maxItems: MAX_BATCH_TARGETS },
    },
    required: ['targets'],
  },
  exampleInput: { targets: ['https://x402.goplausible.xyz/examples/weather'] },
  exampleOutput: { count: 1, requested: 1, capped: false, observedAt: exampleResult.observedAt, results: [exampleResult] },
};

// Price advertised in each paid tool's `_meta` so agents can budget before calling (tools/list is free).
function priceMeta(tool: PaidTool, accepts: PaymentWrapperConfig['accepts']) {
  const a = accepts[0];
  return {
    'x402/price': {
      usd: tool.price,
      amount: a.amount,
      asset: a.asset,
      network: a.network,
      payTo: a.payTo,
      scheme: a.scheme,
      tag: CONFIG.competitionTag,
    },
  };
}

const INFO_TEXT = [
  'Hosannaith is a reliability oracle for x402 endpoints on Algorand.',
  'It independently monitors x402 APIs (uptime, correct HTTP 402 behaviour, latency) and sells',
  'a verified reliability score so an agent can decide whether to trust an endpoint BEFORE paying it.',
  '',
  'check_x402_reliability(target) returns JSON shaped like:',
  '  target:    the URL you asked about',
  '  status:    "pass" (score >= 90) | "degraded" (60–89) | "fail" (< 60) | "unknown" (too little data)',
  '  score:     0–100, or null when there is not enough data to stand behind a score',
  '  detail: {',
  '    confidence:  "history" (scored from accrued observations) | "one-shot" (only one live probe — treat cautiously)',
  '    observations, windowHours: how many samples over what period the score covers',
  '    uptimePct, correct402Pct, p50LatencyMs, p95LatencyMs: the underlying signals',
  '  }',
  '',
  'Decision rule for an agent: pay/route to endpoints that are "pass"; treat "degraded" as risky;',
  'avoid "fail"; for "unknown" or "one-shot", gather more signal or proceed with low stakes.',
  '',
  `This is the hosted remote MCP server (${MCP_PUBLIC_URL}). Paid tools are x402-gated per call:`,
  `check_x402_reliability costs $1.00 and check_x402_reliability_batch costs $7.00 (USDC, ASA ${CONFIG.usdcAsaId},`,
  'Algorand mainnet, settled via the GoPlausible facilitator). Call a paid tool without payment to get',
  'the x402 PaymentRequired; pay it with an x402 MCP client (e.g. @x402/mcp wrapMCPClientWithPayment)',
  'by sending the payment payload in the request _meta["x402/payment"].',
  '',
  `Scoring a watchlist? check_x402_reliability_batch(targets) scores up to ${MAX_BATCH_TARGETS} endpoints in one`,
  'paid call ($7 flat) — cheaper than calling check_x402_reliability for each.',
].join('\n');

const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });

// Fetches the facilitator's /supported (feePayer etc.) and builds the wrappers once at startup.
async function buildPaidTools() {
  await resourceServer.initialize();
  const [singleCfg, batchCfg] = await Promise.all([paymentConfig(SINGLE), paymentConfig(BATCH)]);
  return {
    singleCfg,
    batchCfg,
    single: createPaymentWrapper(resourceServer, singleCfg)<{ target: string }>(async ({ target }) =>
      json(await reliabilityCheck.run(target)),
    ),
    batch: createPaymentWrapper(resourceServer, batchCfg)<{ targets: string[] }>(async ({ targets }) =>
      json(await reliabilityBatch(targets)),
    ),
  };
}

type PaidTools = Awaited<ReturnType<typeof buildPaidTools>>;

// Stateless Streamable HTTP: a fresh McpServer + transport per request (the SDK's recommended
// stateless pattern), sharing the payment wrappers built at startup.
function buildMcpServer(paid: PaidTools): McpServer {
  const server = new McpServer({ name: 'hosannaith', version: '0.1.0' });

  server.registerTool(
    'get_hosannaith_info',
    {
      title: 'About the Hosannaith reliability oracle',
      description:
        'Free. Explains what the Hosannaith x402 reliability oracle returns, what the paid tools cost, ' +
        'and how an agent should act on a score. Call this once before check_x402_reliability.',
      inputSchema: {},
    },
    async () => ({ content: [{ type: 'text', text: INFO_TEXT }] }),
  );

  server.registerTool(
    SINGLE.name,
    {
      title: 'Check an x402 endpoint reliability score',
      description: SINGLE.description,
      inputSchema: {
        target: z
          .string()
          .url()
          .describe('The full https URL of the x402 endpoint to evaluate, e.g. https://api.example.com/resource'),
      },
      _meta: priceMeta(SINGLE, paid.singleCfg.accepts),
    },
    paid.single,
  );

  server.registerTool(
    BATCH.name,
    {
      title: 'Batch-check x402 endpoint reliability',
      description: BATCH.description,
      inputSchema: {
        targets: z
          .array(z.string().url())
          .min(1)
          .max(MAX_BATCH_TARGETS)
          .describe(`Up to ${MAX_BATCH_TARGETS} x402 endpoint URLs to score in one paid call.`),
      },
      _meta: priceMeta(BATCH, paid.batchCfg.accepts),
    },
    paid.batch,
  );

  return server;
}

async function main(): Promise<void> {
  const paid = await buildPaidTools();
  const app = new Hono();

  // Free liveness check. nginx maps /mcp -> / (and /mcp/health -> //health), so match the suffix.
  app.get('*', async (c, next) => {
    if (c.req.path.replace(/\/+$/, '').endsWith('/health')) {
      return c.json({ ok: true, service: 'hosannaith-mcp', network: CONFIG.network });
    }
    await next();
  });

  // Every other path is the MCP endpoint (nginx strips the /mcp prefix; direct hits may keep it).
  app.all('*', async (c) => {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true, // plain JSON responses; no SSE stream needed for request/response tools
    });
    const server = buildMcpServer(paid);
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      void transport.close();
      void server.close();
    }
  });

  serve({ fetch: app.fetch, port: CONFIG.mcpRemotePort }, () => {
    console.log(
      `hosannaith remote MCP listening on http://localhost:${CONFIG.mcpRemotePort} ` +
        `(network=${CONFIG.network}, public=${MCP_PUBLIC_URL})`,
    );
  });
}

main().catch((err) => {
  console.error('[hosannaith-mcp-remote] fatal:', err);
  process.exit(1);
});
