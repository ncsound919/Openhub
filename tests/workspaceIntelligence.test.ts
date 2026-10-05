import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  readGitStatus,
  readGitHistory,
  collectOutdatedDependencies,
  askOllama,
} from '../src/services/workspaceIntelligence';
import { resetBinCache } from '../src/services/binResolve';

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-wsintel-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(os.tmpdir(), 'oh-wsintel-gitconfig') },
  });
}

function initRepo(files: Record<string, string> = {}): string {
  const d = tmp();
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(d, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  git(d, 'init', '-q');
  // Identity goes in the REPO config, not on the first commit's command line.
  // It used to be passed as `-c user.email=... -c user.name=...` to `commit`,
  // which only covers that one invocation: any later commit in the same repo
  // failed with exit 128 "Author identity unknown", because GIT_CONFIG_GLOBAL
  // points at a file that does not exist so there is no global identity to fall
  // back on. Measured, not guessed — the first commit succeeded and the second
  // did not, which is what pointed at the per-invocation flag.
  git(d, 'config', 'user.email', 't@t');
  git(d, 'config', 'user.name', 'Ada Lovelace');
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'initial commit');
  return d;
}

describe('readGitStatus', () => {
  it('reports a clean tree as available with an empty list', async () => {
    const d = initRepo({ 'a.txt': 'a\n' });
    const r = await readGitStatus(d);
    expect(r.available).toBe(true);
    expect(r.status).toEqual([]);
    expect(r.branch).toBeTruthy();
  });

  it('lists uncommitted paths', async () => {
    const d = initRepo({ 'a.txt': 'a\n' });
    fs.writeFileSync(path.join(d, 'b.txt'), 'b\n');
    const r = await readGitStatus(d);
    expect(r.available).toBe(true);
    expect(r.status.join(' ')).toContain('b.txt');
  });

  it('reports NOT AVAILABLE — not an empty list — for a non-repo', async () => {
    // The distinction the page depends on: `status: []` renders as "Working
    // tree clean". Returning that for a directory git cannot read would be a
    // false green, so `available: false` carries the reason instead.
    const d = tmp();
    const r = await readGitStatus(d);
    expect(r.available).toBe(false);
    expect(r.error).toMatch(/git/i);
  });

  it('reports a reason for a missing directory', async () => {
    const r = await readGitStatus(path.join(os.tmpdir(), 'oh-wsintel-does-not-exist'));
    expect(r.available).toBe(false);
    expect(r.error).toContain('does not exist');
  });
});

describe('readGitHistory', () => {
  it('returns commits with hash, message, author and time', async () => {
    const d = initRepo({ 'a.txt': 'a\n' });
    const r = await readGitHistory(d);
    expect(r.available).toBe(true);
    expect(r.history).toHaveLength(1);
    expect(r.history[0]).toMatchObject({ message: 'initial commit', author: 'Ada Lovelace' });
    expect(r.history[0].hash).toMatch(/^[0-9a-f]{7,8}$/);
  });

  it('does not split a subject containing the field separator', async () => {
    // %x1f is the delimiter precisely because commit subjects legitimately
    // contain spaces and tabs. Splitting on those corrupts the field a human
    // actually reads.
    const d = initRepo({ 'a.txt': 'a\n' });
    const subject = 'fix: handle spaces and\ttabs in subject';
    git(d, 'commit', '-q', '--allow-empty', '-m', subject);
    const r = await readGitHistory(d);
    const found = r.history.find((c) => c.message.includes('tabs'));
    expect(found).toBeTruthy();
    expect(found!.message).toBe(subject);
    expect(found!.author).toBe('Ada Lovelace');
  });

  it('honours the limit and clamps a hostile one', async () => {
    const d = initRepo({ 'a.txt': 'a\n' });
    for (let i = 0; i < 5; i++) git(d, 'commit', '-q', '--allow-empty', '-m', `commit ${i}`);
    expect((await readGitHistory(d, 3)).history).toHaveLength(3);
    // 0, negative, NaN and absurd values must not produce an unbounded log or
    // an empty one.
    for (const bad of [0, -5, Number.NaN, 1e9]) {
      const r = await readGitHistory(d, bad);
      expect(r.history.length).toBeGreaterThan(0);
      expect(r.history.length).toBeLessThanOrEqual(200);
    }
  });

  it('reports unavailable for a non-repo', async () => {
    const r = await readGitHistory(tmp());
    expect(r.available).toBe(false);
    expect(r.error).toBeTruthy();
  });
});

