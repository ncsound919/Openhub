import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeAuditConfig, type AuditConfig } from '../src/core/config';
import {
  assembleRuleText,
  selectRuleFiles,
  pathInstructionsFor,
  parseRuleFindings,
  evaluateRules,
  type RuleEvalFile,
  type RuleCompleter,
} from '../src/core/rules';

const dirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-rules-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function cfg(raw: unknown): AuditConfig {
  return normalizeAuditConfig(raw).config;
}

const files: RuleEvalFile[] = [
  { file: 'src/api/users.ts', content: 'export function handler(req) { return db.query(req.body.id); }' },
  { file: 'src/api/users.test.ts', content: 'test("x", () => {});' },
  { file: 'docs/readme.md', content: '# docs' },
];

describe('assembleRuleText', () => {
  it('appends linked file contents and caps length', () => {
    const d = tmpDir();
    fs.mkdirSync(path.join(d, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(d, 'docs', 'rule.md'), 'Always parameterize queries.');
    const config = cfg({ rules: [{ name: 'SQL', description: 'No string-built SQL.', file_paths: ['docs/rule.md'] }] });
    const text = assembleRuleText(config.rules[0], d);
    expect(text).toContain('No string-built SQL.');
    expect(text).toContain('Always parameterize queries.');
  });
});

describe('selectRuleFiles', () => {
  it('applies config filters and the rule include/exclude', () => {
    const config = cfg({
      path_filters: { exclude: ['docs/**'] },
      rules: [{ name: 'API', description: 'd', include: ['src/api/**'], exclude: ['**/*.test.ts'] }],
    });
    const picked = selectRuleFiles(config.rules[0], files, config).map((f) => f.file);
    expect(picked).toEqual(['src/api/users.ts']);
  });
});

describe('pathInstructionsFor', () => {
  it('returns instructions whose glob matches a file', () => {
    const config = cfg({ path_instructions: [{ path: '**/*.ts', instructions: 'Use strict types.' }] });
    expect(pathInstructionsFor(['src/api/users.ts'], config)).toEqual(['- [**/*.ts] Use strict types.']);
    expect(pathInstructionsFor(['docs/readme.md'], config)).toEqual([]);
  });
});

describe('parseRuleFindings', () => {
  const rule = cfg({ rules: [{ name: 'SQL', description: 'd', severity: 'high' }] }).rules[0];
  it('parses a fenced JSON array and defaults severity to the rule', () => {
    const out = parseRuleFindings('```json\n[{"file":"src/a.ts","line":3,"message":"concat SQL"}]\n```', rule);
    expect(out.error).toBeUndefined();
    expect(out.findings[0]).toMatchObject({ file: 'src/a.ts', line: 3, message: 'concat SQL', severity: 'high' });
  });
  it('returns an error for non-array output', () => {
    expect(parseRuleFindings('no json here', rule).error).toBeTruthy();
  });
});

describe('evaluateRules', () => {
  const config = cfg({
    rules: [
      { name: 'No string SQL', description: 'Flag string-built SQL.', severity: 'high', include: ['src/**'], exclude: ['**/*.test.ts'] },
      { name: 'Python only', description: 'Flag python issues.', include: ['**/*.py'] },
    ],
  });

  it('evaluates matching rules and maps findings into the model', async () => {
    const complete: RuleCompleter = async () => '[{"file":"src/api/users.ts","line":1,"message":"SQL built from input","severity":"critical","remediation":"Use a parameterized query."}]';
    const r = await evaluateRules(config, files, process.cwd(), complete);
    expect(r.rulesEvaluated).toEqual(['No string SQL']);
    expect(r.rulesSkipped.map((s) => s.rule)).toEqual(['Python only']);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ source: 'rules', category: 'rule:no-string-sql', severity: 'critical', determinism: 'llm' });
    expect(r.findings[0].location).toEqual({ file: 'src/api/users.ts', line: 1 });
    expect(r.findings[0].remediation).toBe('Use a parameterized query.');
  });

  it('records a model failure as an error and continues', async () => {
    const complete: RuleCompleter = async () => { throw new Error('offline'); };
    const r = await evaluateRules(config, files, process.cwd(), complete);
    expect(r.findings).toEqual([]);
    expect(r.errors.join(' ')).toContain('model call failed');
    expect(r.rulesSkipped.some((s) => s.reason === 'model call failed')).toBe(true);
  });

  it('records a parse failure without throwing', async () => {
    const complete: RuleCompleter = async () => 'the model rambled with no array';
    const r = await evaluateRules(config, files, process.cwd(), complete);
    expect(r.errors.join(' ')).toContain('no JSON array');
    expect(r.rulesEvaluated).toEqual([]);
  });
});
