import { describe, it, expect } from 'vitest';
import { ensureCapability, resolveCapability, onDemandEnabled } from '../src/services/serviceGateway.js';

describe('serviceGateway', () => {
  it('resolves aliases and raw slugs', () => {
    expect(resolveCapability('sca')).toBe('claw-protect');
    expect(resolveCapability('deep')).toBe('the-deep');
    expect(resolveCapability('reporank')).toBe('reporank');
    expect(resolveCapability('nope')).toBeNull();
  });

  it('onDemandEnabled is false by default and true only for truthy flags', () => {
    expect(onDemandEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(onDemandEnabled({ OPENHUB_ONDEMAND_SERVICES: '0' } as NodeJS.ProcessEnv)).toBe(false);
    expect(onDemandEnabled({ OPENHUB_ONDEMAND_SERVICES: '1' } as NodeJS.ProcessEnv)).toBe(true);
    expect(onDemandEnabled({ OPENHUB_ONDEMAND_SERVICES: 'true' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('returns available without starting when already up', async () => {
    let started = false;
    const r = await ensureCapability('reporank', {
      env: {} as NodeJS.ProcessEnv,
      probe: async () => true,
      start: async () => { started = true; return { ok: true, message: '' }; },
      touch: () => {},
    });
    expect(r.available).toBe(true);
    expect(r.alreadyUp).toBe(true);
    expect(started).toBe(false);
  });

  it('does not start when down and on-demand is disabled', async () => {
    let started = false;
    const r = await ensureCapability('reporank', {
      env: {} as NodeJS.ProcessEnv,
      probe: async () => false,
      start: async () => { started = true; return { ok: true, message: '' }; },
    });
    expect(r.available).toBe(false);
    expect(r.attempted).toBe(false);
    expect(started).toBe(false);
    expect(r.reason).toMatch(/disabled/);
  });

  it('starts and re-probes when on-demand is enabled', async () => {
    let calls = 0;
    const r = await ensureCapability('grader', {
      env: { OPENHUB_ONDEMAND_SERVICES: '1' } as NodeJS.ProcessEnv,
      probe: async () => { calls += 1; return calls > 1; },
      start: async () => ({ ok: true, message: 'started' }),
      touch: () => {},
    });
    expect(r.available).toBe(true);
    expect(r.attempted).toBe(true);
    expect(r.started).toBe(true);
  });

  it('reports the real reason when the start fails', async () => {
    const r = await ensureCapability('deep', {
      env: { OPENHUB_ONDEMAND_SERVICES: '1' } as NodeJS.ProcessEnv,
      probe: async () => false,
      start: async () => ({ ok: false, message: 'Directory not found: X' }),
    });
    expect(r.available).toBe(false);
    expect(r.reason).toContain('Directory not found');
  });

  it('an unknown capability is an honest failure, not a fabricated success', async () => {
    const r = await ensureCapability('does-not-exist', { env: {} as NodeJS.ProcessEnv });
    expect(r.available).toBe(false);
    expect(r.slug).toBeNull();
    expect(r.reason).toMatch(/unknown capability/);
  });
});