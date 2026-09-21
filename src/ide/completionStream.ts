// Pure SSE parsing + delta-application logic for Axiom's streaming editor
// completion (`POST /api/editor/complete-stream`).
//
// Kept free of Monaco, fetch and the DOM so the two decisions that matter —
// "reassemble frames split across network chunks" and "what ghost text (if
// any) should this accumulated result show" — are unit-testable in isolation.
// `axiomEditorClient` wires this to the OpenHub proxy; `monacoProviders` wires
// it to the editor.
//
// Wire format (per event, terminated by a blank line):
//   data: {"type":"delta","text":"<accumulated>","source":"local-model","latencyMs":N,"firstTokenMs":M}
//   data: {"type":"done","text":"<final>","source":"local-model","lane":"fim","cached":bool,...}
//   data: {"type":"error","message":"..."}

export interface CompletionStreamMeta {
  source?: string;
  lane?: string;
  cached?: boolean;
  latencyMs?: number;
  firstTokenMs?: number;
  tier?: 'local' | 'hosted';
}

export type CompletionStreamEvent =
  | ({ type: 'delta'; text: string } & CompletionStreamMeta)
  | ({ type: 'done'; text: string } & CompletionStreamMeta)
  | { type: 'error'; message: string };

export type CompletionStreamPhase = 'idle' | 'streaming' | 'done' | 'error';

export interface CompletionStreamState {
  /** The accumulated completion text (delta `text` is already cumulative). */
  text: string;
  meta: CompletionStreamMeta;
  phase: CompletionStreamPhase;
  error?: string;
}

export interface GhostDecision {
  /** True when there is real local-model text worth showing as ghost text. */
  show: boolean;
  text: string;
}

const META_KEYS = ['source', 'lane', 'cached', 'latencyMs', 'firstTokenMs', 'tier'] as const;

function pickMeta(raw: Record<string, unknown>): CompletionStreamMeta {
  const meta: CompletionStreamMeta = {};
  for (const key of META_KEYS) {
    if (raw[key] !== undefined) (meta as Record<string, unknown>)[key] = raw[key];
  }
  return meta;
}

export function createCompletionStreamState(): CompletionStreamState {
  return { text: '', meta: {}, phase: 'idle' };
}

/** Parse one already-delimited SSE frame. Returns null for keep-alives,
 *  comments and non-completion payloads instead of throwing, so a malformed
 *  frame can never kill the stream. */
export function parseSseFrame(frame: string): CompletionStreamEvent | null {
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (!line.startsWith('data:')) continue;
    dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  if (dataLines.length === 0) return null;
  const payload = dataLines.join('\n').trim();
  if (!payload) return null;

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return null;
  }

  const type = raw.type;
  if (type === 'error') {
    return { type: 'error', message: typeof raw.message === 'string' ? raw.message : 'completion stream error' };
  }
  const text = typeof raw.text === 'string' ? raw.text : '';
  if (type === 'done') return { type: 'done', text, ...pickMeta(raw) };
  if (type === 'delta') return { type: 'delta', text, ...pickMeta(raw) };
  return null;
}

/** Frame reassembler. Feed it decoded text in whatever chunk sizes the network
 *  delivers; it returns whole events only once their terminating blank line
 *  has arrived, so a frame split mid-JSON is buffered, not dropped. */
export class SseParser {
  private buffer = '';

  push(chunk: string): CompletionStreamEvent[] {
    if (!chunk) return [];
    // Normalise CRLF on the whole buffer so a `\r` and `\n` split across two
    // chunks still becomes one separator.
    this.buffer = (this.buffer + chunk).replace(/\r\n/g, '\n');
    const events: CompletionStreamEvent[] = [];
    let sep = this.buffer.indexOf('\n\n');
    while (sep >= 0) {
      const frame = this.buffer.slice(0, sep);
      this.buffer = this.buffer.slice(sep + 2);
      const event = parseSseFrame(frame);
      if (event) events.push(event);
      sep = this.buffer.indexOf('\n\n');
    }
    return events;
  }

  /** Parse a trailing frame that arrived without its blank-line terminator. */
  flush(): CompletionStreamEvent[] {
    const frame = this.buffer.replace(/\r\n/g, '\n').trim();
    this.buffer = '';
    if (!frame) return [];
    const event = parseSseFrame(frame);
    return event ? [event] : [];
  }
}

/** Fold one event into the running state. Delta `text` is cumulative, so the
 *  newest non-empty value wins; metadata is merged so a later frame that omits
 *  `source` keeps the one the first delta already carried. */
export function reduceCompletionEvent(
  state: CompletionStreamState,
  event: CompletionStreamEvent,
): CompletionStreamState {
  if (event.type === 'error') return { ...state, phase: 'error', error: event.message };
  const meta: CompletionStreamMeta = { ...state.meta };
  for (const key of META_KEYS) {
    const value = (event as unknown as Record<string, unknown>)[key];
    if (value !== undefined) (meta as Record<string, unknown>)[key] = value;
  }
  const text = event.text || state.text;
  if (event.type === 'done') return { text, meta, phase: 'done' };
  return { text, meta, phase: 'streaming' };
}

/**
 * Decide the ghost text to show for the current accumulated state. Mirrors the
 * non-stream lane's contract exactly: only `source === 'local-model'` text is
 * shown (so an unavailable model, `source: "none"`, yields no ghost text), and
 * single-line mode truncates at the first newline.
 */
export function decideGhostText(
  state: CompletionStreamState,
  opts: { singleLine?: boolean } = {},
): GhostDecision {
  if (state.meta.source !== 'local-model') return { show: false, text: '' };
  const raw = state.text ?? '';
  if (!raw) return { show: false, text: '' };
  let text = raw;
  if (opts.singleLine) {
    const nl = text.indexOf('\n');
    if (nl >= 0) text = text.slice(0, nl);
  }
  if (!text) return { show: false, text: '' };
  return { show: true, text };
}

export interface CompletionStreamFinal {
  text: string;
  meta: CompletionStreamMeta;
}

function abortError(): Error {
  const err = new Error('completion stream aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * Consume an SSE body, invoking `onDelta(accumulatedText, meta)` per delta and
 * resolving with the terminal payload. An `error` frame throws (after any
 * partial text has already been delivered via `onDelta`) rather than silently
 * resolving a half answer; an abort throws an `AbortError` so callers can tell
 * a real failure from a routine cancellation.
 */
export async function readCompletionStream(
  body: ReadableStream<Uint8Array>,
  handlers: { onDelta?: (text: string, meta: CompletionStreamMeta) => void; signal?: AbortSignal } = {},
): Promise<CompletionStreamFinal> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  let state: CompletionStreamState = { ...createCompletionStreamState(), phase: 'streaming' };

  const apply = (events: CompletionStreamEvent[]): void => {
    for (const event of events) {
      state = reduceCompletionEvent(state, event);
      if (event.type === 'error') {
        const err = new Error(event.message) as Error & { partialText?: string };
        err.partialText = state.text;
        throw err;
      }
      if (event.type === 'delta' && event.text) handlers.onDelta?.(event.text, state.meta);
    }
  };

  try {
    for (;;) {
      if (handlers.signal?.aborted) throw abortError();
      const { done, value } = await reader.read();
      if (done) break;
      apply(parser.push(decoder.decode(value, { stream: true })));
    }
    const tail = decoder.decode();
    if (tail) apply(parser.push(tail));
    const remaining = parser.flush();
    if (remaining.length) apply(remaining);
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }

  if (handlers.signal?.aborted) throw abortError();
  return { text: state.text, meta: state.meta };
}
