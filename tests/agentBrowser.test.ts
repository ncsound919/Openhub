import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  agentBrowserStatus,
  agentBrowserOpen,
  agentBrowserKey,
  agentBrowserBaseUrl,
  providerUrl,
  PROVIDER_URLS,
} from '../src/services/agentBrowser';

function okJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('agentBrowser config', () => {
  it('defaults the base URL to the fleet AgentBrowser port', () => {
    expect(agentBrowserBaseUrl({} as NodeJS.ProcessEnv)).toBe('http://127.0.0.1:3700');
  });

  it('prefers the env key over a Keywire lookup', async () => {
    vi.stubEnv('AGENTBROWSER_API_KEY', 'env-key');
    expect(await agentBrowserKey()).toBe('env-key');
  });

  it('maps provider ids to dashboard URLs', () => {
    expect(providerUrl('stripe')).toContain('stripe.com');
    expect(providerUrl('vercel')).toContain('vercel.com');
    expect(providerUrl('nope')).toBeNull();
    expect(Object.keys(PROVIDER_URLS)).toEqual(expect.arrayContaining(['stripe', 'github', 'vercel', 'supabase', 'google']));
  });
});

describe('agentBrowserStatus', () => {
  it('reports reachable when the health route answers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okJson({ status: 'ok' })));
    const r = await agentBrowserStatus();
    expect(r.available).toBe(true);
  });

  it('reports unavailable on a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const r = await agentBrowserStatus();
    expect(r.available).toBe(false);
    expect(r.error).toContain('ECONNREFUSED');
  });
});

describe('agentBrowserOpen', () => {
  it('navigates and detects an authenticated dashboard', async () => {
    vi.stubEnv('AGENTBROWSER_API_KEY', 'test-key');
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain('/api/browser-control');
      expect((init?.headers as Record<string, string>)['X-Agent-Auth']).toBe('test-key');
      const body = JSON.parse(String(init?.body));
      expect(body.action).toBe('navigate');
      return okJson({ success: true, url: body.url, contentPreview: 'All Projects Deployments Usage Settings' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const r = await agentBrowserOpen('https://vercel.com/dashboard');
    expect(r.available).toBe(true);
    expect(r.data?.authenticated).toBe(true);
    expect(r.data?.preview).toContain('Deployments');
  });

  it('flags a login page as unauthenticated', async () => {
    vi.stubEnv('AGENTBROWSER_API_KEY', 'test-key');
    vi.stubGlobal('fetch', vi.fn(async () => okJson({ success: true, contentPreview: 'Sign in to your account Email Password' })));
    const r = await agentBrowserOpen('https://dashboard.stripe.com/');
    expect(r.available).toBe(true);
    expect(r.data?.authenticated).toBe(false);
  });

  it('launches the browser then retries when it is not running', async () => {
    vi.stubEnv('AGENTBROWSER_API_KEY', 'test-key');
    let navigates = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.action === 'launch') return okJson({ success: true });
      if (body.action === 'navigate') {
        navigates += 1;
        if (navigates === 1) return new Response(JSON.stringify({ error: 'Browser not launched' }), { status: 500 });
        return okJson({ success: true, contentPreview: 'Projects' });
      }
      return okJson({});
    });
    vi.stubGlobal('fetch', fetchMock);

    const r = await agentBrowserOpen('https://supabase.com/dashboard/projects');
    expect(r.available).toBe(true);
    expect(navigates).toBe(2);
  });

  it('surfaces an honest error when no key is configured', async () => {
    vi.stubEnv('AGENTBROWSER_API_KEY', '');
    vi.stubEnv('OPENHUB_KEYWIRE_URL', 'http://127.0.0.1:1');
    const r = await agentBrowserOpen('https://vercel.com/dashboard');
    expect(r.available).toBe(false);
    expect(r.error).toMatch(/AGENTBROWSER_API_KEY|no secret source/i);
  });
});
