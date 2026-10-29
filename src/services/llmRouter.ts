/**
 * Unified fleet LLM routing through the operator's provider seam (per OPS.md):
 * a LiteLLM-style gateway at http://localhost:4100/v1/chat/completions serving
 * the `fleet-free` model group, with optional fallback base URLs from env.
 *
 * Local-first tier (new): on the default `auto` tier, `runLlm` first tries a
 * small local model (llama.cpp / llama-server, e.g. MiniCPM5-1B) with a bounded
 * token budget and a no-think template, so routine chat/extraction/short-gen
 * never bills the gateway. Any local failure or empty reply falls through to
 * the fleet gateway exactly as before. Callers that need real-model quality on
 * an explicitly critical path pass `tier: 'critical'` to skip the local tier.
 * A usage ledger records which tier answered, so the reduction is measurable.
 *
 * Binding rules: credentials are resolved from env only (never hardcoded,
 * never logged, never embedded in errors); real failures return
 * `{ ok: false, error }` — a review is never fabricated.
 */

import { probeBase } from './localModel.js';

export type LlmTier = 'auto' | 'local' | 'gateway' | 'critical';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmResult {
  ok: boolean;
  text: string | null;
  provider: string | null;
  /** Which tier answered: 'local' (small model) or 'gateway' (fleet seam). */
  tier?: 'local' | 'gateway';
  error?: string;
}

export interface RunLlmOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  /**
   * `auto` (default) — local small model first, fleet gateway on failure.
   * `local` — local model only; honest fail when it can't answer.
   * `gateway`/`critical` — fleet gateway only (local never consulted).
   * An explicit `baseUrl` option is treated as gateway-only (an explicit
   * provider choice), preserving the historical contract.
   */
  tier?: LlmTier;
  /** Local output cap. Small CPU models stay fast with a small budget. */
  localMaxTokens?: number;
  /**
   * Request structured output. On the local tier this is enforced with llama.cpp
   * `response_format.json_schema` (constrained decoding — a small model cannot
   * produce malformed JSON); the gateway receives `json_object`, which is the
   * portable OpenAI-compatible form. Callers that need trustworthy extraction
   * SHOULD pass this — never trust raw 1B JSON.
   *
   * The local reply is parsed before it is accepted: a schema-constrained model
   * can still emit prose or an empty object, and that is a reason to escalate,
   * not a result to hand back.
   */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  /**
   * Which app is calling. Sent to the gateway as `x-llm-app` so Sieve can
   * attribute spend and failures per app; never used for authorisation.
   */
  app?: string;
  /**
   * Task hint for the shared gateway's lane order: `general`, `fast`, `code`,
   * `reasoning`, or `free`. `free` is a hard guarantee that no paid lane is used.
   */
  task?: string;
  /**
   * Skip the local tier when the request needs more context than it can hold.
   * The phone model is a 4B/8k-class model; a 40k-token document is not a
   * "maybe it fits" case.
   */
  minContextTokens?: number;
  /** The local model has no tool-calling contract; callers that need one skip it. */
  needsTools?: boolean;
}

export const DEFAULT_LLM_BASE_URL = 'http://localhost:4100';
export const DEFAULT_LLM_MODEL = 'fleet-free';
export const DEFAULT_LLM_TIMEOUT_MS = 60_000;

/** Local tier defaults: llama.cpp server, MiniCPM5-1B-Claude-Opus-Fable5-V2
 *  (community fine-tune: stronger instruction-following + tool-calling). */
export const DEFAULT_LOCAL_LLM_URL = 'http://127.0.0.1:11434';
// The operator's phone-bound model: Qwen 3.5 4B GGUF (llama.cpp/Ollama).
export const DEFAULT_LOCAL_LLM_MODEL = 'qwen3.5-4b';

/**
 * A local server is chosen by the operator's own env first; when that base
 * refuses the connection (llama.cpp `llama-server` usually listens on 8080,
 * Ollama on 11434) the other well-known local port is tried and the model id it
 * advertises is used. HTTP-level errors are NOT retried elsewhere: a server that
 * answered is the operator's server, and its error is reported as-is.
 */
