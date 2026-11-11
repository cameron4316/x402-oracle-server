// Read-only census: for every monitored endpoint, the Algorand mainnet id form its most recent 402
// offered (spec / legacy / both / none), and whether a client on the current x402 SDK (2.29+, which
// refuses the legacy full-hash id) could pay it on some mainnet.
//
//   node_modules/.bin/tsx scripts/algorand-id-census.ts [--log data/observations.jsonl] [--since <ISO>] [--list]
//
// Uses each endpoint's LATEST observation that recorded payment requirements (default: last 24 h).
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Observation } from '../src/checks/reliability/store.js';
import { algorandMainnetIdForm, payableByCurrentSdk, payableOnMainnet } from '../src/checks/reliability/x402-network.js';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const logPath = arg('log') ?? './data/observations.jsonl';
const since = arg('since') ?? new Date(Date.now() - 24 * 3600 * 1000).toISOString();
const list = process.argv.includes('--list');

const latest = new Map<string, Observation>();
for await (const line of createInterface({ input: createReadStream(logPath, 'utf8'), crlfDelay: Infinity })) {
  if (!line.includes('"acceptedNetworks"')) continue;
  try {
    const o = JSON.parse(line) as Observation;
    if (o.at >= since && o.httpStatus === 402 && o.acceptedNetworks) latest.set(o.target, o);
  } catch {
    // skip a malformed line
  }
}

const counts = { spec: 0, legacy: 0, both: 0, none: 0, mainnet: 0, currentSdk: 0, legacyOnlyUnpayable: 0 };
const rows: string[] = [];
for (const [target, o] of [...latest].sort(([a], [b]) => a.localeCompare(b))) {
  const nets = o.acceptedNetworks ?? [];
  const form = algorandMainnetIdForm(nets) ?? 'none';
  counts[form]++;
  if (payableOnMainnet(nets)) counts.mainnet++;
  const current = payableByCurrentSdk(nets);
  if (current) counts.currentSdk++;
  if (form === 'legacy' && !current) counts.legacyOnlyUnpayable++;
  rows.push(`${form.padEnd(6)}  current-sdk=${current ? 'yes' : 'NO '}  ${target}`);
}

if (list) console.log(rows.join('\n') + '\n');
const algo = counts.spec + counts.legacy + counts.both;
console.log(`Endpoints with a recorded 402 since ${since}: ${latest.size}`);
console.log(`Algorand mainnet offered: ${algo}  (spec only ${counts.spec}, legacy only ${counts.legacy}, both ${counts.both})`);
console.log(`Payable on some mainnet: ${counts.mainnet}; payable by the current x402 SDK: ${counts.currentSdk}`);
console.log(`Legacy-only Algorand with no other mainnet option (unpayable by the current SDK): ${counts.legacyOnlyUnpayable}`);
