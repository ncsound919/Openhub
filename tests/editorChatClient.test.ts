// Browser composer client tests (Phase 2.3): SSE deltas are surfaced one by one
// and the terminal `done` frame reports the answering tier.
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../src/auth/AuthProvider', () => ({ getAuthHeaders: () => ({}) }));

import { axiomEditorChat } from '../src/ide/axiomEditorClient';

function sse(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) { for (const s of chunks) c.enqueue(enc.encode(s)); c.close(); },
  });
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('axiomEditorChat', () => {
  it('streams deltas and resolves with the final tier', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      body: sse([
        'data: {"delta":"Hel"}\n\n',
        'data: {"delta":"lo"}\n\n',
        'data: {"done":true,"tier":"hosted","model":"deepseek-chat"}\n\n',
      ]),
    })));

    const deltas: string[] = [];
    const r = await axiomEditorChat([{ role: 'user', content: 'hi' }], (d) => deltas.push(d));
    expect(deltas).toEqual(['Hel', 'lo']);
    expect(r.text).toBe('Hello');
    expect(r.tier).toBe('hosted');
    expect(r.model).toBe('deepseek-chat');
  });

  it('throws on an error frame', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      body: sse(['data: {"error":"no model configured"}\n\n']),
    })));
    await expect(axiomEditorChat([{ role: 'user', content: 'hi' }], () => {})).rejects.toThrow('no model configured');
  });
});
