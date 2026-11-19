// A signed public report as a page a person can read: GET /reports/<id>, next to the signed file at
// GET /reports/<id>.json. Free and read-only; nothing here touches the payment code.
//
// Rules this file keeps:
//   - Figures are shown only for a report whose signature this server has just verified against the
//     published keys. Anything else gets a page that says so and shows no figures.
//   - Every value from the report is HTML-escaped. A report is our own signed document, but some of
//     its strings (endpoint URLs, network ids) started life outside this service.
//   - No inline event handlers, no external resources. The Content-Security-Policy allows exactly
//     the one stylesheet and the one script below, by hash.
//   - The script checks the signature again in the reader's browser (Web Crypto), from the signed
//     file and the published keys, and says plainly when it could not.
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { REPORT_ID_PATTERN, REPORT_TYPE } from './attest/report.js';
import { verifyAttestation, type KeySet, type VerifyOutcome } from './attest/verify.js';

const SITE_URL = 'https://hosannaith.com';
const API_URL = 'https://api.hosannaith.com';
const REPO_URL = 'https://github.com/cameron4316/x402-oracle-server';
const VERIFY_URL = `${REPO_URL}/blob/main/docs/attestation.md#verifying`;
const KEYS_PATH = '/.well-known/hosannaith-keys.json';
const CONTACT = 'cameron@hosannaith.com';

type Json = Record<string, unknown>;

// ---------------------------------------------------------------- small helpers

export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const fmt = (v: number): string => v.toLocaleString('en-US', { maximumFractionDigits: 2 });
const count = (v: unknown): string => (num(v) === null ? 'not recorded' : fmt(num(v)!));
const pct = (v: unknown): string => (num(v) === null ? 'not measured' : `${fmt(num(v)!)}%`);
const ms = (v: unknown): string => (num(v) === null ? 'not measured' : `${fmt(num(v)!)} ms`);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "21 Oct 2026, 03:54 UTC". Always UTC, so the page reads the same for every reader. */
export function when(iso: unknown, withTime = true): string {
  if (typeof iso !== 'string') return 'not recorded';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  const date = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  if (!withTime) return date;
  const two = (n: number) => String(n).padStart(2, '0');
  return `${date}, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`;
}

function span(hours: number | null): string {
  if (hours === null) return 'window not recorded';
  if (hours < 48) return `${fmt(Math.round(hours))} hours`;
  return `${fmt(Math.round(hours / 24))} days`;
}

function minutes(v: unknown): string {
  const m = num(v);
  if (m === null) return 'not recorded';
  if (m < 60) return `${fmt(Math.round(m))} min`;
  return `${Math.floor(m / 60)} h ${Math.round(m % 60)} min`;
}

const plural = (n: number, one: string, many: string) => `${fmt(n)} ${n === 1 ? one : many}`;
const shortKid = (kid: string) => (kid.length > 16 ? `${kid.slice(0, 8)}…${kid.slice(-6)}` : kid);

