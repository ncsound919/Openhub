// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseEventFrame,
  normalizeFileDiff,
  normalizeTodos,
  fetchDiff,
  fetchTodos,
  revertLastStep,
} from '../src/mission/useMission.js';

afterEach(() => vi.unstubAllGlobals());

function jsonRes(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
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
