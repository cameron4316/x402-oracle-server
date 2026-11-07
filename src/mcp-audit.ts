// Audit log for the remote MCP server: one JSON line per tool call, in data/mcp-audit.jsonl.
//
// The interceptor wraps each tool callback from the OUTSIDE (around the x402 payment wrapper for the
// paid tools), so it never touches payment handling. It records what was called, how it was paid
// and what came back:
//   paid              the settlement receipt the wrapper attached (transaction, payer, network, amount)
//   payment_required  the 402 we answered with, including the quote we OFFERED (amount, asset,
//                     network), so quotes can later be reconciled against settlements
//   free              the free info tool
//
// What is NOT logged: the payment payload (it carries a signed transaction), query strings and
// fragments of target URLs (they can carry tokens), and result bodies. The file is bounded: past
// maxBytes it is rotated to <file>.1 (replacing any older rotation). Logging never throws into a
// tool call and never delays its result beyond queuing one append.
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

// Same values as @x402/mcp's MCP_PAYMENT_META_KEY / MCP_PAYMENT_RESPONSE_META_KEY; mcp-remote.ts
// asserts that at startup, so this module stays dependency-free and unit-testable.
export const PAYMENT_META_KEY = 'x402/payment';
export const PAYMENT_RESPONSE_META_KEY = 'x402/payment-response';

const MAX_TEXT = 200;
const MAX_PARSE_BYTES = 256 * 1024;

export interface AuditRecord {
  ts: string;
  tool: string;
  mode: 'free' | 'paid' | 'payment_required';
  outcome: 'ok' | 'error' | 'payment_required' | 'payment_rejected' | 'settle_failed';
  payment_presented: boolean;
  duration_ms: number;
  targets?: string[];
  result_status?: string;
  result_score?: number | null;
  result_count?: number;
  signed_kid?: string;
  settlement?: {
    success: boolean;
    transaction?: string;
    network?: string;
    payer?: string;
    amount?: string;
    error_reason?: string;
  };
  quote?: { scheme?: string; amount?: string; asset?: string; network?: string };
  error?: string;
}

type ToolResult = {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
  structuredContent?: Record<string, unknown>;
};

const clip = (s: unknown) => (typeof s === 'string' ? (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + '…' : s) : undefined);

/** A target URL without credentials, query string or fragment; anything unparseable is clipped. */
export function stripTarget(raw: unknown): string {
  if (typeof raw !== 'string') return '<not a string>';
  try {
    const u = new URL(raw.trim());
    return clip(`${u.protocol}//${u.host}${u.pathname}`) ?? '';
  } catch {
    return `<invalid> ${clip(raw.slice(0, 80))}`;
  }
}

export class AuditLog {
  private queue: Promise<void> = Promise.resolve();
  private readonly path: string;
  private readonly maxBytes: number;
  private readonly onError: (err: unknown) => void;

  constructor(path: string, maxBytes = 20 * 1024 * 1024, onError: (err: unknown) => void = (err) => console.error('[mcp-audit] write failed:', err)) {
    this.path = path;
    this.maxBytes = maxBytes;
    this.onError = onError;
  }

  /** Queues one line. Writes are serialized, so lines never interleave and rotation is safe. */
  write(record: AuditRecord): void {
    const line = JSON.stringify(record) + '\n';
    this.queue = this.queue
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        const size = await stat(this.path).then((s) => s.size, () => 0);
        if (size > 0 && size + Buffer.byteLength(line) > this.maxBytes) await rename(this.path, `${this.path}.1`);
        await appendFile(this.path, line, 'utf8');
      })
      .catch(this.onError);
  }

  /** Resolves once every queued line is written (tests, shutdown). */
  flush(): Promise<void> {
    return this.queue;
  }
}

function targetsOf(args: unknown): string[] | undefined {
  const a = (args ?? {}) as { target?: unknown; targets?: unknown };
  if (a.target !== undefined) return [stripTarget(a.target)];
  if (Array.isArray(a.targets)) return a.targets.slice(0, 50).map(stripTarget);
  return undefined;
}

