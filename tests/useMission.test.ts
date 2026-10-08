// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseEventFrame,
  normalizeFileDiff,
  normalizeTodos,
  fetchDiff,
  fetchTodos,
  revertLastStep,
  subscribeMission,
  sessionToMission,
  isTopLevelSession,
  normalizeSessionTelemetry,
} from '../src/mission/useMission.js';
import type { MissionEvent } from '../src/lib/missionStore.js';

afterEach(() => vi.unstubAllGlobals());

function jsonRes(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** An SSE body that emits the given frames then closes (a clean end). */
function sseBody(frames: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
}

/** Enqueue the frame JSON for an event and terminate it with a blank line. */
function frame(obj: Record<string, unknown>): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/** Run subscribeMission against a mock stream and collect its callbacks. */
async function runSubscribe(frames: string[]): Promise<{ events: MissionEvent[]; ends: string[]; errors: string[] }> {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(sseBody(frames), { status: 200 })));
  const events: MissionEvent[] = [];
  const ends: string[] = [];
  const errors: string[] = [];
  const cleanup = subscribeMission(
    'ses_1',
    (e) => events.push(e),
    (m) => errors.push(m),
    (r) => ends.push(r),
  );
  // Give the async reader loop a chance to drain the closed stream.
  await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 20));
  cleanup();
  return { events, ends, errors };
}


describe('parseEventFrame', () => {
  it('parses a session-scoped text event', () => {
    const e = parseEventFrame(JSON.stringify({ type: 'session.updated.1', sessionID: 'ses_1', data: { text: 'hello' } }));
    expect(e?.kind).toBe('session.updated');
    expect(e?.text).toBe('hello');
  });
  it('reads sessionID from properties', () => {
    const e = parseEventFrame(JSON.stringify({ type: 'message.part.updated', properties: { sessionID: 'ses_2', text: 'x' } }));
    expect(e?.kind).toBe('message.part.updated');
  });
  it('reads sessionID nested under properties.info, and title as text', () => {
    const e = parseEventFrame(JSON.stringify({
      type: 'message.updated.1',
      properties: { info: { sessionID: 'ses_nested', title: 'planning' } },
    }));
    expect(e?.sessionId).toBe('ses_nested');
    expect(e?.text).toBe('planning');
  });
  it('reads sessionID nested under properties.part and part text', () => {
    const e = parseEventFrame(JSON.stringify({
      type: 'message.part.updated',
      properties: { part: { sessionID: 'ses_part', text: 'chunk' } },
    }));
    expect(e?.sessionId).toBe('ses_part');
    expect(e?.text).toBe('chunk');
  });
  it('reads sessionID from properties.info.id fallback', () => {
    const e = parseEventFrame(JSON.stringify({
      type: 'message.updated',
      properties: { info: { id: 'ses_id' } },
    }));
    expect(e?.sessionId).toBe('ses_id');
  });
  it('returns null on garbage', () => {
    expect(parseEventFrame('not json')).toBeNull();
    expect(parseEventFrame('')).toBeNull();
  });
});

describe('diff/todo normalization', () => {
  it('reads path/file, additions, deletions, patch and status defensively', () => {
    const out = normalizeFileDiff([
      { file: 'a.ts', additions: 2, deletions: 5, patch: '@@', status: 'added' },
      { path: 'b.ts' },
      { nope: true },
      null,
      'not-an-object',
    ]);
    expect(out).toEqual([
      { path: 'a.ts', additions: 2, deletions: 5, patch: '@@', status: 'added' },
      { path: 'b.ts' },
    ]);
  });

  it('accepts a { diffs: [...] } wrapper and degrades non-arrays to []', () => {
    expect(normalizeFileDiff({ diffs: [{ path: 'c.ts' }] })).toEqual([{ path: 'c.ts' }]);
    expect(normalizeFileDiff(undefined)).toEqual([]);
    expect(normalizeFileDiff({ weird: true })).toEqual([]);
  });

  it('reads content/status/priority and skips content-less todos', () => {
    expect(normalizeTodos([
      { content: 'write tests', status: 'in_progress', priority: 'high' },
      { text: 'ship' },
      { nope: true },
    ])).toEqual([
      { content: 'write tests', status: 'in_progress', priority: 'high' },
      { content: 'ship' },
    ]);
    expect(normalizeTodos({ todos: [{ content: 'x' }] })).toEqual([{ content: 'x' }]);
  });
});

