import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bot, BookOpen, Code, Command, Cpu, RefreshCw, Search, Wrench } from 'lucide-react';
import { getAuthHeaders } from '../auth/AuthProvider';

interface KnowledgeEntry {
  kind: 'agent' | 'skill' | 'workflow' | 'reference' | 'template' | 'rule' | 'command';
  key: string;
  name: string;
  description: string;
  path: string;
}

interface KnowledgeResponse {
  ok: boolean;
  live: boolean;
  root: string | null;
  totals: Record<string, number>;
  entries: KnowledgeEntry[];
  refreshedAt: string;
  error?: string;
}

const kindIcon: Record<KnowledgeEntry['kind'], typeof Bot> = {
  agent: Bot,
  skill: Cpu,
  workflow: Wrench,
  reference: BookOpen,
  template: Code,
  rule: Wrench,
  command: Command,
};

/** The logistics view is a read-only projection of actual ecosystem tooling. */
export function ToolkitRegistry() {
  const [data, setData] = useState<KnowledgeResponse | null>(null);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<'all' | KnowledgeEntry['kind']>('all');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '300' });
      const res = await fetch(`/api/ecosystem/knowledge?${params}`, { credentials: 'include', headers: getAuthHeaders() });
      const payload = await res.json() as KnowledgeResponse;
      setData(payload);
    } catch (err) {
      setData({ ok: false, live: false, root: null, totals: {}, entries: [], refreshedAt: new Date().toISOString(), error: err instanceof Error ? err.message : 'Tool inventory unavailable' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const tools = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (data?.entries ?? []).filter((entry) => {
      if (kind !== 'all' && entry.kind !== kind) return false;
      return !needle || `${entry.name} ${entry.description} ${entry.path}`.toLowerCase().includes(needle);
    });
  }, [data, kind, query]);

  const kinds = Object.keys(data?.totals ?? {}) as KnowledgeEntry['kind'][];

  return (
    <div className="flex-1 w-full max-w-6xl mx-auto flex flex-col gap-5 px-4 py-6 relative z-10">
      <section className="gradient-hero rounded-2xl p-6 relative overflow-hidden">
        <div className="flex items-center gap-2 text-[11px] font-extrabold uppercase tracking-[0.18em] text-emerald-300">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          Live inventory · {data ? Object.values(data.totals ?? {}).reduce((a, b) => a + b, 0) : '—'} tools
        </div>
        <h1 className="mt-2">Tooling <span className="text-info">Logistics.</span></h1>
        <p className="mt-2 max-w-xl text-sm text-gray-400">
          Live inventory from the configured Ecosystem directory — agents, skills, workflows, and commands.
        </p>
        <div className="mt-4">
          <button onClick={() => void load()} disabled={loading} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-4 py-2 text-sm font-bold shadow-lg shadow-blue-950/50">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh inventory
          </button>
        </div>
      </section>

      <div className="glass rounded-xl p-4 text-xs font-mono">
        <div className="text-gray-400 uppercase tracking-[0.14em] text-[10px] font-extrabold">Source</div>
        <div className={data?.live ? 'text-green-400 mt-1 break-all' : 'text-amber-400 mt-1'}>{data?.root || data?.error || 'Checking ecosystem configuration…'}</div>
      </div>

      <div className="flex flex-col md:flex-row gap-3">
        <div className="flex-1 flex items-center bg-surface-raised border border-border-muted rounded px-3 py-2">
          <Search className="w-4 h-4 text-gray-400 mr-2" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search tools, skills, agents, commands…" className="w-full bg-transparent outline-none text-sm text-gray-400 placeholder-gray-500" />
        </div>
        <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)} className="bg-surface-raised border border-border-muted rounded px-3 py-2 text-sm text-gray-400">
          <option value="all">All tool types</option>
          {kinds.map((itemKind) => <option key={itemKind} value={itemKind}>{itemKind} ({data?.totals[itemKind] ?? 0})</option>)}
        </select>
      </div>

      {data?.error && <div className="border border-amber-500/40 bg-amber-500/10 text-amber-300 text-sm p-4">{data.error}</div>}
      {loading ? <div className="text-sm font-mono text-gray-400 py-10">Reading real ecosystem tooling…</div> : tools.length ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {tools.map((tool) => {
            const Icon = kindIcon[tool.kind];
            return <div key={`${tool.kind}-${tool.key}`} className="industrial-card clickable p-5">
              <div className="flex items-start gap-3"><span className="quick-icon" style={{ ['--hover' as string]: 'var(--color-info)' }}><Icon className="w-[18px] h-[18px] text-blue-300" /></span><div className="min-w-0"><div><span className="count-pill">{tool.kind}</span></div><h2 className="!text-base truncate mt-1.5">{tool.name}</h2></div></div>
              <p className="text-xs text-gray-400 mt-4 min-h-10">{tool.description || 'No description was available in the source document.'}</p>
              <div className="border-t border-border-muted mt-4 pt-3 text-[11px] font-mono text-gray-400 break-all">{tool.path}</div>
            </div>;
          })}
        </div>
      ) : <div className="border border-dashed border-border-muted rounded p-10 text-center text-sm text-gray-400">{data?.live ? 'No ecosystem tools match this filter.' : 'No live tool inventory is available.'}</div>}
    </div>
  );
}
