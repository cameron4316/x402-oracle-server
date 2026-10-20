import { declareDiscoveryExtension } from '@x402-avm/extensions';
import { CONFIG } from './config.js';

// One helper so every paid route is declared identically. The compliance route will reuse it unchanged.
function paidRoute(opts: {
  description: string;
  exampleOutput: Record<string, unknown>;
  price?: string;
}) {
  return {
    accepts: [
      {
        scheme: 'exact' as const,
        price: opts.price ?? '$1.00',
        network: CONFIG.caip2,
        payTo: CONFIG.avmAddress,
        // `asset` is required. `tag` marks this endpoint for the Global x402 Challenge so activity
        // is attributed on the leaderboard. VERIFY exact tag placement against the competition blog
        // ("add a field named 'tag' to your extra field") before mainnet (build step 6).
        extra: { asset: CONFIG.usdcAsaId, tag: CONFIG.competitionTag },
      },
    ],
    description: opts.description,
    mimeType: 'application/json',
    extensions: declareDiscoveryExtension({ output: { example: opts.exampleOutput } }),
  };
}

// HTTP route -> payment + Bazaar discovery config.
// Add the compliance route here later; it reuses paidRoute() with no changes to the plumbing.
export const routes = {
  'GET /reliability': paidRoute({
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
        confidence: 'history',
      },
      observedAt: '2026-09-08T00:00:00.000Z',
    },
  }),

  // Batch tier: score up to 50 endpoints in one paid call. Flat price (x402 declares price before
  // the body is seen, so it can't scale with count); history-only (see checks/reliability/batch.ts).
  'POST /reliability/batch': paidRoute({
    price: '$7.00',
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
