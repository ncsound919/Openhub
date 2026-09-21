import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'node:child_process';
import { buildAuditDelta, type DeltaReportInput } from '../src/services/auditDelta';
import { resolveAuditScope } from '../src/services/auditScope';
import { createFinding, type Finding } from '../src/services/findings';

const dirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'openhub-delta-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* best-effort */ }
  }
});

function finding(over: Partial<Parameters<typeof createFinding>[0]>): Finding {
  return createFinding({ source: 'deep', dimension: 'correctness', category: 'bug', severity: 'high', ...over });
}

function report(over: Partial<DeltaReportInput> & { findings: Finding[] }): DeltaReportInput {
  return {
    id: 'audit_1',
    timestamp: '2026-01-01T00:00:00.000Z',
    overallScore: 70,
    grade: 'C-',
    reconciliation: {
      dimensions: [
        { dimension: 'correctness', label: 'Correctness', score: 60, weight: 3 },
        { dimension: 'tests', label: 'Tests', score: 80, weight: 3 },
      ],
    },
    ...over,
  };
}

describe('buildAuditDelta', () => {
  it('establishes a baseline when there is no previous report', () => {
    const current = report({ findings: [finding({ category: 'a' })] });
    const delta = buildAuditDelta(null, current);
    expect(delta.baselineId).toBeNull();
    expect(delta.grade).toMatchObject({ from: null, to: 'C-', changed: false });
    expect(delta.findings.newCount).toBe(0);
    expect(delta.findings.persistedCount).toBe(1);
    expect(delta.headline).toContain('baseline established');
  });

  it('classifies findings as new / fixed / persisted by dedup key', () => {
    const stays = finding({ category: 'stays', location: { file: 'a.ts', line: 1 } });
    const goes = finding({ category: 'goes', location: { file: 'b.ts', line: 2 } });
    const arrives = finding({ category: 'arrives', location: { file: 'c.ts', line: 3 } });
    const previous = report({ findings: [stays, goes] });
    const current = report({ findings: [stays, arrives] });

    const delta = buildAuditDelta(previous, current);
    expect(delta.findings.newCount).toBe(1);
    expect(delta.findings.fixedCount).toBe(1);
    expect(delta.findings.persistedCount).toBe(1);
    expect(delta.findings.new[0].category).toBe('arrives');
    expect(delta.findings.newByDimension.correctness).toBe(1);
  });

  it('attributes a grade change to the dimensions that moved most', () => {
    const previous = report({ findings: [], overallScore: 60, grade: 'D' });
    const current = report({
      findings: [],
      overallScore: 72,
      grade: 'C-',
      reconciliation: {
        dimensions: [
          { dimension: 'correctness', label: 'Correctness', score: 80, weight: 3 }, // +20 * 3 = +60
          { dimension: 'tests', label: 'Tests', score: 82, weight: 3 }, // +2 * 3 = +6
        ],
      },
    });
    const delta = buildAuditDelta(previous, current);
    expect(delta.grade).toMatchObject({ from: 'D', to: 'C-', changed: true });
    expect(delta.score.delta).toBe(12);
    expect(delta.attribution[0].dimension).toBe('correctness');
    expect(delta.attribution[0].impact).toBe(60);
    expect(delta.reasons[0]).toContain('Correctness +20');
    expect(delta.headline).toContain('+0 new');
  });
});

describe('resolveAuditScope', () => {
  function initRepo(): string {
    const dir = tmpDir();
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', 'config', 'commit.gpgsign', 'false'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n', 'utf8');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir });
    return dir;
  }

  it('resolves a diff scope listing changed files', async () => {
    const dir = initRepo();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'new\n', 'utf8');
    const scope = await resolveAuditScope(dir, {});
    expect(scope.mode).toBe('diff');
    expect([...scope.changedFiles].sort()).toEqual(['a.txt', 'b.txt']);
    expect(scope.insertions).toBeGreaterThan(0);
  });

  it('falls back to full when the diff is too large for the guard', async () => {
    const dir = initRepo();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'new\n', 'utf8');
    const scope = await resolveAuditScope(dir, { maxFiles: 1 });
    expect(scope.mode).toBe('full');
    expect(scope.note).toContain('too large');
  });

  it('honours an explicit full request', async () => {
    const dir = initRepo();
    const scope = await resolveAuditScope(dir, { full: true });
    expect(scope.mode).toBe('full');
    expect(scope.note).toContain('full audit requested');
  });

  it('degrades to full for a non-git directory', async () => {
    const scope = await resolveAuditScope(tmpDir(), {});
    expect(scope.mode).toBe('full');
    expect(scope.note).toContain('not a git work tree');
  });
});
