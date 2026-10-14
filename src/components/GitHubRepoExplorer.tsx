import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  CircleDot,
  GitFork,
  Github,
  Globe,
  Loader2,
  Lock,
  RefreshCw,
  Search,
  Star,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { getCsrfToken } from '../auth/AuthProvider';

interface FleetRepoRow {
  fullName: string;
  owner: string;
  name: string;
  visibility: 'public' | 'private' | 'internal';
  archived: boolean;
  fork: boolean;
  pushedAt: string | null;
  updatedAt: string | null;
  description: string | null;
  language: string | null;
  defaultBranch: string | null;
  openIssues: number;
  stargazers: number;
}

interface ReposResponse {
  byAccount: Record<string, number>;
  total: number;
  lastSync: string | null;
  repos: FleetRepoRow[];
  count: number;
}

type AccountFilter = 'all' | string;

function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return 'unknown';
  return formatDistanceToNow(t, { addSuffix: true });
}

function VisibilityBadge({ visibility }: { visibility: FleetRepoRow['visibility'] }) {
  if (visibility === 'private') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-black uppercase tracking-widest text-amber-400 border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 rounded-sm">
        <Lock className="w-2.5 h-2.5" /> private
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-black uppercase tracking-widest text-gray-400 border border-text-muted/40 bg-text-secondary/20 px-1.5 py-0.5 rounded-sm">
      <Globe className="w-2.5 h-2.5" /> {visibility}
    </span>
  );
}

/**
 * Live, filterable listing of the operator's fleet GitHub repos (ncsound919 +
 * tap919) from the persisted index, with an on-demand re-sync. All values come
 * from the API — nothing inferred client-side.
 */
