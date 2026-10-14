import fs from 'fs';
import path from 'path';

/**
 * Overlay365 fleet catalog browse (capability #3).
 *
 * The fleet catalog (OPS-CATALOG.md) is the operator's markdown inventory of
 * fleet assets. Location resolution, in order:
 *   1. env OPENHUB_FLEET_CATALOG (explicit override)
 *   2. env OPENHUB_ECOSYSTEM_ROOT/Draymond-Orchestrator/OPS-CATALOG.md
 *
 * When neither is set (or neither resolves to an existing file) the catalog is
 * treated as absent and the caller degrades honestly. There is no hardcoded
 * machine path — resolution is explicit configuration only.
 *
 * Real parsing, per the catalog's actual shape:
 *   - The `## Totals` section is a `| Kind | Count |` table (`| skill | 227 |`,
 *     `| agent | 42 |`); keys are normalized (lowercase, markdown decorators
 *     stripped, non-alphanumeric runs collapsed to `_`). The `**Total**` row is
 *     not a kind and is excluded.
 *   - `### <category> (n)` sections list assets in `| Name | Kind | ... |
 *     Invocation |` tables. Best-effort extraction: name + kind are required,
 *     an optional `Description` column is honored when the section header has
 *     one, and a `path:...` invocation cell becomes the asset path (any other
 *     invocation, e.g. `http`/`cli`/`steps:N`, leaves path null). At most
 *     `MAX_CATALOG_ASSETS` assets are collected.
 *
 * Degradation rules (binding): a missing catalog yields
 * `{ path: null, source: 'degraded', totals: {}, assets: [], error: 'fleet
 * catalog not found' }` — never a throw, never invented data.
 */

/** Best-effort asset extraction cap (the catalog lists hundreds of assets). */
export const MAX_CATALOG_ASSETS = 500;

export interface CatalogAsset {
  kind: string;
  name: string;
  description: string;
  path: string | null;
}

