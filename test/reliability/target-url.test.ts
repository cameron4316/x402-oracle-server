// Which targets Hosannaith will probe (src/checks/reliability/target-url.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertTarget, checkTarget, MAX_TARGET_LENGTH, TargetRejectedError } from '../../src/checks/reliability/target-url.js';

const allowed = [
  'https://x402.goplausible.xyz/examples/weather',
  'https://api.example.com/x402?plan=pro',
  'http://example.com:8080/pay',
  'https://8.8.8.8/x',
  'http://172.32.0.1/', // just outside 172.16.0.0/12
  'http://[2606:4700::1111]/',
  'http://[::ffff:8.8.8.8]/',
  'http://example.com./',
];

const refused: Array<[string, RegExp]> = [
  ['http://127.0.0.1:4021/health', /private or reserved/],
  ['http://2130706433/', /private or reserved/], // 127.0.0.1 as a decimal integer
  ['http://0x7f.1/', /private or reserved/], // 127.0.0.1 in hex shorthand
  ['http://017700000001/', /private or reserved/], // 127.0.0.1 in octal
  ['http://169.254.169.254/latest/meta-data', /private or reserved/], // cloud metadata
  ['http://10.1.2.3/', /private or reserved/],
  ['http://172.31.255.255/', /private or reserved/],
  ['http://192.168.1.1/', /private or reserved/],
  ['http://100.64.1.1/', /private or reserved/],
  ['http://0.0.0.0/', /private or reserved/],
  ['http://224.0.0.1/', /private or reserved/],
  ['http://[::1]/', /private or reserved/],
  ['http://[::]/', /private or reserved/],
  ['http://[::ffff:127.0.0.1]/', /private or reserved/],
  ['http://[::ffff:10.0.0.1]/', /private or reserved/],
  ['http://[fe80::1]/', /private or reserved/],
  ['http://[fd00::1]/', /private or reserved/],
  ['http://[64:ff9b::7f00:1]/', /private or reserved/],
  ['http://localhost:4021/', /not a public host name/],
  ['http://api.localhost/', /not a public host name/],
  ['http://printer.local/', /not a public host name/],
  ['https://api.internal/x', /not a public host name/],
  ['http://intranet/', /not a public host name/],
  ['file:///etc/passwd', /http or https/],
  ['ftp://example.com/', /http or https/],
  ['javascript:alert(1)', /http or https/],
  ['https://user:pass@example.com/', /credentials/],
  ['not a url', /absolute URL/],
  ['/relative/path', /absolute URL/],
  ['', /empty/],
  ['   ', /empty/],
];

test('public http(s) URLs are accepted, exactly as sent (only trimmed)', () => {
  for (const t of allowed) assert.deepEqual(checkTarget(t), { ok: true, target: t }, t);
  assert.deepEqual(checkTarget('  https://example.com/a  '), { ok: true, target: 'https://example.com/a' });
});

test('private, internal, non-http and malformed targets are refused with a reason', () => {
  for (const [t, reason] of refused) {
    const r = checkTarget(t);
    assert.equal(r.ok, false, `${t} should be refused`);
    assert.match((r as { reason: string }).reason, reason, t);
  }
});

test('non-strings and over-long URLs are refused', () => {
  assert.match((checkTarget(42) as { reason: string }).reason, /string/);
  assert.match((checkTarget(null) as { reason: string }).reason, /string/);
  const long = 'https://example.com/' + 'a'.repeat(MAX_TARGET_LENGTH);
  const r = checkTarget(long);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /longer than 2048/);
  assert.ok(r.target.length < 100, 'the echoed target is clipped');
  assert.equal(checkTarget('https://example.com/' + 'a'.repeat(MAX_TARGET_LENGTH - 20)).ok, true);
});

test('assertTarget throws TargetRejectedError for a refused target', () => {
  assert.equal(assertTarget(' https://example.com/x '), 'https://example.com/x');
  assert.throws(() => assertTarget('http://127.0.0.1/'), (e: unknown) => e instanceof TargetRejectedError && /private/.test(e.reason));
});
