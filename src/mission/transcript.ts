/**
 * Mission transcript — the human-readable conversation the mission screen was
 * missing.
 *
 * opencode's session history is `Message[]`, each `{ info, parts }`:
 *   - `info.role` is `user` or `assistant`, and `info.time.created` is epoch ms;
 *   - `parts` carries `text` parts (the reply) and `tool` parts (what the agent
 *     ran). Tool output is deliberately not copied into the transcript: a phone
 *     does not need a whole shell buffer, only the command and its status.
 *
 * Live events use two shapes (captured from opencode 1.19.4):
 *   - `message.part.delta` with `{ messageID, partID, field: 'text', delta }`
 *   - `message.part.updated` with `part: { id, messageID, type: 'text'|'tool',
 *     text, tool, state }`
 *
 * The helpers here are pure and defensive. A message with no readable role, id
 * or content is skipped rather than rendered as an empty bubble.
 */

export interface TranscriptTool {
  id: string;
  name: string;
  title?: string;
  status?: string;
}

export interface TranscriptTextPart {
  id: string;
  text: string;
}

export interface TranscriptEntry {
  /** Message id (`msg_…`); stable across history fetches and live events. */
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** Epoch ms from the message/part, when the engine supplied one. */
  at?: number;
  tools: TranscriptTool[];
  /** A model/tool failure reported on the message, when present. */
  error?: string;
  /**
   * Text parts in arrival order. Keeping them separately lets a full update for
   * the latest part replace only that part instead of wiping earlier ones.
   * Omitted on entries that have never needed a partial update.
   */
  textParts?: TranscriptTextPart[];
  /**
   * The last text part folded into `text`. Live updates use it to replace the
   * same part instead of appending it twice when a full update follows deltas.
   */
  lastPartId?: string;
}

