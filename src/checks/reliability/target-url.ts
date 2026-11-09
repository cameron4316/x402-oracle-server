// Which URLs Hosannaith will probe and enroll for monitoring.
//
// A target is fetched from our own servers (once inline for a new single-target check, then by the
// monitor every few minutes), so a caller must not be able to point it at our own machine or a
// private network: loopback, private, link-local (incl. cloud metadata at 169.254.169.254),
// carrier-grade NAT, multicast and reserved ranges, and internal-only host names are refused.
// Checked BEFORE payment on both the HTTP API and the remote MCP server, so nobody pays for a target
// we will not probe.
//
// Validation only: an accepted target is kept exactly as sent (trimmed), because existing history
// is keyed by that string; normalizing it would split an endpoint's history in two.
//
// A public host name that resolves (or redirects) to a refused address is caught at probe time:
// probe() in monitor.ts resolves every hop with isRefusedAddress() and follows redirects itself.
import { BlockList, isIP } from 'node:net';

export const MAX_TARGET_LENGTH = 2048;

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['64:ff9b::', 96], // NAT64 (embeds IPv4)
  ['100::', 64], // discard
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

const INTERNAL_NAME = /(^|\.)(localhost|local|internal|intranet|lan|home\.arpa)$/i;

export type TargetCheck = { ok: true; target: string } | { ok: false; target: string; reason: string };

/** Whether an IP address (v4 or v6, no brackets) is in a refused range. Non-IPs return false. */
export function isRefusedAddress(ip: string): boolean {
  return blockedAddress(ip);
}

function blockedAddress(host: string): boolean {
  const family = isIP(host);
  if (family === 4) return blocked.check(host, 'ipv4');
  if (family !== 6) return false;
  // IPv4-mapped / -compatible IPv6 (::ffff:10.0.0.1, ::ffff:a00:1) is checked as the IPv4 inside it.
  const mapped = /^::(ffff:)?(.+)$/i.exec(host);
  if (mapped && mapped[2] !== '1' && mapped[2] !== '') {
    const inner = mapped[2];
    if (isIP(inner) === 4) return blocked.check(inner, 'ipv4');
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(inner);
    if (hex) {
      const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16);
      const v4 = [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
      return blocked.check(v4, 'ipv4');
    }
  }
  return blocked.check(host, 'ipv6');
}

/** Whether Hosannaith will probe this URL. Never throws. */
export function checkTarget(raw: unknown): TargetCheck {
  if (typeof raw !== 'string') return { ok: false, target: String(raw), reason: 'target must be a string' };
  const target = raw.trim();
  if (!target) return { ok: false, target, reason: 'target is empty' };
  if (target.length > MAX_TARGET_LENGTH) {
    return { ok: false, target: target.slice(0, 80) + '…', reason: `target is longer than ${MAX_TARGET_LENGTH} characters` };
  }
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return { ok: false, target, reason: 'target is not an absolute URL' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, target, reason: 'target must be an http or https URL' };
  }
  if (url.username || url.password) return { ok: false, target, reason: 'target must not contain credentials' };
  // WHATWG URL parsing already normalizes IPv4 written as decimal, hex or octal (2130706433 -> 127.0.0.1).
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return { ok: false, target, reason: 'target has no host' };
  if (INTERNAL_NAME.test(host) || (!host.includes('.') && isIP(host) === 0)) {
    return { ok: false, target, reason: 'target host is not a public host name' };
  }
  if (blockedAddress(host)) return { ok: false, target, reason: 'target points at a private or reserved address' };
  return { ok: true, target };
}

/** For callers that have already validated: throws if the target is not allowed. */
export function assertTarget(raw: unknown): string {
  const r = checkTarget(raw);
  if (!r.ok) throw new TargetRejectedError(r.reason);
  return r.target;
}

export class TargetRejectedError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`target rejected: ${reason}`);
    this.reason = reason;
    this.name = 'TargetRejectedError';
  }
}
