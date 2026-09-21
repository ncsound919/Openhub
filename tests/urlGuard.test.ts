import { describe, it, expect, afterEach, vi } from 'vitest';
import { assertOutboundUrlAllowed, fetchWithUrlGuard } from '../src/services/webhooks.js';

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENHUB_ALLOW_PRIVATE_FETCH;
  delete process.env.OPENHUB_WEBHOOK_ALLOW_PRIVATE;
});

describe('assertOutboundUrlAllowed', () => {
  it('rejects non-http(s) schemes and private/loopback hosts by default', () => {
    expect(() => assertOutboundUrlAllowed('file:///etc/passwd')).toThrow();
    expect(() => assertOutboundUrlAllowed('http://127.0.0.1/')).toThrow();
    expect(() => assertOutboundUrlAllowed('http://localhost:3000/')).toThrow();
    expect(() => assertOutboundUrlAllowed('http://169.254.169.254/latest/meta-data')).toThrow();
    expect(() => assertOutboundUrlAllowed('http://10.0.0.1/')).toThrow();
    expect(() => assertOutboundUrlAllowed('https://example.com/')).not.toThrow();
  });

  it('allows private hosts only when the operator opts in', () => {
    process.env.OPENHUB_ALLOW_PRIVATE_FETCH = '1';
    expect(() => assertOutboundUrlAllowed('http://127.0.0.1/')).not.toThrow();
  });
});

describe('fetchWithUrlGuard', () => {
  it('refuses an unsafe initial URL before any fetch', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    await expect(fetchWithUrlGuard('http://127.0.0.1/')).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses a redirect that points at a private host', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/latest/meta-data' } })),
    );
    await expect(fetchWithUrlGuard('https://example.com/start', {}, { label: 'test URL' })).rejects.toThrow(/private/i);
  });

  it('follows a safe redirect and re-validates each hop', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(String(url));
        if (calls.length === 1) return new Response(null, { status: 302, headers: { Location: '/next' } });
        return new Response('ok', { status: 200 });
      }),
    );
    const res = await fetchWithUrlGuard('https://example.com/start');
    expect(res.status).toBe(200);
    expect(calls).toEqual(['https://example.com/start', 'https://example.com/next']);
  });
});
