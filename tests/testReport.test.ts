import { describe, expect, it } from 'vitest';
import {
  parseCoverageFromText,
  parseJUnitXml,
  parseJestLike,
  parsePytestJson,
  parseTestOutput,
  scoreTestSummary,
} from '../src/services/testReport';

describe('parseJestLike (vitest --reporter=json / jest --json)', () => {
  it('reads summary counts and failure detail', () => {
    const summary = parseJestLike({
      numTotalTests: 94,
      numPassedTests: 93,
      numFailedTests: 1,
      numPendingTests: 0,
      testResults: [
        { name: 'tests/a.test.ts', assertionResults: [{ status: 'failed', fullName: 'a > works', failureMessages: ['Error: boom\n  at x'] }] },
      ],
    }, 'vitest');
    expect(summary).toMatchObject({ runner: 'vitest', total: 94, passed: 93, failed: 1 });
    expect(summary!.failures[0]).toMatchObject({ name: 'a > works', file: 'tests/a.test.ts' });
    expect(summary!.failures[0].message).toContain('boom');
  });

  it('derives counts from assertion results when the summary is absent', () => {
    const summary = parseJestLike({
      testResults: [{ name: 's', assertionResults: [
        { status: 'passed', title: 'p' },
        { status: 'passed', title: 'p2' },
        { status: 'pending', title: 'skip' },
      ] }],
    }, 'jest');
    expect(summary).toMatchObject({ total: 3, passed: 2, skipped: 1, failed: 0 });
  });

  it('returns null when there is nothing to read', () => {
    expect(parseJestLike({}, 'jest')).toBeNull();
    expect(parseJestLike(null, 'jest')).toBeNull();
  });
});

describe('parsePytestJson', () => {
  it('maps the pytest-json-report shape', () => {
    const summary = parsePytestJson({
      summary: { total: 94, passed: 93, failed: 1, skipped: 0, duration: 12.3 },
      tests: [{ nodeid: 'test_x.py::test_a', outcome: 'failed', call: { longrepr: 'AssertionError: nope' } }],
    });
    expect(summary).toMatchObject({ total: 94, passed: 93, failed: 1, durationMs: 12300 });
    expect(summary!.failures[0]).toMatchObject({ name: 'test_x.py::test_a' });
  });

  it('merges errors into failures', () => {
    const summary = parsePytestJson({ summary: { total: 3, passed: 1, failed: 1, error: 1 } });
    expect(summary).toMatchObject({ failed: 2, passed: 1 });
  });
});

describe('parseJUnitXml', () => {
  const xml = `<?xml version="1.0"?>
<testsuites tests="3" failures="1" errors="0" skipped="1">
  <testsuite name="pytest" tests="3" failures="1" errors="0" skipped="1">
    <testcase classname="tests.test_x" name="test_ok" time="0.1"/>
    <testcase classname="tests.test_x" name="test_bad" time="0.1">
      <failure message="AssertionError: nope">trace</failure>
    </testcase>
    <testcase classname="tests.test_x" name="test_skip" time="0">
      <skipped message="skip"/>
    </testcase>
  </testsuite>
</testsuites>`;
  it('reads suite totals and the failing test', () => {
    const summary = parseJUnitXml(xml, 'pytest')!;
    expect(summary.total).toBe(3);
    expect(summary.failed).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.passed).toBe(1);
    expect(summary.failures[0].name).toBe('test_bad');
    expect(summary.failures[0].message).toContain('nope');
  });

  it('returns null for non-JUnit text', () => {
    expect(parseJUnitXml('just logs')).toBeNull();
  });
});

describe('parseCoverageFromText', () => {
  it('reads istanbul, pytest-cov and labelled forms', () => {
    expect(parseCoverageFromText('All files          |   74.19 |    61.53 |   80.95 |   76.47 |')).toBe(76.5);
    expect(parseCoverageFromText('TOTAL             500     120    76%')).toBe(76);
    expect(parseCoverageFromText('Statements   : 68.7% ( 100/145 )')).toBe(68.7);
    expect(parseCoverageFromText('overall coverage: 42.5%')).toBe(42.5);
    expect(parseCoverageFromText('no coverage here')).toBeNull();
  });
});

describe('parseTestOutput', () => {
  it('extracts a JSON reporter block embedded after logs', () => {
    const parsed = parseTestOutput(
      'log line\nsome noise\n{"numTotalTests":2,"numPassedTests":2,"numFailedTests":0}\n',
      'vitest',
    );
    expect(parsed.summary).toMatchObject({ total: 2, passed: 2, failed: 0 });
  });

  it('falls back to JUnit XML and coverage text', () => {
    const parsed = parseTestOutput(
      'TOTAL 80%\n<testsuite tests="2" failures="0" skipped="0"><testcase name="a"/></testsuite>',
      'pytest',
    );
    expect(parsed.summary).toMatchObject({ total: 2, passed: 2 });
    expect(parsed.coveragePct).toBe(80);
  });

  it('returns nulls for unrecognized output', () => {
    expect(parseTestOutput('all good', 'npm')).toEqual({ summary: null, coveragePct: null });
  });
});

describe('scoreTestSummary', () => {
  const base = { runner: 'x', skipped: 0, xfailed: 0, durationMs: null, coveragePct: null, failures: [] };

  it('scores a clean run 100 and a failure 0 when coverage is unknown', () => {
    expect(scoreTestSummary({ ...base, total: 5, passed: 5, failed: 0 }, { exitOk: true })).toBe(100);
    expect(scoreTestSummary({ ...base, total: 5, passed: 4, failed: 1 }, { exitOk: false })).toBe(80);
  });

  it('blends pass-rate with coverage vs the gate when coverage is known', () => {
    const summary = { ...base, total: 94, passed: 93, failed: 1, coveragePct: 68.7 };
    // 98.9 * 0.7 + (68.7/80)*100 * 0.3 = 69.25 + 25.76 = ~95
    expect(scoreTestSummary(summary, { coverageGatePct: 80, exitOk: false })).toBe(95);
  });

  it('falls back to the exit code when no counts are parsed', () => {
    expect(scoreTestSummary(null, { exitOk: true })).toBe(100);
    expect(scoreTestSummary(null, { exitOk: false })).toBe(0);
  });
});
