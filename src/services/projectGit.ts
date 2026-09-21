import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 20_000;

export interface ProjectGitState {
  branch: string | null;
  head: string | null;
  subject: string | null;
  changed: string[];
  remote: string | null;
}

function output(error: unknown): string {
  const err = error as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
  const stdout = err.stdout ? String(err.stdout) : '';
  const stderr = err.stderr ? String(err.stderr) : '';
  return `${stdout}\n${stderr}\n${err.message || ''}`.trim().slice(-MAX_OUTPUT);
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, windowsHide: true, timeout: 30_000, maxBuffer: MAX_OUTPUT });
    return stdout;
  } catch (err) {
    throw new Error(output(err) || `git ${args[0]} failed`);
  }
}

/** Read the actual repository state. No output is inferred if Git is unavailable. */
export async function readProjectGitState(cwd: string): Promise<ProjectGitState> {
  const isWorktree = (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim();
  if (isWorktree !== 'true') throw new Error('Active project is not a Git worktree');
  const [branchRaw, logRaw, statusRaw, remoteRaw] = await Promise.all([
    git(cwd, ['branch', '--show-current']),
    git(cwd, ['log', '-1', '--format=%H%n%s']),
    git(cwd, ['status', '--porcelain=v1', '--untracked-files=all']),
    git(cwd, ['remote', 'get-url', 'origin']).catch(() => ''),
  ]);
  const [head = '', subject = ''] = logRaw.trimEnd().split(/\r?\n/, 2);
  return {
    branch: branchRaw.trim() || null,
    head: head || null,
    subject: subject || null,
    changed: statusRaw.split(/\r?\n/).filter(Boolean),
    remote: remoteRaw.trim() || null,
  };
}

export interface ProjectDrift {
  available: boolean;
  fetched: boolean;
  /** True when the current branch has an upstream to compare against. */
  hasUpstream: boolean;
  branch: string | null;
  remote: string | null;
  ahead: number;
  behind: number;
  uncommitted: number;
  /** Changed files vs upstream (name-status lines), capped. */
  files: string[];
  /** Short diff stat vs upstream, e.g. "3 files changed, 41 insertions(+)". */
  stat: string | null;
  /** Upstream HEAD info (last pushed state we can see). */
  lastPush: string | null;
  reason?: string;
}

/** Compare the local project against its last pushed state (origin). Never throws fatally. */
export async function readProjectDrift(cwd: string): Promise<ProjectDrift> {
  const base: ProjectDrift = {
    available: false, fetched: false, hasUpstream: false, branch: null, remote: null,
    ahead: 0, behind: 0, uncommitted: 0, files: [], stat: null, lastPush: null,
  };
  let state: ProjectGitState;
  try {
    state = await readProjectGitState(cwd);
  } catch (err) {
    return { ...base, reason: err instanceof Error ? err.message : String(err) };
  }
  base.branch = state.branch;
  base.remote = state.remote;
  base.uncommitted = state.changed.length;
  if (!state.branch || !state.remote) {
    return { ...base, reason: !state.branch ? 'No current branch' : 'No origin remote configured' };
  }
  base.available = true;
  // Best-effort fetch; offline or auth-blocked remotes must not fail the scan.
  try {
    await execFileAsync('git', ['fetch', '--no-tags', '--prune', 'origin', state.branch], {
      cwd, windowsHide: true, timeout: 20_000, maxBuffer: MAX_OUTPUT,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    base.fetched = true;
  } catch {
    base.fetched = false;
  }
  const run = async (args: string[]): Promise<string | null> => {
    try {
      return await git(cwd, args);
    } catch {
      return null;
    }
  };
  const upstreamRef = await run(['rev-parse', '--verify', '--quiet', '@{u}']);
  base.hasUpstream = upstreamRef !== null && upstreamRef.trim() !== '';
  if (!base.hasUpstream) {
    return { ...base, reason: 'No upstream tracking branch (push to set one)' };
  }
  const counts = await run(['rev-list', '--left-right', '--count', 'HEAD...@{u}']);
  if (counts) {
    const [a, b] = counts.trim().split(/\s+/).map(Number);
    if (Number.isFinite(a)) base.ahead = a;
    if (Number.isFinite(b)) base.behind = b;
  }
  const names = await run(['diff', '--name-status', '@{u}...HEAD']);
  if (names) base.files = names.split(/\r?\n/).filter(Boolean).slice(0, 50);
  const shortstat = await run(['diff', '--shortstat', '@{u}...HEAD']);
  if (shortstat?.trim()) base.stat = shortstat.trim();
  const upstreamLog = await run(['log', '-1', '--format=%ci %s', '@{u}']);
  if (upstreamLog?.trim()) base.lastPush = upstreamLog.trim();
  return base;
}
/** Stage all project changes and create a real commit. */
export async function commitProject(cwd: string, message: string): Promise<ProjectGitState> {
  const cleanMessage = message.trim();
  // eslint-disable-next-line no-control-regex -- intentionally reject NUL/CR/LF in a commit message
  if (!cleanMessage || cleanMessage.length > 200 || /[\u0000\r\n]/.test(cleanMessage)) {
    throw new Error('Commit message must be 1–200 characters and contain no line breaks');
  }
  await git(cwd, ['add', '--all']);
  await git(cwd, ['commit', '-m', cleanMessage]);
  return readProjectGitState(cwd);
}

/** Push the current branch to its configured origin without accepting shell input. */
export async function pushProject(cwd: string): Promise<ProjectGitState> {
  const state = await readProjectGitState(cwd);
  if (!state.branch) throw new Error('Active project has no current Git branch');
  if (!state.remote) throw new Error('Active project has no origin remote configured');
  await git(cwd, ['push', '--set-upstream', 'origin', state.branch]);
  return readProjectGitState(cwd);
}

/** Working-tree vs HEAD content for one file, for inline diff review. */
export interface FileDiff {
  path: string;
  tracked: boolean;
  original: string;
  modified: string;
  patch: string;
}

export async function diffFile(cwd: string, relPath: string, cached = false): Promise<FileDiff> {
  // Normalize the separator ONCE, before the path is used for anything. The
  // previous version converted backslashes only for the git arguments and fed
  // the raw string to path.join, so on POSIX `sub\\b.txt` became a single
  // filename containing a backslash: `modified` came back empty and the diff
  // silently showed no local content. Callers pass whatever the client sent,
  // so the input separator cannot be assumed to match the host's.
  const safePath = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (safePath.includes('..') || safePath.includes('\0')) throw new Error('Unsafe diff path');
  const abs = path.join(cwd, ...safePath.split('/'));
  let original = '';
  let tracked = true;
  try {
    original = await git(cwd, ['show', `HEAD:${safePath}`]);
  } catch {
    tracked = false; // untracked / new file
  }
  const modified = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
  const patch = await git(cwd, cached ? ['diff', '--cached', '--', safePath] : ['diff', '--', safePath]);
  return { path: safePath, tracked, original, modified, patch };
}

export interface BranchList {
  current: string | null;
  branches: string[];
}

export async function listBranches(cwd: string): Promise<BranchList> {
  const [currentRaw, listRaw] = await Promise.all([
    git(cwd, ['branch', '--show-current']).catch(() => ''),
    git(cwd, ['for-each-ref', 'refs/heads', '--format=%(refname:short)']).catch(() => ''),
  ]);
  return {
    current: currentRaw.trim() || null,
    branches: listRaw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
  };
}

function assertBranchName(name: string): void {
  const value = typeof name === 'string' ? name.trim() : '';
  // A leading `-` makes git read the name as an option rather than a ref.
  if (value.startsWith('-') || value.endsWith('.lock') || value.endsWith('/')) {
    throw new Error('Invalid branch name');
  }
  if (!/^[a-zA-Z0-9._\/-]{1,120}$/.test(value) || value.includes('..') || /[\s~^:?*\[\]\\]/.test(value)) {
    throw new Error('Invalid branch name');
  }
}

export async function createBranch(cwd: string, name: string): Promise<BranchList> {
  assertBranchName(name);
  await git(cwd, ['checkout', '-b', name.trim()]);
  return listBranches(cwd);
}

export async function switchBranch(cwd: string, name: string): Promise<BranchList> {
  assertBranchName(name);
  await git(cwd, ['checkout', name.trim()]);
  return listBranches(cwd);
}

export async function deleteBranch(cwd: string, name: string): Promise<BranchList> {
  assertBranchName(name);
  const current = (await git(cwd, ['branch', '--show-current'])).trim();
  if (current === name.trim()) throw new Error('Cannot delete the current branch');
  await git(cwd, ['branch', '-d', name.trim()]);
  return listBranches(cwd);
}

const SEARCH_SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage', '.next', '.cache', 'build', 'out', 'target', '.venv', 'vendor', '__pycache__', '.idea', '.vscode', '.e2e', 'test-results']);
const SEARCH_FILE_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx', 'py', 'json', 'md', 'css', 'html', 'yaml', 'yml', 'sql', 'sh', 'rs', 'go', 'java', 'rb', 'php', 'c', 'cpp', 'h', 'hpp', 'toml', 'ini', 'env', 'xml', 'svg', 'vue', 'svelte']);

/** Bounded, ignore-aware flat file list for the editor's Quick Open. */
export async function listWorkspaceFiles(cwd: string, limit = 3000): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, rel = ''): Promise<void> => {
    if (out.length >= limit) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) return;
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SEARCH_SKIP_DIRS.has(entry.name)) continue;
        await walk(abs, relPath);
      } else if (entry.isFile()) {
        const ext = entry.name.split('.').pop()?.toLowerCase() ?? '';
        if (!SEARCH_FILE_EXTENSIONS.has(ext)) continue;
        if (entry.name.length > 120) continue;
        out.push(relPath);
      }
    }
  };
  await walk(cwd);
  return out.sort();
}

