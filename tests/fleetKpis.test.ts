import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { loadKpis, createFleetKpisRouter } from '../src/routes/fleetKpis';

describe('loadKpis (fleet brain KPIs)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-kpis-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('parses treasury.json and system-goals.json with real fleet shapes', () => {
    fs.writeFileSync(
      path.join(tmp, 'treasury.json'),
      JSON.stringify(
        {
          revenueCents: 3845000,
          lastPulseAt: '2026-04-12T18:04:00.000Z',
          currency: 'USD',
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      path.join(tmp, 'system-goals.json'),
      JSON.stringify(
        {
          goals: [
            {
              id: 'uplift-health',
              domain: 'Uplift Health',
              title: 'Reach $33k monthly recurring revenue',
              weight: 1,
              status: 'active',
            },
            {
              id: 'fleet-stability',
              domain: 'Infrastructure',
              title: 'Keep the fleet stable',
              status: 'in_progress',
            },
          ],
        },
        null,
        2,
      ),
    );

    const kpis = loadKpis({ OPENHUB_DRAYMOND_DIR: tmp });

    expect(kpis.configured).toBe(true);
    expect(kpis.dir).toBe(tmp);
    expect(kpis.source).toBe('live');

    expect(kpis.treasury?.revenueCents).toBe(3845000);
    expect(kpis.treasury?.revenueUSD).toBe(38450);
    expect(kpis.treasury?.lastPulseAt).toBe('2026-04-12T18:04:00.000Z');

    expect(kpis.goals).toHaveLength(2);
    expect(kpis.goals[0]).toEqual({
      id: 'uplift-health',
      domain: 'Uplift Health',
      title: 'Reach $33k monthly recurring revenue',
      weight: 1,
      status: 'active',
    });
    // Absent weight stays null — never an invented number.
    expect(kpis.goals[1].weight).toBeNull();
    expect(kpis.goals[1].status).toBe('in_progress');
    expect(kpis.goals[1].domain).toBe('Infrastructure');
  });

  it('normalizes object-wrapped and keyed brain files (heartbeats + recaps)', () => {
    fs.writeFileSync(
      path.join(tmp, 'heartbeats.json'),
      JSON.stringify(
        {
          'agent-treasury': {
            agentId: 'agent-treasury',
            status: 'online',
            lastSeen: '2026-04-12T18:05:00.000Z',
          },
          'agent-github': {
            agentId: 'agent-github',
            status: 'idle',
            lastSeen: '2026-04-12T18:04:00.000Z',
          },
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      path.join(tmp, 'recaps.json'),
      JSON.stringify(
        {
          recaps: [
            {
              id: 'recap-1',
              agentId: 'openhub',
              action: 'pipeline.run.finalized',
              details: 'run-7 took 84s',
              userId: 'user-42',
              createdAt: '2026-04-12T18:03:00.000Z',
            },
          ],
        },
        null,
        2,
      ),
    );

    const kpis = loadKpis({ OPENHUB_DRAYMOND_DIR: tmp });

    expect(kpis.heartbeats).toHaveLength(2);
    const firstHeartbeat = kpis.heartbeats[0] as Record<string, unknown>;
    expect(firstHeartbeat.agentId).toBe('agent-treasury');

    expect(kpis.recaps).toHaveLength(1);
    const recap = kpis.recaps[0] as Record<string, unknown>;
    expect(recap.action).toBe('pipeline.run.finalized');
    expect(recap.userId).toBe('user-42');
  });

  it('degrades to { configured: false, source: "degraded" } with no throw when the dir is missing', () => {
    const missing = path.join(tmp, 'no-such-dir');

    expect(() => loadKpis({ OPENHUB_DRAYMOND_DIR: missing })).not.toThrow();

    const kpis = loadKpis({ OPENHUB_DRAYMOND_DIR: missing });
    expect(kpis.configured).toBe(false);
    expect(kpis.dir).toBeNull();
    expect(kpis.source).toBe('degraded');
    expect(typeof kpis.error).toBe('string');
    expect(kpis.treasury).toBeNull();
    expect(kpis.goals).toEqual([]);
    expect(kpis.heartbeats).toEqual([]);
    expect(kpis.recaps).toEqual([]);
  });

  it('degrades per-field on corrupt treasury but still reads goals (loud error, no throw)', () => {
    fs.writeFileSync(path.join(tmp, 'treasury.json'), '{ not-json !!!', 'utf-8');
    fs.writeFileSync(
      path.join(tmp, 'system-goals.json'),
      JSON.stringify({ goals: [{ id: 'g-1', title: 'Keep the pulse' }] }, null, 2),
    );

    const kpis = loadKpis({ OPENHUB_DRAYMOND_DIR: tmp });

    expect(kpis.source).toBe('live');
    expect(kpis.configured).toBe(true);
    expect(kpis.treasury).toBeNull();
    expect(kpis.goals).toHaveLength(1);
    expect(kpis.goals[0].id).toBe('g-1');
    expect(kpis.goals[0].domain).toBeNull();
    expect(kpis.goals[0].weight).toBeNull();
    expect(typeof kpis.error).toBe('string');
    expect(kpis.error).toContain('treasury.json');
  });

  it('prefers OPENHUB_DRAYMOND_DIR over the ecosystem-root fallback', () => {
    const ecoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ecosystem-root-'));
    const fallbackDraymond = path.join(ecoRoot, 'Draymond-Orchestrator', '.draymond');
    fs.mkdirSync(fallbackDraymond, { recursive: true });
    fs.writeFileSync(
      path.join(fallbackDraymond, 'treasury.json'),
      JSON.stringify({ revenueCents: 100 }, null, 2),
    );
    fs.writeFileSync(
      path.join(tmp, 'treasury.json'),
      JSON.stringify({ revenueCents: 9900, lastPulseAt: '2026-04-12T00:00:00.000Z' }, null, 2),
    );

    try {
      const kpis = loadKpis({ OPENHUB_DRAYMOND_DIR: tmp, OPENHUB_ECOSYSTEM_ROOT: ecoRoot });
      expect(kpis.dir).toBe(tmp);
      expect(kpis.treasury?.revenueCents).toBe(9900);
      expect(kpis.treasury?.revenueUSD).toBe(99);
      expect(kpis.treasury?.lastPulseAt).toBe('2026-04-12T00:00:00.000Z');
    } finally {
      fs.rmSync(ecoRoot, { recursive: true, force: true });
    }
  });

  it('registers GET /ecosystem/kpis behind the provided auth middleware', async () => {
    const previous = process.env.OPENHUB_DRAYMOND_DIR;
    process.env.OPENHUB_DRAYMOND_DIR = tmp;
    try {
      const applied: string[] = [];
      const app = express();
      app.use(
        '/api',
        createFleetKpisRouter({
          authMiddleware: (
            _req: express.Request,
            _res: express.Response,
            next: express.NextFunction,
          ) => {
            applied.push('auth');
            next();
          },
        }),
      );

      const res = await request(app).get('/api/ecosystem/kpis');

      expect(res.status).toBe(200);
      expect(applied).toEqual(['auth']);
      expect(res.body.configured).toBe(true);
      expect(res.body.dir).toBe(tmp);
      expect(res.body.source).toBe('live');
    } finally {
      if (previous === undefined) {
        delete process.env.OPENHUB_DRAYMOND_DIR;
      } else {
        process.env.OPENHUB_DRAYMOND_DIR = previous;
      }
    }
  });
});