describe('collectOutdatedDependencies', () => {
  it('returns an empty map and NO runners for a directory with no manifest', async () => {
    // "No dependencies here" is a real answer and must not be confused with
    // "the package manager failed".
    const r = await collectOutdatedDependencies(tmp());
    expect(r.outdated).toEqual({});
    expect(r.runners).toEqual([]);
    expect(r.manifests).toEqual([]);
  });

  it('reports the manifest it found', async () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }));
    const r = await collectOutdatedDependencies(d);
    expect(r.manifests).toContain('package.json');
  });

  it('reports a dependency-free package as ANSWERED, with nothing outdated', async () => {
    // Measured, because the obvious assertion here is wrong. `npm outdated
    // --json` on a package with no dependencies exits 0 and prints `{}` — and
    // it does so even for a CORRUPT package.json. `{}` is a legitimate
    // parseable answer meaning "nothing is behind", so `runners: ['npm']` with
    // an empty map is the correct 200/"all up to date" path, not a failure.
    const d = tmp();
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }));
    const r = await collectOutdatedDependencies(d);
    expect(r.runners).toEqual(['npm']);
    expect(r.outdated).toEqual({});
    expect(r.errors).toEqual([]);
  });

  it('records a reason when the package manager cannot be reached', async () => {
    // The 503 branch the route depends on. Two things had to be measured first:
    //
    //  1. Clearing PATH alone does nothing. `resolveBin` caches each tool's
    //     absolute candidates for the life of the process
    //     (src/services/binResolve.ts:103-113), so after npm has been resolved
    //     once, mutating process.env.PATH cannot change what is spawned. The
    //     first version of this test set PATH and still saw `runners: ['npm']`.
    //  2. You cannot make npm emit unparseable output via its input. A corrupt
    //     package.json still yields `{}`.
    //
    // So: empty PATH *and* resetBinCache(). Verified in that order — with the
    // cache left warm the runner still answered.
    const d = tmp();
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }));
    const emptyBin = path.join(d, 'empty-bin');
    fs.mkdirSync(emptyBin);

    const prevPath = process.env.PATH;
    process.env.PATH = emptyBin;
    resetBinCache();
    try {
      const r = await collectOutdatedDependencies(d);
      expect(r.runners).toEqual([]);
      // The manifest WAS found, which is exactly the condition the route turns
      // into a 503 rather than a misleading "all up to date".
      expect(r.manifests).toContain('package.json');
      expect(r.errors.length).toBeGreaterThan(0);
      expect(r.errors.join(' ')).toMatch(/npm/);
    } finally {
      process.env.PATH = prevPath;
      // Leave the cache warm again for every later test in this worker.
      resetBinCache();
    }
  }, 60_000);
});

describe('askOllama', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('returns the model response', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ response: 'because' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    const r = await askOllama('why?');
    expect(r).toMatchObject({ ok: true, response: 'because' });
  });

  it('names the endpoint when Ollama is not running', async () => {
    // "fetch failed" alone cannot distinguish not-running from no-model from a
    // DNS fault. The endpoint is what makes the message actionable.
    globalThis.fetch = (async () => { throw new Error('fetch failed'); }) as typeof fetch;
    const r = await askOllama('why?');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('Ollama');
      expect(r.reason).toMatch(/127\.0\.0\.1:11434|OLLAMA/);
    }
  });

  it('explains a missing model rather than reporting a generic failure', async () => {
    globalThis.fetch = (async () => new Response('not found', { status: 404 })) as typeof fetch;
    const r = await askOllama('why?');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('ollama pull');
  });

  it('surfaces a non-404 HTTP error with its body', async () => {
    globalThis.fetch = (async () => new Response('model runner crashed', { status: 500 })) as typeof fetch;
    const r = await askOllama('why?');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('500');
  });

  it('rejects an empty prompt without calling anything', async () => {
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response('{}'); }) as typeof fetch;
    const r = await askOllama('   ');
    expect(r.ok).toBe(false);
    expect(called).toBe(false);
  });

  it('treats an empty completion as unavailable, not as an empty answer', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ response: '   ' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    const r = await askOllama('why?');
    expect(r.ok).toBe(false);
  });
});
