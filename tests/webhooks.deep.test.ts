import { describe, it, expect, afterEach, vi } from 'vitest';
import { assertOutboundUrlAllowed, fetchWithUrlGuard } from '../src/services/webhooks.js';

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENHUB_ALLOW_PRIVATE_FETCH;
  delete process.env.OPENHUB_WEBHOOK_ALLOW_PRIVATE;
});

// The outbound SSRF guard protects API Studio, the SEO audit and webhooks. These
// assert the policy AND the redirect-following semantics (method/body handling).
describe('assertOutboundUrlAllowed', () => {
  it('allows public http/https and rejects other schemes + private hosts', () => {
    expect(() => assertOutboundUrlAllowed('https://example.com/x')).not.toThrow();
    expect(() => assertOutboundUrlAllowed('http://example.com/x')).not.toThrow();
    expect(() => assertOutboundUrlAllowed('file:///etc/passwd')).toThrow();
    expect(() => assertOutboundUrlAllowed('ftp://example.com')).toThrow();
    expect(() => assertOutboundUrlAllowed('not a url')).toThrow();
    expect(() => assertOutboundUrlAllowed('http://127.0.0.1/')).toThrow();
    expect(() => assertOutboundUrlAllowed('http://169.254.169.254/latest/meta-data')).toThrow();
    expect(() => assertOutboundUrlAllowed('http://10.1.2.3/')).toThrow();
    expect(() => assertOutboundUrlAllowed('http://192.168.0.5/')).toThrow();
    expect(() => assertOutboundUrlAllowed('http://172.20.0.1/')).toThrow();
  });

  it('allows private hosts only when the operator opts in', () => {
    process.env.OPENHUB_ALLOW_PRIVATE_FETCH = '1';
    expect(() => assertOutboundUrlAllowed('http://127.0.0.1/')).not.toThrow();
  });
});

describe('fetchWithUrlGuard redirect semantics', () => {
  it('refuses an unsafe initial URL before any fetch', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    await expect(fetchWithUrlGuard('http://169.254.169.254/')).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it('re-validates every hop: a private redirect target is refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1:9/private' } })));
    await expect(fetchWithUrlGuard('https://example.com/start', {}, { label: 'test' })).rejects.toThrow(/private/i);
  });

  it('303 downgrades POST to GET and drops the body', async () => {
    const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method, body: init?.body });
      if (calls.length === 1) return new Response(null, { status: 303, headers: { Location: '/done' } });
      return new Response('ok', { status: 200 });
    }));
    const res = await fetchWithUrlGuard('https://example.com/start', { method: 'POST', body: 'payload' });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe('https://example.com/done');
    expect(calls[1].method).toBe('GET');
    expect(calls[1].body).toBeUndefined();
  });

  it('307 preserves POST and the body across the hop', async () => {
    const calls: Array<{ method?: string; body?: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      calls.push({ method: init?.method, body: init?.body });
      if (calls.length === 1) return new Response(null, { status: 307, headers: { Location: '/keep' } });
      return new Response('ok', { status: 200 });
    }));
    await fetchWithUrlGuard('https://example.com/start', { method: 'POST', body: 'payload' });
    expect(calls[1].method).toBe('POST');
    expect(calls[1].body).toBe('payload');
  });

  it('caps the number of redirects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 302, headers: { Location: '/loop' } })));
    await expect(fetchWithUrlGuard('https://example.com/start', {}, { maxRedirects: 2 })).rejects.toThrow(/redirect/i);
  });

  it('follows a safe relative redirect', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      calls.push(String(url));
      if (calls.length === 1) return new Response(null, { status: 301, headers: { Location: '/next' } });
      return new Response('ok', { status: 200 });
    }));
    const res = await fetchWithUrlGuard('https://example.com/start');
    expect(res.status).toBe(200);
    expect(calls).toEqual(['https://example.com/start', 'https://example.com/next']);
  });
});