describe('fetchDiff / fetchTodos / revertLastStep', () => {
  it('fetchDiff unwraps the envelope and normalizes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ ok: true, data: [{ path: 'z.ts', additions: 1, deletions: 0 }] })));
    await expect(fetchDiff('ses_1')).resolves.toEqual([{ path: 'z.ts', additions: 1, deletions: 0 }]);
  });

  it('fetchTodos unwraps the envelope and normalizes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ ok: true, data: [{ content: 'do it', status: 'pending' }] })));
    await expect(fetchTodos('ses_1')).resolves.toEqual([{ content: 'do it', status: 'pending' }]);
  });

  it('throws a clear error when there is no message to revert', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ ok: true, data: [] })));
    await expect(revertLastStep('ses_1')).rejects.toThrow('no message to revert');
  });

  it('reverts the last message by its id and returns the engine result', async () => {
    const fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) => {
      if (String(url).includes('/messages')) return jsonRes({ ok: true, data: [{ info: { id: 'msg_1' } }] });
      return jsonRes({ ok: true, data: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(revertLastStep('ses_1')).resolves.toBe(true);
    const revertCall = fetchMock.mock.calls.find(([u]) => String(u).includes('/revert'));
    expect(revertCall).toBeTruthy();
    expect(JSON.parse(String(revertCall![1]?.body))).toEqual({ messageID: 'msg_1' });
  });
});

describe('subscribeMission terminal events', () => {
  it('calls onEnd(done) exactly once for session.idle, even with repeats', async () => {
    const { events, ends, errors } = await runSubscribe([
      frame({ type: 'session.updated.1', sessionID: 'ses_1', data: { text: 'working' } }),
      frame({ type: 'session.idle', sessionID: 'ses_1' }),
      frame({ type: 'session.idle', sessionID: 'ses_1' }),
    ]);
    expect(ends).toEqual(['done']);
    expect(errors).toEqual([]);
    expect(events.map((e) => e.text)).toContain('working');
  });

  it('treats session.completed as done too', async () => {
    const { ends } = await runSubscribe([frame({ type: 'session.completed', sessionID: 'ses_1' })]);
    expect(ends).toEqual(['done']);
  });

  it('calls onEnd(failed) for session.error', async () => {
    const { ends, errors } = await runSubscribe([frame({ type: 'session.error', sessionID: 'ses_1' })]);
    expect(ends).toEqual(['failed']);
    expect(errors).toEqual([]);
  });

  it('ignores a terminal event for a different session', async () => {
    const { ends } = await runSubscribe([frame({ type: 'session.idle', sessionID: 'ses_other' })]);
    expect(ends).toEqual([]);
  });
});

