import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CONFIG_PROPERTIES, CONFIDENCE_LEVELS, EVIDENCE_FORMATS, parseControlConfig } from '../src/control.ts';
import { controlConfig } from './helpers.ts';

const errorsOf = (config: unknown): string[] => {
  const parsed = parseControlConfig(config);
  return parsed.ok ? [] : parsed.errors;
};

test('a complete control parses, with defaults for what is left out', () => {
  const parsed = parseControlConfig({
    'control-id': 'external-service-reliability',
    name: 'n',
    description: 'd',
    target: 'https://service.example/x',
    thresholds: { 'min-availability': 0.99 },
    'max-evidence-age-hours': 24,
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.spec, {
    target: 'https://service.example/x',
    oracle: null,
    evidence: null,
    windowHours: 168,
    thresholds: { minAvailability: 0.99 },
    minConfidence: 'history',
    minObservations: 1,
    maxEvidenceAgeHours: 24,
    enforcement: 'blocking',
  });
});

test('a misspelt property is an error, not something silently ignored', () => {
  assert.match(errorsOf(controlConfig({ 'max-evidence-age-hour': 24 })).join('\n'), /unknown property "max-evidence-age-hour"/);
  assert.match(errorsOf(controlConfig({ thresholds: { 'min-availabilty': 0.99 } })).join('\n'), /thresholds: unknown property "min-availabilty"/);
  assert.match(errorsOf(controlConfig({ evidence: { format: 'openeago-contract', from: 'a', keys: 'b', key: 'c' } })).join('\n'), /evidence: unknown property "key"/);
});

test('a percentage where a fraction is meant is refused', () => {
  assert.match(errorsOf(controlConfig({ thresholds: { 'min-availability': 99.9 } })).join('\n'), /fraction between 0 and 1/);
});

test('the freshness limit and at least one threshold are required', () => {
  const { 'max-evidence-age-hours': _age, ...withoutAge } = controlConfig();
  assert.match(errorsOf(withoutAge).join('\n'), /max-evidence-age-hours is required/);
  assert.match(errorsOf(controlConfig({ thresholds: {} })).join('\n'), /at least one requirement/);
});

test('other invalid values are each reported', () => {
  assert.match(errorsOf(controlConfig({ target: 'ftp://service.example' })).join('\n'), /target must be an http\(s\) URL/);
  assert.match(errorsOf(controlConfig({ 'control-id': 'mi-4' })).join('\n'), /control-id must be/);
  assert.match(errorsOf(controlConfig({ 'min-confidence': 'certain' })).join('\n'), /min-confidence must be one of/);
  assert.match(errorsOf(controlConfig({ enforcement: 'optional' })).join('\n'), /enforcement must be/);
  assert.match(errorsOf(controlConfig({ 'window-hours': 0 })).join('\n'), /window-hours/);
  assert.match(errorsOf(controlConfig({ 'min-observations': 1.5 })).join('\n'), /min-observations/);
  assert.match(errorsOf(controlConfig({ evidence: { format: 'pdf', from: 'a', keys: 'b' } })).join('\n'), /evidence.format must be one of/);
  assert.match(errorsOf(controlConfig({ evidence: { format: 'openeago-contract', from: 'a', keys: 'b', 'trusted-kids': [] } })).join('\n'), /trusted-kids/);
  assert.match(errorsOf(controlConfig({ thresholds: { 'max-latency-p95-ms': 0 } })).join('\n'), /greater than 0/);
  assert.deepEqual(errorsOf('nope'), ['config must be an object']);
});

test('the JSON Schema and the parser describe the same control', () => {
  const schema = JSON.parse(readFileSync(new URL('../controls/external-service-reliability.requirement.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(schema.properties).sort(), [...CONFIG_PROPERTIES.descriptive, ...CONFIG_PROPERTIES.policy].sort());
  assert.deepEqual(Object.keys(schema.properties.evidence.properties).sort(), [...CONFIG_PROPERTIES.evidence].sort());
  assert.deepEqual(Object.keys(schema.properties.thresholds.properties).sort(), [...CONFIG_PROPERTIES.thresholds].sort());
  assert.deepEqual(schema.properties.evidence.properties.format.enum, [...EVIDENCE_FORMATS]);
  assert.deepEqual(schema.properties['min-confidence'].enum, [...CONFIDENCE_LEVELS]);
  assert.equal(schema.properties['control-id'].const, 'external-service-reliability');
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.evidence.additionalProperties, false);
  assert.equal(schema.properties.thresholds.additionalProperties, false);
  // Whatever the schema requires, the parser requires too.
  for (const key of schema.required as string[]) {
    const { [key]: _removed, ...rest } = controlConfig();
    if (key === 'name' || key === 'description') continue; // CALM's own members; they carry no policy
    assert.notEqual(errorsOf(rest).length, 0, `the parser accepts a control without "${key}"`);
  }
});
