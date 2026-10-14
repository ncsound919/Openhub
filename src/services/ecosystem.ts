import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Overlay365 fleet awareness for OpenHub/Axiom.
 *
 * Loads the ecosystem layer files (SOUL, ECOSYSTEM, STRATEGY, MEMORY, OPS) plus
 * the fleet catalog and `.draymond` brain-state inventory so OpenHub and Axiom
 * share the same operating context as the rest of the fleet.
 *
 * Follows the fleet's own rule (ECOSYSTEM/AGENTS.md): degrade gracefully —
 * never fail because a layer file or store is absent. When configured, the
 * context is read live from disk; otherwise `source` is `'degraded'` and every
 * field is null/empty.
 */

export type LayerName = 'soul' | 'ecosystem' | 'strategy' | 'memory' | 'ops';

export const LAYER_FILES: Record<LayerName, string> = {
  soul: 'SOUL.md',
  ecosystem: 'ECOSYSTEM.md',
  strategy: 'STRATEGY.md',
  memory: 'MEMORY.md',
  ops: 'OPS.md',
};

export interface EcosystemLayer {
  name: LayerName;
  path: string | null;
  content: string | null;
  loadedAt: string | null;
}

export interface EcosystemContext {
  configured: boolean;
  root: string | null;
  layers: EcosystemLayer[];
  fleetCatalog: { path: string | null; excerpt: string | null };
  draymondState: string[];
  source: 'live' | 'degraded';
  loadedAt: string | null;
}

const MAX_LAYER_BYTES = 256 * 1024;

function readOptional(file: string): string | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_LAYER_BYTES) return null;
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

function firstExisting(paths: string[]): string | null {
  for (const p of paths) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/** Layer rule roots, highest priority first. */
export function resolveRuleRoots(ecosystemRoot: string | null | undefined, homeDir: string = os.homedir()): string[] {
  const roots: string[] = [];
  if (ecosystemRoot) roots.push(path.join(ecosystemRoot, 'rules', 'overlay365'));
  roots.push(path.join(homeDir, '.config', 'opencode', 'rules', 'overlay365'));
  return roots;
}

export function loadEcosystemContext(
  env: NodeJS.ProcessEnv = process.env,
  homeDir?: string
): EcosystemContext {
  const root = env.OPENHUB_ECOSYSTEM_ROOT || null;
  const ruleRoots = resolveRuleRoots(root, homeDir);

  const layers: EcosystemLayer[] = (Object.keys(LAYER_FILES) as LayerName[]).map((name) => {
    const file = firstExisting(ruleRoots.map((r) => path.join(r, LAYER_FILES[name])));
    const content = file ? readOptional(file) : null;
    return {
      name,
      path: file,
      content,
      loadedAt: content !== null ? new Date().toISOString() : null,
    };
  });

  // Fleet catalog (OPS-CATALOG.md) lives next to the orchestrator.
  const catalogCandidates = [
    env.OPENHUB_FLEET_CATALOG,
    root ? path.join(root, 'Draymond-Orchestrator', 'OPS-CATALOG.md') : null,
  ].filter((p): p is string => Boolean(p));
  const catalogPath = firstExisting(catalogCandidates);
  const catalogExcerpt = catalogPath ? (readOptional(catalogPath) || '').slice(0, 2000) : null;

  // .draymond brain-state inventory. Read-only: memory protocol ownership rules
  // apply on the fleet side; OpenHub never writes these files.
  const draymondDirs = [
    env.OPENHUB_DRAYMOND_DIR,
    root ? path.join(root, 'Draymond-Orchestrator', '.draymond') : null,
    root ? path.join(root, '.draymond') : null,
  ].filter((p): p is string => Boolean(p));
  const draymondState: string[] = [];
  for (const dir of draymondDirs) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.json') && !draymondState.includes(f)) draymondState.push(f);
      }
    } catch {
      /* absent or unreadable */
    }
  }

  const loadedLayers = layers.filter((l) => l.content !== null).length;
  const configured = root !== null && loadedLayers > 0;

  return {
    configured,
    root,
    layers,
    fleetCatalog: { path: catalogPath, excerpt: catalogExcerpt },
    draymondState,
    source: configured ? 'live' : 'degraded',
    loadedAt: new Date().toISOString(),
  };
}

/** Human-readable one-line summary of the ecosystem (for dashboards/CLI). */
export function summarizeEcosystem(ctx: EcosystemContext): string {
  if (ctx.source === 'degraded') {
    return 'Ecosystem: not configured (set OPENHUB_ECOSYSTEM_ROOT)';
  }
  const loaded = ctx.layers.filter((l) => l.content !== null).map((l) => l.name).join(', ');
  return `Ecosystem: ${ctx.root} — layers [${loaded}], brain files ${ctx.draymondState.length}`;
}