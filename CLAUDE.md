# CLAUDE.md — project context for Claude Code

## What this is
An **x402 reliability oracle** on Algorand: a paid x402 endpoint that scores *other* x402
endpoints on reliability (uptime, correct `402` behaviour, latency) from continuous independent
monitoring. Built for the **Algorand Foundation Global x402 Challenge**, which requires live,
pay-per-request x402 endpoints on **Algorand Mainnet** settling through the **GoPlausible**
facilitator.

Strategic intent: infrastructure genuinely useful to the **Algorand Foundation and large /
institutional players** — deliberately NOT retail-facing tooling (no generic price feeds, etc.).

## Architecture (keep it this way)
- **Pluggable `Check` contract** in `src/checks/types.ts`. Every paid product implements it.
  Reliability ships now; a **compliance / attestation** product (for tokenization — the higher
  long-term ceiling) is planned as a SECOND route later. Adding it must stay a small change:
  a new `Check` + one entry in `src/routes.config.ts` + one line in `src/checks/registry.ts`.
  Do not entangle product logic into the payment plumbing.
- **Monitor runs as its own process** (`pnpm monitor`, `src/monitor.ts`), separate from the API.
  It appends observations to `data/observations.jsonl`. This history compounds and CANNOT be
  backfilled — it must keep running. Don't fold it back into the API server.
- **Store is swappable** behind `ObservationStore` (`src/checks/reliability/store.ts`). JSONL now;
  SQLite/Postgres later behind the same interface.

## x402 wiring (from the official tutorial — don't drift)
Source of truth: https://dev.algorand.co/resources/x402-on-algorand/ and repo
`algorandfoundation/x402-demo`. Server uses: Hono + `@hono/node-server`,
`paymentMiddleware` & `x402ResourceServer` from `@x402/hono`, `HTTPFacilitatorClient` from
`@x402/core/server`, `ExactAvmScheme` from `@x402/avm/exact/server`, and
`declareDiscoveryExtension` + `bazaarResourceServerExtension` from `@x402-avm/extensions`.
If installed package exports differ from these imports, fix against what the packages actually
export — the tutorial is the intended shape.

## Key constants
- Competition tag: `x402-global-challenge` (in each route's `extra`)
- USDC ASA — mainnet `31566704`, testnet `10458941`
- Facilitator: `https://facilitator.goplausible.xyz`
- Foundation example endpoint (a monitor target): `https://x402.goplausible.xyz/examples/weather`

## Guardrails
- **Testnet only for now** (`NETWORK=testnet`). Testnet does not count toward the leaderboard.
- `ALGORAND_MAINNET_CAIP2` is intentionally UNWIRED in `src/config.ts`; it throws if mainnet is
  selected. Do NOT hardcode a guessed genesis hash — import the real mainnet id from `@x402/avm`
  when wiring mainnet (build step 6). A wrong network id would silently break a reliability product.
- Never commit `.env`, mnemonics, or private keys.
- payTo address must stay FIXED for the whole competition once chosen on mainnet.

## First task
Get it installed and typechecking:
```
pnpm install
pnpm add @x402/core @x402/avm @x402/hono @x402-avm/extensions hono @hono/node-server dotenv
pnpm typecheck
```
Then: `pnpm monitor` (terminal 1) + `pnpm dev` (terminal 2). Verify `GET /health` returns ok and
an unpaid `GET /reliability?target=...` returns HTTP 402.

## Build workflow (7 steps; step 1 = scaffold, done)
2 build/verify check logic · 3 switch-ready config · 4 test full pay→settle→response on testnet
· 5 deploy public HTTPS (Cloudflare domain) · 6 flip to mainnet + wire mainnet CAIP-2 + confirm tag
· 7 drive real usage. Strategy/decisions live in the Claude.ai project thread, not here.
