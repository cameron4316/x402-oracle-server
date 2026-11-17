// Reads the two things a control points at: the signed document and the oracle's public keys.
// Each is an http(s) URL or a file path relative to the architecture document.
//
// The channel is not trusted for anything. A document is believed only because its signature
// verifies; the keys are believed because the reviewed architecture names where they come from.
// So a saved copy, a mirror or a pipeline artifact is as good as a live fetch.
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { ControlSpec } from './control.ts';
import type { Loaded } from './evaluate.ts';

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 2 * 1024 * 1024;

export function isUrl(ref: string): boolean {
  return /^https?:\/\//i.test(ref);
}

/** Where a reference actually resolves to, for the evidence record. */
export function describeRef(ref: string, baseDir: string): string {
  return isUrl(ref) ? ref : isAbsolute(ref) ? ref : resolve(baseDir, ref);
}

/**
 * Why a read failed, in words a person can act on. Errors arrive wrapped ("fetch failed" around the
 * real cause), so the innermost one is used: its system code when it has one (ENOTFOUND, ENOENT,
 * which also keeps file paths out of the evidence), otherwise its message. Never a bare number.
 */
export function reasonOf(err: unknown): string {
  const seen = new Set<unknown>();
  let innermost: { code?: unknown; message?: unknown } | undefined;
  for (let e = err as { code?: unknown; message?: unknown; cause?: unknown } | undefined; e && typeof e === 'object' && !seen.has(e); e = e.cause as typeof e) {
    seen.add(e);
    innermost = e;
  }
  if (!innermost) return 'unknown error';
  if (typeof innermost.code === 'string' && /^E[A-Z0-9_]+$/.test(innermost.code)) return innermost.code;
  return typeof innermost.message === 'string' && innermost.message.length > 0 ? innermost.message : 'unknown error';
}

export async function loadJson(ref: string, baseDir: string): Promise<Loaded> {
  let text: string;
  try {
    if (isUrl(ref)) {
      // No redirects: the architecture names the exact place, and that is the place that is read.
      const res = await fetch(ref, { redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status} from ${ref}` };
      // Stop reading as soon as the limit is passed, whatever the server said the length would be.
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of res.body ?? []) {
        size += chunk.byteLength;
        if (size > MAX_BYTES) return { ok: false, error: `response from ${ref} is larger than ${MAX_BYTES} bytes` };
        chunks.push(chunk);
      }
      text = Buffer.concat(chunks).toString('utf8');
    } else {
      text = await readFile(describeRef(ref, baseDir), 'utf8');
    }
  } catch (err) {
    return { ok: false, error: `could not read ${ref} (${reasonOf(err)})` };
  }
  if (text.length > MAX_BYTES) return { ok: false, error: `${ref} is larger than ${MAX_BYTES} bytes` };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: `${ref} is not valid JSON` };
  }
  // Both a signed document and a key set are JSON objects; anything else is not evidence.
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, error: `${ref} is not a JSON object` };
  return { ok: true, value };
}

/**
 * The address the signed document is read from. A contract oracle is asked about one target and
 * one window with query parameters (this gate's convention; the proposed contract defines the
 * response, not the request). The Hosannaith formats are complete documents, read as they are.
 */
export function evidenceRef(spec: ControlSpec): string | null {
  if (!spec.evidence) return null;
  const { format, from } = spec.evidence;
  if (format !== 'openeago-contract' || !isUrl(from)) return from;
  const url = new URL(from);
  url.searchParams.set('target', spec.target);
  url.searchParams.set('window_hours', String(spec.windowHours));
  return url.href;
}
