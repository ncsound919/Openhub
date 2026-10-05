import { useCallback, useEffect, useState } from 'react';
import { Activity, Brain, Lightbulb, Network, RefreshCw, TrendingUp, Zap } from 'lucide-react';
import { getCsrfToken, getAuthHeaders } from '../auth/AuthProvider';
import { useAutonomy } from '../hooks/useAutonomy';

interface Insight { id: string; severity: string; title: string; detail: string; systems: string[] }
interface Point { key: string; count: number }
interface Report {
  generatedAt: string;
  trends: {
    windowMs: number; since: string; total: number; passRate: number | null;
    bySystem: Point[]; byKind: Point[]; byOutcome: Point[]; bySeverity: Point[];
  };
  insights: Insight[];
  learning: {
    calibration: { passRate: number | null; sampleSize: number; passRateThreshold: number };
    skills: Array<{ name: string; attempts: number; accepted: number; rejected: number; weight: number }>;
    lessons: Array<{ id: string; severity: string; text: string }>;
  };
  synergy: { available: boolean; domains: string[]; edges: any[]; candidates: any[] };
  autonomy: {
    available: boolean;
    agenda: { math?: { title: string; rationale?: string }; oncology?: { title: string; rationale?: string } };
    learn: any;
    suggestedActions: Array<{ id: string; title: string; detail: string; system: string }>;
  };
  sources: { telemetry: { available: boolean }; recourse: { available: boolean; error?: string } };
}

const SEVERITY: Record<string, string> = {
  critical: 'border-red-500/40 bg-red-500/10 text-red-300',
  high: 'border-orange-500/40 bg-orange-500/10 text-orange-300',
  medium: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  low: 'border-blue-500/40 bg-blue-500/10 text-blue-300',
  info: 'border-border-muted bg-surface-overlay text-gray-300',
};

function Bars({ points, accent = 'var(--color-info)' }: { points: Point[]; accent?: string }) {
  const max = points.reduce((m, p) => Math.max(m, p.count), 0) || 1;
  if (points.length === 0) return <div className="font-mono text-xs text-gray-400">no data</div>;
  return (
    <div className="space-y-1.5">
      {points.slice(0, 7).map((p) => (
        <div key={p.key} className="flex items-center gap-2">
          <span className="w-28 shrink-0 truncate font-mono text-[11px] text-gray-400">{p.key}</span>
          <div className="h-2 flex-1 rounded-full bg-surface-overlay">
            <div className="h-2 rounded-full" style={{ width: `${Math.round((p.count / max) * 100)}%`, background: accent }} />
          </div>
          <span className="w-8 shrink-0 text-right font-mono text-[11px] text-gray-400">{p.count}</span>
        </div>
      ))}
    </div>
  );
}

