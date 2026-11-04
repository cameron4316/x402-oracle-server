// Signature verification for Hosannaith results (docs/attestation.md in the repository).
//
// Every result from the oracle carries an ES256 signature over its RFC 8785 canonical JSON. This
// module checks it against the oracle's published key set before a result is handed back, so an
// altered or forged score is never acted on.
//
// Two kinds of failure, handled differently on purpose:
//   - Signature failures (missing, malformed, unknown or revoked key, invalid signature) mean the
//     result cannot be trusted. They ALWAYS throw HosannaithVerificationError.
//   - Not being able to fetch the key set is a transport problem. In 'auto' mode the result is
//     returned and marked 'jwks_unavailable'; in 'strict' mode it throws too.
// The result object is never modified, so it can still be forwarded and verified elsewhere; the
// outcome is available through getVerification(result).
import { verifyAttestation, verifyBatch, type KeySet, type VerifyFailure } from './attest/verify.js';

/** 'auto' (default): verify, fail on bad signatures, tolerate an unreachable key set.
 *  'strict': also fail when the key set cannot be fetched. 'off': do not verify. */
export type VerifyMode = 'auto' | 'strict' | 'off';

export type VerificationStatus = 'verified' | VerifyFailure | 'jwks_unavailable' | 'verification_skipped';

/** Thrown when a result's signature does not verify (or, in 'strict' mode, cannot be checked). */
export class HosannaithVerificationError extends Error {
  readonly reason: VerifyFailure | 'jwks_unavailable';
  constructor(reason: VerifyFailure | 'jwks_unavailable', detail?: string) {
    super(`Hosannaith result failed signature verification: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'HosannaithVerificationError';
    this.reason = reason;
  }
}

const outcomes = new WeakMap<object, VerificationStatus>();

/** How a result returned by this client was verified, or undefined for objects it did not return. */
export function getVerification(result: object): VerificationStatus | undefined {
  return outcomes.get(result);
}

/** Fetches and caches the oracle's published key set. Refetched once when an unknown key appears. */
export class KeySetCache {
  private cached: { keys: KeySet; expires: number } | null = null;

  constructor(
    private readonly url: string,
    private readonly ttlMs = 60 * 60 * 1000,
  ) {}

  async get(force = false): Promise<KeySet> {
    const now = Date.now();
    if (!force && this.cached && this.cached.expires > now) return this.cached.keys;
    const res = await fetch(this.url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`key set request failed (HTTP ${res.status})`);
    const keys = (await res.json()) as KeySet;
    if (!keys || !Array.isArray(keys.keys)) throw new Error('key set response has no keys[]');
    this.cached = { keys, expires: now + this.ttlMs };
    return keys;
  }
}

/**
 * Verifies a single result (kind 'single') or a batch with every item (kind 'batch'). Returns the
 * outcome on success; throws HosannaithVerificationError when the result must not be trusted.
 */
export async function verifyResult(doc: object, kind: 'single' | 'batch', mode: VerifyMode, keyCache: KeySetCache): Promise<VerificationStatus> {
  if (mode === 'off') return record(doc, 'verification_skipped');

  let keys: KeySet;
  try {
    keys = await keyCache.get();
  } catch (err) {
    if (mode === 'strict') throw new HosannaithVerificationError('jwks_unavailable', (err as Error).message);
    return record(doc, 'jwks_unavailable');
  }

  let failure = check(doc, kind, keys);
  if (failure === 'unknown_kid') {
    // The oracle may have rotated to a key published after our cache was filled: refetch once.
    try {
      keys = await keyCache.get(true);
      failure = check(doc, kind, keys);
    } catch (err) {
      if (mode === 'strict') throw new HosannaithVerificationError('jwks_unavailable', (err as Error).message);
    }
  }
  if (failure) throw new HosannaithVerificationError(failure);
  if (kind === 'batch') {
    // Each item is individually signed and was verified above, so it is verified on its own too.
    for (const item of (doc as { results?: object[] }).results ?? []) record(item, 'verified');
  }
  return record(doc, 'verified');
}

function check(doc: object, kind: 'single' | 'batch', keys: KeySet): VerifyFailure | null {
  if (kind === 'single') {
    const v = verifyAttestation(doc, keys);
    return v.ok ? null : v.reason;
  }
  const v = verifyBatch(doc, keys);
  if (v.ok) return null;
  const firstFailure = [v.outer, ...v.results].find((o) => !o.ok);
  return firstFailure && !firstFailure.ok ? firstFailure.reason : 'signature_missing';
}

function record(doc: object, status: VerificationStatus): VerificationStatus {
  outcomes.set(doc, status);
  return status;
}
