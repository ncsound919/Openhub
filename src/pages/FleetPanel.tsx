import { useState, useEffect, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  Bot,
  Boxes,
  BookOpen,
  DollarSign,
  Goal,
  Loader2,
  ScrollText,
  Server,
} from 'lucide-react';
import type { KpiSnapshot } from '../routes/fleetKpis';
import { GitHubRepoExplorer } from '../components/GitHubRepoExplorer';
import { CapabilityGrid } from '../components/CapabilityGrid';
import { ServicesLifecycleView } from './ServicesLifecycleView';
import { EcosystemView } from './EcosystemView';
import { cn } from '../lib/utils';

/** Strategy target from the fleet strategy layer: $33k/month recurring revenue. */
const MONTHLY_REVENUE_TARGET_USD = 33_000;

interface AgentRecord {
  id?: unknown;
  name?: unknown;
  kind?: unknown;
  type?: unknown;
  status?: unknown;
}

const KIND_FIELD_CANDIDATES = ['kind', 'type'] as const;

function isAgentRecord(value: unknown): value is AgentRecord {
  return value !== null && typeof value === 'object';
}

/**
 * Best-effort normalization of the agents catalog payload (parallel workstream).
 * Handles a bare array, `{ agents: [...] }`, or `{ agents: { id: {...} } }`;
 * anything else yields an empty list rather than a guessed value.
 */
function asAgentRecords(data: unknown): AgentRecord[] {
  if (Array.isArray(data)) return data.filter(isAgentRecord);
  if (data !== null && typeof data === 'object') {
    const wrapped = (data as Record<string, unknown>).agents;
    if (Array.isArray(wrapped)) return wrapped.filter(isAgentRecord);
    if (wrapped !== null && typeof wrapped === 'object') {
      return Object.values(wrapped).filter(isAgentRecord);
    }
  }
  return [];
}

