import { useState, type KeyboardEvent } from 'react';
import { Play, Square } from 'lucide-react';

interface GoalComposerProps {
  engineOnline: boolean;
  onSubmit: (goal: string) => void;
  busy?: boolean;
  /** Show a Stop control (mission is planned/running). */
  canStop?: boolean;
  /** Invoked when Stop is pressed. */
  onStop?: () => void;
}

/**
 * The single primary input for Mission Control: one goal and one primary Run.
 * Run hands the trimmed goal to `onSubmit`. (There is no Plan button: the
 * plan-gate is a Phase C lane and must not be faked.) Disabled while the engine
 * is down, a run is in flight, or the goal is empty. A Stop control appears
 * while a mission is planned or running.
 */
export function GoalComposer({ engineOnline, onSubmit, busy = false, canStop = false, onStop }: GoalComposerProps) {
  const [goal, setGoal] = useState('');
  const trimmed = goal.trim();
  const disabled = !engineOnline || busy || !trimmed;

  const submit = () => {
    if (disabled) return;
    onSubmit(trimmed);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <textarea
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Describe the mission…"
        aria-label="Mission goal"
        rows={3}
        className="w-full resize-none rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-base)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={disabled}
          className="inline-flex items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-semibold text-[var(--color-bg-base)] transition-colors hover:bg-[var(--color-accent-hover)] disabled:opacity-40"
        >
          <Play className="h-3.5 w-3.5" />
          Run
        </button>
        {canStop && (
          <button
            type="button"
            onClick={onStop}
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface-raised)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)]"
          >
            <Square className="h-3.5 w-3.5" />
            Stop
          </button>
        )}
        <span className="ml-auto font-mono text-[10px] text-[var(--color-text-muted)]">⌘/Ctrl+Enter to run</span>
      </div>
    </div>
  );
}
