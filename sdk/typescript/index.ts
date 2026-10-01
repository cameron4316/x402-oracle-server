// hosannaith-client — a tiny client for the Hosannaith x402 reliability oracle on Algorand.
//
// Get a verified reliability score for any x402 endpoint in a few lines. This wraps the
// full x402 pay-per-call handshake (402 -> sign USDC payment -> retry) so you don't have to.
//
//   import { getReliability } from 'hosannaith-client';
//   const r = await getReliability('https://some-x402-endpoint/api', { mnemonic });
//   console.log(r.score, r.detail.confidence);

import { x402Client, wrapFetchWithPayment } from '@x402/fetch';
import { toClientAvmSigner, ExactAvmScheme } from '@x402/avm';
import {
  ed25519SigningKeyFromWrappedSecret,
  type WrappedEd25519Seed,
} from '@algorandfoundation/algokit-utils/crypto';
import { seedFromMnemonic } from '@algorandfoundation/algokit-utils/algo25';

// Facilitator-verified CAIP-2 for Algorand MainNet.
// NOTE: @x402/avm ships the spec-correct *truncated* CAIP-2 form, but the live GoPlausible
// facilitator advertises this legacy *full-genesis-hash* form via /supported, so payments must
// match it. Verified live (2026-09): curl https://facilitator.goplausible.xyz/supported.
// Revert to importing ALGORAND_MAINNET_CAIP2 from '@x402/avm' once GoPlausible syncs their fork.
const ALGORAND_MAINNET_CAIP2 = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=';
const DEFAULT_BASE_URL = 'https://api.hosannaith.com';

export interface ReliabilityDetail {
  observations: number;
  windowHours: number;
  uptimePct: number | null;
  correct402Pct: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  score: number | null;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  confidence: 'history' | 'one-shot';
}

export interface ReliabilityResult {
  target: string;
  checkId: string;
  status: 'pass' | 'degraded' | 'fail' | 'unknown';
  score: number | null;
  detail: ReliabilityDetail;
  observedAt: string;
}

export interface HosannaithOptions {
  /** 25-word Algorand (algo25) mnemonic of the account that pays. Keep it secret — never commit it. */
  mnemonic: string;
  /** Override the oracle base URL. Defaults to https://api.hosannaith.com */
  baseUrl?: string;
}

/**
 * Reusable client. Builds the payment signer once; good when you'll score several endpoints.
 */
export class HosannaithClient {
  private readonly baseUrl: string;
  private readonly mnemonic: string;
  private fetchPromise: Promise<typeof fetch> | null = null;

  constructor(opts: HosannaithOptions) {
    if (!opts?.mnemonic) throw new Error('HosannaithClient: `mnemonic` is required.');
    this.mnemonic = opts.mnemonic;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  private getPayingFetch(): Promise<typeof fetch> {
    if (!this.fetchPromise) {
      this.fetchPromise = (async () => {
        const secretKey = await secretKeyFromMnemonic(this.mnemonic);
        const avmSigner = toClientAvmSigner(secretKey);
        const client = new x402Client();
        client.register(ALGORAND_MAINNET_CAIP2, new ExactAvmScheme(avmSigner));
        return wrapFetchWithPayment(fetch, client) as typeof fetch;
      })();
    }
    return this.fetchPromise;
  }

  /** Pay for and return the reliability score of a target x402 endpoint. */
  async getReliability(targetUrl: string): Promise<ReliabilityResult> {
    if (!targetUrl) throw new Error('getReliability: `targetUrl` is required.');
    const payingFetch = await this.getPayingFetch();
    const url = `${this.baseUrl}/reliability?target=${encodeURIComponent(targetUrl)}`;
    const res = await payingFetch(url, { method: 'GET' });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Hosannaith request failed (HTTP ${res.status}): ${body || '(no body)'}`);
    }
    return (await res.json()) as ReliabilityResult;
  }
}

/** One-shot convenience helper: builds a client and makes a single call. */
export async function getReliability(
  targetUrl: string,
  opts: HosannaithOptions,
): Promise<ReliabilityResult> {
  return new HosannaithClient(opts).getReliability(targetUrl);
}

// Build the base64 signing key x402-avm expects: 32-byte Ed25519 seed + 32-byte public key.
async function secretKeyFromMnemonic(mnemonic: string): Promise<string> {
  const seed = seedFromMnemonic(mnemonic);
  const seedCopy = new Uint8Array(seed);
  const wrappedSeed: WrappedEd25519Seed = {
    unwrapEd25519Seed: async () => seed,
    wrapEd25519Seed: async () => {},
  };
  const wrappedSecret = await ed25519SigningKeyFromWrappedSecret(wrappedSeed);
  return Buffer.concat([
    Buffer.from(seedCopy),
    Buffer.from(wrappedSecret.ed25519Pubkey),
  ]).toString('base64');
}
