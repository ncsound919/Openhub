/**
 * Plan-mode task extraction.
 *
 * The opencode `plan` agent returns a normal assistant reply; it does not write
 * the session todo list (verified against 1.19.4 with the local Qwen model). To
 * show an approvable checklist before execution we parse the plan's own list.
 * When the build agent later calls `todowrite`, those todos are authoritative.
 *
 * This is deliberately tolerant and never invents tasks: only numbered/bulleted
 * lines become rows, a line with no readable content is skipped, and duplicates
 * are dropped.
 */

export type PlanTaskStatus = 'pending' | 'in_progress' | 'done';

export interface PlanTask {
  id: string;
  content: string;
  status: PlanTaskStatus;
}

export interface TodoLike {
  content: string;
  status?: string;
  priority?: string;
}

const LIST_ITEM = /^(?:[-*+]|\d+[.)])\s+(.*)$/;
const STEP_ITEM = /^step\s+\d+\s*[:.)-]\s+(.*)$/i;

function cleanTask(raw: string): { content: string; done: boolean } {
  let value = raw.trim();
  let done = false;
  // Checkbox / completion marker before or after the numbering.
  if (/^\[[xX]\]\s*/.test(value) || /^[✅☑✔]\s*/.test(value)) {
    done = true;
    value = value.replace(/^\[[xX]\]\s*/, '').replace(/^[✅☑✔]\s*/, '');
  }
  value = value.replace(/^\[[ ]\]\s*/, '');
  // Markdown emphasis and inline code markers are noise in a checklist.
  value = value.replace(/\*\*/g, '').replace(/__/g, '').replace(/`/g, '');
  value = value.replace(/\s+/g, ' ').trim();
  value = value.replace(/[.;:,]\s*$/, '').trim();
  return { content: value, done };
}

/**
 * Extract the ordered checklist from a plan reply. A plan that is prose only
 * yields [] — the transcript still shows the plan and the approval button.
 */
export function planTasksFromText(raw: string, limit = 12): PlanTask[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  const tasks: PlanTask[] = [];
  const seen = new Set<string>();
  for (const line of raw.replace(/\r\n/g, '\n').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('```')) continue;
    const match = LIST_ITEM.exec(trimmed) ?? STEP_ITEM.exec(trimmed);
    if (!match) continue;
    const { content, done } = cleanTask(match[1] ?? '');
    if (!content || content.length < 3) continue;
    if (/^(plan|todo list|steps?|numbered plan)\b[:\s]*$/i.test(content)) continue;
    if (/^plan created\b/i.test(content)) continue;
    const key = content.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tasks.push({ id: `plan-${tasks.length}`, content, status: done ? 'done' : 'pending' });
    if (tasks.length >= limit) break;
  }
  return tasks;
}

/** Normalize the engine's todo list into the same checklist rows. */
export function planTasksFromTodos(todos: TodoLike[]): PlanTask[] {
  if (!Array.isArray(todos)) return [];
  const out: PlanTask[] = [];
  for (const todo of todos) {
    const content = typeof todo?.content === 'string' ? todo.content.trim() : '';
    if (!content) continue;
    const raw = (todo.status ?? '').toLowerCase();
    const status: PlanTaskStatus =
      raw === 'done' || raw === 'completed' ? 'done'
        : raw === 'in_progress' || raw === 'in-progress' || raw === 'running' ? 'in_progress'
          : 'pending';
    out.push({ id: `todo-${out.length}`, content, status });
  }
  return out;
}
