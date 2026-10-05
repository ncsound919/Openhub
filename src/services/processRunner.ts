/**
 * Windows-safe process launcher (P4 / workstream G3).
 *
 * Every subprocess the audit spawns goes through here — codifying the launcher
 * quirks this codebase has hit repeatedly: `cmd.exe /d /s /c` for npm/npx/.cmd
 * shims, per-argument quoting, BOM/CRLF normalization, bounded buffers, and
 * preferring a project-local `node_modules/.bin` binary over a global/PATH one.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { recordCommandReceipt } from './receipts.js';
import { RESOLVED_BINS, hardenGitArgs, resolveBin, safeChildEnv, windowsSystemBin } from './binResolve.js';

export interface RunResult {
  ok: boolean;
  code: number | null;
  output: string;
  timedOut: boolean;
  durationMs: number;
  /** Receipt id for this execution (evidence spine). */
  receiptId?: string;
}

export interface RunOptions {
  cwd: string;
  timeoutMs?: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
  /** Human label for the receipt (e.g. the scorer that requested the run). */
  label?: string;
  /** Mark the run as a capability probe so it is excluded from the default list. */
  probe?: boolean;
  /** Skip receipting entirely (e.g. a probe whose only value is the version). */
  noReceipt?: boolean;
  /**
   * Allow resolving the executable from `cwd/node_modules/.bin`.
   *
   * OFF by default and deliberately so: `cwd` is frequently a repository the
   * user is auditing, and a repo that ships `node_modules/.bin/git` (or tsc,
   * eslint, …) would have its own binary executed by the scanner. That turns
   * "review this repo" into "run this repo". Enable it only for a workspace
   * the operator owns, never for scan targets.
   */
  allowLocalBin?: boolean;
}

const IS_WINDOWS = process.platform === 'win32';
const BIN_EXTS = IS_WINDOWS ? ['.cmd', '.exe', '.bat', ''] : ['', '.sh'];

/**
 * Tools that are Node CLI shims (`*.cmd` on Windows) and must run through
 * `cmd /c`. Real executables (node, git, python, pytest, ruff, trivy, …) are
 * spawned directly so their argv is never re-parsed by the shell.
 */
const SHELLABLE = /^(npm|npx|yarn|pnpm|corepack|tsc|eslint|jscpd|pa11y|license-checker|openapi-diff|axe)$/i;

/** Strip a UTF-8 BOM and normalize CRLF so parsers see clean text. */
export function normalizeOutput(input: string): string {
  return `${input ?? ''}`.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();
}

/**
 * Resolve `name` to a project-local binary when one exists, else return it
 * unchanged (PATH lookup). This is what makes `tsc`/`eslint`/`ruff` calls work
 * the same whether or not they are globally installed.
 */
