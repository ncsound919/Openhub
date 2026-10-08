import { useEffect, useState } from 'react';
import type { Mission } from '../lib/missionStore.js';
import type { SessionTelemetry } from './useMission.js';
import { StatusPill } from './StatusPill';

/** Format a duration in ms as `mm:ss`, or `h:mm:ss` past the hour. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/**
 * Live elapsed time since `createdAt`, ticking once per second. Returns `—`
 * when there is no valid timestamp. Text updates are data, not decoration, so
 * they are not gated on reduced motion.
 */
export function useElapsed(createdAt: string | undefined | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!createdAt) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [createdAt]);
  if (!createdAt) return '—';
  const start = Date.parse(createdAt);
  if (Number.isNaN(start)) return '—';
  return formatElapsed(now - start);
}

export interface MissionStatusHeaderProps {
  mission: Mission | null;
  session?: SessionTelemetry | null;
}

/**
 * Header strip for the active mission: state pill, one-line goal, elapsed time
 * and model. With no active mission it renders a calm empty header rather than
 * a blank or an error.
 */
export function MissionStatusHeader({ mission, session }: MissionStatusHeaderProps) {
  // Hooks must run unconditionally, before any early return.
  const elapsed = useElapsed(mission?.createdAt);

  if (!mission) {
    return (
      <div className="flex shrink-0 items-center border-b border-[var(--color-border-muted)] px-4 py-2.5">
        <span className="text-xs text-[var(--color-text-muted)]">No active mission</span>
      </div>
    );
  }

  const model = session?.model ?? 'default';

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-[var(--color-border-muted)] px-4 py-2.5">
      <StatusPill status={mission.status} pulse={mission.status === 'running'} />
      <p className="min-w-0 flex-1 truncate text-sm text-[var(--color-text-primary)]" title={mission.goal}>
        {mission.goal}
      </p>
      <span className="inline-flex items-center gap-1.5">
        <span className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">elapsed</span>
        <span className="font-mono text-xs text-[var(--color-text-secondary)]" aria-label="elapsed time">
          {elapsed}
        </span>
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">model</span>
        <span className="max-w-[12rem] truncate font-mono text-xs text-[var(--color-text-secondary)]" title={model}>
          {model}
        </span>
      </span>
    </div>
  );
}
