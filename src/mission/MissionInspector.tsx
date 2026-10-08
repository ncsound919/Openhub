import { useCallback, useEffect, useState } from 'react';
import { Loader2, RotateCcw, Undo2 } from 'lucide-react';
import {
  fetchDiff,
  fetchTodos,
  revertLastStep,
  unrevertSession,
  type FileDiff,
  type MissionTodo,
  type SessionTelemetry,
} from './useMission.js';

const DEFAULT_TABS = ['Changes', 'Todos', 'Telemetry', 'Artifacts'];

interface MissionInspectorProps {
  /** opencode session backing the active mission, or null when none is selected. */
  sessionId: string | null;
  /** Best-effort telemetry; unknown fields render as `—`. */
  telemetry?: SessionTelemetry | null;
  /**
   * A single explicit refresh token. Bumping it re-reads the diff/todos exactly
   * once (e.g. when the active mission's status changes). A session change
   * already re-reads via `sessionId`, so this is only nudged for same-session
   * transitions to avoid a double fetch.
   */
  refreshToken?: number;
  /** Override the tab rail (primarily for tests). */
  tabs?: string[];
}

/** Render an unknown count as `—` (mono numbers only). */
function dash(n: number | undefined): string {
  return n == null ? '—' : n.toLocaleString('en-US');
}

/** A small pulsing placeholder row for the loading state. */
function Skeleton() {
  return (
    <div className="space-y-2 p-3" aria-label="Loading" role="status">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-3 animate-pulse rounded bg-[var(--color-surface-overlay)]" style={{ width: `${80 - i * 15}%` }} />
      ))}
    </div>
  );
}

const TODO_STATUS: Record<string, { color: string; mark: string }> = {
  done: { color: 'var(--color-success)', mark: '✓' },
  completed: { color: 'var(--color-success)', mark: '✓' },
  in_progress: { color: 'var(--color-info)', mark: '◐' },
  'in-progress': { color: 'var(--color-info)', mark: '◐' },
  pending: { color: 'var(--color-text-muted)', mark: '○' },
};

/**
 * Right-hand inspector for a mission: the review surface (diff + rewind), the
 * todo checklist, session telemetry and the changed-file artifact list.
 *
 * HONESTY: the diff is a post-hoc read of `GET /session/:id/diff` — opencode
 * applies edits live, so there is no per-hunk accept/reject to offer. "Revert
 * last step" rewinds the whole session to just before its last message; it is
 * confirmed first because it is destructive. The diff/todo/message JSON shapes
 * are UNVERIFIED against a live engine, so every read is defensive and empty
 * states are shown rather than fabricated rows.
 */
