import { spawn, execSync, type ChildProcess } from 'child_process';
import net from 'net';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ManagedServiceConfig {
  slug: string;
  name: string;
  port: number;
  healthPath: string;
  cwd: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  category: 'core' | 'audit' | 'repair' | 'llm' | 'game';
}

export interface ServiceStatus {
  slug: string;
  name: string;
  port: number;
  up: boolean;
  pid: number | null;
  category: 'core' | 'audit' | 'repair' | 'llm' | 'game';
  uptimeSeconds?: number;
  lastChecked: string;
}

const UPLIFT_ROOT = process.env.UPLIFT_ROOT || 'C:\\Users\\User\\Downloads\\Uplift';
const ORCH_DIR = path.join(UPLIFT_ROOT, 'Draymond-Orchestrator');
const AXIOM_DIR = path.join(UPLIFT_ROOT, 'Deepseek Harness', 'Axiom Agent');

/** Per-service log dir, so a failed boot is diagnosable from the UI/disk. */
function logDir(): string {
  const dir = path.resolve(__dirname, '..', '..', 'data', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const MANAGED_SERVICES: Record<string, ManagedServiceConfig> = {
  axiom: {
    slug: 'axiom',
    name: 'Axiom Coding Harness',
    port: 3198,
    healthPath: '/api/health',
    cwd: AXIOM_DIR,
    command: 'npx',
    args: ['tsx', 'server.ts'],
    category: 'core',
  },
  draymond: {
    slug: 'draymond',
    name: 'Draymond Orchestrator',
    port: 3444,
    healthPath: '/',
    cwd: ORCH_DIR,
    // The current build artifact is a full .next build (next start), not the
    // standalone output. `npm run start` serves it; a fresh `npm run build`
    // switches the artifact back to .next/standalone (see next.config.ts).
    command: 'npm',
    args: ['run', 'start'],
    env: {
      PORT: '3444',
      // Operator's documented constraints (fleet-manifest.js): autonomous
      // fleet cold-start / failover / repair-benchmark dispatch are OFF —
      // they caused EADDRINUSE crash loops. On-demand start must honor them.
      DRAYMOND_AUTOSTART_SERVICES: '0',
      DRAYMOND_SECTOR_LIFECYCLE: '0',
      DRAYMOND_FAILOVER_MATRIX: '0',
      DRAYMOND_REPAIR_BENCHMARK_ENABLED: '0',
      DRAYMOND_AUTO_START_SERVICES: '0',
    },
    category: 'repair',
  },
  grader: {
    slug: 'grader',
    name: 'Grader Code Evaluator',
    port: 3201,
    // Grader's own server.ts exposes /api/healthz and /api/readyz.
    healthPath: '/api/healthz',
    cwd: path.join(ORCH_DIR, 'agents', 'Grader-main'),
    command: 'npm',
    args: ['run', 'dev'],
    category: 'audit',
  },
  reporank: {
    slug: 'reporank',
    name: 'RepoRank Scanner',
    port: 3200,
    healthPath: '/health',
    cwd: path.join(ORCH_DIR, 'agents', 'reporank', 'apps', 'api'),
    command: 'npx',
    args: ['tsx', 'src/index.ts'],
    category: 'audit',
  },
  'claw-protect': {
    slug: 'claw-protect',
    name: 'Claw-Protect Security Audit',
    port: 3300,
    healthPath: '/api/health',
    cwd: path.join(ORCH_DIR, 'agents', 'Claw-Protect-main'),
    command: 'npm',
    args: ['run', 'dev'],
    env: { CLAW_PORT: '3300', CLAW_SERVE_SAAS: 'false' },
    category: 'audit',
  },
  codenexus: {
    slug: 'codenexus',
    name: 'CodeNexus PR & Review Engine',
    port: 3205,
    healthPath: '/health',
    cwd: path.join(ORCH_DIR, 'agents', 'CodeNexus-main'),
    command: 'npm',
    args: ['run', 'dev'],
    category: 'audit',
  },
  'the-deep': {
    slug: 'the-deep',
    name: 'The Deep Audit Engine',
    port: 3100,
    // The Deep serves /api/v1/health plus the static-analysis, bug-taxonomy
    // and deep-intent passes the `deep` audit scorer calls. tsx avoids a
    // stale-dist problem on on-demand start; PORT matches DEEP_URL default.
    healthPath: '/api/v1/health',
    cwd: path.join(UPLIFT_ROOT, 'The Deep'),
    command: 'npx',
    args: ['tsx', 'server.ts'],
    env: { PORT: '3100' },
    category: 'audit',
  },
  'vibe-reality': {
    slug: 'vibe-reality',
    name: 'Vibe-Reality Code Auditor',
    port: 3202,
    healthPath: '/api/health',
    cwd: path.join(ORCH_DIR, 'agents', 'Vibe-Reality-main'),
    command: 'node',
    args: ['--import', 'tsx', 'server.ts'],
    env: { PORT: '3202', VIBE_REALITY_LOCAL: '1' },
    category: 'audit',
  },
  mutly: {
    slug: 'mutly',
    name: 'Mutly Indexer & Daemon',
    port: 4000,
    healthPath: '/api/health',
    cwd: path.join(ORCH_DIR, 'agents', 'Mutly-Daemon-Agent'),
    command: 'npm',
    args: ['run', 'dev'],
    category: 'audit',
  },
  'deterministic-brain': {
    slug: 'deterministic-brain',
    name: 'Deterministic Brain',
    port: 3210,
    healthPath: '/health',
    cwd: path.join(ORCH_DIR, 'agents', 'deterministic-brain'),
    command: 'python',
    args: ['startup.py'],
    env: { API_PORT: '3210', UVICORN_WORKERS: '1' },
    category: 'core',
  },
  litellm: {
    slug: 'litellm',
    name: 'LiteLLM Proxy',
    port: 4100,
    healthPath: '/health',
    cwd: ORCH_DIR,
    command: 'litellm',
    args: ['--config', 'litellm.yaml', '--port', '4100'],
    category: 'llm',
  },
  redis: {
    slug: 'redis',
    name: 'Redis (queue for RepoRank/audit)',
    port: 6379,
    // Redis answers PING on any path with an error only when unauthenticated;
    // a plain GET returns 400/-ERR which is still <500, so the TCP check is the
    // real liveness signal and HTTP is only a formality.
    healthPath: '/',
    cwd: path.dirname(process.env.REDIS_BIN || 'C:\\Program Files\\Redis\\redis-server.exe'),
    // `redis-server` resolves on PATH (no spaces); a quoted absolute path is
    // needed when shell-spawning, so prefer the PATH name.
    command: process.env.REDIS_CMD || 'redis-server',
    args: [],
    category: 'core',
  },
  'dev-brain': {
    slug: 'dev-brain',
    name: 'Dev-Brain (fleet triage/intake)',
    port: 3450,
    healthPath: '/api/health',
    cwd: path.join(UPLIFT_ROOT, 'Dev-Brain'),
    command: 'node',
    args: ['dist/server.cjs'],
    env: { PORT: '3450', HOST: '127.0.0.1' },
    category: 'core',
  },
};

const activeProcesses = new Map<string, { proc: ChildProcess; startTime: number }>();
const lastActivity = new Map<string, number>();

/** Lifecycle guardrails: max concurrent running services. */
export const MAX_CONCURRENT_SERVICES = Number(process.env.OPENHUB_MAX_CONCURRENT_SERVICES) || 5;
/** Default idle TTL before a service is eligible for reap (default: 30 minutes). */
export const DEFAULT_IDLE_TTL_MS = Number(process.env.OPENHUB_SERVICE_IDLE_TTL_MS) || 30 * 60 * 1000;

export function touchServiceActivity(slug: string): void {
  lastActivity.set(slug, Date.now());
}

export function getLastActivity(slug: string): number | undefined {
  return lastActivity.get(slug);
}

export function getRunningServicesCount(): number {
  return activeProcesses.size;
}

/** Clear active processes tracking (test seam). */
export function clearActiveProcesses(): void {
  activeProcesses.clear();
  lastActivity.clear();
}

/** Ports the lifecycle manager must never kill, regardless of catalog: the
 *  auth authority (Keywire) and the control plane itself (OpenHub). */
export function isProtectedPort(port: number): boolean {
  return port === 3000 || port === 3010;
}

/** Build the env for a spawned service. The catalog port is pinned AFTER the
 *  inherited env (so a parent's PORT=3010 can never leak into a worker) and
 *  per-service env wins last. */
export function buildServiceEnv(config: ManagedServiceConfig, baseEnv: NodeJS.ProcessEnv): Record<string, string> {
  return { ...baseEnv, PORT: String(config.port), ...(config.env ?? {}) } as Record<string, string>;
}

/** Async TCP listen check — fast and never blocks the event loop. */
export function isPortListening(port: number, host = '127.0.0.1', timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (listening: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

/** Resolve the PID owning a listening port. Windows: PowerShell lookup (only
 *  called on the stop path, where the cost is acceptable). */
export function getListeningPid(port: number): number | null {
  try {
    if (process.platform === 'win32') {
      const output = execSync(
        `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess"`,
        { encoding: 'utf8', timeout: 6000, windowsHide: true }
      ).trim();
      const pid = parseInt(output, 10);
      return Number.isFinite(pid) && pid > 0 ? pid : null;
    } else {
      const output = execSync(`lsof -t -i:${port} -sTCP:LISTEN`, { encoding: 'utf8', timeout: 6000 }).trim();
      const pid = parseInt(output.split('\n')[0], 10);
      return Number.isFinite(pid) && pid > 0 ? pid : null;
    }
  } catch {
    return null;
  }
}

export async function probeHttp(port: number, healthPath: string, timeoutMs = 2500): Promise<boolean> {
  try {
    const url = `http://127.0.0.1:${port}${healthPath}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.status < 500;
  } catch {
    return false;
  }
}

export async function getServiceStatus(slug: string, includePid = false): Promise<ServiceStatus | null> {
  const config = MANAGED_SERVICES[slug];
  if (!config) return null;

  // Fast path: TCP check + HTTP probe. PID resolution is deferred (slow) and
  // only requested by the stop path.
  const listening = await isPortListening(config.port);
  const up = listening && (await probeHttp(config.port, config.healthPath));
  const active = activeProcesses.get(slug);

  return {
    slug: config.slug,
    name: config.name,
    port: config.port,
    up,
    pid: includePid && listening ? getListeningPid(config.port) : null,
    category: config.category,
    uptimeSeconds: active ? Math.floor((Date.now() - active.startTime) / 1000) : undefined,
    lastChecked: new Date().toISOString(),
  };
}

export async function getAllServicesStatus(includePid = false): Promise<ServiceStatus[]> {
  const slugs = Object.keys(MANAGED_SERVICES);
  const statuses = await Promise.all(slugs.map((s) => getServiceStatus(s, includePid)));
  return statuses.filter((s): s is ServiceStatus => s !== null);
}

export async function stopServiceSafe(slug: string): Promise<{ ok: boolean; message: string }> {
  const config = MANAGED_SERVICES[slug];
  if (!config) return { ok: false, message: `Unknown service: ${slug}` };

  // Safety invariant: never allow stopping the control plane (OpenHub) or the
  // auth authority (Keywire). The kill below is PID-targeted, but these two
  // ports are protected by policy regardless of what listens there.
  if (isProtectedPort(config.port)) {
    return { ok: false, message: `Refusing to stop protected service ${slug} (port ${config.port}).` };
  }

  const pid = getListeningPid(config.port);
  if (!pid) {
    activeProcesses.delete(slug);
    return { ok: true, message: `Service ${slug} on port ${config.port} is already stopped.` };
  }

  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore', timeout: 6000, windowsHide: true });
    } else {
      process.kill(pid, 'SIGTERM');
    }
    activeProcesses.delete(slug);
    return { ok: true, message: `Stopped ${slug} (PID ${pid}).` };
  } catch (err: any) {
    return { ok: false, message: `Failed to stop ${slug} (PID ${pid}): ${err.message}` };
  }
}

export async function startServiceSafe(slug: string): Promise<{ ok: boolean; message: string; status?: ServiceStatus }> {
  const config = MANAGED_SERVICES[slug];
  if (!config) return { ok: false, message: `Unknown service: ${slug}` };

  if (await isPortListening(config.port)) {
    const alive = await probeHttp(config.port, config.healthPath);
    if (alive) {
      return {
        ok: true,
        message: `Service ${slug} is already running on port ${config.port}.`,
        status: (await getServiceStatus(slug)) ?? undefined,
      };
    }
  }

  if (activeProcesses.size >= MAX_CONCURRENT_SERVICES && !activeProcesses.has(slug)) {
    return {
      ok: false,
      message: `Concurrency cap reached: maximum ${MAX_CONCURRENT_SERVICES} simultaneous services allowed. Stop an active service first.`,
    };
  }

  if (!fs.existsSync(config.cwd)) {
    return { ok: false, message: `Directory not found: ${config.cwd}` };
  }

  try {
    const outLog = path.join(logDir(), `${slug}.log`);
    const errLog = path.join(logDir(), `${slug}.err.log`);
    const proc = spawn(config.command, config.args, {
      cwd: config.cwd,
      // PORT is pinned to the catalog port for EVERY service: many of these
      // apps read process.env.PORT, and the OpenHub launcher exports PORT=3010
      // which would otherwise be inherited and cause EADDRINUSE exits.
      env: buildServiceEnv(config, process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });

    // Stream child output into the per-service logs (pipe is reliable where
    // inherited fds were not on Windows detached spawns).
    proc.stdout?.on('data', (d) => { try { fs.appendFileSync(outLog, d); } catch { /* best-effort logging */ } });
    proc.stderr?.on('data', (d) => { try { fs.appendFileSync(errLog, d); } catch { /* best-effort logging */ } });

    // Capture spawn/exit evidence so a failed boot is diagnosable from the
    // API response instead of a silent dead process.
    const spawnedAt = Date.now();
    let spawnError: string | null = null;
    let exitInfo: string | null = null;
    proc.on('error', (e) => { spawnError = e.message; });
    proc.on('exit', (code, signal) => { exitInfo = `code=${code} signal=${signal}`; });

    proc.unref();
    activeProcesses.set(slug, { proc, startTime: Date.now() });
    touchServiceActivity(slug);

    // Probe loop: wait up to 60s for the service port to open. Cold boots
    // (first tsx compile, DB init) legitimately take 20-40s.
    let ready = false;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (spawnError) break;
      if (exitInfo && !(await isPortListening(config.port))) break;
      if (await isPortListening(config.port)) {
        if (await probeHttp(config.port, config.healthPath, 1000)) {
          ready = true;
          break;
        }
      }
    }

    const currentStatus = await getServiceStatus(slug);
    const failureNote = spawnError
      ? `spawn error: ${spawnError}`
      : exitInfo
        ? `process exited early (${exitInfo}${spawnedAt > 0 ? ` after ${Math.round((Date.now() - spawnedAt) / 1000)}s` : ''})`
        : 'no failure captured';
    return {
      ok: ready,
      message: ready
        ? `Started ${slug} on port ${config.port}.`
        : `Process did not become healthy on port ${config.port} — ${failureNote} (logs: data/logs/${slug}.log)`,
      status: currentStatus ?? undefined,
    };
  } catch (err: any) {
    return { ok: false, message: `Spawn error for ${slug}: ${err.message}` };
  }
}

/**
 * Reap idle services whose activity has timed out.
 * Safe port/PID-targeted stops only.
 */
export async function reapIdleServices(idleTtlMs = DEFAULT_IDLE_TTL_MS): Promise<string[]> {
  const now = Date.now();
  const stopped: string[] = [];
  for (const [slug, entry] of activeProcesses.entries()) {
    const lastActive = lastActivity.get(slug) || entry.startTime;
    if (now - lastActive > idleTtlMs) {
      const res = await stopServiceSafe(slug);
      if (res.ok) stopped.push(slug);
    }
  }
  return stopped;
}