function isConnectionFailure(message: string): boolean {
  return /failed:|ECONNREFUSED|ECONNRESET|timed out|network|fetch failed|ENOTFOUND|socket hang up/i.test(message);
}
export const DEFAULT_LOCAL_MAX_TOKENS = 512;
const LOCAL_LLM_TIMEOUT_MS = 45_000;
/** Above this, the phone model is the wrong tool; go straight to the gateway. */
const LOCAL_CONTEXT_TOKENS = 8192;

/** True only when `text` is a JSON object (not an array, not prose, not empty). */
function isJsonObject(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Usage ledger: which tier served what, so LLM-bill reduction is measurable.
// ---------------------------------------------------------------------------

export interface LlmUsageEntry {
  ts: number;
  tier: 'local' | 'gateway';
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Which app made the call, for per-app spend attribution. */
  app?: string;
  /** Task hint passed to the shared gateway. */
  task?: string;
}

const usageLedger: LlmUsageEntry[] = [];

/** Drain and return all recorded usage since the last take. */
export function takeLlmUsage(): LlmUsageEntry[] {
  return usageLedger.splice(0);
}

/** Test seam: clear the ledger. */
export function resetLlmUsage(): void {
  usageLedger.length = 0;
}

export function llmUsageSummary(env: NodeJS.ProcessEnv = process.env): {
  calls: number;
  localCalls: number;
  gatewayCalls: number;
  totalTokens: number;
  localPct: number;
  gatewayPct: number;
} {
  const agg = usageLedger.reduce(
    (a, e) => ({
      calls: a.calls + 1,
      localCalls: a.localCalls + (e.tier === 'local' ? 1 : 0),
      gatewayCalls: a.gatewayCalls + (e.tier === 'gateway' ? 1 : 0),
      totalTokens: a.totalTokens + e.totalTokens,
    }),
    { calls: 0, localCalls: 0, gatewayCalls: 0, totalTokens: 0 },
  );
  return {
    ...agg,
    localPct: agg.calls > 0 ? Math.round((agg.localCalls / agg.calls) * 1000) / 10 : 0,
    gatewayPct: agg.calls > 0 ? Math.round((agg.gatewayCalls / agg.calls) * 1000) / 10 : 0,
  };
}

/** Resolve the gateway key from env; never logs or embeds it in errors. */
function resolveKey(env: NodeJS.ProcessEnv, explicitKey?: string, preferExplicit = true): string | undefined {
  if (preferExplicit && explicitKey) return explicitKey;
  return env.OPENHUB_LLM_KEY || env.LITELLM_MASTER_KEY || undefined;
}

/** Remove any key material that could leak into error text. */
function redactSecrets(text: string, apiKey?: string): string {
  return apiKey ? text.split(apiKey).join('[redacted]') : text;
}

const COMPLETIONS_PATH = '/v1/chat/completions';

/** Well-known local inference ports, tried only after a refused connection. */
const LOCAL_PROBE_BASES = ['http://127.0.0.1:11434', 'http://127.0.0.1:8080'];

interface ChatAttemptResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * POST one chat-completions request. Resolves with the assistant text + usage
 * or throws an explicit, key-free error (network, non-2xx, bad body, timeout).
 */
async function attemptChat(
  baseUrl: string,
  apiKey: string | undefined,
  model: string,
  messages: LlmMessage[],
  timeoutMs: number,
  extra: { maxTokens?: number; temperature?: number; noThink?: boolean; jsonSchema?: { name: string; schema: Record<string, unknown> }; jsonObject?: boolean; headers?: Record<string, string> } = {},
): Promise<ChatAttemptResult> {
  const url = `${baseUrl.replace(/\/+$/, '')}${COMPLETIONS_PATH}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(extra.headers ?? {}) };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const body: Record<string, unknown> = { model, messages };
  if (extra.maxTokens !== undefined) body.max_tokens = extra.maxTokens;
  if (extra.temperature !== undefined) body.temperature = extra.temperature;
  // MiniCPM-class hybrid-reasoning models dump a thinking block by default;
  // the no-think template makes them answer directly (keeps decisions fast).
  if (extra.noThink) body.chat_template_kwargs = { enable_thinking: false };
  if (extra.jsonSchema) {
    body.response_format = { type: 'json_schema', json_schema: { name: extra.jsonSchema.name, schema: extra.jsonSchema.schema } };
  } else if (extra.jsonObject) {
    body.response_format = { type: 'json_object' };
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new Error(`LLM request to ${url} timed out after ${timeoutMs}ms`);
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`LLM request to ${url} failed: ${message}`);
  }

  if (!res.ok) {
    let detail = '';
    try {
      detail = redactSecrets((await res.text()).slice(0, 500).trim(), apiKey);
    } catch {
      // Body unreadable — status alone is explicit enough.
    }
    throw new Error(
      `LLM request to ${url} returned HTTP ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`,
    );
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`LLM request to ${url} returned invalid JSON: ${message}`);
  }

  const content = (data as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.length === 0) {
    throw new Error(`LLM request to ${url} returned no choices[0].message.content`);
  }
  const u = (data as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown } })?.usage;
  const promptTokens = Number(u?.prompt_tokens) || 0;
  const completionTokens = Number(u?.completion_tokens) || 0;
  const totalTokens = Number(u?.total_tokens) || promptTokens + completionTokens;
  return { text: content, promptTokens, completionTokens, totalTokens };
}

/** The local small-model tier, resolved from env. Accepts a base with or
 *  without the OpenAI `/v1` suffix (attemptChat appends `/v1/chat/completions`). */
function localTier(env: NodeJS.ProcessEnv): { base: string; model: string } {
  const base = (env.OPENHUB_LOCAL_LLM_URL || DEFAULT_LOCAL_LLM_URL)
    .replace(/\/+$/, '')
    .replace(/\/v1$/, '');
  const model = (env.OPENHUB_LOCAL_LLM_MODEL || DEFAULT_LOCAL_LLM_MODEL).trim();
  return { base, model: model || DEFAULT_LOCAL_LLM_MODEL };
}

/** The other well-known local port, tried only after a refused connection. */
function localFallbackBases(_env: NodeJS.ProcessEnv, configured: string): string[] {
  return LOCAL_PROBE_BASES
    .map((base) => base.replace(/\/+$/, '').replace(/\/v1$/, ''))
    .filter((base) => base !== configured);
}

/**
 * Run an LLM conversation. Default `auto`: the local small model first, then the
 * fleet gateway seam (falling back across `OPENHUB_LLM_FALLBACKS` on failure).
 * `tier: 'critical'` skips the local tier entirely — the fleet gateway is the
 * only answerer, preserving the historical contract for quality-critical paths.
 * When every provider fails, the last error wins and no throw escapes.
 */
export async function runLlm(
  messages: LlmMessage[],
  opts: RunLlmOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<LlmResult> {
  const requestedTier: LlmTier = opts.tier ?? 'auto';
  // An explicit baseUrl is an explicit provider choice: skip the local tier so
  // the historical contract (baseUrl answers, or the fallbacks do) is intact.
  const tier: LlmTier = opts.baseUrl ? 'gateway' : requestedTier;
  const skipLocal = tier === 'gateway' || tier === 'critical';
  const skipGateway = tier === 'local';
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
  const app = (opts.app ?? 'openhub').trim() || 'openhub';
  const task = (opts.task ?? 'general').trim().toLowerCase() || 'general';
  const gatewayHeaders = { 'x-llm-app': app, 'x-llm-task': task };
  let lastError: string | null = null;

  // A 4B phone model is the right answer for short, interactive work and the
  // wrong answer for a 40k-token document or a tool-calling contract. Do not
  // pretend otherwise: skip it and let the shared gateway carry the request.
  const localTooSmall =
    (opts.minContextTokens ?? 0) > LOCAL_CONTEXT_TOKENS || Boolean(opts.needsTools);

  // Local small-model tier first: bounded, no-think, fast. Failure falls through.
  if (!skipLocal && !localTooSmall) {
    const lt = localTier(env);
    const localOpts = { maxTokens: opts.localMaxTokens ?? DEFAULT_LOCAL_MAX_TOKENS, temperature: 0.2, noThink: true, jsonSchema: opts.jsonSchema };
    const localTimeout = Math.min(timeoutMs, LOCAL_LLM_TIMEOUT_MS);
    try {
      const r = await attemptChat(lt.base, undefined, lt.model, messages, localTimeout, localOpts);
      // Constrained decoding is a strong hint, not a guarantee. If the caller
      // needs JSON and the local model produced something else, that is a local
      // failure and the gateway should see the request.
      if (opts.jsonSchema && !isJsonObject(r.text)) {
        throw new Error('local reply was not a JSON object');
      }
      usageLedger.push({
        ts: Date.now(),
        tier: 'local',
        provider: lt.base,
        model: lt.model,
        ...r,
        app,
        task,
      });
      return { ok: true, text: r.text, provider: `local:${lt.base}`, tier: 'local' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lastError = `local:${message}`;
      // Only a refused/unroutable base justifies trying the other local port.
      if (isConnectionFailure(message)) {
        for (const alt of localFallbackBases(env, lt.base)) {
          const discovered = await probeBase(alt, fetch, 1500);
          if (!discovered.ok) {
            lastError = `local:${alt}: ${discovered.error ?? 'unreachable'}`;
            continue;
          }
          const model = discovered.models.includes(lt.model) ? lt.model : (discovered.models[0] ?? lt.model);
          try {
            const r = await attemptChat(alt, undefined, model, messages, localTimeout, localOpts);
            if (opts.jsonSchema && !isJsonObject(r.text)) {
              throw new Error('local reply was not a JSON object');
            }
            usageLedger.push({ ts: Date.now(), tier: 'local', provider: alt, model, ...r, app, task });
            return { ok: true, text: r.text, provider: `local:${alt}`, tier: 'local' };
          } catch (altErr) {
            lastError = `local:${altErr instanceof Error ? altErr.message : String(altErr)}`;
          }
        }
      }
    }
  }

  // Fleet gateway chain (unchanged behavior, plus task/app attribution).
  if (!skipGateway) {
    const baseUrl = opts.baseUrl || env.OPENHUB_LLM_BASE_URL || DEFAULT_LLM_BASE_URL;
    const model = opts.model || env.OPENHUB_LLM_MODEL || DEFAULT_LLM_MODEL;
    const fallbackUrls = (env.OPENHUB_LLM_FALLBACKS ?? '')
      .split(',')
      .map((url) => url.trim())
      .filter((url) => url.length > 0);
    // Fallbacks may serve a different model name than the primary (e.g. a local
    // colibri/OLMoE primary falling back to the fleet gateway's `fleet-free`).
    const fallbackModel = env.OPENHUB_LLM_FALLBACK_MODEL || model;

    const attempts: Array<{ baseUrl: string; apiKey: string | undefined; model: string }> = [
      { baseUrl, apiKey: resolveKey(env, opts.apiKey, true), model },
      // Secondary providers are env-configured; their keys may only come from env.
      ...fallbackUrls.map((url) => ({ baseUrl: url, apiKey: resolveKey(env, undefined, false), model: fallbackModel })),
    ];

    for (const attempt of attempts) {
      try {
        const r = await attemptChat(attempt.baseUrl, attempt.apiKey, attempt.model, messages, timeoutMs, {
          jsonObject: Boolean(opts.jsonSchema),
          headers: gatewayHeaders,
        });
        usageLedger.push({
          ts: Date.now(),
          tier: 'gateway',
          provider: attempt.baseUrl,
          model: attempt.model,
          ...r,
          app,
          task,
        });
        return { ok: true, text: r.text, provider: attempt.baseUrl, tier: 'gateway' };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  return { ok: false, text: null, provider: null, error: lastError ?? 'LLM request failed' };
}