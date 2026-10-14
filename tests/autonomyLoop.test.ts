import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAutonomyLoop, type AutonomyDeps, type AutonomySnapshot } from '../src/services/autonomyLoop';
import { createAutonomyRouter } from '../src/routes/autonomy';

function baseDeps(overrides: Partial<AutonomyDeps> = {}): AutonomyDeps {
  return {
    gatherServices: async () => [
      { slug: 'axiom', name: 'Axiom', port: 3198, up: true, category: 'core' },
      { slug: 'gamemaker', name: 'Game Maker', port: 3012, up: false, category: 'game' },
    ],
    gatherInsights: async () => ({
      generatedAt: '2026-01-01T00:00:00.000Z',
      available: true,
      trends: {},
      insights: [{ id: 'pass-rate-low' }],
      synergy: { available: true, domains: ['math'], edges: [], candidates: [] },
      autonomy: { available: true, agenda: {}, learn: null, dream: null, suggestedActions: [] },
      sources: { telemetry: { available: true }, recourse: { available: true } },
    } as any),
    summarize: () => ({
      total: 2, bySystem: {}, byKind: {}, byOutcome: { accepted: 1, rejected: 1 },
      bySeverity: { high: 1 }, passRate: 0.5, windowMs: 1000, since: '2026-01-01T00:00:00.000Z',
    }),
    resumeStuck: async () => 2,
    emit: vi.fn(),
    persist: vi.fn(),
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('autonomy loop', () => {
  it('produces a complete snapshot with health derived from all sources', async () => {
    const persisted: AutonomySnapshot[] = [];
    const loop = createAutonomyLoop(baseDeps({ persist: (s) => persisted.push(s) }));
    const snap = await loop.runTick();

    expect(snap.tick).toBe(1);
    expect(snap.generatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(snap.health.servicesUp).toBe(1);
    expect(snap.health.servicesTotal).toBe(2);
    expect(snap.health.recourseOnline).toBe(true);
    expect(snap.health.highSeverityEvents).toBe(1);
    expect(snap.health.insightCount).toBe(1);
    expect(snap.health.passRate).toBe(0.5);
    expect(snap.resumedRuns).toBe(2);
    expect(snap.degraded).toEqual([]);
    expect(persisted).toHaveLength(1);
    expect(loop.getState()?.tick).toBe(1);
  });

  it('records degraded sources instead of fabricating success', async () => {
    const loop = createAutonomyLoop(baseDeps({
      gatherInsights: async () => {
        throw new Error('recourse down');
      },
      gatherServices: async () => {
        throw new Error('probe failed');
      },
    }));
    const snap = await loop.runTick();
    expect(snap.degraded).toContain('services');
    expect(snap.degraded).toContain('insights');
    expect(snap.degraded).toContain('recourse');
    expect(snap.insights).toBeNull();
    expect(snap.health.recourseOnline).toBe(false);
  });

  it('notifies subscribers on each tick', async () => {
    const loop = createAutonomyLoop(baseDeps());
    const seen: number[] = [];
    const unsub = loop.subscribe((s) => seen.push(s.tick));
    await loop.runTick();
    await loop.runTick();
    unsub();
    await loop.runTick();
    expect(seen).toEqual([1, 2]);
  });

  it('start is idempotent and stop halts the heartbeat', async () => {
    const loop = createAutonomyLoop(baseDeps());
    loop.start(10_000_000);
    expect(loop.isRunning()).toBe(true);
    loop.start(10_000_000); // no-op
    loop.stop();
    expect(loop.isRunning()).toBe(false);
  });
});

describe('autonomy router', () => {
  const fakeLoop = {
    getState: () => ({ tick: 1 } as any),
    runTick: async () => ({ tick: 2 } as any),
    subscribe: () => () => {},
    start: () => {},
    stop: () => {},
    isRunning: () => true,
  };

  function app() {
    const instance = express();
    instance.use(express.json());
    instance.use('/api', createAutonomyRouter({ authMiddleware: (_req, _res, next) => next(), loop: fakeLoop }));
    return instance;
  }

  it('serves the current snapshot and forces a tick on demand', async () => {
    const state = await request(app()).get('/api/autonomy/state');
    expect(state.status).toBe(200);
    expect(state.body.snapshot.tick).toBe(1);

    const tick = await request(app()).post('/api/autonomy/tick');
    expect(tick.status).toBe(200);
    expect(tick.body.snapshot.tick).toBe(2);
  });
});
