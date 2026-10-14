import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Guard against the "nothing works" class of bug: a component that calls an
 * `/api/...` route the server never mounted. The generic fetch mock in the
 * render sweeps cannot catch it, so this scans the source instead.
 */
describe('endpoint coverage', () => {
  it('every frontend /api call has a mounted backend route', () => {
    try {
      execFileSync(process.execPath, [path.join(root, 'scripts', 'audit-endpoints.mjs'), '--check'], {
        cwd: root,
        stdio: 'pipe',
      });
    } catch (e) {
      const out = (e as { stdout?: Buffer }).stdout?.toString() ?? '';
      throw new Error(`Unmatched frontend API calls (no backend route):\n${out}`);
    }
    expect(true).toBe(true);
  }, 60_000);
});
