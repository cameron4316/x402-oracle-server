// src/export-probes.ts — per-probe export for one endpoint over one UTC day (or an explicit window).
// Built for cross-monitor comparisons (e.g. reconciling another monitor's daily verdict against our
// ~3-minute probes): when they disagree with us on an endpoint for a day, this dumps exactly what we
// saw, probe by probe, so the disagreement is settled on timestamps rather than opinions.
// READ-ONLY (streams the observation log); safe to run anytime; never touches the monitor.
//
// Usage:
//   node_modules/.bin/tsx src/export-probes.ts --target <url> --day 2026-11-01          # one UTC day
//   node_modules/.bin/tsx src/export-probes.ts --target <url> --from <ISO> --to <ISO>    # explicit window
//   --all            include every probe (default: non-OK probes only, plus the summary)
//   --out <file>     write JSON to a file instead of stdout
//   --log <path>     observation log path (default ./data/observations.jsonl)
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import type { Observation } from './checks/reliability/store.js';

type Klass = 'ok' | 'down' | 'ungated' | 'indeterminate';

// Same P0 rules as score.ts / report.ts: down = unreachable or 5xx; ok = 402; ungated = 2xx served
// unpaid; everything else (400 needs-input, 401/403, 404/405, 429, ...) = indeterminate (not scored).
function classify(o: Observation): Klass {
  if (!o.reachable || (o.httpStatus != null && o.httpStatus >= 500)) return 'down';
  if (o.httpStatus === 402) return 'ok';
  if (o.httpStatus != null && o.httpStatus >= 200 && o.httpStatus < 300) return 'ungated';
  return 'indeterminate';
}

function fail(msg: string): never {
  console.error('export-probes: ' + msg);
  process.exit(2);
}

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (k: string) => {
    const i = a.indexOf(k);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const target = get('--target');
  const day = get('--day');
  const from = get('--from');
  const to = get('--to');
  const out = get('--out');
  const log = get('--log') ?? './data/observations.jsonl';
  const all = a.includes('--all');
  if (!target) fail('--target <url> is required');
  let fromMs: number;
  let toMs: number;
  if (day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) fail('--day must be YYYY-MM-DD (UTC)');
    fromMs = Date.parse(day + 'T00:00:00Z');
    toMs = fromMs + 86_400_000;
  } else if (from && to) {
    fromMs = Date.parse(from);
    toMs = Date.parse(to);
    if (Number.isNaN(fromMs) || Number.isNaN(toMs) || toMs <= fromMs) fail('--from/--to must be ISO timestamps with to > from');
  } else {
    fail('give --day YYYY-MM-DD or --from <ISO> --to <ISO>');
  }
  return { target: target!, fromMs: fromMs!, toMs: toMs!, out, log, all };
}

const pct = (n: number, d: number): number | null => (d === 0 ? null : Math.round((n / d) * 1000) / 10);
function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function main(): Promise<void> {
  const { target, fromMs, toMs, out, log, all } = parseArgs();
  const probes: Array<Observation & { class: Klass }> = [];
  let rl: ReturnType<typeof createInterface>;
  try {
    rl = createInterface({ input: createReadStream(log, { encoding: 'utf8' }), crlfDelay: Infinity });
  } catch {
    fail(`cannot open ${log}`);
  }
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let o: Observation;
      try {
        o = JSON.parse(line) as Observation;
      } catch {
        continue;
      }
      if (o.target !== target) continue;
      const t = Date.parse(o.at);
      if (t < fromMs || t >= toMs) continue;
      probes.push({ ...o, class: classify(o) });
    }
  } catch (e) {
    fail(`read error: ${(e as Error).message}`);
  }
  probes.sort((x, y) => x.at.localeCompare(y.at));

  const count = (k: Klass) => probes.filter((p) => p.class === k).length;
  const serving = probes.filter((p) => p.class !== 'down');
  const gated = count('ok');
  const ungated = count('ungated');
  const lat = serving
    .map((p) => p.latencyMs)
    .filter((n): n is number => typeof n === 'number')
    .sort((a, b) => a - b);

  const summary = {
    probes: probes.length,
    ok402: gated,
    down: count('down'),
    ungated2xx: ungated,
    indeterminate: count('indeterminate'),
    uptimePct: pct(serving.length, probes.length),
    correct402Pct: pct(gated, gated + ungated), // null when there is no determinate signal (as in score.ts)
    p50LatencyMs: percentile(lat, 50),
    p95LatencyMs: percentile(lat, 95),
    p99LatencyMs: percentile(lat, 99),
    firstProbe: probes[0]?.at ?? null,
    lastProbe: probes[probes.length - 1]?.at ?? null,
  };

  const events = (all ? probes : probes.filter((p) => p.class !== 'ok')).map((p) => ({
    at: p.at,
    class: p.class,
    httpStatus: p.httpStatus,
    reachable: p.reachable,
    latencyMs: p.latencyMs,
    ...(p.error ? { error: p.error } : {}),
  }));

  const result = {
    target,
    window_utc: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
    method:
      'Hosannaith continuous scheduled probes (unpaid GET, then POST if no 402). Classes per P0 rules: ' +
      'down = unreachable or 5xx; ok = 402; ungated = 2xx served unpaid; indeterminate = other 4xx (not scored).',
    summary,
    events_listed: all ? 'all probes' : 'non-OK probes only (use --all for every probe)',
    events,
  };

  const json = JSON.stringify(result, null, 2);
  if (out) {
    await writeFile(out, json + '\n', 'utf8');
    console.error(`export-probes: ${events.length} event(s) from ${probes.length} probe(s) -> ${out}`);
  } else {
    console.log(json);
  }
}

main().catch((e) => fail((e as Error).message));
