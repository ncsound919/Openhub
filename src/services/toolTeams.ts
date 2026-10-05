/**
 * toolTeams.ts — OpenHub's "teams of tools" control layer.
 *
 * Instead of calling every fleet engine at once, job types map to the MINIMAL
 * set of teams that can do the job, and each team exposes only its own tool
 * list. `runTeam` / `runJobType` execute exactly those tools, sequentially,
 * with a per-team in-flight guard so the same team never stacks concurrent
 * runs. This gives Draymond's daily routines and crons visible structure:
 * GET /api/jobs/draymond lists the day phases + scheduled jobs with their
 * team assignment, and each is callable by button.
 *
 * Honesty contract: a tool on a team whose peer is not configured (or down)
 * reports `ok:false` with the real error — never a fabricated result.
 */

import { httpJson, peerSpecs, type JsonResult } from './fleetInterconnect';
import {
  decideSystemOne,
  reviewAdvisory,
  buildReviewAdvisory,
  auditAdvisory,
  buildAuditAdvisory,
  workspaceAdvisory,
  buildWorkspaceAdvisory,
} from './jevClient';

export type TeamId = 'recourse' | 'draymond' | 'axiom' | 'devBrain' | 'openhub';

export type JobType =
  | 'repair' | 'code' | 'audit' | 'review' | 'workspace'
  | 'daily' | 'cron' | 'report' | 'learning' | 'brain'
  | 'growth' | 'strategy' | 'reasoning' | 'matrix' | 'service' | 'insights';

export interface TeamTool {
  id: string;
  label: string;
  /** 'http' = a real endpoint on the team's peer; 'local' = OpenHub's own Jev client. */
  mode: 'http' | 'local';
  method?: 'GET' | 'POST';
  path?: string;
  kind?: string;
}

export interface TeamSpec {
  id: TeamId;
  label: string;
  description: string;
  tools: TeamTool[];
  enabled: boolean;
  baseUrl?: string;
}

const TEAM_META: Record<TeamId, { label: string; description: string }> = {
  recourse: { label: 'Recourse', description: 'Self-developing OS: growth decision, learner, synergy, trend' },
  draymond: { label: 'Draymond', description: 'Orchestrator: ops decisions, daily flow, cron, service lifecycle' },
  axiom: { label: 'Axiom', description: 'Coding harness: repair, audit, workspace decisions' },
  devBrain: { label: 'Dev-Brain', description: 'Reasoning: weighted decision matrix (Jev)' },
  openhub: { label: 'OpenHub', description: 'Primary console: code review, audit, workspace (local Jev)' },
};

const TEAM_TOOLS: Record<TeamId, TeamTool[]> = {
  recourse: [
    { id: 'decision-evaluate', label: 'Growth decision (Jev)', mode: 'http', method: 'GET', path: '/api/recourse/decision/jev/evaluate' },
    { id: 'decision-noul', label: 'Health noul (Jev)', mode: 'http', method: 'GET', path: '/api/recourse/decision/jev/noul' },
    { id: 'learn-episode', label: 'Learner episode', mode: 'http', method: 'POST', path: '/api/recourse/learn/episode' },
    { id: 'synergy-scan', label: 'Synergy scan', mode: 'http', method: 'POST', path: '/api/recourse/synergy/scan' },
    { id: 'trend-ledger', label: 'Trend ledger', mode: 'http', method: 'GET', path: '/api/recourse/trend/ledger' },
  ],
  draymond: [
    { id: 'jev-decide', label: 'Ops decision (Jev)', mode: 'http', method: 'POST', path: '/api/jev/decide' },
    { id: 'jev-status', label: 'Jev status', mode: 'http', method: 'GET', path: '/api/jev/status' },
    { id: 'services', label: 'Service health', mode: 'http', method: 'GET', path: '/api/ops/services' },
  ],
  axiom: [
    { id: 'jev-repair', label: 'Repair decision (Jev)', mode: 'http', method: 'POST', path: '/api/jev/repair' },
    { id: 'jev-audit', label: 'Audit decision (Jev)', mode: 'http', method: 'POST', path: '/api/jev/audit' },
    { id: 'jev-workspace', label: 'Workspace decision (Jev)', mode: 'http', method: 'POST', path: '/api/jev/workspace' },
  ],
  devBrain: [
    { id: 'decide-jev', label: 'Decision matrix (Jev)', mode: 'http', method: 'POST', path: '/api/decide/jev' },
    { id: 'status', label: 'Status', mode: 'http', method: 'GET', path: '/api/status' },
  ],
  openhub: [
    { id: 'local-review', label: 'Code review (Jev)', mode: 'local', kind: 'review' },
    { id: 'local-audit', label: 'Audit verdict (Jev)', mode: 'local', kind: 'audit' },
    { id: 'local-workspace', label: 'Workspace (Jev)', mode: 'local', kind: 'workspace' },
    { id: 'fleet-insights', label: 'Fleet insights', mode: 'http', method: 'GET', path: '/api/fleet/insights' },
    { id: 'jev-status', label: 'Jev status', mode: 'http', method: 'GET', path: '/api/jev/status' },
  ],
};

