import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Cpu, Play, Square, RefreshCw, FolderOpen, Terminal, RotateCcw, Share2, Activity, CheckCircle2, XCircle, ListChecks, GitBranch, Search, Zap } from 'lucide-react';
import { getCsrfToken, getAuthHeaders } from '../auth/AuthProvider';
import { useStore } from '../store';
import { useModelStore, AXIOM_ROUTES } from '../lib/modelStore';
import { cn } from '../lib/utils';
import { ClosedLoopPanel } from '../components/ClosedLoopPanel';

interface ProjectStatus {
  id: string;
  goal: string;
  targetDir: string;
  status: string;
  iteration: number;
  maxIterations: number;
  checkpointSha?: string;
  mode?: string;
  iterations?: any[];
}

interface SkillOption {
  id: string;
  name: string;
  description: string;
}

interface MissionTaskView {
  id: string;
  label: string;
  status: string;
  dependsOn: string[];
  subagentRole?: string;
  usage?: { calls: number; totalTokens: number };
  costUsd?: number | null;
  costSource?: string;
  error?: string;
}

interface MissionView {
  id: string;
  goal: string;
  status: string;
  tasks: MissionTaskView[];
  pendingPlan?: Array<{ label: string; goal: string; dependsOn: string[] }>;
}

const TABS = [
  { id: 'remediation', label: 'Autonomous Loops', icon: Zap },
  { id: 'harness', label: 'Project Loop', icon: Play },
  { id: 'missions', label: 'Plan Missions', icon: ListChecks },
  { id: 'sessions', label: 'Interactive Sessions', icon: Terminal },
  { id: 'retrieval', label: 'Semantic Retrieval', icon: Search },
] as const;

