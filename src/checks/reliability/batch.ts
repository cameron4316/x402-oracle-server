import type { CheckResult } from '../types.js';
import { summarize, statusFromScore } from './score.js';
import { reliabilityStore, reliabilityTargetRegistry } from './index.js';

const DEFAULT_WINDOW_HOURS = 24;

// Max targets scored per paid batch call. History-only reads are cheap, so this is a
// value/abuse bound, not a performance one — one $7 call shouldn't score thousands.
export const MAX_BATCH_TARGETS = 50;

export interface BatchResult {
  results: CheckResult[];
  count: number; // how many were scored (after dedupe + cap)
  requested: number; // how many the caller sent
  capped: boolean; // true if we scored fewer than requested (over the cap)
  observedAt: string;
}

// Score many x402 endpoints in one paid call. HISTORY-ONLY by design: a monitored target gets its
// full score; a target with no history yet is returned `unknown` and ENROLLED for monitoring (no
// inline live probe — a 50-target batch must not fan out into 50 slow probes). The single
// GET /reliability keeps its probe-a-new-target behaviour for one-offs.
export async function reliabilityBatch(rawTargets: unknown[]): Promise<BatchResult> {
  const windowMs = DEFAULT_WINDOW_HOURS * 3600 * 1000;
  const requested = rawTargets.length;

  // Clean: keep strings, trim, drop blanks, dedupe, cap.
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const raw of rawTargets) {
    if (typeof raw !== 'string') continue;
    const url = raw.trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    targets.push(url);
    if (targets.length >= MAX_BATCH_TARGETS) break;
  }

  const results: CheckResult[] = [];
  for (const target of targets) {
    const obs = await reliabilityStore.readForTarget(target, windowMs);
    if (obs.length === 0) {
      // No history yet: start monitoring it, return `unknown` now (no inline probe).
      await reliabilityTargetRegistry.enroll(target);
      results.push({
        target,
        checkId: 'reliability',
        status: 'unknown',
        score: null,
        detail: { observations: 0, windowHours: DEFAULT_WINDOW_HOURS, confidence: 'pending' },
        observedAt: new Date().toISOString(),
      });
      continue;
    }
    const summary = summarize(obs, DEFAULT_WINDOW_HOURS);
    results.push({
      target,
      checkId: 'reliability',
      status: statusFromScore(summary.score),
      score: summary.score,
      detail: { ...summary, confidence: 'history' },
      observedAt: new Date().toISOString(),
    });
  }

  return {
    results,
    count: results.length,
    requested,
    capped: requested > MAX_BATCH_TARGETS,
    observedAt: new Date().toISOString(),
  };
}
