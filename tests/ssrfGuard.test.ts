import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  isBlockedAddress,
  isMetadataHost,
  resolvePinnedAddress,
  guardedFetch,
  __setSsrfTestHooks,
} from '../src/services/ssrfGuard.js';

afterEach(() => {
  __setSsrfTestHooks({});
  vi.unstubAllGlobals();
  delete process.env.OPENHUB_ALLOW_PRIVATE_URLS;
});

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '100.127.255.254', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '::', '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1',
    '::ffff:8.8.8.8', '64:ff9b::a00:1', '[::1]', 'fec0::1',
  ])('blocks %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '93.184.215.14', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111'])('allows %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe('isMetadataHost', () => {
  it('recognizes metadata names and IPs', () => {
    expect(isMetadataHost('metadata.google.internal')).toBe(true);
    expect(isMetadataHost('METADATA.google.internal.')).toBe(true);
    expect(isMetadataHost('169.254.169.254')).toBe(true);
    expect(isMetadataHost('example.com')).toBe(false);
  });
});

describe('resolvePinnedAddress', () => {
  it('rejects a name that resolves to loopback (DNS rebinding style)', async () => {
    __setSsrfTestHooks({ lookup: async () => [{ address: '127.0.0.1', family: 4 }] });
    await expect(resolvePinnedAddress('evil.example')).rejects.toThrow(/private/i);
  });

  it('rejects when ANY answer is private', async () => {
    __setSsrfTestHooks({ lookup: async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.5', family: 4 }] });
    await expect(resolvePinnedAddress('mixed.example')).rejects.toThrow(/private/i);
  });

  it('returns the vetted address for a public name', async () => {
    __setSsrfTestHooks({ lookup: async () => [{ address: '8.8.8.8', family: 4 }] });
    await expect(resolvePinnedAddress('dns.example')).resolves.toEqual({ address: '8.8.8.8', family: 4 });
  });

  it('allows loopback only with OPENHUB_ALLOW_PRIVATE_URLS=1, but never metadata', async () => {
    process.env.OPENHUB_ALLOW_PRIVATE_URLS = '1';
    __setSsrfTestHooks({ lookup: async () => [{ address: '127.0.0.1', family: 4 }] });
    await expect(resolvePinnedAddress('localhost')).resolves.toMatchObject({ address: '127.0.0.1' });
    await expect(resolvePinnedAddress('169.254.169.254')).rejects.toThrow(/metadata/i);
    await expect(resolvePinnedAddress('metadata.google.internal')).rejects.toThrow(/metadata/i);
  });
});

describe('guardedFetch', () => {
  it('re-checks each redirect hop against DNS', async () => {
    __setSsrfTestHooks({
      lookup: async (h) => [{ address: h === 'internal.example' ? '192.168.0.10' : '8.8.8.8', family: 4 }],
      fetch: vi.fn(async () => new Response(null, { status: 302, headers: { Location: 'http://internal.example/admin' } })),
    });
    await expect(guardedFetch('https://public.example/start')).rejects.toThrow(/private/i);
  });

  it('passes a pinned dispatcher to the transport', async () => {
    const transport = vi.fn(async (_u: string, _i?: unknown) => new Response('ok', { status: 200 }));
    __setSsrfTestHooks({ lookup: async () => [{ address: '8.8.8.8', family: 4 }], fetch: transport });
    const res = await guardedFetch('https://public.example/x');
    expect(res.status).toBe(200);
    expect((transport.mock.calls[0][1] as { dispatcher?: unknown }).dispatcher).toBeDefined();
  });

  it('drops Authorization on a cross-origin redirect', async () => {
    const seen: Array<string | null> = [];
    let n = 0;
    __setSsrfTestHooks({
      lookup: async () => [{ address: '8.8.8.8', family: 4 }],
      fetch: vi.fn(async (_u: string, i?: RequestInit) => {
        seen.push(new Headers(i?.headers).get('authorization'));
        n += 1;
        return n === 1
          ? new Response(null, { status: 307, headers: { Location: 'https://other.example/y' } })
          : new Response('done', { status: 200 });
      }),
    });
    await guardedFetch('https://public.example/x', { headers: { Authorization: 'Bearer abc' } });
    expect(seen).toEqual(['Bearer abc', null]);
  });

  it('refuses non-http schemes', async () => {
    await expect(guardedFetch('file:///etc/passwd')).rejects.toThrow(/scheme/i);
  });
});
