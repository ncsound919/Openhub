// Pure per-hunk review state for the inline-edit (Ctrl/Cmd+I) flow.
//
// The model returns a full replacement for the selection. Rather than an
// all-or-nothing apply, the editor keeps a decision per hunk: the user accepts
// or rejects individual hunks and the buffer is reconstructed from the
// original + the accepted set. This module owns that state machine and the
// line ranges the editor paints (green = accepted, red = kept-original), so
// the logic is testable without Monaco or a DOM.
//
// Defaults preserve the historical behavior: a fresh review has every hunk
// accepted, so doing nothing applies the whole proposal.

import { applyHunks, computeHunks, diffLines, type ContentHunk } from './inlineDiff';

export interface HunkDecision {
  index: number;
  accepted: boolean;
  before: string[];
  after: string[];
}

export type HunkRangeKind = 'accepted' | 'rejected';

export interface HunkRange {
  index: number;
  accepted: boolean;
  kind: HunkRangeKind;
  /** 1-based line span in the reconstructed buffer. */
  startLineNumber: number;
  endLineNumber: number;
}

export interface InlineReview {
  original: string;
  proposed: string;
  hunks: ContentHunk[];
  accepted: Set<number>;
}

/** Build a review with every hunk accepted (current apply-all behavior). */
export function createInlineReview(original: string, proposed: string): InlineReview {
  const hunks = computeHunks(original, proposed);
  return { original, proposed, hunks, accepted: new Set(hunks.map((h) => h.index)) };
}

/** Accept or reject one hunk. Mutates and returns the review for chaining. */
export function decideHunk(review: InlineReview, index: number, accepted: boolean): InlineReview {
  if (accepted) review.accepted.add(index);
  else review.accepted.delete(index);
  return review;
}

export function isHunkAccepted(review: InlineReview, index: number): boolean {
  return review.accepted.has(index);
}

export function acceptedCount(review: InlineReview): number {
  return review.accepted.size;
}

export function allAccepted(review: InlineReview): boolean {
  return review.hunks.length > 0 && review.accepted.size === review.hunks.length;
}

export function reviewDecisions(review: InlineReview): HunkDecision[] {
  return review.hunks.map((h) => ({
    index: h.index,
    accepted: review.accepted.has(h.index),
    before: h.before,
    after: h.after,
  }));
}

/** The buffer the editor should hold for the current accepted set. */
export function reviewBuffer(review: InlineReview): string {
  if (allAccepted(review)) return review.proposed;
  return applyHunks(review.original, review.proposed, [...review.accepted]);
}

export function reviewOutcome(review: InlineReview): 'accepted' | 'rejected' | 'partial' {
  if (review.accepted.size === 0) return 'rejected';
  if (allAccepted(review)) return 'accepted';
  return 'partial';
}

export function reviewStatus(review: InlineReview): string {
  return `Axiom inline edit · ${acceptedCount(review)}/${review.hunks.length} hunks accepted`;
}

/**
 * The 1-based line spans each hunk occupies in the reconstructed buffer.
 * Accepted hunks cover their inserted lines; rejected hunks cover the original
 * lines they keep. Hunks that emit no lines (accepted deletion, rejected
 * insertion) are omitted — there is nothing to paint.
 */
export function reviewHunkRanges(review: InlineReview): HunkRange[] {
  const edits = diffLines(review.original, review.proposed);
  const out: HunkRange[] = [];
  let i = 0;
  let index = 0;
  let line = 1;
  while (i < edits.length) {
    if (edits[i].type === ' ') { line++; i++; continue; }
    const beforeLines: string[] = [];
    const afterLines: string[] = [];
    while (i < edits.length && edits[i].type !== ' ') {
      if (edits[i].type === '-') beforeLines.push(edits[i].line);
      else afterLines.push(edits[i].line);
      i++;
    }
    const accepted = review.accepted.has(index);
    const emitted = accepted ? afterLines : beforeLines;
    if (emitted.length > 0) {
      out.push({
        index,
        accepted,
        kind: accepted ? 'accepted' : 'rejected',
        startLineNumber: line,
        endLineNumber: line + emitted.length - 1,
      });
      line += emitted.length;
    }
    index++;
  }
  return out;
}
