/**
 * Mission-list shape normalization.
 *
 * Axiom's `GET /api/mission/list` reports `tasks` as a COUNT (`tasks: number`,
 * `done: number`); some client paths and older payloads carried the full task
 * array. Code that assumed the array produced "m.tasks.map is not a function"
 * and took down the whole workspace panel, so every consumer normalizes here
 * instead of trusting one shape.
 */
export interface MissionTaskRow {
  id: string;
  label: string;
  status: string;
  subagentRole?: string;
  costUsd?: number | null;
}

export interface MissionView {
  id: string;
  goal: string;
  status: string;
  pendingPlan?: Array<{ label: string; dependsOn: string[] }>;
  tasks?: number | MissionTaskRow[];
  done?: number;
}

/** The task rows, or [] when the payload only carried a count. */
export function taskRows(m: MissionView): MissionTaskRow[] {
  return Array.isArray(m.tasks) ? m.tasks : [];
}

/** The task count, whether `tasks` is a number or an array. */
export function taskTotal(m: MissionView): number {
  return Array.isArray(m.tasks) ? m.tasks.length : Number(m.tasks) || 0;
}
