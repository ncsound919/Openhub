/**
 * fleetInterconnect.ts — OpenHub's primary-console interconnect to the rest of
 * the Overlay fleet.
 *
 * OpenHub is the primary tool. This module:
 *   - aggregates live state + Jev tier health of every peer (Recourse,
 *     Dev-Brain, Axiom, Draymond, Keywire),
 *   - routes decisions to the right engine by domain (code/repair → Axiom,
 *     ops (daily/cron/report/learning/brain) → Draymond, growth/strategy →
 *     Recourse, reasoning/matrix → Dev-Brain, review/workspace/audit → local),
 *   - routes outcomes back into Recourse's learning (fleet memory intake +
 *     learner episodes), and
 *   - aggregates Recourse's learning / synergy / trend / insight surfaces.
 *
 * Honesty contract: every peer is probed independently; a down or unauthorized
 * peer reports `online:false`/`unauthorized:true` with the real status — never
 * fabricated state.
 */

export interface PeerSpec {
  id: 'recourse' | 'devBrain' | 'axiom' | 'draymond' | 'keywire';
  label: string;
  baseUrl: string;
  token?: string;
}

export function peerSpecs(env: NodeJS.ProcessEnv = process.env): PeerSpec[] {
  return [
    { id: 'recourse', label: 'Recourse', baseUrl: (env.RECOURSE_URL || 'http://localhost:3050').replace(/\/+$/, ''), token: env.RECOURSE_API_SECRET },
    { id: 'devBrain', label: 'Dev-Brain', baseUrl: (env.DEV_BRAIN_URL || 'http://localhost:3450').replace(/\/+$/, '') },
    { id: 'axiom', label: 'Axiom', baseUrl: (env.AXIOM_URL || 'http://localhost:3198').replace(/\/+$/, '') },
    { id: 'draymond', label: 'Draymond', baseUrl: (env.DRAYMOND_URL || 'http://localhost:3444').replace(/\/+$/, ''), token: env.DRAYMOND_CRON_SECRET },
    { id: 'keywire', label: 'Keywire', baseUrl: (env.KEYWIRE_URL || 'http://127.0.0.1:4700').replace(/\/+$/, '') },
  ];
}

export interface JsonResult {
  ok: boolean;
  status: number;
  data?: unknown;
  error?: string;
  latencyMs: number;
  unauthorized?: boolean;
}

export async function httpJson(
  baseUrl: string,
  path: string,
  opts: { method?: string; body?: unknown; token?: string; timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<JsonResult> {
  const timeoutMs = opts.timeoutMs ?? 6000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  const method = (opts.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(opts.headers ?? {}) };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const hasBody = opts.body !== undefined && method !== 'GET' && method !== 'HEAD';
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      ...(hasBody ? { body: JSON.stringify(opts.body) } : {}),
      signal: controller.signal,
    });
    const text = await res.text().catch(() => '');
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text.slice(0, 200);
    }
    return {
      ok: res.ok,
      status: res.status,
      data,
      error: res.ok ? undefined : `HTTP ${res.status}: ${text.slice(0, 200)}`,
      latencyMs: Date.now() - started,
      unauthorized: res.status === 401 || res.status === 403,
    };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : 'unreachable', latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Fleet state aggregation
// ---------------------------------------------------------------------------

export interface PeerHealth {
  id: PeerSpec['id'];
  label: string;
  baseUrl: string;
  online: boolean;
  status?: number;
  error?: string;
  latencyMs: number;
  unauthorized?: boolean;
  jev?: unknown;
}

async function probePeer(spec: PeerSpec): Promise<PeerHealth> {
  const statusPath: Record<PeerSpec['id'], string> = {
    recourse: '/api/recourse/status',
    devBrain: '/api/status',
    axiom: '/api/status',
    draymond: '/api/jev/status',
    keywire: '/api/v1/vault/bootstrap',
  };
  const jevPath: Partial<Record<PeerSpec['id'], string>> = {
    recourse: '/api/recourse/decision/jev/status',
    devBrain: '/api/jev/status',
    axiom: '/api/jev/status',
    draymond: '/api/jev/status',
  };
  const health = await httpJson(spec.baseUrl, statusPath[spec.id], { token: spec.token, timeoutMs: 4000 });
  let jev: unknown;
  const jevP = jevPath[spec.id];
  if (jevP) {
    if (jevP === statusPath[spec.id]) {
      if (health.ok) jev = health.data; // same endpoint — reuse the probe
    } else {
      const r = await httpJson(spec.baseUrl, jevP, { token: spec.token, timeoutMs: 4000 });
      if (r.ok) jev = r.data;
    }
  }
  return {
    id: spec.id,
    label: spec.label,
    baseUrl: spec.baseUrl,
    online: health.ok,
    status: health.status || undefined,
    error: health.error,
    latencyMs: health.latencyMs,
    unauthorized: health.unauthorized,
    ...(jev !== undefined ? { jev } : {}),
  };
}

