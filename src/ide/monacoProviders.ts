// Monaco providers that turn Axiom's editor bridge into editor-native UX:
//   - inline completions (Tab) from the local model lane,
//   - `@`-mention completions backed by the real Axiom Merkle index,
//   - an instruction inline-edit action (Ctrl/Cmd+I) with accept/reject,
//   - jump-to-next-edit (Alt+J) from Axiom's deterministic next-edit floor.
//
// The Ctrl/Cmd chord is I, not K, on purpose: OpenHub binds the global command
// palette to Cmd/Ctrl+K (Layout.tsx), and a Monaco binding cannot reliably
// pre-empt a window-level listener. Ctrl/Cmd+I is free and does the same job.
//
// Everything degrades honestly: when no local model is configured the server
// answers `source: "none"` and these providers return nothing rather than
// inventing completions.
//
// Latency notes (grounded in the 2026 forum/docs consensus):
//   - No hardcoded debounce. Monaco throttles provider calls and hands us a
//     CancellationToken; we cancel the in-flight fetch via AbortController.
//     The delay is a USER setting (`completionDelayMs`, default 0) — VS Code
//     itself ships `editor.inlineSuggest.minShowDelay` for exactly this reason:
//     too-fast annoys thinkers, too-slow annoys typists, so it must be a knob.
//   - `enableForwardStability` keeps the ghost text while the user types
//     forward along it instead of re-querying per keystroke (fewer requests,
//     less flicker).
//   - Partial accept (word-by-word, Cursor-style Ctrl/Cmd+Right) is handled by
//     Monaco core; `handlePartialAccept` here only records stats.

import type { OnMount } from '@monaco-editor/react';
import {
  axiomEditorComplete,
  axiomEditorCompleteStream,
  axiomEditorIndex,
  axiomEditorInlineEdit,
  axiomEditorNextEdit,
  axiomEditorTelemetry,
} from './axiomEditorClient';
import { decideGhostText, type CompletionStreamMeta } from './completionStream';
import {
  createInlineReview,
  decideHunk,
  acceptedCount,
  allAccepted,
  reviewBuffer,
  reviewDecisions,
  reviewHunkRanges,
  reviewOutcome,
  reviewStatus,
  type InlineReview,
} from './inlineReview';
import { retrievalTrigger, withRetrievalDir } from './editorRetrieval';
import { fixInstructionFor, fixRangeFor, type DiagnosticLike } from './diagnostics';

type MonacoApi = Parameters<OnMount>[1];
type EditorApi = Parameters<OnMount>[0];

export interface AxiomMonacoOptions {
  /** Project root; passed to Axiom as the index/apply root and the retrieval dir. */
  projectPath: string;
  /** Optional per-request model pick (a future model-picker UI can set this). */
  model?: string;
  /** Master switch for Tab completions (Cursor's Tab status indicator). Default true. */
  completionEnabled?: boolean;
  /** User-chosen pause before requesting (ms). Default 0. Mirrors VS Code's minShowDelay. */
  completionDelayMs?: number;
  /** Stream completions (SSE) so the first partial shows at first-token latency.
   *  Default ON; set false to force the non-stream lane. */
  completionStreamEnabled?: boolean;
  /** When true, truncate ghost text at the first newline (Copilot single-line mode). Default false. */
  singleLine?: boolean;
  /** Non-fatal status/notice sink (e.g. "no local model configured"). */
  onStatus?: (message: string) => void;
}

export interface AxiomTabStats {
  /** End-to-end ms of the last completion (proxy + model), when reported. */
  lastTotalMs: number | null;
  /** Which server lane produced it. */
  lastLane: string | null;
  /** True when the last completion was a 0ms cache read. */
  lastCached: boolean;
  /** Completions shown / partial accepts since mount (prompt-cache telemetry). */
  shown: number;
  partialAccepts: number;
  updatedAt: number;
}

const INLINE_LANGS = [
  'typescript', 'javascript', 'typescriptreact', 'javascriptreact',
  'python', 'json', 'markdown', 'css', 'html', 'shell',
  'go', 'rust', 'java', 'cpp', 'c',
];

const registeredMonaco = new WeakSet<object>();
const codeActionsRegistered = new WeakSet<object>();
const registeredEditors = new WeakSet<object>();
/** Editors with an un-decided inline edit outstanding. Accept = keep the
 *  inserted text; reject = restore `original` (byte-exact, not undo-order
 *  dependent) and clear the diff decorations. Per-hunk decisions live in a pure
 *  `InlineReview`, which reconstructs the buffer for any accepted subset. */
interface PendingInlineEdit {
  /** Exact pre-edit text of the replaced range. */
  original: string;
  /** The model's full proposed replacement. */
  proposed: string;
  /** Per-hunk decision state (default: every hunk accepted = apply all). */
  review: InlineReview;
  /** Anchor line/column of the replaced region (stable across recomputes). */
  start: { lineNumber: number; column: number };
  /** Range occupied by the current inserted text. */
  range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
  /** Model version after our last edit; a change means an external edit moved
   *  the buffer, so reject falls back to undo rather than mis-placing text. */
  versionId: number | null;
  /** Per-hunk diff highlights (green accepted / red kept-original). */
  decorations: { clear: () => void } | null;
  /** Small review widget anchored at the edit; cleared on accept/reject. */
  widget: { remove?: () => void } | null;
  /** Per-hunk actions registered for this edit; disposed when it is decided. */
  disposables: Array<{ dispose?: () => void }>;
}
const pendingInlineEdit = new WeakMap<object, PendingInlineEdit>();

/** The buffer span a block of text occupies when inserted at `start`. */
function spanAt(text: string, start: { lineNumber: number; column: number }): PendingInlineEdit['range'] {
  const lines = text.split('\n');
  return {
    startLineNumber: start.lineNumber,
    startColumn: start.column,
    endLineNumber: start.lineNumber + lines.length - 1,
    endColumn: lines.length === 1 ? start.column + text.length : (lines[lines.length - 1]?.length ?? 0) + 1,
  };
}
let fileCache: { project: string; at: number; files: string[] } | null = null;

/** Live options: refreshed on every register call AND via setAxiomMonacoOptions,
 *  so the Tab settings cluster can change prefs without remounting the editor
 *  (providers are registered once per Monaco instance and would otherwise hold
 *  stale closures). */
