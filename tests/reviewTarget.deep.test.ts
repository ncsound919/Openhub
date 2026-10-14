import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  allowedRepoRoots,
  isAllowedRepoDir,
  resolveReviewTarget,
  isSafeGitRef,
  safeRepoFile,
  callerId,
  resolveScanTarget,
} from '../src/lib/reviewTarget.js';

const tmp: string[] = [];
function mk(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-'));
  tmp.push(d);
  return d;
}

const prevRoot = process.env.OPENHUB_REPOS_ROOT;
const prevExtra = process.env.OPENHUB_EXTRA_REPO_ROOTS;
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  if (prevRoot === undefined) delete process.env.OPENHUB_REPOS_ROOT; else process.env.OPENHUB_REPOS_ROOT = prevRoot;
  if (prevExtra === undefined) delete process.env.OPENHUB_EXTRA_REPO_ROOTS; else process.env.OPENHUB_EXTRA_REPO_ROOTS = prevExtra;
});

// reviewTarget is the containment funnel for every review/patch/scan route: a
// raw path.resolve here is an arbitrary filesystem read/write. These assert the
// boundary behaviour directly.
describe('reviewTarget: containment + git ref safety', () => {
  it('allows nested dirs and rejects a sibling that merely shares a prefix', () => {
    const root = mk();
    const nested = path.join(root, 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });
    const evil = `${root}-evil`;
    fs.mkdirSync(evil, { recursive: true });
    process.env.OPENHUB_REPOS_ROOT = root;
    expect(isAllowedRepoDir(nested)).toBe(true);
    expect(isAllowedRepoDir(evil)).toBe(false);
    expect(isAllowedRepoDir(root)).toBe(true);
  });

  it('honours OPENHUB_EXTRA_REPO_ROOTS (delimiter-separated)', () => {
    const primary = mk();
    const extra = mk();
    process.env.OPENHUB_REPOS_ROOT = primary;
    process.env.OPENHUB_EXTRA_REPO_ROOTS = extra;
    expect(allowedRepoRoots().map((p) => path.resolve(p))).toContain(path.resolve(extra));
    expect(isAllowedRepoDir(path.join(extra, 'x'))).toBe(true);
  });

  it('resolveReviewTarget: 409 with no active project and no target', () => {
    process.env.OPENHUB_REPOS_ROOT = mk();
    const r = resolveReviewTarget(undefined, undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
  });

  it('resolveReviewTarget: 400 bad type, 403 outside roots, 404 missing, ok when allowlisted', () => {
    const root = mk();
    process.env.OPENHUB_REPOS_ROOT = root;
    const inside = path.join(root, 'proj');
    fs.mkdirSync(inside);
    const outside = mk();

    const badType = resolveReviewTarget('u1', 123);
    expect(badType.ok).toBe(false);
    if (!badType.ok) expect(badType.status).toBe(400);

    const outsideRes = resolveReviewTarget('u1', outside);
    expect(outsideRes.ok).toBe(false);
    if (!outsideRes.ok) expect(outsideRes.status).toBe(403);

    const missing = resolveReviewTarget('u1', path.join(root, 'missing'));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.status).toBe(404);

    const ok = resolveReviewTarget('u1', inside);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.dir).toBe(path.resolve(inside));
  });

  it('isSafeGitRef rejects options, ranges, whitespace and long/typed inputs', () => {
    expect(isSafeGitRef('main')).toBe(true);
    expect(isSafeGitRef('HEAD~1')).toBe(true);
    expect(isSafeGitRef('origin/main')).toBe(true);
    expect(isSafeGitRef('--output=/tmp/x')).toBe(false);
    expect(isSafeGitRef('-x')).toBe(false);
    expect(isSafeGitRef('a..b')).toBe(false);
    expect(isSafeGitRef('a b')).toBe(false);
    expect(isSafeGitRef('')).toBe(false);
    expect(isSafeGitRef('x'.repeat(201))).toBe(false);
    expect(isSafeGitRef(123)).toBe(false);
  });

  it('safeRepoFile contains within the root and rejects traversal/NUL/empty', () => {
    const root = mk();
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'x');
    expect(safeRepoFile(root, 'src/a.ts')).toBe(path.resolve(root, 'src', 'a.ts'));
    expect(safeRepoFile(root, '../escape.ts')).toBeNull();
    expect(safeRepoFile(root, '..\\..\\escape.ts')).toBeNull();
    expect(safeRepoFile(root, 'a\0b')).toBeNull();
    expect(safeRepoFile(root, '')).toBeNull();
  });

  it('callerId reads req.user.sub; resolveScanTarget falls back to cwd and gates explicit targets', () => {
    expect(callerId({ user: { sub: 'abc' } })).toBe('abc');
    expect(callerId({})).toBeUndefined();
    expect(callerId(null)).toBeUndefined();

    process.env.OPENHUB_REPOS_ROOT = mk();
    const fallback = resolveScanTarget(undefined, '');
    expect(fallback.ok).toBe(true);
    if (fallback.ok) expect(fallback.dir).toBe(path.resolve(process.cwd()));

    const outside = resolveScanTarget('u1', mk());
    expect(outside.ok).toBe(false);
  });
});
