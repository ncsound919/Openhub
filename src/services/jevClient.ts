/**
 * jevClient.ts — Jev (System One) coding-decision client for OpenHub.
 *
 * Jev returns typed `choice` / `noul` / `score` answers over a `state` — no
 * prose. Two-tier chain (matches the fleet clients):
 *   tier 1 = Vercel AI Gateway TypeSafe lane (TYPESAFE_BASE_URL + a key),
 *   tier 2 = LocalJev on :8080 (JEV_LOCAL_BASE_URL, no key required).
 * The gateway is tried first when a key is configured; any failure falls back
 * to localjev. Both down => source "offline" — never a fabricated decision.
 */

export type JevState = string | unknown[] | Record<string, unknown>;

export interface JevChoiceQuestion {
  type: 'choice';
  instructions: unknown;
  criteria: Record<string, unknown>;
}

export interface JevNoulQuestion {
  type: 'noul';
  instructions: unknown;
  criteria?: { true: unknown; false: unknown } | null;
}

export interface JevScoreQuestion {
  type: 'score';
  instructions: unknown;
  criteria: unknown[];
}

export type JevQuestion = JevChoiceQuestion | JevNoulQuestion | JevScoreQuestion;

export type JevAnswer =
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'noul'; noul: number }
  | { type: 'score'; score: number; legend: Record<string, unknown>; probabilities: Record<string, number>; confidence: number };

export interface JevTierConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface JevConfig {
  enabled: boolean;
  timeoutMs: number;
  gateway: JevTierConfig;
  local: JevTierConfig;
}

const GATEWAY_BASE_URL_DEFAULT = 'https://ai-gateway.vercel.sh/typesafe';
const GATEWAY_MODEL_DEFAULT = 'typesafe-ai/jev';
const LOCAL_BASE_URL_DEFAULT = 'http://127.0.0.1:8080';
const LOCAL_MODEL_DEFAULT = 'jev-latest';

export function jevConfig(): JevConfig {
  const gateway: JevTierConfig = {
    baseUrl: (process.env.TYPESAFE_BASE_URL || GATEWAY_BASE_URL_DEFAULT).replace(/\/+$/, ''),
    apiKey: (process.env.TYPESAFE_API_KEY || process.env.AI_GATEWAY_API_KEY || process.env.JEV_API_KEY || '').trim(),
    model: process.env.TYPESAFE_MODEL || GATEWAY_MODEL_DEFAULT,
  };
  const local: JevTierConfig = {
    baseUrl: (process.env.JEV_LOCAL_BASE_URL || LOCAL_BASE_URL_DEFAULT).replace(/\/+$/, ''),
    apiKey: '',
    model: process.env.JEV_LOCAL_MODEL || LOCAL_MODEL_DEFAULT,
  };
  const enabled = process.env.OPENHUB_JEV_ENABLED !== '0';
  const timeoutMs = Number(process.env.JEV_TIMEOUT_MS) || 10_000;
  return { enabled, timeoutMs, gateway, local };
}

export function jevEnabled(): boolean {
  const c = jevConfig();
  return c.enabled && (Boolean(c.gateway.baseUrl) || Boolean(c.local.baseUrl));
}

export interface JevTierStatus {
  id: 'gateway' | 'local';
  baseUrl: string;
  model: string;
  online: boolean;
  error?: string;
}

export interface JevStatus {
  configured: boolean;
  enabled: boolean;
  tiers: JevTierStatus[];
  online: boolean;
  checkedAt?: number;
}

async function rawFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function probeTier(id: 'gateway' | 'local', tier: JevTierConfig): Promise<JevTierStatus> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (tier.apiKey) headers.Authorization = `Bearer ${tier.apiKey}`;
  try {
    const res = await rawFetch(`${tier.baseUrl}/v1/models`, { method: 'GET', headers }, 3000);
    return { id, baseUrl: tier.baseUrl, model: tier.model, online: res.ok, error: res.ok ? undefined : `GET /v1/models -> HTTP ${res.status}` };
  } catch (err: any) {
    return { id, baseUrl: tier.baseUrl, model: tier.model, online: false, error: err?.message || 'unreachable' };
  }
}