function kindOf(agent: AgentRecord): string {
  for (const key of KIND_FIELD_CANDIDATES) {
    const value = agent[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return 'unknown';
}

function formatUSD(usd: number | null): string {
  return usd === null
    ? '—'
    : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(usd);
}

function formatCount(count: number | null): string {
  return count === null ? '—' : String(count);
}

function statusClasses(status: string | null): string {
  switch (status) {
    case 'completed':
    case 'achieved':
      return 'bg-green-500/10 text-green-500 border-green-500/20';
    case 'active':
    case 'in_progress':
      return 'bg-orange-500/10 text-orange-500 border-orange-500/20';
    default:
      return 'bg-blue-500/10 text-blue-500 border-blue-500/20';
  }
}

export function FleetPanel() {
  const [searchParams] = useSearchParams();
  const rawTab = searchParams.get('tab') ?? 'capabilities';
  const tab = ['capabilities', 'overview', 'services', 'ecosystem'].includes(rawTab) ? rawTab : 'capabilities';
  const [kpis, setKpis] = useState<KpiSnapshot | null>(null);
  const [kpisError, setKpisError] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch('/api/ecosystem/kpis', { credentials: 'include' });
        if (!res.ok) {
          if (!cancelled) setKpisError(`KPIs endpoint replied ${res.status} ${res.statusText}`.trim());
        } else if (!cancelled) {
          setKpis((await res.json()) as KpiSnapshot);
        }
      } catch {
        if (!cancelled) setKpisError('KPIs endpoint unreachable');
      }

      try {
        const res = await fetch('/api/ecosystem/agents', { credentials: 'include' });
        if (!res.ok) {
          if (!cancelled) {
            setAgentsError(
              `Agents catalog endpoint replied ${res.status} ${res.statusText}`.trim() +
                ' (catalog workstream may not be mounted yet)',
            );
          }
        } else if (!cancelled) {
          setAgents(asAgentRecords(await res.json()));
        }
      } catch {
        if (!cancelled) setAgentsError('Agents catalog endpoint unreachable');
      }

      if (!cancelled) setLoading(false);
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const treasury = kpis?.treasury ?? null;
  // The API may omit these arrays (or return a non-array); normalize so the
  // render never reads `.length`/`.slice` off undefined.
  const heartbeats = kpis && Array.isArray(kpis.heartbeats) ? kpis.heartbeats : [];
  const recaps = kpis && Array.isArray(kpis.recaps) ? kpis.recaps : [];
  const goals = kpis && Array.isArray(kpis.goals) ? kpis.goals : [];
  const heartbeatsCount = kpis ? heartbeats.length : null;
  const recapsCount = kpis ? recaps.length : null;

  const kindTotals = useMemo(() => {
    const counts = new Map<string, number>();
    for (const agent of agents) {
      const kind = kindOf(agent);
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [agents]);

  const revenuePct = treasury?.revenueUSD != null
    ? Math.min(100, Math.round((treasury.revenueUSD / MONTHLY_REVENUE_TARGET_USD) * 100))
    : 0;
  const live = kpis?.source === 'live';

  const stats = [
    { label: 'Monthly revenue', value: treasury ? formatUSD(treasury.revenueUSD) : '—', sub: `target ${formatUSD(MONTHLY_REVENUE_TARGET_USD)}/mo`, accent: 'var(--color-success)', accent2: 'var(--color-success)', pct: revenuePct },
    { label: 'Heartbeats', value: formatCount(heartbeatsCount), sub: 'engine pulses tracked', accent: 'var(--color-info)', accent2: 'var(--color-accent)', pct: heartbeatsCount ? Math.min(100, heartbeatsCount * 10) : 0 },
    { label: 'Recaps', value: formatCount(recapsCount), sub: 'summaries in brain', accent: 'var(--color-info)', accent2: 'var(--color-success)', pct: recapsCount ? Math.min(100, recapsCount * 10) : 0 },
    { label: 'Agents', value: agents.length > 0 ? String(agents.length) : '—', sub: kpis ? `${goals.length} goals in brain` : 'catalog pending', accent: 'var(--color-warning)', accent2: 'var(--color-warning)', pct: agents.length ? Math.min(100, agents.length * 8) : 0 },
  ];

  return (
    <div className="flex-1 w-full max-w-6xl mx-auto flex flex-col gap-5 px-4 py-6">
      {/* Hero */}
      <section className="gradient-hero rounded-2xl p-6 relative overflow-hidden">
        <div className="absolute -right-8 -top-12 opacity-[0.12] pointer-events-none">
          <Activity className="w-56 h-56 text-blue-300" strokeWidth={1} />
        </div>
        <div className="flex items-center gap-2 text-[11px] font-extrabold uppercase tracking-[0.18em] text-gray-400">
          <span className={`w-1.5 h-1.5 rounded-full animate-pulse ${live ? 'bg-emerald-400' : 'bg-orange-400'}`} />
          Fleet · Mission Control · {kpis?.source ?? 'unknown'}
        </div>
        <h2 className="mt-2">Fleet telemetry <span className="text-info">at a glance.</span></h2>
        <p className="mt-1.5 max-w-xl text-sm text-gray-400 truncate">
          Engine KPIs, revenue pulse, and agent catalog{kpis?.dir ? ` — ${kpis.dir}` : ''}.
        </p>
        {kpis?.error ? <p className="mt-1 font-mono text-[11px] text-amber-400 truncate">{kpis.error}</p> : null}
      </section>

      {/* Hub tabs: capabilities (front door), overview, services, ecosystem */}
      <nav className="flex gap-0.5 overflow-x-auto border-b border-surface-overlay -mb-2" aria-label="Fleet hub">
        {[
          { id: 'capabilities', label: 'Capability Grid', icon: Server },
          { id: 'overview', label: 'Overview', icon: Activity },
          { id: 'services', label: 'Services', icon: Boxes },
          { id: 'ecosystem', label: 'Ecosystem', icon: BookOpen },
        ].map((t) => (
          <Link
            key={t.id}
            to={t.id === 'capabilities' ? '/fleet' : `/fleet?tab=${t.id}`}
            className={cn('repo-tab', tab === t.id && 'active')}
          >
            <t.icon className="w-3.5 h-3.5" />
            {t.label}
          </Link>
        ))}
      </nav>

      {tab === 'capabilities' ? (
        <CapabilityGrid />
      ) : tab === 'overview' ? (
      <>

      {/* Stats */}
      <section className="grid grid-cols-2 xl:grid-cols-4 gap-3" aria-label="Fleet status">
        {stats.map((s) => (
          <div key={s.label} className="industrial-card stat-tile p-4" style={{ ['--accent' as string]: s.accent, ['--accent2' as string]: s.accent2 }}>
            <div className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-gray-400">{s.label}</div>
            <div className="mt-1 truncate text-2xl font-extrabold text-[var(--color-text-primary)] tracking-tight">{s.value}</div>
            <div className="mt-0.5 truncate text-[11px] text-gray-400">{s.sub}</div>
            <div className="meter mt-2.5"><span style={{ width: `${s.pct}%` }} /></div>
          </div>
        ))}
      </section>

      {loading ? (
        <div className="industrial-card p-4 flex items-center gap-3 text-gray-400">
          <Loader2 className="w-4 h-4 animate-spin text-blue-400" />
          <span className="font-mono text-[11px] uppercase tracking-widest">Loading fleet telemetry…</span>
        </div>
      ) : null}

      {kpisError || agentsError ? (
        <div className="industrial-card p-4 flex items-start gap-3 border-amber-500/40">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <div className="font-mono text-[11px] text-amber-300/90 leading-relaxed">
            {kpisError ? <p>KPIs: {kpisError}</p> : null}
            {agentsError ? <p>Agents: {agentsError}</p> : null}
          </div>
        </div>
      ) : null}

      {kpis?.source === 'degraded' ? (
        <div className="industrial-card p-4 flex items-start gap-3 border-orange-500/40">
          <AlertTriangle className="w-4 h-4 text-orange-400 shrink-0 mt-0.5" />
          <p className="font-mono text-[11px] text-orange-300/90 leading-relaxed">
            Degraded: no .draymond directory resolved. Showing explicit nulls — no inferred values.
          </p>
        </div>
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {/* Revenue + catalog */}
        <div className="space-y-3">
          <div className="industrial-card p-4">
            <div className="flex items-center justify-between">
              <h2 className="!text-base flex items-center gap-2"><DollarSign className="w-4 h-4 text-emerald-300" /> Revenue</h2>
              <span className="count-pill">{revenuePct}% of target</span>
            </div>
            <div className="mt-2 truncate text-2xl font-extrabold text-[var(--color-text-primary)]">
              {treasury ? formatUSD(treasury.revenueUSD) : '—'}
            </div>
            <div className="meter mt-2.5" style={{ ['--accent' as string]: 'var(--color-success)', ['--accent2' as string]: 'var(--color-info)' }}>
              <span style={{ width: `${revenuePct}%` }} />
            </div>
            <div className="mt-3 space-y-1 border-t border-surface-overlay pt-3 font-mono text-[11px] text-gray-400">
              <div className="flex justify-between gap-2"><span>Cents</span><span className="text-gray-400 truncate">{treasury?.revenueCents ?? '—'}</span></div>
              <div className="flex justify-between gap-2"><span>Last pulse</span><span className="text-gray-400 truncate">{treasury?.lastPulseAt ?? '—'}</span></div>
            </div>
          </div>

          <div className="industrial-card p-4">
            <div className="flex items-center justify-between">
              <h2 className="!text-base flex items-center gap-2"><Bot className="w-4 h-4 text-blue-300" /> Agents</h2>
              <span className="count-pill">{agents.length > 0 ? `${agents.length} total` : 'no data'}</span>
            </div>
            {agentsError ? (
              <p className="mt-2 font-mono text-[11px] text-amber-400 leading-relaxed">{agentsError}</p>
            ) : agents.length === 0 ? (
              <p className="mt-2 font-mono text-[11px] text-gray-400">{loading ? 'Loading…' : 'No agent catalog data.'}</p>
            ) : (
              <div className="mt-3 space-y-1.5">
                {kindTotals.slice(0, 6).map(([kind, count]) => (
                  <div key={kind} className="flex items-center justify-between text-xs">
                    <span className="truncate text-[11px] font-bold uppercase tracking-wider text-gray-400">{kind}</span>
                    <span className="count-pill">{count}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Goals + telemetry */}
        <div className="lg:col-span-2 space-y-3">
          <div className="industrial-card p-4">
            <div className="flex items-center justify-between">
              <h2 className="!text-base flex items-center gap-2"><Goal className="w-4 h-4 text-orange-300" /> Strategy goals</h2>
              <span className="count-pill">{kpis ? `${goals.length} in brain` : '—'}</span>
            </div>
            {kpis === null ? (
              <p className="mt-2 font-mono text-[11px] text-gray-400">{loading ? 'Loading fleet brain…' : 'No KPIs endpoint data.'}</p>
            ) : goals.length === 0 ? (
              <p className="mt-2 font-mono text-[11px] text-gray-400">No system goals in fleet brain.</p>
            ) : (
              <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-2">
                {goals.slice(0, 6).map((goal) => (
                  <div
                    key={goal.id || goal.title || `goal-${goal.domain ?? 'unknown'}`}
                    className="rounded-lg border border-surface-overlay bg-surface-base/60 p-3 min-w-0"
                  >
                    <div className="truncate text-sm font-bold text-[var(--color-text-primary)]">{goal.title ?? 'Untitled goal'}</div>
                    <div className="mt-0.5 truncate font-mono text-[10px] uppercase tracking-wider text-gray-400">
                      {goal.domain ?? 'no domain'} · w {goal.weight ?? '—'}
                    </div>
                    <span className={`mt-2 inline-block rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${statusClasses(goal.status)}`}>
                      {goal.status ?? 'unknown'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="industrial-card p-4">
            <div className="flex items-center gap-2">
              <ScrollText className="w-4 h-4 text-blue-300" />
              <h2 className="!text-base">Telemetry feed</h2>
            </div>
            <div className="mt-2 space-y-1 font-mono text-[11px] text-gray-400">
              <div className="truncate"><span className="text-emerald-400">treasury</span> pulse: {treasury?.lastPulseAt ?? '—'}</div>
              <div className="truncate"><span className="text-blue-300">kpis</span> goals {kpis ? goals.length : '—'} · heartbeats {formatCount(heartbeatsCount)} · recaps {formatCount(recapsCount)}</div>
              <div className="truncate"><span className="text-gray-400">agents</span> {agents.length > 0 ? agents.length : '—'} entries · {kpis?.dir ?? 'unresolved .draymond'}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Fleet GitHub repos: live, filterable listing across both accounts */}
      <GitHubRepoExplorer />
      </>
      ) : tab === 'services' ? (
        <ServicesLifecycleView />
      ) : (
        <EcosystemView />
      )}
    </div>
  );
}
