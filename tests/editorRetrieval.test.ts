// Unit tests for the pure editor request/retrieval assembly
// (src/ide/editorRetrieval.ts). Axiom injects its retrieval floor only when a
// workspace `dir` rides along, so this is the contract that keeps
// editor-side retrieval consumed rather than idle.
import { describe, it, expect } from 'vitest';
import { retrievalTrigger, withRetrievalDir } from '../src/ide/editorRetrieval';

describe('retrievalTrigger', () => {
  it('enables retrieval and carries the trimmed dir when a project is loaded', () => {
    const t = retrievalTrigger('  C:/work/proj  ');
    expect(t.enabled).toBe(true);
    expect(t.dir).toBe('C:/work/proj');
    expect(t.note).toContain('retrieval on');
  });

  it('disables retrieval with an honest note when nothing is loaded', () => {
    expect(retrievalTrigger(undefined)).toEqual({ enabled: false, note: 'retrieval off — no project loaded' });
    expect(retrievalTrigger('').enabled).toBe(false);
    expect(retrievalTrigger('   ').enabled).toBe(false);
  });
});

describe('withRetrievalDir', () => {
  it('attaches dir and preserves the caller fields', () => {
    const params = { file: 'a.ts', selection: 'x', instruction: 'rename' };
    expect(withRetrievalDir(params, '/proj')).toEqual({ ...params, dir: '/proj' });
  });

  it('omits dir entirely when no project is loaded (Axiom degrades, never errors)', () => {
    const params = { file: 'a.ts', selection: 'x', instruction: 'rename' };
    const out = withRetrievalDir(params, '');
    expect(out).toEqual(params);
    expect('dir' in out).toBe(false);
  });

  it('preserves a caller-supplied dir when no root is given', () => {
    const out = withRetrievalDir({ file: 'a.ts', dir: 'C:/explicit' }, undefined);
    expect(out.dir).toBe('C:/explicit');
  });
});
