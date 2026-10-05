import { useState, useEffect, useCallback } from 'react';
import {
  Zap, Bot, Activity, ShieldCheck, RefreshCw, Layers, Play, CheckCircle2,
  AlertCircle, Loader2, Plus, Square, FileSearch,
} from 'lucide-react';
import { getAuthHeaders, getCsrfToken } from '../auth/AuthProvider';
import { useStore } from '../store';
import { useModelStore, AXIOM_ROUTES } from '../lib/modelStore';

interface SupervisedRun {
  id: string;
  goal: string;
  targetDir: string;
  loopId: string | null;
  status: 'looping' | 'auditing' | 'repairing' | 'complete' | 'failed';
  iteration: number;
  maxIterations: number;
  skills: { name: string; kind: string; reason?: string }[];
  audit: { overallStatus: string; results: { scorer: string; score: number | null; summary: string; error?: string }[] } | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

interface FleetAgent {
  name: string;
  kind: string;
  description?: string;
}

function statusStyle(status: SupervisedRun['status']) {
  if (status === 'looping') return 'border-orange-500/30 text-orange-300 bg-orange-500/10';
  if (status === 'auditing') return 'border-blue-500/30 text-blue-300 bg-blue-500/10';
  if (status === 'repairing') return 'border-amber-500/30 text-amber-300 bg-amber-500/10';
  if (status === 'complete') return 'border-emerald-500/30 text-emerald-300 bg-emerald-500/10';
  return 'border-red-500/30 text-red-300 bg-red-500/10';
}

function statusIcon(status: SupervisedRun['status']) {
  if (status === 'looping') return <Loader2 className="w-4 h-4 animate-spin" />;
  if (status === 'auditing') return <FileSearch className="w-4 h-4" />;
  if (status === 'repairing') return <Activity className="w-4 h-4" />;
  if (status === 'complete') return <CheckCircle2 className="w-4 h-4" />;
  return <AlertCircle className="w-4 h-4" />;
}

/** Real supervised pipeline: Axiom loop → audit → repair, persisted server-side. */
export function AutonomousPipelines() {
  const { activeProject, fetchActiveProject } = useStore();
  const modelRoute = useModelStore((s) => s.routes.axiom) || 'auto';
  const setModelRoute = useModelStore((s) => s.setRoute);

  const [runs, setRuns] = useState<SupervisedRun[]>([]);
  const [fleet, setFleet] = useState<FleetAgent[]>([]);
  const [goal, setGoal] = useState('');
  const [starting, setStarting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/supervise/runs', { credentials: 'include', headers: getAuthHeaders() });
      const data = await res.json();
      if (data.ok && Array.isArray(data.runs)) setRuns(data.runs);
    } catch { /* supervisor offline */ }
    try {
      const res = await fetch('/api/ecosystem/agents', { credentials: 'include', headers: getAuthHeaders() });
      const data = await res.json();
      const list = Array.isArray(data) ? data : Array.isArray(data?.assets) ? data.assets : Array.isArray(data?.agents) ? data.agents : [];
      setFleet(list.slice(0, 40).map((a: { name?: unknown; kind?: unknown; type?: unknown; description?: unknown }) => ({
        name: typeof a.name === 'string' ? a.name : 'agent',
        kind: typeof a.kind === 'string' ? a.kind : typeof a.type === 'string' ? a.type : 'agent',
        description: typeof a.description === 'string' ? a.description : undefined,
      })));
    } catch { /* catalog offline */ }
  }, []);

  useEffect(() => {
    void fetchActiveProject();
    void load();
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [fetchActiveProject, load]);

  const handleStart = async () => {
    if (!activeProject) {
      setMessage('Load a project first — supervised runs need a target.');
      return;
    }
    if (!goal.trim()) {
      setMessage('Set a goal for the loop first.');
      return;
    }
    setStarting(true);
    setMessage(null);
    try {
      const res = await fetch('/api/supervise/start', {
        method: 'POST',
        credentials: 'include',
        headers: getAuthHeaders({ 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() }),
        body: JSON.stringify({ goal: goal.trim(), modelRoute }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setMessage(data.error || `Supervision failed (${res.status})`);
      } else {
        setMessage(`Supervised run started — loop → audit → repair. Track it below.`);
        setGoal('');
        void load();
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Supervision request failed.');
    } finally {
      setStarting(false);
    }
  };

  const runningCount = runs.filter((r) => r.status === 'looping' || r.status === 'auditing' || r.status === 'repairing').length;
  const completeCount = runs.filter((r) => r.status === 'complete').length;
  const failedCount = runs.filter((r) => r.status === 'failed').length;
  const totalSkills = runs.reduce((n, r) => n + (r.skills?.length ?? 0), 0);

  const stats = [
    { label: 'Runs', value: String(runs.length), sub: 'supervised in ledger', accent: 'var(--color-warning)', accent2: 'var(--color-warning)', pct: Math.min(100, runs.length * 10) },
    { label: 'In progress', value: String(runningCount), sub: 'looping / auditing / repairing', accent: 'var(--color-info)', accent2: 'var(--color-accent)', pct: runs.length ? Math.round((runningCount / runs.length) * 100) : 0 },
    { label: 'Complete', value: String(completeCount), sub: failedCount ? `${failedCount} failed` : 'no failures recorded', accent: 'var(--color-success)', accent2: 'var(--color-success)', pct: runs.length ? Math.round((completeCount / runs.length) * 100) : 0 },
    { label: 'Skills matched', value: String(totalSkills), sub: 'best combo fed to loops', accent: 'var(--color-accent)', accent2: 'var(--color-accent)', pct: Math.min(100, totalSkills * 5) },
  ];

  return (
    <div className="flex flex-col gap-5">
      {/* Launch form */}
      <section className="industrial-card p-5">
        <h2 className="!text-base flex items-center gap-2"><Zap className="w-4 h-4 text-orange-300" /> Supervised run</h2>
        <p className="mt-1 text-xs text-gray-400">
          One dispatch: Axiom runs the goal to completion, the audit team grades the build, and Axiom fixes any failure — with the best skill/tool combo selected automatically.
        </p>
        <div className="mt-3 space-y-3">
          <div className="flex items-center gap-2 rounded-lg bg-surface-base border border-border-muted px-3 py-2 text-xs">
            <span className="font-mono text-gray-400 shrink-0">target</span>
            <span className="truncate font-bold text-[var(--color-text-primary)]">{activeProject ? activeProject.repositoryName : 'No project loaded'}</span>
          </div>
          <textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            rows={2}
            placeholder="Goal for the autonomous run (e.g. Fix failing tests and tighten error handling)"
            className="w-full bg-surface-base border border-border-muted rounded-lg p-2.5 text-xs font-mono text-gray-400 outline-none focus:border-orange-500 placeholder:text-gray-500"
          />
          <div className="flex flex-wrap items-center gap-2.5">
            <select
              value={modelRoute}
              onChange={(e) => setModelRoute('axiom', e.target.value)}
              className="rounded-lg border border-border-muted bg-surface-base px-2.5 py-2 text-xs font-mono text-gray-400"
            >
              {AXIOM_ROUTES.map((r) => <option key={r} value={r}>{r.toUpperCase()}</option>)}
            </select>
            <button
              onClick={handleStart}
              disabled={starting || !activeProject || !goal.trim()}
              className="inline-flex items-center gap-2 rounded-lg bg-orange-600 hover:bg-orange-500 disabled:opacity-40 text-white px-4 py-2 text-sm font-bold"
            >
              {starting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              {starting ? 'Starting…' : 'Supervise run'}
            </button>
            <button onClick={() => void load()} className="inline-flex items-center gap-2 rounded-lg border border-border-muted px-3 py-2 text-xs font-bold text-gray-400 hover:text-[var(--color-text-primary)]">
              <RefreshCw className="w-4 h-4" /> Refresh
            </button>
          </div>
        </div>
        {message && <p className="mt-3 text-xs font-mono text-gray-400">{message}</p>}
      </section>

      {/* Stats */}
      <section className="grid grid-cols-2 xl:grid-cols-4 gap-3" aria-label="Supervision metrics">
        {stats.map((s) => (
          <div key={s.label} className="industrial-card stat-tile p-4" style={{ ['--accent' as string]: s.accent, ['--accent2' as string]: s.accent2 }}>
            <div className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-gray-400">{s.label}</div>
            <div className="mt-1 text-2xl font-extrabold text-[var(--color-text-primary)] tracking-tight">{s.value}</div>
            <div className="mt-0.5 truncate text-[11px] text-gray-400">{s.sub}</div>
            <div className="meter mt-2.5"><span style={{ width: `${s.pct}%` }} /></div>
          </div>
        ))}
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {/* Runs ledger */}
        <div className="lg:col-span-2 space-y-3">
          <div className="industrial-card overflow-hidden">
            <div className="flex items-center justify-between gap-2 border-b border-surface-overlay bg-surface-raised/60 px-4 py-3">
              <h2 className="!text-base flex items-center gap-2"><Layers className="w-4 h-4 text-orange-300" /> Run ledger · {runs.length}</h2>
              <span className="count-pill">{runningCount} active</span>
            </div>
            {runs.length === 0 ? (
              <div className="p-8 text-center text-gray-400">
                <Bot className="w-8 h-8 mx-auto text-gray-400" />
                <p className="mt-3 text-sm font-bold text-[var(--color-text-primary)]">No supervised runs yet</p>
                <p className="mt-1 text-xs text-gray-400">Set a goal and dispatch the first loop → audit → repair chain.</p>
              </div>
            ) : (
              <div className="divide-y divide-surface-overlay">
                {runs.slice(0, 20).map((run) => (
                  <div key={run.id} className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <span className={`w-9 h-9 rounded-lg border flex items-center justify-center shrink-0 ${statusStyle(run.status)}`}>
                        {statusIcon(run.status)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="truncate text-sm font-bold text-[var(--color-text-primary)]">{run.goal}</span>
                          <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase ${statusStyle(run.status)}`}>{run.status}</span>
                        </div>
                        <div className="mt-0.5 flex items-center gap-3 font-mono text-[10px] text-gray-400">
                          <span className="truncate">{run.loopId ? `loop ${run.loopId.slice(0, 8)}` : 'no loop'}</span>
                          <span className="shrink-0">iter {run.iteration}/{run.maxIterations}</span>
                          <span className="shrink-0">{new Date(run.updatedAt).toLocaleTimeString()}</span>
                        </div>
                        {run.audit && (
                          <div className="mt-1 text-[11px] font-mono text-gray-400">
                            audit: <span className={run.audit.overallStatus === 'pass' ? 'text-emerald-300' : run.audit.overallStatus === 'warn' ? 'text-amber-300' : 'text-red-300'}>{run.audit.overallStatus}</span>
                            {run.audit.results.length ? ` · ${run.audit.results.map((r) => r.scorer).join(', ')}` : ''}
                          </div>
                        )}
                        {run.error && <div className="mt-1 truncate text-[11px] font-mono text-red-400">{run.error}</div>}
                      </div>
                    </div>
                    {run.skills.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {run.skills.map((s) => (
                          <span key={`${run.id}-${s.name}`} className="inline-flex items-center gap-1 rounded-full border border-border-muted px-2 py-0.5 text-[10px] font-mono text-gray-400" title={s.reason}>
                            {s.name} <span className="text-gray-400">{s.kind}</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Fleet + escalation */}
        <div className="space-y-3">
          <div className="industrial-card p-4">
            <h2 className="!text-base flex items-center gap-2"><Bot className="w-4 h-4 text-blue-300" /> Fleet agents</h2>
            <p className="mt-1 text-xs text-gray-400">Available skills/tools loops can draw on by default.</p>
            <div className="mt-3 space-y-1.5 max-h-80 overflow-y-auto">
              {fleet.length === 0 ? (
                <p className="text-xs font-mono text-gray-400">Fleet catalog unavailable.</p>
              ) : (
                fleet.slice(0, 24).map((a) => (
                  <div key={a.name} className="flex items-center gap-2 text-xs">
                    <span className="truncate font-bold text-[var(--color-text-primary)]">{a.name}</span>
                    <span className="ml-auto shrink-0 font-mono text-[10px] uppercase text-gray-400">{a.kind}</span>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="industrial-card p-4">
            <h2 className="!text-base flex items-center gap-2"><ShieldCheck className="w-4 h-4 text-emerald-300" /> Escalation</h2>
            <p className="mt-1 text-xs text-gray-400">
              Stuck loops ask the copilot to research via AgentBrowser, OmniResearch, or BookBridge.
            </p>
            <div className="mt-2 flex items-center gap-2 text-[11px] font-mono text-gray-400">
              <Plus className="w-3.5 h-3.5 text-orange-300" /> Use the Dev Co-Pilot <code className="text-orange-300">/ask</code> to route a question.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
