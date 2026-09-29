# Hosannaith

**A pay-per-call x402 reliability oracle — live on Algorand Mainnet.**

🔗 **Live app:** [hosannaith.com](https://hosannaith.com) · **API:** `api.hosannaith.com` ·
**Repo:** [github.com/cameron4316/x402-oracle-server](https://github.com/cameron4316/x402-oracle-server)

## The problem

As x402 turns APIs into pay-per-request services, agents increasingly pay endpoints they didn't
build — with no way to know if an endpoint is actually reliable before sending real USDC. Dead or
misbehaving endpoints silently waste money and break automated flows.

## What it does

Hosannaith is itself an x402 endpoint. It independently and continuously monitors other x402
endpoints and sells a verified reliability score on demand: uptime, correct `402` behaviour, and
latency percentiles, backed by real accumulated history — with every response flagging its
confidence (`"history"` for a stood-behind score, `"one-shot"` for a target queried for the first
time). It's x402 monitoring x402.

```
GET https://api.hosannaith.com/reliability?target=<x402-endpoint-url>
```

Unpaid requests get `402 Payment Required` with payment instructions; paid requests settle in
USDC on Algorand via the GoPlausible facilitator and return JSON like:

> **Verifiable on-chain:** first mainnet settlement —
> [`3F2ATV3NCRVOI45IEL6OUKAWED3NQX246WJADESJB5CFR6LIXGCQ`](https://allo.info/tx/3F2ATV3NCRVOI45IEL6OUKAWED3NQX246WJADESJB5CFR6LIXGCQ)

```json
{
  "target": "https://x402.example.com/api",
  "status": "pass",
  "score": 98.7,
  "detail": {
    "observations": 1439,
    "windowHours": 24,
    "uptimePct": 100,
    "correct402Pct": 100,
    "p50LatencyMs": 88,
    "p95LatencyMs": 127,
    "confidence": "history"
  }
}
```

## Architecture and vision

The architecture is deliberately **pluggable**: every paid product implements the `Check`
contract (see `src/checks/types.ts`). Reliability ships first; a **compliance/attestation**
product for tokenization — the trust layer institutions need to bring real-world assets on-chain —
is planned as a second `Check` + one route entry, with no rewrite of the payment plumbing.

The **monitor** (`pnpm monitor`, run continuously on the production droplet) records one
observation per target per interval, append-only, to `data/observations.jsonl`. That history
compounds and cannot be reconstructed later — every score above is backed by real, continuous
observation, not a synthetic estimate.

---

## For developers

Everything below is setup/reference for running Hosannaith locally (defaults to testnet) or
understanding the codebase — not required to use the live API above.

---

## 1. Install
```bash
pnpm install
# runtime deps (exact packages from the official Algorand tutorial):
pnpm add @x402/core @x402/avm @x402/hono @x402-avm/extensions hono @hono/node-server dotenv
```

## 2. Configure
```bash
cp .env.example .env
```
Then edit `.env`:
- `AVM_ADDRESS` — a **testnet** account funded with ALGO and opted in to testnet USDC.
- Leave `NETWORK=testnet` and the GoPlausible `FACILITATOR_URL` as-is for now.
- `MONITOR_TARGETS` already points at the Foundation's public example endpoint.

Testnet setup (accounts, faucets, USDC opt-in) follows the official tutorial:
https://dev.algorand.co/resources/x402-on-algorand/

## 3. Run (two terminals)
```bash
pnpm monitor   # terminal 1 — starts collecting observations immediately
pnpm dev       # terminal 2 — starts the paid resource server on :4021
```
Sanity checks:
```bash
curl http://localhost:4021/health                 # -> {"ok":true,...}  (free)
curl -i "http://localhost:4021/reliability?target=https://x402.goplausible.xyz/examples/weather"
#  -> HTTP 402 Payment Required  (correct: it's a PAID route)
```
To pay and get the JSON back, point the tutorial's client at
`http://localhost:4021/reliability?target=...` (client code:
https://dev.algorand.co/resources/x402-on-algorand/#part-1-build-the-client).

---

## File map
```
src/
  index.ts              Hono app + x402 wiring (edit sparingly)
  monitor.ts            Standalone monitor process (pnpm monitor)
  config.ts             Network/asset/facilitator config; testnet<->mainnet switch
  routes.config.ts      Paid routes + Bazaar discovery metadata  <-- add compliance route here
  checks/
    types.ts            The pluggable Check contract (shared by all products)
    registry.ts         Maps check id -> implementation
    reliability/
      monitor.ts        probe() + startMonitor()
      store.ts          Observation type + append-only JSONL store (swappable)
      score.ts          Turns observations into a 0-100 score
      index.ts          The reliability Check (reads store, computes score)
data/
  observations.jsonl    Append-only history (git-ignored; compounding)
```

## Mainnet is live — the CAIP-2 override, explained accurately

`src/config.ts`'s `FACILITATOR_TESTNET_CAIP2` and `MAINNET_CAIP2` are **hardcoded, not imported
from `@x402/avm`** — and that's deliberate, not an oversight. Here's the real story:

`@x402/avm`'s `ALGORAND_TESTNET_CAIP2` / `ALGORAND_MAINNET_CAIP2` exports are the **spec-correct**,
truncated CAIP-2 form (per the Algorand CAIP-2 namespace profile; fixed upstream in
`x402-foundation/x402` issue #2904 / PR #2931). The package is not the problem. The live
GoPlausible facilitator (`facilitator.goplausible.xyz`) runs `GoPlausible/x402-avm`, a fork
hundreds of commits behind upstream that predates that fix — so its `/supported` endpoint still
advertises the legacy, non-compliant full-genesis-hash form, on both testnet and mainnet. This
server hardcodes the values the facilitator **actually expects**, verified live via
`curl https://facilitator.goplausible.xyz/supported`, not guessed and not the package constant.

**If GoPlausible syncs their fork** to the upstream fix, both constants must be reverted back to
importing from `@x402/avm` — see the comments at each constant in `src/config.ts` for the full
reasoning. A tracking report was filed upstream against `x402-foundation/x402` (GoPlausible's own
fork has issue creation restricted, so that wasn't an option).

To run this server against mainnet yourself: set `NETWORK=mainnet` and `AVM_ADDRESS` to a
**fixed** payTo address opted in to mainnet USDC (ASA `31566704`, already set in `src/config.ts`).
The `tag` field in `routes.config.ts`'s `extra` attributes activity to the Algorand Global x402
Challenge.

## Notes
- Tracks x402 protocol `2.26.0` (`package.json` pins `^2.26.0` for `@x402/core`, `@x402/avm`, and
  `@x402/hono`; the Algorand discovery/Bazaar package `@x402-avm/extensions` versions separately,
  currently `^2.6.1` — run `pnpm ls` for exact resolved versions).
- Run `pnpm typecheck` after `pnpm install` to catch any API drift if you bump dependency versions.
