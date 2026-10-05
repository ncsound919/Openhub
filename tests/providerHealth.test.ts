import { describe, it, expect, vi } from 'vitest';
import { probeProviderHealth, type ProviderHealthDeps } from '../src/services/providerHealth';
import type { VaultCredentialHealth } from '../src/services/githubVaultAuth';

function deps(over: Partial<ProviderHealthDeps> = {}): ProviderHealthDeps {
  return {
    secretNames: vi.fn(async () => ({ available: true, data: ['GITHUB_TOKEN', 'STRIPE_SECRET_KEY'] })),
    probeGitHub: vi.fn(async () => ([
      { key: 'GITHUB_TOKEN', present: true, valid: true, login: 'ncsound919', status: 200 },
      { key: 'GITHUB_PAT_TAP919', present: true, valid: false, login: null, status: 401, error: 'GitHub token verification failed (401): Bad credentials' },
    ] as VaultCredentialHealth[])),
    fetchImpl: vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
    timeoutMs: 50,
    ...over,
  };
}

describe('probeProviderHealth', () => {
  it('reports vault reachability, secret count and a valid GitHub credential', async () => {
    const report = await probeProviderHealth({}, deps());
    expect(report.vault).toMatchObject({ reachable: true, secretCount: 2 });
    const github = report.providers.find((p) => p.id === 'github');
    expect(github).toMatchObject({ up: true, configured: true });
    expect(github?.detail).toContain('@ncsound919');
    expect(github?.detail).toContain('1/2');
  });

  it('marks GitHub down and names the revoked key when no credential verifies', async () => {
    const d = deps({ probeGitHub: vi.fn(async () => ([
      { key: 'GITHUB_PAT_TAP919', present: true, valid: false, login: null, status: 401, error: 'bad' },
    ] as VaultCredentialHealth[])) });
    const report = await probeProviderHealth({}, d);
    const github = report.providers.find((p) => p.id === 'github');
    expect(github?.up).toBe(false);
    expect(github?.detail).toContain('GITHUB_PAT_TAP919');
    expect(github?.detail).toContain('revoked/expired');
  });

  it('degrades honestly when the vault is unreachable', async () => {
    const d = deps({
      secretNames: vi.fn(async () => ({ available: false, error: 'Keywire HTTP 500' })),
      probeGitHub: vi.fn(async () => [] as VaultCredentialHealth[]),
    });
    const report = await probeProviderHealth({}, d);
    expect(report.vault.reachable).toBe(false);
    expect(report.vault.secretCount).toBeNull();
    const keywire = report.providers.find((p) => p.id === 'keywire');
    expect(keywire?.up).toBe(false);
    expect(keywire?.detail).toBe('unreachable');
  });

  it('reports an unreachable fleet service with its error, never as up', async () => {
    const d = deps({
      fetchImpl: vi.fn(async () => { throw new Error('connect ECONNREFUSED'); }) as unknown as typeof fetch,
    });
    const report = await probeProviderHealth({}, d);
    const axiom = report.providers.find((p) => p.id === 'axiom');
    expect(axiom?.up).toBe(false);
    expect(axiom?.detail).toContain('ECONNREFUSED');
  });
});
