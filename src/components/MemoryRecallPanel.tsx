import React, { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Database,
  Loader2,
  Search,
  XCircle,
} from 'lucide-react';
import { getAuthHeaders, getCsrfToken } from '../auth/AuthProvider';
import { cn } from '../lib/utils';

/**
 * Memory recall panel — one question, two memory bridges.
 *
 * `Sieve` is the fan-out read surface (code index + local snippets + Recourse),
 * `Recourse` is the durable fleet memory on the phone's own deployment. Both
 * are reached through the server's /api/memory/recall proxy, which reports an
 * offline source with its reason instead of pretending it returned nothing.
 */

type SourceKey = 'sieve' | 'recourse';
type Scope = 'both' | SourceKey;

interface RecallHit {
  id: string;
  text: string;
  score?: number | null;
  path?: string | null;
  line?: number | null;
  kind?: string | null;
  source?: string | null;
  layers?: string[];
}

interface SourceResult {
  source: SourceKey;
  available: boolean;
  endpoint: string;
  latencyMs: number;
  status?: number;
  hits: RecallHit[];
  layers?: Record<string, { available: boolean; count: number; reason?: string; mode?: string }>;
  reason?: string;
}

interface RecallResponse {
  ok: boolean;
  query: string;
  k: number;
  gateway: string | null;
  error?: string;
  results: Partial<Record<SourceKey, SourceResult>>;
}

const SOURCE_ORDER: SourceKey[] = ['sieve', 'recourse'];

const SOURCE_META: Record<SourceKey, { name: string; blurb: string }> = {
  sieve: { name: 'Sieve', blurb: 'code index · local snippets · fleet memory' },
  recourse: { name: 'Recourse', blurb: 'durable vector memory on the phone' },
};

const SCOPES: { id: Scope; label: string }[] = [
  { id: 'both', label: 'Both' },
  { id: 'sieve', label: 'Sieve' },
  { id: 'recourse', label: 'Recourse' },
];

const K_OPTIONS = [4, 8, 16];

function gatewayLabel(gateway: string | null): string | null {
  if (!gateway) return null;
  try {
    return new URL(gateway).host;
  } catch {
    return gateway;
  }
}

