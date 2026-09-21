import { describe, it, expect } from 'vitest';
import { hasMentions, mentionTokens, withContextBlock } from '../src/ide/contextMentions';

describe('mentionTokens', () => {
  it('extracts typed mentions', () => {
    const t = mentionTokens('use @file:src/a.ts and @folder:src plus @code:buildThing @docs:retrieval');
    expect(t.map((m) => `${m.kind}:${m.value}`)).toEqual([
      'file:src/a.ts', 'folder:src', 'code:buildThing', 'docs:retrieval',
    ]);
  });
  it('extracts @git with and without a ref', () => {
    expect(mentionTokens('@git')).toEqual([{ raw: '@git', kind: 'git', value: '' }]);
    expect(mentionTokens('@git:HEAD~2')).toEqual([{ raw: '@git:HEAD~2', kind: 'git', value: 'HEAD~2' }]);
  });
  it('treats a bare @path/with/slash as a file path', () => {
    expect(mentionTokens('see @src/a.ts')).toEqual([{ raw: '@src/a.ts', kind: 'path', value: 'src/a.ts' }]);
  });
  it('ignores email-like and bare @ with no path', () => {
    expect(mentionTokens('me@example.com')).toEqual([]);
    expect(mentionTokens('@ hello')).toEqual([]);
  });
  it('is empty for plain text', () => {
    expect(mentionTokens('no mentions here')).toEqual([]);
  });
});

describe('hasMentions', () => {
  it('reflects detection', () => {
    expect(hasMentions('look at @file:src/a.ts')).toBe(true);
    expect(hasMentions('nothing')).toBe(false);
  });
});

describe('withContextBlock', () => {
  it('appends a non-empty block', () => {
    expect(withContextBlock('do the thing', '--- @file:x ---\nbody')).toBe('do the thing\n\n--- @file:x ---\nbody');
  });
  it('returns the trimmed prompt when the block is empty', () => {
    expect(withContextBlock('  do the thing  ', '   ')).toBe('do the thing');
  });
});
