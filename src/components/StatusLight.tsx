import { cn } from '../lib/utils';

/** Shared status vocabulary so a "light" means the same thing everywhere. */
export type LightState = 'idle' | 'working' | 'ok' | 'warn' | 'error' | 'offline';

const TONE: Record<LightState, { color: string; label: string }> = {
  idle: { color: 'var(--color-text-muted)', label: 'idle' },
  working: { color: 'var(--color-accent)', label: 'working' },
  ok: { color: 'var(--color-success)', label: 'done' },
  warn: { color: 'var(--color-warning)', label: 'warning' },
  error: { color: 'var(--color-danger)', label: 'failed' },
  offline: { color: 'var(--color-text-muted)', label: 'offline' },
};

/**
 * A small state light with a glow + pulse. `working` pulses; `idle`/`offline`
 * stay flat so motion always means "something is happening right now", which is
 * the whole point of the indicator.
 */
export function StatusLight({
  state,
  label,
  title,
  className,
  dotOnly = false,
}: {
  state: LightState;
  label?: string;
  title?: string;
  className?: string;
  dotOnly?: boolean;
}) {
  const tone = TONE[state];
  const glowing = state !== 'idle' && state !== 'offline';
  return (
    <span
      className={cn('inline-flex min-w-0 items-center gap-1.5', className)}
      title={title ?? label ?? tone.label}
      role="status"
      aria-label={label ?? tone.label}
    >
      <span className="relative flex h-2 w-2 shrink-0" aria-hidden>
        {state === 'working' && (
          <span
            className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-70"
            style={{ backgroundColor: tone.color }}
          />
        )}
        <span
          className="relative inline-flex h-2 w-2 rounded-full"
          style={{ backgroundColor: tone.color, boxShadow: glowing ? `0 0 6px ${tone.color}` : 'none' }}
        />
      </span>
      {!dotOnly && label && (
        <span className="min-w-0 truncate text-[10px] font-semibold" style={{ color: tone.color }}>
          {label}
        </span>
      )}
    </span>
  );
}
