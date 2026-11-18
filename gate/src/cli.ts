#!/usr/bin/env node
// reliability-gate: checks the external-service-reliability controls in a CALM architecture
// against signed evidence, and fails the pipeline when one is not met.
//
//   check     run the gate (exit 0 = met, 1 = a blocking control is not met, 2 = could not run)
//   audit     re-check a saved evidence file, offline
//   controls  list the controls found in an architecture, without checking them
//   overlay   add nodes and controls to someone else's architecture without editing it
//   keygen    make a signing key for the pipeline and the public key set auditors need
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { publicJwk } from './attest/keys.ts';
import { createSigner, type Signer } from './attest/sign.ts';
import { findControls } from './calm.ts';
import { parseControlConfig } from './control.ts';
import { auditBundle, runGate, sha256Hex, type ReviewedArchitecture } from './evidence.ts';
import { renderMetrics } from './metrics.ts';
import { applyOverlay } from './overlay.ts';
import { renderAudit, renderMarkdown, renderText } from './report.ts';
import { loadJson } from './sources.ts';
import { GATE_NAME, GATE_VERSION } from './version.ts';

const USAGE = `${GATE_NAME} ${GATE_VERSION}

Usage:
  reliability-gate check --architecture <calm.json> [options]
      --evidence-out <file>   save the evidence file (the signed documents, keys, checks, decisions)
      --metrics-out <file>    save the results as Prometheus metrics
      --summary-out <file>    save a Markdown summary (also appended to $GITHUB_STEP_SUMMARY when set)
      --format text|json      what to print (default text)
      --sign-key <PEM file>   sign the evidence file as the pipeline (or put the PEM text in $RELIABILITY_GATE_SIGN_KEY)
      --now <RFC 3339 time>   evaluate as of this time instead of the clock (recorded as "pinned")
      --verbose, -v           list every check, also for controls that are met
      --allow-empty           do not treat "no controls found" as an error

  reliability-gate audit <evidence.json> [options]
      --architecture <file>   the reviewed CALM file: confirms no control setting was changed or left out
      --trust-keys <file|URL> the oracle's keys from a source you trust (repeat for each oracle)
      --pipeline-keys <file|URL>  the pipeline's public keys: the file must carry its valid signature
      --format text|json
  reliability-gate keygen --private-out <key.pem> --public-out <keys.json>
  reliability-gate controls --architecture <calm.json>
  reliability-gate overlay --base <calm.json> --overlay <overlay.json> --out <merged.json>

Exit codes: 0 met, 1 not met, 2 could not run.`;

class UsageError extends Error {}

async function save(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function readJsonFile(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    throw new UsageError(`cannot read ${path} (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new UsageError(`${path} is not valid JSON`);
  }
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new UsageError(`--${name} is required`);
  return value;
}

/** The environment variable a pipeline can hold its signing key in (PEM text), so no key file is needed. */
const SIGN_KEY_ENV = 'RELIABILITY_GATE_SIGN_KEY';

/** The pipeline's signing key: a PEM file named on the command line, or PEM text in the environment. */
async function loadSigner(path: string | undefined): Promise<Signer | undefined> {
  let pem: string | undefined;
  let from: string;
  if (path !== undefined) {
    from = `--sign-key ${path}`;
    try {
      pem = await readFile(path, 'utf8');
    } catch (err) {
      throw new UsageError(`--sign-key: cannot read ${path} (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`);
    }
  } else {
    from = `$${SIGN_KEY_ENV}`;
    pem = process.env[SIGN_KEY_ENV] || undefined;
  }
  if (pem === undefined) return undefined;
  try {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('not a P-256 key');
    return createSigner(key);
  } catch {
    // Never echo the key material or a parser message that might quote it.
    throw new UsageError(`${from} is not a P-256 private key in PEM form (make one with "reliability-gate keygen")`);
  }
}

async function keygen(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { 'private-out': { type: 'string' }, 'public-out': { type: 'string' } } });
  const privateOut = required(values['private-out'], 'private-out');
  const publicOut = required(values['public-out'], 'public-out');
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const kid = createSigner(privateKey).kid;
  await mkdir(dirname(privateOut), { recursive: true });
  try {
    // Never overwrite a key, and readable by its owner only.
    await writeFile(privateOut, privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
  } catch (err) {
    throw new UsageError(`cannot write ${privateOut} (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}); an existing key is never overwritten`);
  }
  const keySet = { keys: [{ ...publicJwk(privateKey), kid, alg: 'ES256', use: 'sig', status: 'active', activated_at: new Date().toISOString() }], revoked_keys: [] };
  await save(publicOut, JSON.stringify(keySet, null, 2) + '\n');
  console.log(`Private key: ${privateOut} (keep it in the pipeline's secret store; never commit it)`);
  console.log(`Public keys: ${publicOut} (give this to auditors; key id ${kid})`);
  return 0;
}

async function check(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      architecture: { type: 'string', short: 'a' },
      'evidence-out': { type: 'string' },
      'metrics-out': { type: 'string' },
      'summary-out': { type: 'string' },
      format: { type: 'string', default: 'text' },
      now: { type: 'string' },
      'allow-empty': { type: 'boolean', default: false },
      'sign-key': { type: 'string' },
      verbose: { type: 'boolean', short: 'v', default: false },
    },
  });
  const architecture = required(values.architecture, 'architecture');
  if (values.format !== 'text' && values.format !== 'json') throw new UsageError('--format must be text or json');
  let now = new Date();
  if (values.now !== undefined) {
    now = new Date(values.now);
    if (Number.isNaN(now.getTime())) throw new UsageError('--now must be an RFC 3339 time, for example 2026-11-15T00:00:00Z');
  }

  const signer = await loadSigner(values['sign-key']);

  let bundle;
  try {
    bundle = await runGate(architecture, { now, clock: values.now === undefined ? 'system' : 'pinned', signer });
  } catch (err) {
    throw new UsageError((err as NodeJS.ErrnoException).code === 'ENOENT' ? `cannot read ${architecture}` : (err as Error).message);
  }
  if (bundle.controls.length === 0 && !values['allow-empty']) {
    // A gate that finds nothing to check and passes is how a typo turns into a false assurance.
    throw new UsageError(`no external-service-reliability controls found in ${architecture} (pass --allow-empty if that is expected)`);
  }

  if (values['evidence-out']) await save(values['evidence-out'], JSON.stringify(bundle, null, 2) + '\n');
  if (values['metrics-out']) await save(values['metrics-out'], renderMetrics(bundle));
  const markdown = renderMarkdown(bundle);
  if (values['summary-out']) await save(values['summary-out'], markdown);
  if (process.env['GITHUB_STEP_SUMMARY']) await appendFile(process.env['GITHUB_STEP_SUMMARY'], markdown + '\n');

  if (values.format === 'json') {
    console.log(JSON.stringify(bundle, null, 2));
  } else {
    console.log(renderText(bundle, values.verbose));
    if (values['evidence-out']) {
      const by = bundle.signature ? `, signed by pipeline key ${bundle.signature.kid}` : ', not signed by the pipeline';
      console.log(`Evidence: ${values['evidence-out']} (digest sha256 ${bundle.digest.value}${by})`);
    }
  }
  return bundle.result === 'pass' ? 0 : 1;
}

