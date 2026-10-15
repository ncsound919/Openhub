import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'node:url';

/**
 * Vault client — the zero-trust credential seam for OpenHub, per the fleet
 * credential gate (AGENTS.md).
 *
 * 2026-10-15: the fleet's secrets migrated to **Infisical** (project o365,
 * identity mach1). Resolution order is now Infisical FIRST, Keywire second:
 *   Infisical  — the primary lane (one client: INFRASTRUCTURE/infisical/
 *                infisical-client.mjs; credentials in .secrets/mach1.env).
 *   Keywire    — the legacy/fallback lane (service token, minted JWT, SVID
 *                file-trust), still needed for anything never migrated.
 *
 * Keywire's two non-vault views were dealt with the same day: the site inventory
 * moved to the local services/fleetSites.ts (+ data/ecosystem-sites.json), and
 * keywireCompliance() was deleted as an unused export (nothing rendered it).
 * Nothing in OpenHub reads Keywire for either view now - the vault fallback lane
 * is all that remains in this module.
 *
 * This module never invents a secret, never logs a value, and degrades honestly
 * (`available: false` + an `error`) when every lane is down.
 */

export type SecretSource = 'env' | 'infisical' | 'keywire' | 'file' | null;

export interface SecretResult {
  value: string | null;
  source: SecretSource;
  error?: string;
}

/** Every vault call resolves to this — availability is explicit, never faked. */
export interface VaultResult<T = unknown> {
  available: boolean;
  status?: number;
  data?: T;
  error?: string;
  /** Which lane answered (additive; the vault UI reports it). */
  source?: 'infisical' | 'keywire';
}

const VAULT_TIMEOUT_MS = 6000;
const SVID_TTL_SECONDS = 300;

// ---------------------------------------------------------------------------
// Configuration (resolved per call so env overrides always apply)
// ---------------------------------------------------------------------------

export function keywireBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.OPENHUB_KEYWIRE_URL || env.KEYWIRE_URL || 'http://127.0.0.1:4700').replace(/\/+$/, '');
}

export function keywireProject(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENHUB_KEYWIRE_PROJECT || env.KEYWIRE_PROJECT || 'prj-mt7jrul1';
}

export function keywireEnvName(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENHUB_KEYWIRE_ENV || env.KEYWIRE_ENV || 'production';
}

/** Keywire's shared HMAC secret file. Explicit env first, then the known
 *  fleet checkout, so a fleet run needs no configuration. */
export function keywireKeysFile(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OPENHUB_KEYWIRE_KEYS_FILE || env.KEYWIRE_KEYS_FILE;
  if (explicit) return explicit;
  const keywireRoot = env.KEYWIRE_ROOT || path.join(os.homedir(), 'Downloads', 'BUSINESS', 'INFRASTRUCTURE', 'Keywire');
  return path.join(keywireRoot, 'data', 'keywire-keys.json');
}

function keywireServiceTokenFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENHUB_KEYWIRE_TOKEN_FILE || path.join(os.homedir(), '.secrets', 'opencode', 'keywire-service-token');
}

// ---------------------------------------------------------------------------
// Infisical lane (primary) — one shared client, one credential path
// ---------------------------------------------------------------------------

/** The fleet's Infisical lane client (same module sieve uses). */
export function infisicalClientPath(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.OPENHUB_INFISICAL_CLIENT ||
    env.INFISICAL_CLIENT ||
    path.join('C:', 'Users', 'User', 'Downloads', 'BUSINESS', 'INFRASTRUCTURE', 'infisical', 'infisical-client.mjs')
  );
}

export function infisicalSecretPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENHUB_INFISICAL_PATH || '/overlay365-fleet/prod';
}

export function infisicalEnvName(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENHUB_INFISICAL_ENV || 'prod';
}

interface InfisicalLane {
  resolve(name: string, opts?: { env?: string; secretPath?: string }): Promise<string | null>;
  withAuth<T>(fn: (token: string) => Promise<T>): Promise<T>;
  listSecrets(token: string, env: string, secretPath: string, recursive: boolean, values: boolean): Promise<{ status: number; body: unknown }>;
}

