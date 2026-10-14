import { describe, it, expect, vi } from 'vitest';
import { isBusyError, withBusyRetry, withBusyRetrySync } from '../src/lib/sqliteRetry';

const busy = () => Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
const real = () => Object.assign(new Error('CHECK constraint failed'), { code: 'SQLITE_CONSTRAINT_CHECK' });

describe('isBusyError (only lock contention is retriable)', () => {
  it('recognises the lock codes', () => {
    for (const code of ['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_LOCKED']) {
      expect(isBusyError(Object.assign(new Error('x'), { code }))).toBe(true);
    }
  });

  it('rejects everything else, including code-less values', () => {
    expect(isBusyError(real())).toBe(false);
    expect(isBusyError(new Error('plain'))).toBe(false);
    expect(isBusyError(null)).toBe(false);
    expect(isBusyError(undefined)).toBe(false);
    expect(isBusyError('SQLITE_BUSY')).toBe(false);
  });
});

describe('withBusyRetry (async)', () => {
  it('calls once and returns on success', async () => {
    const fn = vi.fn(() => 42);
    await expect(withBusyRetry('t', fn, { baseMs: 1 })).resolves.toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries BUSY then returns the late success', async () => {
    let n = 0;
    const out = await withBusyRetry('t', () => (++n < 3 ? Promise.reject(busy()) : 'ok'), { baseMs: 1 });
    expect(out).toBe('ok');
    expect(n).toBe(3);
  });

  it('throws a non-BUSY error immediately without retry', async () => {
    const fn = vi.fn(() => Promise.reject(real()));
    await expect(withBusyRetry('t', fn, { baseMs: 1 })).rejects.toThrow('CHECK constraint');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('gives up after the configured attempts on persistent BUSY', async () => {
    const fn = vi.fn(() => Promise.reject(busy()));
    await expect(withBusyRetry('t', fn, { attempts: 3, baseMs: 1 })).rejects.toThrow('database is locked');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('backs off between attempts instead of hot-spinning', async () => {
    const t0 = Date.now();
    await expect(withBusyRetry('t', () => Promise.reject(busy()), { attempts: 3, baseMs: 50 })).rejects.toThrow();
    // waits are 50+jitter then 100+jitter, so at least ~150ms must pass
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
  });
});

describe('withBusyRetrySync', () => {
  it('returns on success and retries BUSY without sleeping the loop', () => {
    let n = 0;
    const out = withBusyRetrySync('t', () => {
      if (++n < 3) throw busy();
      return 'ok';
    });
    expect(out).toBe('ok');
    expect(n).toBe(3);
  });

  it('throws non-BUSY at once and persistent BUSY after N attempts', () => {
    const realFn = vi.fn(() => { throw real(); });
    expect(() => withBusyRetrySync('t', realFn)).toThrow('CHECK constraint');
    expect(realFn).toHaveBeenCalledTimes(1);

    const busyFn = vi.fn(() => { throw busy(); });
    expect(() => withBusyRetrySync('t', busyFn, { attempts: 4 })).toThrow('database is locked');
    expect(busyFn).toHaveBeenCalledTimes(4);
  });
});
