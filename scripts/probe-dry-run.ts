// Read-only check before restarting the monitor on new probe code: probes every enrolled target ONCE
// with the probe in this checkout and compares the status with that target's latest real observation.
// Writes nothing (no observations, no enrollment). Sends one unpaid probe per target, like one tick.
//
//   node_modules/.bin/tsx scripts/probe-dry-run.ts [--log data/observations.jsonl] [--targets data/targets.json]
//
// Prints each target whose status differs from its last observation (expected for a few, since time
// has passed; a pattern is what to look for), plus a summary of what the 402s now report.
import { createReadStream, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { probe } from '../src/checks/reliability/monitor.js';
import type { Observation } from '../src/checks/reliability/store.js';
import { classifyNetwork } from '../src/checks/reliability/x402-network.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const logPath = arg('log', './data/observations.jsonl');
const targetsPath = arg('targets', './data/targets.json');

const targets = JSON.parse(readFileSync(targetsPath, 'utf8')) as string[];
const wanted = new Set(targets);
const last = new Map<string, Observation>();
const lines = createInterface({ input: createReadStream(logPath, 'utf8'), crlfDelay: Infinity });
for await (const line of lines) {
  if (!line) continue;
  try {
    const o = JSON.parse(line) as Observation;
    if (wanted.has(o.target)) last.set(o.target, o);
  } catch {
    // skip a malformed line
  }
}

const show = (o: Observation | undefined) => (o ? (o.reachable ? String(o.httpStatus) : 'down') : 'none');
let differ = 0;
let gated = 0;
let parsed = 0;
let mainnet = 0;
let testnetOnly = 0;
let bazaar = 0;
let redirected = 0;
let refused = 0;
for (const target of targets) {
  const now = await probe(target);
  const before = last.get(target);
  if (show(now) !== show(before)) {
    differ++;
    console.log(`differs  ${target}  last=${show(before)}  now=${show(now)}${now.error ? `  (${now.error})` : ''}`);
  }
  if (now.error?.startsWith('refused:')) refused++;
  if (now.redirects) redirected++;
  if (now.httpStatus === 402) {
    gated++;
    if (now.paymentRequiredParsed) parsed++;
    if (now.hasBazaarExtension) bazaar++;
    const classes = (now.acceptedNetworks ?? []).map(classifyNetwork);
    if (classes.includes('mainnet')) mainnet++;
    else if (classes.length > 0 && classes.every((c) => c === 'testnet')) {
      testnetOnly++;
      console.log(`testnet-only 402  ${target}  ${JSON.stringify(now.acceptedNetworks)}`);
    }
  }
}
console.log(
  `\n${targets.length} probed: ${differ} differ from their last observation, ${refused} refused, ` +
    `${redirected} redirected.\n402s: ${gated}; requirements parsed ${parsed}; payable on a mainnet ${mainnet}; ` +
    `testnet-only ${testnetOnly}; with bazaar extension ${bazaar}.`,
);