async function audit(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      'trust-keys': { type: 'string', multiple: true },
      'pipeline-keys': { type: 'string', multiple: true },
      architecture: { type: 'string', short: 'a' },
      format: { type: 'string', default: 'text' },
    },
  });
  const file = positionals[0];
  if (!file || positionals.length > 1) throw new UsageError('audit takes one evidence file');
  if (values.format !== 'text' && values.format !== 'json') throw new UsageError('--format must be text or json');
  const bundle = await readJsonFile(file);
  const trusted: unknown[] = [];
  for (const ref of values['trust-keys'] ?? []) {
    const loaded = await loadJson(ref, process.cwd());
    if (!loaded.ok) throw new UsageError(`--trust-keys: ${loaded.error}`);
    trusted.push(loaded.value);
  }
  let reviewed: ReviewedArchitecture | null = null;
  if (values.architecture) {
    let bytes: Buffer;
    try {
      bytes = await readFile(values.architecture);
    } catch (err) {
      throw new UsageError(`--architecture: cannot read ${values.architecture} (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`);
    }
    let document: unknown;
    try {
      document = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new UsageError(`--architecture: ${values.architecture} is not valid JSON`);
    }
    reviewed = { sha256: sha256Hex(bytes), document };
  }
  const pipelineKeys: unknown[] = [];
  for (const ref of values['pipeline-keys'] ?? []) {
    const loaded = await loadJson(ref, process.cwd());
    if (!loaded.ok) throw new UsageError(`--pipeline-keys: ${loaded.error}`);
    pipelineKeys.push(loaded.value);
  }
  const result = auditBundle(bundle, trusted, reviewed, pipelineKeys);
  console.log(values.format === 'json' ? JSON.stringify(result, null, 2) : renderAudit(result));
  return result.ok ? 0 : 1;
}

async function controls(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { architecture: { type: 'string', short: 'a' } } });
  const architecture = required(values.architecture, 'architecture');
  const found = findControls(await readJsonFile(architecture));
  if (found.length === 0) {
    console.log(`No external-service-reliability controls in ${architecture}.`);
    return 0;
  }
  let invalid = 0;
  for (const instance of found) {
    const parsed = parseControlConfig(instance.config);
    const target = (instance.config as { target?: unknown }).target;
    console.log(`${instance.id} (${instance.where}), control "${instance.controlKey}": ${typeof target === 'string' ? target : '(no target)'}`);
    if (!parsed.ok) {
      invalid++;
      for (const error of parsed.errors) console.log(`    x  ${error}`);
    } else {
      const s = parsed.spec;
      console.log(`    ${s.enforcement}, evidence: ${s.evidence ? `${s.evidence.format} from ${s.evidence.from}` : 'none configured'}`);
    }
  }
  return invalid > 0 ? 1 : 0;
}

async function overlay(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { base: { type: 'string' }, overlay: { type: 'string' }, out: { type: 'string' } } });
  const base = await readJsonFile(required(values.base, 'base'));
  const additions = await readJsonFile(required(values.overlay, 'overlay'));
  const out = required(values.out, 'out');
  let merged;
  try {
    merged = applyOverlay(base, additions);
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  await save(out, JSON.stringify(merged, null, 2) + '\n');
  console.log(`Wrote ${out}`);
  return 0;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command === 'check') return await check(rest);
    if (command === 'audit') return await audit(rest);
    if (command === 'controls') return await controls(rest);
    if (command === 'overlay') return await overlay(rest);
    if (command === 'keygen') return await keygen(rest);
    if (command === '--version' || command === 'version') {
      console.log(GATE_VERSION);
      return 0;
    }
    if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
      console.log(USAGE);
      return command === undefined ? 2 : 0;
    }
    throw new UsageError(`unknown command "${command}"`);
  } catch (err) {
    // parseArgs reports bad options as TypeError with a code; both are usage problems.
    if (err instanceof UsageError || (err as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      console.error(`reliability-gate: ${(err as Error).message}`);
      console.error('Run "reliability-gate help" for usage.');
      return 2;
    }
    throw err;
  }
}

process.exitCode = await main();
