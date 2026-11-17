// Shared by the tests: a throwaway oracle key, signed contract documents, and a control config.
import { generateKeyPairSync } from 'node:crypto';
import { publicJwk } from '../src/attest/keys.ts';
import { attest, createSigner } from '../src/attest/sign.ts';
import type { KeySet } from '../src/attest/verify.ts';
import { parseControlConfig, type ControlSpec } from '../src/control.ts';

export const TARGET = 'https://service.example/v1/thing';
export const ORACLE = 'https://oracle.example';
export const NOW = new Date('2026-11-15T12:00:00.000Z');

export function makeOracle(activatedAt = '2026-01-01T00:00:00Z') {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const signer = createSigner(privateKey);
  const keySet: KeySet = {
    keys: [{ ...publicJwk(privateKey), kid: signer.kid, alg: 'ES256', use: 'sig', status: 'active', activated_at: activatedAt }],
    revoked_keys: [],
  };
  return { signer, keySet, kid: signer.kid };
}

export const GOOD_FIGURES = {
  reliability_score: 0.99,
  availability_pct: 0.999,
  error_rate: 0.001,
  latency_p50_ms: 100,
  latency_p95_ms: 200,
  latency_p99_ms: 400,
  protocol_conformance: 1,
  observations: 3360,
  window_hours: 168,
  confidence: 'history',
};

/** A contract document signed one minute before NOW unless told otherwise. */
export function contractDoc(signer: ReturnType<typeof createSigner>, overrides: Record<string, unknown> = {}, generatedAt = '2026-11-15T11:59:00.000Z') {
  const body = {
    target: TARGET,
    ...GOOD_FIGURES,
    observed_at: generatedAt,
    oracle: { id: ORACLE, jwks_uri: `${ORACLE}/.well-known/keys.json` },
    ...overrides,
  };
  return attest(signer, body, generatedAt) as unknown as Record<string, unknown>;
}

export function controlConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'control-id': 'external-service-reliability',
    name: 'External Service Reliability',
    description: 'test control',
    target: TARGET,
    oracle: ORACLE,
    evidence: { format: 'openeago-contract', from: 'evidence.json', keys: 'keys.json' },
    'window-hours': 168,
    thresholds: { 'min-reliability-score': 0.95, 'min-availability': 0.99, 'max-error-rate': 0.05, 'max-latency-p95-ms': 1500 },
    'min-confidence': 'history',
    'min-observations': 1000,
    'max-evidence-age-hours': 24,
    ...overrides,
  };
}

export function spec(overrides: Record<string, unknown> = {}): ControlSpec {
  const parsed = parseControlConfig(controlConfig(overrides));
  if (!parsed.ok) throw new Error(`test control is not valid: ${parsed.errors.join('; ')}`);
  return parsed.spec;
}
