# x402 conformance records

Independent checks that Hosannaith's own paid routes answer like well-formed x402 v2 resources.

## CDP facilitator validator

[`POST https://api.cdp.coinbase.com/platform/v2/x402/validate`](https://docs.cdp.coinbase.com/api-reference/v2/rest-api/x402-facilitator/validate-x402-endpoint)
is a public, unauthenticated, read-only probe run by Coinbase's CDP facilitator. It sends an
unpaid request to the resource (no payment, no indexing) and reports four preflight checks:

| Check | What it tests |
|---|---|
| `reachable` | The endpoint responded within the timeout. |
| `returns_402` | The unpaid request was answered with HTTP 402. |
| `parse` | The 402 payment requirements parse. |
| `has_bazaar_extension` | The payment requirements carry the Bazaar discovery extension. |

**Expected result for Hosannaith:** all four preflight checks pass, and the overall `valid` is
`false`. `valid` additionally requires that *the CDP facilitator* would index the resource
(`simulation.outcome = accepted`). CDP does not settle Algorand, so it cannot accept a resource
whose only payment option is Algorand USDC. That is a statement about CDP's catalog, not about
x402 conformance.

**`has_bazaar_extension` is recorded here but is not part of how Hosannaith scores other
endpoints.** The extension is optional discovery metadata; many correctly gated, payable
endpoints omit it. Hosannaith's definition of a valid 402 is about gating and payability, not
catalog listing.

## How to run

GitHub → **Actions** → **x402 conformance (CDP validator)** → **Run workflow**. It checks
`GET /reliability` and `POST /reliability/batch`, prints each result to the log, and keeps the
JSON as a downloadable artifact. Re-run it after any change to the 402 response.

## Records

Results are committed here as `cdp-validate-<route>-<YYYY-MM-DD>.json` (one file per route per run).