export function AxiomHarnessView() {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get('tab') || 'remediation';
  const tab = ['remediation', 'harness', 'missions', 'sessions', 'retrieval'].includes(rawTab) ? rawTab : 'remediation';

  const [axiomOnline, setAxiomOnline] = useState<boolean | null>(null);
  const [goal, setGoal] = useState('');
  const modelRoute = useModelStore((s) => s.routes.axiom) || 'auto';
  const setModelRoute = useModelStore((s) => s.setRoute);
  const [busy, setBusy] = useState(false);
  const [currentProject, setCurrentProject] = useState<ProjectStatus | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const { activeProject, activeProjectLoading, activeProjectError, fetchActiveProject } = useStore();

  // Mission (plan-gated) state.
  const [missionGoal, setMissionGoal] = useState('');
  const [missionPlanGate, setMissionPlanGate] = useState(true);
  const [missionBusy, setMissionBusy] = useState(false);
  const [mission, setMission] = useState<MissionView | null>(null);
  const [skills, setSkills] = useState<SkillOption[]>([]);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [shareView, setShareView] = useState<{ kind: string; markdown: string } | null>(null);
  const [telemetry, setTelemetry] = useState<any>(null);
  const [telemetryBusy, setTelemetryBusy] = useState(false);
  const [retrievalGoal, setRetrievalGoal] = useState('');
  const [retrievalResult, setRetrievalResult] = useState<any>(null);
  const [retrievalBusy, setRetrievalBusy] = useState(false);
  const [sessions, setSessions] = useState<Array<{ id: string; title: string; updatedAt: string }>>([]);
  const [activeSession, setActiveSession] = useState<{ id: string; title: string; messages: Array<{ role: string; text: string; ts?: number }> } | null>(null);
  const [sessionInput, setSessionInput] = useState('');

  const addLog = (msg: string) => {
    setLogs((prev) => [...prev.slice(-30), `[${new Date().toLocaleTimeString()}] ${msg}`]);
  };

  const checkStatus = async () => {
    try {
      const res = await fetch('/api/axiom/status', { credentials: 'include', headers: getAuthHeaders() });
      const json = await res.json();
      setAxiomOnline(json.ok && json.data?.status === 'ok');
      if (json.ok) addLog('Axiom daemon active on :3198');
    } catch {
      setAxiomOnline(false);
      addLog('Axiom daemon unreachable');
    }
  };

  useEffect(() => {
    void checkStatus();
    void fetchActiveProject();
    void loadSkills();
    void loadSessions();
  }, [fetchActiveProject]);

  const loadSkills = async () => {
    try {
      const res = await fetch('/api/axiom/skills', { credentials: 'include', headers: getAuthHeaders() });
      const json = await res.json();
      const all = Array.isArray(json.data?.skills) ? json.data.skills as SkillOption[] : [];
      setSkills(all.filter((s) => s.name && s.id));
    } catch {
      // skills are optional; the harness runs without them
    }
  };

  const loadSessions = async () => {
    try {
      const res = await fetch('/api/axiom/sessions', { credentials: 'include', headers: getAuthHeaders() });
      const json = await res.json();
      if (json.ok && Array.isArray(json.data?.sessions)) setSessions(json.data.sessions as Array<{ id: string; title: string; updatedAt: string }>);
    } catch {
      // sessions are optional
    }
  };

  const handleNewSession = async () => {
    try {
      const res = await fetch('/api/axiom/sessions', {
        method: 'POST',
        credentials: 'include',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
        body: JSON.stringify({ title: `Session ${new Date().toLocaleTimeString()}` }),
      });
      const json = await res.json();
      if (json.ok && json.data?.session) {
        setActiveSession({ id: json.data.session.id, title: json.data.session.title, messages: [] });
        addLog(`New session ${json.data.session.id}`);
        void loadSessions();
      }
    } catch (err: any) {
      addLog(`New session failed: ${err.message}`);
    }
  };

  const handleOpenSession = async (id: string) => {
    try {
      const res = await fetch(`/api/axiom/sessions/${id}`, { credentials: 'include', headers: getAuthHeaders() });
      const json = await res.json();
      if (json.ok && json.data?.session) {
        setActiveSession({ id: json.data.session.id, title: json.data.session.title, messages: json.data.session.messages ?? [] });
        addLog(`Resumed session ${id} (${(json.data.session.messages ?? []).length} messages)`);
      }
    } catch (err: any) {
      addLog(`Open session failed: ${err.message}`);
    }
  };

  const handleSessionSend = async () => {
    const text = sessionInput.trim();
    if (!text) return;
    if (!activeSession) {
      await handleNewSession();
      // activeSession set via state — need the id; re-fetch from sessions list
      const res = await fetch('/api/axiom/sessions', { credentials: 'include', headers: getAuthHeaders() });
      const json = await res.json();
      const newest = Array.isArray(json.data?.sessions) ? json.data.sessions[0] : null;
      if (!newest) return;
      setActiveSession((prev) => ({ id: newest.id, title: prev?.title ?? newest.title, messages: [...(prev?.messages ?? []), { role: 'user', text, ts: Date.now() }] }));
      setSessionInput('');
      addLog(`Session note saved: "${text.slice(0, 60)}"`);
      return;
    }
    const userMsg = { role: 'user', text, ts: Date.now() };
    setActiveSession((prev) => prev ? { ...prev, messages: [...prev.messages, userMsg] } : prev);
    setSessionInput('');
    addLog(`Session ${activeSession.id}: user -> ${text.slice(0, 60)}`);
    try {
      const res = await fetch(`/api/axiom/sessions/${activeSession.id}/messages`, {
        method: 'POST',
        credentials: 'include',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
        body: JSON.stringify({ messages: [userMsg] }),
      });
      const json = await res.json();
      if (json.ok && json.data?.session) {
        setActiveSession((prev) => prev ? { ...prev, messages: json.data.session.messages } : prev);
        void loadSessions();
      }
    } catch (err: any) {
      addLog(`Session persist failed: ${err.message}`);
    }
  };

  const pollMission = async (id: string) => {
    try {
      const res = await fetch(`/api/axiom/mission/status/${id}`, { credentials: 'include', headers: getAuthHeaders() });
      const json = await res.json();
      if (json.ok && json.data) {
        const m = json.data as MissionView;
        setMission(m);
        if (!['running', 'awaiting-approval'].includes(m.status)) {
          addLog(`Mission ${m.id} finished: ${m.status}`);
          return;
        }
        setTimeout(() => void pollMission(id), 4000);
      }
    } catch {
      // transient — retry next tick
      setTimeout(() => void pollMission(id), 8000);
    }
  };

  const handleStartLoop = async () => {
    if (!activeProject) {
      addLog('Load a project before dispatching an Axiom loop.');
      return;
    }
    setBusy(true);
    addLog(`Dispatching project loop for ${activeProject.repositoryName}: "${goal}"`);
    try {
      const res = await fetch('/api/axiom/project/run', {
        method: 'POST',
        credentials: 'include',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
        body: JSON.stringify({ goal, modelRoute, maxIterations: 8, skills: selectedSkills }),
      });
      const json = await res.json();
      if (json.ok && json.data?.id) {
        addLog(`Loop created with ID ${json.data.id}`);
        setCurrentProject({
          id: json.data.id,
          goal,
          targetDir: activeProject.path,
          status: 'running',
          iteration: 1,
          maxIterations: 8,
        });
      } else {
        addLog(`Failed to start loop: ${json.error || 'unknown error'}`);
      }
    } catch (err: any) {
      addLog(`Loop dispatch error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleStopLoop = async () => {
    if (!currentProject) return;
    addLog(`Sending stop request for loop ${currentProject.id}`);
    try {
      await fetch(`/api/axiom/project/stop/${currentProject.id}`, { method: 'POST', credentials: 'include', headers: { ...getAuthHeaders(), 'X-CSRF-Token': getCsrfToken() } });
      setCurrentProject((prev) => (prev ? { ...prev, status: 'stopped' } : null));
      addLog('Project loop stop signal acknowledged');
    } catch (err: any) {
      addLog(`Failed to stop loop: ${err.message}`);
    }
  };

  const handleRewindLoop = async () => {
    if (!currentProject) return;
    addLog(`Rewinding loop ${currentProject.id} to last checkpoint…`);
    try {
      const res = await fetch(`/api/axiom/project/rewind/${currentProject.id}`, { method: 'POST', credentials: 'include', headers: { ...getAuthHeaders(), 'X-CSRF-Token': getCsrfToken() } });
      const json = await res.json();
      if (json.ok && json.data?.ok) {
        addLog(`Rewound to ${json.data.resetTo?.slice(0, 12)} — ${json.data.note}`);
      } else {
        addLog(`Rewind failed: ${json.data?.error || json.error || 'unknown'}`);
      }
    } catch (err: any) {
      addLog(`Rewind error: ${err.message}`);
    }
  };

  const handleShare = async (kind: 'loop' | 'mission') => {
    const id = kind === 'loop' ? currentProject?.id : mission?.id;
    if (!id) return;
    try {
      const res = await fetch(`/api/axiom/${kind === 'loop' ? 'project' : 'mission'}/share/${id}`, { credentials: 'include', headers: getAuthHeaders() });
      const json = await res.json();
      if (json.ok && json.data?.markdown) {
        setShareView({ kind, markdown: json.data.markdown });
        addLog(`${kind} share snapshot generated (${json.data.markdown.length} chars)`);
      } else {
        addLog(`Share failed: ${json.data?.error || json.error || 'unknown'}`);
      }
    } catch (err: any) {
      addLog(`Share error: ${err.message}`);
    }
  };

  const handleMissionDispatch = async () => {
    if (!activeProject) {
      addLog('Load a project before dispatching a mission.');
      return;
    }
    setMissionBusy(true);
    addLog(`Dispatching ${missionPlanGate ? 'plan-gated' : 'autonomous'} mission: "${missionGoal}"`);
    try {
      const res = await fetch('/api/axiom/mission/run', {
        method: 'POST',
        credentials: 'include',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
        body: JSON.stringify({ goal: missionGoal, planGate: missionPlanGate, maxTasks: 5, skills: selectedSkills }),
      });
      const json = await res.json();
      if (json.ok && json.data?.id) {
        addLog(`Mission created ${json.data.id} (${json.data.status})`);
        setMission({ id: json.data.id, goal: missionGoal, status: json.data.status, tasks: [], pendingPlan: json.data.pendingPlan ?? undefined });
        if (json.data.status === 'running') void pollMission(json.data.id);
        if (json.data.status === 'awaiting-approval') addLog('Plan ready for review — approve to launch or reject.');
      } else {
        addLog(`Mission dispatch failed: ${json.error || 'unknown error'}`);
      }
    } catch (err: any) {
      addLog(`Mission dispatch error: ${err.message}`);
    } finally {
      setMissionBusy(false);
    }
  };

  const handleMissionDecision = async (approve: boolean) => {
    if (!mission) return;
    try {
      const res = await fetch(`/api/axiom/mission/${approve ? 'approve' : 'reject'}/${mission.id}`, {
        method: 'POST',
        credentials: 'include',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
        body: JSON.stringify(approve ? { by: 'openhub' } : { reason: 'rejected from OpenHub console' }),
      });
      const json = await res.json();
      if (json.ok && json.data?.ok) {
        addLog(approve ? `Mission ${mission.id} approved — launching ${json.data.taskCount} tasks` : `Mission ${mission.id} rejected`);
        if (approve) { setMission({ ...mission, status: 'running' }); void pollMission(mission.id); }
        else setMission({ ...mission, status: 'stopped' });
      } else {
        addLog(`Decision failed: ${json.data?.error || json.error || 'unknown'}`);
      }
    } catch (err: any) {
      addLog(`Decision error: ${err.message}`);
    }
  };

  const handleExportTelemetry = async () => {
    setTelemetryBusy(true);
    try {
      const res = await fetch('/api/axiom/telemetry/export', { credentials: 'include', headers: getAuthHeaders() });
      const json = await res.json();
      if (json.ok && json.data?.ok) {
        const spans = json.data.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.length ?? 0;
        setTelemetry(json.data);
        addLog(`OTel export: ${spans} spans`);
      } else {
        addLog('Telemetry export failed');
      }
    } catch (err: any) {
      addLog(`Telemetry export error: ${err.message}`);
    } finally {
      setTelemetryBusy(false);
    }
  };

  const handleRetrieve = async () => {
    if (!activeProject) {
      addLog('Load a project before retrieving.');
      return;
    }
    setRetrievalBusy(true);
    try {
      const res = await fetch('/api/axiom/retrieve', {
        method: 'POST',
        credentials: 'include',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
        body: JSON.stringify({ goal: retrievalGoal }),
      });
      const json = await res.json();
      if (json.ok && json.data?.ok) {
        setRetrievalResult(json.data);
        addLog(`Retrieval: engine=${json.data.engine}${json.data.live ? ' (live embeddings)' : ''} hits=${json.data.hits?.length ?? 0}`);
      } else {
        addLog(`Retrieval failed: ${json.data?.error || json.error || 'unknown'}`);
      }
    } catch (err: any) {
      addLog(`Retrieval error: ${err.message}`);
    } finally {
      setRetrievalBusy(false);
    }
  };

  const isRunning = currentProject?.status === 'running';
  const progress = currentProject
    ? Math.min(100, Math.round((currentProject.iteration / Math.max(1, currentProject.maxIterations)) * 100))
    : 0;

  const stats = [
    {
      label: 'Daemon',
      value: axiomOnline === null ? 'Probing' : axiomOnline ? 'Online' : 'Offline',
      sub: axiomOnline ? ':3198 responding' : axiomOnline === null ? 'checking status…' : 'unreachable',
      accent: axiomOnline ? 'var(--color-success)' : axiomOnline === null ? 'var(--color-info)' : 'var(--color-danger)',
      accent2: axiomOnline ? 'var(--color-success)' : 'var(--color-accent)',
      pct: axiomOnline ? 100 : axiomOnline === null ? 40 : 6,
    },
    {
      label: 'Active loop',
      value: currentProject ? currentProject.status : 'Idle',
      sub: currentProject ? `id ${currentProject.id.slice(0, 8)}` : 'no loop dispatched',
      accent: 'var(--color-info)',
      accent2: 'var(--color-accent)',
      pct: currentProject ? progress : 6,
    },
    {
      label: 'Iteration',
      value: currentProject ? `${currentProject.iteration}/${currentProject.maxIterations}` : '—',
      sub: currentProject ? currentProject.goal.slice(0, 32) || 'goal set' : 'start a loop to track',
      accent: 'var(--color-success)',
      accent2: 'var(--color-success)',
      pct: progress,
    },
    {
      label: 'Terminal',
      value: `${logs.length}`,
      sub: logs.length ? 'entries captured' : 'waiting for actions',
      accent: 'var(--color-warning)',
      accent2: 'var(--color-warning)',
      pct: Math.min(100, logs.length * 8),
    },
  ];

  return (
    <div className="flex-1 w-full max-w-6xl mx-auto flex flex-col gap-5 px-4 py-6">
      {/* Hero */}
      <section className="gradient-hero rounded-2xl p-6 relative overflow-hidden">
        <div className="absolute -right-10 -top-14 opacity-[0.12] pointer-events-none">
          <Cpu className="w-64 h-64 text-emerald-300" strokeWidth={1} />
        </div>
        <div className="flex items-center gap-2 text-[11px] font-extrabold uppercase tracking-[0.18em] text-emerald-300">
          <span className={`w-1.5 h-1.5 rounded-full ${axiomOnline ? 'bg-emerald-400 animate-pulse' : axiomOnline === null ? 'bg-blue-400 animate-pulse' : 'bg-red-400'}`} />
          {axiomOnline === null ? 'Probing daemon' : axiomOnline ? 'Daemon online · :3198' : 'Daemon offline'}
        </div>
        <h2 className="mt-2">
          Axiom harness <span className="text-info">loop control.</span>
        </h2>
        <p className="mt-1.5 max-w-xl text-sm text-gray-400">
          Dispatch autonomous coding loops against the active project.
        </p>
        <div className="mt-4 flex flex-wrap gap-2.5">
          {isRunning ? (
            <button
              onClick={handleStopLoop}
              className="inline-flex items-center gap-2 rounded-lg bg-red-600 hover:bg-red-500 text-white px-4 py-2 text-sm font-bold"
            >
              <Square className="w-4 h-4" /> Stop loop
            </button>
          ) : (
            <button
              onClick={handleStartLoop}
              disabled={busy || !axiomOnline || !activeProject || !goal.trim()}
              className="inline-flex items-center gap-2 rounded-lg bg-green-600 hover:bg-green-500 disabled:opacity-40 text-white px-4 py-2 text-sm font-bold"
            >
              <Play className="w-4 h-4" /> {activeProject ? 'Start project loop' : 'Load a project first'}
            </button>
          )}
          <button
            onClick={checkStatus}
            className="inline-flex items-center gap-2 rounded-lg border border-border-muted bg-surface-base/70 hover:border-emerald-500/50 px-4 py-2 text-sm font-bold text-gray-400"
          >
            <RefreshCw className="w-4 h-4" /> Refresh status
          </button>
          {currentProject && currentProject.checkpointSha && (
            <button
              onClick={handleRewindLoop}
              className="inline-flex items-center gap-2 rounded-lg border border-amber-600/50 bg-surface-base/70 hover:border-amber-500 px-4 py-2 text-sm font-bold text-amber-400"
            >
              <RotateCcw className="w-4 h-4" /> Undo to checkpoint
            </button>
          )}
          {currentProject && (
            <button
              onClick={() => void handleShare('loop')}
              className="inline-flex items-center gap-2 rounded-lg border border-border-muted bg-surface-base/70 hover:border-blue-500/50 px-4 py-2 text-sm font-bold text-gray-400"
            >
              <Share2 className="w-4 h-4" /> Share loop
            </button>
          )}
        </div>
      </section>

      {/* Stats */}
      <section className="grid grid-cols-2 xl:grid-cols-4 gap-3" aria-label="Harness status">
        {stats.map((s) => (
          <div key={s.label} className="industrial-card stat-tile p-4" style={{ ['--accent' as string]: s.accent, ['--accent2' as string]: s.accent2 }}>
            <div className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-gray-400">{s.label}</div>
            <div className="mt-1 truncate text-2xl font-extrabold text-[var(--color-text-primary)] tracking-tight">{s.value}</div>
            <div className="mt-0.5 truncate text-[11px] text-gray-400">{s.sub}</div>
            <div className="meter mt-2.5"><span style={{ width: `${s.pct}%` }} /></div>
          </div>
        ))}
      </section>

      {/* Sub-navigation tabs */}
      <nav className="flex gap-1 overflow-x-auto border-b border-surface-overlay pb-2" aria-label="Axiom Loops">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setSearchParams({ tab: t.id })}
            className={cn(
              'inline-flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-colors',
              tab === t.id
                ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 shadow-sm'
                : 'text-gray-400 hover:text-gray-200 hover:bg-surface-raised border border-transparent',
            )}
          >
            <t.icon className="w-3.5 h-3.5" />
            {t.label}
          </button>
        ))}
      </nav>

      {tab === 'remediation' && <ClosedLoopPanel />}

      {tab === 'harness' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          {/* Launch */}
          <section className="industrial-card p-5 space-y-4" aria-label="Launch project loop">
            <h2 className="!text-base">Launch loop</h2>
          <div>
            <label htmlFor="axiom-project" className="text-[11px] font-mono text-gray-400 block mb-1.5">Active project</label>
            <div id="axiom-project" className="flex items-center gap-2 rounded-lg bg-surface-base border border-border-muted px-3 py-2">
              <FolderOpen className="w-4 h-4 text-gray-400 shrink-0" />
              {activeProject ? (
                <div className="min-w-0">
                  <div className="text-xs font-bold text-[var(--color-text-primary)] truncate">{activeProject.repositoryName}</div>
                  <div className="text-[10px] font-mono text-gray-400 truncate" title={activeProject.path}>{activeProject.path}</div>
                </div>
              ) : (
                <span className="text-xs text-amber-400">{activeProjectLoading ? 'Checking active project…' : activeProjectError || 'No project loaded.'}</span>
              )}
            </div>
          </div>
          <div>
            <label htmlFor="axiom-goal" className="text-[11px] font-mono text-gray-400 block mb-1.5">Goal / prompt</label>
            <textarea
              id="axiom-goal"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              rows={3}
              placeholder="e.g. Fix failing tests and tighten error handling"
              className="w-full bg-surface-base border border-border-muted rounded-lg p-2.5 text-xs font-mono text-gray-400 outline-none focus:border-green-500 placeholder:text-gray-500"
            />
          </div>
          <div>
            <label htmlFor="axiom-route" className="text-[11px] font-mono text-gray-400 block mb-1.5">Model route</label>
            <select
              id="axiom-route"
              value={modelRoute}
              onChange={(e) => setModelRoute('axiom', e.target.value)}
              className="w-full bg-surface-base border border-border-muted rounded-lg px-2.5 py-2 text-xs font-mono text-gray-400"
            >
              {AXIOM_ROUTES.map((route) => (
                <option key={route} value={route}>{route.toUpperCase()}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="axiom-skills" className="text-[11px] font-mono text-gray-400 block mb-1.5">Skills (injected into codegen context)</label>
            <div id="axiom-skills" className="space-y-1.5">
              {skills.length === 0 ? (
                <div className="text-[11px] text-gray-500 font-mono">No skills detected (.opencode/skills)</div>
              ) : (
                skills.map((s) => (
                  <label key={s.id} className="flex items-start gap-2 cursor-pointer group">
                    <input
                      type="checkbox"
                      checked={selectedSkills.includes(s.id)}
                      onChange={(e) => {
                        const id = s.id;
                        setSelectedSkills((prev) => e.target.checked ? [...prev, id] : prev.filter((x) => x !== id));
                      }}
                      className="mt-0.5 accent-emerald-500"
                    />
                    <span className="min-w-0">
                      <span className="block text-xs font-bold text-gray-300 group-hover:text-[var(--color-text-primary)] truncate">{s.name}</span>
                      <span className="block text-[10px] text-gray-500 truncate">{s.description}</span>
                    </span>
                  </label>
                ))
              )}
            </div>
          </div>
        </section>

        {/* Monitor + logs */}
        <div className="lg:col-span-2 flex flex-col gap-3">
          <section className="industrial-card p-5" aria-label="Active loop monitor">
            <div className="flex items-center justify-between gap-3 mb-3">
              <h2 className="!text-base">Active loop</h2>
              {currentProject && <span className="count-pill">{currentProject.status}</span>}
            </div>
            {currentProject ? (
              <div className="rounded-lg bg-surface-base border border-border-muted p-3.5 space-y-1.5 font-mono text-xs">
                <div className="flex justify-between items-center gap-2">
                  <span className="text-gray-400 truncate">ID: {currentProject.id}</span>
                  <span className="text-gray-400 shrink-0">{currentProject.iteration}/{currentProject.maxIterations}</span>
                </div>
                <div className="meter"><span style={{ width: `${progress}%` }} /></div>
                <div className="text-gray-400 truncate">Goal: {currentProject.goal}</div>
                <div className="text-gray-400 truncate">Target: {currentProject.targetDir}</div>
                {currentProject.checkpointSha && (
                  <div className="text-amber-400 truncate" title="Last greenfield git checkpoint — Undo resets here">
                    checkpoint: {currentProject.checkpointSha.slice(0, 12)}
                  </div>
                )}
              </div>
            ) : (
              <div className="text-xs text-gray-400 font-mono py-6 text-center border border-dashed border-border-muted rounded-lg">
                No loops running — set a goal and dispatch.
              </div>
            )}
          </section>

          <section className="industrial-card p-5" aria-label="Execution terminal log">
            <div className="flex items-center justify-between gap-3 mb-3">
              <h2 className="!text-base flex items-center gap-2"><Terminal className="w-4 h-4 text-gray-400" /> Terminal</h2>
              <span className="count-pill">{logs.length} entries</span>
            </div>
            <div className="bg-surface-base border border-border-muted rounded-lg p-3 h-48 overflow-y-auto font-mono text-xs space-y-1">
              {logs.length === 0 ? (
                <span className="text-gray-400">Waiting for actions...</span>
              ) : (
                logs.map((line, idx) => (
                  <div key={idx} className="text-gray-400 leading-relaxed">
                    {line}
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      </div>
      )}

      {/* Mission (plan-gated) — closes the plan-mode / human-gate gap */}
      {tab === 'missions' && (
        <section className="industrial-card p-5 space-y-4" aria-label="Mission planner with plan gate">
        <div className="flex items-center justify-between gap-3">
          <h2 className="!text-base flex items-center gap-2"><GitBranch className="w-4 h-4 text-emerald-400" /> Mission planner</h2>
          <span className="count-pill">plan gate {missionPlanGate ? 'ON' : 'off'}</span>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <div className="space-y-3">
            <div>
              <label htmlFor="mission-goal" className="text-[11px] font-mono text-gray-400 block mb-1.5">Mission goal</label>
              <textarea
                id="mission-goal"
                value={missionGoal}
                onChange={(e) => setMissionGoal(e.target.value)}
                rows={3}
                placeholder="e.g. Build a multi-file CLI library and its dependent consumer"
                className="w-full bg-surface-base border border-border-muted rounded-lg p-2.5 text-xs font-mono text-gray-400 outline-none focus:border-emerald-500 placeholder:text-gray-500"
              />
            </div>
            <label className="flex items-center gap-2 text-xs font-mono text-gray-400">
              <input
                type="checkbox"
                checked={missionPlanGate}
                onChange={(e) => setMissionPlanGate(e.target.checked)}
                className="accent-emerald-500"
              />
              Require human approval of the plan before any task runs
            </label>
            <button
              onClick={handleMissionDispatch}
              disabled={missionBusy || !axiomOnline || !activeProject || !missionGoal.trim()}
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white px-4 py-2 text-sm font-bold"
            >
              <ListChecks className="w-4 h-4" /> {missionPlanGate ? 'Plan + await approval' : 'Dispatch autonomous mission'}
            </button>
          </div>
          <div className="rounded-lg bg-surface-base border border-border-muted p-3.5 space-y-2 font-mono text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="text-gray-400">Status</span>
              <span className={'font-bold ' + (mission?.status === 'awaiting-approval' ? 'text-amber-400' : mission?.status === 'running' ? 'text-emerald-400' : 'text-gray-400')}>
                {mission ? mission.status : 'idle'}
              </span>
            </div>
            {mission?.pendingPlan && mission.pendingPlan.length > 0 && mission.status === 'awaiting-approval' && (
              <div className="space-y-2 pt-2">
                <div className="text-[10px] uppercase tracking-wider text-gray-500">Proposed task DAG — approve to launch:</div>
                {mission.pendingPlan.map((t, i) => (
                  <div key={i} className="flex items-start gap-2 text-gray-300">
                    <span className="text-emerald-400 shrink-0">t{i + 1}</span>
                    <span className="min-w-0">
                      <span className="block truncate">{t.label}</span>
                      <span className="block text-[10px] text-gray-500 truncate">{t.dependsOn?.length ? `after ${t.dependsOn.join(', ')}` : 'independent'}</span>
                    </span>
                  </div>
                ))}
                <div className="flex gap-2 pt-1">
                  <button
                    onClick={() => void handleMissionDecision(true)}
                    className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 text-xs font-bold"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" /> Approve plan
                  </button>
                  <button
                    onClick={() => void handleMissionDecision(false)}
                    className="inline-flex items-center gap-1.5 rounded-md bg-red-600/80 hover:bg-red-500 text-white px-3 py-1.5 text-xs font-bold"
                  >
                    <XCircle className="w-3.5 h-3.5" /> Reject
                  </button>
                </div>
              </div>
            )}
            {mission?.tasks && mission.tasks.length > 0 && (
              <div className="space-y-1.5 pt-1">
                {mission.tasks.map((t) => (
                  <div key={t.id} className="flex items-center justify-between gap-2">
                    <span className="text-gray-300 truncate">{t.id} {t.label}</span>
                    <span className="flex items-center gap-2 shrink-0">
                      {t.subagentRole && <span className="text-[11px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300">{t.subagentRole}</span>}
                      {t.costUsd != null && <span className="text-[11px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300">${t.costUsd.toFixed(4)}</span>}
                      <span className={`text-[10px] ${t.status === 'done' ? 'text-emerald-400' : t.status === 'failed' || t.status === 'blocked' ? 'text-red-400' : 'text-gray-500'}`}>{t.status}</span>
                    </span>
                  </div>
                ))}
                {mission.tasks.some((t) => t.costUsd != null) && (
                  <div className="pt-1 border-t border-surface-overlay text-[10px] text-purple-300">
                    Mission cost: ${mission.tasks.reduce((a, t) => a + (t.costUsd ?? 0), 0).toFixed(4)}
                  </div>
                )}
              </div>
            )}
            {mission && !['awaiting-approval'].includes(mission.status) && mission.status !== 'running' && mission.tasks.length === 0 && (
              <div className="text-[11px] text-gray-500 pt-1">Mission {mission.id}: {mission.status}</div>
            )}
          </div>
        </div>
      </section>
      )}

      {/* Agent sessions (interactive UX: transcript + resume) */}
      {tab === 'sessions' && (
        <section className="industrial-card p-5 space-y-3" aria-label="Agent sessions">
          <div className="flex items-center justify-between gap-3">
            <h2 className="!text-base flex items-center gap-2"><Terminal className="w-4 h-4 text-blue-400" /> Agent sessions</h2>
            <button
              onClick={handleNewSession}
              className="rounded-md border border-border-muted hover:border-blue-500/50 px-3 py-1.5 text-xs font-bold text-gray-400"
            >
              New session
            </button>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
            <div className="rounded-lg bg-surface-base border border-border-muted p-2 space-y-1 max-h-40 overflow-y-auto">
              {sessions.length === 0 ? (
                <div className="text-[11px] text-gray-500 font-mono p-1">No sessions yet — start one and resume anytime.</div>
              ) : (
                sessions.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => void handleOpenSession(s.id)}
                    className={`w-full text-left px-2 py-1.5 rounded text-[11px] font-mono truncate ${activeSession?.id === s.id ? 'bg-blue-500/15 text-blue-300' : 'text-gray-400 hover:bg-surface-raised'}`}
                  >
                    {s.title || s.id}
                  </button>
                ))
              )}
            </div>
            <div className="lg:col-span-2 rounded-lg bg-surface-base border border-border-muted p-3 flex flex-col gap-2 min-h-[160px]">
              {activeSession ? (
                <>
                  <div className="flex-1 space-y-1.5 overflow-y-auto max-h-40 font-mono text-xs">
                    {activeSession.messages.length === 0 ? (
                      <div className="text-gray-500">Session {activeSession.id} — add a note or dispatch from the mission panel.</div>
                    ) : (
                      activeSession.messages.slice(-20).map((m, i) => (
                        <div key={i} className={m.role === 'user' ? 'text-blue-300' : 'text-gray-400'}>
                          <span className="text-gray-600">{m.role}:</span> {m.text}
                        </div>
                      ))
                    )}
                  </div>
                  <div className="flex gap-2">
                    <input
                      value={sessionInput}
                      onChange={(e) => setSessionInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') void handleSessionSend(); }}
                      placeholder="Note / prompt for this session…"
                      className="flex-1 bg-surface-raised border border-border-muted rounded-md px-2 py-1.5 text-xs font-mono text-gray-300 outline-none focus:border-blue-500 placeholder:text-gray-500"
                    />
                    <button
                      onClick={handleSessionSend}
                      className="rounded-md bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 text-xs font-bold shrink-0"
                    >
                      Send
                    </button>
                  </div>
                </>
              ) : (
                <div className="text-xs text-gray-500 font-mono m-auto">
                  Open a session from the list or create a new one to record/resume an agent interaction.
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {/* Semantic retrieval + Observability */}
      {tab === 'retrieval' && (
        <div className="space-y-4">
          <section className="industrial-card p-5 space-y-3" aria-label="Semantic retrieval">
            <div className="flex items-center justify-between gap-3">
              <h2 className="!text-base flex items-center gap-2"><Search className="w-4 h-4 text-teal-400" /> Semantic retrieval</h2>
              <span className="count-pill">{retrievalResult ? retrievalResult.engine : 'idle'}</span>
            </div>
            <div className="flex gap-2">
              <input
                value={retrievalGoal}
                onChange={(e) => setRetrievalGoal(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleRetrieve(); }}
                placeholder="Goal / query — e.g. implement the divide operation"
                className="flex-1 bg-surface-base border border-border-muted rounded-lg px-2.5 py-2 text-xs font-mono text-gray-400 outline-none focus:border-teal-500 placeholder:text-gray-500"
              />
              <button
                onClick={handleRetrieve}
                disabled={retrievalBusy || !axiomOnline || !activeProject || !retrievalGoal.trim()}
                className="rounded-md bg-teal-600 hover:bg-teal-500 disabled:opacity-40 text-white px-3 py-1.5 text-xs font-bold shrink-0"
              >
                {retrievalBusy ? 'Searching…' : 'Retrieve'}
              </button>
            </div>
            {retrievalResult ? (
              <div className="rounded-lg bg-surface-base border border-border-muted p-3 font-mono text-xs text-gray-300 space-y-1.5">
                <div className="text-[10px] text-gray-500">
                  engine: {retrievalResult.engine}{retrievalResult.live ? ' (live embeddings)' : ''} — {retrievalResult.hits?.length ?? 0} hits
                  {retrievalResult.note ? ` · ${retrievalResult.note}` : ''}
                </div>
                {(retrievalResult.hits ?? []).slice(0, 6).map((h: any, i: number) => (
                  <div key={i} className="space-y-0.5">
                    <div className="text-teal-300">
                      {h.file}:{h.startLine}-{h.endLine} <span className="text-gray-500">(score {h.score})</span>
                      {h.symbols?.length ? <span className="text-gray-500"> [{h.symbols.join(', ')}]</span> : null}
                    </div>
                    <div className="text-gray-500 truncate">{String(h.snippet || '').split(/\r?\n/).slice(0, 2).join(' ').slice(0, 220)}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-xs text-gray-500 font-mono">
                AST-chunked retrieval against the active project — embeddings when a tier is configured, lexical+symbol floor otherwise.
              </div>
            )}
          </section>

          {/* Share snapshot */}
          <section className="industrial-card p-5 space-y-3" aria-label="Share snapshot">
            <div className="flex items-center justify-between gap-3">
              <h2 className="!text-base flex items-center gap-2"><Share2 className="w-4 h-4 text-blue-400" /> Share / handoff</h2>
              <div className="flex gap-2">
                {mission && (
                  <button
                    onClick={() => void handleShare('mission')}
                    className="rounded-md border border-border-muted hover:border-blue-500/50 px-3 py-1.5 text-xs font-bold text-gray-400"
                  >
                    Share mission
                  </button>
                )}
                {shareView && (
                  <button
                    onClick={() => setShareView(null)}
                    className="rounded-md border border-border-muted hover:border-red-500/50 px-3 py-1.5 text-xs font-bold text-gray-400"
                  >
                    Close
                  </button>
                )}
              </div>
            </div>
            {shareView ? (
              <pre className="bg-surface-base border border-border-muted rounded-lg p-3 h-64 overflow-y-auto font-mono text-xs text-gray-300 whitespace-pre-wrap">
                {shareView.markdown}
              </pre>
            ) : (
              <div className="text-xs text-gray-500 font-mono">
                Generate a self-contained snapshot of a loop or mission — markdown + JSON for review or handoff to another agent.
              </div>
            )}
          </section>

          {/* OTel observability export */}
          <section className="industrial-card p-5 space-y-3" aria-label="Telemetry export">
            <div className="flex items-center justify-between gap-3">
              <h2 className="!text-base flex items-center gap-2"><Activity className="w-4 h-4 text-purple-400" /> OTel observability</h2>
              <button
                onClick={handleExportTelemetry}
                disabled={telemetryBusy || !axiomOnline}
                className="rounded-md bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white px-3 py-1.5 text-xs font-bold"
              >
                Export OTLP
              </button>
            </div>
            {telemetry ? (
              <div className="rounded-lg bg-surface-base border border-border-muted p-3 font-mono text-xs text-gray-300 space-y-1">
                <div className="flex gap-3 text-gray-400">
                  <span>spans: {telemetry.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.length ?? 0}</span>
                  <span>otlpVersion: {telemetry.otlpVersion}</span>
                </div>
                <pre className="h-40 overflow-y-auto whitespace-pre-wrap text-[10px] text-gray-500">
                  {JSON.stringify(telemetry, null, 2).slice(0, 4000)}
                </pre>
              </div>
            ) : (
              <div className="text-xs text-gray-500 font-mono">
                Export the durable event streams (missions, loops, evals) as OpenTelemetry JSON for a Jaeger/Signoz/Grafana collector.
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
