/**
 * Absolute-path resolution for the tools OpenHub spawns inside repositories
 * it does not own (git, npm, npx).
 *
 * On Windows, `CreateProcess` (and libuv's PATH search) look in the current
 * directory before PATH. OpenHub routinely runs `git`/`npx` with `cwd` set to a
 * cloned or imported repository, so a repo that ships `git.exe` or `npx.cmd`
 * at its root would have that file executed instead of the real tool. We
 * therefore resolve each tool once, from a directory we control, to an
 * absolute path that is not inside the target repo, and spawn that.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const IS_WINDOWS = process.platform === 'win32';
const WIN_EXEC_EXTS = new Set(['.exe', '.cmd', '.bat', '.com']);

/** Tools resolved to absolute paths before they are spawned. */
export const RESOLVED_BINS: ReadonlySet<string> = new Set(['git', 'npm', 'npx']);

const candidateCache = new Map<string, string[]>();

function systemRoot(): string {
  return process.env.SystemRoot || process.env.windir || 'C:\\Windows';
}

/** Absolute path to a Windows system executable (cmd.exe, where.exe, taskkill.exe). */
export function windowsSystemBin(name: string): string {
  return path.join(systemRoot(), 'System32', name);
}

function norm(p: string): string {
  const r = path.resolve(p);
  return IS_WINDOWS ? r.toLowerCase() : r;
}

/** True when `child` is `parent` or lies beneath it. */
export function isInsideDir(child: string, parent: string): boolean {
  const c = norm(child);
  const p = norm(parent);
  if (c === p) return true;
  const rel = path.relative(p, c);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function preferenceRank(p: string): number {
  const lower = p.toLowerCase().replace(/\\/g, '/');
  if (IS_WINDOWS) {
    if (/\/program files( \(x86\))?\//.test(lower)) return 0;
    if (/\/nodejs\//.test(lower)) return 1;
    return 2;
  }
  if (/^\/(usr\/(local\/)?bin|bin|opt\/homebrew\/bin)\//.test(lower)) return 0;
  if (/\/node(js)?\//.test(lower) || /\/\.nvm\//.test(lower)) return 1;
  return 2;
}

function windowsCandidates(name: string): string[] {
  const safeCwd = os.homedir();
  let out = '';
  try {
    out = execFileSync(windowsSystemBin('where.exe'), [name], {
      cwd: safeCwd,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 10_000,
      env: safeChildEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return [];
  }
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && path.isAbsolute(l))
    .filter((l) => WIN_EXEC_EXTS.has(path.extname(l).toLowerCase()))
    // `where` also searches its own cwd; never accept a hit from there.
    .filter((l) => norm(path.dirname(l)) !== norm(safeCwd));
}

function posixCandidates(name: string): string[] {
  const found: string[] = [];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    // Relative PATH entries ('' or '.') resolve against the child's cwd.
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    try {
      const st = fs.statSync(candidate);
      if (!st.isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      found.push(candidate);
    } catch {
      /* not here */
    }
  }
  return found;
}

function candidates(name: string): string[] {
  let list = candidateCache.get(name);
  if (!list) {
    const raw = IS_WINDOWS ? windowsCandidates(name) : posixCandidates(name);
    // Stable sort: preferred install dirs first, PATH order within a rank.
    list = raw
      .map((p, i) => ({ p, i, r: preferenceRank(p) }))
      .sort((a, b) => a.r - b.r || a.i - b.i)
      .map((x) => x.p);
    candidateCache.set(name, list);
  }
  return list;
}

/**
 * Resolve `name` (git, npm, npx) to an absolute path that is not inside
 * `untrustedRoot`. Returns `null` when no such binary is found. Results are
 * cached per process; the filter is applied per call.
 */
export function resolveBinPath(name: string, untrustedRoot?: string): string | null {
  for (const candidate of candidates(name)) {
    if (untrustedRoot && isInsideDir(candidate, untrustedRoot)) continue;
    return candidate;
  }
  return null;
}

/**
 * Like {@link resolveBinPath} but falls back to the bare name, so callers keep
 * working (and fail honestly) when the tool is not installed at all.
 */
export function resolveBin(name: string, untrustedRoot?: string): string {
  return resolveBinPath(name, untrustedRoot) ?? name;
}

/** Clear the resolution cache (tests / after installing tools). */
export function resetBinCache(): void {
  candidateCache.clear();
}

/**
 * Environment for child processes. Always sets NoDefaultCurrentDirectoryInExePath
 * so Windows programs the child starts (cmd.exe, npm's shims) do not search
 * their cwd for executables either.
 */
export function safeChildEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...process.env, ...(extra ?? {}), NoDefaultCurrentDirectoryInExePath: '1' };
}

/** A hooks directory that can never contain hooks. */
function emptyHooksPath(): string {
  return IS_WINDOWS ? 'NUL' : '/dev/null';
}

/**
 * `-c` overrides that neutralise config a scanned repo can plant in its own
 * `.git/config`: fsmonitor (runs a command on every status/diff), hooks, and
 * the file:// transport. Pass `network: true` for fetch/clone, which also
 * restricts transports to https and ssh.
 */
export function gitSafetyArgs(opts: { network?: boolean } = {}): string[] {
  // Operators whose own remotes are local paths / shares can opt back in to the
  // file transport; it is off by default because a repo-planted remote or
  // submodule URL can point it at any repository on disk.
  const fileAllowed = process.env.OPENHUB_GIT_ALLOW_FILE_PROTOCOL === '1';
  const args = [
    '-c', 'core.fsmonitor=',
    '-c', `core.hooksPath=${emptyHooksPath()}`,
    '-c', `protocol.file.allow=${fileAllowed ? 'always' : 'never'}`,
  ];
  if (opts.network) {
    args.push(
      '-c', 'protocol.allow=never',
      '-c', 'protocol.https.allow=always',
      // ssh stays allowed so ssh remotes keep working, but a repo-planted
      // core.sshCommand is replaced with plain `ssh` (GIT_SSH_COMMAND in the
      // operator's own environment still wins).
      '-c', 'protocol.ssh.allow=always',
      '-c', 'core.sshCommand=ssh',
    );
    // protocol.allow=never overrides nothing that is set explicitly, so the
    // file opt-in above still applies to fetch/push.
  }
  return args;
}

const NETWORK_GIT_SUBCOMMANDS = new Set(['fetch', 'clone', 'pull', 'ls-remote', 'submodule', 'push']);

/** Prefix `args` with {@link gitSafetyArgs}, choosing network mode from the subcommand. */
export function hardenGitArgs(args: string[]): string[] {
  const sub = args.find((a) => !a.startsWith('-'));
  return [...gitSafetyArgs({ network: sub ? NETWORK_GIT_SUBCOMMANDS.has(sub) : false }), ...args];
}
