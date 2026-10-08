/**
 * Mission API + SSE layer — turns opencode sessions into missions.
 *
 * Browser-side only. It talks to OpenHub's own `/api/opencode/*` proxy (Task A4),
 * which authenticates the user and forwards to the opencode engine. It must NOT
 * import `services/opencodeClient` (the server client): that pulls node
 * `Buffer`/`process`, which Vite stubs to `{}` in the browser.
 *
 * Auth headers come from the same helper the editor bridge uses
 * (`axiomEditorClient` -> `auth/AuthProvider#getAuthHeaders`), so cookie + CSRF
 * handling stays in one place. Every request is relative (`/api/...`).
 */

import { getAuthHeaders } from '../auth/AuthProvider';
import { useMissionStore, type MissionEvent } from '../lib/missionStore.js';

/**
 * A parsed frame that also carries the session it belongs to. The public
 * `MissionEvent` type (Task B2) has no session field, but `subscribeMission`
 * must filter by session, so the id is attached at runtime. This is structurally
 * a `MissionEvent`, so callers typed against `MissionEvent` are unaffected.
 */
interface ParsedMissionEvent extends MissionEvent {
  sessionId?: string;
}

/** A nested object field, or undefined when it is absent / not a plain object. */
function nestedObject(rec: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const v = rec[key];
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/**
 * Read a session id from any shape opencode bus events have been seen to use.
 * Tolerance is deliberate: the live bus-event JSON is still UNVERIFIED against a
 * running engine (starting one risks a WAL clash with the running desktop app).
 * Real opencode events nest the session under `properties.info.sessionID` /
 * `properties.info.id` / `properties.part.sessionID`, so those are read too.
 */
function pickSessionId(rec: Record<string, unknown>): string | undefined {
  const properties = nestedObject(rec, 'properties');
  const data = nestedObject(rec, 'data');
  const propertiesInfo = properties ? nestedObject(properties, 'info') : undefined;
  const propertiesPart = properties ? nestedObject(properties, 'part') : undefined;
  const dataInfo = data ? nestedObject(data, 'info') : undefined;
  const dataPart = data ? nestedObject(data, 'part') : undefined;
  const candidate =
    rec.sessionID ??
    properties?.sessionID ??
    propertiesInfo?.sessionID ??
    propertiesInfo?.id ??
    propertiesPart?.sessionID ??
    data?.sessionID ??
    dataInfo?.sessionID ??
    dataPart?.sessionID ??
    rec.aggregateID;
  return typeof candidate === 'string' && candidate ? candidate : undefined;
}

/**
 * PURE, tolerant parser for one opencode SSE `data:` payload.
 *
 * Assumption (UNVERIFIED): each event is a JSON object that carries its session
 * under `sessionID`, `properties.sessionID`, `properties.info.sessionID`,
 * `properties.info.id`, `properties.part.sessionID`, `data.sessionID`,
 * `data.info.sessionID`, `data.part.sessionID`, or `aggregateID`; a `type`
 * string optionally ending in a `.N` version suffix; and human text under
 * `data.text` / `properties.text` / `properties.info.title` /
 * `properties.part.text` / `data.part.text` / `summary` / `type`. The exact live
 * shape has not been captured (see above), so the parser ignores unknown fields
 * and returns null — never throws — on anything it cannot read, so one malformed
 * frame cannot kill the stream.
 */
export function parseEventFrame(raw: string): ParsedMissionEvent | null {
  if (typeof raw !== 'string') return null;
  let body = raw.trim();
  if (!body) return null;
  // Accept a full `data: {...}` line as well as the bare JSON payload.
  if (body.startsWith('data:')) body = body.slice(5).trim();
  if (!body) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;

  const type = typeof rec.type === 'string' ? rec.type : '';
  const kind = type.replace(/\.\d+$/, '');

  const data = nestedObject(rec, 'data');
  const properties = nestedObject(rec, 'properties');
  const propertiesInfo = properties ? nestedObject(properties, 'info') : undefined;
  const propertiesPart = properties ? nestedObject(properties, 'part') : undefined;
  const dataPart = data ? nestedObject(data, 'part') : undefined;
  const textSource =
    data?.text ??
    properties?.text ??
    propertiesInfo?.title ??
    propertiesPart?.text ??
    dataPart?.text ??
    rec.summary ??
    rec.type;
  const text =
    typeof textSource === 'string' ? textSource : textSource == null ? '' : String(textSource);

  const event: ParsedMissionEvent = { at: Date.now(), kind, text };
  if (data?.taskId != null) {
    event.taskId = typeof data.taskId === 'string' ? data.taskId : String(data.taskId);
  }
  const sessionId = pickSessionId(rec);
  if (sessionId) event.sessionId = sessionId;
  return event;
}

/**
 * The proxy answers in a `{ ok, data }` envelope and returns 502 with a reason
 * on failure. Surface that as a thrown error rather than a silent empty body.
 */
async function readEnvelope(res: Response): Promise<Record<string, unknown>> {
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || json.ok === false) {
    const reason = typeof json.error === 'string' ? `: ${json.error}` : '';
    throw new Error(`opencode proxy HTTP ${res.status}${reason}`);
  }
  return json;
}

