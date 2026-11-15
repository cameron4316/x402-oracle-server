// Adds outside-service nodes and controls to an existing CALM architecture without editing it.
//
// The use: someone else owns the architecture (here, the FINOS AI Steel Thread demo). An overlay
// says what to add, the base file stays byte-for-byte theirs, and the merged result is what gets
// validated and gated. Nothing is overwritten: an id or a control key that already exists is an
// error, not a silent replacement.

type Obj = Record<string, unknown>;

function isPlainObject(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function byId(list: unknown, what: string): Map<string, Obj> {
  if (!Array.isArray(list)) throw new Error(`the base architecture has no ${what} list`);
  const map = new Map<string, Obj>();
  for (const item of list) {
    if (isPlainObject(item) && typeof item['unique-id'] === 'string') map.set(item['unique-id'], item);
  }
  return map;
}

function addAll(target: unknown[], existing: Map<string, Obj>, additions: unknown, what: string): void {
  if (additions === undefined) return;
  if (!Array.isArray(additions)) throw new Error(`overlay: add-${what}s must be a list`);
  for (const item of additions) {
    if (!isPlainObject(item) || typeof item['unique-id'] !== 'string') throw new Error(`overlay: every added ${what} needs a unique-id`);
    if (existing.has(item['unique-id'])) throw new Error(`overlay: ${what} "${item['unique-id']}" already exists in the base architecture`);
    existing.set(item['unique-id'], item);
    target.push(item);
  }
}

function attach(existing: Map<string, Obj>, additions: unknown, what: string): void {
  if (additions === undefined) return;
  if (!isPlainObject(additions)) throw new Error(`overlay: attach-controls.${what}s must be an object keyed by unique-id`);
  for (const [id, controls] of Object.entries(additions)) {
    const item = existing.get(id);
    if (!item) throw new Error(`overlay: cannot attach controls to ${what} "${id}": it is not in the architecture`);
    if (!isPlainObject(controls)) throw new Error(`overlay: controls for ${what} "${id}" must be an object`);
    const current = isPlainObject(item['controls']) ? item['controls'] : {};
    for (const [key, control] of Object.entries(controls)) {
      if (key in current) throw new Error(`overlay: ${what} "${id}" already has a control named "${key}"`);
      current[key] = control;
    }
    item['controls'] = current;
  }
}

export function applyOverlay(base: unknown, overlay: unknown): Obj {
  if (!isPlainObject(base)) throw new Error('the base architecture must be a JSON object');
  if (!isPlainObject(overlay)) throw new Error('the overlay must be a JSON object');
  const known = ['description', 'base', 'add-nodes', 'add-relationships', 'add-to-composition', 'attach-controls', 'append-metadata'];
  for (const key of Object.keys(overlay)) {
    if (!known.includes(key)) throw new Error(`overlay: unknown property "${key}"`);
  }

  const merged = structuredClone(base);
  const nodes = byId(merged['nodes'], 'nodes');
  const relationships = byId(merged['relationships'], 'relationships');
  addAll(merged['nodes'] as unknown[], nodes, overlay['add-nodes'], 'node');
  addAll(merged['relationships'] as unknown[], relationships, overlay['add-relationships'], 'relationship');

  const compositions = overlay['add-to-composition'];
  if (compositions !== undefined) {
    if (!isPlainObject(compositions)) throw new Error('overlay: add-to-composition must be an object keyed by relationship unique-id');
    for (const [id, members] of Object.entries(compositions)) {
      const type = relationships.get(id)?.['relationship-type'];
      const composed = isPlainObject(type) ? type['composed-of'] : undefined;
      if (!isPlainObject(composed) || !Array.isArray(composed['nodes'])) throw new Error(`overlay: "${id}" is not a composed-of relationship in the architecture`);
      if (!Array.isArray(members)) throw new Error(`overlay: add-to-composition.${id} must be a list of node ids`);
      for (const member of members) {
        if (typeof member !== 'string' || !nodes.has(member)) throw new Error(`overlay: add-to-composition.${id} names "${String(member)}", which is not a node`);
        if (!composed['nodes'].includes(member)) composed['nodes'].push(member);
      }
    }
  }

  const controls = overlay['attach-controls'];
  if (controls !== undefined) {
    if (!isPlainObject(controls)) throw new Error('overlay: attach-controls must be an object');
    attach(nodes, controls['nodes'], 'node');
    attach(relationships, controls['relationships'], 'relationship');
  }

  const metadata = overlay['append-metadata'];
  if (metadata !== undefined) {
    if (!isPlainObject(metadata)) throw new Error('overlay: append-metadata must be an object of lists');
    // CALM metadata is either one object or a list of objects; the first object is extended.
    let holder: Obj;
    if (Array.isArray(merged['metadata']) && isPlainObject(merged['metadata'][0])) holder = merged['metadata'][0];
    else if (isPlainObject(merged['metadata'])) holder = merged['metadata'];
    else {
      holder = {};
      merged['metadata'] = [holder];
    }
    for (const [key, values] of Object.entries(metadata)) {
      if (!Array.isArray(values)) throw new Error(`overlay: append-metadata.${key} must be a list`);
      const current = Array.isArray(holder[key]) ? (holder[key] as unknown[]) : [];
      for (const value of values) if (!current.includes(value)) current.push(value);
      holder[key] = current;
    }
  }
  return merged;
}
