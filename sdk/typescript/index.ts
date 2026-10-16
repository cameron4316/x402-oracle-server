// hosannaith-client — a tiny client for the Hosannaith x402 reliability oracle on Algorand.
//
// Get a verified reliability score for any x402 endpoint in a few lines. This wraps the
// full x402 pay-per-call handshake (402 -> sign USDC payment -> retry) so you don't have to.
//
//   import { getReliability } from 'hosannaith-client';
//   const r = await getReliability('https://some-x402-endpoint/api', { mnemonic });
//   console.log(r.score, r.detail.confidence);

import algosdk from 'algosdk';
import { x402Client, wrapFetchWithPayment } from '@x402/fetch';
import { ExactAvmScheme } from '@x402/avm';

// Facilitator-verified CAIP-2 for Algorand MainNet.
// NOTE: @x402/avm ships the spec-correct *truncated* CAIP-2 form, but the live GoPlausible
// facilitator advertises this legacy *full-genesis-hash* form via /supported, so payments must
// match it. Verified live (2026-09): curl https://facilitator.goplausible.xyz/supported.
const ALGORAND_MAINNET_CAIP2 = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=';
const DEFAULT_BASE_URL = 'https://api.hosannaith.com';

export interface ReliabilityDetail {
  observations: number;
  windowHours: number;
  uptimePct: number | null; // % of probes reachable
  correct402Pct: number | null; // % of probes that correctly demanded payment
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
  private payingFetch: typeof fetch | null = null;

  constructor(opts: HosannaithOptions) {
    if (!opts?.mnemonic) throw new Error('HosannaithClient: `mnemonic` is required.');
    this.mnemonic = opts.mnemonic;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  // Build an x402 paying fetch from the mnemonic. We construct a ClientAvmSigner BY HAND
  // (address + signTransactions) rather than calling the library's signer factory: that
  // factory's expected input has changed across @x402/avm versions, but ClientAvmSigner is the
  // stable contract. algosdk does the mnemonic->key derivation and the Ed25519 signing.
  private getPayingFetch(): typeof fetch {
    if (!this.payingFetch) {
      const { addr, sk } = algosdk.mnemonicToSecretKey(this.mnemonic.trim());
      const signer: any = {
        address: String(addr),
        signTransactions: async (txns: Uint8Array[], indexesToSign?: number[]) =>
          txns.map((txn, i) => {
            if (indexesToSign && !indexesToSign.includes(i)) return null;
            return algosdk.signTransaction(algosdk.decodeUnsignedTransaction(txn), sk).blob;
          }),
      };
      const client = new x402Client();
      client.register(ALGORAND_MAINNET_CAIP2, new ExactAvmScheme(signer));
      this.payingFetch = wrapFetchWithPayment(fetch, client) as typeof fetch;
    }
    return this.payingFetch;
  }

  /** Pay for and return the reliability score of a target x402 endpoint. */
  async getReliability(targetUrl: string): Promise<ReliabilityResult> {
    if (!targetUrl) throw new Error('getReliability: `targetUrl` is required.');
    const payingFetch = this.getPayingFetch();
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
