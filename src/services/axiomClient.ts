import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export const AXIOM_BASE = process.env.AXIOM_URL || `http://127.0.0.1:${process.env.AXIOM_PORT || '3198'}`;

/** Resolve the HMAC signing secret using the SAME chain Axiom itself uses
 *  (src/server/auth.ts resolveSigningSecret): Keywire key file first, then the
 *  persisted emergency key. Order matters: Axiom prefers the Keywire secret
 *  when it is configured, so OpenHub must too or minted tokens get rejected
 *  with "bad signature". */
function getSigningSecret(): string {
  const keysFile = process.env.KEYWIRE_KEYS_FILE
    || (process.env.UPLIFT_ROOT
      ? path.join(process.env.UPLIFT_ROOT, 'Keywire', 'data', 'keywire-keys.json')
      : path.join('C:', 'Users', 'User', 'Downloads', 'Uplift', 'Keywire', 'data', 'keywire-keys.json'));
  if (keysFile && fs.existsSync(keysFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(keysFile, 'utf8').replace(/^\uFEFF/, ''));
      if (typeof parsed?.jwtSecret === 'string' && parsed.jwtSecret) {
        return parsed.jwtSecret;
      }
    } catch {}
  }

  // Emergency key file check (same path shape as src/server/auth.ts).
  const emergencyPath = process.env.AXIOM_EMERGENCY_KEY_FILE || path.join(process.env.USERPROFILE || '', '.axiom', 'emergency-key.json');
  if (fs.existsSync(emergencyPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(emergencyPath, 'utf8'));
      if (typeof parsed?.key === 'string' && parsed.key) {
        return parsed.key;
      }
    } catch {}
  }

  return '';
}

/**
 * Mint the internal orchestrator token OpenHub uses to call Axiom.
 *
 * OpenHub is a trusted internal caller (it holds the same signing secret), so it
 * carries the owner roles Axiom's RBAC write-gates require. Without them every
 * consequential Axiom call — mission approve/reject, project run/stop, pipeline
 * loop start — is refused with `403 {"error":"forbidden"}` the moment RBAC is on
 * (which it is by default). Exported for the regression test.
 */
export function mintAxiomToken(): string {
  const secret = getSigningSecret();
  if (!secret) return '';

  const nowS = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      sub: 'openhub-orchestrator',
      iss: 'axiom-agent',
      aud: 'axiom-api',
      iat: nowS,
      exp: nowS + 12 * 3600,
      roles: ['owner', 'admin'],
      permissions: ['read', 'write'],
    })
  ).toString('base64url');

  const input = `${header}.${payload}`;
  const sig = crypto.createHmac('sha256', secret).update(input).digest('base64url');
  return `${input}.${sig}`;
}