async function postJson(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  return readEnvelope(res);
}

/**
 * Create an opencode session and register it as a mission in `planned` state.
 * Resolves with the session/mission id. It deliberately does NOT send the goal
 * prompt: the page must subscribe to the event stream first, or early frames
 * race ahead of the subscription and are lost. Call `sendPrompt` after
 * subscribing.
 */
export async function createMission(goal: string): Promise<string> {
  const created = await postJson('/api/opencode/sessions', { title: goal });
  const data = (created.data ?? {}) as Record<string, unknown>;
  const id = typeof data.id === 'string' && data.id ? data.id : '';
  if (!id) throw new Error('opencode did not return a session id');

  useMissionStore.getState().upsertMission({
    id,
    goal,
    sessionId: id,
    status: 'planned',
    createdAt: new Date().toISOString(),
  });
  return id;
}

/**
 * Send the goal to an already-created session and move it to `running`. On
 * failure the mission is marked `failed` before the error rethrows.
 */
export async function sendPrompt(id: string, goal: string): Promise<void> {
  try {
    await postJson(`/api/opencode/sessions/${encodeURIComponent(id)}/prompt`, {
      parts: [{ type: 'text', text: goal }],
    });
    useMissionStore.getState().setStatus(id, 'running');
  } catch (err) {
    useMissionStore.getState().setStatus(id, 'failed');
    throw err;
  }
}

/** Ask opencode to abort the mission's session. */
export async function abortMission(id: string, sessionId: string): Promise<void> {
  void id; // kept for the documented call signature; the session id drives the request
  await postJson(`/api/opencode/sessions/${encodeURIComponent(sessionId)}/abort`, {});
}

/**
 * Stream opencode bus events for one session. Opens the proxy SSE endpoint and
 * invokes `onEvent` for each frame whose session id matches. Returns a cleanup
 * that aborts the request and stops reading the stream.
 *
 * `onError` (optional) is invoked with a human message when the stream fails for
 * a non-abort reason: the fetch rejects, the response is not ok, there is no
 * body, or the read loop throws. Abort (cleanup) never calls `onError`, so a
 * deliberately stopped mission is not reported as failed.
 *
 * The request deliberately has no timeout: it is a long-lived stream that ends
 * only when the engine ends it or the caller aborts.
 */
export function subscribeMission(
  sessionId: string,
  onEvent: (e: MissionEvent) => void,
  onError?: (message: string) => void,
): () => void {
  const controller = new AbortController();
  const fail = (message: string) => {
    if (!controller.signal.aborted) onError?.(message);
  };

  void (async () => {
    let res: Response;
    try {
      res = await fetch('/api/opencode/events', {
        method: 'GET',
        credentials: 'include',
        headers: { ...getAuthHeaders() },
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) return; // aborted by cleanup — not a failure
      fail(err instanceof Error ? err.message : 'event stream request failed');
      return;
    }
    if (!res.ok) {
      fail(`event stream unavailable (HTTP ${res.status})`);
      return;
    }
    if (!res.body) {
      fail('event stream returned no body');
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Normalize CRLF so frames split the same way on every platform.
        buffer = buffer.replace(/\r\n/g, '\n');
        let sep = buffer.indexOf('\n\n');
        while (sep >= 0) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          for (const line of frame.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload) continue;
            const event = parseEventFrame(payload);
            if (event && event.sessionId === sessionId) onEvent(event);
          }
          sep = buffer.indexOf('\n\n');
        }
      }
    } catch (err) {
      if (controller.signal.aborted) return; // aborted by cleanup — not a failure
      fail(err instanceof Error ? err.message : 'event stream dropped');
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* already released */
      }
    }
  })();

  return () => controller.abort();
}
