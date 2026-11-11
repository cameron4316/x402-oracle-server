/**
 * Removes trailing "/" characters in linear time.
 *
 * Replaces `s.replace(/\/+$/, '')`, which is quadratic on a long run of slashes followed by another
 * character (CodeQL js/polynomial-redos): an 8 KB request path of slashes cost ~50 ms of CPU.
 */
export function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* "/" */) end--;
  return s.slice(0, end);
}
