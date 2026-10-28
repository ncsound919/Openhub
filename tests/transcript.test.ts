import { describe, it, expect } from 'vitest';
import {
  appendTranscriptDelta,
  normalizeTranscript,
  upsertTranscriptRole,
  upsertTranscriptText,
  upsertTranscriptTool,
  type TranscriptEntry,
} from '../src/mission/transcript.js';

const user: TranscriptEntry = { id: 'msg_u', role: 'user', text: 'hello', tools: [] };

describe('normalizeTranscript', () => {
  it('reads the captured opencode message shape into a conversation', () => {
    const entries = normalizeTranscript([
      {
        info: { id: 'msg_u', role: 'user', time: { created: 1 } },
        parts: [{ type: 'text', text: 'Respond with exactly: transcript-ok' }],
      },
      {
        info: { id: 'msg_a', role: 'assistant', time: { created: 2 }, finish: 'stop' },
        parts: [
          { type: 'step-start' },
          { id: 'prt_1', type: 'text', text: 'transcript-ok', time: { start: 3, end: 4 } },
          {
            id: 'prt_tool',
            type: 'tool',
            tool: 'bash',
            state: { status: 'completed', title: 'bash', input: { command: 'echo hi' } },
          },
          { id: 'prt_2', type: 'text', text: 'Done.' },
        ],
      },
    ]);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ id: 'msg_u', role: 'user', text: 'Respond with exactly: transcript-ok', at: 1 });
    expect(entries[1]).toMatchObject({
      id: 'msg_a',
      role: 'assistant',
      // Multiple text parts are separated, never concatenated mid-word.
      text: 'transcript-ok\n\nDone.',
      at: 2,
      lastPartId: 'prt_2',
    });
    expect(entries[1].tools).toEqual([
      { id: 'prt_tool', name: 'bash', title: 'bash', status: 'completed' },
    ]);
    expect(entries[1].textParts).toEqual([
      { id: 'prt_1', text: 'transcript-ok' },
      { id: 'prt_2', text: 'Done.' },
    ]);
  });

  it('skips system/empty/reasoning-only messages instead of rendering blank bubbles', () => {
    expect(normalizeTranscript([
      { info: { role: 'system' }, parts: [{ type: 'text', text: 'hidden' }] },
      { info: { id: 'm1', role: 'assistant' }, parts: [{ type: 'text', text: '   ' }] },
      { info: { id: 'm2', role: 'assistant' }, parts: [{ type: 'reasoning', text: 'thinking' }] },
      { info: { id: 'm3', role: 'assistant' }, parts: [{ type: 'text', text: 'synthetic', synthetic: true }] },
      null,
      'nope',
    ])).toEqual([]);
  });

  it('surfaces a message error so a failed reply is not silent', () => {
    const [entry] = normalizeTranscript([
      {
        info: { id: 'msg_e', role: 'assistant', error: { data: { message: 'provider exploded' } } },
        parts: [],
      },
    ]);
    expect(entry.error).toBe('provider exploded');
  });

  it('tolerates malformed input and messages with no parts', () => {
    // No parts means no invented reply; a flat text field is not a message body.
    expect(normalizeTranscript([null, 'nope', { id: 'flat', role: 'assistant', text: 'hi' }])).toEqual([]);
  });
});

describe('live transcript updates', () => {
  it('creates an assistant entry from the first delta and appends the rest', () => {
    let entries = appendTranscriptDelta([], 'msg_a', 'prt_1', 'trans');
    entries = appendTranscriptDelta(entries, 'msg_a', 'prt_1', 'cript');
    expect(entries).toEqual([
      { id: 'msg_a', role: 'assistant', text: 'transcript', tools: [], lastPartId: 'prt_1' },
    ]);
  });

  it('starts a new paragraph when the next text part begins', () => {
    const first = appendTranscriptDelta([], 'msg_a', 'prt_1', 'transcript-ok');
    const second = appendTranscriptDelta(first, 'msg_a', 'prt_2', 'Done.');
    expect(second[0].text).toBe('transcript-ok\n\nDone.');
  });

  it('replaces streamed deltas with the full part update instead of duplicating them', () => {
    const streamed = appendTranscriptDelta([], 'msg_a', 'prt_1', 'trans');
    const full = upsertTranscriptText(streamed, 'msg_a', 'prt_1', 'transcript-ok');
    expect(full[0].text).toBe('transcript-ok');
    const repeated = upsertTranscriptText(full, 'msg_a', 'prt_1', 'transcript-ok');
    expect(repeated[0].text).toBe('transcript-ok');
  });

  it('appends a new part once and does not duplicate its repeated full update', () => {
    const first = upsertTranscriptText([], 'msg_a', 'prt_1', 'transcript-ok');
    const second = upsertTranscriptText(first, 'msg_a', 'prt_2', 'Done.');
    const repeated = upsertTranscriptText(second, 'msg_a', 'prt_2', 'Done.');
    expect(repeated[0].text).toBe('transcript-ok\n\nDone.');
  });

  it('fills in the role without wiping text, and creates a placeholder before text arrives', () => {
    const withText = [{ ...user, id: 'msg_a', text: 'hi', role: 'assistant' as const }];
    expect(upsertTranscriptRole(withText, 'msg_a', 'assistant')[0].text).toBe('hi');
    const placeholder = upsertTranscriptRole([], 'msg_new', 'assistant', 12);
    expect(placeholder).toEqual([
      { id: 'msg_new', role: 'assistant', text: '', tools: [], at: 12 },
    ]);
  });

  it('updates a tool in place as its status changes', () => {
    let entries = upsertTranscriptTool([], 'msg_a', { id: 'prt_tool', name: 'bash', status: 'running' });
    entries = upsertTranscriptTool(entries, 'msg_a', { id: 'prt_tool', name: 'bash', title: 'echo hi', status: 'completed' });
    expect(entries[0].tools).toEqual([
      { id: 'prt_tool', name: 'bash', title: 'echo hi', status: 'completed' },
    ]);
  });

  it('appends a late message after the existing history', () => {
    const entries = appendTranscriptDelta([user], 'msg_a', 'prt_1', 'hi');
    expect(entries.map((entry) => entry.id)).toEqual(['msg_u', 'msg_a']);
  });

  it('keeps earlier text parts when the last part is updated again', () => {
    const history = normalizeTranscript([
      {
        info: { id: 'msg_a', role: 'assistant' },
        parts: [
          { id: 'prt_1', type: 'text', text: 'first' },
          { id: 'prt_2', type: 'text', text: 'second' },
        ],
      },
    ]);
    const updated = upsertTranscriptText(history, 'msg_a', 'prt_2', 'second, finished');
    expect(updated[0].text).toBe('first\n\nsecond, finished');
  });
});
