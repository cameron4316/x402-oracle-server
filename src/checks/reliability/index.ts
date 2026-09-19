import { dirname, join } from 'node:path';
import type { Check, CheckResult } from '../types.js';
import { JsonlObservationStore } from './store.js';
import { summarize } from './score.js';
import { probe } from './monitor.js';
import { TargetRegistry } from './targets.js';
import { CONFIG } from '../../config.js';

// Single shared store instance — the monitor writes to it, the paid check reads from it.
const store = new JsonlObservationStore(CONFIG.observationLog);
// File-backed registry so a target queried on-demand (below) gets picked up by the separate
// monitor process too — see targets.ts for why this isn't just an in-memory list.
const targetRegistry = new TargetRegistry(
  join(dirname(CONFIG.observationLog), 'targets.json'),
  CONFIG.monitorTargets,
);
const DEFAULT_WINDOW_HOURS = 24;

export const reliabilityCheck: Check = {
  id: 'reliability',
  describe() {
    return (
      'Reliability score (0-100) for an x402 endpoint: uptime, correct 402 behaviour, and latency ' +
      'percentiles from continuous independent monitoring. Returns the score plus supporting stats. ' +
      'A target with no monitoring history yet gets one immediate live probe instead (see the ' +
      "detail.confidence field — 'history' vs 'one-shot') and is enrolled for ongoing monitoring."
    );
  },
  async run(target: string): Promise<CheckResult> {
    const windowMs = DEFAULT_WINDOW_HOURS * 3600 * 1000;
    let obs = await store.readForTarget(target, windowMs);
    let confidence: 'history' | 'one-shot' = 'history';

    if (obs.length === 0) {
      // Nothing observed for this target yet: take one live reading now rather than charging
      // for an "unknown" result, and enroll it so continuous history starts compounding from
      // here on. A single probe can't support a stood-behind score (see MIN_OBSERVATIONS in
      // score.ts) — that's expected and surfaced via `confidence` below, not hidden.
      confidence = 'one-shot';
      const liveObs = await probe(target);
      await store.append(liveObs);
      await targetRegistry.enroll(target);
      obs = [liveObs];
    }

    const summary = summarize(obs, DEFAULT_WINDOW_HOURS);
    const status: CheckResult['status'] =
      summary.score === null
        ? 'unknown'
        : summary.score >= 90
          ? 'pass'
          : summary.score >= 60
            ? 'degraded'
            : 'fail';
    return {
      target,
      checkId: 'reliability',
      status,
      score: summary.score,
      detail: { ...summary, confidence },
      observedAt: new Date().toISOString(),
    };
  },
};

export { store as reliabilityStore, targetRegistry as reliabilityTargetRegistry };
