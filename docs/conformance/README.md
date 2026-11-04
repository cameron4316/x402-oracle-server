# x402 conformance records

Independent checks that Hosannaith's own paid routes answer like well-formed x402 v2 resources.

## CDP facilitator validator

[`POST https://api.cdp.coinbase.com/platform/v2/x402/validate`](https://docs.cdp.coinbase.com/api-reference/v2/rest-api/x402-facilitator/validate-x402-endpoint)
is a public, unauthenticated, read-only probe run by Coinbase's CDP facilitator. It sends an
unpaid request to the resource (no payment, no indexing) and runs about 25 preflight checks on the
402 response: transport, x402 v2 shape, the `accepts` entry, and Bazaar discovery metadata. The
overall `valid` also requires that *the CDP facilitator* would index the resource.

### Results (both paid routes, identical outcome; first run 2026-11-02, re-run 2026-11-03)

21 of 25 checks pass, including: endpoint reachable, HTTP 402, x402 version 2, payment
requirements delivered in the `PAYMENT-REQUIRED` header, `exact` scheme, amount, timeout, and the
full Bazaar extension (info, input, method matches the probed method, output example, schema).

The 4 that fail, and why:

| Check | Result | Cause |
|---|---|---|
| `accepts[0].network` | not supported | CDP does not settle Algorand. Expected. |
| `accepts[0].asset` | "31566704 is not USDC" | CDP recognises its own chains' USDC contracts, not Algorand ASA 31566704 (which is Circle's USDC on Algorand). Expected, same cause. |
| `accepts[0].payTo` | invalid address | CDP validates its own chains' address formats, not Algorand's. Expected, same cause. |
| `parse` | network "must be in CAIP-2 format" | **Real, and known.** We advertise the network as `algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=` because that is the legacy form the GoPlausible facilitator still requires in order to settle. It is not valid CAIP-2 (a CAIP-2 reference is at most 32 characters from `[-_a-zA-Z0-9]`). The spec-correct form is the truncated one that `@x402/avm` exports. See the README section "Mainnet is live — the CAIP-2 override". This result is independent confirmation that the legacy form breaks standard x402 parsers. It is resolved by reverting the override once GoPlausible's facilitator accepts the spec-correct form. |

Overall `valid: false`, `simulation.outcome: rejected` ("invalid discovery configuration").

**`has_bazaar_extension` and the other Bazaar checks are recorded but are not part of how
Hosannaith scores other endpoints.** The extension is optional discovery metadata; many correctly
gated, payable endpoints omit it. Hosannaith's definition of a valid 402 is about gating and
payability, not catalog listing.

### Fixed after the first run

The 2026-11-02 responses also showed two discovery problems, fixed in PR #11 and confirmed by the
2026-11-03 run (same 21/25, same four expected failures):

| Issue (2026-11-02) | Now (2026-11-03) |
|---|---|
| `resource.url` was `http://api.hosannaith.com/...` (TLS terminates at the reverse proxy, so the app saw plain HTTP) | `https://api.hosannaith.com/reliability` and `/reliability/batch`, set per route |
| `GET /reliability` declared no query parameters, so Bazaar discovery did not learn about the required `target` | `queryParams` declares `target` |
| `POST /reliability/batch` was declared as a query route | declared as a JSON-body route with a `targets` array |

## How to run

GitHub → **Actions** → **x402 conformance (CDP validator)** → **Run workflow**. It checks
`GET /reliability` and `POST /reliability/batch`, prints each result to the log, and keeps the
JSON as a downloadable artifact. Re-run it after any change to the 402 response.

## Records

Results are committed here as `cdp-validate-<route>-<YYYY-MM-DD>.json` (one file per route per run).
