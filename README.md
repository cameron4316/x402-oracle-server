# x402 reliability oracle (Algorand)

A paid x402 endpoint that scores the **reliability** of other x402 endpoints — uptime, correct
`402` behaviour, and latency — from continuous independent monitoring. Built on the official
Algorand x402 tutorial (Hono + `@x402/*` + GoPlausible facilitator).

The architecture is deliberately **pluggable**: every paid product is a `Check` (see
`src/checks/types.ts`). Reliability ships now; a **compliance/attestation** product later is a new
`Check` + one route entry — no rewrite of the payment plumbing.

## What's the "can't-backfill" part?
The **monitor** (`pnpm monitor`) records one observation per target per interval, append-only, to
`data/observations.jsonl`. That history compounds and cannot be reconstructed later — so start the
monitor as early as possible and keep it running.

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

## Before you go live on MAINNET (build step 6)
1. In `src/config.ts`, import the mainnet network id from `@x402/avm`
   (e.g. `ALGORAND_MAINNET_CAIP2`) and assign it to `MAINNET_CAIP2`. (Mainnet USDC ASA `31566704`
   is already set.) We didn't hardcode the mainnet id to avoid shipping a wrong genesis hash.
2. Set `NETWORK=mainnet` and `AVM_ADDRESS` to your **fixed** competition payTo (opted in to USDC).
3. Confirm the `tag` placement in `routes.config.ts` against the competition blog
   ("add a field named 'tag' to your extra field").
4. Deploy publicly over HTTPS (your Cloudflare domain) — Bazaar discovery needs a real host, not localhost.
5. Settle one real mainnet payment end-to-end and confirm it appears on the leaderboard + Bazaar.

## Notes / to confirm
- Package **versions**: `pnpm add` resolves current releases (repo tracks x402 protocol `2.11.0`).
  After a successful install, consider pinning with what `pnpm ls` reports.
- This scaffold was written against the official tutorial's imports; run `pnpm typecheck` after
  install to catch any API drift in your installed versions.
