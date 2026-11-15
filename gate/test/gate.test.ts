// End to end, over real HTTP on the loopback interface: the gate reads signed evidence and keys
// from a running oracle, writes an evidence file, and an audit re-checks that file.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadScenario, startMockOracle, type MockOracle } from '../mock-oracle/server.ts';
import { canonicalize } from '../src/attest/jcs.ts';
import { auditBundle, runGate, type Bundle } from '../src/evidence.ts';
import { renderMetrics } from '../src/metrics.ts';
import { renderMarkdown, renderText } from '../src/report.ts';
import { controlConfig } from './helpers.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const BUREAU = 'https://credit-bureau.example/v1/score';
const EMPLOYMENT = 'https://employment-verification.example/v1/verify';
const dir = mkdtempSync(join(tmpdir(), 'reliability-gate-'));
let oracle: MockOracle;

before(async () => {
  oracle = await startMockOracle({ scenario: loadScenario('healthy') });
});
after(() => oracle.close());

function node(id: string, config: Record<string, unknown> | null) {
  return {
    'unique-id': id,
    'node-type': 'service',
    name: id,
    description: id,
    ...(config ? { controls: { 'external-service-reliability': { description: 'd', requirements: [{ 'requirement-url': 'https://example.invalid/req', config }] } } } : {}),
  };
}

function mockControl(target: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return controlConfig({
    target,
    oracle: oracle.url,
    evidence: { format: 'openeago-contract', from: `${oracle.url}/reliability`, keys: `${oracle.url}/.well-known/keys.json` },
    ...overrides,
  });
}

function writeArchitecture(name: string, nodes: unknown[]): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify({ 'unique-id': 'test', name: 'Test architecture', nodes, relationships: [] }));
  return path;
}

const cli = (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, GITHUB_STEP_SUMMARY: '' } }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? 2) : 0, stdout, stderr });
    });
  });

const reDigest = (bundle: Bundle): Bundle => {
  const { digest: _digest, ...unsigned } = bundle;
  return { ...bundle, digest: { ...bundle.digest, value: createHash('sha256').update(canonicalize(unsigned)).digest('hex') } };
};

test('a healthy architecture passes, and the evidence file audits clean', async () => {
  oracle.setScenario(loadScenario('healthy'));
  const architecture = writeArchitecture('healthy.json', [node('agent', null), node('bureau', mockControl(BUREAU)), node('employment', mockControl(EMPLOYMENT))]);
  const bundle = await runGate(architecture, { now: new Date(), clock: 'system' });
  assert.equal(bundle.result, 'pass');
  assert.deepEqual(bundle.summary, { controls: 2, pass: 2, fail: 0, warn: 0, invalid: 0 });
  assert.deepEqual(bundle.controls.map((c) => [c.id, c.decision, c.keys?.kid]), [['bureau', 'pass', oracle.kid], ['employment', 'pass', oracle.kid]]);
  const record = bundle.controls[0]!;
  assert.equal((record.evidence?.document as { target: string }).target, BUREAU);
  assert.match(record.evidence?.from ?? '', /window_hours=168/);
  assert.equal(record.measurement?.observations, 3360);

  // Survives being written to disk and read back, as an auditor would receive it.
  const audit = auditBundle(JSON.parse(JSON.stringify(bundle)));
  assert.equal(audit.ok, true, audit.problems.join('; '));
  assert.equal(audit.controls.every((c) => c.consistent && c.key_confirmed === null), true);

  const keys = await (await fetch(`${oracle.url}/.well-known/keys.json`)).json();
  assert.equal(auditBundle(bundle, [keys]).controls.every((c) => c.key_confirmed === true), true);
  // A key set that does not contain the key the file relied on: not confirmed.
  const elsewhere = auditBundle(bundle, [{ keys: [] }]);
  assert.equal(elsewhere.ok, false);
  assert.match(elsewhere.problems.join('\n'), /is not in the trusted key set/);
  const revoked = auditBundle(bundle, [{ ...(keys as object), revoked_keys: [{ kid: oracle.kid }] }]);
  assert.equal(revoked.ok, false);
});

