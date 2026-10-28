import { addMessage, listEnabledWatches, setWatchState } from './store';
import { executeTool } from './tools';
import { publish } from './events';

/**
 * Live fleet watcher. One probe per tick serves every watching session; a
 * message is written only when the state actually changed. The first tick is a
 * baseline, not a notification.
 */

export interface FleetState {
  online: number;
  degraded: number;
  offline: number;
  unknown: number;
  total: number;
  enabledJobs: number;
  totalJobs: number;
  failingJobs: number;
  runsOk: number;
  runsError: number;
}

export function fleetStateFrom(data: unknown): FleetState {
  const overview = (data as { overview?: Record<string, unknown> } | null)?.overview ?? {};
  const health = (overview.health ?? {}) as Record<string, unknown>;
  const jobs = (overview.jobs ?? {}) as Record<string, unknown>;
  const runs = (overview.runs24h ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
  };
  return {
    online: n(health.online),
    degraded: n(health.degraded),
    offline: n(health.offline),
    unknown: n(health.unknown),
    total: n(overview.total),
    enabledJobs: n(jobs.enabled),
    totalJobs: n(jobs.total),
    failingJobs: n(jobs.failing),
    runsOk: n(runs.ok),
    runsError: n(runs.error),
  };
}

/** Human sentences for meaningful changes only. */
export function diffFleetState(prev: FleetState, next: FleetState): string[] {
  const changes: string[] = [];
  if (next.offline > prev.offline) changes.push(`${next.offline} service(s) offline (was ${prev.offline}).`);
  if (next.offline < prev.offline) changes.push(`${prev.offline - next.offline} service(s) back online.`);
  if (next.degraded !== prev.degraded) changes.push(`${next.degraded} degraded (was ${prev.degraded}).`);
  if (next.failingJobs !== prev.failingJobs) {
    changes.push(`${next.failingJobs} failing job(s) (was ${prev.failingJobs}).`);
  }
  if (next.runsError > prev.runsError) {
    changes.push(`${next.runsError - prev.runsError} new failed run(s) in 24h.`);
  }
  if (next.enabledJobs !== prev.enabledJobs) {
    changes.push(`${next.enabledJobs}/${next.totalJobs} jobs enabled (was ${prev.enabledJobs}/${prev.totalJobs}).`);
  }
  return changes;
}

let timer: ReturnType<typeof setInterval> | null = null;

async function tick(): Promise<void> {
  const watches = listEnabledWatches();
  if (watches.length === 0) return;
  const result = await executeTool('fleet.status', {}, process.env);
  if (!result.ok) return;
  const next = fleetStateFrom(result.data);
  const at = new Date().toISOString();

  for (const watch of watches) {
    if (!watch.lastState) {
      setWatchState(watch.sessionId, next as unknown as Record<string, unknown>);
      continue;
    }
    const prev = watch.lastState as unknown as FleetState;
    const changes = diffFleetState(prev, next);
    if (changes.length > 0) {
      const text = `Live update — ${changes.join(' ')} (checked ${at}).`;
      addMessage(watch.sessionId, 'assistant', text);
      publish(watch.sessionId, 'watch.event', { text, at, state: next });
    }
    setWatchState(watch.sessionId, next as unknown as Record<string, unknown>);
  }
}

export function startHarnessWatcher(intervalMs = 60_000): () => void {
  if (timer) return () => undefined;
  timer = setInterval(() => {
    void tick().catch(() => {
      /* a failed tick is silent; the next one retries */
    });
  }, intervalMs);
  timer.unref?.();
  return () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
}

/** Test seam. */
export async function runWatchTick(): Promise<void> {
  await tick();
}