export function GitHubRepoExplorer() {
  const [data, setData] = useState<ReposResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const [account, setAccount] = useState<AccountFilter>('all');
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [showForks, setShowForks] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/github/fleet/repos?limit=500', { credentials: 'include' });
      if (!res.ok) {
        setError(`Repos endpoint replied ${res.status} ${res.statusText}`.trim());
        setData(null);
      } else {
        setData((await res.json()) as ReposResponse);
        setError(null);
      }
    } catch {
      setError('Repos endpoint unreachable');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sync = useCallback(async () => {
    setSyncing(true);
    setError(null);
    try {
      const res = await fetch('/api/github/fleet/repos/sync', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error || `Sync failed (${res.status})`);
      }
      await load();
    } catch {
      setError('Sync request failed');
    } finally {
      setSyncing(false);
    }
  }, [load]);

  const accounts = useMemo(() => Object.keys(data?.byAccount ?? {}), [data]);

  const filtered = useMemo(() => {
    const repos = data?.repos ?? [];
    const q = search.trim().toLowerCase();
    return repos.filter((r) => {
      if (account !== 'all' && r.owner !== account) return false;
      if (!showArchived && r.archived) return false;
      if (!showForks && r.fork) return false;
      if (q && !r.name.toLowerCase().includes(q) && !(r.description ?? '').toLowerCase().includes(q)) return false;
      return true;
    });
  }, [data, account, search, showArchived, showForks]);

  return (
    <div className="industrial-card p-6">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
        <h2 className="text-gray-400 flex items-center text-sm">
          <Github className="w-4 h-4 mr-2" /> GitHub Fleet Repos
          <span className="ml-3 text-[10px] font-black text-green-500 tracking-widest">
            {data ? `${data.total} INDEXED` : '—'}
          </span>
        </h2>
        <div className="flex items-center gap-3">
          <span className="text-[11px] font-mono text-gray-400">last sync: {data?.lastSync ?? 'never'}</span>
          <button
            onClick={sync}
            disabled={syncing}
            className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-blue-400 hover:text-blue-300 disabled:opacity-50 border border-blue-500/30 hover:border-blue-400/60 bg-blue-500/10 px-2.5 py-1.5 rounded-sm transition-colors"
          >
            {syncing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            {syncing ? 'Syncing' : 'Sync now'}
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="flex items-center bg-surface-base border border-border-muted rounded-sm px-2 py-1 focus-within:border-blue-500">
          <Search className="w-3.5 h-3.5 text-gray-400 mr-2" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter repos..."
            className="bg-transparent border-none outline-none text-xs text-gray-400 placeholder-gray-500 w-48 font-mono"
          />
        </div>
        <div className="flex items-center bg-surface-base border border-border-muted rounded-sm p-0.5">
          {(['all', ...accounts] as AccountFilter[]).map((acct) => (
            <button
              key={acct}
              onClick={() => setAccount(acct)}
              className={`text-[10px] font-black uppercase tracking-widest px-2.5 py-1 rounded-sm transition-colors ${
                account === acct ? 'bg-blue-500/20 text-blue-400' : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              {acct}{acct !== 'all' && data?.byAccount[acct] !== undefined ? ` ${data.byAccount[acct]}` : ''}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-[10px] font-mono text-gray-400 cursor-pointer">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} className="accent-blue-500" />
          archived
        </label>
        <label className="flex items-center gap-1.5 text-[10px] font-mono text-gray-400 cursor-pointer">
          <input type="checkbox" checked={showForks} onChange={(e) => setShowForks(e.target.checked)} className="accent-blue-500" />
          forks
        </label>
        <span className="text-[10px] font-mono text-gray-400 ml-auto">{filtered.length} shown</span>
      </div>

      {error ? (
        <div className="bg-amber-500/10 border border-amber-500/40 p-3 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
          <p className="text-[10px] font-mono text-amber-400 leading-relaxed">{error}</p>
        </div>
      ) : loading ? (
        <div className="flex items-center gap-2 text-gray-400 py-6">
          <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
          <span className="text-[10px] font-mono uppercase tracking-widest">Loading repo index...</span>
        </div>
      ) : !data ? (
        <p className="text-[10px] text-gray-400 font-mono py-4">No repo index available.</p>
      ) : filtered.length === 0 ? (
        <p className="text-[10px] text-gray-400 font-mono py-4">
          No repos match the current filters{data.total === 0 ? ' — run a sync to populate the index.' : '.'}
        </p>
      ) : (
        <div className="max-h-[520px] overflow-y-auto divide-y divide-text-secondary/60 pr-1">
          {filtered.map((r) => (
            <div key={r.fullName} className="py-3 flex items-start justify-between gap-4 group">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <a
                    href={`https://github.com/${r.fullName}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm font-mono text-blue-400 hover:text-blue-300 hover:underline truncate"
                  >
                    {r.name}
                  </a>
                  <VisibilityBadge visibility={r.visibility} />
                  {r.archived ? (
                    <span className="inline-flex items-center gap-1 text-[11px] font-black uppercase tracking-widest text-orange-400 border border-orange-500/30 bg-orange-500/10 px-1.5 py-0.5 rounded-sm">
                      <Archive className="w-2.5 h-2.5" /> archived
                    </span>
                  ) : null}
                  {r.fork ? (
                    <span className="inline-flex items-center gap-1 text-[11px] font-black uppercase tracking-widest text-gray-400 border border-text-muted/40 px-1.5 py-0.5 rounded-sm">
                      <GitFork className="w-2.5 h-2.5" /> fork
                    </span>
                  ) : null}
                </div>
                {r.description ? (
                  <p className="text-[11px] text-gray-400 mt-1 line-clamp-1">{r.description}</p>
                ) : null}
                <div className="flex items-center gap-3 mt-1 text-[11px] font-mono text-gray-400 uppercase tracking-widest">
                  <span className="text-gray-400">{r.owner}</span>
                  {r.language ? <span className="text-gray-400">{r.language}</span> : null}
                  {r.defaultBranch ? <span>⎇ {r.defaultBranch}</span> : null}
                  <span>pushed {relativeTime(r.pushedAt)}</span>
                </div>
              </div>
              <div className="flex items-center gap-3 shrink-0 pt-0.5 text-[10px] font-mono text-gray-400">
                {r.stargazers > 0 ? (
                  <span className="flex items-center gap-1">
                    <Star className="w-3 h-3 text-yellow-500/70" /> {r.stargazers}
                  </span>
                ) : null}
                {r.openIssues > 0 ? (
                  <span className="flex items-center gap-1">
                    <CircleDot className="w-3 h-3 text-green-500/70" /> {r.openIssues}
                  </span>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
