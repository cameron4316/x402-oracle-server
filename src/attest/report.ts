// Signed public reports: a dated, citable snapshot of Hosannaith's measurements for a named set of
// endpoints, built from report cards (src/report.ts output) and signed with the attestation key.
// Same signature scheme as results (docs/attestation.md); `type` tells the two documents apart.

export const REPORT_TYPE = 'hosannaith.reliability-report';
export const REPORT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const METHOD_URL = 'https://github.com/cameron4316/x402-oracle-server#reading-the-result';
const KEYS_URL = 'https://api.hosannaith.com/.well-known/hosannaith-keys.json';
const VERIFY_URL = 'https://github.com/cameron4316/x402-oracle-server/blob/main/docs/attestation.md#verifying';
// The monitor began recording what each 402 asks for (networks, version) at this time; payment figures
// in a report only cover 402 probes from then on.
export const PAYMENT_RECORDING_SINCE = '2026-11-09T18:44:00Z';

// The subset of a report card (src/report.ts JSON) a public report uses.
export interface ReportCard {
  target: string;
  status: string;
  summary: {
    observations: number;
    windowHours: number;
    score: number | null;
    uptimePct: number | null;
    correct402Pct: number | null;
    p50LatencyMs: number | null;
    p95LatencyMs: number | null;
    p99LatencyMs?: number | null;
    firstObservedAt: string | null;
    lastObservedAt: string | null;
    // Payment signals (present on report cards generated since they were added; see score.ts).
    paymentRequirementsSamples?: number;
    mainnetPayablePct?: number | null;
    currentSdkPayablePct?: number | null;
    algorandIdForm?: 'spec' | 'legacy' | 'both' | null;
    acceptedNetworks?: string[] | null;
  };
  sustained: Array<{ kind: 'down' | 'ungated'; start: string; end: string; durationMin: number; probes: number }>;
  transientDown: number;
  transientUngated: number;
  spikes: Array<{ at: string; latencyMs: number }>;
}

export interface ReportMeta {
  id: string; // e.g. "a-identity-2026-11"
  subject: string; // e.g. "A-Identity"
  scope: string; // what the report does and does not cover
}

export function buildReport(meta: ReportMeta, cards: ReportCard[]) {
  if (!REPORT_ID_PATTERN.test(meta.id)) throw new Error(`report id "${meta.id}" must be lowercase words joined by single hyphens`);
  if (cards.length === 0) throw new Error('a report needs at least one report card');
  const firsts = cards.map((c) => c.summary.firstObservedAt).filter((v): v is string => !!v).sort();
  const lasts = cards.map((c) => c.summary.lastObservedAt).filter((v): v is string => !!v).sort();
  if (!firsts.length || !lasts.length) throw new Error('report cards carry no observations');
  const from = firsts[0];
  const to = lasts[lasts.length - 1];
  const hours = (Date.parse(to) - Date.parse(from)) / 3_600_000;
  // Mean time between probes, averaged over the endpoints.
  const intervals = cards.map((c) => {
    const span = Date.parse(c.summary.lastObservedAt ?? to) - Date.parse(c.summary.firstObservedAt ?? from);
    return span / 1000 / Math.max(1, c.summary.observations - 1);
  });
  const meanIntervalSeconds = Math.round(intervals.reduce((a, b) => a + b, 0) / intervals.length);

  return {
    type: REPORT_TYPE,
    id: meta.id,
    title: `Reliability report: ${meta.subject}`,
    subject: meta.subject,
    scope: meta.scope,
    window: { from, to, hours: Math.round(hours * 10) / 10 },
    method:
      `Independent, unpaid probes of each endpoint about every ${Math.round(meanIntervalSeconds / 60)} minutes ` +
      `(mean interval ${meanIntervalSeconds} s). Uptime = probes where the endpoint was reachable and not a 5xx. ` +
      'Correct-402 = of the probes where the endpoint made a payment decision (402, or an unpaid 2xx), the share ' +
      'that correctly answered 402. Score = 0.6 x uptime + 0.4 x correct-402 - a latency penalty (up to 20). ' +
      `A sustained outage is 2+ consecutive failed probes. Full definitions: ${METHOD_URL}` +
      (cards.some(hasPayment)
        ? ` Payment figures (networks accepted, Algorand network id form, payability on mainnet and by the current ` +
          `x402 SDK) cover only the 402 responses recorded since ${PAYMENT_RECORDING_SINCE}, when the monitor ` +
          'began recording them; they are informational and not part of the score.'
        : ''),
    disclaimer:
      'An observational measurement of past behaviour over the stated window. It is not a guarantee of future ' +
      'availability or performance, and not an audit, certification or endorsement.',
    endpoints: cards.map((c) => ({
      target: c.target,
      status: c.status.toLowerCase(),
      score: c.summary.score,
      probes: c.summary.observations,
      uptimePct: c.summary.uptimePct,
      correct402Pct: c.summary.correct402Pct,
      p50LatencyMs: c.summary.p50LatencyMs,
      p95LatencyMs: c.summary.p95LatencyMs,
      p99LatencyMs: c.summary.p99LatencyMs ?? null,
      firstObservedAt: c.summary.firstObservedAt,
      lastObservedAt: c.summary.lastObservedAt,
      sustainedOutages: c.sustained,
      transientErrors: c.transientDown + c.transientUngated,
      latencySpikes: c.spikes,
      ...(hasPayment(c)
        ? {
            payment: {
              samples: c.summary.paymentRequirementsSamples,
              acceptedNetworks: c.summary.acceptedNetworks ?? [],
              algorandIdForm: c.summary.algorandIdForm ?? null,
              mainnetPayablePct: c.summary.mainnetPayablePct ?? null,
              currentSdkPayablePct: c.summary.currentSdkPayablePct ?? null,
            },
          }
        : {}),
    })),
    publisher: 'Hosannaith (https://hosannaith.com)',
    verification: { keys: KEYS_URL, instructions: VERIFY_URL },
  };
}

function hasPayment(c: ReportCard): boolean {
  return (c.summary.paymentRequirementsSamples ?? 0) > 0;
}
