// Builds and signs a public reliability report from report cards. Runs where the signing key is.
//
//   node_modules/.bin/tsx scripts/sign-report.ts \
//     --id a-identity-2026-11 --subject "A-Identity" \
//     --scope "Covers only the two Algorand x402 endpoints listed below." \
//     reports/<card1>.json reports/<card2>.json
//
// Signs with the key at SIGNING_KEY_PATH (read from the environment or .env), which must be
// published as active in attest/jwks-history.json. Writes reports/signed/<id>.json (gitignored, so a
// later git pull of the committed copy never conflicts) and prints the signed document (public data:
// safe to share) so it can be committed to public-reports/. The private key is never printed.
import { config as loadEnv } from 'dotenv';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSigner } from '../src/attest/keyset.js';
import { attest } from '../src/attest/sign.js';
import { buildReport, type ReportCard } from '../src/attest/report.js';

loadEnv();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const id = arg('--id');
const subject = arg('--subject');
const scope = arg('--scope');
const flagged = new Set(['--id', '--subject', '--scope'].flatMap((f) => [f, arg(f)]));
const cardPaths = process.argv.slice(2).filter((a) => !flagged.has(a));
if (!id || !subject || !scope || cardPaths.length === 0) {
  console.error('usage: sign-report.ts --id <id> --subject <name> --scope <text> <card.json> [...]');
  process.exit(2);
}

const signer = loadSigner();
if (!signer) {
  console.error('sign-report: SIGNING_KEY_PATH is not set, so the report cannot be signed.');
  process.exit(1);
}

const cards = cardPaths.map((p) => JSON.parse(readFileSync(p, 'utf8')) as ReportCard);
const signed = attest(signer, buildReport({ id, subject, scope }, cards));

mkdirSync(join('reports', 'signed'), { recursive: true });
const out = join('reports', 'signed', `${id}.json`);
writeFileSync(out, JSON.stringify(signed, null, 2) + '\n', 'utf8');
console.error(`sign-report: signed with key ${signer.kid}; written to ${out}. The JSON below is public; share it to publish.`);
console.log(JSON.stringify(signed, null, 2));
