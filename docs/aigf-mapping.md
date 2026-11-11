# Hosannaith and the FINOS AI Governance Framework

How Hosannaith relates to the risks and mitigations in the
[FINOS AI Governance Framework](https://github.com/finos/ai-governance-framework) (AIGF): what
applies, the evidence for each claim, what is not done, and what does not apply.

This is a self-assessment by the maintainer. It is not a certification, and FINOS has not reviewed it.

## How to read this

- **Hosannaith is not an AI system.** It runs no model. It measures x402 endpoints (availability,
  payment gating, latency) and returns signed scores. The framework is written for firms that build
  and run AI systems, so most of it is addressed to Hosannaith's users, not to Hosannaith.
- **Hosannaith meets the framework in two roles:**
  1. *A third-party MCP server and API that a firm brings into an agentic system.* The firm vets it.
     [Part 1](#part-1-hosannaith-as-a-server-you-vet) is the evidence for that review.
  2. *An input to the firm's own controls.* Signed measurements the firm can record and act on.
     [Part 2](#part-2-hosannaith-as-an-input-to-your-controls) says which controls, and how far it goes.
- **Status words.** *Yes*: Hosannaith does this and you can check it. *Partly*: some of it.
  *No*: not done today. *Yours*: the control belongs to the firm using Hosannaith.
- **Source.** Every id comes from the framework repository at commit
  [`67b8c32`](https://github.com/finos/ai-governance-framework/tree/67b8c3257695d5ede09d262798bf28a0e58d4740) (its v3 release, 2 November 2026). Ids are written the way the
  framework writes them, `RI-NN` for risks and `MI-NN` for mitigations
  ([CONVENTIONS.md](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/CONVENTIONS.md)). Each id links to the file it comes from,
  and [Sources](#sources) lists them all. Nothing here is taken from the `finos-mcp-aigf` PyPI package.

## Summary

| Mitigation | Hosannaith's role | Status | CALM control |
|---|---|---|---|
| [MI-20] MCP Server Security Governance | The MCP server a firm vets | Partly | `mcp-security` |
| [MI-19] Tool Chain Validation and Sanitization | Validates tool inputs, constrains tool output | Partly: server side yes, agent side yours | `tool-chain-validation` |
| [MI-23] Agentic System Credential Protection Framework | The only secret involved is your own payment key | Partly | `credential-protection` |
| [MI-21] Agent Decision Audit and Explainability | Supplies signed, checkable records | Yours, supported | `decision-audit` |
| [MI-04] AI System Observability | Supplies measurements of outside endpoints | Yours, supported in part | `ai-observability` |

The other 20 mitigations do not apply. Each has a one-line reason under
[Considered and rejected](#considered-and-rejected).

**What a score does not tell you.** A Hosannaith score says an endpoint is up, answers in good time
and asks for payment correctly. It does not say the endpoint is the right counterparty, that what it
returns is correct, or that an agent is allowed to pay it. Those need other controls.

## Part 1: Hosannaith as a server you vet

### MI-20 MCP Server Security Governance

Source: [MI-20]. Per its source file it mitigates [RI-26], [RI-08] and [RI-01]. Only [RI-26] is
relevant here: Hosannaith is exactly the kind of outside MCP server that risk describes. The
mitigation is written for the firm, which decides its tier and runs the proxy, allowlist and
monitoring. This table is what Hosannaith gives that review.

| What the source asks for | Hosannaith | Status | Where to check |
|---|---|---|---|
| Tier 1: source code review for open source servers | All server, client and MCP package code is public under Apache-2.0. | Yes | this repository |
| Tier 1: scanning of transitive dependencies and license checks | CI fails on any production dependency outside a permissive allow-list. Each npm release is built with a CycloneDX SBOM, made from the package manager's own resolution and kept with the release build. | Yes | `.github/workflows/ci.yml`, `scripts/check-licenses.mjs`, `scripts/sbom.mjs` |
| Tier 1: CVE checks and vulnerability scanning | Dependency alerts and security updates, code scanning on every pull request and weekly, and secret scanning are enabled on the repository. | Yes | repository settings (not files) |
| Tier 1: TLS for all MCP communications | The MCP server and API are served over HTTPS. Protocol version and cipher choices are not stated here. | Partly | `https://api.hosannaith.com/mcp` |
| Tier 1: human approval before an agent acts on a server's tools | Yours. Two things help: the paid tools are annotated read-only and non-destructive, and every paid call needs a payment your client must sign, which is a natural approval point. | Yours | `src/mcp-tools.ts` |
| Section 1: security certifications, penetration testing | None. Hosannaith is maintained by one person and holds no SOC 2 or ISO 27001 certification. No third-party penetration test has been done. | No | |
| Section 1: SLA for security, data handling and availability | No terms of service or SLA are published yet. | No | |
| Section 2: mutual authentication | Not offered. | No | |
| Section 2: API keys, OAuth, access tokens | None exist, by design. There are no accounts. Access to the paid tools is by x402 payment, so there is no Hosannaith credential for you to store, rotate or leak. | Yes (by design) | `/llms.txt`, `/.well-known/x402` |
| Section 2: communication audit logs | The MCP server writes one line per tool call: time, tool, target without its query string, whether it was paid, the settlement receipt or the quote offered, and duration. It never logs payment payloads or result bodies. The log is size-bounded and is a plain file, not tamper-evident. | Partly | `src/mcp-audit.ts` |
| Section 3: cryptographic signatures on data from the server | Every result is signed (ES256 over RFC 8785 canonical JSON), and every batch as a whole. Public keys, retired keys and revoked keys are published and also committed to the repository. | Yes | [docs/attestation.md](attestation.md), `/.well-known/hosannaith-keys.json`, `attest/jwks-history.json` |
| Section 3: schema validation of data from the server | JSON Schemas for every response shape and an OpenAPI 3.1 description are published. | Yes | `/schema/check-result.json`, `/schema/batch-result.json`, `/openapi.json` |
| Section 3: data versioning | The signed body carries `spec_version` (semantic versioning). | Yes | [docs/attestation.md](attestation.md) |
| Section 3: timestamp validation and staleness detection | The signed body carries when it was generated and the first and last observation times, plus `observations`, `windowHours` and `confidence` (`history`, `one-shot` or `pending`). No score is given below five observations. | Yes | `src/checks/reliability/score.ts` |
| Section 3: cross-reference validation against other sources | Yours. Hosannaith cannot vouch for itself. | Yours | |
| Section 4: monitoring the server's availability and behaviour | Yours. Free health checks exist for the API and the MCP server. | Yours | `/health`, `/mcp/health` |
| Section 5: isolation and segmentation | Yours. One relevant fact: the remote MCP server keeps no session state between calls. | Yours | `src/mcp-remote.ts` |
| Section 6: incident response | A security policy with a contact address and response targets, a `security.txt`, and a written procedure for a compromised signing key (rotate, list the old key as revoked; clients then refuse it). | Partly | [SECURITY.md](../SECURITY.md), `/.well-known/security.txt`, [docs/attestation.md](attestation.md) |
| [RI-26] "update poisoning" | npm packages are built by GitHub Actions from a tag on the protected main branch, published with npm trusted publishing (no long-lived token), staged, and released only after approval with 2FA. Each release has a provenance record. Third-party actions in the release workflow are pinned to commits. | Yes | `.github/workflows/publish.yml`, [docs/releasing.md](releasing.md) |

What you send to Hosannaith: the URLs you ask about, an optional window, and an x402 payment. No
prompts, no customer data. What it stores: its own observations of public endpoints, and the call
log described above (payer address, target without its query string, receipt). The application does not encrypt these
at rest.

Limits worth knowing:

- A signature proves a result came from the holder of Hosannaith's key and was not changed on the
  way. It does not prove the measurement is right.
- The signing key is a file on the serving host, not in an HSM. If that host were compromised, an
  attacker could sign false results until the key is revoked.
- Clients fetch the public keys from the same origin as the results, over TLS. For an independent
  check, compare them with `attest/jwks-history.json` in this repository.
- `hosannaith-client` verifies every signature by default. The local `hosannaith-mcp` package does
  not verify signatures itself yet; it relies on TLS to the API.
- There is no per-caller rate limit in the application.

### MI-19 Tool Chain Validation and Sanitization

Source: [MI-19]. Per its source file it mitigates [RI-25], [RI-10] and [RI-24]. Most of it is about
how a firm's agent chooses and sequences tools, which is the firm's. Two parts fall on a tool
provider: validating the parameters it is called with, and making sure its output cannot carry an
attack into the next step. The source file also lists [ATR-2026-00013] (Tool-Driven Server-Side
Request Forgery) and [ATR-2026-00011] (Instruction Injection via Tool Output).

| What the source asks for | Hosannaith | Status | Where to check |
|---|---|---|---|
| Section 2: parameter schema, format and range validation | A target must be a public `http` or `https` URL of at most 2048 characters with no credentials. The window must be 24, 168 or 720 hours. A batch takes 1 to 50 targets. Anything else is refused before any payment is asked for. | Yes | `src/mcp-tools.ts`, `src/checks/reliability/target-url.ts`, `src/checks/reliability/window.ts`, `src/index.ts` |
| Section 2: injection prevention, here server-side request forgery ([ATR-2026-00013]) | Hosannaith fetches the URLs it is given, so it refuses loopback, private, link-local (including cloud metadata), carrier-grade NAT, multicast and reserved addresses and internal host names. It checks again at probe time: DNS is resolved for every hop and redirects are followed by hand, so a public name cannot lead to a private address. | Yes | `src/checks/reliability/target-url.ts`, `src/checks/reliability/monitor.ts` |
| Section 3: outputs from one tool sanitized before they feed the next ([ATR-2026-00011]) | A result is structured JSON that matches a published schema: numbers, closed lists of status words, timestamps, and the caller's own target. One field holds text chosen by a monitored endpoint, the payment network names in its 402. That text is repeated only when it is shaped like a network id (no spaces, at most 53 characters). Anything else is left out. | Yes | `src/checks/reliability/x402-network.ts` (`isRelayableNetworkId`), `src/contract/schema.ts` |
| Section 1: decision logging for tool selection | Yours. If you use the payment guard in `hosannaith-client`, it calls you back with every allow or block decision and its basis. | Yours | `sdk/typescript/index.ts` (`onDecision`) |
| Section 4: alerts on validation failures | Refused inputs are answered with an error and are not charged, but Hosannaith raises no alert on repeated failures. | No | |
| Sections 1, 3, 5, 6: tool selection, safe sequences, approval steps, rule management | Yours. | Yours | |

### MI-23 Agentic System Credential Protection Framework

Source: [MI-23]. Per its source file it mitigates [RI-29], [RI-24] and [RI-26]. It is about keeping
credentials away from agents. The question for a vendor is which credentials its product makes you
hold near an agent.

| What the source asks for | Hosannaith | Status | Where to check |
|---|---|---|---|
| Key principle: credential access minimization | Hosannaith issues no credentials: no API keys, accounts or tokens. The only secret involved is your own payment key, used to sign each x402 payment. It is never sent to Hosannaith. | Yes | `src/index.ts`, `sdk/typescript/index.ts` |
| Section 2: credentials delivered through a broker, not held by the agent | `hosannaith-client` accepts your own paying `fetch` in place of a mnemonic, so signing can stay in your wallet service or broker. The remote MCP server takes payment through the x402 MCP convention, so there too the key stays with your own MCP client. | Yes | `sdk/typescript/index.ts` (`payingFetch`) |
| Section 1: no credentials in environment variables or agent-readable files | Not met by the local `hosannaith-mcp` package. It reads a 25-word payment mnemonic from an environment variable of the MCP server process. An agent that can read that process's environment or its configuration file can read the key. | No | `mcp/src/index.ts` |
| (Our guidance for that key) | Use a dedicated account that holds only a small balance, as the package's own tool description says. Prefer the remote MCP server or `payingFetch` where the key must not sit next to an agent. | Guidance | `mcp/README.md` |

Hosannaith's own signing key is not an agent credential, but for completeness: it is kept in a file
outside the repository (the key itself is never in an environment variable), the server refuses to
start with a key that is not published, and rotation and revocation are documented in
[docs/attestation.md](attestation.md).

## Part 2: Hosannaith as an input to your controls

### MI-21 Agent Decision Audit and Explainability

Source: [MI-21]. Per its source file it mitigates [RI-24], [RI-25] and [RI-22]. This is the firm's
control: recording why its agents did what they did. Hosannaith helps with the record-keeping side
([RI-22]). It does nothing to stop an authorization bypass ([RI-24]).

| What the source asks for | What Hosannaith supplies | Where to check |
|---|---|---|
| Section 1: record the input data behind a decision, with sources, timestamps and data quality indicators | A result is a self-contained signed record: the target, the score and what it is made of, the window, the number of observations, the confidence level, timestamps and the signing key id. Store it next to the decision it informed. | [docs/attestation.md](attestation.md), `/schema/check-result.json` |
| Section 1: record decision outcomes | The payment guard reports each decision: the URL, allowed or blocked, the score, the confidence, the reason, whether the score came from cache, and how its signature checked out. | `sdk/typescript/index.ts` (`GuardDecision`) |
| Section 3: independent verifiability, records an auditor can check without access to the provider's systems | Anyone holding a stored result can verify it against the published keys, offline, with standard tooling (RFC 8785 canonical JSON and an ES256 signature) or the reference script. Retired keys stay published so old results stay checkable. | `scripts/verify-signature.ts`, `/.well-known/hosannaith-keys.json` |
| Section 5: evidence export | Signed, dated public reports are published as JSON and committed to this repository. | `/reports/<id>.json`, `public-reports/` |

Not covered: the agent's reasoning, context and tool choices, which only the firm's system can
record. Hosannaith's own logs (observations and the MCP call log) are plain append-only files. They
are not hash-chained or anchored to an external log, so the history behind a score is asserted by
the operator, not independently auditable. Revoking a key also invalidates the genuine results it
signed earlier.

### MI-04 AI System Observability

Source: [MI-04]. Per its source file it mitigates thirteen risks, [RI-26] among them. This is the
firm's control: seeing what its AI system and its dependencies are doing. Hosannaith covers one
slice of it, the paid outside endpoints an agent calls.

| What the source asks for | What Hosannaith supplies | Where to check |
|---|---|---|
| Section 2: status codes and latencies for interactions that cross a trust boundary to third parties | Independent measurements of x402 endpoints, taken every few minutes from outside your network: availability, error rate, latency at p50, p95 and p99, and whether the endpoint asks for payment correctly and on which networks. | `/llms.txt`, [README](../README.md) |
| Section 4: baselines to compare against | Rolling windows of 24 hours, 7 days and 30 days per endpoint. | `src/checks/reliability/window.ts` |
| Data to monitor SLA compliance for outside services (listed under benefits) | The same measurements, signed, so they can be kept as evidence. | [docs/attestation.md](attestation.md) |

Not covered: anything inside the firm's system (model behaviour, prompts, user activity, resource
use). Hosannaith sends no alerts or webhooks today; you ask, it answers. It does not emit
OpenTelemetry data (section 7). Payment-gating checks apply to HTTP x402 endpoints, not to payment
made inside MCP tool calls.

## Risks

Relevant, with the mitigation that carries them above:

| Risk | Why it is relevant | See |
|---|---|---|
| [RI-26] MCP Server Supply Chain Compromise | Hosannaith is an outside MCP server. | MI-20 |
| [RI-25] Tool Chain Manipulation and Injection | Its output feeds an agent's next step. | MI-19 |
| [RI-10] Prompt Injection | A monitored endpoint could try to pass text to an agent through a result. | MI-19 |
| [RI-29] Agent-Mediated Credential Discovery and Harvesting | The local MCP package holds a payment key. | MI-23 |
| [RI-22] Regulatory Compliance and Oversight | Signed results support record-keeping. | MI-21 |
| [RI-24] Agent Action Authorization Bypass | Named by the sources of MI-19, MI-21 and MI-23. Hosannaith does not prevent it: a score says nothing about whether an agent may make a payment. | MI-21 |

Not relevant:

- [RI-01], [RI-02], [RI-04], [RI-05], [RI-06], [RI-08], [RI-09], [RI-14], [RI-16], [RI-17], [RI-18], [RI-19], [RI-20], [RI-23]: risks of models, their data and their outputs. Hosannaith runs no model and holds no such data.
- [RI-07] Availability of Foundational Model: about model hosting. Hosannaith measures the availability of x402 endpoints, which is a different dependency. It would matter only if a firm bought inference through an x402 endpoint.
- [RI-27] Agent State Persistence Poisoning: Hosannaith holds no agent state.
- [RI-28] Multi-Agent Trust Boundary Violations: Hosannaith is not an agent.
- [RI-30] Skill/Plugin Supply Chain Compromise (draft): Hosannaith ships no skills or plugins.

## Considered and rejected

Mitigations that do not apply to Hosannaith, with the reason. Two are still drafts in the framework
and are marked.

| Mitigation | Why it does not apply |
|---|---|
| [MI-01] AI Data Leakage Prevention and Detection | Hosannaith receives no prompts, training data or customer data. A call carries a public URL and a payment. |
| [MI-02] Data Filtering From External Knowledge Bases | It has no knowledge base, embeddings or retrieval pipeline. |
| [MI-03] User/App/Model Firewalling/Filtering | There is no model to filter traffic to or from. Input checks on Hosannaith's own tools are under MI-19. |
| [MI-05] System Acceptance Testing | This is acceptance testing of the firm's AI system. Hosannaith's own CI tests are ordinary software testing, not this control. |
| [MI-06] Data Quality & Classification/Sensitivity | It governs data used to train or ground models. Hosannaith's measurements are public facts about public endpoints. |
| [MI-07] Legal and Contractual Frameworks for AI Systems | This is the firm's contracting control. Hosannaith publishes no terms of service or SLA yet, which is listed as a gap under MI-20. |
| [MI-08] Quality of Service (QoS) and DDoS Prevention for AI Systems | It protects model inference capacity, and Hosannaith runs no model. Hosannaith limits its inputs (MI-19) but has no per-caller rate limit. |
| [MI-09] AI System Alerting and Denial of Wallet (DoW) / Spend Monitoring | This is the firm's budget control. The facts it needs: prices are fixed and public, each 402 quotes the exact amount before payment, and each paid call returns a receipt. Hosannaith sets no spend caps. |
| [MI-10] AI Model Version Pinning | There is no model to pin. How Hosannaith's own packages are released is under MI-20. |
| [MI-11] Human Feedback Loop for AI Systems | There are no model outputs for people to rate. |
| [MI-12] Role-Based Access Control for AI Data | There is no AI training or retrieval data, and there are no user accounts. |
| [MI-13] Providing Citations and Source Traceability for AI-Generated Information | It is about generated text citing its sources, and Hosannaith generates no text. A signed result can be what a firm's system cites; see MI-21. |
| [MI-14] Encryption of AI Data at Rest | It covers confidential AI data such as training sets, embeddings and prompts. Hosannaith stores none. What it does store is stated under MI-20. |
| [MI-15] Using Large Language Models for Automated Evaluation (LLM-as-a-Judge) | Scores are arithmetic over recorded probes. No model judges anything. |
| [MI-16] Preserving Source Data Access Controls in AI Systems | Hosannaith ingests no access-controlled source data. |
| [MI-17] AI Firewall Implementation and Management | There is no model to shield, and Hosannaith does not inspect an agent's prompts or outputs. |
| [MI-18] Agent Authority Least Privilege Framework | It is about an agent's identity and permissions, which Hosannaith cannot see. The payment guard enforces one rule in code (a minimum score before paying). That is a small input to a firm's policy, not this framework. |
| [MI-22] Multi-Agent Isolation and Segmentation | Hosannaith is not an agent and keeps no per-agent state. |
| [MI-24] Human-in-the-Loop Action Approval Gate (draft) | Hosannaith approves nothing. A firm could use a score as one input to a rule that decides when a person must approve. |
| [MI-25] Skill/Plugin Integrity and Governance (draft) | Hosannaith ships no skill or plugin bundle. Its npm MCP package is an MCP server, covered by MI-20. |

## Something the framework does not name

Hosannaith exists for a failure the framework does not list as a risk: an agent pays an outside
service that is down, serves without asking for payment, or can only be paid on a test network. The
nearest risks are [RI-07], written for model hosting, and [RI-26], written for MCP servers. We do not
claim either for the pre-payment check. This may be worth raising with the framework's maintainers.

## CALM controls

The same five mitigations are attached as controls to the nodes they concern in
[`calm/hosannaith.architecture.json`](../calm/hosannaith.architecture.json). Each control's
`config` carries the framework id, a `reference-url` to its source file at the pinned commit, a
status, and a link back to the matching section of this page.

| CALM control key | Mitigation | Nodes |
|---|---|---|
| `mcp-security` | [MI-20] MCP Server Security Governance | `remote-mcp`, `mcp-package` |
| `tool-chain-validation` | [MI-19] Tool Chain Validation and Sanitization | `remote-mcp`, `oracle-api` |
| `credential-protection` | [MI-23] Agentic System Credential Protection Framework | `mcp-package`, `client-sdk` |
| `decision-audit` | [MI-21] Agent Decision Audit and Explainability | `oracle-api`, `report-signer`, `client-sdk` |
| `ai-observability` | [MI-04] AI System Observability | `monitor` |

The control keys are the ones FINOS CALM tooling uses for these mitigations
([`calm-studio/docs/AIGF_CATALOGUE.json`](https://github.com/finos/architecture-as-code/blob/c57c3d9ab92b8c5442c8bc40dc161be7dabbcce4/calm-studio/docs/AIGF_CATALOGUE.json)). The shape of each control follows
FINOS's own CALM examples
([`examples/fluxnova/fluxnova-ai-agent.architecture.json`](https://github.com/finos/architecture-as-code/blob/c57c3d9ab92b8c5442c8bc40dc161be7dabbcce4/examples/fluxnova/fluxnova-ai-agent.architecture.json)):
`requirement-url` is CALM's base control-requirement schema, which the CALM CLI validates the
`config` against.

## Two id forms

The framework's current ids are `RI-NN` and `MI-NN`. CALM tooling still carries a catalogue of
framework version 2.0 (generated 2026-03-14) that uses an older form with the type in the
id. It does not include [MI-24], [MI-25] or [RI-30]. For readers who know the older form, these are
the ones used on this page, as that catalogue gives them:

| Current id | Older id in the CALM catalogue |
|---|---|
| [MI-20] MCP Server Security Governance | `AIR-PREV-020` |
| [MI-19] Tool Chain Validation and Sanitization | `AIR-PREV-019` |
| [MI-23] Agentic System Credential Protection Framework | `AIR-PREV-023` |
| [MI-21] Agent Decision Audit and Explainability | `AIR-DET-021` |
| [MI-04] AI System Observability | `AIR-DET-004` |
| [RI-26] MCP Server Supply Chain Compromise | `AIR-SEC-026` |
| [RI-25] Tool Chain Manipulation and Injection | `AIR-SEC-025` |
| [RI-10] Prompt Injection | `AIR-SEC-010` |
| [RI-29] Agent-Mediated Credential Discovery and Harvesting | `AIR-SEC-029` |
| [RI-22] Regulatory Compliance and Oversight | `AIR-RC-022` |
| [RI-24] Agent Action Authorization Bypass | `AIR-SEC-024` |

## Sources

Framework: FINOS AI Governance Framework, version v3, commit `67b8c3257695d5ede09d262798bf28a0e58d4740`
(2026-11-02), licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Copyright FINOS.
This page describes and refers to the framework's text; it does not reproduce it. Machine-readable
copy of this table: [`calm/aigf-sources.json`](../calm/aigf-sources.json), checked in CI against the
framework repository by `scripts/check-aigf-ids.mjs`.

Files read to write this page:

- In full: the five applied mitigations ([MI-04], [MI-19], [MI-20], [MI-21], [MI-23]) and the risks
  [RI-24], [RI-25] and [RI-26]. Also [MI-08] and [MI-09], and `CONVENTIONS.md`, `README.md`,
  `NOTICE`, `LICENSE.spdx`, `docs/_config.yml`, `docs/_data/references/README.md`,
  `docs/_data/references/atr.yml` and `docs/_includes/mitigation-id.html`.
- Purpose, key principles and section headings, with the sections that bear on Hosannaith:
  [MI-13], [MI-18], [MI-22], [MI-24], [MI-25].
- Purpose and key principles: [MI-01], [MI-02], [MI-03], [MI-05], [MI-06], [MI-07], [MI-10], [MI-11],
  [MI-12], [MI-14], [MI-15], [MI-16], [MI-17].
- Front matter and summary: every other risk.

| Id | Title | Status in the framework | Source file |
|---|---|---|---|
| MI-01 | AI Data Leakage Prevention and Detection | Approved-Specification | [`docs/_mitigations/mi-1_ai-data-leakage-prevention-and-detection.md`](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-1_ai-data-leakage-prevention-and-detection.md) |
| MI-02 | Data Filtering From External Knowledge Bases | Approved-Specification | [`docs/_mitigations/mi-2_data-filtering-from-external-knowledge-bases.md`](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-2_data-filtering-from-external-knowledge-bases.md) |
| MI-03 | User/App/Model Firewalling/Filtering | Approved-Specification | [`docs/_mitigations/mi-3_user-app-model-firewalling-filtering.md`](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-3_user-app-model-firewalling-filtering.md) |
| MI-04 | AI System Observability | Approved-Specification | [`docs/_mitigations/mi-4_ai-system-observability.md`](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-4_ai-system-observability.md) |
| MI-05 | System Acceptance Testing | Approved-Specification | [`docs/_mitigations/mi-5_system-acceptance-testing.md`](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-5_system-acceptance-testing.md) |
| MI-06 | Data Quality & Classification/Sensitivity | Approved-Specification | [`docs/_mitigations/mi-6_data-quality-classification-sensitivity.md`](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-6_data-quality-classification-sensitivity.md) |
| MI-07 | Legal and Contractual Frameworks for AI Systems | Approved-Specification | [`docs/_mitigations/mi-7_legal-and-contractual-frameworks-for-ai-systems.md`](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-7_legal-and-contractual-frameworks-for-ai-systems.md) |
| MI-08 | Quality of Service (QoS) and DDoS Prevention for AI Systems | Approved-Specification | [`docs/_mitigations/mi-8_quality-of-service-qos-and-ddos-prevention-for-ai-systems.md`](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-8_quality-of-service-qos-and-ddos-prevention-for-ai-systems.md) |
| MI-09 | AI System Alerting and Denial of Wallet (DoW) / Spend Monitoring | Approved-Specification | [`docs/_mitigations/mi-9_ai-system-alerting-and-denial-of-wallet-dow-spend-monitoring.md`](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-9_ai-system-alerting-and-denial-of-wallet-dow-spend-monitoring.md) |
| MI-10 | AI Model Version Pinning | Approved-Specification | [`docs/_mitigations/mi-10_ai-model-version-pinning.md`](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-10_ai-model-version-pinning.md) |
| MI-11 | Human Feedback Loop for AI Systems | Approved-Specification | [`docs/_mitigations/mi-11_human-feedback-loop-for-ai-systems.md`](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-11_human-feedback-loop-for-ai-systems.md) |
| MI-12 | Role-Based Access Control for AI Data | Approved-Specification | [`docs/_mitigations/mi-12_role-based-access-control-for-ai-data.md`](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-12_role-based-access-control-for-ai-data.md) |
| MI-13 | Providing Citations and Source Traceability for AI-Generated Information | Approved-Specification | [`docs/_mitigations/mi-13_providing-citations-and-source-traceability-for-ai-generated-information.md`](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-13_providing-citations-and-source-traceability-for-ai-generated-information.md) |
| MI-14 | Encryption of AI Data at Rest | Approved-Specification | [`docs/_mitigations/mi-14_encryption-of-ai-data-at-rest.md`](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-14_encryption-of-ai-data-at-rest.md) |
| MI-15 | Using Large Language Models for Automated Evaluation (LLM-as-a-Judge) | Approved-Specification | [`docs/_mitigations/mi-15_using-large-language-models-for-automated-evaluation-llm-as-a-judge-.md`](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-15_using-large-language-models-for-automated-evaluation-llm-as-a-judge-.md) |
| MI-16 | Preserving Source Data Access Controls in AI Systems | Approved-Specification | [`docs/_mitigations/mi-16_preserving-source-data-access-controls-in-ai-systems.md`](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-16_preserving-source-data-access-controls-in-ai-systems.md) |
| MI-17 | AI Firewall Implementation and Management | Approved-Specification | [`docs/_mitigations/mi-17_ai-firewall-implementation-and-management.md`](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-17_ai-firewall-implementation-and-management.md) |
| MI-18 | Agent Authority Least Privilege Framework | Approved-Specification | [`docs/_mitigations/mi-18_agent-authority-least-privilege-framework.md`](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-18_agent-authority-least-privilege-framework.md) |
| MI-19 | Tool Chain Validation and Sanitization | Approved-Specification | [`docs/_mitigations/mi-19_tool-chain-validation-and-sanitization.md`](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-19_tool-chain-validation-and-sanitization.md) |
| MI-20 | MCP Server Security Governance | Approved-Specification | [`docs/_mitigations/mi-20_mcp-server-security-governance.md`](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-20_mcp-server-security-governance.md) |
| MI-21 | Agent Decision Audit and Explainability | Approved-Specification | [`docs/_mitigations/mi-21_agent-decision-audit-and-explainability.md`](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-21_agent-decision-audit-and-explainability.md) |
| MI-22 | Multi-Agent Isolation and Segmentation | Approved-Specification | [`docs/_mitigations/mi-22_multi-agent-isolation-and-segmentation.md`](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-22_multi-agent-isolation-and-segmentation.md) |
| MI-23 | Agentic System Credential Protection Framework | Approved-Specification | [`docs/_mitigations/mi-23_agentic-system-credential-protection-framework.md`](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-23_agentic-system-credential-protection-framework.md) |
| MI-24 | Human-in-the-Loop Action Approval Gate | Draft | [`docs/_mitigations/mi-24_human-in-the-loop-action-approval-gate.md`](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-24_human-in-the-loop-action-approval-gate.md) |
| MI-25 | Skill/Plugin Integrity and Governance | Draft | [`docs/_mitigations/mi-25_skill-plugin-integrity-and-governance.md`](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-25_skill-plugin-integrity-and-governance.md) |
| RI-01 | Information Leaked To Hosted Model | Approved-Specification | [`docs/_risks/ri-1_information-leaked-to-hosted-model.md`](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_risks/ri-1_information-leaked-to-hosted-model.md) |
| RI-02 | Information Leaked to Vector Store | Approved-Specification | [`docs/_risks/ri-2_information-leaked-to-vector-store.md`](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_risks/ri-2_information-leaked-to-vector-store.md) |
| RI-04 | Hallucination and Inaccurate Outputs | Approved-Specification | [`docs/_risks/ri-4_hallucination-and-inaccurate-outputs.md`](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_risks/ri-4_hallucination-and-inaccurate-outputs.md) |
| RI-05 | Foundation Model Versioning | Approved-Specification | [`docs/_risks/ri-5_foundation-model-versioning.md`](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_risks/ri-5_foundation-model-versioning.md) |
| RI-06 | Non-Deterministic Behaviour | Approved-Specification | [`docs/_risks/ri-6_non-deterministic-behaviour.md`](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_risks/ri-6_non-deterministic-behaviour.md) |
| RI-07 | Availability of Foundational Model | Approved-Specification | [`docs/_risks/ri-7_availability-of-foundational-model.md`](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_risks/ri-7_availability-of-foundational-model.md) |
| RI-08 | Tampering With the Foundational Model | Approved-Specification | [`docs/_risks/ri-8_tampering-with-the-foundational-model.md`](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_risks/ri-8_tampering-with-the-foundational-model.md) |
| RI-09 | Data Poisoning | Approved-Specification | [`docs/_risks/ri-9_data-poisoning.md`](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_risks/ri-9_data-poisoning.md) |
| RI-10 | Prompt Injection | Approved-Specification | [`docs/_risks/ri-10_prompt-injection.md`](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_risks/ri-10_prompt-injection.md) |
| RI-14 | Inadequate System Alignment | Approved-Specification | [`docs/_risks/ri-14_inadequate-system-alignment.md`](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_risks/ri-14_inadequate-system-alignment.md) |
| RI-16 | Bias and Discrimination | Approved-Specification | [`docs/_risks/ri-16_bias-and-discrimination.md`](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_risks/ri-16_bias-and-discrimination.md) |
| RI-17 | Lack of Explainability | Approved-Specification | [`docs/_risks/ri-17_lack-of-explainability.md`](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_risks/ri-17_lack-of-explainability.md) |
| RI-18 | Model Overreach / Expanded Use | Approved-Specification | [`docs/_risks/ri-18_model-overreach-expanded-use.md`](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_risks/ri-18_model-overreach-expanded-use.md) |
| RI-19 | Data Quality and Drift | Approved-Specification | [`docs/_risks/ri-19_data-quality-and-drift.md`](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_risks/ri-19_data-quality-and-drift.md) |
| RI-20 | Reputational Risk | Approved-Specification | [`docs/_risks/ri-20_reputational-risk.md`](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_risks/ri-20_reputational-risk.md) |
| RI-22 | Regulatory Compliance and Oversight | Approved-Specification | [`docs/_risks/ri-22_regulatory-compliance-and-oversight.md`](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_risks/ri-22_regulatory-compliance-and-oversight.md) |
| RI-23 | Intellectual Property (IP) and Copyright | Approved-Specification | [`docs/_risks/ri-23_intellectual-property-ip-and-copyright.md`](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_risks/ri-23_intellectual-property-ip-and-copyright.md) |
| RI-24 | Agent Action Authorization Bypass | Approved-Specification | [`docs/_risks/ri-24_agent-action-authorization-bypass.md`](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_risks/ri-24_agent-action-authorization-bypass.md) |
| RI-25 | Tool Chain Manipulation and Injection | Approved-Specification | [`docs/_risks/ri-25_tool-chain-manipulation-and-injection.md`](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_risks/ri-25_tool-chain-manipulation-and-injection.md) |
| RI-26 | MCP Server Supply Chain Compromise | Approved-Specification | [`docs/_risks/ri-26_mcp-server-supply-chain-compromise.md`](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_risks/ri-26_mcp-server-supply-chain-compromise.md) |
| RI-27 | Agent State Persistence Poisoning | Approved-Specification | [`docs/_risks/ri-27_agent-state-persistence-poisoning.md`](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_risks/ri-27_agent-state-persistence-poisoning.md) |
| RI-28 | Multi-Agent Trust Boundary Violations | Approved-Specification | [`docs/_risks/ri-28_multi-agent-trust-boundary-violations.md`](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_risks/ri-28_multi-agent-trust-boundary-violations.md) |
| RI-29 | Agent-Mediated Credential Discovery and Harvesting | Approved-Specification | [`docs/_risks/ri-29_agent-mediated-credential-discovery-and-harvesting.md`](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_risks/ri-29_agent-mediated-credential-discovery-and-harvesting.md) |
| RI-30 | Skill/Plugin Supply Chain Compromise | Draft | [`docs/_risks/ri-30_skill-plugin-supply-chain-compromise.md`](https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_risks/ri-30_skill-plugin-supply-chain-compromise.md) |

Threat references named above, as the framework lists them:

| Id | Title | Listed in |
|---|---|---|
| ATR-2026-00011 | Instruction Injection via Tool Output | `docs/_data/references/atr.yml`, `docs/_mitigations/mi-19_tool-chain-validation-and-sanitization.md` |
| ATR-2026-00013 | Tool-Driven Server-Side Request Forgery | `docs/_data/references/atr.yml`, `docs/_mitigations/mi-19_tool-chain-validation-and-sanitization.md` |

[MI-01]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-1_ai-data-leakage-prevention-and-detection.md
[MI-02]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-2_data-filtering-from-external-knowledge-bases.md
[MI-03]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-3_user-app-model-firewalling-filtering.md
[MI-04]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-4_ai-system-observability.md
[MI-05]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-5_system-acceptance-testing.md
[MI-06]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-6_data-quality-classification-sensitivity.md
[MI-07]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-7_legal-and-contractual-frameworks-for-ai-systems.md
[MI-08]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-8_quality-of-service-qos-and-ddos-prevention-for-ai-systems.md
[MI-09]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-9_ai-system-alerting-and-denial-of-wallet-dow-spend-monitoring.md
[MI-10]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-10_ai-model-version-pinning.md
[MI-11]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-11_human-feedback-loop-for-ai-systems.md
[MI-12]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-12_role-based-access-control-for-ai-data.md
[MI-13]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-13_providing-citations-and-source-traceability-for-ai-generated-information.md
[MI-14]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-14_encryption-of-ai-data-at-rest.md
[MI-15]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-15_using-large-language-models-for-automated-evaluation-llm-as-a-judge-.md
[MI-16]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-16_preserving-source-data-access-controls-in-ai-systems.md
[MI-17]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-17_ai-firewall-implementation-and-management.md
[MI-18]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-18_agent-authority-least-privilege-framework.md
[MI-19]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-19_tool-chain-validation-and-sanitization.md
[MI-20]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-20_mcp-server-security-governance.md
[MI-21]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-21_agent-decision-audit-and-explainability.md
[MI-22]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-22_multi-agent-isolation-and-segmentation.md
[MI-23]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-23_agentic-system-credential-protection-framework.md
[MI-24]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-24_human-in-the-loop-action-approval-gate.md
[MI-25]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-25_skill-plugin-integrity-and-governance.md
[RI-01]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_risks/ri-1_information-leaked-to-hosted-model.md
[RI-02]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_risks/ri-2_information-leaked-to-vector-store.md
[RI-04]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_risks/ri-4_hallucination-and-inaccurate-outputs.md
[RI-05]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_risks/ri-5_foundation-model-versioning.md
[RI-06]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_risks/ri-6_non-deterministic-behaviour.md
[RI-07]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_risks/ri-7_availability-of-foundational-model.md
[RI-08]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_risks/ri-8_tampering-with-the-foundational-model.md
[RI-09]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_risks/ri-9_data-poisoning.md
[RI-10]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_risks/ri-10_prompt-injection.md
[RI-14]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_risks/ri-14_inadequate-system-alignment.md
[RI-16]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_risks/ri-16_bias-and-discrimination.md
[RI-17]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_risks/ri-17_lack-of-explainability.md
[RI-18]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_risks/ri-18_model-overreach-expanded-use.md
[RI-19]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_risks/ri-19_data-quality-and-drift.md
[RI-20]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_risks/ri-20_reputational-risk.md
[RI-22]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_risks/ri-22_regulatory-compliance-and-oversight.md
[RI-23]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_risks/ri-23_intellectual-property-ip-and-copyright.md
[RI-24]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_risks/ri-24_agent-action-authorization-bypass.md
[RI-25]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_risks/ri-25_tool-chain-manipulation-and-injection.md
[RI-26]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_risks/ri-26_mcp-server-supply-chain-compromise.md
[RI-27]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_risks/ri-27_agent-state-persistence-poisoning.md
[RI-28]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_risks/ri-28_multi-agent-trust-boundary-violations.md
[RI-29]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_risks/ri-29_agent-mediated-credential-discovery-and-harvesting.md
[RI-30]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_risks/ri-30_skill-plugin-supply-chain-compromise.md
[ATR-2026-00011]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_data/references/atr.yml
[ATR-2026-00013]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_data/references/atr.yml