export interface FleetCatalogResult {
  path: string | null;
  source: 'live' | 'degraded';
  totals: Record<string, number>;
  assets: CatalogAsset[];
  error?: string;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve the fleet catalog markdown file, or null when none of the configured
 * candidates exists. A configured path that does not exist yields null — the
 * caller degrades honestly instead of pretending a catalog exists.
 */
export function resolveCatalogPath(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.OPENHUB_FLEET_CATALOG) {
    const explicit = env.OPENHUB_FLEET_CATALOG;
    return isFile(explicit) ? explicit : null;
  }
  // Every configured ecosystem root is a candidate, in order — single-root
  // setups behave exactly as before.
  const roots: string[] = [];
  if (typeof env.OPENHUB_ECOSYSTEM_ROOTS === 'string' && env.OPENHUB_ECOSYSTEM_ROOTS.trim() !== '') {
    roots.push(...env.OPENHUB_ECOSYSTEM_ROOTS.split(';').map((s) => s.trim()).filter(Boolean));
  }
  if (env.OPENHUB_ECOSYSTEM_ROOT) roots.push(env.OPENHUB_ECOSYSTEM_ROOT);
  for (const root of roots) {
    const candidate = path.join(root, 'Draymond-Orchestrator', 'OPS-CATALOG.md');
    if (isFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Normalize a catalog kind/key: lowercase, strip markdown `*`/backtick
 * decorators, collapse runs of non-alphanumerics into `_` so `mcp-server`,
 * `mcp server`, `MCP Server` and `mcp_server` all normalize to `mcp_server`.
 */
function normalizeKindKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[*`]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Trim a table cell and strip surrounding markdown emphasis/code wrappers. */
function cleanCell(raw: string): string {
  return raw.trim().replace(/^[*`]+|[*`]+$/g, '').trim();
}

/** Split a markdown table row into its data cells (empty decorators dropped). */
function splitRow(line: string): string[] {
  if (!line.trim().startsWith('|')) return [];
  const cells = line.split('|');
  return cells.slice(1, -1).map((c) => c.trim());
}

/** Cell values that identify a table header row inside an asset section. */
const HEADER_CELLS = new Set(['name', 'kind', 'slug', 'active', 'invocation', 'description', 'capability', 'resources', 'count']);

/** True when every cell is a markdown separator (e.g. `| --- | --- |`). */
function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^-+$/.test(c));
}

/** A cell named `path:agents/...` becomes `agents/...`; anything else → null. */
function pathFromInvocation(cell: string | undefined): string | null {
  const cleaned = cleanCell(cell ?? '');
  const match = /^path\s*:\s*(.+)$/i.exec(cleaned);
  if (!match || match[1].trim().length === 0) return null;
  return match[1].trim();
}

interface AssetColumnMap {
  name: number;
  kind: number;
  description?: number;
  invocation?: number;
}

/** Detect a header row and return its column layout, or null for data rows. */
function detectHeader(cells: string[]): AssetColumnMap | null {
  const layout: AssetColumnMap = { name: -1, kind: -1 };
  let isHeader = false;
  cells.forEach((cell, index) => {
    const key = normalizeKindKey(cell);
    if (key === 'name') { layout.name = index; isHeader = true; }
    else if (key === 'kind') { layout.kind = index; isHeader = true; }
    else if (key === 'description') { layout.description = index; isHeader = true; }
    else if (key === 'invocation') { layout.invocation = index; isHeader = true; }
    else if (HEADER_CELLS.has(key)) isHeader = true;
  });
  return isHeader ? layout : null;
}

function parseAssetRow(cells: string[], layout: AssetColumnMap | null): CatalogAsset | null {
  const nameIndex = layout ? layout.name : 0;
  const kindIndex = layout ? layout.kind : 1;
  const name = cleanCell(cells[nameIndex] ?? '');
  const kind = normalizeKindKey(cells[kindIndex] ?? '');
  if (!name || !kind) return null;

  const description =
    layout && layout.description !== undefined ? cleanCell(cells[layout.description] ?? '') : '';
  let assetPath: string | null = null;
  if (layout && layout.invocation !== undefined) {
    assetPath = pathFromInvocation(cells[layout.invocation]);
  } else if (cells.length >= 3) {
    assetPath = pathFromInvocation(cells[cells.length - 1]);
  }
  return { kind, name, description, path: assetPath };
}

/**
 * Load and parse the fleet catalog. Pure and testable: pass an env override
 * (e.g. OPENHUB_FLEET_CATALOG) to point at a specific catalog file. Never
 * throws — a missing/unreadable catalog degrades with an explicit error.
 */
export function loadFleetCatalog(env: NodeJS.ProcessEnv = process.env): FleetCatalogResult {
  const catalogPath = resolveCatalogPath(env);
  if (!catalogPath) {
    return {
      path: null,
      source: 'degraded',
      totals: {},
      assets: [],
      error: 'fleet catalog not found',
    };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(catalogPath, 'utf-8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      path: catalogPath,
      source: 'degraded',
      totals: {},
      assets: [],
      error: `cannot read fleet catalog: ${message}`,
    };
  }

  const totals: Record<string, number> = {};
  const assets: CatalogAsset[] = [];
  const lines = raw.split(/\r?\n/);

  let inTotals = false;
  let sectionLayout: AssetColumnMap | null = null;

  for (const line of lines) {
    if (assets.length >= MAX_CATALOG_ASSETS) break;

    if (/^##\s+totals\s*$/i.test(line)) {
      inTotals = true;
      sectionLayout = null;
      continue;
    }
    if (/^##\s/.test(line)) {
      inTotals = false;
      sectionLayout = null;
      continue;
    }
    if (/^###\s/.test(line)) {
      inTotals = false;
      sectionLayout = null; // reset per section; header detection happens on first row
      continue;
    }
    if (/^#/.test(line)) {
      inTotals = false;
      sectionLayout = null;
      continue;
    }

    const cells = splitRow(line);
    if (cells.length === 0) continue;

    if (inTotals) {
      // Totals rows are exactly `| kind | <integer> |`.
      if (cells.length === 2 && /^\d+$/.test(cells[1])) {
        const key = normalizeKindKey(cells[0]);
        if (key && key !== 'total') totals[key] = Number(cells[1]);
      }
      continue;
    }

    if (isSeparatorRow(cells)) continue;
    if (sectionLayout !== null) {
      const asset = parseAssetRow(cells, sectionLayout);
      if (asset) assets.push(asset);
      continue;
    }
    const layout = detectHeader(cells);
    if (layout) {
      sectionLayout = layout; // remember this section's column layout
      continue;
    }
    if (cells.length >= 2) {
      const asset = parseAssetRow(cells, null);
      if (asset) assets.push(asset);
    }
  }

  return { path: catalogPath, source: 'live', totals, assets };
}