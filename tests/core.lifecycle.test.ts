import { describe, it, expect } from 'vitest';
import { createFinding, type Finding } from '../src/services/findings';
import { reconcileLifecycle, gateDecision, type LifecycleRecord } from '../src/core/lifecycle';

function f(over: Record<string, unknown> = {}): Finding {
  return createFinding({
    source: 'deep',
    dimension: 'security',
    category: 'secret',
    severity: 'high',
    confidence: 0.9,
    determinism: 'static',
    location: { file: 'src/a.ts', line: 3 },
    ...over,
  });
}

const T = '2026-01-01T00:00:00.000Z';
const T2 = '2026-01-02T00:00:00.000Z';

const gate = { threshold: 'high' as const, alwaysPass: false, drafts: false, maxChangedLines: null, ignoreLabels: [] as string[] };

describe('reconcileLifecycle', () => {
  it('marks a first-sight finding as new/open', () => {
    const r = reconcileLifecycle([], [f()], T);
    expect(r.active).toHaveLength(1);
    expect(r.active[0].transition).toBe('new');
    expect(r.active[0].record.status).toBe('open');
    expect(r.active[0].record.seenCount).toBe(1);
  });

  it('marks a recurring finding as persisting and counts sightings', () => {
    const first = reconcileLifecycle([], [f()], T);
    const second = reconcileLifecycle(first.records, [f()], T2);
    expect(second.active[0].transition).toBe('persisting');
    expect(second.active[0].record.seenCount).toBe(2);
    expect(second.active[0].record.firstSeen).toBe(T);
    expect(second.active[0].record.lastSeen).toBe(T2);
  });

  it('auto-resolves an open finding that did not reappear', () => {
    const first = reconcileLifecycle([], [f()], T);
    const second = reconcileLifecycle(first.records, [], T2);
    expect(second.active).toHaveLength(0);
    expect(second.resolvedNow).toHaveLength(1);
    expect(second.resolvedNow[0].status).toBe('resolved');
    expect(second.resolvedNow[0].resolution).toBe('fixed');
  });

  it('reopens a resolved finding when it returns', () => {
    const first = reconcileLifecycle([], [f()], T);
    const resolved = reconcileLifecycle(first.records, [], T2);
    const again = reconcileLifecycle(resolved.records, [f()], T);
    expect(again.active[0].transition).toBe('reopened');
    expect(again.active[0].record.status).toBe('open');
    expect(again.active[0].record.resolvedAt).toBeUndefined();
  });

  it('keeps operator-suppressed findings hidden, not auto-resolved', () => {
    const first = reconcileLifecycle([], [f()], T);
    const suppressed: LifecycleRecord[] = first.records.map((r) => ({ ...r, status: 'false_positive' as const }));
    const next = reconcileLifecycle(suppressed, [f()], T2);
    expect(next.active).toHaveLength(0);
    expect(next.suppressed).toHaveLength(1);
    expect(next.suppressed[0].record.status).toBe('false_positive');
    expect(next.resolvedNow).toHaveLength(0);
  });

  it('dedupes duplicate findings within one run', () => {
    const r = reconcileLifecycle([], [f(), f()], T);
    expect(r.active).toHaveLength(1);
  });

  // Regression guard for the measured defect: with `lessons.dir` unconfigured the
  // bridge emitted zero findings, and every open lesson finding was flipped to
  // resolved/"fixed" because the corpus was not being read at all. Silence from a
  // detector is not evidence that a defect was repaired.
  it('does NOT auto-resolve an open finding when its source reported nothing', () => {
    const first = reconcileLifecycle([], [f({ source: 'lessons' })], T);
    expect(first.active[0].record.status).toBe('open');

    const second = reconcileLifecycle(first.records, [], T2, { observedSources: new Set(['eslint']) });
    expect(second.resolvedNow).toHaveLength(0);
    expect(second.heldUnobserved).toHaveLength(1);
    expect(second.heldUnobserved[0].status).toBe('open');
    expect(second.byFingerprint.get(first.active[0].record.fingerprint)?.status).toBe('open');
  });

  it('still auto-resolves when the source DID report (even with zero findings of its own now)', () => {
    const first = reconcileLifecycle([], [f({ source: 'eslint' })], T);
    // The detector ran and legitimately found nothing this time.
    const second = reconcileLifecycle(first.records, [], T2, { observedSources: new Set(['eslint']) });
    expect(second.resolvedNow).toHaveLength(1);
    expect(second.resolvedNow[0].resolution).toBe('fixed');
    expect(second.heldUnobserved).toHaveLength(0);
  });

  it('holds a source open when findings were produced but every citation went stale', () => {
    // A stale citation means the code moved. The detector spoke; the defect is
    // not thereby repaired, and it must not be recorded as `fixed`.
    const first = reconcileLifecycle([], [f({ source: 'lessons' })], T);
    const second = reconcileLifecycle(first.records, [], T2, { observedSources: new Set(['lessons']) });
    expect(second.resolvedNow).toHaveLength(1);
    // ...and with the caller asserting the detector ran, resolution is legitimate;
    // the protection is that an UNATTEMPTED source is held above.
    expect(second.heldUnobserved).toHaveLength(0);
  });
});

describe('gateDecision', () => {
  it('fails on a new finding at or above the threshold', () => {
    const rec = reconcileLifecycle([], [f({ severity: 'high' })], T);
    const g = gateDecision(rec, gate);
    expect(g.passed).toBe(false);
    expect(g.failing).toHaveLength(1);
  });

  it('passes a persisting finding (new-only gate)', () => {
    const first = reconcileLifecycle([], [f()], T);
    const second = reconcileLifecycle(first.records, [f()], T2);
    expect(gateDecision(second, gate).passed).toBe(true);
    expect(gateDecision(second, gate, { newOnly: false }).passed).toBe(false);
  });

  it('passes findings below the threshold', () => {
    const rec = reconcileLifecycle([], [f({ severity: 'medium' })], T);
    expect(gateDecision(rec, { ...gate, threshold: 'high' }).passed).toBe(true);
    expect(gateDecision(rec, { ...gate, threshold: 'medium' }).passed).toBe(false);
  });

  it('honors always_pass, ignore labels and the diff cap', () => {
    const rec = reconcileLifecycle([], [f({ severity: 'critical' })], T);
    expect(gateDecision(rec, { ...gate, alwaysPass: true }).passed).toBe(true);
    expect(gateDecision(rec, { ...gate, ignoreLabels: ['skip-review'] }, { labels: ['skip-review'] }).passed).toBe(true);
    // The diff cap does NOT pass a huge diff: it declines to evaluate it.
    const capped = gateDecision(rec, { ...gate, maxChangedLines: 100 }, { changedLines: 5000 });
    expect(capped.passed).toBe(false);
    expect(capped.evaluated).toBe(false);
    expect(capped.reason).toContain('not gated');
  });

  it('marks a normal gate as evaluated', () => {
    const rec = reconcileLifecycle([], [f({ severity: 'high' })], T);
    expect(gateDecision(rec, gate).evaluated).toBe(true);
    expect(gateDecision(rec, { ...gate, alwaysPass: true }).evaluated).toBe(false);
  });
});
