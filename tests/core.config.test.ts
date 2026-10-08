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
import { parseIgnoreFile, loadGitIgnore } from '../src/core/gitignore';

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
    expect(config.pathFilters).toMatchObject({ include: ['src/**'], exclude: ['dist/**'] });
    expect(config.pathInstructions[0].path).toBe('**/*.tsx');
  });

  it('honours .gitignore by default and can be opted out of', () => {
    expect(normalizeAuditConfig({}).config.pathFilters.respectGitIgnore).toBe(true);
    expect(
      normalizeAuditConfig({ pathFilters: { gitignore: false } }).config.pathFilters.respectGitIgnore,
    ).toBe(false);
    expect(
      normalizeAuditConfig({ path_filters: { respect_git_ignore: false } }).config.pathFilters.respectGitIgnore,
    ).toBe(false);
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

  it('reports rule-cap overflow as an ERROR, not a warning', () => {
    // This was a warning plus `enabled: false`, which produced a config that
    // reported `errors: []` while two of its own rules were inert. A rule you
    // wrote and then lost silently is a load failure.
    const rules = Array.from({ length: MAX_ACTIVE_RULES + 2 }, (_, i) => ({ name: `r${i}`, description: 'd' }));
    const { config, errors, warnings } = normalizeAuditConfig({ rules });
    expect(config.rules.filter((r) => r.enabled)).toHaveLength(MAX_ACTIVE_RULES);
    expect(config.rules).toHaveLength(MAX_ACTIVE_RULES + 2);
    expect(errors.join(' ')).toContain('active limit');
    // The names of what was lost, not just a count.
    expect(errors.join(' ')).toContain(`r${MAX_ACTIVE_RULES}`);
    expect(errors.join(' ')).toContain(`r${MAX_ACTIVE_RULES + 1}`);
    expect(warnings.join(' ')).not.toContain('active limit');
  });

  it('raises the rule ceiling only through an explicit maxActiveRules', () => {
    const rules = Array.from({ length: MAX_ACTIVE_RULES + 2 }, (_, i) => ({ name: `r${i}`, description: 'd' }));
    const { config, errors } = normalizeAuditConfig({ rules, maxActiveRules: MAX_ACTIVE_RULES + 2 });
    expect(config.rules.filter((r) => r.enabled)).toHaveLength(MAX_ACTIVE_RULES + 2);
    expect(errors).toEqual([]);
  });

  it('rejects a maxActiveRules that is not a positive integer, and one past the hard limit', () => {
    const { errors: bad } = normalizeAuditConfig({ maxActiveRules: 'lots' });
    expect(bad.join(' ')).toContain('not a positive integer');
    const { errors: huge, config } = normalizeAuditConfig({ maxActiveRules: 10_000 });
    expect(huge.join(' ')).toContain('hard limit');
    expect(config.rules).toEqual([]);
  });

  it('accepts `id` as the rule name key instead of silently dropping the rule', () => {
    // The defect: `id` was read only after the name check, so a rule written as
    // `id:` fell through to the missing-name branch and was dropped, while the
    // response still echoed a plausible derived id.
    const { config, errors } = normalizeAuditConfig({
      rules: [{ id: 'audio-thread-safety', description: 'No allocation on the audio thread.', severity: 'high' }],
    });
    expect(errors).toEqual([]);
    expect(config.rules).toHaveLength(1);
    expect(config.rules[0]).toMatchObject({ id: 'audio-thread-safety', name: 'audio-thread-safety', enabled: true });
  });

  it('prefers name over id when both are present', () => {
    const { config } = normalizeAuditConfig({
      rules: [{ id: 'stable-id', name: 'Human name', description: 'd' }],
    });
    expect(config.rules[0].name).toBe('Human name');
    expect(config.rules[0].id).toBe('stable-id');
  });

  it('names the keys present when a rule has no name at all', () => {
    const { config, errors } = normalizeAuditConfig({ rules: [{ description: 'd', severity: 'high' }] });
    expect(config.rules).toHaveLength(0);
    expect(errors[0]).toContain('needs a "name" (or "id")');
    // The keys it DID find are the diagnostic: they say which one was wrong.
    expect(errors[0]).toContain('description');
    expect(errors[0]).toContain('severity');
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

  it('defaults the lessons corpus on and parses its block', () => {
    expect(DEFAULT_AUDIT_CONFIG.lessons).toEqual({ enabled: true, dir: '', repoPath: '' });
    const { config, warnings } = normalizeAuditConfig({ lessons: { dir: 'C:/x/Coding lessons', enabled: true, repo_path: 'C:/repo' } });
    expect(config.lessons).toMatchObject({ enabled: true, dir: 'C:/x/Coding lessons', repoPath: 'C:/repo' });
    expect(warnings.join(' ')).not.toContain('unknown top-level key "lessons"');
    // An absolute dir is allowed (the corpus lives outside the repo) but flagged.
    expect(warnings.join(' ')).toMatch(/lessons\.dir is an absolute path/);
  });

  it('accepts a bare boolean for lessons', () => {
    expect(normalizeAuditConfig({ lessons: false }).config.lessons.enabled).toBe(false);
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

  it('loads the repo .gitignore by default, and skips it when told to', () => {
    const d = tmpDir();
    fs.writeFileSync(path.join(d, '.gitignore'), 'build-dbg/\n*.log\n');
    expect(loadAuditConfig(d).gitIgnore?.isIgnored('build-dbg/x.o')).toBe(true);
    expect(loadAuditConfig(d, { withGitIgnore: false }).gitIgnore).toBeUndefined();
  });

  it('does not load a matcher when the config opted out of .gitignore', () => {
    const d = tmpDir();
    fs.writeFileSync(path.join(d, '.gitignore'), 'build-dbg/\n');
    fs.writeFileSync(path.join(d, 'openhub.yaml'), 'pathFilters:\n  gitignore: false\n');
    const r = loadAuditConfig(d);
    expect(r.config.pathFilters.respectGitIgnore).toBe(false);
    expect(r.gitIgnore).toBeUndefined();
  });

  it('reports no .gitignore as present:false rather than throwing', () => {
    const r = loadAuditConfig(tmpDir());
    // Absent file => the matcher exists and ignores nothing. `present` is what
    // distinguishes "no .gitignore" from "we did not load one".
    expect(r.gitIgnore?.present).toBe(false);
    expect(r.gitIgnore?.isIgnored('anything/at/all')).toBe(false);
  });
});

describe('tests: block', () => {
  it('parses the object form with cwd and args', () => {
    const { config, errors } = normalizeAuditConfig({
      tests: { commands: [{ command: 'npx', args: ['vitest', 'run'], cwd: 'webui', label: 'webui unit' }], timeoutMs: 120_000 },
    });
    expect(errors).toEqual([]);
    expect(config.testCommands).toEqual([
      { command: 'npx', args: ['vitest', 'run'], cwd: 'webui', label: 'webui unit' },
    ]);
    expect(config.testTimeoutMs).toBe(120_000);
  });

  it('parses the bare-string form', () => {
    const { config, errors } = normalizeAuditConfig({ tests: ['npm test -- --run'] });
    expect(errors).toEqual([]);
    expect(config.testCommands[0]).toEqual({ command: 'npm', args: ['test', '--', '--run'], label: 'npm' });
  });

  it('rejects a cwd that escapes the repo', () => {
    // A test command pointing outside the repo would run in the wrong tree and
    // report a result about it. Rejected, not clamped.
    const { config, errors } = normalizeAuditConfig({ tests: [{ command: 'npm', cwd: '../elsewhere' }] });
    expect(config.testCommands).toHaveLength(0);
    expect(errors.join(' ')).toContain('unsafe cwd');
  });

  it('rejects an absolute cwd', () => {
    const { config, errors } = normalizeAuditConfig({ tests: [{ command: 'npm', cwd: 'C:/Windows/System32' }] });
    expect(config.testCommands).toHaveLength(0);
    expect(errors.join(' ')).toContain('unsafe cwd');
  });

  it('errors on a non-positive timeout and falls back to the default', () => {
    const { config, errors } = normalizeAuditConfig({ tests: { timeoutMs: 0 } });
    expect(errors.join(' ')).toContain('not a positive number');
    expect(config.testTimeoutMs).toBe(DEFAULT_AUDIT_CONFIG.testTimeoutMs);
  });

  it('errors on a tests entry with no command', () => {
    const { config, errors } = normalizeAuditConfig({ tests: [{ args: ['test'] }] });
    expect(config.testCommands).toHaveLength(0);
    expect(errors.join(' ')).toContain('needs a "command"');
  });

  it('defaults testTimeoutMs to 600s when unset', () => {
    expect(normalizeAuditConfig({}).config.testTimeoutMs).toBe(600_000);
  });
});
