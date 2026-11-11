import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trimTrailingSlashes } from '../src/trim.js';

test('trimTrailingSlashes removes only trailing slashes', () => {
  assert.equal(trimTrailingSlashes('https://api.hosannaith.com/'), 'https://api.hosannaith.com');
  assert.equal(trimTrailingSlashes('https://api.hosannaith.com///'), 'https://api.hosannaith.com');
  assert.equal(trimTrailingSlashes('https://api.hosannaith.com'), 'https://api.hosannaith.com');
  assert.equal(trimTrailingSlashes('//health//'), '//health');
  assert.equal(trimTrailingSlashes('///'), '');
  assert.equal(trimTrailingSlashes(''), '');
});

test('trimTrailingSlashes is linear on a long run of slashes (the quadratic regex took seconds)', () => {
  const evil = '/'.repeat(200_000) + 'x';
  const start = performance.now();
  assert.equal(trimTrailingSlashes(evil), evil);
  assert.equal(trimTrailingSlashes('/'.repeat(200_000)), '');
  assert.ok(performance.now() - start < 250, 'took too long');
});
