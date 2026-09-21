/**
 * Unified fleet LLM routing through the operator's provider seam (per OPS.md):
 * a LiteLLM-style gateway at http://localhost:4100/v1/chat/completions serving
 * the `fleet-free` model group, with optional fallback base URLs from env.
 *
 * Binding rules: credentials are resolved from env only (never hardcoded,
 * never logged, never embedded in errors); real failures return
 * `{ ok: false, error }` — a review is never fabricated.
 */

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmResult {
  ok: boolean;
  text: string | null;
  provider: string | null;
  error?: string;
}

export interface RunLlmOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
}

export const DEFAULT_LLM_BASE_URL = 'http://localhost:4100';
export const DEFAULT_LLM_MODEL = 'fleet-free';
export const DEFAULT_LLM_TIMEOUT_MS = 60_000;

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

/**
 * POST one chat-completions request. Resolves with the assistant text or
 * throws an explicit, key-free error (network, non-2xx, bad body, timeout).
 */
async function attemptChat(
  baseUrl: string,
  apiKey: string | undefined,
  model: string,
  messages: LlmMessage[],
  timeoutMs: number,
): Promise<string> {
  const url = `${baseUrl.replace(/\/+$/, '')}${COMPLETIONS_PATH}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages }),
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
  return content;
}

/**
 * Run an LLM conversation against the fleet seam, falling back across
 * `OPENHUB_LLM_FALLBACKS` (comma-separated base URLs) on failure. The primary
 * uses `OPENHUB_LLM_MODEL`; fallbacks use `OPENHUB_LLM_FALLBACK_MODEL` when set
 * (so a local primary can fall back to a differently-named API model). Per-
 * provider keys may only differ via env. When every provider fails, the last
 * error wins and no throw escapes.
 */
export async function runLlm(
  messages: LlmMessage[],
  opts: RunLlmOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<LlmResult> {
  const baseUrl = opts.baseUrl || env.OPENHUB_LLM_BASE_URL || DEFAULT_LLM_BASE_URL;
  const model = opts.model || env.OPENHUB_LLM_MODEL || DEFAULT_LLM_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;

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

  let lastError: string | null = null;
  for (const attempt of attempts) {
    try {
      const text = await attemptChat(attempt.baseUrl, attempt.apiKey, attempt.model, messages, timeoutMs);
      return { ok: true, text, provider: attempt.baseUrl };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  return { ok: false, text: null, provider: null, error: lastError ?? 'LLM request failed' };
}