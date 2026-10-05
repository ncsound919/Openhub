import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { buildInsights } from '../src/services/insights';
import { recordEvent } from '../src/services/telemetry';
import { recordEpisode } from '../src/services/selfLearning';
import { createInsightsRouter } from '../src/routes/insights';

let dir: string;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const RECOURSE_RESPONSES: Record<string, unknown> = {
  '/api/recourse/status': { status: 'alive', generation: 7 },
  '/api/recourse/synergy/map': {
    success: true,
    map: { domains: ['math', 'oncology'], edges: [{ from: 'math', to: 'oncology' }], candidates: [{ domain: 'math', method: 'bloom' }] },
  },
  '/api/recourse/agenda/next': { success: true, nextMath: { milestone: { id: 'prove-theorem-1' }, rationale: 'unlocks domain coverage' }, nextOncology: null },
  '/api/recourse/learn/status': { success: true, state: { selfScore: 0.72, calibrationError: 0.1, geneCount: 5, directives: ['keep gates strict'] } },
  '/api/recourse/dream/status': { success: true, dreamState: { phase: 'idle', cycles: 3 } },
};

function stubRecourse(overrides: Record<string, unknown> = {}) {
  const table: Record<string, unknown> = { ...RECOURSE_RESPONSES, ...overrides };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    for (const [suffix, body] of Object.entries(table)) {
      if (url.includes(suffix)) {
        if (body === 'offline') return new Response('down', { status: 503 });
        return json(body);
      }
    }
    return json({});
  }));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhub-insights-'));
  vi.stubEnv('OPENHUB_TELEMETRY_DIR', dir);
  vi.stubEnv('OPENHUB_SELFLEARNING_DIR', path.join(dir, 'self'));
  vi.stubEnv('RECOURSE_API_SECRET', 'secret');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('buildInsights', () => {
  it('computes trends and flags a low verified pass rate', async () => {
    stubRecourse();
    for (let i = 0; i < 3; i += 1) recordEvent({ system: 'supervisor', kind: 'run-complete', outcome: 'rejected', severity: 'high' });
    recordEvent({ system: 'supervisor', kind: 'run-complete', outcome: 'accepted' });

    const report = await buildInsights();
    expect(report.trends.total).toBe(4);
    expect(report.trends.passRate).toBeCloseTo(0.25, 5);
    expect(report.insights.some((i) => i.id === 'pass-rate-low')).toBe(true);
    expect(report.insights.some((i) => i.id === 'high-severity-events')).toBe(true);
    expect(report.sources.recourse.available).toBe(true);
  });

  it('normalizes the nested synergy map and agenda-next milestones', async () => {
    stubRecourse();
    const report = await buildInsights();
    expect(report.synergy.domains).toEqual(['math', 'oncology']);
    expect(report.synergy.candidates).toHaveLength(1);
    expect(report.autonomy.agenda.math?.title).toBe('prove-theorem-1');
    expect(report.autonomy.learn?.selfScore).toBe(0.72);
    expect(report.autonomy.suggestedActions.some((a) => a.id === 'agenda-math')).toBe(true);
  });

  it('reports Recourse offline honestly and still computes local trends', async () => {
    stubRecourse({
      '/api/recourse/status': 'offline',
      '/api/recourse/synergy/map': 'offline',
      '/api/recourse/learn/status': 'offline',
      '/api/recourse/dream/status': 'offline',
      '/api/recourse/agenda/next': 'offline',
    });
    recordEvent({ system: 'axiom', kind: 'loop-start' });
    const report = await buildInsights();
    expect(report.sources.recourse.available).toBe(false);
    expect(report.insights.some((i) => i.id === 'recourse-offline')).toBe(true);
    expect(report.trends.total).toBe(1);
  });

  it('surfaces self-learning lessons, calibration, and trend deltas', async () => {
    stubRecourse();
    // Self-learning: a consistently failing skill over several outcomes.
    for (let i = 0; i < 5; i += 1) recordEpisode({ kind: 'supervision', outcome: 'rejected', skills: ['WeakTool'] });

    const report = await buildInsights();
    expect(report.learning.skills.some((s) => s.name === 'WeakTool')).toBe(true);
    expect(report.learning.calibration.sampleSize).toBe(5);
    expect(report.insights.some((i) => i.id === 'learn:skill-weak:WeakTool')).toBe(true);
    expect(report.insights.some((i) => i.id === 'calibration')).toBe(true);
    // Trend deltas are always present (0/None when no prior window).
    expect(typeof report.trends.totalDelta).toBe('number');
    expect(report.trends).toHaveProperty('passRateDelta');
    expect(report.trends).toHaveProperty('highSeverityDelta');
  });
});

describe('insights router', () => {
  function app() {
    const instance = express();
    instance.use(express.json());
    instance.use('/api', createInsightsRouter({ authMiddleware: (_req, _res, next) => next() }));
    return instance;
  }

  it('serves the report and validates the bridge context query', async () => {
    stubRecourse();
    const report = await request(app()).get('/api/insights');
    expect(report.status).toBe(200);
    expect(report.body.ok).toBe(true);
    expect(Array.isArray(report.body.report.insights)).toBe(true);

    const missing = await request(app()).get('/api/recourse/bridge/context');
    expect(missing.status).toBe(400);
  });

  it('serves a normalized synergy map', async () => {
    stubRecourse();
    const res = await request(app()).get('/api/insights/synergy');
    expect(res.status).toBe(200);
    expect(res.body.domains).toEqual(['math', 'oncology']);
  });

  it('requires targetDir to dispatch a Recourse repair', async () => {
    stubRecourse();
    const res = await request(app()).post('/api/recourse/bridge/dispatch').send({ goal: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('targetDir');
  });
});
