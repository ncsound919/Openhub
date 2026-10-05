import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeAuditConfig,
  loadAuditConfig,
  DEFAULT_AUDIT_CONFIG,
  MAX_ACTIVE_RULES,
} from '../src/core/config';

const dirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-config-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('normalizeAuditConfig', () => {
  it('parses a rule with snake_case keys and defaults', () => {
    const { config, errors } = normalizeAuditConfig({
      version: 1,
      sensitivity: 'high',
      rules: [
        { name: 'Require auth', description: 'Flag routes without auth middleware.', severity: 'critical', include: ['src/api/**'], exclude: ['**/*.test.ts'], file_paths: ['docs/auth.md'] },
      ],
    });
    expect(errors).toEqual([]);
    expect(config.sensitivity).toBe('high');
    expect(config.rules).toHaveLength(1);
    expect(config.rules[0]).toMatchObject({
      name: 'Require auth',
      severity: 'critical',
      include: ['src/api/**'],
      exclude: ['**/*.test.ts'],
      filePaths: ['docs/auth.md'],
      enabled: true,
    });
    expect(config.rules[0].id).toBe('require-auth');
  });

  it('accepts a nested reviews block and camelCase (CodeRabbit shape)', () => {
    const { config } = normalizeAuditConfig({
      reviews: {
        custom_rules: [{ name: 'No console', description: 'Flag console.log.', severity: 'medium' }],
        path_filters: { include: ['src/**'], exclude: ['dist/**'] },
      },
      pathInstructions: [{ path: '**/*.tsx', instructions: 'Prefer function components.' }],
    });
    expect(config.rules).toHaveLength(1);
    expect(config.pathFilters).toEqual({ include: ['src/**'], exclude: ['dist/**'] });
    expect(config.pathInstructions[0].path).toBe('**/*.tsx');
  });

  it('warns on an unknown severity and defaults to medium', () => {
    const { config, warnings } = normalizeAuditConfig({ rules: [{ name: 'x', description: 'd', severity: 'blocker' }] });
    expect(config.rules[0].severity).toBe('medium');
    expect(warnings.join(' ')).toContain('unknown severity');
  });

  it('skips a rule with no description and no linked files', () => {
    const { config, errors } = normalizeAuditConfig({ rules: [{ name: 'empty' }] });
    expect(config.rules).toHaveLength(0);
    expect(errors.join(' ')).toContain('needs a "description"');
  });

  it('ignores unsafe linked file paths', () => {
    const { config, warnings } = normalizeAuditConfig({
      rules: [{ name: 'x', file_paths: ['/etc/passwd', '../secret.md', 'docs/ok.md'] }],
    });
    expect(config.rules[0].filePaths).toEqual(['docs/ok.md']);
    expect(warnings.join(' ')).toContain('unsafe linked file');
  });

  it('disables rules beyond the active limit', () => {
    const rules = Array.from({ length: MAX_ACTIVE_RULES + 2 }, (_, i) => ({ name: `r${i}`, description: 'd' }));
    const { config, warnings } = normalizeAuditConfig({ rules });
    expect(config.rules.filter((r) => r.enabled)).toHaveLength(MAX_ACTIVE_RULES);
    expect(warnings.join(' ')).toContain('active limit');
  });

  it('warns on unknown top-level keys', () => {
    const { warnings } = normalizeAuditConfig({ nonsense: true });
    expect(warnings.join(' ')).toContain('unknown top-level key "nonsense"');
  });

  it('parses gate settings with defaults', () => {
    const { config } = normalizeAuditConfig({ gate: { threshold: 'critical', always_pass: true, max_changed_lines: 100, ignore_labels: ['skip-review'] } });
    expect(config.gate).toMatchObject({ threshold: 'critical', alwaysPass: true, maxChangedLines: 100, ignoreLabels: ['skip-review'] });
    expect(DEFAULT_AUDIT_CONFIG.gate.threshold).toBe('high');
  });
});

describe('loadAuditConfig', () => {
  it('returns defaults when no config file exists', () => {
    const r = loadAuditConfig(tmpDir());
    expect(r.source).toBeNull();
    expect(r.config).toEqual(DEFAULT_AUDIT_CONFIG);
    expect(r.errors).toEqual([]);
  });

  it('loads and parses a YAML config file', () => {
    const d = tmpDir();
    fs.writeFileSync(path.join(d, 'openhub.yaml'), [
      'version: 1',
      'sensitivity: low',
      'rules:',
      '  - name: No eval',
      '    description: Flag eval() usage.',
      '    severity: high',
      '    include:',
      '      - "src/**"',
    ].join('\n'));
    const r = loadAuditConfig(d);
    expect(r.source).toBe('openhub.yaml');
    expect(r.config.sensitivity).toBe('low');
    expect(r.config.rules[0]).toMatchObject({ name: 'No eval', severity: 'high', include: ['src/**'] });
  });

  it('degrades to defaults with an explicit error on invalid YAML', () => {
    const d = tmpDir();
    fs.writeFileSync(path.join(d, 'openhub.yaml'), 'rules: [unterminated');
    const r = loadAuditConfig(d);
    expect(r.source).toBe('openhub.yaml');
    expect(r.errors[0]).toContain('failed to parse');
    expect(r.config).toEqual(DEFAULT_AUDIT_CONFIG);
  });
});
