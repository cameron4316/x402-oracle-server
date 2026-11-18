# Elenchos

**Proof, not promises, for the outside services your agents depend on.**

Elenchos (ἔλεγχος, Greek for a proof or a test, and in modern Greek an audit) is a reliability
gate for pipelines. The command and the files keep the plain name `reliability-gate`.

An AI agent in a bank does not work alone. It calls a credit bureau, an employment check, a risk
service, a hosted model. Each of those is run by someone else. If one of them is down, slow or
misbehaving, the agent's work is wrong or late, and the firm finds out afterwards.

Elenchos lets a firm write, in its [CALM](https://calm.finos.org) architecture, what each
outside service must meet. It then checks that requirement on every pipeline run against **signed
evidence from an independent oracle**, fails the pipeline when a service falls short, and saves an
evidence file that an auditor can re-check later without the pipeline, the network or the oracle.

It was built for the FINOS Fall 2026 Hackathon as an extension of the
[FINOS AI Steel Thread demo](https://github.com/finos-hack/ai-steel-thread-demo). See
[HACKATHON.md](HACKATHON.md) for the entry itself.

## Try it in two minutes

You need Node 22.18 or later. There is nothing to install, no account and no payment.

```bash
git clone https://github.com/cameron4316/x402-oracle-server
cd x402-oracle-server/gate
node demo/demo.ts
```

The demo runs five steps and prints each command it uses:

1. **A good day.** Four outside services are checked. The pipeline passes.
2. **An audit.** The saved evidence file is re-checked offline. Every decision is recomputed.
3. **One service degrades.** The same command now fails the pipeline, with the reasons.
4. **Someone edits the numbers to hide it.** The oracle's signature no longer verifies.
5. **Someone loosens the rule instead.** The file no longer matches the reviewed architecture.

Step 3 looks like this:

```text
FAIL    employment-verification-api (node)
        target    https://employment-verification.example/v1/verify
        evidence  openeago-contract, signed by key YdmBw1HF.. (active), 168 h window, 3,360 observations, under a minute old
        ok  a valid signature by one of the oracle's published keys   valid (ES256, key YdmBw1HFRbbNm5-N6DNsRNs-a8HckvaZ3bgFv72pD1c)
        ok  issued by http://127.0.0.1:8787                           http://127.0.0.1:8787
        ok  at most 24 h old                                          under a minute old
        ok  covers at least 168 h                                     covers 168 h
        ok  confidence "history" or better                            "history"
        ok  at least 1,000 observations                               3,360 observations
        x   reliability score >= 0.95                                 0.882
        x   availability >= 0.99                                      0.9712
        ok  error rate <= 0.05                                        0.0288
        x   p95 latency <= 1,500 ms                                   2,140 ms

Result: FAIL. 1 of 4 controls not met (1 advisory warning).
```

Two of the four services in the demo are fictional, and their figures come from a mock oracle.
They are not measurements. The third is a real pay-per-call endpoint with a real signed report,
verified against a real published key. The fourth has no independent evidence at all, and the gate
says so. [What is real and what is not](#what-is-real-and-what-is-not) lists this exactly.

## The control

A firm attaches one control to each outside service in its architecture. This one says: the credit
bureau must have a reliability score of at least 0.95, availability of at least 99%, an error rate
of at most 5% and a 95th percentile latency of at most 1.5 seconds, over the last seven days,
shown by evidence that is at most a day old.

```json
"controls": {
  "external-service-reliability": {
    "description": "The credit bureau API must be shown to be reliable by signed, independent evidence on every pipeline run.",
    "requirements": [{
      "requirement-url": "https://raw.githubusercontent.com/cameron4316/x402-oracle-server/main/gate/controls/external-service-reliability.requirement.json",
      "config": {
        "control-id": "external-service-reliability",
        "name": "External Service Reliability",
        "description": "...",
        "target": "https://credit-bureau.example/v1/score",
        "oracle": "https://oracle.example",
        "evidence": {
          "format": "openeago-contract",
          "from": "https://oracle.example/reliability",
          "keys": "https://oracle.example/.well-known/keys.json"
        },
        "window-hours": 168,
        "thresholds": {
          "min-reliability-score": 0.95,
          "min-availability": 0.99,
          "max-error-rate": 0.05,
          "max-latency-p95-ms": 1500
        },
        "min-confidence": "history",
        "min-observations": 1000,
        "max-evidence-age-hours": 24,
        "enforcement": "blocking"
      }
    }]
  }
}
```

The control follows the same pattern as the Steel Thread's own controls: a requirement schema
([controls/external-service-reliability.requirement.json](controls/external-service-reliability.requirement.json))
and the settings inline. `calm validate` checks the settings against the schema. The three
fractions above (0.95, 0.99, 0.05) are the thresholds the OpenEAGO specification uses for
reliability, availability and error rate, as quoted in the proposal linked
[below](#where-the-evidence-comes-from).

| Setting | Meaning |
|---|---|
| `target` | The outside service the evidence must be about. |
| `evidence.from` | Where the signed document is read from: a URL or a file. |
| `evidence.keys` | The oracle's public keys: a URL or a file. This is the trust anchor. |
| `evidence.trusted-kids` | Optional. Only these key ids are accepted. |
| `oracle` | The issuer the evidence must name. Only for `openeago-contract`. The Hosannaith formats name no issuer, so `oracle` is refused there: pin the key with `trusted-kids` instead. |
| `window-hours` | The evidence must cover at least this long. Default 168. |
| `thresholds` | What the service must meet. Fractions run from 0 to 1. |
| `min-confidence` | `history` (default), `one-shot` or `pending`. |
| `min-observations` | Fewest observations the evidence may rest on. |
| `max-evidence-age-hours` | Oldest acceptable evidence. Required. |
| `enforcement` | `blocking` (default) fails the pipeline. `advisory` warns. |

A misspelt setting is an error, not something quietly ignored. So is a percentage where a fraction
is meant: `99.9` for availability is refused, because a gate that compared 99.9 with 0.99 would
pass almost anything.

## How it decides

The gate takes nothing in a document on trust until the oracle's signature has been checked.

1. **Is there evidence?** No source, an unreadable document or unreadable keys all mean the
   control is not met.
2. **Is it the oracle's own statement about this service?** The document must be about the
   target. Its signature must verify against the keys the *control* names. Keys a document points
   at are ignored, so an attacker cannot bring their own. A pinned key id must match. The document
   must be dated within the life of its key, and name the expected issuer.
3. **Is the evidence good enough to rely on?** It must be recent, cover the window, rest on enough
   observations, and be based on recorded history when the control asks for that.
4. **Does the service meet the thresholds?** A threshold the evidence says nothing about is not
   met. Absence is not proof.

A failure in step 1 or 2 stops the check there. Steps 3 and 4 are always evaluated in full, so one
run reports everything that is wrong.

Exit codes: `0` every blocking control is met, `1` one is not, `2` the gate could not run. An
architecture with no such controls is exit `2` unless you pass `--allow-empty`, so a typo cannot
turn into a pass.

## The evidence file and the audit

`--evidence-out` saves one JSON file per run. For each control it holds the control as written,
the signed document exactly as received, the key set it was verified against, every check and the
decision.

```bash
node src/cli.ts audit evidence.json \
  --architecture architecture.calm.json \
  --trust-keys ../attest/jwks-history.json
```

`audit` recomputes every decision from the signed documents in the file, as of the time recorded
in it, and compares. It needs no network.

Only the oracle's documents are signed. Everything else in the file is confirmed against something
the auditor brings:

| In the file | Protected by |
|---|---|
| The oracle's figures | The oracle's signature. Any edit breaks it, and the recomputed decision becomes "fail". |
| The decisions and checks | Recomputed every time, never read from the file. Flipping "fail" to "pass" is caught even when the file's digest was recomputed. |
| The control settings, and which controls there are | `--architecture`: the reviewed CALM file. The file must be the one the gate ran on (by SHA-256), every control's settings must be identical, and none may be missing. Without it, someone could loosen a threshold in the file, or drop a failing control, and redo everything that follows. |
| The signing keys | `--trust-keys`: the oracle's keys from a source you trust. Every key the file relied on must appear there, unrevoked. |
| The time of the run, and which signed document was presented | Nothing yet. They are the file's own statements. A document dated after the stated run time is refused, but an older genuine document could be presented as the latest. Closing this needs the pipeline to sign the file, which the gate does not do yet. |

Without `--architecture` or `--trust-keys` the audit still runs, and says which of the two it could
not confirm. The digest in the file detects accidental change; it is not a signature.

## Where the evidence comes from

The gate does not measure anything. It checks what an independent oracle has signed. Three signed
formats are understood, and each is reduced to the same measurement before the thresholds apply.

| `evidence.format` | What it is |
|---|---|
| `openeago-contract` | The response contract proposed for OpenEAGO in [finos-labs/open-eago issue 72](https://github.com/finos-labs/open-eago/issues/72): the spec's field names, fractions from 0 to 1, an explicit window, a confidence level, and an ES256 signature over RFC 8785 canonical JSON. Any oracle that answers in this shape works. The gate asks with `?target=...&window_hours=...`, which is this gate's convention: the proposal defines the response, not the request. |
| `hosannaith-report` | A dated public report signed by [Hosannaith](https://hosannaith.com), covering one or more endpoints. Free to fetch. |
| `hosannaith-result` | A Hosannaith check result, single or batch, as its paid API returns it. The gate reads a saved result. It does not make payments. |

Two oracles ship here, so that nothing in the gate depends on one vendor:

- **[mock-oracle/](mock-oracle/server.ts)** speaks the proposed contract and was written from the
  proposal alone. It knows nothing about Hosannaith. Its figures come from a scenario file and are
  not measurements; every response says so. Its signing key is made at start and never saved.
- **Hosannaith** is a live oracle for pay-per-call (x402) endpoints. The example verifies its
  signed report in [`public-reports/`](../public-reports/a-identity-2026-11.json) against its
  public key history in [`attest/`](../attest/jwks-history.json), with the key id pinned.

Because the gate trusts the signature and not the channel, a saved copy, a mirror or a build
artifact is as good as a live fetch. The example reads Hosannaith's report from this repository.
The Steel Thread run below reads the same report from Hosannaith's API. The decision is the same.

To obtain a fresh `hosannaith-result`, call the oracle with
[`hosannaith-client`](https://www.npmjs.com/package/hosannaith-client) (`getReliability(url, ...)`)
and save the JSON it returns.

## On the FINOS AI Steel Thread demo

The Steel Thread demo models a loan approval flow in CALM and attaches four AI Governance
Framework mitigations to it. Its tools for credit score, employment and fraud are stubs, marked
`"stub": true` in its architecture, and the one outside service it models is the hosted model's
API. The loan approval use case it implements describes external credit data and external APIs.

[examples/steel-thread/](examples/steel-thread/README.md) adds what production would add: the
outside services behind those stubs, and an `external-service-reliability` control on each
outside service, including the model API. It does this with an overlay. The Steel Thread's file
is read at a pinned commit and extended; it is not edited and not copied here.

```bash
git clone https://github.com/finos-hack/ai-steel-thread-demo
git -C ai-steel-thread-demo checkout 2782173d47f5074f8767dbdf553fa9165ee1ccd8
node examples/steel-thread/run.ts --steel-thread ./ai-steel-thread-demo
```

Add `--offline` on a network that cannot reach Hosannaith's API: the signed report and keys are
then read from this repository, and the decision is the same.

CI does the same on every change: applies the overlay, validates the merged architecture with
the official CALM CLI, and runs the gate on it.

## In a pipeline

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 24
- uses: cameron4316/x402-oracle-server/gate@main
  with:
    architecture: architecture/system.calm.json
    evidence-out: evidence/reliability.json
    metrics-out: evidence/reliability.prom
- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: reliability-evidence
    path: evidence/
```

The job summary gets a table of every control. `--metrics-out` writes the same results as
Prometheus metrics (`reliability_gate_control_met`, `reliability_gate_availability_ratio`,
`reliability_gate_latency_seconds` and others), so the state of each outside service can sit on
the dashboards a team already has.

Other commands:

```bash
node src/cli.ts check --architecture <calm.json> [--evidence-out f] [--metrics-out f] [--verbose]
node src/cli.ts audit <evidence.json> [--architecture <calm.json>] [--trust-keys <file or URL>]...
node src/cli.ts controls --architecture <calm.json>      # list the controls, check nothing
node src/cli.ts overlay --base <calm.json> --overlay <overlay.json> --out <merged.json>
```

The gate has no dependencies: it uses only what ships with Node, and runs its TypeScript
directly. There is no install step and no build.

## How this relates to FINOS work

Every framework id below links to its source file in the
[FINOS AI Governance Framework](https://github.com/finos/ai-governance-framework) at commit
`67b8c3257695d5ede09d262798bf28a0e58d4740`, the same pin the rest of this repository uses
([calm/aigf-sources.json](../calm/aigf-sources.json)). The framework is licensed CC-BY-4.0. A test
fails if an id is cited here without being in that manifest. The Steel Thread's files write the
same ids in the framework's file-name form (`ri-7`, `mi-4`), and so do the controls in the overlay.

| | What the source says | What the gate does with it |
|---|---|---|
| [RI-07] Availability of Foundational Model | Models are often served by third-party providers; an outage or degradation at the provider disrupts operations; a service level agreement does not guarantee uninterrupted service. | Applies the same reasoning to every outside service an agent depends on, and turns "we have an agreement" into a requirement checked against measurements. |
| [MI-04] AI System Observability | Observability provides the data needed to monitor service level compliance for AI services. Its source lists [RI-07] among the risks it mitigates. | Brings independent measurements of outside services into the pipeline and, as metrics, onto the same dashboards. |
| [MI-21] Agent Decision Audit and Explainability | Audit records should be verifiable by a deployer, an auditor or an authority without privileged access to the provider's systems; self-reported logs weaken that. | The evidence is signed by a party other than the service and other than the firm, and the saved file can be re-checked by anyone holding the oracle's public keys. |
| [MI-20] MCP Server Security Governance | For outside MCP servers: continuous monitoring of behaviour and performance, and defined availability and performance requirements. | When the outside service is an MCP server, the control is where those requirements are written down and checked. |

**A gap worth naming.** [RI-07] is about the model provider. The framework has no risk that names
the availability of the *other* outside services an agent calls, or of services an agent pays per
call. This control borrows [RI-07]'s reasoning for them. That is a nearest fit, not a claim that
the framework says so.

- **CALM.** The control is an ordinary CALM control with a JSON Schema requirement, validated by
  the official CLI in CI.
- **OpenEAGO.** The `openeago-contract` format, the mock oracle and the adapter for Hosannaith
  are the working example offered in the proposal: one interface, two implementations, signature
  verification against the oracle's keys.

## What is real and what is not

| In the demo and examples | Real? |
|---|---|
| The gate, the control, the signature checks, the evidence file, the audit | Real, and covered by tests. |
| Hosannaith's signed report on A-Identity's `risk_check` endpoint, and the key it verifies against | Real. The report states exactly what it covers. |
| The credit bureau and employment verification services, and their figures | Fictional. `.example` names, mock oracle. Not measurements. |
| Evidence for the hosted model API | None. The control is advisory and the gate reports that no evidence source is configured. That is a statement about this example, not about any provider. |

## Limits

- **The gate is only as good as the oracle.** It proves what the oracle signed, not that the
  oracle measured well. Choosing which oracle to trust, and pinning its keys, is the firm's
  decision.
- **Hosannaith measures pay-per-call (x402) endpoints today.** It does not measure ordinary APIs,
  MCP servers or model APIs, which is why those services in the examples are fictional or carry
  no evidence. An oracle for them would plug in through the same contract.
- **Dates are the oracle's.** Freshness uses the times the oracle signed. A revoked key is refused.
  A retired key is accepted only for documents dated while it was in use. An oracle that lies
  about the time is not detected.
- **Build time, not run time.** The gate stops a pipeline. It does not sit in the path of the
  agent's calls. The metrics output is the bridge to run-time dashboards and alerts.
- **The evidence file is not signed by the pipeline.** Its settings are confirmed against the
  reviewed architecture and its keys against a trusted key set, but the time of the run is its own
  statement. See [the audit section](#the-evidence-file-and-the-audit).
- **Behind a proxy**, Node's `fetch` needs `NODE_USE_ENV_PROXY=1` to use the proxy settings in the
  environment. Reading evidence from files avoids the network altogether.

## Layout and tests

```text
src/            the gate: control parser, CALM reader, formats, decision, evidence, audit, CLI
src/attest/     signature code, identical to the server's (a test keeps it so)
controls/       the control's requirement schema
mock-oracle/    a contract-speaking oracle with made-up figures, for trying the gate
examples/       loan-approval (self-contained) and steel-thread (overlay on the FINOS demo)
demo/           the four-step walk-through
test/           node --test "test/*.test.ts"
```

```bash
node --test "test/*.test.ts"
```

The tests run on a bare checkout. They cover the decision logic check by check, the three
formats against real signed documents, forged evidence files (edited numbers, loosened settings,
dropped controls), and the command line end to end over real HTTP on the loopback interface.

Apache-2.0, like the rest of this repository.

[RI-07]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_risks/ri-7_availability-of-foundational-model.md
[MI-04]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-4_ai-system-observability.md
[MI-20]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-20_mcp-server-security-governance.md
[MI-21]: https://github.com/finos/ai-governance-framework/blob/67b8c3257695d5ede09d262798bf28a0e58d4740/docs/_mitigations/mi-21_agent-decision-audit-and-explainability.md