export function resolveExecutable(name: string, cwd: string, allowLocalBin = false): string {
  if (name.includes('/') || name.includes('\\')) return name;
  // Untrusted `cwd` (a repo under review) must not supply the binary — see
  // RunOptions.allowLocalBin.
  if (!allowLocalBin) return name;
  const binDir = path.join(cwd, 'node_modules', '.bin');
  for (const ext of BIN_EXTS) {
    const candidate = path.join(binDir, `${name}${ext}`);
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return name;
}

function shellQuote(arg: string): string {
  if (arg === '') return '""';
  // cmd-safe: wrap anything with whitespace/metacharacters and double embedded
  // quotes (cmd's escape convention), so `|` inside a regex never becomes a pipe.
  // `%` is excluded from the bare-word set: cmd.exe expands %VAR% even inside
  // quotes, so an argument containing it must not reach the command line raw.
  if (/^[A-Za-z0-9_@+=:,./\\-]+$/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

/**
 * Kill `pid` and every process it started. On Windows `execFile`'s timeout only
 * kills the direct child (often cmd.exe), leaving npm/node/tsc running; on POSIX
 * the child was spawned detached, so it leads its own process group.
 */
export function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  if (IS_WINDOWS) {
    try {
      execFile(windowsSystemBin('taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15_000 }, () => {
        /* best effort */
      });
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/**
 * Run a command, bounded, with no shell injection surface beyond the quoted
 * argv we build ourselves. Never throws — failures come back as `ok: false`.
 */
export function runLocalCommand(
  cmd: string,
  args: string[],
  options: RunOptions,
): Promise<RunResult> {
  const { cwd, timeoutMs = 120_000, maxBuffer = 8 * 1024 * 1024, env } = options;
  // git/npm/npx are resolved to an absolute path outside `cwd` so a scanned
  // repo cannot plant its own `git.exe`/`npx.cmd` (Windows searches cwd first).
  const bare = !cmd.includes('/') && !cmd.includes('\\');
  const executable = bare && RESOLVED_BINS.has(cmd.toLowerCase())
    ? resolveBin(cmd.toLowerCase(), cwd)
    : resolveExecutable(cmd, cwd, options.allowLocalBin === true);
  // Neutralise repo-controlled git config (fsmonitor, hooks, file transport).
  const effectiveArgs = bare && cmd.toLowerCase() === 'git' ? hardenGitArgs(args) : args;
  // A resolved project-local `.cmd`/`.bat` shim needs cmd.exe; so does a known
  // shellable tool name on Windows.
  const needsShell = IS_WINDOWS && (/\.(cmd|bat)$/i.test(executable) || SHELLABLE.test(cmd));
  const runCmd = needsShell ? windowsSystemBin('cmd.exe') : executable;
  // Same convention Node uses for `shell: true`: the whole command line is
  // wrapped in one pair of quotes that `/s` strips, and passed verbatim so
  // libuv does not re-escape our cmd-style quoting (needed for absolute paths
  // such as "C:\\Program Files\\nodejs\\npx.cmd").
  const runArgs = needsShell
    ? ['/d', '/s', '/c', `"${[executable, ...effectiveArgs].map(shellQuote).join(' ')}"`]
    : effectiveArgs;

  const startedAt = Date.now();
  return new Promise((resolve) => {
    let killedByTimeout = false;
    let overflowed = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;

    // spawn (not execFile): execFile drops `detached`, and on POSIX the child
    // must lead its own process group so a timeout can kill the whole tree.
    let child: ChildProcess;
    const finish = (spawnError: Error | null, exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const stdout = Buffer.concat(outChunks).toString('utf8');
      const stderr = Buffer.concat(errChunks).toString('utf8');
      const error = spawnError || overflowed || killedByTimeout || signal !== null || exitCode !== 0;
      const output = normalizeOutput(`${stdout}\n${stderr}`);
      const elapsed = Date.now() - startedAt;
      // Windows does not always set `killed`/`SIGTERM` when the timeout fires,
      // so also treat "failed after ~the timeout elapsed" as a timeout.
      const timedOut = Boolean(error) && (
        killedByTimeout
        || signal === 'SIGTERM'
        || elapsed >= timeoutMs - 150
      );
      const code = error ? exitCode : 0;
      let receiptId: string | undefined;
      if (!options.noReceipt) {
        try {
          const receipt = recordCommandReceipt({
            command: [cmd, ...args].join(' '),
            tool: cmd,
            cwd,
            status: !error ? 'passed' : timedOut ? 'timeout' : 'failed',
            exitCode: code,
            startedAt,
            durationMs: elapsed,
            output,
            ...(options.probe ? { probe: true } : {}),
            ...(options.label ? { label: options.label } : {}),
          });
          receiptId = receipt.id;
        } catch {
          /* evidence recording must never fail the command */
        }
      }
      resolve({
        ok: !error,
        code,
        output,
        timedOut,
        durationMs: elapsed,
        ...(receiptId ? { receiptId } : {}),
      });
    };
    try {
      child = spawn(runCmd, runArgs, {
        cwd,
        windowsHide: true,
        env: safeChildEnv(env),
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(needsShell ? { windowsVerbatimArguments: true } : {}),
        ...(IS_WINDOWS ? {} : { detached: true }),
      });
    } catch (err) {
      finish(err as Error, null, null);
      return;
    }
    const collect = (chunks: Buffer[], which: 'out' | 'err') => (chunk: Buffer): void => {
      const size = which === 'out' ? (outBytes += chunk.length) : (errBytes += chunk.length);
      if (size > maxBuffer) {
        if (!overflowed) {
          overflowed = true;
          killProcessTree(child.pid);
        }
        return;
      }
      chunks.push(chunk);
    };
    child.stdout?.on('data', collect(outChunks, 'out'));
    child.stderr?.on('data', collect(errChunks, 'err'));
    child.on('error', (err) => finish(err, null, null));
    child.on('close', (exitCode, signal) => finish(null, exitCode, signal));
    timer = setTimeout(() => {
      killedByTimeout = true;
      killProcessTree(child.pid);
    }, timeoutMs);
    timer.unref?.();
  });
}

export interface ToolProbe {
  name: string;
  available: boolean;
  version?: string;
  reason?: string;
}

const probeCache = new Map<string, ToolProbe>();
const PROBE_CACHE_MAX = 200;

/**
 * Probe whether a CLI tool can actually run (P4 preflight). Results are cached
 * per process; an unavailable tool is reported honestly, never assumed.
 */
export async function probeTool(
  name: string,
  versionArgs: string[],
  cwd: string,
  timeoutMs = 8_000,
): Promise<ToolProbe> {
  const cacheKey = `${cwd}::${name}`;
  const cached = probeCache.get(cacheKey);
  if (cached) return cached;
  const run = await runLocalCommand(name, versionArgs, { cwd, timeoutMs, probe: true, label: `probe:${name}` });
  const firstLine = run.output.split('\n').find((l) => l.trim())?.trim().slice(0, 80);
  const probe: ToolProbe = run.ok
    ? { name, available: true, ...(firstLine ? { version: firstLine } : {}) }
    : {
        name,
        available: false,
        reason: run.timedOut ? `${name} timed out` : firstLine || `${name} not runnable (exit ${run.code ?? 'unknown'})`,
      };
  probeCache.set(cacheKey, probe);
  if (probeCache.size > PROBE_CACHE_MAX) {
    const oldest = probeCache.keys().next().value;
    if (oldest !== undefined) probeCache.delete(oldest);
  }
  return probe;
}

/** Clear the per-process tool probe cache (tests / after installing tools). */
export function resetToolProbeCache(): void {
  probeCache.clear();
}
