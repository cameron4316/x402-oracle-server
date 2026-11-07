// The remote MCP audit log (src/mcp-audit.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog, classify, stripTarget, withAudit, type AuditRecord } from '../src/mcp-audit.js';

const tmp = () => join(mkdtempSync(join(tmpdir(), 'mcp-audit-')), 'audit.jsonl');
const lines = (p: string): AuditRecord[] => readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

const QUOTE = { scheme: 'exact', network: 'algorand:test', amount: '1000000', asset: '31566704', payTo: 'PAYTO' };
const paymentRequired = (error: string) => ({
  structuredContent: { x402Version: 2, error, accepts: [QUOTE] },
  content: [{ type: 'text', text: JSON.stringify({ x402Version: 2, error, accepts: [QUOTE] }) }],
  isError: true,
});
const settled = (body: object, receipt: object) => ({
  content: [{ type: 'text', text: JSON.stringify(body) }],
  _meta: { 'x402/payment-response': receipt },
});

test('stripTarget drops query strings, fragments and credentials', () => {
  assert.equal(stripTarget('https://u:p@api.example.com:8443/pay?token=secret#frag'), 'https://api.example.com:8443/pay');
  assert.equal(stripTarget(42), '<not a string>');
  assert.match(stripTarget('nope?key=1'), /^<invalid> /);
});

test('classify: an unpaid call is payment_required, with the quote we offered', () => {
  const c = classify('paid', false, paymentRequired('Payment required to access this tool'));
  assert.equal(c.mode, 'payment_required');
  assert.equal(c.outcome, 'payment_required');
  assert.deepEqual(c.quote, { scheme: 'exact', amount: '1000000', asset: '31566704', network: 'algorand:test' });
  assert.match(c.error!, /Payment required/);
});

test('classify: a payment that was presented but answered with a 402 is payment_rejected', () => {
  const c = classify('paid', true, paymentRequired('Payment settlement failed: insufficient funds'));
  assert.equal(c.outcome, 'payment_rejected');
  assert.match(c.error!, /settlement failed/);
});

test('classify: a settled call records the on-chain receipt', () => {
  const c = classify('paid', true, settled({ status: 'pass' }, { success: true, transaction: 'TXID', network: 'algorand:test', payer: 'PAYER', amount: '1000000' }));
  assert.equal(c.mode, 'paid');
  assert.equal(c.outcome, 'ok');
  assert.deepEqual(c.settlement, { success: true, transaction: 'TXID', network: 'algorand:test', payer: 'PAYER', amount: '1000000', error_reason: undefined });
  const failed = classify('paid', true, settled({}, { success: false, errorReason: 'invalid_transaction' }));
  assert.equal(failed.outcome, 'settle_failed');
  assert.equal(failed.settlement!.error_reason, 'invalid_transaction');
});

test('withAudit logs a settled paid call without the payment payload', async () => {
  const path = tmp();
  const log = new AuditLog(path);
  const body = { target: 'https://a.example/x', status: 'pass', score: 97.5, signature: { alg: 'ES256', kid: 'KID', sig: 'S' } };
  const tool = withAudit(log, 'check_x402_reliability', 'paid', async () =>
    settled(body, { success: true, transaction: 'TXID', network: 'algorand:test', payer: 'PAYER' }),
  );
  const result = await tool({ target: 'https://a.example/x?key=secret' }, { _meta: { 'x402/payment': { signedTxn: 'SECRET-PAYLOAD' } } });
  assert.equal((result.content![0] as { text: string }).text, JSON.stringify(body), 'the result is returned unchanged');
  await log.flush();
  const [r] = lines(path);
  assert.equal(r.tool, 'check_x402_reliability');
  assert.equal(r.mode, 'paid');
  assert.equal(r.outcome, 'ok');
  assert.equal(r.payment_presented, true);
  assert.deepEqual(r.targets, ['https://a.example/x']);
  assert.equal(r.result_status, 'pass');
  assert.equal(r.result_score, 97.5);
  assert.equal(r.signed_kid, 'KID');
  assert.equal(r.settlement!.transaction, 'TXID');
  assert.equal(typeof r.duration_ms, 'number');
  const raw = readFileSync(path, 'utf8');
  assert.ok(!raw.includes('SECRET-PAYLOAD') && !raw.includes('key=secret'), 'no payment payload, no query string');
});

test('withAudit logs a batch, the free tool, and a thrown error (and rethrows it)', async () => {
  const path = tmp();
  const log = new AuditLog(path);
  await withAudit(log, 'check_x402_reliability_batch', 'paid', async () => paymentRequired('Payment required'))(
    { targets: ['https://a.example/1', 'https://b.example/2?x=1'] },
    {},
  );
  await withAudit(log, 'get_hosannaith_info', 'free', async () => ({ content: [{ type: 'text', text: 'Hosannaith is…' }] }))({}, {});
  const boom = withAudit(log, 'check_x402_reliability', 'paid', async () => {
    throw new Error('handler blew up');
  });
  await assert.rejects(() => boom({ target: 'https://c.example/' }, {}), /handler blew up/);
  await log.flush();
  const [batch, info, err] = lines(path);
  assert.deepEqual(batch.targets, ['https://a.example/1', 'https://b.example/2']);
  assert.equal(batch.outcome, 'payment_required');
  assert.equal(batch.quote!.amount, '1000000');
  assert.equal(info.mode, 'free');
  assert.equal(info.outcome, 'ok');
  assert.equal(info.targets, undefined);
  assert.equal(err.outcome, 'error');
  assert.match(err.error!, /handler blew up/);
});

test('the log rotates past its size cap and keeps one older file', async () => {
  const path = tmp();
  const log = new AuditLog(path, 600);
  const call = withAudit(log, 'get_hosannaith_info', 'free', async () => ({ content: [{ type: 'text', text: 'x' }] }));
  for (let i = 0; i < 12; i++) await call({}, {});
  await log.flush();
  assert.ok(existsSync(`${path}.1`), 'rotated file exists');
  assert.ok(readFileSync(path).length <= 600, 'current file stays under the cap');
  assert.ok(readFileSync(`${path}.1`).length <= 600);
});

test('a write failure is reported, never thrown into the tool call', async () => {
  const errors: unknown[] = [];
  const log = new AuditLog('/dev/null/cannot/write/here.jsonl', 1000, (e) => errors.push(e));
  const result = await withAudit(log, 'get_hosannaith_info', 'free', async () => ({ content: [{ type: 'text', text: 'ok' }] }))({}, {});
  assert.equal(result.content![0].text, 'ok');
  await log.flush();
  assert.equal(errors.length, 1);
});
