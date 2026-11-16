// Applies the overlay to a checkout of the FINOS AI Steel Thread demo and runs the gate on the
// result. The Steel Thread's own files are read, never changed, and never copied into this
// repository.
//
//   git clone https://github.com/finos-hack/ai-steel-thread-demo
//   git -C ai-steel-thread-demo checkout <commit named in overlay.json>
//   node examples/steel-thread/run.ts --steel-thread ./ai-steel-thread-demo [--offline] [--scenario degraded]
//
// Writes, under examples/steel-thread/out/:
//   loan-approval.with-external-services.calm.json   the merged architecture
//   url-to-local-file-mapping.json                   the Steel Thread's control schemas plus this one
//   evidence.json, metrics.prom, summary.md          what the gate found
//   mock-oracle-keys.json                            the mock oracle's public key, for the audit
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadScenario, startMockOracle } from '../../mock-oracle/server.ts';
import { findControls } from '../../src/calm.ts';
import { applyOverlay } from '../../src/overlay.ts';

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));
const { values } = parseArgs({
  options: {
    'steel-thread': { type: 'string' },
    scenario: { type: 'string', default: 'healthy' },
    'no-mock-oracle': { type: 'boolean', default: false },
    'skip-gate': { type: 'boolean', default: false },
    offline: { type: 'boolean', default: false },
  },
});

const overlay = JSON.parse(readFileSync(here('./overlay.json'), 'utf8'));
if (!values['steel-thread']) {
  console.error('Pass --steel-thread <path to a checkout of the Steel Thread demo>:');
  console.error(`  git clone ${overlay.base.repository}`);
  console.error(`  git -C ai-steel-thread-demo checkout ${overlay.base.commit}`);
  process.exit(2);
}
const checkout = resolve(values['steel-thread']);
const basePath = join(checkout, overlay.base.path);
if (!existsSync(basePath)) {
  console.error(`${basePath} does not exist. Is ${checkout} a checkout of ${overlay.base.repository}?`);
  process.exit(2);
}

// The overlay was written against one exact file. If the Steel Thread has moved on, say so
// rather than quietly extending something that was never reviewed.
const baseBytes = readFileSync(basePath);
const sha256 = createHash('sha256').update(baseBytes).digest('hex');
if (sha256 !== overlay.base.sha256) {
  console.error(`The Steel Thread architecture is not the version this overlay was written for.`);
  console.error(`  expected sha256 ${overlay.base.sha256} (commit ${overlay.base.commit})`);
  console.error(`  found    sha256 ${sha256}`);
  console.error(`Check out that commit, or review the overlay against the new file and update overlay.json.`);
  process.exit(2);
}

const out = here('./out/');
mkdirSync(out, { recursive: true });
const merged = applyOverlay(JSON.parse(baseBytes.toString('utf8')), overlay);

// --offline: read Hosannaith's signed report and public keys from this repository instead of its
// API, for networks that cannot reach it. The gate trusts the signature, not the channel, so the
// decision is the same; only where the bytes come from changes.
if (values.offline) {
  const API = 'https://api.hosannaith.com';
  const local = (path: string): string => relative(out, here(`../../../${path}`)).split('\\').join('/');
  let switched = 0;
  for (const control of findControls(merged)) {
    const evidence = (control.config as { evidence?: { format?: string; from?: string; keys?: string } }).evidence;
    const report = evidence?.from?.startsWith(`${API}/reports/`) ? evidence.from.slice(API.length + 1).replace(/^reports\//, 'public-reports/') : null;
    if (!evidence || report === null) continue;
    if (!existsSync(here(`../../../${report}`))) {
      console.error(`--offline: ${report} is not in this repository.`);
      process.exit(2);
    }
    evidence.from = local(report);
    evidence.keys = local('attest/jwks-history.json');
    switched++;
  }
  console.log(`Offline: ${switched} control(s) read Hosannaith's signed report and keys from this repository.`);
}
const mergedPath = join(out, 'loan-approval.with-external-services.calm.json');
writeFileSync(mergedPath, JSON.stringify(merged, null, 2) + '\n');

// calm-cli resolves each control's requirement-url through this map. Absolute paths, so the map
// works from any directory.
const theirMapPath = join(dirname(basePath), 'url-to-local-file-mapping.json');
const mapping: Record<string, string> = {};
if (existsSync(theirMapPath)) {
  for (const [url, file] of Object.entries(JSON.parse(readFileSync(theirMapPath, 'utf8')) as Record<string, string>)) {
    mapping[url] = resolve(dirname(theirMapPath), file);
  }
}
const schemaPath = here('../../controls/external-service-reliability.requirement.json');
mapping[JSON.parse(readFileSync(schemaPath, 'utf8')).$id] = schemaPath;
writeFileSync(join(out, 'url-to-local-file-mapping.json'), JSON.stringify(mapping, null, 2) + '\n');

const added = (overlay['add-nodes'] as unknown[]).length;
console.log(`Steel Thread architecture at ${overlay.base.commit.slice(0, 7)}: ${(merged['nodes'] as unknown[]).length} nodes after adding ${added} outside services.`);
console.log(`Wrote ${relative(process.cwd(), mergedPath)}`);
if (values['skip-gate']) process.exit(0);

const oracle = values['no-mock-oracle'] ? null : await startMockOracle({ port: 8787, scenario: loadScenario(values.scenario) });
const code = await new Promise<number>((done) => {
  // Relative paths, so the evidence file does not record where on this machine the work was done.
  const rel = (path: string): string => relative(process.cwd(), path);
  const args = [here('../../src/cli.ts'), 'check', '--architecture', rel(mergedPath)];
  args.push('--evidence-out', rel(join(out, 'evidence.json')), '--metrics-out', rel(join(out, 'metrics.prom')), '--summary-out', rel(join(out, 'summary.md')));
  spawn(process.execPath, args, { stdio: 'inherit' }).on('exit', (status) => done(status ?? 2));
});
// The mock oracle's key exists only while it runs. Its public half is saved so the evidence can be
// audited afterwards with the key confirmed. (A real oracle's keys come from the oracle, not from here.)
if (oracle) {
  const keys = await (await fetch(`${oracle.url}/.well-known/keys.json`)).json();
  writeFileSync(join(out, 'mock-oracle-keys.json'), JSON.stringify(keys, null, 2) + '\n');
}
await oracle?.close();
process.exitCode = code;
