// src/report.ts — per-endpoint reliability report-card generator (Phase 0, §3.1).
// Reads the live observation log and emits one markdown + json report per monitored target.
// Reuses summarize() so every number matches the live /reliability score exactly.
// READ-ONLY: never writes to the observation log and never touches the monitor — safe to run anytime.
//
// Usage (note the `--` so pnpm passes the flags through):
//   pnpm report                          # all targets, default 7-day window
//   pnpm report -- --target <url>        # one target
//   pnpm report -- --window 14d          # custom window (Nd or Nh)
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { CONFIG } from './config.js';
import { summarize, statusFromScore, type ReliabilitySummary } from './checks/reliability/score.js';
import type { Observation } from './checks/reliability/store.js';

const REPORTS_DIR = join(process.cwd(), 'reports');
const LATENCY_SPIKE_FACTOR = 2; // flag a probe whose latency > p95 * this ...
const SPIKE_FLOOR_MS = 1500; // ... and also above this absolute floor (so healthy fast endpoints stay quiet)
const SUSTAINED_MIN_PROBES = 2; // a real outage = 2+ consecutive failed probes; a single probe = transient blip
const DEFAULT_WINDOW_HOURS = 24 * 7; // 7 days
const MIN_OBS_FOR_HISTORY = 5; // matches MIN_OBSERVATIONS in score.ts

function parseArgs(): { target?: string; windowHours: number } {
  const a = process.argv.slice(2);
  let target: string | undefined;
  let windowHours = DEFAULT_WINDOW_HOURS;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--target') target = a[++i];
    else if (a[i] === '--window') {
      const m = /^(\d+)([dh])$/.exec((a[++i] ?? '').trim());
      if (m) windowHours = Number(m[1]) * (m[2] === 'd' ? 24 : 1);
    }
  }
  return { target, windowHours };
}

// Stable key for an endpoint URL — reused by the scorecard route and (later) the on-chain registry.
export function endpointKey(url: string): string {
  let canon = url.trim();
  try {
    const u = new URL(canon);
    u.protocol = u.protocol.toLowerCase();
    u.hostname = u.hostname.toLowerCase();
    if (u.pathname === '/') u.pathname = '';
    canon = u.toString();
  } catch {
    /* not a URL — hash the raw string */
  }
  return createHash('sha256').update(canon).digest('hex').slice(0, 12);
}

