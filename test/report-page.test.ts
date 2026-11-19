// GET /reports/<id> and GET /reports (src/report-page.ts): a signed public report as a page.
// Keys are made at run time. The script that checks the signature in the reader's browser is run
// here against the same documents as the server's verifier, so the two cannot drift apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, webcrypto } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReport, type ReportCard } from '../src/attest/report.js';
import { attest, createSigner } from '../src/attest/sign.js';
import { publicJwk, thumbprint } from '../src/attest/keys.js';
import { verifyAttestation, type KeySet } from '../src/attest/verify.js';
import { loadKeyHistory, publishedKeySet } from '../src/attest/keyset.js';
import { REPORT_PAGE_HEADERS, VERIFY_SCRIPT, reportIndexPage, reportPage } from '../src/report-page.js';

const PUBLISHED_DIR = fileURLToPath(new URL('../public-reports/', import.meta.url));
const PUBLISHED_KEYS = publishedKeySet(loadKeyHistory());

function newKey() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const signer = createSigner(privateKey);
  const jwk = publicJwk(privateKey);
  const keySet: KeySet = { keys: [{ ...jwk, kid: thumbprint(jwk), alg: 'ES256', use: 'sig', status: 'active' }], revoked_keys: [] };
  return { signer, keySet, kid: thumbprint(jwk) };
}

function card(target: string, extra: Partial<ReportCard> = {}, summary: Partial<ReportCard['summary']> = {}): ReportCard {
  return {
    target,
    status: 'PASS',
    summary: {
      observations: 1000,
      windowHours: 168,
      score: 91.25,
      uptimePct: 99.9,
      correct402Pct: 100,
      p50LatencyMs: 207,
      p95LatencyMs: 354,
      p99LatencyMs: 900,
      firstObservedAt: '2026-11-01T00:00:00.000Z',
      lastObservedAt: '2026-11-08T00:00:00.000Z',
      ...summary,
    },
    sustained: [],
    transientDown: 0,
    transientUngated: 0,
    spikes: [],
    ...extra,
  };
}

/** Writes signed reports into a new directory and returns its path (with a trailing slash). */
function publish(reports: Array<{ id: string }>): string {
  const dir = mkdtempSync(join(tmpdir(), 'reports-')) + '/';
  for (const r of reports) writeFileSync(dir + r.id + '.json', JSON.stringify(r, null, 2));
  return dir;
}

const between = (html: string, open: string, close: string) => html.slice(html.indexOf(open) + open.length, html.indexOf(close));
/** The page without one element, found by plain string position. */
const without = (html: string, open: string, close: string) => html.slice(0, html.indexOf(open)) + html.slice(html.indexOf(close) + close.length);
/** True if the text contains any of the given pieces of markup, in any letter case. */
const hasMarkup = (html: string, ...pieces: string[]) => pieces.some((piece) => html.toLowerCase().includes(piece.toLowerCase()));

test('the published report renders with its figures, and says its signature was checked', async () => {
  const page = await reportPage(PUBLISHED_DIR, 'a-identity-2026-11', PUBLISHED_KEYS);
  assert.ok(page);
  assert.equal(page.verified, true);
  const report = JSON.parse(readFileSync(PUBLISHED_DIR + 'a-identity-2026-11.json', 'utf8'));
  assert.match(page.html, /<h1>Reliability report: A-Identity<\/h1>/);
  assert.match(page.html, /Signature valid\./);
  assert.match(page.html, /21 Oct 2026 to 4 Nov 2026 \(14 days\)\. 2 endpoints, 13,437 probes\./);
  for (const e of report.endpoints) {
    assert.ok(page.html.includes(`<h3>${e.target}</h3>`), e.target);
    assert.ok(page.html.includes(`<b>${e.score}</b> / 100`), `score ${e.score}`);
  }
  // The page names the exact file and signature it was built from, for the browser's check.
  assert.ok(page.html.includes(`data-report="a-identity-2026-11" data-sig="${report.signature.sig}"`));
  assert.ok(page.html.includes('href="/reports/a-identity-2026-11.json"'));
  assert.ok(page.html.includes(report.disclaimer));
});

