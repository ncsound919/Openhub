import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import path from 'node:path';
import { initializeDatabase } from '../src/auth/db.js';
import {
  SEED_ENTITIES,
  DEPLOY_WEIGHTS,
  deployabilityPercent,
  gradeFor,
  listRegistry,
  getRegistryEntry,
  refreshRegistry,
  auditRegistry,
  auditEntityLive,
  resolveAuditDir,
  summarizeRegistry,
  clearRegistry,
  type DeployFactors,
  type EcosystemEntity,
} from '../src/services/ecosystemRegistry.js';
import type { ScorerResult } from '../src/services/evidence.js';
import type { FleetCapabilitiesSnapshot } from '../src/services/capabilityProbe.js';
import { createEcosystemRegistryRouter } from '../src/routes/ecosystemRegistryRoutes.js';

function factors(partial: Partial<DeployFactors>): DeployFactors {
  return { deployed: false, buildable: false, verified: false, versionControlled: false, integrated: false, documented: false, ...partial };
}

const fakeSnapshot: FleetCapabilitiesSnapshot = {
  probedAt: '2026-09-19T00:00:00.000Z',
  cached: false,
  ttlMs: 20_000,
  summary: { total: 2, online: 1, degraded: 0, offline: 1 },
  bridges: [
    {
      slug: 'axiom', name: 'Axiom Coding Harness', category: 'core', status: 'online',
      latencyMs: 3, lastChecked: '2026-09-19T00:00:00.000Z', operations: [],
      transport: 'http', endpoint: 'http://127.0.0.1:3198/api/health', version: '2.0.0',
    },
    {
      slug: 'reporank', name: 'RepoRank', category: 'audit', status: 'offline', reason: 'connection refused',
      latencyMs: 2, lastChecked: '2026-09-19T00:00:00.000Z', operations: [],
      transport: 'http', endpoint: 'http://127.0.0.1:3200/health',
    },
  ],
};

