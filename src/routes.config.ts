import { declareDiscoveryExtension } from '@x402-avm/extensions';
import { CONFIG } from './config.js';

// Max targets per batch call. Duplicated from checks/reliability/batch.ts (MAX_BATCH_TARGETS) on
// purpose: importing it would pull the observation store into this config module. A test asserts
// the two stay equal.
export const BATCH_TARGET_LIMIT = 50;

const EXAMPLE_TARGET = 'https://x402.goplausible.xyz/examples/weather';

// What the caller sends, for Bazaar discovery. GET routes describe query parameters; POST routes
// describe a JSON body (`bodyType` marks a body route; without it the route is declared as query-only).
type DiscoveryInput =
  | { kind: 'query'; example: Record<string, unknown>; schema: Record<string, unknown> }
  | { kind: 'json-body'; example: Record<string, unknown>; schema: Record<string, unknown> };

// One helper so every paid route is declared identically. The compliance route will reuse it unchanged.
function paidRoute(opts: {
  path: string; // public path, e.g. '/reliability'
  description: string;
  input: DiscoveryInput;
  exampleOutput: Record<string, unknown>;
  price?: string;
}) {
  const output = { example: opts.exampleOutput };
  return {
    // One entry per Algorand network id form, spec form first (see the CAIP-2 note in config.ts).
    // Identical terms otherwise: same price, payTo, asset and tag.
    accepts: CONFIG.caip2Offered.map((network) => ({
      scheme: 'exact' as const,
      price: opts.price ?? '$1.00',
      network,
      payTo: CONFIG.avmAddress,
      // `asset` is required. `tag` attributes activity to the Global x402 Challenge leaderboard
      // ("add a field named 'tag' to your extra field").
      extra: { asset: CONFIG.usdcAsaId, tag: CONFIG.competitionTag },
    })),
    // Fixed public https URL. Payment matching compares only the `accepts` terms, never this URL,
    // so it does not affect verification; it is what clients and the Bazaar catalog see.
    resource: `${CONFIG.publicBaseUrl}${opts.path}`,
    description: opts.description,
    mimeType: 'application/json',
    extensions:
      opts.input.kind === 'json-body'
        ? declareDiscoveryExtension({ bodyType: 'json', input: opts.input.example, inputSchema: opts.input.schema, output })
        : declareDiscoveryExtension({ input: opts.input.example, inputSchema: opts.input.schema, output }),
  };
}

// HTTP route -> payment + Bazaar discovery config.
// Add the compliance route here later; it reuses paidRoute() with no changes to the plumbing.
export const routes = {
  'GET /reliability': paidRoute({
    path: '/reliability',
    input: {
      kind: 'query',
      example: { target: EXAMPLE_TARGET },
      schema: {
        properties: {
          target: { type: 'string', format: 'uri', maxLength: 2048, description: 'Full http(s) URL of the x402 endpoint to score.' },
        },
        required: ['target'],
        additionalProperties: false,
      },
    },
    description:
      'Reliability score (0-100) for a given x402 endpoint: uptime, correct 402 behaviour, and ' +
      'latency percentiles from continuous independent monitoring. Pass ?target=<endpoint-url>.',
    exampleOutput: {
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
        p99LatencyMs: 410,
        confidence: 'history',
        availability_pct: 99.9,
        error_rate_pct: 0.1,
        protocol_conformance_pct: 100,
        score_normalized: 0.985,
      },
      observedAt: '2026-09-08T00:00:00.000Z',
    },
  }),

  // Batch tier: score up to 50 endpoints in one paid call. Flat price (x402 declares price before
  // the body is seen, so it can't scale with count); history-only (see checks/reliability/batch.ts).
  'POST /reliability/batch': paidRoute({
    path: '/reliability/batch',
    price: '$7.00',
    input: {
      kind: 'json-body',
      example: { targets: [EXAMPLE_TARGET] },
      schema: {
        type: 'object',
        properties: {
          targets: {
            type: 'array',
            items: { type: 'string', format: 'uri', maxLength: 2048 },
            minItems: 1,
            maxItems: BATCH_TARGET_LIMIT,
            description: `Endpoint URLs to score. Duplicates are removed; at most ${BATCH_TARGET_LIMIT} are scored.`,
          },
        },
        required: ['targets'],
        additionalProperties: false,
      },
    },
    description:
      'Reliability scores for up to 50 x402 endpoints in one call. POST JSON body ' +
      '{"targets":["<endpoint-url>", ...]}. Returns a results array (same per-target shape as ' +
      'GET /reliability). Monitored targets return a history-based score; unmonitored targets return ' +
      '"unknown" and are enrolled for ongoing monitoring.',
    exampleOutput: {
      count: 2,
      requested: 2,
      capped: false,
      observedAt: '2026-10-19T00:00:00.000Z',
      results: [
        {
          target: 'https://api.example.com/x402-a',
          checkId: 'reliability',
          status: 'pass',
          score: 98.5,
          detail: { observations: 1440, windowHours: 24, uptimePct: 99.9, correct402Pct: 100, confidence: 'history' },
          observedAt: '2026-10-19T00:00:00.000Z',
        },
        {
          target: 'https://api.example.com/x402-b',
          checkId: 'reliability',
          status: 'unknown',
          score: null,
          detail: { observations: 0, windowHours: 24, confidence: 'pending' },
          observedAt: '2026-10-19T00:00:00.000Z',
        },
      ],
    },
  }),
};
