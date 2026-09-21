import { recordEvent } from './telemetry.js';
import {
  normalizeRecallHits,
  normalizeSynergyMap,
  recourseMemoryIndex,
  recourseMemoryRecall,
  recourseSynergyMap,
  type RecourseResult,
  type SynergyMapView,
} from './recourseClient.js';
import { startSupervision, type SupervisionRun } from './supervisor.js';

/**
 * Recourse bridge — the bidirectional seam that lets OpenHub and Recourse
 * self-improve together.
 *
 *   Recourse → OpenHub: `recourseContextForGoal` folds Recourse memory + the
 *   cross-domain synergy map into task context before a run starts.
 *   OpenHub → Recourse: `recordRecourseOutcome` writes verified outcomes back
 *   into Recourse's self-learning intake (fleet memory).
 *   Recourse → OpenHub (autonomy): `dispatchRecourseRepair` turns a Recourse
 *   findings dossier + agenda into a *supervised* Axiom loop. Dispatch is always
 *   operator-initiated (never autonomous spawning — see CONTROL_PLANE_PLAN.md).
 */

export interface RecallHit { id?: string; kind?: string; text: string; score?: number }

export interface RecourseContext {
  available: boolean;
  context: string;
  hits: RecallHit[];
  synergy: SynergyMapView | null;
  error?: string;
}

/** Build planner/run context from Recourse: recall hits + synergy domains. */
export async function recourseContextForGoal(
  goal: string,
  opts: { topK?: number } = {},
): Promise<RecourseContext> {
  if (!goal || !goal.trim()) {
    return { available: false, context: '', hits: [], synergy: null, error: 'goal is required' };
  }
  const [recall, synergy] = await Promise.all([
    recourseMemoryRecall(goal.trim(), { topK: opts.topK ?? 5 }),
    recourseSynergyMap(),
  ]);

  const hits = recall.available ? normalizeRecallHits(recall.data).slice(0, opts.topK ?? 5) : [];
  const map = synergy.available ? normalizeSynergyMap(synergy.data) : null;
  const parts: string[] = [];
  if (hits.length) {
    parts.push(`Recourse memory (prior verified lessons):\n${hits.map((h, i) => `  ${i + 1}. ${h.text}`).join('\n')}`);
  }
  if (map && map.domains.length) {
    parts.push(`Recourse synergy domains (proven cross-domain methods): ${map.domains.join(', ')}`);
  }
  const available = recall.available || synergy.available;
  return {
    available,
    context: parts.join('\n\n'),
    hits,
    synergy: map,
    ...(available ? {} : { error: recall.error || synergy.error || 'Recourse unreachable' }),
  };
}

/** Write a verified outcome back into Recourse's self-learning memory. */
export async function recordRecourseOutcome(
  payload: Record<string, unknown> & { goal?: string; status?: string },
): Promise<RecourseResult> {
  const res = await recourseMemoryIndex({ source: 'openhub-insights', ...payload });
  recordEvent({
    system: 'recourse',
    kind: 'outcome-write',
    outcome: res.available ? 'accepted' : 'error',
    ...(typeof payload.goal === 'string' ? { goal: payload.goal } : {}),
    data: { available: res.available, status: res.status, ...(res.error ? { error: res.error } : {}) },
  });
  return res;
}

export interface RecourseDispatchParams {
  targetDir: string;
  findings?: Array<{ file?: string; line?: number; title?: string; severity?: string; suggestion?: string }> | string[];
  goal?: string;
  maxIterations?: number;
  userId?: string;
  correlationId?: string;
}

function findingsToGoal(findings: RecourseDispatchParams['findings']): string {
  if (!Array.isArray(findings) || findings.length === 0) return '';
  const lines = findings.slice(0, 25).map((f, i) => {
    if (typeof f === 'string') return `${i + 1}. ${f}`;
    const loc = f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : 'finding';
    const sev = f.severity ? `[${f.severity}] ` : '';
    return `${i + 1}. ${loc} ${sev}${f.title ?? ''}${f.suggestion ? ` — ${f.suggestion}` : ''}`;
  });
  return `Address the following findings:\n${lines.join('\n')}`;
}

/**
 * Turn a Recourse findings dossier / agenda item into a supervised Axiom loop.
 * Operator-gated: this function is only ever reached through an authenticated
 * POST; it never self-starts.
 */
export async function dispatchRecourseRepair(params: RecourseDispatchParams): Promise<SupervisionRun> {
  if (!params.targetDir || !params.targetDir.trim()) {
    throw new Error('targetDir is required');
  }
  const goalParts = [
    params.goal?.trim() || '',
    findingsToGoal(params.findings),
  ].filter(Boolean);
  const goal = (goalParts.join('\n\n') || 'Address Recourse-diagnosed issues in this workspace').slice(0, 4000);
  const maxIterations = Math.min(20, Math.max(1, Number(params.maxIterations) || 6));

  const run = await startSupervision({
    goal,
    targetDir: params.targetDir.trim(),
    maxIterations,
    userId: params.userId,
  });

  recordEvent({
    system: 'recourse',
    kind: 'bridge-dispatch',
    severity: run.status === 'failed' ? 'high' : 'info',
    outcome: run.status === 'failed' ? 'error' : 'pending',
    correlationId: params.correlationId,
    goal,
    targetDir: params.targetDir.trim(),
    data: { runId: run.id, loopId: run.loopId, status: run.status, maxIterations },
  });

  return run;
}
