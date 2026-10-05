// Unit tests for the pure per-hunk inline-edit review state
// (src/ide/inlineReview.ts): defaults, hunk decisions, buffer reconstruction
// and the line ranges the editor paints.
import { describe, it, expect } from 'vitest';
import {
  createInlineReview,
  decideHunk,
  isHunkAccepted,
  acceptedCount,
  allAccepted,
  reviewDecisions,
  reviewBuffer,
  reviewOutcome,
  reviewHunkRanges,
  reviewStatus,
} from '../src/ide/inlineReview';
import { applyHunks } from '../src/ide/inlineDiff';

const BEFORE = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n';
const AFTER = 'a\nB\nc\nd\ne\nf\ng\nh\nI\nj\n';

describe('createInlineReview', () => {
  it('accepts every hunk by default (apply-all preserved)', () => {
    const r = createInlineReview(BEFORE, AFTER);
    expect(r.hunks).toHaveLength(2);
    expect(allAccepted(r)).toBe(true);
    expect(acceptedCount(r)).toBe(2);
    expect(reviewBuffer(r)).toBe(AFTER);
  });

  it('is not "all accepted" when there are no hunks', () => {
    const r = createInlineReview('same', 'same');
    expect(r.hunks).toHaveLength(0);
    expect(allAccepted(r)).toBe(false);
    expect(reviewBuffer(r)).toBe('same');
  });
});

describe('decideHunk', () => {
  it('rejects and re-accepts a single hunk', () => {
    const r = createInlineReview(BEFORE, AFTER);
    decideHunk(r, 0, false);
    expect(isHunkAccepted(r, 0)).toBe(false);
    expect(acceptedCount(r)).toBe(1);
    expect(reviewBuffer(r)).toBe(applyHunks(BEFORE, AFTER, [1]));
    decideHunk(r, 0, true);
    expect(reviewBuffer(r)).toBe(AFTER);
  });

  it('rejecting all hunks restores the original', () => {
    const r = createInlineReview(BEFORE, AFTER);
    decideHunk(r, 0, false);
    decideHunk(r, 1, false);
    expect(reviewBuffer(r)).toBe(BEFORE);
    expect(reviewOutcome(r)).toBe('rejected');
  });

  it('reports the outcome for each decision set', () => {
    const r = createInlineReview(BEFORE, AFTER);
    expect(reviewOutcome(r)).toBe('accepted');
    decideHunk(r, 0, false);
    expect(reviewOutcome(r)).toBe('partial');
    decideHunk(r, 1, false);
    expect(reviewOutcome(r)).toBe('rejected');
  });
});

describe('reviewDecisions', () => {
  it('mirrors the before/after lines and the current decisions', () => {
    const r = createInlineReview(BEFORE, AFTER);
    decideHunk(r, 1, false);
    expect(reviewDecisions(r)).toEqual([
      { index: 0, accepted: true, before: ['b'], after: ['B'] },
      { index: 1, accepted: false, before: ['i'], after: ['I'] },
    ]);
  });
});

describe('reviewHunkRanges', () => {
  it('maps accepted hunks to their inserted line spans', () => {
    const r = createInlineReview(BEFORE, AFTER);
    expect(reviewHunkRanges(r)).toEqual([
      { index: 0, accepted: true, kind: 'accepted', startLineNumber: 2, endLineNumber: 2 },
      { index: 1, accepted: true, kind: 'accepted', startLineNumber: 9, endLineNumber: 9 },
    ]);
  });

  it('marks rejected hunks over the original lines they keep', () => {
    const r = createInlineReview(BEFORE, AFTER);
    decideHunk(r, 0, false);
    expect(reviewHunkRanges(r)[0]).toEqual({
      index: 0, accepted: false, kind: 'rejected', startLineNumber: 2, endLineNumber: 2,
    });
  });

  it('omits hunks that emit no lines', () => {
    const insertion = createInlineReview('a\nb\n', 'a\nnew\nb\n');
    expect(reviewHunkRanges(insertion)).toEqual([
      { index: 0, accepted: true, kind: 'accepted', startLineNumber: 2, endLineNumber: 2 },
    ]);
    decideHunk(insertion, 0, false);
    expect(reviewHunkRanges(insertion)).toEqual([]);

    const deletion = createInlineReview('a\nb\n', 'a\n');
    expect(reviewHunkRanges(deletion)).toEqual([]);
    decideHunk(deletion, 0, false);
    expect(reviewHunkRanges(deletion)).toEqual([
      { index: 0, accepted: false, kind: 'rejected', startLineNumber: 2, endLineNumber: 2 },
    ]);
  });

  it('spans multi-line replacements', () => {
    const r = createInlineReview('a\nb\nc\n', 'a\nX\nY\nc\n');
    expect(reviewHunkRanges(r)).toEqual([
      { index: 0, accepted: true, kind: 'accepted', startLineNumber: 2, endLineNumber: 3 },
    ]);
  });
});

describe('reviewStatus', () => {
  it('summarizes the accepted count', () => {
    const r = createInlineReview(BEFORE, AFTER);
    expect(reviewStatus(r)).toContain('2/2');
    decideHunk(r, 0, false);
    expect(reviewStatus(r)).toContain('1/2');
  });
});
