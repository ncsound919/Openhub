import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const HOST = '127.0.0.1';
const PORT = Number(process.env.OPENCODE_PORT || '4196');
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
function readPassword(): string {
  try { return parsePassword(fs.readFileSync(PASSWORD_FILE, 'utf8')); } catch { return ''; }
}
export function getEnginePassword(): string { return readPassword(); }

export async function opencodeEngineHealth(): Promise<{ available: boolean; version?: string; error?: string }> {
  try {
    const res = await fetch(`${OPENCODE_BASE}/global/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { available: false, error: `HTTP ${res.status}` };
    const body = await res.json().catch(() => ({})) as { healthy?: boolean; version?: string };
    return { available: body.healthy === true, version: body.version };
  } catch (err) {
    return { available: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function startOpencodeEngine(): Promise<{ started: boolean; error?: string }> {
  const health = await opencodeEngineHealth();
  if (health.available) return { started: true };
  const pw = readPassword();
  if (!pw) return { started: false, error: 'no server password (see ~/.secrets/opencode/server-password)' };
  child = spawn(OPENCODE_BIN, buildServeArgs(), {
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: pw },
    stdio: 'ignore',
    detached: false,
    shell: process.platform === 'win32',
  });
  // A failed spawn (missing binary, EACCES, ...) emits 'error'. Without this
  // handler that event is unhandled and crashes the server; capture it so the
  // wait loop can return promptly instead of waiting out the full 10s.
  let spawnError: string | null = null;
  child.on('error', (err) => {
    spawnError = err instanceof Error ? err.message : String(err);
  });
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (spawnError) return { started: false, error: spawnError };
    if ((await opencodeEngineHealth()).available) return { started: true };
  }
  return { started: false, error: 'engine did not become healthy in 10s' };
}

export async function stopOpencodeEngine(): Promise<{ stopped: boolean }> {
  if (!child) return { stopped: false };
  child.kill();
  child = null;
  return { stopped: true };
}
