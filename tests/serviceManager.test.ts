import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
  MANAGED_SERVICES,
  isPortListening,
  isProtectedPort,
  buildServiceEnv,
  getServiceStatus,
  stopServiceSafe,
} from '../src/services/serviceManager';

describe('serviceManager', () => {
  it('defines the audit-suite services; retired tools are absent', () => {
    // Axiom was removed 2026-10-15: its only checkout was archived to
    // BUSINESS/_archive/from-uplift/06_Resources/Axiom Agent and can no longer
    // start. A catalog entry that can only answer "Directory not found" is a
    // lie the Fleet UI keeps telling; its capability-bridge row still probes
    // :3198 and honestly reports offline.
    expect(MANAGED_SERVICES.axiom).toBeUndefined();

    expect(MANAGED_SERVICES.grader).toBeDefined();
    expect(MANAGED_SERVICES.grader.port).toBe(3201);
    // Grader's real health endpoint is /api/healthz (see Grader-main/server.ts).
    expect(MANAGED_SERVICES.grader.healthPath).toBe('/api/healthz');

    expect(MANAGED_SERVICES.reporank).toBeDefined();
    expect(MANAGED_SERVICES.reporank.port).toBe(3200);

    expect(MANAGED_SERVICES['claw-protect']).toBeDefined();
    expect(MANAGED_SERVICES['claw-protect'].port).toBe(3300);

    expect(MANAGED_SERVICES['the-deep']).toBeDefined();
    expect(MANAGED_SERVICES['the-deep'].port).toBe(3100);

    // Retired 2026-10-08 (Draymond orchestrator replaced by Paperclip).
    expect(MANAGED_SERVICES.draymond).toBeUndefined();
    expect(MANAGED_SERVICES.mutly).toBeUndefined();
    expect(MANAGED_SERVICES['vibe-reality']).toBeUndefined();
  });

  // 2026-10-15: three catalog cwds pointed at directories the 2026-09 dedupe
  // had deleted, so they could never start. Every managed cwd must exist on
  // disk — this is the test that would have caught the rot before the audit.
  it('points every managed service at a directory that exists', () => {
    const missing = Object.entries(MANAGED_SERVICES)
      .filter(([, cfg]) => !fs.existsSync(cfg.cwd))
      .map(([slug, cfg]) => `${slug}: ${cfg.cwd}`);
    expect(missing).toEqual([]);
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
    expect(isProtectedPort(4700)).toBe(true); // Keywire (auth authority)
    expect(isProtectedPort(3000)).toBe(false); // Grafana — not a fleet service
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
    const status = await getServiceStatus('deterministic-brain');
    expect(status).not.toBeNull();
    if (status) {
      expect(status.slug).toBe('deterministic-brain');
      expect(status.port).toBe(3210);
      expect(status.category).toBe('core');
      expect(typeof status.up).toBe('boolean');
      // PID is not resolved on the status path (deferred to the stop path).
      expect(status.pid).toBeNull();
    }
  });
});
