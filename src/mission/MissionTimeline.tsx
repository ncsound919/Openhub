import type { MissionEvent } from '../lib/missionStore.js';

interface MissionTimelineProps {
  events: MissionEvent[];
}

/**
 * Ordered mission event log. Phase B stub: an empty state or a plain list of
 * `kind` / `text` with a local time. Phase C replaces this with the rich,
 * grouped timeline.
 */
export function MissionTimeline({ events }: MissionTimelineProps) {
  if (events.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-[var(--color-text-muted)]">
        No mission yet — describe a goal to begin.
      </div>
    );
  }

  return (
    <ol className="h-full min-h-0 space-y-1 overflow-y-auto p-3">
      {events.map((event, index) => (
        <li
          key={`${event.at}-${index}`}
          className="flex items-start gap-3 rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-base)] px-3 py-2"
        >
          <span className="shrink-0 font-mono text-[10px] text-[var(--color-text-muted)]">
            {new Date(event.at).toLocaleTimeString()}
          </span>
          <span className="shrink-0 font-mono text-[11px] font-semibold text-[var(--color-accent-text)]">
            {event.kind}
          </span>
          <span className="min-w-0 flex-1 break-words text-xs text-[var(--color-text-secondary)]">
            {event.text}
          </span>
        </li>
      ))}
    </ol>
  );
}