describe('sessionToMission defaults', () => {
  it('defaults an unknown status to the neutral planned and omits createdAt when absent', () => {
    const m = sessionToMission({ id: 'ses_x', title: 'a session', status: 'weird' });
    expect(m).not.toBeNull();
    expect(m!.status).toBe('planned');
    expect(m!.createdAt).toBeUndefined();
    expect(m!.goal).toBe('a session');
  });

  it('keeps a known status and parses a provided timestamp', () => {
    const m = sessionToMission({ id: 'ses_y', status: 'running', time: { created: 1_700_000_000_000 } });
    expect(m!.status).toBe('running');
    expect(m!.createdAt).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it('returns null without an id', () => {
    expect(sessionToMission({ title: 'no id' })).toBeNull();
    expect(sessionToMission(null)).toBeNull();
  });
});

describe('parseEventFrame permissions', () => {
  it('extracts a pending permission from permission.updated', () => {
    const ev = parseEventFrame(JSON.stringify({
      type: 'permission.updated',
      properties: { id: 'per_1', sessionID: 'ses_1', type: 'bash', title: 'Run: rm -rf build' },
    })) as unknown as { sessionId?: string; permission?: { id: string; title: string; type: string } };
    expect(ev.sessionId).toBe('ses_1');
    expect(ev.permission).toEqual({ id: 'per_1', title: 'Run: rm -rf build', type: 'bash' });
  });
  it('ignores a permission event without an id and reads permission.replied', () => {
    const none = parseEventFrame(JSON.stringify({ type: 'permission.updated', properties: { sessionID: 's' } })) as unknown as { permission?: unknown };
    expect(none.permission).toBeUndefined();
    const replied = parseEventFrame(JSON.stringify({
      type: 'permission.replied',
      properties: { sessionID: 's', permissionID: 'per_1', response: 'once' },
    })) as unknown as { permissionReplied?: string };
    expect(replied.permissionReplied).toBe('per_1');
  });
});

describe('real engine session shape (captured from opencode 1.18.35)', () => {
  const top = {
    id: 'ses_ee65062e5ffeJK96XbaciUUTaq', slug: 'mighty-island', projectID: 'global',
    directory: 'C:\\Users\\User\\Downloads\\BUSINESS', summary: { additions: 0, deletions: 0, files: 0 },
    cost: 0.228689178, tokens: { input: 1062095, output: 27293, reasoning: 33585, cache: { read: 10949376, write: 0 } },
    title: 'OpenHub as main ecosystem controller', agent: 'build',
    model: { id: 'deepseek-v4.1-flash', providerID: 'opencode-go', variant: 'high' },
    version: '1.18.35', time: { created: 1791432301850, updated: 1791435727447 },
  };
  it('maps to a mission and telemetry', () => {
    expect(sessionToMission(top)?.id).toBe(top.id);
    expect(normalizeSessionTelemetry(top)).toMatchObject({ cost: 0.228689178, model: 'deepseek-v4.1-flash', tokens: { input: 1062095, output: 27293 } });
  });
  it('treats subagent sessions (parentID) as non-missions', () => {
    expect(isTopLevelSession(top)).toBe(true);
    expect(isTopLevelSession({ ...top, parentID: 'ses_parent', permission: [{ permission: 'task', pattern: '*', action: 'deny' }] })).toBe(false);
  });
});

describe('robustness fixes', () => {
  it('revertLastStep accepts a Session object as success', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) =>
      String(url).includes('/messages')
        ? jsonRes({ ok: true, data: [{ info: { id: 'msg_1' } }] })
        : jsonRes({ ok: true, data: { id: 'ses_1', revert: { messageID: 'msg_1' } } })));
    await expect(revertLastStep('ses_1')).resolves.toBe(true);
  });

  it('reconnects after a clean end-of-stream with no terminal event', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const enc = new TextEncoder();
    const mk = () => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode(': ping\n\n')); c.close(); } });
    const fetchMock = vi.fn(async () => new Response(mk(), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const cleanup = subscribeMission('ses_1', () => {});
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1_100);
    await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    cleanup();
    vi.useRealTimers();
  });
});

describe('live engine event capture (opencode 1.18.35, tests/fixtures/opencode-events.live.txt)', () => {
  const frames = readFileSync(join(process.cwd(), 'tests', 'fixtures', 'opencode-events.live.txt'), 'utf8')
    .split('\n\n').map((f) => f.trim()).filter(Boolean);
  const parsed = frames.map((f) => parseEventFrame(f) as unknown as { kind: string; text: string; sessionId?: string });
  it('parses every captured frame', () => {
    expect(parsed).toHaveLength(4);
    expect(parsed.every(Boolean)).toBe(true);
  });
  it('session.created carries its session id and title', () => {
    const ev = parsed.find((e) => e.kind === 'session.created')!;
    expect(ev.sessionId).toBe('ses_ee506078affeGOfLBX3MAHA1Rm');
    expect(ev.text).toBe('openhub contract capture (safe to delete)');
  });
  it('session.error surfaces the real reason, not just the event name', () => {
    const ev = parsed.find((e) => e.kind === 'session.error')!;
    expect(ev.sessionId).toBe('ses_ee506078affeGOfLBX3MAHA1Rm');
    expect(ev.text).toBe('ProviderNoProvidersError: No providers are available');
  });
  it('global events (connected, heartbeat) have no session and are filtered out of missions', () => {
    for (const k of ['server.connected', 'server.heartbeat']) {
      expect(parsed.find((e) => e.kind === k)?.sessionId).toBeUndefined();
    }
  });
});