function record(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function text(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Read the error message from any of the shapes opencode has used. */
function messageError(info: Record<string, unknown>): string | undefined {
  const direct = text(info.error);
  if (direct) return direct;
  const err = record(info.error);
  const data = err ? record(err.data) : undefined;
  return text(data?.message) ?? text(err?.message);
}

/** Normalize a tool part into the small row the mission screen renders. */
export function normalizeToolPart(raw: Record<string, unknown>, index = 0): TranscriptTool {
  const state = record(raw.state) ?? {};
  const input = record(state.input) ?? {};
  const id = text(raw.id) ?? text(raw.callID) ?? text(raw.toolCallID) ?? `tool-${index}`;
  const name = text(raw.tool) ?? text(raw.name) ?? 'tool';
  const title =
    text(state.title) ??
    text(input.description) ??
    text(input.command) ??
    text(input.filePath) ??
    text(input.path);
  const status = text(state.status);
  return {
    id,
    name,
    ...(title ? { title } : {}),
    ...(status ? { status } : {}),
  };
}

/** Convert the engine's message history into renderable entries. */
export function normalizeTranscript(raw: unknown[]): TranscriptEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: TranscriptEntry[] = [];
  for (const item of raw) {
    const rec = record(item);
    if (!rec) continue;
    const info = record(rec.info) ?? rec;
    const role = info.role === 'user' || info.role === 'assistant' ? info.role : undefined;
    if (!role) continue;
    const id = text(info.id) ?? text(rec.id);
    if (!id) continue;

    const parts = Array.isArray(rec.parts) ? rec.parts : [];
    const bodyParts: TranscriptTextPart[] = [];
    const tools: TranscriptTool[] = [];
    for (const rawPart of parts) {
      const part = record(rawPart);
      if (!part) continue;
      if (part.type === 'text' && typeof part.text === 'string') {
        // Reasoning/synthetic text is not the agent's answer.
        if (part.synthetic === true || part.ignored === true || !part.text.trim()) continue;
        bodyParts.push({ id: text(part.id) ?? `part-${bodyParts.length}`, text: part.text });
      } else if (part.type === 'tool') {
        tools.push(normalizeToolPart(part, tools.length));
      }
    }

    const body = bodyParts.map((part) => part.text).join('\n\n');
    const lastPartId = bodyParts.length > 0 ? bodyParts[bodyParts.length - 1].id : undefined;
    const error = messageError(info);
    if (!body.trim() && tools.length === 0 && !error) continue;
    const created = num(record(info.time)?.created);
    entries.push({
      id,
      role,
      text: body.trim(),
      tools,
      ...(bodyParts.length > 0 ? { textParts: bodyParts } : {}),
      ...(created !== undefined ? { at: created } : {}),
      ...(lastPartId ? { lastPartId } : {}),
      ...(error ? { error } : {}),
    });
  }
  return entries;
}

/** Create or update the role/time of a message before its text arrives. */
export function upsertTranscriptRole(
  entries: TranscriptEntry[],
  id: string,
  role: 'user' | 'assistant',
  at?: number,
): TranscriptEntry[] {
  const index = entries.findIndex((entry) => entry.id === id);
  if (index === -1) {
    return [...entries, { id, role, text: '', tools: [], ...(at !== undefined ? { at } : {}) }];
  }
  const next = [...entries];
  const current = next[index];
  next[index] = { ...current, role, ...(current.at === undefined && at !== undefined ? { at } : {}) };
  return next;
}

/** Apply one streamed `message.part.delta` chunk. */
export function appendTranscriptDelta(
  entries: TranscriptEntry[],
  messageId: string,
  partId: string,
  delta: string,
  at?: number,
): TranscriptEntry[] {
  if (!delta) return entries;
  const index = entries.findIndex((entry) => entry.id === messageId);
  if (index === -1) {
    return [...entries, { id: messageId, role: 'assistant', text: delta, tools: [], lastPartId: partId, ...(at !== undefined ? { at } : {}) }];
  }
  const next = [...entries];
  const current = next[index];
  if (current.textParts) {
    const partIndex = current.textParts.findIndex((part) => part.id === partId);
    const nextParts = partIndex === -1
      ? [...current.textParts, { id: partId, text: delta }]
      : current.textParts.map((part, i) => (i === partIndex ? { ...part, text: part.text + delta } : part));
    next[index] = rebuildText(current, nextParts);
    return next;
  }
  const samePart = current.lastPartId === partId;
  const body = samePart ? current.text + delta : current.text ? `${current.text}\n\n${delta}` : delta;
  next[index] = { ...current, text: body, lastPartId: partId };
  return next;
}

/**
 * Apply a full `message.part.updated` text part. A full update for the same part
 * replaces the streamed text; a new part is appended after the previous one.
 */
export function upsertTranscriptText(
  entries: TranscriptEntry[],
  messageId: string,
  partId: string,
  body: string,
  at?: number,
): TranscriptEntry[] {
  if (!body) return entries;
  const index = entries.findIndex((entry) => entry.id === messageId);
  if (index === -1) {
    return [...entries, { id: messageId, role: 'assistant', text: body, tools: [], lastPartId: partId, ...(at !== undefined ? { at } : {}) }];
  }
  const next = [...entries];
  const current = next[index];
  const existing = current.textParts;
  let nextParts: TranscriptTextPart[];
  if (existing) {
    const partIndex = existing.findIndex((part) => part.id === partId);
    nextParts = partIndex === -1
      ? [...existing, { id: partId, text: body }]
      : existing.map((part, i) => (i === partIndex ? { ...part, text: body } : part));
  } else if (current.lastPartId === partId || !current.text) {
    nextParts = [{ id: partId, text: body }];
  } else {
    nextParts = [
      { id: current.lastPartId ?? `${messageId}-text`, text: current.text },
      { id: partId, text: body },
    ];
  }
  next[index] = {
    ...rebuildText(current, nextParts),
    ...(current.at === undefined && at !== undefined ? { at } : {}),
  };
  return next;
}

/** Recompute the display text from its ordered parts. */
function rebuildText(entry: TranscriptEntry, parts: TranscriptTextPart[]): TranscriptEntry {
  return {
    ...entry,
    text: parts.map((part) => part.text).join('\n\n').trim(),
    textParts: parts,
    lastPartId: parts.length > 0 ? parts[parts.length - 1].id : entry.lastPartId,
  };
}

/** Apply one `message.part.updated` tool part. */
export function upsertTranscriptTool(
  entries: TranscriptEntry[],
  messageId: string,
  tool: TranscriptTool,
  at?: number,
): TranscriptEntry[] {
  const index = entries.findIndex((entry) => entry.id === messageId);
  if (index === -1) {
    return [...entries, { id: messageId, role: 'assistant', text: '', tools: [tool], ...(at !== undefined ? { at } : {}) }];
  }
  const next = [...entries];
  const current = next[index];
  const tools = [...current.tools];
  const toolIndex = tools.findIndex((t) => t.id === tool.id);
  if (toolIndex === -1) tools.push(tool);
  else tools[toolIndex] = tool;
  next[index] = { ...current, tools, ...(current.at === undefined && at !== undefined ? { at } : {}) };
  return next;
}
