# Security policy

Hosannaith sells signed reliability scores that other systems may use to decide whether to pay an
endpoint, so a flaw that lets someone forge, alter or game a score matters to us as much as a flaw in
the server itself. Thank you for reporting responsibly.

## How to report

Email **security@hosannaith.com**, or use GitHub's private vulnerability reporting
(this repository's **Security** tab, then **Report a vulnerability**).

Please do not open a public issue, pull request or discussion for a suspected vulnerability.

Helpful to include:

- what is affected (a URL, an npm package and version, or a file in this repository)
- steps to reproduce, or a proof of concept
- the impact you think it has
- whether and how you would like to be credited

Machine-readable contact details: [`/.well-known/security.txt`](https://api.hosannaith.com/.well-known/security.txt)
(RFC 9116).

## What happens next

Hosannaith is maintained by one person, so these are honest targets rather than a contract:

- acknowledgement within 3 business days
- a first assessment (confirmed or not, and how serious) within 10 business days
- a fix or mitigation as fast as the severity calls for, with updates to you along the way
- coordinated disclosure: we agree a publication date with you once a fix is available, and credit
  you in the release notes unless you prefer otherwise

There is no paid bug bounty at this time.

## Scope

In scope:

- the API at `https://api.hosannaith.com`, including the remote MCP server at `/mcp`
- the website at `https://hosannaith.com`
- the npm packages [`hosannaith-client`](https://www.npmjs.com/package/hosannaith-client) and
  [`hosannaith-mcp`](https://www.npmjs.com/package/hosannaith-mcp)
- the code in this repository

Especially interesting:

- forging a result signature, or getting a verifier to accept a tampered or revoked-key result
  (see [docs/attestation.md](docs/attestation.md))
- getting a paid result without paying, or paying and not getting one
- making the service probe or enroll a private or internal address
- inflating or depressing another endpoint's score
- anything that exposes data or credentials

Out of scope:

- endpoints that Hosannaith monitors but does not run. Please report those to their operators.
- denial of service, load or volume testing
- social engineering, phishing or physical attacks
- reports from automated scanners with no demonstrated impact
- missing security headers or best-practice notes with no demonstrated impact

## Testing guidelines

- Use your own accounts and funds. The paid routes settle real USDC on Algorand mainnet, and most
  findings can be shown without paying at all.
- Do not access, change or delete data that is not yours, and stop as soon as you have shown the
  issue.
- Keep traffic modest: no automated high-volume requests.

If you follow this policy in good faith, we will not pursue or support legal action against you for
your research, and we will work with you to understand and fix the issue.

## Supported versions

| Component | Supported |
|---|---|
| Live API and remote MCP server | always the deployed version |
| `hosannaith-client` | the latest release |
| `hosannaith-mcp` | the latest release |

## If a signing key is compromised

The key is rotated and the old one is listed under `revoked_keys` in
[`/.well-known/hosannaith-keys.json`](https://api.hosannaith.com/.well-known/hosannaith-keys.json).
`hosannaith-client` refuses results signed by a revoked key. The full procedure is in
[docs/attestation.md](docs/attestation.md).
