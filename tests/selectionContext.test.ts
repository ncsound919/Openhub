import { describe, expect, it } from 'vitest';
import { buildSelectionPrompt, lineAt } from '../src/ide/selectionContext';

const source = ['export function greet(name: string) {', '  return `Hello, ${name}!`;', '}', ''].join('\n');

describe('buildSelectionPrompt', () => {
  it('carries the path, 1-based line range and fenced selection', () => {
    const start = source.indexOf('  return');
    const end = source.indexOf(';\n}', start) + 1;
    const prompt = buildSelectionPrompt({
      path: 'src/greet.ts',
      language: 'typescript',
      value: source,
      start,
      end,
    });

    expect(prompt).toContain('In `src/greet.ts` (lines 2-2):');
    expect(prompt).toContain('```ts');
    expect(prompt).toContain('  return `Hello, ${name}!`;');
    expect(prompt.endsWith('\n')).toBe(true);
  });

  it('uses the end line for a multi-line selection', () => {
    const start = source.indexOf('export function');
    const end = source.indexOf(';\n}', start) + 1;
    const prompt = buildSelectionPrompt({
      path: 'src/greet.ts',
      language: 'typescript',
      value: source,
      start,
      end,
    });
    expect(prompt).toContain('(lines 1-2)');
  });

  it('returns nothing for an empty or whitespace-only selection', () => {
    expect(buildSelectionPrompt({ path: 'a.ts', language: 'ts', value: source, start: 3, end: 3 })).toBe('');
    expect(buildSelectionPrompt({ path: 'a.ts', language: 'ts', value: 'a\n  \nb', start: 2, end: 5 })).toBe('');
  });

  it('truncates very large selections and says so', () => {
    const prompt = buildSelectionPrompt({
      path: 'large.txt',
      language: 'text',
      value: 'x'.repeat(1000),
      start: 0,
      end: 1000,
      maxChars: 200,
    });
    expect(prompt).toContain('(selection truncated after 200 characters)');
    expect(prompt).not.toContain('x'.repeat(201));
  });

  it('counts lines without allocating a slice per line', () => {
    expect(lineAt('a\nb\nc', 0)).toBe(1);
    expect(lineAt('a\nb\nc', 2)).toBe(2);
    expect(lineAt('a\nb\nc', 4)).toBe(3);
    expect(lineAt('a\nb\nc', 999)).toBe(3);
  });
});
