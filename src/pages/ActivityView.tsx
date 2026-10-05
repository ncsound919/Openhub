import React from 'react';
import { Link } from 'react-router-dom';
import {
  Activity, AlertTriangle, CheckCircle2, CircleDot, Clock, Hammer,
  RefreshCw, ShieldCheck, Sparkles, Zap,
} from 'lucide-react';
import { getAuthHeaders } from '../auth/AuthProvider';
import { cn } from '../lib/utils';

type Severity = 'low' | 'medium' | 'high' | 'critical';

type FeedEvent = {
  id: string;
  ts: string | null;
  source: 'incident' | 'repair' | 'loop' | 'project';
  title: string;
  detail?: string;
  tone: 'danger' | 'warning' | 'success' | 'neutral' | 'accent';
};

const SEVERITY_TONE: Record<Severity, FeedEvent['tone']> = {
  critical: 'danger',
  high: 'danger',
  medium: 'warning',
  low: 'neutral',
};

const TONE_DOT: Record<FeedEvent['tone'], string> = {
  danger: 'bg-[var(--color-danger)]',
  warning: 'bg-[var(--color-warning)]',
  success: 'bg-[var(--color-success)]',
  neutral: 'bg-[var(--color-text-muted)]',
  accent: 'bg-[var(--color-accent)]',
};

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'incident', label: 'Incidents' },
  { id: 'repair', label: 'Repair' },
  { id: 'loop', label: 'Loops' },
  { id: 'project', label: 'Projects' },
] as const;

type FilterId = (typeof FILTERS)[number]['id'];

const SOURCE_ICON: Record<FeedEvent['source'], React.ReactNode> = {
  incident: <AlertTriangle className="w-3.5 h-3.5" />,
  repair: <Hammer className="w-3.5 h-3.5" />,
  loop: <Zap className="w-3.5 h-3.5" />,
  project: <CircleDot className="w-3.5 h-3.5" />,
};

