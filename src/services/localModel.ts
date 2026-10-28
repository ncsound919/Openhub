/**
 * The phone's own GGUF model (a small Qwen served by llama.cpp or Ollama).
 *
 * Two things consume it:
 *   - OpenHub's LLM tier (reviews, chat, workspace tools, reports) through
 *     `llmRouter`, and
 *   - the opencode engine as a `local` provider, so missions and their tools can
 *     run against it.
 *
 * A phone-bound setup cannot assume which server is running, so the probe tries
 * the configured base first and then the two well-known local ports
 * (llama.cpp `llama-server` :8080, Ollama :11434). Whichever answers is reported
 * by name — nothing is invented, and an unreachable model reads as unreachable.
 *
 * `OPENHUB_LOCAL_LLM_MODEL` pins the model id; when it is unset, or when the
 * server serves something else, the id advertised by `GET /v1/models` is used so
 * a renamed GGUF does not break the wiring.
 */

export const LOCAL_PROVIDER_ID = 'local';
export const LOCAL_PROBE_PATH = '/v1/models';

/** Where a phone-bound local server usually listens when nothing is configured. */
export const DEFAULT_LOCAL_LLM_URL = 'http://127.0.0.1:11434';

/** The operator's model: Qwen 3.5 4B, GGUF, served locally on the phone. */
export const DEFAULT_LOCAL_LLM_MODEL = 'qwen3.5-4b';

/** Well-known local inference ports, tried after the configured base URL. */
export const LOCAL_FALLBACK_BASES = ['http://127.0.0.1:11434', 'http://127.0.0.1:8080'];

const PROBE_TIMEOUT_MS = 2000;
const PROBE_TTL_MS = 30_000;

export interface LocalModelTarget {
  /** Base URL without a trailing slash or `/v1` suffix. */
  baseUrl: string;
  /** Configured model id (may be empty: the server advertises its own). */
  modelId: string;
  apiKey?: string;
  /** Bases to try, configured first, de-duplicated. */
  candidates: string[];
}

export interface LocalModelProbe {
  reachable: boolean;
  /** Base URL that answered, when reachable. */
  baseUrl: string | null;
  /** Model ids the server advertises (empty when it advertises none). */
  models: string[];
  /** The id OpenHub will use: the configured one when the server lists it, else the first listed. */
  modelId: string | null;
  error?: string;
  checkedAt: string;
}

/** Strip a trailing slash and an OpenAI `/v1` suffix so paths append cleanly. */
export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}

export function localModelTarget(env: NodeJS.ProcessEnv = process.env): LocalModelTarget | null {
  const configured = (env.OPENHUB_LOCAL_LLM_URL || '').trim();
  const modelId = (env.OPENHUB_LOCAL_LLM_MODEL || '').trim();
  // Nothing configured at all: stay out of the way (llmRouter keeps its own defaults).
  if (!configured && !modelId) return null;
  const base = normalizeBaseUrl(configured || DEFAULT_LOCAL_LLM_URL);
  const candidates = [base, ...LOCAL_FALLBACK_BASES.map(normalizeBaseUrl)].filter(
    (url, i, all) => all.indexOf(url) === i,
  );
  const apiKey = (env.OPENHUB_LOCAL_LLM_KEY || '').trim() || undefined;
  return { baseUrl: base, modelId, candidates, ...(apiKey ? { apiKey } : {}) };
}