let liveOpts: AxiomMonacoOptions = { projectPath: '' };
export function setAxiomMonacoOptions(patch: Partial<AxiomMonacoOptions>): void {
  liveOpts = { ...liveOpts, ...patch };
}

const tabStats: AxiomTabStats = {
  lastTotalMs: null, lastLane: null, lastCached: false,
  shown: 0, partialAccepts: 0, updatedAt: 0,
};
export function getAxiomTabStats(): AxiomTabStats {
  return { ...tabStats };
}

const tabStatsListeners = new Set<() => void>();
/** Subscribe to Tab-stat changes so the status bar renders on demand instead of
 *  polling a 2s interval. Returns an unsubscribe function. */
export function subscribeAxiomTabStats(listener: () => void): () => void {
  tabStatsListeners.add(listener);
  return () => { tabStatsListeners.delete(listener); };
}
function emitTabStats(): void {
  for (const listener of tabStatsListeners) {
    try { listener(); } catch { /* a bad listener must not break the lane */ }
  }
}

/**
 * Inline instruction input for Ctrl+I. Replaces the blocking `window.prompt`
 * with a compact content widget anchored to the selection (falls back to prompt
 * on older Monaco / non-DOM). Resolves the instruction, `''` for an empty
 * submit, or `null` when cancelled.
 */
function promptInlineInstruction(
  ed: { addContentWidget?: (w: unknown) => void; removeContentWidget?: (w: unknown) => void },
  anchor: { lineNumber: number; column: number },
): Promise<string | null> {
  if (typeof document === 'undefined' || typeof ed.addContentWidget !== 'function' || typeof ed.removeContentWidget !== 'function') {
    return Promise.resolve(window.prompt('Axiom inline edit — instruction:'));
  }
  return new Promise((resolve) => {
    const dom = document.createElement('div');
    dom.className = 'axiom-inline-instruction';
    dom.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 6px;border:1px solid var(--color-border-strong,#444);border-radius:6px;background:var(--color-surface-overlay,#1e1e1e);box-shadow:0 6px 18px rgba(0,0,0,.35);font-size:12px;';

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Describe the edit…';
    input.setAttribute('aria-label', 'Inline edit instruction');
    input.style.cssText = 'min-width:240px;background:transparent;border:none;outline:none;color:var(--color-text-primary,#eee);font:inherit;font-family:var(--font-mono,monospace);';

    const submit = document.createElement('button');
    submit.type = 'button';
    submit.textContent = 'Edit';
    submit.style.cssText = 'cursor:pointer;border:none;border-radius:4px;background:var(--color-accent,#5e6ad2);color:#fff;font:inherit;padding:2px 8px;';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = '✕';
    cancel.setAttribute('aria-label', 'Cancel inline edit');
    cancel.style.cssText = 'cursor:pointer;border:1px solid currentColor;border-radius:4px;background:transparent;color:inherit;font:inherit;padding:1px 6px;';

    let settled = false;
    let widget: { getId: () => string; getDomNode: () => HTMLElement; getPosition: () => unknown } | null = null;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      if (widget) { try { ed.removeContentWidget?.(widget); } catch { /* already gone */ } }
      // Return focus to the editor so Ctrl+Z / Ctrl+Right hit Monaco, not the
      // now-removed input.
      try { (ed as { focus?: () => void }).focus?.(); } catch { /* best-effort */ }
      resolve(value);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(input.value.trim()); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(null); }
    });
    submit.addEventListener('click', () => finish(input.value.trim()));
    cancel.addEventListener('click', () => finish(null));

    dom.append(input, submit, cancel);
    widget = {
      getId: () => 'axiom.inlineEditInstruction',
      getDomNode: () => dom,
      getPosition: () => ({ position: { lineNumber: anchor.lineNumber, column: anchor.column }, preference: [1] }),
    };
    try {
      ed.addContentWidget?.(widget);
    } catch {
      resolve(window.prompt('Axiom inline edit — instruction:'));
      return;
    }
    setTimeout(() => input.focus(), 0);
  });
}

/** Last ghost text per model, for word-by-word partial accept and instant
 *  remainder serve. `partial` marks entries produced by our own partial
 *  accept — only those are served synchronously, so a stale network ghost
 *  can never shadow fresh model output. */
interface GhostEntry {
  versionId: number;
  lineNumber: number;
  column: number;
  text: string;
  partial: boolean;
}
const ghostByModel = new WeakMap<object, GhostEntry>();

/** Leading-whitespace-plus-first-word on one line, else a lone newline, else
 *  the whole (whitespace-only) tail. */
export function nextWordChunk(rem: string): string {
  const m = /^[ \t]*\S+/.exec(rem);
  if (m) return m[0];
  if (rem.startsWith('\n')) return '\n';
  return rem;
}

/** Default ON. `VITE_AXIOM_COMPLETION_STREAM=off|0|false|no` forces the
 *  non-stream lane without touching call sites (rollout kill switch). */
function streamDefaultEnabled(): boolean {
  try {
    const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
    const flag = env?.VITE_AXIOM_COMPLETION_STREAM;
    if (typeof flag === 'string' && /^(0|false|off|no)$/i.test(flag.trim())) return false;
  } catch { /* not running under Vite: keep the default */ }
  return true;
}
const COMPLETION_STREAM_DEFAULT = streamDefaultEnabled();

/** Resolve the streaming client defensively. A Vitest module mock (and some
 *  bundler shims) proxies an undefined named export by *throwing* on access
 *  rather than yielding undefined, so probe it once, guarded. */
function resolveCompletionStreamFn(): typeof axiomEditorCompleteStream | null {
  try {
    return typeof axiomEditorCompleteStream === 'function' ? axiomEditorCompleteStream : null;
  } catch {
    return null;
  }
}
const completionStreamFn = resolveCompletionStreamFn();

/** Streaming runs unless explicitly disabled — and only when the streaming
 *  client is actually present (keeps callers on older/mocked clients intact). */
function streamEnabledFor(opts: AxiomMonacoOptions): boolean {
  if (!completionStreamFn) return false;
  if (opts.completionStreamEnabled === false) return false;
  if (opts.completionStreamEnabled === true) return true;
  return COMPLETION_STREAM_DEFAULT;
}

/** The editor the providers are currently mounted on. Providers are global to
 *  a Monaco instance, so this is refreshed on every register call. */
