// Unit tests for the pure model-catalog parser (src/ide/editorModelCatalog.ts):
// Axiom's `{ groups, current }` shape is normalized into a flat, de-duplicated
// picker list with the persisted default first.
import { describe, it, expect } from 'vitest';
import { parseModelCatalog, modelPickerOptions } from '../src/ide/editorModelCatalog';

const RAW = {
  current: 'deepseek-v4-flash',
  groups: [
    { provider: 'ollama', label: 'Ollama (local)', models: ['minicpm', 'qwen2.5-coder'] },
    { provider: 'gemini', label: 'Gemini', models: ['gemini-2.5-pro', 'minicpm'] },
    { provider: 'axiom', label: 'Axiom Offline', models: ['axiom-offline'] },
  ],
};

describe('parseModelCatalog', () => {
  it('keeps groups and flattens de-duplicated models in order', () => {
    const c = parseModelCatalog(RAW);
    expect(c.groups).toHaveLength(3);
    expect(c.groups[0]).toEqual({ provider: 'ollama', label: 'Ollama (local)', models: ['minicpm', 'qwen2.5-coder'] });
    expect(c.models).toEqual(['minicpm', 'qwen2.5-coder', 'gemini-2.5-pro', 'axiom-offline']);
    expect(c.current).toBe('deepseek-v4-flash');
  });

  it('ignores malformed groups, non-string ids and blanks', () => {
    const c = parseModelCatalog({
      current: '  ',
      groups: [
        null,
        'nope',
        { provider: 'p', models: ['ok', '', 42, '  '] },
        { provider: 'empty', models: [] },
        { models: ['only-models'] },
      ],
    });
    expect(c.groups).toEqual([
      { provider: 'p', label: 'p', models: ['ok'] },
      { provider: 'empty', label: 'empty', models: [] },
      { provider: '', label: '', models: ['only-models'] },
    ]);
    expect(c.models).toEqual(['ok', 'only-models']);
    expect(c.current).toBeNull();
  });

  it('is empty-safe for junk input', () => {
    expect(parseModelCatalog(null)).toEqual({ groups: [], models: [], current: null });
    expect(parseModelCatalog(undefined)).toEqual({ groups: [], models: [], current: null });
    expect(parseModelCatalog('nope')).toEqual({ groups: [], models: [], current: null });
  });

  it('falls back to the provider id when a label is missing', () => {
    const c = parseModelCatalog({ groups: [{ provider: 'zen', models: ['z'] }] });
    expect(c.groups[0].label).toBe('zen');
  });
});

describe('modelPickerOptions', () => {
  it('puts the configured default first, then the editor tier, then the catalog', () => {
    const c = parseModelCatalog(RAW);
    const options = modelPickerOptions(c, { configured: 'minicpm', models: ['editor-only', 'deepseek-v4-flash'] });
    expect(options).toEqual([
      'minicpm',
      'editor-only',
      'deepseek-v4-flash',
      'qwen2.5-coder',
      'gemini-2.5-pro',
      'axiom-offline',
    ]);
  });

  it('de-duplicates and skips empty entries', () => {
    const c = parseModelCatalog({ groups: [{ provider: 'p', models: ['a', 'b'] }] });
    expect(modelPickerOptions(c, { configured: null, models: ['', 'b', 'a'] })).toEqual(['b', 'a']);
  });

  it('returns only the catalog when no editor tier is configured', () => {
    const c = parseModelCatalog(RAW);
    expect(modelPickerOptions(c, {})[0]).toBe('minicpm');
  });
});
