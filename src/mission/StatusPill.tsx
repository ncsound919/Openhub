import type { MissionStatus } from '../lib/missionStore.js';

/**
 * The single source of truth for mission-state color. Semantic tokens only,
 * one locked accent for the running state. Used by both the status header and
 * the missions rail so the two can never disagree about a status's color.
 */
type Tone = 'neutral' | 'accent' | 'warning' | 'success' | 'danger';

const TONE_CLASS: Record<Tone, string> = {
  neutral:
    'border-[var(--color-border-strong)] bg-[var(--color-surface-overlay)] text-[var(--color-text-secondary)]',
  accent:
    'border-[color-mix(in_srgb,var(--color-accent)_45%,transparent)] bg-[color-mix(in_srgb,var(--color-accent)_16%,transparent)] text-[var(--color-accent-text)]',
  warning:
    'border-[color-mix(in_srgb,var(--color-warning)_45%,transparent)] bg-[color-mix(in_srgb,var(--color-warning)_14%,transparent)] text-[var(--color-warning)]',
  success:
    'border-[color-mix(in_srgb,var(--color-success)_45%,transparent)] bg-[color-mix(in_srgb,var(--color-success)_14%,transparent)] text-[var(--color-success)]',
  danger:
    'border-[color-mix(in_srgb,var(--color-danger)_45%,transparent)] bg-[color-mix(in_srgb,var(--color-danger)_14%,transparent)] text-[var(--color-danger)]',
};

function toneFor(status: MissionStatus): Tone {
  switch (status) {
    case 'running':
      return 'accent';
    case 'review':
      return 'warning';
    case 'done':
      return 'success';
    case 'failed':
      return 'danger';
    default:
      return 'neutral'; // draft, planned
  }
}

export interface StatusPillProps {
  status: MissionStatus;
  size?: 'sm' | 'md';
  /** Render a subtle pulse (used for `running`). Disabled under reduced motion. */
  pulse?: boolean;
}

export function StatusPill({ status, size = 'md', pulse = false }: StatusPillProps) {
  const sizing = size === 'sm' ? 'px-1.5 py-0.5 text-[9px]' : 'px-2.5 py-1 text-[11px]';
  return (
    <span
      className={
        'inline-flex items-center gap-1.5 rounded-full border font-semibold uppercase tracking-wide ' +
        sizing +
        ' ' +
        TONE_CLASS[toneFor(status)]
      }
    >
      {pulse && (
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-current animate-pulse motion-reduce:animate-none"
        />
      )}
      {status}
    </span>
  );
}
