import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SECURITY_CONTACT,
  SECURITY_TXT_CANONICAL,
  SECURITY_TXT_EXPIRES,
  securityTxt,
} from '../src/security-txt.js';

const fields = (text: string) =>
  text
    .split('\n')
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const i = line.indexOf(': ');
      return [line.slice(0, i), line.slice(i + 2)] as const;
    });

test('security.txt has the RFC 9116 required fields, exactly once each', () => {
  const f = fields(securityTxt());
  assert.deepEqual(f.filter(([k]) => k === 'Contact').map(([, v]) => v), [`mailto:${SECURITY_CONTACT}`]);
  assert.equal(f.filter(([k]) => k === 'Expires').length, 1);
  assert.deepEqual(f.filter(([k]) => k === 'Canonical').map(([, v]) => v), [...SECURITY_TXT_CANONICAL]);
  assert.ok(f.every(([k]) => ['Contact', 'Expires', 'Preferred-Languages', 'Canonical', 'Policy'].includes(k)));
  assert.ok(securityTxt().endsWith('\n'));
});

test('Expires is a valid UTC date in the future and less than a year ahead (renew it when this fails)', () => {
  const expires = Date.parse(SECURITY_TXT_EXPIRES);
  assert.ok(Number.isFinite(expires), 'Expires does not parse');
  assert.equal(new Date(expires).toISOString(), SECURITY_TXT_EXPIRES, 'Expires is not RFC 3339 UTC');
  const days = (expires - Date.now()) / 86_400_000;
  assert.ok(days > 0, 'security.txt has expired: set a new SECURITY_TXT_EXPIRES and republish the site copy');
  assert.ok(days <= 366, 'Expires is more than a year ahead (RFC 9116 recommends less than a year)');
});

test('SECURITY.md points at the same contact address', () => {
  const md = readFileSync(new URL('../SECURITY.md', import.meta.url), 'utf8');
  assert.ok(md.includes(SECURITY_CONTACT));
});
