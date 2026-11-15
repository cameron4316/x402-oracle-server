// Runs every control in an architecture and records what was decided and why, in one file an
// auditor can re-check later without the pipeline, the network or the oracle.
//
// The evidence file holds, for each control: the control as written, the signed document exactly
// as received, the key set it was verified against, the measurement read from it, every check, and
// the decision. `audit` re-runs the same evaluation from that file and compares.
//
// What the file proves on its own, and what it does not:
//   - The oracle's signature inside it cannot be forged or altered without detection.
//   - The digest detects accidental change to the rest of the file. It is not a signature: someone
//     who rewrote the file could recompute it. The decisions are therefore always recomputed from
//     the signed documents, never taken on trust from the file.
//   - The key set in the file is the one the pipeline used. To rule out a substituted key set, an
//     auditor passes the oracle's keys from a source they trust (`audit --trust-keys`).
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { canonicalize } from './attest/jcs.ts';
import { findControls, type ControlInstance } from './calm.ts';
import type { Measurement } from './contract.ts';
import { parseControlConfig } from './control.ts';
import { asKeySet, evaluate, type Check, type Loaded } from './evaluate.ts';
import { evidenceRef, loadJson } from './sources.ts';
import { GATE_NAME, GATE_VERSION } from './version.ts';

export type Decision = 'pass' | 'fail' | 'warn' | 'invalid';

export interface ControlRecord {
  where: ControlInstance['where'];
  id: string;
  name: string | null;
  control_key: string;
  requirement_index: number;
  /** The control exactly as written in the architecture. */
  config: unknown;
  /** Set when the control itself is not valid; such a control is never treated as met. */
  config_errors: string[] | null;
  decision: Decision;
  checks: Check[];
  measurement: Measurement | null;
  evidence: {
    format: string;
    from: string;
    document: unknown | null;
    document_sha256: string | null;
    error: string | null;
  } | null;
  keys: {
    from: string;
    key_set: unknown | null;
    key_set_sha256: string | null;
    kid: string | null;
    key_status: string | null;
    error: string | null;
  } | null;
}

export interface Bundle {
  type: 'reliability-gate.evidence';
  version: 1;
  gate: { name: string; version: string };
  evaluated_at: string;
  /** "pinned" when the evaluation time was given on the command line instead of read from the clock. */
  clock: 'system' | 'pinned';
  architecture: { path: string; sha256: string; name: string | null };
  result: 'pass' | 'fail';
  summary: { controls: number; pass: number; fail: number; warn: number; invalid: number };
  controls: ControlRecord[];
  digest: { alg: 'sha256'; canonicalization: 'RFC 8785'; value: string };
}

export const sha256Hex = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const canonicalSha256 = (value: unknown): string => sha256Hex(canonicalize(value));

function digestOf(bundle: Omit<Bundle, 'digest'>): Bundle['digest'] {
  return { alg: 'sha256', canonicalization: 'RFC 8785', value: canonicalSha256(bundle) };
}

function summarize(controls: ControlRecord[]): Bundle['summary'] {
  const count = (d: Decision): number => controls.filter((c) => c.decision === d).length;
  return { controls: controls.length, pass: count('pass'), fail: count('fail'), warn: count('warn'), invalid: count('invalid') };
}

export interface RunOptions {
  now: Date;
  clock: 'system' | 'pinned';
}

