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

/** One endpoint's result inside a batch. Mirrors ReliabilityResult, but `confidence` may also be
 *  'pending' — a target with no history yet, now enrolled for monitoring. */
export interface BatchItemResult {
  target: string;
  checkId: string;
  status: 'pass' | 'degraded' | 'fail' | 'unknown';
  score: number | null;
  detail: { confidence?: 'history' | 'one-shot' | 'pending'; [k: string]: unknown };
  observedAt: string;
}

/** Return shape of getReliabilityBatch. */
export interface BatchReliabilityResult {
  results: BatchItemResult[];
  count: number; // how many were scored (after dedupe + the 50 cap)
  requested: number; // how many you sent
  capped: boolean; // true if you sent more than the cap
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

  /** Pay once and score up to 50 endpoints in a single batch call ($7 flat). Targets with no
   *  monitoring history yet come back `unknown` and are enrolled for ongoing monitoring. */
  async getReliabilityBatch(targets: string[]): Promise<BatchReliabilityResult> {
    if (!Array.isArray(targets) || targets.length === 0) {
      throw new Error('getReliabilityBatch: `targets` must be a non-empty array of URLs.');
    }
    const payingFetch = this.getPayingFetch();
    const res = await payingFetch(`${this.baseUrl}/reliability/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targets }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Hosannaith batch request failed (HTTP ${res.status}): ${body || '(no body)'}`);
    }
    return (await res.json()) as BatchReliabilityResult;
  }
}

/** One-shot convenience helper: builds a client and makes a single call. */
export async function getReliability(
  targetUrl: string,
  opts: HosannaithOptions,
): Promise<ReliabilityResult> {
  return new HosannaithClient(opts).getReliability(targetUrl);
}

/** One-shot batch helper: builds a client and scores many endpoints in one paid call. */
export async function getReliabilityBatch(
  targets: string[],
  opts: HosannaithOptions,
): Promise<BatchReliabilityResult> {
  return new HosannaithClient(opts).getReliabilityBatch(targets);
}

// ---------------------------------------------------------------------------
// Reliability guard — vet an x402 endpoint BEFORE you pay it.
//
// Wrap your paying fetch once; from then on every request is checked against
// Hosannaith first, and a low-scoring endpoint is refused (or warned on) before
// any USDC moves. Scores are cached per endpoint, so repeated payments to the
// same endpoint reuse one check instead of paying for a new one each time.
// ---------------------------------------------------------------------------

/** A transparent, reproducible record of why a request was allowed or blocked. */
export interface GuardDecision {
  /** The endpoint the agent was about to call/pay. */
  url: string;
  /** Whether the request was allowed to proceed. */
  allow: boolean;
  status: ReliabilityResult['status'];
  score: number | null;
  confidence: 'history' | 'one-shot' | null;
  /** Human-readable basis for the decision (what was compared, never more than was measured). */
  reason: string;
  /** True when the score was reused from cache rather than freshly paid for. */
  cached: boolean;
  /** Set when the reliability check itself failed (oracle down, payment error). */
  error?: string;
}

/** Thrown in `block` mode when an endpoint fails the reliability bar. Carries the full decision. */
export class ReliabilityGuardError extends Error {
  readonly decision: GuardDecision;
  constructor(decision: GuardDecision) {
    super(`Reliability guard blocked ${decision.url}: ${decision.reason}`);
    this.name = 'ReliabilityGuardError';
    this.decision = decision;
  }
}