/** The MINIMAL team set per job type — only these get called for that job. */
export const JOB_TYPE_TEAMS: Record<JobType, TeamId[]> = {
  repair: ['axiom'],
  code: ['axiom'],
  audit: ['axiom', 'openhub'],
  review: ['openhub'],
  workspace: ['openhub'],
  daily: ['draymond'],
  cron: ['draymond'],
  report: ['draymond'],
  learning: ['draymond', 'recourse'],
  brain: ['draymond'],
  growth: ['recourse'],
  strategy: ['recourse'],
  reasoning: ['devBrain'],
  matrix: ['devBrain'],
  service: ['draymond'],
  insights: ['recourse', 'openhub'],
};

export function jobTypeTeams(jobType: string): TeamId[] {
  return (JOB_TYPE_TEAMS as Record<string, TeamId[]>)[jobType] ?? [];
}

/**
 * Draymond DAY_FLOW step handler → job type. This is the missing link between
 * Draymond's real day schedule (`day-orchestrator.ts` DAY_FLOW, keyed by handler
 * slug) and OpenHub's team routing (keyed by coarse job type). Without it the
 * console could only show a static job-type table that never matched the actual
 * steps, so "delegation" was a view rather than a router.
 *
 * Handlers absent here have no team assignment (surfaced honestly as `[]`).
 */
export const DAY_STEP_JOB_TYPE: Record<string, JobType> = {
  'overlay-auditor': 'audit',
  ingest_news: 'daily',
  research_rotation: 'learning',
  fetch_market_data: 'daily',
  oss_marketing_stack_up: 'service',
  strategy_team: 'strategy',
  run_overlay_qa: 'audit',
  treasury_pulse: 'daily',
  finance_strategy_brief: 'daily',
  finance_goals_sync: 'daily',
  'wf-mission-sync': 'daily',
  fleet_duty_sync: 'service',
  self_repair_check: 'repair',
  benchmark_chains: 'audit',
  science_campaign_seed: 'reasoning',
  marketing_pulse: 'daily',
  'social-media-dashboard': 'service',
  'agent-browser': 'service',
  bookbridge: 'learning',
  'daily-marketing-run': 'daily',
  oss_marketing_stack_status: 'service',
  repair_shift: 'repair',
  research_grade_loop: 'audit',
  self_learning_loop: 'learning',
  rd_night: 'reasoning',
  dream_cycle: 'learning',
  ultraplan_process: 'reasoning',
  scan_book_library: 'learning',
  wiki_sync: 'brain',
  generate_agent_avatars: 'daily',
};

/** Team set for a Draymond day-step handler (by way of its job type). */
export function teamsForDayStep(handler: string): TeamId[] {
  const jobType = DAY_STEP_JOB_TYPE[handler];
  return jobType ? jobTypeTeams(jobType) : [];
}

/** Full handler → team-set map for the console to join against the day plan. */
export function dayStepTeams(): Record<string, TeamId[]> {
  const out: Record<string, TeamId[]> = {};
  for (const handler of Object.keys(DAY_STEP_JOB_TYPE)) out[handler] = teamsForDayStep(handler);
  return out;
}

