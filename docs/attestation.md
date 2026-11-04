# Signed attestations

Every Hosannaith reliability result can be cryptographically signed, so a consumer can prove that a
score came from Hosannaith and was not altered in transit or afterwards. A signed result can be
forwarded on its own (to an auditor, an SLA record, a settlement contract) and still verify.

Signing is additive: a signed result is the same JSON as an unsigned one, plus three members.

## Format (`spec_version` 1.0.0)

```json
{
  "target": "https://x402.example.com/api",
  "checkId": "reliability",
  "status": "pass",
  "score": 98.2,
  "detail": { "...": "..." },
  "observedAt": "2026-11-03T15:36:46.326Z",
  "spec_version": "1.0.0",
  "generated_at": "2026-11-03T15:36:46.330Z",
  "signature": {
    "alg": "ES256",
    "kid": "<RFC 7638 thumbprint of the signing key>",
    "sig": "<86 characters: raw 64-byte r||s, base64url, no padding>"
  }
}
```

| Member | Meaning |
|---|---|
| `spec_version` | Version of this attestation format. Additive changes bump the minor version; breaking changes bump the major. |
| `generated_at` | When the result was signed (RFC 3339, UTC). `observedAt` remains the time the check was computed. |
| `signature.alg` | Always `ES256`: ECDSA on P-256 with SHA-256. |
| `signature.kid` | The signing key's [RFC 7638](https://www.rfc-editor.org/rfc/rfc7638) JWK thumbprint (SHA-256). |
| `signature.sig` | The signature, encoded as JWS ES256 does: raw `r‖s` (64 bytes, IEEE P1363), base64url without padding. |

### What is signed

The signature covers the [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) (JCS) canonical JSON of
the object **without its own `signature` member**, encoded as UTF-8.

### Batches

`POST /reliability/batch` returns a batch whose **every result is signed on its own** (so any one
result can be extracted and verified alone), and the **batch is signed as a whole**. The batch
signature covers the entire batch body **including every per-result `signature`**, excluding only
the batch's own `signature`. So it also proves which results were returned together, and the
batch metadata (`count`, `requested`, `capped`). The `signature` block has the same name and shape
at both levels, so one verifier handles a single result, a batch item, or a batch.

## Keys

Public keys are published at
[`/.well-known/hosannaith-keys.json`](https://api.hosannaith.com/.well-known/hosannaith-keys.json):
a standard JWKS (`keys[]`) plus `revoked_keys[]`. The same history is committed to this repository
as [`attest/jwks-history.json`](../attest/jwks-history.json), so every key change is a reviewed commit.

| Status | In `keys[]`? | Meaning |
|---|---|---|
| `active` | yes | Signs new results. At most one at a time. |
| `retired` | yes, forever | No longer signs. Kept so results signed with it stay verifiable. |
| revoked | **no**, listed in `revoked_keys[]` | Compromised. Removed from `keys[]` so verifiers that only read a standard JWKS fail closed. |

A verifier must reject a `kid` listed in `revoked_keys`, and must not trust a `keys[]` entry whose
`kid` is not the thumbprint of its own key material.

Known limitation: revoking a key invalidates every result it signed, including genuine ones signed
before the compromise. Anchoring attestations on-chain (planned) removes that limitation.

## Verifying

Reference verifier (single result or batch):

```
node_modules/.bin/tsx scripts/verify-signature.ts result.json
node_modules/.bin/tsx scripts/verify-signature.ts result.json --keys attest/jwks-history.json   # offline
```

In your own code, any JOSE library can verify it. With Node.js and no dependencies:

```js
import { createPublicKey, verify } from 'node:crypto';

const { signature, ...unsigned } = result;
const jwks = await (await fetch('https://api.hosannaith.com/.well-known/hosannaith-keys.json')).json();
if (jwks.revoked_keys?.some((r) => r.kid === signature.kid)) throw new Error('revoked key');
const jwk = jwks.keys.find((k) => k.kid === signature.kid);
const ok = verify(
  'sha256',
  Buffer.from(canonicalize(unsigned)), // RFC 8785, e.g. the "canonicalize" npm package
  { key: createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
  Buffer.from(signature.sig, 'base64url'),
);
```

Failure reasons reported by the reference verifier (`src/attest/verify.ts`): `signature_missing`,
`malformed_signature`, `unsupported_alg`, `revoked_kid`, `unknown_kid`, `signature_invalid`. All of
them mean "do not trust this result".

## Signed public reports

A public report is a dated, citable snapshot of Hosannaith's measurements for a named set of
endpoints over a stated window: per endpoint score, uptime, correct-402, latency percentiles,
sustained outages, transient errors and latency spikes, plus the method, scope and a disclaimer.
It is signed with the same key and scheme as results, and `"type": "hosannaith.reliability-report"`
distinguishes it from a result.

- Served at `https://api.hosannaith.com/reports/<id>.json`, from `public-reports/` in this repo.
- Never edited after publishing: a citation always points at the numbers it quoted. A newer report
  gets a new id.
- CI verifies every committed report against the published keys, so an unsigned or altered report
  cannot be published.
- Generated where the key is: `node_modules/.bin/tsx scripts/sign-report.ts --id <id> --subject <name>
  --scope <text> <report-card.json>...` (report cards come from `pnpm report -- --target <url>`).

## Operating the signing key

- The private key is generated **on the server that uses it** (`scripts/attest-keygen.ts`), written
  with mode `0400` outside the repository, and referenced by the `SIGNING_KEY_PATH` environment
  variable. It is never committed, printed, logged or copied elsewhere.
- **Deliberately no backup of the private key.** Losing it means rotating to a new key; results
  signed with the old key stay verifiable because its public key stays published as `retired`.
- The server signs only if its key is published as `active` in `attest/jwks-history.json`. If
  `SIGNING_KEY_PATH` is set to any other key, the server refuses to start. If it is not set, results
  are served unsigned.

### Enabling or rotating

1. Generate the new key on the server: `node_modules/.bin/tsx scripts/attest-keygen.ts <path>`.
   It prints only the public entry.
2. Add that entry to `attest/jwks-history.json` with `activated_at` set; mark the previous active
   key `"status": "retired"` with `retired_at`. Merge.
3. Deploy, point `SIGNING_KEY_PATH` at the new key, restart the API and remote MCP services.
4. Verify a fresh result with `scripts/verify-signature.ts`.

There is no signing overlap: the switch is atomic at restart. Rotate yearly and whenever server
access changes.

### If a key is compromised

1. Rotate to a new key as above.
2. Move the compromised key from `keys` to `revoked_keys` with `revoked_at` (and a short `reason`).
3. Merge and deploy promptly, then announce the revocation with the `kid` and time.

Planned hardening: keep the private key in an HSM or cloud KMS so it never sits in process memory.