let infisicalLane: Promise<InfisicalLane | null> | null = null;
/** When the lane fails (vault down, creds missing), skip it for this long so a
 *  per-secret resolution loop never retries a dead lane hundreds of times. */
let infisicalDownUntil = 0;
const INFISICAL_RETRY_MS = 60_000;

async function loadInfisical(env: NodeJS.ProcessEnv): Promise<InfisicalLane | null> {
  if (env.OPENHUB_DISABLE_INFISICAL === '1') return null;
  if (Date.now() < infisicalDownUntil) return null;
  if (!infisicalLane) {
    infisicalLane = import(pathToFileURL(infisicalClientPath(env)).href)
      .then((mod) => mod as InfisicalLane)
      .catch(() => null);
  }
  const lane = await infisicalLane;
  if (!lane) infisicalDownUntil = Date.now() + INFISICAL_RETRY_MS;
  return lane;
}

/** One secret value from Infisical. Never throws; null when unavailable. */
export async function infisicalSecret(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  try {
    const lane = await loadInfisical(env);
    if (!lane) return null;
    const value = await lane.resolve(name, { env: infisicalEnvName(env), secretPath: infisicalSecretPath(env) });
    return present(value) ? value : null;
  } catch {
    infisicalDownUntil = Date.now() + INFISICAL_RETRY_MS;
    return null;
  }
}

/** Secret NAMES from Infisical (values never fetched). Never throws. */
export async function infisicalSecretNames(
  env: NodeJS.ProcessEnv = process.env,
): Promise<VaultResult<string[]>> {
  try {
    const lane = await loadInfisical(env);
    if (!lane) return { available: false, error: 'Infisical lane unavailable' };
    const res = await lane.withAuth((token) =>
      lane.listSecrets(token, infisicalEnvName(env), infisicalSecretPath(env), false, false),
    );
    if (res.status !== 200) return { available: false, status: res.status, error: `Infisical HTTP ${res.status}` };
    const rows = (res.body as { secrets?: { secretKey?: string }[] }).secrets ?? [];
    return { available: true, status: 200, data: rows.map((r) => String(r.secretKey)).sort() };
  } catch {
    infisicalDownUntil = Date.now() + INFISICAL_RETRY_MS;
    return { available: false, error: 'Infisical lane unavailable' };
  }
}

function present(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

function b64url(input: string): string {
  return Buffer.from(input).toString('base64url');
}

// ---------------------------------------------------------------------------
// Bearer resolution
// ---------------------------------------------------------------------------

interface BearerAuth {
  token: string;
  source: 'env' | 'service-token' | 'token-file' | 'svid';
  error?: string;
}

let cachedBearer: { key: string; token: string; expiresAt: number } | null = null;

/** Cache key: the config a bearer was resolved under. Prevents a token resolved
 *  for one vault/project leaking into a call against another. */
function authConfigKey(env: NodeJS.ProcessEnv): string {
  return `${keywireBaseUrl(env)}|${keywireProject(env)}|${keywireKeysFile(env)}|${env.OPENHUB_KEYWIRE_TOKEN || env.KEYWIRE_TOKEN ? 'explicit' : 'derived'}`;
}

/** Test seam: drop the cached bearer. */
export function clearKeywireAuthCache(): void {
  cachedBearer = null;
}

function readKeyFileSecret(keysFile: string): string {
  try {
    if (!fs.existsSync(keysFile)) return '';
    const raw = JSON.parse(fs.readFileSync(keysFile, 'utf-8').replace(/^\uFEFF/, '')) as { jwtSecret?: unknown };
    return typeof raw?.jwtSecret === 'string' && raw.jwtSecret.length > 0 ? raw.jwtSecret : '';
  } catch {
    return '';
  }
}

/** Sign a short-lived SVID in the shape Keywire's workload trust accepts. */
export function signSvid(secret: string, projectId: string, nowMs = Date.now()): string {
  const now = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      sub: 'spiffe://ecosystem/openhub-agent',
      iss: 'keywire-local-consumer',
      aud: 'keywire-vault-api',
      projectId,
      iat: now,
      exp: now + SVID_TTL_SECONDS,
    }),
  );
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

