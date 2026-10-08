import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const HOST = '127.0.0.1';
const PORT = (() => {
  const n = Number(process.env.OPENCODE_PORT || '4196');
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 4196;
})();
export const OPENCODE_BASE = `http://${HOST}:${PORT}`;
const OPENCODE_BIN = process.env.OPENCODE_BIN
  || path.join(process.env.APPDATA || '', 'npm', process.platform === 'win32' ? 'opencode.cmd' : 'opencode');
const PASSWORD_FILE = process.env.OPENCODE_SERVER_PASSWORD_FILE
  || path.join(process.env.USERPROFILE || '', '.secrets', 'opencode', 'server-password');

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
  const proc = spawn(win && /\s/.test(OPENCODE_BIN) ? `"${OPENCODE_BIN}"` : OPENCODE_BIN, buildServeArgs(), {
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: pw },
    stdio: ['ignore', log, log],
    detached: false,
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
    else proc.kill();
  } catch { /* best effort */ }
});

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
    try {
      proc.kill();
    } catch {
      /* already exited */
    }
  }
  return { stopped: true };
}
