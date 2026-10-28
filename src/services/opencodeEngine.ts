import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { localModelTarget, mergeLocalProvider, probeBase, normalizeBaseUrl } from './localModel.js';
import { fleetMcpServers, mergeFleetMcp } from './fleetMcp.js';

const HOST = '127.0.0.1';
const PORT = (() => {
  const n = Number(process.env.OPENCODE_PORT || '4196');
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 4196;
})();
export const OPENCODE_BASE = `http://${HOST}:${PORT}`;
/**
 * Where the CLI lives when OPENCODE_BIN is unset.
 *
 * Windows keeps the npm-global location. On Linux/Android `npm/opencode` was a
 * relative path (APPDATA is unset), so the spawn silently looked in the current
 * directory. Use PATH instead; Termux users point OPENCODE_BIN at the proot
 * wrapper explicitly.
 */
const OPENCODE_BIN = process.env.OPENCODE_BIN
  || (process.platform === 'win32'
    ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm', 'opencode.cmd')
    : 'opencode');
// USERPROFILE is Windows-only; on Termux the old default resolved to the
// relative `.secrets/...` and never found the password the phone writes to $HOME.
const PASSWORD_FILE = process.env.OPENCODE_SERVER_PASSWORD_FILE
  || path.join(os.homedir(), '.secrets', 'opencode', 'server-password');

let child: ChildProcess | null = null;

export function parsePassword(raw: string | undefined): string {
  return (raw ?? '').replace(/\r?\n$/, '');
}
export function buildServeArgs(): string[] {
  return ['serve', '--hostname', HOST, '--port', String(PORT)];
}
// Re-read the secret at most every 5 s: it used to hit the disk synchronously on
// every proxied request and every SSE poll, yet still picks up a rotation quickly.
let pwCache: { value: string; at: number } | null = null;
function readPassword(): string {
  if (pwCache && Date.now() - pwCache.at < 5_000) return pwCache.value;
  let value = '';
  try { value = parsePassword(fs.readFileSync(PASSWORD_FILE, 'utf8')); } catch { value = ''; }
  pwCache = { value, at: Date.now() };
  return value;
}
export function getEnginePassword(): string { return readPassword(); }

/** Basic auth header for the engine. Lives here so health probes can use it too. */
export function basicAuthHeader(pw: string = readPassword()): string {
  const user = process.env.OPENCODE_SERVER_USERNAME || 'opencode';
  return 'Basic ' + Buffer.from(`${user}:${pw}`).toString('base64');
}

