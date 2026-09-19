import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

// Shared, file-backed list of targets the monitor should continuously probe.
// Seeded from MONITOR_TARGETS. The paid check enrolls any newly-queried target here so its
// history starts compounding even if it wasn't pre-configured. The monitor runs as a SEPARATE
// process (see CLAUDE.md), so it can't be told about a new target directly — it re-reads this
// file each tick instead. Writes are atomic (write-then-rename) so a concurrent read never sees
// a half-written file.
export class TargetRegistry {
  constructor(
    private readonly path: string,
    private readonly seed: string[],
  ) {}

  // Union of the configured seed targets and whatever has been enrolled so far, self-healing
  // the file if the seed grew (or the file didn't exist yet).
  async list(): Promise<string[]> {
    const stored = await this.readAll();
    const union = Array.from(new Set([...this.seed, ...stored]));
    const changed = union.length !== stored.length || union.some((t) => !stored.includes(t));
    if (changed) await this.writeAll(union);
    return union;
  }

  async enroll(target: string): Promise<boolean> {
    const current = await this.list();
    if (current.includes(target)) return false;
    await this.writeAll([...current, target]);
    return true;
  }

  private async readAll(): Promise<string[]> {
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
    } catch {
      return [];
    }
  }

  private async writeAll(targets: string[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, JSON.stringify(targets, null, 2), 'utf8');
    await rename(tmp, this.path);
  }
}
