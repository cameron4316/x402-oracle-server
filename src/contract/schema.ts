// Machine-readable contract for Hosannaith's responses: JSON Schema (draft 2020-12) for the
// reliability result shapes and for error bodies (RFC 9457 Problem Details).
//
// These schemas describe what the code in src/checks/reliability/ actually returns, and
// test/contract.test.ts validates real outputs against them so the two cannot drift silently.
// The response shapes are additive-only: new optional fields may appear (so objects allow
// additional properties); existing fields never change name, type or meaning.

const API_BASE = 'https://api.hosannaith.com';
const SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

// RFC 3339 timestamp in UTC with a literal "Z" (what Date.prototype.toISOString produces).
const timestampUtc = {
  type: 'string',
  format: 'date-time',
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$',
} as const;

const percent = (description: string) => ({
  type: ['number', 'null'],
  minimum: 0,
  maximum: 100,
  description,
});

const latencyMs = (description: string) => ({
  type: ['integer', 'null'],
  minimum: 0,
  description,
});

// Attestation members (docs/attestation.md). Present only when the server signs results.
const attestationProperties = {
  spec_version: {
    type: 'string',
    pattern: '^\\d+\\.\\d+\\.\\d+$',
    description: 'Version of the signed attestation format (semver). Present on signed results.',
  },
  generated_at: { ...timestampUtc, description: 'When the result was signed. Present on signed results.' },
  signature: {
    type: 'object',
    description:
      'ES256 signature over the RFC 8785 canonical JSON of this object without its own `signature`. ' +
      'Public keys: /.well-known/hosannaith-keys.json. Present on signed results.',
    required: ['alg', 'kid', 'sig'],
    properties: {
      alg: { const: 'ES256' },
      kid: { type: 'string', description: 'RFC 7638 thumbprint of the signing key.' },
      sig: { type: 'string', pattern: '^[A-Za-z0-9_-]{86}$', description: 'Raw 64-byte r||s, base64url, no padding.' },
    },
  },
} as const;

export const reliabilityDetailSchema = {
  type: 'object',
  description:
    'Supporting statistics for a reliability result. For a batch target with no history yet ' +
    '(confidence "pending") only observations, windowHours and confidence are present.',
  required: ['observations', 'windowHours', 'confidence'],
  properties: {
    observations: { type: 'integer', minimum: 0, description: 'Probes in the scoring window.' },
    windowHours: { type: 'number', exclusiveMinimum: 0, description: 'Length of the scoring window.' },
    confidence: {
      enum: ['history', 'one-shot', 'pending'],
      description:
        '"history": scored from accumulated monitoring. "one-shot": first sighting, one live probe ' +
        '(score is null). "pending": batch only; no history yet, now enrolled for monitoring.',
    },
    uptimePct: percent('Probes where the endpoint was serving (reachable and not 5xx), in percent.'),
    correct402Pct: percent(
      'Gating-determinate probes (402 vs unpaid 2xx) that returned 402, in percent. Null when no probe ' +
        'was determinate; other 4xx are indeterminate for an unpaid probe and excluded.',
    ),
    p50LatencyMs: latencyMs('Median latency of serving probes.'),
    p95LatencyMs: latencyMs(
      '95th percentile latency of serving probes. With fewer than 20 samples it equals the slowest sample.',
    ),
    p99LatencyMs: latencyMs('99th percentile latency of serving probes. Null below 20 latency samples.'),
    score: { type: ['number', 'null'], minimum: 0, maximum: 100, description: 'Same as the top-level score.' },
    firstObservedAt: { anyOf: [timestampUtc, { type: 'null' }], description: 'Oldest probe in the window.' },
    lastObservedAt: { anyOf: [timestampUtc, { type: 'null' }], description: 'Newest probe in the window.' },
    availability_pct: percent('OpenEAGO SLO alias of uptimePct.'),
    error_rate_pct: percent(
      'OpenEAGO SLO view: 100 - uptimePct, the share of probes that were 5xx or unreachable. ' +
        'Client-side 4xx are not counted as errors: for an unpaid probe they are indeterminate.',
    ),
    protocol_conformance_pct: percent('OpenEAGO SLO alias of correct402Pct.'),
    score_normalized: {
      type: ['number', 'null'],
      minimum: 0,
      maximum: 1,
      description: 'The 0-100 score rescaled to [0, 1] (score / 100).',
    },
    paymentRequirementsSamples: {
      type: 'integer',
      minimum: 0,
      description:
        '402 probes in the window that recorded their x402 payment requirements (recorded since ' +
        'November 2026; older 402s are not counted). Denominator of the two fields below.',
    },
    mainnetPayablePct: percent(
      'Of those 402s, the share whose payment requirements parse and name at least one known mainnet ' +
        '(e.g. Algorand, Base, Solana mainnet). An endpoint can answer 402 yet only accept testnet ' +
        'payment. Informational: not part of the score. Null when no 402 recorded its requirements.',
    ),
    discoverablePct: percent(
      'Of those 402s, the share carrying the x402 v2 bazaar discovery extension (catalog metadata). ' +
        'Informational, never a score input: many correctly gated endpoints omit it.',
    ),
    acceptedNetworks: {
      type: ['array', 'null'],
      // Network ids only: no spaces, at most 53 characters (see isRelayableNetworkId in x402-network.ts).
      items: { type: 'string', pattern: '^[-_a-zA-Z0-9:+/=]{1,53}$' },
      maxItems: 10,
      description:
        'Payment networks the 402s named in the window, as sent (CAIP-2 ids or x402 v1 names). ' +
        'A monitored endpoint chooses this text, so only well-formed network ids are repeated here; ' +
        'anything else it sent is left out.',
    },
    currentSdkPayablePct: percent(
      'Of the 402s that recorded their requirements, the share payable on a known mainnet in a form the ' +
        'current x402 SDK accepts. Since @x402/core and @x402/avm 2.29.0 the SDK refuses the legacy ' +
        'full-genesis-hash Algorand id, so an endpoint whose only mainnet option is that id scores lower ' +
        'here than in mainnetPayablePct. Informational: not part of the score.',
    ),
    algorandIdForm: {
      type: ['string', 'null'],
      enum: ['spec', 'legacy', 'both', null],
      description:
        'Which Algorand mainnet id form(s) the window\'s 402s used: "spec" (CAIP-2, first 32 characters of ' +
        'the genesis hash; required by the x402 SDK since 2.29), "legacy" (full genesis hash; accepted by ' +
        'older clients), "both", or null when Algorand mainnet is not offered.',
    },
  },
} as const;

