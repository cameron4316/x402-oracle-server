#!/usr/bin/env node
// Checks that every FINOS AI Governance Framework (AIGF) id we use points at a real source file.
//
//   node scripts/check-aigf-ids.mjs                  # offline: our files agree with calm/aigf-sources.json
//   node scripts/check-aigf-ids.mjs --source <dir>   # also: the manifest agrees with a local clone of
//                                                    #   finos/ai-governance-framework at the pinned commit
//   node scripts/check-aigf-ids.mjs --fetch          # also: the same, read from GitHub at the pinned commit
//                                                    #   (plus the CALM catalogue the older ids come from)
//
// Offline it proves no id appears in docs/aigf-mapping.md or the CALM files without a manifest entry,
// that every link and every CALM control points at the manifest's source file, and that all of the
// framework's mitigations are accounted for (applied or rejected, never both, never missing).
// With --source or --fetch it proves the manifest itself matches the framework: each file exists and
// its front matter carries that sequence number, title, status and `mitigates` list.
// No dependencies. Exit code 0 only if every check passes.
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(join(root, rel), 'utf8');
const args = process.argv.slice(2);
const sourceDir = args.includes('--source') ? args[args.indexOf('--source') + 1] : null;
const doFetch = args.includes('--fetch');

const manifest = JSON.parse(read('calm/aigf-sources.json'));
const { framework, ids, 'threat-references': threats, 'calm-catalogue': catalogue } = manifest;
const sourceUrl = (path) => `${framework.repository}/blob/${framework.commit}/${path}`;

const errors = [];
const fail = (msg) => errors.push(msg);
let checks = 0;
const ok = (cond, msg) => {
  checks++;
  if (!cond) fail(msg);
};

// --- 1. The manifest is well formed: an id's number is the number in its file name. ---
ok(/^[0-9a-f]{40}$/.test(framework.commit), 'framework.commit is not a full commit id');
for (const [id, entry] of Object.entries(ids)) {
  const m = /^(MI|RI)-(\d\d)$/.exec(id);
  ok(m, `${id}: not in the RI-NN / MI-NN form`);
  if (!m) continue;
  const [, prefix, nn] = m;
  const dir = prefix === 'MI' ? '_mitigations' : '_risks';
  const expected = new RegExp(`^docs/${dir}/${prefix.toLowerCase()}-${Number(nn)}_[a-z0-9-]+\\.md$`);
  ok(expected.test(entry.path), `${id}: path ${entry.path} does not match its id`);
  ok(entry.kind === (prefix === 'MI' ? 'mitigation' : 'risk'), `${id}: wrong kind`);
  ok(typeof entry.title === 'string' && entry.title.length > 0, `${id}: no title`);
  for (const r of entry.mitigates ?? []) ok(r in ids, `${id}: mitigates ${r}, which is not in the manifest`);
}