export function MissionInspector({ sessionId, telemetry = null, refreshToken = 0, tabs = DEFAULT_TABS }: MissionInspectorProps) {
  const [active, setActive] = useState(tabs[0] ?? '');
  const [diff, setDiff] = useState<FileDiff[]>([]);
  const [todos, setTodos] = useState<MissionTodo[]>([]);
  const [diffLoading, setDiffLoading] = useState(false);
  const [todosLoading, setTodosLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [canUnrevert, setCanUnrevert] = useState(false);
  const [busy, setBusy] = useState(false);

  const loadDiff = useCallback(async () => {
    if (!sessionId) {
      setDiff([]);
      return;
    }
    setDiffLoading(true);
    try {
      setDiff(await fetchDiff(sessionId));
      setError(null);
    } catch (err) {
      setDiff([]);
      setError(err instanceof Error ? err.message : 'Unable to load changes');
    } finally {
      setDiffLoading(false);
    }
  }, [sessionId]);

  const loadTodos = useCallback(async () => {
    if (!sessionId) {
      setTodos([]);
      return;
    }
    setTodosLoading(true);
    try {
      setTodos(await fetchTodos(sessionId));
      setError(null);
    } catch (err) {
      setTodos([]);
      setError(err instanceof Error ? err.message : 'Unable to load todos');
    } finally {
      setTodosLoading(false);
    }
  }, [sessionId]);

  // Re-read on a session change (the loaders change identity with `sessionId`)
  // or on an explicit refresh token — exactly one fetch per change, never both.
  useEffect(() => {
    void loadDiff();
    void loadTodos();
  }, [loadDiff, loadTodos, refreshToken]);

  // A new session cannot inherit a prior session's un-done revert.
  useEffect(() => setCanUnrevert(false), [sessionId]);

  const onRevert = async () => {
    if (!sessionId || busy) return;
    if (!window.confirm('Revert the last step? This rewinds the session and is destructive.')) return;
    setBusy(true);
    setError(null);
    try {
      const confirmed = await revertLastStep(sessionId);
      if (!confirmed) {
        // The engine returns a success boolean; a false / unrecognized response
        // must not be reported as a revert that happened.
        setError('Engine did not confirm the revert; nothing was changed.');
        return;
      }
      setCanUnrevert(true);
      await loadDiff();
      await loadTodos();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to revert');
    } finally {
      setBusy(false);
    }
  };

  const onUnrevert = async () => {
    if (!sessionId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const confirmed = await unrevertSession(sessionId);
      if (!confirmed) {
        setError('Engine did not confirm the unrevert; nothing was changed.');
        return;
      }
      setCanUnrevert(false);
      await loadDiff();
      await loadTodos();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to unrevert');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col border-l border-[var(--color-border-muted)] bg-[var(--color-surface-base)]">
      <div
        role="tablist"
        className="flex shrink-0 items-center gap-1 border-b border-[var(--color-border-muted)] px-2 py-1.5"
      >
        {tabs.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={tab === active}
            onClick={() => setActive(tab)}
            className={
              'rounded px-2 py-1 text-[11px] font-semibold transition-colors ' +
              (tab === active
                ? 'bg-[var(--color-surface-overlay)] text-[var(--color-text-primary)]'
                : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]')
            }
          >
            {tab}
          </button>
        ))}
      </div>

      {error && (
        <div className="shrink-0 border-b border-[var(--color-border-muted)] px-3 py-1.5 text-[11px] text-[var(--color-danger)]">
          {error}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto text-xs text-[var(--color-text-secondary)]">
        {active === 'Changes' && (
          <ChangesTab
            sessionId={sessionId}
            diff={diff}
            loading={diffLoading}
            busy={busy}
            canUnrevert={canUnrevert}
            expanded={expanded}
            onToggle={(path) => setExpanded((cur) => (cur === path ? null : path))}
            onRevert={onRevert}
            onUnrevert={onUnrevert}
          />
        )}
        {active === 'Todos' && <TodosTab loading={todosLoading} todos={todos} />}
        {active === 'Telemetry' && <TelemetryTab telemetry={telemetry} />}
        {active === 'Artifacts' && <ArtifactsTab loading={diffLoading} diff={diff} />}
      </div>
    </div>
  );
}

interface ChangesTabProps {
  sessionId: string | null;
  diff: FileDiff[];
  loading: boolean;
  busy: boolean;
  canUnrevert: boolean;
  expanded: string | null;
  onToggle: (path: string) => void;
  onRevert: () => void;
  onUnrevert: () => void;
}

function ChangesTab({ sessionId, diff, loading, busy, canUnrevert, expanded, onToggle, onRevert, onUnrevert }: ChangesTabProps) {
  return (
    <div className="flex flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border-muted)] px-3 py-2">
        <button
          type="button"
          onClick={onRevert}
          disabled={!sessionId || busy}
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface-raised)] px-2 py-1 text-[11px] font-semibold text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)] disabled:opacity-40"
        >
          <RotateCcw className="h-3 w-3" />
          Revert last step
        </button>
        <button
          type="button"
          onClick={onUnrevert}
          disabled={!canUnrevert || busy}
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface-raised)] px-2 py-1 text-[11px] font-semibold text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)] disabled:opacity-40"
        >
          <Undo2 className="h-3 w-3" />
          Unrevert
        </button>
        {busy && <Loader2 className="h-3 w-3 animate-spin text-[var(--color-text-muted)]" />}
      </div>

      {/* Honesty note: no per-hunk accept is possible with this engine. */}
      <p className="border-b border-[var(--color-border-muted)] px-3 py-1.5 text-[10px] leading-snug text-[var(--color-text-muted)]">
        Post-hoc diff — opencode applies edits live. Per-hunk accept/reject is not available from the
        engine; Revert rewinds the session to just before its last message.
      </p>

      {loading ? (
        <Skeleton />
      ) : diff.length === 0 ? (
        <p className="p-4 text-center text-xs text-[var(--color-text-muted)]">No changes yet</p>
      ) : (
        <ul className="divide-y divide-[var(--color-border-muted)]">
          {diff.map((file) => (
            <li key={file.path}>
              <button
                type="button"
                onClick={() => onToggle(file.path)}
                aria-expanded={expanded === file.path}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-[var(--color-surface-overlay)]"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--color-text-primary)]" title={file.path}>
                  {file.path}
                </span>
                <span className="shrink-0 font-mono text-[10px]">
                  {file.additions != null && <span className="text-[var(--color-success)]">+{file.additions}</span>}
                  {file.deletions != null && <span className="ml-1 text-[var(--color-danger)]">−{file.deletions}</span>}
                  {file.additions == null && file.deletions == null && <span className="text-[var(--color-text-muted)]">—</span>}
                </span>
              </button>
              {expanded === file.path && (
                file.patch ? (
                  <pre className="max-h-80 overflow-auto border-t border-[var(--color-border-muted)] bg-[var(--color-bg-base)] px-3 py-2 font-mono text-[10px] leading-relaxed text-[var(--color-text-secondary)]">
                    {file.patch}
                  </pre>
                ) : (
                  <p className="border-t border-[var(--color-border-muted)] px-3 py-1.5 text-[10px] text-[var(--color-text-muted)]">
                    No patch available for this file.
                  </p>
                )
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TodosTab({ loading, todos }: { loading: boolean; todos: MissionTodo[] }) {
  if (loading) return <Skeleton />;
  if (todos.length === 0) {
    return <p className="p-4 text-center text-xs text-[var(--color-text-muted)]">No todos yet</p>;
  }
  return (
    <ul className="p-2">
      {todos.map((todo, i) => {
        const meta = (todo.status && TODO_STATUS[todo.status]) || { color: 'var(--color-text-muted)', mark: '○' };
        return (
          <li key={`${i}-${todo.content}`} className="flex items-start gap-2 px-1 py-1">
            <span className="mt-px w-3 shrink-0 text-center font-mono" style={{ color: meta.color }} aria-hidden="true">
              {meta.mark}
            </span>
            <span className="min-w-0 flex-1 break-words text-[var(--color-text-primary)]">{todo.content}</span>
            <span className="shrink-0 font-mono text-[10px]" style={{ color: meta.color }}>
              {todo.status ?? '—'}
            </span>
            {todo.priority && (
              <span className="shrink-0 font-mono text-[10px] text-[var(--color-text-muted)]">{todo.priority}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function TelemetryTab({ telemetry }: { telemetry: SessionTelemetry | null }) {
  const rows: Array<[string, string]> = [
    ['model', telemetry?.model ?? '—'],
    ['cost', telemetry?.cost == null ? '—' : `$${telemetry.cost.toFixed(4)}`],
    ['tokens in', dash(telemetry?.tokens?.input)],
    ['tokens out', dash(telemetry?.tokens?.output)],
    ['files changed', dash(telemetry?.filesChanged)],
    ['additions', dash(telemetry?.additions)],
    ['deletions', dash(telemetry?.deletions)],
  ];
  return (
    <dl className="p-3">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-center justify-between py-1">
          <dt className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">{label}</dt>
          <dd className="font-mono text-[11px] text-[var(--color-text-secondary)]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ArtifactsTab({ loading, diff }: { loading: boolean; diff: FileDiff[] }) {
  if (loading) return <Skeleton />;
  if (diff.length === 0) {
    return <p className="p-4 text-center text-xs text-[var(--color-text-muted)]">No artifacts yet</p>;
  }
  return (
    <ul className="divide-y divide-[var(--color-border-muted)]">
      {diff.map((file) => (
        <li key={file.path} className="flex items-center gap-2 px-3 py-1.5">
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--color-text-primary)]" title={file.path}>
            {file.path}
          </span>
          <span className="shrink-0 font-mono text-[10px] text-[var(--color-text-muted)]">
            {file.status ?? (file.additions != null || file.deletions != null ? `+${file.additions ?? 0} −${file.deletions ?? 0}` : '—')}
          </span>
        </li>
      ))}
    </ul>
  );
}
