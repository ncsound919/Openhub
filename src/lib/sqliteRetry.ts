/**
 * Retry policy for transient SQLite lock contention.
 *
 * Every background writer in this server (dream loop, fleet sync, self-report,
 * the external status-ledger sampler) shares one SQLite file, so SQLITE_BUSY is
 * a routine traffic event, not a defect. Before this helper, each writer treated
 * the first BUSY as final: the tick was silently skipped and the data went stale
 * until the next cycle -- and in one case the unhandled rejection killed the
 * server outright (see Coding lessons 2026-10-05-a-sampler-must-never-hold-a-…).
 *
 * Policy, stated once so every writer behaves the same:
 * - retry only errors that mean "someone else holds the lock" (BUSY variants);
 *   any other error throws immediately so real defects stay loud;
 * - bounded attempts with exponential backoff + jitter, so a stuck lock degrades
 *   to one warning per tick instead of a hot spin or a silent skip;
 * - the sync variant retries immediately with no sleep: it exists for contexts
 *   that cannot await (boot migrations, sync ticks), where the waiting is
 *   busy_timeout's job, not ours. Blocking the event loop in a sleep would be
 *   worse than the lock.
 *
 * Deliberately dependency-free: db.ts imports this, so it must not import db.ts.
 */

export interface BusyRetryOptions {
  /** Total attempts including the first try. Default 5. */
  attempts?: number;
  /** Base backoff in ms; actual wait is base * 2^retry capped at 5s, plus jitter. Default 200. */
  baseMs?: number;
}

const DEFAULT_ATTEMPTS = 5;
const DEFAULT_BASE_MS = 200;
const MAX_WAIT_MS = 5_000;

export function isBusyError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT' || code === 'SQLITE_LOCKED';
}

function backoffMs(retryIndex: number, baseMs: number): number {
  const grown = Math.min(MAX_WAIT_MS, baseMs * 2 ** retryIndex);
  return grown + Math.floor(Math.random() * 100);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function withBusyRetry<T>(
  label: string,
  fn: () => T | Promise<T>,
  opts: BusyRetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, Math.floor(opts.attempts ?? DEFAULT_ATTEMPTS));
  const baseMs = Math.max(0, opts.baseMs ?? DEFAULT_BASE_MS);
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (!isBusyError(err) || i === attempts - 1) throw err;
      const wait = backoffMs(i, baseMs);
      console.warn(`[sqlite] ${label}: database busy, retry ${i + 1}/${attempts} in ${wait}ms`);
      await sleep(wait);
    }
  }
  throw last;
}

/**
 * Sync twin for contexts that cannot await.
 *
 * Retries immediately, with a deliberately small default attempt count. This
 * variant BLOCKS the event loop: better-sqlite3 is synchronous, so each attempt
 * can burn a full busy_timeout with nothing else served. Measured 2026-10-05 by
 * tests/dbLockDrill.mjs -- 5 attempts against a 30s lock held the event loop
 * long enough that /api/health timed out on every sample while pm2 still
 * reported `online`. Callers on this path must pair a short busy_timeout
 * (src/auth/db.ts uses 1s) with a bounded count, and must not use it from a
 * high-frequency interval. For anything that can await, use withBusyRetry: its
 * backoff sleeps instead of spinning, so the server keeps serving.
 *
 * Same contract otherwise -- BUSY-only retries, anything else throws at once.
 */
export function withBusyRetrySync<T>(
  label: string,
  fn: () => T,
  opts: BusyRetryOptions = {},
): T {
  const attempts = Math.max(1, Math.floor(opts.attempts ?? 3));
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return fn();
    } catch (err) {
      last = err;
      if (!isBusyError(err) || i === attempts - 1) throw err;
      console.warn(`[sqlite] ${label}: database busy, retry ${i + 1}/${attempts}`);
    }
  }
  throw last;
}
