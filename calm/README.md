# Hosannaith architecture as code (FINOS CALM)

[`hosannaith.architecture.json`](hosannaith.architecture.json) describes Hosannaith in
[CALM](https://calm.finos.org), the FINOS Common Architecture Language Model, against the CALM 1.2
release schema. CI validates it with the official CLI on every pull request (job "CALM architecture
(validate)"), so it cannot drift out of the schema.

## What it models

- **Actors:** a paying agent or application, and an auditor or relying party who verifies results
  second-hand.
- **The oracle** (`hosannaith`, composed of): the x402 HTTP API, the remote MCP server, the monitor
  (its own process), the report signer, the observation log, the target registry, the MCP audit log,
  the attestation signing key, the published key set (JWKS) and the signed public reports.
- **Distributed clients:** `hosannaith-client` and `hosannaith-mcp` on npm.
- **External systems:** the x402 facilitator (GoPlausible), Algorand mainnet, and the monitored x402
  endpoints.
- **Flows:** a paid reliability check over HTTP (402, payment, verify, score, sign, settle, client-side
  signature verification), the same check over MCP (ending with the audit log record), continuous
  monitoring, and independent verification by a relying party.

Results are signed after payment verification and before settlement. A target with no history gets
one unpaid live probe through the same guarded probe as the monitor, its observation is appended to
the log, and the target is enrolled for monitoring.

It is a logical architecture. Hosting and deployment details are intentionally left out.

## Validate locally

```
npx @finos/calm-cli@1.69.0 validate -a calm/hosannaith.architecture.json -f pretty
```

CI runs it with `--strict`, so warnings fail the build as well as errors. To browse it visually, open the file in
the CALM VS Code extension or render it with `calm docify`.

## Next

CALM `controls` for the properties that matter to a relying party (signed results, refusal of private
targets before payment, the receive-only payTo, the audit log), each linked to the matching risk or
mitigation in the [FINOS AI Governance Framework](https://github.com/finos/ai-governance-framework).
