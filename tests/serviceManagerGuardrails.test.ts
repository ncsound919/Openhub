import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearActiveProcesses,
  getRunningServicesCount,
  isProtectedPort,
  MAX_CONCURRENT_SERVICES,
  touchServiceActivity,
  getLastActivity,
  reapIdleServices,
} from '../src/services/serviceManager';

describe('Service Lifecycle Guardrails (C4)', () => {
  beforeEach(() => {
    clearActiveProcesses();
  });

  it('protects Keywire (3000) and OpenHub (3010) from being killed', () => {
    expect(isProtectedPort(3000)).toBe(true);
    expect(isProtectedPort(3010)).toBe(true);
    expect(isProtectedPort(3198)).toBe(false);
    expect(isProtectedPort(3201)).toBe(false);
  });

  it('tracks concurrency and exposes max limit', () => {
    expect(MAX_CONCURRENT_SERVICES).toBeGreaterThanOrEqual(1);
    expect(getRunningServicesCount()).toBe(0);
  });

  it('tracks idle activity timestamps and supports touch', () => {
    expect(getLastActivity('axiom')).toBeUndefined();
    touchServiceActivity('axiom');
    const ts = getLastActivity('axiom');
    expect(ts).toBeDefined();
    expect(ts).toBeCloseTo(Date.now(), -3);
  });

  it('reapIdleServices safely runs without active processes', async () => {
    const reaped = await reapIdleServices(1000);
    expect(reaped).toEqual([]);
  });
});