export interface GuardOptions extends HosannaithOptions {
  /** Block endpoints scoring below this (0–100). Default 90. */
  minScore?: number;
  /** `block` throws on a failing endpoint; `warn` logs and proceeds. Default `block`. */
  mode?: 'block' | 'warn';
  /** How long to reuse one endpoint's score, in ms. Default 15 min. */
  cacheTtlMs?: number;
  /** What to do when the oracle has too little data (status `unknown`). Default `allow`. */
  onUnknown?: 'allow' | 'block';
  /** What to do if the reliability check itself fails. Default `allow` (fail-open — an oracle
   *  outage must not break the agent's payments). Set `block` to fail-closed. */
  onError?: 'allow' | 'block';
  /** Choose which requests to guard. Default: everything except calls to the oracle itself. */
  shouldGuard?: (url: string, init?: RequestInit) => boolean;
  /** Called with every decision — use for logging, metrics, or chaining another check (e.g. identity). */
  onDecision?: (decision: GuardDecision) => void;
}

/**
 * Wrap a fetch so every request to a payable endpoint is vetted by Hosannaith first.
 *
 *   import { wrapFetchWithReliabilityGuard } from 'hosannaith-client';
 *   import { wrapFetchWithPayment, x402Client } from '@x402/fetch';
 *
 *   const paying = wrapFetchWithPayment(fetch, client);           // your x402 payer
 *   const safe   = wrapFetchWithReliabilityGuard(paying, { mnemonic, minScore: 90 });
 *   await safe('https://some-x402-endpoint/api');                 // checked, then paid
 *
 * The guard's own oracle call is paid via x402, so `mnemonic` must be a funded,
 * USDC-opted-in account. The oracle endpoint is never guarded (so it can't recurse).
 */
export function wrapFetchWithReliabilityGuard(
  innerFetch: typeof fetch,
  opts: GuardOptions,
): typeof fetch {
  if (!opts?.mnemonic) throw new Error('wrapFetchWithReliabilityGuard: `mnemonic` is required.');
  const minScore = opts.minScore ?? 90;
  const mode = opts.mode ?? 'block';
  const cacheTtlMs = opts.cacheTtlMs ?? 15 * 60 * 1000;
  const onUnknown = opts.onUnknown ?? 'allow';
  const onError = opts.onError ?? 'allow';
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const client = new HosannaithClient({ mnemonic: opts.mnemonic, baseUrl });
  const cache = new Map<string, { result: ReliabilityResult; expires: number }>();

  const urlOf = (input: RequestInfo | URL): string =>
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);

    // Never guard the oracle itself (would recurse), and honour the caller's filter.
    if (url.startsWith(baseUrl) || (opts.shouldGuard && !opts.shouldGuard(url, init))) {
      return innerFetch(input as RequestInfo, init);
    }

    let decision: GuardDecision;
    try {
      const now = Date.now();
      const hit = cache.get(url);
      let result: ReliabilityResult;
      let cached = false;
      if (hit && hit.expires > now) {
        result = hit.result;
        cached = true;
      } else {
        result = await client.getReliability(url);
        cache.set(url, { result, expires: now + cacheTtlMs });
      }
      const confidence = result.detail?.confidence ?? null;
      let allow: boolean;
      let reason: string;
      if (result.status === 'unknown') {
        allow = onUnknown === 'allow';
        reason = `too little data (unknown) — ${allow ? 'allowed' : 'blocked'}`;
      } else if (typeof result.score === 'number' && result.score >= minScore) {
        allow = true;
        reason = `score ${result.score} >= minScore ${minScore} (${result.status})`;
      } else {
        allow = false;
        reason = `score ${result.score ?? 'n/a'} < minScore ${minScore} (${result.status})`;
      }
      decision = { url, allow, status: result.status, score: result.score, confidence, reason, cached };
    } catch (err) {
      const allow = onError === 'allow';
      decision = {
        url,
        allow,
        status: 'unknown',
        score: null,
        confidence: null,
        reason: `reliability check failed — ${allow ? 'allowed (fail-open)' : 'blocked (fail-closed)'}`,
        cached: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    opts.onDecision?.(decision);

    if (!decision.allow) {
      if (mode === 'block') throw new ReliabilityGuardError(decision);
      console.warn(`[hosannaith guard] ${decision.reason} — proceeding (warn mode): ${url}`);
    }

    return innerFetch(input as RequestInfo, init);
  }) as typeof fetch;
}
