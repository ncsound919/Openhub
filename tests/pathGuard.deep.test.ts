import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { touchesSensitiveDir, isBrowsable, hasDeniedSegment, browseRoots, isSubpath } from '../src/lib/pathGuard.js';

// The folder browser / local import are gated by these. A miss exposes a
// credential store or the whole host filesystem.
describe('pathGuard: credential stores and containment', () => {
  it('flags single-segment credential dirs anywhere in the path', () => {
    expect(touchesSensitiveDir('/home/u/.ssh/id_rsa')).toBe(true);
    expect(touchesSensitiveDir('/home/u/.aws/credentials')).toBe(true);
    expect(touchesSensitiveDir('/home/u/.kube/config')).toBe(true);
    expect(touchesSensitiveDir('C:\\Users\\u\\.docker\\config.json')).toBe(true);
  });

  it('flags multi-segment credential stores (.config/gcloud)', () => {
    expect(touchesSensitiveDir('/home/u/.config/gcloud/application_default_credentials.json')).toBe(true);
    // A plain .config (without gcloud) is not itself a credential store.
    expect(touchesSensitiveDir('/home/u/.config/app/settings.json')).toBe(false);
  });

  it('does not flag ordinary project paths', () => {
    expect(touchesSensitiveDir('/home/u/projects/app/src/index.ts')).toBe(false);
    expect(touchesSensitiveDir(path.join(os.tmpdir(), 'repo', 'src'))).toBe(false);
  });

  it('isBrowsable: inside a root and not sensitive; rejects outside + sensitive', () => {
    const root = path.join(os.tmpdir(), 'pg-root');
    expect(isBrowsable(path.join(root, 'repo', 'src'), [root])).toBe(true);
    expect(isBrowsable(path.join(root, '..', 'elsewhere'), [root])).toBe(false);
    expect(isBrowsable(path.join(root, '.ssh'), [root])).toBe(false);
  });

  it('hasDeniedSegment blocks .git by name (case-insensitive)', () => {
    expect(hasDeniedSegment('.git/config')).toBe(true);
    expect(hasDeniedSegment('.GIT/hooks/post-commit')).toBe(true);
    expect(hasDeniedSegment('src/.git/config')).toBe(true);
    expect(hasDeniedSegment('src/a.ts')).toBe(false);
  });

  it('browseRoots defaults to home and honors OPENHUB_BROWSE_ROOTS', () => {
    expect(browseRoots({}, '/home/u')).toEqual([path.resolve('/home/u')]);
    const roots = browseRoots({ OPENHUB_BROWSE_ROOTS: ['/a', '/b'].join(path.delimiter) }, '/home/u');
    expect(roots.map((r) => path.resolve(r))).toContain(path.resolve('/a'));
  });

  it('isSubpath is not a lexical prefix match', () => {
    expect(isSubpath('/a/b', '/a/b/c')).toBe(true);
    expect(isSubpath('/a/b', '/a/b')).toBe(true);
    expect(isSubpath('/a/b', '/a/b2')).toBe(false);
  });
});
