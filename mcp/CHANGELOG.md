# Changelog

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
