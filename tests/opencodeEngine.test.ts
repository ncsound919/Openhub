import { describe, it, expect, vi, afterEach } from 'vitest';
import { OPENCODE_BASE, buildServeArgs, parsePassword, taskkillArgs, opencodeEngineHealth } from '../src/services/opencodeEngine.js';

describe('opencodeEngine', () => {
  it('targets a dedicated loopback port', () => {
    expect(OPENCODE_BASE).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
  it('builds serve args with host and port', () => {
    expect(buildServeArgs()).toEqual(['serve', '--hostname', '127.0.0.1', '--port', String(Number(process.env.OPENCODE_PORT || '4196'))]);
  });
  it('trims a trailing newline from the password', () => {
    expect(parsePassword('secret\n')).toBe('secret');
    expect(parsePassword(undefined)).toBe('');
  });
  it('builds a Windows tree-kill command', () => {
    expect(taskkillArgs(1234)).toEqual(['/pid', '1234', '/T', '/F']);
  });
  it('health probe sends basic auth (engine 401s unauthenticated calls)', async () => {
    const fetchMock = vi.fn(async (_u: string | URL, _i?: RequestInit) => new Response('{"healthy":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect((await opencodeEngineHealth()).available).toBe(true);
    expect((fetchMock.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
  });
});
afterEach(() => vi.unstubAllGlobals());
