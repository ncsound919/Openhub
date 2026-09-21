import React from 'react';
import { Layers, Loader2, Check, RefreshCw, ChevronRight } from 'lucide-react';
import { getAuthHeaders, getCsrfToken } from '../auth/AuthProvider';
import { cn } from '../lib/utils';
import {
  defaultSelection,
  flattenReview,
  isHunkAccepted,
  selectionPayload,
  setFileHunks,
  stepRow,
  summary,
  toggleHunk,
  type ReviewProposal,
  type ReviewQueueItem,
  type ReviewSelection,
} from './reviewMultibuffer';

/**
 * Multibuffer review â€” every pending review proposal flattened into ONE
 * continuous, keyboard-driven buffer (Zed-style), instead of per-file panels.
 * Reuses the existing review queue and `/api/axiom/review/:id/apply-hunks`.
 *
 * Keys: j/k move Â· space (or x) toggle hunk Â· a/r accept/reject the file Â·
 * Enter apply the active proposal.
 */
export function MultibufferReviewPanel() {
  const [items, setItems] = React.useState<ReviewQueueItem[]>([]);
  const [proposals, setProposals] = React.useState<ReviewProposal[]>([]);
  const [sel, setSel] = React.useState<ReviewSelection>({});
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [active, setActive] = React.useState(0);
  const containerRef = React.useRef<HTMLDivElement>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qRes = await fetch('/api/axiom/review/queue', { credentials: 'include', headers: getAuthHeaders() });
      const q = await qRes.json().catch(() => ({}));
      const pending: ReviewQueueItem[] = (Array.isArray(q?.data?.items) ? q.data.items : [])
        .filter((r: ReviewQueueItem) => r && r.status === 'pending');
      setItems(pending);
      const details = await Promise.all(pending.map(async (r) => {
        try {
          const dRes = await fetch(`/api/axiom/review/${encodeURIComponent(r.id)}`, { credentials: 'include', headers: getAuthHeaders() });
          const d = await dRes.json().catch(() => ({}));
          const proposal = d?.data?.proposal as ReviewProposal | undefined;
          return proposal && Array.isArray(proposal.files) ? proposal : null;
        } catch {
          return null;
        }
      }));
      const loaded = details.filter((p): p is ReviewProposal => !!p);
      setProposals(loaded);
      setSel(defaultSelection(loaded));
      setActive(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the review queue');
      setProposals([]);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { void load(); }, [load]);

  const rows = React.useMemo(() => flattenReview(proposals), [proposals]);
  const totals = React.useMemo(() => summary(proposals, sel), [proposals, sel]);
  const indexByKey = React.useMemo(() => {
    const m = new Map<string, number>();
    rows.forEach((r, i) => m.set(r.key, i));
    return m;
  }, [rows]);

  React.useEffect(() => {
    const el = containerRef.current?.querySelector(`[data-row-key="${rows[active]?.key ?? ''}"]`);
    if (el && 'scrollIntoView' in el) (el as HTMLElement).scrollIntoView({ block: 'nearest' });
  }, [active, rows]);

  const applyProposal = async (proposalId: string) => {
    const p = proposals.find((x) => x.id === proposalId);
    if (!p) return;
    setBusy(proposalId);
    setError(null);
    try {
      const res = await fetch(`/api/axiom/review/${encodeURIComponent(proposalId)}/apply-hunks`, {
        method: 'POST',
        credentials: 'include',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
        body: JSON.stringify({ hunks: selectionPayload(p, sel) }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error(json.error || `Apply failed (HTTP ${res.status})`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Apply failed');
    } finally {
      setBusy(null);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const row = rows[active];
    const file = row ? proposals.find((p) => p.id === row.proposalId)?.files.find((f) => f.path === row.path) : undefined;
    if (e.key === 'j') { setActive((i) => stepRow(rows.length, i, 1)); e.preventDefault(); }
    else if (e.key === 'k') { setActive((i) => stepRow(rows.length, i, -1)); e.preventDefault(); }
    else if ((e.key === ' ' || e.key === 'x') && row) {
      setSel((s) => toggleHunk(s, row.proposalId, row.path, row.hunkIndex));
      e.preventDefault();
    } else if (e.key === 'a' && row && file) {
      setSel((s) => setFileHunks(s, row.proposalId, row.path, file.hunks.map((h) => h.index), true));
      e.preventDefault();
    } else if (e.key === 'r' && row && file) {
      setSel((s) => setFileHunks(s, row.proposalId, row.path, file.hunks.map((h) => h.index), false));
      e.preventDefault();
    } else if (e.key === 'Enter' && row) {
      void applyProposal(row.proposalId);
      e.preventDefault();
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 border-b border-[var(--color-border-muted)] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
        <Layers className="w-3.5 h-3.5" /> Multibuffer review
        <span className="ml-auto font-mono normal-case tracking-normal">{totals.accepted}/{totals.total} hunks</span>
        <button
          type="button"
          onClick={() => void load()}
          aria-label="Refresh review queue"
          title="Refresh"
          className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
        >
          <RefreshCw className={cn('w-3 h-3', loading && 'animate-spin')} />
        </button>
      </div>

      {error && (
        <div role="alert" className="mx-2 mt-2 rounded border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-2 py-1.5 text-[11px] text-[var(--color-danger)]">
          {error}
        </div>
      )}

      <div
        ref={containerRef}
        tabIndex={0}
        role="region"
        aria-label="Multibuffer review"
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-y-auto p-2 outline-none"
      >
        {loading && proposals.length === 0 ? (
          <div className="flex items-center gap-2 px-2 py-3 text-xs text-[var(--color-text-muted)]">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Reading review queueâ€¦
          </div>
        ) : proposals.length === 0 ? (
          <div className="px-2 py-3 text-xs text-[var(--color-text-muted)]">
            No proposals awaiting review{items.length ? ` (${items.length} pending without detail)` : ''}.
          </div>
        ) : (
          proposals.map((p) => (
            <div key={p.id} className="mb-3 overflow-hidden rounded-md border border-[var(--color-border-muted)]">
              <div className="sticky top-[-8px] z-10 flex items-center gap-2 border-b border-[var(--color-border-muted)] bg-[var(--color-surface-raised)] px-2 py-1.5">
                <ChevronRight className="w-3 h-3 text-[var(--color-text-muted)]" />
                <span className="truncate font-mono text-[11px] text-[var(--color-text-secondary)]">{p.id}</span>
                <span className="text-[10px] text-[var(--color-text-muted)]">{p.files.length} file{p.files.length === 1 ? '' : 's'}</span>
                <button
                  type="button"
                  disabled={busy === p.id}
                  onClick={() => void applyProposal(p.id)}
                  className="ml-auto flex items-center gap-1 rounded bg-[var(--color-success)] px-2 py-0.5 text-[10px] font-semibold text-white hover:brightness-110 disabled:opacity-40"
                >
                  {busy === p.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                  Apply selected
                </button>
              </div>
              {p.files.map((f) => {
                const accepted = (sel[p.id]?.[f.path] ?? []).length;
                return (
                  <div key={f.path} className="border-b border-[var(--color-border-muted)] last:border-b-0">
                    <div className="flex items-center gap-2 bg-[var(--color-surface-base)] px-2 py-1 font-mono text-[11px] text-[var(--color-text-primary)]">
                      <span className="truncate" title={f.path}>{f.path}</span>
                      <span className="text-[10px] text-[var(--color-text-muted)]">{f.action} Â· {accepted}/{f.hunks.length}</span>
                      <button type="button" onClick={() => setSel((s) => setFileHunks(s, p.id, f.path, f.hunks.map((h) => h.index), true))} className="ml-auto text-[10px] text-[var(--color-accent-text)] hover:underline">all</button>
                      <button type="button" onClick={() => setSel((s) => setFileHunks(s, p.id, f.path, f.hunks.map((h) => h.index), false))} className="text-[10px] text-[var(--color-text-muted)] hover:underline">none</button>
                    </div>
                    {f.hunks.map((h) => {
                      const key = `${p.id}::${f.path}::${h.index}`;
                      const idx = indexByKey.get(key) ?? -1;
                      const on = isHunkAccepted(sel, p.id, f.path, h.index);
                      return (
                        <label
                          key={h.index}
                          data-row-key={key}
                          className={cn(
                            'flex cursor-pointer gap-2 px-2 py-1 font-mono text-[11px]',
                            idx === active ? 'bg-[var(--color-surface-hover)]' : 'hover:bg-[var(--color-surface-hover)]/50',
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => setSel((s) => toggleHunk(s, p.id, f.path, h.index))}
                            onFocus={() => setActive(idx)}
                            className="mt-0.5"
                            aria-label={`${on ? 'Reject' : 'Accept'} hunk ${h.index + 1} in ${f.path}`}
                          />
                          <span className="min-w-0 flex-1 overflow-x-auto whitespace-pre">
                            {h.before.map((l, i) => <span key={`b${i}`} className="block text-red-400">-{l}</span>)}
                            {h.after.map((l, i) => <span key={`a${i}`} className="block text-green-400">+{l}</span>)}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