let activeEditor: EditorApi | null = null;
let refreshingInlineSuggest = false;

interface StreamSession {
  versionId: number | null;
  lineNumber: number;
  column: number;
  text: string;
  source?: string;
  controller: AbortController;
  done: boolean;
}
const streamSessionByModel = new WeakMap<object, StreamSession>();

function abortStream(modelKey: object): void {
  const session = streamSessionByModel.get(modelKey);
  if (!session) return;
  try { session.controller.abort(); } catch { /* noop */ }
  streamSessionByModel.delete(modelKey);
}

/** Ask Monaco to re-read the (cached) completion so a newly-arrived tail is
 *  painted. The provider serves an active session's text with no new request,
 *  so this cannot stampede the model. */
function refreshInlineSuggest(): void {
  if (refreshingInlineSuggest) return;
  const ed = activeEditor as unknown as { trigger?: (source: string, id: string, payload: unknown) => void } | null;
  if (!ed?.trigger) return;
  refreshingInlineSuggest = true;
  try { ed.trigger('axiom.stream', 'editor.action.inlineSuggest.trigger', {}); }
  catch { /* older Monaco: the final text still lands on the next keystroke */ }
  finally { refreshingInlineSuggest = false; }
}

/** Ghost text for an accumulated string, honouring the local-model contract
 *  and single-line mode (shared with the non-stream path). */
function streamGhostText(text: string, source: string | undefined, o: AxiomMonacoOptions): string {
  const decision = decideGhostText({ text, meta: { source }, phase: 'streaming' }, { singleLine: o.singleLine });
  return decision.show ? decision.text : '';
}

/** Start an SSE completion and resolve `first` as soon as anything showable
 *  exists, so the provider can return without waiting for the whole stream.
 *  `final` settles when the stream ends (or fails) for the background update. */
function openCompletionStream(
  params: Parameters<typeof axiomEditorCompleteStream>[0],
  modelKey: object,
  model: { getVersionId?: () => number } | null | undefined,
  position: { lineNumber?: number; column?: number } | null | undefined,
  versionId: number | null,
): {
  first: Promise<{ text: string; source?: string; meta: CompletionStreamMeta }>;
  final: Promise<{ text?: string; source?: string } | undefined>;
} {
  const session: StreamSession = {
    versionId,
    lineNumber: position?.lineNumber ?? 1,
    column: position?.column ?? 1,
    text: '',
    controller: new AbortController(),
    done: false,
  };
  streamSessionByModel.set(modelKey, session);

  if (!completionStreamFn) {
    return {
      first: Promise.reject(new Error('completion stream client unavailable')),
      final: Promise.resolve(undefined),
    };
  }

  let settleFirst: ((value: { text: string; source?: string; meta: CompletionStreamMeta }) => void) | null = null;
  let failFirst: ((reason: unknown) => void) | null = null;
  let settled = false;
  const first = new Promise<{ text: string; source?: string; meta: CompletionStreamMeta }>((resolve, reject) => {
    settleFirst = resolve;
    failFirst = reject;
  });

  const isStale = (): boolean => {
    const current = typeof model?.getVersionId === 'function' ? model.getVersionId() : null;
    return session.controller.signal.aborted || current !== versionId;
  };

  const final = completionStreamFn(params, {
    signal: session.controller.signal,
    onDelta: (text, meta) => {
      if (isStale()) {
        try { session.controller.abort(); } catch { /* noop */ }
        return;
      }
      session.text = text;
      if (meta?.source !== undefined) session.source = meta.source;
      if (!settled) {
        settled = true;
        settleFirst?.({ text: session.text, source: session.source, meta });
      } else {
        refreshInlineSuggest();
      }
    },
  }).then((res) => {
    session.done = true;
    const data = res.data;
    if (data?.text) {
      session.text = data.text;
      if (data.source !== undefined) session.source = data.source;
    }
    if (!settled) {
      settled = true;
      settleFirst?.({ text: session.text, source: session.source, meta: { source: data?.source } });
    } else {
      refreshInlineSuggest();
    }
    return data;
  }).catch((err) => {
    session.done = true;
    if (!settled) {
      settled = true;
      failFirst?.(err);
    }
    throw err;
  });
  // The terminal rejection is either surfaced through `first` (pre-show) or is
  // a partial ghost already visible; never let it escape as unhandled.
  final.catch(() => { /* handled above */ });

  return { first, final };
}

function recordShown(extra: { proxyMs?: unknown; latencyMs?: unknown; lane?: unknown; cached?: unknown }): void {
  const proxyMs = typeof extra.proxyMs === 'number' ? extra.proxyMs : 0;
  const latencyMs = typeof extra.latencyMs === 'number' ? extra.latencyMs : null;
  tabStats.lastTotalMs = latencyMs === null ? (extra.proxyMs === undefined ? tabStats.lastTotalMs : proxyMs) : proxyMs + latencyMs;
  tabStats.lastLane = typeof extra.lane === 'string' ? extra.lane : tabStats.lastLane;
  tabStats.lastCached = extra.cached === true;
  tabStats.shown += 1;
  tabStats.updatedAt = Date.now();
  emitTabStats();
}

/** Fetch the project file list from Axiom, cached briefly. */
async function listFiles(projectPath: string): Promise<string[]> {
  const now = Date.now();
  if (fileCache && fileCache.project === projectPath && now - fileCache.at < 30_000) return fileCache.files;
  try {
    const res = await axiomEditorIndex({ dir: projectPath }) as { data?: { entries?: Array<{ path?: string }> } };
    const files = (res.data?.entries ?? []).map((e) => e.path).filter((p): p is string => typeof p === 'string');
    fileCache = { project: projectPath, at: now, files };
    return files;
  } catch {
    return fileCache?.files ?? [];
  }
}

/**
 * Register Axiom's Monaco providers/actions. Safe to call on every editor
 * mount: providers are registered once per monaco instance and the action once
 * per editor instance.
 */
