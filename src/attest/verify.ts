// Verifies attestations produced by sign.ts against a published key set (JWKS).
// Dependency-free (node:crypto only) so the same code can ship in the client SDK.
//
// Every failure has its own reason, so a caller can tell tampering (signature_invalid,
// unknown_kid, revoked_kid, signature_missing) from things that are not about this object.
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { canonicalize } from './jcs.js';
import { thumbprint, type PublicJwk } from './keys.js';
import { SIGNATURE_ALG, type SignatureBlock } from './sign.js';

export interface PublishedKey extends PublicJwk {
  kid: string;
  alg?: string;
  use?: string;
  status?: 'active' | 'retired';
  activated_at?: string | null;
  retired_at?: string | null;
}

export interface KeySet {
  keys: PublishedKey[];
  revoked_keys?: Array<{ kid: string; revoked_at?: string }>;
}

export type VerifyFailure =
  | 'signature_missing'
  | 'malformed_signature'
  | 'unsupported_alg'
  | 'revoked_kid'
  | 'unknown_kid'
  | 'signature_invalid';

export type VerifyOutcome = { ok: true; kid: string } | { ok: false; reason: VerifyFailure; kid?: string };

const B64URL_64_BYTES = /^[A-Za-z0-9_-]{86}$/; // 64 raw bytes, base64url, no padding

export function verifyAttestation(obj: unknown, keySet: KeySet): VerifyOutcome {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, reason: 'signature_missing' };
  const { signature, ...unsigned } = obj as Record<string, unknown> & { signature?: SignatureBlock };
  if (signature === undefined) return { ok: false, reason: 'signature_missing' };
  if (!signature || typeof signature !== 'object' || typeof signature.kid !== 'string' || typeof signature.sig !== 'string') {
    return { ok: false, reason: 'malformed_signature' };
  }
  const { alg, kid, sig } = signature;
  if (alg !== SIGNATURE_ALG) return { ok: false, reason: 'unsupported_alg', kid };
  if (!B64URL_64_BYTES.test(sig)) return { ok: false, reason: 'malformed_signature', kid };
  if (keySet.revoked_keys?.some((r) => r.kid === kid)) return { ok: false, reason: 'revoked_kid', kid };

  const key = keySet.keys.find((k) => k.kid === kid);
  // A published entry whose kid does not match its own key material is treated as unknown.
  if (!key || key.kty !== 'EC' || key.crv !== 'P-256' || thumbprint(key) !== kid) {
    return { ok: false, reason: 'unknown_kid', kid };
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(canonicalize(unsigned), 'utf8');
  } catch {
    return { ok: false, reason: 'signature_invalid', kid };
  }
  const publicKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: key.x, y: key.y }, format: 'jwk' });
  const ok = cryptoVerify('sha256', bytes, { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
  return ok ? { ok: true, kid } : { ok: false, reason: 'signature_invalid', kid };
}

/** Verifies a batch: the outer signature and every per-result signature. */
export function verifyBatch(batch: unknown, keySet: KeySet): { ok: boolean; outer: VerifyOutcome; results: VerifyOutcome[] } {
  const outer = verifyAttestation(batch, keySet);
  const items = (batch as { results?: unknown })?.results;
  const results = Array.isArray(items) ? items.map((r) => verifyAttestation(r, keySet)) : [];
  return { ok: outer.ok && Array.isArray(items) && results.every((r) => r.ok), outer, results };
}
