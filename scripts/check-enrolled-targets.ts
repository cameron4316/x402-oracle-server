// Lists enrolled monitor targets that the target rules (src/checks/reliability/target-url.ts) would
// now refuse. Read-only: it changes nothing. Run on the server after deploying the rules:
//   node_modules/.bin/tsx scripts/check-enrolled-targets.ts [path/to/targets.json]
import { readFileSync } from 'node:fs';
import { checkTarget } from '../src/checks/reliability/target-url.js';

const path = process.argv[2] ?? './data/targets.json';
const targets: unknown = JSON.parse(readFileSync(path, 'utf8'));
if (!Array.isArray(targets)) throw new Error(`${path} is not a JSON array`);
const refused = targets.map(checkTarget).filter((r) => !r.ok);
for (const r of refused) console.log(`refused  ${r.target}  (${(r as { reason: string }).reason})`);
console.log(`${targets.length} enrolled, ${refused.length} would be refused`);
