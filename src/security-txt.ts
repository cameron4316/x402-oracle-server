// RFC 9116 security.txt: where to report a vulnerability. Served free at /.well-known/security.txt
// on the API, and the same file is published on hosannaith.com (Canonical lists both locations).
//
// Expires is a fixed date on purpose: RFC 9116 wants it under a year ahead, and a date computed at
// request time would make a stale file look current forever. test/security-txt.test.ts fails once the
// date has passed or is more than a year ahead, so CI is the reminder to renew it.

export const SECURITY_CONTACT = 'security@hosannaith.com';
export const SECURITY_TXT_EXPIRES = '2027-11-01T00:00:00.000Z';

export const SECURITY_TXT_CANONICAL = [
  'https://api.hosannaith.com/.well-known/security.txt',
  'https://hosannaith.com/.well-known/security.txt',
] as const;

export const SECURITY_POLICY_URL = 'https://github.com/cameron4316/x402-oracle-server/security/policy';

export function securityTxt(): string {
  return [
    `Contact: mailto:${SECURITY_CONTACT}`,
    `Expires: ${SECURITY_TXT_EXPIRES}`,
    'Preferred-Languages: en',
    ...SECURITY_TXT_CANONICAL.map((url) => `Canonical: ${url}`),
    `Policy: ${SECURITY_POLICY_URL}`,
    '',
  ].join('\n');
}
