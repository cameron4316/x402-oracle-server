# Changelog

## 0.3.1

- Fixes paying from a fresh install. `@x402/avm` 2.29 and later accept only the spec-form Algorand
  network id, and this package allowed those versions while registering only the legacy full-hash
  id, so a new install could not pay. It now registers the spec form, which the Hosannaith server
  offers first, and keeps the legacy form as a fallback.

## 0.3.0

- Tool descriptions document the new result fields: `detail.p99LatencyMs`, the OpenEAGO SLO
  aliases (`availability_pct`, `error_rate_pct`, `protocol_conformance_pct`, `score_normalized`),
  and the signature on every result (`spec_version`, `generated_at`, `signature`), with where to
  verify it.
- The server reports its real version to MCP clients.
- **License:** Apache-2.0 from this release, with LICENSE and NOTICE in the package. 0.2.1 and
  earlier remain available under MIT.
- First release built, checked and staged from GitHub Actions with npm trusted publishing.

## 0.2.1 and earlier

Published under the MIT License.
