import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runCmakeScorer } from '../src/services/auditSuite';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-cmake-'));
}

describe('cmake scorer (G4)', () => {
  it('is an honest no-op on a non-CMake tree (excluded, never a zero)', async () => {
    const dir = tmp();
    try {
      const r = await runCmakeScorer(dir);
      expect(r.scorer).toBe('cmake');
      expect(r.score).toBeNull();
      expect(String(r.summary) + String(r.error)).toMatch(/CMakeLists/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects CMakeLists.txt and reports an honest failure when cmake is unavailable', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.10)\nproject(noop)\n');
    const prev = process.env.AXIOM_CMAKE_CMD;
    process.env.AXIOM_CMAKE_CMD = path.join(dir, 'definitely-not-a-cmake-binary');
    try {
      const r = await runCmakeScorer(dir);
      expect(r.scorer).toBe('cmake');
      // The CMakeLists.txt was detected, so configure ran and failed honestly —
      // never a fabricated pass, and never an excluded null.
      expect(r.score).toBe(0);
      expect(String(r.summary)).toMatch(/FAILED/);
    } finally {
      if (prev === undefined) delete process.env.AXIOM_CMAKE_CMD; else process.env.AXIOM_CMAKE_CMD = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
