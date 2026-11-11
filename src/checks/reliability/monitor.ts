import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Observation, ObservationStore } from './store.js';
import { checkTarget, isRefusedAddress } from './target-url.js';
import { decodePaymentRequiredHeader, summarizeRequirements } from './x402-network.js';

type ProbeMethod = 'GET' | 'POST';
// Most x402 resources are GET, but many only serve POST and would answer a GET with 404/405 —
// scoring those as "no payment demanded" would be wrong. So probe GET first; if it doesn't return
// a 402, try POST. A healthy x402 endpoint answers an unpaid request with 402 on the method it
// serves. We never send a request body, so a well-gated endpoint returns 402 before doing any work.
const PROBE_METHODS: ProbeMethod[] = ['GET', 'POST'];

// Redirects are followed by hand (same rules as fetch: 303, and 301/302 after a POST, continue as
// GET) so that every hop can be checked: a public endpoint must not be able to bounce a probe to our
// own machine or a private network, and neither may a host name that resolves to one.
const MAX_REDIRECTS = 10;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
// x402 v1 puts the payment requirements in a JSON body; only this much of it is read.
const MAX_V1_BODY_BYTES = 64 * 1024;

class RefusedHopError extends Error {}

/** Resolves a host name to its addresses (tests pass their own). */
export type Resolver = (host: string) => Promise<Array<{ address: string }>>;
const systemResolver: Resolver = (host) => lookup(host, { all: true, verbatim: true });

