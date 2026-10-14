import { useMemo } from 'react';
import type { Mission } from '../lib/missionStore.js';
import { StatusPill } from './StatusPill';

export interface MissionRailProps {
  missions: Mission[];
  activeId: string | null;
  onSelect: (id: string) => void;
  /** Show skeleton rows while the mission list is loading. */
  loading?: boolean;
}

/** Compact relative age for a rail row: `now`, `12s`, `5m`, `2h`, `3d`. */
export function formatAge(createdAt: string): string {
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return '—';
  const secs = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (secs < 5) return 'now';
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Left rail: one row per mission, newest first. Running rows carry an accent
 * highlight; the active row gets a selected treatment. It is a rail, not a
 * board — no filters, no columns.
 */
export function MissionRail({ missions, activeId, onSelect, loading = false }: MissionRailProps) {
  const ordered = useMemo(
    () => [...missions].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
    [missions],
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-[var(--color-surface-base)]">
      <div className="flex shrink-0 items-center justify-between border-b border-[var(--color-border-muted)] px-3 py-2.5">
        <h2 className="text-balance text-xs font-semibold text-[var(--color-text-primary)]">Missions</h2>
        <span className="rounded-full border border-[var(--color-border-muted)] bg-[var(--color-surface-overlay)] px-2 py-0.5 font-mono text-[10px] text-[var(--color-text-secondary)]">
          {missions.length}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loading ? (
          <ul aria-hidden="true" className="space-y-1.5">
            {[0, 1, 2].map((i) => (
              <li
                key={i}
                className="h-12 rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-raised)] motion-safe:animate-pulse"
              />
            ))}
          </ul>
        ) : ordered.length === 0 ? (
          <p className="text-balance px-2 py-6 text-center text-xs text-[var(--color-text-muted)]">No missions yet</p>
        ) : (
          <ul className="space-y-1">
            {ordered.map((m) => {
              const active = m.id === activeId;
              const running = m.status === 'running';
              const rowClass = active
                ? 'border-[var(--color-accent)] bg-[var(--color-surface-overlay)]'
                : running
                  ? 'border-[var(--color-border-muted)] bg-[color-mix(in_srgb,var(--color-accent)_8%,transparent)] hover:bg-[var(--color-surface-hover)]'
                  : 'border-transparent hover:border-[var(--color-border-muted)] hover:bg-[var(--color-surface-hover)]';
              return (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(m.id)}
                    aria-current={active ? 'true' : undefined}
                    className={
                      'flex w-full flex-col gap-1 rounded-md border px-2.5 py-2 text-left transition-colors ' +
                      rowClass
                    }
                  >
                    <span className="flex items-center gap-2">
                      <StatusPill status={m.status} size="sm" pulse={running} />
                      <span className="ml-auto shrink-0 font-mono text-[10px] text-[var(--color-text-muted)]">
                        {formatAge(m.createdAt)}
                      </span>
                    </span>
                    <span
                      className={
                        'truncate text-xs ' +
                        (active || running
                          ? 'text-[var(--color-text-primary)]'
                          : 'text-[var(--color-text-secondary)]')
                      }
                    >
                      {m.goal}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
