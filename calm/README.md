# Hosannaith architecture as code (FINOS CALM)

[`hosannaith.architecture.json`](hosannaith.architecture.json) describes Hosannaith in
[CALM](https://calm.finos.org), the FINOS Common Architecture Language Model, against the CALM 1.2
release schema. CI validates it with the official CLI on every pull request (job "CALM architecture
(validate)"), so it cannot drift out of the schema.

## What it models

- **Actors:** a paying agent or application, and an auditor or relying party who verifies results
  second-hand.
- **The oracle** (`hosannaith`, composed of): the x402 HTTP API, the remote MCP server, the monitor
  (its own process), the observation log, the target registry, the MCP audit log, the attestation
  signing key and the published key set (JWKS).
- **Distributed clients:** `hosannaith-client` and `hosannaith-mcp` on npm.
- **External systems:** the x402 facilitator (GoPlausible), Algorand mainnet, and the monitored x402
  endpoints.
- **Flows:** a paid reliability check (402, payment, verify, score, sign, settle, client-side
  signature verification), continuous monitoring, and independent verification by a relying party.

It is a logical architecture. Hosting and deployment details are intentionally left out.

## Validate locally

```
npx @finos/calm-cli@1.69.0 validate -a calm/hosannaith.architecture.json -f pretty
```

The command exits non-zero only on errors; warnings are hints. To browse it visually, open the file in
the CALM VS Code extension or render it with `calm docify`.

## Next

CALM `controls` for the properties that matter to a relying party (signed results, refusal of private
targets before payment, the receive-only payTo, the audit log), each linked to the matching risk or
mitigation in the [FINOS AI Governance Framework](https://github.com/finos/ai-governance-framework).
