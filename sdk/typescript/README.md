# hosannaith-client

A tiny client for the **Hosannaith x402 reliability oracle** on Algorand. Get a verified
reliability score (uptime, correct-402 behaviour, latency) for any x402 endpoint — before you
route real USDC to it. The client handles the full x402 pay-per-call handshake for you.

> **TL;DR** — stop paying dead endpoints. Wrap your x402 paying fetch once and every endpoint is
> vetted before a cent moves: `wrapFetchWithReliabilityGuard(payingFetch, { mnemonic, minScore })`.
> [Jump to the guard ↓](#guard-every-payment-automatically)

## Install

```bash
npm i hosannaith-client @x402/core @x402/fetch @x402/avm
```

The `@x402/*` packages are peer dependencies — install them alongside. `algosdk` is a regular
dependency and is pulled in automatically.

## Use

```ts
import { getReliability } from 'hosannaith-client';

const result = await getReliability('https://some-x402-endpoint/api', {
  mnemonic: process.env.AVM_MNEMONIC!,   // 25-word Algorand mnemonic, funded with USDC
});

console.log(result.score, result.detail.confidence);
// 98.7 "history"
```

Scoring several endpoints? Reuse one client (builds the signer once):

```ts
import { HosannaithClient } from 'hosannaith-client';

const oracle = new HosannaithClient({ mnemonic: process.env.AVM_MNEMONIC! });
for (const url of endpoints) {
  const r = await oracle.getReliability(url);
  if (r.score !== null && r.score < 60) console.warn(`${url} looks unreliable (${r.score})`);
}
```

## Score a whole watchlist in one call (batch)

Scoring many endpoints? One paid batch call ($7 flat) scores up to **50** at once, instead of 50
separate payments. Monitored targets return a full score; a target with no history yet comes back
`unknown` and is enrolled for monitoring.

```ts
import { getReliabilityBatch } from 'hosannaith-client';

const batch = await getReliabilityBatch(
  ['https://a.example/x402', 'https://b.example/x402', 'https://c.example/x402'],
  { mnemonic: process.env.AVM_MNEMONIC! },
);

console.log(`${batch.count} scored`);
const trustworthy = batch.results.filter((r) => r.status === 'pass').map((r) => r.target);
```

## Guard every payment automatically

Don't want to remember to check? Wrap your paying fetch once, and every endpoint is vetted
*before* any USDC moves — a low-scoring endpoint is refused (or warned on) automatically. Scores
are cached per endpoint, so repeated payments to the same endpoint reuse one check.

```ts
import { wrapFetchWithReliabilityGuard } from 'hosannaith-client';
import { wrapFetchWithPayment, x402Client } from '@x402/fetch';

const paying = wrapFetchWithPayment(fetch, x402client);          // your x402 payer
const safe = wrapFetchWithReliabilityGuard(paying, {
  mnemonic: process.env.AVM_MNEMONIC!,   // funds the reliability checks
  minScore: 90,                          // refuse anything below this
  // mode: 'warn',                       // or just log and proceed (default: 'block')
  // cacheTtlMs: 15 * 60 * 1000,         // reuse a score for 15 min (default)
  onDecision: (d) => console.log(`[guard] ${d.url}: ${d.reason}`),
});

// From here on, every call is checked, then paid. A failing endpoint throws
// ReliabilityGuardError (in block mode) before a cent leaves your wallet.
await safe('https://some-x402-endpoint/api');
```

Options: `minScore` (default 90), `mode` (`'block'` | `'warn'`, default `'block'`), `cacheTtlMs`
(default 15 min), `onUnknown`/`onError` (`'allow'` | `'block'` — both default `'allow'`, so an
oracle outage never breaks your payments), `shouldGuard` (filter which requests to check), and
`onDecision` (observe every verdict — handy for metrics or chaining another check like identity).

The guard's own checks are paid via x402, so `mnemonic` must be a funded, USDC-opted-in account.

## What you get back

```json
{
  "target": "https://some-x402-endpoint/api",
  "status": "pass",
  "score": 98.7,
  "detail": {
    "observations": 1439,
    "uptimePct": 100,
    "correct402Pct": 100,
    "p50LatencyMs": 88,
    "p95LatencyMs": 127,
    "p99LatencyMs": 210,
    "confidence": "history",
    "availability_pct": 100,
    "error_rate_pct": 0,
    "protocol_conformance_pct": 100,
    "score_normalized": 0.987
  }
}
```

`availability_pct`, `error_rate_pct`, `protocol_conformance_pct` and `score_normalized` are the
same measurements in OpenEAGO SLO terms; see the
[field reference](https://github.com/cameron4316/x402-oracle-server#reading-the-result).

`confidence` is `"history"` when the score is backed by accumulated monitoring, or `"one-shot"`
for a target queried for the first time (a single live probe, `score: null`).

## Signed results are verified for you

Every Hosannaith result is signed with the oracle's published key. The client checks that
signature before it returns anything, so an altered or forged score never reaches your code.

```ts
import { getReliability, getVerification, HosannaithVerificationError } from 'hosannaith-client';

try {
  const r = await getReliability(url, { mnemonic });
  getVerification(r); // 'verified' (or 'jwks_unavailable' if the key list couldn't be fetched)
} catch (err) {
  if (err instanceof HosannaithVerificationError) {
    // err.reason: 'signature_invalid' | 'signature_missing' | 'unknown_kid' | 'revoked_kid' | ...
  }
}
```

| `verify` | Bad, missing or revoked signature | Key list unreachable |
|---|---|---|
| `'auto'` (default) | throws `HosannaithVerificationError` | result returned, marked `jwks_unavailable` |
| `'strict'` | throws | throws |
| `'off'` | not checked | not checked |

The result object is never modified, so you can store or forward it and anyone can verify it
again later. In the **guard**, a score whose signature fails is always refused, whatever
`onError` says: a forged "pass" is exactly the attack signing exists to stop. Each
`GuardDecision` records how its score was verified in `decision.verification`.

## Requirements

- An Algorand **MainNet** account funded with USDC (each check is $1.00, or $7.00 for a batch of up to 50) and ALGO for fees.
- Its **25-word** mnemonic, passed as `mnemonic`. **Never commit it** — load it from an env var or a secret store.

Live service: https://hosannaith.com · Endpoint: `https://api.hosannaith.com/reliability?target=<url>`

## License

Licensed under the [Apache License, Version 2.0](LICENSE). See [NOTICE](NOTICE).

Earlier releases were published under the MIT License and remain available under its terms: `hosannaith-client` 0.3.0 and earlier.
