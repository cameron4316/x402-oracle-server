// Which history windows a caller may ask for. Fixed values, so every window maps to a published
// meaning and the cost of a query stays bounded:
//   24   the last day (the default, and the only window before this option existed)
//   168  rolling 7 days: the window FINOS OpenEAGO Appendix D uses for reliability_score, error_rate
//        and latency_p99_ms
//   720  rolling 30 days: the window Appendix D uses for availability_pct
export const WINDOW_HOURS_ALLOWED = [24, 168, 720] as const;
export type WindowHours = (typeof WINDOW_HOURS_ALLOWED)[number];
export const DEFAULT_WINDOW_HOURS: WindowHours = 24;

export type WindowCheck = { ok: true; hours: WindowHours } | { ok: false; reason: string };

/** Accepts undefined (default), a number, or a numeric string from a query parameter. */
export function parseWindowHours(raw: unknown): WindowCheck {
  if (raw === undefined || raw === null || raw === '') return { ok: true, hours: DEFAULT_WINDOW_HOURS };
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d{1,4}$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  const hours = WINDOW_HOURS_ALLOWED.find((h) => h === n);
  if (hours === undefined) {
    return { ok: false, reason: `windowHours must be one of ${WINDOW_HOURS_ALLOWED.join(', ')}` };
  }
  return { ok: true, hours };
}
