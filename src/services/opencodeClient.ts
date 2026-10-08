import { OPENCODE_BASE, getEnginePassword, basicAuthHeader } from './opencodeEngine.js';

export function authHeader(pw: string = getEnginePassword()): string {
  return basicAuthHeader(pw);
}

/**
 * Opt-in project scoping: set OPENHUB_OPENCODE_DIRECTORY so sessions run in that
 * directory instead of wherever `opencode serve` happened to start (UNVERIFIED
 * header name against a live engine; unset = previous behaviour).
 */
function dirHeaders(): Record<string, string> {
  const dir = process.env.OPENHUB_OPENCODE_DIRECTORY;
  return dir ? { 'x-opencode-directory': encodeURIComponent(dir) } : {};
}

export async function ocFetch(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<any> {
  const { timeoutMs, headers, ...rest } = init;
  const method = (rest.method || 'GET').toUpperCase();
  const merged = new Headers(headers);
  for (const [k, v] of Object.entries(dirHeaders())) if (!merged.has(k)) merged.set(k, v);
  if (!merged.has('Authorization')) merged.set('Authorization', authHeader());
  if (method !== 'GET' && rest.body != null && !merged.has('Content-Type')) {
    merged.set('Content-Type', 'application/json');
  }
  const res = await fetch(`${OPENCODE_BASE}${path}`, {
    ...rest,
    headers: merged,
    signal: rest.signal ?? AbortSignal.timeout(timeoutMs ?? 30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`opencode HTTP ${res.status}: ${text || res.statusText}`);
  }
  if (res.status === 204) return {};
  return res.json().catch(() => ({}));
}

export function getEngineStatus(): Promise<any> {
  return ocFetch('/global/health');
}

/**
 * How many model providers the engine has configured, or null if it cannot be
 * determined. An engine with zero fails every prompt with ProviderNoProvidersError
 * (seen live), so the UI warns before a mission is started. The route
 * (`/config/providers`) is UNVERIFIED against a live engine: any error or odd
 * shape yields null, never a false 0.
 */
export async function providerCount(): Promise<number | null> {
  try {
    const body = await ocFetch('/config/providers', { timeoutMs: 3000 });
    const list = Array.isArray(body?.providers) ? body.providers
      : body?.providers && typeof body.providers === 'object' ? Object.keys(body.providers)
      : null;
    return list ? list.length : null;
  } catch { return null; }
}

export function listProjects(): Promise<any> {
  return ocFetch('/project');
}

export function listSessions(): Promise<any> {
  return ocFetch('/session');
}

export function getSession(id: string): Promise<any> {
  return ocFetch(`/session/${encodeURIComponent(id)}`);
}

export function sessionMessages(id: string, limit?: number): Promise<any> {
  const qs = limit == null ? '' : `?limit=${encodeURIComponent(String(limit))}`;
  return ocFetch(`/session/${encodeURIComponent(id)}/message${qs}`);
}

export function createSession(title?: string): Promise<any> {
  return ocFetch('/session', { method: 'POST', body: JSON.stringify({ title }) });
}

export interface PromptOptions {
  model?: { providerID: string; modelID: string };
  agent?: string;
}

export function promptSessionAsync(id: string, parts: unknown[], opts: PromptOptions = {}): Promise<any> {
  return ocFetch(`/session/${encodeURIComponent(id)}/prompt_async`, {
    method: 'POST',
    body: JSON.stringify({ parts, ...(opts.model ? { model: opts.model } : {}), ...(opts.agent ? { agent: opts.agent } : {}) }),
  });
}

export function abortSession(id: string): Promise<any> {
  return ocFetch(`/session/${encodeURIComponent(id)}/abort`, { method: 'POST' });
}

/**
 * Revert (rewind) the session to just before `messageID`. The engine's revert
 * body is `{ messageID, partID? }`; the response shape is UNVERIFIED against a
 * live engine, so callers must read it defensively (the proxy forwards it as-is).
 */
export function revertSession(id: string, messageID: string): Promise<any> {
  return ocFetch(`/session/${encodeURIComponent(id)}/revert`, {
    method: 'POST',
    body: JSON.stringify({ messageID }),
  });
}

/** Undo the most recent revert. Response shape is UNVERIFIED. */
export function unrevertSession(id: string): Promise<any> {
  return ocFetch(`/session/${encodeURIComponent(id)}/unrevert`, { method: 'POST' });
}

export function sessionTodos(id: string): Promise<any> {
  return ocFetch(`/session/${encodeURIComponent(id)}/todo`);
}

export function sessionDiff(id: string): Promise<any> {
  return ocFetch(`/session/${encodeURIComponent(id)}/diff`);
}

export function respondPermission(id: string, permissionID: string, response: unknown): Promise<any> {
  return ocFetch(
    `/session/${encodeURIComponent(id)}/permissions/${encodeURIComponent(permissionID)}`,
    { method: 'POST', body: JSON.stringify({ response }) },
  );
}

export function eventsRaw(signal?: AbortSignal): Promise<Response> {
  return fetch(`${OPENCODE_BASE}/event`, { headers: { Authorization: authHeader(), ...dirHeaders() }, signal });
}
