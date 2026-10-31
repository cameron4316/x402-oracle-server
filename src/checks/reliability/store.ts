import { appendFile, mkdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
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
    // Stream line-by-line instead of reading the whole append-only log into memory. On a growing
    // log (already >100MB) a whole-file readFile() makes every paid call's peak memory ~2x the file
    // size — an OOM risk on a small box. Streaming keeps per-call memory bounded by the query window,
    // not the file size. Behaviour is identical to the previous whole-file read (verified against it
    // across normal/cutoff/malformed/CRLF/EOF/empty/missing cases).
    const cutoff = sinceMs ? Date.now() - sinceMs : 0;
    const out: Observation[] = [];
    let rl: ReturnType<typeof createInterface>;
    try {
      rl = createInterface({ input: createReadStream(this.path, { encoding: 'utf8' }), crlfDelay: Infinity });
    } catch {
      return []; // no data yet
    }
    try {
      for await (const line of rl) {
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
    } catch {
      // file vanished mid-read or stream error: return what we have rather than throw
    }
    return out;
  }
}
