// Browser-side editor bridge: calls OpenHub's own /api/axiom/editor/* proxy,
// which authenticates the user and forwards to Axiom's /api/editor/* with the
// server-minted HMAC token.
//
// This must NOT import services/axiomClient (the server client): that module
// pulls node crypto/fs/path, which Vite stubs to `{}` in the browser, so
// minting throws before any request is sent. Browser code talks to the proxy.

import { getAuthHeaders } from '../auth/AuthProvider';
import { readCompletionStream, type CompletionStreamMeta } from './completionStream';
import type { LspDiagnostic } from './lspDiagnostics';

export interface EditorProxyResult<T> {
  data?: T;
  /** OpenHub's own measured overhead (auth + forward), when the proxy times the lane. */
  proxyMs?: number;
}

async function editorPost<T>(path: string, body: unknown, signal?: AbortSignal): Promise<EditorProxyResult<T>> {
  const res = await fetch(`/api/axiom${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new Error(`OpenHub editor proxy HTTP ${res.status}`);
  const json = (await res.json().catch(() => ({}))) as EditorProxyResult<T>;
  return json;
}

async function editorGet<T>(path: string): Promise<EditorProxyResult<T>> {
  const res = await fetch(`/api/axiom${path}`, { credentials: 'include', headers: { ...getAuthHeaders() } });
  if (!res.ok) throw new Error(`OpenHub editor proxy HTTP ${res.status}`);
  const json = (await res.json().catch(() => ({}))) as EditorProxyResult<T>;
  return json;
}

export interface EditorIndexResult {
  entries?: Array<{ path?: string }>;
}

export interface EditorTextResult {
  text?: string;
  source?: string;
  note?: string;
  /** Real measured model latency (Axiom) — feeds the Tab status readout. */
  latencyMs?: number;
  /** Which server lane produced the text (`fim` native vs `chat` fallback). */
  lane?: string;
  /** Time to the first streamed token, when the streaming lane was used. */
  firstTokenMs?: number;
  /** True when served from the prompt cache (0ms model time). */
  cached?: boolean;
  /** Which tier answered: the on-box model or the hosted fast model. */
  tier?: 'local' | 'hosted';
}

export function axiomEditorIndex(params: { dir: string }): Promise<EditorProxyResult<EditorIndexResult>> {
  return editorPost<EditorIndexResult>('/editor/index', params);
}

export interface EditorMentionsResult {
  /** The resolved context block to prepend to a prompt. Empty when nothing resolved. */
  block?: string;
  resolved?: string[];
  unresolved?: string[];
}

/** Resolve `@file/@folder/@code/@docs/@git` mentions in `text` into a bounded
 *  context block. The server is authoritative about what resolves. */
export function axiomEditorMentions(params: { dir: string; text: string }): Promise<EditorProxyResult<EditorMentionsResult>> {
  return editorPost<EditorMentionsResult>('/editor/mentions', params);
}

export function axiomEditorComplete(params: {
  file: string; content: string; line: number; column: number; dir?: string; model?: string;
}, signal?: AbortSignal): Promise<EditorProxyResult<EditorTextResult>> {
  return editorPost<EditorTextResult>('/editor/complete', params, signal);
}

export type EditorCompletionStreamParams = {
  file: string; content: string; line: number; column: number; dir?: string; model?: string;
};

/**
 * Streaming sibling of {@link axiomEditorComplete}. POSTs to the proxy's
 * `/editor/complete-stream` SSE lane and fires `onDelta(accumulatedText, meta)`
 * for every delta so the editor can paint ghost text at first-token latency.
 * Resolves with the final payload once the stream signals `done`.
 *
 * Errors are surfaced, never fabricated: a transport failure or an SSE
 * `error` frame rejects (the provider falls back to the non-stream lane), and
 * a cancelled request rejects with an `AbortError`.
 */
export async function axiomEditorCompleteStream(
  params: EditorCompletionStreamParams,
  handlers: { onDelta: (accumulatedText: string, meta: CompletionStreamMeta) => void; signal?: AbortSignal },
): Promise<EditorProxyResult<EditorTextResult>> {
  const res = await fetch('/api/axiom/editor/complete-stream', {
    method: 'POST',
    credentials: 'include',
    headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    ...(handlers.signal ? { signal: handlers.signal } : {}),
  });
  if (!res.ok || !res.body) throw new Error(`OpenHub editor stream proxy HTTP ${res.status}`);
  const final = await readCompletionStream(res.body, { onDelta: handlers.onDelta, signal: handlers.signal });
  return {
    data: {
      text: final.text,
      source: final.meta.source,
      lane: final.meta.lane,
      cached: final.meta.cached,
      latencyMs: final.meta.latencyMs,
      firstTokenMs: final.meta.firstTokenMs,
      tier: final.meta.tier,
    },
  };
}

export function axiomEditorInlineEdit(params: {
  file: string; content: string; selection: string; instruction: string; line?: number; column?: number; dir?: string; model?: string;
}): Promise<EditorProxyResult<EditorTextResult>> {
  return editorPost<EditorTextResult>('/editor/inline-edit', params);
}

export interface EditorNextEditCandidate {
  file?: string;
  line?: number;
  kind?: string;
  reason?: string;
  confidence?: number;
}

export interface EditorNextEditResult {
  engine?: string;
  live?: boolean;
  latencyMs?: number;
  candidates?: EditorNextEditCandidate[];
  completion?: EditorTextResult;
}

export function axiomEditorNextEdit(params: {
  dir: string; file: string; content: string; line: number; column: number; complete?: boolean;
}): Promise<EditorProxyResult<EditorNextEditResult>> {
  return editorPost<EditorNextEditResult>('/editor/next-edit', params);
}

export interface EditorModelsResult {
  /** Environment-configured model id, or null when none is set. */
  configured?: string | null;
  /** True when the local tier answered its /models list. */
  live?: boolean;
  /** Selectable model ids (configured first). Empty when unconfigured. */
  models?: string[];
  /** The local tier's base URL (loopback), or null when unconfigured. */
  base?: string | null;
  /** Hosted fast-completion tier status (policy-gated). */
  hosted?: { configured?: boolean; allowed?: boolean; model?: string | null; base?: string | null };
  note?: string;
}

export function axiomEditorModels(): Promise<EditorProxyResult<EditorModelsResult>> {
  return editorGet<EditorModelsResult>('/editor/models');
}

export interface EditorDiagnosticsResult {
  ok?: boolean;
  /** False when Axiom has no language server configured for this file. */
  available?: boolean;
  diagnostics?: LspDiagnostic[];
  error?: string;
}

/** Real language-server diagnostics for a file, via the OpenHub proxy. */
export async function axiomEditorDiagnostics(
  params: { file: string; rootDir?: string },
): Promise<EditorDiagnosticsResult> {
  const res = await fetch('/api/axiom/editor/diagnostics', {
    method: 'POST',
    credentials: 'include',
    headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  return (await res.json().catch(() => ({}))) as EditorDiagnosticsResult;
}

export interface EditorWarmResult {
  /** Local tier the warm loop targets, or null when unconfigured. */
  target?: { base?: string; model?: string } | null;
  lastPing?: { ok?: boolean; ms?: number } | null;
  keepalive?: boolean;
  ping?: { ok?: boolean; ms?: number } | null;
}

/** Read warm-transport state (keepalive + last ping). */
export function axiomEditorWarm(): Promise<EditorProxyResult<EditorWarmResult>> {
  return editorGet<EditorWarmResult>('/editor/warm');
}

/** Start the warm keepalive so the first Tab after opening a project is hot. */
export function axiomEditorWarmStart(): Promise<EditorProxyResult<EditorWarmResult>> {
  return editorPost<EditorWarmResult>('/editor/warm/start', {}, undefined);
}

export interface EditorModelCatalogGroup {
  provider?: string;
  label?: string;
  models?: string[];
}

/** Axiom's live cross-provider catalog (`GET /api/pipeline/models`). */
export interface EditorModelCatalogResult {
  groups?: EditorModelCatalogGroup[];
  current?: string | null;
}

export function axiomEditorModelCatalog(): Promise<EditorProxyResult<EditorModelCatalogResult>> {
  return editorGet<EditorModelCatalogResult>('/editor/catalog');
}

/** Persist the default editor model in Axiom's settings store. */
export function axiomEditorSetModel(model: string): Promise<EditorProxyResult<{ model?: string }>> {
  return editorPost<{ model?: string }>('/editor/model', { model });
}

/** Stream a composer turn from the OpenHub proxy. `onDelta` fires per real
 *  provider chunk; resolves with the assembled text and the tier that answered. */
export async function axiomEditorChat(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  onDelta: (delta: string) => void,
  opts: { tier?: 'auto' | 'local' | 'hosted'; model?: string; signal?: AbortSignal } = {},
): Promise<{ text: string; tier?: string; model?: string; note?: string }> {
  const res = await fetch('/api/axiom/editor/chat', {
    method: 'POST',
    credentials: 'include',
    headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, tier: opts.tier, model: opts.model }),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!res.ok || !res.body) throw new Error(`OpenHub editor chat HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let final: { tier?: string; model?: string; note?: string } = {};
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx = buffer.indexOf('\n');
    while (idx >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      idx = buffer.indexOf('\n');
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      try {
        const j = JSON.parse(data) as { delta?: string; done?: boolean; error?: string; tier?: string; model?: string; note?: string };
        if (j.error) throw new Error(j.error);
        if (typeof j.delta === 'string' && j.delta) { text += j.delta; onDelta(j.delta); }
        if (j.done) final = { tier: j.tier, model: j.model, note: j.note };
      } catch (e) {
        if (e instanceof SyntaxError) continue; // keep-alive/partial frame
        throw e;
      }
    }
  }
  return { text, tier: final.tier, model: final.model, note: final.note };
}

/** Fire-and-forget regression signal. Never awaited, never throws into the
 *  editor path; `keepalive` lets it survive a navigation. */
export function axiomEditorTelemetry(event: {
  kind: 'completion' | 'inline-edit';
  tier?: 'local' | 'hosted';
  lane?: string;
  cached?: boolean;
  latencyMs?: number;
  outcome?: 'accepted' | 'rejected' | 'partial';
  hunksAccepted?: number;
  hunksTotal?: number;
}): void {
  try {
    void fetch('/api/axiom/editor/telemetry', {
      method: 'POST',
      credentials: 'include',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ event }),
      keepalive: true,
    });
  } catch { /* telemetry is best-effort */ }
}

export interface EditorLatencyProbe {
  deterministicMs?: number;
  completionMs?: number;
  completionSource?: string;
  totalMs?: number;
  budgetMs?: number;
  withinBudget?: boolean;
}

export function axiomEditorLatencyProbe(params: {
  file: string; content: string; line: number; column: number; dir: string;
}): Promise<EditorProxyResult<EditorLatencyProbe>> {
  return editorPost<EditorLatencyProbe>('/editor/latency-probe', params);
}
