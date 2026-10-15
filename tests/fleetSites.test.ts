// fleetSites.test.ts — the local site inventory (re-homed from Keywire).
// Three honesty contracts: a missing/malformed inventory says so instead of
// reading as "no sites"; unprobed states are `unknown`, never `up`; and
// `allUp` is false whenever anything is down OR unknown.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fleetSites, loadSiteInventory, siteInventoryFile } from '../src/services/fleetSites.js';

const tmp: string[] = [];
function writeInventory(content: string, name = `sites-${Math.random().toString(36).slice(2)}.json`): string {
  const file = path.join(os.tmpdir(), name);
  fs.writeFileSync(file, content);
  tmp.push(file);
  return file;
}
afterEach(() => {
  for (const f of tmp.splice(0)) fs.rmSync(f, { force: true });
});

const INVENTORY = JSON.stringify({
  version: 1,
  updatedAt: '2026-09-16T15:36:40.000Z',
  sites: [
    { id: 'overlay365', name: 'Overlay365 Hub', tier: 'critical', publicUrl: 'https://overlay365.com' },
    { id: 'health', name: 'Uplift Health', tier: 'critical', publicUrl: 'https://uplift-health.vercel.app' },
    { id: 'wealth', name: 'Uplift Wealth', tier: 'high' }, // no publicUrl
  ],
});

describe('loadSiteInventory', () => {
  it('reads the local inventory with every site state unknown and allUp false', () => {
    const file = writeInventory(INVENTORY);
    const r = loadSiteInventory({ OPENHUB_SITES_FILE: file } as NodeJS.ProcessEnv);
    expect(r.available).toBe(true);
    expect(r.data?.source).toBe('local');
    expect(r.data?.sites.map((s) => s.id)).toEqual(['overlay365', 'health', 'wealth']);
    expect(r.data?.sites.every((s) => s.state === 'unknown')).toBe(true);
    expect(r.data?.summary).toMatchObject({ total: 3, up: 0, down: 0, unknown: 3, allUp: false });
  });

  it('a missing inventory reports the reason — not an empty list', () => {
    const r = loadSiteInventory({ OPENHUB_SITES_FILE: path.join(os.tmpdir(), 'definitely-missing-sites.json') } as NodeJS.ProcessEnv);
    expect(r.available).toBe(false);
    expect(r.error).toMatch(/unreadable/);
    expect(r.data).toBeUndefined();
  });

  it('malformed JSON reports the reason and does not throw', () => {
    const file = writeInventory('{ not json');
    const r = loadSiteInventory({ OPENHUB_SITES_FILE: file } as NodeJS.ProcessEnv);
    expect(r.available).toBe(false);
    expect(r.error).toMatch(/not valid JSON/);
  });

  it('a file without sites[] is refused rather than treated as empty', () => {
    const file = writeInventory('{"version":1}');
    const r = loadSiteInventory({ OPENHUB_SITES_FILE: file } as NodeJS.ProcessEnv);
    expect(r.available).toBe(false);
    expect(r.error).toMatch(/no sites\[\]/);
  });

  it('defaults to the repo data path', () => {
    expect(siteInventoryFile({} as NodeJS.ProcessEnv).replace(/\\/g, '/')).toMatch(/openhub\/data\/ecosystem-sites\.json$/);
  });
});

describe('fleetSites', () => {
  it('without probe: nothing is claimed up', async () => {
    const file = writeInventory(INVENTORY);
    const r = await fleetSites({ OPENHUB_SITES_FILE: file } as NodeJS.ProcessEnv);
    expect(r.data?.probed).toBe(false);
    expect(r.data?.summary.up).toBe(0);
    expect(r.data?.summary.allUp).toBe(false);
    expect(r.data?.summary.criticalAttention).toEqual([]); // no check ran, so no claim
  });

  it('with probe: real states, honest summary, and critical attention', async () => {
    const file = writeInventory(INVENTORY);
    const fakeFetch = (async (url: string) => {
      if (String(url).includes('overlay365')) return new Response('ok', { status: 200 });
      return new Response('nope', { status: 503 });
    }) as unknown as typeof fetch;
    const r = await fleetSites({ OPENHUB_SITES_FILE: file } as NodeJS.ProcessEnv, { probe: true, fetchImpl: fakeFetch });
    const byId = Object.fromEntries((r.data?.sites ?? []).map((s) => [s.id, s]));
    expect(byId.overlay365.state).toBe('up');
    expect(byId.overlay365.status).toBe(200);
    expect(byId.health.state).toBe('down');
    expect(byId.wealth.state).toBe('unknown'); // no publicUrl -> never probed
    expect(r.data?.summary).toMatchObject({ total: 3, up: 1, down: 1, unknown: 1, allUp: false });
    expect(r.data?.summary.criticalAttention).toEqual(['health']); // critical and not up
  });

  it('NEGATIVE CONTROL: allUp only when every site was proven up', async () => {
    const file = writeInventory(JSON.stringify({ version: 1, updatedAt: 'now', sites: [{ id: 'a', name: 'A', publicUrl: 'https://a.test' }] }));
    const ok = (async () => new Response('ok', { status: 200 })) as unknown as typeof fetch;
    const r = await fleetSites({ OPENHUB_SITES_FILE: file } as NodeJS.ProcessEnv, { probe: true, fetchImpl: ok });
    expect(r.data?.summary.allUp).toBe(true);
    // Now the same inventory with one unknown site must NOT read allUp.
    const file2 = writeInventory(JSON.stringify({ version: 1, updatedAt: 'now', sites: [{ id: 'a', name: 'A', publicUrl: 'https://a.test' }, { id: 'b', name: 'B' }] }));
    const r2 = await fleetSites({ OPENHUB_SITES_FILE: file2 } as NodeJS.ProcessEnv, { probe: true, fetchImpl: ok });
    expect(r2.data?.summary.allUp).toBe(false);
  });
});

describe('re-homed: the shipped inventory is local, Keywire-independent', () => {
  it('resolves the repo inventory with Keywire pointed at a dead port', async () => {
    // The whole point of the move: this must work with Keywire unreachable.
    const r = await fleetSites({ OPENHUB_KEYWIRE_URL: 'http://127.0.0.1:1', KEYWIRE_URL: 'http://127.0.0.1:1' } as NodeJS.ProcessEnv);
    expect(r.available).toBe(true);
    expect(r.data?.source).toBe('local');
    expect((r.data?.sites.length ?? 0)).toBeGreaterThanOrEqual(1);
    expect(r.data?.sites.some((s) => s.id === 'overlay365')).toBe(true);
    expect(r.data?.summary.allUp).toBe(false); // nothing was probed
  });
});
