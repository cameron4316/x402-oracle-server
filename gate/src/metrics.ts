// The same results as Prometheus metrics (text exposition format), so the state of each outside
// dependency can sit on the dashboards a team already has, next to the system's own telemetry.
import type { Bundle } from './evidence.ts';

const escapeLabel = (v: string): string => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

interface Metric {
  name: string;
  help: string;
  samples: Array<{ labels: Record<string, string>; value: number }>;
}

export function renderMetrics(bundle: Bundle): string {
  const evaluatedAt = Date.parse(bundle.evaluated_at);
  const metrics: Metric[] = [
    { name: 'reliability_gate_control_met', help: '1 if the control on this outside service is met, 0 if not.', samples: [] },
    { name: 'reliability_gate_signature_valid', help: "1 if the evidence carried a valid signature by one of the oracle's keys.", samples: [] },
    { name: 'reliability_gate_reliability_score', help: 'Reliability score from the signed evidence, 0 to 1.', samples: [] },
    { name: 'reliability_gate_availability_ratio', help: 'Availability from the signed evidence, 0 to 1.', samples: [] },
    { name: 'reliability_gate_error_ratio', help: 'Error rate from the signed evidence, 0 to 1.', samples: [] },
    { name: 'reliability_gate_latency_seconds', help: 'Latency from the signed evidence, by quantile.', samples: [] },
    { name: 'reliability_gate_observations', help: 'Number of observations behind the evidence.', samples: [] },
    { name: 'reliability_gate_evidence_age_seconds', help: 'Age of the evidence when the gate ran.', samples: [] },
  ];
  const [met, signature, score, availability, errors, latency, observations, age] = metrics as [Metric, Metric, Metric, Metric, Metric, Metric, Metric, Metric];

  for (const record of bundle.controls) {
    const config = (record.config ?? {}) as { target?: unknown; enforcement?: unknown };
    const labels = {
      id: record.id,
      target: typeof config.target === 'string' ? config.target : '',
      enforcement: config.enforcement === 'advisory' ? 'advisory' : 'blocking',
    };
    met.samples.push({ labels, value: record.decision === 'pass' ? 1 : 0 });
    signature.samples.push({ labels, value: record.checks.some((c) => c.id === 'signature' && c.ok) ? 1 : 0 });
    const m = record.measurement;
    if (!m) continue;
    if (m.reliabilityScore !== null) score.samples.push({ labels, value: m.reliabilityScore });
    if (m.availability !== null) availability.samples.push({ labels, value: m.availability });
    if (m.errorRate !== null) errors.samples.push({ labels, value: m.errorRate });
    for (const [quantile, value] of [
      ['0.5', m.latencyP50Ms],
      ['0.95', m.latencyP95Ms],
      ['0.99', m.latencyP99Ms],
    ] as const) {
      if (value !== null) latency.samples.push({ labels: { ...labels, quantile }, value: value / 1000 });
    }
    if (m.observations !== null) observations.samples.push({ labels, value: m.observations });
    const stamps = [m.generatedAt, m.observedAt].filter((t): t is string => t !== null).map((t) => Date.parse(t));
    if (stamps.length > 0) age.samples.push({ labels, value: Math.max(0, (evaluatedAt - Math.min(...stamps)) / 1000) });
  }

  const out: string[] = [];
  for (const metric of metrics) {
    if (metric.samples.length === 0) continue;
    out.push(`# HELP ${metric.name} ${metric.help}`);
    out.push(`# TYPE ${metric.name} gauge`);
    for (const sample of metric.samples) {
      const labels = Object.entries(sample.labels)
        .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
        .join(',');
      out.push(`${metric.name}{${labels}} ${sample.value}`);
    }
  }
  out.push('# HELP reliability_gate_last_run_timestamp_seconds When the gate last ran.');
  out.push('# TYPE reliability_gate_last_run_timestamp_seconds gauge');
  out.push(`reliability_gate_last_run_timestamp_seconds ${evaluatedAt / 1000}`);
  return out.join('\n') + '\n';
}
