import fs from 'node:fs';
import path from 'node:path';

/**
 * fleetMcp.ts — the fleet's MCP servers registered with the opencode engine.
 *
 * The coding loop (missions, review, repair) only benefits from a tool when the
 * engine can actually spawn or reach it, so a server is registered only when
 * its configuration exists on this machine: a checkout that is present (and, for
 * compiled servers, built), or a configured endpoint URL. Everything else is
 * reported with `enabled:false` and the reason — a tool is never advertised as
 * wired when nothing would answer.
 *
 * Registration happens at engine spawn: `opencodeEngine.engineConfigOverlay`
 * merges these entries into the operator's own `~/.config/opencode/opencode.json`,
 * so the operator's MCP servers, agents and providers are preserved (their entry
 * always wins on an id clash).
 *
 * Wired here (ncsound919 fleet, full-stack development aid):
 *   - sequential-thinking  built-in  step-by-step reasoning for planning/review
 *   - og-glass             local/remote  UI preset + design validation MCP
 *                          (remote-first: design.overlay365.online serves /mcp)
 *   - dev-brain            local     deterministic decision/triage MCP bridge
 *   - business-logic       local     domain rules / state machines / validation
 *
 * math-x, BigBack- and Middle-Man-MCP are HTTP services, not MCP servers — they
 * are wired through the capability registry (`capabilityRegistry.ts`) for
 * probing and discovery.
 */

/** One MCP server as opencode will spawn/reach it. */
export type FleetMcpEntry =
  | { type: 'local'; command: string[] }
  | { type: 'remote'; url: string; headers?: Record<string, string> };

export interface FleetMcpServer {
  /** opencode `mcp` map key. */
  id: string;
  label: string;
  /** Whether the server will be registered with the engine. */
  enabled: boolean;
  /** Why it is not registered — present on every disabled server, never silent. */
  reason?: string;
  /** opencode mcp entry; absent when disabled. */
  config?: FleetMcpEntry;
  /** Env var (or 'built-in') that controls this entry. */
  source: string;
}

const SEQ_THINK_PKG = '@modelcontextprotocol/server-sequential-thinking';

/** Set to 0/false/no to keep sequential thinking out of the engine. */
function seqThinkEnabled(env: NodeJS.ProcessEnv): boolean {
  const v = (env.OPENHUB_MCP_SEQTHINK ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'no');
}

/**
 * A local stdio server from a checkout. Disabled (with the reason) when the
 * checkout is absent or — when `entry` is given — not built yet, so opencode is
 * never handed a command that cannot start.
 */
function localDirServer(
  id: string,
  label: string,
  source: string,
  dir: string | undefined,
  entry: string[] | null,
  command: (dirAbs: string) => string[],
  hint: string,
): FleetMcpServer {
  if (!dir || !dir.trim()) {
    return { id, label, enabled: false, reason: hint, source };
  }
  const dirAbs = path.resolve(dir);
  if (!isDir(dirAbs)) {
    return { id, label, enabled: false, reason: `${source}=${dirAbs} does not exist`, source };
  }
  if (entry) {
    const entryPath = path.join(dirAbs, ...entry);
    if (!isFile(entryPath)) {
      return {
        id, label, enabled: false,
        reason: `${entryPath} not found — build it first (npm install && npm run build in ${dirAbs})`,
        source,
      };
    }
  }
  return { id, label, enabled: true, config: { type: 'local', command: command(dirAbs) }, source };
}

/**
 * A remote Streamable-HTTP server from its endpoint URL, optionally carrying an
 * Authorization header value (e.g. `Basic base64(user:pass)` or `Bearer …`) for
 * endpoints behind a gate — `design.overlay365.online` sits behind Caddy basic
 * auth, so without the header every MCP call would be a 401.
 */
function remoteServer(
  id: string,
  label: string,
  source: string,
  url: string | undefined,
  auth?: string,
): FleetMcpServer | null {
  if (!url || !url.trim()) return null;
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return { id, label, enabled: false, reason: `${source} must be an http(s) URL (got ${JSON.stringify(trimmed)})`, source };
  }
  const authValue = auth?.trim();
  return {
    id,
    label,
    enabled: true,
    config: {
      type: 'remote',
      url: trimmed,
      ...(authValue ? { headers: { Authorization: authValue } } : {}),
    },
    source,
  };
}

/**
 * Local dir or remote URL — either way the server is available only when one of
 * the two is configured. Returns the disabled server when neither is, so the
 * report names what to set.
 */
function localOrRemote(opts: {
  id: string;
  label: string;
  dirEnv: string;
  urlEnv: string;
  dir?: string;
  url?: string;
  /** Authorization header VALUE for the remote endpoint (optional gate). */
  auth?: string;
  entry: string[] | null;
  command: (dirAbs: string) => string[];
  hint: string;
  repo: string;
}): FleetMcpServer {
  const remote = remoteServer(opts.id, opts.label, opts.urlEnv, opts.url, opts.auth);
  if (remote) return remote;
  const local = localDirServer(opts.id, opts.label, opts.dirEnv, opts.dir, opts.entry, opts.command, '');
  if (local.enabled) return local;
  if (opts.dir && opts.dir.trim() && local.reason && !local.reason.startsWith('set ')) {
    // dir was configured but unusable — report that, not the generic hint.
    return local;
  }
  return {
    id: opts.id,
    label: opts.label,
    enabled: false,
    reason: `${opts.hint} (${opts.repo}) — set ${opts.dirEnv} (checkout) or ${opts.urlEnv} (HTTP MCP endpoint)`,
    source: opts.dirEnv,
  };
}