test('a degraded service fails the gate; advisory controls and missing evidence are reported as such', async () => {
  oracle.setScenario(loadScenario('degraded'));
  const architecture = writeArchitecture('degraded.json', [
    node('bureau', mockControl(BUREAU)),
    node('employment', mockControl(EMPLOYMENT)),
    node('employment-advisory', mockControl(EMPLOYMENT, { enforcement: 'advisory' })),
    node('unmeasured', mockControl('https://nobody-measures-this.example/')),
    node('no-source', (({ evidence: _e, oracle: _o, ...rest }) => rest)(mockControl(BUREAU))),
    node('misconfigured', mockControl(BUREAU, { thresholds: { 'min-availability': 99 } })),
  ]);
  const bundle = await runGate(architecture, { now: new Date(), clock: 'system' });
  assert.equal(bundle.result, 'fail');
  assert.deepEqual(
    bundle.controls.map((c) => [c.id, c.decision]),
    [['bureau', 'pass'], ['employment', 'fail'], ['employment-advisory', 'warn'], ['unmeasured', 'fail'], ['no-source', 'fail'], ['misconfigured', 'invalid']],
  );
  const failing = bundle.controls[1]!;
  assert.deepEqual(failing.checks.filter((c) => !c.ok).map((c) => c.id), ['reliability-score', 'availability', 'latency-p95']);
  assert.match(bundle.controls[3]!.checks[0]!.actual, /HTTP 404/);
  assert.equal(bundle.controls[4]!.evidence, null);
  assert.match(bundle.controls[5]!.config_errors!.join('\n'), /fraction between 0 and 1/);
  assert.equal(auditBundle(JSON.parse(JSON.stringify(bundle))).ok, true);

  const text = renderText(bundle);
  assert.match(text, /^FAIL {4}employment \(node\)$/m);
  assert.match(text, /x {3}availability >= 0\.99 +0\.9712/);
  assert.match(text, /^WARN {4}employment-advisory \(node\) {2}\[advisory\]$/m);
  assert.match(text, /^INVALID misconfigured \(node\)$/m);
  assert.match(text, /Result: FAIL\. 4 of 6 controls not met \(1 advisory warning\)\./);
  const markdown = renderMarkdown(bundle);
  assert.match(markdown, /\| FAIL \| `employment` \|/);
  assert.match(markdown, /availability >= 0\.99: 0\.9712/);

  const metrics = renderMetrics(bundle);
  assert.match(metrics, new RegExp(`reliability_gate_control_met\\{id="employment",target="${EMPLOYMENT.replace(/[.]/g, '\\.')}",enforcement="blocking"\\} 0`));
  assert.match(metrics, /reliability_gate_control_met\{id="bureau",[^}]+\} 1/);
  assert.match(metrics, /reliability_gate_availability_ratio\{id="employment",[^}]+\} 0\.9712/);
  assert.match(metrics, /reliability_gate_latency_seconds\{id="employment",[^}]+quantile="0\.95"\} 2\.14/);
  assert.match(metrics, /reliability_gate_signature_valid\{id="no-source",[^}]+\} 0/);
  for (const line of metrics.trim().split('\n')) assert.match(line, /^(# (HELP|TYPE) \w+ .+|\w+(\{[^}]*\})? -?[\d.e+-]+)$/, line);
});

test('an oracle that cannot be reached is a failed control, not a crash and not a pass', async () => {
  const dead = 'http://127.0.0.1:9/reliability';
  const architecture = writeArchitecture('dead.json', [node('bureau', mockControl(BUREAU, { evidence: { format: 'openeago-contract', from: dead, keys: 'http://127.0.0.1:9/keys.json' } }))]);
  const bundle = await runGate(architecture, { now: new Date(), clock: 'system' });
  assert.equal(bundle.result, 'fail');
  assert.equal(bundle.controls[0]!.checks[0]!.id, 'evidence-retrieved');
  assert.equal(bundle.controls[0]!.evidence?.document, null);
  assert.equal(auditBundle(JSON.parse(JSON.stringify(bundle))).ok, true);
});

test('editing a saved evidence file is caught, even when its digest is recomputed', async () => {
  oracle.setScenario(loadScenario('degraded'));
  const architecture = writeArchitecture('forge.json', [node('employment', mockControl(EMPLOYMENT))]);
  const bundle = await runGate(architecture, { now: new Date(), clock: 'system' });
  assert.equal(bundle.result, 'fail');

  // A careless edit: flip the result only.
  const careless = { ...structuredClone(bundle), result: 'pass' as const };
  const a = auditBundle(careless);
  assert.equal(a.digest_ok, false);
  assert.equal(a.ok, false);

  // A careful one: flip the decision and the checks, then recompute the digest.
  const flipped = structuredClone(bundle);
  flipped.controls[0]!.decision = 'pass';
  for (const check of flipped.controls[0]!.checks) check.ok = true;
  flipped.result = 'pass';
  const b = auditBundle(reDigest(flipped));
  assert.equal(b.digest_ok, true);
  assert.equal(b.ok, false);
  assert.equal(b.controls[0]!.recomputed, 'fail');
  assert.match(b.controls[0]!.reason ?? '', /reliability score >= 0\.95: 0\.882/);

  // The most careful: also improve the numbers inside the signed document.
  const forged = structuredClone(flipped);
  Object.assign(forged.controls[0]!.evidence!.document as object, { reliability_score: 0.99, availability_pct: 0.999, latency_p95_ms: 200 });
  const c = auditBundle(reDigest(forged));
  assert.equal(c.digest_ok, true);
  assert.equal(c.ok, false);
  assert.match(c.controls[0]!.reason ?? '', /signature_invalid/);

  // Loosening the control inside the file does not help: the recorded checks no longer match it.
  const loosened = structuredClone(flipped);
  (loosened.controls[0]!.config as { thresholds: Record<string, number> }).thresholds = { 'min-availability': 0.5 };
  assert.equal(auditBundle(reDigest(loosened)).ok, false);

  assert.equal(auditBundle({ type: 'something-else' }).ok, false);
  assert.equal(auditBundle(null).ok, false);
});

