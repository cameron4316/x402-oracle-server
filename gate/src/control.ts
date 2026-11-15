// The "external-service-reliability" control: what a firm writes into its CALM architecture to say
// "this outside service must be shown to be reliable, by evidence we can check".
//
// The JSON Schema for the same shape is controls/external-service-reliability.requirement.json; a
// test keeps the two in step. Parsing here is strict on purpose: a misspelt threshold that was
// silently ignored would make a gate pass that should not.

export const CONTROL_ID = 'external-service-reliability';

export const EVIDENCE_FORMATS = ['openeago-contract', 'hosannaith-report', 'hosannaith-result'] as const;
export type EvidenceFormat = (typeof EVIDENCE_FORMATS)[number];

/** Ordered weakest to strongest: a threshold can only be met by evidence at or above the minimum. */
export const CONFIDENCE_LEVELS = ['pending', 'one-shot', 'history'] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

export interface Thresholds {
  minReliabilityScore?: number;
  minAvailability?: number;
  maxErrorRate?: number;
  maxLatencyP50Ms?: number;
  maxLatencyP95Ms?: number;
  maxLatencyP99Ms?: number;
  minProtocolConformance?: number;
}

export interface EvidenceSource {
  format: EvidenceFormat;
  /** Where the signed document comes from: an http(s) URL or a file path relative to the architecture. */
  from: string;
  /** The oracle's public key set (JWKS): URL or file path. This, not the document, is the trust anchor. */
  keys: string;
  /** Optional pin: only these key ids are accepted. */
  trustedKids: string[] | null;
}

export interface ControlSpec {
  target: string;
  /** Expected issuer of the evidence, compared with the document when the document names one. */
  oracle: string | null;
  evidence: EvidenceSource | null;
  windowHours: number;
  thresholds: Thresholds;
  minConfidence: Confidence;
  minObservations: number;
  maxEvidenceAgeHours: number;
  enforcement: 'blocking' | 'advisory';
}

export type ParsedControl = { ok: true; spec: ControlSpec } | { ok: false; errors: string[] };

const THRESHOLD_KEYS: Record<string, { field: keyof Thresholds; kind: 'fraction' | 'ms' }> = {
  'min-reliability-score': { field: 'minReliabilityScore', kind: 'fraction' },
  'min-availability': { field: 'minAvailability', kind: 'fraction' },
  'max-error-rate': { field: 'maxErrorRate', kind: 'fraction' },
  'max-latency-p50-ms': { field: 'maxLatencyP50Ms', kind: 'ms' },
  'max-latency-p95-ms': { field: 'maxLatencyP95Ms', kind: 'ms' },
  'max-latency-p99-ms': { field: 'maxLatencyP99Ms', kind: 'ms' },
  'min-protocol-conformance': { field: 'minProtocolConformance', kind: 'fraction' },
};

/** Keys that describe the control (CALM's own, plus the framework references) and carry no policy. */
const DESCRIPTIVE_KEYS = ['control-id', 'name', 'description', 'aigf-catalog-url', 'aigf-risks', 'aigf-mitigations'];
const POLICY_KEYS = [
  'target',
  'oracle',
  'evidence',
  'window-hours',
  'thresholds',
  'min-confidence',
  'min-observations',
  'max-evidence-age-hours',
  'enforcement',
];
const EVIDENCE_KEYS = ['format', 'from', 'keys', 'trusted-kids'];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