export function InsightsView() {
  const [fetched, setFetched] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [dispatching, setDispatching] = useState<string | null>(null);
  const [dispatchMsg, setDispatchMsg] = useState<string>('');
  const [forging, setForging] = useState(false);
  const [forgeMsg, setForgeMsg] = useState('');
  // Live heartbeat: the autonomy engine recomputes insights server-side, so the
  // page updates itself; the manual fetch is only a first-paint/fallback path.
  const { snapshot } = useAutonomy();
  const report = (snapshot?.insights as Report | undefined) ?? fetched;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/insights', { credentials: 'include', headers: getAuthHeaders() });
      const data = await res.json();
      if (data.ok) setFetched(data.report as Report);
    } catch { /* keep last report */ }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const dispatch = async (actionId: string, goal: string) => {
    const targetDir = window.prompt('Target directory for the supervised repair loop (must be under Axiom UPLIFT_ROOT):', '');
    if (!targetDir) return;
    setDispatching(actionId);
    setDispatchMsg('');
    try {
      const res = await fetch('/api/recourse/bridge/dispatch', {
        method: 'POST',
        credentials: 'include',
        headers: { ...getAuthHeaders(), 'X-CSRF-Token': getCsrfToken(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetDir, goal, maxIterations: 6 }),
      });
      const data = await res.json();
      setDispatchMsg(data.ok ? `Dispatched supervised run ${data.run?.id ?? ''}` : `Dispatch failed: ${data.error ?? data.run?.error ?? 'unknown'}`);
    } catch (err: any) {
      setDispatchMsg(`Dispatch failed: ${err?.message ?? err}`);
    }
    setDispatching(null);
    refresh();
  };

  const runForge = async () => {
    setForging(true);
    setForgeMsg('');
    try {
      const res = await fetch('/api/selflearn/forge', {
        method: 'POST',
        credentials: 'include',
        headers: { ...getAuthHeaders(), 'X-CSRF-Token': getCsrfToken(), 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      setForgeMsg(data.available ? 'Recourse forge iteration dispatched.' : `Forge unavailable: ${data.error ?? 'Recourse offline or unguarded'}`);
    } catch (err: any) {
      setForgeMsg(`Forge failed: ${err?.message ?? err}`);
    }
    setForging(false);
  };

  if (!report) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="font-mono text-xs text-[var(--color-text-muted)]">{loading ? 'Computing insights…' : 'No report yet'}</div>
      </div>
    );
  }

  const learning = report.learning ?? { calibration: { passRate: null, sampleSize: 0, passRateThreshold: 0.5 }, skills: [], lessons: [] };
  const passPct = report.trends.passRate === null ? '—' : `${Math.round(report.trends.passRate * 100)}%`;
  const tiles = [
    { label: 'Events', value: String(report.trends.total), sub: `${Math.round(report.trends.windowMs / 86400000)}d window`, accent: 'var(--color-info)' },
    { label: 'Pass rate', value: passPct, sub: 'verified verdicts', accent: 'var(--color-success)' },
    { label: 'Synergy', value: String(report.synergy.domains.length), sub: `${report.synergy.candidates.length} candidates`, accent: 'var(--color-accent)' },
    { label: 'Recourse', value: report.sources.recourse.available ? 'Online' : 'Offline', sub: report.autonomy.agenda.math ? 'agenda live' : 'no agenda', accent: 'var(--color-warning)' },
  ];

  return (
    <div className="flex-1 w-full max-w-6xl mx-auto flex flex-col gap-5 px-4 py-6">
      <section className="gradient-hero rounded-2xl p-6 relative overflow-hidden">
        <div className="absolute -right-8 -top-12 opacity-[0.12] pointer-events-none">
          <TrendingUp className="w-56 h-56 text-emerald-300" strokeWidth={1} />
        </div>
        <div className="flex items-center gap-2 text-[11px] font-extrabold uppercase tracking-[0.18em] text-emerald-300">
          <span className={`w-1.5 h-1.5 rounded-full ${report.sources.recourse.available ? 'bg-emerald-400 animate-pulse' : 'bg-surface-overlay'}`} />
          Telemetry · Trends · Self-learning
        </div>
        <h2 className="mt-2">Systems that <span className="text-info">learn together.</span></h2>
        <p className="mt-1.5 max-w-2xl text-sm text-gray-400">
          One event stream across Axiom, Game Maker, audits and repairs, fused with Recourse's cross-domain synergy and
          self-learning agenda.
        </p>
        <div className="mt-4">
          <button onClick={refresh} disabled={loading} className="inline-flex items-center gap-2 rounded-lg border border-border-muted bg-surface-base/70 px-4 py-2 text-sm font-bold text-gray-400 hover:border-blue-500/50 disabled:opacity-50">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>
      </section>

      <section className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        {tiles.map((s) => (
          <div key={s.label} className="industrial-card stat-tile p-4" style={{ ['--accent' as string]: s.accent, ['--accent2' as string]: s.accent }}>
            <div className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-gray-400">{s.label}</div>
            <div className="mt-1 truncate text-2xl font-extrabold text-[var(--color-text-primary)] tracking-tight">{s.value}</div>
            <div className="mt-0.5 truncate text-[11px] text-gray-400">{s.sub}</div>
          </div>
        ))}
      </section>

      <section className="grid gap-3 lg:grid-cols-2">
        <div className="industrial-card p-5">
          <div className="flex items-center gap-2"><Activity className="w-4 h-4 text-info" /><h3 className="text-sm font-extrabold uppercase tracking-[0.14em] text-[var(--color-text-primary)]">By system</h3></div>
          <div className="mt-3"><Bars points={report.trends.bySystem} /></div>
          <div className="mt-4 flex items-center gap-2"><Zap className="w-4 h-4 text-accent" /><h3 className="text-sm font-extrabold uppercase tracking-[0.14em] text-[var(--color-text-primary)]">By outcome</h3></div>
          <div className="mt-3"><Bars points={report.trends.byOutcome} accent="var(--color-success)" /></div>
        </div>
        <div className="industrial-card p-5">
          <div className="flex items-center gap-2"><Lightbulb className="w-4 h-4 text-amber-300" /><h3 className="text-sm font-extrabold uppercase tracking-[0.14em] text-[var(--color-text-primary)]">Insights</h3></div>
          <div className="mt-3 space-y-2">
            {report.insights.length === 0 && <p className="font-mono text-xs text-gray-400">No insights for this window.</p>}
            {report.insights.map((i) => (
              <div key={i.id} className={`rounded-lg border px-3 py-2 ${SEVERITY[i.severity] ?? SEVERITY.info}`}>
                <div className="text-xs font-bold">{i.title}</div>
                <div className="mt-0.5 text-[11px] opacity-90">{i.detail}</div>
                <div className="mt-1 font-mono text-[10px] opacity-70">{i.systems.join(' · ')}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="grid gap-3 lg:grid-cols-2">
        <div className="industrial-card p-5">
          <div className="flex items-center gap-2"><Network className="w-4 h-4 text-accent" /><h3 className="text-sm font-extrabold uppercase tracking-[0.14em] text-[var(--color-text-primary)]">Cross-domain synergy</h3></div>
          {report.synergy.available ? (
            <div className="mt-3 space-y-3">
              <div className="flex flex-wrap gap-1.5">
                {report.synergy.domains.map((d) => (
                  <span key={d} className="rounded-full border border-border-muted bg-surface-overlay px-2.5 py-1 font-mono text-[11px] text-gray-300">{d}</span>
                ))}
                {report.synergy.domains.length === 0 && <span className="font-mono text-xs text-gray-400">no domains</span>}
              </div>
              <div className="font-mono text-[11px] text-gray-400">{report.synergy.edges.length} edges · {report.synergy.candidates.length} transfer candidates</div>
            </div>
          ) : (
            <p className="mt-3 font-mono text-xs text-gray-400">Recourse offline — synergy unavailable.</p>
          )}
        </div>
        <div className="industrial-card p-5">
          <div className="flex items-center gap-2"><Brain className="w-4 h-4 text-accent" /><h3 className="text-sm font-extrabold uppercase tracking-[0.14em] text-[var(--color-text-primary)]">Autonomy (operator-gated)</h3></div>
          <div className="mt-3 space-y-2">
            {report.autonomy.agenda.math && (
              <div className="rounded-lg border border-border-muted bg-surface-base/60 px-3 py-2">
                <div className="text-xs font-bold text-[var(--color-text-primary)]">Math: {report.autonomy.agenda.math.title}</div>
                {report.autonomy.agenda.math.rationale && <div className="text-[11px] text-gray-400">{report.autonomy.agenda.math.rationale}</div>}
              </div>
            )}
            {report.autonomy.agenda.oncology && (
              <div className="rounded-lg border border-border-muted bg-surface-base/60 px-3 py-2">
                <div className="text-xs font-bold text-[var(--color-text-primary)]">Oncology: {report.autonomy.agenda.oncology.title}</div>
                {report.autonomy.agenda.oncology.rationale && <div className="text-[11px] text-gray-400">{report.autonomy.agenda.oncology.rationale}</div>}
              </div>
            )}
            {!report.autonomy.agenda.math && !report.autonomy.agenda.oncology && <p className="font-mono text-xs text-gray-400">No agenda head.</p>}
            <div className="flex flex-wrap gap-2 pt-1">
              {report.autonomy.suggestedActions.map((a) => (
                <button
                  key={a.id}
                  onClick={() => dispatch(a.id, a.title)}
                  disabled={dispatching !== null}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-bold text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-40"
                >
                  <Zap className="w-3 h-3" /> {dispatching === a.id ? 'Dispatching…' : a.title}
                </button>
              ))}
            </div>
            {dispatchMsg && <div className="font-mono text-[11px] text-gray-400">{dispatchMsg}</div>}
          </div>
        </div>
      </section>

      {/* Self-development: OpenHub's own learner + Recourse self-hosting */}
      <section className="industrial-card p-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Brain className="w-4 h-4 text-emerald-400" />
            <h3 className="text-sm font-extrabold uppercase tracking-[0.14em] text-[var(--color-text-primary)]">Self-development</h3>
          </div>
          <button
            onClick={runForge}
            disabled={forging}
            className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-bold text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-40"
          >
            <Zap className="w-3 h-3" /> {forging ? 'Forging…' : 'Run Recourse forge'}
          </button>
        </div>
        <div className="mt-3 grid gap-4 lg:grid-cols-2">
          <div>
            <div className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-gray-400">
              Learned skill effectiveness
              {learning.calibration.sampleSize > 0 && (
                <span className="ml-2 normal-case tracking-normal text-gray-400">
                  · bar {Math.round(learning.calibration.passRateThreshold * 100)}% over {learning.calibration.sampleSize} outcomes
                </span>
              )}
            </div>
            <div className="mt-2 space-y-1.5">
              {learning.skills.length === 0 && <p className="font-mono text-xs text-gray-400">No outcomes recorded yet — run a supervised loop.</p>}
              {learning.skills.map((s) => (
                <div key={s.name} className="flex items-center gap-2">
                  <span className="w-40 shrink-0 truncate font-mono text-[11px] text-gray-300">{s.name}</span>
                  <div className="h-2 flex-1 rounded-full bg-surface-overlay">
                    <div className="h-2 rounded-full" style={{ width: `${Math.round(s.weight * 100)}%`, background: s.weight >= 0.6 ? 'var(--color-success)' : s.weight <= 0.35 ? 'var(--color-warning)' : 'var(--color-info)' }} />
                  </div>
                  <span className="w-16 shrink-0 text-right font-mono text-[10px] text-gray-400">{s.accepted}/{s.attempts}</span>
                </div>
              ))}
            </div>
          </div>
          <div>
            <div className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-gray-400">Lessons</div>
            <div className="mt-2 space-y-1.5">
              {learning.lessons.length === 0 && <p className="font-mono text-xs text-gray-400">No lessons yet.</p>}
              {learning.lessons.map((l) => (
                <div key={l.id} className={`rounded-lg border px-3 py-2 text-[11px] ${SEVERITY[l.severity] ?? SEVERITY.info}`}>{l.text}</div>
              ))}
            </div>
            {forgeMsg && <div className="mt-2 font-mono text-[11px] text-gray-400">{forgeMsg}</div>}
          </div>
        </div>
      </section>
    </div>
  );
}
