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
    "p99LatencyMs": 210,
    "confidence": "history",
    "availability_pct": 100,
    "error_rate_pct": 0,
    "protocol_conformance_pct": 100,
    "score_normalized": 0.987
  }
}
```

### Reading the result

| Field | Meaning |
|---|---|
| `status` | `pass` (score ≥ 90) · `degraded` (60–89) · `fail` (< 60) · `unknown` (not enough data) |
| `score` | 0–100 composite: 0.6 × uptime + 0.4 × correct-402 − a latency penalty (up to 20). `null` below 5 observations. |
| `uptimePct` | Probes where the endpoint was serving: reachable and not a 5xx. |
| `correct402Pct` | Of the probes where the endpoint made a payment decision (a `402`, or serving an unpaid `2xx`), the share that correctly answered `402`. Other `4xx` (e.g. a `400` because our probe sends no input) are indeterminate and excluded. `null` if no probe was determinate. |
| `p50/p95/p99LatencyMs` | Latency percentiles of serving probes. `p99LatencyMs` is `null` below 20 samples (it would just be the slowest one); below 20 samples `p95LatencyMs` equals the slowest sample. |
| `confidence` | `history` (accumulated monitoring) · `one-shot` (first sighting, one live probe, `score: null`) · `pending` (batch only: no history yet, now enrolled). |

### OpenEAGO SLO view

The same numbers in the SLO vocabulary used by agent registries and SLA/SLO feasibility checks.
These are pure aliases (no new measurement) and are `null` exactly when their source is `null`.

| SLO term | Field | Definition |
|---|---|---|
| availability | `availability_pct` | = `uptimePct` |
| error rate | `error_rate_pct` | = 100 − `uptimePct`: % of probes that were 5xx or unreachable (server-side errors). Client-side 4xx are indeterminate for an unpaid probe and are not counted. |
| protocol conformance | `protocol_conformance_pct` | = `correct402Pct`: % of gating-determinate probes that returned 402 rather than serving unpaid 2xx. |
| latency | `p50LatencyMs`, `p95LatencyMs`, `p99LatencyMs` | as above |
| registry score | `score_normalized` + `confidence` | `score` / 100, in [0, 1] |

### Machine-readable contract

- [`/openapi.json`](https://api.hosannaith.com/openapi.json): OpenAPI 3.1 description of every route, with each paid route's x402 terms in `x-x402`.
- JSON Schemas (draft 2020-12): [`/schema/check-result.json`](https://api.hosannaith.com/schema/check-result.json), [`/schema/batch-result.json`](https://api.hosannaith.com/schema/batch-result.json), [`/schema/problem.json`](https://api.hosannaith.com/schema/problem.json).
- Errors are [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) Problem Details (`application/problem+json`). The `402 Payment Required` response is the x402 protocol's own.
- Timestamps are RFC 3339 in UTC. Responses are additive-only: new optional fields may appear; existing fields never change name, type or meaning.
- **Signed results:** when signing is enabled, every result (and every batch, as a whole) carries an ES256 signature over its RFC 8785 canonical JSON, verifiable against [`/.well-known/hosannaith-keys.json`](https://api.hosannaith.com/.well-known/hosannaith-keys.json). Format, verification and key policy: [`docs/attestation.md`](docs/attestation.md).

## Use it in your own code

A small TypeScript SDK wraps the full x402 pay-per-call handshake (402 → sign USDC payment →
retry) so you don't have to implement it yourself:

```ts
import { getReliability } from 'hosannaith-client';

const result = await getReliability('https://some-x402-endpoint/api', {
  mnemonic: process.env.AVM_MNEMONIC!, // 25-word Algorand mnemonic, funded with USDC
});

console.log(result.score, result.detail.confidence);
```

See [`sdk/typescript/`](sdk/typescript/) for the client, a runnable example, and full usage docs.

## Use it from any MCP agent (Model Context Protocol)

This repo also ships an **MCP server** in [`mcp/`](mcp/) — published to npm as
[`hosannaith-mcp`](https://www.npmjs.com/package/hosannaith-mcp) and listed in the official
[MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.cameron4316/hosannaith-mcp`.
It lets any Model Context Protocol client (Claude Desktop, Cursor, and other MCP agents) vet an
x402 endpoint's reliability before paying it.

Built on the official MCP TypeScript SDK (`@modelcontextprotocol/sdk`), it exposes three **MCP
tools**:

- `get_hosannaith_info` — free; explains the score shape and how to act on it.
- `check_x402_reliability` — paid; reliability score for one endpoint, settled as an x402 USDC
  micropayment on Algorand.
- `check_x402_reliability_batch` — paid; score up to 50 endpoints in a single call.

Add it to an MCP client's config:

```json
{
  "mcpServers": {
    "hosannaith": {
      "command": "npx",
      "args": ["-y", "hosannaith-mcp"],
      "env": { "AVM_MNEMONIC": "<25-word Algorand mnemonic, funded with USDC>" }
    }
  }
}
```

See [`mcp/`](mcp/) for the MCP server, its tools, and full setup docs.

There is also a **hosted remote MCP server** at `https://api.hosannaith.com/mcp` (Streamable HTTP,
paid per call via x402 MCP). Its tools carry MCP annotations (paid tools: read-only, not destructive,
not idempotent, open-world; the one side effect is that a target with no history gets one live probe
and is enrolled for monitoring). Every call is recorded in an audit log with its on-chain settlement,
or the quote offered when no payment was made; payment payloads and URL query strings are never
logged.

Targets must be public http(s) URLs. Private, loopback, link-local and reserved addresses, internal
host names and URLs with credentials are refused before any payment, on the HTTP API and both MCP
servers.

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

## License

Licensed under the [Apache License, Version 2.0](LICENSE). See [NOTICE](NOTICE).

This repository was previously MIT-licensed. Code and npm releases published under MIT before the
change (`hosannaith-client` 0.3.0 and earlier, `hosannaith-mcp` 0.2.1 and earlier) remain
available under the MIT License.
