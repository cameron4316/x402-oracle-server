// OpenAPI 3.1 description of the public HTTP API, built from the live route config so prices,
// asset, network and payTo can never drift from what the payment middleware actually enforces.
// Takes the routes as an argument (instead of importing routes.config.ts) so it stays free of
// runtime configuration and can be unit-tested on its own.

import { batchResultSchema, checkResultSchema, embeddable, problemSchema } from './schema.js';

export const API_BASE = 'https://api.hosannaith.com';
export const OPENAPI_DOC_VERSION = '1.0.0';

// The subset of a paidRoute() entry (routes.config.ts) this document reads.
export interface PaidRouteLike {
  description: string;
  accepts: Array<{
    scheme: string;
    price: string;
    network: string;
    payTo: string;
    extra: { asset: string | number; tag?: string };
  }>;
}

const usdToAtomic = (price: string): string =>
  String(Math.round((Number(String(price).replace(/[^0-9.]/g, '')) || 0) * 1_000_000)); // USDC: 6 decimals

const problemResponse = (description: string) => ({
  description,
  content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } },
});

const paymentRequiredResponse = {
  description:
    'Payment required (x402 v2). The PAYMENT-REQUIRED response header carries the base64-encoded ' +
    'JSON payment requirements. Pay with any x402 client and retry with the PAYMENT-SIGNATURE header. ' +
    'This response is produced by the x402 payment middleware.',
};

function x402Extension(route: PaidRouteLike) {
  const a = route.accepts[0];
  return {
    scheme: a.scheme,
    price: a.price,
    amount: usdToAtomic(a.price),
    asset: String(a.extra.asset),
    network: a.network,
    payTo: a.payTo,
    ...(a.extra.tag ? { tag: a.extra.tag } : {}),
  };
}

const freeText = (summary: string, mediaType = 'text/plain') => ({
  get: {
    summary,
    tags: ['Discovery'],
    responses: { '200': { description: 'OK', content: { [mediaType]: {} } } },
  },
});

const freeJson = (summary: string) => ({
  get: {
    summary,
    tags: ['Discovery'],
    responses: { '200': { description: 'OK', content: { 'application/json': {} } } },
  },
});

export function buildOpenApi(routes: Record<string, PaidRouteLike>, opts: { maxBatchTargets: number; signed?: boolean }) {
  const single = routes['GET /reliability'];
  const batch = routes['POST /reliability/batch'];
  if (!single || !batch) throw new Error('buildOpenApi: expected GET /reliability and POST /reliability/batch routes');

  return {
    openapi: '3.1.0',
    jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    info: {
      title: 'Hosannaith',
      version: OPENAPI_DOC_VERSION,
      summary: 'Reliability oracle for x402 endpoints on Algorand.',
      description:
        'Independently and continuously monitors x402 endpoints and returns a reliability score ' +
        '(uptime, correct 402 behaviour, latency percentiles) so an agent can decide whether to trust ' +
        'an endpoint before paying it. Paid operations settle in USDC on Algorand mainnet via x402; ' +
        'their payment terms are in each operation\'s "x-x402" extension. Response objects are ' +
        'additive-only: new optional fields may appear; existing fields never change.' +
        (opts.signed
          ? ' Every result is signed: it carries spec_version, generated_at and an ES256 signature ' +
            'verifiable against /.well-known/hosannaith-keys.json (see docs/attestation.md).'
          : ''),
      license: { name: 'Apache-2.0', identifier: 'Apache-2.0' },
      contact: { url: 'https://hosannaith.com' },
    },
    servers: [{ url: API_BASE }],
    tags: [
      { name: 'Reliability', description: 'Paid (x402) reliability scores.' },
      { name: 'Discovery', description: 'Free documents for agents and tooling.' },
    ],
    paths: {
      '/reliability': {
        get: {
          operationId: 'getReliability',
          summary: 'Reliability score for one x402 endpoint',
          description: single.description,
          tags: ['Reliability'],
          'x-x402': x402Extension(single),
          parameters: [
            {
              name: 'target',
              in: 'query',
              required: true,
              description:
                'Full http(s) URL of the x402 endpoint to score. Private, loopback, link-local and reserved ' +
                'addresses, internal host names and URLs with credentials are refused (400, before payment).',
              schema: { type: 'string', format: 'uri', maxLength: 2048 },
            },
            {
              name: 'windowHours',
              in: 'query',
              required: false,
              description:
                'History window in hours: 24 (default), 168 (rolling 7 days) or 720 (rolling 30 days), ' +
                'the windows FINOS OpenEAGO Appendix D uses. Any other value is refused (400, before payment).',
              schema: { type: 'integer', enum: [24, 168, 720], default: 24 },
            },
          ],
          responses: {
            '200': {
              description: 'Reliability result.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/CheckResult' } } },
            },
            '400': problemResponse('Target or windowHours not accepted (see the parameters). Returned before payment.'),
            '402': paymentRequiredResponse,
            '500': problemResponse('Internal error.'),
          },
        },
      },
      '/reliability/batch': {
        post: {
          operationId: 'getReliabilityBatch',
          summary: `Reliability scores for up to ${opts.maxBatchTargets} x402 endpoints`,
          description: batch.description,
          tags: ['Reliability'],
          'x-x402': x402Extension(batch),
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['targets'],
                  properties: {
                    targets: {
                      type: 'array',
                      minItems: 1,
                      items: { type: 'string', format: 'uri', maxLength: 2048 },
                      description:
                        `Endpoint URLs. Duplicates are removed; at most ${opts.maxBatchTargets} are scored. ` +
                        'The same targets are refused as for GET /reliability (400, before payment).',
                    },
                    windowHours: {
                      type: 'integer',
                      enum: [24, 168, 720],
                      default: 24,
                      description: 'History window in hours, as for GET /reliability.',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Batch result.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/BatchResult' } } },
            },
            '400': problemResponse('Body is not { "targets": [...] }, or a target is not accepted.'),
            '402': paymentRequiredResponse,
            '500': problemResponse('Internal error.'),
          },
        },
      },
      '/health': freeJson('Liveness check'),
      '/.well-known/x402': freeJson('x402 discovery document'),
      '/.well-known/hosannaith-keys.json': freeJson('Public keys for verifying signed results (JWKS + revoked_keys)'),
      '/.well-known/security.txt': freeText('Where to report a security issue (RFC 9116)'),
      '/reports/{id}.json': {
        get: {
          summary: 'Signed, dated public reliability report',
          tags: ['Discovery'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' } }],
          responses: {
            '200': { description: 'Signed report (verify per docs/attestation.md).', content: { 'application/json': {} } },
            '404': problemResponse('No such report.'),
          },
        },
      },
      '/llms.txt': freeText('Agent-facing guide'),
      '/openapi.json': freeJson('This document'),
      '/schema/check-result.json': freeJson('JSON Schema of a reliability result'),
      '/schema/batch-result.json': freeJson('JSON Schema of a batch result'),
      '/schema/problem.json': freeJson('JSON Schema of an error body (RFC 9457)'),
    },
    components: {
      schemas: {
        CheckResult: embeddable(checkResultSchema),
        BatchResult: embeddable(batchResultSchema),
        Problem: embeddable(problemSchema),
      },
    },
  };
}
