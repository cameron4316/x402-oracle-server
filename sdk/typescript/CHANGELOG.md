# Changelog

## Unreleased

- Trims trailing slashes from `baseUrl` without a regular expression (CodeQL js/polynomial-redos).
  `baseUrl` comes from your own code, so this was not exploitable remotely.

## 0.4.1

- Pays Hosannaith with the spec-form Algorand network id (`algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k`)
  when the server offers it, which it now does first. The x402 SDK accepts only that form since
  `@x402/avm` 2.29. The legacy full-hash id stays registered as a fallback.

## 0.4.0

- **Signed results are verified.** Every result from the oracle carries an ES256 signature. The
  client now checks it against Hosannaith's published keys before returning. A forged, altered or
  revoked result throws `HosannaithVerificationError`, and the reliability guard never allows a
  payment on one, whatever `onError` says. Choose the
  behaviour with `verify: 'auto' | 'strict' | 'off'` (default `'auto'`); read the outcome with
  `getVerification(result)`. See "Signed results are verified for you" in the README.
- **New result fields** (additive): `detail.p99LatencyMs` (null below 20 latency samples) and the
  OpenEAGO SLO aliases `availability_pct`, `error_rate_pct`, `protocol_conformance_pct`,
  `score_normalized`; plus `spec_version`, `generated_at` and `signature` on every result.
- `payingFetch` option: bring your own x402 paying fetch instead of a mnemonic.
- **License:** Apache-2.0 from this release, with LICENSE and NOTICE in the package. 0.3.0 and
  earlier remain available under MIT.

## 0.3.0 and earlier

Published under the MIT License.