/** Probe one base for its advertised models. Never throws. */
export async function probeBase(
  base: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<{ ok: boolean; models: string[]; error?: string }> {
  try {
    const res = await fetchImpl(`${base}${LOCAL_PROBE_PATH}`, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, models: [], error: `HTTP ${res.status}` };
    const body = await res.json().catch(() => null) as { data?: Array<{ id?: unknown }> } | null;
    const models = Array.isArray(body?.data)
      ? body.data.map((m) => (typeof m?.id === 'string' ? m.id : '')).filter(Boolean)
      : [];
    return { ok: true, models };
  } catch (err) {
    return { ok: false, models: [], error: err instanceof Error ? err.message : String(err) };
  }
}

let cache: { at: number; probe: LocalModelProbe } | null = null;

/** Test seam: drop the cached probe. */
export function resetLocalModelCache(): void {
  cache = null;
}

/**
 * Probe the local model, trying the configured base then the well-known ports.
 * Results are cached briefly: prompts and the health lane call this often.
 */
export async function probeLocalModel(
  env: NodeJS.ProcessEnv = process.env,
  deps: { fetchImpl?: typeof fetch; timeoutMs?: number; now?: () => number } = {},
): Promise<LocalModelProbe> {
  const now = deps.now ?? Date.now;
  if (cache && now() - cache.at < PROBE_TTL_MS) return cache.probe;
  const target = localModelTarget(env);
  const checkedAt = new Date().toISOString();
  if (!target) {
    const probe: LocalModelProbe = { reachable: false, baseUrl: null, models: [], modelId: null, error: 'not configured', checkedAt };
    cache = { at: now(), probe };
    return probe;
  }
  const errors: string[] = [];
  for (const base of target.candidates) {
    const res = await probeBase(base, deps.fetchImpl ?? fetch, deps.timeoutMs);
    if (!res.ok) {
      errors.push(`${base}: ${res.error ?? 'unreachable'}`);
      continue;
    }
    const advertised = res.models;
    const modelId = target.modelId && advertised.includes(target.modelId)
      ? target.modelId
      : (advertised[0] ?? target.modelId ?? null);
    const probe: LocalModelProbe = { reachable: true, baseUrl: base, models: advertised, modelId, checkedAt };
    cache = { at: now(), probe };
    return probe;
  }
  const probe: LocalModelProbe = {
    reachable: false,
    baseUrl: null,
    models: [],
    modelId: target.modelId || null,
    error: errors.join('; ') || 'unreachable',
    checkedAt,
  };
  cache = { at: now(), probe };
  return probe;
}

/**
 * The opencode model reference for the local model — `local/qwen3.5-4b` — or
 * null when the server is not answering right now. Used as the default model for
 * missions that do not name one, so a phone with the model running works without
 * any extra configuration.
 */
export async function localOpencodeModel(
  env: NodeJS.ProcessEnv = process.env,
  deps: { fetchImpl?: typeof fetch; timeoutMs?: number; now?: () => number } = {},
): Promise<{ providerID: string; modelID: string } | null> {
  const probe = await probeLocalModel(env, deps);
  if (!probe.reachable || !probe.modelId) return null;
  return { providerID: LOCAL_PROVIDER_ID, modelID: probe.modelId };
}

/**
 * opencode provider block for a local OpenAI-compatible server, merged into the
 * engine config at spawn (see opencodeEngine.buildEngineEnv).
 *
 * The shape is opencode's v1 config (`provider` + `npm`/`options`, model
 * `tool_call`), which is what 1.19.x — the version this app manages — reads.
 * The newer v2 shape (`providers` + `package`/`settings`) is silently ignored by
 * 1.19.x, which is why a local model used to load but never appear as a provider.
 *
 * `tool_call` is declared so the engine offers the local model its tool set;
 * without it a small local model is treated as chat-only and cannot drive the
 * agent loop.
 */
export function localProviderConfig(
  target: LocalModelTarget,
  discoveredModels: string[] = [],
): Record<string, unknown> {
  const modelIds = [target.modelId, ...discoveredModels].filter((id, i, all) => id && all.indexOf(id) === i);
  const models: Record<string, unknown> = {};
  for (const id of modelIds) {
    models[id] = { name: `${id} (local)`, tool_call: true };
  }
  return {
    provider: {
      [LOCAL_PROVIDER_ID]: {
        name: 'Local model (phone)',
        npm: '@ai-sdk/openai-compatible',
        options: {
          baseURL: `${target.baseUrl}/v1`,
          ...(target.apiKey ? { apiKey: target.apiKey } : { apiKey: 'local-no-key' }),
        },
        models,
      },
    },
  };
}

/**
 * Engine config overlay: the operator's own opencode config with the local
 * provider merged in, as JSON for `OPENCODE_CONFIG_CONTENT`.
 *
 * The full file is re-serialized rather than replaced, so MCP servers, agents and
 * every other setting the operator configured survive the overlay. A config that
 * cannot be parsed is NOT silently discarded — the caller gets the error and must
 * decide (the engine keeps running on the operator's own file).
 */
export function mergeLocalProvider(
  userConfig: unknown,
  target: LocalModelTarget,
  discoveredModels: string[] = [],
): { ok: true; config: Record<string, unknown> } | { ok: false; error: string } {
  if (userConfig != null && (typeof userConfig !== 'object' || Array.isArray(userConfig))) {
    return { ok: false, error: 'opencode config is not a JSON object' };
  }
  const base = { ...((userConfig as Record<string, unknown> | null) ?? {}) };
  const existing = (base.provider && typeof base.provider === 'object' && !Array.isArray(base.provider))
    ? { ...(base.provider as Record<string, unknown>) }
    : {};
  const overlay = localProviderConfig(target, discoveredModels) as { provider: Record<string, Record<string, unknown>> };
  const overlayLocal = overlay.provider[LOCAL_PROVIDER_ID];
  const priorLocal = (existing[LOCAL_PROVIDER_ID] && typeof existing[LOCAL_PROVIDER_ID] === 'object')
    ? (existing[LOCAL_PROVIDER_ID] as Record<string, unknown>)
    : {};
  // Keep any models the operator already declared for this provider.
  const priorModels = (priorLocal.models && typeof priorLocal.models === 'object' && !Array.isArray(priorLocal.models))
    ? (priorLocal.models as Record<string, unknown>)
    : {};
  existing[LOCAL_PROVIDER_ID] = {
    ...overlayLocal,
    ...priorLocal,
    models: { ...(overlayLocal.models as Record<string, unknown>), ...priorModels },
  };
  base.provider = existing;
  return { ok: true, config: base };
}