/** Checks every external-service-reliability control in the architecture file. */
export async function runGate(architecturePath: string, options: RunOptions): Promise<Bundle> {
  const raw = await readFile(architecturePath);
  let architecture: unknown;
  try {
    architecture = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error(`${architecturePath} is not valid JSON`);
  }
  const instances = findControls(architecture);
  const baseDir = dirname(resolve(architecturePath));

  // Several controls often share one report or one key set: read each address once.
  const cache = new Map<string, Promise<Loaded>>();
  const load = (ref: string): Promise<Loaded> => {
    let pending = cache.get(ref);
    if (!pending) {
      pending = loadJson(ref, baseDir);
      cache.set(ref, pending);
    }
    return pending;
  };

  const controls = await Promise.all(
    instances.map(async (instance): Promise<ControlRecord> => {
      const base = {
        where: instance.where,
        id: instance.id,
        name: instance.name,
        control_key: instance.controlKey,
        requirement_index: instance.requirementIndex,
        config: instance.config,
      };
      const parsed = parseControlConfig(instance.config);
      if (!parsed.ok) {
        return { ...base, config_errors: parsed.errors, decision: 'invalid', checks: [], measurement: null, evidence: null, keys: null };
      }
      const { spec } = parsed;
      const from = evidenceRef(spec);
      const document = from === null ? null : await load(from);
      const keySet = spec.evidence ? await load(spec.evidence.keys) : null;
      const result = evaluate({ spec, document, keySet, now: options.now });
      return {
        ...base,
        config_errors: null,
        decision: result.decision,
        checks: result.checks,
        measurement: result.measurement,
        evidence:
          spec.evidence && from !== null && document
            ? {
                format: spec.evidence.format,
                from,
                document: document.ok ? document.value : null,
                document_sha256: document.ok ? canonicalSha256(document.value) : null,
                error: document.ok ? null : document.error,
              }
            : null,
        keys:
          spec.evidence && keySet
            ? {
                from: spec.evidence.keys,
                key_set: keySet.ok ? keySet.value : null,
                key_set_sha256: keySet.ok ? canonicalSha256(keySet.value) : null,
                kid: result.kid,
                key_status: result.keyStatus,
                error: keySet.ok ? null : keySet.error,
              }
            : null,
      };
    }),
  );

  const summary = summarize(controls);
  const architectureName = (architecture as { name?: unknown }).name;
  const unsigned: Omit<Bundle, 'digest'> = {
    type: 'reliability-gate.evidence',
    version: 1,
    gate: { name: GATE_NAME, version: GATE_VERSION },
    evaluated_at: options.now.toISOString(),
    clock: options.clock,
    architecture: { path: architecturePath, sha256: sha256Hex(raw), name: typeof architectureName === 'string' ? architectureName : null },
    result: summary.fail + summary.invalid > 0 ? 'fail' : 'pass',
    summary,
    controls,
  };
  return { ...unsigned, digest: digestOf(unsigned) };
}

export interface AuditControl {
  id: string;
  control_key: string;
  recorded: Decision;
  recomputed: Decision;
  /** The recorded decision and every recorded check match what the signed document supports. */
  consistent: boolean;
  /** When they do not match: the first requirement the evidence in the file fails. */
  reason: string | null;
  kid: string | null;
  /** true/false when trusted keys were supplied and this control used a key; null otherwise. */
  key_confirmed: boolean | null;
}

export interface AuditResult {
  ok: boolean;
  digest_ok: boolean;
  result_ok: boolean;
  trusted_keys_supplied: boolean;
  controls: AuditControl[];
  problems: string[];
}

function isBundle(value: unknown): value is Bundle {
  const b = value as Partial<Bundle> | null;
  return (
    typeof b === 'object' &&
    b !== null &&
    b.type === 'reliability-gate.evidence' &&
    b.version === 1 &&
    typeof b.evaluated_at === 'string' &&
    !Number.isNaN(Date.parse(b.evaluated_at)) &&
    Array.isArray(b.controls) &&
    typeof b.digest === 'object' &&
    b.digest !== null
  );
}

/**
 * Re-checks a saved evidence file. Every decision is recomputed from the signed documents inside
 * it, as of the time recorded in it. `trustedKeySets` are the oracle's keys from a source the
 * auditor trusts; when given, every key the file relied on must appear there, unrevoked.
 */