test('the command line: exit codes, files written, and the audit command', async () => {
  oracle.setScenario(loadScenario('healthy'));
  const good = writeArchitecture('cli-good.json', [node('bureau', mockControl(BUREAU))]);
  const evidence = join(dir, 'out', 'evidence.json');
  const metrics = join(dir, 'out', 'metrics.prom');
  const summary = join(dir, 'out', 'summary.md');
  const pass = await cli(['check', '-a', good, '--evidence-out', evidence, '--metrics-out', metrics, '--summary-out', summary]);
  assert.equal(pass.code, 0, pass.stdout + pass.stderr);
  assert.match(pass.stdout, /PASS {4}bureau \(node\)/);
  assert.match(pass.stdout, /met {7}reliability score 0\.991, availability 0\.9995/);
  assert.match(pass.stdout, /Result: PASS\. 1 control checked, none failing\./);
  assert.equal(existsSync(evidence) && existsSync(metrics) && existsSync(summary), true);
  assert.match(readFileSync(summary, 'utf8'), /## Reliability gate/);
  assert.equal(JSON.parse(readFileSync(evidence, 'utf8')).clock, 'system');

  const verbose = await cli(['check', '-a', good, '--verbose']);
  assert.match(verbose.stdout, /ok {2}availability >= 0\.99 +0\.9995/);

  const audit = await cli(['audit', evidence, '--trust-keys', `${oracle.url}/.well-known/keys.json`]);
  assert.equal(audit.code, 0, audit.stdout + audit.stderr);
  assert.match(audit.stdout, /Audit: OK/);
  assert.match(audit.stdout, /signing key confirmed by the trusted key set/);
  assert.match((await cli(['audit', evidence])).stdout, /signing keys were taken from the file itself/);

  const tampered = join(dir, 'out', 'tampered.json');
  writeFileSync(tampered, readFileSync(evidence, 'utf8').replace('"result": "pass"', '"result": "fail"'));
  const badAudit = await cli(['audit', tampered]);
  assert.equal(badAudit.code, 1);
  assert.match(badAudit.stdout, /DOES NOT MATCH/);

  oracle.setScenario(loadScenario('degraded'));
  const bad = writeArchitecture('cli-bad.json', [node('employment', mockControl(EMPLOYMENT))]);
  const fail = await cli(['check', '-a', bad, '--format', 'json']);
  assert.equal(fail.code, 1);
  assert.equal(JSON.parse(fail.stdout).result, 'fail');

  // Evidence dated "now" is in the future for a clock pinned to the past; the pin is recorded.
  const pinned = await cli(['check', '-a', bad, '--format', 'json', '--now', '2026-01-01T00:00:00Z']);
  assert.equal(JSON.parse(pinned.stdout).clock, 'pinned');

  const empty = writeArchitecture('cli-empty.json', [node('agent', null)]);
  const none = await cli(['check', '-a', empty]);
  assert.equal(none.code, 2);
  assert.match(none.stderr, /no external-service-reliability controls found/);
  assert.equal((await cli(['check', '-a', empty, '--allow-empty'])).code, 0);

  assert.equal((await cli(['check'])).code, 2);
  assert.equal((await cli(['check', '-a', join(dir, 'missing.json')])).code, 2);
  assert.equal((await cli(['check', '-a', good, '--now', 'yesterday'])).code, 2);
  assert.equal((await cli(['check', '-a', good, '--no-such-option'])).code, 2);
  assert.equal((await cli(['frobnicate'])).code, 2);
  assert.equal((await cli(['help'])).code, 0);

  const list = await cli(['controls', '-a', bad]);
  assert.equal(list.code, 0);
  assert.match(list.stdout, /employment \(node\), control "external-service-reliability"/);
});