export async function opencodeEngineHealth(): Promise<{ available: boolean; version?: string; error?: string }> {
  try {
    // The engine enforces basic auth once OPENCODE_SERVER_PASSWORD is set, so an
    // unauthenticated probe gets 401 and a RUNNING engine looks down (which made
    // start() spawn a duplicate that dies on the port clash).
    const res = await fetch(`${OPENCODE_BASE}/global/health`, {
      headers: { Authorization: basicAuthHeader() },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return { available: false, error: `HTTP ${res.status}` };
    const body = await res.json().catch(() => ({})) as { healthy?: boolean; version?: string };
    return { available: body.healthy === true, version: body.version };
  } catch (err) {
    return { available: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Where the operator's own opencode config lives (OPENCODE_CONFIG wins). */
export function operatorConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENCODE_CONFIG || path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
}

/**
 * Engine config overlay handed back as `OPENCODE_CONFIG_CONTENT` at spawn.
 *
 * Two things are merged into the operator's own opencode config:
 *   1. the local model (Qwen GGUF on the phone) — the engine gets its provider
 *      list from config, so a local OpenAI-compatible server is invisible until
 *      a `provider.local` block exists;
 *   2. the fleet's MCP servers (fleetMcp.ts) — sequential-thinking, OG-Glass,
 *      Dev-Brain, Business-Logic, Middle-Man — so missions and the coding loop
 *      can actually call them.
 *
 * The operator's MCP servers, agents and every other setting survive: their
 * file is re-serialized with only additions (their entry wins on an id clash).
 * Returns null when there is nothing to merge, or when the config cannot be
 * parsed — an overlay built from a broken file would silently drop the
 * operator's MCP servers, so the engine keeps reading its own file instead.
 */
export async function engineConfigOverlay(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const target = localModelTarget(env);
  const fleet = fleetMcpServers(env);
  const fleetActive = fleet.filter((s) => s.enabled && s.config);
  if (!target && fleetActive.length === 0) return null;

  let userConfig: unknown = null;
  const configPath = operatorConfigPath(env);
  if (fs.existsSync(configPath)) {
    try {
      userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (err) {
      console.warn(
        `[opencode] ${configPath} is not valid JSON (${err instanceof Error ? err.message : String(err)}); `
        + 'the local model and fleet MCP servers are NOT registered so your own MCP servers keep working. Fix the file and restart.',
      );
      return null;
    }
  }

  let base: unknown = userConfig;
  if (target) {
    // Discover the ids the server actually serves so a renamed GGUF still works.
    const discovered: string[] = [];
    for (const candidate of target.candidates) {
      const res = await probeBase(normalizeBaseUrl(candidate), fetch, 1500);
      if (res.ok) {
        discovered.push(...res.models);
        break;
      }
    }
    const merged = mergeLocalProvider(userConfig, target, discovered);
    if (!merged.ok) {
      console.warn(`[opencode] local model not registered: ${merged.error}`);
      return null;
    }
    base = merged.config;
  }

  const withMcp = mergeFleetMcp(base, fleet);
  if (!withMcp.ok) {
    console.warn(`[opencode] fleet MCP servers not registered: ${withMcp.error}`);
    return null;
  }
  if (withMcp.added.length) {
    console.log(`[opencode] fleet MCP registered: ${withMcp.added.join(', ')}`);
  }
  const skipped = fleet.filter((s) => !s.enabled && s.reason);
  if (skipped.length) {
    console.log(`[opencode] fleet MCP not registered: ${skipped.map((s) => `${s.id} (${s.reason})`).join('; ')}`);
  }
  return JSON.stringify(withMcp.config);
}

/**
 * Environment for the spawned engine. `OPENHUB_OPENCODE_DATA_DIR` gives the
 * engine its own opencode data root (via XDG_DATA_HOME) so the app never has to
 * migrate or fight over a desktop CLI's database. An existing install whose DB
 * was written by a different opencode schema otherwise fails at startup with
 * "Database is not empty and has no session table".
 */
export function buildEngineEnv(
  pw: string,
  env: NodeJS.ProcessEnv = process.env,
  overlay?: string | null,
): NodeJS.ProcessEnv {
  const dataDir = env.OPENHUB_OPENCODE_DATA_DIR;
  return {
    ...env,
    ...(dataDir ? { XDG_DATA_HOME: path.resolve(dataDir) } : {}),
    OPENCODE_SERVER_PASSWORD: pw,
    // Only set when the operator has a local model configured; otherwise the
    // engine keeps reading its own config file.
    ...(overlay ? { OPENCODE_CONFIG_CONTENT: overlay } : {}),
  };
}

let starting: Promise<{ started: boolean; error?: string }> | null = null;

/** Concurrent callers share one spawn; a double-click used to leak a second child. */
export function startOpencodeEngine(): Promise<{ started: boolean; error?: string }> {
  if (!starting) starting = doStart().finally(() => { starting = null; });
  return starting;
}

function openEngineLog(): number | 'ignore' {
  try {
    const dir = path.join(process.cwd(), 'data');
    fs.mkdirSync(dir, { recursive: true });
    return fs.openSync(path.join(dir, 'opencode-engine.log'), 'a');
  } catch { return 'ignore'; }
}

async function doStart(): Promise<{ started: boolean; error?: string }> {
  const health = await opencodeEngineHealth();
  if (health.available) return { started: true };
  const pw = readPassword();
  if (!pw) return { started: false, error: 'no server password (see ~/.secrets/opencode/server-password)' };
  const win = process.platform === 'win32';
  const log = openEngineLog();
  // Register the local model + fleet MCP servers before the engine reads its config.
  const overlay = await engineConfigOverlay().catch((err) => {
    console.warn(`[opencode] engine config overlay failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  });
  const proc = spawn(win && /\s/.test(OPENCODE_BIN) ? `"${OPENCODE_BIN}"` : OPENCODE_BIN, buildServeArgs(), {
    env: buildEngineEnv(pw, process.env, overlay),
    stdio: ['ignore', log, log],
    // On POSIX the child becomes its own process-group leader so stop() can
    // signal the whole tree. On Android the binary is a proot wrapper: killing
    // only the wrapper orphaned opencode, which kept squatting port 4196.
    detached: !win,
    shell: win,
  });
  child = proc;
  if (typeof log === 'number') { try { fs.closeSync(log); } catch { /* child holds its own dup */ } }
  // Crashed/exited engines must not leave a stale handle for stop() to kill.
  proc.on('exit', () => { if (child === proc) child = null; });
  // A failed spawn (missing binary, EACCES, ...) emits 'error'. Without this
  // handler that event is unhandled and crashes the server; capture it so the
  // wait loop can return promptly instead of waiting out the full 10s.
  let spawnError: string | null = null;
  proc.on('error', (err) => {
    spawnError = err instanceof Error ? err.message : String(err);
    // The handle is dead; clear it so a later stop() does not try to kill it.
    if (child === proc) child = null;
  });
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (spawnError) return { started: false, error: spawnError };
    if ((await opencodeEngineHealth()).available) return { started: true };
  }
  return { started: false, error: 'engine did not become healthy in 10s (see data/opencode-engine.log)' };
}

// If OpenHub dies, don't orphan `opencode serve` on port 4196 (it blocks the
// desktop app). 'exit' handlers must be synchronous, hence spawnSync.
process.once('exit', () => {
  const proc = child;
  if (!proc || proc.pid == null) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', taskkillArgs(proc.pid), { stdio: 'ignore' });
    else process.kill(-proc.pid, 'SIGKILL');
  } catch { /* best effort */ }
});

/**
 * Signal a spawned engine and its descendants. POSIX engines are spawned
 * detached (their own process group), so a negative pid reaches the wrapper's
 * children too; Windows uses taskkill /T.
 */
export function killEngineTree(proc: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (proc.pid == null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', taskkillArgs(proc.pid), { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-proc.pid, signal);
  } catch {
    try { proc.kill(signal); } catch { /* already exited */ }
  }
}

/**
 * Args that force-kill a process and all of its descendants on Windows.
 * `taskkill /T` walks the tree; `/F` forces it.
 */
export function taskkillArgs(pid: number): string[] {
  return ['/pid', String(pid), '/T', '/F'];
}

export async function stopOpencodeEngine(): Promise<{ stopped: boolean; reason?: string }> {
  const proc = child;
  // An engine started elsewhere (desktop app, a terminal) is not ours to kill.
  if (!proc) return { stopped: false, reason: 'no engine was started by OpenHub in this process' };
  child = null;
  if (process.platform === 'win32' && proc.pid != null) {
    // On Windows the engine is spawned through the shell (`shell: true`), so the
    // direct child is cmd.exe. `proc.kill()` would kill only the shell and orphan
    // `opencode serve`, which then squats port 4196 (conflicting with the desktop
    // app). Kill the whole tree with taskkill instead.
    await new Promise<void>((resolve) => {
      try {
        const killer = spawn('taskkill', taskkillArgs(proc.pid as number), { stdio: 'ignore' });
        killer.on('error', () => resolve());
        killer.on('close', () => resolve());
      } catch {
        resolve();
      }
    });
  } else {
    // Give the engine a moment to exit on SIGTERM, then force the group. Without
    // the group signal, Termux leaves `opencode serve` (inside proot) running,
    // so the next start() fails on the occupied port.
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(); } };
      proc.once('exit', finish);
      killEngineTree(proc, 'SIGTERM');
      const timer = setTimeout(() => {
        if (!settled) killEngineTree(proc, 'SIGKILL');
        finish();
      }, 1500);
      timer.unref?.();
    });
  }
  return { stopped: true };
}
