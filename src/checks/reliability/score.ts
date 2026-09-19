import type { Observation } from './store.js';

export interface ReliabilitySummary {
  observations: number;
  windowHours: number;
  uptimePct: number | null; // % of probes reachable
  correct402Pct: number | null; // % of probes that correctly demanded payment
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  score: number | null; // 0-100 composite; null when not enough data to stand behind
  firstObservedAt: string | null;
  lastObservedAt: string | null;
}

// Don't emit a score we can't stand behind. Tune as your history grows.
const MIN_OBSERVATIONS = 5;

export function summarize(obs: Observation[], windowHours: number): ReliabilitySummary {
  if (obs.length === 0) return emptySummary(windowHours);

  const reachable = obs.filter((o) => o.reachable);
  const uptimePct = pct(reachable.length, obs.length);
  const correct402Pct = pct(obs.filter((o) => o.demandedPayment).length, obs.length);
  const latencies = reachable
    .map((o) => o.latencyMs)
    .filter((n): n is number => typeof n === 'number')
    .sort((a, b) => a - b);
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);

  let score: number | null = null;
  if (obs.length >= MIN_OBSERVATIONS && uptimePct !== null && correct402Pct !== null) {
    const latencyPenalty = p95 === null ? 0 : Math.min(20, p95 / 100); // up to -20 for slow
    score = clamp(0, 100, 0.6 * uptimePct + 0.4 * correct402Pct - latencyPenalty);
    score = Math.round(score * 10) / 10;
  }

  return {
    observations: obs.length,
    windowHours,
    uptimePct,
    correct402Pct,
    p50LatencyMs: p50,
    p95LatencyMs: p95,
    score,
    firstObservedAt: obs[0]?.at ?? null,
    lastObservedAt: obs[obs.length - 1]?.at ?? null,
  };
}

function emptySummary(windowHours: number): ReliabilitySummary {
  return {
    observations: 0,
    windowHours,
    uptimePct: null,
    correct402Pct: null,
    p50LatencyMs: null,
    p95LatencyMs: null,
    score: null,
    firstObservedAt: null,
    lastObservedAt: null,
  };
}

const pct = (n: number, d: number): number | null => (d === 0 ? null : Math.round((n / d) * 1000) / 10);
const clamp = (lo: number, hi: number, v: number): number => Math.max(lo, Math.min(hi, v));
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}
