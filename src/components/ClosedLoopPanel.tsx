import React, { useState, useEffect, useCallback } from 'react';
import { getCsrfToken } from '../auth/AuthProvider';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Clock,
  Play,
  RefreshCw,
  RotateCcw,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Zap,
  Power,
  XCircle,
  FolderCode,
  FileText,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { cn } from '../lib/utils';
import { useStore } from '../store';
import type {
  ClosedLoopRun,
  LoopMetrics,
  LoopStage,
  RiskTier,
} from '../services/closedLoop';

const STAGES: Array<{ id: LoopStage; label: string; desc: string }> = [
  { id: 'detect', label: 'Detect', desc: 'Composite signal intake & deduplication' },
  { id: 'diagnose', label: 'Diagnose', desc: 'Root cause analysis & baseline audit' },
  { id: 'decide', label: 'Decide', desc: 'Risk routing & blast-radius evaluation' },
  { id: 'act', label: 'Act', desc: 'Deterministic runbook or Axiom mission' },
  { id: 'verify', label: 'Verify', desc: 'Audit gate re-run (regression check)' },
  { id: 'learn', label: 'Learn', desc: 'Recourse memory & self-learning episode' },
];

export function ClosedLoopPanel() {
  const { activeProject } = useStore();
  const [runs, setRuns] = useState<ClosedLoopRun[]>([]);
  const [metrics, setMetrics] = useState<LoopMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedRun, setSelectedRun] = useState<ClosedLoopRun | null>(null);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [triggering, setTriggering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      const [runsRes, metricsRes] = await Promise.all([
        fetch('/api/loop/runs?limit=30', { credentials: 'include' }),
        fetch('/api/loop/metrics', { credentials: 'include' }),
      ]);

      if (runsRes.ok) {
        const data = await runsRes.json();
        setRuns(data.runs || []);
        if (selectedRun) {
          const updated = (data.runs as ClosedLoopRun[]).find((r: ClosedLoopRun) => r.id === selectedRun.id);
          if (updated) setSelectedRun(updated);
        }
      }
      if (metricsRes.ok) {
        const data = await metricsRes.json();
        setMetrics(data.metrics || null);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to fetch closed-loop state');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [selectedRun]);

  useEffect(() => {
    loadData();
    const interval = setInterval(() => loadData(true), 6000);
    return () => clearInterval(interval);
  }, [loadData]);

  const handleToggleKillSwitch = async () => {
    if (!metrics) return;
    try {
      const targetState = !metrics.killSwitchActive;
      const res = await fetch('/api/loop/kill-switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
        credentials: 'include',
        body: JSON.stringify({ active: targetState }),
      });
      if (res.ok) {
        await loadData(true);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to toggle kill switch');
    }
  };

  const handleApprove = async (runId: string) => {
    setApprovingId(runId);
    try {
      const res = await fetch(`/api/loop/runs/${runId}/approve`, {
        method: 'POST',
        headers: { 'X-CSRF-Token': getCsrfToken() },
        credentials: 'include',
      });
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || `HTTP ${res.status}`);
      }
      await loadData(true);
    } catch (err: any) {
      setError(err.message || 'Approval failed');
    } finally {
      setApprovingId(null);
    }
  };

  const handleTriggerRun = async () => {
    if (!activeProject?.path) {
      setError('Please select or load an active project first');
      return;
    }
    setTriggering(true);
    setError(null);
    try {
      const res = await fetch('/api/loop/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
        credentials: 'include',
        body: JSON.stringify({
          targetDir: activeProject.path,
          signals: [
            {
              source: 'audit',
              key: 'lint_errors_detected',
              severity: 'medium',
              message: 'Automated remediation requested from Loops console',
              targetDir: activeProject.path,
            },
          ],
        }),
      });
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      if (data.run) {
        setSelectedRun(data.run);
      }
      await loadData(true);
    } catch (err: any) {
      setError(err.message || 'Failed to trigger remediation loop');
    } finally {
      setTriggering(false);
    }
  };

  const pendingApprovals = runs.filter((r) => r.status === 'waiting_approval');

  return (
    <div className="space-y-6">
      {/* KPI & Metrics Bar */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <div className="bg-surface-base border border-border-muted rounded-xl p-3.5 flex flex-col justify-between">
          <span className="text-[10px] text-gray-400 uppercase tracking-wider font-semibold">Active Loops</span>
          <div className="flex items-baseline gap-1 mt-1">
            <span className="text-xl font-bold text-blue-400 font-mono">{metrics?.activeLoopsCount ?? 0}</span>
            <span className="text-[10px] text-gray-500 font-sans">running</span>
          </div>
        </div>

        <div className="bg-surface-base border border-border-muted rounded-xl p-3.5 flex flex-col justify-between">
          <span className="text-[10px] text-gray-400 uppercase tracking-wider font-semibold">MTTR</span>
          <div className="flex items-baseline gap-1 mt-1">
            <span className="text-xl font-bold text-gray-100 font-mono">
              {metrics?.mttrMs ? `${(metrics.mttrMs / 1000).toFixed(1)}s` : '—'}
            </span>
            <span className="text-[10px] text-gray-500 font-sans">mean recovery</span>
          </div>
        </div>

        <div className="bg-surface-base border border-border-muted rounded-xl p-3.5 flex flex-col justify-between">
          <span className="text-[10px] text-gray-400 uppercase tracking-wider font-semibold">Success Rate</span>
          <div className="flex items-baseline gap-1 mt-1">
            <span className="text-xl font-bold text-emerald-400 font-mono">
              {metrics?.automationSuccessRate != null ? `${Math.round(metrics.automationSuccessRate * 100)}%` : '—'}
            </span>
            <span className="text-[10px] text-gray-500 font-sans">resolved</span>
          </div>
        </div>

        <div className="bg-surface-base border border-border-muted rounded-xl p-3.5 flex flex-col justify-between">
          <span className="text-[10px] text-gray-400 uppercase tracking-wider font-semibold">Change Failure</span>
          <div className="flex items-baseline gap-1 mt-1">
            <span className="text-xl font-bold text-gray-300 font-mono">
              {metrics ? `${Math.round(metrics.changeFailureRate * 100)}%` : '—'}
            </span>
            <span className="text-[10px] text-gray-500 font-sans">regressed</span>
          </div>
        </div>

        <div className="bg-surface-base border border-border-muted rounded-xl p-3.5 flex flex-col justify-between">
          <span className="text-[10px] text-gray-400 uppercase tracking-wider font-semibold">Awaiting Approval</span>
          <div className="flex items-baseline gap-1 mt-1">
            <span className={cn('text-xl font-bold font-mono', (metrics?.waitingApprovalRuns ?? 0) > 0 ? 'text-amber-400' : 'text-gray-400')}>
              {metrics?.waitingApprovalRuns ?? 0}
            </span>
            <span className="text-[10px] text-gray-500 font-sans">operator wall</span>
          </div>
        </div>

        <div className="bg-surface-base border border-border-muted rounded-xl p-3.5 flex flex-col justify-between">
          <span className="text-[10px] text-gray-400 uppercase tracking-wider font-semibold">Autonomy Kill Switch</span>
          <div className="flex items-center justify-between mt-1">
            <span className={cn('text-xs font-bold uppercase', metrics?.killSwitchActive ? 'text-red-400' : 'text-emerald-400')}>
              {metrics?.killSwitchActive ? 'Active (Blocked)' : 'Armed (Online)'}
            </span>
            <button
              onClick={handleToggleKillSwitch}
              className={cn(
                'p-1.5 rounded-lg border transition-colors',
                metrics?.killSwitchActive
                  ? 'bg-red-500/20 text-red-400 border-red-500/30 hover:bg-red-500/30'
                  : 'bg-surface-raised text-gray-400 border-border-muted hover:text-red-400 hover:border-red-500/30',
              )}
              title={metrics?.killSwitchActive ? 'Resume autonomy' : 'Engage emergency kill switch'}
            >
              <Power className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-xs text-red-400 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
          <button onClick={() => setError(null)} className="text-gray-400 hover:text-gray-200">✕</button>
        </div>
      )}

      {/* Operator Approval Banner / Queue */}
      {pendingApprovals.length > 0 && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ShieldAlert className="w-5 h-5 text-amber-400" />
              <h4 className="text-sm font-bold text-amber-300">Operator Review Required</h4>
              <span className="px-2 py-0.5 rounded-full text-[10px] bg-amber-500/20 text-amber-300 font-bold">
                {pendingApprovals.length} pending
              </span>
            </div>
            <span className="text-xs text-gray-400">High blast-radius or schema/auth changes paused for safety</span>
          </div>

          <div className="space-y-2">
            {pendingApprovals.map((run) => (
              <div
                key={run.id}
                className="bg-surface-base border border-amber-500/20 rounded-lg p-3 flex flex-col md:flex-row md:items-center justify-between gap-3"
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-gray-200">{run.proposedAction?.name || 'Autonomous Action'}</span>
                    <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 font-bold">
                      Risk: {run.proposedAction?.riskTier}
                    </span>
                    <span className="text-[10px] text-gray-400 font-mono truncate max-w-xs">{run.targetDir}</span>
                  </div>
                  <p className="text-xs text-gray-400">{run.proposedAction?.description}</p>
                  {run.proposedAction?.filesTargeted && (
                    <div className="flex flex-wrap gap-1 text-[10px] font-mono text-gray-400 mt-1">
                      <span className="text-gray-500">Files:</span>
                      {run.proposedAction.filesTargeted.map((f) => (
                        <span key={f} className="px-1.5 py-0.5 bg-surface-raised rounded text-gray-300 border border-border-muted">
                          {f}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => setSelectedRun(run)}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-surface-raised border border-border-muted text-gray-300 hover:bg-surface-overlay"
                  >
                    Inspect
                  </button>
                  <button
                    onClick={() => handleApprove(run.id)}
                    disabled={approvingId === run.id}
                    className="px-3 py-1.5 rounded-lg text-xs font-bold bg-amber-500 text-black hover:bg-amber-400 disabled:opacity-50 inline-flex items-center gap-1.5 transition-colors"
                  >
                    {approvingId === run.id ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        Approving…
                      </>
                    ) : (
                      <>
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        Approve & Execute
                      </>
                    )}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Main Runner & Active Stage Viewer */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left 2 Cols: Pipeline Stepper & Inspector */}
        <div className="lg:col-span-2 space-y-4">
          <div className="bg-surface-raised border border-border-muted rounded-xl p-5 shadow-sm space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-border-muted pb-3">
              <div>
                <h3 className="text-base font-bold text-gray-100 flex items-center gap-2">
                  <Zap className="w-4 h-4 text-emerald-400" />
                  Self-Improving Autonomous Remediation
                </h3>
                <p className="text-xs text-gray-400 mt-0.5">
                  6-stage deterministic loop with pre/post score validation and fail-closed audit verification.
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => loadData(true)}
                  disabled={refreshing}
                  className="p-1.5 rounded-lg bg-surface-base border border-border-muted text-gray-400 hover:text-gray-200"
                  title="Refresh loop state"
                >
                  <RefreshCw className={cn('w-3.5 h-3.5', refreshing && 'animate-spin')} />
                </button>
                <button
                  onClick={handleTriggerRun}
                  disabled={triggering || metrics?.killSwitchActive || !activeProject}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-emerald-500 text-black hover:bg-emerald-400 disabled:opacity-50 transition-colors shadow-sm"
                >
                  {triggering ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5 fill-current" />}
                  Trigger Remediation Loop
                </button>
              </div>
            </div>

            {/* Selected or Latest Run Stepper */}
            {selectedRun || runs[0] ? (
              (() => {
                const current = selectedRun || runs[0];
                const stageIndex = STAGES.findIndex((s) => s.id === current.currentStage);

                return (
                  <div className="space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono bg-surface-base p-3 rounded-lg border border-border-muted">
                      <div className="flex items-center gap-2">
                        <span className="text-gray-400 font-sans">Run ID:</span>
                        <span className="text-gray-100 font-bold">{current.id}</span>
                        <span
                          className={cn(
                            'px-2 py-0.5 rounded text-[10px] font-sans font-bold uppercase',
                            current.status === 'completed' && 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20',
                            current.status === 'running' && 'bg-blue-500/10 text-blue-400 border border-blue-500/20 animate-pulse',
                            current.status === 'waiting_approval' && 'bg-amber-500/10 text-amber-400 border border-amber-500/20',
                            current.status === 'failed' && 'bg-red-500/10 text-red-400 border border-red-500/20',
                          )}
                        >
                          {current.status}
                        </span>
                      </div>

                      <div className="flex items-center gap-4 text-[11px]">
                        <div>
                          <span className="text-gray-500 font-sans">Pre-score: </span>
                          <span className="text-gray-200">{current.preScore ?? '—'}</span>
                        </div>
                        <ChevronRight className="w-3 h-3 text-gray-600" />
                        <div>
                          <span className="text-gray-500 font-sans">Post-score: </span>
                          <span className={cn(
                            'font-bold',
                            current.postScore !== undefined && current.preScore !== undefined && (current.postScore ?? 0) >= (current.preScore ?? 0)
                              ? 'text-emerald-400'
                              : 'text-gray-200',
                          )}>
                            {current.postScore ?? '—'}
                          </span>
                        </div>
                        {current.durationMs && (
                          <div className="text-gray-500">({(current.durationMs / 1000).toFixed(1)}s)</div>
                        )}
                      </div>
                    </div>

                    {/* 6-Stage Horizontal Progress Bar */}
                    <div className="grid grid-cols-2 sm:grid-cols-6 gap-2">
                      {STAGES.map((s, idx) => {
                        const isPast = stageIndex > idx || current.status === 'completed';
                        const isCurrent = current.currentStage === s.id && current.status !== 'completed';
                        const isFailed = current.status === 'failed' && current.currentStage === s.id;

                        return (
                          <div
                            key={s.id}
                            className={cn(
                              'p-2.5 rounded-lg border text-center transition-colors relative overflow-hidden',
                              isPast && 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400',
                              isCurrent && 'bg-blue-500/10 border-blue-500/30 text-blue-300 ring-1 ring-blue-500/30',
                              isFailed && 'bg-red-500/10 border-red-500/30 text-red-400',
                              !isPast && !isCurrent && !isFailed && 'bg-surface-base border-border-muted text-gray-500',
                            )}
                          >
                            <div className="text-[10px] font-bold uppercase tracking-wider">
                              {idx + 1}. {s.label}
                            </div>
                            <div className="text-[11px] truncate mt-0.5 font-sans opacity-70">
                              {isPast ? 'Passed' : isCurrent ? 'In Progress' : isFailed ? 'Failed' : 'Pending'}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* Stage Details / Proposed Action */}
                    {current.proposedAction && (
                      <div className="bg-surface-base border border-border-muted rounded-lg p-3.5 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-bold text-gray-300 uppercase font-sans">
                            Proposed Action ({current.proposedAction.type})
                          </span>
                          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-surface-raised border border-border-muted text-gray-300">
                            Risk Tier: {current.proposedAction.riskTier}
                          </span>
                        </div>
                        <div className="text-xs text-gray-200 font-semibold">{current.proposedAction.name}</div>
                        <p className="text-xs text-gray-400">{current.proposedAction.description}</p>
                        {current.proposedAction.command && (
                          <div className="text-[11px] font-mono bg-surface-raised p-2 rounded border border-border-muted text-emerald-400">
                            $ {current.proposedAction.command}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Stage Transition History */}
                    {current.stageHistory && current.stageHistory.length > 0 && (
                      <div className="space-y-1.5">
                        <span className="text-[10px] font-bold uppercase text-gray-400 tracking-wider">
                          Stage Transition Log
                        </span>
                        <div className="space-y-1 max-h-36 overflow-y-auto">
                          {current.stageHistory.map((h, i) => (
                            <div
                              key={i}
                              className="text-xs font-mono p-2 rounded bg-surface-base border border-border-muted/60 flex items-center justify-between text-gray-300"
                            >
                              <div className="flex items-center gap-2 truncate">
                                <span className="text-blue-400 font-bold uppercase text-[10px]">{h.stage}</span>
                                <span className="truncate text-gray-400">{h.notes || 'Stage executed'}</span>
                              </div>
                              <span className="text-[10px] text-gray-500 shrink-0">
                                {new Date(h.enteredAt).toLocaleTimeString()}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()
            ) : (
              <div className="text-center py-12 text-gray-500 text-xs font-mono">
                No remediation loops recorded yet. Select an active project and click "Trigger Remediation Loop".
              </div>
            )}
          </div>
        </div>

        {/* Right 1 Col: Loop Runs History */}
        <div className="bg-surface-raised border border-border-muted rounded-xl p-4 shadow-sm flex flex-col space-y-3">
          <div className="flex items-center justify-between border-b border-border-muted pb-2">
            <h4 className="text-sm font-bold text-gray-100 flex items-center gap-1.5">
              <Clock className="w-4 h-4 text-gray-400" />
              Remediation History
            </h4>
            <span className="text-[10px] font-mono text-gray-500">{runs.length} runs</span>
          </div>

          <div className="flex-1 overflow-y-auto space-y-2 max-h-[480px]">
            {runs.length === 0 ? (
              <div className="text-center py-8 text-xs text-gray-500 font-mono">
                No runs recorded
              </div>
            ) : (
              runs.map((r) => (
                <div
                  key={r.id}
                  onClick={() => setSelectedRun(r)}
                  className={cn(
                    'p-3 rounded-lg border text-left cursor-pointer transition-all space-y-1.5',
                    selectedRun?.id === r.id
                      ? 'bg-surface-overlay border-blue-500/40 shadow-sm'
                      : 'bg-surface-base border-border-muted hover:border-border-muted/80',
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-bold text-gray-200 truncate font-mono">
                      {r.id.slice(0, 16)}…
                    </span>
                    <span
                      className={cn(
                        'text-[11px] font-bold uppercase px-1.5 py-0.5 rounded',
                        r.status === 'completed' && 'text-emerald-400 bg-emerald-500/10',
                        r.status === 'running' && 'text-blue-400 bg-blue-500/10',
                        r.status === 'waiting_approval' && 'text-amber-400 bg-amber-500/10',
                        r.status === 'failed' && 'text-red-400 bg-red-500/10',
                      )}
                    >
                      {r.status}
                    </span>
                  </div>

                  <div className="text-xs text-gray-400 truncate">
                    {r.proposedAction?.name || r.targetDir}
                  </div>

                  <div className="flex items-center justify-between text-[10px] text-gray-500 font-mono pt-1 border-t border-border-muted/40">
                    <span>{new Date(r.startedAt).toLocaleTimeString()}</span>
                    <span>Stage: {r.currentStage}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
