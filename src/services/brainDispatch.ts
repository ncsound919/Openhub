/**
 * Deterministic-brain dispatch — the chosen orchestration entrypoint for
 * business-development actions (per operator decision).
 *
 * Contract (verified in `deterministic-brain/api/server.py`):
 *   POST {base}/task  { "query": string, "lane_override"?: string }
 *   -> dict with `final_output`, `reasoning.chosen_skill`, `task`, ...
 *
 * The brain is a zero-LLM loop (parse → reason → execute → audit), which is why
 * it's the right owner for auditable business runs. This module never invents a
 * result: if the brain is unreachable it reports `available: false`.
 */

export interface DispatchResult {
  available: boolean;
  target: string;
  status?: number;
  data?: unknown;
  error?: string;
}

/** Chain result: which target answered, and every attempt made. */
export interface ChainResult extends DispatchResult {
  attempts: Array<{ target: string; status?: number; error?: string }>;
}

export function deterministicBrainUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.OPENHUB_BRAIN_URL || env.BRAIN_URL || 'http://127.0.0.1:3210').replace(/\/+$/, '');
}

/**
 * Uplift-Agent bridge URL. There is intentionally NO default here: the fleet
 * doc names :8000, but on this machine that port serves the colibri local LLM
 * (`coli serve --model olmoe_merged`), which answers /task with a model error.
 * Dispatching business tasks at a model endpoint would be theater, so the
 * fallback only fires when UPLIFT_AGENT_URL is explicitly configured.
 */
export function upliftAgentUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.OPENHUB_UPLIFT_AGENT_URL || env.UPLIFT_AGENT_URL || '').replace(/\/+$/, '');
}

/** POST a task to the deterministic brain. Serialised by the caller if needed. */
export async function dispatchToBrain(
  query: string,
  opts: { laneOverride?: string; timeoutMs?: number } = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<DispatchResult> {
  const target = deterministicBrainUrl(env);
  const q = String(query || '').trim();
  if (!q) return { available: false, target, error: 'query is required' };
  try {
    const res = await fetch(`${target}/task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q, ...(opts.laneOverride ? { lane_override: opts.laneOverride } : {}) }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
    });
    const data = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) return { available: false, target, status: res.status, data, error: `brain HTTP ${res.status}` };
    return { available: true, target, status: res.status, data };
  } catch (err) {
    return { available: false, target, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Uplift-Agent bridge — the fleet's async task contract:
 *   POST {base}/task { description, task_id?, session_id? } -> 202 { task_id, status: 'queued' }
 * (verified in `agents/Uplift-Agent/server.js`). Used as the fallback when the
 * deterministic brain's synchronous /task is unavailable.
 */
export async function dispatchToUpliftAgent(
  description: string,
  opts: { sessionId?: string; timeoutMs?: number } = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<DispatchResult> {
  const target = upliftAgentUrl(env);
  const d = String(description || '').trim();
  if (!target) return { available: false, target: '(unconfigured)', error: 'UPLIFT_AGENT_URL not configured' };
  if (!d) return { available: false, target, error: 'description is required' };
  try {
    const res = await fetch(`${target}/task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: d, ...(opts.sessionId ? { session_id: opts.sessionId } : {}) }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });
    const data = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) return { available: false, target, status: res.status, data, error: `uplift-agent HTTP ${res.status}` };
    return { available: true, target, status: res.status, data };
  } catch (err) {
    return { available: false, target, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Dispatch chain: deterministic brain (synchronous, auditable) first; on
 * failure fall back to the Uplift-Agent queue (unless disabled). Never fabricates
 * a result — if every target fails, `available` is false and `attempts` explains why.
 */
export async function dispatchTask(
  query: string,
  opts: { laneOverride?: string; sessionId?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<ChainResult> {
  const attempts: ChainResult['attempts'] = [];

  const brain = await dispatchToBrain(query, opts.laneOverride ? { laneOverride: opts.laneOverride } : {}, env);
  attempts.push({ target: brain.target, status: brain.status, error: brain.error });
  if (brain.available) return { ...brain, attempts };

  const fallbackEnabled = env.OPENHUB_DISPATCH_FALLBACK !== '0' && env.OPENHUB_DISPATCH_FALLBACK !== 'false';
  const fallbackUrl = upliftAgentUrl(env);
  if (fallbackEnabled && fallbackUrl) {
    const uplift = await dispatchToUpliftAgent(query, opts.sessionId ? { sessionId: opts.sessionId } : {}, env);
    attempts.push({ target: uplift.target, status: uplift.status, error: uplift.error });
    if (uplift.available) return { ...uplift, attempts };
  }

  const suffix = !fallbackEnabled ? 'fallback disabled'
    : !fallbackUrl ? 'no fallback configured (OPENHUB_UPLIFT_AGENT_URL unset)'
    : attempts.map((a) => `${a.target}: ${a.error || a.status}`).join('; ');
  return {
    available: false,
    target: attempts.map((a) => a.target).join(' -> '),
    error: `brain: ${attempts[0]?.error || attempts[0]?.status}; ${suffix}`,
    attempts,
  };
}

/** Build a deterministic task string for a CRM action. */
export function actionToQuery(action: { kind: string; title: string; detail: string; suggestion: string }): string {
  return [
    `Business development action: ${action.kind}`,
    `Title: ${action.title}`,
    `Context: ${action.detail}`,
    `Recommended step: ${action.suggestion}`,
    'Produce: (1) the concrete next step, (2) a short message draft if outreach is appropriate, (3) any date/deadline to schedule.',
  ].join('\n');
}
