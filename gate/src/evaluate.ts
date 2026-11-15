// Decides whether one control is met, from the signed document and the key set that were loaded.
//
// Pure: no network, no clock of its own. The same function runs when the gate checks a pipeline and
// when an auditor re-checks a saved evidence file later, so the two cannot disagree.
//
// Order matters. Nothing in a document is treated as a measurement until its signature has been
// verified against keys named by the control (never keys named by the document itself). A failed
// integrity check stops the evaluation; the policy checks after it are all evaluated, so one run
// reports everything that is wrong.
import { verifyAttestation, type KeySet, type PublishedKey } from './attest/verify.ts';
import { extractMeasurement, type Measurement } from './contract.ts';
import { CONFIDENCE_LEVELS, type ControlSpec, type Thresholds } from './control.ts';

export type Loaded = { ok: true; value: unknown } | { ok: false; error: string };

export interface Check {
  id: string;
  /**
   * integrity: is this the oracle's own statement about this service. quality: is the evidence recent
   * and strong enough to rely on. threshold: does the service meet what the control requires.
   */
  group: 'integrity' | 'quality' | 'threshold';
  ok: boolean;
  /** What the control requires and what was found, as short human-readable text. */
  required: string;
  actual: string;
}

export interface Evaluation {
  /** Whether the control's requirement is met. */
  met: boolean;
  /** pass = met. fail = not met and blocking. warn = not met, but the control is advisory. */
  decision: 'pass' | 'fail' | 'warn';
  checks: Check[];
  /** Set only once the signature has verified. */
  measurement: Measurement | null;
  kid: string | null;
  keyStatus: string | null;
}

export interface EvaluationInput {
  spec: ControlSpec;
  /** null when the control configures no evidence source. */
  document: Loaded | null;
  keySet: Loaded | null;
  now: Date;
}

/**
 * Text taken from a document reaches a terminal and a pipeline summary before the document can be
 * trusted. It is kept to one bounded, printable line, so a crafted value cannot repaint the
 * terminal (escape sequences), reorder what is displayed (direction overrides) or flood the output.
 */
export function printable(value: string, max = 300): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, '?');
  return cleaned.length > max ? `${cleaned.slice(0, max)}...` : cleaned;
}

/** Tolerance for clocks that disagree slightly (document dated just ahead of the gate's clock). */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function asKeySet(value: unknown): KeySet | null {
  if (!isPlainObject(value) || !Array.isArray(value['keys']) || !value['keys'].every(isPlainObject)) return null;
  const revoked = value['revoked_keys'];
  if (revoked !== undefined && (!Array.isArray(revoked) || !revoked.every(isPlainObject))) return null;
  return value as unknown as KeySet;
}

const frac = (n: number): string => n.toFixed(4).replace(/0{1,2}$/, '');
const ms = (n: number): string => `${Math.round(n).toLocaleString('en-US')} ms`;

function describeAge(msAge: number): string {
  const minutes = msAge / 60000;
  if (minutes < 1) return 'under a minute';
  if (minutes < 120) return `${Math.round(minutes)} min`;
  const hours = minutes / 60;
  if (hours < 72) return `${hours.toFixed(1)} h`;
  return `${(hours / 24).toFixed(1)} days`;
}

const THRESHOLD_CHECKS: Array<{
  field: keyof Thresholds;
  id: string;
  label: string;
  value: (m: Measurement) => number | null;
  kind: 'min' | 'max';
  format: (n: number) => string;
}> = [
  { field: 'minReliabilityScore', id: 'reliability-score', label: 'reliability score', value: (m) => m.reliabilityScore, kind: 'min', format: frac },
  { field: 'minAvailability', id: 'availability', label: 'availability', value: (m) => m.availability, kind: 'min', format: frac },
  { field: 'maxErrorRate', id: 'error-rate', label: 'error rate', value: (m) => m.errorRate, kind: 'max', format: frac },
  { field: 'maxLatencyP50Ms', id: 'latency-p50', label: 'p50 latency', value: (m) => m.latencyP50Ms, kind: 'max', format: ms },
  { field: 'maxLatencyP95Ms', id: 'latency-p95', label: 'p95 latency', value: (m) => m.latencyP95Ms, kind: 'max', format: ms },
  { field: 'maxLatencyP99Ms', id: 'latency-p99', label: 'p99 latency', value: (m) => m.latencyP99Ms, kind: 'max', format: ms },
  { field: 'minProtocolConformance', id: 'protocol-conformance', label: 'protocol conformance', value: (m) => m.protocolConformance, kind: 'min', format: frac },
];

