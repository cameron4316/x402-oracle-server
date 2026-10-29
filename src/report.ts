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
const LATENCY_SPIKE_FACTOR = 2; // flag a probe whose latency > p95 * this
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

type Incident = { kind: 'down' | 'ungated'; start: string; end: string; durationMin: number; probes: number };
type Spike = { at: string; latencyMs: number };

// Matches the P0 scoring model: down = unreachable or 5xx; ungated = served a 2xx unpaid (no 402);
// 402 = ok; 400/other-4xx = indeterminate (NOT an incident — the probe just couldn't test gating).
function classify(o: Observation): 'down' | 'ungated' | 'ok' | 'indeterminate' {
  if (!o.reachable || (o.httpStatus != null && o.httpStatus >= 500)) return 'down';
  if (o.httpStatus === 402) return 'ok';
  if (o.httpStatus != null && o.httpStatus >= 200 && o.httpStatus < 300) return 'ungated';
  return 'indeterminate';
}

function extractIncidents(obs: Observation[]): Incident[] {
  const inc: Incident[] = [];
  let run: { kind: 'down' | 'ungated'; items: Observation[] } | null = null;
  const flush = () => {
    if (!run || run.items.length === 0) return;
    const first = run.items[0];
    const last = run.items[run.items.length - 1];
    const durationMin = Math.round((new Date(last.at).getTime() - new Date(first.at).getTime()) / 60000);
    inc.push({ kind: run.kind, start: first.at, end: last.at, durationMin, probes: run.items.length });
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
  return inc;
}

function extractSpikes(obs: Observation[], p95: number | null): Spike[] {
  if (p95 == null) return [];
  const threshold = p95 * LATENCY_SPIKE_FACTOR;
  return obs
    .filter((o) => typeof o.latencyMs === 'number' && (o.latencyMs as number) > threshold)
    .map((o) => ({ at: o.at, latencyMs: o.latencyMs as number }));
}

function toMarkdown(
  target: string,
  key: string,
  s: ReliabilitySummary,
  incidents: Incident[],
  spikes: Spike[],
): string {
  const status = statusFromScore(s.score).toUpperCase();
  const since = s.firstObservedAt ? s.firstObservedAt.slice(0, 10) : '—';
  const confidence = s.observations >= MIN_OBS_FOR_HISTORY ? 'history' : 'one-shot';
  const L: string[] = [];
  L.push(`# Reliability report — ${target}`);
  L.push('');
  L.push(`**Status:** ${status}  ·  **Score:** ${s.score ?? 'n/a'}/100  ·  **Confidence:** ${confidence}`);
  L.push(`Monitored by Hosannaith since ${since} · window ${s.windowHours}h · ${s.observations} probes · key \`${key}\``);
  L.push('');
  L.push('| Metric | Value |');
  L.push('| --- | --- |');
  L.push(`| Uptime | ${s.uptimePct ?? '—'}% |`);
  L.push(`| Correct-402 | ${s.correct402Pct ?? '—'}% |`);
  L.push(`| Latency p50 | ${s.p50LatencyMs ?? '—'} ms |`);
  L.push(`| Latency p95 | ${s.p95LatencyMs ?? '—'} ms |`);
  L.push('');
  L.push(`## Incidents (${incidents.length})`);
  if (incidents.length === 0) {
    L.push('None in window. ✅');
  } else {
    for (const i of incidents) {
      const label = i.kind === 'down' ? 'DOWN / 5xx' : 'Served unpaid (no 402 demanded)';
      L.push(`- **${label}** — ${i.start} → ${i.end} (${i.durationMin} min, ${i.probes} probes)`);
    }
  }
  L.push('');
  L.push(`## Latency spikes (${spikes.length}, > ${LATENCY_SPIKE_FACTOR}× p95)`);
  if (spikes.length === 0) {
    L.push('None.');
  } else {
    for (const sp of spikes.slice(0, 20)) L.push(`- ${sp.at} — ${sp.latencyMs} ms`);
    if (spikes.length > 20) L.push(`- …and ${spikes.length - 20} more`);
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
    const incidents = extractIncidents(obs);
    const spikes = extractSpikes(obs, s.p95LatencyMs);
    const key = endpointKey(t);
    await writeFile(join(REPORTS_DIR, `${key}.md`), toMarkdown(t, key, s, incidents, spikes), 'utf8');
    await writeFile(
      join(REPORTS_DIR, `${key}.json`),
      JSON.stringify(
        { target: t, endpointKey: key, generatedAt: new Date().toISOString(), status: statusFromScore(s.score), summary: s, incidents, spikes },
        null,
        2,
      ),
      'utf8',
    );
    console.log(
      `${statusFromScore(s.score).padEnd(9)} score=${String(s.score ?? 'n/a').padStart(5)} ` +
        `obs=${String(s.observations).padStart(4)} inc=${incidents.length} spikes=${spikes.length}  ${t}  -> reports/${key}.md`,
    );
  }
  console.log(`\n${targets.length} report(s) written to reports/`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
