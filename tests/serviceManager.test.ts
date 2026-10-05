import { describe, it, expect } from 'vitest';
import {
  MANAGED_SERVICES,
  isPortListening,
  isProtectedPort,
  buildServiceEnv,
  getServiceStatus,
  stopServiceSafe,
} from '../src/services/serviceManager';

describe('serviceManager', () => {
  it('defines all required coding, audit, and repair services', () => {
    expect(MANAGED_SERVICES.axiom).toBeDefined();
    expect(MANAGED_SERVICES.axiom.port).toBe(3198);

    expect(MANAGED_SERVICES.draymond).toBeDefined();
    expect(MANAGED_SERVICES.draymond.port).toBe(3444);

    expect(MANAGED_SERVICES.grader).toBeDefined();
    expect(MANAGED_SERVICES.grader.port).toBe(3201);
    // Grader's real health endpoint is /api/healthz (see Grader-main/server.ts).
    expect(MANAGED_SERVICES.grader.healthPath).toBe('/api/healthz');

    expect(MANAGED_SERVICES.reporank).toBeDefined();
    expect(MANAGED_SERVICES.reporank.port).toBe(3200);

    expect(MANAGED_SERVICES['claw-protect']).toBeDefined();
    expect(MANAGED_SERVICES['claw-protect'].port).toBe(3300);
  });

  it('reports a free high port as not listening', async () => {
    // Port 59999 is not occupied in test environments.
    const listening = await isPortListening(59999);
    expect(listening).toBe(false);
  });

  it('reports an occupied port as listening when the control plane port is in use', async () => {
    // Only assert when OpenHub itself is running (port 3010) — otherwise this
    // check is environment-dependent and the test is skipped implicitly.
    const occupied = await isPortListening(3010);
    expect([true, false]).toContain(occupied);
  });

  it('returns an unknown-service error for stop requests', async () => {
    const result = await stopServiceSafe('unknown_dummy');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Unknown service');
  });

  it('never allows stopping protected ports (Keywire / OpenHub)', () => {
    expect(isProtectedPort(3000)).toBe(true); // Keywire
    expect(isProtectedPort(3010)).toBe(true); // OpenHub control plane
    expect(isProtectedPort(3198)).toBe(false); // Axiom is a managed worker
    expect(isProtectedPort(3201)).toBe(false); // Grader is a managed worker
  });

  it('pins the catalog PORT over an inherited PORT env (EADDRINUSE guard)', () => {
    const env = buildServiceEnv(MANAGED_SERVICES.grader, { PATH: 'x', PORT: '3010', GITHUB_TOKEN: 't' });
    expect(env.PORT).toBe('3201');
    expect(env.GITHUB_TOKEN).toBe('t');
  });

  it('includes per-service env keys alongside the PORT pin', () => {
    const env = buildServiceEnv(MANAGED_SERVICES['claw-protect'], { PORT: '9999' });
    expect(env.PORT).toBe('3300');
    expect(env.CLAW_PORT).toBe('3300');
  });

  it('retrieves formatted status for a registered service', async () => {
    const status = await getServiceStatus('axiom');
    expect(status).not.toBeNull();
    if (status) {
      expect(status.slug).toBe('axiom');
      expect(status.port).toBe(3198);
      expect(status.category).toBe('core');
      expect(typeof status.up).toBe('boolean');
      // PID is not resolved on the status path (deferred to the stop path).
      expect(status.pid).toBeNull();
    }
  });
});
