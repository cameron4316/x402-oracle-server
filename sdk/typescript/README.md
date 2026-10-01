# hosannaith-client

A tiny client for the **Hosannaith x402 reliability oracle** on Algorand. Get a verified
reliability score (uptime, correct-402 behaviour, latency) for any x402 endpoint — before you
route real USDC to it. The client handles the full x402 pay-per-call handshake for you.

## Install

```bash
pnpm add @x402/core @x402/fetch @x402/avm @algorandfoundation/algokit-utils
# then drop index.ts into your project, or install this folder directly
```

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
    "confidence": "history"
  }
}
```

`confidence` is `"history"` when the score is backed by accumulated monitoring, or `"one-shot"`
for a target queried for the first time (a single live probe, `score: null`).

## Requirements

- An Algorand **MainNet** account funded with a little USDC (each call costs ~$0.01) and ALGO for fees.
- Its **25-word** mnemonic, passed as `mnemonic`. **Never commit it** — load it from an env var or a secret store.

Live service: https://hosannaith.com · Endpoint: `https://api.hosannaith.com/reliability?target=<url>`