export function registerAxiomMonaco(monaco: MonacoApi, editor: EditorApi, opts: AxiomMonacoOptions): void {
  liveOpts = { ...liveOpts, ...opts };
  activeEditor = editor;
  if (!registeredMonaco.has(monaco as unknown as object)) {
    registeredMonaco.add(monaco as unknown as object);
    for (const lang of INLINE_LANGS) {
      monaco.languages.registerInlineCompletionsProvider(lang, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        provideInlineCompletions: async (model: any, position: any, _context: any, token: any) => {
          const o = liveOpts;
          if (o.completionEnabled === false) return { items: [] };
          if (!o.projectPath) return { items: [] };
          // Instant remainder serve: our own partial accept left a remainder
          // at exactly this position — no network, no delay, no flicker.
          const ghost = ghostByModel.get(model as unknown as object);
          if (ghost?.partial
            && ghost.lineNumber === position?.lineNumber
            && ghost.column === position?.column
            && typeof model?.getVersionId === 'function'
            && model.getVersionId() === ghost.versionId
            && ghost.text) {
            recordShown({ proxyMs: 0, latencyMs: 0, lane: 'cache', cached: true });
            return {
              items: [{
                insertText: ghost.text,
                range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
              }],
              enableForwardStability: true,
            };
          }
          // A live stream at exactly this anchor serves its latest text with no
          // new request. This is both the "later deltas update the ghost" path
          // (our own refresh trigger lands here) and a cheap re-serve.
          const modelKey = model as unknown as object;
          const versionId = typeof model?.getVersionId === 'function' ? model.getVersionId() : null;
          const anchorLine = position?.lineNumber ?? 1;
          const anchorColumn = position?.column ?? 1;
          const streaming = streamEnabledFor(o);
          if (streaming) {
            const live = streamSessionByModel.get(modelKey);
            if (live
              && live.versionId === versionId
              && live.lineNumber === anchorLine
              && live.column === anchorColumn) {
              const text = streamGhostText(live.text, live.source, o);
              if (text) {
                return {
                  items: [{
                    insertText: text,
                    range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
                  }],
                  enableForwardStability: true,
                };
              }
            }
          }
          const delay = Math.max(0, o.completionDelayMs ?? 0);
          if (delay > 0) {
            await new Promise((r) => setTimeout(r, delay));
            if (token?.isCancellationRequested) return { items: [] };
          }
          if (token?.isCancellationRequested) return { items: [] };
          const ctrl = new AbortController();
          const sub = token?.onCancellationRequested?.(() => ctrl.abort());
          // Before the first delta the provider token is authoritative; after we
          // return, cancellation must not kill the still-streaming request, so
          // this listener is removed in `finally`.
          const onCtrlAbort = (): void => abortStream(modelKey);
          ctrl.signal.addEventListener('abort', onCtrlAbort);
          const requestParams = withRetrievalDir({
            file: String(model?.uri?.path ?? ''),
            content: String(model?.getValue?.() ?? ''),
            line: position?.lineNumber ?? 1,
            column: position?.column ?? 1,
            ...(o.model ? { model: o.model } : {}),
          }, o.projectPath);
          try {
            // Streaming lane: resolve on the first partial for first-token
            // latency, then refresh later deltas in place. Any failure before a
            // ghost is shown falls through to the non-stream lane below.
            if (streaming) {
              const stale = streamSessionByModel.get(modelKey);
              if (stale && (stale.versionId !== versionId || stale.lineNumber !== anchorLine || stale.column !== anchorColumn)) {
                abortStream(modelKey);
              }
              try {
                const t0 = Date.now();
                const opened = openCompletionStream(requestParams, modelKey, model, position, versionId);
                const first = await opened.first;
                if (ctrl.signal.aborted || token?.isCancellationRequested) {
                  abortStream(modelKey);
                  return { items: [] };
                }
                const text = streamGhostText(first.text, first.source, o);
                if (text) {
                  // Report the real first-token latency, not a hardcoded 0.
                  const firstTokenMs = typeof first.meta?.firstTokenMs === 'number'
                    ? first.meta.firstTokenMs
                    : (typeof first.meta?.latencyMs === 'number' ? first.meta.latencyMs : Date.now() - t0);
                  recordShown({ proxyMs: 0, latencyMs: firstTokenMs, lane: 'stream' });
                  axiomEditorTelemetry({ kind: 'completion', lane: 'stream' });
                  if (typeof model?.getVersionId === 'function') {
                    ghostByModel.set(modelKey, {
                      versionId: model.getVersionId(),
                      lineNumber: position.lineNumber,
                      column: position.column,
                      text,
                      partial: false,
                    });
                  }
                  // Keep the visible ghost in step with the stream, then take
                  // the final text; the provider serves the session cache, so
                  // refreshes never re-hit the model.
                  void opened.final.then((data) => {
                    if (!data?.text) return;
                    const updated = streamGhostText(data.text, data.source, o);
                    if (!updated || typeof model?.getVersionId !== 'function') return;
                    ghostByModel.set(modelKey, {
                      versionId: model.getVersionId(),
                      lineNumber: position.lineNumber,
                      column: position.column,
                      text: updated,
                      partial: false,
                    });
                    refreshInlineSuggest();
                  }).catch(() => { /* pre-show failure already fell back below */ });
                  return {
                    items: [{
                      insertText: text,
                      range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
                    }],
                    enableForwardStability: true,
                  };
                }
                abortStream(modelKey);
                return { items: [] };
              } catch (e) {
                if ((e as Error)?.name === 'AbortError' || ctrl.signal.aborted || token?.isCancellationRequested) return { items: [] };
                abortStream(modelKey);
                // Hard fallback: the non-stream lane below runs exactly as today.
              }
            }
            const res = await axiomEditorComplete(requestParams, ctrl.signal) as {
              proxyMs?: number;
              data?: { text?: string; source?: string; latencyMs?: number; lane?: string; cached?: boolean; tier?: 'local' | 'hosted' };
            };
            if (ctrl.signal.aborted || token?.isCancellationRequested) return { items: [] };
            const data = res.data;
            if (!data || data.source !== 'local-model' || !data.text) return { items: [] };
            let text = data.text;
            if (o.singleLine) {
              const nl = text.indexOf('\n');
              if (nl >= 0) text = text.slice(0, nl);
              if (!text) return { items: [] };
            }
            recordShown({ proxyMs: res.proxyMs, latencyMs: data.latencyMs, lane: data.lane, cached: data.cached });
            axiomEditorTelemetry({ kind: 'completion', tier: data.tier, lane: data.lane, cached: data.cached, latencyMs: data.latencyMs });
            if (typeof model?.getVersionId === 'function') {
              ghostByModel.set(model as unknown as object, {
                versionId: model.getVersionId(),
                lineNumber: position.lineNumber,
                column: position.column,
                text,
                partial: false,
              });
            }
            return {
              items: [{
                insertText: text,
                range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column),
              }],
              // Typing forward along the ghost text keeps it (no re-query storm).
              enableForwardStability: true,
            };
          } catch (e) {
            // Aborts are routine (user kept typing) — stay silent either way.
            if ((e as Error)?.name === 'AbortError' || ctrl.signal.aborted) return { items: [] };
            return { items: [] };
          } finally {
            ctrl.signal.removeEventListener('abort', onCtrlAbort);
            try { (sub as { dispose?: () => void })?.dispose?.(); } catch { /* noop */ }
          }
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handlePartialAccept: (_completions: any, _item: any, _acceptedChars: number) => {
          tabStats.partialAccepts += 1;
          tabStats.updatedAt = Date.now();
          emitTabStats();
        },
        freeInlineCompletions: () => { /* nothing retained */ },
      });

      monaco.languages.registerCompletionItemProvider(lang, {
        triggerCharacters: ['@'],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        provideCompletionItems: async (model: any, position: any) => {
          if (!liveOpts.projectPath) return { suggestions: [] };
          const line = String(model?.getLineContent?.(position.lineNumber) ?? '').slice(0, position.column - 1);
          const m = /@[\w./-]*$/.exec(line);
          if (!m) return { suggestions: [] };
          const files = await listFiles(liveOpts.projectPath);
          const range = new monaco.Range(position.lineNumber, position.column - m[0].length, position.lineNumber, position.column);
          // Non-file mention forms the resolver understands, offered alongside
          // file paths so `@git` / `@docs:` are discoverable without docs.
          const statics = [
            { label: '@git — working-tree diff', insert: '@git' },
            { label: '@docs: — search markdown', insert: '@docs:' },
          ]
            .filter((s) => s.insert.startsWith(m[0]))
            .map((s) => ({
              label: s.label,
              kind: monaco.languages.CompletionItemKind.Keyword,
              insertText: s.insert,
              filterText: `${m[0]}${s.insert}`,
              range,
            }));
          return {
            suggestions: [
              ...statics,
              ...files.slice(0, 200).map((f) => ({
                label: f,
                kind: monaco.languages.CompletionItemKind.File,
                insertText: `@file:${f}`,
                // The range replaces the typed `@...` text, so Monaco scores the
                // matching word (e.g. "@") against filterText. Without the trigger
                // prefix here, no label matches and Monaco drops every item.
                filterText: `${m[0]}${f}`,
                range,
              })),
            ],
          };
        },
      });
    }
  }

  if (!registeredEditors.has(editor as unknown as object)) {
    registeredEditors.add(editor as unknown as object);
    // Word-by-word partial accept (Cursor's Ctrl/Cmd+Right). Scoped to
    // `inlineSuggestionVisible` so built-in word navigation is untouched when
    // no ghost text is showing. The remainder is served instantly by the
    // provider above — the chain needs no further network until the user
    // deviates from the ghost.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (editor as any).addCommand?.(
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.RightArrow,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ed = editor as any;
          const model = ed.getModel?.();
          const p = ed.getPosition?.();
          if (!model || !p) return;
          const entry = ghostByModel.get(model as unknown as object);
          if (!entry?.text
            || entry.lineNumber !== p.lineNumber
            || entry.column !== p.column
            || (typeof model.getVersionId === 'function' && model.getVersionId() !== entry.versionId)) return;
          const chunk = nextWordChunk(entry.text);
          if (!chunk) return;
          const hasNl = chunk.includes('\n');
          ed.pushUndoStop();
          ed.executeEdits('axiom.acceptNextWord', [{
            range: new monaco.Range(p.lineNumber, p.column, p.lineNumber, p.column),
            text: chunk,
          }]);
          ed.pushUndoStop();
          const rest = entry.text.slice(chunk.length);
          if (rest && typeof model.getVersionId === 'function') {
            ghostByModel.set(model as unknown as object, {
              versionId: model.getVersionId(),
              lineNumber: hasNl ? p.lineNumber + 1 : p.lineNumber,
              column: hasNl ? 1 : p.column + chunk.length,
              text: rest,
              partial: true,
            });
          } else {
            ghostByModel.delete(model as unknown as object);
          }
          tabStats.partialAccepts += 1;
          tabStats.updatedAt = Date.now();
          emitTabStats();
        },
        'inlineSuggestionVisible',
      );
    } catch { /* older Monaco without addCommand/context — Tab accept still works */ }

    // ---- Proactive fix loop -------------------------------------------------
    // Surface Axiom as a Monaco Quick Fix on any compiler/server diagnostic, and
    // a "fix all" pass. Both reuse the inline-edit lane and apply directly
    // (undo-bracketed), so a red squiggle is one click from fixed.
    const toDiagnostic = (m: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number; code?: unknown; message?: unknown }): DiagnosticLike => ({
      line: m.startLineNumber,
      column: m.startColumn,
      endLine: m.endLineNumber,
      endColumn: m.endColumn,
      code: typeof m.code === 'string' ? m.code : (typeof (m.code as { value?: unknown } | undefined)?.value === 'string' ? String((m.code as { value: string }).value) : undefined),
      message: String(m.message ?? ''),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const applyDiagnosticFix = async (ed: any, diag: DiagnosticLike): Promise<boolean> => {
      const o = liveOpts;
      const model = ed.getModel?.();
      if (!o.projectPath || !model) return false;
      const lineCount = typeof model.getLineCount === 'function' ? model.getLineCount() : 1;
      const r = fixRangeFor(diag, lineCount);
      const range = new monaco.Range(r.startLineNumber, r.startColumn, r.endLineNumber, r.endColumn);
      const selection = model.getValueInRange(range);
      if (!selection.trim()) return false;
      try {
        const res = await axiomEditorInlineEdit(withRetrievalDir({
          file: String(model.uri?.path ?? ''),
          content: String(model.getValue?.() ?? ''),
          selection,
          instruction: fixInstructionFor(diag),
          line: r.startLineNumber,
          column: r.startColumn,
          ...(o.model ? { model: o.model } : {}),
        }, o.projectPath)) as { data?: { text?: string; source?: string; note?: string } };
        const data = res.data;
        if (!data || data.source !== 'local-model' || !data.text) {
          o.onStatus?.(data?.note ?? `fix unavailable (no local model); ${retrievalTrigger(o.projectPath).note}`);
          return false;
        }
        if (data.text === selection) {
          o.onStatus?.('Axiom fix returned no change');
          return false;
        }
        ed.pushUndoStop?.();
        ed.executeEdits('axiom.fixDiagnostic', [{ range, text: data.text }]);
        ed.pushUndoStop?.();
        o.onStatus?.(`Axiom fixed ${diag.code ?? 'the problem'} on line ${diag.line}`);
        axiomEditorTelemetry({ kind: 'inline-edit', outcome: 'accepted', hunksAccepted: 1, hunksTotal: 1 });
        return true;
      } catch {
        o.onStatus?.('Axiom fix request failed');
        return false;
      }
    };

    if (!codeActionsRegistered.has(monaco as unknown as object)
      && typeof monaco.languages.registerCodeActionProvider === 'function') {
      codeActionsRegistered.add(monaco as unknown as object);
      for (const lang of INLINE_LANGS) {
        monaco.languages.registerCodeActionProvider(lang, {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          provideCodeActions: (model: any, range: any, context: any) => {
            const o = liveOpts;
            const empty = { actions: [], dispose: () => undefined };
            if (o.completionEnabled === false || !o.projectPath) return empty;
            const severity = monaco.MarkerSeverity;
            const source: Array<{ startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number; severity: number; code?: unknown; message?: unknown }> =
              (context.markers && context.markers.length ? context.markers : monaco.editor.getModelMarkers({ resource: model.uri }));
            const markers = source.filter((m) => m.severity === severity.Error || m.severity === severity.Warning);
            if (!markers.length) return empty;
            const line = range.startLineNumber;
            const actions: Array<Record<string, unknown>> = [];
            const here = markers.find((m) => line >= m.startLineNumber && line <= m.endLineNumber);
            if (here) {
              const d = toDiagnostic(here);
              actions.push({
                title: d.code ? `Axiom: Fix ${d.code}` : 'Axiom: Fix this problem',
                kind: 'quickfix',
                diagnostics: [here],
                isPreferred: true,
                command: { id: 'axiom.fixDiagnostic', title: 'Axiom: fix problem', arguments: [d] },
              });
            }
            actions.push({
              title: `Axiom: Fix all problems in this file (${markers.length})`,
              kind: 'quickfix',
              command: { id: 'axiom.fixAllDiagnostics', title: 'Axiom: fix all problems', arguments: [markers.map(toDiagnostic)] },
            });
            return { actions, dispose: () => undefined };
          },
        });
      }
    }
    editor.addAction({
      id: 'axiom.fixDiagnostic',
      label: 'Axiom: fix problem',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      run: async (ed: any, diag?: DiagnosticLike) => {
        if (diag) await applyDiagnosticFix(ed, diag);
      },
    });
    editor.addAction({
      id: 'axiom.fixAllDiagnostics',
      label: 'Axiom: fix all problems in file',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      run: async (ed: any, diags?: DiagnosticLike[]) => {
        const list = Array.isArray(diags) ? [...diags] : [];
        if (!list.length) return;
        // Bottom-up so applying a fix never invalidates the line numbers of the
        // diagnostics still queued below it.
        list.sort((a, b) => b.line - a.line);
        const batch = list.slice(0, 10);
        let fixed = 0;
        for (const d of batch) {
          if (!(await applyDiagnosticFix(ed, d))) break;
          fixed += 1;
        }
        liveOpts.onStatus?.(`Axiom: fixed ${fixed}/${batch.length} problems`);
      },
    });
    editor.addAction({
      id: 'axiom.inlineEdit',
      label: 'Axiom: edit selection with instruction',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      run: async (ed: any) => {
        const o = liveOpts;
        const model = ed.getModel();
        const sel = ed.getSelection();
        if (!model || !sel) return;
        // A new inline edit supersedes any undecided one: drop its overlays so
        // the buffer has exactly one outstanding review.
        const previous = pendingInlineEdit.get(ed as unknown as object);
        if (previous) {
          previous.decorations?.clear?.();
          if (previous.widget && typeof ed.removeContentWidget === 'function') { try { ed.removeContentWidget(previous.widget); } catch { /* best-effort */ } }
          for (const d of previous.disposables) { try { d.dispose?.(); } catch { /* best-effort */ } }
          pendingInlineEdit.delete(ed as unknown as object);
        }
        const selection = model.getValueInRange(sel) || model.getLineContent(sel.startLineNumber);
        const anchor = typeof sel.getStartPosition === 'function'
          ? sel.getStartPosition()
          : { lineNumber: sel.startLineNumber, column: sel.startColumn };
        const instruction = await promptInlineInstruction(ed, anchor);
        if (instruction === null) return;
        const trimmedInstruction = instruction.trim();
        if (!trimmedInstruction) {
          o.onStatus?.('Inline edit needs a non-empty instruction.');
          return;
        }
        try {
          const res = await axiomEditorInlineEdit(withRetrievalDir({
            file: String(model.uri?.path ?? ''),
            content: model.getValue(),
            selection,
            instruction: trimmedInstruction,
            line: sel.startLineNumber,
            column: sel.startColumn,
            ...(o.model ? { model: o.model } : {}),
          }, o.projectPath)) as { data?: { text?: string; source?: string; note?: string } };
          const data = res.data;
          if (!data || data.source !== 'local-model' || !data.text) {
            o.onStatus?.(data?.note ?? `inline edit unavailable (no local model); ${retrievalTrigger(o.projectPath).note}`);
            return;
          }
          if (data.text === selection) {
            o.onStatus?.('inline edit returned no change');
            return;
          }
          const start = anchor;
          const review = createInlineReview(selection, data.text);
          const pending: PendingInlineEdit = {
            original: selection,
            proposed: data.text,
            review,
            start,
            range: spanAt(data.text, start),
            versionId: null,
            decorations: null,
            widget: null,
            disposables: [],
          };
          // Paint every hunk as a real diff: accepted hunks green, rejected
          // hunks red over the original lines they keep.
          const decorate = (): void => {
            pending.decorations?.clear?.();
            try {
              if (typeof ed.createDecorationsCollection === 'function') {
                const decorations = reviewHunkRanges(pending.review).map((r) => ({
                  range: new monaco.Range(r.startLineNumber, 1, r.endLineNumber, 1),
                  options: {
                    isWholeLine: true,
                    className: r.accepted ? 'axiom-inline-edit-added' : 'axiom-inline-edit-rejected',
                    linesDecorationsClassName: r.accepted ? 'axiom-inline-edit-glyph' : 'axiom-inline-edit-glyph-rejected',
                  },
                }));
                pending.decorations = ed.createDecorationsCollection(decorations);
              }
            } catch { pending.decorations = null; }
          };
          const removeWidget = (): void => {
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              if (pending.widget && typeof (ed as any).removeContentWidget === 'function') (ed as any).removeContentWidget(pending.widget);
            } catch { /* best-effort */ }
            pending.widget = null;
          };
          // A compact review widget anchored at the edit: one toggle per hunk
          // plus "accept all", so accept/reject is a click, not a palette trip.
          const renderWidget = (): void => {
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const anyEd = ed as any;
              if (typeof anyEd.addContentWidget !== 'function') return;
              removeWidget();
              const dom = document.createElement('div');
              dom.className = 'axiom-inline-review';
              dom.style.cssText = 'display:flex;align-items:center;gap:6px;padding:2px 6px;border:1px solid var(--color-border-strong,#444);border-radius:4px;background:var(--color-surface-overlay,#1e1e1e);font-size:11px;font-family:monospace;';
              const label = document.createElement('span');
              label.textContent = reviewStatus(pending.review);
              dom.appendChild(label);
              for (const d of reviewDecisions(pending.review)) {
                const btn = document.createElement('button');
                btn.textContent = `${d.accepted ? '✓' : '✗'} hunk ${d.index + 1}`;
                btn.title = d.accepted ? 'Reject this hunk' : 'Accept this hunk';
                btn.style.cssText = 'cursor:pointer;border:1px solid currentColor;border-radius:3px;background:transparent;color:inherit;font:inherit;padding:0 3px;';
                btn.onclick = (ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                  decideHunk(pending.review, d.index, !d.accepted);
                  recompute();
                  axiomEditorTelemetry({ kind: 'inline-edit', outcome: reviewOutcome(pending.review), hunksAccepted: acceptedCount(pending.review), hunksTotal: pending.review.hunks.length });
                  o.onStatus?.(reviewStatus(pending.review));
                };
                dom.appendChild(btn);
              }
              if (!allAccepted(pending.review)) {
                const acceptAll = document.createElement('button');
                acceptAll.textContent = 'accept all';
                acceptAll.style.cssText = 'cursor:pointer;border:none;border-radius:3px;background:transparent;color:inherit;font:inherit;text-decoration:underline;padding:0 2px;';
                acceptAll.onclick = (ev) => {
                  ev.preventDefault();
                  ev.stopPropagation();
                  for (const h of pending.review.hunks) decideHunk(pending.review, h.index, true);
                  recompute();
                  axiomEditorTelemetry({ kind: 'inline-edit', outcome: 'accepted', hunksAccepted: pending.review.hunks.length, hunksTotal: pending.review.hunks.length });
                  o.onStatus?.(reviewStatus(pending.review));
                };
                dom.appendChild(acceptAll);
              }
              const widget = {
                getId: () => 'axiom.inlineEditReview',
                getDomNode: () => dom,
                getPosition: () => ({
                  position: { lineNumber: pending.start.lineNumber, column: 1 },
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  preference: [(monaco as any).editor?.ContentWidgetPositionPreference?.BELOW ?? 1],
                }),
              };
              anyEd.addContentWidget(widget);
              pending.widget = widget as unknown as { remove?: () => void };
            } catch { pending.widget = null; }
          };
          // Recompute the buffer for the current accepted set. Unrejected edits
          // keep the full proposed text; a subset reconstructs from the original.
          const recompute = (): void => {
            const text = reviewBuffer(pending.review);
            ed.pushUndoStop?.();
            ed.executeEdits('axiom.inlineEditHunks', [{ range: new monaco.Range(pending.range.startLineNumber, pending.range.startColumn, pending.range.endLineNumber, pending.range.endColumn), text }]);
            ed.pushUndoStop?.();
            pending.range = spanAt(text, pending.start);
            const m = ed.getModel?.();
            pending.versionId = m && typeof m.getVersionId === 'function' ? m.getVersionId() : null;
            decorate();
            renderWidget();
          };

          ed.pushUndoStop();
          ed.executeEdits('axiom.inlineEdit', [{ range: sel, text: data.text }]);
          ed.pushUndoStop();
          pending.versionId = typeof model.getVersionId === 'function' ? model.getVersionId() : null;
          decorate();
          renderWidget();

          // One accept + one reject action per hunk, so the decision is
          // per-change, not all-or-nothing. Registered on the editor and
          // disposed when the edit is decided.
          for (const h of pending.review.hunks) {
            const total = pending.review.hunks.length;
            // Alt+1..9 accepts a hunk, Alt+Shift+1..9 rejects it. Digit codes are
            // only defined for 1..9, so beyond that the widget/palette still work.
            const digitCode = (n: number): number | undefined => {
              const codes: Array<number | undefined> = [undefined,
                monaco.KeyCode.Digit1, monaco.KeyCode.Digit2, monaco.KeyCode.Digit3,
                monaco.KeyCode.Digit4, monaco.KeyCode.Digit5, monaco.KeyCode.Digit6,
                monaco.KeyCode.Digit7, monaco.KeyCode.Digit8, monaco.KeyCode.Digit9];
              return n >= 1 && n <= 9 ? codes[n] : undefined;
            };
            const register = (id: string, label: string, run: () => void, keybindings?: number[]): void => {
              try {
                const d = ed.addAction({ id, label, run, ...(keybindings ? { keybindings } : {}) });
                if (d && typeof d.dispose === 'function') pending.disposables.push(d);
              } catch { /* older Monaco without dynamic actions: accept-all still works */ }
            };
            const rejectCode = digitCode(h.index + 1);
            register(
              `axiom.inlineEdit.rejectHunk.${h.index}`,
              `Axiom: reject inline-edit hunk ${h.index + 1}/${total}`,
              () => { decideHunk(pending.review, h.index, false); recompute(); o.onStatus?.(`inline-edit hunk ${h.index + 1}/${total} rejected (${acceptedCount(pending.review)} accepted)`); axiomEditorTelemetry({ kind: 'inline-edit', outcome: reviewOutcome(pending.review), hunksAccepted: acceptedCount(pending.review), hunksTotal: total }); },
              rejectCode ? [monaco.KeyMod.Alt | monaco.KeyMod.Shift | rejectCode] : undefined,
            );
            const acceptCode = digitCode(h.index + 1);
            register(
              `axiom.inlineEdit.acceptHunk.${h.index}`,
              `Axiom: accept inline-edit hunk ${h.index + 1}/${total}`,
              () => { decideHunk(pending.review, h.index, true); recompute(); o.onStatus?.(`inline-edit hunk ${h.index + 1}/${total} accepted (${acceptedCount(pending.review)} accepted)`); axiomEditorTelemetry({ kind: 'inline-edit', outcome: reviewOutcome(pending.review), hunksAccepted: acceptedCount(pending.review), hunksTotal: total }); },
              acceptCode ? [monaco.KeyMod.Alt | acceptCode] : undefined,
            );
          }
          pendingInlineEdit.set(ed as unknown as object, pending);
          o.onStatus?.(`Axiom inline edit applied (${pending.review.hunks.length} hunk${pending.review.hunks.length === 1 ? '' : 's'}) — Accept all (axiom.acceptInlineEdit), Reject all (axiom.rejectInlineEdit), or per-hunk in the review widget.`);
        } catch {
          o.onStatus?.('inline edit request failed');
        }
      },
    });
    editor.addAction({
      id: 'axiom.acceptInlineEdit',
      label: 'Axiom: accept inline edit',
      keybindings: [monaco.KeyMod.Alt | monaco.KeyMod.Shift | monaco.KeyCode.KeyA],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      run: async (ed: any) => {
        const pending = pendingInlineEdit.get(ed as unknown as object);
        if (!pending) {
          liveOpts.onStatus?.('no pending Axiom inline edit to accept');
          return;
        }
        pending.decorations?.clear();
        if (pending.widget && typeof ed.removeContentWidget === 'function') { try { ed.removeContentWidget(pending.widget); } catch { /* best-effort */ } }
        for (const d of pending.disposables) { try { d.dispose?.(); } catch { /* best-effort */ } }
        pendingInlineEdit.delete(ed as unknown as object);
        axiomEditorTelemetry({ kind: 'inline-edit', outcome: 'accepted', hunksAccepted: pending.review.hunks.length, hunksTotal: pending.review.hunks.length });
        ed.pushUndoStop();
        liveOpts.onStatus?.('Axiom inline edit accepted');
      },
    });
    editor.addAction({
      id: 'axiom.rejectInlineEdit',
      label: 'Axiom: reject inline edit',
      keybindings: [monaco.KeyMod.Alt | monaco.KeyMod.Shift | monaco.KeyCode.KeyR],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      run: async (ed: any) => {
        const pending = pendingInlineEdit.get(ed as unknown as object);
        if (!pending) {
          liveOpts.onStatus?.('no pending Axiom inline edit to reject');
          return;
        }
        pending.decorations?.clear();
        if (pending.widget && typeof ed.removeContentWidget === 'function') { try { ed.removeContentWidget(pending.widget); } catch { /* best-effort */ } }
        for (const d of pending.disposables) { try { d.dispose?.(); } catch { /* best-effort */ } }
        pendingInlineEdit.delete(ed as unknown as object);
        axiomEditorTelemetry({ kind: 'inline-edit', outcome: 'rejected', hunksAccepted: 0, hunksTotal: pending.review.hunks.length });
        const model = ed.getModel?.();
        const currentVersion = model && typeof model.getVersionId === 'function' ? model.getVersionId() : null;
        // Exact restore when the buffer is untouched; otherwise undo (never
        // insert the original at a stale offset and corrupt the file).
        if (model && (pending.versionId === null || currentVersion === pending.versionId)) {
          ed.pushUndoStop();
          ed.executeEdits('axiom.rejectInlineEdit', [{
            range: new monaco.Range(pending.range.startLineNumber, pending.range.startColumn, pending.range.endLineNumber, pending.range.endColumn),
            text: pending.original,
          }]);
          ed.pushUndoStop();
          liveOpts.onStatus?.('Axiom inline edit rejected — original restored');
        } else {
          ed.trigger('axiom.rejectInlineEdit', 'undo', null);
          liveOpts.onStatus?.('Axiom inline edit rejected — restored via undo');
        }
      },
    });
    editor.addAction({
      id: 'axiom.jumpToNextEdit',
      label: 'Axiom: jump to next predicted edit',
      keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyJ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      run: async (ed: any) => {
        const o = liveOpts;
        if (!o.projectPath) {
          o.onStatus?.('no project loaded — cannot predict the next edit');
          return;
        }
        const model = ed.getModel();
        const pos = ed.getPosition?.();
        if (!model || !pos) return;
        try {
          const res = await axiomEditorNextEdit({
            dir: o.projectPath,
            file: String(model.uri?.path ?? ''),
            content: String(model.getValue?.() ?? ''),
            line: pos.lineNumber ?? 1,
            column: pos.column ?? 1,
            complete: false,
          }) as { data?: { candidates?: Array<{ file?: string; line?: number; reason?: string }> } };
          const cands = Array.isArray(res.data?.candidates) ? res.data!.candidates! : [];
          const base = (String(model.uri?.path ?? '').split('/').pop() ?? '').toLowerCase();
          const same = cands.find((c) => (String(c.file ?? '').split('/').pop() ?? '').toLowerCase() === base
            && typeof c.line === 'number' && c.line !== pos.lineNumber)
            ?? cands.find((c) => typeof c.line === 'number' && (String(c.file ?? '').split('/').pop() ?? '').toLowerCase() === base);
          if (!same || typeof same.line !== 'number') {
            const other = cands[0];
            o.onStatus?.(other?.file
              ? `next edit is in ${other.file}:${other.line ?? 1} — open it to jump there`
              : 'no next edit predicted here');
            return;
          }
          ed.revealLineInCenter(same.line);
          ed.setPosition({ lineNumber: same.line, column: 1 });
          ed.focus();
          o.onStatus?.(`jumped to predicted next edit (line ${same.line}${same.reason ? ` — ${same.reason}` : ''})`);
        } catch {
          o.onStatus?.('next-edit prediction request failed');
        }
      },
    });
  }
}
