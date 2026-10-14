import { describe, expect, it } from 'vitest';
import {
  peerSpecs,
  httpJson,
  routeTarget,
  routeDecision,
  fleetState,
  learnFromFleet,
} from '../src/services/fleetInterconnect';

const CLOSED = 'http://127.0.0.1:9';

describe('peerSpecs', () => {
  it('defaults every peer to a base URL and reuses fleet env overrides', () => {
    const specs = peerSpecs({ RECOURSE_URL: 'http://localhost:3050' });
    expect(specs.map((s) => s.id)).toEqual(['recourse', 'devBrain', 'axiom', 'draymond', 'keywire']);
    expect(specs[0].baseUrl).toBe('http://localhost:3050');
    // Keywire moved to :4700 (Phase-0 fix); :3000 is Grafana on this host.
    expect(specs[4].baseUrl).toBe('http://127.0.0.1:4700');
  });
});

describe('routeTarget', () => {
  it('routes each decision domain to the right engine', () => {
    expect(routeTarget('repair').engine).toBe('axiom');
    expect(routeTarget('repair').path).toBe('/api/jev/repair');
    expect(routeTarget('code').engine).toBe('axiom');
    expect(routeTarget('daily').engine).toBe('draymond');
    expect(routeTarget('cron').engine).toBe('draymond');
    expect(routeTarget('learning').engine).toBe('draymond');
    expect(routeTarget('growth').engine).toBe('recourse');
    expect(routeTarget('strategy').engine).toBe('recourse');
    expect(routeTarget('reasoning').engine).toBe('devBrain');
    expect(routeTarget('matrix').path).toBe('/api/decide/jev');
    expect(routeTarget('review').engine).toBe('local');
  });
});

describe('httpJson', () => {
  it('reports honestly when a peer is unreachable', async () => {
    const r = await httpJson(CLOSED, '/api/status', { timeoutMs: 2000 });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
    expect(r.error).toBeTruthy();
  });
});

describe('routeDecision', () => {
  it('handles local domains without a network call', async () => {
    const r = await routeDecision('review', { fileCount: 1 });
    expect(r.routedTo).toBe('local');
    expect(r.engine).toBe('OpenHub');
    expect(r.available).toBe(true);
  });

  it('routes growth to Recourse and reports unavailable honestly when down', async () => {
    const r = await routeDecision('growth', {}, { RECOURSE_URL: CLOSED, DEV_BRAIN_URL: CLOSED, AXIOM_URL: CLOSED, DRAYMOND_URL: CLOSED, KEYWIRE_URL: CLOSED });
    expect(r.routedTo).toBe('recourse');
    expect(r.available).toBe(false);
    expect(r.error).toBeTruthy();
  });
});

describe('fleetState', () => {
  it('reports every peer offline without fabricating when none are reachable', async () => {
    const state = await fleetState({ RECOURSE_URL: CLOSED, DEV_BRAIN_URL: CLOSED, AXIOM_URL: CLOSED, DRAYMOND_URL: CLOSED, KEYWIRE_URL: CLOSED });
    expect(state.online).toBe(false);
    expect(state.peers).toHaveLength(5);
    expect(state.peers.every((p) => p.online === false)).toBe(true);
  });
});

describe('learnFromFleet', () => {
  it('reports honestly when Recourse is unreachable', async () => {
    const result = await learnFromFleet(
      { kind: 'lesson', id: 'l1', text: 'never retry flaky jobs 3x', runEpisode: false },
      { RECOURSE_URL: CLOSED, RECOURSE_API_SECRET: 'x' },
    );
    expect(result.memory.ok).toBe(false);
    expect(result.episode).toBeNull();
  });
});