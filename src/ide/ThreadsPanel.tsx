import React from 'react';
import { GitBranchPlus, Loader2, Check, X, RefreshCw, Play, FileDiff, GitCommitHorizontal, GitMerge, Trash2, ChevronRight } from 'lucide-react';
import { getAuthHeaders, getCsrfToken } from '../auth/AuthProvider';
import { cn } from '../lib/utils';
import {
  anyLive,
  heldByTask,
  heldWorktrees,
  missionHeadline,
  normalizeMissionList,
  taskProgress,
  taskViews,
  tokenTotal,
  type HeldWorktree,
  type MissionSummary,
  type TaskView,
} from './threads';

/**
 * Threads — Zed-style parallel agents over Axiom's mission fan-out.
 *
 * Each mission runs independent tasks concurrently (each in an isolated git
 * worktree when the target is a repo). This panel lists live threads, shows the
 * per-thread (per-task) fan-out with usage/audit facts, and lets you launch a
 * parallel run, approve a parked plan, inspect a task's loop diff, and commit
 * the accepted result.
 *
 * Honest note: Axiom's engine auto-merges a task's worktree when the task's
 * audit gate passes (see `src/server/missionWorktrees.ts`), so "merge" here is
 * the operator's final accept-and-commit of the accumulated working tree — not
 * an interactive hold-and-merge of a live worktree.
 */
