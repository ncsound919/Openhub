import { describe, it, expect } from 'vitest';
import {
  clampFocus,
  flattenHunks,
  hunkKey,
  isHunkSelected,
  moveFocus,
  reviewKeyAction,
  setHunkSelected,
  summarizeSelection,
} from '../src/ide/agentDockReview';

const files = [
  { path: 'a.ts', hunks: [{ index: 0 }, { index: 1 }] },
  { path: 'b.ts', hunks: [{ index: 0 }] },
];

describe('flattenHunks', () => {
  it('orders hunks by file then index', () => {
    expect(flattenHunks(files)).toEqual([
      { path: 'a.ts', index: 0 },
      { path: 'a.ts', index: 1 },
      { path: 'b.ts', index: 0 },
    ]);
  });
  it('returns empty for no files', () => {
    expect(flattenHunks([])).toEqual([]);
  });
});

describe('focus movement', () => {
  it('clamps to the list bounds and -1 when empty', () => {
    expect(clampFocus(3, -5)).toBe(0);
    expect(clampFocus(3, 9)).toBe(2);
    expect(clampFocus(0, 0)).toBe(-1);
  });
  it('moves and clamps', () => {
    expect(moveFocus(3, 0, 1)).toBe(1);
    expect(moveFocus(3, 2, 1)).toBe(2);
    expect(moveFocus(3, 0, -1)).toBe(0);
    expect(moveFocus(0, 0, 1)).toBe(-1);
  });
});

describe('hunk selection', () => {
  it('toggles and sorts indices', () => {
    let sel = setHunkSelected(undefined, 'a.ts', 2, true);
    sel = setHunkSelected(sel, 'a.ts', 0, true);
    expect(sel['a.ts']).toEqual([0, 2]);
    sel = setHunkSelected(sel, 'a.ts', 2, false);
    expect(sel['a.ts']).toEqual([0]);
  });
  it('reports membership', () => {
    const sel = { 'a.ts': [1] };
    expect(isHunkSelected(sel, 'a.ts', 1)).toBe(true);
    expect(isHunkSelected(sel, 'a.ts', 0)).toBe(false);
    expect(isHunkSelected(undefined, 'a.ts', 0)).toBe(false);
  });
  it('summarizes selection', () => {
    const sel = { 'a.ts': [0], 'b.ts': [0] };
    expect(summarizeSelection(files, sel)).toEqual({ files: 2, totalHunks: 3, selectedHunks: 2 });
    expect(summarizeSelection(files, undefined)).toEqual({ files: 2, totalHunks: 3, selectedHunks: 0 });
  });
});

describe('reviewKeyAction', () => {
  it('maps the j/k/space/a/r/enter scheme', () => {
    expect(reviewKeyAction('j')).toBe('next');
    expect(reviewKeyAction('ArrowDown')).toBe('next');
    expect(reviewKeyAction('k')).toBe('prev');
    expect(reviewKeyAction('ArrowUp')).toBe('prev');
    expect(reviewKeyAction(' ')).toBe('toggle');
    expect(reviewKeyAction('x')).toBe('toggle');
    expect(reviewKeyAction('a')).toBe('accept');
    expect(reviewKeyAction('r')).toBe('reject');
    expect(reviewKeyAction('Enter')).toBe('apply');
    expect(reviewKeyAction('z')).toBe('none');
  });
});

describe('hunkKey', () => {
  it('is stable and path-scoped', () => {
    expect(hunkKey('a.ts', 1)).toBe('a.ts#1');
    expect(hunkKey('b.ts', 1)).not.toBe(hunkKey('a.ts', 1));
  });
});
