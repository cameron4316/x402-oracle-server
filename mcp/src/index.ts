#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import algosdk from 'algosdk';
import { x402Client, wrapFetchWithPayment } from '@x402/fetch';
import { ExactAvmScheme } from '@x402/avm';

// Where the paid /reliability endpoint lives. Override only for local testing.
const BASE_URL = (process.env.HOSANNAITH_BASE_URL ?? 'https://api.hosannaith.com').replace(/\/+$/, '');

// Facilitator-advertised CAIP-2 for Algorand MainNet.
// @x402/avm ships the spec-correct *truncated* CAIP-2, but the live GoPlausible facilitator
// advertises this legacy *full-genesis-hash* form via /supported, so payments must match it.
const ALGORAND_MAINNET_CAIP2 = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=';

// The oracle's response shape (mirrors the Hosannaith server's reliability check).
interface ReliabilityResult {
  target: string;
  checkId: string;
  status: 'pass' | 'degraded' | 'fail' | 'unknown';
  score: number | null;
  detail?: { confidence?: 'history' | 'one-shot'; [k: string]: unknown };
  observedAt: string;
}

// Build an x402 paying fetch from a 25-word mnemonic.
//
// We construct a ClientAvmSigner BY HAND (address + signTransactions) instead of calling the
// library's toClientAvmSigner factory: that factory's expected input changed across @x402/avm
// versions (base64 key string -> wrapped-secret object), but ClientAvmSigner is the stable
// contract. algosdk does the mnemonic->key derivation and the Ed25519 signing.
function payingFetchFromMnemonic(mnemonic: string): typeof fetch {
  const { addr, sk } = algosdk.mnemonicToSecretKey(mnemonic.trim());
  const address = String(addr);

  // ClientAvmSigner: receives encoded unsigned txns, returns signed blobs (or null for skipped).
  const signer: any = {
    address,
    signTransactions: async (txns: Uint8Array[], indexesToSign?: number[]) =>
      txns.map((txn, i) => {
        if (indexesToSign && !indexesToSign.includes(i)) return null;
        return algosdk.signTransaction(algosdk.decodeUnsignedTransaction(txn), sk).blob;
      }),
  };

  const client = new x402Client();
  client.register(ALGORAND_MAINNET_CAIP2, new ExactAvmScheme(signer));
  return wrapFetchWithPayment(fetch, client) as typeof fetch;
}

const server = new McpServer({ name: 'hosannaith', version: '0.1.0' });

// --- Free tool: describe the oracle so an agent knows how to read a score ---
server.registerTool(
  'get_hosannaith_info',
  {
    title: 'About the Hosannaith reliability oracle',
    description:
      'Free. Explains what the Hosannaith x402 reliability oracle returns and how an agent should ' +
      'act on a score. Call this once before check_x402_reliability so you can interpret the result.',
    inputSchema: {},
  },
  async () => ({
    content: [
      {
        type: 'text',
        text: [
          'Hosannaith is a reliability oracle for x402 endpoints on Algorand.',
          'It independently monitors x402 APIs (uptime, correct HTTP 402 behaviour, latency) and sells',
          'a verified reliability score so an agent can decide whether to trust an endpoint BEFORE paying it.',
          '',
          'check_x402_reliability(targetUrl) returns JSON shaped like:',
          '  target:    the URL you asked about',
          '  status:    "pass" (score >= 90) | "degraded" (60–89) | "fail" (< 60) | "unknown" (too little data)',
          '  score:     0–100, or null when there is not enough data to stand behind a score',
          '  detail: {',
          '    confidence:  "history" (scored from accrued observations) | "one-shot" (only one live probe — treat cautiously)',
          '    observations, windowHours: how many samples over what period the score covers',
          '    uptimePct, correct402Pct, p50LatencyMs, p95LatencyMs: the underlying signals',
          '  }',
          '',
          'Decision rule for an agent: pay/route to endpoints that are "pass"; treat "degraded" as risky;',
          'avoid "fail"; for "unknown" or "one-shot", gather more signal or proceed with low stakes.',
          '',
          'check_x402_reliability itself costs a small USDC payment on Algorand (x402). It requires the',
          'AVM_MNEMONIC environment variable to be set on this MCP server to a funded (low-balance, throwaway)',
          'Algorand account that has opted into USDC. The mnemonic is read only from the environment and is',
          'never logged or returned.',
          '',
          'Scoring a watchlist? check_x402_reliability_batch(targetUrls) scores up to 50 endpoints in one',
          'paid call ($7 flat) — cheaper than calling check_x402_reliability for each.',
        ].join('\n'),
      },
    ],
  }),
);

