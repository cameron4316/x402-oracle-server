# hosannaith-mcp

An [MCP](https://modelcontextprotocol.io) server that gives any MCP-capable agent (Claude Desktop,
Cursor, Claude Code, etc.) a tool to check the **reliability of an x402 endpoint on Algorand**
before it routes a payment there.

It wraps the [Hosannaith](https://hosannaith.com) reliability oracle. One tool call pays a small
USDC amount over x402 and returns a verified reliability score.

## Tools

| Tool | Cost | What it does |
| --- | --- | --- |
| `get_hosannaith_info` | free | Explains what the score means and how to act on it. Call this first. |
| `check_x402_reliability` | small USDC payment (x402 on Algorand) | Returns the reliability score for a target x402 endpoint URL. |

A score looks like:

```json
{
  "target": "https://api.example.com/resource",
  "status": "pass",
  "score": 97,
  "detail": {
    "observations": 142,
    "windowHours": 24,
    "uptimePct": 100,
    "correct402Pct": 100,
    "p50LatencyMs": 180,
    "p95LatencyMs": 420,
    "confidence": "history"
  },
  "observedAt": "2026-10-14T00:00:00.000Z"
}
```

- `status`: `pass` (score ≥90) · `degraded` (60–89) · `fail` (<60) · `unknown` (too little data)
- `score`: 0–100, or `null` when there isn't enough history to stand behind a number
- `detail.confidence`: `history` (scored from accrued observations) · `one-shot` (only one live probe — treat cautiously)

## Install & build

```bash
npm install
npm run build
```

This produces `dist/index.js`, the executable the MCP client runs.

## Configure your MCP client

`check_x402_reliability` pays for the score, so the server needs the 25-word mnemonic of a
**funded, USDC-opted-in Algorand account** in the `AVM_MNEMONIC` environment variable. Use a
**low-balance throwaway hot account** — never your main wallet, never a receive-only address.
The mnemonic is read only from the environment; it is never logged or returned.

### Claude Desktop

Edit `claude_desktop_config.json`
(macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`,
Windows: `%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "hosannaith": {
      "command": "node",
      "args": ["/absolute/path/to/hosannaith-mcp/dist/index.js"],
      "env": {
        "AVM_MNEMONIC": "word1 word2 ... word25"
      }
    }
  }
}
```

Use the absolute path to `dist/index.js`. Restart Claude Desktop.

### Cursor

Add to `~/.cursor/mcp.json` (or the project's `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "hosannaith": {
      "command": "node",
      "args": ["/absolute/path/to/hosannaith-mcp/dist/index.js"],
      "env": {
        "AVM_MNEMONIC": "word1 word2 ... word25"
      }
    }
  }
}
```

## Try it

1. Call `get_hosannaith_info` (free) and read how to interpret a score.
2. Call `check_x402_reliability` with a target URL, e.g.
   `https://x402.goplausible.xyz/examples/weather`. The server pays via x402 and returns the score.

## Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `AVM_MNEMONIC` | for paid tool | — | 25-word mnemonic of a funded, USDC-opted-in throwaway Algorand account used to pay for scores. |
| `HOSANNAITH_BASE_URL` | no | `https://api.hosannaith.com` | Override the oracle endpoint (local testing only). |

## Security

- `AVM_MNEMONIC` is a **spending** key. Keep it to a throwaway account with a small balance.
- It lives only in your MCP client config's `env` block — never commit it to version control.
- The server never prints, logs, or returns the mnemonic.

## License

MIT © Cameron Vickers
