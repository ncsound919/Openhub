import { useEffect, useState } from 'react';
import { BookOpen, RefreshCw, Search, FolderOpen } from 'lucide-react';
import { getCsrfToken, getAuthHeaders } from '../auth/AuthProvider';

interface KnowledgeEntry {
  kind: string;
  key: string;
  name: string;
  description: string;
  path: string;
}

interface KnowledgeResponse {
  ok: boolean;
  live: boolean;
  root: string | null;
  roots?: string[];
  sources?: { root: string; label: string; entries: number }[];
  totals: Record<string, number>;
  entries: KnowledgeEntry[];
  error?: string;
}

const KINDS = ['all', 'agent', 'skill', 'workflow', 'reference', 'template', 'rule', 'command'];
const KIND_COLORS: Record<string, string> = {
  agent: 'text-green-400 border-green-500/40 bg-green-500/10',
  skill: 'text-blue-400 border-blue-500/40 bg-blue-500/10',
  workflow: 'text-purple-400 border-purple-500/40 bg-purple-500/10',
  reference: 'text-teal-400 border-teal-500/40 bg-teal-500/10',
  template: 'text-yellow-400 border-yellow-500/40 bg-yellow-500/10',
  rule: 'text-orange-400 border-orange-500/40 bg-orange-500/10',
  command: 'text-pink-400 border-pink-500/40 bg-pink-500/10',
};

