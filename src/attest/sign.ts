// Signed attestations. Every reliability result is signed on its own, so one endpoint's result can
// be forwarded (to an auditor, an SLA record, a settlement contract) and still verify. A batch is
// additionally signed as a whole.
//
// Wire format, added to the result object (additive; nothing existing changes):
//   spec_version  "1.0.0"   version of this attestation format (semver)
//   generated_at  RFC 3339  when the attestation was signed (observedAt stays the check time)
//   signature     { alg: "ES256", kid, sig }
//
// What is signed: the RFC 8785 canonical JSON of the object WITHOUT its own `signature` member.
// For a batch, the outer signature covers the whole batch body INCLUDING every per-result
// `signature`, and excludes only the batch's own `signature`. The block has the same name and
// shape at both levels, so one verifier handles a single result, a batch item, or a batch.
//
// Encoding: ECDSA P-256 / SHA-256 with the raw 64-byte r||s signature (IEEE P1363), base64url
// without padding: exactly what JWS ES256 uses, so standard JOSE libraries can verify it.
import { sign as cryptoSign, type KeyObject } from 'node:crypto';
import { canonicalize } from './jcs.js';
import { publicJwk, thumbprint } from './keys.js';
import { SIGNATURE_ALG, SPEC_VERSION, type SignatureBlock } from './format.js';

export { SIGNATURE_ALG, SPEC_VERSION, type SignatureBlock };

export interface Attestation {
  spec_version: string;
  generated_at: string;
  signature: SignatureBlock;
}

export interface Signer {
  readonly kid: string;
  sign(unsigned: Record<string, unknown>): SignatureBlock;
}

export function createSigner(privateKey: KeyObject): Signer {
  if (privateKey.type !== 'private') throw new Error('attest: createSigner needs a private key');
  const kid = thumbprint(publicJwk(privateKey));
  return {
    kid,
    sign(unsigned) {
      if ('signature' in unsigned) throw new Error('attest: object is already signed');
      const bytes = Buffer.from(canonicalize(unsigned), 'utf8');
      const sig = cryptoSign('sha256', bytes, { key: privateKey, dsaEncoding: 'ieee-p1363' });
      return { alg: SIGNATURE_ALG, kid, sig: sig.toString('base64url') };
    },
  };
}

/** Adds spec_version, generated_at and a signature over everything else. */
export function attest<T extends object>(signer: Signer, body: T, generatedAt = new Date().toISOString()): T & Attestation {
  const unsigned = { ...body, spec_version: SPEC_VERSION, generated_at: generatedAt };
  return { ...unsigned, signature: signer.sign(unsigned as Record<string, unknown>) };
}

/** Signs every result, then the batch as a whole (covering the per-result signatures). */
export function attestBatch<T extends { results: object[] }>(signer: Signer, batch: T, generatedAt = new Date().toISOString()) {
  const results = batch.results.map((r) => attest(signer, r, generatedAt));
  return attest(signer, { ...batch, results }, generatedAt);
}
