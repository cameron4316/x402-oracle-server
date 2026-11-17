// One measurement shape, whatever the oracle sent.
//
// Three signed document formats are understood:
//   openeago-contract   the response contract proposed for OpenEAGO (finos-labs/open-eago issue 72):
//                       spec names, fractions in [0, 1], an explicit window, a confidence level.
//   hosannaith-result   a Hosannaith check result (percentages, flat latency fields), single or batch.
//   hosannaith-report   a Hosannaith dated public report covering one or more endpoints.
// Each is reduced to a Measurement in the contract's units. The signed document itself is never
// changed: it is verified as received and kept verbatim as evidence.
import type { Confidence, EvidenceFormat } from './control.ts';
import { CONFIDENCE_LEVELS } from './control.ts';

export interface Measurement {
  target: string;
  /** All fractions are in [0, 1]. null means the document does not carry the value. */
  reliabilityScore: number | null;
  availability: number | null;
  errorRate: number | null;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  latencyP99Ms: number | null;
  protocolConformance: number | null;
  observations: number | null;
  windowHours: number | null;
  confidence: Confidence | null;
  /** When the service was last observed, and when the document was signed (RFC 3339). */
  observedAt: string | null;
  generatedAt: string | null;
  /** The issuer the document names, if it names one. */
  oracle: string | null;
}

export type Extraction =
  | { ok: true; measurement: Measurement; signed: unknown }
  | { ok: false; reason: 'unrecognized_document' | 'target_not_in_document' | 'malformed_document'; detail: string };

type Obj = Record<string, unknown>;

