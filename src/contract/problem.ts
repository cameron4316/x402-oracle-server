// RFC 9457 Problem Details for Hosannaith's own error responses (application/problem+json).
// Covers the 4xx/5xx bodies this server writes. The 402 Payment Required response is NOT ours:
// it is produced by the x402 payment middleware in the x402 protocol's shape and is left as is.

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  404: 'Not Found',
  500: 'Internal Server Error',
};

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  /** Legacy alias of `detail` for clients written against the earlier { "error": "..." } bodies. */
  error?: string;
}

// type "about:blank" (RFC 9457 §4.2.1): the HTTP status code is the problem type, and `title` is
// its standard phrase. Specific problem type URIs can be introduced later without breaking clients.
export function problem(status: number, detail?: string): Problem {
  return {
    type: 'about:blank',
    title: TITLES[status] ?? 'Error',
    status,
    ...(detail ? { detail, error: detail } : {}),
  };
}