export async function axiomFetch(endpoint: string, options: RequestInit = {}): Promise<any> {
  const url = `${AXIOM_BASE.replace(/\/$/, '')}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;
  const token = mintAxiomToken();

  const headers = new Headers(options.headers || {});
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  if (!headers.has('Content-Type') && options.method && options.method !== 'GET') {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    throw new Error(`Axiom HTTP ${res.status}: ${errorText || res.statusText}`);
  }
  return res.json();
}

export async function getAxiomStatus(): Promise<any> {
  return axiomFetch('/api/health');
}

export async function getAxiomCapabilities(): Promise<any> {
  return axiomFetch('/api/harness/capabilities');
}

export async function startAxiomProjectLoop(params: {
  goal: string;
  targetDir: string;
  maxIterations?: number;
  modelRoute?: string;
  skills?: { name: string; kind: string; reason?: string }[];
}): Promise<any> {
  return axiomFetch('/api/project/run', {
    method: 'POST',
    body: JSON.stringify({
      goal: params.goal,
      targetDir: params.targetDir,
      maxIterations: params.maxIterations || 8,
      modelRoute: params.modelRoute || 'auto',
      doneCriteria: { typecheck: true, tests: true },
      capabilities: { keywire: true, agentbrowser: true, deep: true, mutly: true, subteam: true },
      ...(params.skills && params.skills.length ? { skills: params.skills } : {}),
    }),
  });
}

export async function getAxiomProjectStatus(loopId: string): Promise<any> {
  return axiomFetch(`/api/project/status/${encodeURIComponent(loopId)}`);
}

/** Read-only loop evidence: what the agent did/claimed vs what the gates proved. */
export async function getAxiomProjectAudit(loopId: string): Promise<any> {
  return axiomFetch(`/api/project/audit/${encodeURIComponent(loopId)}`);
}

/** Full state + events.jsonl timeline for a loop. */
export async function getAxiomProjectReplay(loopId: string): Promise<any> {
  return axiomFetch(`/api/project/replay/${encodeURIComponent(loopId)}`);
}

/** Recent project loops (top 20). */
export async function listAxiomProjects(): Promise<any> {
  return axiomFetch('/api/project/list');
}

export async function stopAxiomProjectLoop(loopId: string): Promise<any> {
  return axiomFetch(`/api/project/stop/${encodeURIComponent(loopId)}`, {
    method: 'POST',
  });
}

export async function rewindAxiomProject(loopId: string): Promise<any> {
  return axiomFetch(`/api/project/rewind/${encodeURIComponent(loopId)}`, {
    method: 'POST',
  });
}

export async function diffAxiomProject(loopId: string): Promise<any> {
  return axiomFetch(`/api/project/diff/${encodeURIComponent(loopId)}`);
}

export async function shareAxiomProject(loopId: string): Promise<any> {
  return axiomFetch(`/api/project/share/${encodeURIComponent(loopId)}`);
}

export async function shareAxiomMission(id: string): Promise<any> {
  return axiomFetch(`/api/mission/share/${encodeURIComponent(id)}`);
}

export async function runAxiomMission(params: {
  goal: string;
  targetDir: string;
  maxTasks?: number;
  planGate?: boolean;
  skills?: string[];
  concurrency?: number;
}): Promise<any> {
  return axiomFetch('/api/mission/run', {
    method: 'POST',
    body: JSON.stringify({
      goal: params.goal,
      targetDir: params.targetDir,
      plan: 'auto',
      maxTasks: params.maxTasks || 5,
      ...(params.concurrency && params.concurrency > 1 ? { concurrency: Math.min(8, Math.floor(params.concurrency)) } : {}),
      ...(params.planGate ? { planGate: true } : {}),
      ...(params.skills && params.skills.length ? { skills: params.skills } : {}),
    }),
  });
}

export async function getAxiomMissionStatus(id: string): Promise<any> {
  return axiomFetch(`/api/mission/status/${encodeURIComponent(id)}`);
}

export async function listAxiomMissions(): Promise<any> {
  return axiomFetch('/api/mission/list');
}

export async function approveAxiomMission(id: string, by?: string): Promise<any> {
  return axiomFetch(`/api/mission/approve/${encodeURIComponent(id)}`, {
    method: 'POST',
    body: JSON.stringify({ by }),
  });
}

export async function rejectAxiomMission(id: string, reason?: string): Promise<any> {
  return axiomFetch(`/api/mission/reject/${encodeURIComponent(id)}`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

// --- Worktree review (hold → diff → merge) ----------------------------------

export async function listAxiomWorktrees(missionId: string): Promise<any> {
  return axiomFetch(`/api/mission/${encodeURIComponent(missionId)}/worktrees`);
}

export async function axiomWorktreeDiff(missionId: string, taskId: string): Promise<any> {
  return axiomFetch(`/api/mission/${encodeURIComponent(missionId)}/worktree/${encodeURIComponent(taskId)}/diff`);
}

export async function mergeAxiomWorktree(missionId: string, taskId: string, message?: string): Promise<any> {
  return axiomFetch(`/api/mission/${encodeURIComponent(missionId)}/worktree/${encodeURIComponent(taskId)}/merge`, {
    method: 'POST',
    body: JSON.stringify({ message }),
  });
}

export async function discardAxiomWorktree(missionId: string, taskId: string): Promise<any> {
  return axiomFetch(`/api/mission/${encodeURIComponent(missionId)}/worktree/${encodeURIComponent(taskId)}/discard`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function listAxiomSkills(): Promise<any> {
  return axiomFetch('/api/harness/skills');
}

export async function exportAxiomTelemetry(): Promise<any> {
  return axiomFetch('/api/telemetry/export');
}

export async function retrieveAxiom(goal: string, targetDir: string): Promise<any> {
  return axiomFetch('/api/harness/retrieve', {
    method: 'POST',
    body: JSON.stringify({ goal, targetDir }),
  });
}

export async function listAxiomSessions(): Promise<any> {
  return axiomFetch('/api/harness/sessions');
}

export async function createAxiomSession(title?: string): Promise<any> {
  return axiomFetch('/api/harness/sessions', {
    method: 'POST',
    body: JSON.stringify({ title }),
  });
}

export async function getAxiomSession(id: string): Promise<any> {
  return axiomFetch(`/api/harness/sessions/${encodeURIComponent(id)}`);
}

export async function appendAxiomSessionMessages(id: string, messages: Array<{ role: string; text: string; ts?: number }>): Promise<any> {
  return axiomFetch(`/api/harness/sessions/${encodeURIComponent(id)}/messages`, {
    method: 'POST',
    body: JSON.stringify({ messages }),
  });
}

// --- Editor bridge (apply / index / mentions / complete / inline-edit) -------

export async function axiomEditorApply(params: { rootRel?: string; payload: string; write?: boolean }): Promise<any> {
  return axiomFetch('/api/editor/apply', { method: 'POST', body: JSON.stringify(params) });
}

export async function axiomEditorIndex(params: { dir: string; prev?: unknown[] }): Promise<any> {
  return axiomFetch('/api/editor/index', { method: 'POST', body: JSON.stringify(params) });
}

export async function axiomEditorMentions(params: { dir: string; text: string }): Promise<any> {
  return axiomFetch('/api/editor/mentions', { method: 'POST', body: JSON.stringify(params) });
}

export async function axiomEditorComplete(params: { file: string; content: string; line: number; column: number; dir?: string; model?: string }): Promise<any> {
  return axiomFetch('/api/editor/complete', { method: 'POST', body: JSON.stringify(params) });
}

export async function axiomEditorInlineEdit(params: {
  file: string; content: string; selection: string; instruction: string; line?: number; column?: number; dir?: string; model?: string;
}): Promise<any> {
  return axiomFetch('/api/editor/inline-edit', { method: 'POST', body: JSON.stringify(params) });
}

export async function axiomEditorLatencyProbe(params: {
  file: string; content: string; line: number; column: number; dir: string;
}): Promise<any> {
  return axiomFetch('/api/editor/latency-probe', { method: 'POST', body: JSON.stringify(params) });
}

export async function axiomEditorNextEdit(params: {
  dir: string; file: string; content: string; line: number; column: number; complete?: boolean;
}): Promise<any> {
  return axiomFetch('/api/editor/next-edit', { method: 'POST', body: JSON.stringify(params) });
}

export async function axiomEditorModels(): Promise<any> {
  return axiomFetch('/api/editor/models');
}

export interface LspDiagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
}

/** Real LSP diagnostics from Axiom's language-server client. `available:false`
 *  (no server configured for this language) is an honest non-error, never a
 *  fabricated diagnostic list. */
export async function axiomLspDiagnostics(
  params: { file: string; rootDir?: string },
): Promise<{ available: boolean; diagnostics?: LspDiagnostic[]; error?: string }> {
  const token = mintAxiomToken();
  try {
    const res = await fetch(`${AXIOM_BASE.replace(/\/$/, '')}/api/harness/lsp/diagnostics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(params),
    });
    if (res.status === 503) {
      const body = await res.json().catch(() => ({}));
      return { available: false, error: (body as { error?: string })?.error || 'no language server configured for this file' };
    }
    if (!res.ok) return { available: false, error: `Axiom HTTP ${res.status}` };
    const body = (await res.json()) as { diagnostics?: LspDiagnostic[] };
    return { available: true, diagnostics: Array.isArray(body?.diagnostics) ? body.diagnostics : [] };
  } catch (err) {
    return { available: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Warm-transport control (keepalive + a resident ping) so a Tab does not pay
 *  a cold handshake. Transport warmth, not a claimed prompt-cache warmth. */
export async function axiomEditorWarmStatus(): Promise<any> {
  return axiomFetch('/api/editor/warm');
}

export async function axiomEditorWarmStart(): Promise<any> {
  return axiomFetch('/api/editor/warm/start', { method: 'POST' });
}

export async function axiomEditorWarmStop(): Promise<any> {
  return axiomFetch('/api/editor/warm/stop', { method: 'POST' });
}

export async function axiomEditorTelemetry(event: unknown): Promise<any> {
  return axiomFetch('/api/editor/telemetry', { method: 'POST', body: JSON.stringify({ event }) });
}

/** Raw SSE stream for the composer. Returns the upstream Response so the proxy
 *  can pipe frames through without buffering the whole answer. */
export async function axiomEditorChatRaw(params: { messages: unknown[]; tier?: string; model?: string }): Promise<Response> {
  const token = mintAxiomToken();
  return fetch(`${AXIOM_BASE.replace(/\/$/, '')}/api/editor/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(params),
  });
}

/** Raw SSE stream for editor completion (Tab ghost text). Same contract as
 *  axiomEditorChatRaw: the proxy pipes frames straight through. */
export async function axiomEditorCompleteStreamRaw(params: unknown): Promise<Response> {
  const token = mintAxiomToken();
  return fetch(`${AXIOM_BASE.replace(/\/$/, '')}/api/editor/complete-stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(params),
  });
}
export async function axiomEditorWatchStart(params: { dir: string }): Promise<any> {
  return axiomFetch('/api/editor/index/watch', { method: 'POST', body: JSON.stringify(params) });
}

export async function axiomEditorWatchList(): Promise<any> {
  return axiomFetch('/api/editor/index/watch');
}

export async function axiomEditorWatchStop(id: string): Promise<any> {
  return axiomFetch(`/api/editor/index/watch/${encodeURIComponent(id)}/stop`, { method: 'POST' });
}

export async function axiomPrReviewDiff(params: { diff: string }): Promise<any> {
  return axiomFetch('/api/pr/review-diff', { method: 'POST', body: JSON.stringify(params) });
}

// --- Diff-review queue (propose-before-apply) -------------------------------

export async function listAxiomReviews(): Promise<any> {
  return axiomFetch('/api/review/queue');
}

export async function getAxiomReview(id: string): Promise<any> {
  return axiomFetch(`/api/review/${encodeURIComponent(id)}`);
}

export async function decideAxiomReview(id: string, decision: 'approve' | 'reject', note?: string): Promise<any> {
  return axiomFetch(`/api/review/${encodeURIComponent(id)}/decision`, {
    method: 'POST',
    body: JSON.stringify({ decision, note }),
  });
}

/** Accept only the selected hunks of a proposal. `hunks` is `[{path, hunks}]`
 *  where `hunks` is an array of hunk indices, "all", or "none". */
export async function applyAxiomReviewHunks(
  id: string,
  hunks: Array<{ path: string; hunks: number[] | 'all' | 'none' }>,
  note?: string,
): Promise<any> {
  return axiomFetch(`/api/review/${encodeURIComponent(id)}/apply-hunks`, {
    method: 'POST',
    body: JSON.stringify({ hunks, note }),
  });
}

// --- Antagonist (Prospector + Adversary) ------------------------------------

/** Ranked, evidence-backed improvement opportunities in a target directory. */
export async function scanAxiomProspector(dir: string, top = 15): Promise<any> {
  const params = new URLSearchParams({ dir });
  if (Number.isFinite(top)) params.set('top', String(top));
  return axiomFetch(`/api/prospector/scan?${params.toString()}`);
}

/** Mutation-test a directory: does its suite catch a fault? Axiom restores files. */
export async function runAxiomAdversary(dir: string, maxMutants = 12): Promise<any> {
  return axiomFetch('/api/adversary/run', {
    method: 'POST',
    body: JSON.stringify({ dir, maxMutants }),
  });
}

export async function getAxiomAdversaryLatest(dir?: string): Promise<any> {
  const qs = dir ? `?dir=${encodeURIComponent(dir)}` : '';
  return axiomFetch(`/api/adversary/latest${qs}`);
}

/** Launch the top-ranked opportunities as real project loops (`dryRun` previews). */
export async function runAxiomProspectorCampaign(dir: string, opts: { count?: number; dryRun?: boolean } = {}): Promise<any> {
  return axiomFetch('/api/prospector/run', {
    method: 'POST',
    body: JSON.stringify({ dir, count: opts.count ?? 2, dryRun: opts.dryRun === true }),
  });
}
