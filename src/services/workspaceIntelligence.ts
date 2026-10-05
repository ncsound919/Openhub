/**
 * Workspace Intelligence — the data behind src/pages/WorkspaceIntelligence.tsx.
 *
 * ── Why this file exists ──
 * That page was written and never mounted, and it called five `/api/workspace/*`
 * endpoints that were never implemented. Every fetch sat in a `try` with an
 * `if (res.ok)` guard, so the page rendered an empty shell and nothing ever
 * failed visibly — and `tests/endpointCoverage.test.ts` had been failing ever
 * since, reporting "unmatched frontend API calls". Two dead ends were available:
 * delete the page, or make it real. This is the second.
 *
 * ── Reuse over reinvention ──
 *   - git status      → `readProjectGitState` (projectGit.ts), already the
 *                       canonical reader, already hardened (`hardenGitArgs`,
 *                       `safeChildEnv`, resolved git binary).
 *   - git history     → same module's git invocation style.
 *   - outdated deps   → `collectOutdatedDependencies`, extracted from
 *                       `runDepsFreshnessScorer` so `npm outdated --json` has ONE
 *                       implementation. Two call sites would drift, and a
 *                       dependency count that differs between the audit and the
 *                       dashboard is worse than either.
 *   - hygiene         → NOT here. `/api/workspace/deploy-readiness` already
 *                       serves `{ score, checks[] }` from `getDeployReadiness`.
 *                       The page is repointed at it rather than a fifth route
 *                       being added that duplicates it.
 *
 * ── The honesty rule, applied throughout ──
 * Every function reports what it could not do. A missing git binary, an absent
 * Ollama, or a project with no manifest returns a reason — never an empty array
 * that renders as "all clean". That distinction is the whole reason this page
 * was worth wiring up rather than deleting: an empty list and a real "clean"
 * look identical on screen and mean opposite things.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readProjectGitState } from './projectGit.js';
import { runLocalCommand } from './processRunner.js';

export interface GitStatusResult {
  /** Uncommitted paths, in porcelain form (`XY path`). */
  status: string[];
  branch: string | null;
  head: string | null;
  /** Null when the directory is not a git worktree — not an empty status. */
  available: boolean;
  error?: string;
}

export interface CommitEntry {
  hash: string;
  message: string;
  author: string;
  time: string;
}

export interface GitHistoryResult {
  history: CommitEntry[];
  available: boolean;
  error?: string;
}

/**
 * Uncommitted changes for a project directory.
 *
 * `readProjectGitState` already returns `changed`, so this is a thin adapter
 * rather than a second git invocation.
 */