function isPlainObject(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Same resource, ignoring only spelling differences a URL parser removes (case of host, default port). */
export function sameTarget(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}

class Malformed extends Error {}

function num(o: Obj, key: string): number | null {
  const v = o[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Malformed(`${key} is not a number`);
  return v;
}

function nonNegative(o: Obj, key: string): number | null {
  const v = num(o, key);
  if (v !== null && v < 0) throw new Malformed(`${key} is negative`);
  return v;
}

/** A fraction in [0, 1]. A value such as 99.9 is refused rather than guessed at. */
function fraction(o: Obj, key: string): number | null {
  const v = num(o, key);
  if (v !== null && (v < 0 || v > 1)) throw new Malformed(`${key} is ${v}, not a fraction between 0 and 1`);
  return v;
}

/** A percentage in [0, 100], returned as a fraction. */
function percent(o: Obj, key: string): number | null {
  const v = num(o, key);
  if (v !== null && (v < 0 || v > 100)) throw new Malformed(`${key} is ${v}, not a percentage between 0 and 100`);
  return v === null ? null : v / 100;
}

function str(o: Obj, key: string): string | null {
  const v = o[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new Malformed(`${key} is not a string`);
  return v;
}

function timestamp(o: Obj, key: string): string | null {
  const v = str(o, key);
  if (v !== null && Number.isNaN(Date.parse(v))) throw new Malformed(`${key} is not a timestamp`);
  return v;
}

function confidence(o: Obj, key: string): Confidence | null {
  const v = str(o, key);
  if (v === null) return null;
  if (!(CONFIDENCE_LEVELS as readonly string[]).includes(v)) throw new Malformed(`${key} is "${v}"`);
  return v as Confidence;
}

function fromContract(doc: Obj, target: string): Extraction {
  const docTarget = str(doc, 'target');
  if (docTarget === null) return { ok: false, reason: 'unrecognized_document', detail: 'no "target" member' };
  if (!sameTarget(docTarget, target)) {
    return { ok: false, reason: 'target_not_in_document', detail: `the document is about ${docTarget}` };
  }
  const oracle = doc['oracle'];
  return {
    ok: true,
    signed: doc,
    measurement: {
      target: docTarget,
      reliabilityScore: fraction(doc, 'reliability_score'),
      // The contract keeps the spec's field name, which holds a fraction (see the RFC, question 4).
      availability: fraction(doc, 'availability_pct'),
      errorRate: fraction(doc, 'error_rate'),
      latencyP50Ms: nonNegative(doc, 'latency_p50_ms'),
      latencyP95Ms: nonNegative(doc, 'latency_p95_ms'),
      latencyP99Ms: nonNegative(doc, 'latency_p99_ms'),
      protocolConformance: fraction(doc, 'protocol_conformance'),
      observations: nonNegative(doc, 'observations'),
      windowHours: nonNegative(doc, 'window_hours'),
      confidence: confidence(doc, 'confidence'),
      observedAt: timestamp(doc, 'observed_at'),
      generatedAt: timestamp(doc, 'generated_at'),
      oracle: isPlainObject(oracle) ? str(oracle, 'id') : null,
    },
  };
}

function fromHosannaithResult(doc: Obj, target: string): Extraction {
  // A batch carries one independently signed result per target: use the matching one.
  let result = doc;
  if (Array.isArray(doc['results'])) {
    const match = doc['results'].find((r: unknown) => isPlainObject(r) && typeof r['target'] === 'string' && sameTarget(r['target'], target));
    if (!isPlainObject(match)) return { ok: false, reason: 'target_not_in_document', detail: 'no result for this target in the batch' };
    result = match;
  }
  const docTarget = str(result, 'target');
  const detail = result['detail'];
  if (docTarget === null || !isPlainObject(detail)) {
    return { ok: false, reason: 'unrecognized_document', detail: 'not a Hosannaith check result (no "target" or "detail")' };
  }
  if (!sameTarget(docTarget, target)) {
    return { ok: false, reason: 'target_not_in_document', detail: `the document is about ${docTarget}` };
  }
  const score = fraction(detail, 'score_normalized') ?? percent(result, 'score');
  const availability = percent(detail, 'availability_pct') ?? percent(detail, 'uptimePct');
  const errorRate = percent(detail, 'error_rate_pct') ?? (availability === null ? null : 1 - availability);
  return {
    ok: true,
    signed: result,
    measurement: {
      target: docTarget,
      reliabilityScore: score,
      availability,
      errorRate,
      latencyP50Ms: nonNegative(detail, 'p50LatencyMs'),
      latencyP95Ms: nonNegative(detail, 'p95LatencyMs'),
      latencyP99Ms: nonNegative(detail, 'p99LatencyMs'),
      protocolConformance: percent(detail, 'protocol_conformance_pct') ?? percent(detail, 'correct402Pct'),
      observations: nonNegative(detail, 'observations'),
      windowHours: nonNegative(detail, 'windowHours'),
      confidence: confidence(detail, 'confidence'),
      observedAt: timestamp(detail, 'lastObservedAt') ?? timestamp(result, 'observedAt'),
      generatedAt: timestamp(result, 'generated_at'),
      oracle: null,
    },
  };
}

function fromHosannaithReport(doc: Obj, target: string): Extraction {
  if (doc['type'] !== 'hosannaith.reliability-report' || !Array.isArray(doc['endpoints'])) {
    return { ok: false, reason: 'unrecognized_document', detail: 'not a Hosannaith reliability report' };
  }
  const endpoint = doc['endpoints'].find((e: unknown) => isPlainObject(e) && typeof e['target'] === 'string' && sameTarget(e['target'], target));
  if (!isPlainObject(endpoint)) {
    return { ok: false, reason: 'target_not_in_document', detail: 'the report does not cover this target' };
  }
  const window = isPlainObject(doc['window']) ? doc['window'] : {};
  const availability = percent(endpoint, 'uptimePct');
  return {
    ok: true,
    // The report is signed as a whole; one endpoint's figures cannot be lifted out and still verify.
    signed: doc,
    measurement: {
      target: endpoint['target'] as string,
      reliabilityScore: percent(endpoint, 'score'),
      availability,
      errorRate: availability === null ? null : 1 - availability,
      latencyP50Ms: nonNegative(endpoint, 'p50LatencyMs'),
      latencyP95Ms: nonNegative(endpoint, 'p95LatencyMs'),
      latencyP99Ms: nonNegative(endpoint, 'p99LatencyMs'),
      protocolConformance: percent(endpoint, 'correct402Pct'),
      observations: nonNegative(endpoint, 'probes'),
      windowHours: nonNegative(window, 'hours'),
      // A report is built from the recorded history of each endpoint.
      confidence: 'history',
      observedAt: timestamp(endpoint, 'lastObservedAt'),
      generatedAt: timestamp(doc, 'generated_at'),
      oracle: null,
    },
  };
}

/**
 * Reads the measurement for `target` out of a document, and says which object carries the signature
 * that covers it (the whole document, or one result inside a batch).
 */
export function extractMeasurement(format: EvidenceFormat, document: unknown, target: string): Extraction {
  if (!isPlainObject(document)) return { ok: false, reason: 'unrecognized_document', detail: 'the document is not a JSON object' };
  try {
    if (format === 'openeago-contract') return fromContract(document, target);
    if (format === 'hosannaith-result') return fromHosannaithResult(document, target);
    return fromHosannaithReport(document, target);
  } catch (err) {
    if (err instanceof Malformed) return { ok: false, reason: 'malformed_document', detail: err.message };
    throw err;
  }
}