export function MemoryRecallPanel() {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<Scope>('both');
  const [k, setK] = useState(8);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<RecallResponse | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  async function runRecall(event?: React.FormEvent) {
    event?.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) {
      setError('Type a question first — recall needs a query.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/memory/recall', {
        method: 'POST',
        credentials: 'include',
        headers: getAuthHeaders({ 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() }),
        body: JSON.stringify({ query: trimmed, source: scope, k }),
      });
      const payload = (await res.json().catch(() => ({}))) as Partial<RecallResponse>;
      if (!payload.results) {
        setData(null);
        setError(payload.error || `Recall failed (HTTP ${res.status})`);
        return;
      }
      setData(payload as RecallResponse);
      setError(
        payload.ok === false
          ? payload.error || 'Every requested memory bridge is offline — see the reasons below.'
          : null,
      );
    } catch (err) {
      setData(null);
      setError(err instanceof Error ? err.message : 'Recall request failed');
    } finally {
      setLoading(false);
    }
  }

  const entries = data
    ? SOURCE_ORDER.filter((source) => data.results[source]).map(
        (source) => [source, data.results[source] as SourceResult] as const,
      )
    : [];
  const totalHits = entries.reduce((sum, [, result]) => sum + result.hits.length, 0);

  return (
    <div className="space-y-4" data-testid="memory-recall-panel">
      {/* Header */}
      <div className="bg-surface-raised border border-border-muted rounded-xl p-5 shadow-sm">
        <div className="flex items-center gap-2">
          <Database className="w-5 h-5 text-blue-400" />
          <h3 className="text-base font-bold text-gray-100">Memory recall</h3>
          <span className="text-[10px] bg-blue-500/10 text-blue-400 border border-blue-500/20 px-2 py-0.5 rounded font-mono font-bold">
            Sieve · Recourse
          </span>
        </div>
        <p className="text-xs text-gray-400 mt-1">
          One query, fanned out through the mobile gateway. Each source reports its own state, so an
          offline bridge reads as offline — never as an empty answer.
        </p>

        <form onSubmit={runRecall} className="mt-4 space-y-3">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Recall query"
              placeholder="e.g. how does the agent request shell approval?"
              className="w-full pl-8 pr-3 py-2 bg-surface-base border border-border-muted rounded-lg text-xs font-mono text-gray-200 placeholder:text-gray-500 focus:outline-none focus:border-blue-500/50"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {SCOPES.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => setScope(option.id)}
                aria-pressed={scope === option.id}
                className={cn(
                  'px-2.5 py-1 rounded-lg text-[11px] font-semibold uppercase tracking-wider transition-colors',
                  scope === option.id
                    ? 'bg-blue-500 text-white shadow-sm'
                    : 'bg-surface-raised text-gray-400 hover:text-gray-200 border border-border-muted',
                )}
              >
                {option.label}
              </button>
            ))}

            <label className="ml-auto flex items-center gap-2 text-[11px] text-gray-400 font-mono">
              hits/source
              <select
                value={k}
                onChange={(e) => setK(Number(e.target.value))}
                aria-label="Hits per source"
                className="bg-surface-raised border border-border-muted rounded-lg px-2 py-1 text-[11px] font-mono text-gray-200 focus:outline-none"
              >
                {K_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="submit"
              disabled={loading}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-white transition-colors shadow-sm"
            >
              <Loader2 className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
              {loading ? 'Recalling…' : 'Recall'}
            </button>
          </div>
        </form>

        {data?.gateway ? (
          <p className="mt-3 font-mono text-[10px] text-gray-500">
            via {gatewayLabel(data.gateway)} · {totalHits} hit{totalHits === 1 ? '' : 's'}
            {data.query ? ` for “${data.query.slice(0, 60)}”` : ''}
          </p>
        ) : null}
      </div>

      {error ? (
        <div className="bg-surface-raised border border-amber-500/40 rounded-xl p-4 flex items-start gap-3">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <p className="font-mono text-[11px] text-amber-300/90 leading-relaxed">{error}</p>
        </div>
      ) : null}

      {!data ? (
        <div className="bg-surface-base border border-border-muted rounded-xl p-8 text-center">
          <Database className="w-6 h-6 text-gray-500 mx-auto" />
          <p className="mt-2 font-mono text-[11px] text-gray-400">
            No recall yet. Ask a question to read Sieve and Recourse.
          </p>
        </div>
      ) : entries.length === 0 ? (
        <div className="bg-surface-base border border-border-muted rounded-xl p-6 text-center">
          <p className="font-mono text-[11px] text-gray-400">No source answered this request.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {entries.map(([source, result]) => (
            <div
              key={source}
              className="bg-surface-raised border border-border-muted rounded-xl p-4 shadow-sm"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h4 className="text-sm font-bold text-gray-100 truncate">
                      {SOURCE_META[source].name}
                    </h4>
                    <span
                      className={cn(
                        'inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold uppercase',
                        result.available
                          ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                          : 'bg-red-500/10 text-red-400 border border-red-500/20',
                      )}
                    >
                      {result.available ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
                      {result.available ? 'online' : 'offline'}
                    </span>
                  </div>
                  <p className="font-mono text-[10px] text-gray-500 truncate">
                    {SOURCE_META[source].blurb} · {result.latencyMs}ms
                    {result.status ? ` · HTTP ${result.status}` : ''}
                  </p>
                </div>
                <span className="count-pill shrink-0">{result.hits.length} hits</span>
              </div>

              {result.reason ? (
                <p className="mt-2 font-mono text-[11px] text-red-300/90 leading-relaxed">
                  {result.reason}
                </p>
              ) : null}

              {result.layers ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {Object.entries(result.layers).map(([name, layer]) => (
                    <span
                      key={name}
                      title={layer.reason || `${layer.count} hit(s)`}
                      className={cn(
                        'text-[10px] font-mono px-1.5 py-0.5 rounded border',
                        layer.available
                          ? 'bg-surface-base text-blue-300 border-border-muted'
                          : 'bg-surface-base text-red-300 border-red-500/30',
                      )}
                    >
                      {name}
                      {layer.available ? `:${layer.count}` : ' unavailable'}
                    </span>
                  ))}
                </div>
              ) : null}

              {result.available && result.hits.length === 0 ? (
                <p className="mt-3 font-mono text-[11px] text-gray-400">
                  Answered, but nothing matched this query.
                </p>
              ) : null}

              {result.hits.length > 0 ? (
                <ul className="mt-3 space-y-1.5">
                  {result.hits.map((hit, index) => {
                    const key = `${source}:${hit.id || index}`;
                    const isOpen = expanded === key;
                    return (
                      <li key={key}>
                        <button
                          type="button"
                          onClick={() => setExpanded(isOpen ? null : key)}
                          aria-expanded={isOpen}
                          className="w-full text-left p-2.5 rounded-lg bg-surface-base border border-border-muted hover:border-blue-500/40 transition-colors"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p
                                className="text-xs text-gray-200 whitespace-pre-wrap break-words"
                                style={isOpen ? undefined : { maxHeight: '3.5rem', overflow: 'hidden' }}
                              >
                                {hit.text || hit.id}
                              </p>
                              <div className="mt-1 flex flex-wrap items-center gap-1.5 font-mono text-[10px] text-gray-500">
                                {(hit.layers ?? (hit.path ? ['code'] : [])).map((layer) => (
                                  <span
                                    key={layer}
                                    className="px-1.5 py-0.5 rounded bg-surface-raised text-blue-300 border border-border-muted"
                                  >
                                    {layer}
                                  </span>
                                ))}
                                {hit.path ? (
                                  <span className="truncate">
                                    {hit.path}
                                    {hit.line != null ? `:${hit.line}` : ''}
                                  </span>
                                ) : null}
                                {hit.kind ? <span>{hit.kind}</span> : null}
                                {typeof hit.score === 'number' ? (
                                  <span>score {hit.score.toFixed(3)}</span>
                                ) : null}
                              </div>
                            </div>
                            <ChevronDown
                              className={cn(
                                'w-3.5 h-3.5 text-gray-500 shrink-0 mt-0.5 transition-transform',
                                isOpen && 'rotate-180',
                              )}
                            />
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}