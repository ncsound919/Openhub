import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Bot, Cpu, Wrench, BookOpen, Code, Command, Puzzle, Plus, Check, RefreshCw, Search, Loader2,
} from 'lucide-react';
import { useStore } from '../store';
import { getAuthHeaders } from '../auth/AuthProvider';

/**
 * Repository Extensions (E3) — real, not a marketplace mock.
 *
 * Two honest halves:
 *  1. The live ecosystem catalog (`/api/ecosystem/knowledge`) — real files on
 *     disk (agents/skills/workflows/commands), each labeled with its source path.
 *  2. "Register to workspace" writes the item into the workspace registry
 *     (`POST /api/registry`). That is what makes it appear in the workspace's
 *     suggested skills — a real, reversible registration, NOT a package install.
 *     No download/execution happens here, so nothing is claimed that isn't true.
 */

type KnowledgeKind = 'agent' | 'skill' | 'workflow' | 'reference' | 'template' | 'rule' | 'command';

interface KnowledgeEntry {
  kind: KnowledgeKind;
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
  error?: string;
}

const KIND_ICON: Record<KnowledgeKind, typeof Bot> = {
  agent: Bot,
  skill: Cpu,
  workflow: Wrench,
  reference: BookOpen,
  template: Code,
  rule: Wrench,
  command: Command,
};

/** Map an ecosystem kind onto the workspace registry's item types. */
function registryType(kind: KnowledgeKind): 'cli' | 'mcp' | 'cron' | 'agent' {
  if (kind === 'agent') return 'agent';
  if (kind === 'skill' || kind === 'command') return 'cli';
  if (kind === 'workflow') return 'cron';
  return 'agent';
}

export function ExtensionsView() {
  const { owner, repo: repoName } = useParams();
  const repo = useStore((state) => state.repositories.find((r) => r.owner === owner && r.name === repoName));
  const registryItems = useStore((state) => state.registryItems);
  const fetchRegistryItems = useStore((state) => state.fetchRegistryItems);
  const addRegistryItem = useStore((state) => state.addRegistryItem);

  const [data, setData] = useState<KnowledgeResponse | null>(null);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<'all' | KnowledgeKind>('all');
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ecosystem/knowledge?limit=300', { credentials: 'include', headers: getAuthHeaders() });
      setData((await res.json()) as KnowledgeResponse);
    } catch (err) {
      setData({ ok: false, live: false, root: null, totals: {}, entries: [], error: err instanceof Error ? err.message : 'Catalog unavailable' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (registryItems.length === 0) void fetchRegistryItems(); }, [registryItems.length, fetchRegistryItems]);

  const registered = useMemo(() => new Set(registryItems.map((i) => i.name.toLowerCase())), [registryItems]);

  const entries = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (data?.entries ?? []).filter((e) => {
      if (kind !== 'all' && e.kind !== kind) return false;
      return !needle || `${e.name} ${e.description} ${e.path}`.toLowerCase().includes(needle);
    });
  }, [data, kind, query]);

  const register = async (entry: KnowledgeEntry) => {
    setBusyKey(entry.key);
    try {
      await addRegistryItem({
        name: entry.name,
        type: registryType(entry.kind),
        description: entry.description || `Ecosystem ${entry.kind} (${entry.path})`,
        author: 'ecosystem',
        version: '1.0.0',
      });
    } finally {
      setBusyKey(null);
    }
  };

  const kinds = Object.keys(data?.totals ?? {}) as KnowledgeKind[];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between border-b border-[var(--color-border-muted)] pb-4">
        <div>
          <h2 className="flex items-center text-lg font-bold text-[var(--color-text-primary)]">
            <Puzzle className="mr-2 h-5 w-5 text-[var(--color-accent-text)]" /> Extensions
          </h2>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            {repo ? `${repo.owner}/${repo.name} · ` : ''}Live ecosystem catalog. Register an item to make it available in the workspace.
          </p>
        </div>
        <button
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-raised)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      <div className="rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-base)] p-3 text-xs font-mono">
        <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--color-text-muted)]">Source</span>
        <div className={data?.live ? 'mt-1 break-all text-[var(--color-success)]' : 'mt-1 text-[var(--color-warning)]'}>
          {data?.root || data?.error || 'Checking ecosystem configuration…'}
        </div>
      </div>

      <div className="flex flex-col gap-3 md:flex-row">
        <div className="flex flex-1 items-center rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-raised)] px-3 py-2">
          <Search className="mr-2 h-4 w-4 text-[var(--color-text-muted)]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search agents, skills, workflows, commands…"
            aria-label="Search ecosystem catalog"
            className="w-full bg-transparent text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] outline-none"
          />
        </div>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as typeof kind)}
          aria-label="Filter by kind"
          className="rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-raised)] px-3 py-2 text-sm text-[var(--color-text-primary)]"
        >
          <option value="all">All kinds</option>
          {kinds.map((k) => <option key={k} value={k}>{k} ({data?.totals[k] ?? 0})</option>)}
        </select>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-10 font-mono text-sm text-[var(--color-text-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" /> Reading ecosystem catalog…
        </div>
      ) : entries.length === 0 ? (
        <div className="rounded-md border border-dashed border-[var(--color-border-muted)] p-10 text-center text-sm text-[var(--color-text-muted)]">
          {data?.live ? 'No ecosystem items match this filter.' : 'No live catalog is available. Configure OPENHUB_ECOSYSTEM_ROOT.'}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {entries.map((entry) => {
            const Icon = KIND_ICON[entry.kind];
            const isIn = registered.has(entry.name.toLowerCase());
            return (
              <div key={`${entry.kind}-${entry.key}`} className="rounded-lg border border-[var(--color-border-muted)] bg-[var(--color-surface-raised)] p-4">
                <div className="flex items-start gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)]">
                    <Icon className="h-[18px] w-[18px] text-[var(--color-accent-text)]" />
                  </span>
                  <div className="min-w-0">
                    <span className="tag">{entry.kind}</span>
                    <h3 className="mt-1.5 truncate text-sm font-semibold text-[var(--color-text-primary)]" title={entry.name}>{entry.name}</h3>
                  </div>
                </div>
                <p className="mt-3 min-h-10 text-xs text-[var(--color-text-secondary)]">{entry.description || 'No description in the source document.'}</p>
                <div className="mt-3 flex items-center gap-2 border-t border-[var(--color-border-muted)] pt-3">
                  <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-[var(--color-text-muted)]" title={entry.path}>{entry.path}</span>
                  <button
                    onClick={() => void register(entry)}
                    disabled={isIn || busyKey === entry.key}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md bg-[var(--color-accent)] px-2 py-1 text-[11px] font-semibold text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
                  >
                    {busyKey === entry.key ? <Loader2 className="h-3 w-3 animate-spin" /> : isIn ? <Check className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
                    {isIn ? 'In workspace' : 'Register'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
