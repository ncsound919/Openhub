// Warm OpenHub completion path (R6 item 2 — "warm OpenHub route").
//
// The default editor completion path is browser → OpenHub proxy → Axiom
// (:3198) → local model: two server hops before the model. This module lets
// OpenHub call the local model DIRECTLY and hold the connection, so the fast
// path is browser → OpenHub → model. One hop fewer, no Axiom HMAC mint per
// keystroke.
//
// Scope and honesty:
//   - This is the FIM fast lane ONLY. It does not do retrieval or the chat
//     fallback — those stay in Axiom's `completeInline`. On any miss
//     (tier unconfigured/unreachable, no FIM text, timeout, abort) it returns
//     null and the caller proxies to Axiom, which still has retrieval + chat.
//     So the warm path only replaces a completion Axiom's own FIM lane would
//     have produced; it never produces a worse answer, only a closer one.
//   - The FIM request shapes mirror Axiom's `src/server/nextEdit.ts`
//     (`tryFimComplete`) — that file is the source of truth. If a shape changes
//     there, change it here. The duplication is the cost of removing the hop
//     and is deliberately kept small (three shapes, one template).
//   - Tier config (base/model) is DISCOVERED from Axiom's `/api/editor/models`
//     (which returns `base`), TTL-cached, so there is no second copy of the
//     model config to drift. A per-request `model` override wins.
//   - Never throws: every failure is a `null` miss.
//
// Note: this is a marginal latency win, not a structural one. Measured, the
// Axiom hop is a few ms on loopback; the real Tab wins are the abort-based
// cancellation, the 30s prompt cache, and the speculative prefetch already in
// the Axiom path. This removes the last redundant hop and keeps config in one
// place — it does not by itself make Tab <100ms on a slow CPU tier.

import { axiomEditorModels } from './axiomClient.js';

const TIER_TTL_MS = 60_000;
const CACHE_TTL_MS = 30_000;
const CACHE_MAX = 200;
const FIM_MAX_TOKENS = 64;
const FIM_TIMEOUT_MS = 8000;

export interface LocalTier {
  base: string;
  model: string;
}

export interface WarmCompletion {
  text: string;
  lane: 'fim';
  /** True when served from the local prompt cache (no model call). */
  cached: boolean;
  /** Model-only wall time in ms (0 for a cache read). */
  modelMs: number;
}

// ---------------------------------------------------------------------------
// Tier discovery (single source of truth: Axiom).
// ---------------------------------------------------------------------------

let tierCache: { at: number; base: string | null; configured: string | null } | null = null;

async function discoverTier(): Promise<{ base: string | null; configured: string | null }> {
  const now = Date.now();
  if (tierCache && now - tierCache.at < TIER_TTL_MS) return tierCache;
  try {
    const m = (await axiomEditorModels()) as { base?: unknown; configured?: unknown };
    const base = typeof m?.base === 'string' && m.base ? m.base : null;
    const configured = typeof m?.configured === 'string' && m.configured ? m.configured : null;
    tierCache = { at: now, base, configured };
  } catch {
    // Axiom unreachable: no tier for this TTL. The caller proxies (and that
    // will also fail, honestly), rather than guessing a local URL.
    tierCache = { at: now, base: null, configured: null };
  }
  return tierCache;
}

/** The local tier to call directly, or null when it cannot be determined. */
export async function resolveLocalTier(modelOverride?: string): Promise<LocalTier | null> {
  const { base, configured } = await discoverTier();
  const model = (modelOverride ?? '').trim() || configured;
  if (!base || !model) return null;
  return { base, model };
}

/** Test seam: drop the cached tier so the next call re-discovers it. */
export function resetLocalTierCache(): void {
  tierCache = null;
}

// ---------------------------------------------------------------------------
// Prompt cache + in-flight dedupe (same key shape as Axiom's completionCache).
// ---------------------------------------------------------------------------

const cache = new Map<string, { at: number; text: string }>();
const inflight = new Map<string, Promise<WarmCompletion | null>>();

function readCache(key: string): string | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.text;
}

function writeCache(key: string, text: string): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, { at: Date.now(), text });
}

