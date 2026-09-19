import type { Check } from './types.js';
import { reliabilityCheck } from './reliability/index.js';

const checks = new Map<string, Check>();

export function registerCheck(check: Check): void {
  checks.set(check.id, check);
}
export function getCheck(id: string): Check | undefined {
  return checks.get(id);
}

// --- Register available checks here ---
registerCheck(reliabilityCheck);
// registerCheck(complianceCheck);  // <- future second product, same plumbing, one line

export { checks };
