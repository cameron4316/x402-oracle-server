import type { Observation, ObservationStore } from './store.js';

type ProbeMethod = 'GET' | 'POST';
// Most x402 resources are GET, but many only serve POST and would answer a GET with 404/405 —
// scoring those as "no payment demanded" would be wrong. So probe GET first; if it doesn't return
// a 402, try POST. A healthy x402 endpoint answers an unpaid request with 402 on the method it
// serves. We never send a request body, so a well-gated endpoint returns 402 before doing any work.
const PROBE_METHODS: ProbeMethod[] = ['GET', 'POST'];

async function probeOnce(target: string, method: ProbeMethod, timeoutMs: number): Promise<Observation> {
  const at = new Date().toISOString();
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(target, { method, signal: controller.signal });
    const latencyMs = Date.now() - started;
    return {
      target,
      at,
      reachable: true,
      httpStatus: res.status,
      demandedPayment: res.status === 402,
      latencyMs,
    };
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
export async function probe(target: string, timeoutMs = 10_000): Promise<Observation> {
  let fallback: Observation | null = null;
  for (const method of PROBE_METHODS) {
    const obs = await probeOnce(target, method, timeoutMs);
    if (obs.demandedPayment) return obs;
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
}): () => void {
  const { targets, intervalSeconds, store } = opts;
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
      const currentTargets = await getTargets();
      if (currentTargets.length === 0) {
        console.warn('[monitor] no targets configured — nothing to observe yet.');
      }
      for (const target of currentTargets) {
        const obs = await probe(target);
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
