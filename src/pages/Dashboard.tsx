import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Activity, ArrowRight, ArrowUpRight, FolderGit2, Github, ShieldCheck,
  Sparkles, Terminal as TerminalIcon, Wrench, Zap, Radar, LayoutDashboard, ShieldAlert,
  Rocket, Loader2, XCircle,
} from 'lucide-react';
import { useStore } from '../store';
import { LocalFolderLoader } from '../components/LocalFolderLoader';
import { AutonomyBar } from '../components/AutonomyBar';
import { GitHubIntegrationPage } from './GitHubIntegrationPage';
import { AssuranceView } from './AssuranceView';
import { StatusLight } from '../components/StatusLight';
import { InsightFeedPanel } from '../components/InsightFeedPanel';
import { usePipelineContext } from '../ide/PipelineProvider';
import { stageLight } from '../ide/usePipeline';
import { getAutonomyMode, prefersPlanGate } from '../lib/autonomy';
import { getAuthHeaders } from '../auth/AuthProvider';
import { cn } from '../lib/utils';

/** Command Center: repo status first, then assurance + repositories, one surface. */
export function Dashboard() {
  const [searchParams] = useSearchParams();
  const rawTab = searchParams.get('tab') ?? 'status';
  const tab = ['status', 'assurance', 'repositories'].includes(rawTab) ? rawTab : 'status';
  const { repositories, registryItems, activeProject, activeProjectLoading, activeProjectError, fetchRepositories, fetchActiveProject, fetchRegistryItems, drift, driftState } = useStore();
  // Command console controls: run the autonomous pipeline from the home surface.
  const pipeline = usePipelineContext();
  const [projectStatus, setProjectStatus] = useState<any>(null);
  const [showOnboarding, setShowOnboarding] = useState(() => !localStorage.getItem('openhub.onboarding.done'));
  // Auxiliary status sources degrade independently; name them instead of
  // swallowing the failure so "no data" is distinguishable from "unavailable".
  const [degraded, setDegraded] = useState<string[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const markDegraded = (label: string) =>
    setDegraded((prev) => (prev.includes(label) ? prev : [...prev, label]));

  const dismissOnboarding = () => {
    localStorage.setItem('openhub.onboarding.done', '1');
    setShowOnboarding(false);
  };

  useEffect(() => {
    void fetchRepositories();
    void fetchActiveProject();
    void fetchRegistryItems();
  }, [fetchActiveProject, fetchRepositories, fetchRegistryItems]);

  useEffect(() => {
    if (!activeProject) return;
    (async () => {
      try {
        const res = await fetch('/api/project/active/status', { credentials: 'include', headers: getAuthHeaders() });
        const data = await res.json();
        if (data.ok) setProjectStatus(data);
      } catch { markDegraded('project status'); }
    })();
  }, [activeProject, reloadKey]);

  const repoCount = repositories.length;
  const toolCount = registryItems.length;
  const activeTools = registryItems.filter((t) => t.status === 'active').length;
  const toolHealth = toolCount ? Math.round((activeTools / toolCount) * 100) : 0;
  const driftSummary = !activeProject
    ? 'waiting on project'
    : driftState === 'ok' && drift
      ? !drift.hasUpstream
        ? 'no upstream branch yet'
        : drift.ahead + drift.behind + drift.uncommitted === 0
          ? 'in sync with last push'
          : `${drift.ahead}↑ ${drift.behind}↓ · ${drift.uncommitted} uncommitted`
      : driftState === 'scanning'
        ? 'scanning vs last push…'
        : `branch ${activeProject.defaultBranch ?? 'n/a'}`;

  const lastAudit = projectStatus?.current?.lastAudit ?? projectStatus?.persisted?.lastAudit ?? null;
  const lastRun = projectStatus?.current?.lastRun ?? projectStatus?.persisted?.lastRun ?? null;
  const auditVerdict = lastAudit?.overallStatus ?? null;

  return (
    <div className="flex-1 w-full max-w-6xl mx-auto flex flex-col gap-5 px-4 py-6">
      {/* Status / Assurance / Repositories tabs */}
      <nav className="flex gap-0.5 overflow-x-auto border-b border-surface-overlay -mb-2" aria-label="Command center">
        {[
          { id: 'status', label: 'Status', icon: LayoutDashboard, to: '/' },
          { id: 'assurance', label: 'Assurance', icon: ShieldCheck, to: '/?tab=assurance' },
          { id: 'repositories', label: `Projects · ${repoCount}`, icon: Github, to: '/?tab=repositories' },
        ].map((t) => (
          <Link key={t.id} to={t.to} className={cn('repo-tab', tab === t.id && 'active')}>
            <t.icon className="w-3.5 h-3.5" />
            {t.label}
          </Link>
        ))}
      </nav>

      {degraded.length > 0 && (
        <div role="alert" className="flex items-center justify-between gap-3 border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 rounded-md px-3 py-2">
          <span className="text-sm text-[var(--color-text-secondary)]">
            Some status sources are unavailable: {degraded.join(', ')}.
          </span>
          <button
            onClick={() => { setDegraded([]); setReloadKey((k) => k + 1); }}
            className="shrink-0 text-sm font-medium text-[var(--color-warning)] hover:underline"
          >
            Retry
          </button>
        </div>
      )}

      {tab === 'repositories' ? (
        <GitHubIntegrationPage />
      ) : tab === 'assurance' ? (
        <AssuranceView />
      ) : (
        <>
          {/* Hero */}
          <section className="gradient-hero rounded-2xl p-6 md:p-7 relative overflow-hidden">
            <div className="absolute -right-10 -top-14 opacity-[0.12] pointer-events-none">
              <Activity className="w-64 h-64 text-blue-300" strokeWidth={1} />
            </div>
            <div className="flex items-center gap-2 text-[11px] font-extrabold uppercase tracking-[0.18em] text-emerald-300">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              {activeProject ? `Context: ${activeProject.repositoryName}` : 'No project loaded'}
            </div>
            <h1 className="mt-2 max-w-2xl">
              Command console <span className="text-info">for shipping.</span>
            </h1>
            <p className="mt-2 max-w-xl text-sm text-gray-400">
              One project context drives code, Axiom loops, assurance, and GitHub delivery. Pick an action — everything else follows the active project.
            </p>
            <div className="mt-4 flex flex-wrap gap-2.5">
              <Link to="/?tab=repositories" className="inline-flex items-center gap-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 text-sm font-bold shadow-lg shadow-blue-950/50">
                <Github className="w-4 h-4" /> {activeProject ? 'Switch project' : 'Load a project'}
              </Link>
              <LocalFolderLoader className="!py-2" />
              <Link to="/workspace" className="inline-flex items-center gap-2 rounded-lg border border-border-muted bg-surface-base/70 hover:border-blue-500/50 px-4 py-2 text-sm font-bold text-gray-400">
                Open workspace <ArrowRight className="w-4 h-4" />
              </Link>
              <Link to="/?tab=assurance" className="inline-flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/15 px-4 py-2 text-sm font-bold text-emerald-300">
                <ShieldCheck className="w-4 h-4" /> Assurance
              </Link>
              <button
                type="button"
                onClick={() => void pipeline.start('autopilot', undefined, { planGate: prefersPlanGate(getAutonomyMode()) })}
                disabled={!activeProject || pipeline.running || pipeline.starting}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 text-sm font-bold disabled:opacity-40"
                title="Run the autonomous pipeline: typecheck → adversary → audit → repair → loop → verify"
              >
                {pipeline.starting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Rocket className="w-4 h-4" />} Run Autopilot
              </button>
              <button
                type="button"
                onClick={() => void pipeline.start('audit')}
                disabled={!activeProject || pipeline.running || pipeline.starting}
                className="inline-flex items-center gap-2 rounded-lg border border-border-muted bg-surface-base/70 hover:border-emerald-500/50 px-4 py-2 text-sm font-bold text-gray-300 disabled:opacity-40"
                title="Audit the active project and dispatch repair if it fails"
              >
                <ShieldCheck className="w-4 h-4" /> Audit
              </button>
            </div>

            {/* Live pipeline status — the console always shows whether work is happening. */}
            {pipeline.job && (
              <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className="font-mono text-[11px] text-gray-400">{Math.round((pipeline.job.progress ?? 0) * 100)}%</span>
                <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                  {pipeline.job.stages.map((s) => (
                    <StatusLight key={s.id} state={stageLight(s)} label={s.label} title={`${s.label}: ${s.detail || s.status}`} />
                  ))}
                </span>
                <StatusLight
                  state={pipeline.running ? 'working' : pipeline.job.status === 'complete' ? 'ok' : pipeline.job.status === 'cancelled' || pipeline.job.status === 'awaiting-approval' ? 'warn' : 'error'}
                  label={pipeline.running ? 'Running' : pipeline.job.status === 'awaiting-approval' ? 'Plan ready — approve in Workspace' : pipeline.job.status}
                  title={pipeline.job.error || pipeline.job.status}
                />
                {pipeline.running && (
                  <button
                    type="button"
                    onClick={() => void pipeline.cancel()}
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-gray-400 hover:text-red-400"
                  >
                    <XCircle className="w-3.5 h-3.5" /> Cancel
                  </button>
                )}
              </div>
            )}
            {!pipeline.job && pipeline.error && (
              <StatusLight state="error" label={pipeline.error} className="mt-4 max-w-[44rem]" />
            )}
          </section>

          {/* Live self-awareness — services, Recourse, insights, severity. */}
          <AutonomyBar />

          {/* First-run onboarding — three steps to a working loop */}
          {showOnboarding && (
            <section className="rounded-md border border-[color-mix(in_srgb,var(--color-accent)_35%,transparent)] bg-[color-mix(in_srgb,var(--color-accent)_8%,var(--color-surface-raised))] p-4">
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-accent-text)]">
                <Sparkles className="w-3.5 h-3.5" /> Your daily workspace in 3 steps
              </div>
              <div className="mt-2 grid grid-cols-1 md:grid-cols-3 gap-2">
                <Link to="/projects" className="group rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-raised)] p-3 hover:border-[var(--color-accent)]">
                  <span className="font-mono text-[10px] text-[var(--color-accent-text)]">1</span>
                  <span className="mt-1 block text-sm font-semibold text-[var(--color-text-primary)]">Load a project</span>
                  <span className="mt-0.5 block text-xs text-[var(--color-text-muted)]">Import from GitHub or a local folder.</span>
                </Link>
                <Link to="/workspace" className="group rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-raised)] p-3 hover:border-[var(--color-accent)]">
                  <span className="font-mono text-[10px] text-[var(--color-accent-text)]">2</span>
                  <span className="mt-1 block text-sm font-semibold text-[var(--color-text-primary)]">Open the workspace</span>
                  <span className="mt-0.5 block text-xs text-[var(--color-text-muted)]">Editor, terminal, git, and services in one surface.</span>
                </Link>
                <Link to="/axiom" className="group rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-raised)] p-3 hover:border-[var(--color-accent)]">
                  <span className="font-mono text-[10px] text-[var(--color-accent-text)]">3</span>
                  <span className="mt-1 block text-sm font-semibold text-[var(--color-text-primary)]">Run a loop</span>
                  <span className="mt-0.5 block text-xs text-[var(--color-text-muted)]">The fleet starts shipping while you watch.</span>
                </Link>
              </div>
              <button
                onClick={dismissOnboarding}
                className="mt-2 text-[11px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
              >
                Got it — hide this
              </button>
            </section>
          )}

          {/* Compact status: one line, no cards. */}
          <section className="industrial-card px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-2" aria-label="Status">
            <StatusLight
              state={activeProject ? 'ok' : 'warn'}
              label={activeProject ? activeProject.repositoryName : activeProjectLoading ? 'Loading project…' : 'No project loaded'}
              title={activeProject?.path ?? activeProjectError ?? undefined}
            />
            <StatusLight
              state={auditVerdict === 'pass' ? 'ok' : auditVerdict === 'fail' ? 'error' : auditVerdict === 'warn' ? 'warn' : 'idle'}
              label={`audit ${auditVerdict ?? '—'}`}
              title={lastAudit ? `${lastAudit.scores?.length ?? 0} scorers · ${new Date(lastAudit.timestamp).toLocaleString()}` : 'no audit recorded'}
            />
            <StatusLight
              state={driftState === 'scanning' ? 'working' : drift && drift.ahead + drift.behind + drift.uncommitted > 0 ? 'warn' : 'ok'}
              label={driftSummary}
            />
            <StatusLight
              state={lastRun ? (lastRun.status === 'failed' ? 'error' : 'ok') : 'idle'}
              label={`run ${lastRun?.status ?? '—'}`}
              title={lastRun?.goal}
            />
            <span className="font-mono text-[10px] text-[var(--color-text-muted)]">{repoCount} repos</span>
            <Link
              to={activeProject ? '/workspace' : '/?tab=repositories'}
              className="ml-auto shrink-0 inline-flex items-center gap-1 text-xs font-bold text-[var(--color-accent-text)] hover:text-[var(--color-accent)]"
            >
              {activeProject ? 'Workspace' : 'Load a project'} <ArrowUpRight className="w-3.5 h-3.5" />
            </Link>
          </section>

          {/* Repo status lives in the compact status strip above; the card wall
              that used to be here is gone (it was info without controls). */}

          {/* Discoveries & insights — what the system learned, not stat cards. */}
          <InsightFeedPanel />

        </>
      )}
    </div>
  );
}
