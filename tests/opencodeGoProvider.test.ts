import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenCodeGoProvider } from '../orchestrator/models/providers.js';

afterEach(() => { vi.unstubAllGlobals(); delete process.env.OPENCODE_API_KEY; });

describe('OpenCodeGoProvider', () => {
  it('calls the documented OpenCode Go endpoint, not api.opencode.com', async () => {
    const fetchMock = vi.fn(async (_u: string | URL, _i?: RequestInit) =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const p = new OpenCodeGoProvider('deepseek-v4-flash', { tier: 'fast', apiKey: 'k' });
    await p.call([{ role: 'user', content: 'x' }] as never);
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://opencode.ai/zen/go/v1/chat/completions');
  });
  it('never sends a request without a key', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const p = new OpenCodeGoProvider('m', { tier: 'fast' });
    await expect(p.call([] as never)).rejects.toThrow(/OPENCODE_API_KEY/);
    expect(await p.healthCheck()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