export async function jevStatus(): Promise<JevStatus> {
  const c = jevConfig();
  const [gateway, local] = await Promise.all([probeTier('gateway', c.gateway), probeTier('local', c.local)]);
  return { configured: true, enabled: c.enabled, tiers: [gateway, local], online: gateway.online || local.online, checkedAt: Date.now() };
}

export interface SystemOneInput {
  state: JevState;
  questions: Record<string, JevQuestion>;
  model?: string;
}

export interface JevUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface JevResult {
  ok: boolean;
  source: 'vercel' | 'localjev' | 'offline';
  model?: string;
  answers?: Record<string, JevAnswer>;
  usage?: JevUsage;
  latencyMs: number;
  error?: string;
  httpStatus?: number;
}

interface TierCallResult {
  ok: boolean;
  model?: string;
  answers?: Record<string, JevAnswer>;
  usage?: JevUsage;
  latencyMs: number;
  error?: string;
  httpStatus?: number;
}

function authHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

async function postSystemOne(tier: JevTierConfig, input: SystemOneInput, timeoutMs: number, started: number): Promise<TierCallResult> {
  const endpoint = `${tier.baseUrl}/v1/systemone`;
  const body = { model: input.model ?? tier.model, state: input.state, questions: input.questions };
  const retryable = new Set([429, 529]);
  let lastStatus = 0;
  let lastError = '';

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(300, 200 * attempt)));
    try {
      const res = await rawFetch(endpoint, { method: 'POST', headers: authHeaders(tier.apiKey), body: JSON.stringify(body) }, timeoutMs);
      lastStatus = res.status;
      if (retryable.has(res.status)) {
        lastError = `HTTP ${res.status} (transient overload; retrying)`;
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        lastError = `POST ${endpoint} -> HTTP ${res.status}: ${text.slice(0, 200)}`;
        return { ok: false, latencyMs: Date.now() - started, error: lastError, httpStatus: res.status };
      }
      const data: any = await res.json();
      const answers: Record<string, JevAnswer> | undefined = data && typeof data.answers === 'object' && data.answers !== null ? data.answers : undefined;
      if (!answers) return { ok: false, latencyMs: Date.now() - started, error: 'Jev response missing answers' };
      const usage: JevUsage | undefined =
        data?.usage && typeof data.usage.input_tokens === 'number'
          ? { inputTokens: data.usage.input_tokens, outputTokens: Number(data.usage.output_tokens) || 0 }
          : undefined;
      return { ok: true, model: typeof data.model === 'string' ? data.model : tier.model, answers, usage, latencyMs: Date.now() - started };
    } catch (err: any) {
      const aborted = err?.name === 'AbortError';
      lastError = aborted ? `request timed out after ${timeoutMs}ms` : (err?.message || 'request failed');
      if (!aborted) break;
    }
  }
  return { ok: false, latencyMs: Date.now() - started, error: lastError, httpStatus: lastStatus || undefined };
}

export async function decideSystemOne(input: SystemOneInput): Promise<JevResult> {
  const c = jevConfig();
  const started = Date.now();
  if (!jevEnabled()) {
    return { ok: false, source: 'offline', latencyMs: Date.now() - started, error: c.enabled ? 'no Jev tier configured' : 'Jev decision engine disabled (OPENHUB_JEV_ENABLED=0)' };
  }
  if (c.gateway.apiKey) {
    const r = await postSystemOne(c.gateway, input, c.timeoutMs, started);
    if (r.ok) return { ...r, source: 'vercel' };
  }
  const local = await postSystemOne(c.local, input, c.timeoutMs, started);
  if (local.ok) return { ...local, source: 'localjev' };
  return { ...local, source: 'offline' };
}

