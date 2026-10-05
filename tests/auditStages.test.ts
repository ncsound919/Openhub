import { describe, it, expect } from 'vitest';
import {
  AUDIT_PRESETS,
  AUDIT_STAGES,
  evaluateAuditGate,
  resolveAuditPlan,
  type ScorerName,
} from '../src/services/auditSuite';

const KNOWN_SCORERS: ScorerName[] = [
  'reporank', 'grader', 'claw', 'sca', 'codenexus', 'local_qa',
  'codegraph', 'ocr', 'deep', 'codegang', 'typecheck', 'lint',
  'deps_freshness', 'licenses_sbom', 'duplication', 'perf',
  'a11y', 'api_contract', 'git_history', 'iac', 'sonarqube', 'cmake',
  ];

describe('resolveAuditPlan', () => {
  it('defaults to the full suite with no preset or stage', () => {
    const plan = resolveAuditPlan({});
    expect(plan.preset).toBeNull();
    expect(plan.stage).toBeNull();
    expect(plan.full).toBe(false);
    expect(plan.scorers).toEqual(expect.arrayContaining(KNOWN_SCORERS.filter((s) => s !== 'codenexus')));
  });

  it('resolves the quick preset to its four fast gates', () => {
    const plan = resolveAuditPlan({ preset: 'quick' });
    expect(plan.preset).toBe('quick');
    expect(plan.scorers).toEqual(['typecheck', 'lint', 'git_history', 'deps_freshness']);
    expect(plan.full).toBe(false);
  });

  it('lets explicit scorers win over a preset', () => {
    const plan = resolveAuditPlan({ preset: 'deep', scorers: ['lint'] });
    expect(plan.scorers).toEqual(['lint']);
    expect(plan.preset).toBe('deep');
  });

  it('implies the preset from a stage', () => {
    const plan = resolveAuditPlan({ stage: 'release' });
    expect(plan.stage).toBe('release');
    expect(plan.preset).toBe('release');
    expect(plan.full).toBe(true);
    expect(plan.scorers.length).toBeGreaterThan(10);
  });

  it('keeps explicit scorers but still records the stage', () => {
    const plan = resolveAuditPlan({ stage: 'pr', scorers: ['typecheck'] });
    expect(plan.scorers).toEqual(['typecheck']);
    expect(plan.stage).toBe('pr');
    expect(plan.preset).toBe('standard');
  });

  it('ignores unknown preset/stage values instead of crashing', () => {
    const plan = resolveAuditPlan({ preset: 'nonsense' as never, stage: 'bogus' as never });
    expect(plan.preset).toBeNull();
    expect(plan.stage).toBeNull();
    expect(plan.scorers.length).toBeGreaterThan(0);
  });

  it('honours an explicit full override over a diff-scoped preset', () => {
    expect(resolveAuditPlan({ preset: 'quick', full: true }).full).toBe(true);
  });
});

describe('evaluateAuditGate', () => {
  it('returns null without a stage (ad-hoc runs have no gate)', () => {
    expect(evaluateAuditGate(95, null)).toBeNull();
  });

  it('passes and fails the release gate on its minimum', () => {
    expect(evaluateAuditGate(85, 'release')).toMatchObject({ pass: true, advisory: false, minScore: 80 });
    expect(evaluateAuditGate(79, 'release')).toMatchObject({ pass: false, advisory: false });
  });

  it('fails closed when no score was produced', () => {
    const gate = evaluateAuditGate(null, 'merge');
    expect(gate).toMatchObject({ pass: false });
    expect(gate?.reason).toMatch(/no score/);
  });

  it('nightly records without ever blocking', () => {
    const gate = evaluateAuditGate(12, 'nightly');
    expect(gate).toMatchObject({ advisory: true, minScore: null });
    expect(evaluateAuditGate(null, 'nightly')?.pass).toBe(false);
  });
});

describe('preset/stage registry integrity', () => {
  it('every preset references only known scorers', () => {
    const known = new Set<ScorerName>(KNOWN_SCORERS);
    for (const [name, preset] of Object.entries(AUDIT_PRESETS)) {
      for (const scorer of preset.scorers) {
        expect(known.has(scorer), `${name} references unknown scorer ${scorer}`).toBe(true);
      }
    }
  });

  it('every stage references a known preset', () => {
    for (const [name, stage] of Object.entries(AUDIT_STAGES)) {
      expect(AUDIT_PRESETS[stage.preset], `${name} references unknown preset`).toBeDefined();
    }
  });

  it('release is full-tree while quick is diff-scoped', () => {
    expect(AUDIT_PRESETS.release.full).toBe(true);
    expect(AUDIT_PRESETS.quick.full).toBe(false);
  });

  it('only merge/nightly/release index into Recourse memory', () => {
    expect(AUDIT_STAGES.merge.memory).toBe(true);
    expect(AUDIT_STAGES.nightly.memory).toBe(true);
    expect(AUDIT_STAGES.release.memory).toBe(true);
    expect(AUDIT_STAGES['pre-commit'].memory).toBe(false);
    expect(AUDIT_STAGES.pr.memory).toBe(false);
  });
});
