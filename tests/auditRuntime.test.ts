import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  auditCacheEnabled,
  auditCacheTtlMs,
  auditModelConfig,
  getCachedScorer,
  resetAuditCache,
  scorerCacheKey,
  setCachedScorer,
  signatureForDir,
} from '../src/services/auditRuntime';

const dirs: string[] = [];

function tmpProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhub-runtime-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, rel), content, 'utf8');
  }
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* best-effort */ }
  }
  vi.unstubAllEnvs();
  resetAuditCache();
});

describe('cache enablement', () => {
  it('is disabled unless AUDIT_CACHE_TTL_MS is positive', () => {
    vi.stubEnv('AUDIT_CACHE_TTL_MS', '');
    expect(auditCacheTtlMs()).toBe(0);
    expect(auditCacheEnabled()).toBe(false);
    vi.stubEnv('AUDIT_CACHE_TTL_MS', 'not-a-number');
    expect(auditCacheEnabled()).toBe(false);
    vi.stubEnv('AUDIT_CACHE_TTL_MS', '5000');
    expect(auditCacheEnabled()).toBe(true);
  });

  it('stores and returns results only when enabled', () => {
    const key = scorerCacheKey('deep', '/t', 'sig');
    setCachedScorer(key, { scorer: 'deep', score: 90, summary: 'x' });
    expect(getCachedScorer(key)).toBeNull();

    vi.stubEnv('AUDIT_CACHE_TTL_MS', '60000');
    setCachedScorer(key, { scorer: 'deep', score: 90, summary: 'x' });
    const hit = getCachedScorer(key);
    expect(hit).toMatchObject({ scorer: 'deep', score: 90, cached: true });
  });

  it('expires entries past the TTL and clears on reset', () => {
    vi.stubEnv('AUDIT_CACHE_TTL_MS', '1');
    const key = scorerCacheKey('lint', '/t', 'sig');
    setCachedScorer(key, { scorer: 'lint', score: 80, summary: 'x' });
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(getCachedScorer(key)).toBeNull();
        vi.stubEnv('AUDIT_CACHE_TTL_MS', '60000');
        setCachedScorer(key, { scorer: 'lint', score: 80, summary: 'x' });
        expect(getCachedScorer(key)).not.toBeNull();
        resetAuditCache();
        expect(getCachedScorer(key)).toBeNull();
        resolve();
      }, 10);
    });
  });
});

describe('signatureForDir', () => {
  it('is stable for an unchanged tree and changes when a file changes', () => {
    const dir = tmpProject({ 'a.ts': 'a', 'b.ts': 'b' });
    const first = signatureForDir(dir);
    expect(signatureForDir(dir)).toBe(first);
    fs.writeFileSync(path.join(dir, 'a.ts'), 'a-larger-content', 'utf8');
    expect(signatureForDir(dir)).not.toBe(first);
  });

  it('scopes to an explicit file list and reflects missing files', () => {
    const dir = tmpProject({ 'a.ts': 'a', 'b.ts': 'b', 'c.ts': 'c' });
    const scopedA = signatureForDir(dir, ['a.ts']);
    const scopedAB = signatureForDir(dir, ['a.ts', 'b.ts']);
    expect(scopedA).not.toBe(scopedAB);
    expect(signatureForDir(dir, ['a.ts'])).toBe(scopedA);
    expect(signatureForDir(dir, ['missing.ts'])).toMatch(/^[0-9a-f]+$/);
  });

  it('degrades for an unreadable directory', () => {
    expect(signatureForDir(path.join(os.tmpdir(), 'openhub-runtime-nope'))).toBe('unreadable');
  });
});

describe('auditModelConfig', () => {
  it('reports no pin when the environment is unset', () => {
    vi.stubEnv('AUDIT_LLM_MODEL', '');
    vi.stubEnv('AUDIT_LLM_SEED', '');
    expect(auditModelConfig()).toEqual({ model: null, seed: null, source: 'none' });
  });

  it('pins the model and seed from the environment', () => {
    vi.stubEnv('AUDIT_LLM_MODEL', 'gpt-5-pinned');
    vi.stubEnv('AUDIT_LLM_SEED', '42');
    expect(auditModelConfig()).toEqual({ model: 'gpt-5-pinned', seed: 42, source: 'env' });
  });

  it('ignores a non-numeric seed', () => {
    vi.stubEnv('AUDIT_LLM_MODEL', 'm');
    vi.stubEnv('AUDIT_LLM_SEED', 'abc');
    expect(auditModelConfig()).toMatchObject({ model: 'm', seed: null, source: 'env' });
  });
});
