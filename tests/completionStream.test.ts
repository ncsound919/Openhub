// Pure tests for the streaming-completion SSE parser: frames split across
// network chunks must reassemble, accumulated deltas must surface in order, and
// the terminal `done` payload must be what readCompletionStream resolves with.
import { describe, it, expect } from 'vitest';
import { SseParser, readCompletionStream, parseSseFrame } from '../src/ide/completionStream';

function sse(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) { for (const s of chunks) c.enqueue(enc.encode(s)); c.close(); },
  });
}

describe('SseParser', () => {
  it('buffers a frame split mid-JSON across chunks', () => {
    const parser = new SseParser();
    expect(parser.push('data: {"type":"del')).toEqual([]);
    expect(parser.push('ta","text":"Hel')).toEqual([]);
    expect(parser.push('lo","source":"local-model"}\n\n')).toEqual([
      { type: 'delta', text: 'Hello', source: 'local-model' },
    ]);
  });

  it('emits multiple events from one chunk and normalises CRLF', () => {
    const parser = new SseParser();
    const events = parser.push(
      'data: {"type":"delta","text":"a","source":"local-model"}\r\n\r\n'
      + 'data: {"type":"done","text":"ab","lane":"fim"}\r\n\r\n',
    );
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: 'delta', text: 'a' });
    expect(events[1]).toMatchObject({ type: 'done', text: 'ab', lane: 'fim' });
  });

  it('flushes a trailing frame that has no blank-line terminator', () => {
    const parser = new SseParser();
    parser.push('data: {"type":"done","text":"x","source":"local-model"}');
    expect(parser.flush()).toEqual([{ type: 'done', text: 'x', source: 'local-model' }]);
  });

  it('ignores keep-alive and malformed frames instead of throwing', () => {
    expect(parseSseFrame('')).toBeNull();
    expect(parseSseFrame(': keep-alive')).toBeNull();
    expect(parseSseFrame('data: not json')).toBeNull();
    expect(parseSseFrame('data: {"type":"unknown"}')).toBeNull();
  });
});

describe('readCompletionStream', () => {
  it('emits accumulated deltas split mid-event and resolves with the final done payload', async () => {
    const chunks = [
      'data: {"type":"delta","text":"Hel',
      'lo","source":"local-model","latencyMs":15,"firstTokenMs":42}\n\n',
      'data: {"type":"delta","text":"Hello wor',
      'ld","source":"local-model","latencyMs":22,"firstTokenMs":42}\n\n',
      'data: {"type":"done","text":"Hello world","source":"local-model","lane":"fim","cached":false,"latencyMs":31,"firstTokenMs":42}\n\n',
    ];
    const deltas: Array<{ text: string; source?: string; firstTokenMs?: number }> = [];
    const final = await readCompletionStream(sse(chunks), {
      onDelta: (text, meta) => deltas.push({ text, source: meta.source, firstTokenMs: meta.firstTokenMs }),
    });

    expect(deltas.map((d) => d.text)).toEqual(['Hello', 'Hello world']);
    expect(deltas[0]).toMatchObject({ source: 'local-model', firstTokenMs: 42 });
    expect(final.text).toBe('Hello world');
    expect(final.meta).toMatchObject({ lane: 'fim', latencyMs: 31, firstTokenMs: 42 });
  });

  it('rejects on an error frame rather than resolving a half answer', async () => {
    await expect(readCompletionStream(sse(['data: {"type":"error","message":"no local model"}\n\n'])))
      .rejects.toThrow('no local model');
  });

  it('rejects with AbortError when the signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(readCompletionStream(sse(['data: {"type":"delta","text":"x","source":"local-model"}\n\n']), {
      signal: ctrl.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
