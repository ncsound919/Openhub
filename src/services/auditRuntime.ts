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
