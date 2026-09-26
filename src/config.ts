import { config as loadEnv } from 'dotenv';
import { USDC_TESTNET_ASA_ID } from '@x402/avm';

loadEnv();

export type NetworkName = 'testnet' | 'mainnet';

const network = (process.env.NETWORK ?? 'testnet').toLowerCase() as NetworkName;

// Known mainnet USDC ASA id (competition spec).
const MAINNET_USDC_ASA_ID = 31566704;

// ALGORAND CAIP-2 FORM — @x402/avm is NOT buggy here; the facilitator we're deployed against is.
// The TRUNCATED 32-char form (used elsewhere as @x402/avm's ALGORAND_TESTNET_CAIP2 export) is the
// spec-correct CAIP-2 identifier per the Algorand CAIP-2 namespace profile — full base64 genesis
// hashes exceed CAIP-2's length/character limits. Upstream x402-foundation/x402 already fixed this
// (issue #2904, PR #2931, merged): @x402/avm@2.26.0's constants correctly reflect it.
//
// GoPlausible's hosted facilitator (facilitator.goplausible.xyz) runs GoPlausible/x402-avm, a fork
// ~604 commits behind x402-foundation/x402:main that predates PR #2931. Its live /supported
// endpoint (confirmed via `curl https://facilitator.goplausible.xyz/supported`) still advertises
// the legacy, non-compliant full-hash form below. x402HTTPResourceServer's facilitator-support
// check does an exact string match, so registering the spec-correct package constant against this
// stale facilitator fails outright with "Facilitator does not support scheme exact on network ...".
//
// We override to the facilitator's legacy value below SOLELY to interoperate with the facilitator
// as currently deployed — this is NOT the spec-correct value, it's pinned to match a known-stale
// dependency. Reported upstream: GoPlausible/x402-avm (CAIP-2 sync issue). If/when GoPlausible
// syncs their fork and the live facilitator starts advertising the compliant truncated form, THIS
// OVERRIDE MUST BE REVERTED (back to importing ALGORAND_TESTNET_CAIP2 from '@x402/avm') or this
// server will stop matching the facilitator the same way it does today.
const FACILITATOR_TESTNET_CAIP2 = 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=' as const;

// IMPORTANT (build step 6 — going live on mainnet):
// Same story as FACILITATOR_TESTNET_CAIP2 above — @x402/avm's ALGORAND_MAINNET_CAIP2 export
// ("algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k") is the spec-correct truncated CAIP-2 form, but
// GoPlausible's hosted facilitator (still on GoPlausible/x402-avm, ~604 commits behind, predating
// PR #2931) advertises the legacy full-hash form instead. Confirmed via a live
// `curl https://facilitator.goplausible.xyz/supported` (2026-09-25): the mainnet entry returns
// the value below, matching the same drift already seen on testnet. This is the authoritative
// value the facilitator actually expects, not a guess and not the package constant. REVERT to
// importing ALGORAND_MAINNET_CAIP2 from '@x402/avm' once GoPlausible syncs their fork and the
// live facilitator starts advertising the compliant truncated form.
const MAINNET_CAIP2 = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=' as const;

function resolveNetwork(): { caip2: `${string}:${string}`; usdcAsaId: number } {
  if (network === 'testnet') {
    return { caip2: FACILITATOR_TESTNET_CAIP2, usdcAsaId: Number(USDC_TESTNET_ASA_ID) };
  }
  if (network === 'mainnet') {
    return { caip2: MAINNET_CAIP2, usdcAsaId: MAINNET_USDC_ASA_ID };
  }
  throw new Error(`Unknown NETWORK "${network}". Use "testnet" or "mainnet".`);
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name} (see .env.example)`);
  return v;
}

const resolved = resolveNetwork();

export const CONFIG = {
  network,
  caip2: resolved.caip2,
  usdcAsaId: resolved.usdcAsaId,
  avmAddress: requireEnv('AVM_ADDRESS'),
  facilitatorUrl: process.env.FACILITATOR_URL ?? 'https://facilitator.goplausible.xyz',
  port: Number(process.env.PORT ?? 4021),
  // Competition tag added to each route's `extra` so activity is attributed to the Challenge.
  competitionTag: 'x402-global-challenge',
  monitorTargets: (process.env.MONITOR_TARGETS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  monitorIntervalSeconds: Number(process.env.MONITOR_INTERVAL_SECONDS ?? 60),
  observationLog: process.env.OBSERVATION_LOG ?? './data/observations.jsonl',
} as const;
