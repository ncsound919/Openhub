// Browser-side per-hunk content patching for inline-edit review.
//
// This is the client twin of `src/server/patchHunks.ts`. The inline-edit flow
// needs to recompute the buffer for an arbitrary subset of hunks without a
// round trip, so the same line-diff algorithm runs in the browser. Keep the two
// in sync: identical inputs must produce identical hunks, or a hunk the editor
// shows could differ from the one the server would write.
//
// Pure, no Monaco, no DOM.

export interface LineEdit {
  type: ' ' | '-' | '+';
  line: string;
}

const splitLines = (t: string): string[] =>
  t === '' ? [] : t.replace(/\r\n/g, '\n').replace(/\r$/g, '').split('\n');

/** LCS line diff (same algorithm as src/server/diff.ts). */
export function diffLines(oldText: string, newText: string): LineEdit[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: LineEdit[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ type: ' ', line: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: '-', line: a[i] }); i++; }
    else { out.push({ type: '+', line: b[j] }); j++; }
  }
  while (i < n) { out.push({ type: '-', line: a[i] }); i++; }
  while (j < m) { out.push({ type: '+', line: b[j] }); j++; }
  return out;
}

export interface ContentHunk {
  index: number;
  before: string[];
  after: string[];
}

export function computeHunks(before: string, after: string): ContentHunk[] {
  const edits = diffLines(before, after);
  const hunks: ContentHunk[] = [];
  let i = 0;
  let index = 0;
  while (i < edits.length) {
    if (edits[i].type === ' ') { i++; continue; }
    const beforeLines: string[] = [];
    const afterLines: string[] = [];
    while (i < edits.length && edits[i].type !== ' ') {
      if (edits[i].type === '-') beforeLines.push(edits[i].line);
      else afterLines.push(edits[i].line);
      i++;
    }
    hunks.push({ index: index++, before: beforeLines, after: afterLines });
  }
  return hunks;
}

/** Reconstruct content from `before` applying only the accepted hunk indices. */
export function applyHunks(before: string, after: string, accepted: number[]): string {
  const edits = diffLines(before, after);
  const keep = new Set(accepted);
  const out: string[] = [];
  let i = 0;
  let index = 0;
  while (i < edits.length) {
    if (edits[i].type === ' ') { out.push(edits[i].line); i++; continue; }
    const beforeLines: string[] = [];
    const afterLines: string[] = [];
    while (i < edits.length && edits[i].type !== ' ') {
      if (edits[i].type === '-') beforeLines.push(edits[i].line);
      else afterLines.push(edits[i].line);
      i++;
    }
    out.push(...(keep.has(index++) ? afterLines : beforeLines));
  }
  return out.join('\n');
}
