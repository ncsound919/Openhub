import { describe, it, expect, vi, afterEach } from 'vitest';
import { authHeader, ocFetch, listSessions, abortSession } from '../src/services/opencodeClient.js';

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
  it('abortSession POSTs /session/:id/abort', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response('true', { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await abortSession('ses_abc');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/session\/ses_abc\/abort$/);
    expect((init as RequestInit).method).toBe('POST');
  });
});
