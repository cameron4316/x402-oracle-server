# Releasing the npm packages

`hosannaith-client` (`sdk/typescript`) and `hosannaith-mcp` (`mcp`) are released from GitHub
Actions by [`.github/workflows/publish.yml`](../.github/workflows/publish.yml) using npm
[trusted publishing](https://docs.npmjs.com/trusted-publishers) and
[staged publishing](https://docs.npmjs.com/staged-publishing):

- No npm token exists anywhere. The workflow authenticates to npm with a short-lived GitHub OIDC
  token, and only this repository's `publish.yml` running in the `npm` environment is trusted.
- A release is **staged**, not live. A maintainer reviews it and approves it with 2FA before anyone
  can install it, so a compromised workflow alone cannot ship a package.
- No dependency code runs with publishing rights. A `build` job without credentials checks the tag
  against the package version (and that it points at `main`), runs the same checks and dependency
  license gate as CI, writes a CycloneDX SBOM with `scripts/sbom.mjs` from pnpm's own resolution,
  and packs the tarball. A separate `stage` job, the only one given an OIDC token, installs nothing but npm itself,
  checks the tarball's SHA-256 and stages exactly that tarball with lifecycle scripts disabled.
- Third-party actions in the release workflow are pinned to commit SHAs.
- The tarball and SBOM are kept as the `release` artifact of the workflow run.

Every pull request rehearses the build job for both packages (CI job "npm packages (dry run,
SBOM)"): the SBOM must build, and the tarball must carry LICENSE, NOTICE and README, carry no tests,
and repack to the same file list once extracted.

## One-time setup on npmjs.com (per package)

Do this right before the first release with the workflow: a new trusted publisher configuration
expires if it is not used within 2 days.

1. Make sure 2FA is on for the npm account (needed to approve staged releases).
2. Package page → **Settings** → **Trusted Publisher** → **GitHub Actions**:
   - Organization or user: `cameron4316`
   - Repository: `x402-oracle-server`
   - Workflow filename: `publish.yml`
   - Environment name: `npm`
   - Allowed actions: staged publish only (do not allow plain `npm publish`)
3. After the first release works: **Settings** → **Publishing access** → **Require two-factor
   authentication and disallow tokens**.

Repeat for the other package. `repository.url` in each `package.json` already points at this
repository, which trusted publishing requires.

## Cutting a release

1. Merge a pull request that bumps the version (for the MCP server, `mcp/package.json` and every
   version in `mcp/server.json`) and notes the changes.
2. Tag the merge commit on `main` and push the tag:
   ```
   git tag hosannaith-client@0.4.0 && git push origin hosannaith-client@0.4.0
   git tag hosannaith-mcp@0.3.0 && git push origin hosannaith-mcp@0.3.0
   ```
3. Watch the "Publish to npm" run. It stops before staging if any check fails. Nothing is public
   until step 4.
4. Review the staged release on npmjs.com (**Staged Packages** tab) or with
   `npm stage list hosannaith-client`. The SHA-256 printed by the run's Pack step identifies the
   tarball. Approve it with 2FA (button, or `npm stage approve <stage-id>`), or leave it unapproved
   to abandon the release.
5. Check the new version page on npmjs.com shows its provenance (built by this repository's
   `publish.yml`).
6. For the MCP server, update the MCP Registry listing afterwards with `mcp-publisher publish`.
