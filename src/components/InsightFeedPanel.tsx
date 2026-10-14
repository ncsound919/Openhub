import { useCallback, useEffect, useState } from 'react';
import { Lightbulb, RefreshCw, Compass, TrendingUp, Eye, AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import { getAuthHeaders } from '../auth/AuthProvider';
import { StatusLight, type LightState } from './StatusLight';
import { cn } from '../lib/utils';

type FeedKind = 'discovery' | 'trend' | 'tip' | 'review' | 'alert';
type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

interface FeedItem {
  id: string;
  kind: FeedKind;
  severity: Severity;
  title: string;
  detail: string;
  systems: string[];
  evidence?: Record<string, unknown>;
  at?: string;
}
interface InsightFeed {
  generatedAt: string;
  items: FeedItem[];
  counts: Record<FeedKind, number>;
  sources: { telemetry: boolean; recourse: boolean; audit: boolean; incidents: boolean; pipeline: boolean };
}

const KIND_META: Record<FeedKind, { label: string; icon: typeof Lightbulb; tone: string }> = {
  alert: { label: 'Alert', icon: AlertTriangle, tone: 'text-[var(--color-danger)]' },
  review: { label: 'Review', icon: Eye, tone: 'text-[var(--color-warning)]' },
  discovery: { label: 'Discovery', icon: Compass, tone: 'text-[var(--color-accent-text)]' },
  trend: { label: 'Trend', icon: TrendingUp, tone: 'text-[var(--color-info)]' },
  tip: { label: 'Tip', icon: Lightbulb, tone: 'text-[var(--color-success)]' },
};

const SEV_LIGHT: Record<Severity, LightState> = {
  critical: 'error',
  high: 'error',
  medium: 'warn',
  low: 'idle',
  info: 'ok',
};

/**
 * InsightFeedPanel — discoveries, trends, tips, reviews and alerts composed from
 * Recourse, self-learning, audit deltas, incidents and pipeline history. This is
 * the "what is the system telling me" surface, not a wall of raw stats.
 */
export function InsightFeedPanel() {
  const [feed, setFeed] = useState<InsightFeed | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FeedKind | 'all'>('all');
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/insights/feed', { credentials: 'include', headers: getAuthHeaders() });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.feed) {
        setError(json?.error || `Could not load insights (HTTP ${res.status})`);
        return;
      }
      setFeed(json.feed as InsightFeed);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load insights');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const items = feed ? (filter === 'all' ? feed.items : feed.items.filter((i) => i.kind === filter)) : [];
  const offline = feed
    ? (Object.entries(feed.sources).filter(([, v]) => !v).map(([k]) => k))
    : [];

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-industrial tracking-tight text-[var(--color-text-primary)]">Discoveries &amp; insights</h3>
        {feed && (
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              onClick={() => setFilter('all')}
              className={cn('rounded-full px-2.5 py-0.5 text-[11px] font-bold', filter === 'all' ? 'bg-[var(--color-accent)] text-white' : 'border border-border-muted text-gray-400 hover:text-[var(--color-text-primary)]')}
            >
              All {feed.items.length}
            </button>
            {(Object.keys(KIND_META) as FeedKind[]).map((k) => {
              const meta = KIND_META[k];
              const Icon = meta.icon;
              const count = feed.counts[k] ?? 0;
              if (count === 0) return null;
              return (
                <button
                  key={k}
                  onClick={() => setFilter(k)}
                  className={cn('inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-bold', filter === k ? 'bg-[var(--color-accent)] text-white' : 'border border-border-muted text-gray-400 hover:text-[var(--color-text-primary)]')}
                >
                  <Icon className="w-3 h-3" /> {meta.label} {count}
                </button>
              );
            })}
          </div>
        )}
        <button
          onClick={() => void load()}
          disabled={loading}
          className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-border-muted bg-surface-base/70 px-2.5 py-1 text-[11px] font-bold text-gray-400 hover:text-[var(--color-text-primary)] disabled:opacity-50"
        >
          <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} /> Refresh
        </button>
      </div>

      {error && <StatusLight state="error" label={error} className="max-w-[44rem]" title={error} />}

      {offline.length > 0 && (
        <p className="text-[11px] text-[var(--color-text-muted)]">
          Some sources are offline ({offline.join(', ')}); items from the rest are still shown. Nothing is fabricated.
        </p>
      )}

      {loading && !feed && <p className="text-xs text-[var(--color-text-muted)]">Reading system state…</p>}

      {feed && items.length === 0 && (
        <p className="text-xs text-[var(--color-text-muted)]">
          {filter === 'all' ? 'Nothing to report yet — run an Autopilot pass and the discoveries will show up here.' : `No ${filter} items.`}
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {items.map((it) => {
          const meta = KIND_META[it.kind];
          const Icon = meta.icon;
          const expanded = open[it.id] === true;
          return (
            <li key={it.id} className="industrial-card p-4">
              <button
                type="button"
                onClick={() => setOpen((o) => ({ ...o, [it.id]: !expanded }))}
                className="flex w-full items-start gap-3 text-left"
                aria-expanded={expanded}
              >
                <Icon className={cn('mt-0.5 w-4 h-4 shrink-0', meta.tone)} />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className={cn('text-[10px] font-black uppercase tracking-widest', meta.tone)}>{meta.label}</span>
                    <StatusLight state={SEV_LIGHT[it.severity]} label={it.severity} dotOnly title={`severity: ${it.severity}`} />
                    <span className="truncate text-sm font-semibold text-[var(--color-text-primary)]">{it.title}</span>
                  </span>
                  <span className="mt-1 block text-xs leading-relaxed text-gray-400">{it.detail}</span>
                </span>
                {it.evidence && (expanded ? <ChevronDown className="mt-0.5 w-4 h-4 shrink-0 text-gray-500" /> : <ChevronRight className="mt-0.5 w-4 h-4 shrink-0 text-gray-500" />)}
              </button>
              <div className="mt-1.5 flex flex-wrap items-center gap-2 pl-7">
                {it.systems.map((s) => (
                  <span key={s} className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] font-mono text-gray-400">{s}</span>
                ))}
                {it.at && <span className="text-[10px] font-mono text-gray-500">{new Date(it.at).toLocaleString()}</span>}
              </div>
              {expanded && it.evidence && (
                <pre className="mt-2 ml-7 max-h-52 overflow-auto rounded border border-border-muted bg-black/30 p-2 font-mono text-[10px] text-gray-400 whitespace-pre-wrap">
                  {JSON.stringify(it.evidence, null, 2)}
                </pre>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