async function readAll(): Promise<Observation[]> {
  let raw: string;
  try {
    raw = await readFile(CONFIG.observationLog, 'utf8');
  } catch {
    return [];
  }
  const out: Observation[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Observation);
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

// Matches the P0 scoring model: down = unreachable or 5xx; ungated = served a 2xx unpaid (no 402);
// 402 = ok; 400/other-4xx = indeterminate (NOT an incident — the probe just couldn't test gating).
function classify(o: Observation): 'down' | 'ungated' | 'ok' | 'indeterminate' {
  if (!o.reachable || (o.httpStatus != null && o.httpStatus >= 500)) return 'down';
  if (o.httpStatus === 402) return 'ok';
  if (o.httpStatus != null && o.httpStatus >= 200 && o.httpStatus < 300) return 'ungated';
  return 'indeterminate';
}

type Sustained = { kind: 'down' | 'ungated'; start: string; end: string; durationMin: number; probes: number };
type Spike = { at: string; latencyMs: number };

// Distinguish a SUSTAINED outage (>=2 consecutive failed probes — a real incident with a duration)
// from a TRANSIENT blip (a single failed probe, usually a timeout/5xx under latency load). Counting
// every single-probe failure as an "incident" overstates problems and destroys credibility.
function extractIncidents(obs: Observation[]): { sustained: Sustained[]; transientDown: number; transientUngated: number } {
  const sustained: Sustained[] = [];
  let transientDown = 0;
  let transientUngated = 0;
  let run: { kind: 'down' | 'ungated'; items: Observation[] } | null = null;
  const flush = () => {
    if (!run) return;
    if (run.items.length >= SUSTAINED_MIN_PROBES) {
      const first = run.items[0];
      const last = run.items[run.items.length - 1];
      const durationMin = Math.round((new Date(last.at).getTime() - new Date(first.at).getTime()) / 60000);
      sustained.push({ kind: run.kind, start: first.at, end: last.at, durationMin, probes: run.items.length });
    } else if (run.kind === 'down') {
      transientDown++;
    } else {
      transientUngated++;
    }
    run = null;
  };
  for (const o of obs) {
    const c = classify(o);
    if (c === 'down' || c === 'ungated') {
      if (run && run.kind === c) run.items.push(o);
      else {
        flush();
        run = { kind: c, items: [o] };
      }
    } else {
      flush();
    }
  }
  flush();
  return { sustained, transientDown, transientUngated };
}

function extractSpikes(obs: Observation[], p95: number | null): Spike[] {
  if (p95 == null) return [];
  const threshold = Math.max(p95 * LATENCY_SPIKE_FACTOR, SPIKE_FLOOR_MS);
  return obs
    .filter((o) => typeof o.latencyMs === 'number' && (o.latencyMs as number) > threshold)
    .map((o) => ({ at: o.at, latencyMs: o.latencyMs as number }));
}

// One honest sentence on what is dragging the score down — so the headline matches the data.
// When there is no score, say WHY accurately: a 0%-uptime endpoint is DOWN, not "needs input".
function scoreDriver(s: ReliabilitySummary): string {
  if (s.score == null) {
    if (s.observations < MIN_OBS_FOR_HISTORY) return `Not enough observations yet to score (${s.observations} so far).`;
    if (s.uptimePct === 0) return 'Appears down — returned a server error (5xx) or was unreachable on every probe in the window.';
    if (s.uptimePct != null && s.uptimePct < 90)
      return `Frequently unavailable — down on ${Math.round(100 - s.uptimePct)}% of probes; too little determinate gating signal to score.`;
    return 'Not enough gating-determinate data to score — the endpoint likely needs valid input (returns 4xx to a bare probe).';
  }
  const parts: Array<[string, number, string]> = [
    ['downtime', s.uptimePct == null ? 0 : 0.6 * (100 - s.uptimePct), `${s.uptimePct}% uptime`],
    ['402 non-compliance', s.correct402Pct == null ? 0 : 0.4 * (100 - s.correct402Pct), `${s.correct402Pct}% correct-402`],
    ['latency', s.p95LatencyMs == null ? 0 : Math.min(20, s.p95LatencyMs / 100), `p95 ${s.p95LatencyMs} ms`],
  ];
  parts.sort((a, b) => b[1] - a[1]);
  if (parts[0][1] < 1) return 'Healthy across uptime, 402 behaviour, and latency.';
  return `Score driven down mainly by **${parts[0][0]}** (${parts[0][2]}).`;
}

// Report-only display status: the shared statusFromScore() returns "unknown" for a null score, but a
// card for an endpoint that was down on every probe should read DOWN, not UNKNOWN. (Does not touch the
// paid API's statusFromScore — presentation only.)
function displayStatus(s: ReliabilitySummary): string {
  if (s.score == null && s.uptimePct === 0) return 'DOWN';
  return statusFromScore(s.score).toUpperCase();
}

function toMarkdown(
  target: string,
  key: string,
  s: ReliabilitySummary,
  inc: { sustained: Sustained[]; transientDown: number; transientUngated: number },
  spikes: Spike[],
): string {
  const status = displayStatus(s);
  const since = s.firstObservedAt ? s.firstObservedAt.slice(0, 10) : '—';
  const confidence = s.observations >= MIN_OBS_FOR_HISTORY ? 'history' : 'one-shot';
  const L: string[] = [];
  L.push(`# Reliability report — ${target}`);
  L.push('');
  L.push(`**Status:** ${status}  ·  **Score:** ${s.score ?? 'n/a'}/100  ·  **Confidence:** ${confidence}`);
  L.push(scoreDriver(s));
  L.push(`Monitored by Hosannaith since ${since} · window ${s.windowHours}h · ${s.observations} probes · key \`${key}\``);
  L.push('');
  L.push('| Metric | Value |');
  L.push('| --- | --- |');
  L.push(`| Uptime | ${s.uptimePct ?? '—'}% |`);
  L.push(`| Correct-402 | ${s.correct402Pct ?? '—'}% |`);
  L.push(`| Latency p50 | ${s.p50LatencyMs ?? '—'} ms |`);
  L.push(`| Latency p95 | ${s.p95LatencyMs ?? '—'} ms |`);
  L.push('');
  L.push(`## Sustained outages (${inc.sustained.length})`);
  if (inc.sustained.length === 0) {
    L.push('None — no outage lasting 2+ consecutive probes. ✅');
  } else {
    for (const i of inc.sustained) {
      const label = i.kind === 'down' ? 'DOWN / 5xx' : 'Served unpaid (no 402 demanded)';
      L.push(`- **${label}** — ${i.start} → ${i.end} (**${i.durationMin} min**, ${i.probes} consecutive probes)`);
    }
  }
  L.push('');
  const tTotal = inc.transientDown + inc.transientUngated;
  L.push(`## Transient errors (${tTotal})`);
  if (tTotal === 0) {
    L.push('None.');
  } else {
    const bits: string[] = [];
    if (inc.transientDown) bits.push(`${inc.transientDown} single-probe 5xx / unreachable`);
    if (inc.transientUngated) bits.push(`${inc.transientUngated} single-probe served-unpaid`);
    L.push(`${bits.join(', ')} — isolated blips (one failed probe each), typically a timeout under latency load.`);
  }
  L.push('');
  L.push(`## Latency spikes (${spikes.length}, > ${LATENCY_SPIKE_FACTOR}× p95 and > ${SPIKE_FLOOR_MS} ms)`);
  if (spikes.length === 0) {
    L.push('None.');
  } else {
    for (const sp of spikes.slice(0, 15)) L.push(`- ${sp.at} — ${sp.latencyMs} ms`);
    if (spikes.length > 15) L.push(`- …and ${spikes.length - 15} more`);
  }
  L.push('');
  L.push('_Every figure above is reproducible from the raw observation log. Generated by Hosannaith._');
  return L.join('\n');
}

async function main(): Promise<void> {
  const { target, windowHours } = parseArgs();
  const all = await readAll();
  const cutoff = Date.now() - windowHours * 3600 * 1000;
  const inWindow = all.filter((o) => new Date(o.at).getTime() >= cutoff);

  const targets = target ? [target] : [...new Set(inWindow.map((o) => o.target))].sort();
  if (targets.length === 0) {
    console.error('No observations in window. Is the monitor running and has it accrued data?');
    process.exit(1);
  }

  await mkdir(REPORTS_DIR, { recursive: true });
  for (const t of targets) {
    const obs = inWindow.filter((o) => o.target === t).sort((a, b) => a.at.localeCompare(b.at));
    const s = summarize(obs, windowHours);
    const inc = extractIncidents(obs);
    const spikes = extractSpikes(obs, s.p95LatencyMs);
    const key = endpointKey(t);
    await writeFile(join(REPORTS_DIR, `${key}.md`), toMarkdown(t, key, s, inc, spikes), 'utf8');
    await writeFile(
      join(REPORTS_DIR, `${key}.json`),
      JSON.stringify(
        { target: t, endpointKey: key, generatedAt: new Date().toISOString(), status: displayStatus(s), summary: s, ...inc, spikes },
        null,
        2,
      ),
      'utf8',
    );
    console.log(
      `${displayStatus(s).padEnd(9)} score=${String(s.score ?? 'n/a').padStart(5)} ` +
        `obs=${String(s.observations).padStart(4)} outages=${inc.sustained.length} transient=${inc.transientDown + inc.transientUngated} spikes=${spikes.length}  ${t}`,
    );
  }
  console.log(`\n${targets.length} report(s) written to reports/`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
