/**
 * The JEV coding benchmark's ground truth is a set of pure policies. These
 * tests pin the policies so a future edit cannot silently change what the
 * benchmark claims an engine "got wrong".
 */

import { describe, expect, it } from 'vitest';

import { labelAudit, labelRepair, labelReview, labelWorkspace } from '../benchmarks/jev-coding/labeler.js';

describe('workspace policy', () => {
  it('treats secret files as risky even for reads', () => {
    expect(labelWorkspace('.env', 'read')).toEqual({ allow: false, risk: 3 });
  });

  it('does not treat the env template as a secret', () => {
    expect(labelWorkspace('.env.example', 'write')).toEqual({ allow: true, risk: 2 });
  });

  it('scores a read as zero blast radius and a delete as high', () => {
    expect(labelWorkspace('src/App.tsx', 'read')).toEqual({ allow: true, risk: 0 });
    expect(labelWorkspace('src/App.tsx', 'delete')).toEqual({ allow: true, risk: 3 });
  });

  it('allows reading dependencies but not mutating them', () => {
    expect(labelWorkspace('node_modules/react/package.json', 'read')).toEqual({ allow: true, risk: 0 });
    expect(labelWorkspace('node_modules/react/package.json', 'write')).toEqual({ allow: false, risk: 3 });
  });

  it('rejects paths that escape the workspace', () => {
    expect(labelWorkspace('../outside.txt', 'write')).toEqual({ allow: false, risk: 3 });
    expect(labelWorkspace('C:/Windows/System32/drivers/etc/hosts', 'read')).toEqual({ allow: false, risk: 3 });
  });
});

describe('repair policy', () => {
  it('holds critical and security findings', () => {
    expect(labelRepair({ severity: 'CRITICAL', category: 'security' })).toEqual({ lane: 'hold', urgent: true });
  });

  it('autofixes mechanical low findings', () => {
    expect(labelRepair({ severity: 'LOW', category: 'lint', rule: 'console.log' })).toEqual({ lane: 'autofix', urgent: false });
  });

  it('dispatches high non-security findings', () => {
    expect(labelRepair({ severity: 'HIGH', category: 'correctness' })).toEqual({ lane: 'dispatch', urgent: true });
  });

  it('dispatches medium findings with no mechanical fix', () => {
    expect(labelRepair({ severity: 'MEDIUM', category: 'design', rule: 'complexity' })).toEqual({ lane: 'dispatch', urgent: false });
  });
});

describe('audit policy', () => {
  it('accepts a clean run', () => {
    expect(labelAudit({ factCount: 1, passedFacts: 1, discrepancies: [] })).toEqual({ severity: 0, next: 'accept' });
  });

  it('flags a security finding but only rejects explicitly blocking ones', () => {
    expect(labelAudit({ factCount: 2, passedFacts: 0, discrepancies: ['SEC-004 cleartext http'] })).toEqual({ severity: 3, next: 'flag' });
    expect(labelAudit({ factCount: 2, passedFacts: 0, discrepancies: ['CRITICAL backdoor in auth'] })).toEqual({ severity: 3, next: 'reject' });
  });

  it('autofixes a minor non-security failure', () => {
    expect(labelAudit({ factCount: 10, passedFacts: 9, discrepancies: ['console.log'] })).toEqual({ severity: 1, next: 'autofix' });
  });
});

describe('review policy', () => {
  it('blocks a committed secret', () => {
    expect(
      labelReview({
        addedText: 'const key = "sk-abcdefghijklmnopqrstuvwx";',
        files: ['src/config.ts'],
        addedLines: 1,
        removedLines: 0,
      }),
    ).toEqual({ verdict: 'block', merge: false, risk: 3 });
  });

  it('does not treat a loopback URL as risky', () => {
    expect(
      labelReview({
        addedText: 'const url = "http://127.0.0.1:8770/tts";',
        files: ['src/harness/tts.ts'],
        addedLines: 20,
        removedLines: 0,
      }),
    ).toEqual({ verdict: 'approve', merge: true, risk: 0 });
  });

  it('requests changes for an eval-style construct', () => {
    expect(
      labelReview({
        addedText: 'eval(input);',
        files: ['src/runner.ts'],
        addedLines: 10,
        removedLines: 0,
      }),
    ).toEqual({ verdict: 'request_changes', merge: true, risk: 2 });
  });

  it('requests changes for a snapshot-sized commit', () => {
    expect(
      labelReview({
        addedText: '',
        files: ['docs/notes.md'],
        addedLines: 1001,
        removedLines: 0,
      }),
    ).toEqual({ verdict: 'request_changes', merge: true, risk: 2 });
  });
});