export function ActivityView() {
  const [filter, setFilter] = React.useState<FilterId>('all');
  const [events, setEvents] = React.useState<FeedEvent[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshTick, setRefreshTick] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const out: FeedEvent[] = [];

      const get = async (url: string) => {
        try {
          const res = await fetch(url, { credentials: 'include', headers: getAuthHeaders() });
          if (!res.ok) return null;
          return await res.json();
        } catch {
          return null;
        }
      };

      const [inc, repair, dream, missions] = await Promise.all([
        get('/api/incidents'),
        get('/api/repair/logs'),
        get('/api/dream'),
        get('/api/axiom/mission/list'),
      ]);

      if (inc?.incidents) {
        for (const i of inc.incidents as any[]) {
          out.push({
            id: `inc:${i.id}`,
            ts: i.createdAt ?? null,
            source: 'incident',
            title: i.kind ?? 'Incident',
            detail: i.detail || undefined,
            tone: SEVERITY_TONE[i.severity as Severity] ?? 'neutral',
          });
        }
      }

      const repairEntries = [...(repair?.repairLog ?? []), ...(repair?.teamLog ?? [])] as any[];
      for (const r of repairEntries) {
        out.push({
          id: `rep:${Math.random().toString(36).slice(2)}`,
          ts: r.timestamp ?? null,
          source: 'repair',
          title: r.signal ?? r.action ?? 'Repair event',
          detail: r.detail || undefined,
          tone: r.status === 'success' || r.status === 'ok' ? 'success' : 'warning',
        });
      }

      if (dream?.entries) {
        for (const d of (dream.entries as any[]).filter((e) => e.lastAnalyzedAt)) {
          out.push({
            id: `proj:${d.repoId}`,
            ts: d.lastAnalyzedAt ?? null,
            source: 'project',
            title: `${d.name} â€” ${d.status ?? 'unanalyzed'}`,
            detail: d.summary || undefined,
            tone: d.status === 'critical' ? 'danger' : d.status === 'attention' ? 'warning' : d.status === 'healthy' ? 'success' : 'neutral',
          });
        }
      }

      const rawMissions = (missions?.data ?? missions?.missions ?? []) as any;
      const missionList: any[] = Array.isArray(rawMissions)
        ? rawMissions
        : Array.isArray(rawMissions?.missions)
          ? rawMissions.missions
          : [];
      for (const m of missionList) {
        const goal = m.goal ?? m.summary ?? m.signal ?? 'Loop';
        out.push({
          id: `loop:${m.id ?? Math.random().toString(36).slice(2)}`,
          ts: m.updatedAt ?? m.createdAt ?? null,
          source: 'loop',
          title: goal,
          detail: m.status ?? undefined,
          tone: m.status === 'done' || m.status === 'ok' ? 'success' : m.status === 'awaiting-approval' ? 'warning' : 'accent',
        });
      }

      out.sort((a, b) => (b.ts ?? '').localeCompare(a.ts ?? ''));
      if (!cancelled) setEvents(out.slice(0, 120));
      setLoading(false);
      // Mark everything seen so the nav badge clears.
      localStorage.setItem('openhub.activity.lastSeen', new Date().toISOString());
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshTick]);

  const visible = filter === 'all' ? events : events.filter((e) => e.source === filter);

  const counts = React.useMemo(() => {
    const c: Record<FilterId, number> = { all: events.length, incident: 0, repair: 0, loop: 0, project: 0 };
    for (const e of events) c[e.source]++;
    return c;
  }, [events]);

  const fmt = (ts: string | null) => {
    if (!ts) return 'â€”';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return 'â€”';
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="flex-1 w-full max-w-5xl mx-auto flex flex-col gap-5 px-4 py-6">
      {/* Header */}
      <section className="gradient-hero rounded-xl p-6 relative overflow-hidden">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-accent-text)]">
          <Activity className="w-3.5 h-3.5" /> Activity
        </div>
        <h1 className="mt-1.5 text-xl font-bold tracking-tight">What happened across your workspace</h1>
        <p className="mt-1 max-w-xl text-[13px] text-[var(--color-text-muted)]">
          A unified stream of incidents, repairs, autonomous loops, and project health. Every agent action is logged here.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            onClick={() => setRefreshTick((t) => t + 1)}
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-raised)] px-2.5 py-1.5 text-xs font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
          <Link to="/assurance" className="inline-flex items-center gap-1.5 rounded-md border border-[color-mix(in_srgb,var(--color-accent)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)] px-2.5 py-1.5 text-xs font-medium text-[var(--color-accent-text)]">
            <ShieldCheck className="w-3.5 h-3.5" /> Assurance
          </Link>
          <Link to="/axiom" className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-raised)] px-2.5 py-1.5 text-xs font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]">
            <Zap className="w-3.5 h-3.5" /> Loops
          </Link>
        </div>
      </section>

      {/* Digest */}
      {!loading && events.length > 0 && (
        <section className="grid grid-cols-2 sm:grid-cols-4 gap-2" aria-label="Activity digest">
          <div className="rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-raised)] p-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--color-text-muted)]">Incidents</div>
            <div className="mt-0.5 flex items-center gap-1.5">
              <span className="text-lg font-bold text-[var(--color-text-primary)]">{counts.incident}</span>
              <span className="text-[10px] text-[var(--color-text-secondary)]">{events.filter((e) => e.source === 'incident' && e.tone === 'danger').length} critical/high</span>
            </div>
          </div>
          <div className="rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-raised)] p-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--color-text-muted)]">Repairs</div>
            <div className="mt-0.5 text-lg font-bold text-[var(--color-text-primary)]">{counts.repair}</div>
          </div>
          <div className="rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-raised)] p-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--color-text-muted)]">Loops</div>
            <div className="mt-0.5 flex items-center gap-1.5">
              <span className="text-lg font-bold text-[var(--color-text-primary)]">{counts.loop}</span>
              <span className="text-[10px] text-[var(--color-warning)]">{events.filter((e) => e.source === 'loop' && e.tone === 'warning').length} awaiting approval</span>
            </div>
          </div>
          <div className="rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-raised)] p-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--color-text-muted)]">Project health</div>
            <div className="mt-0.5 flex items-center gap-1.5">
              <span className="text-lg font-bold text-[var(--color-text-primary)]">{counts.project}</span>
              <span className="text-[10px] text-[var(--color-warning)]">{events.filter((e) => e.source === 'project' && (e.tone === 'warning' || e.tone === 'danger')).length} need attention</span>
            </div>
          </div>
        </section>
      )}

      {/* Filters */}
      <div className="flex items-center gap-1 border-b border-[var(--color-border-muted)] pb-0 -mb-1 overflow-x-auto">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={cn(
              'repo-tab',
              filter === f.id && 'active',
            )}
          >
            {f.label}
            <span className="count-pill">{counts[f.id]}</span>
          </button>
        ))}
      </div>

      {/* Feed */}
      <section className="flex flex-col gap-2">
        {loading ? (
          <div className="rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-raised)] px-4 py-10 text-center text-sm text-[var(--color-text-muted)]">
            Reading workspace stateâ€¦
          </div>
        ) : visible.length === 0 ? (
          <div className="rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-raised)] px-4 py-12 text-center">
            <Sparkles className="mx-auto w-5 h-5 text-[var(--color-text-muted)]" />
            <p className="mt-2 text-sm font-medium text-[var(--color-text-secondary)]">All quiet.</p>
            <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
              No {filter === 'all' ? '' : `${filter} `}activity yet. Start a loop or load a project to see events land here.
            </p>
          </div>
        ) : (
          visible.map((e) => (
            <div
              key={e.id}
              className="flex items-start gap-3 rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-raised)] px-3.5 py-3"
            >
              <span className={cn('mt-1.5 w-2 h-2 rounded-full shrink-0', TONE_DOT[e.tone])} />
              <span className="mt-0.5 shrink-0 text-[var(--color-text-muted)]">{SOURCE_ICON[e.source]}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-medium text-[var(--color-text-primary)]">{e.title}</span>
                  <span className="shrink-0 rounded-full border border-[var(--color-border-muted)] bg-[var(--color-surface-overlay)] px-1.5 py-px text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
                    {e.source}
                  </span>
                </div>
                {e.detail && (
                  <p className="mt-0.5 truncate text-xs text-[var(--color-text-muted)]" title={e.detail}>{e.detail}</p>
                )}
              </div>
              <span className="shrink-0 inline-flex items-center gap-1 font-mono text-[11px] text-[var(--color-text-muted)]">
                <Clock className="w-3 h-3" /> {fmt(e.ts)}
              </span>
            </div>
          ))
        )}
      </section>

      <p className="flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]">
        <CheckCircle2 className="w-3.5 h-3.5" />
        Every action is logged and verifiable. This is the human audit trail of your autonomous fleet.
      </p>
    </div>
  );
}