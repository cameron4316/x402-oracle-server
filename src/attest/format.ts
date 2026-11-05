// Attestation format constants shared by the signer (server) and the verifier (server and SDK).
// Dependency-free: this file is copied verbatim into the client SDK (sdk/typescript/attest/).

export const SPEC_VERSION = '1.0.0';
export const SIGNATURE_ALG = 'ES256';

export interface SignatureBlock {
  alg: typeof SIGNATURE_ALG;
  kid: string;
  sig: string;
}
