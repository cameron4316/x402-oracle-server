# Contributing

Thank you for considering a contribution. Hosannaith is a small project with one maintainer, so
this guide is short and the process is simple.

## Before you start

- **A small fix** (a typo, a clear bug, a missing test): open a pull request.
- **Anything larger** (a new field, a new check, a change to how something is scored or signed):
  open an issue first and describe what you have in mind. It saves you building something that
  cannot be merged.
- **A suspected vulnerability**: do not open an issue or a pull request. Follow
  [SECURITY.md](SECURITY.md).

## Reporting a problem

Open an issue at <https://github.com/cameron4316/x402-oracle-server/issues>. It helps to say:

- what you did (the request, the command, or the package and version)
- what you expected, and what happened instead
- for a score or a report you think is wrong: the target URL, the time, and the `kid` of the
  signature if there is one

For a suspected vulnerability, do not open an issue. Follow [SECURITY.md](SECURITY.md).

## What is in this repository

| Folder | What it is | How to test it |
|---|---|---|
| `src/`, `test/` | The API server, the monitor and the remote MCP server | `pnpm install --frozen-lockfile`, then `pnpm typecheck` and `pnpm test` |
| `sdk/typescript/` | `hosannaith-client`, the client package | `pnpm install --frozen-lockfile`, then `pnpm typecheck` and `pnpm test` in that folder |
| `mcp/` | `hosannaith-mcp`, the local MCP server | `pnpm install --ignore-workspace --no-frozen-lockfile` and `pnpm build` in that folder |
| `gate/` | Elenchos, the reliability gate | `node --test "gate/test/*.test.ts"` (nothing to install) |
| `calm/`, `docs/` | The architecture model, the framework mapping and the security baseline self-assessment | `node scripts/check-aigf-ids.mjs` and `node scripts/check-osps-baseline.mjs` |

You need Node 22 or later and [pnpm](https://pnpm.io). Production runs on Node 24, and CI tests
both. Every pull request runs the full set of checks; you do not need to run all of them locally.

## Rules that reviews hold to

These are the things a change is most often sent back for.

1. **Existing response fields do not change.** Fields, names and nesting in a result are a
   contract with people who verify signatures and parse results. New fields are added; existing
   ones are not renamed, moved or given a new meaning.
2. **The payment code is left alone.** Product logic does not go into the payment middleware or
   its wrapper. A new paid product is a new `Check`, one route entry and one registry line.
3. **No secrets, ever.** No `.env` files, mnemonics, private keys or tokens in a commit, a test,
   a fixture or a log line. Tests that need a key make one at run time.
4. **Tests make no payments.** No test, script or CI job may pay an endpoint or create
   on-chain volume.
5. **A behaviour change comes with a test.** If a fix has no test that fails without it, the
   review will ask for one.
6. **Framework ids are sourced.** Any FINOS AI Governance Framework risk or mitigation id must be
   in `calm/aigf-sources.json` and link to its source file. Ids are never invented. A check
   enforces this.
7. **Licences.** Dependencies must be under a licence on the allow list that CI checks
   (Apache-2.0, MIT, BSD, ISC and similar). No GPL, AGPL or SSPL.
8. **Say what is true.** Documentation states what the code does today. If something is partial,
   the text says "partly" and names what is missing.

## Sign your commits (DCO)

This project uses the [Developer Certificate of Origin](https://developercertificate.org). By
signing off a commit you state that you wrote the change, or otherwise have the right to submit
it, under this project's licence.

Add the sign-off with `-s`:

```bash
git commit -s -m "fix: describe the change"
```

That adds a line like `Signed-off-by: Your Name <you@example.com>` using the name and email in
your git configuration. Every commit in a pull request needs one.

## Pull requests

1. Fork the repository and work on a branch.
2. Keep one pull request to one change. Describe what it does, why, and how you checked it.
3. Make sure CI is green. `main` is protected: changes arrive only through pull requests, and
   these checks are required: "Server (typecheck, tests, licenses)", "hosannaith-client
   (typecheck, licenses)" and "hosannaith-mcp (build, licenses)".
4. The maintainer reviews, may ask for changes, and squash-merges.

Reviews aim to be prompt, but with one maintainer a reply can take a few days.

## Licence

The project is licensed under [Apache-2.0](LICENSE). Contributions are accepted under the same
licence.

## Conduct

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
