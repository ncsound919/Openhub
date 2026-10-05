import { describe, it, expect, afterEach } from 'vitest';
import { axiomFetch } from '../src/services/axiomClient.js';

const prevFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = prevFetch;
});

describe('axiomFetch timeout', () => {
  it('aborts a hung Axiom call instead of hanging the stage forever', async () => {
    globalThis.fetch = ((_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      })) as unknown as typeof fetch;
    await expect(axiomFetch('/api/project/status/x', { timeoutMs: 30 })).rejects.toThrow();
  });

  it('still succeeds on a fast response', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
    await expect(axiomFetch('/api/health')).resolves.toEqual({ ok: true });
  });
});
