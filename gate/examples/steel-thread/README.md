# The control on the FINOS AI Steel Thread demo

The [AI Steel Thread demo](https://github.com/finos-hack/ai-steel-thread-demo) is the end-to-end
run of FINOS Governance-as-Code: a loan approval flow, modelled in CALM, with AI Governance
Framework mitigations attached and enforced.

This folder adds one thing to it: **governance of the outside services the flow depends on.**

## What the Steel Thread has, and what this adds

| | In the Steel Thread today | Added by the overlay |
|---|---|---|
| Outside services in the architecture | The hosted model API. The credit score, employment and fraud tools are stubs (`"stub": true`). | The outside services a production version of those tools would call: a credit bureau, an employment verification service and a pay-per-call risk check. |
| Controls | Data leakage prevention, observability, acceptance testing and human feedback (`mi-1`, `mi-4`, `mi-5`, `mi-11`). | `external-service-reliability` on each outside service, the model API included. |
| Risks named | `ri-1`. | `ri-7`, availability of an outside provider. |
| Evidence | Metrics and traces from the system itself. | Signed measurements from an independent oracle, saved as a file an auditor can re-check. |

[`overlay.json`](overlay.json) holds the additions. It is written against one exact file: the
Steel Thread's `architecture/loan-approval.calm.json` at commit
`2782173d47f5074f8767dbdf553fa9165ee1ccd8`, identified by its SHA-256. The runner refuses any
other version rather than extend a file nobody reviewed. The Steel Thread's files are read from
your checkout. They are not edited and not copied into this repository.

The controls use the Steel Thread's own conventions: the framework ids sit beside the control's
description in the framework's file-name form, and `aigf-catalog-url` points at the catalogue
page. Its launch UI reads those fields.

## Run it

```bash
git clone https://github.com/finos-hack/ai-steel-thread-demo
git -C ai-steel-thread-demo checkout 2782173d47f5074f8767dbdf553fa9165ee1ccd8

# from the gate folder
node examples/steel-thread/run.ts --steel-thread ./ai-steel-thread-demo
```

The runner applies the overlay, starts the mock oracle, runs the gate, and writes to `out/`:

| File | What it is |
|---|---|
| `loan-approval.with-external-services.calm.json` | The merged architecture: 42 nodes, the Steel Thread's 39 plus 3 outside services. |
| `url-to-local-file-mapping.json` | The Steel Thread's four control schemas plus this one, for `calm validate`. |
| `evidence.json` | The signed documents, keys, checks and decisions. |
| `metrics.prom` | The same results as Prometheus metrics. |
| `summary.md` | The table a pipeline shows. |
| `mock-oracle-keys.json` | The mock oracle's public key, saved so the evidence can be audited after it stops. |

Add `--scenario degraded` to see the pipeline fail.

**If your network cannot reach `api.hosannaith.com`**, the risk check control fails with "could not
read", which is the gate refusing to pass without evidence. Two ways round it:

- `--offline` reads the signed report and the public keys from this repository instead. The gate
  trusts the signature, not the channel, so the decision is the same.
- Behind a proxy, set `NODE_USE_ENV_PROXY=1` so Node's `fetch` uses the proxy settings in your
  environment.

To audit the evidence afterwards, with the controls and the keys confirmed:

```bash
node src/cli.ts audit examples/steel-thread/out/evidence.json \
  --architecture examples/steel-thread/out/loan-approval.with-external-services.calm.json \
  --trust-keys ../attest/jwks-history.json \
  --trust-keys examples/steel-thread/out/mock-oracle-keys.json
```

To validate the merged architecture:

```bash
npx @finos/calm-cli validate \
  -a examples/steel-thread/out/loan-approval.with-external-services.calm.json \
  -u examples/steel-thread/out/url-to-local-file-mapping.json -f pretty
```

## What the four controls show

| Service | Evidence | Expected result |
|---|---|---|
| `credit-bureau-api` (fictional) | Mock oracle, proposed OpenEAGO contract | Pass |
| `employment-verification-api` (fictional) | Mock oracle, proposed OpenEAGO contract | Pass; fail with `--scenario degraded` |
| `counterparty-risk-check` (real endpoint) | Hosannaith's signed public report, fetched from its API (or read from this repository with `--offline`) and verified against its published key, key id pinned | Pass while the report is under 90 days old |
| `openai-chat-api` (the Steel Thread's own node) | None configured | Advisory warning |

The last row is the point of an advisory control. The framework names the availability of the
model provider as a risk. With the control attached, the pipeline shows on every run that no
independent evidence is configured for it. That is a statement about this example's
configuration, not about any provider.

## Putting it into the Steel Thread itself

The overlay maps one to one onto a change to the Steel Thread's repository:

1. Add `controls/external-service-reliability.requirement.json` and its line in
   `url-to-local-file-mapping.json`.
2. Add the nodes, relationships and controls from `overlay.json` to `loan-approval.calm.json`.
3. Add a pipeline step that runs the gate and keeps `evidence.json`.
4. Point Prometheus at the metrics, next to the system's own.