export async function fleetState(env: NodeJS.ProcessEnv = process.env): Promise<{ peers: PeerHealth[]; online: boolean; at: string }> {
  const specs = peerSpecs(env);
  const peers = await Promise.all(specs.map(probePeer));
  return { peers, online: peers.some((p) => p.online), at: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Decision routing — OpenHub is the primary console
// ---------------------------------------------------------------------------

export type DecisionDomain =
  | 'repair' | 'code' | 'audit' | 'review' | 'workspace'
  | 'daily' | 'cron' | 'report' | 'learning' | 'brain'
  | 'growth' | 'strategy' | 'reasoning' | 'matrix' | 'service';

export interface RouteDecisionResult {
  domain: DecisionDomain;
  routedTo: PeerSpec['id'] | 'local';
  engine: string;
  available: boolean;
  status?: number;
  data?: unknown;
  error?: string;
}

/** Build the outbound payload for a domain→engine hop. */
export function routeTarget(domain: DecisionDomain): { engine: PeerSpec['id'] | 'local'; path: string; method: string; body: (p: Record<string, unknown>) => Record<string, unknown> } {
  switch (domain) {
    case 'repair':
      return { engine: 'axiom', path: '/api/jev/repair', method: 'POST', body: (p) => ({ file: String(p.file ?? '') }) };
    case 'audit':
      return { engine: 'axiom', path: '/api/jev/audit', method: 'POST', body: (p) => ({ verified: p.verified !== false, factCount: Number(p.factCount) || 0, passedFacts: Number(p.passedFacts) || 0, discrepancies: Array.isArray(p.discrepancies) ? p.discrepancies.map(String) : [] }) };
    case 'code':
      return { engine: 'axiom', path: '/api/jev/workspace', method: 'POST', body: (p) => ({ path: String(p.path ?? ''), operation: String(p.operation ?? '') }) };
    case 'workspace':
      return { engine: 'axiom', path: '/api/jev/workspace', method: 'POST', body: (p) => ({ path: String(p.path ?? ''), operation: String(p.operation ?? '') }) };
    case 'daily':
    case 'cron':
    case 'report':
    case 'learning':
    case 'brain':
      return { engine: 'draymond', path: '/api/jev/decide', method: 'POST', body: (p) => ({ kind: domain, ...(p ?? {}) }) };
    case 'growth':
    case 'strategy':
      return { engine: 'recourse', path: '/api/recourse/decision/jev/evaluate', method: 'GET', body: () => ({}) };
    case 'reasoning':
    case 'matrix':
      return { engine: 'devBrain', path: '/api/decide/jev', method: 'POST', body: (p) => ({ problem: String(p.problem ?? ''), candidates: Array.isArray(p.candidates) ? p.candidates : [], strategy: typeof p.strategy === 'string' ? p.strategy : undefined }) };
    case 'review':
      return { engine: 'local', path: '', method: 'POST', body: (p) => p };
    case 'service':
      return { engine: 'draymond', path: '/api/jev/decide', method: 'POST', body: (p) => ({ kind: 'service', service: p.service, action: String(p.action ?? 'start') }) };
  }
}

/** Route a decision to the right engine. `local` resolves review/workspace via
 *  OpenHub's own Jev client (the primary console). */
export async function routeDecision(domain: DecisionDomain, payload: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): Promise<RouteDecisionResult> {
  const target = routeTarget(domain);
  if (target.engine === 'local') {
    return { domain, routedTo: 'local', engine: 'OpenHub', available: true, data: { note: 'handled locally by OpenHub jevClient' } };
  }
  const spec = peerSpecs(env).find((s) => s.id === target.engine);
  if (!spec) return { domain, routedTo: target.engine, engine: target.engine, available: false, error: 'peer not configured' };
  const r = await httpJson(spec.baseUrl, target.path, { method: target.method, body: target.body(payload), token: spec.token, timeoutMs: 20000 });
  return { domain, routedTo: target.engine, engine: spec.label, available: r.ok, status: r.status, data: r.data, error: r.error };
}

// ---------------------------------------------------------------------------
// Fleet → Recourse learning (feedback into learning/synergy/trend/insights)
// ---------------------------------------------------------------------------

export interface FleetLearnInput {
  kind: 'gene' | 'lesson' | 'hypothesis' | 'signal' | 'snapshot';
  id: string;
  text: string;
  topic?: string;
  data?: unknown;
  externalScore?: number;
  runEpisode?: boolean;
}

export interface FleetLearnResult {
  memory: JsonResult;
  episode: JsonResult | null;
}

export async function learnFromFleet(input: FleetLearnInput, env: NodeJS.ProcessEnv = process.env): Promise<FleetLearnResult> {
  const recourse = peerSpecs(env).find((s) => s.id === 'recourse');
  if (!recourse) throw new Error('recourse peer not configured');
  const token = recourse.token;
  const memory = await httpJson(recourse.baseUrl, '/api/recourse/fleet/memory', {
    method: 'POST',
    token,
    body: { source: 'openhub-fleet', kind: input.kind, id: input.id, text: input.text, topic: input.topic ?? 'fleet-outcome', data: input.data ?? null },
  });
  let episode: JsonResult | null = null;
  if (input.runEpisode !== false) {
    episode = await httpJson(recourse.baseUrl, '/api/recourse/learn/episode', {
      method: 'POST',
      token,
      body: { externalScore: typeof input.externalScore === 'number' ? input.externalScore : undefined },
    });
  }
  return { memory, episode };
}

// ---------------------------------------------------------------------------
// Fleet insights — Recourse learning / synergy / trend / decision + peer Jev
// ---------------------------------------------------------------------------

export async function fleetInsights(env: NodeJS.ProcessEnv = process.env): Promise<Record<string, unknown>> {
  const specs = peerSpecs(env);
  const recourse = specs.find((s) => s.id === 'recourse');
  const devBrain = specs.find((s) => s.id === 'devBrain');
  const draymond = specs.find((s) => s.id === 'draymond');

  const reads: Array<[string, Promise<JsonResult>]> = [];
  if (recourse) {
    reads.push(['learn', httpJson(recourse.baseUrl, '/api/recourse/learn/status', { token: recourse.token })]);
    reads.push(['synergyMap', httpJson(recourse.baseUrl, '/api/recourse/synergy/map', { token: recourse.token })]);
    reads.push(['synergyCandidates', httpJson(recourse.baseUrl, '/api/recourse/synergy/candidates', { token: recourse.token })]);
    reads.push(['trend', httpJson(recourse.baseUrl, '/api/recourse/trend/ledger', { token: recourse.token })]);
    reads.push(['decision', httpJson(recourse.baseUrl, '/api/recourse/decision/jev/status', { token: recourse.token })]);
    reads.push(['reporter', httpJson(recourse.baseUrl, '/api/recourse/reporter/latest', { token: recourse.token })]);
  }
  if (devBrain) reads.push(['devBrain', httpJson(devBrain.baseUrl, '/api/status', { token: devBrain.token })]);
  if (draymond) reads.push(['draymondJev', httpJson(draymond.baseUrl, '/api/jev/status', { token: draymond.token })]);

  const settled: Record<string, JsonResult> = {};
  const entries = await Promise.all(reads.map(async ([key, p]) => [key, await p] as const));
  for (const [key, r] of entries) settled[key] = r;

  const ok = (key: string) => settled[key]?.ok ? settled[key].data : null;
  const state = await fleetState(env);
  return {
    at: new Date().toISOString(),
    peers: state.peers,
    recourse: {
      learning: ok('learn'),
      synergy: ok('synergyMap'),
      synergyCandidates: ok('synergyCandidates'),
      trend: ok('trend'),
      decisionJev: ok('decision'),
      reporter: ok('reporter'),
    },
    devBrain: ok('devBrain'),
    draymondJev: ok('draymondJev'),
  };
}