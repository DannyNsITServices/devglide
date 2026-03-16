import fs from 'fs/promises';
import path from 'path';
import { getActiveProject } from '../../../project-context.js';

export interface CustomNodeDefinition {
  type: string;
  label: string;
  description?: string;
  category: string;
  configSchema: Record<string, { type: string; required?: boolean; description?: string }>;
  executor: 'shell';
  commandTemplate: string;
}

/**
 * Loads user-defined node types from `.devglide/node-types/` directory.
 */
export async function loadCustomNodes(): Promise<CustomNodeDefinition[]> {
  const ap = getActiveProject();
  if (!ap) return [];

  const nodeTypesDir = path.join(ap.path, '.devglide', 'node-types');
  const definitions: CustomNodeDefinition[] = [];

  let entries: string[];
  try {
    entries = await fs.readdir(nodeTypesDir);
  } catch {
    return definitions;
  }

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;

    try {
      const raw = await fs.readFile(path.join(nodeTypesDir, entry), 'utf-8');
      const def = JSON.parse(raw) as CustomNodeDefinition;

      if (!def.type || !def.label || !def.category || !def.commandTemplate) continue;

      definitions.push(def);
    } catch {
      // Skip invalid files
    }
  }

  return definitions;
}