export function auditBundle(value: unknown, trustedKeySets: unknown[] = []): AuditResult {
  const problems: string[] = [];
  if (!isBundle(value)) {
    return { ok: false, digest_ok: false, result_ok: false, trusted_keys_supplied: trustedKeySets.length > 0, controls: [], problems: ['not a reliability-gate evidence file'] };
  }
  const { digest, ...unsigned } = value;
  let digestOk = false;
  try {
    digestOk = digest.value === canonicalSha256(unsigned);
  } catch {
    digestOk = false;
  }
  if (!digestOk) problems.push('the file has been changed since it was written (digest mismatch)');

  const trusted = trustedKeySets.map(asKeySet);
  if (trusted.some((t) => t === null)) problems.push('a trusted key set is not a JWKS-style object with a "keys" list');
  const now = new Date(value.evaluated_at);

  const controls = value.controls.map((record, index): AuditControl => {
    try {
      return auditControl(record);
    } catch {
      // The file is untrusted input: a record this code cannot even read is a finding.
      problems.push(`control ${index + 1}: the record is malformed`);
      return { id: `control ${index + 1}`, control_key: '', recorded: 'invalid', recomputed: 'invalid', consistent: false, reason: 'the record is malformed', kid: null, key_confirmed: null };
    }
  });

  function auditControl(record: ControlRecord): AuditControl {
    if (typeof record !== 'object' || record === null || typeof record.id !== 'string') throw new Error('malformed record');
    const parsed = parseControlConfig(record.config);
    let recomputed: Decision;
    let consistent: boolean;
    let kid: string | null = null;
    let reason: string | null = null;
    if (!parsed.ok) {
      recomputed = 'invalid';
      consistent = record.decision === 'invalid';
      if (!consistent) reason = `the control is not valid: ${parsed.errors[0]}`;
    } else {
      const asLoaded = (present: boolean, v: unknown, error: string | null | undefined): Loaded =>
        present && v !== null && v !== undefined ? { ok: true, value: v } : { ok: false, error: error ?? 'not recorded' };
      const document = record.evidence ? asLoaded(true, record.evidence.document, record.evidence.error) : null;
      const keySet = record.keys ? asLoaded(true, record.keys.key_set, record.keys.error) : null;
      const result = evaluate({ spec: parsed.spec, document, keySet, now });
      recomputed = result.decision;
      kid = result.kid;
      consistent =
        record.decision === result.decision &&
        canonicalSha256(record.checks ?? null) === canonicalSha256(result.checks) &&
        canonicalSha256(record.measurement ?? null) === canonicalSha256(result.measurement);
      const failing = result.checks.find((c) => !c.ok);
      if (!consistent) reason = failing ? `${failing.required}: ${failing.actual}` : 'the recorded checks or measurement differ from the signed document';
    }
    if (!consistent) problems.push(`${record.id}: recorded as "${record.decision}", but the evidence in the file supports "${recomputed}"`);

    let keyConfirmed: boolean | null = null;
    if (trustedKeySets.length > 0 && kid !== null) {
      const used = asKeySet(record.keys?.key_set)?.keys.find((k) => k.kid === kid);
      keyConfirmed = trusted.some(
        (set) =>
          set !== null &&
          !set.revoked_keys?.some((r) => r.kid === kid) &&
          set.keys.some((k) => k.kid === kid && used !== undefined && k.x === used.x && k.y === used.y && k.crv === used.crv),
      );
      if (!keyConfirmed) problems.push(`${record.id}: key ${kid} is not in the trusted key set (or is revoked there)`);
    }
    return { id: record.id, control_key: record.control_key, recorded: record.decision, recomputed, consistent, reason, kid, key_confirmed: keyConfirmed };
  }

  const expected = controls.some((c) => c.recomputed === 'fail' || c.recomputed === 'invalid') ? 'fail' : 'pass';
  const resultOk = value.result === expected;
  if (!resultOk) problems.push(`the file's overall result is "${value.result}", but its evidence supports "${expected}"`);

  return { ok: problems.length === 0, digest_ok: digestOk, result_ok: resultOk, trusted_keys_supplied: trustedKeySets.length > 0, controls, problems };
}
