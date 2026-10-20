// report.ts — read-only reliability report for every monitored target.
// No payment, no HTTP server, reads your local observation history only.
//     node_modules/.bin/tsx report.ts
import { reliabilityCheck, reliabilityTargetRegistry } from './src/checks/reliability/index.js';

const targets = await reliabilityTargetRegistry.list();
const rows: Array<{ target: string; status: string; score: number | null; detail: any }> = [];

for (const t of targets) {
  const r = await reliabilityCheck.run(t);
  rows.push({ target: t, status: r.status, score: r.score, detail: r.detail });
}

rows.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));

console.log(`\nHosannaith reliability report — ${rows.length} targets — ${new Date().toISOString()}\n`);
for (const { target, status, score, detail } of rows) {
  const s = (score ?? '—').toString().padStart(5);
  console.log(
    `${s}  ${status.padEnd(8)}  ` +
      `up=${detail.uptimePct ?? '—'}%  402=${detail.correct402Pct ?? '—'}%  ` +
      `p50=${detail.p50LatencyMs ?? '—'}ms  p95=${detail.p95LatencyMs ?? '—'}ms  ` +
      `n=${String(detail.observations).padStart(4)}  ${detail.confidence.padEnd(8)}  ${target}`,
  );
}
console.log('');
