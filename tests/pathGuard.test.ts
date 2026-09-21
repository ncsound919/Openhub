import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { isSubpath, hasDeniedSegment, browseRoots, isBrowsable, touchesSensitiveDir } from '../src/lib/pathGuard';

describe('isSubpath (path traversal guard)', () => {
  const base = path.resolve('/repos/owner/repo');

  it('allows the base directory itself', () => {
    expect(isSubpath(base, base)).toBe(true);
  });

  it('allows files and directories inside the base', () => {
    expect(isSubpath(base, path.join(base, 'src', 'index.ts'))).toBe(true);
    expect(isSubpath(base, path.join(base, 'a', 'b', 'c.txt'))).toBe(true);
  });

  it('rejects traversal via ..', () => {
    expect(isSubpath(base, path.join(base, '..', 'other'))).toBe(false);
    expect(isSubpath(base, path.join(base, '..', '..', 'etc'))).toBe(false);
  });

  it('rejects a prefix-sibling path (the classic startsWith bug)', () => {
    expect(isSubpath('/repos/owner/repo', '/repos/owner/repo-evil')).toBe(false);
  });

  it('rejects absolute paths outside the base', () => {
    expect(isSubpath(base, path.resolve('/etc/passwd'))).toBe(false);
  });
});

describe('hasDeniedSegment (.git is not repo content)', () => {
  it('denies .git at any depth, in either separator style', () => {
    expect(hasDeniedSegment('.git/config')).toBe(true);
    expect(hasDeniedSegment('.git/hooks/post-commit')).toBe(true);
    expect(hasDeniedSegment('sub/.git/hooks/pre-push')).toBe(true);
    expect(hasDeniedSegment('sub\\.git\\config')).toBe(true);
  });

  it('denies case variants (Windows/macOS open .GIT just fine)', () => {
    expect(hasDeniedSegment('.GIT/config')).toBe(true);
    expect(hasDeniedSegment('.Git/hooks/post-commit')).toBe(true);
  });

  it('allows ordinary paths, including names that merely contain .git', () => {
    expect(hasDeniedSegment('src/index.ts')).toBe(false);
    expect(hasDeniedSegment('.gitignore')).toBe(false);
    expect(hasDeniedSegment('docs/.gitkeep')).toBe(false);
    expect(hasDeniedSegment('')).toBe(false);
  });
});

describe('browseRoots / isBrowsable (host filesystem confinement)', () => {
  const home = path.resolve('/home/alice');

  it('defaults to the home directory when unconfigured', () => {
    expect(browseRoots({} as NodeJS.ProcessEnv, home)).toEqual([home]);
  });

  it('honours an explicit root list', () => {
    const roots = browseRoots(
      { OPENHUB_BROWSE_ROOTS: ['/srv/projects', '/srv/scratch'].join(path.delimiter) } as NodeJS.ProcessEnv,
      home,
    );
    expect(roots).toEqual([path.resolve('/srv/projects'), path.resolve('/srv/scratch')]);
  });

  it('allows paths inside a root', () => {
    expect(isBrowsable(path.join(home, 'code', 'app'), [home])).toBe(true);
    expect(isBrowsable(home, [home])).toBe(true);
  });

  it('rejects anything outside every root', () => {
    expect(isBrowsable(path.resolve('/etc'), [home])).toBe(false);
    expect(isBrowsable(path.resolve('/home/bob'), [home])).toBe(false);
    expect(isBrowsable(path.join(home, '..', 'bob'), [home])).toBe(false);
  });

  it('rejects credential stores even inside an allowed root', () => {
    expect(isBrowsable(path.join(home, '.ssh'), [home])).toBe(false);
    expect(isBrowsable(path.join(home, '.aws', 'credentials'), [home])).toBe(false);
    expect(isBrowsable(path.join(home, '.gnupg'), [home])).toBe(false);
    expect(touchesSensitiveDir(path.join(home, '.kube', 'config'))).toBe(true);
  });
});

describe('isSubpath — symlink escape (the lexical guard missed these)', () => {
  let tmp: string;
  let repo: string;
  let outside: string;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openhub-guard-'));
    repo = path.join(tmp, 'repo');
    outside = path.join(tmp, 'outside');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'nope');
    fs.mkdirSync(path.join(repo, '.git', 'hooks'), { recursive: true });
    try {
      // A directory symlink inside the repo pointing out of it.
      fs.symlinkSync(outside, path.join(repo, 'escape'), 'dir');
      // ...and one pointing at .git, which names no denied segment.
      fs.symlinkSync(path.join(repo, '.git'), path.join(repo, 'docs'), 'dir');
    } catch {
      // Windows without developer mode cannot create symlinks; the tests below
      // then assert on the plain paths, which still must hold.
    }
  });

  afterAll(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  const haveSymlinks = (): boolean => {
    try { return fs.lstatSync(path.join(repo, 'escape')).isSymbolicLink(); } catch { return false; }
  };

  it('still allows genuine paths inside the repo', () => {
    expect(isSubpath(repo, path.join(repo, 'src', 'index.ts'))).toBe(true);
    expect(isSubpath(repo, repo)).toBe(true);
  });

  it('rejects a path that leaves the repo through a symlink', () => {
    if (!haveSymlinks()) return;
    expect(isSubpath(repo, path.join(repo, 'escape'))).toBe(false);
    expect(isSubpath(repo, path.join(repo, 'escape', 'secret.txt'))).toBe(false);
    // A file that does not exist yet, under the link: a write would land outside.
    expect(isSubpath(repo, path.join(repo, 'escape', 'new-file.txt'))).toBe(false);
  });

  it('rejects a .git write disguised by a symlink name', () => {
    if (!haveSymlinks()) return;
    expect(hasDeniedSegment('docs/hooks/post-commit')).toBe(false); // name alone says nothing
    expect(hasDeniedSegment('docs/hooks/post-commit', repo)).toBe(true); // where it lands does
    expect(hasDeniedSegment('src/index.ts', repo)).toBe(false);
  });

  it('rejects a credential store reached through a symlink name', () => {
    const home = path.join(tmp, 'home');
    fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
    let linked = false;
    try {
      fs.symlinkSync(path.join(home, '.ssh'), path.join(home, 'keys'), 'dir');
      linked = fs.lstatSync(path.join(home, 'keys')).isSymbolicLink();
    } catch { /* no symlink support */ }
    if (!linked) return;
    expect(touchesSensitiveDir(path.join(home, 'keys'))).toBe(true);
    expect(isBrowsable(path.join(home, 'keys'), [home])).toBe(false);
  });
});
