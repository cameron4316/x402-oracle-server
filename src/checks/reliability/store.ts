import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

// One recorded probe of a target endpoint.
export interface Observation {
  target: string;
  at: string; // ISO timestamp
  reachable: boolean;
  httpStatus: number | null;
  demandedPayment: boolean; // healthy x402 endpoint answers an unpaid GET with 402
  latencyMs: number | null;
  error?: string;
}

export interface ObservationStore {
  append(obs: Observation): Promise<void>;
  readForTarget(target: string, sinceMs?: number): Promise<Observation[]>;
}

// Append-only JSONL store: human-inspectable, durable, and compounding.
// Upgrade path: swap in SQLite/Postgres behind this same interface without touching callers.
export class JsonlObservationStore implements ObservationStore {
  constructor(private readonly path: string) {}

  async append(obs: Observation): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, JSON.stringify(obs) + '\n', 'utf8');
  }

  async readForTarget(target: string, sinceMs?: number): Promise<Observation[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch {
      return []; // no data yet
    }
    const cutoff = sinceMs ? Date.now() - sinceMs : 0;
    const out: Observation[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as Observation;
        if (o.target !== target) continue;
        if (cutoff && new Date(o.at).getTime() < cutoff) continue;
        out.push(o);
      } catch {
        // skip malformed line rather than crash the read
      }
    }
    return out;
  }
}
