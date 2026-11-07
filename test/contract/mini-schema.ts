// Minimal JSON Schema (2020-12) validator for the keywords our published schemas use. Test-only.
// It THROWS on any keyword it does not implement, so a schema can never silently outgrow it.

type Schema = Record<string, unknown>;

const ANNOTATIONS = new Set(['$schema', '$id', 'title', 'description', 'format']);
const IMPLEMENTED = new Set([
  'type', 'enum', 'const', 'required', 'properties', 'items', 'anyOf',
  'minimum', 'maximum', 'exclusiveMinimum', 'pattern', 'minItems', 'maxItems',
]);

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function matchesType(v: unknown, t: string): boolean {
  const actual = typeOf(v);
  return actual === t || (t === 'number' && actual === 'integer');
}

export function validate(schema: Schema, value: unknown, path = '$'): string[] {
  const errors: string[] = [];
  for (const k of Object.keys(schema)) {
    if (!ANNOTATIONS.has(k) && !IMPLEMENTED.has(k)) throw new Error(`mini-schema: unsupported keyword "${k}" at ${path}`);
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    if (!types.some((t) => matchesType(value, t))) {
      return [`${path}: expected ${types.join('|')}, got ${typeOf(value)}`];
    }
  }
  if (schema.enum && !(schema.enum as unknown[]).includes(value)) errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
  if ('const' in schema && schema.const !== value) errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${path}: ${value} < minimum ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(`${path}: ${value} > maximum ${schema.maximum}`);
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum)
      errors.push(`${path}: ${value} <= exclusiveMinimum ${schema.exclusiveMinimum}`);
  }
  if (typeof value === 'string' && typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${path}: "${value}" does not match ${schema.pattern}`);
  }
  if (schema.anyOf) {
    const branches = (schema.anyOf as Schema[]).map((s) => validate(s, value, path));
    if (!branches.some((b) => b.length === 0)) errors.push(`${path}: matches no anyOf branch (${branches.flat().join('; ')})`);
  }
  if (typeOf(value) === 'object') {
    const obj = value as Record<string, unknown>;
    for (const r of (schema.required as string[] | undefined) ?? []) {
      if (!(r in obj)) errors.push(`${path}: missing required "${r}"`);
    }
    const props = (schema.properties as Record<string, Schema> | undefined) ?? {};
    for (const [k, sub] of Object.entries(props)) {
      if (k in obj) errors.push(...validate(sub, obj[k], `${path}.${k}`));
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, i) => errors.push(...validate(schema.items as Schema, item, `${path}[${i}]`)));
  }
  return errors;
}
