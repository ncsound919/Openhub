// Unit tests for the browser-side per-hunk inline-edit patcher. Mirrors the
// server patchHunks contract so the editor and the server can never disagree.
import { describe, it, expect } from 'vitest';
import { computeHunks, applyHunks, diffLines } from '../src/ide/inlineDiff';

const BEFORE = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n';
const AFTER = 'a\nB\nc\nd\ne\nf\ng\nh\nI\nj\n';

describe('diffLines', () => {
  it('marks equal, removed and inserted lines', () => {
    const edits = diffLines('a\nb', 'a\nc');
    expect(edits).toEqual([
      { type: ' ', line: 'a' },
      { type: '-', line: 'b' },
      { type: '+', line: 'c' },
    ]);
  });
});

describe('computeHunks', () => {
  it('splits separated changes into distinct hunks', () => {
    const hunks = computeHunks(BEFORE, AFTER);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ index: 0, before: ['b'], after: ['B'] });
    expect(hunks[1]).toMatchObject({ index: 1, before: ['i'], after: ['I'] });
  });

  it('handles pure insertions and deletions', () => {
    expect(computeHunks('a\nb\n', 'a\nnew\nb\n')[0]).toMatchObject({ before: [], after: ['new'] });
    expect(computeHunks('a\nb\n', 'a\n')[0]).toMatchObject({ before: ['b'], after: [] });
  });
});

describe('applyHunks', () => {
  it('applies only the accepted hunks', () => {
    expect(applyHunks(BEFORE, AFTER, [0])).toBe('a\nB\nc\nd\ne\nf\ng\nh\ni\nj\n');
    expect(applyHunks(BEFORE, AFTER, [1])).toBe('a\nb\nc\nd\ne\nf\ng\nh\nI\nj\n');
  });

  it('applies all and none correctly', () => {
    expect(applyHunks(BEFORE, AFTER, [0, 1])).toBe(AFTER);
    expect(applyHunks(BEFORE, AFTER, [])).toBe(BEFORE);
  });
});