export function EcosystemView() {
  const [kind, setKind] = useState('all');
  const [search, setSearch] = useState('');
  const [data, setData] = useState<KnowledgeResponse | null>(null);
  const [refreshBusy, setRefreshBusy] = useState(false);

  const load = async (nextKind = kind, nextSearch = search) => {
    try {
      const params = new URLSearchParams();
      if (nextKind !== 'all') params.set('kind', nextKind);
      if (nextSearch.trim()) params.set('search', nextSearch.trim());
      const res = await fetch(`/api/ecosystem/knowledge?${params.toString()}`, { credentials: 'include', headers: getAuthHeaders() });
      const json = await res.json();
      setData({ ok: json.ok, live: json.live, root: json.root, roots: json.roots, sources: json.sources, totals: json.totals ?? {}, entries: json.entries ?? [], error: json.error });
    } catch {
      setData({ ok: false, live: false, root: null, totals: {}, entries: [], error: 'Failed to load ecosystem knowledge' });
    }
  };

  useEffect(() => {
    load('all', '');
  }, []);

  const handleRefresh = async () => {
    setRefreshBusy(true);
    try {
      await fetch('/api/ecosystem/knowledge/refresh', { method: 'POST', credentials: 'include', headers: { ...getAuthHeaders(), 'X-CSRF-Token': getCsrfToken() } });
      await load(kind, search);
    } catch {}
    setRefreshBusy(false);
  };

  const totalEntries = Object.values(data?.totals ?? {}).reduce((a, b) => a + b, 0);
  const shown = data?.entries.length ?? 0;

  const stats = [
    { label: 'Assets', value: String(totalEntries), sub: data?.live ? 'indexed & live' : 'not configured', accent: 'var(--color-info)', accent2: 'var(--color-accent)', pct: totalEntries ? Math.min(100, totalEntries * 2) : 4 },
    { label: 'Shown', value: String(shown), sub: kind === 'all' ? 'all kinds' : `kind: ${kind}`, accent: 'var(--color-success)', accent2: 'var(--color-success)', pct: totalEntries ? Math.min(100, Math.round((shown / Math.max(1, totalEntries)) * 100)) : 0 },
    { label: 'Kinds', value: String(Object.keys(data?.totals ?? {}).length || KINDS.length - 1), sub: 'agent · skill · workflow…', accent: 'var(--color-warning)', accent2: 'var(--color-warning)', pct: 70 },
    { label: 'Source', value: data?.live ? 'Live' : 'Idle', sub: data?.root ? data.root : 'set OPENHUB_ECOSYSTEM_ROOT', accent: 'var(--color-accent)', accent2: 'var(--color-accent)', pct: data?.live ? 100 : 8 },
  ];

  return (
    <div className="flex-1 w-full max-w-6xl mx-auto flex flex-col gap-5 px-4 py-6">
      {/* Hero */}
      <section className="gradient-hero rounded-2xl p-6 relative overflow-hidden">
        <div className="absolute -right-8 -top-12 opacity-[0.12] pointer-events-none">
          <BookOpen className="w-56 h-56 text-blue-300" strokeWidth={1} />
        </div>
        <div className="flex items-center gap-2 text-[11px] font-extrabold uppercase tracking-[0.18em] text-gray-400">
          <span className={`w-1.5 h-1.5 rounded-full ${data?.live ? 'bg-emerald-400 animate-pulse' : 'bg-surface-overlay'}`} />
          Ecosystem · {data?.live ? `${totalEntries} assets` : 'not configured'}
        </div>
        <h2 className="mt-2">Knowledge <span className="text-info">at hand.</span></h2>
        <p className="mt-1.5 max-w-xl truncate text-sm text-gray-400">{data?.root ? `Source: ${data.root}` : 'Set OPENHUB_ECOSYSTEM_ROOT to index the ecosystem folder.'}</p>
        <div className="mt-4">
          <button
            onClick={handleRefresh}
            disabled={refreshBusy}
            className="inline-flex items-center gap-2 rounded-lg border border-border-muted bg-surface-base/70 px-4 py-2 text-sm font-bold text-gray-400 hover:border-blue-500/50 disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${refreshBusy ? 'animate-spin' : ''}`} /> Re-index
          </button>
        </div>
        {data?.error && <p className="mt-2 truncate font-mono text-[11px] text-red-400">{data.error}</p>}
      </section>

      {/* Stats */}
      <section className="grid grid-cols-2 xl:grid-cols-4 gap-3" aria-label="Knowledge status">
        {stats.map((s) => (
          <div key={s.label} className="industrial-card stat-tile p-4" style={{ ['--accent' as string]: s.accent, ['--accent2' as string]: s.accent2 }}>
            <div className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-gray-400">{s.label}</div>
            <div className="mt-1 truncate text-2xl font-extrabold text-[var(--color-text-primary)] tracking-tight">{s.value}</div>
            <div className="mt-0.5 truncate text-[11px] text-gray-400">{s.sub}</div>
            <div className="meter mt-2.5"><span style={{ width: `${s.pct}%` }} /></div>
          </div>
        ))}
      </section>

      {/* Sources — every local intel root feeding the index */}
      {data?.sources && data.sources.length > 0 && (
        <section className="glass rounded-xl px-4 py-3" aria-label="Intel sources">
          <div className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-gray-400">
            Intel sources · {data.sources.length}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {data.sources.map((s) => (
              <span key={s.root} className="inline-flex items-center gap-2 rounded-full border border-border-muted bg-surface-base px-3 py-1" title={s.root}>
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                <span className="text-xs font-bold text-[var(--color-text-primary)]">{s.label}</span>
                <span className="count-pill">{s.entries}</span>
              </span>
            ))}
          </div>
        </section>
      )}

      {/* Filters */}
      <section className="industrial-card p-4 space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {KINDS.map((k) => {
            const count = k === 'all' ? totalEntries : (data?.totals?.[k] ?? 0);
            return (
              <button
                key={k}
                onClick={() => { setKind(k); load(k, search); }}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11px] font-bold uppercase transition cursor-pointer ${
                  kind === k
                    ? 'border-blue-500/50 text-blue-200 bg-blue-500/10'
                    : 'border-border-muted text-gray-400 bg-surface-base hover:text-[var(--color-text-primary)]'
                }`}
              >
                {k} <span className="count-pill">{count}</span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center rounded-lg border border-border-muted bg-surface-base px-3 py-2">
          <Search className="w-4 h-4 text-gray-400 mr-2 shrink-0" />
          <input
            type="text"
            value={search}
            onChange={(e) => { setSearch(e.target.value); load(kind, e.target.value); }}
            placeholder="Search agents, skills, workflows, rules…"
            className="bg-transparent border-none outline-none text-sm w-full text-gray-400 placeholder-gray-500"
          />
        </div>
      </section>

      {/* Results */}
      {data?.entries.length === 0 ? (
        <div className="industrial-card p-8 text-center font-mono text-xs text-gray-400">
          No matches. Try a different search or kind.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {data?.entries.slice(0, 24).map((e, i) => (
            <div key={`${e.kind}-${e.key}-${i}`} className="industrial-card clickable p-4 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <span className={`shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px] font-bold uppercase ${KIND_COLORS[e.kind] ?? 'text-gray-400 border-border-muted bg-surface-base'}`}>
                  {e.kind}
                </span>
                <span className="flex min-w-0 items-center gap-1 font-mono text-[10px] text-gray-400">
                  <FolderOpen className="w-3 h-3 shrink-0" />
                  <span className="truncate">{e.path}</span>
                </span>
              </div>
              <div className="mt-2 truncate text-sm font-bold text-[var(--color-text-primary)]">{e.name}</div>
              <div className="mt-0.5 line-clamp-2 text-xs leading-snug text-gray-400">{e.description || '—'}</div>
            </div>
          ))}
        </div>
      )}
      {shown > 24 ? (
        <p className="text-center font-mono text-[11px] text-gray-400">Showing 24 of {shown} — refine search to narrow.</p>
      ) : null}
    </div>
  );
}