test('the Content-Security-Policy allows exactly the stylesheet and the script the page carries', async () => {
  const page = await reportPage(PUBLISHED_DIR, 'a-identity-2026-11', PUBLISHED_KEYS);
  assert.ok(page);
  const hash = (text: string) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
  const csp = REPORT_PAGE_HEADERS['Content-Security-Policy'];
  assert.ok(csp.includes(`style-src ${hash(between(page.html, '<style>', '</style>'))};`));
  assert.ok(csp.includes(`script-src ${hash(between(page.html, '<script>', '</script>'))};`));
  assert.match(csp, /^default-src 'none';/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(page.html.split('<script').length, 2, 'exactly one script element');
  assert.equal(page.html.split('<style').length, 2, 'exactly one style element');
  assert.doesNotMatch(page.html, /\son[a-z]+=|style="|javascript:/i);
  assert.equal(REPORT_PAGE_HEADERS['X-Content-Type-Options'], 'nosniff');
});

test('outages, spikes and payment figures are shown when the report has them', async () => {
  const { signer, keySet } = newKey();
  const report = attest(
    signer,
    buildReport({ id: 'example-2026-11', subject: 'Example Co', scope: 'Covers only the endpoint listed below.' }, [
      card(
        'https://example.com/paid',
        {
          status: 'DEGRADED',
          sustained: [{ kind: 'down', start: '2026-11-03T10:00:00.000Z', end: '2026-11-03T11:30:00.000Z', durationMin: 90, probes: 30 }],
          transientDown: 2,
          transientUngated: 1,
          spikes: [
            { at: '2026-11-02T01:00:00.000Z', latencyMs: 1500 },
            { at: '2026-11-05T02:00:00.000Z', latencyMs: 4200 },
          ],
        },
        { score: 71, paymentRequirementsSamples: 400, acceptedNetworks: ['algorand:mainnet'], algorandIdForm: 'legacy', mainnetPayablePct: 100, currentSdkPayablePct: 0 },
      ),
    ]),
  );
  const page = await reportPage(publish([report]), 'example-2026-11', keySet);
  assert.ok(page?.verified);
  const html = page.html;
  assert.match(html, /<div class="score degraded"><b>71<\/b> \/ 100<br><span class="badge">degraded<\/span>/);
  assert.match(html, /<td>Down<\/td><td>3 Nov 2026, 10:00 UTC<\/td><td>3 Nov 2026, 11:30 UTC<\/td><td>1 h 30 min<\/td><td>30<\/td>/);
  assert.match(html, /Short errors<\/b> \(a single failed probe\): 3</);
  assert.match(html, /Latency spikes:<\/b> 2, the slowest 4,200 ms on 5 Nov 2026, 02:00 UTC/);
  assert.match(html, /from 400 recorded 402 responses; not part of the score/);
  assert.match(html, /<code>algorand:mainnet<\/code>/);
  assert.match(html, /the older form only\. Payable on Algorand Mainnet: <b>100%<\/b>\. Payable by the current x402 SDK: <b>0%<\/b>/);
});

test('text from a report cannot become markup', async () => {
  const { signer, keySet } = newKey();
  const hostile = '<script>alert(1)</script><img src=x onerror=alert(2)>"\'&';
  const base = buildReport({ id: 'hostile-2026-11', subject: hostile, scope: hostile }, [
    card(`https://example.com/${hostile}`, {}, { paymentRequirementsSamples: 3, acceptedNetworks: [hostile], algorandIdForm: 'spec' }),
  ]);
  const report = attest(signer, { ...base, method: `${hostile} https://github.com/cameron4316/x402-oracle-server#x"><b>y`, disclaimer: hostile });
  const page = await reportPage(publish([report]), 'hostile-2026-11', keySet);
  assert.ok(page?.verified);
  // Everything except the page's own stylesheet and script.
  const body = without(without(page.html, '<script>', '</script>'), '<style>', '</style>');
  assert.equal(hasMarkup(body, '<script', '<img', 'onerror=alert(2)>', '<b>y'), false);
  assert.ok(body.includes('&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(2)&gt;&quot;&#39;&amp;'));
  // A project link is still a link, and stops at the first character that could end the attribute.
  assert.ok(body.includes('<a href="https://github.com/cameron4316/x402-oracle-server#x">'));
  // The index page escapes too.
  assert.equal(hasMarkup(await reportIndexPage(publish([report]), keySet), '<script', '<img'), false);
});

test('a report that does not verify gets a page with no figures', async () => {
  const { signer, keySet, kid } = newKey();
  const good = attest(signer, buildReport({ id: 'example-2026-11', subject: 'Example Co', scope: 'One endpoint.' }, [card('https://example.com/paid')]));

  const edited = structuredClone(good) as typeof good;
  edited.endpoints[0].score = 100;
  const page = await reportPage(publish([edited]), 'example-2026-11', keySet);
  assert.ok(page);
  assert.equal(page.verified, false);
  assert.match(page.html, /Signature not valid\.<\/strong> The signature does not match the contents of the file\./);
  assert.match(page.html, /<meta name="robots" content="noindex">/);
  assert.equal(hasMarkup(page.html, 'example.com/paid', '/ 100', '<script'), false);

  const revoked: KeySet = { keys: [], revoked_keys: [{ kid }] };
  const revokedPage = await reportPage(publish([good]), 'example-2026-11', revoked);
  assert.equal(revokedPage?.verified, false);
  assert.match(revokedPage!.html, /The key that signed the file has been revoked\./);

  const other = newKey();
  const unknown = await reportPage(publish([good]), 'example-2026-11', other.keySet);
  assert.equal(unknown?.verified, false);
  assert.match(unknown!.html, /not among Hosannaith&#39;s published keys|not among Hosannaith's published keys/);

  // The list leaves out anything that does not verify.
  assert.match(await reportIndexPage(publish([edited]), keySet), /No reports have been published yet\./);
});

test('there is no page for a name that is not a published report', async () => {
  const { signer, keySet } = newKey();
  const good = attest(signer, buildReport({ id: 'example-2026-11', subject: 'Example Co', scope: 'One endpoint.' }, [card('https://example.com/paid')]));
  const dir = publish([good]);
  writeFileSync(dir + 'not-a-report.json', JSON.stringify(attest(signer, { type: 'something-else', id: 'not-a-report' })));
  writeFileSync(dir + 'renamed.json', JSON.stringify(good)); // the file name must be the report's own id
  writeFileSync(dir + 'broken.json', '{ not json');
  for (const id of ['no-such-report', 'not-a-report', 'renamed', 'broken', '../attest/jwks-history', 'Example-2026-11', 'a--b', '']) {
    assert.equal(await reportPage(dir, id, keySet), null, id);
  }
  assert.ok(await reportPage(dir, 'example-2026-11', keySet));
  assert.match(await reportIndexPage('/no/such/directory/', keySet), /No reports have been published yet\./);
});

test('the list shows verified reports, newest window first', async () => {
  const { signer, keySet } = newKey();
  const make = (id: string, subject: string, last: string) =>
    attest(signer, buildReport({ id, subject, scope: 'One endpoint.' }, [card('https://example.com/' + id, {}, { lastObservedAt: last })]));
  const dir = publish([make('older-2026-10', 'Older', '2026-11-02T00:00:00.000Z'), make('newer-2026-11', 'Newer', '2026-11-09T00:00:00.000Z')]);
  const html = await reportIndexPage(dir, keySet);
  assert.ok(html.indexOf('href="/reports/newer-2026-11"') > 0);
  assert.ok(html.indexOf('href="/reports/newer-2026-11"') < html.indexOf('href="/reports/older-2026-10"'));
  assert.equal(hasMarkup(html, '<script'), false);
});

// ---- the script that runs in the reader's browser

type BrowserVerify = (report: unknown, keySet: unknown, subtle: unknown) => Promise<{ state: string; kid?: string }>;
function browserVerify(): BrowserVerify {
  // Outside a browser the script only publishes its verify function (there is no document here).
  new Function(VERIFY_SCRIPT)();
  const fn = (globalThis as Record<string, unknown>).__hosannaithVerifyReport;
  assert.equal(typeof fn, 'function');
  return fn as BrowserVerify;
}

test("the browser's check agrees with the server's on the published report", async () => {
  const verify = browserVerify();
  const report = JSON.parse(readFileSync(PUBLISHED_DIR + 'a-identity-2026-11.json', 'utf8'));
  const keys = JSON.parse(JSON.stringify(PUBLISHED_KEYS));
  assert.deepEqual(await verify(report, keys, webcrypto.subtle), { state: 'valid', kid: report.signature.kid });
  assert.equal(verifyAttestation(report, PUBLISHED_KEYS).ok, true);
});

test("the browser's check and the server's give the same verdict, case by case", async () => {
  const verify = browserVerify();
  const { signer, keySet, kid } = newKey();
  // Awkward but legal content: key order, unicode, escapes, numbers that need care.
  const good = attest(signer, {
    type: 'hosannaith.reliability-report',
    id: 'odd-2026-11',
    'z last': 1,
    'a first': [1.5, 1e21, 0.000001, -0, 100, null, true, 'é', ' ', '"quoted"\\', { b: 2, a: 1 }],
    nested: { 'ключ': 'значение', '': 'empty key', deeper: { n: 1.0, s: '\n\t' } },
  });
  const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
  const edited = { ...plain(good), id: 'odd-2026-12' };
  const badSig = { ...plain(good), signature: { ...good.signature, sig: good.signature.sig.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) } };
  const wrongAlg = { ...plain(good), signature: { ...good.signature, alg: 'HS256' } };
  const { signature: _dropped, ...unsigned } = plain(good);
  const mislabelled: KeySet = { keys: [{ ...newKey().keySet.keys[0], kid }], revoked_keys: [] };

  const cases: Array<[string, unknown, KeySet, string, boolean]> = [
    ['as signed', plain(good), keySet, 'valid', true],
    ['a value changed', edited, keySet, 'invalid', false],
    ['the signature changed', badSig, keySet, 'invalid', false],
    ['the key revoked', plain(good), { keys: keySet.keys, revoked_keys: [{ kid }] }, 'revoked', false],
    ['a key set without the key', plain(good), newKey().keySet, 'unknown_key', false],
    ['a different key published under the same id', plain(good), mislabelled, 'unknown_key', false],
    ['another signing method', wrongAlg, keySet, 'malformed', false],
    ['no signature', unsigned, keySet, 'malformed', false],
    ['not an object', [plain(good)], keySet, 'malformed', false],
  ];
  for (const [name, doc, keys, state, ok] of cases) {
    assert.equal((await verify(doc, plain(keys), webcrypto.subtle)).state, state, name);
    assert.equal(verifyAttestation(doc, keys).ok, ok, name);
  }
});
