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
import { usePipelineContext } from '../ide/PipelineProvider';
import { stageLight } from '../ide/usePipeline';
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
  const [auditTools, setAuditTools] = useState<any[]>([]);
  const [dream, setDream] = useState<{ entries: any[]; summary: any } | null>(null);
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

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/audit/tools', { credentials: 'include', headers: getAuthHeaders() });
        const data = await res.json();
        if (data.ok && Array.isArray(data.tools)) setAuditTools(data.tools);
      } catch { markDegraded('audit tools'); }
    })();
    (async () => {
      try {
        const res = await fetch('/api/dream', { credentials: 'include', headers: getAuthHeaders() });
        const data = await res.json();
        if (data.ok) setDream({ entries: data.entries ?? [], summary: data.summary ?? {} });
      } catch { markDegraded('dream state'); }
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

  const stats = [
    { label: 'Repositories', value: String(repoCount), sub: repoCount ? 'tracked in account' : 'none yet — import one', accent: 'var(--color-info)', accent2: 'var(--color-accent)', pct: Math.min(100, repoCount * 12) },
    { label: 'Project context', value: activeProject ? 'Active' : 'Empty', sub: activeProject?.repositoryName ?? 'load one to unlock loops', accent: 'var(--color-success)', accent2: 'var(--color-success)', pct: activeProject ? 100 : 6 },
    { label: 'Tool health', value: toolCount ? `${toolHealth}%` : '—', sub: toolCount ? `${activeTools}/${toolCount} tools active` : 'no tools discovered', accent: 'var(--color-warning)', accent2: 'var(--color-warning)', pct: toolHealth },
    { label: 'Delivery', value: activeProject ? 'Ready' : 'Idle', sub: driftSummary, accent: 'var(--color-accent)', accent2: 'var(--color-accent)', pct: activeProject ? 82 : 8 },
  ];

  const actions = [
    { to: '/workspace', icon: TerminalIcon, title: 'Open workspace', desc: 'Code, loops, drift & skills in one', hover: 'var(--color-info)' },
    { to: '/axiom', icon: Zap, title: 'Loop console', desc: 'Full detail on running loops', hover: 'var(--color-success)' },
    { to: '/?tab=assurance', icon: ShieldCheck, title: 'Assurance', desc: 'Pipelines, audit, repair, readiness', hover: 'var(--color-info)' },
    { to: '/?tab=repositories', icon: Github, title: 'Load a project', desc: 'Import from GitHub or a local folder', hover: 'var(--color-warning)' },
    { to: '/fleet', icon: Radar, title: 'Fleet hub', desc: 'Agents, services, ecosystem, tools', hover: 'var(--color-accent-hover)' },
    { to: '/settings?tab=integrations', icon: Wrench, title: 'Configure', desc: 'Integrations, business & keys', hover: 'var(--color-warning)' },
  ];

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
          { id: 'repositories', label: `Repositories · ${repoCount}`, icon: Github, to: '/?tab=repositories' },
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
                onClick={() => void pipeline.start('autopilot')}
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
                  state={pipeline.running ? 'working' : pipeline.job.status === 'complete' ? 'ok' : pipeline.job.status === 'cancelled' ? 'warn' : 'error'}
                  label={pipeline.running ? 'Running' : pipeline.job.status}
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

          {/* Active project strip */}
          <section className="glass rounded-xl px-4 py-3 flex items-center gap-3" aria-label="Active project">
            <span className="w-8 h-8 rounded-lg bg-blue-500/15 border border-blue-500/30 flex items-center justify-center shrink-0">
              <FolderGit2 className="w-4 h-4 text-blue-300" />
            </span>
            {activeProject ? (
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-bold text-[var(--color-text-primary)]">{activeProject.repositoryName}</div>
                <div className="truncate font-mono text-[11px] text-gray-400">{activeProject.path}{activeProject.githubFullName ? ` · ${activeProject.githubFullName}` : ''}</div>
              </div>
            ) : (
              <div className="flex-1 text-sm text-gray-400">
                {activeProjectLoading ? 'Reading the active project context…' : activeProjectError || 'No project is loaded. Import one from GitHub to begin.'}
              </div>
            )}
            <Link to={activeProject ? '/workspace' : '/?tab=repositories'} className="shrink-0 inline-flex items-center gap-1 text-xs font-bold text-blue-300 hover:text-blue-200">
              {activeProject ? 'Workspace' : 'Repositories'} <ArrowUpRight className="w-3.5 h-3.5" />
            </Link>
          </section>

          {/* Repo status & weaknesses — know before working */}
          <section aria-labelledby="repo-status" className="space-y-3">
            <div className="flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-blue-300" />
              <h2 id="repo-status" className="!text-base">Repo status &amp; weaknesses</h2>
            </div>
            {!activeProject ? (
              <div className="industrial-card p-5 text-sm text-gray-400">
                {activeProjectLoading ? 'Reading the active project…' : 'Load a project to see its status, weaknesses, and last work point.'}
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="industrial-card stat-tile p-4" style={{ ['--accent' as string]: 'var(--color-accent)' }}>
                  <div className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-gray-400">Last audit</div>
                  <div className={`mt-1 text-2xl font-extrabold tracking-tight ${auditVerdict === 'pass' ? 'text-emerald-400' : auditVerdict === 'warn' ? 'text-amber-400' : auditVerdict === 'fail' ? 'text-red-400' : 'text-gray-400'}`}>
                    {auditVerdict ?? '—'}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-gray-400">{lastAudit ? `${lastAudit.scores?.length ?? 0} scorers · ${new Date(lastAudit.timestamp).toLocaleDateString()}` : 'no audit recorded'}</div>
                </div>
                <div className="industrial-card stat-tile p-4" style={{ ['--accent' as string]: 'var(--color-info)' }}>
                  <div className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-gray-400">Delivery state</div>
                  <div className="mt-1 text-2xl font-extrabold tracking-tight text-[var(--color-text-primary)]">{driftSummary}</div>
                  <div className="mt-0.5 truncate text-[11px] text-gray-400">drift vs last push</div>
                </div>
                <div className="industrial-card stat-tile p-4" style={{ ['--accent' as string]: 'var(--color-warning)' }}>
                  <div className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-gray-400">Last run</div>
                  <div className="mt-1 truncate text-2xl font-extrabold tracking-tight text-[var(--color-text-primary)]">{lastRun?.status ?? '—'}</div>
                  <div className="mt-0.5 truncate text-[11px] text-gray-400">{lastRun ? lastRun.goal.slice(0, 48) : 'no supervised run yet'}</div>
                </div>
              </div>
            )}
            {auditTools.length > 0 && (
              <div className="industrial-card p-4">
                <div className="flex items-center justify-between">
                  <h2 className="!text-base">Audit tools</h2>
                  <span className="count-pill">{auditTools.length}</span>
                </div>
                <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                  {auditTools.map((t) => (
                    <div key={t.name} className="rounded-lg border border-surface-overlay bg-surface-base/60 px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span className={`h-1.5 w-1.5 rounded-full ${t.configured ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                        <span className="truncate text-xs font-bold text-[var(--color-text-primary)]">{t.label ?? t.name}</span>
                      </div>
                      <div className="mt-1 flex items-center gap-3 font-mono text-[10px] text-gray-400">
                        <span>{t.kind}</span>
                        <span>{t.stats?.runs ?? 0} runs</span>
                        {typeof t.stats?.avgScore === 'number' && <span>avg {t.stats.avgScore}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>

          {/* Dream state — continuous monitoring + grading of every repo */}
          {dream && dream.entries.length > 0 && (
            <section className="industrial-card overflow-hidden" aria-label="Dream state">
              <div className="flex items-center justify-between gap-2 border-b border-surface-overlay bg-surface-raised/60 px-4 py-3">
                <h2 className="!text-base flex items-center gap-2"><Radar className="w-4 h-4 text-purple-300" /> Dream state</h2>
                <span className="count-pill">{dream.summary?.graded ?? 0}/{dream.summary?.total ?? 0} graded</span>
              </div>
              <div className="divide-y divide-surface-overlay max-h-72 overflow-y-auto">
                {dream.entries.map((e: any) => (
                  <div key={e.repoId} className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${e.status === 'healthy' ? 'bg-emerald-400' : e.status === 'attention' ? 'bg-amber-400' : e.status === 'critical' ? 'bg-red-400' : 'bg-gray-400'}`} />
                      <span className="truncate text-xs font-bold text-[var(--color-text-primary)]">{e.name}</span>
                      <span className="ml-auto shrink-0 font-mono text-sm font-extrabold text-gray-200">{e.grade ?? '—'}</span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-3 font-mono text-[10px] text-gray-400">
                      <span className="truncate">{e.purpose.slice(0, 40)}</span>
                      <span className="shrink-0">{e.development}</span>
                      {typeof e.score === 'number' && <span className="shrink-0">score {e.score}</span>}
                      {e.findings > 0 && <span className="shrink-0 text-orange-300">{e.findings} findings</span>}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Stats */}
          <section className="grid grid-cols-2 xl:grid-cols-4 gap-3" aria-label="Status">
            {stats.map((s) => (
              <div key={s.label} className="industrial-card stat-tile p-4" style={{ ['--accent' as string]: s.accent, ['--accent2' as string]: s.accent2 }}>
                <div className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-gray-400">{s.label}</div>
                <div className="mt-1 text-2xl font-extrabold text-[var(--color-text-primary)] tracking-tight">{s.value}</div>
                <div className="mt-0.5 truncate text-[11px] text-gray-400">{s.sub}</div>
                <div className="meter mt-2.5"><span style={{ width: `${s.pct}%` }} /></div>
              </div>
            ))}
          </section>

          {/* Quick actions */}
          <section aria-label="Quick actions">
            <div className="flex items-center gap-2 mb-2.5">
              <Sparkles className="w-4 h-4 text-yellow-300" />
              <h2 className="!text-base">Do next</h2>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {actions.map((a) => (
                <Link key={a.to + a.title} to={a.to} className="quick-action" style={{ ['--hover' as string]: a.hover }}>
                  <span className="quick-icon"><a.icon className="w-[18px] h-[18px]" style={{ color: a.hover }} /></span>
                  <span className="min-w-0">
                    <span className="block text-sm font-bold text-[var(--color-text-primary)]">{a.title}</span>
                    <span className="block text-xs text-gray-400 mt-0.5">{a.desc}</span>
                  </span>
                  <ArrowUpRight className="w-4 h-4 ml-auto shrink-0 text-gray-400" />
                </Link>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
