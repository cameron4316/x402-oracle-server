// Turns an evidence bundle into something a person reads: plain text for a terminal, Markdown for a
// pipeline's job summary. Plain ASCII in the terminal form so it reads the same in every console.
import type { Bundle, ControlRecord, AuditResult } from './evidence.ts';

const LABEL: Record<ControlRecord['decision'], string> = { pass: 'PASS', fail: 'FAIL', warn: 'WARN', invalid: 'INVALID' };

function targetOf(record: ControlRecord): string {
  const target = (record.config as { target?: unknown } | null)?.target;
  return typeof target === 'string' ? target : '(no target)';
}

const shortKid = (kid: string): string => (kid.length > 12 ? `${kid.slice(0, 8)}..` : kid);

function evidenceLine(record: ControlRecord, fullKid = false): string | null {
  if (!record.evidence) return null;
  const parts = [record.evidence.format];
  if (record.keys?.kid && record.checks.some((c) => c.id === 'signature' && c.ok)) {
    parts.push(`signed by key ${fullKid ? record.keys.kid : shortKid(record.keys.kid)}${record.keys.key_status ? ` (${record.keys.key_status})` : ''}`);
  }
  const m = record.measurement;
  if (m?.windowHours !== null && m?.windowHours !== undefined) parts.push(`${m.windowHours} h window`);
  if (m?.observations !== null && m?.observations !== undefined) parts.push(`${m.observations.toLocaleString('en-US')} observations`);
  const freshness = record.checks.find((c) => c.id === 'freshness');
  if (freshness?.ok) parts.push(freshness.actual);
  return parts.join(', ');
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function resultLine(bundle: Bundle): string {
  const s = bundle.summary;
  const notMet = s.fail + s.invalid;
  const warnings = s.warn > 0 ? ` (${plural(s.warn, 'advisory warning', 'advisory warnings')})` : '';
  if (notMet === 0) return `Result: PASS. ${plural(s.controls, 'control', 'controls')} checked, none failing${warnings}.`;
  return `Result: FAIL. ${notMet} of ${plural(s.controls, 'control', 'controls')} not met${warnings}.`;
}

/** `verbose` lists every check; otherwise a control that is met is summarised on one line. */
export function renderText(bundle: Bundle, verbose = false): string {
  const lines: string[] = [];
  lines.push(`Reliability gate ${bundle.gate.version}: ${plural(bundle.summary.controls, 'control', 'controls')}, evaluated ${bundle.evaluated_at}${bundle.clock === 'pinned' ? ' (clock pinned with --now)' : ''}`);
  lines.push(`Architecture: ${bundle.architecture.path}`);
  for (const record of bundle.controls) {
    lines.push('');
    const advisory = (record.config as { enforcement?: unknown } | null)?.enforcement === 'advisory' ? '  [advisory]' : '';
    lines.push(`${LABEL[record.decision].padEnd(7)} ${record.id} (${record.where})${advisory}`);
    lines.push(`        target    ${targetOf(record)}`);
    const evidence = evidenceLine(record);
    if (evidence) lines.push(`        evidence  ${evidence}`);
    for (const error of record.config_errors ?? []) lines.push(`        x   control is not valid: ${error}`);
    if (record.decision === 'pass' && !verbose) {
      const met = record.checks.filter((c) => c.group === 'threshold').map((c) => `${c.required.split(/ [<>]= /)[0]} ${c.actual}`);
      lines.push(`        met       ${met.join(', ')}`);
      continue;
    }
    const width = Math.max(0, ...record.checks.map((c) => c.required.length));
    for (const check of record.checks) {
      lines.push(`        ${check.ok ? 'ok ' : 'x  '} ${check.required.padEnd(width)}   ${check.actual}`);
    }
  }
  lines.push('');
  lines.push(resultLine(bundle));
  return lines.join('\n');
}

/**
 * A value as a Markdown code span inside a table cell. Nothing in it is interpreted: no links,
 * images, emphasis or HTML, whatever the text is. Backslashes are doubled before pipes are escaped,
 * so every pipe is preceded by an odd number of backslashes and can never end the cell.
 */
function code(value: string): string {
  const text = value
    .replace(/[\r\n]+/g, ' ')
    .replace(/`/g, "'")
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|');
  return text.trim().length === 0 ? '' : `\`${text}\``;
}

export function renderMarkdown(bundle: Bundle): string {
  const lines: string[] = [];
  lines.push('## Reliability gate');
  lines.push('');
  lines.push(`**${resultLine(bundle).replace(/^Result: /, '')}** Evaluated ${bundle.evaluated_at}${bundle.clock === 'pinned' ? ' (clock pinned)' : ''} against ${code(bundle.architecture.path)}.`);
  lines.push('');
  lines.push('| Result | Service | Target | Evidence | Not met |');
  lines.push('|---|---|---|---|---|');
  for (const record of bundle.controls) {
    const notMet = [
      ...(record.config_errors ?? []).map((e) => `control is not valid: ${e}`),
      ...record.checks.filter((c) => !c.ok).map((c) => `${c.required}: ${c.actual}`),
    ];
    lines.push(`| ${LABEL[record.decision]} | ${code(record.id)} | ${code(targetOf(record))} | ${code(evidenceLine(record, true) ?? 'none')} | ${notMet.map(code).join('<br>')} |`);
  }
  lines.push('');
  lines.push(`Evidence digest (SHA-256): \`${bundle.digest.value}\``);
  return lines.join('\n') + '\n';
}

export function renderAudit(result: AuditResult): string {
  const lines: string[] = [];
  lines.push(`File digest: ${result.digest_ok ? 'matches the content' : 'DOES NOT MATCH (the file was changed after it was written)'}`);
  for (const c of result.controls) {
    const key =
      c.key_confirmed === null || !c.consistent
        ? ''
        : c.key_confirmed
          ? ', signing key confirmed by the trusted key set'
          : ', SIGNING KEY NOT CONFIRMED by the trusted key set';
    lines.push(
      c.consistent
        ? `ok  ${c.id}: recorded ${c.recorded}, and the signed evidence supports ${c.recomputed}${key}`
        : `x   ${c.id}: recorded ${c.recorded}, but the signed evidence supports ${c.recomputed} (${c.reason})`,
    );
  }
  if (!result.trusted_keys_supplied && result.controls.some((c) => c.kid)) {
    lines.push('Note: the signing keys were taken from the file itself. Pass --trust-keys <file or URL> to confirm them against a source you trust.');
  }
  lines.push('');
  lines.push(result.ok ? 'Audit: OK. Every recorded decision is supported by the signed evidence in the file.' : `Audit: FAILED.\n${result.problems.map((p) => `  - ${p}`).join('\n')}`);
  return lines.join('\n');
}
