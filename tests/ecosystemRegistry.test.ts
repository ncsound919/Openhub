import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
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
        expect(e.auditSource).not.toMatch(/^seed-unverified/);
        expect(e.auditScore).toBeGreaterThanOrEqual(0);
        expect(e.auditScore).toBeLessThanOrEqual(100);
      } else {
        // Two honest nulls: never ranked, and ranked-but-unverifiable. Both
        // carry no score; only the second keeps its claimed citation in
        // `evidence` so a future run can re-derive it.
        expect(e.auditSource === 'not-yet-ranked' || /^seed-unverified \(original: .+\)$/.test(e.auditSource)).toBe(true);
      }
    }
  });

  // 2026-10-15 audit: every Uplift-era report the seed cited was absent from
  // disk (the tree moved in the 2026-09 dedupe), and four pack scores cited a
  // test file that produces no scores at all. A score nothing can check is not
  // evidence, so entity() demotes them — and these tests pin the demotion so a
  // later session cannot re-add an unverifiable number to look complete.
  describe('provenance gate (seed-unverified)', () => {
    it('demotes a score whose cited report is not on disk', () => {
      const reporank = SEED_ENTITIES.find((e) => e.id === 'reporank')!;
      expect(reporank.auditScore).toBeNull();
      expect(reporank.auditSource).toMatch(/^seed-unverified \(original: reports\//);
      // The original citation survives in evidence — demoted, not erased.
      expect(reporank.evidence.some((ev) => ev.includes('2026-08-16-agentops-readiness-matrix'))).toBe(true);
    });

    it('demotes the two entries that cited ecosystemKnowledge.test.ts', () => {
      // ecosystem-skills (85) and get-shit-done (80). That test is the
      // Ecosystem-folder indexer, pointed at an absent folder; it produces no
      // scores, so it can never be an audit source for anything.
      for (const id of ['ecosystem-skills', 'get-shit-done']) {
        const e = SEED_ENTITIES.find((x) => x.id === id)!;
        expect(e.auditScore, `${id} must not carry an unverifiable score`).toBeNull();
        expect(e.auditSource).toContain('ecosystemKnowledge.test.ts');
      }
    });

    it('demotes the six entries citing AXIOM_FLEET_INTEGRATION.md phases', () => {
      for (const id of ['dev-brain', 'recourse', 'ecosystem-agents', 'ecosystem-commands', 'ecosystem-plugins', 'ecosystem-rules']) {
        const e = SEED_ENTITIES.find((x) => x.id === id)!;
        expect(e.auditScore, `${id} must not carry an unverifiable score`).toBeNull();
        expect(e.auditSource).toContain('AXIOM_FLEET_INTEGRATION.md Phase');
      }
    });

    it('keeps a score that a live audit actually produced', () => {
      // Negative control: the gate must only demote unverifiable sources, or
      // it becomes a scoring floor. `live:*` rows come from real audit runs.
      const live = SEED_ENTITIES.find((e) => /^live:/.test(e.auditSource));
      if (live) {
        expect(live.auditScore).not.toBeNull();
        expect(live.auditGrade).not.toBeNull();
      }
    });

    it('still honestly nulls not-yet-ranked entities without inventing an unverified label', () => {
      const jarvis = SEED_ENTITIES.find((e) => e.id === 'jarvis')!;
      expect(jarvis.auditScore).toBeNull();
      expect(jarvis.auditSource).toBe('not-yet-ranked');
    });
  });

  // The Jarvis entry is the one whose port cannot be taken at face value: the
  // port its own config declares is held by an unrelated process, so declaring
  // it here would have produced a URL that answers for something else. These
  // assertions exist so a later session cannot "fix" the blank port by filling
  // it in.
  describe('jarvis (OpenJarvis)', () => {
    const jarvis = () => SEED_ENTITIES.find((e) => e.id === 'jarvis')!;

    it('is registered as a platform service wired to its bridge', () => {
      expect(jarvis()).toBeTruthy();
      expect(jarvis().kind).toBe('service');
      expect(jarvis().bridge).toBe('jarvis');
      expect(jarvis().tags).toContain('voice');
    });

    it('declares no port, and therefore no url that could answer for another process', () => {
      expect(jarvis().port).toBeNull();
      expect(jarvis().url).toBeNull();
    });

    it('carries both a local audit dir and the canonical upstream repo', () => {
      expect(jarvis().auditDir).toBe('C:/Users/User/AppData/Local/OpenJarvis/src');
      expect(jarvis().auditRepo).toBe('open-jarvis/OpenJarvis');
      expect(resolveAuditDir(jarvis())).toBe(jarvis().auditDir);
    });

    it('is honestly unranked rather than seeded with a number', () => {
      expect(jarvis().auditScore).toBeNull();
      expect(jarvis().auditSource).toBe('not-yet-ranked');
    });

    it('records its blockers rather than hiding them', () => {
      expect(jarvis().blockers.length).toBeGreaterThanOrEqual(3);
      expect(jarvis().blockers.join(' ')).toMatch(/8000/);
    });
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

  // 2026-10-15: the summary printed "health online 4" with no timestamp, so a
  // persisted overlay read as a live probe (only one port was actually
  // listening). The summary now names the probe time or its absence.
  it('the summary names when health was probed, or that it never was', () => {
    const snapshot = listRegistry({});
    const summary = summarizeRegistry(snapshot);
    expect(summary).toMatch(/\((health as of .+|health never probed)\)$/);
    expect(snapshot.totals.healthAsOf).toBe(snapshot.entries
      .map((e) => e.healthCheckedAt)
      .filter((t): t is string => Boolean(t))
      .sort()
      .at(-1) ?? null);
  });

  it('filters by kind, search, and minimum deployability', () => {
    const services = listRegistry({ kind: 'service' });
    expect(services.entries.length).toBeGreaterThan(0);
    for (const e of services.entries) expect(e.kind).toBe('service');

    const hit = listRegistry({ search: 'infisical' });
    expect(hit.entries.some((e) => e.id === 'infisical')).toBe(true);

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
  // A REAL directory, created once for the block.
  //
  // The fixture used to be `auditDir: 'C:/tmp/proj'`, which does not exist. That
  // let the block assert "runs RepoRank, Grader and The Deep" while The Deep was
  // being handed a path with nothing behind it — a test that passed by asserting
  // a scorer was called on a fiction. It is the same shape as the registry's own
  // path rot: a configured target that was never real.
  const REAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-registry-'));

  beforeAll(() => {
    fs.mkdirSync(REAL_DIR, { recursive: true });
  });

  afterAll(() => {
    clearRegistry();
    fs.rmSync(REAL_DIR, { recursive: true, force: true });
  });

  beforeEach(() => {
    initializeDatabase();
    clearRegistry();
  });

  const scorer = (name: string, score: number | null, extra: Partial<ScorerResult> = {}): ScorerResult =>
    ({ scorer: name, score, summary: extra.summary ?? `${name} ran`, ...extra } as ScorerResult);

  function synthetic(auditDir: string = REAL_DIR): EcosystemEntity {
    return {
      id: 'synthetic', name: 'Synthetic', kind: 'tool', pillar: 'test', stack: [], purpose: 'test entity',
      repo: null, port: null, url: null, bridge: null, tags: [], auditScore: null, auditGrade: null,
      auditSource: 'not-yet-ranked', auditAt: null, auditRepo: 'owner/repo', auditDir,
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
    const result = await auditRegistry({ ids: ['infisical'], deps: {} });
    expect(result.audited).toHaveLength(0);
    expect(result.skipped[0].id).toBe('infisical');
    expect(result.skipped[0].reason).toContain('no live audit target');
  });

  it('refresh(audit:true) keeps health and adds live audit scores', async () => {
    // Health comes from `fakeSnapshot`, which only knows the slugs 'axiom' and
    // 'reporank' — so those two are asserted for health. The exact audit SCORES
    // are asserted on `deterministic-brain` and `mutly`, which have an
    // `auditRepo` and NO `auditDir`, so only the repo scorers run.
    //
    // The previous version asserted 95 for axiom and 75 for reporank. Both
    // numbers depended on the real fleet layout: axiom's auditDir is relative
    // and reporank's is absolute, so whether The Deep ran — and therefore
    // whether reporank averaged 75 or (75+95)/2 = 85 — depended on which
    // directories happened to exist on the machine running the test. That is a
    // test asserting a fiction, which is how it came to disagree with the code.
    const prevRoot = process.env.UPLIFT_ROOT;
    // A root that does not exist, so no relative auditDir can resolve.
    process.env.UPLIFT_ROOT = path.join(REAL_DIR, 'no-such-root');
    try {
      const snapshot = await refreshRegistry({
        probe: async () => fakeSnapshot,
        audit: true,
        auditIds: ['axiom', 'reporank', 'deterministic-brain', 'mutly'],
        auditDeps: {
          reporank: async () => scorer('reporank', 75),
          deep: async () => scorer('deep', 95),
        },
      });
      const byId = (id: string) => snapshot.entries.find((e) => e.id === id)!;

      // Health is preserved from the probe, unchanged by auditing.
      expect(byId('axiom').health).toBe('online');
      expect(byId('reporank').health).toBe('offline');

      // Repo-only entities: RepoRank answered 75, so that is the live score.
      expect(byId('deterministic-brain').auditScore).toBe(75);
      expect(byId('deterministic-brain').auditSource).toBe('live:reporank');
      expect(byId('mutly').auditScore).toBe(75);

      // axiom's local target cannot resolve under a root that is not there, so
      // The Deep is skipped rather than called against a missing path — and the
      // seeded score stands instead of a fabricated live one.
      expect(byId('axiom').auditSource).not.toMatch(/^live:/);
    } finally {
      if (prevRoot === undefined) delete process.env.UPLIFT_ROOT;
      else process.env.UPLIFT_ROOT = prevRoot;
    }
  });

  it('skips The Deep and records the path when a configured auditDir is gone', async () => {
    // The rot case. It used to call the scorer against a missing directory,
    // which returned `unavailable` while `auditSource` still read `live:deep` —
    // a live audit that examined nothing. 15 of 22 registry entries were in
    // this state on 2026-10-05.
    let called = false;
    const live = await auditEntityLive(synthetic(path.join(REAL_DIR, 'gone')), {
      reporank: async () => scorer('reporank', 80),
      deep: async () => { called = true; return scorer('deep', 100); },
    });
    expect(called).toBe(false);
    expect(live.sources).toEqual(['reporank']);
    const deep = live.outcomes.find((o) => o.scorer === 'deep')!;
    expect(deep.status).toBe('unavailable');
    expect(deep.score).toBeNull();
    // The reason has to name the path, or it is not fixable from the report.
    expect(deep.error).toContain('path rot');
    expect(deep.error).toContain('gone');
  });

  it('still calls The Deep when the configured auditDir exists', async () => {
    // The counterpart: the skip must not fire on a good path.
    let calledWith: string | null = null;
    const live = await auditEntityLive(synthetic(REAL_DIR), {
      reporank: async () => scorer('reporank', 80),
      deep: async (dir) => { calledWith = dir; return scorer('deep', 100); },
    });
    expect(calledWith).toBe(REAL_DIR);
    expect(live.sources).toContain('deep');
    expect(live.score).toBe(90);
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