/** Test seam: clear the warm completion cache. */
export function clearLocalCompletionCache(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// FIM request shapes (ported from Axiom's tryFimComplete).
// ---------------------------------------------------------------------------

type FimMode = 'off' | 'auto' | 'ollama' | 'llamacpp';

function fimMode(env: NodeJS.ProcessEnv = process.env): FimMode {
  const m = (env.AXIOM_FIM_MODE || 'auto').trim().toLowerCase();
  return m === 'off' || m === 'ollama' || m === 'llamacpp' ? m : 'auto';
}

function serverOrigin(base: string): string {
  return base.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
}

function renderFimPrompt(template: string, prefix: string, suffix: string): string {
  return template.split('{prefix}').join(prefix).split('{suffix}').join(suffix);
}

function stripFences(text: string): string {
  return text.replace(/^\s*```[a-zA-Z0-9]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
}

interface FimAttempt {
  url: string;
  body: unknown;
  pick: (j: { response?: unknown; content?: unknown; choices?: Array<{ text?: unknown }> }) => string;
}

function fimAttempts(base: string, model: string, prefix: string, suffix: string): FimAttempt[] {
  const mode = fimMode();
  if (mode === 'off') return [];
  const origin = serverOrigin(base);
  const template = (process.env.AXIOM_FIM_TEMPLATE || '').trim();
  const prompt = template ? renderFimPrompt(template, prefix, suffix) : prefix;
  const attempts: FimAttempt[] = [];
  if (mode === 'auto' || mode === 'ollama') {
    attempts.push({
      url: `${origin}/api/generate`,
      body: { model, prompt, suffix, stream: false, options: { num_predict: FIM_MAX_TOKENS, temperature: 0.2 } },
      pick: (j) => (typeof j.response === 'string' ? j.response : ''),
    });
  }
  if (mode === 'auto' || mode === 'llamacpp') {
    attempts.push({
      url: `${origin}/completion`,
      body: {
        prompt,
        ...(template ? {} : { input_suffix: suffix }),
        n_predict: FIM_MAX_TOKENS,
        cache_prompt: true,
        temperature: 0.2,
        stop: ['```'],
      },
      pick: (j) => (typeof j.content === 'string' ? j.content : ''),
    });
    attempts.push({
      url: `${base.replace(/\/+$/, '')}/completions`,
      body: {
        model,
        prompt,
        ...(template ? {} : { suffix }),
        max_tokens: FIM_MAX_TOKENS,
        temperature: 0.2,
        stream: false,
        cache_prompt: true,
        stop: ['```'],
      },
      pick: (j) => {
        const t = j.choices?.[0]?.text;
        return typeof t === 'string' ? t : '';
      },
    });
  }
  return attempts;
}

/** Direct FIM call. Returns null on any failure so the caller can proxy. */
async function tryFim(
  base: string,
  model: string,
  prefix: string,
  suffix: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string | null> {
  const attempts = fimAttempts(base, model, prefix, suffix);
  const deadline = Date.now() + Math.max(200, timeoutMs);
  for (const a of attempts) {
    if (signal?.aborted) return null;
    const remaining = deadline - Date.now();
    if (remaining <= 50) return null;
    const ctrl = new AbortController();
    const onAbort = (): void => ctrl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), remaining);
    try {
      const r = await fetch(a.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(a.body),
        signal: ctrl.signal,
      });
      if (!r.ok) continue;
      const j = (await r.json()) as { response?: unknown; content?: unknown; choices?: Array<{ text?: unknown }> };
      const text = stripFences(a.pick(j));
      if (text.trim()) return text;
      return null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

export interface WarmRequest {
  file: string;
  content: string;
  line: number;
  column: number;
  /** Per-request model override (the editor's model picker). */
  model?: string;
  timeoutMs?: number;
}

/** A direct local-model completion, or null to let the caller proxy to Axiom. */
export function warmFimComplete(req: WarmRequest, signal?: AbortSignal): Promise<WarmCompletion | null> {
  return warmFim(req, signal, false);
}

/** After a real completion resolves, prefetch the next cursor line so a Tab
 *  there is a cache read. Mirrors Axiom's `prefetchNextCursor`; `skipPrefetch`
 *  on the worker prevents a recursive chain. */
function prefetchNext(req: WarmRequest, signal?: AbortSignal): void {
  const content = String(req?.content ?? '');
  const nextLine = (Number(req?.line) || 1) + 1;
  if (nextLine > content.split(/\r?\n/).length) return;
  void warmFim({ ...req, line: nextLine, column: 1 }, signal, true).catch(() => { /* best-effort */ });
}

async function warmFim(req: WarmRequest, signal: AbortSignal | undefined, skipPrefetch: boolean): Promise<WarmCompletion | null> {
  const file = String(req?.file ?? '');
  const content = String(req?.content ?? '');
  const line = Number(req?.line) || 1;
  const column = Number(req?.column) || 1;
  const tier = await resolveLocalTier(req?.model);
  if (!tier) return null;

  const lines = content.split(/\r?\n/);
  const before = [...lines.slice(0, line - 1), (lines[line - 1] ?? '').slice(0, Math.max(0, column - 1))].join('\n');
  const after = [(lines[line - 1] ?? '').slice(Math.max(0, column - 1)), ...lines.slice(line)].join('\n');
  const prefix = `File: ${file}\n${before}`.slice(-4000);
  const suffix = after.slice(0, 2000);
  const key = `${file}\n${prefix.slice(-1200)}\n${suffix.slice(0, 600)}`;

  const cached = readCache(key);
  if (cached !== null) return { text: cached, lane: 'fim', cached: true, modelMs: 0 };

  const existing = inflight.get(key);
  if (existing) return existing;

  const task = (async (): Promise<WarmCompletion | null> => {
    const start = Date.now();
    const text = await tryFim(tier.base, tier.model, prefix, suffix, req?.timeoutMs ?? FIM_TIMEOUT_MS, signal);
    if (!text) return null;
    writeCache(key, text);
    if (!skipPrefetch) prefetchNext(req, signal);
    return { text, lane: 'fim', cached: false, modelMs: Date.now() - start };
  })();
  inflight.set(key, task);
  try {
    return await task;
  } finally {
    inflight.delete(key);
  }
}
