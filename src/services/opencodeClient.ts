import { OPENCODE_BASE, getEnginePassword } from './opencodeEngine.js';

export function authHeader(pw: string = getEnginePassword()): string {
  const user = process.env.OPENCODE_SERVER_USERNAME || 'opencode';
  return 'Basic ' + Buffer.from(`${user}:${pw}`).toString('base64');
}

export async function ocFetch(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<any> {
  const { timeoutMs, headers, ...rest } = init;
  const method = (rest.method || 'GET').toUpperCase();
  const merged = new Headers(headers);
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

export function promptSessionAsync(id: string, parts: unknown[]): Promise<any> {
  return ocFetch(`/session/${encodeURIComponent(id)}/prompt_async`, {
    method: 'POST',
    body: JSON.stringify({ parts }),
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

export function eventsRaw(): Promise<Response> {
  return fetch(`${OPENCODE_BASE}/event`, { headers: { Authorization: authHeader() } });
}
