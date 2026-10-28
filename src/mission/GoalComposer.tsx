import { useState, type KeyboardEvent } from 'react';
import { Play, Square, Sparkles } from 'lucide-react';

const QUICK_GOALS = [
  'Fix the failing tests and explain what changed',
  'Add unit tests for the changed code',
  'Refactor for readability without changing behavior',
  'Review the diff and list risks',
  'Update docs to match the code',
];

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
      <div className="flex flex-wrap gap-1.5">
        {QUICK_GOALS.map((g) => (
          <button
            key={g}
            type="button"
            onClick={() => setGoal(g)}
            className="inline-flex min-h-[36px] items-center gap-1 rounded-full border border-[var(--color-border-muted)] bg-[var(--color-surface-raised)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border-strong)] hover:text-[var(--color-text-secondary)] sm:min-h-0"
          >
            <Sparkles className="h-3 w-3 shrink-0" />
            {g}
          </button>
        ))}
      </div>
      <textarea
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Describe the mission…"
        aria-label="Mission goal"
        rows={3}
        className="w-full resize-none rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-base)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
      />
      <div className="flex items-center gap-2">
        {/* Fill is the light accent variant so the dark label clears WCAG AA:
            text-bg-base on accent is 4.16:1 (fail); on accent-text it is 7.0:1. */}
        <button
          type="button"
          onClick={submit}
          disabled={disabled}
          className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md bg-[var(--color-accent-text)] px-3 py-1.5 text-xs font-semibold text-[var(--color-bg-base)] transition-colors hover:bg-[var(--color-accent-hover)] disabled:opacity-40 sm:min-h-0"
        >
          <Play className="h-3.5 w-3.5" />
          Run
        </button>
        {canStop && (
          <button
            type="button"
            onClick={onStop}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface-raised)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)] sm:min-h-0"
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
