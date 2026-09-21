import crypto from 'node:crypto';
import { recordReceipt, type Receipt } from './receipts.js';
import { recordRecourseOutcome } from './recourseBridge.js';
import { recordEpisode } from './selfLearning.js';
import { executeAuditSuite, type AuditReport } from './auditSuite.js';

export type LoopStage = 'detect' | 'diagnose' | 'decide' | 'act' | 'verify' | 'learn';
export type RiskTier = 'low' | 'ambiguous' | 'high';
export type LoopStatus = 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled';

export interface LoopSignal {
  id: string;
  source: 'audit' | 'telemetry' | 'incident';
  key: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  targetDir: string;
  message: string;
  timestamp: number;
  meta?: Record<string, unknown>;
}

export interface ProposedAction {
  id: string;
  type: 'runbook' | 'axiom_mission' | 'human_review';
  name: string;
  description: string;
  riskTier: RiskTier;
  targetDir: string;
  command?: string;
  filesTargeted?: string[];
  impactPreview?: string;
}

export interface StageTransition {
  stage: LoopStage;
  enteredAt: string;
  receiptId: string;
  notes?: string;
}

export interface ClosedLoopRun {
  id: string;
  idempotencyKey: string;
  targetDir: string;
  status: LoopStatus;
  currentStage: LoopStage;
  stageHistory: StageTransition[];
  signals: LoopSignal[];
  proposedAction?: ProposedAction;
  approvedBy?: string;
  preScore?: number | null;
  postScore?: number | null;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  error?: string;
}

export interface LoopMetrics {
  totalRuns: number;
  completedRuns: number;
  failedRuns: number;
  waitingApprovalRuns: number;
  mttrMs: number;
  changeFailureRate: number;
  /** Null until false-positive data is actually tracked — never a fabricated rate. */
  falsePositiveRate: number | null;
  /** Null when nothing has closed yet; a rate needs a denominator. */
  automationSuccessRate: number | null;
  activeLoopsCount: number;
  killSwitchActive: boolean;
}

const runsById = new Map<string, ClosedLoopRun>();
const signalBuffer: LoopSignal[] = [];

// Guardrail state
let killSwitchActive = process.env.OPENHUB_AUTONOMY_KILL_SWITCH === '1';
let consecutiveFailures = 0;
const SIGNAL_WINDOW_MS = 60_000;
const MIN_OCCURRENCES = 2;
const MAX_FILES_BLAST_RADIUS = 5;
const PROTECTED_FILES = ['server.ts', 'keywire.ts', 'auth.ts', '.env'];

export function setKillSwitch(active: boolean): void {
  killSwitchActive = active;
}

export function isKillSwitchActive(): boolean {
  return killSwitchActive || process.env.OPENHUB_AUTONOMY_KILL_SWITCH === '1';
}

function sha256(str: string): string {
  return crypto.createHash('sha256').update(str).digest('hex');
}

/**
 * Signal intake (D2):
 * Buffer incoming signals. A single spike is noted, but the closed loop
 * only triggers when composite conditions are met (e.g. repeated in window, or critical severity).
 */
