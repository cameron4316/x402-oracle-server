// Allowed history windows (src/checks/reliability/window.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_WINDOW_HOURS, parseWindowHours, WINDOW_HOURS_ALLOWED } from '../../src/checks/reliability/window.js';

test('24, 168 and 720 hours are allowed, as numbers or query strings; absent means 24', () => {
  assert.deepEqual([...WINDOW_HOURS_ALLOWED], [24, 168, 720]);
  assert.equal(DEFAULT_WINDOW_HOURS, 24);
  for (const v of [undefined, null, '']) assert.deepEqual(parseWindowHours(v), { ok: true, hours: 24 });
  for (const h of [24, 168, 720]) {
    assert.deepEqual(parseWindowHours(h), { ok: true, hours: h });
    assert.deepEqual(parseWindowHours(String(h)), { ok: true, hours: h });
    assert.deepEqual(parseWindowHours(` ${h} `), { ok: true, hours: h });
  }
});

test('anything else is refused with the allowed list', () => {
  for (const v of [0, 1, 48, 167, 169, 8760, -24, 24.5, '48', '24h', '0x18', '1e2', 'abc', {}, [], true]) {
    const r = parseWindowHours(v);
    assert.equal(r.ok, false, `${JSON.stringify(v)} should be refused`);
    assert.match((r as { reason: string }).reason, /one of 24, 168, 720/);
  }
});
