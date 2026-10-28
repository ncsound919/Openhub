import { describe, it, expect, vi, afterEach } from 'vitest';
import { authHeader, ocFetch, listSessions, listPermissions, abortSession, respondPermission } from '../src/services/opencodeClient.js';

afterEach(() => vi.restoreAllMocks());

describe('opencodeClient', () => {
  it('builds a basic auth header for user opencode', () => {
    expect(authHeader('pw')).toBe('Basic ' + Buffer.from('opencode:pw').toString('base64'));
  });
  it('throws with the status on non-ok', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 502 })));
    await expect(ocFetch('/global/health')).rejects.toThrow(/502/);
  });
  it('listSessions GETs /session', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await listSessions();
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/session$/);
  });
  it('sends the project directory header verbatim, not percent-encoded', async () => {
    process.env.OPENHUB_OPENCODE_DIRECTORY = '/home/phone/repo';
    try {
      const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }));
      vi.stubGlobal('fetch', fetchMock);
      await listSessions();
      const headers = new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers);
      expect(headers.get('x-opencode-directory')).toBe('/home/phone/repo');
    } finally {
      delete process.env.OPENHUB_OPENCODE_DIRECTORY;
    }
  });
  it('listPermissions GETs /permission', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await listPermissions();
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/permission$/);
  });
  it('respondPermission falls back to the experimental root reply route on 404', async () => {
    const fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) =>
      String(url).includes('/session/')
        ? new Response('not found', { status: 404 })
        : new Response('true', { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await respondPermission('ses_1', 'per_1', 'once');
    expect(String(fetchMock.mock.calls[1][0])).toMatch(/\/permission\/per_1\/reply$/);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ reply: 'once' });
  });
  it('abortSession POSTs /session/:id/abort', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response('true', { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await abortSession('ses_abc');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/session\/ses_abc\/abort$/);
    expect((init as RequestInit).method).toBe('POST');
  });
});
