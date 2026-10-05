/**
 * Audit runtime determinism controls (P4 / workstream G2).
 *
 * Two things keep repeat audits reproducible:
 *  - a content-signature keyed result cache so unchanged trees don't re-run
 *    expensive deterministic tools, invalidated the moment a file changes;
 *  - a single place that pins the LLM model id + seed (recorded on every report
 *    so a grade can be tied to the exact model that produced it).
 *
 * The cache is OFF unless `AUDIT_CACHE_TTL_MS` is set to a positive number, so
 * tests and one-off audits keep the old always-fresh behaviour by default.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ScorerResult } from './evidence.js';

export interface CachedScorerResult extends ScorerResult {
  /** True when the result was served from the runtime cache. */
  cached?: boolean;
}

export function auditCacheTtlMs(): number {
  const n = Number(process.env.AUDIT_CACHE_TTL_MS ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function auditCacheEnabled(): boolean {
  return auditCacheTtlMs() > 0;
}

/**
 * Cheap, stable signature of the audited file set. When `files` is supplied
 * (diff scope) only those are hashed; otherwise a bounded top-level listing is
 * used. Either way a touched file changes the signature and busts the cache.
 */
export function signatureForDir(dir: string, files?: Iterable<string>): string {
  const hash = createHash('sha1');
  if (files) {
    const list = Array.from(files).map((f) => f.replace(/\\/g, '/')).sort();
    hash.update(`n=${list.length}\n`);
    for (const rel of list) {
      try {
        const stat = fs.statSync(path.join(dir, rel));
        hash.update(`${rel}:${stat.size}:${stat.mtimeMs}\n`);
      } catch {
        hash.update(`${rel}:missing\n`);
      }
    }
    return hash.digest('hex').slice(0, 16);
  }
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 'unreadable';
  }
  for (const entry of entries.slice(0, 200).sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      const stat = fs.statSync(path.join(dir, entry.name));
      hash.update(`${entry.name}:${stat.size}:${stat.mtimeMs}\n`);
    } catch {
      hash.update(`${entry.name}:?\n`);
    }
  }
  return hash.digest('hex').slice(0, 16);
}

export function scorerCacheKey(scorer: string, target: string, signature: string): string {
  return `${scorer}|${target}|${signature}`;
}

const cache = new Map<string, { at: number; result: ScorerResult }>();
const CACHE_MAX = 200;

export function getCachedScorer(key: string): CachedScorerResult | null {
  const ttl = auditCacheTtlMs();
  if (ttl <= 0) return null;
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > ttl) {
    cache.delete(key);
    return null;
  }
  return { ...hit.result, cached: true };
}

export function setCachedScorer(key: string, result: ScorerResult): void {
  if (!auditCacheEnabled()) return;
  cache.set(key, { at: Date.now(), result });
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

export function resetAuditCache(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// Model pinning / seeds
// ---------------------------------------------------------------------------

export interface AuditModelConfig {
  /** Pinned model id, or null when the environment does not pin one. */
  model: string | null;
  seed: number | null;
  source: 'env' | 'none';
}

/** Read the pinned model + seed from the environment (recorded on reports). */
export function auditModelConfig(): AuditModelConfig {
  const model = (process.env.AUDIT_LLM_MODEL ?? '').trim() || null;
  const seedRaw = (process.env.AUDIT_LLM_SEED ?? '').trim();
  const seed = seedRaw !== '' && Number.isFinite(Number(seedRaw)) ? Number(seedRaw) : null;
  return { model, seed, source: model || seed !== null ? 'env' : 'none' };
}

// ---------------------------------------------------------------------------
// Audit-team model provider
// ---------------------------------------------------------------------------

/**
 * The audit team's model provider, resolved from env. Per OPS.md the fleet LLM
 * seam is the LiteLLM gateway, so the audit team routes through it using a model
 * GROUP (`ollama-cloud` by default — the hosted small model LiteLLM fans across
 * the Ollama Cloud keys). Setting `AUDIT_LLM_MODEL` pins an explicit group/model.
 */
export const AUDIT_MODEL_GROUP_DEFAULT = 'ollama-cloud';

export interface AuditModelProvider {
  /** Gateway root, WITHOUT a trailing `/v1` (callers append `/v1/chat/completions`). */
  baseUrl: string;
  model: string;
  hasKey: boolean;
  source: 'env' | 'default';
}

export function auditModelProvider(env: NodeJS.ProcessEnv = process.env): AuditModelProvider {
  const baseUrl = (
    env.AUDIT_LLM_BASE_URL ||
    env.OPENHUB_LLM_BASE_URL ||
    env.AXIOM_LLM_BASE_URL ||
    'http://localhost:4100'
  )
    .replace(/\/chat\/completions\/?$/, '')
    .replace(/\/v1\/?$/, '')
    .replace(/\/+$/, '');
  const explicitModel = (env.AUDIT_LLM_MODEL || '').trim();
  const model = explicitModel || AUDIT_MODEL_GROUP_DEFAULT;
  const hasKey = Boolean((env.AUDIT_LLM_KEY || env.OPENHUB_LLM_KEY || env.LITELLM_MASTER_KEY || '').trim());
  return { baseUrl, model, hasKey, source: explicitModel ? 'env' : 'default' };
}

/**
 * Resolve the gateway bearer: env first, then the Keywire vault by name. Never
 * logs or returns a fabricated value; unresolved → undefined (honest).
 */
export async function resolveAuditModelKey(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const direct = (env.AUDIT_LLM_KEY || env.OPENHUB_LLM_KEY || env.LITELLM_MASTER_KEY || '').trim();
  if (direct) return direct;
  try {
    const { resolveSecret } = await import('./keywire.js');
    const result = await resolveSecret('LITELLM_MASTER_KEY', env);
    return result.value ?? undefined;
  } catch {
    return undefined;
  }
}
