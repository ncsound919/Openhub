/**
 * Windows-safe process launcher (P4 / workstream G3).
 *
 * Every subprocess the audit spawns goes through here — codifying the launcher
 * quirks this codebase has hit repeatedly: `cmd.exe /d /s /c` for npm/npx/.cmd
 * shims, per-argument quoting, BOM/CRLF normalization, bounded buffers, and
 * preferring a project-local `node_modules/.bin` binary over a global/PATH one.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { recordCommandReceipt } from './receipts.js';

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
 * Run a command, bounded, with no shell injection surface beyond the quoted
 * argv we build ourselves. Never throws — failures come back as `ok: false`.
 */
export function runLocalCommand(
  cmd: string,
  args: string[],
  options: RunOptions,
): Promise<RunResult> {
  const { cwd, timeoutMs = 120_000, maxBuffer = 8 * 1024 * 1024, env } = options;
  const executable = resolveExecutable(cmd, cwd, options.allowLocalBin === true);
  // A resolved project-local `.cmd`/`.bat` shim needs cmd.exe; so does a known
  // shellable tool name on Windows.
  const needsShell = IS_WINDOWS && (/\.(cmd|bat)$/i.test(executable) || SHELLABLE.test(cmd));
  const runCmd = needsShell ? (process.env.ComSpec ?? 'cmd.exe') : executable;
  const runArgs = needsShell
    ? ['/d', '/s', '/c', [executable, ...args].map(shellQuote).join(' ')]
    : args;

  const startedAt = Date.now();
  return new Promise((resolve) => {
    execFile(
      runCmd,
      runArgs,
      { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer, ...(env ? { env } : {}) },
      (error, stdout, stderr) => {
        const output = normalizeOutput(`${stdout || ''}\n${stderr || ''}`);
        const err = error as { code?: number | string | null; killed?: boolean; signal?: string | null } | null;
        const elapsed = Date.now() - startedAt;
        // Windows does not always set `killed`/`SIGTERM` when the timeout fires,
        // so also treat "failed after ~the timeout elapsed" as a timeout.
        const timedOut = Boolean(error) && (
          Boolean(err?.killed)
          || err?.signal === 'SIGTERM'
          || err?.code === 'ETIMEDOUT'
          || elapsed >= timeoutMs - 150
        );
        const code = error ? (typeof err?.code === 'number' ? err.code : null) : 0;
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
      },
    );
  });
}

export interface ToolProbe {
  name: string;
  available: boolean;
  version?: string;
  reason?: string;
}

const probeCache = new Map<string, ToolProbe>();

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
  return probe;
}

/** Clear the per-process tool probe cache (tests / after installing tools). */
export function resetToolProbeCache(): void {
  probeCache.clear();
}