export interface SearchHit {
  file: string;
  line: number;
  text: string;
}

/**
 * Bounded, ignore-aware full-text search over a project tree.
 *
 * Async on purpose: a synchronous `readdirSync`/`readFileSync` walk ran on the
 * request path and blocked Node's event loop for the whole tree (stalling the
 * terminal socket and every other request) on each keystroke. This uses
 * `fs.promises`, honours an AbortSignal, and stops at a wall-clock budget, so a
 * query against a monorepo yields a partial result instead of freezing the app.
 */
export async function searchWorkspace(
  cwd: string,
  query: string,
  opts: { limit?: number; budgetMs?: number; signal?: AbortSignal } = {},
): Promise<SearchHit[]> {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const limit = opts.limit ?? 120;
  const deadline = Date.now() + (opts.budgetMs ?? 1500);
  const hits: SearchHit[] = [];
  const done = (): boolean => hits.length >= limit || Date.now() > deadline || opts.signal?.aborted === true;

  const walk = async (dir: string, rel = ''): Promise<void> => {
    if (done()) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (done()) return;
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
      const abs = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SEARCH_SKIP_DIRS.has(entry.name)) continue;
        await walk(abs, relPath);
      } else if (entry.isFile()) {
        const ext = entry.name.split('.').pop()?.toLowerCase() ?? '';
        if (!SEARCH_FILE_EXTENSIONS.has(ext)) continue;
        if (entry.name.length > 120) continue;
        try {
          const stat = await fsp.stat(abs);
          if (stat.size > 1_000_000) continue;
          const content = await fsp.readFile(abs, 'utf8');
          if (content.includes('\u0000')) continue;
          const lines = content.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            if (done()) return;
            const line = lines[i];
            if (line.toLowerCase().includes(needle)) {
              hits.push({ file: relPath, line: i + 1, text: line.trim().slice(0, 240) });
            }
          }
        } catch {
          /* unreadable */
        }
      }
    }
  };
  await walk(cwd);
  return hits;
}