/**
 * Every fleet MCP server with its current registration state. Pure: reads only
 * `env` and the filesystem, no network. Order is stable (engine config and the
 * status report both depend on it).
 */
export function fleetMcpServers(env: NodeJS.ProcessEnv = process.env): FleetMcpServer[] {
  const servers: FleetMcpServer[] = [];

  // Built-in: official sequential-thinking server. Default on because the
  // operator asked for it; `npx -y` fetches it on first engine use.
  servers.push(
    seqThinkEnabled(env)
      ? {
          id: 'sequential-thinking',
          label: 'Sequential Thinking',
          enabled: true,
          config: { type: 'local', command: ['npx', '-y', SEQ_THINK_PKG] },
          source: 'built-in',
        }
      : {
          id: 'sequential-thinking',
          label: 'Sequential Thinking',
          enabled: false,
          reason: 'disabled by OPENHUB_MCP_SEQTHINK=0',
          source: 'OPENHUB_MCP_SEQTHINK',
        },
  );

  // OG-Glass — UI preset / design validation MCP. Remote-first: the deployed
  // instance (design.overlay365.online) already serves HTTP MCP at /mcp.
  servers.push(localOrRemote({
    id: 'og-glass',
    label: 'OG-Glass Design MCP',
    dirEnv: 'OPENHUB_MCP_OG_GLASS_DIR',
    urlEnv: 'OPENHUB_MCP_OG_GLASS_URL',
    dir: env.OPENHUB_MCP_OG_GLASS_DIR,
    url: env.OPENHUB_MCP_OG_GLASS_URL,
    auth: env.OPENHUB_MCP_OG_GLASS_AUTH,
    entry: ['dist', 'index.js'],
    command: (d) => ['node', path.join(d, 'dist', 'index.js')],
    hint: 'UI preset + design-validation MCP not configured',
    repo: 'github.com/ncsound919/OG-Glass',
  }));

  // Dev-Brain — deterministic decision/triage MCP bridge (tsx, no build step).
  servers.push(localDirServer(
    'dev-brain',
    'Dev-Brain Decision MCP',
    'OPENHUB_MCP_DEVBRAIN_DIR',
    env.OPENHUB_MCP_DEVBRAIN_DIR,
    ['dev-brain-mcp.ts'],
    (d) => ['npx', '-y', 'tsx', path.join(d, 'dev-brain-mcp.ts')],
    'set OPENHUB_MCP_DEVBRAIN_DIR to a checkout of github.com/ncsound919/Dev-Brain',
  ));

  // Business-Logic-MCP — domain rules, state machines, validation (37 tools).
  servers.push(localDirServer(
    'business-logic',
    'Business-Logic MCP',
    'OPENHUB_MCP_BUSINESS_LOGIC_DIR',
    env.OPENHUB_MCP_BUSINESS_LOGIC_DIR,
    ['dist', 'index.js'],
    (d) => ['node', path.join(d, 'dist', 'index.js')],
    'set OPENHUB_MCP_BUSINESS_LOGIC_DIR to a checkout of github.com/ncsound919/Business-Logic-MCP',
  ));

  return servers;
}

/** The servers that will actually be registered (enabled with a config). */
export function activeFleetMcp(env: NodeJS.ProcessEnv = process.env): FleetMcpServer[] {
  return fleetMcpServers(env).filter((s) => s.enabled && s.config);
}

/**
 * Merge the fleet's MCP servers into an opencode config object.
 *
 * The operator's own entries always win on an id clash — this only adds what is
 * missing, never overwrites a server the operator already declared. `base` is
 * re-serialized wholesale (same contract as mergeLocalProvider): agents,
 * providers and every other setting survive.
 */
export function mergeFleetMcp(
  base: unknown,
  servers: FleetMcpServer[],
): { ok: true; config: Record<string, unknown>; added: string[] } | { ok: false; error: string } {
  if (base != null && (typeof base !== 'object' || Array.isArray(base))) {
    return { ok: false, error: 'opencode config is not a JSON object' };
  }
  const config = { ...((base as Record<string, unknown> | null) ?? {}) };
  const existing = (config.mcp && typeof config.mcp === 'object' && !Array.isArray(config.mcp))
    ? { ...(config.mcp as Record<string, unknown>) }
    : {};
  const added: string[] = [];
  for (const server of servers) {
    if (!server.enabled || !server.config) continue;
    if (existing[server.id] !== undefined) continue; // operator's entry wins
    existing[server.id] = server.config;
    added.push(server.id);
  }
  config.mcp = existing;
  return { ok: true, config, added };
}

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}
