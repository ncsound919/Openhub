import { afterEach, describe, expect, it } from 'vitest';
import path from 'path';
import fs from 'node:fs';
import os from 'node:os';
import {
  normalizeOutput,
  probeTool,
  resetToolProbeCache,
  resolveExecutable,
  runLocalCommand,
} from '../src/services/processRunner';

afterEach(() => {
  resetToolProbeCache();
});

describe('normalizeOutput', () => {
  it('strips a BOM, normalizes CRLF and trims', () => {
    expect(normalizeOutput('\uFEFFline1\r\nline2\r\n')).toBe('line1\nline2');
    expect(normalizeOutput(null as unknown as string)).toBe('');
  });
});

describe('resolveExecutable', () => {
  it('does NOT use the target directory\'s node_modules/.bin by default', () => {
    // `cwd` is routinely a repository under review. Resolving the binary from
    // that repo let it supply its own `git`/`tsc`, turning "scan this repo"
    // into "run this repo". Local-bin resolution is now opt-in.
    expect(resolveExecutable('tsc', process.cwd())).toBe('tsc');
  });

  it('uses a project-local binary when the caller explicitly opts in', () => {
    // Build the shim rather than depending on which dev binaries happen to be
    // linked in a given checkout.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openhub-bin-'));
    try {
      const binDir = path.join(root, 'node_modules', '.bin');
      fs.mkdirSync(binDir, { recursive: true });
      const name = process.platform === 'win32' ? 'faketool.cmd' : 'faketool';
      fs.writeFileSync(path.join(binDir, name), '');
      const resolved = resolveExecutable('faketool', root, true);
      expect(resolved).toContain(path.join('node_modules', '.bin'));
      expect(resolved.toLowerCase()).toContain('faketool');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('passes through an unknown tool name (PATH lookup)', () => {
    expect(resolveExecutable('definitely-not-installed-xyz', process.cwd(), true)).toBe('definitely-not-installed-xyz');
  });

  it('passes through explicit paths untouched', () => {
    const p = path.join(process.cwd(), 'bin', 'tool.cmd');
    expect(resolveExecutable(p, process.cwd())).toBe(p);
  });
});

describe('runLocalCommand', () => {
  it('runs a successful command and captures stdout', async () => {
    const r = await runLocalCommand('node', ['-e', 'process.stdout.write("hello")'], { cwd: process.cwd(), timeoutMs: 30_000 });
    expect(r.ok).toBe(true);
    expect(r.code).toBe(0);
    expect(r.output).toContain('hello');
  });

  it('reports a non-zero exit as not-ok without throwing', async () => {
    const r = await runLocalCommand('node', ['-e', 'process.exit(7)'], { cwd: process.cwd(), timeoutMs: 30_000 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(7);
  });

  it('kills a command that exceeds its timeout', async () => {
    const r = await runLocalCommand('node', ['-e', 'setTimeout(() => {}, 10_000)'], { cwd: process.cwd(), timeoutMs: 800 });
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.durationMs).toBeLessThan(30_000);
  });
});

describe('probeTool', () => {
  it('reports an unknown tool as unavailable and caches the result', async () => {
    const first = await probeTool('definitely-not-installed-xyz', ['--version'], process.cwd(), 5_000);
    expect(first.available).toBe(false);
    const second = await probeTool('definitely-not-installed-xyz', ['--version'], process.cwd(), 5_000);
    expect(second).toBe(first); // same cached object reference
  });

  it('reports a runnable tool as available with a version line', async () => {
    const probe = await probeTool('node', ['--version'], process.cwd(), 10_000);
    expect(probe.available).toBe(true);
    expect(probe.version).toMatch(/v?\d+/);
  });
});
