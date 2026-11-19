// End to end, over real HTTP on the loopback interface: the gate reads signed evidence and keys
// from a running oracle, writes an evidence file, and an audit re-checks that file.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadScenario, startMockOracle, type MockOracle } from '../mock-oracle/server.ts';
import { canonicalize } from '../src/attest/jcs.ts';
import { parseControlConfig } from '../src/control.ts';
import { evaluate } from '../src/evaluate.ts';
import { auditBundle, runGate, sha256Hex, type Bundle } from '../src/evidence.ts';
import { renderMetrics } from '../src/metrics.ts';
import { renderAudit, renderMarkdown, renderText } from '../src/report.ts';
import { controlConfig, makeOracle } from './helpers.ts';

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
  // The digest covers everything except itself and the pipeline's signature.
  const { digest: _digest, signature: _signature, ...unsigned } = bundle;
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
  assert.match(markdown, /`availability >= 0\.99: 0\.9712`/);

  const metrics = renderMetrics(bundle);
  assert.equal(metrics.includes(`reliability_gate_control_met{id="employment",target="${EMPLOYMENT}",enforcement="blocking"} 0\n`), true);
  assert.match(metrics, /reliability_gate_control_met\{id="bureau",[^}]+\} 1/);
  assert.match(metrics, /reliability_gate_availability_ratio\{id="employment",[^}]+\} 0\.9712/);
  assert.match(metrics, /reliability_gate_latency_seconds\{id="employment",[^}]+quantile="0\.95"\} 2\.14/);
  assert.match(metrics, /reliability_gate_signature_valid\{id="no-source",[^}]+\} 0/);
  for (const line of metrics.trim().split('\n')) assert.match(line, /^(# (HELP|TYPE) \w+ .+|\w+(\{[^}]*\})? -?[\d.e+-]+)$/, line);
});

test('the mock oracle refuses what it has no figures for', async () => {
  for (const target of ['__proto__', 'constructor', 'https://unknown.example/']) {
    const res = await fetch(`${oracle.url}/reliability?target=${encodeURIComponent(target)}`);
    assert.equal(res.status, 404, target);
  }
  assert.equal((await fetch(`${oracle.url}/reliability`)).status, 400);
  assert.equal((await fetch(`${oracle.url}/reliability?target=${encodeURIComponent(BUREAU)}&window_hours=0`)).status, 400);
  const doc = (await (await fetch(`${oracle.url}/reliability?target=${encodeURIComponent(BUREAU)}&window_hours=24`)).json()) as { observations: number; notice: string };
  assert.equal(doc.observations, 480);
  assert.match(doc.notice, /Not a measurement/);
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
  // A file whose records are not even the right shape is a finding, not a crash.
  const mangled = auditBundle(reDigest({ ...structuredClone(bundle), controls: [null, 'x', {}] as unknown as Bundle['controls'] }));
  assert.equal(mangled.ok, false);
  assert.equal(mangled.controls.length, 3);
  assert.match(mangled.problems.join('\n'), /control 1: the record is malformed/);
});

/** What a careful insider does: change a control's settings in the file, then redo everything that follows from them. */
function forgeSettings(bundle: Bundle, id: string, change: (config: Record<string, unknown>) => void): Bundle {
  const forged = structuredClone(bundle);
  const record = forged.controls.find((c) => c.id === id)!;
  change(record.config as Record<string, unknown>);
  const parsed = parseControlConfig(record.config);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return forged;
  const result = evaluate({
    spec: parsed.spec,
    document: { ok: true, value: record.evidence!.document },
    keySet: { ok: true, value: record.keys!.key_set },
    now: new Date(forged.evaluated_at),
  });
  Object.assign(record, { decision: result.decision, checks: result.checks, measurement: result.measurement });
  const count = (d: string): number => forged.controls.filter((c) => c.decision === d).length;
  forged.summary = { controls: forged.controls.length, pass: count('pass'), fail: count('fail'), warn: count('warn'), invalid: count('invalid') };
  forged.result = forged.summary.fail + forged.summary.invalid > 0 ? 'fail' : 'pass';
  return reDigest(forged);
}