/** Escapes text, and links only URLs in this project's own repository. */
function withProjectLinks(text: string): string {
  const parts = text.split(/(https:\/\/github\.com\/cameron4316\/x402-oracle-server[^\s"'<>]*)/);
  return parts
    .map((part, i) => {
      if (i % 2 === 0) return esc(part);
      const trailing = /[.,;:)]+$/.exec(part)?.[0] ?? '';
      const url = part.slice(0, part.length - trailing.length);
      return `<a href="${esc(url)}">${esc(url)}</a>${esc(trailing)}`;
    })
    .join('');
}

// ---------------------------------------------------------------- style and script (fixed text)

// Colours follow hosannaith.com: near-black, a crimson wordmark, gold accents. System fonts only,
// because the page loads nothing from anywhere else.

const STYLE = `
:root { color-scheme: dark; --bg: #0B0908; --panel: #151210; --line: #332D27; --ink: #F7F3EC;
  --soft: #BDB3A4; --gold: #D9B44A; --mark: #B8192F; --good: #8FD6A0; --warn: #F0C36A; --bad: #FF9A8B; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink);
  font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
main { max-width: 880px; margin: 0 auto; padding: 32px 20px 64px; }
a { color: var(--gold); }
code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.92em; }
.top { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; flex-wrap: wrap;
  padding-bottom: 16px; border-bottom: 1px solid var(--line); }
.brand { color: var(--mark); font-family: Georgia, "Times New Roman", serif; font-weight: 700; text-decoration: none; font-size: 1.5rem; }
.kind { color: var(--soft); font-size: 0.85rem; letter-spacing: 0.08em; text-transform: uppercase; }
h1 { font-family: Georgia, "Times New Roman", serif; font-size: 2.2rem; line-height: 1.15; margin: 32px 0 8px; }
h2 { font-family: Georgia, "Times New Roman", serif; font-size: 1.3rem; margin: 40px 0 12px; color: var(--gold); }
h3 { font-size: 1rem; margin: 0; font-weight: 600; word-break: break-all; }
p { margin: 0 0 12px; }
.lede { color: var(--soft); margin-bottom: 24px; }
.soft { color: var(--soft); }
.sig { border: 1px solid var(--gold); border-radius: 10px; padding: 16px 20px; background: var(--panel); }
.sig[data-state="bad"], .sig[data-browser="bad"] { border-color: var(--bad); }
.sig strong { font-size: 1.05rem; }
.sig .ok { color: var(--good); }
.sig .no { color: var(--bad); }
.sig p:last-child { margin-bottom: 0; }
.links { font-size: 0.92rem; display: flex; flex-wrap: wrap; gap: 4px 16px; }
.links a { white-space: nowrap; }
.card { border: 1px solid var(--line); border-radius: 10px; padding: 20px; background: var(--panel); margin-bottom: 16px; }
.head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
.score { text-align: right; white-space: nowrap; }
.score b { font-size: 1.6rem; line-height: 1; }
.badge { display: inline-block; border: 1px solid currentColor; border-radius: 999px; padding: 0 10px;
  font-size: 0.75rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
.pass { color: var(--good); } .degraded { color: var(--warn); } .fail { color: var(--bad); } .unknown { color: var(--soft); }
dl.stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 16px 0; }
dl.stats div { border-top: 1px solid var(--line); padding-top: 8px; }
dt { color: var(--soft); font-size: 0.8rem; }
dd { margin: 0; font-size: 1.15rem; font-weight: 600; }
dd small { font-size: 0.8rem; font-weight: 400; color: var(--soft); display: block; }
.facts { font-size: 0.92rem; color: var(--soft); }
.facts p { margin-bottom: 6px; }
.facts b { color: var(--ink); font-weight: 600; }
table { width: 100%; border-collapse: collapse; font-size: 0.9rem; margin: 8px 0 12px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); }
th { color: var(--soft); font-weight: 500; }
ul.plain { list-style: none; padding: 0; margin: 0; }
ul.plain li { padding: 12px 0; border-bottom: 1px solid var(--line); }
footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--line); color: var(--soft); font-size: 0.9rem; }
@media (max-width: 640px) { h1 { font-size: 1.5rem; } dl.stats { grid-template-columns: repeat(2, 1fr); }
  .head { flex-direction: column; } .score { text-align: left; } }
@media print { :root { color-scheme: light; --bg: #fff; --panel: #fff; --line: #bbb; --ink: #111; --soft: #444;
  --gold: #6b5200; --mark: #B8192F; --good: #1b6b2f; --warn: #7a5200; --bad: #9b1c1c; } main { padding: 0; } .card { break-inside: avoid; } }
`;

// Runs in the reader's browser. Plain script, no build step, the same text for every report (so one
// hash in the Content-Security-Policy covers it). The canonical form and the checks follow
// src/attest/jcs.ts and src/attest/verify.ts; test/report-page.test.ts runs this text against both.
export const VERIFY_SCRIPT = String.raw`
(function () {
  "use strict";
  function canonicalize(v) {
    if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
    if (typeof v === "number") {
      if (!isFinite(v)) throw new TypeError("non-finite number");
      return JSON.stringify(v);
    }
    if (Array.isArray(v)) {
      return "[" + v.map(function (x) { return x === undefined ? "null" : canonicalize(x); }).join(",") + "]";
    }
    if (typeof v === "object") {
      var keys = Object.keys(v).filter(function (k) { return v[k] !== undefined; }).sort();
      return "{" + keys.map(function (k) { return JSON.stringify(k) + ":" + canonicalize(v[k]); }).join(",") + "}";
    }
    throw new TypeError("cannot canonicalize");
  }
  function fromBase64Url(s) {
    var b = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    var out = new Uint8Array(b.length);
    for (var i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
    return out;
  }
  function toBase64Url(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  // Returns { state, kid }. state: valid | invalid | revoked | unknown_key | malformed.
  async function verifyReport(report, keySet, subtle) {
    if (!report || typeof report !== "object" || Array.isArray(report)) return { state: "malformed" };
    var signature = report.signature;
    if (!signature || typeof signature !== "object" || typeof signature.kid !== "string" || typeof signature.sig !== "string") {
      return { state: "malformed" };
    }
    var kid = signature.kid;
    if (signature.alg !== "ES256" || !/^[A-Za-z0-9_-]{86}$/.test(signature.sig)) return { state: "malformed", kid: kid };
    var revoked = keySet && Array.isArray(keySet.revoked_keys) ? keySet.revoked_keys : [];
    if (revoked.some(function (r) { return r && r.kid === kid; })) return { state: "revoked", kid: kid };
    var keys = keySet && Array.isArray(keySet.keys) ? keySet.keys : [];
    var key = keys.filter(function (k) { return k && k.kid === kid; })[0];
    if (!key || key.kty !== "EC" || key.crv !== "P-256" || typeof key.x !== "string" || typeof key.y !== "string") {
      return { state: "unknown_key", kid: kid };
    }
    var enc = new TextEncoder();
    // The key id must be the RFC 7638 thumbprint of the key it names.
    var members = JSON.stringify({ crv: key.crv, kty: key.kty, x: key.x, y: key.y });
    var thumb = toBase64Url(new Uint8Array(await subtle.digest("SHA-256", enc.encode(members))));
    if (thumb !== kid) return { state: "unknown_key", kid: kid };
    var unsigned = {};
    Object.keys(report).forEach(function (k) {
      if (k !== "signature") Object.defineProperty(unsigned, k, { value: report[k], enumerable: true });
    });
    var publicKey = await subtle.importKey(
      "jwk", { kty: "EC", crv: "P-256", x: key.x, y: key.y }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    var ok = await subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, publicKey, fromBase64Url(signature.sig), enc.encode(canonicalize(unsigned)));
    return { state: ok ? "valid" : "invalid", kid: kid };
  }

  if (typeof document === "undefined") { globalThis.__hosannaithVerifyReport = verifyReport; return; }

  var box = document.getElementById("sig");
  var note = document.getElementById("sig-browser");
  if (!box || !note || !box.getAttribute("data-report")) return;
  function say(state, text) { box.setAttribute("data-browser", state); note.textContent = text; }
  if (!window.crypto || !window.crypto.subtle || !window.fetch) {
    say("none", "This browser cannot check signatures, so the line above is the server's check only.");
    return;
  }
  say("checking", "Checking again in your browser…");
  function getJson(url) {
    return fetch(url, { cache: "no-store", credentials: "omit" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }
  var file = "/reports/" + box.getAttribute("data-report") + ".json";
  Promise.all([getJson(file), getJson("/.well-known/hosannaith-keys.json")])
    .then(function (got) {
      return verifyReport(got[0], got[1], window.crypto.subtle).then(function (result) {
        var same = got[0] && got[0].signature && got[0].signature.sig === box.getAttribute("data-sig");
        if (result.state === "valid" && !same) {
          say("none", "The signed file has changed since this page was built. Reload the page.");
        } else if (result.state === "valid") {
          say("ok", "Checked again in your browser: the signature on the signed file is valid for Hosannaith's published key.");
        } else if (result.state === "revoked") {
          say("bad", "Your browser's check: the key that signed this report has been revoked. Do not rely on this page.");
        } else if (result.state === "unknown_key") {
          say("bad", "Your browser's check: the signing key is not among Hosannaith's published keys. Do not rely on this page.");
        } else {
          say("bad", "Your browser's check failed: the signature does not match the signed file. Do not rely on this page.");
        }
      });
    })
    .catch(function () {
      say("none", "Your browser could not fetch the signed file and the keys, so the line above is the server's check only.");
    });
})();
`;

const sha256Base64 = (text: string) => createHash('sha256').update(text, 'utf8').digest('base64');

/** Response headers for every report page. Only this page's own stylesheet and script may run. */
export const REPORT_PAGE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'public, max-age=300',
  'Content-Security-Policy': [
    "default-src 'none'",
    `style-src 'sha256-${sha256Base64(STYLE)}'`,
    `script-src 'sha256-${sha256Base64(VERIFY_SCRIPT)}'`,
    "connect-src 'self'",
    "img-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

// ---------------------------------------------------------------- page parts

function shell(opts: { title: string; description: string; path: string; index: boolean; body: string; script: boolean }): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(opts.title)} | Hosannaith</title>
<meta name="description" content="${esc(opts.description)}">
${opts.index ? '' : '<meta name="robots" content="noindex">\n'}<meta property="og:site_name" content="Hosannaith">
<meta property="og:title" content="${esc(opts.title)}">
<meta property="og:description" content="${esc(opts.description)}">
<meta property="og:image" content="${API_URL}/og-image.png">
<meta property="og:url" content="${esc(API_URL + opts.path)}">
<meta property="og:type" content="article">
<style>${STYLE}</style>
</head>
<body>
<main>
<div class="top"><a class="brand" href="${SITE_URL}">Hosannaith</a><span class="kind">Signed reliability report</span></div>
${opts.body}
<footer>
<p>Published by Hosannaith, an independent reliability oracle for x402 endpoints. <a href="${SITE_URL}">hosannaith.com</a></p>
<p>Run an x402 endpoint and want a report on yours? Write to <a href="mailto:${CONTACT}">${CONTACT}</a>.</p>
</footer>
</main>
${opts.script ? `<script>${VERIFY_SCRIPT}</script>\n` : ''}</body>
</html>
`;
}

function outagesTable(rows: unknown[]): string {
  const body = rows
    .filter(isObject)
    .map(
      (o) =>
        `<tr><td>${o.kind === 'ungated' ? 'Answered without asking for payment' : 'Down'}</td><td>${esc(when(o.start))}</td>` +
        `<td>${esc(when(o.end))}</td><td>${esc(minutes(o.durationMin))}</td><td>${esc(count(o.probes))}</td></tr>`,
    )
    .join('\n');
  return `<table>
<thead><tr><th scope="col">What happened</th><th scope="col">From</th><th scope="col">To</th><th scope="col">Lasted</th><th scope="col">Probes</th></tr></thead>
<tbody>
${body}
</tbody>
</table>`;
}

const ID_FORM: Record<string, string> = {
  spec: 'the current standard form',
  legacy: 'the older form only',
  both: 'both the current and the older form',
};

function paymentFacts(payment: Json): string {
  const networks = list(payment.acceptedNetworks).filter((n): n is string => typeof n === 'string');
  const form = str(payment.algorandIdForm);
  return `<p><b>Payment requests</b> (from ${esc(count(payment.samples))} recorded 402 responses; not part of the score)</p>
<p>Networks asked for: ${networks.length ? networks.map((n) => `<code>${esc(n)}</code>`).join(', ') : 'none recorded'}</p>
<p>Algorand network id: ${esc(ID_FORM[form] ?? 'not recorded')}. Payable on Algorand Mainnet: <b>${esc(pct(payment.mainnetPayablePct))}</b>. Payable by the current x402 SDK: <b>${esc(pct(payment.currentSdkPayablePct))}</b>.</p>`;
}

function endpointCard(e: Json): string {
  const status = ['pass', 'degraded', 'fail'].includes(str(e.status)) ? str(e.status) : 'unknown';
  const score = num(e.score);
  const outages = list(e.sustainedOutages);
  const spikes = list(e.latencySpikes).filter(isObject);
  const worst = spikes.reduce<Json | null>((a, s) => ((num(s.latencyMs) ?? 0) > (num(a?.latencyMs) ?? -1) ? s : a), null);
  const errors = num(e.transientErrors);
  return `<article class="card">
<div class="head">
<h3>${esc(str(e.target, 'endpoint not named'))}</h3>
<div class="score ${status}"><b>${score === null ? 'No score' : esc(fmt(score))}</b>${score === null ? '' : ' / 100'}<br><span class="badge">${esc(status)}</span></div>
</div>
<dl class="stats">
<div><dt>Uptime</dt><dd>${esc(pct(e.uptimePct))}</dd></div>
<div><dt>Correct 402</dt><dd>${esc(pct(e.correct402Pct))}</dd></div>
<div><dt>Latency, median</dt><dd>${esc(ms(e.p50LatencyMs))}<small>95th ${esc(ms(e.p95LatencyMs))}, 99th ${esc(ms(e.p99LatencyMs))}</small></dd></div>
<div><dt>Probes</dt><dd>${esc(count(e.probes))}</dd></div>
</dl>
<div class="facts">
<p>Observed from ${esc(when(e.firstObservedAt))} to ${esc(when(e.lastObservedAt))}.</p>
<p><b>Sustained outages:</b> ${outages.length ? esc(fmt(outages.length)) : 'none'}</p>
${outages.length ? outagesTable(outages) : ''}
<p><b>Short errors</b> (a single failed probe): ${errors === null ? 'not recorded' : esc(fmt(errors))}</p>
<p><b>Latency spikes:</b> ${spikes.length ? esc(fmt(spikes.length)) : 'none'}${worst ? `, the slowest ${esc(ms(worst.latencyMs))} on ${esc(when(worst.at))}` : ''}</p>
${isObject(e.payment) ? paymentFacts(e.payment) : ''}
</div>
</article>`;
}

function summaryLine(report: Json): string {
  const window = isObject(report.window) ? report.window : {};
  const endpoints = list(report.endpoints).filter(isObject);
  const probes = endpoints.reduce((a, e) => a + (num(e.probes) ?? 0), 0);
  return (
    `${when(window.from, false)} to ${when(window.to, false)} (${span(num(window.hours))}). ` +
    `${plural(endpoints.length, 'endpoint', 'endpoints')}, ${plural(probes, 'probe', 'probes')}.`
  );
}

/** The page for a report whose signature has been verified. `outcome.ok` must be true. */
export function renderReportPage(report: Json, kid: string): string {
  const id = str(report.id);
  const title = str(report.title, `Reliability report: ${str(report.subject, id)}`);
  const summary = summaryLine(report);
  const signature = isObject(report.signature) ? report.signature : {};
  const endpoints = list(report.endpoints).filter(isObject);
  const body = `<h1>${esc(title)}</h1>
<p class="lede">${esc(summary)}</p>
<section class="sig" id="sig" data-state="ok" data-report="${esc(id)}" data-sig="${esc(str(signature.sig))}" aria-live="polite">
<p><strong class="ok">Signature valid.</strong> Signed by Hosannaith on ${esc(when(report.generated_at))} with key <code title="${esc(kid)}">${esc(shortKid(kid))}</code>. This server checked it when it built this page.</p>
<p class="soft" id="sig-browser"></p>
<p class="links"><a href="/reports/${esc(id)}.json">The signed file (JSON)</a><a href="${KEYS_PATH}">Published keys</a><a href="${VERIFY_URL}">Check it yourself</a></p>
</section>
<h2>What this report covers</h2>
<p>${esc(str(report.scope, 'The report does not state its scope.'))}</p>
<h2>Endpoints</h2>
${endpoints.map(endpointCard).join('\n')}
<h2>How it was measured</h2>
<p class="soft">${withProjectLinks(str(report.method, 'The report does not state its method.'))}</p>
<h2>What this report is not</h2>
<p class="soft">${esc(str(report.disclaimer))}</p>
<p class="soft">The figures above are those in the signed file. A report is never edited after it is published; a newer report gets a new address. <a href="/reports">All reports</a></p>`;
  return shell({
    title,
    description: `Signed by Hosannaith. ${summary}`,
    path: `/reports/${id}`,
    index: true,
    body,
    script: true,
  });
}

const FAILURE_TEXT: Record<string, string> = {
  signature_missing: 'The file carries no signature.',
  malformed_signature: 'The signature on the file is not in a form that can be checked.',
  unsupported_alg: 'The file is signed with a method this service does not use.',
  revoked_kid: 'The key that signed the file has been revoked.',
  unknown_kid: "The key that signed the file is not among Hosannaith's published keys.",
  signature_invalid: 'The signature does not match the contents of the file.',
};

/** The page for a report that exists but did not verify. Shows no figures. */
export function renderUnverifiedPage(id: string, reason: string): string {
  const body = `<h1>This report could not be verified</h1>
<section class="sig" data-state="bad">
<p><strong class="no">Signature not valid.</strong> ${esc(FAILURE_TEXT[reason] ?? 'The signature could not be checked.')}</p>
<p>No figures are shown, because they cannot be relied on. If you were sent a link to this page, please tell <a href="mailto:${CONTACT}">${CONTACT}</a>.</p>
<p class="links"><a href="/reports/${esc(id)}.json">The file (JSON)</a><a href="${KEYS_PATH}">Published keys</a><a href="${VERIFY_URL}">Check it yourself</a></p>
</section>`;
  return shell({
    title: 'Report could not be verified',
    description: 'This report did not pass its signature check, so no figures are shown.',
    path: `/reports/${id}`,
    index: false,
    body,
    script: false,
  });
}

/** The list of published reports. Only reports that verify are listed. */
export function renderIndexPage(reports: Json[]): string {
  const items = reports
    .map(
      (r) =>
        `<li><a href="/reports/${esc(str(r.id))}">${esc(str(r.title, str(r.id)))}</a><br><span class="soft">${esc(summaryLine(r))}</span></li>`,
    )
    .join('\n');
  const body = `<h1>Reliability reports</h1>
<p class="lede">Dated, signed snapshots of what Hosannaith measured for a named set of x402 endpoints. Each can be checked against Hosannaith's published keys, and none is edited after it is published.</p>
${reports.length ? `<ul class="plain">\n${items}\n</ul>` : '<p>No reports have been published yet.</p>'}`;
  return shell({
    title: 'Reliability reports',
    description: 'Dated, signed reliability reports for x402 endpoints, published by Hosannaith.',
    path: '/reports',
    index: true,
    body,
    script: false,
  });
}

// ---------------------------------------------------------------- loading

type Loaded = { report: Json; outcome: VerifyOutcome };

async function load(dir: string, id: string, keySet: KeySet): Promise<Loaded | null> {
  if (!REPORT_ID_PATTERN.test(id)) return null;
  let report: unknown;
  try {
    report = JSON.parse(await readFile(dir + id + '.json', 'utf8'));
  } catch {
    return null;
  }
  if (!isObject(report) || report.type !== REPORT_TYPE || report.id !== id) return null;
  return { report, outcome: verifyAttestation(report, keySet) };
}

/** GET /reports/<id>. Null means there is no such report (the caller answers 404). */
export async function reportPage(dir: string, id: string, keySet: KeySet): Promise<{ html: string; verified: boolean } | null> {
  const loaded = await load(dir, id, keySet);
  if (!loaded) return null;
  const { report, outcome } = loaded;
  return outcome.ok
    ? { html: renderReportPage(report, outcome.kid), verified: true }
    : { html: renderUnverifiedPage(id, outcome.reason), verified: false };
}

/** GET /reports. Newest window first. */
export async function reportIndexPage(dir: string, keySet: KeySet): Promise<string> {
  let files: string[] = [];
  try {
    files = await readdir(dir);
  } catch {
    // no directory: an empty list
  }
  const ids = files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length));
  const loaded = (await Promise.all(ids.map((id) => load(dir, id, keySet)))).filter((l): l is Loaded => !!l && l.outcome.ok);
  const end = (r: Json) => (isObject(r.window) ? str(r.window.to) : '');
  const reports = loaded.map((l) => l.report).sort((a, b) => end(b).localeCompare(end(a)));
  return renderIndexPage(reports);
}
