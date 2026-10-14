import { describe, it, expect, vi } from 'vitest';
import {
  provisionGitHubFromVault,
  isVaultOwner,
  probeVaultGitHubCredentials,
  VAULT_CONNECT_SCOPE,
  type VaultAuthDeps,
} from '../src/services/githubVaultAuth';
import type { GitHubUser } from '../src/services/githubService';

const profile = (login: string): GitHubUser => ({
  id: 1,
  login,
  name: login,
  avatar_url: `https://avatars.example/${login}.png`,
  email: `${login}@example.com`,
  bio: null,
  public_repos: 3,
  html_url: `https://github.com/${login}`,
});

/** Build injectable deps from a { KEY: token } map; tokens starting with "bad-" fail verification. */
function deps(tokens: Record<string, string>, failWith = 'GitHub token verification failed (401): Bad credentials'): VaultAuthDeps {
  return {
    resolveSecret: vi.fn(async (name: string) => {
      const value = tokens[name] ?? null;
      return value ? { value, source: 'keywire' } : { value: null, source: null, error: `no secret source for ${name}` };
    }),
    verifyProfile: vi.fn(async (token: string) => {
      if (token.startsWith('bad-')) throw new Error(failWith);
      return profile(token.startsWith('tok-') ? 'ncsound919' : 'tap919');
    }),
    saveIntegration: vi.fn(),
    isOwner: () => true,
  };
}

describe('githubVaultAuth', () => {
  describe('provisionGitHubFromVault', () => {
    it('provisions from the primary vault key and persists a keywire-vault record', async () => {
      const d = deps({ GITHUB_TOKEN: 'tok-good' });
      const result = await provisionGitHubFromVault('user-1', {}, d);

      expect(result).toMatchObject({ connected: true, key: 'GITHUB_TOKEN', source: 'keywire', scope: VAULT_CONNECT_SCOPE });
      expect(result.user?.login).toBe('ncsound919');
      expect(d.saveIntegration).toHaveBeenCalledWith('user-1', 'tok-good', expect.objectContaining({ login: 'ncsound919' }), VAULT_CONNECT_SCOPE);
    });

    it('skips a present-but-revoked key and falls through to the next working credential', async () => {
      const d = deps({ GITHUB_TOKEN: 'bad-revoked', GITHUB_PAT_NCSOUND: 'tok-backup' });
      const result = await provisionGitHubFromVault('user-1', {}, d);

      expect(result).toMatchObject({ connected: true, key: 'GITHUB_PAT_NCSOUND' });
      expect(d.saveIntegration).toHaveBeenCalledTimes(1);
      expect(d.saveIntegration).toHaveBeenCalledWith('user-1', 'tok-backup', expect.anything(), VAULT_CONNECT_SCOPE);
    });

    it('returns an honest error and writes nothing when no credential verifies', async () => {
      const d = deps({ GITHUB_TOKEN: 'bad-revoked' });
      const result = await provisionGitHubFromVault('user-1', {}, d);

      expect(result.connected).toBe(false);
      expect(result.error).toContain('no usable GitHub credential');
      expect(result.error).toContain('GITHUB_TOKEN');
      expect(d.saveIntegration).not.toHaveBeenCalled();
    });

    it('never writes a record when the vault itself is unreachable', async () => {
      const d = deps({});
      const result = await provisionGitHubFromVault('user-1', {}, d);

      expect(result.connected).toBe(false);
      expect(result.error).toContain('not present');
      expect(d.saveIntegration).not.toHaveBeenCalled();
    });
  });

  describe('probeVaultGitHubCredentials', () => {
    it('reports presence, validity and login per candidate key', async () => {
      const d = deps({ GITHUB_TOKEN: 'tok-good', GITHUB_PAT_NCSOUND: 'bad-revoked' });
      const health = await probeVaultGitHubCredentials({}, d);

      const byKey = Object.fromEntries(health.map((h) => [h.key, h]));
      expect(byKey.GITHUB_TOKEN).toMatchObject({ present: true, valid: true, login: 'ncsound919', status: 200 });
      expect(byKey.GITHUB_PAT_NCSOUND).toMatchObject({ present: true, valid: false, login: null, status: 401 });
      expect(byKey.GH_TOKEN).toMatchObject({ present: false, valid: false });
    });

    it('marks a vault error as not present rather than valid', async () => {
      const d = deps({});
      d.resolveSecret = vi.fn(async () => { throw new Error('Keywire HTTP 500'); });
      const health = await probeVaultGitHubCredentials({}, d);
      expect(health.every((h) => h.present === false && h.valid === false)).toBe(true);
      expect(health[0].error).toContain('Keywire HTTP 500');
    });
  });
});

describe('vault token owner restriction (audit 2026-09-23)', () => {
  it('never provisions the vault token into a non-owner account', async () => {
    const d = { ...deps({ GITHUB_TOKEN: 'tok-good' }), isOwner: () => false };
    const result = await provisionGitHubFromVault('someone-else', {}, d);
    expect(result.connected).toBe(false);
    expect(d.saveIntegration).not.toHaveBeenCalled();
    expect(d.resolveSecret).not.toHaveBeenCalled();
  });

  it('isVaultOwner honors OPENHUB_OWNER_USER_ID', () => {
    expect(isVaultOwner('owner-id', { OPENHUB_OWNER_USER_ID: 'owner-id' })).toBe(true);
    expect(isVaultOwner('other-id', { OPENHUB_OWNER_USER_ID: 'owner-id' })).toBe(false);
    expect(isVaultOwner('', { OPENHUB_OWNER_USER_ID: 'owner-id' })).toBe(false);
  });
});