describe('ecosystemRegistry — rubric', () => {
  it('weights sum to 100', () => {
    expect(Object.values(DEPLOY_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('scores all-true to 100 and all-false to 0', () => {
    expect(deployabilityPercent(factors({ deployed: true, buildable: true, verified: true, versionControlled: true, integrated: true, documented: true }))).toBe(100);
    expect(deployabilityPercent(factors({}))).toBe(0);
  });

  it('scores a partial factor set deterministically', () => {
    // deployed(25) + verified(20) + versionControlled(20) = 65
    expect(deployabilityPercent(factors({ deployed: true, verified: true, versionControlled: true }))).toBe(65);
  });

  it('maps scores to letter grades', () => {
    expect(gradeFor(95)).toBe('A');
    expect(gradeFor(85)).toBe('B');
    expect(gradeFor(72)).toBe('C');
    expect(gradeFor(61)).toBe('D');
    expect(gradeFor(20)).toBe('F');
  });
});

describe('ecosystemRegistry — seed', () => {
  it('has unique ids and complete required fields', () => {
    const ids = new Set<string>();
    for (const e of SEED_ENTITIES) {
      expect(ids.has(e.id)).toBe(false);
      ids.add(e.id);
      expect(['service', 'tool', 'project', 'pack']).toContain(e.kind);
      expect(e.purpose.length).toBeGreaterThan(10);
      expect(Array.isArray(e.stack)).toBe(true);
      expect(e.factors).toBeTruthy();
    }
    expect(SEED_ENTITIES.length).toBeGreaterThanOrEqual(30);
  });

  it('preserves repo, stack and tags from the seed', () => {
    const axiom = SEED_ENTITIES.find((e) => e.id === 'axiom')!;
    expect(axiom.repo).toBe('Axiom Agent');
    expect(axiom.stack).toContain('TypeScript');
    expect(axiom.tags).toContain('coding-loop');
  });

  it('never invents an audit score without a source', () => {
    for (const e of SEED_ENTITIES) {
      if (e.auditScore !== null) {
        expect(e.auditSource).not.toBe('not-yet-ranked');
        expect(e.auditScore).toBeGreaterThanOrEqual(0);
        expect(e.auditScore).toBeLessThanOrEqual(100);
      } else {
        expect(e.auditSource).toBe('not-yet-ranked');
      }
    }
  });
});

describe('ecosystemRegistry — query', () => {
  beforeEach(() => {
    initializeDatabase();
    clearRegistry();
  });

  it('lists entries with computed deployability and an ordered ranking', () => {
    const snapshot = listRegistry({});
    expect(snapshot.entries.length).toBeGreaterThan(0);
    for (const e of snapshot.entries) {
      expect(e.deployability).toBe(deployabilityPercent(e.factors));
    }
    expect(snapshot.totals.total).toBe(snapshot.entries.length);
    for (let i = 1; i < snapshot.ranking.length; i++) {
      expect(snapshot.ranking[i - 1].auditScore).toBeGreaterThanOrEqual(snapshot.ranking[i].auditScore);
    }
    expect(typeof summarizeRegistry(snapshot)).toBe('string');
  });

  it('filters by kind, search, and minimum deployability', () => {
    const services = listRegistry({ kind: 'service' });
    expect(services.entries.length).toBeGreaterThan(0);
    for (const e of services.entries) expect(e.kind).toBe('service');

    const hit = listRegistry({ search: 'keywire' });
    expect(hit.entries.some((e) => e.id === 'keywire')).toBe(true);

    const high = listRegistry({ minDeployability: 80 });
    for (const e of high.entries) expect(e.deployability).toBeGreaterThanOrEqual(80);
  });

  it('returns a single entry by id, or null', () => {
    expect(getRegistryEntry('axiom')?.name).toBe('Axiom Coding Harness');
    expect(getRegistryEntry('nope')).toBeNull();
  });
});

describe('ecosystemRegistry — live refresh', () => {
  beforeEach(() => {
    initializeDatabase();
    clearRegistry();
  });

  afterAll(() => {
    clearRegistry();
  });

  it('applies probe health, recomputes deployability, and persists it', async () => {
    const before = getRegistryEntry('reporank')!;
    expect(before.health).toBe('unknown');

    const snapshot = await refreshRegistry({ probe: async () => fakeSnapshot });
    const axiom = snapshot.entries.find((e) => e.id === 'axiom')!;
    const reporank = snapshot.entries.find((e) => e.id === 'reporank')!;

    expect(axiom.health).toBe('online');
    expect(axiom.factors.deployed).toBe(true);
    expect(axiom.deployability).toBe(deployabilityPercent(axiom.factors));

    expect(reporank.health).toBe('offline');
    expect(reporank.factors.deployed).toBe(false);
    expect(reporank.deployability).toBeLessThan(before.deployability);

    // The refresh is persisted, so a plain read sees it without re-probing.
    expect(getRegistryEntry('reporank')?.health).toBe('offline');
    expect(getRegistryEntry('axiom')?.health).toBe('online');
    // A bridge elided from the probe result stays honestly 'unknown'.
    expect(getRegistryEntry('mutly')?.health).toBe('unknown');
  });

  it('degrades honestly when the probe throws', async () => {
    const snapshot = await refreshRegistry({ probe: async () => { throw new Error('probe offline'); } });
    expect(snapshot.probedAt).toBeNull();
    expect(snapshot.entries.every((e) => e.health === 'unknown')).toBe(true);
  });
});

describe('ecosystemRegistry — live audit scoring', () => {
  beforeEach(() => {
    initializeDatabase();
    clearRegistry();
  });

  afterAll(() => {
    clearRegistry();
  });

  const scorer = (name: string, score: number | null, extra: Partial<ScorerResult> = {}): ScorerResult =>
    ({ scorer: name, score, summary: extra.summary ?? `${name} ran`, ...extra } as ScorerResult);

  function synthetic(): EcosystemEntity {
    return {
      id: 'synthetic', name: 'Synthetic', kind: 'tool', pillar: 'test', stack: [], purpose: 'test entity',
      repo: null, port: null, url: null, bridge: null, tags: [], auditScore: null, auditGrade: null,
      auditSource: 'not-yet-ranked', auditAt: null, auditRepo: 'owner/repo', auditDir: 'C:/tmp/proj',
      factors: deployabilityBase(), blockers: [], evidence: [],
    };
  }

  function deployabilityBase(): DeployFactors {
    return { deployed: true, buildable: true, verified: false, versionControlled: true, integrated: false, documented: false };
  }

  it('resolves a relative auditDir under UPLIFT_ROOT and passes absolute dirs through', () => {
    const e = synthetic();
    expect(resolveAuditDir({ ...e, auditDir: 'C:/abs/proj' }, {})).toBe('C:/abs/proj');
    expect(resolveAuditDir({ ...e, auditDir: 'sub/proj' }, { UPLIFT_ROOT: 'C:/root' })).toBe(path.join('C:/root', 'sub/proj'));
    expect(resolveAuditDir({ ...e, auditDir: 'sub/proj' }, {})).toBeNull();
  });

  it('runs RepoRank, Grader and The Deep and averages the real scores', async () => {
    const live = await auditEntityLive(synthetic(), {
      reporank: async () => scorer('reporank', 80),
      grader: async () => scorer('grader', 60),
      deep: async () => scorer('deep', 100),
    });
    expect(live.sources).toEqual(['reporank', 'grader', 'deep']);
    expect(live.score).toBe(80); // (80 + 60 + 100) / 3
    expect(live.grade).toBe('B');
    expect(live.outcomes.filter((o) => o.status === 'ok')).toHaveLength(3);
  });

  it('records unavailable scorers without letting them dilute the score', async () => {
    const live = await auditEntityLive(synthetic(), {
      reporank: async () => { throw new Error('reporank unreachable'); },
      grader: async () => scorer('grader', 70),
      deep: async () => scorer('deep', null, { status: 'unavailable', error: 'DEEP_URL not set' }),
    });
    expect(live.sources).toEqual(['grader']);
    expect(live.score).toBe(70);
    const reporank = live.outcomes.find((o) => o.scorer === 'reporank')!;
    expect(reporank.status).toBe('unavailable');
    expect(reporank.error).toContain('unreachable');
    expect(live.outcomes.find((o) => o.scorer === 'deep')?.score).toBeNull();
  });

  it('persists live scores and marks the source as live', async () => {
    const before = getRegistryEntry('reporank')!;
    expect(before.auditSource).not.toMatch(/^live:/);

    const result = await auditRegistry({
      ids: ['reporank'],
      deps: { reporank: async () => scorer('reporank', 88) },
    });
    expect(result.audited).toHaveLength(1);
    expect(result.audited[0].score).toBe(88);

    const after = getRegistryEntry('reporank')!;
    expect(after.auditScore).toBe(88);
    expect(after.auditGrade).toBe('B');
    expect(after.auditSource).toBe('live:reporank');
    expect(after.auditOutcomes).toHaveLength(1);
    expect(after.auditLiveAt).toBe(result.auditedAt);
  });

  it('skips entities without a live audit target, with a reason', async () => {
    const result = await auditRegistry({ ids: ['keywire'], deps: {} });
    expect(result.audited).toHaveLength(0);
    expect(result.skipped[0].id).toBe('keywire');
    expect(result.skipped[0].reason).toContain('no live audit target');
  });

  it('refresh(audit:true) keeps health and adds live audit scores', async () => {
    const prevRoot = process.env.UPLIFT_ROOT;
    process.env.UPLIFT_ROOT = 'C:/root';
    try {
      const snapshot = await refreshRegistry({
        probe: async () => fakeSnapshot,
        audit: true,
        auditIds: ['axiom', 'reporank'],
        auditDeps: {
          reporank: async () => scorer('reporank', 75),
          deep: async () => scorer('deep', 95),
        },
      });
      const axiom = snapshot.entries.find((e) => e.id === 'axiom')!;
      expect(axiom.health).toBe('online');
      expect(axiom.auditScore).toBe(95); // deep only (no grader/reporank target for axiom)
      expect(axiom.auditSource).toBe('live:deep');
      const reporank = snapshot.entries.find((e) => e.id === 'reporank')!;
      expect(reporank.health).toBe('offline');
      expect(reporank.auditScore).toBe(75);
    } finally {
      if (prevRoot === undefined) delete process.env.UPLIFT_ROOT;
      else process.env.UPLIFT_ROOT = prevRoot;
    }
  });
});

describe('ecosystemRegistry router', () => {
  beforeEach(() => {
    initializeDatabase();
    clearRegistry();
  });

  function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/api', createEcosystemRegistryRouter({ authMiddleware: (_req, _res, next) => next() }));
    return app;
  }

  it('GET /api/ecosystem/registry returns the catalog', async () => {
    const res = await request(makeApp()).get('/api/ecosystem/registry');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.entries.length).toBeGreaterThan(0);
    expect(res.body.totals.total).toBeGreaterThan(0);
    expect(Array.isArray(res.body.ranking)).toBe(true);
  });

  it('GET /api/ecosystem/registry/summary returns totals + ranking', async () => {
    const res = await request(makeApp()).get('/api/ecosystem/registry/summary');
    expect(res.status).toBe(200);
    expect(res.body.totals.total).toBeGreaterThan(0);
    expect(res.body.summary).toContain('Ecosystem registry');
  });

  it('GET /api/ecosystem/registry/:id 404s on an unknown entity', async () => {
    const res = await request(makeApp()).get('/api/ecosystem/registry/not-a-real-entity');
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
  });
});