export function parseControlConfig(config: unknown): ParsedControl {
  const errors: string[] = [];
  if (!isPlainObject(config)) return { ok: false, errors: ['config must be an object'] };

  for (const key of Object.keys(config)) {
    if (!DESCRIPTIVE_KEYS.includes(key) && !POLICY_KEYS.includes(key)) errors.push(`unknown property "${key}"`);
  }
  if (config['control-id'] !== CONTROL_ID) errors.push(`control-id must be "${CONTROL_ID}"`);

  const target = config['target'];
  if (typeof target !== 'string' || !isHttpUrl(target)) errors.push('target must be an http(s) URL');

  const oracle = config['oracle'];
  if (oracle !== undefined && (typeof oracle !== 'string' || oracle.length === 0)) errors.push('oracle must be a non-empty string');

  let evidence: EvidenceSource | null = null;
  const rawEvidence = config['evidence'];
  if (rawEvidence !== undefined) {
    if (!isPlainObject(rawEvidence)) {
      errors.push('evidence must be an object');
    } else {
      for (const key of Object.keys(rawEvidence)) {
        if (!EVIDENCE_KEYS.includes(key)) errors.push(`evidence: unknown property "${key}"`);
      }
      const { format, from, keys } = rawEvidence;
      const kids = rawEvidence['trusted-kids'];
      if (typeof format !== 'string' || !(EVIDENCE_FORMATS as readonly string[]).includes(format)) {
        errors.push(`evidence.format must be one of ${EVIDENCE_FORMATS.join(', ')}`);
      }
      if (typeof from !== 'string' || from.length === 0) errors.push('evidence.from must be a URL or a file path');
      if (typeof keys !== 'string' || keys.length === 0) errors.push('evidence.keys must be a URL or a file path');
      if (kids !== undefined && (!Array.isArray(kids) || kids.length === 0 || kids.some((k) => typeof k !== 'string' || k.length === 0))) {
        errors.push('evidence.trusted-kids must be a non-empty list of key ids');
      }
      // Only returned when there are no errors at all, so the casts below never reach a caller unchecked.
      evidence = {
        format: format as EvidenceFormat,
        from: from as string,
        keys: keys as string,
        trustedKids: Array.isArray(kids) ? (kids as string[]) : null,
      };
    }
  }

  const windowHours = config['window-hours'] ?? 168;
  if (typeof windowHours !== 'number' || !Number.isInteger(windowHours) || windowHours < 1) {
    errors.push('window-hours must be a whole number of hours, 1 or more');
  }

  const thresholds: Thresholds = {};
  const rawThresholds = config['thresholds'];
  if (!isPlainObject(rawThresholds) || Object.keys(rawThresholds).length === 0) {
    errors.push('thresholds must name at least one requirement');
  } else {
    for (const [key, value] of Object.entries(rawThresholds)) {
      const def = THRESHOLD_KEYS[key];
      if (!def) {
        errors.push(`thresholds: unknown property "${key}"`);
      } else if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(`thresholds.${key} must be a number`);
      } else if (def.kind === 'fraction' && (value < 0 || value > 1)) {
        // The most likely mistake is a percentage (99.9) where a fraction (0.999) is meant.
        errors.push(`thresholds.${key} must be a fraction between 0 and 1 (0.99 means 99%)`);
      } else if (def.kind === 'ms' && value <= 0) {
        errors.push(`thresholds.${key} must be greater than 0`);
      } else {
        thresholds[def.field] = value;
      }
    }
  }

  const minConfidence = config['min-confidence'] ?? 'history';
  if (typeof minConfidence !== 'string' || !(CONFIDENCE_LEVELS as readonly string[]).includes(minConfidence)) {
    errors.push(`min-confidence must be one of ${CONFIDENCE_LEVELS.join(', ')}`);
  }

  const minObservations = config['min-observations'] ?? 1;
  if (typeof minObservations !== 'number' || !Number.isInteger(minObservations) || minObservations < 1) {
    errors.push('min-observations must be a whole number, 1 or more');
  }

  const maxAge = config['max-evidence-age-hours'];
  if (typeof maxAge !== 'number' || !Number.isFinite(maxAge) || maxAge <= 0) {
    errors.push('max-evidence-age-hours is required and must be greater than 0');
  }

  const enforcement = config['enforcement'] ?? 'blocking';
  if (enforcement !== 'blocking' && enforcement !== 'advisory') errors.push('enforcement must be "blocking" or "advisory"');

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    spec: {
      target: target as string,
      oracle: (oracle as string | undefined) ?? null,
      evidence,
      windowHours: windowHours as number,
      thresholds,
      minConfidence: minConfidence as Confidence,
      minObservations: minObservations as number,
      maxEvidenceAgeHours: maxAge as number,
      enforcement: enforcement as 'blocking' | 'advisory',
    },
  };
}

/** The config property names, for the test that compares this parser with the JSON Schema. */
export const CONFIG_PROPERTIES = {
  descriptive: DESCRIPTIVE_KEYS,
  policy: POLICY_KEYS,
  evidence: EVIDENCE_KEYS,
  thresholds: Object.keys(THRESHOLD_KEYS),
};