export async function readGitStatus(projectDir: string): Promise<GitStatusResult> {
  if (!fs.existsSync(projectDir)) {
    return { status: [], branch: null, head: null, available: false, error: `project dir does not exist: ${projectDir}` };
  }
  try {
    const state = await readProjectGitState(projectDir);
    // A null branch means git could not answer. Reporting `status: []` for that
    // would render as "Working tree clean", which is the opposite of the truth.
    if (state.branch === null) {
      return { status: [], branch: null, head: null, available: false, error: 'not a git worktree, or git is unavailable' };
    }
    return { status: state.changed ?? [], branch: state.branch, head: state.head, available: true };
  } catch (err) {
    return { status: [], branch: null, head: null, available: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Cap on commits returned. The page renders a scroll list, not a full log. */
const MAX_HISTORY = 30;

const GIT_LOG_FORMAT = '%H%x1f%an%x1f%aI%x1f%s';
const FIELD_SEP = '\u001f';

/**
 * Recent commits. `%x1f` (unit separator) as the field delimiter rather than a
 * space or tab: commit subjects and author names legitimately contain both, and
 * splitting on them corrupts the message — which is the field a human reads.
 */
export async function readGitHistory(projectDir: string, limit = MAX_HISTORY): Promise<GitHistoryResult> {
  if (!fs.existsSync(projectDir)) {
    return { history: [], available: false, error: `project dir does not exist: ${projectDir}` };
  }
  const capped = Math.max(1, Math.min(200, Math.trunc(limit) || MAX_HISTORY));
  const run = await runLocalCommand(
    'git',
    ['log', '-n', String(capped), '--format=' + GIT_LOG_FORMAT],
    { cwd: projectDir, timeoutMs: 20_000 },
  );
  if (!run.ok) {
    const notRepo = /not a git repository|does not appear to be a git repository/i.test(run.output);
    return {
      history: [],
      available: false,
      error: notRepo ? 'not a git worktree' : (run.output.trim().slice(-200) || `git log exited ${run.code}`),
    };
  }
  const history: CommitEntry[] = [];
  for (const line of run.output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [hash, author, time, message] = line.split(FIELD_SEP);
    if (!hash) continue;
    history.push({
      hash: String(hash).slice(0, 8),
      message: String(message ?? ''),
      author: String(author ?? ''),
      time: String(time ?? ''),
    });
  }
  return { history, available: true };
}

export interface OutdatedPackage {
  current: string;
  latest: string;
  /** True when the major version differs — the interesting upgrades. */
  major: boolean;
  manifest: string;
}

export interface OutdatedDepsResult {
  /** Package name → version info. Empty when nothing was examined. */
  outdated: Record<string, OutdatedPackage>;
  /** Which package managers actually answered (`npm`, `pip`). */
  runners: string[];
  /** Per-manager failure reasons, for the case where nothing answered. */
  errors: string[];
  /** Manifests that were present. Lets a caller say "no manifest here". */
  manifests: string[];
}

function isMajorBump(current: string, latest: string): boolean {
  return String(latest).split('.')[0] !== String(current).split('.')[0];
}

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Outdated dependencies for a project, from npm and/or pip.
 *
 * Single source of truth for `npm outdated --json` and `pip list --outdated`.
 * `runDepsFreshnessScorer` builds its findings from this rather than shelling
 * out a second time — the audit and this dashboard must not disagree about how
 * many dependencies are behind.
 *
 * Never throws. A manager that is missing, slow or unparseable contributes an
 * entry to `errors` and nothing else, because a dashboard that throws on a
 * missing pip is a dashboard nobody uses.
 */
export async function collectOutdatedDependencies(targetDir: string): Promise<OutdatedDepsResult> {
  const outdated: Record<string, OutdatedPackage> = {};
  const runners: string[] = [];
  const errors: string[] = [];
  const manifests: string[] = [];

  const npmManifest = path.join(targetDir, 'package.json');
  if (fs.existsSync(npmManifest)) {
    manifests.push('package.json');
    const run = await runLocalCommand('npm', ['outdated', '--json'], { cwd: targetDir, timeoutMs: 120_000 });
    const parsed = parseJson<Record<string, { current?: string; latest?: string; wanted?: string }>>(run.output);
    if (parsed) {
      // `npm outdated` exits 1 when packages ARE outdated, so a non-zero exit
      // with parseable JSON is a success, not a failure. Keying off run.ok here
      // would report "no outdated deps" on exactly the repos that have some.
      runners.push('npm');
      for (const [name, info] of Object.entries(parsed)) {
        const current = info.current ?? '?';
        const latest = info.latest ?? info.wanted ?? '?';
        outdated[name] = { current, latest, major: isMajorBump(current, latest), manifest: 'package.json' };
      }
    } else {
      errors.push(`npm outdated produced no parseable JSON${run.timedOut ? ' (timed out)' : ''}`);
    }
  }

  const pyManifest = ['pyproject.toml', 'requirements.txt', 'setup.py']
    .find((f) => fs.existsSync(path.join(targetDir, f)));
  if (pyManifest) {
    manifests.push(pyManifest);
    const run = await runLocalCommand('pip', ['list', '--outdated', '--format=json'], { cwd: targetDir, timeoutMs: 120_000 });
    const parsed = parseJson<Array<{ name?: string; version?: string; latest_version?: string }>>(run.output);
    if (parsed) {
      runners.push('pip');
      for (const pkg of parsed) {
        if (!pkg?.name) continue;
        const current = pkg.version ?? '?';
        const latest = pkg.latest_version ?? '?';
        outdated[pkg.name] = { current, latest, major: isMajorBump(current, latest), manifest: pyManifest };
      }
    } else {
      errors.push(`pip list --outdated produced no parseable JSON${run.timedOut ? ' (timed out)' : ''}`);
    }
  }

  return { outdated, runners, errors, manifests };
}

// ---------------------------------------------------------------------------
// Ollama — an OPTIONAL local model. Absent is the normal case and is reported
// as such, not as an error the user has to interpret.
// ---------------------------------------------------------------------------

export const OLLAMA_URL = (process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'llama3.2';

export interface OllamaResult {
  response: string;
  model: string;
}

/**
 * Ask the local Ollama server to answer `prompt`.
 *
 * Returns a discriminated result rather than throwing: `unavailable` with a
 * reason is the expected outcome when Ollama is not installed or not running,
 * and the page renders that sentence. A thrown error would surface as
 * "[ERROR] fetch failed", which tells the user nothing about which of the
 * several things that can be wrong actually is.
 *
 * The endpoint is fixed, not caller-supplied. A prompt field is user input;
 * allowing it to carry a URL would make this an SSRF primitive, and the fixed
 * constant means the ssrfGuard is not even needed here.
 */
export async function askOllama(
  prompt: string,
  opts: { model?: string; timeoutMs?: number } = {},
): Promise<
  | { ok: true; response: string; model: string }
  | { ok: false; reason: string }
> {
  const text = String(prompt ?? '').trim();
  if (!text) return { ok: false, reason: 'prompt is empty' };

  const model = opts.model ?? OLLAMA_MODEL;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  let res: Response;
  try {
    res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: text, stream: false }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    // Name the endpoint. "fetch failed" alone cannot distinguish "Ollama is not
    // running" from "the model is not pulled" from a DNS or TLS problem.
    return { ok: false, reason: `cannot reach Ollama at ${OLLAMA_URL} (${raw})` };
  }

  if (res.status === 404) {
    return { ok: false, reason: `Ollama is running but has no model "${model}". Pull it with: ollama pull ${model}` };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, reason: `Ollama returned HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}` };
  }

  const json = parseJson<{ response?: string }>(await res.text().catch(() => ''));
  if (!json || typeof json.response !== 'string' || !json.response.trim()) {
    return { ok: false, reason: `Ollama returned no text for model "${model}"` };
  }
  return { ok: true, response: json.response, model };
}
