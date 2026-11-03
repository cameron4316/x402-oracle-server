// RFC 8785 JSON Canonicalization Scheme (JCS): the exact bytes that get signed.
//
// For the JSON data model (null, booleans, finite numbers, strings, arrays, plain objects), JCS is:
//   - strings and numbers serialized exactly as ECMAScript's JSON.stringify does (RFC 8785 §3.2.2),
//   - object members sorted by their names' UTF-16 code units (§3.2.3), which is JavaScript's
//     default string sort,
//   - no whitespace.
// Anything outside that model (undefined at top level, functions, Dates, NaN/Infinity, BigInt,
// class instances) is rejected rather than coerced, so a signature never covers bytes a verifier
// in another language would serialize differently.

export function canonicalize(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('JCS: non-finite numbers cannot be canonicalized');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    // JSON.stringify writes null for undefined array elements; do the same.
    return '[' + value.map((v) => (v === undefined ? 'null' : canonicalize(v))).join(',') + ']';
  }
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new TypeError('JCS: only plain objects can be canonicalized');
    const obj = value as Record<string, unknown>;
    // JSON.stringify drops members whose value is undefined; do the same so the signed bytes match
    // what is actually sent.
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
  }
  throw new TypeError(`JCS: cannot canonicalize a value of type ${typeof value}`);
}
