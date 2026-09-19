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

export interface Check {
  readonly id: string;
  describe(): string; // human-readable; feeds Bazaar discovery metadata
  run(target: string): Promise<CheckResult>;
}