// --- Paid tool: fetch the reliability score for one x402 endpoint ---
server.registerTool(
  'check_x402_reliability',
  {
    title: 'Check an x402 endpoint reliability score',
    description:
      'Paid (small USDC payment via x402 on Algorand). Returns the Hosannaith reliability score for a ' +
      'target x402 endpoint URL so you can decide whether to trust it before routing payment to it. ' +
      'Requires the AVM_MNEMONIC environment variable on this server.',
    inputSchema: {
      targetUrl: z
        .string()
        .url()
        .describe('The full https URL of the x402 endpoint to evaluate, e.g. https://api.example.com/resource'),
    },
  },
  async ({ targetUrl }) => {
    const mnemonic = process.env.AVM_MNEMONIC;
    if (!mnemonic) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text:
              'AVM_MNEMONIC is not set. This tool pays for the score via x402, so the MCP server needs the ' +
              '25-word mnemonic of a funded, USDC-opted-in Algorand account in the AVM_MNEMONIC environment ' +
              'variable. Add it to this server\'s "env" in your MCP client config and restart.',
          },
        ],
      };
    }

    try {
      const payingFetch = payingFetchFromMnemonic(mnemonic);
      const url = `${BASE_URL}/reliability?target=${encodeURIComponent(targetUrl)}`;
      const res = await payingFetch(url, { method: 'GET' });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Hosannaith request failed (HTTP ${res.status}) for ${targetUrl}: ${body || '(no body)'}`,
            },
          ],
        };
      }

      const result = (await res.json()) as ReliabilityResult;
      const confidence = result.detail?.confidence;
      const summary =
        `Hosannaith reliability for ${targetUrl}: ` +
        `status=${result.status}` +
        (typeof result.score === 'number' ? ` score=${result.score}` : ' score=n/a') +
        (confidence ? ` confidence=${confidence}` : '');

      return {
        content: [
          { type: 'text', text: summary },
          { type: 'text', text: JSON.stringify(result, null, 2) },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text:
              `Failed to get a reliability score for ${targetUrl}: ` +
              (err instanceof Error ? err.message : String(err)) +
              '. Check that AVM_MNEMONIC is a funded USDC-opted-in account and that the target URL is reachable.',
          },
        ],
      };
    }
  },
);

// --- Paid tool: batch reliability — score up to 50 endpoints in one call ---
server.registerTool(
  'check_x402_reliability_batch',
  {
    title: 'Batch-check x402 endpoint reliability',
    description:
      'Paid (one small USDC payment via x402 on Algorand — $7 flat for up to 50 targets). Scores ' +
      'many x402 endpoints in a single call: pass a list of URLs, get a reliability score for each. ' +
      'Cheaper than checking each separately when you have a watchlist to vet before routing payments. ' +
      'Requires the AVM_MNEMONIC environment variable on this server.',
    inputSchema: {
      targetUrls: z
        .array(z.string().url())
        .min(1)
        .max(50)
        .describe('Up to 50 x402 endpoint URLs to score in one paid call.'),
    },
  },
  async ({ targetUrls }) => {
    const mnemonic = process.env.AVM_MNEMONIC;
    if (!mnemonic) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text:
              'AVM_MNEMONIC is not set. This tool pays for the scores via x402, so the MCP server needs the ' +
              '25-word mnemonic of a funded, USDC-opted-in Algorand account in the AVM_MNEMONIC environment ' +
              'variable. Add it to this server\'s "env" in your MCP client config and restart.',
          },
        ],
      };
    }

    try {
      const payingFetch = payingFetchFromMnemonic(mnemonic);
      const res = await payingFetch(`${BASE_URL}/reliability/batch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targets: targetUrls }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return {
          isError: true,
          content: [
            { type: 'text', text: `Hosannaith batch request failed (HTTP ${res.status}): ${body || '(no body)'}` },
          ],
        };
      }

      const result = (await res.json()) as {
        results: Array<{ status: string }>;
        count: number;
        requested: number;
        capped: boolean;
      };
      const tally = result.results.reduce<Record<string, number>>((acc, r) => {
        acc[r.status] = (acc[r.status] ?? 0) + 1;
        return acc;
      }, {});
      const summary =
        `Hosannaith batch: scored ${result.count} of ${result.requested}` +
        (result.capped ? ' (capped at 50)' : '') +
        ` — pass=${tally.pass ?? 0} degraded=${tally.degraded ?? 0} fail=${tally.fail ?? 0} unknown=${tally.unknown ?? 0}`;

      return {
        content: [
          { type: 'text', text: summary },
          { type: 'text', text: JSON.stringify(result, null, 2) },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text:
              'Failed to batch-score the endpoints: ' +
              (err instanceof Error ? err.message : String(err)) +
              '. Check that AVM_MNEMONIC is a funded, USDC-opted-in account.',
          },
        ],
      };
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // MUST log to stderr only — stdout is the MCP JSON-RPC channel and any stray write corrupts it.
  console.error('[hosannaith-mcp] ready on stdio');
}

main().catch((err) => {
  console.error('[hosannaith-mcp] fatal:', err);
  process.exit(1);
});