// ─── Coding-decision advisories ─────────────────────────────────────────────

export type JevSource = 'vercel' | 'localjev' | 'offline';

interface AdvisoryBase {
  ok: boolean;
  source: JevSource;
  model?: string;
  error?: string;
}

export interface ReviewAdvisoryInput {
  fileCount: number;
  addedLines: number;
  removedLines: number;
  diffSummary?: string;
}

export function reviewAdvisory(input: ReviewAdvisoryInput): { state: JevState; questions: Record<string, JevQuestion> } {
  const state = {
    action: 'code_review',
    fileCount: input.fileCount,
    addedLines: input.addedLines,
    removedLines: input.removedLines,
    diffSummary: (input.diffSummary ?? '').slice(0, 800),
  };
  const questions: Record<string, JevQuestion> = {
    verdict: {
      type: 'choice',
      instructions: 'What is the right code-review verdict for this change?',
      criteria: {
        approve: 'Approve as-is',
        request_changes: 'Request changes',
        block: 'Block the change',
      },
    },
    merge: {
      type: 'noul',
      instructions: 'Is this change safe to merge now?',
      criteria: { true: 'Safe to merge', false: 'Hold' },
    },
    risk: {
      type: 'score',
      instructions: 'Rate the regression risk of this change.',
      criteria: ['None', 'Low', 'Medium', 'High'],
    },
  };
  return { state, questions };
}

export interface ReviewJevAdvisory extends AdvisoryBase {
  verdict?: string;
  verdictProbability?: number;
  merge?: boolean;
  noul?: number;
  riskScore?: number;
  riskConfidence?: number;
}

export function buildReviewAdvisory(result: JevResult): ReviewJevAdvisory {
  if (!result.ok || !result.answers) return { ok: false, source: 'offline', error: result.error };
  const verdict = result.answers.verdict;
  const merge = result.answers.merge;
  const risk = result.answers.risk;
  const noul = merge && merge.type === 'noul' ? merge.noul : undefined;
  let verdictChoice: string | undefined;
  let verdictProbability = 0;
  if (verdict && verdict.type === 'choice') {
    verdictChoice = verdict.choice;
    verdictProbability = verdict.probabilities?.[verdict.choice] ?? 0;
  }
  return {
    ok: true,
    source: result.source,
    model: result.model,
    verdict: verdictChoice,
    verdictProbability,
    merge: noul === undefined ? undefined : noul >= 0.5,
    noul,
    riskScore: risk && risk.type === 'score' ? risk.score : undefined,
    riskConfidence: risk && risk.type === 'score' ? risk.confidence : undefined,
  };
}

export interface RepairAdvisoryInput {
  finding?: string;
  brief?: string;
}

export function repairAdvisory(input: RepairAdvisoryInput): { state: JevState; questions: Record<string, JevQuestion> } {
  const state = {
    action: 'repair_triage',
    finding: (input.finding ?? '').slice(0, 400),
    brief: (input.brief ?? '').slice(0, 1200),
  };
  const questions: Record<string, JevQuestion> = {
    lane: {
      type: 'choice',
      instructions: 'Which repair lane should handle this?',
      criteria: { autofix: 'Automated fix', dispatch: 'Dispatch to the repair team', hold: 'Hold for human review' },
    },
    urgent: {
      type: 'noul',
      instructions: 'Does this need immediate repair?',
      criteria: { true: 'Immediate', false: 'Can wait' },
    },
  };
  return { state, questions };
}

export interface RepairJevAdvisory extends AdvisoryBase {
  lane?: string;
  laneProbability?: number;
  urgent?: boolean;
  noul?: number;
}

