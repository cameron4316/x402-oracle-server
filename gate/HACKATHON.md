# FINOS Fall 2026 Hackathon entry: Reliability gate

**Track:** Governance-as-Code (extending the AI Steel Thread demo)
**Entrant:** Cameron Vickers, solo
**Licence:** Apache-2.0

## The gap

The AI Steel Thread demo shows governance as something a pipeline proves: a loan approval flow
modelled in CALM, with AI Governance Framework mitigations attached, enforced and observed.

It governs what the agent sends to the model, how the model calls are observed, how the system is
tested and where a person signs off. It does not yet govern whether the **outside services** the
agent depends on are working. In the demo those tools are stubs. In production they are a credit
bureau, an employment check, a fraud or risk service and the model provider: four third parties
whose failures become the firm's failures.

A contract and the provider's own status page are the usual answers. Neither is evidence a
pipeline can check, and a status page is not independent.

## What this adds

One control and the tooling to prove it.

- **A CALM control, `external-service-reliability`,** in the Steel Thread's own pattern. It
  states what an outside service must meet and which oracle's evidence is accepted.
- **A gate** that checks the control on every pipeline run against evidence **signed by an
  independent oracle**, and fails the pipeline when a service falls short.
- **An evidence file** holding the signed documents, keys, checks and decisions, and an **audit**
  command that recomputes every decision from it offline. Edited numbers are caught by the oracle's
  signature. Loosened settings or a dropped control are caught against the reviewed architecture.
  Recomputing the file's digest does not help a forger in either case.
- **An overlay** that applies all of this to the Steel Thread's architecture at a pinned commit,
  without editing or copying its files.
- **A working example of the OpenEAGO reliability-oracle proposal**
  ([finos-labs/open-eago issue 72](https://github.com/finos-labs/open-eago/issues/72)): one
  response contract, two independent implementations, signatures verified against the oracle's
  published keys.

## See it

Node 22.18 or later. Nothing to install, no account, no payment.

```bash
git clone https://github.com/cameron4316/x402-oracle-server
cd x402-oracle-server/gate
node demo/demo.ts
```

Five steps: a passing pipeline, an offline audit, a service that degrades and fails the pipeline,
and two forged evidence files that the audit rejects (edited numbers, then a loosened rule). On the Steel Thread's own architecture:
[examples/steel-thread/](examples/steel-thread/README.md). Everything else: [README.md](README.md).

## How it uses FINOS projects

| Project | Use |
|---|---|
| AI Steel Thread demo | Extended by an overlay on its CALM architecture at a pinned commit. CI applies the overlay, validates the result and runs the gate on it. |
| CALM | The control is a CALM control with a JSON Schema requirement. Both architectures are validated with the official CLI in CI. |
| AI Governance Framework | Every risk and mitigation cited links to its source file at a pinned commit, and a test fails on an id that is not in the pinned manifest. The README says where the fit is exact and where it is only the nearest. |
| OpenEAGO | The evidence contract is the one proposed in issue 72, using the specification's own field names, units and thresholds. |

## What was built for the hackathon, and what existed

Built during the event, in [this folder](.): the control and its schema, the gate, the evidence
file and audit, the mock oracle, the overlay and its runner, both examples, the demo, the tests,
the GitHub Action and the CI workflow.

Existing before it: Hosannaith, the live oracle used as the real evidence source in the examples,
with its signing keys, its signed public report and the signature code the gate reuses.

Two of the four services in the examples are fictional and their figures are not measurements.
The README lists exactly what is real and what is not.

## What comes next

1. Offer the control and the overlay to the Steel Thread as a contribution.
2. Offer the contract, the mock oracle and the adapter to OpenEAGO as `examples/reliability-oracle`.
3. Propose to the AI Governance Framework a risk for the availability of outside services an
   agent depends on or pays, which the framework does not name today.
4. Sign the evidence file as the pipeline that produced it, so the time of the run is attested too.
5. Oracles for ordinary APIs and MCP servers, through the same contract.

Built by Cameron Vickers, with Claude Code as pair programmer.