export function ThreadsPanel({ projectPath }: { projectPath: string }) {
  const [missions, setMissions] = React.useState<MissionSummary[]>([]);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [tasks, setTasks] = React.useState<TaskView[]>([]);
  const [held, setHeld] = React.useState<HeldWorktree[]>([]);
  const [reviewEnabled, setReviewEnabled] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [diff, setDiff] = React.useState<{ label: string; text: string } | null>(null);

  const [goal, setGoal] = React.useState('');
  const [maxTasks, setMaxTasks] = React.useState(4);
  const [concurrency, setConcurrency] = React.useState(2);
  const [planGate, setPlanGate] = React.useState(true);

  const load = React.useCallback(async () => {
    try {
      const res = await fetch('/api/axiom/mission/list', { credentials: 'include', headers: getAuthHeaders() });
      const json = await res.json().catch(() => ({}));
      if (json?.ok && json.data) setMissions(normalizeMissionList(json.data));
    } catch {
      // transient; keep the last good list
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDetail = React.useCallback(async (id: string) => {
    setSelected(id);
    setDiff(null);
    setError(null);
    try {
      const res = await fetch(`/api/axiom/mission/status/${encodeURIComponent(id)}`, { credentials: 'include', headers: getAuthHeaders() });
      const json = await res.json().catch(() => ({}));
      if (json?.ok) setTasks(taskViews(json.data));
      else setTasks([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load thread');
      setTasks([]);
    }
    try {
      const wRes = await fetch(`/api/axiom/mission/${encodeURIComponent(id)}/worktrees`, { credentials: 'include', headers: getAuthHeaders() });
      const wJson = await wRes.json().catch(() => ({}));
      setHeld(heldWorktrees(wJson?.data));
      setReviewEnabled(wJson?.data?.reviewEnabled === true);
    } catch {
      setHeld([]);
    }
  }, []);

  React.useEffect(() => { void load(); }, [load]);

  React.useEffect(() => {
    if (!anyLive(missions)) return;
    const t = window.setInterval(() => {
      void load();
      if (selected) void loadDetail(selected);
    }, 3000);
    return () => window.clearInterval(t);
  }, [missions, selected, load, loadDetail]);

  const launch = async () => {
    setBusy('launch');
    setError(null);
    try {
      const res = await fetch('/api/axiom/mission/run', {
        method: 'POST',
        credentials: 'include',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
        body: JSON.stringify({ goal, maxTasks, planGate, concurrency }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error(json.error || `Launch failed (HTTP ${res.status})`);
      setGoal('');
      await load();
      const id = json.data?.id;
      if (typeof id === 'string') await loadDetail(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Launch failed');
    } finally {
      setBusy(null);
    }
  };

  const decide = async (id: string, decision: 'approve' | 'reject') => {
    setBusy(`${decision}:${id}`);
    setError(null);
    try {
      const res = await fetch(`/api/axiom/mission/${decision}/${encodeURIComponent(id)}`, {
        method: 'POST',
        credentials: 'include',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
        body: JSON.stringify({ by: 'openhub' }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error(json.error || `${decision} failed (HTTP ${res.status})`);
      await load();
      await loadDetail(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : `${decision} failed`);
    } finally {
      setBusy(null);
    }
  };

  const showDiff = async (task: TaskView) => {
    if (!task.loopId) { setError(`${task.id} has no loop id yet (task has not run)`); return; }
    setBusy(`diff:${task.id}`);
    setError(null);
    try {
      const res = await fetch(`/api/axiom/project/diff/${encodeURIComponent(task.loopId)}`, { credentials: 'include', headers: getAuthHeaders() });
      const json = await res.json().catch(() => ({}));
      const text = json?.data?.diff ?? json?.data?.diffText;
      setDiff({ label: `${task.id} · ${task.label}`, text: typeof text === 'string' ? text : '(no diff available yet)' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Diff failed');
    } finally {
      setBusy(null);
    }
  };

  const commitAccepted = async (task: TaskView) => {
    setBusy(`commit:${task.id}`);
    setError(null);
    try {
      const res = await fetch('/api/project/active/git/commit', {
        method: 'POST',
        credentials: 'include',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
        body: JSON.stringify({ message: `thread ${task.id}: ${(task.label || 'task').slice(0, 100)}` }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error(json.error || `Commit failed (HTTP ${res.status})`);
      setDiff(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Commit failed');
    } finally {
      setBusy(null);
    }
  };

  const showHeldDiff = async (task: TaskView) => {
    if (!selected) return;
    setBusy(`diff:${task.id}`);
    setError(null);
    try {
      const res = await fetch(`/api/axiom/mission/${encodeURIComponent(selected)}/worktree/${encodeURIComponent(task.id)}/diff`, { credentials: 'include', headers: getAuthHeaders() });
      const json = await res.json().catch(() => ({}));
      const text = json?.data?.diff;
      setDiff({ label: `held · ${task.id} · ${task.label}`, text: typeof text === 'string' ? text : '(no diff available)' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Diff failed');
    } finally {
      setBusy(null);
    }
  };

  const mergeHeld = async (task: TaskView) => {
    if (!selected) return;
    setBusy(`merge:${task.id}`);
    setError(null);
    try {
      const res = await fetch(`/api/axiom/mission/${encodeURIComponent(selected)}/worktree/${encodeURIComponent(task.id)}/merge`, {
        method: 'POST',
        credentials: 'include',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
        body: JSON.stringify({}),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error(json.data?.output || json.error || `Merge failed (HTTP ${res.status})`);
      setDiff(null);
      await loadDetail(selected);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Merge failed');
    } finally {
      setBusy(null);
    }
  };

  const discardHeld = async (task: TaskView) => {
    if (!selected) return;
    setBusy(`discard:${task.id}`);
    setError(null);
    try {
      const res = await fetch(`/api/axiom/mission/${encodeURIComponent(selected)}/worktree/${encodeURIComponent(task.id)}/discard`, {
        method: 'POST',
        credentials: 'include',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
        body: JSON.stringify({}),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error(json.error || `Discard failed (HTTP ${res.status})`);
      await loadDetail(selected);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Discard failed');
    } finally {
      setBusy(null);
    }
  };

  const progress = taskProgress(tasks);
  const heldMap = heldByTask(held);
  const selectedMission = missions.find((m) => m.id === selected) ?? null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 border-b border-[var(--color-border-muted)] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
        <GitBranchPlus className="w-3.5 h-3.5" /> Threads
        <span className="ml-auto font-mono normal-case tracking-normal">{missions.length} run{missions.length === 1 ? '' : 's'}</span>
        <button type="button" onClick={() => void load()} aria-label="Refresh threads" title="Refresh" className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]">
          <RefreshCw className={cn('w-3 h-3', loading && 'animate-spin')} />
        </button>
      </div>

      {error && (
        <div role="alert" className="mx-2 mt-2 rounded border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-2 py-1.5 text-[11px] text-[var(--color-danger)]">
          {error}
        </div>
      )}

      <div className="border-b border-[var(--color-border-muted)] p-2">
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="Goal to fan out across parallel threads…"
          rows={2}
          className="w-full resize-none rounded border border-[var(--color-border-muted)] bg-[var(--color-surface-base)] px-2 py-1 text-[11px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
        />
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px] text-[var(--color-text-muted)]">
          <label className="flex items-center gap-1">tasks
            <input type="number" min={1} max={8} value={maxTasks} onChange={(e) => setMaxTasks(Math.max(1, Math.min(8, Number(e.target.value) || 1)))} className="w-10 rounded border border-[var(--color-border-muted)] bg-[var(--color-surface-base)] px-1 text-[10px] text-[var(--color-text-primary)]" />
          </label>
          <label className="flex items-center gap-1">parallel
            <input type="number" min={1} max={8} value={concurrency} onChange={(e) => setConcurrency(Math.max(1, Math.min(8, Number(e.target.value) || 1)))} className="w-10 rounded border border-[var(--color-border-muted)] bg-[var(--color-surface-base)] px-1 text-[10px] text-[var(--color-text-primary)]" />
          </label>
          <label className="flex items-center gap-1"><input type="checkbox" checked={planGate} onChange={(e) => setPlanGate(e.target.checked)} /> gate plan</label>
          <button
            type="button"
            disabled={busy === 'launch' || !goal.trim() || !projectPath}
            onClick={() => void launch()}
            className="ml-auto flex items-center gap-1 rounded bg-[var(--color-accent)] px-2 py-0.5 text-[10px] font-semibold text-white disabled:opacity-40"
          >
            {busy === 'launch' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />} Run threads
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && missions.length === 0 ? (
          <div className="flex items-center gap-2 px-3 py-3 text-xs text-[var(--color-text-muted)]"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading threads…</div>
        ) : missions.length === 0 ? (
          <div className="px-3 py-3 text-xs text-[var(--color-text-muted)]">No mission threads yet. Launch one above to fan out parallel work.</div>
        ) : (
          <>
            {missions.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => void loadDetail(m.id)}
                className={cn(
                  'flex w-full items-center gap-2 border-b border-[var(--color-border-muted)] px-3 py-1.5 text-left text-[11px] hover:bg-[var(--color-surface-hover)]',
                  selected === m.id && 'bg-[var(--color-surface-hover)]',
                )}
              >
                <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', m.live ? 'bg-[var(--color-warning)] animate-pulse' : m.status === 'done' ? 'bg-[var(--color-success)]' : m.status === 'failed' ? 'bg-[var(--color-danger)]' : 'bg-[var(--color-text-muted)]')} />
                <span className="min-w-0 flex-1 truncate text-[var(--color-text-primary)]">{m.goal || m.id}</span>
                <span className="shrink-0 font-mono text-[10px] text-[var(--color-text-muted)]">{missionHeadline(m)}</span>
                <span className="shrink-0 rounded border border-[var(--color-border-muted)] px-1 text-[11px] uppercase text-[var(--color-text-muted)]">{m.status}</span>
              </button>
            ))}

            {selectedMission && (
              <div className="border-t border-[var(--color-border)] bg-[var(--color-surface-raised)]">
                <div className="flex items-center gap-2 px-3 py-1.5 text-[10px] uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
                  <ChevronRight className="w-3 h-3" />
                  <span className="truncate normal-case tracking-normal">{selectedMission.id}</span>
                  <span className="ml-auto font-mono normal-case tracking-normal">{progress.done}/{progress.total} done{progress.failed ? ` · ${progress.failed} failed` : ''}{progress.running ? ` · ${progress.running} active` : ''}</span>
                  {held.length > 0 && <span className="rounded border border-[var(--color-warning)]/50 px-1 text-[11px] normal-case tracking-normal text-[var(--color-warning)]" title="worktrees held for review">{held.length} held</span>}
                  {reviewEnabled && held.length === 0 && <span className="text-[11px] normal-case tracking-normal" title="AXIOM_MISSION_WORKTREE_REVIEW is on; held worktrees appear when a task runs in a worktree">review on</span>}
                </div>

                {selectedMission.status === 'awaiting-approval' && (
                  <div className="flex items-center gap-2 px-3 py-1.5">
                    <span className="text-[11px] text-[var(--color-warning)]">Plan parked — approve to launch the tasks.</span>
                    <button type="button" disabled={busy !== null} onClick={() => void decide(selectedMission.id, 'approve')} className="ml-auto flex items-center gap-1 rounded bg-[var(--color-success)] px-2 py-0.5 text-[10px] font-semibold text-white disabled:opacity-40">
                      {busy === `approve:${selectedMission.id}` ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Approve
                    </button>
                    <button type="button" disabled={busy !== null} onClick={() => void decide(selectedMission.id, 'reject')} className="flex items-center gap-1 rounded border border-[var(--color-border-muted)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)] disabled:opacity-40">
                      {busy === `reject:${selectedMission.id}` ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />} Reject
                    </button>
                  </div>
                )}

                {tasks.map((t) => (
                  <div key={t.id} className="border-t border-[var(--color-border-muted)] px-3 py-1.5">
                    <div className="flex items-center gap-2 text-[11px]">
                      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', t.status === 'done' ? 'bg-[var(--color-success)]' : t.status === 'failed' || t.status === 'stalled' ? 'bg-[var(--color-danger)]' : t.status === 'running' ? 'bg-[var(--color-warning)] animate-pulse' : 'bg-[var(--color-text-muted)]')} />
                      <span className="font-mono text-[10px] text-[var(--color-text-muted)]">{t.id}</span>
                      <span className="min-w-0 flex-1 truncate text-[var(--color-text-primary)]">{t.label}</span>
                      {t.auditVerified && <span title="audit verified" className="text-[11px] text-[var(--color-success)]">audited</span>}
                      <span className="shrink-0 font-mono text-[11px] text-[var(--color-text-muted)]">{t.status} · {t.attempts}/{t.maxAttempts}{tokenTotal(t.usage) ? ` · ${tokenTotal(t.usage)}tx` : ''}</span>
                    </div>
                    {t.artifactSummary && <div className="mt-0.5 truncate pl-4 font-mono text-[11px] text-[var(--color-text-muted)]" title={t.artifactSummary}>{t.artifactSummary}</div>}
                    {t.error && <div className="mt-0.5 truncate pl-4 text-[11px] text-[var(--color-danger)]" title={t.error}>{t.error}</div>}
                    <div className="mt-1 flex items-center gap-2 pl-4 text-[10px]">
                      {heldMap[t.id] ? (
                        <>
                          <span className="rounded border border-[var(--color-warning)]/50 px-1 text-[11px] text-[var(--color-warning)]" title={`held branch ${heldMap[t.id].branch}`}>held</span>
                          <button type="button" disabled={busy !== null} onClick={() => void showHeldDiff(t)} className="flex items-center gap-1 text-[var(--color-accent-text)] hover:underline disabled:opacity-40">
                            {busy === `diff:${t.id}` ? <Loader2 className="w-3 h-3 animate-spin" /> : <FileDiff className="w-3 h-3" />} Diff
                          </button>
                          <button type="button" disabled={busy !== null} onClick={() => void mergeHeld(t)} className="flex items-center gap-1 text-[var(--color-success)] hover:underline disabled:opacity-40">
                            {busy === `merge:${t.id}` ? <Loader2 className="w-3 h-3 animate-spin" /> : <GitMerge className="w-3 h-3" />} Merge
                          </button>
                          <button type="button" disabled={busy !== null} onClick={() => void discardHeld(t)} className="flex items-center gap-1 text-[var(--color-danger)] hover:underline disabled:opacity-40">
                            {busy === `discard:${t.id}` ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />} Discard
                          </button>
                          <span className="ml-auto truncate font-mono text-[11px] text-[var(--color-text-muted)]" title={heldMap[t.id].branch}>{heldMap[t.id].branch}</span>
                        </>
                      ) : (
                        <>
                          <button type="button" disabled={busy !== null} onClick={() => void showDiff(t)} className="flex items-center gap-1 text-[var(--color-accent-text)] hover:underline disabled:opacity-40">
                            {busy === `diff:${t.id}` ? <Loader2 className="w-3 h-3 animate-spin" /> : <FileDiff className="w-3 h-3" />} Diff
                          </button>
                          <button type="button" disabled={busy !== null} onClick={() => void commitAccepted(t)} className="flex items-center gap-1 text-[var(--color-text-secondary)] hover:underline disabled:opacity-40">
                            {busy === `commit:${t.id}` ? <Loader2 className="w-3 h-3 animate-spin" /> : <GitCommitHorizontal className="w-3 h-3" />} Commit
                          </button>
                          {t.targetDir && <span className="ml-auto truncate font-mono text-[11px] text-[var(--color-text-muted)]" title={t.targetDir}>{t.targetDir}</span>}
                        </>
                      )}
                    </div>
                  </div>
                ))}

                {diff && (
                  <div className="border-t border-[var(--color-border-muted)]">
                    <div className="flex items-center gap-2 px-3 py-1 text-[10px] text-[var(--color-text-muted)]">
                      <span className="truncate">{diff.label}</span>
                      <button type="button" onClick={() => setDiff(null)} className="ml-auto hover:text-[var(--color-text-primary)]">close</button>
                    </div>
                    <pre className="max-h-64 overflow-auto bg-[var(--color-surface-base)] px-3 py-2 font-mono text-[10px] text-[var(--color-text-secondary)]">{diff.text}</pre>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
