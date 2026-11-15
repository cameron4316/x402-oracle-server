// Keeps the gate in step with the rest of the repository: the signature code it carries, the
// example it ships, and the framework ids it cites.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findControls } from '../src/calm.ts';
import { parseControlConfig } from '../src/control.ts';
import { applyOverlay } from '../src/overlay.ts';
import { GATE_NAME, GATE_VERSION } from '../src/version.ts';

const gate = fileURLToPath(new URL('../', import.meta.url));
const repo = fileURLToPath(new URL('../../', import.meta.url));
const read = (root: string, path: string): string => readFileSync(join(root, path), 'utf8');

test('the signature code is the server\'s own, changed only in how files import each other', () => {
  for (const file of ['jcs.ts', 'keys.ts', 'format.ts', 'verify.ts', 'sign.ts']) {
    const server = read(repo, `src/attest/${file}`).replace(/from '\.\/(\w+)\.js'/g, "from './$1.ts'");
    assert.equal(read(gate, `src/attest/${file}`), server, `gate/src/attest/${file} has drifted from src/attest/${file}`);
  }
});

test('the version constant matches package.json', () => {
  const pkg = JSON.parse(read(gate, 'package.json'));
  assert.equal(pkg.version, GATE_VERSION);
  assert.equal(pkg.name, GATE_NAME);
});

const schema = JSON.parse(read(gate, 'controls/external-service-reliability.requirement.json'));

function checkArchitecture(architecture: unknown, label: string, expected: number): void {
  const controls = findControls(architecture);
  assert.equal(controls.length, expected, `${label}: number of controls`);
  for (const control of controls) {
    const parsed = parseControlConfig(control.config);
    assert.equal(parsed.ok, true, `${label}: ${control.id}: ${parsed.ok ? '' : parsed.errors.join('; ')}`);
    assert.equal(control.requirementUrl, schema.$id, `${label}: ${control.id} does not point at the control's schema`);
  }
}

test('the example architecture carries valid controls that point at the published schema', () => {
  checkArchitecture(JSON.parse(read(gate, 'examples/loan-approval/architecture.calm.json')), 'example', 4);
  const mapping = JSON.parse(read(gate, 'examples/loan-approval/url-to-local-file-mapping.json'));
  assert.deepEqual(Object.keys(mapping), [schema.$id]);
  assert.equal(existsSync(join(gate, 'examples/loan-approval', mapping[schema.$id])), true);
});

test('the Steel Thread overlay applies to an architecture with the nodes it names, and its controls are valid', () => {
  const overlay = JSON.parse(read(gate, 'examples/steel-thread/overlay.json'));
  // A stand-in for the base: just the ids the overlay refers to. CI applies it to the real file.
  const referenced = new Set<string>();
  for (const id of Object.keys(overlay['attach-controls']?.nodes ?? {})) referenced.add(id);
  for (const r of overlay['add-relationships'] ?? []) referenced.add(r['relationship-type'].connects.source.node);
  const added = new Set((overlay['add-nodes'] ?? []).map((n: { 'unique-id': string }) => n['unique-id']));
  const compositions = Object.keys(overlay['add-to-composition'] ?? {});
  const base = {
    nodes: [...referenced].filter((id) => !added.has(id)).map((id) => ({ 'unique-id': id, 'node-type': 'service', name: id, description: id })),
    relationships: compositions.map((id) => ({ 'unique-id': id, 'relationship-type': { 'composed-of': { container: 'x', nodes: [] } } })),
    metadata: [{}],
  };
  const merged = applyOverlay(base, overlay);
  checkArchitecture(merged, 'steel thread overlay', 4);
  assert.match(overlay.base.commit, /^[0-9a-f]{40}$/);
  assert.match(overlay.base.sha256, /^[0-9a-f]{64}$/);
});

function filesUnder(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'out') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) filesUnder(path, out);
    else if (/\.(md|json|ts|ya?ml)$/.test(name)) out.push(path);
  }
  return out;
}

test('every framework id cited anywhere in the gate exists in the pinned source manifest', () => {
  const manifest = JSON.parse(read(repo, 'calm/aigf-sources.json'));
  const known = new Set(Object.keys(manifest.ids));
  const cited = new Map<string, string>();
  for (const file of filesUnder(gate)) {
    if (file.endsWith('repository.test.ts')) continue;
    const text = readFileSync(file, 'utf8');
    // Both spellings: MI-04 (this repository) and mi-4 (the framework's file names, the Steel Thread).
    for (const match of text.matchAll(/(?<![\w/-])(MI|RI|mi|ri)-(\d{1,2})(?![\w-])/g)) {
      const id = `${match[1]!.toUpperCase()}-${match[2]!.padStart(2, '0')}`;
      cited.set(id, file);
    }
  }
  assert.notEqual(cited.size, 0);
  for (const [id, file] of cited) assert.equal(known.has(id), true, `${id} (cited in ${file}) is not in calm/aigf-sources.json`);

  // In the gate's own documents, every id is linked to its source file at the pinned commit.
  for (const doc of ['README.md', 'HACKATHON.md', 'examples/steel-thread/README.md']) {
    if (!existsSync(join(gate, doc))) continue;
    const text = read(gate, doc);
    for (const match of text.matchAll(/\[((?:MI|RI)-\d{2})\]:\s*(\S+)/g)) {
      const entry = manifest.ids[match[1]!];
      assert.equal(match[2], `${manifest.framework.repository}/blob/${manifest.framework.commit}/${entry.path}`, `${doc}: link for ${match[1]}`);
    }
    for (const match of text.matchAll(/(?<![\w/[-])((?:MI|RI)-\d{2})(?![\w\]-])/g)) {
      assert.fail(`${doc}: ${match[1]} is written without a link to its source ([${match[1]}])`);
    }
    for (const match of text.matchAll(/\[((?:MI|RI)-\d{2})\](?!:)/g)) {
      assert.match(text, new RegExp(`^\\[${match[1]}\\]: `, 'm'), `${doc}: [${match[1]}] has no link definition`);
    }
  }
});
