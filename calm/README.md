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

## Controls: FINOS AI Governance Framework

Five nodes carry CALM `controls` that link to mitigations in the
[FINOS AI Governance Framework](https://github.com/finos/ai-governance-framework). The reasoning,
the evidence and the mitigations that do not apply are in
[`docs/aigf-mapping.md`](../docs/aigf-mapping.md).

| Control key | Mitigation | Nodes |
|---|---|---|
| `mcp-security` | MI-20 MCP Server Security Governance | `remote-mcp`, `mcp-package` |
| `tool-chain-validation` | MI-19 Tool Chain Validation and Sanitization | `remote-mcp`, `oracle-api` |
| `credential-protection` | MI-23 Agentic System Credential Protection Framework | `mcp-package`, `client-sdk` |
| `decision-audit` | MI-21 Agent Decision Audit and Explainability | `oracle-api`, `report-signer`, `client-sdk` |
| `ai-observability` | MI-04 AI System Observability | `monitor` |

How each control is written:

- The key is the one FINOS CALM tooling uses for that mitigation.
- The shape follows FINOS's own CALM examples (the FluxNova architectures in
  `finos/architecture-as-code`): `requirement-url` is CALM's base control-requirement schema, and
  the CALM CLI validates the `config` against it.
- `config` has `control-id`, `name` and `description` as that schema requires, then:
  `reference-url` (the mitigation's source file in the framework repository, at a pinned commit),
  `aigf-id`, `aigf-commit`, `role` (the provider being vetted, or an input to the firm's own
  control), an honest `status`, and `mapping` (the matching section of the mapping page).

[`aigf-sources.json`](aigf-sources.json) lists every framework id we use with the file it comes
from. `node scripts/check-aigf-ids.mjs` fails if an id appears anywhere without an entry there, or if
a link or control points at a different file. It runs with the tests. With `--fetch` it also checks
the entries against the framework repository itself, which CI does.
