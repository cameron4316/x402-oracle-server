// Finds the external-service-reliability controls in a CALM architecture document.
//
// CALM attaches controls to nodes, to relationships, and to the architecture as a whole, each as
//   "controls": { "<key>": { "description": "...", "requirements": [{ "requirement-url": "...", "config": { ... } }] } }
// The key is the author's choice, so a control is recognised by its config's "control-id", not by
// the key. One node can then carry several (one per outside service it stands for).
import { CONTROL_ID } from './control.ts';

export interface ControlInstance {
  where: 'node' | 'relationship' | 'architecture';
  /** unique-id of the node or relationship; the architecture's own id (or "architecture") otherwise. */
  id: string;
  name: string | null;
  controlKey: string;
  requirementIndex: number;
  requirementUrl: string | null;
  config: unknown;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function collect(where: ControlInstance['where'], id: string, name: string | null, controls: unknown, out: ControlInstance[]): void {
  if (!isPlainObject(controls)) return;
  for (const [controlKey, control] of Object.entries(controls)) {
    if (!isPlainObject(control) || !Array.isArray(control['requirements'])) continue;
    control['requirements'].forEach((requirement: unknown, requirementIndex: number) => {
      if (!isPlainObject(requirement)) return;
      const config = requirement['config'];
      if (!isPlainObject(config) || config['control-id'] !== CONTROL_ID) return;
      const url = requirement['requirement-url'];
      out.push({ where, id, name, controlKey, requirementIndex, requirementUrl: typeof url === 'string' ? url : null, config });
    });
  }
}

export function findControls(architecture: unknown): ControlInstance[] {
  if (!isPlainObject(architecture)) throw new Error('the architecture document must be a JSON object');
  const out: ControlInstance[] = [];
  const archId = typeof architecture['unique-id'] === 'string' ? architecture['unique-id'] : 'architecture';
  const archName = typeof architecture['name'] === 'string' ? architecture['name'] : null;
  collect('architecture', archId, archName, architecture['controls'], out);
  for (const [where, list] of [
    ['node', architecture['nodes']],
    ['relationship', architecture['relationships']],
  ] as const) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!isPlainObject(item) || typeof item['unique-id'] !== 'string') continue;
      const name = typeof item['name'] === 'string' ? item['name'] : null;
      collect(where, item['unique-id'], name, item['controls'], out);
    }
  }
  return out;
}
