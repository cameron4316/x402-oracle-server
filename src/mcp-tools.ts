// Shared pieces of the remote MCP server's tool definitions, kept free of side effects so tests can
// register them on a real McpServer (test/mcp-tools.test.ts).
import { z } from 'zod';
import { checkTarget, MAX_TARGET_LENGTH } from './checks/reliability/target-url.js';
import { WINDOW_HOURS_ALLOWED } from './checks/reliability/window.js';

// A target the oracle will probe (src/checks/reliability/target-url.ts). The MCP SDK validates
// arguments before calling the tool, so a refused target never reaches the payment wrapper: the
// caller gets an error and pays nothing.
export const targetUrl = z
  .string()
  .max(MAX_TARGET_LENGTH)
  .url()
  .refine((t) => checkTarget(t).ok, {
    message:
      'Target not accepted: it must be a public http(s) URL (no credentials, internal host names, or ' +
      'private, loopback, link-local or reserved addresses).',
  });

// Optional history window (src/checks/reliability/window.ts): 24 h (default), 168 h (rolling 7 days)
// or 720 h (rolling 30 days), the windows FINOS OpenEAGO Appendix D uses.
export const windowHoursArg = z
  .union([z.literal(WINDOW_HOURS_ALLOWED[0]), z.literal(WINDOW_HOURS_ALLOWED[1]), z.literal(WINDOW_HOURS_ALLOWED[2])])
  .optional()
  .describe('History window in hours: 24 (default), 168 (rolling 7 days) or 720 (rolling 30 days).');

// Tool annotations (MCP spec). The paid tools only READ scores, but each call pays and may probe a
// new target live, so they are not idempotent, and they reach out to third-party endpoints.
export const PAID_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;
export const INFO_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