test('editing the control settings in an evidence file is caught against the reviewed architecture', async () => {
  oracle.setScenario(loadScenario('degraded'));
  const architecture = writeArchitecture('settings.json', [node('bureau', mockControl(BUREAU)), node('employment', mockControl(EMPLOYMENT))]);
  const bundle = await runGate(architecture, { now: new Date(), clock: 'system' });
  assert.equal(bundle.result, 'fail');
  const bytes = readFileSync(architecture);
  const reviewed = { sha256: sha256Hex(bytes), document: JSON.parse(bytes.toString('utf8')) };

  // The honest file is confirmed against the architecture it was produced from.
  const honest = auditBundle(bundle, [], reviewed);
  assert.equal(honest.ok, true, honest.problems.join('; '));
  assert.equal(honest.architecture, 'matches');
  assert.equal(honest.controls.every((c) => c.settings_confirmed === true), true);

  const forgeries: Array<[string, Bundle, RegExp]> = [
    ['loosened thresholds', forgeSettings(bundle, 'employment', (c) => { c['thresholds'] = { 'min-availability': 0.5 }; }), /employment: the control's settings in the file differ/],
    ['blocking turned advisory', forgeSettings(bundle, 'employment', (c) => { c['enforcement'] = 'advisory'; }), /employment: the control's settings in the file differ/],
    ['observation floor lowered', forgeSettings(bundle, 'bureau', (c) => { c['min-observations'] = 1; }), /bureau: the control's settings in the file differ/],
  ];
  for (const [name, forged, message] of forgeries) {
    // On its own the file is self-consistent: this is exactly what the note in the output warns about.
    const alone = auditBundle(forged);
    assert.equal(alone.ok, true, name);
    assert.equal(alone.architecture, 'not-checked', name);
    // Against the reviewed architecture it is caught.
    const checked = auditBundle(forged, [], reviewed);
    assert.equal(checked.ok, false, name);
    assert.equal(checked.architecture, 'differs', name);
    assert.match(checked.problems.join('\n'), message, name);
  }
  assert.equal(forgeries[0]![1].result, 'pass');
  assert.equal(forgeries[1]![1].result, 'pass');

  // Dropping the failing control from the file altogether.
  const dropped = structuredClone(bundle);
  dropped.controls = dropped.controls.filter((c) => c.id !== 'employment');
  dropped.summary = { controls: 1, pass: 1, fail: 0, warn: 0, invalid: 0 };
  dropped.result = 'pass';
  assert.equal(auditBundle(reDigest(dropped)).ok, true);
  const droppedChecked = auditBundle(reDigest(dropped), [], reviewed);
  assert.equal(droppedChecked.ok, false);
  assert.match(droppedChecked.problems.join('\n'), /the reviewed architecture has a control on employment that the file has no record of/);

  // A record for a control the architecture does not have.
  const invented = structuredClone(bundle);
  invented.controls[0]!.id = 'somewhere-else';
  assert.match(auditBundle(reDigest(invented), [], reviewed).problems.join('\n'), /somewhere-else: no such control in the reviewed architecture/);

  // An architecture that is not the file the gate ran on, even if its controls are the same.
  const other = { sha256: sha256Hex('something else'), document: reviewed.document };
  const wrongFile = auditBundle(bundle, [], other);
  assert.equal(wrongFile.ok, false);
  assert.match(wrongFile.problems.join('\n'), /is not the file the gate ran on/);
  assert.equal(auditBundle(bundle, [], { sha256: reviewed.sha256, document: 'nope' }).ok, false);

  // The same through the command line.
  const evidence = join(dir, 'out', 'settings-forged.json');
  mkdirSync(join(dir, 'out'), { recursive: true });
  writeFileSync(evidence, JSON.stringify(forgeries[0]![1], null, 2));
  const withoutArchitecture = await cli(['audit', evidence]);
  assert.equal(withoutArchitecture.code, 0);
  assert.match(withoutArchitecture.stdout, /Pass --architecture/);
  const withArchitecture = await cli(['audit', evidence, '--architecture', architecture]);
  assert.equal(withArchitecture.code, 1);
  assert.match(withArchitecture.stdout, /DIFFERS from the reviewed architecture/);
  assert.equal((await cli(['audit', evidence, '--architecture', join(dir, 'missing.json')])).code, 2);
});

/** Redo every control in a file as of a (possibly changed) time, the way a careful forger would. */
function redo(bundle: Bundle): Bundle {
  const forged = structuredClone(bundle);
  for (const record of forged.controls) {
    const parsed = parseControlConfig(record.config);
    if (!parsed.ok || !record.evidence || !record.keys) continue;
    const result = evaluate({
      spec: parsed.spec,
      document: { ok: true, value: record.evidence.document },
      keySet: { ok: true, value: record.keys.key_set },
      now: new Date(forged.evaluated_at),
    });
    Object.assign(record, { decision: result.decision, checks: result.checks, measurement: result.measurement });
  }
  const count = (d: string): number => forged.controls.filter((c) => c.decision === d).length;
  forged.summary = { controls: forged.controls.length, pass: count('pass'), fail: count('fail'), warn: count('warn'), invalid: count('invalid') };
  forged.result = forged.summary.fail + forged.summary.invalid > 0 ? 'fail' : 'pass';
  return reDigest(forged);
}

test('a file signed by the pipeline: the run time and the documents presented cannot be changed', async () => {
  const pipeline = makeOracle();
  const architecture = writeArchitecture('signed.json', [node('employment', mockControl(EMPLOYMENT))]);

  oracle.setScenario(loadScenario('healthy'));
  const earlier = await runGate(architecture, { now: new Date(), clock: 'system', signer: pipeline.signer });
  assert.equal(earlier.result, 'pass');
  assert.equal(earlier.signature?.kid, pipeline.kid);

  oracle.setScenario(loadScenario('degraded'));
  const bundle = await runGate(architecture, { now: new Date(), clock: 'system', signer: pipeline.signer });
  assert.equal(bundle.result, 'fail');

  // Signed and confirmed.
  const confirmed = auditBundle(JSON.parse(JSON.stringify(bundle)), [], null, [pipeline.keySet]);
  assert.equal(confirmed.ok, true, confirmed.problems.join('; '));
  assert.equal(confirmed.pipeline_signature, 'confirmed');
  assert.equal(confirmed.pipeline_kid, pipeline.kid);
  // Signed, but the auditor brought no pipeline keys: said, not assumed.
  assert.equal(auditBundle(bundle).pipeline_signature, 'unconfirmed');
  assert.match(renderAudit(auditBundle(bundle)), /pipeline signature that was not checked/);
  assert.match(renderAudit(confirmed), /Run time: .*as signed by the pipeline/);

  // Forgery 1: present the document from the earlier, healthy run as if it were this run's.
  // Everything in the file is then genuine and self-consistent. Only the pipeline's signature knows.
  const replay = structuredClone(bundle);
  replay.controls[0]!.evidence!.document = structuredClone(earlier.controls[0]!.evidence!.document);
  replay.evaluated_at = earlier.evaluated_at;
  const replayed = redo(replay);
  assert.equal(replayed.result, 'pass');
  const reviewed = { sha256: bundle.architecture.sha256, document: JSON.parse(readFileSync(architecture, 'utf8')) };
  const keys = await (await fetch(`${oracle.url}/.well-known/keys.json`)).json();
  const withoutPipelineKeys = auditBundle(replayed, [keys], reviewed);
  assert.equal(withoutPipelineKeys.ok, true, withoutPipelineKeys.problems.join('; '));
  assert.equal(withoutPipelineKeys.pipeline_signature, 'unconfirmed');
  const caught = auditBundle(replayed, [keys], reviewed, [pipeline.keySet]);
  assert.equal(caught.ok, false);
  assert.equal(caught.pipeline_signature, 'invalid');
  assert.match(caught.problems.join('\n'), /the pipeline signature does not verify \(signature_invalid\)/);

  // Forgery 2: only the stated time of the run is moved.
  const moved = structuredClone(bundle);
  moved.evaluated_at = new Date(Date.parse(bundle.evaluated_at) + 60_000).toISOString();
  assert.equal(auditBundle(redo(moved)).ok, true);
  assert.equal(auditBundle(redo(moved), [], null, [pipeline.keySet]).ok, false);

  // Forgery 3: strip the signature and hope nobody asks for it.
  const { signature: _signature, ...stripped } = replayed;
  assert.equal(auditBundle(stripped).pipeline_signature, 'absent');
  const strippedChecked = auditBundle(stripped, [], null, [pipeline.keySet]);
  assert.equal(strippedChecked.ok, false);
  assert.match(strippedChecked.problems.join('\n'), /not signed by the pipeline, but pipeline keys were supplied/);

  // Forgery 4: re-sign with a key of the forger's own.
  const forger = makeOracle();
  const { signature: _old, ...unsignedReplay } = replayed;
  const resigned = { ...unsignedReplay, signature: forger.signer.sign(unsignedReplay) } as Bundle;
  assert.equal(auditBundle(resigned, [], null, [forger.keySet]).pipeline_signature, 'confirmed');
  assert.match(auditBundle(resigned, [], null, [pipeline.keySet]).problems.join('\n'), /unknown_kid/);

  // A revoked pipeline key, and a key that was not yet in use at the stated time.
  assert.match(auditBundle(bundle, [], null, [{ keys: [], revoked_keys: [{ kid: pipeline.kid }] }]).problems.join('\n'), /revoked_kid/);
  const later = { keys: [{ ...pipeline.keySet.keys[0], activated_at: new Date(Date.now() + 3600_000).toISOString() }] };
  assert.match(auditBundle(bundle, [], null, [later]).problems.join('\n'), /outside the life of the pipeline key/);
  assert.match(auditBundle(bundle, [], null, ['nope']).problems.join('\n'), /pipeline key set is not/);
  // Any one of several supplied key sets may hold the key.
  assert.equal(auditBundle(bundle, [], null, [forger.keySet, pipeline.keySet]).ok, true);
});

test('the command line: making a pipeline key, signing with it, and auditing against it', async () => {
  oracle.setScenario(loadScenario('healthy'));
  const architecture = writeArchitecture('cli-signed.json', [node('bureau', mockControl(BUREAU))]);
  const keyFile = join(dir, 'keys', 'pipeline.pem');
  const publicFile = join(dir, 'keys', 'pipeline-keys.json');
  const made = await cli(['keygen', '--private-out', keyFile, '--public-out', publicFile]);
  assert.equal(made.code, 0, made.stderr);
  assert.match(readFileSync(keyFile, 'utf8'), /^-----BEGIN PRIVATE KEY-----/);
  const published = JSON.parse(readFileSync(publicFile, 'utf8'));
  assert.equal(published.keys.length, 1);
  assert.equal('d' in published.keys[0], false, 'the public key set must not contain the private part');
  assert.doesNotMatch(made.stdout + made.stderr, /BEGIN PRIVATE KEY/);
  // An existing key is never overwritten.
  const again = await cli(['keygen', '--private-out', keyFile, '--public-out', publicFile]);
  assert.equal(again.code, 2);
  assert.match(again.stderr, /never overwritten/);

  const evidence = join(dir, 'keys', 'signed-evidence.json');
  const signed = await cli(['check', '-a', architecture, '--evidence-out', evidence, '--sign-key', keyFile]);
  assert.equal(signed.code, 0, signed.stdout + signed.stderr);
  assert.match(signed.stdout, new RegExp(`signed by pipeline key ${published.keys[0].kid}`));
  const audit = await cli(['audit', evidence, '--architecture', architecture, '--trust-keys', `${oracle.url}/.well-known/keys.json`, '--pipeline-keys', publicFile]);
  assert.equal(audit.code, 0, audit.stdout + audit.stderr);
  assert.match(audit.stdout, /Pipeline signature: valid/);
  assert.match(audit.stdout, /Audit: OK\. The pipeline signed this file/);

  // The same key from the environment, as a pipeline secret would arrive.
  const fromEnv = await new Promise<{ code: number; stdout: string }>((resolve) => {
    execFile(process.execPath, [CLI, 'check', '-a', architecture, '--format', 'json'], { env: { ...process.env, GITHUB_STEP_SUMMARY: '', RELIABILITY_GATE_SIGN_KEY: readFileSync(keyFile, 'utf8') } }, (err, stdout) =>
      resolve({ code: err ? 1 : 0, stdout }),
    );
  });
  assert.equal(JSON.parse(fromEnv.stdout).signature.kid, published.keys[0].kid);

  // One changed character anywhere in a signed file.
  const tampered = join(dir, 'keys', 'signed-tampered.json');
  writeFileSync(tampered, readFileSync(evidence, 'utf8').replace('"clock": "system"', '"clock": "pinned"'));
  const bad = await cli(['audit', tampered, '--pipeline-keys', publicFile]);
  assert.equal(bad.code, 1);
  assert.match(bad.stdout, /Pipeline signature: NOT VALID/);

  // An unsigned file, when the auditor expects a signed one.
  const unsigned = join(dir, 'keys', 'unsigned-evidence.json');
  assert.equal((await cli(['check', '-a', architecture, '--evidence-out', unsigned])).code, 0);
  assert.match((await cli(['audit', unsigned])).stdout, /not signed by the pipeline, so the time of the run is its own statement/);
  assert.equal((await cli(['audit', unsigned, '--pipeline-keys', publicFile])).code, 1);

  // A key that is not a P-256 private key is refused without echoing it.
  const notAKey = join(dir, 'keys', 'not-a-key.pem');
  writeFileSync(notAKey, 'super secret text that must not be printed');
  const refused = await cli(['check', '-a', architecture, '--sign-key', notAKey]);
  assert.equal(refused.code, 2);
  assert.doesNotMatch(refused.stdout + refused.stderr, /super secret/);
  assert.equal((await cli(['check', '-a', architecture, '--sign-key', join(dir, 'keys', 'missing.pem')])).code, 2);
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