export function teamCatalog(env: NodeJS.ProcessEnv = process.env): { teams: TeamSpec[]; jobTypes: Record<string, TeamId[]> } {
  const peers = new Map(peerSpecs(env).map((p) => [p.id, p]));
  const teams: TeamSpec[] = (Object.keys(TEAM_TOOLS) as TeamId[]).map((id) => {
    const peer = peers.get(id as Exclude<TeamId, 'openhub'>);
    const meta = TEAM_META[id];
    return {
      id,
      label: peer?.label ?? meta.label,
      description: meta.description,
      tools: TEAM_TOOLS[id],
      enabled: Boolean(peer),
      ...(peer ? { baseUrl: peer.baseUrl } : {}),
    };
  });
  return { teams, jobTypes: JOB_TYPE_TEAMS as Record<string, TeamId[]> };
}

// Per-team in-flight guard: a team's tools are never called twice at once.
const inFlight = new Set<TeamId>();

export function teamBusy(id: TeamId): boolean {
  return inFlight.has(id);
}

async function runLocalTool(kind: string, payload: Record<string, unknown>): Promise<JsonResult> {
  const started = Date.now();
  if (kind === 'review') {
    const { state, questions } = reviewAdvisory({
      fileCount: Number(payload.fileCount) || 0,
      addedLines: Number(payload.addedLines) || 0,
      removedLines: Number(payload.removedLines) || 0,
      diffSummary: typeof payload.diffSummary === 'string' ? payload.diffSummary : undefined,
    });
    const r = await decideSystemOne({ state, questions });
    return { ok: r.ok, status: r.ok ? 200 : 502, data: buildReviewAdvisory(r), latencyMs: r.latencyMs, error: r.error };
  }
  if (kind === 'audit') {
    const { state, questions } = auditAdvisory({
      status: typeof payload.status === 'string' ? payload.status : 'unknown',
      factCount: Number(payload.factCount) || 0,
      passedFacts: Number(payload.passedFacts) || 0,
      discrepancies: Array.isArray(payload.discrepancies) ? payload.discrepancies.map(String) : [],
    });
    const r = await decideSystemOne({ state, questions });
    return { ok: r.ok, status: r.ok ? 200 : 502, data: buildAuditAdvisory(r), latencyMs: r.latencyMs, error: r.error };
  }
  if (kind === 'workspace') {
    const { state, questions } = workspaceAdvisory({
      path: String(payload.path ?? ''),
      operation: String(payload.operation ?? ''),
    });
    const r = await decideSystemOne({ state, questions });
    return { ok: r.ok, status: r.ok ? 200 : 502, data: buildWorkspaceAdvisory(r), latencyMs: r.latencyMs, error: r.error };
  }
  return { ok: false, status: 400, error: `unknown local tool kind "${kind}"`, latencyMs: Date.now() - started };
}

export interface ToolRun {
  id: string;
  label: string;
  result: JsonResult;
}

export interface TeamRunResult {
  team: TeamId;
  busy: boolean;
  tools: ToolRun[];
}

/** Run one team's tools sequentially. Returns `busy:true` immediately if the
 *  team is already mid-run (never queues another concurrent run). */
export async function runTeam(
  id: TeamId,
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
  contextKind?: JobType,
): Promise<TeamRunResult> {
  if (inFlight.has(id)) return { team: id, busy: true, tools: [] };
  inFlight.add(id);
  try {
    const peer = peerSpecs(env).find((p) => p.id === (id as Exclude<TeamId, 'openhub'>));
    const tools: ToolRun[] = [];
    for (const tool of TEAM_TOOLS[id] ?? []) {
      if (tool.mode === 'local') {
        tools.push({ id: tool.id, label: tool.label, result: await runLocalTool(tool.kind ?? '', payload) });
        continue;
      }
      if (!peer) {
        tools.push({ id: tool.id, label: tool.label, result: { ok: false, status: 0, error: `team "${id}" peer not configured`, latencyMs: 0 } });
        continue;
      }
      let body: unknown = payload;
      if (tool.id === 'jev-decide' && !payload.kind && contextKind) {
        body = { ...payload, kind: contextKind };
      }
      const result = await httpJson(peer.baseUrl, tool.path ?? '', {
        method: tool.method,
        ...(tool.method === 'POST' ? { body } : {}),
        token: peer.token,
        timeoutMs: 20000,
      });
      tools.push({ id: tool.id, label: tool.label, result });
    }
    return { team: id, busy: false, tools };
  } finally {
    inFlight.delete(id);
  }
}

