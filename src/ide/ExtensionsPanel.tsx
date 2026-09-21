// In-workspace Extensions panel — the real ecosystem catalog, not a marketplace
// stub. Mirrors the honest contract of pages/ExtensionsView: entries are real
// files on disk under the ecosystem root; nothing is downloaded or executed.
// Full search/filter/register lives on the /extensions page; this panel is the
// compact in-context view so the sidebar is not a dead end.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Puzzle, Loader2, ExternalLink } from 'lucide-react';
import { getAuthHeaders } from '../auth/AuthProvider';

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
  totals: Record<string, number>;
  entries: KnowledgeEntry[];
  error?: string;
}

export function ExtensionsPanel() {
  const [data, setData] = useState<KnowledgeResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/ecosystem/knowledge?limit=100', { credentials: 'include', headers: getAuthHeaders() });
        const json = (await res.json()) as KnowledgeResponse;
        if (alive) setData(json);
      } catch (err) {
        if (alive) setData({ ok: false, live: false, root: null, totals: {}, entries: [], error: err instanceof Error ? err.message : 'Catalog unavailable' });
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const entries = data?.entries ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col p-3 text-xs">
      <div className="mb-2 flex items-center gap-1.5 font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
        <Puzzle className="h-3.5 w-3.5 text-[var(--color-accent-text)]" /> Extensions
        <Link to="/extensions" className="ml-auto flex items-center gap-1 text-[var(--color-accent-text)] hover:underline">
          Catalog <ExternalLink className="h-3 w-3" />
        </Link>
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-[var(--color-text-muted)]">
          <Loader2 className="h-3 w-3 animate-spin" /> loading ecosystem catalog…
        </div>
      )}

      {!loading && !data?.live && (
        <div className="text-[var(--color-text-muted)]">
          Ecosystem catalog offline{data?.error ? ` — ${data.error}` : ''}.
        </div>
      )}

      {!loading && data?.live && entries.length === 0 && (
        <div className="text-[var(--color-text-muted)]">No ecosystem entries found.</div>
      )}

      {!loading && entries.length > 0 && (
        <div className="min-h-0 flex-1 space-y-1.5 overflow-auto">
          {entries.slice(0, 60).map((e) => (
            <div key={e.key} className="rounded border border-[var(--color-border-muted)] bg-[var(--color-bg-base)] p-1.5">
              <div className="flex items-center gap-1.5">
                <span className="truncate font-medium text-[var(--color-text-primary)]">{e.name}</span>
                <span className="ml-auto shrink-0 rounded bg-[var(--color-surface-overlay)] px-1 text-[10px] uppercase text-[var(--color-text-muted)]">{e.kind}</span>
              </div>
              {e.description && <div className="mt-0.5 line-clamp-2 text-[var(--color-text-muted)]">{e.description}</div>}
            </div>
          ))}
          {entries.length > 60 && <div className="pt-1 text-[var(--color-text-muted)]">…{entries.length - 60} more in the full catalog</div>}
        </div>
      )}
    </div>
  );
}