/** Refuses a URL the target rules reject, or whose host currently resolves to a refused address. */
async function assertProbeable(url: string, resolve: Resolver, signal: AbortSignal): Promise<void> {
  const checked = checkTarget(url);
  if (!checked.ok) throw new RefusedHopError(`refused: ${checked.reason}`);
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return; // literal addresses were already checked above
  let addresses: Array<{ address: string }>;
  try {
    // The probe's timeout covers resolution too: a slow resolver must not hold a tick past it.
    addresses = await Promise.race([
      resolve(host),
      new Promise<never>((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    ]);
  } catch {
    // Unresolvable (or timed out): let fetch fail, or abort, exactly as it always has.
    signal.throwIfAborted();
    return;
  }
  if (addresses.some((a) => isRefusedAddress(a.address))) {
    throw new RefusedHopError('refused: host resolves to a private or reserved address');
  }
}

async function readCapped(res: Response, max: number): Promise<string | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) return null;
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** What a 402 said about payment: v2 PAYMENT-REQUIRED header first, then a v1 JSON body. */
async function paymentRequirements(res: Response) {
  let summary = summarizeRequirements(decodePaymentRequiredHeader(res.headers.get('payment-required')));
  if (!summary.parsed && /json/i.test(res.headers.get('content-type') ?? '')) {
    const text = await readCapped(res, MAX_V1_BODY_BYTES);
    if (text) {
      try {
        summary = summarizeRequirements(JSON.parse(text));
      } catch {
        // not JSON after all: stays unparsed
      }
    }
  }
  return {
    paymentRequiredParsed: summary.parsed,
    x402Version: summary.x402Version,
    acceptedNetworks: summary.acceptedNetworks,
    hasBazaarExtension: summary.hasBazaarExtension,
  };
}

async function probeOnce(target: string, method: ProbeMethod, timeoutMs: number, resolve: Resolver): Promise<Observation> {
  const at = new Date().toISOString();
  // Latency counts only time spent in fetch (every hop), not our own DNS checks, so it stays
  // comparable with observations recorded before redirects were followed by hand.
  let latencyMs = 0;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let url = target;
  let currentMethod: ProbeMethod = method;
  let redirects = 0;
  try {
    for (;;) {
      await assertProbeable(url, resolve, controller.signal);
      controller.signal.throwIfAborted();
      const hopStarted = Date.now();
      const res = await fetch(url, { method: currentMethod, redirect: 'manual', signal: controller.signal });
      latencyMs += Date.now() - hopStarted;
      const location = res.headers.get('location');
      if (REDIRECT_STATUSES.has(res.status) && location) {
        void res.body?.cancel().catch(() => {});
        if (++redirects > MAX_REDIRECTS) throw new Error('too many redirects');
        url = new URL(location, url).href;
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && currentMethod === 'POST')) {
          currentMethod = 'GET';
        }
        continue;
      }
      const extra = res.status === 402 ? await paymentRequirements(res) : {};
      void res.body?.cancel().catch(() => {});
      return {
        target,
        at,
        reachable: true,
        httpStatus: res.status,
        demandedPayment: res.status === 402,
        latencyMs,
        ...extra,
        ...(redirects > 0 ? { redirects } : {}),
      };
    }
  } catch (err) {
    return {
      target,
      at,
      reachable: false,
      httpStatus: null,
      demandedPayment: false,
      latencyMs: null,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

// Probe an x402 endpoint WITHOUT paying. Tries GET, then POST only if GET didn't yield a 402
// (so GET endpoints cost exactly one request). Returns the attempt that correctly demanded
// payment; otherwise the most informative attempt (preferring a reachable one).
export async function probe(target: string, timeoutMs = 10_000, resolve: Resolver = systemResolver): Promise<Observation> {
  let fallback: Observation | null = null;
  for (const method of PROBE_METHODS) {
    const obs = await probeOnce(target, method, timeoutMs, resolve);
    if (obs.demandedPayment) return obs;
    if (obs.error?.startsWith('refused:')) return obs; // same answer for any method
    if (!fallback || (obs.reachable && !fallback.reachable)) fallback = obs;
  }
  return fallback!;
}

// Runs forever: probe every target on an interval and append each observation.
// `targets` may be a static list or an async getter re-invoked each tick — the latter lets the
// target set grow at runtime (e.g. targets enrolled on-demand by the paid check) without the
// monitor process needing to be told directly.
export function startMonitor(opts: {
  targets: string[] | (() => Promise<string[]>);
  intervalSeconds: number;
  store: ObservationStore;
  /** DNS resolver for probes (tests pass a fake one; production uses the system resolver). */
  resolve?: Resolver;
}): () => void {
  const { targets, intervalSeconds, store, resolve = systemResolver } = opts;
  const getTargets = typeof targets === 'function' ? targets : async () => targets;
  let stopped = false;
  // Guards against overlapping ticks: if probing every target (each up to a 10s timeout) ever
  // takes longer than intervalSeconds, a naive setInterval would fire a second, overlapping tick
  // — producing duplicate/out-of-order observations that skew uptime and latency stats.
  let ticking = false;

  async function tick(): Promise<void> {
    if (ticking) {
      console.warn('[monitor] previous tick still in progress — skipping this interval to avoid overlap.');
      return;
    }
    ticking = true;
    try {
      const all = await getTargets();
      // Never probe a target the rules refuse (target-url.ts), even if one got into the list.
      const currentTargets = all.filter((t) => checkTarget(t).ok);
      if (currentTargets.length < all.length) {
        console.warn(`[monitor] skipping ${all.length - currentTargets.length} refused target(s)`);
      }
      if (currentTargets.length === 0) {
        console.warn('[monitor] no targets configured — nothing to observe yet.');
      }
      for (const target of currentTargets) {
        const obs = await probe(target, undefined, resolve);
        await store.append(obs);
        console.log(
          `[monitor] ${obs.at} ${target} reachable=${obs.reachable} ` +
            `status=${obs.httpStatus ?? '-'} latency=${obs.latencyMs ?? '-'}ms`,
        );
      }
    } finally {
      ticking = false;
    }
  }

  void tick(); // fire immediately so data starts now
  const handle = setInterval(() => {
    if (!stopped) void tick();
  }, intervalSeconds * 1000);

  return () => {
    stopped = true;
    clearInterval(handle);
  };
}
