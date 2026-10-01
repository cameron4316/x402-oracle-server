// Minimal usage example. Run: AVM_MNEMONIC="your 25 words" pnpm tsx example.ts
import { getReliability } from './index.js';

const mnemonic = process.env.AVM_MNEMONIC;
if (!mnemonic) throw new Error('Set AVM_MNEMONIC to a 25-word Algorand mnemonic funded with USDC.');

const target = process.argv[2] ?? 'https://x402.goplausible.xyz/examples/weather';

const result = await getReliability(target, { mnemonic });

console.log(`Reliability of ${result.target}`);
console.log(`  score:      ${result.score} (${result.status})`);
console.log(`  confidence: ${result.detail.confidence}`);
console.log(`  uptime:     ${result.detail.uptimePct}%  over ${result.detail.observations} observations`);
console.log(`  latency:    p50 ${result.detail.p50LatencyMs}ms / p95 ${result.detail.p95LatencyMs}ms`);
