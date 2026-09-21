import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  commitProject,
  createBranch,
  deleteBranch,
  diffFile,
  listBranches,
  pushProject,
  readProjectDrift,
  readProjectGitState,
  searchWorkspace,
  switchBranch,
} from '../src/services/projectGit';

// Skip the whole file honestly when Git is not on PATH.
const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const itGit = hasGit ? it : it.skip;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function initRepo(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(dir, ['init', '--initial-branch=main']);
  git(dir, ['config', 'user.name', 'OpenHub Coverage']);
  git(dir, ['config', 'user.email', 'openhub-coverage@example.test']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# Initial\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-m', 'Initial commit']);
  return dir;
}

function initBare(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(dir, ['init', '--bare']);
  return dir;
}

describe('projectGit coverage', () => {
  const dirs: string[] = [];

  const make = (prefix: string, bare = false): string => {
    const dir = bare ? initBare(prefix) : initRepo(prefix);
    dirs.push(dir);
    return dir;
  };

  const plainDir = (prefix: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  };

  afterEach(() => {
    while (dirs.length) {
      const d = dirs.pop()!;
      try {
        fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        /* best-effort cleanup on Windows */
      }
    }
  });

  itGit('rejects state reads outside a worktree and reports drift unavailable', async () => {
    const plain = plainDir('openhub-git-plain-');
    await expect(readProjectGitState(plain)).rejects.toThrow();
    const drift = await readProjectDrift(plain);
    expect(drift.available).toBe(false);
    expect(drift.reason).toBeTruthy();
  });

  itGit('reports no origin remote when the repo has no remote configured', async () => {
    const repo = make('openhub-git-noremote-');
    const drift = await readProjectDrift(repo);
    expect(drift.available).toBe(false);
    expect(drift.branch).toBe('main');
    expect(drift.remote).toBeNull();
    expect(drift.reason).toBe('No origin remote configured');
  });

  itGit('reports a missing upstream when origin exists but nothing is tracked', async () => {
    const bare = make('openhub-git-bare-', true);
    const repo = make('openhub-git-noupstream-');
    git(repo, ['remote', 'add', 'origin', bare]);
    const drift = await readProjectDrift(repo);
    expect(drift.branch).toBe('main');
    expect(drift.remote).toBe(bare);
    expect(drift.hasUpstream).toBe(false);
    expect(drift.reason).toContain('No upstream tracking branch');
  });

  itGit('computes ahead/behind, changed files, stat and last push against origin', async () => {
    const bare = make('openhub-git-origin-', true);
    const repo = make('openhub-git-drift-');
    git(repo, ['remote', 'add', 'origin', bare]);
    git(repo, ['push', '--set-upstream', 'origin', 'main']);

    const clean = await readProjectDrift(repo);
    expect(clean.available).toBe(true);
    expect(clean.fetched).toBe(true);
    expect(clean.hasUpstream).toBe(true);
    expect(clean.ahead).toBe(0);
    expect(clean.behind).toBe(0);
    expect(clean.files).toEqual([]);
    expect(clean.lastPush).toBeTruthy();

    fs.writeFileSync(path.join(repo, 'feature.ts'), 'export const a = 1;\n');
    git(repo, ['add', 'feature.ts']);
    git(repo, ['commit', '-m', 'Add feature']);
    fs.writeFileSync(path.join(repo, 'scratch.txt'), 'wip\n');

    const ahead = await readProjectDrift(repo);
    expect(ahead.ahead).toBe(1);
    expect(ahead.uncommitted).toBe(1);
    expect(ahead.files.join('\n')).toContain('feature.ts');
    expect(ahead.stat).toMatch(/file changed/);

    // Push, then rewind local one commit so the branch is behind origin.
    git(repo, ['push', 'origin', 'main']);
    git(repo, ['reset', '--hard', 'HEAD~1']);
    const behind = await readProjectDrift(repo);
    expect(behind.behind).toBe(1);
  }, 60_000);

  itGit('pushes the current branch and clears the ahead count', async () => {
    const bare = make('openhub-git-pushorigin-', true);
    const repo = make('openhub-git-push-');
    git(repo, ['remote', 'add', 'origin', bare]);
    git(repo, ['push', '--set-upstream', 'origin', 'main']);
    fs.writeFileSync(path.join(repo, 'more.ts'), 'export const c = 3;\n');
    await commitProject(repo, 'More work');
    const before = await readProjectDrift(repo);
    expect(before.ahead).toBe(1);
    const pushed = await pushProject(repo);
    expect(pushed.branch).toBe('main');
    const after = await readProjectDrift(repo);
    expect(after.ahead).toBe(0);
  }, 60_000);

  itGit('refuses to push without a branch or a remote', async () => {
    const detached = make('openhub-git-detach-');
    fs.writeFileSync(path.join(detached, 'x.ts'), 'export const x = 1;\n');
    git(detached, ['add', 'x.ts']);
    git(detached, ['commit', '-m', 'x']);
    git(detached, ['checkout', '--detach']);
    await expect(pushProject(detached)).rejects.toThrow('no current Git branch');

    const noRemote = make('openhub-git-pushnoremote-');
    await expect(pushProject(noRemote)).rejects.toThrow('no origin remote');
  }, 60_000);

  itGit('validates commit message length and control characters', async () => {
    const repo = make('openhub-git-msg-');
    await expect(commitProject(repo, 'x'.repeat(201))).rejects.toThrow('1–200');
    await expect(commitProject(repo, 'bad\u0000name')).rejects.toThrow('line breaks');
    await expect(commitProject(repo, '   ')).rejects.toThrow('1–200');
  });

  itGit('diffs a cached change and normalizes backslash paths', async () => {
    const repo = make('openhub-git-diff-');
    fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'sub', 'b.txt'), 'one\n');
    git(repo, ['add', 'sub/b.txt']);
    git(repo, ['commit', '-m', 'Add sub file']);
    fs.writeFileSync(path.join(repo, 'sub', 'b.txt'), 'two\n');
    git(repo, ['add', 'sub/b.txt']);

    const cached = await diffFile(repo, 'sub\\b.txt', true);
    expect(cached.tracked).toBe(true);
    expect(cached.original).toBe('one\n');
    expect(cached.modified).toBe('two\n');
    expect(cached.patch).toContain('b.txt');
  });

  itGit('rejects invalid branch names and refuses to delete the current branch', async () => {
    const repo = make('openhub-git-branches-');
    await expect(createBranch(repo, 'bad name')).rejects.toThrow('Invalid branch name');
    await expect(createBranch(repo, '')).rejects.toThrow('Invalid branch name');
    await expect(createBranch(repo, 'x'.repeat(121))).rejects.toThrow('Invalid branch name');
    await expect(switchBranch(repo, 'a..b')).rejects.toThrow('Invalid branch name');
    await expect(deleteBranch(repo, 'bad~name')).rejects.toThrow('Invalid branch name');
    await expect(deleteBranch(repo, 'main')).rejects.toThrow('Cannot delete the current branch');

    await createBranch(repo, 'feature/y');
    const switched = await switchBranch(repo, 'feature/y');
    expect(switched.current).toBe('feature/y');
  });

  itGit('returns an empty branch list outside a worktree', async () => {
    const plain = plainDir('openhub-git-nobranches-');
    const list = await listBranches(plain);
    expect(list.current).toBeNull();
    expect(list.branches).toEqual([]);
  }, 60_000);

  it('searches the workspace while honoring skip rules, size and extension caps', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'openhub-git-search-'));
    dirs.push(ws);
    fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
    fs.mkdirSync(path.join(ws, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'src', 'app.ts'), 'const token = findme;\nsecond findme\n');
    fs.writeFileSync(path.join(ws, 'node_modules', 'junk.ts'), 'findme\n');
    fs.writeFileSync(path.join(ws, '.hidden.ts'), 'findme\n');
    fs.writeFileSync(path.join(ws, 'logo.png'), 'findme\n');
    fs.writeFileSync(path.join(ws, 'big.ts'), 'a'.repeat(1_000_001));
    fs.writeFileSync(path.join(ws, 'nul.ts'), 'x\u0000findme');
    fs.writeFileSync(path.join(ws, `${'a'.repeat(130)}.ts`), 'findme\n');

    expect(await searchWorkspace(ws, '   ')).toEqual([]);
    const hits = await searchWorkspace(ws, 'findme');
    expect(hits.length).toBe(2);
    expect(hits.every((h) => h.file === 'src/app.ts')).toBe(true);
    expect(hits[0].line).toBe(1);
    expect(await searchWorkspace(ws, 'findme', { limit: 1 })).toHaveLength(1);
    expect(await searchWorkspace(path.join(ws, 'missing'), 'findme')).toEqual([]);
  });

  it('caps long search hit text at 240 characters', async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'openhub-git-longline-'));
    dirs.push(ws);
    fs.writeFileSync(path.join(ws, 'long.ts'), `needle ${'z'.repeat(400)}\n`);
    const hits = await searchWorkspace(ws, 'needle');
    expect(hits).toHaveLength(1);
    expect(hits[0].text.length).toBeLessThanOrEqual(240);
  });
});