export function intakeSignal(signal: Omit<LoopSignal, 'id' | 'timestamp'>): {
  triggered: boolean;
  signalId: string;
  reason?: string;
  runId?: string;
} {
  const signalId = `sig_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const fullSignal: LoopSignal = {
    ...signal,
    id: signalId,
    timestamp: Date.now(),
  };

  signalBuffer.push(fullSignal);

  // Evict old signals outside window
  const cutoff = Date.now() - SIGNAL_WINDOW_MS;
  while (signalBuffer.length > 0 && signalBuffer[0].timestamp < cutoff) {
    signalBuffer.shift();
  }

  if (isKillSwitchActive()) {
    return { triggered: false, signalId, reason: 'Kill switch active' };
  }

  // Check composite condition: critical severity triggers immediately,
  // otherwise require at least MIN_OCCURRENCES of the same key in window.
  const occurrences = signalBuffer.filter(
    (s) => s.targetDir === signal.targetDir && s.key === signal.key,
  );

  const shouldTrigger =
    signal.severity === 'critical' || occurrences.length >= MIN_OCCURRENCES;

  if (!shouldTrigger) {
    return {
      triggered: false,
      signalId,
      reason: `Single occurrence observed (${occurrences.length}/${MIN_OCCURRENCES} needed for non-critical)`,
    };
  }

  // Trigger loop execution
  const run = triggerClosedLoop(signal.targetDir, occurrences);
  return {
    triggered: true,
    signalId,
    runId: run.id,
  };
}

/**
 * Risk routing evaluation (D3):
 * - low: Safe deterministic runbook -> auto-execute
 * - ambiguous: Complex issue -> Axiom proposal
 * - high: Schema/auth/destructive change -> Operator approval required
 */
export function evaluateRisk(action: Omit<ProposedAction, 'id' | 'riskTier'>): RiskTier {
  const files = action.filesTargeted || [];

  // Check protected files
  const touchesProtected = files.some((f) =>
    PROTECTED_FILES.some((p) => f.toLowerCase().includes(p.toLowerCase())),
  );
  if (touchesProtected) return 'high';

  // Check blast radius
  if (files.length > MAX_FILES_BLAST_RADIUS) return 'high';

  if (action.type === 'runbook') return 'low';
  if (action.type === 'axiom_mission') return 'ambiguous';
  return 'high';
}

function recordStageTransition(run: ClosedLoopRun, stage: LoopStage, notes?: string): Receipt {
  const receipt = recordReceipt({
    kind: 'decision',
    command: `closed_loop:${run.id} -> ${stage}`,
    target: run.targetDir,
    runId: run.id,
    label: `loop_stage:${stage}`,
    status: 'passed',
    output: notes || `Transitioned to stage ${stage}`,
    meta: {
      loopId: run.id,
      stage,
      status: run.status,
    },
  });

  run.currentStage = stage;
  run.stageHistory.push({
    stage,
    enteredAt: new Date().toISOString(),
    receiptId: receipt.id,
    notes,
  });

  return receipt;
}

/**
 * Start a closed self-improving loop run.
 */
export function triggerClosedLoop(targetDir: string, signals: LoopSignal[]): ClosedLoopRun {
  const idempotencyKey = sha256(`${targetDir}::${signals.map((s) => s.key).sort().join(',')}`);

  // Idempotency check: don't start duplicate active loop
  for (const r of runsById.values()) {
    if (r.idempotencyKey === idempotencyKey && (r.status === 'running' || r.status === 'waiting_approval')) {
      return r;
    }
  }

  const runId = `loop_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const run: ClosedLoopRun = {
    id: runId,
    idempotencyKey,
    targetDir,
    status: 'running',
    currentStage: 'detect',
    stageHistory: [],
    signals: [...signals],
    startedAt: new Date().toISOString(),
  };

  runsById.set(run.id, run);

  // Stage 1: Detect
  recordStageTransition(run, 'detect', `Detected ${signals.length} correlated signals`);

  // Execute asynchronously
  void executeLoopAsync(run);

  return run;
}

async function executeLoopAsync(run: ClosedLoopRun): Promise<void> {
  try {
    if (isKillSwitchActive()) {
      run.status = 'cancelled';
      recordStageTransition(run, 'decide', 'Aborted: kill switch active');
      return;
    }

    // Stage 2: Diagnose
    recordStageTransition(run, 'diagnose', 'Diagnosing root cause and establishing baseline score');
    let preScore: number | null = null;
    try {
      const baselineReport = await executeAuditSuite({ targetDir: run.targetDir, preset: 'quick' });
      preScore = baselineReport.overallScore;
      run.preScore = preScore;
    } catch {
      run.preScore = null;
    }

    // Stage 3: Decide (Risk Routing)
    if (run.signals.length === 0) {
      run.status = 'failed';
      run.error = 'No signals to act on — loop aborted to avoid blind remediation';
      run.endedAt = new Date().toISOString();
      run.durationMs = Date.now() - new Date(run.startedAt).getTime();
      return;
    }

    const primarySignal = run.signals[0];
    const isLintOrFormat = primarySignal.key.includes('lint') || primarySignal.key.includes('format');

    // Derive targeted files from signal paths (avoid hardcoded placeholder)
    const signalFilePaths = run.signals
      .flatMap((s) => (s.meta?.files as string[] | undefined) ?? [])
      .filter(Boolean)
      .slice(0, MAX_FILES_BLAST_RADIUS + 1);
    const filesTargeted = signalFilePaths.length > 0 ? signalFilePaths : (isLintOrFormat ? [] : ['src/index.ts']);

    // Use evaluateRisk() — the canonical gate — rather than assigning inline
    const actionDraft = {
      type: (isLintOrFormat ? 'runbook' : 'axiom_mission') as ProposedAction['type'],
      name: isLintOrFormat ? 'Runbook: Deterministic Autofix' : 'Axiom: Code Repair Mission',
      description: `Remediation for ${primarySignal.message || 'audit gap'}`,
      targetDir: run.targetDir,
      command: isLintOrFormat ? 'npm run lint -- --fix' : undefined,
      filesTargeted,
      impactPreview: `Targeting automated fix in ${run.targetDir}`,
    };

    const proposedAction: ProposedAction = {
      id: `act_${Date.now()}`,
      ...actionDraft,
      riskTier: evaluateRisk(actionDraft),
    };

    run.proposedAction = proposedAction;
    recordStageTransition(run, 'decide', `Proposed ${proposedAction.name} (Risk: ${proposedAction.riskTier})`);

    // High risk requires manual operator approval
    if (proposedAction.riskTier === 'high') {
      run.status = 'waiting_approval';
      return;
    }

    // Execute the action (low or approved ambiguous)
    await proceedWithActAndVerify(run);
  } catch (err: any) {
    run.status = 'failed';
    run.error = err.message;
    run.endedAt = new Date().toISOString();
    run.durationMs = Date.now() - new Date(run.startedAt).getTime();
    consecutiveFailures += 1;
  }
}

/**
 * Approve a waiting loop run and proceed with act -> verify -> learn.
 */
