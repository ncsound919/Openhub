import { describe, it, expect } from 'vitest';
import { createFinding, type Finding } from '../src/services/findings';
import { validateFinding, validateFindings, type ValidationContext } from '../src/core/validator';

function f(over: Record<string, unknown> = {}): Finding {
  return createFinding({
    source: 'deep',
    dimension: 'security',
    category: 'secret',
    severity: 'high',
    confidence: 0.9,
    determinism: 'static',
    location: { file: 'src/a.ts', line: 1 },
    ...over,
  });
}

function ctx(files: Record<string, string>, extra: Partial<ValidationContext> = {}): ValidationContext {
  return { files: new Map(Object.entries(files)), ...extra };
}

describe('validateFinding — secrets', () => {
  it('confirms a credential-shaped value present at the line', () => {
    const v = validateFinding(f({ category: 'secret' }), ctx({ 'src/a.ts': `const API_KEY = "sk-live-abcdef123456";` }));
    expect(v.verdict).toBe('confirmed');
    expect(v.confidence).toBeGreaterThan(0.8);
  });

  it('marks a placeholder as unconfirmed', () => {
    const v = validateFinding(f({ category: 'secret' }), ctx({ 'src/a.ts': `const key = "your_api_key_here";` }));
    expect(v.verdict).toBe('unconfirmed');
    expect(v.evidence.some((e) => e.kind === 'placeholder')).toBe(true);
  });

  it('marks the finding stale when the secret is gone', () => {
    const v = validateFinding(f({ category: 'secret', evidence: 'sk-live-abcdef123456' }), ctx({ 'src/a.ts': '// removed during cleanup' }));
    expect(v.verdict).toBe('stale');
  });
});

describe('validateFinding — generic findings', () => {
  it('confirms when evidence is present at the location', () => {
    const v = validateFinding(
      f({ category: 'lint:no-unused-vars', evidence: 'unused variable x', location: { file: 'src/a.ts', line: 2 } }),
      ctx({ 'src/a.ts': 'a\nunused variable x here\nc' }),
    );
    expect(v.verdict).toBe('confirmed');
    expect(v.confidence).toBeCloseTo(0.85, 5);
  });

  it('is stale when the file is missing', () => {
    expect(validateFinding(f(), ctx({})).verdict).toBe('stale');
  });

  it('is stale when the line is past end of file', () => {
    const v = validateFinding(f({ location: { file: 'src/a.ts', line: 99 } }), ctx({ 'src/a.ts': 'a\nb' }));
    expect(v.verdict).toBe('stale');
  });
});

describe('validateFinding — injection reachability', () => {
  it('confirms when a sink and a tainted source co-occur', () => {
    const v = validateFinding(
      f({ category: 'sql-injection', dimension: 'security' }),
      ctx({ 'src/a.ts': `app.get('/u', (req, res) => { db.query('select ' + req.query.id); });` }),
    );
    expect(v.verdict).toBe('confirmed');
    expect(v.reachability).toBe('reachable');
  });

  it('is unconfirmed when only a sink is present', () => {
    const v = validateFinding(f({ category: 'command-injection' }), ctx({ 'src/a.ts': `exec('ls')` }));
    expect(v.verdict).toBe('unconfirmed');
    expect(v.reachability).toBe('unknown');
  });
});

describe('validateFinding — dependency reachability', () => {
  it('confirms an imported package', () => {
    const v = validateFinding(
      f({ category: 'cve:axios', cve: 'CVE-2026-1', dimension: 'security' }),
      ctx({ 'src/a.ts': `import axios from 'axios';` }),
    );
    expect(v.verdict).toBe('confirmed');
    expect(v.reachability).toBe('reachable');
  });

  it('confirms when the vulnerable symbol is referenced', () => {
    const v = validateFinding(
      f({ category: 'cve:axios', cve: 'CVE-2026-1' }),
      ctx({ 'src/a.ts': `axios.get(url)` }, { packageSymbols: new Map([['axios', ['axios.get']]]) }),
    );
    expect(v.verdict).toBe('confirmed');
    expect(v.evidence.some((e) => e.kind === 'symbol-present')).toBe(true);
  });

  it('is unconfirmed/unreachable when there is no usage', () => {
    const v = validateFinding(f({ category: 'cve:lodash', cve: 'CVE-2026-2' }), ctx({ 'src/a.ts': 'console.log(1)' }));
    expect(v.verdict).toBe('unconfirmed');
    expect(v.reachability).toBe('unreachable');
  });

  it('is unconfirmed/unknown for a declared-but-unimported direct dependency', () => {
    const v = validateFinding(
      f({ category: 'cve:leftpad', cve: 'CVE-2026-3' }),
      ctx({ 'src/a.ts': 'console.log(1)' }, { directDependencies: new Set(['leftpad']) }),
    );
    expect(v.verdict).toBe('unconfirmed');
    expect(v.reachability).toBe('unknown');
  });
});

describe('validateFindings', () => {
  it('drops stale findings by default and keeps unconfirmed ones', () => {
    const findings = [
      f({ category: 'lint:x', location: { file: 'gone.ts', line: 1 } }),
      f({ category: 'command-injection', location: { file: 'src/a.ts', line: 1 } }),
    ];
    const r = validateFindings(findings, ctx({ 'src/a.ts': 'exec(1)' }));
    expect(r.dropped.map((d) => d.validation.verdict)).toEqual(['stale']);
    expect(r.kept).toHaveLength(1);
    expect(r.validations.size).toBe(2);
  });

  it('drops unconfirmed findings when asked', () => {
    const findings = [f({ category: 'command-injection', location: { file: 'src/a.ts', line: 1 } })];
    const r = validateFindings(findings, ctx({ 'src/a.ts': 'exec(1)' }), { dropUnconfirmed: true });
    expect(r.kept).toHaveLength(0);
    expect(r.dropped).toHaveLength(1);
  });
});
