#!/usr/bin/env node
// CycloneDX 1.5 SBOM for one npm package, built from what pnpm itself resolved: no third-party SBOM
// tool runs in the release job.
//
//   pnpm list --prod --depth Infinity --json > list.json
//   pnpm licenses list --prod --json > licenses.json
//   node scripts/sbom.mjs --package package.json --list list.json --licenses licenses.json > sbom.cdx.json
//
// Every production dependency (direct and transitive) becomes a component with its exact version,
// npm purl and license, plus a dependency graph. Fails if a direct dependency from package.json, or
// any package pnpm lists licenses for, is missing from the tree, so an SBOM cannot silently come
// out incomplete.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/** pkg:npm purl; the scope's "@" is percent-encoded (purl spec). */
export function purl(name, version) {
  return `pkg:npm/${name.startsWith('@') ? '%40' + name.slice(1) : name}@${version}`;
}

/** Looks up a package's license in `pnpm licenses list --json` output ({ license: [{name, versions}] }). */
function licenseIndex(licenses) {
  const index = new Map();
  for (const [group, entries] of Object.entries(licenses ?? {})) {
    for (const e of entries ?? []) {
      for (const v of e.versions ?? [e.version]) index.set(`${e.name}@${v}`, e.license ?? group);
    }
  }
  return index;
}

function licenseField(spdx) {
  if (!spdx || spdx === 'Unknown') return undefined;
  return /\s(OR|AND|WITH)\s/.test(spdx) || spdx.startsWith('(') ? [{ expression: spdx }] : [{ license: { id: spdx } }];
}

export function buildSbom({ pkg, list, licenses, timestamp = new Date().toISOString(), serial = randomUUID() }) {
  const root = Array.isArray(list) ? list[0] : list;
  if (!root) throw new Error('sbom: empty pnpm list output');
  const lic = licenseIndex(licenses);
  const rootRef = purl(pkg.name, pkg.version);
  const components = new Map(); // bom-ref -> component
  const graph = new Map(); // bom-ref -> Set(bom-ref)

  // pnpm can print a repeated package without its children, so a package is expanded the first
  // time it shows up WITH children, wherever that is.
  const expanded = new Set();
  const walk = (deps, parentRef) => {
    for (const [name, d] of Object.entries(deps ?? {})) {
      const version = d?.version;
      if (!version || /^(link|file|workspace):/.test(version)) continue;
      const realName = d.from ?? name; // for npm: aliases, `from` holds the real package name
      const ref = purl(realName, version);
      graph.get(parentRef).add(ref);
      if (!components.has(ref)) {
        const c = { type: 'library', 'bom-ref': ref, name: realName, version, purl: ref };
        const l = licenseField(lic.get(`${realName}@${version}`));
        if (l) c.licenses = l;
        components.set(ref, c);
        graph.set(ref, new Set());
      }
      if (!expanded.has(ref) && Object.keys(d.dependencies ?? {}).length) {
        expanded.add(ref);
        walk(d.dependencies, ref);
      }
    }
  };
  graph.set(rootRef, new Set());
  walk(root.dependencies, rootRef);

  const direct = [...graph.get(rootRef)].map((ref) => components.get(ref).name);
  const missing = Object.keys(pkg.dependencies ?? {}).filter((n) => !direct.includes(n));
  if (missing.length) throw new Error(`sbom: direct dependencies missing from the pnpm tree: ${missing.join(', ')}`);
  // Cross-check against pnpm's license listing, which covers the same production packages.
  const unlisted = [...lic.keys()].filter((k) => {
    const at = k.lastIndexOf('@');
    return !components.has(purl(k.slice(0, at), k.slice(at + 1)));
  });
  if (unlisted.length) throw new Error(`sbom: packages in pnpm licenses but not in the tree: ${unlisted.join(', ')}`);

  const byRef = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${serial}`,
    version: 1,
    metadata: {
      timestamp,
      tools: { components: [{ type: 'application', name: 'hosannaith scripts/sbom.mjs' }] },
      component: {
        type: 'library',
        'bom-ref': rootRef,
        name: pkg.name,
        version: pkg.version,
        purl: rootRef,
        ...(licenseField(pkg.license) ? { licenses: licenseField(pkg.license) } : {}),
      },
    },
    components: [...components.values()].sort((a, b) => byRef(a['bom-ref'], b['bom-ref'])),
    dependencies: [...graph.entries()]
      .map(([ref, on]) => ({ ref, dependsOn: [...on].sort(byRef) }))
      .sort((a, b) => byRef(a.ref, b.ref)),
  };
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || !process.argv[i + 1]) throw new Error(`sbom: missing --${name} <file>`);
  return JSON.parse(readFileSync(process.argv[i + 1], 'utf8'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const sbom = buildSbom({ pkg: arg('package'), list: arg('list'), licenses: arg('licenses') });
    process.stdout.write(JSON.stringify(sbom, null, 2) + '\n');
    process.stderr.write(`sbom: ${sbom.components.length} components for ${sbom.metadata.component.name}@${sbom.metadata.component.version}\n`);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