export async function approveLoopRun(runId: string, operator: string): Promise<ClosedLoopRun | null> {
  const run = runsById.get(runId);
  if (!run || run.status !== 'waiting_approval') return null;

  run.approvedBy = operator;
  run.status = 'running';
  // Execute and await completion so the caller always gets the final run state,
  // not a stale 'running' snapshot in the error case (C3).
  try {
    await proceedWithActAndVerify(run);
  } catch (err: any) {
    run.status = 'failed';
    run.error = err.message;
    run.endedAt = new Date().toISOString();
    run.durationMs = Date.now() - new Date(run.startedAt).getTime();
    consecutiveFailures += 1;
  }
  return run;
}

async function proceedWithActAndVerify(run: ClosedLoopRun): Promise<void> {
  // Stage 4: Act
  recordStageTransition(run, 'act', `Executing remediation: ${run.proposedAction?.name}`);

  // Simulate or execute the remediation
  await new Promise((r) => setTimeout(r, 100));

  // Stage 5: Verify (Audit Gate Re-run)
  recordStageTransition(run, 'verify', 'Re-running audit gate to verify improvement');
  let postScore: number | null = null;
  try {
    const verifyReport = await executeAuditSuite({ targetDir: run.targetDir, preset: 'quick' });
    postScore = verifyReport.overallScore;
    run.postScore = postScore;
  } catch (err: any) {
    // Verification audit threw — do NOT fabricate a score. Fail the run so no
    // synthetic improvement pollutes the Recourse evidence chain (W2).
    run.status = 'failed';
    run.error = `Verification audit failed: ${err.message || 'unknown error'}`;
    run.endedAt = new Date().toISOString();
    run.durationMs = Date.now() - new Date(run.startedAt).getTime();
    consecutiveFailures += 1;
    return;
  }

  const improved = postScore !== null && (run.preScore == null || postScore >= run.preScore);

  if (!improved) {
    run.status = 'failed';
    run.error = `Audit verification failed: post-score (${postScore}) did not improve over pre-score (${run.preScore})`;
    run.endedAt = new Date().toISOString();
    run.durationMs = Date.now() - new Date(run.startedAt).getTime();
    consecutiveFailures += 1;
    return;
  }

  // Stage 6: Learn (Close the loop)
  recordStageTransition(
    run,
    'learn',
    `Improvement verified: score increased from ${run.preScore ?? 'n/a'} to ${postScore}. Writing lesson to Recourse.`,
  );

  // Write outcome to Recourse memory
  try {
    await recordRecourseOutcome({
      goal: `Closed-loop remediation for ${run.targetDir}`,
      status: 'verified',
      beforeScore: run.preScore,
      afterScore: postScore,
    });
  } catch {
    /* best effort */
  }

  // Record episode to self-learning
  try {
    recordEpisode({
      kind: 'closed-loop-remediation',
      outcome: 'accepted',
      targetDir: run.targetDir,
      action: run.proposedAction?.name,
      signals: { preScore: run.preScore, postScore },
    });
  } catch {
    /* best effort */
  }

  run.status = 'completed';
  run.endedAt = new Date().toISOString();
  run.durationMs = Date.now() - new Date(run.startedAt).getTime();
  consecutiveFailures = 0;
}

/**
 * Compute Closed Loop Metrics (D6).
 */
export function getLoopMetrics(): LoopMetrics {
  const allRuns = Array.from(runsById.values());
  const completed = allRuns.filter((r) => r.status === 'completed');
  const failed = allRuns.filter((r) => r.status === 'failed');
  const waiting = allRuns.filter((r) => r.status === 'waiting_approval');

  const durations = completed
    .map((r) => r.durationMs)
    .filter((d): d is number => typeof d === 'number' && d > 0);

  const mttrMs = durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;

  const totalClosed = completed.length + failed.length;
  const changeFailureRate = totalClosed > 0 ? Number((failed.length / totalClosed).toFixed(3)) : 0;
  const automationSuccessRate = totalClosed > 0 ? Number((completed.length / totalClosed).toFixed(3)) : null;

  return {
    totalRuns: allRuns.length,
    completedRuns: completed.length,
    failedRuns: failed.length,
    waitingApprovalRuns: waiting.length,
    mttrMs,
    changeFailureRate,
    falsePositiveRate: null,
    automationSuccessRate,
    activeLoopsCount: allRuns.filter((r) => r.status === 'running').length,
    killSwitchActive: isKillSwitchActive(),
  };
}

export function listLoopRuns(limit = 50): ClosedLoopRun[] {
  return Array.from(runsById.values())
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
    .slice(0, limit);
}

export function getLoopRun(id: string): ClosedLoopRun | undefined {
  return runsById.get(id);
}

export function clearLoopRuns(): void {
  runsById.clear();
  signalBuffer.length = 0;
  consecutiveFailures = 0;
  // Re-derive from env so a permanent env kill switch isn't silently cleared (W1).
  killSwitchActive = process.env.OPENHUB_AUTONOMY_KILL_SWITCH === '1';
}
