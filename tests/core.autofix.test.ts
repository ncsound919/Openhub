import { describe, it, expect } from 'vitest';
import { createFinding, type Finding } from '../src/services/findings';
import {
  buildUnifiedDiff,
  suggestDependencyUpgrade,
  parseFixResponse,
  generateAutofix,
  generateAutofixes,
  type FixGenerator,
} from '../src/core/autofix';

function f(over: Record<string, unknown> = {}): Finding {
  return createFinding({
    source: 'deep',
    dimension: 'correctness',
    category: 'npe',
    severity: 'high',
    confidence: 0.8,
    determinism: 'static',
    location: { file: 'src/a.ts', line: 2 },
    evidence: 'unchecked deref',
    ...over,
  });
}

describe('buildUnifiedDiff', () => {
  it('produces a valid single-hunk diff', () => {
    const diff = buildUnifiedDiff('a\nb\nc\n', 'a\nB\nc\n', 'src/a.ts');
    expect(diff).toContain('--- a/src/a.ts');
    expect(diff).toContain('+++ b/src/a.ts');
    expect(diff).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
    expect(diff).toContain('-b');
    expect(diff).toContain('+B');
  });

  it('returns empty string when nothing changed', () => {
    expect(buildUnifiedDiff('same\n', 'same\n', 'x.ts')).toBe('');
  });
});

describe('suggestDependencyUpgrade', () => {
  const manifest = JSON.stringify({ dependencies: { axios: '^1.0.0' } }, null, 2);

  it('bumps a dependency, preserving the range prefix', () => {
    const up = suggestDependencyUpgrade(manifest, 'axios', '1.6.0');
    expect(up).not.toBeNull();
    expect(up!.from).toBe('^1.0.0');
    expect(up!.to).toBe('^1.6.0');
    expect(up!.newContent).toContain('"axios": "^1.6.0"');
  });

  it('returns null for an unknown package or unchanged version', () => {
    expect(suggestDependencyUpgrade(manifest, 'lodash', '4.0.0')).toBeNull();
    expect(suggestDependencyUpgrade(manifest, 'axios', '1.0.0')).toBeNull();
  });
});

describe('parseFixResponse', () => {
  it('parses a fenced JSON object', () => {
    const r = parseFixResponse('```json\n{"newContent":"x","confidence":"high","rationale":"r"}\n```');
    expect(r).toMatchObject({ newContent: 'x', confidence: 'high', rationale: 'r' });
  });
  it('accepts a raw diff string', () => {
    expect(parseFixResponse('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b')).toMatchObject({ patch: expect.stringContaining('@@') });
  });
  it('returns null for unrelated text', () => {
    expect(parseFixResponse('just prose')).toBeNull();
  });
});

describe('generateAutofix', () => {
  it('computes a patch from the model newContent', async () => {
    const generate: FixGenerator = async () => ({ newContent: 'const x = a ?? 0;\n', confidence: 'high', rationale: 'guard null' });
    const s = await generateAutofix({ finding: f(), fileContent: 'const x = a;\n', generate });
    expect(s).not.toBeNull();
    expect(s!.file).toBe('src/a.ts');
    expect(s!.confidence).toBe('high');
    expect(s!.patch).toContain('+++ b/src/a.ts');
    expect(s!.fingerprint).toBeTruthy();
  });

  it('returns null when the model produces no safe fix', async () => {
    const generate: FixGenerator = async () => ({ newContent: 'const x = a;\n' }); // unchanged
    expect(await generateAutofix({ finding: f(), fileContent: 'const x = a;\n', generate })).toBeNull();
  });

  it('rejects an oversized patch', async () => {
    const generate: FixGenerator = async () => ({ newContent: `${'x\n'.repeat(100)}` });
    expect(await generateAutofix({ finding: f(), fileContent: 'const x = a;\n', generate, maxPatchChars: 20 })).toBeNull();
  });
});

describe('generateAutofixes', () => {
  it('collects suggestions, skips unlocated findings and records generator errors', async () => {
    const files = new Map([['src/a.ts', 'const x = a;\n']]);
    const generate: FixGenerator = async ({ file }) => {
      if (file === 'src/boom.ts') throw new Error('model down');
      return { newContent: 'const x = a ?? 0;\n', confidence: 'medium' };
    };
    const findings = [
      f(),
      f({ location: undefined, category: 'repo-issue' }),
      f({ location: { file: 'src/boom.ts', line: 1 } }),
      f({ category: 'advisory' }),
    ];
    const r = await generateAutofixes(findings, {
      readFile: (file) => files.get(file) ?? (file === 'src/boom.ts' ? 'const y = b;\n' : null),
      generate,
      skipCategory: /^advisory$/,
    });
    expect(r.suggestions).toHaveLength(1);
    expect(r.skipped.some((s) => s.reason.includes('no file location'))).toBe(true);
    expect(r.skipped.some((s) => s.reason.includes('not auto-fixable'))).toBe(true);
    expect(r.errors.join(' ')).toContain('model down');
  });
});
