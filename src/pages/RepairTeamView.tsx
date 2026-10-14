import { useEffect, useState } from 'react';
import { Wrench, RotateCcw, RefreshCw, Siren, Zap } from 'lucide-react';
import { getCsrfToken, getAuthHeaders } from '../auth/AuthProvider';
import { useStore } from '../store';

interface RepairLogEntry {
  detectedAt?: string;
  signal?: string;
  detail?: unknown;
  action?: unknown;
  status?: unknown;
}

/**
 * A `.draymond/repair-team-log.json` entry. These use `failureKind` / `error` /
 * `repairedAt` / `crew.lead` / `action`, not `signal` / `timestamp` / `status` —
 * the old shared interface read the wrong fields, so every value here rendered
 * as "—". Kept in sync with `repairClient.RepairTeamLogEntry`.
 */
interface RepairTeamLogEntry {
  jobName?: string;
  failureKind?: string;
  error?: string;
  crew?: { lead?: string };
  repairedAt?: string;
  action?: string;
  detail?: unknown;
  dispatch?: { kind?: string; result?: string };
}

/** Rendered as text, never as a raw React child: .draymond repair-log entries
 *  carry `action` as an OBJECT ({name, service, command, safe}), not a string. */
function actionLabel(action: unknown): string {
  if (action == null) return 'Action';
  if (typeof action === 'string') return action;
  if (typeof action === 'object') {
    const a = action as { name?: unknown; service?: unknown };
    return [a.name, a.service].filter(Boolean).map(String).join(' · ') || 'Action';
  }
  return String(action);
}