function resultSummary(result: ToolResult): Pick<AuditRecord, 'result_status' | 'result_score' | 'result_count' | 'signed_kid'> {
  const text = result.content?.[0]?.text;
  if (typeof text !== 'string' || text.length > MAX_PARSE_BYTES) return {};
  try {
    const body = JSON.parse(text) as Record<string, any>;
    const kid = typeof body?.signature?.kid === 'string' ? { signed_kid: body.signature.kid as string } : {};
    if (Array.isArray(body?.results)) return { result_count: body.results.length, ...kid };
    if (typeof body?.status === 'string') {
      return { result_status: body.status, result_score: typeof body.score === 'number' ? body.score : null, ...kid };
    }
  } catch {
    // free text (the info tool): nothing to summarize
  }
  return {};
}

/** Classifies a finished call from what the payment wrapper returned. */
export function classify(kind: 'free' | 'paid', presented: boolean, result: ToolResult): Pick<AuditRecord, 'mode' | 'outcome' | 'settlement' | 'quote' | 'error'> {
  if (kind === 'free') return { mode: 'free', outcome: result.isError ? 'error' : 'ok' };
  const receipt = result._meta?.[PAYMENT_RESPONSE_META_KEY] as Record<string, unknown> | undefined;
  if (receipt && typeof receipt === 'object') {
    const settlement = {
      success: receipt.success === true,
      transaction: clip(receipt.transaction),
      network: clip(receipt.network),
      payer: clip(receipt.payer),
      amount: clip(receipt.amount),
      error_reason: clip(receipt.errorReason ?? receipt.errorMessage),
    };
    const outcome = !settlement.success ? 'settle_failed' : result.isError ? 'error' : 'ok';
    return { mode: 'paid', outcome, settlement };
  }
  const required = result.structuredContent as { accepts?: unknown; error?: unknown } | undefined;
  if (result.isError && required && Array.isArray(required.accepts)) {
    const a = (required.accepts[0] ?? {}) as Record<string, unknown>;
    return {
      mode: 'payment_required',
      outcome: presented ? 'payment_rejected' : 'payment_required',
      quote: { scheme: clip(a.scheme), amount: clip(a.amount), asset: clip(String(a.asset ?? '')), network: clip(a.network) },
      error: clip(required.error),
    };
  }
  // An error with no receipt and no 402 (e.g. the wrapper's own internal error).
  return { mode: presented ? 'paid' : 'payment_required', outcome: 'error', error: clip(result.content?.[0]?.text) };
}

/** Wraps a tool callback so every call is written to the audit log. Rethrows whatever it throws. */
export function withAudit<A, E, R extends ToolResult>(
  log: AuditLog,
  tool: string,
  kind: 'free' | 'paid',
  callback: (args: A, extra: E) => R | Promise<R>,
  now: () => number = Date.now,
): (args: A, extra: E) => Promise<R> {
  return async (args, extra) => {
    const started = now();
    const meta = (extra as { _meta?: Record<string, unknown> } | undefined)?._meta;
    const presented = kind === 'paid' && meta?.[PAYMENT_META_KEY] != null;
    const base = { ts: new Date(started).toISOString(), tool, payment_presented: presented, targets: targetsOf(args) };
    try {
      const result = await callback(args, extra);
      try {
        log.write({ ...base, ...classify(kind, presented, result), ...resultSummary(result), duration_ms: now() - started });
      } catch (err) {
        console.error('[mcp-audit] could not record call:', err);
      }
      return result;
    } catch (err) {
      log.write({
        ...base,
        mode: kind === 'free' ? 'free' : presented ? 'paid' : 'payment_required',
        outcome: 'error',
        duration_ms: now() - started,
        error: clip(err instanceof Error ? err.message : String(err)),
      });
      throw err;
    }
  };
}
