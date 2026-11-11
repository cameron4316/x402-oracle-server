// The pluggable contract shared by every paid product route.
// Reliability implements it now; compliance/attestation will implement the SAME interface later,
// so adding a second product = a new Check + one route entry, not a rewrite.

export type CheckStatus = 'pass' | 'fail' | 'degraded' | 'unknown';

export interface CheckResult {
  target: string;
  checkId: string;
  status: CheckStatus;
  score: number | null; // 0-100 where meaningful, else null
  detail: Record<string, unknown>;
  observedAt: string; // ISO 8601
}

/** Optional per-call parameters a check may honour (a check ignores what it does not use). */
export interface CheckRunOptions {
  windowHours?: number; // history window, for checks that score accumulated history
}

export interface Check {
  readonly id: string;
  describe(): string; // human-readable; feeds Bazaar discovery metadata
  run(target: string, options?: CheckRunOptions): Promise<CheckResult>;
}
