import type { Observation, ObservationStore } from './store.js';

// Probe an x402 endpoint WITHOUT paying. A healthy paid endpoint should answer an unpaid
// GET with HTTP 402 Payment Required. We record exactly what happened — no smoothing.
export async function probe(target: string, timeoutMs = 10_000): Promise<Observation> {
  const at = new Date().toISOString();
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(target, { method: 'GET', signal: controller.signal });
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
