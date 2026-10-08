// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseEventFrame,
  normalizeFileDiff,
  normalizeTodos,
  fetchDiff,
  fetchTodos,
  revertLastStep,
  subscribeMission,
  sessionToMission,
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
