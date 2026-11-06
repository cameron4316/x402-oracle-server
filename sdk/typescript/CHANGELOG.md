# Changelog

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
