// Standalone monitor process:  pnpm monitor
// Run this SEPARATELY from the API so your observation history keeps accruing even while you
// restart/iterate on the paid server. This is the time-critical, can't-be-backfilled piece —
// start it as early as possible and keep it running.
import { CONFIG } from './config.js';
import { startMonitor } from './checks/reliability/monitor.js';
import { pinnedDispatcher } from './checks/reliability/pinned-fetch.js';
import { reliabilityStore, reliabilityTargetRegistry } from './checks/reliability/index.js';

console.log(
  `[monitor] starting — ${CONFIG.monitorTargets.length} configured target(s) plus any enrolled ` +
    `on-demand, every ${CONFIG.monitorIntervalSeconds}s`,
);
console.log(`[monitor] writing to ${CONFIG.observationLog}`);
// Refuse to start if probe connections cannot be pinned to the addresses that were checked
// (pinned-fetch.ts): better no observations than probes that could be steered to a private address.
await pinnedDispatcher();
startMonitor({
  targets: () => reliabilityTargetRegistry.list(),
  intervalSeconds: CONFIG.monitorIntervalSeconds,
  store: reliabilityStore,
});
