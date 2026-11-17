import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findControls } from '../src/calm.ts';
import { applyOverlay } from '../src/overlay.ts';
import { controlConfig } from './helpers.ts';

const control = (key = 'external-service-reliability') => ({ [key]: { description: 'd', requirements: [{ 'requirement-url': 'https://example.invalid/req', config: controlConfig() }] } });

const base = () => ({
  'unique-id': 'base',
  nodes: [
    { 'unique-id': 'system', 'node-type': 'system', name: 'System', description: 's' },
    { 'unique-id': 'agent', 'node-type': 'service', name: 'Agent', description: 'a' },
    { 'unique-id': 'model', 'node-type': 'service', name: 'Model', description: 'm', controls: { existing: { description: 'e', requirements: [] } } },
  ],
  relationships: [
    { 'unique-id': 'composition', 'relationship-type': { 'composed-of': { container: 'system', nodes: ['agent', 'model'] } } },
    { 'unique-id': 'agent-to-model', 'relationship-type': { connects: { source: { node: 'agent' }, destination: { node: 'model' } } } },
  ],
  metadata: [{ 'aigf-risks': ['ri-1'], note: 'kept' }],
});

const overlay = () => ({
  description: 'adds an outside service',
  base: { repository: 'https://example.invalid/repo', commit: 'abc' },
  'add-nodes': [{ 'unique-id': 'bureau', 'node-type': 'service', name: 'Bureau', description: 'b', controls: control() }],
  'add-relationships': [{ 'unique-id': 'agent-to-bureau', 'relationship-type': { connects: { source: { node: 'agent' }, destination: { node: 'bureau' } } } }],
  'add-to-composition': { composition: ['bureau'] },
  'attach-controls': { nodes: { model: control() }, relationships: { 'agent-to-model': control('reliability-of-the-link') } },
  'append-metadata': { 'aigf-risks': ['ri-7', 'ri-1'], 'aigf-mitigations': ['mi-4'] },
});

test('an overlay adds nodes, relationships and controls, and leaves the base untouched', () => {
  const original = base();
  const merged = applyOverlay(original, overlay()) as ReturnType<typeof base>;
  assert.deepEqual(original, base());
  assert.deepEqual(merged.nodes.map((n) => n['unique-id']), ['system', 'agent', 'model', 'bureau']);
  assert.deepEqual(merged.relationships.map((r) => r['unique-id']), ['composition', 'agent-to-model', 'agent-to-bureau']);
  assert.deepEqual((merged.relationships[0]!['relationship-type'] as { 'composed-of': { nodes: string[] } })['composed-of'].nodes, ['agent', 'model', 'bureau']);
  assert.deepEqual(Object.keys(merged.nodes[2]!.controls!), ['existing', 'external-service-reliability']);
  assert.deepEqual(merged.metadata, [{ 'aigf-risks': ['ri-1', 'ri-7'], note: 'kept', 'aigf-mitigations': ['mi-4'] }]);
  assert.deepEqual(
    findControls(merged).map((c) => [c.where, c.id, c.controlKey]),
    [['node', 'model', 'external-service-reliability'], ['node', 'bureau', 'external-service-reliability'], ['relationship', 'agent-to-model', 'reliability-of-the-link']],
  );
});

test('an overlay never overwrites or invents', () => {
  const cases: Array<[RegExp, (o: ReturnType<typeof overlay>) => unknown]> = [
    [/node "agent" already exists/, (o) => ({ ...o, 'add-nodes': [{ 'unique-id': 'agent' }] })],
    [/relationship "composition" already exists/, (o) => ({ ...o, 'add-relationships': [{ 'unique-id': 'composition' }] })],
    [/already has a control named "existing"/, (o) => ({ ...o, 'attach-controls': { nodes: { model: { existing: {} } } } })],
    [/node "ghost": it is not in the architecture/, (o) => ({ ...o, 'attach-controls': { nodes: { ghost: control() } } })],
    [/"agent-to-model" is not a composed-of relationship/, (o) => ({ ...o, 'add-to-composition': { 'agent-to-model': ['bureau'] } })],
    [/names "ghost", which is not a node/, (o) => ({ ...o, 'add-to-composition': { composition: ['ghost'] } })],
    [/unknown property "add-node"/, (o) => ({ ...o, 'add-node': [] })],
    [/every added node needs a unique-id/, (o) => ({ ...o, 'add-nodes': [{}] })],
  ];
  for (const [message, change] of cases) assert.throws(() => applyOverlay(base(), change(overlay())), message);
  assert.throws(() => applyOverlay([], overlay()), /base architecture must be a JSON object/);
});

test('controls are found on nodes, relationships and the architecture itself, by control-id', () => {
  const architecture = {
    'unique-id': 'arch',
    controls: control('whole-system'),
    nodes: [
      { 'unique-id': 'a', name: 'A', controls: { ...control('first'), ...control('second'), other: { description: 'o', requirements: [{ 'requirement-url': 'u', config: { 'control-id': 'mi-4' } }] } } },
      { 'unique-id': 'b' },
      'not a node',
    ],
    relationships: [{ 'unique-id': 'r', controls: control() }],
  };
  assert.deepEqual(
    findControls(architecture).map((c) => [c.where, c.id, c.controlKey, c.name]),
    [['architecture', 'arch', 'whole-system', null], ['node', 'a', 'first', 'A'], ['node', 'a', 'second', 'A'], ['relationship', 'r', 'external-service-reliability', null]],
  );
  assert.deepEqual(findControls({ nodes: [] }), []);
  assert.throws(() => findControls('nope'), /must be a JSON object/);
});