async function exchangeServiceToken(token: string, env: NodeJS.ProcessEnv): Promise<string> {
  try {
    const res = await fetch(`${keywireBaseUrl(env)}/api/v1/auth/service-token/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(VAULT_TIMEOUT_MS),
    });
    if (!res.ok) return '';
    const body = (await res.json().catch(() => null)) as { accessToken?: unknown } | null;
    return typeof body?.accessToken === 'string' ? body.accessToken : '';
  } catch {
    return '';
  }
}

function isJwt(token: string): boolean {
  return token.split('.').length === 3;
}

/** Expiry (ms) of a JWT, or null when it carries no readable `exp`. */
function jwtExpiryMs(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf-8')) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a bearer for the vault API. Returns an error string (never a
 * fabricated token) when nothing usable is available.
 */
export async function keywireBearer(
  env: NodeJS.ProcessEnv = process.env,
): Promise<BearerAuth> {
  const cacheKey = authConfigKey(env);
  if (cachedBearer && cachedBearer.key === cacheKey && cachedBearer.expiresAt > Date.now()) {
    return { token: cachedBearer.token, source: 'env' };
  }

  // 1. Explicit bearer.
  const explicit = env.OPENHUB_KEYWIRE_TOKEN || env.KEYWIRE_TOKEN;
  if (present(explicit)) {
    return { token: explicit, source: 'env' };
  }

  // 2. Service token env.
  const serviceToken = env.OPENHUB_KEYWIRE_SERVICE_TOKEN || env.KEYWIRE_SERVICE_TOKEN;
  if (present(serviceToken) && serviceToken.startsWith('kw_st_live_')) {
    const exchanged = await exchangeServiceToken(serviceToken, env);
    if (exchanged) {
      cachedBearer = { key: cacheKey, token: exchanged, expiresAt: Date.now() + 10 * 60_000 };
      return { token: exchanged, source: 'service-token' };
    }
  }

  // 3. Minted vault JWT on disk (Axiom/opencode convention).
  const tokenFile = keywireServiceTokenFile(env);
  try {
    if (fs.existsSync(tokenFile)) {
      const fileToken = fs.readFileSync(tokenFile, 'utf-8').trim();
      if (present(fileToken)) {
        if (isJwt(fileToken)) {
          const exp = jwtExpiryMs(fileToken);
          // Use the minted JWT only while it is still valid; otherwise fall
          // through to a fresh SVID rather than presenting an expired token.
          if (exp === null || exp > Date.now() + 5_000) return { token: fileToken, source: 'token-file' };
        } else if (fileToken.startsWith('kw_st_live_')) {
          const exchanged = await exchangeServiceToken(fileToken, env);
          if (exchanged) {
            cachedBearer = { key: cacheKey, token: exchanged, expiresAt: Date.now() + 10 * 60_000 };
            return { token: exchanged, source: 'service-token' };
          }
        }
      }
    }
  } catch {
    /* fall through to SVID */
  }

  // 4. SVID file-trust.
  const secret = readKeyFileSecret(keywireKeysFile(env));
  if (present(secret)) {
    const svid = signSvid(secret, keywireProject(env));
    return { token: svid, source: 'svid' };
  }

  return { token: '', source: 'env', error: `no Keywire credential: set KEYWIRE_SERVICE_TOKEN or provide ${keywireKeysFile(env)}` };
}


/** Keywire's LLC compliance + site-inventory views � REMOVED 2026-10-15.
 *
 *  `keywireCompliance()` was an unused export (no OpenHub code rendered the
 *  view) and was deleted rather than re-homed. The site inventory moved to the
 *  local `services/fleetSites.ts` + `data/ecosystem-sites.json`, which removed
 *  the last *used* non-vault coupling. This module now reads Keywire only for
 *  the vault fallback lane.
 */let cachedSecrets: { key: string; secrets: Record<string, string>; expiresAt: number } | null = null;

/** Test seam: drop the cached secret map. */
export function clearKeywireSecretCache(): void {
  cachedSecrets = null;
}

/**
 * Fetch the project's secrets (SVID/workload path, record shape). Cached ~60s
 * per config. Values stay server-side; callers must never ship them to the
 * browser.
 */
export async function keywireSecrets(
  env: NodeJS.ProcessEnv = process.env,
): Promise<VaultResult<Record<string, string>>> {
  const project = keywireProject(env);
  const envName = keywireEnvName(env);
  const cacheKey = `${keywireBaseUrl(env)}|${project}|${envName}|${keywireKeysFile(env)}`;
  if (cachedSecrets && cachedSecrets.key === cacheKey && cachedSecrets.expiresAt > Date.now()) {
    return { available: true, status: 200, data: cachedSecrets.secrets };
  }
  const auth = await keywireBearer(env);
  if (!auth.token) {
    return { available: false, error: auth.error || 'Keywire credential unavailable' };
  }
  try {
    const res = await fetch(`${keywireBaseUrl(env)}/api/v1/workload/fetch-secrets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}` },
      body: JSON.stringify({ svid: auth.source === 'svid' ? auth.token : undefined, projectId: project, envSlug: envName }),
      signal: AbortSignal.timeout(VAULT_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => null)) as { secrets?: Record<string, string> } | null;
    if (!res.ok) return { available: false, status: res.status, error: `Keywire fetch-secrets HTTP ${res.status}` };
    const secrets = body?.secrets && typeof body.secrets === 'object' ? body.secrets : {};
    cachedSecrets = { key: cacheKey, secrets, expiresAt: Date.now() + 60_000 };
    return { available: true, status: res.status, data: secrets };
  } catch (err) {
    return { available: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Secret names only — the safe shape for presence checks and the UI.
 *  Infisical FIRST (the primary lane), Keywire second (legacy fallback). */
export async function keywireSecretNames(env: NodeJS.ProcessEnv = process.env): Promise<VaultResult<string[]>> {
  const infisical = await infisicalSecretNames(env);
  if (infisical.available && infisical.data?.length) return { ...infisical, source: 'infisical' };
  const result = await keywireSecrets(env);
  if (!result.available || !result.data) return { available: false, status: result.status, error: result.error };
  return { available: true, status: result.status, source: 'keywire', data: Object.keys(result.data).sort() };
}

// ---------------------------------------------------------------------------
// Name-based resolution (back-compat surface used by GitHub OAuth + repos)
// ---------------------------------------------------------------------------

function emergencyFileValue(name: string, env: NodeJS.ProcessEnv): string | null {
  const keyDir = env.OPENHUB_KEY_DIR || path.join(os.homedir(), '.openhub');
  const filePath = path.join(keyDir, 'emergency-secrets.json');
  try {
    if (!fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    const value = parsed[name];
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Zero-trust secret resolution, fleet credential gate order:
 * env -> Infisical (primary) -> Keywire (legacy) -> emergency file -> explicit null.
 * Never logs values and never substitutes a fake default.
 */
export async function resolveSecret(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SecretResult> {
  const envValue = env[`OPENHUB_SECRET_${name}`] ?? env[name];
  if (present(envValue)) return { value: envValue, source: 'env' };

  const infisicalValue = await infisicalSecret(name, env);
  if (present(infisicalValue)) return { value: infisicalValue, source: 'infisical' };

  const vaultRes = await keywireSecrets(env);
  if (vaultRes.available && vaultRes.data) {
    const vaultValue = vaultRes.data[name];
    if (present(vaultValue)) return { value: vaultValue, source: 'keywire' };
  }

  const fileValue = emergencyFileValue(name, env);
  if (present(fileValue)) return { value: fileValue, source: 'file' };

  return {
    value: null,
    source: null,
    error: `no secret source for ${name}`,
  };
}

export function resolveSecrets(
  names: string[],
  env?: NodeJS.ProcessEnv,
): Promise<Record<string, SecretResult>> {
  return Promise.all(names.map((name) => resolveSecret(name, env))).then((results) => {
    const resolved: Record<string, SecretResult> = {};
    for (let i = 0; i < names.length; i++) resolved[names[i]] = results[i];
    return resolved;
  });
}