export interface JobTypeRunResult {
  jobType: string;
  teams: TeamId[];
  results: TeamRunResult[];
  learn: LearnFeedback | null;
}

/** Run a job type through its MINIMAL team set, one team at a time — nothing
 *  else gets called. Outcomes feed back into Recourse + Draymond learning so
 *  the routing improves as it runs (opt-out: payload.learn === false or
 *  OPENHUB_TEAMS_LEARN=0). */
export async function runJobType(
  jobType: string,
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<JobTypeRunResult> {
  const teams = jobTypeTeams(jobType);
  const results: TeamRunResult[] = [];
  for (const id of teams) {
    results.push(await runTeam(id, payload, env, jobType as JobType));
  }
  const learn = payload.learn === false ? null : await learnFromRun(jobType, results, env);
  return { jobType, teams, results, learn };
}

export interface DraymondRoutines {
  day: JsonResult;
  schedules: JsonResult;
  jobTypes: Record<string, TeamId[]>;
  /** Draymond day-step handler → the team(s) that execute it. */
  stepTeams: Record<string, TeamId[]>;
}

/** Draymond's daily flow + scheduled crons, with their team assignment.
 *  Honest: an unconfigured/unauthorized Draymond reports ok:false. */
export async function draymondRoutines(env: NodeJS.ProcessEnv = process.env): Promise<DraymondRoutines> {
  const draymond = peerSpecs(env).find((p) => p.id === 'draymond');
  const day = draymond
    ? await httpJson(draymond.baseUrl, '/api/ops/day', { token: draymond.token, timeoutMs: 8000 })
    : { ok: false, status: 0, error: 'draymond peer not configured', latencyMs: 0 };
  const schedules = draymond
    ? await httpJson(draymond.baseUrl, '/api/v1/schedules', { token: draymond.token, timeoutMs: 8000 })
    : { ok: false, status: 0, error: 'draymond peer not configured', latencyMs: 0 };
  return { day, schedules, jobTypes: JOB_TYPE_TEAMS as Record<string, TeamId[]>, stepTeams: dayStepTeams() };
}

// ---------------------------------------------------------------------------
// Closed learning loop — outcomes feed back into Recourse + Draymond learning
// so the tool-team routing improves as it runs.
// ---------------------------------------------------------------------------

export interface LearnFeedback {
  recourse: { memory: JsonResult; episode: JsonResult };
  draymond: JsonResult;
}

/** Feed one job-type run's real outcomes into the fleet learners:
 *  - Recourse  fleet memory (kind 'lesson', topic 'tool-team-outcome') + a
 *    learner episode scored by the tool success rate.
 *  - Draymond  recordOutcome (agentId 'openhub-teams', success = majority ok).
 * Best-effort and honest: a down/unconfigured learner reports ok:false and
 * never breaks the run. Gated by OPENHUB_TEAMS_LEARN (default on). */
export async function learnFromRun(
  jobType: string,
  results: TeamRunResult[],
  env: NodeJS.ProcessEnv = process.env,
  opts: { enabled?: boolean; scoreOverride?: number } = {},
): Promise<LearnFeedback> {
  const enabled = opts.enabled ?? (env.OPENHUB_TEAMS_LEARN || '1').trim() !== '0';
  const empty: LearnFeedback = {
    recourse: {
      memory: { ok: false, status: 0, error: 'learning disabled (OPENHUB_TEAMS_LEARN=0)', latencyMs: 0 },
      episode: { ok: false, status: 0, error: 'learning disabled (OPENHUB_TEAMS_LEARN=0)', latencyMs: 0 },
    },
    draymond: { ok: false, status: 0, error: 'learning disabled (OPENHUB_TEAMS_LEARN=0)', latencyMs: 0 },
  };
  if (!enabled) return empty;

  const tools = results.flatMap((r) => r.tools);
  const ok = tools.filter((t) => t.result.ok).length;
  const total = tools.length;
  const score = opts.scoreOverride ?? (total > 0 ? ok / total : 0);

  const recourse = peerSpecs(env).find((p) => p.id === 'recourse');
  const draymond = peerSpecs(env).find((p) => p.id === 'draymond');

  const id = `teams:${jobType}:${Date.now().toString(36)}`;
  const summary = `tool-team job "${jobType}" ran ${total} tool(s) across ${results.length} team(s), ${ok} ok (score ${score.toFixed(2)})`;
  const data = {
    jobType,
    teams: results.map((r) => r.team),
    ok,
    total,
    score: Number(score.toFixed(3)),
    toolErrors: tools.filter((t) => !t.result.ok).map((t) => ({ id: t.id, error: t.result.error })),
  };

  const memory = recourse
    ? await httpJson(recourse.baseUrl, '/api/recourse/fleet/memory', {
        method: 'POST',
        token: recourse.token,
        body: { source: 'openhub-teams', kind: 'lesson', id, text: summary, topic: 'tool-team-outcome', data },
        timeoutMs: 15000,
      })
    : { ok: false, status: 0, error: 'recourse peer not configured', latencyMs: 0 };
  const episode = recourse
    ? await httpJson(recourse.baseUrl, '/api/recourse/learn/episode', {
        method: 'POST',
        token: recourse.token,
        body: { externalScore: score },
        timeoutMs: 15000,
      })
    : { ok: false, status: 0, error: 'recourse peer not configured', latencyMs: 0 };

  const draymondOutcome = draymond
    ? await httpJson(draymond.baseUrl, '/api/ops/learning', {
        method: 'POST',
        token: draymond.token,
        body: {
          agentId: 'openhub-teams',
          kind: 'tool-team',
          summary,
          success: score >= 0.5,
          detail: JSON.stringify(data).slice(0, 4000),
        },
        timeoutMs: 15000,
      })
    : { ok: false, status: 0, error: 'draymond peer not configured', latencyMs: 0 };

  return { recourse: { memory, episode }, draymond: draymondOutcome };
}

// ---------------------------------------------------------------------------
// Synergy + learning overview — Recourse synergy map/learn + Draymond lessons
// ---------------------------------------------------------------------------

export interface SynergyOverview {
  at: string;
  recourse: { synergyMap: JsonResult; candidates: JsonResult; learnStatus: JsonResult };
  draymond: { lessons: JsonResult };
}

export async function synergyOverview(env: NodeJS.ProcessEnv = process.env): Promise<SynergyOverview> {
  const recourse = peerSpecs(env).find((p) => p.id === 'recourse');
  const draymond = peerSpecs(env).find((p) => p.id === 'draymond');
  const miss = (label: string): JsonResult => ({ ok: false, status: 0, error: `${label} peer not configured`, latencyMs: 0 });
  const [synergyMap, candidates, learnStatus, lessons] = await Promise.all([
    recourse ? httpJson(recourse.baseUrl, '/api/recourse/synergy/map', { token: recourse.token, timeoutMs: 8000 }) : miss('recourse'),
    recourse ? httpJson(recourse.baseUrl, '/api/recourse/synergy/candidates', { token: recourse.token, timeoutMs: 8000 }) : miss('recourse'),
    recourse ? httpJson(recourse.baseUrl, '/api/recourse/learn/status', { token: recourse.token, timeoutMs: 8000 }) : miss('recourse'),
    draymond ? httpJson(draymond.baseUrl, '/api/ops/learning', { token: draymond.token, timeoutMs: 8000 }) : miss('draymond'),
  ]);
  return { at: new Date().toISOString(), recourse: { synergyMap, candidates, learnStatus }, draymond: { lessons } };
}