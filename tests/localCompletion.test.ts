import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const modelsMock = vi.fn();
vi.mock('../src/services/axiomClient', () => ({
  axiomEditorModels: () => modelsMock(),
}));

import {
  warmFimComplete,
  resolveLocalTier,
  resetLocalTierCache,
  clearLocalCompletionCache,
} from '../src/services/localCompletion';

beforeEach(() => {
  resetLocalTierCache();
  clearLocalCompletionCache();
  modelsMock.mockReset();
});

afterEach(() => vi.unstubAllGlobals());

describe('resolveLocalTier', () => {
  it('discovers the base + configured model from Axiom', async () => {
    modelsMock.mockResolvedValue({ ok: true, configured: 'minicpm', base: 'http://127.0.0.1:11434/v1' });
    expect(await resolveLocalTier()).toEqual({ base: 'http://127.0.0.1:11434/v1', model: 'minicpm' });
  });

  it('lets a per-request model override win', async () => {
    modelsMock.mockResolvedValue({ ok: true, configured: 'minicpm', base: 'http://127.0.0.1:11434/v1' });
    expect((await resolveLocalTier('picked'))?.model).toBe('picked');
  });

  it('is null when there is no configured base (so the caller proxies)', async () => {
    modelsMock.mockResolvedValue({ ok: true, configured: null, base: null, models: [] });
    expect(await resolveLocalTier()).toBeNull();
  });

  it('is null when Axiom is unreachable, without guessing a local URL', async () => {
    modelsMock.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await resolveLocalTier()).toBeNull();
  });
});

describe('warmFimComplete', () => {
  it('returns FIM text from the local model, then serves a repeat from cache', async () => {
    modelsMock.mockResolvedValue({ ok: true, configured: 'm', base: 'http://127.0.0.1:11434/v1' });
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      calls += 1;
      if (String(url).endsWith('/api/generate')) return { ok: true, json: async () => ({ response: ' return x;' }) };
      return { ok: false, status: 404, json: async () => ({}) };
    }));

    const req = { file: 'a.ts', content: 'const x = ', line: 1, column: 11 };
    const first = await warmFimComplete(req);
    expect(first).toMatchObject({ lane: 'fim', cached: false });
    expect(first?.text).toContain('return x;');
    expect(first?.modelMs).toBeGreaterThanOrEqual(0);

    const afterFirst = calls;
    const second = await warmFimComplete(req);
    expect(second).toMatchObject({ cached: true, modelMs: 0 });
    expect(calls).toBe(afterFirst);
  });

  it('returns null (caller proxies) when the tier is unconfigured', async () => {
    modelsMock.mockResolvedValue({ ok: true, configured: null, base: null });
    expect(await warmFimComplete({ file: 'a.ts', content: 'x', line: 1, column: 1 })).toBeNull();
  });

  it('returns null when the model call fails, never throwing', async () => {
    modelsMock.mockResolvedValue({ ok: true, configured: 'm', base: 'http://127.0.0.1:9/v1' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    expect(await warmFimComplete({ file: 'a.ts', content: 'const x = ', line: 1, column: 11 })).toBeNull();
  });

  it('prefetches the next cursor line so a Tab there is a cache read', async () => {
    modelsMock.mockResolvedValue({ ok: true, configured: 'm', base: 'http://127.0.0.1:11434/v1' });
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      calls += 1;
      if (String(url).endsWith('/api/generate')) return { ok: true, json: async () => ({ response: 'return a + b;' }) };
      return { ok: false, status: 404, json: async () => ({}) };
    }));
    const content = 'function add() {\n  return a + b;\n}\n';
    const firstLine = content.split('\n')[0];
    const first = await warmFimComplete({ file: 'pf.ts', content, line: 1, column: firstLine.length + 1 });
    expect(first?.cached).toBe(false);
    // The line-2 prefetch runs in the background.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const before = calls;
    const second = await warmFimComplete({ file: 'pf.ts', content, line: 2, column: 1 });
    expect(second?.cached).toBe(true);
    expect(second?.modelMs).toBe(0);
    expect(calls).toBe(before);
  });

  it('honours AXIOM_FIM_MODE=off by skipping the model entirely', async () => {
    modelsMock.mockResolvedValue({ ok: true, configured: 'm', base: 'http://127.0.0.1:11434/v1' });
    const prev = process.env.AXIOM_FIM_MODE;
    process.env.AXIOM_FIM_MODE = 'off';
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => { calls += 1; return { ok: true, json: async () => ({ response: 'x' }) }; }));
    try {
      expect(await warmFimComplete({ file: 'a.ts', content: 'const x = ', line: 1, column: 11 })).toBeNull();
      expect(calls).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.AXIOM_FIM_MODE; else process.env.AXIOM_FIM_MODE = prev;
    }
  });
});
