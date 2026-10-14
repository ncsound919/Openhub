import type { MissionEvent } from '../lib/missionStore.js';

interface MissionTimelineProps {
  events: MissionEvent[];
}

/** One rendered step: a header plus the events that belong to it. */
export interface MissionStep {
  index: number;
  taskId?: string;
  heading: string;
  events: MissionEvent[];
}

/** A "plan"-ish kind announces a new phase of work. Heuristic — see below. */
function isPlanish(kind: string): boolean {
  return /plan|todo|task/i.test(kind);
}

/**
 * Group a flat event log into steps.
 *
 * HEURISTIC (UNVERIFIED until live events are seen): a new step starts when an
 * event carries a *new* `taskId`, or when the event's `kind` transitions into a
 * plan-ish kind. Otherwise the event joins the current step. With no `taskId`
 * at all and no plan transition, every event lands in a single step. This is a
 * best-effort reading of an event shape that has not been captured from a live
 * engine; it never throws and unknown kinds simply stay put.
 */
export function groupEventsIntoSteps(events: MissionEvent[]): MissionStep[] {
  const steps: MissionStep[] = [];
  let current: MissionStep | null = null;
  for (const event of events) {
    const prevKind = current && current.events.length > 0 ? current.events[current.events.length - 1].kind : undefined;
    const taskChanged = event.taskId != null && event.taskId !== current?.taskId;
    const intoPlanish = isPlanish(event.kind) && !(prevKind != null && isPlanish(prevKind));
    if (!current || taskChanged || intoPlanish) {
      current = {
        index: steps.length,
        ...(event.taskId != null ? { taskId: event.taskId } : {}),
        heading: event.taskId ?? `Step ${steps.length + 1}`,
        events: [],
      };
      steps.push(current);
    }
    current.events.push(event);
  }
  return steps;
}

/**
 * A friendlier step heading for display: a raw engine `taskId` (e.g.
 * `task_abc123`) becomes `Task abc123`'s tail, while synthetic steps keep their
 * own heading. `full` carries the untruncated value for the `title` attribute.
 */
export function stepLabel(step: MissionStep): { label: string; full: string } {
  if (step.taskId) {
    return { label: `Task ${step.taskId.slice(-4)}`, full: step.taskId };
  }
  return { label: step.heading, full: step.heading };
}

/**
 * Ordered mission event log, grouped into steps. Each event shows its local
 * time, `kind` and text. If there are no events, a calm empty state is shown.
 */
export function MissionTimeline({ events }: MissionTimelineProps) {
  if (events.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-balance text-sm text-[var(--color-text-muted)]">
        No mission yet — describe a goal to begin.
      </div>
    );
  }

  const steps = groupEventsIntoSteps(events);
  const latest = events[events.length - 1];
  const note = 'Step grouping is heuristic — refined once live event shapes are verified.';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p id="mission-steps-note" className="sr-only">
        {note}
      </p>
      {/* Only the newest event is announced; the list itself is not a live region,
          so appending does not re-read the whole timeline. */}
      <span role="status" aria-live="polite" className="sr-only">
        {latest ? `${latest.kind}: ${latest.text}` : ''}
      </span>
      <ol
        aria-describedby="mission-steps-note"
        title={note}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3"
      >
        {steps.map((step) => {
          const { label, full } = stepLabel(step);
          return (
            <li
              key={step.index}
              className="overflow-hidden rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-base)]"
            >
              <div className="flex items-center gap-2 border-b border-[var(--color-border-muted)] px-3 py-1.5">
                <span className="font-mono text-[10px] text-[var(--color-text-muted)]">
                  {String(step.index + 1).padStart(2, '0')}
                </span>
                <span
                  className="min-w-0 flex-1 truncate text-[11px] font-semibold text-[var(--color-text-primary)]"
                  title={full}
                >
                  {label}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-[var(--color-text-muted)]">{step.events.length}</span>
              </div>
              <ul className="space-y-1 p-2">
                {step.events.map((event, index) => (
                  <li key={`${event.at}-${index}`} className="flex items-start gap-3 px-1 py-0.5">
                    <span className="shrink-0 font-mono text-[10px] text-[var(--color-text-muted)]">
                      {new Date(event.at).toLocaleTimeString()}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] font-semibold text-[var(--color-accent-text)]">
                      {event.kind}
                    </span>
                    <span className="min-w-0 flex-1 break-words text-pretty text-xs text-[var(--color-text-secondary)]">
                      {event.text}
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
