import { describe, expect, it } from 'vitest';
import { selfReportSummary, publishSelfReportToChat, type SelfReport } from '../src/services/selfReport';

function report(over: Partial<SelfReport> = {}): SelfReport {
  return {
    schema: 'openhub-self-report-v1',
    at: '2026-09-22T00:00:00.000Z',
    identity: { ok: true, name: 'openhub', version: '2.0.0', pid: 1, uptimeSec: 3600, platform: 'win32', node: 'v24', port: 3000 },
    activity: { ok: true, windowMs: 86400000, total: 42, bySystem: {}, byKind: {}, byOutcome: {}, bySeverity: {}, passRate: 0.75, recent: [] },
    incidents: { ok: true, recent: [], bySeverity: {}, dispatch: null },
    runs: { ok: true, total: 5, active: 2, latest: null },
    audit: { ok: true, verdict: 'pass', reportId: 'r1', at: '2026-09-22T00:00:00.000Z' },
    ecosystem: { ok: true, sources: [], entries: 0 },
    bridges: { axiom: { ok: true, online: true }, recourse: { ok: true, available: true } },
    ...over,
  };
}

describe('selfReportSummary', () => {
  it('compacts a healthy report into readable lines', () => {
    const s = selfReportSummary(report());
    expect(s).toContain('openhub v2.0.0');
    expect(s).toContain('42 events');
    expect(s).toContain('pass 75%');
    expect(s).toContain('axiom:up');
    expect(s).toContain('recourse:up');
    expect(s).toContain('audit:pass');
  });

  it('degrades each section honestly when unavailable', () => {
    const s = selfReportSummary(report({ activity: { ok: false, error: 'nope' }, bridges: { axiom: { ok: false, error: 'x' }, recourse: { ok: false, error: 'x' } } }));
    expect(s).toContain('activity unavailable');
    expect(s).toContain('axiom:down');
    expect(s).toContain('recourse:down');
  });
});

describe('publishSelfReportToChat', () => {
  it('publishes to the Open-Chat topic and reports success', async () => {
    const r = await publishSelfReportToChat(report(), { OPENHUB_OPENCHAT_TOPIC: 'openhub-reports' });
    expect(r.published).toBe(true);
    expect(r.topic).toBe('openhub-reports');
  });
});