// Pure model for the multibuffer review surface.
//
// Zed's "multibuffer" shows many excerpts from many files in one continuous
// buffer that you review in a single pass. OpenHub's AgentDock already reviews
// one proposal's files as separate <details> blocks; this module flattens every
// pending proposal into one ordered row list plus a selection model, so the UI
// can render a single keyboard-driven buffer and reuse the existing
// `/api/axiom/review/:id/apply-hunks` contract.
//
// Kept free of React/DOM so the ordering + selection logic is unit-testable.

export interface ReviewHunk {
  index: number;
  before: string[];
  after: string[];
}

export interface ReviewFile {
  path: string;
  action: string;
  hunks: ReviewHunk[];
}

export interface ReviewProposal {
  id: string;
  status: string;
  files: ReviewFile[];
}

export interface ReviewQueueItem {
  id: string;
  status: string;
  fileCount: number;
}

export interface MultibufferRow {
  /** Stable row identity for React keys and active-row tracking. */
  key: string;
  proposalId: string;
  path: string;
  action: string;
  hunkIndex: number;
  before: string[];
  after: string[];
}

const rowKey = (proposalId: string, path: string, hunkIndex: number): string => `${proposalId}::${path}::${hunkIndex}`;

/** Flatten every proposal's files/hunks into one ordered buffer. Files keep
 *  their order within a proposal (and proposals keep the order given). */
export function flattenReview(proposals: ReviewProposal[]): MultibufferRow[] {
  const rows: MultibufferRow[] = [];
  for (const p of proposals) {
    if (!p || !Array.isArray(p.files)) continue;
    for (const f of p.files) {
      if (!f || !Array.isArray(f.hunks)) continue;
      for (const h of f.hunks) {
        rows.push({
          key: rowKey(p.id, f.path, h.index),
          proposalId: p.id,
          path: f.path,
          action: f.action,
          hunkIndex: h.index,
          before: Array.isArray(h.before) ? h.before : [],
          after: Array.isArray(h.after) ? h.after : [],
        });
      }
    }
  }
  return rows;
}

/** proposalId -> path -> accepted hunk indices. */
export type ReviewSelection = Record<string, Record<string, number[]>>;

/** Every hunk accepted by default (the safe-to-apply starting point). */
export function defaultSelection(proposals: ReviewProposal[]): ReviewSelection {
  const sel: ReviewSelection = {};
  for (const p of proposals) {
    const byPath: Record<string, number[]> = {};
    for (const f of p.files ?? []) byPath[f.path] = (f.hunks ?? []).map((h) => h.index);
    sel[p.id] = byPath;
  }
  return sel;
}

export function isHunkAccepted(sel: ReviewSelection, proposalId: string, path: string, index: number): boolean {
  return (sel[proposalId]?.[path] ?? []).includes(index);
}

export function toggleHunk(sel: ReviewSelection, proposalId: string, path: string, index: number): ReviewSelection {
  const forProposal = sel[proposalId] ?? {};
  const current = new Set(forProposal[path] ?? []);
  if (current.has(index)) current.delete(index);
  else current.add(index);
  return { ...sel, [proposalId]: { ...forProposal, [path]: [...current].sort((a, b) => a - b) } };
}

/** Accept-all / reject-all for one file's hunks. */
export function setFileHunks(
  sel: ReviewSelection,
  proposalId: string,
  path: string,
  hunkIndices: number[],
  all: boolean,
): ReviewSelection {
  const forProposal = sel[proposalId] ?? {};
  return { ...sel, [proposalId]: { ...forProposal, [path]: all ? [...hunkIndices].sort((a, b) => a - b) : [] } };
}

/** The payload `/apply-hunks` expects for one proposal. A file whose hunks are
 *  all accepted sends `'all'`; otherwise the explicit index list. */
export function selectionPayload(proposal: ReviewProposal, sel: ReviewSelection): Array<{ path: string; hunks: number[] | 'all' | 'none' }> {
  return (proposal.files ?? []).map((f) => {
    const selected = sel[proposal.id]?.[f.path] ?? [];
    const selection: number[] | 'all' | 'none' =
      f.hunks.length > 0 && selected.length === f.hunks.length ? 'all' : selected;
    return { path: f.path, hunks: selection };
  });
}

/** Accepted / total hunk counts across all proposals (for the header readout). */
export function summary(proposals: ReviewProposal[], sel: ReviewSelection): { accepted: number; total: number } {
  let accepted = 0;
  let total = 0;
  for (const p of proposals) {
    for (const f of p.files ?? []) {
      for (const h of f.hunks ?? []) {
        total += 1;
        if (isHunkAccepted(sel, p.id, f.path, h.index)) accepted += 1;
      }
    }
  }
  return { accepted, total };
}

/** Index of the next/previous row for keyboard navigation, clamped. */
export function stepRow(count: number, current: number, delta: number): number {
  if (count <= 0) return 0;
  const next = current + delta;
  return Math.max(0, Math.min(count - 1, next));
}
