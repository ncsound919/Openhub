/**
 * Pure logic behind AgentDock's diff-review keyboard control and hunk
 * selection. Kept free of React/DOM so the scheme is unit-testable and can be
 * shared with the multibuffer panel (which uses the same j/k/space/a/r keys).
 */

export interface ReviewHunkRef {
  path: string;
  index: number;
}

export interface ReviewFileLike {
  path: string;
  hunks: Array<{ index: number }>;
}

/** Stable key for a hunk, used to track the keyboard cursor. */
export function hunkKey(path: string, index: number): string {
  return `${path}#${index}`;
}

/** Flatten a review's files into one ordered hunk list for linear navigation. */
export function flattenHunks(files: ReviewFileLike[]): ReviewHunkRef[] {
  const out: ReviewHunkRef[] = [];
  for (const f of files) for (const h of f.hunks) out.push({ path: f.path, index: h.index });
  return out;
}

/** Keep a cursor inside `[0, len)`; -1 when there is nothing to focus. */
export function clampFocus(len: number, focus: number): number {
  if (len <= 0) return -1;
  if (focus < 0) return 0;
  if (focus >= len) return len - 1;
  return focus;
}

export function moveFocus(len: number, focus: number, delta: number): number {
  return clampFocus(len, focus + delta);
}

export function isHunkSelected(sel: Record<string, number[]> | undefined, path: string, index: number): boolean {
  return Array.isArray(sel?.[path]) && (sel as Record<string, number[]>)[path].includes(index);
}

/** Immutably set a hunk's selected state, keeping indices sorted. */
export function setHunkSelected(
  sel: Record<string, number[]> | undefined,
  path: string,
  index: number,
  on: boolean,
): Record<string, number[]> {
  const current = new Set(sel?.[path] ?? []);
  if (on) current.add(index);
  else current.delete(index);
  return { ...(sel ?? {}), [path]: [...current].sort((a, b) => a - b) };
}

export type ReviewKeyAction = 'next' | 'prev' | 'toggle' | 'accept' | 'reject' | 'apply' | 'none';

/** Map a keydown to a review action. Mirrors MultibufferReviewPanel:
 *  j/k (or arrows) navigate, space/x toggle, a accept, r reject, Enter apply. */
export function reviewKeyAction(key: string): ReviewKeyAction {
  switch (key) {
    case 'j':
    case 'ArrowDown':
      return 'next';
    case 'k':
    case 'ArrowUp':
      return 'prev';
    case ' ':
    case 'x':
      return 'toggle';
    case 'a':
      return 'accept';
    case 'r':
      return 'reject';
    case 'Enter':
      return 'apply';
    default:
      return 'none';
  }
}

export interface SelectionSummary {
  files: number;
  totalHunks: number;
  selectedHunks: number;
}

/** Summarise a review's selection for a status line / disabled state. */
export function summarizeSelection(
  files: ReviewFileLike[],
  sel: Record<string, number[]> | undefined,
): SelectionSummary {
  let totalHunks = 0;
  let selectedHunks = 0;
  for (const f of files) {
    totalHunks += f.hunks.length;
    for (const h of f.hunks) if (isHunkSelected(sel, f.path, h.index)) selectedHunks += 1;
  }
  return { files: files.length, totalHunks, selectedHunks };
}
