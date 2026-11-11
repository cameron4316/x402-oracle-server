import { config as loadEnv } from 'dotenv';
import { ALGORAND_MAINNET_CAIP2, ALGORAND_TESTNET_CAIP2, USDC_TESTNET_ASA_ID } from '@x402/avm';
import { trimTrailingSlashes } from './trim.js';

loadEnv();

export type NetworkName = 'testnet' | 'mainnet';

const network = (process.env.NETWORK ?? 'testnet').toLowerCase() as NetworkName;

// Known mainnet USDC ASA id (competition spec).
const MAINNET_USDC_ASA_ID = 31566704;

// ALGORAND NETWORK IDS (CAIP-2) — a transition, offered in BOTH forms.
//
// Two ids are in use for each Algorand network:
//   spec form    "algorand:" + the first 32 characters of the base64 genesis hash. The only form the
//                x402 SDK accepts since @x402/core and @x402/avm 2.29.0 (x402-foundation/x402 #3894,
//                which removed the legacy form). This is what @x402/avm exports as
//                ALGORAND_MAINNET_CAIP2 / ALGORAND_TESTNET_CAIP2.
//   legacy form  "algorand:" + the full genesis hash. What GoPlausible's facilitator used to require
//                (reported in x402-foundation/x402 #3528), and what hosannaith-client up to 0.4.0
//                and hosannaith-mcp up to 0.3.0 register.
// The GoPlausible facilitator now lists both in /supported, so every 402 offers both, spec form
// FIRST: clients on current SDKs can only pay the spec form, and existing installs of our own clients
// keep paying the legacy one. Same price, payTo and tag on both. Drop the legacy entry once no
// settlements use it (the remote MCP audit log records the network of every settlement).
//
// This server's own @x402 packages are pinned below 2.29 by the lockfile; 2.29+ would refuse to
// register the legacy form. Upgrade them only together with dropping it.
const ALGORAND_MAINNET_LEGACY = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=' as const;
const ALGORAND_TESTNET_LEGACY = 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=' as const;

type Caip2 = `${string}:${string}`;

function resolveNetwork(): { caip2: Caip2; caip2Legacy: Caip2; usdcAsaId: number } {
  if (network === 'testnet') {
    return { caip2: ALGORAND_TESTNET_CAIP2 as Caip2, caip2Legacy: ALGORAND_TESTNET_LEGACY, usdcAsaId: Number(USDC_TESTNET_ASA_ID) };
  }
  if (network === 'mainnet') {
    return { caip2: ALGORAND_MAINNET_CAIP2 as Caip2, caip2Legacy: ALGORAND_MAINNET_LEGACY, usdcAsaId: MAINNET_USDC_ASA_ID };
  }
  throw new Error(`Unknown NETWORK "${network}". Use "testnet" or "mainnet".`);
}

// The spec form must be exactly the first 32 characters of the legacy form's reference; a wrong id
// would silently stop payments, so check it at startup rather than trust either constant blindly.
function assertSameNetwork(spec: string, legacy: string): void {
  const [ns, ref] = [legacy.slice(0, legacy.indexOf(':')), legacy.slice(legacy.indexOf(':') + 1)];
  if (spec !== `${ns}:${ref.slice(0, 32)}`) {
    throw new Error(`Algorand network ids disagree: ${spec} is not the spec form of ${legacy}`);
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name} (see .env.example)`);
  return v;
}

const resolved = resolveNetwork();
assertSameNetwork(resolved.caip2, resolved.caip2Legacy);

export const CONFIG = {
  network,
  // Spec-form CAIP-2 id (offered first) and the legacy form (offered second); see above.
  caip2: resolved.caip2,
  caip2Legacy: resolved.caip2Legacy,
  caip2Offered: [resolved.caip2, resolved.caip2Legacy] as const,
  usdcAsaId: resolved.usdcAsaId,
  avmAddress: requireEnv('AVM_ADDRESS'),
  facilitatorUrl: process.env.FACILITATOR_URL ?? 'https://facilitator.goplausible.xyz',
  port: Number(process.env.PORT ?? 4021),
  // Public HTTPS origin of the API. Used as each paid route's x402 `resource.url`: TLS terminates at
  // nginx, so the URL the app sees on a request is http://, which is not what clients reach.
  publicBaseUrl: trimTrailingSlashes(process.env.PUBLIC_BASE_URL ?? 'https://api.hosannaith.com'),
  // Remote x402-gated MCP server (src/mcp-remote.ts) — its own process/port, isolated from the API.
  mcpRemotePort: Number(process.env.MCP_REMOTE_PORT ?? 4022),
  // Competition tag added to each route's `extra` so activity is attributed to the Challenge.
  competitionTag: 'x402-global-challenge',
  monitorTargets: (process.env.MONITOR_TARGETS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  monitorIntervalSeconds: Number(process.env.MONITOR_INTERVAL_SECONDS ?? 60),
  observationLog: process.env.OBSERVATION_LOG ?? './data/observations.jsonl',
  // Remote MCP audit log (src/mcp-audit.ts): one line per tool call, rotated to <file>.1 past the cap.
  mcpAuditLog: process.env.MCP_AUDIT_LOG ?? './data/mcp-audit.jsonl',
  mcpAuditMaxBytes: Number(process.env.MCP_AUDIT_MAX_BYTES ?? 20 * 1024 * 1024),
} as const;
