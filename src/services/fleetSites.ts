import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Fleet site inventory — OpenHub-local.
 *
 * 2026-10-15: re-homed from Keywire. The inventory's single source of truth was
 * `ecosystem-sites.json` (Keywire `sites.ts:26`); OpenHub now reads its own copy
 * at `data/ecosystem-sites.json` (override: `OPENHUB_SITES_FILE`). Keywire is no
 * longer consulted for this view, which removes the last *used* non-vault
 * coupling (`seo.ts:auditFleetSites`). The LLC compliance view was an unused
 * export and was deleted rather than re-homed.
 *
 * Honesty rules:
 *   - A site's state is `unknown` unless a probe actually ran. `allUp` is false
 *     whenever anything is down OR unknown — never true by omission.
 *   - A missing or malformed inventory reports `available: false` with the
 *     reason; it never returns an empty inventory that reads like "no sites".
 */

export interface SiteInventoryEntry {
  id: string;
  name: string;
  tier?: string;
  kind?: string;
  publicUrl?: string;
  originUrl?: string;
  domain?: string;
  vercelProject?: string;
  repoPath?: string;
  edge?: string;
  owner?: string;
  aliases?: string[];
}

export interface SiteInventory {
  version: number;
  updatedAt: string;
  description?: string;
  vercelTeamId?: string;
  sites: SiteInventoryEntry[];
}

export type SiteState = 'up' | 'down' | 'unknown';

export interface FleetSite extends SiteInventoryEntry {
  state: SiteState;
  status?: number | null;
  error?: string;
}

export interface FleetSitesSummary {
  total: number;
  up: number;
  down: number;
  unknown: number;
  allUp: boolean;
  criticalAttention: string[];
}

export interface FleetSitesView {
  generatedAt: string;
  inventoryUpdatedAt: string;
  source: 'local';
  probed: boolean;
  summary: FleetSitesSummary;
  sites: FleetSite[];
}

export interface FleetSitesResult {
  available: boolean;
  status?: number;
  data?: FleetSitesView;
  error?: string;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_INVENTORY = path.join(HERE, '..', '..', 'data', 'ecosystem-sites.json');

export function siteInventoryFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENHUB_SITES_FILE || DEFAULT_INVENTORY;
}

/** Read + validate the local inventory. Never throws; failure carries a reason. */
export function loadSiteInventory(env: NodeJS.ProcessEnv = process.env): FleetSitesResult {
  const file = siteInventoryFile(env);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    return { available: false, error: `site inventory unreadable at ${file}: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SiteInventory>;
    if (!Array.isArray(parsed.sites)) return { available: false, error: `site inventory has no sites[] array (${file})` };
    const sites = parsed.sites.filter((s): s is SiteInventoryEntry => !!s && typeof s.id === 'string' && typeof s.name === 'string');
    if (sites.length !== parsed.sites.length) {
      return { available: false, error: `site inventory has entries without id/name (${file})` };
    }
    return {
      available: true,
      status: 200,
      data: {
        generatedAt: new Date().toISOString(),
        inventoryUpdatedAt: String(parsed.updatedAt ?? ''),
        source: 'local',
        probed: false,
        summary: { total: sites.length, up: 0, down: 0, unknown: sites.length, allUp: false, criticalAttention: [] },
        sites: sites.map((s) => ({ ...s, state: 'unknown' as SiteState })),
      },
    };
  } catch (err) {
    return { available: false, error: `site inventory is not valid JSON (${file}): ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function probeSite(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<{ state: SiteState; status?: number | null; error?: string }> {
  try {
    const res = await fetchImpl(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    return { state: res.ok ? 'up' : 'down', status: res.status };
  } catch (err) {
    return { state: 'down', status: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The fleet-sites view. `probe: true` performs a bounded GET per site with a
 * public URL; without it every state is `unknown` (nothing is pretended).
 */
export async function fleetSites(
  env: NodeJS.ProcessEnv = process.env,
  opts: { probe?: boolean; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<FleetSitesResult> {
  const loaded = loadSiteInventory(env);
  if (!loaded.available || !loaded.data) return loaded;
  if (!opts.probe) return loaded;

  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const view = loaded.data;
  const sites: FleetSite[] = await Promise.all(
    view.sites.map(async (s) => {
      if (!s.publicUrl) return { ...s, state: 'unknown' as SiteState };
      const r = await probeSite(s.publicUrl, fetchImpl, timeoutMs);
      return { ...s, state: r.state, status: r.status ?? null, ...(r.error ? { error: r.error } : {}) };
    }),
  );
  const up = sites.filter((s) => s.state === 'up').length;
  const down = sites.filter((s) => s.state === 'down').length;
  const unknown = sites.filter((s) => s.state === 'unknown').length;
  return {
    available: true,
    status: 200,
    data: {
      ...view,
      probed: true,
      sites,
      summary: {
        total: sites.length,
        up,
        down,
        unknown,
        // Anything not proven up keeps allUp false — down OR unknown.
        allUp: sites.length > 0 && up === sites.length,
        criticalAttention: sites.filter((s) => s.tier === 'critical' && s.state !== 'up').map((s) => s.id),
      },
    },
  };
}
