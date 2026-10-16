import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'node:url';

/**
 * Vault client — the zero-trust credential seam for OpenHub.
 *
 * 2026-10-15: the fleet's secrets live in **Infisical** (project o365, identity
 * mach1), and **Keywire was retired ecosystem-wide**. This module is
 * Infisical-only — the Keywire lane (service-token exchange, SVID file-trust,
 * `/workload/fetch-secrets`) is GONE, along with its `keywire-keys.json` read.
 *
 * Resolution order: env → Infisical → emergency file → explicit null.
 * This module never invents a secret, never logs a value, and degrades honestly
 * (`available: false` + an `error`) when the vault is unreachable.
 */

export type SecretSource = 'env' | 'infisical' | 'file' | null;

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
  /** Which lane answered (Infisical is the only one now). */
  source?: 'infisical';
}

// ---------------------------------------------------------------------------
// Infisical lane — one shared client, one credential path
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

function present(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
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

/**
 * Secret NAMES for presence checks and the UI (Infisical only). Replaces the
 * old `keywireSecretNames`. Never throws; `available:false` with the reason.
 */
export async function secretNames(env: NodeJS.ProcessEnv = process.env): Promise<VaultResult<string[]>> {
  const infisical = await infisicalSecretNames(env);
  if (!infisical.available || !infisical.data) return infisical;
  return { ...infisical, source: 'infisical' };
}

/**
 * The whole secret map (names → values) from Infisical. Used for readiness
 * checks that need the value (e.g. SEO integration keys). Values stay
 * server-side; callers must never ship them to the browser.
 */
export async function secretValues(env: NodeJS.ProcessEnv = process.env): Promise<VaultResult<Record<string, string>>> {
  try {
    const lane = await loadInfisical(env);
    if (!lane) return { available: false, error: 'Infisical lane unavailable' };
    const res = await lane.withAuth((token) =>
      lane.listSecrets(token, infisicalEnvName(env), infisicalSecretPath(env), false, true),
    );
    if (res.status !== 200) return { available: false, status: res.status, error: `Infisical HTTP ${res.status}` };
    const rows = (res.body as { secrets?: { secretKey?: string; secretValue?: string }[] }).secrets ?? [];
    const map: Record<string, string> = {};
    for (const r of rows) if (r.secretKey) map[String(r.secretKey)] = String(r.secretValue ?? '');
    return { available: true, status: 200, source: 'infisical', data: map };
  } catch {
    infisicalDownUntil = Date.now() + INFISICAL_RETRY_MS;
    return { available: false, error: 'Infisical lane unavailable' };
  }
}

// ---------------------------------------------------------------------------
// Name-based resolution (env → Infisical → emergency file)
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
 * env → Infisical (the vault) → emergency file → explicit null.
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
