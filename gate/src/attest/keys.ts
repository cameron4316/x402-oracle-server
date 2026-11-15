// P-256 key handling for ES256 attestations: public JWK export and the RFC 7638 key id.
// Dependency-free: this file is copied verbatim into the client SDK (sdk/typescript/attest/).
import { createHash, createPublicKey, type KeyObject } from 'node:crypto';

export interface PublicJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}

/** The public half of a P-256 key (private or public KeyObject) as a minimal JWK. */
export function publicJwk(key: KeyObject): PublicJwk {
  const jwk = createPublicKey(key).export({ format: 'jwk' }) as Record<string, unknown>;
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
    throw new Error('attest: the signing key must be an EC P-256 key (ES256)');
  }
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
}

/**
 * RFC 7638 JWK thumbprint (SHA-256, base64url): the key id. For an EC key the hashed input is the
 * required members crv, kty, x, y in lexicographic order with no whitespace (RFC 7638 §3.2).
 * Derived from the key itself, so a published kid can always be checked against its key.
 */
export function thumbprint(jwk: Pick<PublicJwk, 'crv' | 'kty' | 'x' | 'y'>): string {
  const members = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return createHash('sha256').update(members, 'utf8').digest('base64url');
}
