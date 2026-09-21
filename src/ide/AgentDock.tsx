import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  RotateCcw, Share2, GitBranch, Loader2, CheckCircle2, XCircle, RefreshCw, Zap,
  Activity, Bot, FileDiff, GitCommitHorizontal, Sparkles, Play, Square,
} from 'lucide-react';
import { getAuthHeaders, getCsrfToken } from '../auth/AuthProvider';
import { cn } from '../lib/utils';
import {
  clampFocus, flattenHunks, hunkKey, isHunkSelected, moveFocus,
  reviewKeyAction, setHunkSelected, summarizeSelection,
} from './agentDockReview';

interface LoopState {
  id: string;
  goal: string;
  status: string;
  iteration: number;
  maxIterations: number;
  checkpointSha?: string;
  report?: string;
  iterations?: Array<{ iteration: number; verdict?: string; verification?: string | null; findings?: string[] }>;
}

interface MissionView {
  id: string;
  goal: string;
  status: string;
  pendingPlan?: Array<{ label: string; dependsOn: string[] }>;
  tasks: Array<{ id: string; label: string; status: string; subagentRole?: string; costUsd?: number | null }>;
}

interface ReviewItem {
  id: string;
  status: string;
  fileCount: number;
  decisionNote?: string | null;
}

interface ReviewHunk { index: number; before: string[]; after: string[] }
interface ReviewFile { path: string; action: string; hunks: ReviewHunk[] }
interface ReviewDetail { id: string; status: string; files: ReviewFile[] }

/** AgentDock — the in-editor Axiom agent surface for the Monaco workspace:
 *  live loop status, checkpoint diff review, /undo, /share, and plan-gate
 *  approval. Mirrors the /axiom console but sits next to the code it changed.
 *
 *  `activeLoopId` is the loop the workspace's Autonomy panel started, so the
 *  dock attaches to it automatically instead of asking the operator to paste an
 *  id. `onLoopStopped` lets the dock's Stop reset the workspace's loop state. */
