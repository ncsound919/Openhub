import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  gitSafetyArgs,
  hardenGitArgs,
  isInsideDir,
  resetBinCache,
  resolveBin,
  resolveBinPath,
  safeChildEnv,
} from '../src/services/binResolve';
import { runLocalCommand } from '../src/services/processRunner';

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const itGit = hasGit ? it : it.skip;

const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

afterEach(() => {
  resetBinCache();
  for (const d of dirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      /* best effort */
    }
  }
});

describe('binResolve', () => {
  it('safeChildEnv keeps the environment and disables cwd exe search', () => {
    const env = safeChildEnv({ FOO_X: 'bar' });
    expect(env.FOO_X).toBe('bar');
    expect(env.NoDefaultCurrentDirectoryInExePath).toBe('1');
    expect(env.PATH ?? env.Path).toBe(process.env.PATH ?? process.env.Path);
  });

  it('isInsideDir is containment, not a string prefix', () => {
    const base = path.resolve('/repos/a/repo');
    expect(isInsideDir(path.join(base, 'git.exe'), base)).toBe(true);
    expect(isInsideDir(base, base)).toBe(true);
    expect(isInsideDir(path.resolve('/repos/a/repo-evil/git.exe'), base)).toBe(false);
  });

  it('gitSafetyArgs neutralises fsmonitor, hooks and the file transport', () => {
    const local = gitSafetyArgs().join(' ');
    expect(local).toContain('core.fsmonitor=');
    expect(local).toContain('core.hooksPath=');
    expect(local).toContain('protocol.file.allow=never');
    expect(local).not.toContain('protocol.allow=never');
    const net = hardenGitArgs(['fetch', 'origin']).join(' ');
    expect(net).toContain('protocol.allow=never');
    expect(net).toContain('protocol.https.allow=always');
    expect(hardenGitArgs(['status']).slice(-1)).toEqual(['status']);
  });

  itGit('resolves git to an absolute path outside the target repo', () => {
    const repo = tmp('openhub-binres-');
    const resolved = resolveBinPath('git', repo);
    expect(resolved).not.toBeNull();
    expect(path.isAbsolute(resolved!)).toBe(true);
    expect(isInsideDir(resolved!, repo)).toBe(false);
  });

  it('never returns a candidate inside the untrusted root', () => {
    const found = resolveBinPath('git');
    if (!found) return; // git not installed: nothing to filter
    expect(resolveBinPath('git', path.dirname(found))).not.toBe(found);
    expect(resolveBin('definitely-not-a-real-tool-xyz')).toBe('definitely-not-a-real-tool-xyz');
  });

  itGit('a repo-planted core.fsmonitor does not run through runLocalCommand', async () => {
    const repo = tmp('openhub-fsmon-');
    const marker = path.join(tmp('openhub-fsmon-marker-'), 'ran').replace(/\\/g, '/');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
    const hook = `node -e "require('fs').writeFileSync('${marker}','x')"`;
    execFileSync('git', ['config', 'core.fsmonitor', hook], { cwd: repo });

    const r = await runLocalCommand('git', ['status', '--porcelain'], { cwd: repo, timeoutMs: 30_000, noReceipt: true });
    expect(r.output).toContain('a.txt');
    expect(fs.existsSync(marker)).toBe(false);

    // Control: plain git does run it, so the assertion above is meaningful.
    try {
      execFileSync('git', ['status', '--porcelain'], { cwd: repo, stdio: 'ignore' });
    } catch {
      /* the hook's output is not a valid fsmonitor reply; git may complain */
    }
    expect(fs.existsSync(marker)).toBe(true);
  });
});

describe('runLocalCommand tree kill', () => {
  it('kills grandchildren when the timeout fires', async () => {
    const marker = path.join(tmp('openhub-treekill-'), 'survived');
    const grandchild = `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'), 2500)`;
    const parent = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' }); setTimeout(() => {}, 60000)`;
    const r = await runLocalCommand('node', ['-e', parent], { cwd: process.cwd(), timeoutMs: 1000, noReceipt: true });
    expect(r.timedOut).toBe(true);
    await new Promise((res) => setTimeout(res, 3500));
    expect(fs.existsSync(marker)).toBe(false);
  }, 20_000);
});