export function evaluate(input: EvaluationInput): Evaluation {
  const { spec, now } = input;
  const checks: Check[] = [];
  let measurement: Measurement | null = null;
  let kid: string | null = null;
  let keyStatus: string | null = null;

  const finish = (): Evaluation => {
    const met = checks.every((c) => c.ok);
    return {
      met,
      decision: met ? 'pass' : spec.enforcement === 'advisory' ? 'warn' : 'fail',
      checks: checks.map((c) => ({ ...c, required: printable(c.required), actual: printable(c.actual) })),
      measurement,
      kid: kid === null ? null : printable(kid, 100),
      keyStatus: keyStatus === null ? null : printable(keyStatus, 40),
    };
  };
  const stop = (id: string, required: string, actual: string): Evaluation => {
    checks.push({ id, group: 'integrity', ok: false, required, actual });
    return finish();
  };

  // --- Is there evidence at all? ---
  if (!spec.evidence || !input.document || !input.keySet) {
    return stop('evidence-source', 'signed evidence from an independent oracle', 'no evidence source is configured for this service');
  }
  if (!input.document.ok) return stop('evidence-retrieved', 'the signed document can be read', input.document.error);
  if (!input.keySet.ok) return stop('keys-retrieved', "the oracle's public keys can be read", input.keySet.error);
  const keySet = asKeySet(input.keySet.value);
  if (!keySet) return stop('keys-retrieved', "the oracle's public keys can be read", 'the key set is not a JWKS-style object with a "keys" list');

  // --- Integrity: is this document about this service, and did the oracle sign it? ---
  const extraction = extractMeasurement(spec.evidence.format, input.document.value, spec.target);
  if (!extraction.ok) {
    return stop('evidence-covers-target', `a ${spec.evidence.format} document about ${spec.target}`, `${extraction.reason}: ${extraction.detail}`);
  }
  const verified = verifyAttestation(extraction.signed, keySet);
  kid = verified.kid ?? null;
  if (!verified.ok) return stop('signature', "a valid signature by one of the oracle's published keys", verified.reason);
  checks.push({ id: 'signature', group: 'integrity', ok: true, required: "a valid signature by one of the oracle's published keys", actual: `valid (ES256, key ${verified.kid})` });

  const key = keySet.keys.find((k) => k.kid === verified.kid) as PublishedKey;
  keyStatus = key.status ?? null;
  if (spec.evidence.trustedKids) {
    if (!spec.evidence.trustedKids.includes(verified.kid)) {
      return stop('key-pinned', `signed by a pinned key (${spec.evidence.trustedKids.join(', ')})`, `signed by ${verified.kid}, which is not pinned`);
    }
    checks.push({ id: 'key-pinned', group: 'integrity', ok: true, required: 'signed by a pinned key', actual: verified.kid });
  }

  const candidate = extraction.measurement;
  const generatedAt = candidate.generatedAt === null ? null : Date.parse(candidate.generatedAt);
  if (generatedAt !== null) {
    const activated = typeof key.activated_at === 'string' ? Date.parse(key.activated_at) : null;
    const retired = typeof key.retired_at === 'string' ? Date.parse(key.retired_at) : null;
    if (activated !== null && !Number.isNaN(activated) && generatedAt < activated - CLOCK_SKEW_MS) {
      return stop('key-valid-at-signing', 'signed while the key was in use', `dated ${candidate.generatedAt}, before the key was activated (${key.activated_at})`);
    }
    if (retired !== null && !Number.isNaN(retired) && generatedAt > retired + CLOCK_SKEW_MS) {
      return stop('key-valid-at-signing', 'signed while the key was in use', `dated ${candidate.generatedAt}, after the key was retired (${key.retired_at})`);
    }
  }

  if (spec.oracle !== null && (candidate.oracle !== null || spec.evidence.format === 'openeago-contract')) {
    if (candidate.oracle !== spec.oracle) {
      return stop('issuer', `issued by ${spec.oracle}`, candidate.oracle === null ? 'the document does not name its oracle' : `issued by ${candidate.oracle}`);
    }
    checks.push({ id: 'issuer', group: 'integrity', ok: true, required: `issued by ${spec.oracle}`, actual: spec.oracle });
  }

  // The signature covers these values: from here on they are the measurement.
  measurement = candidate;

  // --- Policy: is the evidence recent and strong enough, and are the thresholds met? ---
  const observedAt = measurement.observedAt === null ? null : Date.parse(measurement.observedAt);
  const stamps = [generatedAt, observedAt].filter((t): t is number => t !== null);
  const maxAge = `at most ${spec.maxEvidenceAgeHours} h old`;
  if (generatedAt === null) {
    checks.push({ id: 'freshness', group: 'quality', ok: false, required: maxAge, actual: 'the document does not say when it was signed' });
  } else if (Math.max(...stamps) > now.getTime() + CLOCK_SKEW_MS) {
    checks.push({ id: 'freshness', group: 'quality', ok: false, required: maxAge, actual: `dated in the future (${measurement.generatedAt})` });
  } else {
    // Age is counted from the older of "signed at" and "last observed", so a fresh signature over
    // stale observations does not count as fresh.
    const age = now.getTime() - Math.min(...stamps);
    checks.push({ id: 'freshness', group: 'quality', ok: age <= spec.maxEvidenceAgeHours * 3600_000, required: maxAge, actual: `${describeAge(Math.max(age, 0))} old` });
  }

  checks.push({
    id: 'window',
    group: 'quality',
    ok: measurement.windowHours !== null && measurement.windowHours >= spec.windowHours,
    required: `covers at least ${spec.windowHours} h`,
    actual: measurement.windowHours === null ? 'window not stated' : `covers ${measurement.windowHours} h`,
  });

  const have = measurement.confidence === null ? -1 : CONFIDENCE_LEVELS.indexOf(measurement.confidence);
  checks.push({
    id: 'confidence',
    group: 'quality',
    ok: have >= CONFIDENCE_LEVELS.indexOf(spec.minConfidence),
    required: `confidence "${spec.minConfidence}" or better`,
    actual: measurement.confidence === null ? 'confidence not stated' : `"${measurement.confidence}"`,
  });

  checks.push({
    id: 'observations',
    group: 'quality',
    ok: measurement.observations !== null && measurement.observations >= spec.minObservations,
    required: `at least ${spec.minObservations.toLocaleString('en-US')} observations`,
    actual: measurement.observations === null ? 'observation count not stated' : `${measurement.observations.toLocaleString('en-US')} observations`,
  });

  for (const t of THRESHOLD_CHECKS) {
    const limit = spec.thresholds[t.field];
    if (limit === undefined) continue;
    const value = t.value(measurement);
    const required = `${t.label} ${t.kind === 'min' ? '>=' : '<='} ${t.format(limit)}`;
    if (value === null) {
      // A requirement the evidence says nothing about is not met: absence is not proof.
      checks.push({ id: t.id, group: 'threshold', ok: false, required, actual: 'not measured' });
    } else {
      checks.push({ id: t.id, group: 'threshold', ok: t.kind === 'min' ? value >= limit : value <= limit, required, actual: t.format(value) });
    }
  }

  return finish();
}