const checkResultBody = {
  type: 'object',
  required: ['target', 'checkId', 'status', 'score', 'detail', 'observedAt'],
  properties: {
    target: { type: 'string', description: 'The endpoint URL that was scored, as requested.' },
    checkId: { const: 'reliability' },
    status: {
      enum: ['pass', 'degraded', 'fail', 'unknown'],
      description: 'pass: score >= 90. degraded: 60-89. fail: < 60. unknown: not enough data to score.',
    },
    score: {
      type: ['number', 'null'],
      minimum: 0,
      maximum: 100,
      description: '0-100 composite (0.6 uptime + 0.4 correct-402 - latency penalty); null below 5 observations.',
    },
    detail: reliabilityDetailSchema,
    observedAt: { ...timestampUtc, description: 'When this result was computed.' },
    ...attestationProperties,
  },
} as const;

export const checkResultSchema = {
  $schema: SCHEMA_DIALECT,
  $id: `${API_BASE}/schema/check-result.json`,
  title: 'Hosannaith reliability result',
  description: 'Response of GET /reliability and of each item in POST /reliability/batch results.',
  ...checkResultBody,
} as const;

export const batchResultSchema = {
  $schema: SCHEMA_DIALECT,
  $id: `${API_BASE}/schema/batch-result.json`,
  title: 'Hosannaith batch reliability result',
  description: 'Response of POST /reliability/batch.',
  type: 'object',
  required: ['results', 'count', 'requested', 'capped', 'observedAt'],
  properties: {
    results: { type: 'array', items: checkResultBody },
    count: { type: 'integer', minimum: 0, description: 'Targets scored, after dedupe and the cap.' },
    requested: { type: 'integer', minimum: 0, description: 'Targets sent by the caller.' },
    capped: { type: 'boolean', description: 'True when more targets were sent than the cap allows.' },
    observedAt: timestampUtc,
    ...attestationProperties,
  },
} as const;

// RFC 9457 Problem Details. `error` repeats `detail` for clients written against the earlier
// { "error": "..." } bodies.
export const problemSchema = {
  $schema: SCHEMA_DIALECT,
  $id: `${API_BASE}/schema/problem.json`,
  title: 'Problem Details (RFC 9457)',
  type: 'object',
  required: ['type', 'title', 'status'],
  properties: {
    type: { type: 'string', description: 'Problem type URI; "about:blank" means the HTTP status says it all.' },
    title: { type: 'string' },
    status: { type: 'integer', minimum: 400, maximum: 599 },
    detail: { type: 'string' },
    instance: { type: 'string' },
    error: { type: 'string', description: 'Legacy alias of detail.' },
  },
} as const;

// Served at /schema/<name>.json
export const PUBLISHED_SCHEMAS = {
  'check-result': checkResultSchema,
  'batch-result': batchResultSchema,
  problem: problemSchema,
} as const;

// A copy suitable for embedding under OpenAPI components (no $schema / $id, which would reset the
// base URI inside the OpenAPI document).
export function embeddable(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _s, $id: _i, ...rest } = schema;
  return rest;
}
