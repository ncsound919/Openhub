import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  commitProject,
  readProjectGitState,
  diffFile,
  listBranches,
  createBranch,
  switchBranch,
  deleteBranch,
  searchWorkspace,
} from '../src/services/projectGit';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('projectGit', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'openhub-project-git-'));
    git(root, ['init', '--initial-branch=main']);
    git(root, ['config', 'user.name', 'OpenHub Test']);
    git(root, ['config', 'user.email', 'openhub-test@example.test']);
    fs.writeFileSync(path.join(root, 'README.md'), '# Initial\n');
    git(root, ['add', 'README.md']);
    git(root, ['commit', '-m', 'Initial commit']);
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('reports actual worktree state and commits staged project changes', async () => {
    const initial = await readProjectGitState(root);
    expect(initial.branch).toBe('main');
    expect(initial.changed).toEqual([]);
    expect(initial.head).toMatch(/^[0-9a-f]{40}$/);

    fs.writeFileSync(path.join(root, 'README.md'), '# Updated\n');
    const dirty = await readProjectGitState(root);
    expect(dirty.changed).toEqual([' M README.md']);

    const committed = await commitProject(root, 'Update README');
    expect(committed.subject).toBe('Update README');
    expect(committed.changed).toEqual([]);
    expect(git(root, ['log', '-1', '--format=%s'])).toBe('Update README');
  });

  it('rejects unsafe or empty commit messages before invoking Git', async () => {
    await expect(commitProject(root, '')).rejects.toThrow('Commit message must be');
    await expect(commitProject(root, 'first line\nsecond line')).rejects.toThrow('Commit message must be');
  });

  it('diffs a changed file against HEAD (original + modified)', async () => {
    fs.writeFileSync(path.join(root, 'README.md'), '# Updated\nMore lines here.\n');
    const diff = await diffFile(root, 'README.md');
    expect(diff.tracked).toBe(true);
    expect(diff.original).toContain('# Initial');
    expect(diff.modified).toContain('# Updated');
    expect(diff.patch).toContain('README.md');

    // Untracked file: original is empty.
    fs.writeFileSync(path.join(root, 'notes.txt'), 'fresh\n');
    const untracked = await diffFile(root, 'notes.txt');
    expect(untracked.tracked).toBe(false);
    expect(untracked.original).toBe('');
    expect(untracked.modified).toBe('fresh\n');
  });

  it('rejects unsafe diff paths', async () => {
    await expect(diffFile(root, '../escape.txt')).rejects.toThrow('Unsafe');
  });

  it('lists, creates, switches, and deletes branches', async () => {
    const initial = await listBranches(root);
    expect(initial.current).toBe('main');
    expect(initial.branches).toContain('main');

    const created = await createBranch(root, 'feature-x');
    expect(created.current).toBe('feature-x');

    const switched = await switchBranch(root, 'main');
    expect(switched.current).toBe('main');

    await expect(deleteBranch(root, 'feature-x')).resolves.toBeTruthy();
    const after = await listBranches(root);
    expect(after.branches).not.toContain('feature-x');
  });

  it('rejects invalid branch names', async () => {
    await expect(createBranch(root, 'bad name')).rejects.toThrow('Invalid branch name');
    await expect(createBranch(root, 'a..b')).rejects.toThrow('Invalid branch name');
  });

  it('searches the workspace while skipping junk directories', async () => {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'app.ts'), "const token = 'findme';\n");
    fs.writeFileSync(path.join(root, 'node_modules', 'junk.js'), "const token = 'findme';\n");

    const hits = await searchWorkspace(root, 'findme');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.file === 'src/app.ts')).toBe(true);
    expect(hits.some((h) => h.file.includes('node_modules'))).toBe(false);
    expect(hits[0].line).toBe(1);
  });
});