export function AgentDock({
  activeLoopId,
  onLoopStopped,
  onLoopStarted,
}: {
  activeLoopId?: string | null;
  onLoopStopped?: (id: string) => void;
  onLoopStarted?: (id: string) => void;
} = {}) {
  const [loopId, setLoopId] = useState<string | null>(null);
  const [loop, setLoop] = useState<LoopState | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [diffBusy, setDiffBusy] = useState(false);
  const [undoBusy, setUndoBusy] = useState(false);
  const [shareMarkdown, setShareMarkdown] = useState<string | null>(null);
  const [missions, setMissions] = useState<MissionView[]>([]);
  const [busy, setBusy] = useState(false);
  const [approveBusy, setApproveBusy] = useState(false);
  const [explainText, setExplainText] = useState<string | null>(null);
  const [explainBusy, setExplainBusy] = useState(false);
  const [reviews, setReviews] = useState<ReviewItem[]>([]);
  const [reviewBusy, setReviewBusy] = useState<string | null>(null);
  const [reviewDetails, setReviewDetails] = useState<Record<string, ReviewDetail>>({});
  // reviewId -> filePath -> accepted hunk indices
  const [hunkSel, setHunkSel] = useState<Record<string, Record<string, number[]>>>({});
  // Keyboard review cursor: which review's hunk list is focused, and where.
  const [focusReviewId, setFocusReviewId] = useState<string | null>(null);
  const [focusIdx, setFocusIdx] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The last externally-adopted loop id, so the adopt effect fires once per id.
  const adoptedRef = useRef<string | null>(null);

  const stopPoll = () => {
    if (pollTimer.current) { clearTimeout(pollTimer.current); pollTimer.current = null; }
  };

  // Exactly one self-rescheduling poll, cancellable, owned by this component.
  // Previously re-armed bare setTimeout chains with no handle, so navigating
  // away left them running (and every attachLoop started another one).
  const pollLoop = async (id: string) => {
    try {
      const res = await fetch(`/api/axiom/project/status/${id}`, { credentials: 'include', headers: getAuthHeaders() });
      const json = await res.json().catch(() => ({}));
      if (!mountedRef.current) return;
      if (!res.ok || !json.ok || !json.data) {
        setError(`Loop status unavailable (HTTP ${res.status})`);
        stopPoll();
        pollTimer.current = setTimeout(() => void pollLoop(id), 8000);
        return;
      }
      setError(null);
      setLoop(json.data as LoopState);
      if (['running', 'pending'].includes(String(json.data.status))) {
        stopPoll();
        pollTimer.current = setTimeout(() => void pollLoop(id), 4000);
      }
    } catch {
      if (!mountedRef.current) return;
      setError('Loop status request failed — retrying.');
      stopPoll();
      pollTimer.current = setTimeout(() => void pollLoop(id), 8000);
    }
  };

  useEffect(() => () => { mountedRef.current = false; stopPoll(); }, []);

  const listMissions = async () => {
    try {
      const res = await fetch('/api/axiom/mission/list', { credentials: 'include', headers: getAuthHeaders() });
      const json = await res.json();
      if (json.ok && Array.isArray(json.data?.missions)) {
        setMissions((json.data.missions as MissionView[]).filter((m) => ['awaiting-approval', 'running'].includes(m.status)).slice(0, 5));
      }
    } catch {
      // missions are optional
    }
  };

  useEffect(() => {
    void listMissions();
    const t = setInterval(() => void listMissions(), 10000);
    return () => clearInterval(t);
  }, []);

  const listReviews = async () => {
    try {
      const res = await fetch('/api/axiom/review/queue', { credentials: 'include', headers: getAuthHeaders() });
      const json = await res.json();
      if (json.ok && Array.isArray(json.data?.items)) {
        setReviews((json.data.items as ReviewItem[]).filter((r) => r.status === 'pending').slice(0, 5));
      }
    } catch {
      // review queue is optional
    }
  };

  useEffect(() => {
    void listReviews();
    const t = setInterval(() => void listReviews(), 10000);
    return () => clearInterval(t);
  }, []);

  const handleReviewDecision = async (id: string, decision: 'approve' | 'reject') => {
    setReviewBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/axiom/review/${id}/decision`, {
        method: 'POST',
        credentials: 'include',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
        body: JSON.stringify({ decision }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error(json.error || `Review decision failed (HTTP ${res.status})`);
      await listReviews();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Review decision failed');
    } finally {
      setReviewBusy(null);
    }
  };

  const loadReviewDetail = async (id: string) => {
    setReviewBusy(id);
    try {
      const res = await fetch(`/api/axiom/review/${id}`, { credentials: 'include', headers: getAuthHeaders() });
      const json = await res.json();
      const proposal = json?.data?.proposal as ReviewDetail | undefined;
      if (proposal) {
        setReviewDetails((prev) => ({ ...prev, [id]: proposal }));
        // Default every hunk to accepted.
        const sel: Record<string, number[]> = {};
        for (const f of proposal.files) sel[f.path] = f.hunks.map((h) => h.index);
        setHunkSel((prev) => ({ ...prev, [id]: sel }));
      }
    } catch {
      // detail is optional; queue still works
    } finally {
      setReviewBusy(null);
    }
  };

  const toggleHunk = (id: string, path: string, index: number) => {
    setHunkSel((prev) => {
      const forReview = prev[id] ?? {};
      const current = new Set(forReview[path] ?? []);
      if (current.has(index)) current.delete(index); else current.add(index);
      return { ...prev, [id]: { ...forReview, [path]: [...current].sort((a, b) => a - b) } };
    });
  };

  const toggleFileHunks = (id: string, path: string, all: boolean) => {
    const detail = reviewDetails[id];
    if (!detail) return;
    const file = detail.files.find((f) => f.path === path);
    if (!file) return;
    setHunkSel((prev) => ({ ...prev, [id]: { ...(prev[id] ?? {}), [path]: all ? file.hunks.map((h) => h.index) : [] } }));
  };

  const applySelectedHunks = async (id: string) => {
    const detail = reviewDetails[id];
    if (!detail) return;
    setReviewBusy(id);
    setError(null);
    try {
      const hunks = detail.files.map((f) => {
        const selected = hunkSel[id]?.[f.path] ?? [];
        const selection = f.hunks.length > 0 && selected.length === f.hunks.length ? 'all' : selected;
        return { path: f.path, hunks: selection };
      });
      const res = await fetch(`/api/axiom/review/${id}/apply-hunks`, {
        method: 'POST',
        credentials: 'include',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
        body: JSON.stringify({ hunks }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error(json.error || `Apply hunks failed (HTTP ${res.status})`);
      setReviewDetails((prev) => { const next = { ...prev }; delete next[id]; return next; });
      await listReviews();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Apply hunks failed');
    } finally {
      setReviewBusy(null);
    }
  };

  const attachLoop = async (id: string) => {
    stopPoll();
    setLoopId(id);
    setDiff(null);
    setShareMarkdown(null);
    await pollLoop(id);
  };

  // Adopt the loop the workspace's Autonomy panel started. Fires once per id so
  // a poll-triggered re-render does not re-attach (and re-arm the timer).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!activeLoopId || adoptedRef.current === activeLoopId) return;
    adoptedRef.current = activeLoopId;
    void attachLoop(activeLoopId);
  }, [activeLoopId]);

  /** Stop the attached loop (interrupt). Resets the workspace's loop state. */
  const handleStopLoop = async () => {
    if (!loopId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/axiom/project/stop/${loopId}`, {
        method: 'POST', credentials: 'include',
        headers: getAuthHeaders({ 'X-CSRF-Token': getCsrfToken() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error(json.error || `Stop failed (HTTP ${res.status})`);
      stopPoll();
      setLoop((prev) => (prev ? { ...prev, status: 'stopped' } : prev));
      onLoopStopped?.(loopId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Stop failed');
    } finally {
      setBusy(false);
    }
  };

  /** Retry: start a fresh loop with the same goal and iteration budget. There is
   *  no resume endpoint, so this is honestly a new run — labelled as such. */
  const handleRetryLoop = async () => {
    if (!loop) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/axiom/project/run', {
        method: 'POST', credentials: 'include',
        headers: getAuthHeaders({ 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() }),
        body: JSON.stringify({ goal: loop.goal, maxIterations: loop.maxIterations }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok || !json.data?.id) throw new Error(json.error || `Retry failed (HTTP ${res.status})`);
      adoptedRef.current = json.data.id;
      onLoopStarted?.(json.data.id);
      await attachLoop(json.data.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Retry failed');
    } finally {
      setBusy(false);
    }
  };

  const setHunkSelFor = (id: string, path: string, index: number, on: boolean) => {
    setHunkSel((prev) => ({ ...prev, [id]: setHunkSelected(prev[id], path, index, on) }));
  };

  /** Keyboard review for one proposal: j/k navigate, space/x toggle, a accept,
   *  r reject, Enter apply-selected. Same scheme as MultibufferReviewPanel. */
  const handleReviewKey = (e: KeyboardEvent<HTMLDivElement>, id: string) => {
    const detail = reviewDetails[id];
    if (!detail) return;
    const action = reviewKeyAction(e.key);
    if (action === 'none') return;
    e.preventDefault();
    e.stopPropagation();
    const flat = flattenHunks(detail.files);
    const current = focusReviewId === id ? focusIdx : 0;
    if (action === 'next') { setFocusReviewId(id); setFocusIdx(moveFocus(flat.length, current, 1)); return; }
    if (action === 'prev') { setFocusReviewId(id); setFocusIdx(moveFocus(flat.length, current, -1)); return; }
    const target = flat[clampFocus(flat.length, current)];
    if (!target) return;
    if (action === 'apply') { void applySelectedHunks(id); return; }
    const selected = isHunkSelected(hunkSel[id], target.path, target.index);
    const on = action === 'accept' ? true : action === 'reject' ? false : !selected;
    setFocusReviewId(id);
    setHunkSelFor(id, target.path, target.index, on);
  };

  const handleLoadDiff = async () => {
    if (!loopId) return;
    setDiffBusy(true);
    try {
      const res = await fetch(`/api/axiom/project/diff/${loopId}`, { credentials: 'include', headers: getAuthHeaders() });
      const json = await res.json();
      if (json.ok && json.data?.ok) setDiff(json.data.diff || '(empty diff)');
      else setDiff(null);
    } catch {
      setDiff(null);
    } finally {
      setDiffBusy(false);
    }
  };

  const handleUndo = async () => {
    if (!loopId) return;
    if (!window.confirm('Rewind the project to this loop\'s checkpoint? Uncommitted changes made since then are discarded.')) return;
    setUndoBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/axiom/project/rewind/${loopId}`, {
        method: 'POST', credentials: 'include',
        headers: { ...getAuthHeaders(), 'X-CSRF-Token': getCsrfToken() },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok || !json.data?.ok) throw new Error(json.error || `Rewind failed (HTTP ${res.status})`);
      setDiff(null);
      await pollLoop(loopId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rewind failed');
    } finally {
      setUndoBusy(false);
    }
  };

  /** Approve: commit the agent's working-tree changes with the loop goal as the message. */
  const handleApprove = async () => {
    if (!loop) return;
    if (!window.confirm('Commit the agent\'s working-tree changes now?')) return;
    setApproveBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/project/active/git/commit', {
        method: 'POST', credentials: 'include',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
        body: JSON.stringify({ message: (loop.goal || 'Agent loop').slice(0, 120) }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error(json.error || `Commit failed (HTTP ${res.status})`);
      setDiff(null);
      setExplainText(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Commit failed');
    } finally {
      setApproveBusy(false);
    }
  };

  /** Explain: LLM summary of the loaded checkpoint diff. */
  const handleExplain = async () => {
    if (!diff) return;
    setExplainBusy(true);
    try {
      const res = await fetch('/api/project/active/git/explain', {
        method: 'POST', credentials: 'include',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ diff: diff.slice(0, 8000) }),
      });
      const json = await res.json();
      setExplainText(json.ok ? (json.text ?? 'No summary produced.') : `Explain unavailable: ${json.error ?? 'unknown'}`);
    } catch {
      setExplainText('Explain unavailable — LLM route offline.');
    } finally {
      setExplainBusy(false);
    }
  };

  const handleShare = async () => {
    if (!loopId) return;
    setError(null);
    try {
      const res = await fetch(`/api/axiom/project/share/${loopId}`, { credentials: 'include', headers: getAuthHeaders() });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok || !json.data?.markdown) throw new Error(json.error || `Share unavailable (HTTP ${res.status})`);
      setShareMarkdown(json.data.markdown);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Share unavailable');
    }
  };

  const handleMissionDecision = async (id: string, approve: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/axiom/mission/${approve ? 'approve' : 'reject'}/${id}`, {
        method: 'POST', credentials: 'include',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
        body: JSON.stringify(approve ? { by: 'openhub-workspace' } : { reason: 'rejected from workspace' }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error(json.error || `Mission ${approve ? 'approve' : 'reject'} failed (HTTP ${res.status})`);
      await listMissions();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Mission decision failed');
    } finally {
      setBusy(false);
    }
  };

  const lastIter = loop?.iterations?.[loop.iterations.length - 1];

  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-4 text-xs">
      {error && (
        <div role="alert" className="rounded border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-2 py-1.5 text-[11px] text-[var(--color-danger)]">
          {error}
        </div>
      )}
      {/* Loop status + attach */}
      <div>
        <div className="flex items-center gap-1.5 font-bold text-gray-400 uppercase tracking-wider">
          <Zap className="w-3.5 h-3.5 text-emerald-400" /> Loop
          {loopId && <span className={`ml-auto text-[10px] font-mono ${loop?.status === 'done' ? 'text-emerald-400' : loop?.status === 'running' ? 'text-amber-400' : 'text-gray-400'}`}>{loop?.status ?? '…'}</span>}
        </div>
        {loop ? (
          <div className="mt-2 rounded border border-border-muted bg-bg-base p-2 space-y-1.5 font-mono">
            <div className="truncate text-[var(--color-text-primary)]" title={loop.goal}>{loop.goal.slice(0, 60)}</div>
            <div className="flex gap-3 text-gray-400">
              <span>iter {loop.iteration}/{loop.maxIterations}</span>
              {lastIter?.verdict && <span className={lastIter.verdict === 'PASS' ? 'text-emerald-400' : 'text-red-400'}>{lastIter.verdict}</span>}
            </div>
            {loop.checkpointSha && <div className="text-amber-400 truncate">checkpoint: {loop.checkpointSha.slice(0, 12)}</div>}
            {loop.status === 'done' && <div className="text-emerald-400">✓ all gates passed</div>}
            <div className="flex flex-wrap gap-1.5 pt-1">
              <button onClick={handleLoadDiff} disabled={diffBusy || !loop.checkpointSha} className="flex items-center gap-1 rounded bg-accent hover:bg-accent-hover disabled:opacity-40 px-2 py-1 text-white font-bold">
                {diffBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <FileDiff className="w-3 h-3" />} Diff
              </button>
              <button onClick={() => void handleApprove()} disabled={approveBusy || !loop.checkpointSha} className="flex items-center gap-1 rounded bg-success hover:brightness-110 disabled:opacity-40 px-2 py-1 text-white font-bold" title="Commit the agent's working-tree changes">
                {approveBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <GitCommitHorizontal className="w-3 h-3" />} Approve
              </button>
              <button onClick={() => void handleUndo()} disabled={undoBusy || !loop.checkpointSha} className="flex items-center gap-1 rounded bg-warning hover:brightness-110 disabled:opacity-40 px-2 py-1 text-white font-bold">
                {undoBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />} Undo
              </button>
              <button onClick={handleShare} className="flex items-center gap-1 rounded bg-border-muted hover:bg-border-strong px-2 py-1 text-gray-200 font-bold">
                <Share2 className="w-3 h-3" /> Share
              </button>
              {['running', 'pending'].includes(String(loop.status)) && (
                <button onClick={() => void handleStopLoop()} disabled={busy} className="flex items-center gap-1 rounded bg-danger hover:brightness-110 disabled:opacity-40 px-2 py-1 text-white font-bold" title="Stop the running loop">
                  {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Square className="w-3 h-3" />} Stop
                </button>
              )}
              {['done', 'failed', 'stopped', 'blocked'].includes(String(loop.status)) && (
                <button onClick={() => void handleRetryLoop()} disabled={busy} className="flex items-center gap-1 rounded border border-border-muted px-2 py-1 text-gray-300 font-bold hover:text-[var(--color-text-primary)] disabled:opacity-40" title="Start a new loop with the same goal">
                  {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />} Retry
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="mt-2 text-gray-500">No loop attached — run one from Autonomy, or enter an id below.</div>
        )}
        <div className="mt-2 flex gap-1.5">
          <input
            value={loopId ?? ''}
            onChange={(e) => setLoopId(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && loopId) void attachLoop(loopId); }}
            placeholder="loop id…"
            className="flex-1 bg-bg-base border border-border-muted rounded px-2 py-1 font-mono text-gray-300 focus:border-emerald-500 focus:outline-none"
          />
          <button onClick={() => { if (loopId) void attachLoop(loopId); }} aria-label="Refresh loop status" title="Refresh loop status" className="rounded bg-success hover:brightness-110 text-white px-2 py-1 font-bold">
            <RefreshCw className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Live agent activity — the real per-iteration findings / verification /
          report from /api/axiom/project/status. Nothing is synthesized: a loop
          that reports nothing shows nothing. */}
      {loop && ((loop.iterations?.length ?? 0) > 0 || loop.report) && (
        <div>
          <div className="flex items-center gap-1.5 font-bold text-gray-400 uppercase tracking-wider">
            <Activity className="w-3.5 h-3.5 text-blue-400" /> Activity
            <span className="ml-auto text-[10px] font-mono text-gray-500">{loop.iterations?.length ?? 0} iter</span>
          </div>
          <div className="mt-2 space-y-1.5">
            {[...(loop.iterations ?? [])].reverse().map((it) => (
              <div key={it.iteration} className="rounded border border-border-muted bg-bg-base p-2 space-y-1">
                <div className="flex items-center gap-2 font-mono text-[10px]">
                  <span className="text-gray-400">#{it.iteration}</span>
                  {it.verdict && <span className={it.verdict === 'PASS' ? 'text-emerald-400' : 'text-red-400'}>{it.verdict}</span>}
                </div>
                {it.verification && <div className="break-words text-[10px] text-gray-400">{it.verification}</div>}
                {it.findings && it.findings.length > 0 && (
                  <ul className="list-disc space-y-0.5 pl-4 text-[10px] text-gray-400">
                    {it.findings.map((f, i) => <li key={i} className="break-words">{f}</li>)}
                  </ul>
                )}
              </div>
            ))}
          </div>
          {loop.report && (
            <details className="mt-1.5 rounded border border-border-muted bg-bg-base p-2">
              <summary className="cursor-pointer text-[10px] font-bold uppercase tracking-wider text-gray-400">Report</summary>
              <pre className="mt-1 max-h-56 overflow-auto font-mono text-[10px] text-gray-300 whitespace-pre-wrap">{loop.report}</pre>
            </details>
          )}
        </div>
      )}

      {/* Diff review */}
      {diff !== null && (
        <div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 font-bold text-gray-400 uppercase tracking-wider">
              <FileDiff className="w-3.5 h-3.5 text-blue-400" /> Diff vs checkpoint
            </div>
            <button onClick={() => { setDiff(null); setExplainText(null); }} aria-label="Close diff" title="Close diff" className="text-gray-500 hover:text-[var(--color-text-primary)]">✕</button>
          </div>
          <pre className="mt-2 max-h-72 overflow-auto rounded border border-border-muted bg-bg-base p-2 font-mono text-[10px] text-gray-300 whitespace-pre-wrap">
            {diff}
          </pre>
          <button
            onClick={() => void handleExplain()}
            disabled={explainBusy}
            className="mt-1.5 flex items-center gap-1 rounded border border-border-muted bg-surface-raised px-2 py-1 text-[10px] font-bold text-gray-300 hover:text-[var(--color-text-primary)] disabled:opacity-40"
          >
            {explainBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3 text-amber-400" />} Explain this change
          </button>
          {explainText && (
            <div className="mt-1.5 rounded border border-border-muted bg-bg-base p-2 text-[11px] leading-relaxed text-gray-300 whitespace-pre-wrap">
              {explainText}
            </div>
          )}
        </div>
      )}

      {/* Share snapshot */}
      {shareMarkdown && (
        <div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 font-bold text-gray-400 uppercase tracking-wider">
              <Share2 className="w-3.5 h-3.5 text-blue-400" /> Share snapshot
            </div>
            <button onClick={() => setShareMarkdown(null)} aria-label="Close share snapshot" title="Close share snapshot" className="text-gray-500 hover:text-[var(--color-text-primary)]">✕</button>
          </div>
          <pre className="mt-2 max-h-56 overflow-auto rounded border border-border-muted bg-bg-base p-2 font-mono text-[10px] text-gray-300 whitespace-pre-wrap">
            {shareMarkdown}
          </pre>
        </div>
      )}

      {/* Plan-gate approvals */}
      <div>
        <div className="flex items-center gap-1.5 font-bold text-gray-400 uppercase tracking-wider">
          <GitBranch className="w-3.5 h-3.5 text-emerald-400" /> Plan approvals
          <span className="ml-auto text-[10px] font-mono text-gray-500">{missions.filter((m) => m.status === 'awaiting-approval').length} parked</span>
        </div>
        {missions.length === 0 ? (
          <div className="mt-2 text-gray-500">No missions awaiting approval.</div>
        ) : (
          <div className="mt-2 space-y-2">
            {missions.map((m) => (
              <div key={m.id} className="rounded border border-border-muted bg-bg-base p-2 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className={`text-[10px] font-mono ${m.status === 'awaiting-approval' ? 'text-amber-400' : 'text-emerald-400'}`}>{m.status}</span>
                  <span className="text-[11px] font-mono text-gray-500 truncate">{m.id}</span>
                </div>
                <div className="truncate text-[var(--color-text-primary)]" title={m.goal}>{m.goal.slice(0, 50)}</div>
                {m.status === 'awaiting-approval' && (
                  <div className="space-y-1">
                    {m.pendingPlan?.map((t, i) => (
                      <div key={i} className="text-[10px] text-gray-400">
                        <span className="text-emerald-400">t{i + 1}</span> {t.label}{t.dependsOn?.length ? ` · after ${t.dependsOn.join(',')}` : ''}
                      </div>
                    ))}
                    <div className="flex gap-1.5 pt-1">
                      <button onClick={() => void handleMissionDecision(m.id, true)} disabled={busy} className="flex items-center gap-1 rounded bg-success hover:brightness-110 disabled:opacity-40 px-2 py-1 text-white font-bold">
                        <CheckCircle2 className="w-3 h-3" /> Approve
                      </button>
                      <button onClick={() => void handleMissionDecision(m.id, false)} disabled={busy} className="flex items-center gap-1 rounded bg-danger hover:brightness-110 disabled:opacity-40 px-2 py-1 text-white font-bold">
                        <XCircle className="w-3 h-3" /> Reject
                      </button>
                    </div>
                  </div>
                )}
                {m.status === 'running' && (
                  <div className="space-y-1">
                    {m.tasks.map((t) => (
                      <div key={t.id} className="flex items-center justify-between text-[10px]">
                        <span className="text-gray-400 truncate">{t.id} {t.label}</span>
                        <span className="flex items-center gap-1.5">
                          {t.subagentRole && <span className="rounded bg-blue-500/20 px-1 text-blue-300">{t.subagentRole}</span>}
                          {t.costUsd != null && <span className="rounded bg-purple-500/20 px-1 text-purple-300">${t.costUsd.toFixed(4)}</span>}
                          <span className={t.status === 'done' ? 'text-emerald-400' : t.status === 'failed' || t.status === 'blocked' ? 'text-red-400' : 'text-gray-500'}>{t.status}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Diff-review queue (propose-before-apply) */}
      <div>
        <div className="flex items-center gap-1.5 font-bold text-gray-400 uppercase tracking-wider">
          <FileDiff className="w-3.5 h-3.5 text-blue-400" /> Diff review
          <span className="ml-auto text-[10px] font-mono text-gray-500">{reviews.length} pending</span>
        </div>
        {reviews.length === 0 ? (
          <div className="mt-2 text-gray-500">No proposals awaiting review.</div>
        ) : (
          <div className="mt-2 space-y-2">
            {reviews.map((r) => (
              <div key={r.id} className="rounded border border-border-muted bg-bg-base p-2 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] font-mono text-amber-400">{r.status}</span>
                  <span className="text-[11px] font-mono text-gray-500 truncate">{r.id}</span>
                </div>
                <div className="text-[10px] text-gray-400">{r.fileCount} file{r.fileCount === 1 ? '' : 's'} changed</div>
                <div className="flex gap-1.5 pt-1">
                  <button
                    onClick={() => void handleReviewDecision(r.id, 'approve')}
                    disabled={reviewBusy === r.id}
                    className="flex items-center gap-1 rounded bg-success px-2 py-1 text-white font-bold disabled:opacity-40"
                  >
                    {reviewBusy === r.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />} Apply all
                  </button>
                  <button
                    onClick={() => void handleReviewDecision(r.id, 'reject')}
                    disabled={reviewBusy === r.id}
                    className="flex items-center gap-1 rounded bg-danger px-2 py-1 text-white font-bold disabled:opacity-40"
                  >
                    <XCircle className="w-3 h-3" /> Reject
                  </button>
                  <button
                    onClick={() => void (reviewDetails[r.id] ? setReviewDetails((p) => { const n = { ...p }; delete n[r.id]; return n; }) : loadReviewDetail(r.id))}
                    disabled={reviewBusy === r.id}
                    className="flex items-center gap-1 rounded border border-border-muted px-2 py-1 text-gray-300 font-bold disabled:opacity-40"
                  >
                    <FileDiff className="w-3 h-3" /> {reviewDetails[r.id] ? 'Hide hunks' : 'Per-hunk'}
                  </button>
                </div>

                {reviewDetails[r.id] && (() => {
                  const detail = reviewDetails[r.id];
                  const flat = flattenHunks(detail.files);
                  const focusedKey = focusReviewId === r.id && flat[focusIdx]
                    ? hunkKey(flat[focusIdx].path, flat[focusIdx].index)
                    : null;
                  const summary = summarizeSelection(detail.files, hunkSel[r.id]);
                  return (
                    <div
                      className="mt-1 space-y-2 rounded border-t border-border-muted pt-1.5 outline-none focus:ring-1 focus:ring-[var(--color-accent)]/40"
                      tabIndex={0}
                      autoFocus
                      onKeyDown={(e) => handleReviewKey(e, r.id)}
                      aria-label={`Review ${r.id}: ${summary.selectedHunks} of ${summary.totalHunks} hunks selected`}
                    >
                      <div className="flex items-center gap-2 text-[10px] text-gray-500">
                        <span className="font-mono">{summary.selectedHunks}/{summary.totalHunks} selected</span>
                        <span className="ml-auto font-mono" title="j/k move · space toggle · a accept · r reject · Enter apply">j/k · space · a · r · ⏎</span>
                      </div>
                      {detail.files.map((f) => {
                        const selected = new Set(hunkSel[r.id]?.[f.path] ?? []);
                        const fileName = f.path.split('/').pop() || f.path;
                        return (
                          <div key={f.path} className="space-y-1">
                            <div className="flex items-center gap-1.5 text-[10px] font-mono">
                              <span className="text-gray-300 truncate" title={f.path}>{fileName}</span>
                              <span className="text-gray-500">({f.hunks.length} hunk{f.hunks.length === 1 ? '' : 's'})</span>
                              <button onClick={() => toggleFileHunks(r.id, f.path, true)} className="ml-auto text-blue-300 hover:underline">all</button>
                              <button onClick={() => toggleFileHunks(r.id, f.path, false)} className="text-gray-500 hover:underline">none</button>
                            </div>
                            {f.hunks.map((h) => (
                              <label
                                key={h.index}
                                className={cn(
                                  'flex gap-1.5 rounded border bg-bg-base p-1.5 font-mono text-[10px] cursor-pointer',
                                  focusedKey === hunkKey(f.path, h.index)
                                    ? 'border-[var(--color-accent)]'
                                    : 'border-border-muted/60',
                                )}
                              >
                                <input type="checkbox" checked={selected.has(h.index)} onChange={() => toggleHunk(r.id, f.path, h.index)} className="mt-0.5" />
                                <span className="min-w-0 flex-1 overflow-x-auto whitespace-pre">
                                  {h.before.map((l, i) => <span key={`b${i}`} className="block text-red-400">-{l}</span>)}
                                  {h.after.map((l, i) => <span key={`a${i}`} className="block text-emerald-400">+{l}</span>)}
                                </span>
                              </label>
                            ))}
                          </div>
                        );
                      })}
                      <button
                        onClick={() => void applySelectedHunks(r.id)}
                        disabled={reviewBusy === r.id || summary.selectedHunks === 0}
                        className="flex items-center gap-1 rounded bg-success px-2 py-1 text-white font-bold disabled:opacity-40"
                      >
                        {reviewBusy === r.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />} Apply selected hunks
                      </button>
                    </div>
                  );
                })()}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="pt-2 text-[10px] text-gray-500 flex items-center gap-1">
        <Bot className="w-3 h-3" /> AgentDock — undo/share/diff/approve live next to the code they change.
      </div>
    </div>
  );
}