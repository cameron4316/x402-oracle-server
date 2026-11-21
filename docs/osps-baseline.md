# OpenSSF Security Baseline, Level 1: self-assessment

The [Open Source Project Security Baseline](https://baseline.openssf.org) is the OpenSSF's list of
security requirements for open source projects, in three levels. This page checks this repository
against every Level 1 requirement of version **2026.08.28**, the current version when this was
written.

This is a self-assessment by the maintainer. Nobody outside the project has reviewed it. Each row
names where to look, so anyone can check it.

## Summary

| | |
|---|---|
| Level 1 requirements | 24 |
| Met | 22 |
| Not applicable | 1 |
| To confirm | 1 |
| Not met | 0 |

Last checked: 2026-11-19. Levels 2 and 3 have not been assessed.

## How to read the table

- **Met**: the requirement holds today, and the evidence column says where to see it.
- **Not applicable**: the requirement is conditional and the condition does not hold here.
- **To confirm**: it depends on an account setting that cannot be read from the repository. The
  maintainer confirms it; the row says what to confirm.
- **Not met**: stated as such. A row is changed to "Met" only after the gap is closed.

The requirement text in the second column is shortened. The full wording is in the
[published checklist](https://baseline.openssf.org/versions/2026-08-28).

## Level 1

| Requirement | What it asks | Status | Evidence |
|---|---|---|---|
| OSPS-AC-01.01 | Multi-factor authentication to read or change sensitive resources in the repository | To confirm | The maintainer's GitHub account must have two-factor authentication on. This cannot be read from the repository. Releases already need a second factor: `.github/workflows/publish.yml` only stages a release, and the maintainer approves it on npm with 2FA. |
| OSPS-AC-02.01 | A new collaborator gets permissions by hand, or the lowest by default | Met | The repository has one maintainer and belongs to a personal account. A collaborator can only be added by the owner, by hand. Nothing grants access automatically. |
| OSPS-AC-03.01 | Direct commits to the primary branch are prevented | Met | A ruleset on `main` requires a pull request for every change, allows squash merges only, requires three status checks, and has no bypass list. |
| OSPS-AC-03.02 | Deleting the primary branch needs explicit confirmation | Met | The same ruleset blocks deletion of `main` and blocks force pushes. |
| OSPS-BR-01.01 | CI sanitises untrusted metadata before using it | Met | No workflow puts a pull request title, branch name or other contributor-chosen text into a script. Action inputs reach scripts as environment variables (`gate/action.yml`). The release workflow accepts a tag only if it names one of two known packages (`.github/workflows/publish.yml`). |
| OSPS-BR-01.03 | CI keeps privileged credentials away from untrusted code | Met | Workflows run on `pull_request`, never `pull_request_target`, with `contents: read` (`.github/workflows/ci.yml`), so code from a fork gets no secrets. No publishing token is stored anywhere. The only job that can publish runs on a release tag that must point at a commit on `main`, and it can only stage a release: nobody can install it until the maintainer approves it on npm (`.github/workflows/publish.yml`). |
| OSPS-BR-03.01 | Official project channels use encrypted transport | Met | The site (`https://hosannaith.com`), the API (`https://api.hosannaith.com`), this repository and the npm packages are all served over HTTPS. |
| OSPS-BR-03.02 | Official distribution channels are cryptographically authenticated | Met | Source is distributed from GitHub and packages from the npm registry, both over TLS. Packages are published from CI with npm trusted publishing, and the publishing job checks the package's SHA-256 against the one the build job packed (`.github/workflows/publish.yml`). |
| OSPS-BR-07.01 | Secrets are kept out of version control | Met | GitHub secret scanning is on, with push protection, so a push containing a recognised secret is refused. `.gitignore` excludes `.env` files and key files. Tests create keys at run time (`CONTRIBUTING.md`, rule 3). |
| OSPS-DO-01.01 | User guides for all basic functionality | Met | `README.md`, `sdk/typescript/README.md`, `gate/README.md`, `docs/attestation.md`. |
| OSPS-DO-02.01 | A guide for reporting defects | Met | `CONTRIBUTING.md` ("Reporting a problem") for bugs, `SECURITY.md` for vulnerabilities. |
| OSPS-GV-02.01 | A public place to discuss changes and problems | Met | GitHub Issues and pull requests on this repository are open to everyone. |
| OSPS-GV-03.01 | An explanation of how to contribute | Met | `CONTRIBUTING.md`. |
| OSPS-LE-02.01 | The source licence is an open source licence | Met | Apache-2.0 (`LICENSE`). |
| OSPS-LE-02.02 | The licence of released assets is an open source licence | Met | Both npm packages declare Apache-2.0 (`sdk/typescript/package.json`, `mcp/package.json`). |
| OSPS-LE-03.01 | The source licence is in a LICENSE file in the repository | Met | `LICENSE`, with `NOTICE`. |
| OSPS-LE-03.02 | The licence ships with released assets | Met | Each package carries its own copy (`sdk/typescript/LICENSE`, `mcp/LICENSE`). |
| OSPS-QA-01.01 | The source repository is publicly readable at a fixed address | Met | `https://github.com/cameron4316/x402-oracle-server`. |
| OSPS-QA-01.02 | A public record of every change, who made it and when | Met | The git history. Every change to `main` arrives through a pull request, which keeps the discussion and the checks with it. |
| OSPS-QA-02.01 | A dependency list for direct dependencies | Met | `package.json` and `pnpm-lock.yaml`; `sdk/typescript/package.json` and its lockfile; `mcp/package.json`. The release workflow also writes a CycloneDX bill of materials for each release (`scripts/sbom.mjs`). |
| OSPS-QA-04.01 | Projects with several repositories list their codebases | Not applicable | The project's code is in this one repository. The static files of the website are not in a repository yet. |
| OSPS-QA-05.01 | No generated executables in version control | Met | The repository tracks source only. Build output is ignored (`.gitignore`), and packages are built in CI. |
| OSPS-QA-05.02 | No unreviewable binary artifacts in version control | Met | The repository tracks no binary files. |
| OSPS-VM-02.01 | Security contacts in the documentation | Met | `SECURITY.md`, and an RFC 9116 file at `/.well-known/security.txt` on the API (`src/security-txt.ts`). |

## Related

- **Scorecard.** `.github/workflows/scorecard.yml` runs the [OpenSSF Scorecard](https://github.com/ossf/scorecard)
  checks each week and on every change to `main`. The result is in the job summary and kept as a
  workflow artifact. It is not published to the Scorecard service, so there is no badge.
- **What Level 1 does not say.** It is a floor for how a project is run. It says nothing about
  whether the service is sound. For that, see the [framework mapping](aigf-mapping.md), which
  states the service's gaps plainly.

## Source

Requirement ids are those of the baseline's Level 1 checklist, version 2026.08.28, from
[ossf/security-baseline](https://github.com/ossf/security-baseline) at commit
`c62696c17f4086bb1aed51cfa594dee00e9d8a91`
([`docs/versions/2026-08-28-checklist.md`](https://github.com/ossf/security-baseline/blob/c62696c17f4086bb1aed51cfa594dee00e9d8a91/docs/versions/2026-08-28-checklist.md)).
The list is pinned in [`osps-baseline-l1.json`](osps-baseline-l1.json), and a check fails if this
page lists a requirement that is not in it, misses one, or names a file that does not exist.
