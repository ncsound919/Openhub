import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  normalizeRecallHits,
  normalizeRegistryTools,
  normalizeSynergyMap,
  normalizeAgendaNext,
  recourseMemoryRecall,
  recourseMemoryIndex,
  recourseRegistry,
} from '../src/services/recourseClient';

function okJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('normalizeRecallHits', () => {
  it('unwraps the Recourse {hits:[{id,kind,text,score}]} shape', () => {
    const hits = normalizeRecallHits({
      success: true,
      hits: [
        { id: 'gene:x', kind: 'gene', text: 'a probe', score: 0.9 },
        { id: 'lesson:y', kind: 'lesson', text: 'a lesson' },
      ],
    });
    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({ id: 'gene:x', kind: 'gene', text: 'a probe', score: 0.9 });
    expect(hits[1].text).toBe('a lesson');
  });

  it('tolerates results/matches/array shapes and drops entries without text', () => {
    expect(normalizeRecallHits({ results: [{ content: 'from results' }] })[0].text).toBe('from results');
    expect(normalizeRecallHits({ matches: [{ summary: 'from matches' }] })[0].text).toBe('from matches');
    expect(normalizeRecallHits([{ text: 'plain' }])[0].text).toBe('plain');
    expect(normalizeRecallHits({ hits: [{ id: 'empty' }] })).toEqual([]);
    expect(normalizeRecallHits(null)).toEqual([]);
  });
});

describe('normalizeRegistryTools', () => {
  it('projects the current promoted version and self-host flag', () => {
    const tools = normalizeRegistryTools({
      registry: [
        {
          name: 'bloomFilter',
          domain: 'coding',
          currentVersion: '2',
          entrypoint: '.selfhosted/tools/bloomFilter.mjs',
          healthStatus: 'healthy',
          versions: [
            { version: '1', score: 0.5, passed_verifier: true },
            { version: '2', score: 0.91, passed_verifier: true },
          ],
        },
      ],
    });
    expect(tools).toHaveLength(1);
    expect(tools[0]).toEqual({
      name: 'bloomFilter', domain: 'coding', version: '2', score: 0.91,
      passed: true, selfHosted: true, health: 'healthy',
    });
  });

  it('returns [] for unknown shapes and skips nameless entries', () => {
    expect(normalizeRegistryTools(null)).toEqual([]);
    expect(normalizeRegistryTools({ registry: [{ domain: 'coding' }] })).toEqual([]);
  });
});

describe('normalizeSynergyMap', () => {
  it('unwraps the nested `map` object (the real Recourse shape)', () => {
    const view = normalizeSynergyMap({
      success: true,
      map: { domains: ['math', 'oncology'], edges: [{ from: 'math', to: 'oncology' }], candidates: [{ domain: 'math' }] },
    });
    expect(view.domains).toEqual(['math', 'oncology']);
    expect(view.edges).toHaveLength(1);
    expect(view.candidates).toHaveLength(1);
  });

  it('tolerates a flat map and unknown shapes', () => {
    expect(normalizeSynergyMap({ domains: ['x'] }).domains).toEqual(['x']);
    expect(normalizeSynergyMap(null).domains).toEqual([]);
  });
});

describe('normalizeAgendaNext', () => {
  it('resolves nextMath/nextOncology milestones', () => {
    const view = normalizeAgendaNext({
      success: true,
      nextMath: { milestone: { id: 'prove-1' }, rationale: 'unlock coverage', statusReport: { status: 'active' } },
      nextOncology: { milestone: 'trial-x', rationale: 'evidence' },
    });
    expect(view.math).toEqual({ title: 'prove-1', rationale: 'unlock coverage', status: 'active' });
    expect(view.oncology?.title).toBe('trial-x');
  });

  it('returns {} for null/absent heads', () => {
    expect(normalizeAgendaNext({ success: true, nextMath: null, nextOncology: null })).toEqual({});
    expect(normalizeAgendaNext(null)).toEqual({});
  });
});

describe('recourseMemoryRecall', () => {
  it('sends the query as `q` with optional kind/topK and reports availability', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain('/api/recourse/memory/recall?');
      expect(url).toContain('q=bloom');
      expect(url).toContain('kind=gene');
      expect(url).toContain('topK=3');
      return okJson({ success: true, hits: [] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const r = await recourseMemoryRecall('bloom', { kind: 'gene', topK: 3 });
    expect(r.available).toBe(true);
    expect(r.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports unavailable with the error when the host is down', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const r = await recourseMemoryRecall('anything');
    expect(r.available).toBe(false);
    expect(r.error).toContain('ECONNREFUSED');
  });
});

describe('recourseMemoryIndex', () => {
  it('is fail-closed when RECOURSE_API_SECRET is unset', async () => {
    vi.stubEnv('RECOURSE_API_SECRET', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const r = await recourseMemoryIndex({ source: 'axiom-loop' });
    expect(r.available).toBe(false);
    expect(r.error).toContain('fail-closed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('writes external outcomes to the fleet-memory intake (not the body-ignoring index route)', async () => {
    vi.stubEnv('RECOURSE_API_SECRET', 'test-secret');
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('http://localhost:3050/api/recourse/fleet/memory');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body));
      expect(body.source).toBe('axiom-loop');
      expect(body.goal).toBe('build x');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer test-secret');
      return okJson({ success: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    const r = await recourseMemoryIndex({ source: 'axiom-loop', goal: 'build x' });
    expect(r.available).toBe(true);
  });
});

describe('recourseRegistry', () => {
  it('flags unavailable when Recourse answers non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })));
    const r = await recourseRegistry();
    expect(r.available).toBe(false);
    expect(r.status).toBe(503);
  });
});
