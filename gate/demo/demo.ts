// A five-minute walk through the gate, with nothing to install and nothing to pay for:
//
//   node demo/demo.ts
//
// It starts the mock oracle, runs the gate against the example architecture, lets one service
// degrade, and then plays an insider who edits the saved evidence to hide the failure, twice.
// Uses no shell, so it runs the same on Linux, macOS and Windows.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadScenario, startMockOracle } from '../mock-oracle/server.ts';
import { canonicalize } from '../src/attest/jcs.ts';
import { parseControlConfig } from '../src/control.ts';
import { evaluate } from '../src/evaluate.ts';

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
    "Every decision is recomputed from the signed documents inside the file. The auditor brings two\nthings of their own: the reviewed architecture, and the oracles' public keys.",
  );
  const confirm = ['--architecture', architecture, '--trust-keys', hosannaithKeys, '--trust-keys', mockKeys];
  await gate(['audit', good, ...confirm]);

  step('3. One service degrades', 'The employment verification service has had outages and has become slow. Same gate, same command.');
  oracle.setScenario(loadScenario('degraded'));
  const bad = `${out}evidence-fail.json`;
  await gate(['check', '--architecture', architecture, '--evidence-out', bad]);

  const failing = (): any => JSON.parse(readFileSync(here(`../${bad}`), 'utf8'));
  const save = (name: string, forged: any): string => {
    const { digest: _old, ...unsigned } = forged;
    forged.digest.value = createHash('sha256').update(canonicalize(unsigned)).digest('hex');
    writeFileSync(here(`../${out}${name}`), JSON.stringify(forged, null, 2) + '\n');
    return `${out}${name}`;
  };
  const markPassed = (forged: any): void => {
    forged.result = 'pass';
    forged.summary = { ...forged.summary, pass: forged.summary.pass + forged.summary.fail, fail: 0 };
  };

  step(
    '4. Someone edits the evidence to hide it: better numbers',
    'A careful insider rewrites the failing file: better numbers in the signed document, every\ndecision set to pass, and the file digest recomputed so the file looks untouched.',
  );
  const numbers = failing();
  for (const control of numbers.controls) {
    if (control.id !== 'employment-verification-api') continue;
    Object.assign(control.evidence.document, { reliability_score: 0.984, availability_pct: 0.9981, error_rate: 0.0019, latency_p95_ms: 520 });
    control.decision = 'pass';
    for (const check of control.checks) check.ok = true;
  }
  markPassed(numbers);
  await gate(['audit', save('evidence-forged-numbers.json', numbers), ...confirm]);
  console.log('\nThe digest was recomputed, so the file looks intact. The oracle signature over the edited');
  console.log('numbers no longer verifies, so the recomputed decision is "fail" and the audit says so.');

  step(
    '5. A subtler edit: leave the numbers alone, loosen the rule',
    "The insider cannot touch what the oracle signed, so they lower the thresholds recorded in the\nfile until the bad numbers pass, and redo every check so the file agrees with itself.",
  );
  const rule = failing();
  for (const control of rule.controls) {
    if (control.id !== 'employment-verification-api') continue;
    control.config.thresholds = { 'min-reliability-score': 0.8, 'min-availability': 0.95, 'max-error-rate': 0.05, 'max-latency-p95-ms': 5000 };
    const parsed = parseControlConfig(control.config);
    if (!parsed.ok) throw new Error(parsed.errors.join('; '));
    const redone = evaluate({
      spec: parsed.spec,
      document: { ok: true, value: control.evidence.document },
      keySet: { ok: true, value: control.keys.key_set },
      now: new Date(rule.evaluated_at),
    });
    Object.assign(control, { decision: redone.decision, checks: redone.checks, measurement: redone.measurement });
  }
  markPassed(rule);
  await gate(['audit', save('evidence-forged-rule.json', rule), ...confirm]);
  console.log('\nThis file agrees with itself: the signatures are valid and the looser thresholds are met.');
  console.log('It is caught because the auditor brought the reviewed architecture, and the thresholds in');
  console.log('the file are not the ones in it. Without --architecture the audit says it could not confirm that.');
} finally {
  await oracle.close();
}
