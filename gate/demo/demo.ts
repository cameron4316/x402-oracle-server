// A five-minute walk through the gate, with nothing to install and nothing to pay for:
//
//   node demo/demo.ts
//
// It starts the mock oracle, runs the gate against the example architecture, lets one service
// degrade, and then plays an insider who edits the saved evidence to hide the failure.
// Works the same on Linux, macOS and Windows.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadScenario, startMockOracle } from '../mock-oracle/server.ts';
import { canonicalize } from '../src/attest/jcs.ts';

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));
// Everything runs from the gate folder with relative paths, so the output reads the same anywhere.
const root = here('../');
const cli = here('../src/cli.ts');
const architecture = 'examples/loan-approval/architecture.calm.json';
const hosannaithKeys = '../attest/jwks-history.json';
const out = 'demo/out/';
mkdirSync(here('./out/'), { recursive: true });

function step(title: string, note: string): void {
  console.log(`\n${'='.repeat(78)}\n${title}\n${note}\n${'='.repeat(78)}\n`);
}

// The mock oracle runs inside this process, so the gate must run without blocking it.
function gate(args: string[]): Promise<number> {
  console.log(`$ reliability-gate ${args.join(' ')}\n`);
  return new Promise((done) => {
    spawn(process.execPath, [cli, ...args], { stdio: 'inherit', cwd: root }).on('exit', (code) => {
      console.log(`\n(exit code ${code ?? 2})`);
      done(code ?? 2);
    });
  });
}

let oracle;
try {
  oracle = await startMockOracle({ port: 8787, scenario: loadScenario('healthy') });
} catch (err) {
  console.error(`Could not start the mock oracle on port 8787 (${(err as Error).message}). Is another copy running?`);
  process.exit(2);
}
const mockKeys = `${oracle.url}/.well-known/keys.json`;

try {
  step(
    '1. The pipeline gate, on a good day',
    'Four outside services. Two fictional ones answered by the mock oracle, one real pay-per-call\nendpoint with a real signed report, and one with no independent evidence at all.',
  );
  const good = `${out}evidence-pass.json`;
  await gate(['check', '--architecture', architecture, '--evidence-out', good]);

  step(
    '2. An auditor re-checks the saved evidence, offline',
    "Every decision is recomputed from the signed documents inside the file. The signing keys are\nconfirmed against the oracles' key sets, obtained separately.",
  );
  await gate(['audit', good, '--trust-keys', hosannaithKeys, '--trust-keys', mockKeys]);

  step('3. One service degrades', 'The employment verification service has had outages and has become slow. Same gate, same command.');
  oracle.setScenario(loadScenario('degraded'));
  const bad = `${out}evidence-fail.json`;
  await gate(['check', '--architecture', architecture, '--evidence-out', bad]);

  step(
    '4. Someone edits the evidence to hide it',
    'A careful insider rewrites the failing file: better numbers in the signed document, every\ndecision set to pass, and the file digest recomputed so the file looks untouched.',
  );
  const forged = JSON.parse(readFileSync(here(`../${bad}`), 'utf8'));
  for (const control of forged.controls) {
    if (control.id !== 'employment-verification-api') continue;
    Object.assign(control.evidence.document, { reliability_score: 0.984, availability_pct: 0.9981, error_rate: 0.0019, latency_p95_ms: 520 });
    control.decision = 'pass';
    for (const check of control.checks) check.ok = true;
  }
  forged.result = 'pass';
  forged.summary = { ...forged.summary, pass: forged.summary.pass + forged.summary.fail, fail: 0 };
  const { digest: _old, ...unsigned } = forged;
  forged.digest.value = createHash('sha256').update(canonicalize(unsigned)).digest('hex');
  const forgedPath = `${out}evidence-forged.json`;
  writeFileSync(here(`../${forgedPath}`), JSON.stringify(forged, null, 2) + '\n');
  await gate(['audit', forgedPath, '--trust-keys', hosannaithKeys, '--trust-keys', mockKeys]);

  console.log('\nThe digest was recomputed, so the file looks intact. The oracle signature over the edited');
  console.log('numbers no longer verifies, so the recomputed decision is "fail" and the audit says so.');
} finally {
  await oracle.close();
}
