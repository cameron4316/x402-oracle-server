// Standalone monitor process:  pnpm monitor
// Run this SEPARATELY from the API so your observation history keeps accruing even while you
// restart/iterate on the paid server. This is the time-critical, can't-be-backfilled piece —
// start it as early as possible and keep it running.
import { CONFIG } from './config.js';
import { startMonitor } from './checks/reliability/monitor.js';
import { reliabilityStore, reliabilityTargetRegistry } from './checks/reliability/index.js';

console.log(
  `[monitor] starting — ${CONFIG.monitorTargets.length} configured target(s) plus any enrolled ` +
    `on-demand, every ${CONFIG.monitorIntervalSeconds}s`,
);
console.log(`[monitor] writing to ${CONFIG.observationLog}`);
startMonitor({
  targets: () => reliabilityTargetRegistry.list(),
  intervalSeconds: CONFIG.monitorIntervalSeconds,
  store: reliabilityStore,
});