export function buildRepairAdvisory(result: JevResult): RepairJevAdvisory {
  if (!result.ok || !result.answers) return { ok: false, source: 'offline', error: result.error };
  const lane = result.answers.lane;
  const urgent = result.answers.urgent;
  const noul = urgent && urgent.type === 'noul' ? urgent.noul : undefined;
  let laneChoice: string | undefined;
  let laneProbability = 0;
  if (lane && lane.type === 'choice') {
    laneChoice = lane.choice;
    laneProbability = lane.probabilities?.[lane.choice] ?? 0;
  }
  return {
    ok: true,
    source: result.source,
    model: result.model,
    lane: laneChoice,
    laneProbability,
    urgent: noul === undefined ? undefined : noul >= 0.5,
    noul,
  };
}

export interface AuditAdvisoryInput {
  status: string;
  factCount: number;
  passedFacts: number;
  discrepancies: string[];
}

export function auditAdvisory(input: AuditAdvisoryInput): { state: JevState; questions: Record<string, JevQuestion> } {
  const state = {
    action: 'audit_verdict',
    status: input.status,
    factCount: input.factCount,
    passedFacts: input.passedFacts,
    discrepancies: input.discrepancies.slice(0, 6),
  };
  const questions: Record<string, JevQuestion> = {
    severity: {
      type: 'score',
      instructions: 'How severe are the audit findings?',
      criteria: ['None / trivial', 'Minor', 'Moderate', 'Severe / blocking'],
    },
    next: {
      type: 'choice',
      instructions: 'What should happen next?',
      criteria: { accept: 'Accept', autofix: 'Auto-fix', flag: 'Flag for review', reject: 'Reject' },
    },
  };
  return { state, questions };
}

export interface AuditJevAdvisory extends AdvisoryBase {
  severityScore?: number;
  severityConfidence?: number;
  next?: string;
  nextProbability?: number;
}

export function buildAuditAdvisory(result: JevResult): AuditJevAdvisory {
  if (!result.ok || !result.answers) return { ok: false, source: 'offline', error: result.error };
  const severity = result.answers.severity;
  const next = result.answers.next;
  let nextChoice: string | undefined;
  let nextProbability = 0;
  if (next && next.type === 'choice') {
    nextChoice = next.choice;
    nextProbability = next.probabilities?.[next.choice] ?? 0;
  }
  return {
    ok: true,
    source: result.source,
    model: result.model,
    severityScore: severity && severity.type === 'score' ? severity.score : undefined,
    severityConfidence: severity && severity.type === 'score' ? severity.confidence : undefined,
    next: nextChoice,
    nextProbability,
  };
}

export interface WorkspaceAdvisoryInput {
  path: string;
  operation: string;
}

export function workspaceAdvisory(input: WorkspaceAdvisoryInput): { state: JevState; questions: Record<string, JevQuestion> } {
  const state = { action: 'workspace', operation: input.operation, path: input.path };
  const questions: Record<string, JevQuestion> = {
    allow: {
      type: 'noul',
      instructions: 'Is this workspace operation safe to run now?',
      criteria: { true: 'Safe', false: 'Risky' },
    },
    risk: {
      type: 'score',
      instructions: 'Rate the blast radius of this operation.',
      criteria: ['None', 'Low', 'Medium', 'High'],
    },
  };
  return { state, questions };
}

export interface WorkspaceJevAdvisory extends AdvisoryBase {
  allow?: boolean;
  noul?: number;
  riskScore?: number;
  riskConfidence?: number;
}

export function buildWorkspaceAdvisory(result: JevResult): WorkspaceJevAdvisory {
  if (!result.ok || !result.answers) return { ok: false, source: 'offline', error: result.error };
  const allow = result.answers.allow;
  const risk = result.answers.risk;
  const noul = allow && allow.type === 'noul' ? allow.noul : undefined;
  return {
    ok: true,
    source: result.source,
    model: result.model,
    allow: noul === undefined ? undefined : noul >= 0.5,
    noul,
    riskScore: risk && risk.type === 'score' ? risk.score : undefined,
    riskConfidence: risk && risk.type === 'score' ? risk.confidence : undefined,
  };
}