// --- 2. Every id token in our files is in the manifest. ---
const airIds = new Set([...Object.values(catalogue.mitigations), ...Object.values(catalogue.risks)].map((e) => e['air-id']));
const FILES = ['docs/aigf-mapping.md', 'calm/README.md', 'calm/hosannaith.architecture.json', 'README.md'];
for (const file of FILES) {
  const text = read(file);
  for (const [token] of text.matchAll(/\b(?:MI|RI)-\d+\b/g)) ok(token in ids, `${file}: ${token} is not a framework id in the manifest`);
  for (const [token] of text.matchAll(/\bATR-\d{4}-\d{5}\b/g)) ok(token in threats, `${file}: ${token} is not in the manifest`);
  for (const [token] of text.matchAll(/\bAIR-[A-Z]+-\d+\b/g)) ok(airIds.has(token), `${file}: ${token} is not in the CALM catalogue section of the manifest`);
  // A lower-case file-style id (mi-20, ri-26) outside a path, URL or link anchor would be an unchecked id.
  for (const m of text.matchAll(/(?<![\w/#_-])(?:mi|ri)-\d+\b(?!_)/g)) fail(`${file}: write ${m[0].toUpperCase()} in the framework's form, not "${m[0]}"`);
}

// --- 3. The mapping page: links, the sources table, and full coverage of the mitigations. ---
const doc = read('docs/aigf-mapping.md');
const linkDefs = new Map([...doc.matchAll(/^\[([A-Z]+-[\d-]+)\]: (\S+)$/gm)].map((m) => [m[1], m[2]]));
for (const [id, url] of linkDefs) {
  const entry = ids[id] ?? threats[id];
  ok(entry && url === sourceUrl(entry.path), `docs/aigf-mapping.md: link for ${id} is not its source file at the pinned commit`);
}
for (const [, id] of doc.matchAll(/\[((?:MI|RI)-\d\d|ATR-\d{4}-\d{5})\](?!:|\()/g)) {
  ok(linkDefs.has(id), `docs/aigf-mapping.md: [${id}] has no link to its source file`);
}
const usedInDoc = new Set([...doc.matchAll(/\b(?:MI|RI)-\d\d\b/g)].map((m) => m[0]));
const sourcesTable = doc.slice(doc.indexOf('\n## Sources'));
for (const id of usedInDoc) {
  const entry = ids[id];
  if (!entry) continue; // already reported above
  ok(sourcesTable.includes(`| ${id} | ${entry.title} | ${entry.status} | [\`${entry.path}\`](${sourceUrl(entry.path)}) |`), `docs/aigf-mapping.md: Sources has no exact row for ${id}`);
}
ok(doc.includes(framework.commit), 'docs/aigf-mapping.md does not state the pinned commit');

const section = (title) => {
  const start = doc.indexOf(`\n## ${title}\n`);
  if (start < 0) return '';
  const end = doc.indexOf('\n## ', start + 4);
  return doc.slice(start, end < 0 ? undefined : end);
};
const rowIds = (text) => new Set([...text.matchAll(/^\| \[(MI-\d\d)\]/gm)].map((m) => m[1]));
const applied = rowIds(section('Summary'));
const rejected = rowIds(section('Considered and rejected'));
const allMitigations = Object.keys(ids).filter((id) => id.startsWith('MI-'));
for (const id of allMitigations) {
  ok(applied.has(id) !== rejected.has(id), `${id}: must be exactly one of applied (Summary) or rejected, found ${applied.has(id) ? 'both' : 'neither'}`);
}
for (const id of applied) ok(new RegExp(`^### ${id} `, 'm').test(doc), `${id}: applied but has no section`);
for (const id of Object.keys(ids).filter((k) => k.startsWith('RI-'))) ok(usedInDoc.has(id), `${id}: risk is not accounted for on the mapping page`);

// --- 4. CALM controls: each points at the framework source file and at a real section of the page. ---
const arch = JSON.parse(read('calm/hosannaith.architecture.json'));
const slug = (heading) => heading.toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-');
const anchors = new Set([...doc.matchAll(/^#{2,3} (.+)$/gm)].map((m) => slug(m[1])));
const controlled = new Set();
for (const node of arch.nodes) {
  for (const [key, control] of Object.entries(node.controls ?? {})) {
    for (const req of control.requirements ?? []) {
      const id = req.config?.['aigf-id'];
      const where = `calm node ${node['unique-id']} control ${key}`;
      ok(id && id in ids, `${where}: no aigf-id from the manifest`);
      if (!id || !(id in ids)) continue;
      controlled.add(id);
      ok(req['requirement-url'] === sourceUrl(ids[id].path), `${where}: requirement-url is not the source file of ${id}`);
      ok(control.description.includes(`AIGF ${id} ${ids[id].title}`), `${where}: description does not name ${id} and its title`);
      ok(req.config['aigf-title'] === ids[id].title, `${where}: aigf-title differs from the manifest`);
      ok(req.config['aigf-commit'] === framework.commit, `${where}: aigf-commit is not the pinned commit`);
      ok(key === catalogue.mitigations[id]?.['control-key'], `${where}: key is not the CALM catalogue's key for ${id}`);
      const [, anchor] = String(req.config.mapping ?? '').split('#');
      ok(anchor && anchors.has(anchor), `${where}: mapping link #${anchor} is not a heading of the mapping page`);
    }
  }
}
for (const id of applied) ok(controlled.has(id), `${id}: applied on the mapping page but has no CALM control`);
for (const id of controlled) ok(applied.has(id), `${id}: has a CALM control but is not applied on the mapping page`);

// --- 5. Optional: the manifest agrees with the framework itself. ---
function frontMatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return null;
  const scalar = (k) => new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(m[1])?.[1].trim() ?? null;
  const list = (k) => {
    const block = new RegExp(`^${k}:[^\\n]*\\n((?:[ \\t]+-.*\\n?)*)`, 'm').exec(m[1] + '\n');
    return block ? block[1].split('\n').map((l) => l.trim().replace(/^-\s*/, '').replace(/\s+#.*$/, '')).filter(Boolean) : [];
  };
  return { raw: m[1], scalar, list };
}
const toId = (file) => `RI-${String(Number(file.split('-')[1])).padStart(2, '0')}`;

async function checkAgainst(readSource, label) {
  for (const [id, entry] of Object.entries(ids)) {
    let text;
    try {
      text = await readSource(entry.path);
    } catch (e) {
      fail(`${label}: ${id}: cannot read ${entry.path} (${e.message})`);
      continue;
    }
    const fm = frontMatter(text);
    ok(fm, `${label}: ${id}: ${entry.path} has no front matter`);
    if (!fm) continue;
    ok(Number(fm.scalar('sequence')) === Number(id.slice(3)), `${label}: ${id}: sequence in ${entry.path} is ${fm.scalar('sequence')}`);
    ok(fm.scalar('title') === entry.title, `${label}: ${id}: title is "${fm.scalar('title')}", manifest says "${entry.title}"`);
    ok(fm.scalar('doc-status') === entry.status, `${label}: ${id}: status is ${fm.scalar('doc-status')}, manifest says ${entry.status}`);
    if (entry.kind === 'mitigation') {
      const upstream = fm.list('mitigates').map(toId).join(',');
      ok(upstream === entry.mitigates.join(','), `${label}: ${id}: mitigates is [${upstream}], manifest says [${entry.mitigates.join(',')}]`);
    }
  }
  for (const [id, entry] of Object.entries(threats)) {
    let table;
    const listed = [];
    try {
      table = await readSource(entry.path);
      for (const path of entry['listed-in']) listed.push([path, await readSource(path)]);
    } catch (e) {
      fail(`${label}: ${id}: cannot read its source files (${e.message})`);
      continue;
    }
    ok(new RegExp(`^  ${id}:\\n    title: ${id} ${entry.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').test(table), `${label}: ${id}: not in ${entry.path} with that title`);
    for (const [path, text] of listed) {
      ok(frontMatter(text)?.raw.includes(id), `${label}: ${id}: not listed in the front matter of ${path}`);
    }
  }
}

function checkCatalogue(text, label) {
  const upstream = JSON.parse(text);
  ok(String(upstream.version) === catalogue['catalogue-version'], `${label}: catalogue version is ${upstream.version}`);
  const pad = (n) => String(n).padStart(2, '0');
  for (const [id, entry] of Object.entries(catalogue.mitigations)) {
    const u = upstream.mitigations.find((x) => `MI-${pad(x.sequence)}` === id);
    ok(u && u.airId === entry['air-id'] && u.calmControlKey === entry['control-key'], `${label}: ${id}: catalogue says ${u?.airId} / ${u?.calmControlKey}`);
  }
  for (const [id, entry] of Object.entries(catalogue.risks)) {
    const u = upstream.risks.find((x) => `RI-${pad(x.sequence)}` === id);
    ok(u && u.id === entry['air-id'], `${label}: ${id}: catalogue says ${u?.id}`);
  }
}

if (sourceDir) {
  ok(existsSync(join(sourceDir, 'docs/_mitigations')), `--source ${sourceDir} is not a clone of the framework`);
  try {
    const head = execFileSync('git', ['-C', sourceDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    ok(head === framework.commit, `--source is at ${head}, the manifest pins ${framework.commit}`);
  } catch {
    fail('--source: cannot read the clone\'s commit (is git available and is it a git checkout?)');
  }
  await checkAgainst(async (path) => readFileSync(join(sourceDir, path), 'utf8'), 'source');
}
if (doFetch) {
  const get = async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  };
  const raw = (repo, commit, path) => `${repo.replace('https://github.com/', 'https://raw.githubusercontent.com/')}/${commit}/${path}`;
  await checkAgainst((path) => get(raw(framework.repository, framework.commit, path)), 'fetch');
  try {
    checkCatalogue(await get(raw(catalogue.repository, catalogue.commit, catalogue.path)), 'fetch');
  } catch (e) {
    fail(`fetch: cannot read the CALM catalogue (${e.message})`);
  }
}
const catalogueArg = args.includes('--catalogue') ? args[args.indexOf('--catalogue') + 1] : null;
if (catalogueArg) checkCatalogue(readFileSync(catalogueArg, 'utf8'), 'catalogue');

if (errors.length) {
  for (const e of [...new Set(errors)]) console.error(`FAIL  ${e}`);
  console.error(`\n${new Set(errors).size} problem(s).`);
  process.exit(1);
}
const mode = [sourceDir && 'local clone', doFetch && 'GitHub', catalogueArg && 'catalogue file'].filter(Boolean).join(' + ') || 'offline';
console.log(`ok    ${checks} checks (${mode}): ${Object.keys(ids).length} framework ids, ${applied.size} applied, ${rejected.size} rejected, ${controlled.size} with CALM controls.`);