function text(value: unknown): string {
  if (value == null) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

interface LaneStanding {
  lane: string;
  elo: number;
  matches: number;
  wins: number;
  losses: number;
  winRate: number;
}

interface RepairStandings {
  ok: boolean;
  signal?: string;
  bucket?: string;
  baselineLane?: string;
  ranked?: LaneStanding[];
  learning?: string[];
  error?: string;
}

/** Coerce an untrusted standings payload into the shape the view renders, so a
 *  malformed Axiom/Recourse body cannot throw in render. */
function normalizeStandings(raw: unknown): RepairStandings {
  const r = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  const ranked = Array.isArray(r.ranked)
    ? r.ranked
        .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
        .map((x) => ({
          lane: typeof x.lane === 'string' ? x.lane : String(x.lane ?? ''),
          elo: num(x.elo),
          matches: num(x.matches),
          wins: num(x.wins),
          losses: num(x.losses),
          winRate: num(x.winRate),
        }))
    : undefined;
  return {
    ok: true,
    signal: typeof r.signal === 'string' ? r.signal : undefined,
    bucket: typeof r.bucket === 'string' ? r.bucket : undefined,
    baselineLane: typeof r.baselineLane === 'string' ? r.baselineLane : undefined,
    ranked,
    learning: Array.isArray(r.learning) ? r.learning.filter((x): x is string => typeof x === 'string') : undefined,
    error: typeof r.error === 'string' ? r.error : undefined,
  };
}

export function RepairTeamView() {
  const [signal, setSignal] = useState('operator:repair-request');
  const [detail, setDetail] = useState('');
  const [repairLogs, setRepairLogs] = useState<RepairLogEntry[]>([]);
  const [teamLogs, setTeamLogs] = useState<RepairTeamLogEntry[]>([]);
  const [triggering, setTriggering] = useState(false);
  const [workOrder, setWorkOrder] = useState<{ items: any[]; total: number } | null>(null);
  const [incidents, setIncidents] = useState<any[]>([]);
  const [prefs, setPrefs] = useState<{ low: boolean; medium: boolean; high: boolean; critical: boolean; killSwitch: boolean } | null>(null);
  const [dispatchState, setDispatchState] = useState<{ inFlight: boolean; queued: number }>({ inFlight: false, queued: 0 });
  // Repair-lane outcome memory (Axiom's rating store over Draymond's team log).
  const [standingsSignal, setStandingsSignal] = useState('code_error');
  const [standings, setStandings] = useState<RepairStandings | null>(null);
  const [standingsBusy, setStandingsBusy] = useState(false);
  const { activeProject, activeProjectLoading, activeProjectError, fetchActiveProject } = useStore();

  const fetchStandings = async (query: string) => {
    setStandingsBusy(true);
    try {
      const res = await fetch(`/api/axiom/repair/standings?signal=${encodeURIComponent(query)}`, {
        credentials: 'include',
        headers: getAuthHeaders(),
      });
      const data = await res.json();
      // The proxy wraps Axiom's body as { ok, data }; a 502 means Axiom is down.
      setStandings(data?.ok ? normalizeStandings(data.data) : { ok: false, error: data?.error ?? `HTTP ${res.status}` });
    } catch (err) {
      setStandings({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setStandingsBusy(false);
    }
  };

  /** Fold Draymond's repair-team log into the rating store, then refresh. */
  const ingestOutcomes = async () => {
    setStandingsBusy(true);
    try {
      await fetch('/api/axiom/repair/ingest', {
        method: 'POST',
        credentials: 'include',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
        body: JSON.stringify({}),
      });
    } catch { /* best-effort; the log is not lost */ }
    await fetchStandings(standingsSignal);
  };

  const fetchIncidents = async () => {
    try {
      const res = await fetch('/api/incidents', { credentials: 'include', headers: getAuthHeaders() });
      const data = await res.json();
      if (data.ok) {
        setIncidents(Array.isArray(data.incidents) ? data.incidents : []);
        if (data.prefs) setPrefs(data.prefs);
        if (data.dispatch) setDispatchState(data.dispatch);
      }
    } catch { /* incident bus offline */ }
  };

  const togglePref = async (sev: 'low' | 'medium' | 'high' | 'critical') => {
    if (!prefs) return;
    try {
      const res = await fetch('/api/incidents/prefs', {
        method: 'PUT',
        credentials: 'include',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
        body: JSON.stringify({ [sev]: !prefs[sev] }),
      });
      const data = await res.json();
      if (data.ok && data.prefs) setPrefs({ ...data.prefs, killSwitch: prefs.killSwitch });
    } catch { /* prefs unavailable */ }
  };

  const dispatchIncident = async (id: string) => {
    try {
      await fetch(`/api/incidents/${id}/dispatch`, {
        method: 'POST',
        credentials: 'include',
        headers: { ...getAuthHeaders(), 'X-CSRF-Token': getCsrfToken() },
      });
      void fetchIncidents();
    } catch { /* dispatch failed */ }
  };

  const fetchLogs = async () => {
    try {
      const res = await fetch('/api/repair/logs', { credentials: 'include', headers: getAuthHeaders() });
      const data = await res.json();
      if (data.ok && data.logs) {
        setRepairLogs(data.logs.repairLog || []);
        setTeamLogs(data.logs.teamLog || []);
      }
    } catch {}
  };

  useEffect(() => {
    void fetchLogs();
    void fetchActiveProject();
    void fetchIncidents();
    void fetchStandings('code_error');
    (async () => {
      try {
        const res = await fetch('/api/audit/readouts', { credentials: 'include', headers: getAuthHeaders() });
        const data = await res.json();
        if (data.ok && data.workOrder) setWorkOrder(data.workOrder);
      } catch { /* readouts offline */ }
    })();
  }, [fetchActiveProject]);

  const handleTrigger = async () => {
    if (!activeProject) return;
    setTriggering(true);
    try {
      await fetch('/api/repair/trigger', {
        method: 'POST',
        credentials: 'include',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
        body: JSON.stringify({ signal, detail: detail.trim() || `Operator requested repair for ${activeProject.repositoryName}`, kind: 'job' }),
      });
      await fetchLogs();
    } catch {}
    setTriggering(false);
  };

  const lastSignal = teamLogs[0] ? (teamLogs[0].failureKind || teamLogs[0].error || '—') : '—';
  const stats = [
    { label: 'Shift logs', value: String(teamLogs.length), sub: teamLogs.length ? `last: ${String(lastSignal).slice(0, 24)}` : 'no triage yet', accent: 'var(--color-warning)', accent2: 'var(--color-warning)', pct: Math.min(100, teamLogs.length * 15) },
    { label: 'Repair actions', value: String(repairLogs.length), sub: repairLogs.length ? 'self-heal attempts' : 'none recorded', accent: 'var(--color-success)', accent2: 'var(--color-success)', pct: Math.min(100, repairLogs.length * 15) },
    { label: 'Dispatch', value: triggering ? 'Sending' : activeProject ? 'Ready' : 'Blocked', sub: activeProject ? activeProject.repositoryName : 'load a project first', accent: 'var(--color-info)', accent2: 'var(--color-accent)', pct: triggering ? 60 : activeProject ? 90 : 8 },
  ];

  return (
    <div className="flex-1 w-full max-w-6xl mx-auto flex flex-col gap-5 px-4 py-6">
      {/* Hero */}
      <section className="gradient-hero rounded-2xl p-6 relative overflow-hidden">
        <div className="absolute -right-10 -top-14 opacity-[0.12] pointer-events-none">
          <Wrench className="w-64 h-64 text-orange-300" strokeWidth={1} />
        </div>
        <div className="flex items-center gap-2 text-[11px] font-extrabold uppercase tracking-[0.18em] text-orange-300">
          <span className="w-1.5 h-1.5 rounded-full bg-orange-400 animate-pulse" />
          Operator-triggered triage
        </div>
        <h2 className="mt-2">
          Repair team <span className="text-info">dispatch.</span>
        </h2>
        <p className="mt-1.5 max-w-xl text-sm text-gray-400">
          Trigger deterministic triage and track self-healing outcomes.
        </p>
        <div className="mt-4 flex flex-wrap gap-2.5">
          <button
            onClick={handleTrigger}
            disabled={triggering || !signal.trim() || !activeProject}
            className="inline-flex items-center gap-2 rounded-lg bg-orange-600 hover:bg-orange-500 disabled:opacity-40 text-white px-4 py-2 text-sm font-bold"
          >
            <RotateCcw className="w-4 h-4" /> {activeProject ? 'Dispatch repair team' : 'Load a project first'}
          </button>
          <button
            onClick={fetchLogs}
            className="inline-flex items-center gap-2 rounded-lg border border-border-muted bg-surface-base/70 hover:border-orange-500/50 px-4 py-2 text-sm font-bold text-gray-400"
          >
            <RefreshCw className="w-4 h-4" /> Refresh logs
          </button>
        </div>
      </section>

      {/* Stats */}
      <section className="grid grid-cols-2 xl:grid-cols-3 gap-3" aria-label="Repair status">
        {stats.map((s) => (
          <div key={s.label} className="industrial-card stat-tile p-4" style={{ ['--accent' as string]: s.accent, ['--accent2' as string]: s.accent2 }}>
            <div className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-gray-400">{s.label}</div>
            <div className="mt-1 truncate text-2xl font-extrabold text-[var(--color-text-primary)] tracking-tight">{s.value}</div>
            <div className="mt-0.5 truncate text-[11px] text-gray-400">{s.sub}</div>
            <div className="meter mt-2.5"><span style={{ width: `${s.pct}%` }} /></div>
          </div>
        ))}
      </section>

      {/* Incidents — auto-dispatch feed with per-severity toggles (single-flight) */}
      <section className="industrial-card overflow-hidden" aria-label="Incident auto-dispatch">
        <div className="flex items-center justify-between gap-2 border-b border-surface-overlay bg-surface-raised/60 px-4 py-3">
          <h2 className="!text-base flex items-center gap-2">
            <Siren className="w-4 h-4 text-red-300" /> Incidents
            {dispatchState.inFlight && <span className="count-pill">dispatching…</span>}
            {dispatchState.queued > 0 && <span className="count-pill">{dispatchState.queued} queued</span>}
          </h2>
          <button onClick={() => void fetchIncidents()} className="inline-flex items-center gap-1.5 text-[11px] font-bold text-gray-400 hover:text-[var(--color-text-primary)]">
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
        </div>
        <div className="px-4 py-3 border-b border-surface-overlay">
          <div className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-gray-400 mb-2">Auto-dispatch toggles</div>
          <div className="flex flex-wrap gap-2">
            {(['low', 'medium', 'high', 'critical'] as const).map((sev) => {
              const on = !!prefs?.[sev];
              return (
                <button
                  key={sev}
                  onClick={() => void togglePref(sev)}
                  role="switch"
                  aria-checked={on}
                  className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-extrabold uppercase tracking-wider transition-colors ${on ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300' : 'border-border-muted bg-surface-base text-gray-400'}`}
                >
                  <span className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${on ? 'bg-emerald-500/60' : 'bg-border-muted'}`}>
                    <span className={`inline-block h-3 w-3 rounded-full bg-white transition-transform ${on ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                  </span>
                  {sev}
                </button>
              );
            })}
          </div>
          {prefs?.killSwitch && (
            <p className="mt-2 font-mono text-[10px] text-amber-300">Kill-switch active (OPENHUB_AUTODISPATCH=0) — incidents log only.</p>
          )}
        </div>
        {incidents.length === 0 ? (
          <div className="p-6 text-center text-sm text-gray-400">No incidents recorded — failures across Axiom, copilot, and pipelines land here.</div>
        ) : (
          <div className="divide-y divide-surface-overlay max-h-72 overflow-y-auto">
            {incidents.slice(0, 30).map((inc: any) => (
              <div key={inc.id} className="px-4 py-2.5 flex items-start gap-3">
                <span className={`mt-0.5 shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase ${
                  inc.severity === 'critical' ? 'border-red-500/50 text-red-300 bg-red-500/10'
                  : inc.severity === 'high' ? 'border-orange-500/50 text-orange-300 bg-orange-500/10'
                  : inc.severity === 'medium' ? 'border-blue-500/40 text-blue-300 bg-blue-500/10'
                  : 'border-border-muted text-gray-400'
                }`}>
                  {inc.severity}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-bold text-[var(--color-text-primary)]">{inc.kind} <span className="font-mono font-normal text-gray-400">· {inc.source}</span></div>
                  <div className="mt-0.5 line-clamp-2 text-[11px] text-gray-400">{inc.detail || '—'}</div>
                  <div className="mt-0.5 font-mono text-[10px] text-gray-400">
                    {inc.dispatched ? `repair dispatched${inc.dispatchResult ? ` · ${inc.dispatchResult}` : ''}` : 'logged — awaiting dispatch'}
                  </div>
                </div>
                {!inc.dispatched && (
                  <button
                    onClick={() => void dispatchIncident(inc.id)}
                    className="shrink-0 inline-flex items-center gap-1 rounded border border-orange-500/40 px-2 py-1 text-[10px] font-extrabold uppercase text-orange-300 hover:bg-orange-500/10"
                  >
                    <Zap className="w-3 h-3" /> Dispatch
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Work order — exact instructions from agent readouts */}
      {workOrder && (
        <section className="industrial-card overflow-hidden" aria-label="Repair work order">
          <div className="flex items-center justify-between gap-2 border-b border-surface-overlay bg-surface-raised/60 px-4 py-3">
            <h2 className="!text-base flex items-center gap-2"><Wrench className="w-4 h-4 text-orange-300" /> Work order</h2>
            <span className="count-pill">{workOrder.total} items</span>
          </div>
          {workOrder.items.length === 0 ? (
            <div className="p-6 text-center text-sm text-gray-400">No work order yet — run the audit to generate exact repair instructions.</div>
          ) : (
            <div className="divide-y divide-surface-overlay max-h-72 overflow-y-auto">
              {workOrder.items.slice(0, 40).map((w, i) => (
                <div key={`${w.tool}-${w.ruleId}-${i}`} className="px-4 py-2">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="shrink-0 font-mono text-gray-400">{i + 1}.</span>
                    <span className="truncate font-mono text-blue-300">{w.file}{w.line ? `:${w.line}` : ''}</span>
                    <span className="ml-auto shrink-0 rounded-full border border-border-muted px-1.5 py-0.5 font-mono text-[11px] uppercase text-gray-400">{w.category}</span>
                  </div>
                  <div className="mt-0.5 truncate text-[11px] font-mono text-orange-300/80" title={w.suggestion}>{w.suggestion}</div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Dispatch */}
      <section className="industrial-card p-5" aria-label="Dispatch repair for active project">
        <div className="flex items-center justify-between gap-3 mb-3">
          <h2 className="!text-base">Dispatch repair</h2>
          {activeProject ? (
            <span className="truncate font-mono text-[11px] text-gray-400">{activeProject.repositoryName} · {activeProject.path}</span>
          ) : (
            <span className="text-[11px] text-amber-400">{activeProjectLoading ? 'Checking active project…' : activeProjectError || 'No project loaded.'}</span>
          )}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label htmlFor="repair-signal" className="text-[11px] font-mono text-gray-400 block mb-1.5">Signal key</label>
            <input
              id="repair-signal"
              type="text"
              value={signal}
              onChange={(e) => setSignal(e.target.value)}
              className="w-full bg-surface-base border border-border-muted rounded-lg px-3 py-2 text-xs font-mono text-gray-400"
            />
          </div>
          <div>
            <label htmlFor="repair-detail" className="text-[11px] font-mono text-gray-400 block mb-1.5">Error detail</label>
            <input
              id="repair-detail"
              type="text"
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
              placeholder="e.g. Failing checkout on main"
              className="w-full bg-surface-base border border-border-muted rounded-lg px-3 py-2 text-xs font-mono text-gray-400 placeholder:text-gray-500"
            />
          </div>
        </div>
      </section>

      {/* Logs */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <section className="industrial-card p-5" aria-label="Repair shift log">
          <div className="flex items-center justify-between gap-3 mb-3">
            <h2 className="!text-base">Shift log</h2>
            <span className="count-pill">{teamLogs.length}</span>
          </div>
          <div className="bg-surface-base border border-border-muted rounded-lg p-3 h-64 overflow-y-auto space-y-2 font-mono text-xs">
            {teamLogs.length === 0 ? (
              <div className="text-gray-400 text-center py-6">No shift logs found.</div>
            ) : (
              teamLogs.map((log, i) => (
                <div key={i} className="border-b border-surface-overlay pb-2 last:border-b-0 space-y-0.5">
                  <div className="flex justify-between gap-2 text-xs text-gray-400">
                    <span className="text-orange-400 truncate" title={text(log.error)}>
                      {text(log.failureKind) || 'failure'}
                      {log.crew?.lead ? ` · ${log.crew.lead}` : ''}
                    </span>
                    <span className="shrink-0">{text(log.repairedAt) || 'Recent'}</span>
                  </div>
                  <div className="text-gray-400 text-xs line-clamp-2">{text(log.detail) || text(log.error)}</div>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="industrial-card p-5" aria-label="Self-repair action log">
          <div className="flex items-center justify-between gap-3 mb-3">
            <h2 className="!text-base">Self-repair log</h2>
            <span className="count-pill">{repairLogs.length}</span>
          </div>
          <div className="bg-surface-base border border-border-muted rounded-lg p-3 h-64 overflow-y-auto space-y-2 font-mono text-xs">
            {repairLogs.length === 0 ? (
              <div className="text-gray-400 text-center py-6">No self-repair attempts recorded.</div>
            ) : (
              repairLogs.map((log, i) => (
                <div key={i} className="border-b border-surface-overlay pb-2 last:border-b-0 space-y-0.5">
                  <div className="flex justify-between gap-2 text-xs text-gray-400">
                    <span className="text-green-400 truncate">{actionLabel(log.action)}</span>
                    <span className="shrink-0">{text(log.status)}</span>
                  </div>
                  <div className="text-gray-400 text-xs line-clamp-2">{text(log.detail)}</div>
                </div>
              ))
            )}
          </div>
        </section>
      </div>

      {/* Repair-lane outcome memory: which lead actually fixed which kind of
          failure, from real outcomes folded into Recourse's rating store. */}
      <section className="industrial-card p-5" aria-label="Repair lane standings">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <div>
            <h2 className="!text-base">Repair-lane standings</h2>
            <p className="text-[11px] text-gray-400 mt-0.5">
              Verified repair outcomes per coding lead, ranked by Elo. A fix counts only once its service
              re-pinged healthy (Draymond's gate) — an applied patch is not a verified repair. Rows below
              the match floor are still being learned — not a verdict.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <input
              aria-label="Failure signal bucket"
              value={standingsSignal}
              onChange={(e) => setStandingsSignal(e.target.value)}
              placeholder="failureKind e.g. code_error"
              className="w-52 bg-surface-base border border-border-muted rounded-lg px-3 py-1.5 text-xs font-mono text-gray-300"
            />
            <button
              type="button"
              onClick={() => void fetchStandings(standingsSignal)}
              disabled={standingsBusy}
              className="rounded-lg border border-border-muted px-3 py-1.5 text-xs font-bold text-gray-300 hover:bg-surface-overlay disabled:opacity-50"
            >
              {standingsBusy ? 'Loading…' : 'Load'}
            </button>
            <button
              type="button"
              onClick={() => void ingestOutcomes()}
              disabled={standingsBusy}
              className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-bold text-emerald-300 hover:bg-emerald-500/15 disabled:opacity-50"
            >
              Ingest outcomes
            </button>
          </div>
        </div>

        {!standings ? (
          <div className="text-gray-400 text-center py-6 text-xs">No standings loaded.</div>
        ) : !standings.ok ? (
          <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 px-3 py-2 text-xs text-amber-300">
            {standings.error?.includes('502') || standings.error?.includes('fetch')
              ? 'Axiom is unreachable — the standings come from Axiom’s rating bridge.'
              : standings.error || 'Standings unavailable.'}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-3 text-[11px] text-gray-400 font-mono">
              <span>bucket: <span className="text-gray-200">{standings.bucket ?? '—'}</span></span>
              <span>baseline lead: <span className="text-gray-200">{standings.baselineLane ?? '—'}</span></span>
            </div>
            {(standings.ranked?.length ?? 0) === 0 ? (
              <div className="text-gray-400 text-xs py-2">
                No lead has enough matched repairs yet. Enable exploration (DRAYMOND_REPAIR_EXPLORE=1) and
                ingest to build the ranking.
              </div>
            ) : (
              <table className="w-full text-left text-xs">
                <thead className="text-gray-400 font-mono text-[11px]">
                  <tr>
                    <th className="py-1">#</th>
                    <th className="py-1">lead</th>
                    <th className="py-1 text-right">elo</th>
                    <th className="py-1 text-right">w/l</th>
                    <th className="py-1 text-right">fix%</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {(standings.ranked ?? []).map((s, i) => (
                    <tr key={s.lane} className="border-t border-surface-overlay">
                      <td className="py-1 text-gray-400">{i + 1}</td>
                      <td className="py-1 text-gray-200">{s.lane}</td>
                      <td className="py-1 text-right text-amber-300">{s.elo.toFixed(0)}</td>
                      <td className="py-1 text-right text-gray-300">{s.wins}/{s.losses}</td>
                      <td className="py-1 text-right text-gray-300">{(s.winRate * 100).toFixed(0)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {(standings.learning?.length ?? 0) > 0 ? (
              <div className="text-[11px] text-gray-500">
                still learning (below match floor): <span className="font-mono text-gray-400">{standings.learning!.join(', ')}</span>
              </div>
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
}
