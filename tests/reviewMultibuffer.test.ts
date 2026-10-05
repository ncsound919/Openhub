import { describe, it, expect } from 'vitest';
import {
  defaultSelection,
  flattenReview,
  isHunkAccepted,
  selectionPayload,
  setFileHunks,
  stepRow,
  summary,
  toggleHunk,
  type ReviewProposal,
} from '../src/ide/reviewMultibuffer';

const proposals: ReviewProposal[] = [
  {
    id: 'rev-1',
    status: 'pending',
    files: [
      { path: 'src/a.ts', action: 'edit', hunks: [
        { index: 0, before: ['a0'], after: ['A0'] },
        { index: 1, before: ['a1'], after: ['A1'] },
      ] },
      { path: 'src/b.ts', action: 'create', hunks: [{ index: 0, before: [], after: ['B0'] }] },
    ],
  },
  {
    id: 'rev-2',
    status: 'pending',
    files: [{ path: 'src/c.ts', action: 'edit', hunks: [{ index: 0, before: ['c0'], after: ['C0'] }] }],
  },
];

describe('flattenReview', () => {
  it('flattens every proposal/file/hunk in order with stable keys', () => {
    const rows = flattenReview(proposals);
    expect(rows.map((r) => r.key)).toEqual([
      'rev-1::src/a.ts::0',
      'rev-1::src/a.ts::1',
      'rev-1::src/b.ts::0',
      'rev-2::src/c.ts::0',
    ]);
    expect(rows[0].before).toEqual(['a0']);
    expect(rows[2].after).toEqual(['B0']);
  });

  it('ignores malformed proposals/files', () => {
    expect(flattenReview([{ id: 'x', status: 'pending', files: [] }])).toEqual([]);
    expect(flattenReview([null as unknown as ReviewProposal])).toEqual([]);
  });
});

describe('selection model', () => {
  it('defaults to accepting every hunk', () => {
    const sel = defaultSelection(proposals);
    expect(isHunkAccepted(sel, 'rev-1', 'src/a.ts', 0)).toBe(true);
    expect(summary(proposals, sel)).toEqual({ accepted: 4, total: 4 });
  });

  it('toggles a single hunk and reports the accepted count', () => {
    let sel = defaultSelection(proposals);
    sel = toggleHunk(sel, 'rev-1', 'src/a.ts', 1);
    expect(isHunkAccepted(sel, 'rev-1', 'src/a.ts', 1)).toBe(false);
    expect(isHunkAccepted(sel, 'rev-1', 'src/a.ts', 0)).toBe(true);
    expect(summary(proposals, sel).accepted).toBe(3);
  });

  it('accept-all / reject-all a file', () => {
    let sel = defaultSelection(proposals);
    sel = setFileHunks(sel, 'rev-1', 'src/a.ts', [0, 1], false);
    expect(summary(proposals, sel).accepted).toBe(2); // b.ts + c.ts
    sel = setFileHunks(sel, 'rev-1', 'src/a.ts', [0, 1], true);
    expect(summary(proposals, sel).accepted).toBe(4);
  });
});

describe('selectionPayload', () => {
  it("sends 'all' when a file's hunks are fully accepted, else the index list", () => {
    let sel = defaultSelection(proposals);
    expect(selectionPayload(proposals[0], sel)).toEqual([
      { path: 'src/a.ts', hunks: 'all' },
      { path: 'src/b.ts', hunks: 'all' },
    ]);

    sel = toggleHunk(sel, 'rev-1', 'src/a.ts', 0);
    expect(selectionPayload(proposals[0], sel)).toEqual([
      { path: 'src/a.ts', hunks: [1] },
      { path: 'src/b.ts', hunks: 'all' },
    ]);

    sel = setFileHunks(sel, 'rev-1', 'src/b.ts', [0], false);
    expect(selectionPayload(proposals[0], sel)).toEqual([
      { path: 'src/a.ts', hunks: [1] },
      { path: 'src/b.ts', hunks: [] },
    ]);
  });
});

describe('stepRow', () => {
  it('clamps navigation to the row range', () => {
    expect(stepRow(4, 0, 1)).toBe(1);
    expect(stepRow(4, 3, 1)).toBe(3);
    expect(stepRow(4, 0, -1)).toBe(0);
    expect(stepRow(0, 0, 1)).toBe(0);
  });
});
