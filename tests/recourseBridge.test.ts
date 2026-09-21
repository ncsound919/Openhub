import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const startSupervision = vi.fn();
vi.mock('../src/services/supervisor', () => ({
  startSupervision: (...args: unknown[]) => startSupervision(...args),
}));

import { dispatchRecourseRepair, recourseContextForGoal, recordRecourseOutcome } from '../src/services/recourseBridge';
import { listEvents } from '../src/services/telemetry';

let dir: string;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhub-bridge-'));
  vi.stubEnv('OPENHUB_TELEMETRY_DIR', dir);
  vi.stubEnv('RECOURSE_API_SECRET', 'secret');
  startSupervision.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('recourseContextForGoal', () => {
  it('composes recall hits and synergy domains (nested map shape)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/memory/recall')) return json({ success: true, hits: [{ id: 'l1', kind: 'lesson', text: 'gate before apply' }] });
      if (url.includes('/synergy/map')) return json({ success: true, map: { domains: ['math', 'coding'] } });
      return json({});
    }));
    const ctx = await recourseContextForGoal('build a verified platformer', { topK: 3 });
    expect(ctx.available).toBe(true);
    expect(ctx.hits[0].text).toBe('gate before apply');
    expect(ctx.synergy?.domains).toEqual(['math', 'coding']);
    expect(ctx.context).toContain('gate before apply');
    expect(ctx.context).toContain('math');
  });

  it('requires a goal', async () => {
    const ctx = await recourseContextForGoal('   ');
    expect(ctx.available).toBe(false);
    expect(ctx.error).toContain('goal');
  });
});

describe('recordRecourseOutcome', () => {
  it('writes through the guarded fleet-memory intake and records telemetry', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain('/api/recourse/fleet/memory');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer secret');
      expect(JSON.parse(String(init?.body)).source).toBe('openhub-insights');
      return json({ success: true, indexed: 1 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const r = await recordRecourseOutcome({ goal: 'raise pass rate', status: 'accepted' });
    expect(r.available).toBe(true);
    const events = listEvents({ system: 'recourse' });
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('outcome-write');
  });

  it('is fail-closed without a secret', async () => {
    vi.stubEnv('RECOURSE_API_SECRET', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const r = await recordRecourseOutcome({ goal: 'x' });
    expect(r.available).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('dispatchRecourseRepair', () => {
  it('turns a findings dossier into a supervised loop and records telemetry', async () => {
    startSupervision.mockResolvedValue({ id: 'run_1', status: 'looping', loopId: 'loop_1', goal: 'g', targetDir: 'C:/proj' });
    const run = await dispatchRecourseRepair({
      targetDir: 'C:/proj',
      findings: [{ file: 'a.gd', line: 3, severity: 'high', title: 'parse error', suggestion: 'fix extends' }],
      correlationId: 'cid-9',
    });
    expect(run.id).toBe('run_1');
    const call = startSupervision.mock.calls[0][0];
    expect(call.targetDir).toBe('C:/proj');
    expect(call.goal).toContain('a.gd:3');
    expect(call.goal).toContain('parse error');
    expect(call.maxIterations).toBe(6);

    const events = listEvents({ system: 'recourse' });
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('bridge-dispatch');
    expect(events[0].correlationId).toBe('cid-9');
  });

  it('requires a targetDir', async () => {
    await expect(dispatchRecourseRepair({ targetDir: '' })).rejects.toThrow(/targetDir/);
  });
});
