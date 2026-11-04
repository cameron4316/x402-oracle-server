// Key history and the server's signer.
//
// attest/jwks-history.json (committed; PUBLIC keys only) is the single record of every signing key
// Hosannaith has used: the active one, retired ones (kept forever so old attestations stay
// verifiable) and revoked ones (removed from `keys` so naive JWKS verifiers fail safe). It is served
// as /.well-known/hosannaith-keys.json. Every rotation is a commit, so key history is auditable.
//
// The private key never enters the repository or the environment: SIGNING_KEY_PATH points at a PEM
// file readable only by the service user. The server signs only if that key is published here as
// `active`; otherwise it refuses to start, so it can never issue signatures nobody can verify.
import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { thumbprint } from './keys.js';
import { createSigner, type Signer } from './sign.js';
import type { KeySet, PublishedKey } from './verify.js';

export const DEFAULT_HISTORY_PATH = fileURLToPath(new URL('../../attest/jwks-history.json', import.meta.url));

export interface KeyHistory extends KeySet {
  keys: PublishedKey[];
  revoked_keys: Array<{ kid: string; revoked_at: string; reason?: string }>;
}

/** Loads and validates the key history. Throws on anything inconsistent. */
export function loadKeyHistory(path = DEFAULT_HISTORY_PATH): KeyHistory {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<KeyHistory>;
  const keys = raw.keys ?? [];
  const revoked = raw.revoked_keys ?? [];
  for (const k of keys) {
    if (k.kty !== 'EC' || k.crv !== 'P-256' || typeof k.x !== 'string' || typeof k.y !== 'string') {
      throw new Error(`attest: key ${k.kid} in the key history is not an EC P-256 public key`);
    }
    if ('d' in k) throw new Error(`attest: key ${k.kid} in the key history contains PRIVATE key material`);
    if (thumbprint(k) !== k.kid) throw new Error(`attest: key ${k.kid} in the key history does not match its thumbprint`);
    if (k.status !== 'active' && k.status !== 'retired') throw new Error(`attest: key ${k.kid} has status "${k.status}"`);
  }
  if (keys.filter((k) => k.status === 'active').length > 1) throw new Error('attest: more than one active key in the key history');
  for (const r of revoked) {
    if (keys.some((k) => k.kid === r.kid)) throw new Error(`attest: revoked key ${r.kid} is still listed in keys`);
  }
  return { keys, revoked_keys: revoked };
}

/** The document served at /.well-known/hosannaith-keys.json (a JWKS plus revoked_keys). */
export function publishedKeySet(history: KeyHistory): KeyHistory {
  return {
    keys: history.keys.map((k) => ({ ...k, alg: 'ES256', use: 'sig' })),
    revoked_keys: history.revoked_keys,
  };
}

/**
 * The server's signer, or null when SIGNING_KEY_PATH is not set (results are then served unsigned,
 * exactly as before signing existed). Throws, so the process refuses to start, if the key cannot be
 * read or is not published as the active key.
 */
export function loadSigner(keyPath = process.env.SIGNING_KEY_PATH, history: KeyHistory = loadKeyHistory()): Signer | null {
  if (!keyPath) return null;
  let pem: string;
  try {
    pem = readFileSync(keyPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'read error';
    throw new Error(`attest: cannot read the signing key at SIGNING_KEY_PATH (${code})`);
  }
  let signer: Signer;
  try {
    signer = createSigner(createPrivateKey(pem));
  } catch {
    throw new Error('attest: SIGNING_KEY_PATH does not contain a valid EC P-256 private key');
  }
  const published = history.keys.find((k) => k.kid === signer.kid);
  if (!published || published.status !== 'active') {
    throw new Error(
      `attest: signing key ${signer.kid} is not published as "active" in attest/jwks-history.json. ` +
        'Publish its public key first, or unset SIGNING_KEY_PATH to serve unsigned results.',
    );
  }
  return signer;
}
