import { resolveSecret } from './keywire.js';
import {
  verifyAndFetchGitHubProfile,
  saveGitHubIntegration,
  type GitHubUser,
} from './githubService.js';
import { getDb } from '../auth/db.js';

/**
 * Vault-backed GitHub authentication for OpenHub.
 *
 * Keywire is the fleet's credential authority. OpenHub's interactive GitHub
 * routes historically required a manual OAuth or PAT step, so the IDE opened
 * disconnected even though the vault already held a working token. This module
 * closes that gap: it resolves the operator's GitHub credential from the vault
 * (env -> Keywire -> emergency file, via `resolveSecret`), proves it against the
 * real GitHub API, and persists the same `github_integrations` record the manual
 * flow writes — so the account is already logged in on first load.
 *
 * Honesty contract (matches the rest of the harness): a missing, revoked or
 * expired token returns `{ connected: false, reason }` and writes nothing. It
 * never fabricates a connection and never logs a token value.
 */

/** Vault keys tried in order. `GITHUB_TOKEN` is the fleet-wide primary. */
export const VAULT_GITHUB_TOKEN_KEYS = ['GITHUB_TOKEN', 'GITHUB_PAT_NCSOUND', 'GH_TOKEN'] as const;

export type VaultGitHubTokenKey = (typeof VAULT_GITHUB_TOKEN_KEYS)[number];

export interface VaultCredentialHealth {
  key: string;
  present: boolean;
  valid: boolean;
  login: string | null;
  status: number | null;
  error?: string;
}

export interface VaultConnectResult {
  connected: boolean;
  user?: GitHubUser;
  /** Vault key that authenticated, e.g. `GITHUB_TOKEN`. */
  key?: string;
  /** Resolution source reported by `resolveSecret` (`env` | `keywire` | `file`). */
  source?: string;
  scope?: string;
  error?: string;
}

/** Injectable seams so the provisioning logic is unit-testable without a vault. */
export interface VaultAuthDeps {
  resolveSecret: (name: string, env?: NodeJS.ProcessEnv) => Promise<{ value: string | null; source: string | null; error?: string }>;
  verifyProfile: (token: string) => Promise<GitHubUser>;
  saveIntegration: (userId: string, token: string, profile: Partial<GitHubUser>, scope?: string) => void;
  /** Whether `userId` is the owner account allowed to receive the vault token. */
  isOwner?: (userId: string, env: NodeJS.ProcessEnv) => boolean;
}

/**
 * The vault credential is the OPERATOR's GitHub token. It may only be
 * provisioned into the owner's OpenHub account, never copied into every
 * account that opens the IDE (audit 2026-09-23). The owner is
 * OPENHUB_OWNER_USER_ID when set; otherwise the first-created user (lowest
 * rowid, i.e. insertion order; ids are UUIDs so they carry no order).
 */
export function isVaultOwner(userId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!userId) return false;
  const configured = env.OPENHUB_OWNER_USER_ID?.trim();
  if (configured) return userId === configured;
  try {
    const row = getDb().prepare('SELECT id FROM users ORDER BY rowid ASC LIMIT 1').get() as { id?: string } | undefined;
    return !!row?.id && row.id === userId;
  } catch {
    return false;
  }
}

export const VAULT_OWNER_ONLY_ERROR = 'The vault GitHub credential is reserved for the OpenHub owner account (OPENHUB_OWNER_USER_ID)';

const DEFAULT_DEPS: VaultAuthDeps = {
  resolveSecret,
  verifyProfile: verifyAndFetchGitHubProfile,
  saveIntegration: saveGitHubIntegration,
  isOwner: isVaultOwner,
};

export const VAULT_CONNECT_SCOPE = 'keywire-vault';

/**
 * Try each candidate vault key until one authenticates against GitHub.
 * Returns the first working credential, or an honest error when none do.
 */
async function firstWorkingCredential(
  env: NodeJS.ProcessEnv,
  deps: VaultAuthDeps,
): Promise<{ token: string; profile: GitHubUser; key: string; source: string } | { error: string }> {
  const attempts: string[] = [];
  for (const key of VAULT_GITHUB_TOKEN_KEYS) {
    let resolved: { value: string | null; source: string | null; error?: string };
    try {
      resolved = await deps.resolveSecret(key, env);
    } catch (err) {
      attempts.push(`${key}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (!resolved.value) {
      attempts.push(`${key}: not present`);
      continue;
    }
    try {
      const profile = await deps.verifyProfile(resolved.value);
      return { token: resolved.value, profile, key, source: resolved.source || 'keywire' };
    } catch (err) {
      attempts.push(`${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return {
    error: `no usable GitHub credential in the vault (${attempts.join('; ')})`,
  };
}

/**
 * Provision (or refresh) the OpenHub GitHub integration for `userId` from the
 * Keywire vault. Persists the record only when a credential actually verifies.
 */
export async function provisionGitHubFromVault(
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
  deps: VaultAuthDeps = DEFAULT_DEPS,
): Promise<VaultConnectResult> {
  const isOwner = deps.isOwner ?? isVaultOwner;
  if (!isOwner(userId, env)) return { connected: false, error: VAULT_OWNER_ONLY_ERROR };
  const found = await firstWorkingCredential(env, deps);
  if ('error' in found) return { connected: false, error: found.error };
  deps.saveIntegration(userId, found.token, found.profile, VAULT_CONNECT_SCOPE);
  return {
    connected: true,
    user: found.profile,
    key: found.key,
    source: found.source,
    scope: VAULT_CONNECT_SCOPE,
  };
}

/**
 * Health of every GitHub credential candidate in the vault — presence and a
 * real API check per key. Powers the "which PAT is dead" surface (a stale PAT
 * otherwise fails silently at the first write).
 */
export async function probeVaultGitHubCredentials(
  env: NodeJS.ProcessEnv = process.env,
  deps: VaultAuthDeps = DEFAULT_DEPS,
): Promise<VaultCredentialHealth[]> {
  const out: VaultCredentialHealth[] = [];
  for (const key of VAULT_GITHUB_TOKEN_KEYS) {
    let resolved: { value: string | null; source: string | null; error?: string };
    try {
      resolved = await deps.resolveSecret(key, env);
    } catch (err) {
      out.push({ key, present: false, valid: false, login: null, status: null, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (!resolved.value) {
      out.push({ key, present: false, valid: false, login: null, status: null, error: resolved.error || 'not present' });
      continue;
    }
    try {
      const profile = await deps.verifyProfile(resolved.value);
      out.push({ key, present: true, valid: true, login: profile.login, status: 200 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const statusMatch = message.match(/\((\d{3})\)/);
      out.push({
        key,
        present: true,
        valid: false,
        login: null,
        status: statusMatch ? Number(statusMatch[1]) : null,
        error: message.slice(0, 200),
      });
    }
  }
  return out;
}
