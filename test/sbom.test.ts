// scripts/sbom.mjs: CycloneDX SBOM from pnpm's own resolution. Run as a subprocess, exactly as the
// release workflow runs it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pkg = { name: 'hosannaith-example', version: '1.2.3', license: 'Apache-2.0', dependencies: { '@scope/a': '^1.0.0', b: '^2.0.0' } };
const list = [
  {
    name: 'hosannaith-example',
    version: '1.2.3',
    dependencies: {
      '@scope/a': {
        from: '@scope/a',
        version: '1.0.1',
        dependencies: { c: { from: 'c', version: '3.0.0' }, local: { from: 'local', version: 'link:../local' } },
      },
      b: { from: 'b', version: '2.4.0', dependencies: { c: { from: 'c', version: '3.0.0' } } },
    },
  },
];
const licenses = {
  MIT: [{ name: '@scope/a', versions: ['1.0.1'], license: 'MIT' }],
  '(MIT OR Apache-2.0)': [{ name: 'b', versions: ['2.4.0'], license: '(MIT OR Apache-2.0)' }],
  Unknown: [{ name: 'c', versions: ['3.0.0'], license: 'Unknown' }],
};

function run(p: object, l: object, lic: object) {
  const dir = mkdtempSync(join(tmpdir(), 'sbom-'));
  const files = { package: p, list: l, licenses: lic };
  const args = ['scripts/sbom.mjs'];
  for (const [k, v] of Object.entries(files)) {
    writeFileSync(join(dir, `${k}.json`), JSON.stringify(v));
    args.push(`--${k}`, join(dir, `${k}.json`));
  }
  return spawnSync(process.execPath, args, { encoding: 'utf8' });
}

test('every production dependency, deduplicated, with purls, licenses and the graph', () => {
  const r = run(pkg, list, licenses);
  assert.equal(r.status, 0, r.stderr);
  const sbom = JSON.parse(r.stdout);
  assert.equal(sbom.bomFormat, 'CycloneDX');
  assert.equal(sbom.specVersion, '1.5');
  assert.match(sbom.serialNumber, /^urn:uuid:[0-9a-f-]{36}$/);
  assert.equal(sbom.metadata.component.purl, 'pkg:npm/hosannaith-example@1.2.3');
  assert.deepEqual(sbom.metadata.component.licenses, [{ license: { id: 'Apache-2.0' } }]);

  assert.deepEqual(
    sbom.components.map((c: { purl: string }) => c.purl),
    ['pkg:npm/%40scope/a@1.0.1', 'pkg:npm/b@2.4.0', 'pkg:npm/c@3.0.0'],
  );
  const byName = Object.fromEntries(sbom.components.map((c: { name: string }) => [c.name, c]));
  assert.deepEqual(byName['@scope/a'].licenses, [{ license: { id: 'MIT' } }]);
  assert.deepEqual(byName.b.licenses, [{ expression: '(MIT OR Apache-2.0)' }]);
  assert.equal(byName.c.licenses, undefined, 'an unknown license is left out, not invented');

  const deps = Object.fromEntries(sbom.dependencies.map((d: { ref: string; dependsOn: string[] }) => [d.ref, d.dependsOn]));
  assert.deepEqual(deps['pkg:npm/hosannaith-example@1.2.3'], ['pkg:npm/%40scope/a@1.0.1', 'pkg:npm/b@2.4.0']);
  assert.deepEqual(deps['pkg:npm/%40scope/a@1.0.1'], ['pkg:npm/c@3.0.0'], 'link: dependencies are skipped');
  assert.deepEqual(deps['pkg:npm/b@2.4.0'], ['pkg:npm/c@3.0.0']);
  assert.deepEqual(deps['pkg:npm/c@3.0.0'], []);
  assert.match(r.stderr, /3 components for hosannaith-example@1\.2\.3/);
});

test('fails rather than emit an SBOM missing a direct dependency', () => {
  const r = run({ ...pkg, dependencies: { ...pkg.dependencies, d: '^1.0.0' } }, list, licenses);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /direct dependencies missing from the pnpm tree: d/);
  assert.equal(r.stdout, '');
});

test('fails on empty pnpm output', () => {
  const r = run(pkg, [], licenses);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /empty pnpm list output/);
});

test('the script parses as plain Node (no dependencies, no tsx)', () => {
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', 'scripts/sbom.mjs']));
});
