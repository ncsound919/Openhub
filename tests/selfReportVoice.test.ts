import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  deliveryAdvisory,
  deterministicFraming,
  buildDeliveryVoice,
  humanizedSelfReport,
  selfReportFacts,
} from '../src/services/selfReportVoice';
import type { SelfReport } from '../src/services/selfReport';

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

describe('deliveryAdvisory', () => {
  it('builds a JEV state + framing choice from real report data', () => {
    const { state, questions } = deliveryAdvisory(report());
    const s = state as Record<string, unknown>;
    expect(s.action).toBe('self_report_delivery');
    expect(questions.framing.type).toBe('choice');
    const criteria = questions.framing.criteria as Record<string, unknown>;
    expect(Object.keys(criteria)).toContain('degraded');
  });
});

describe('deterministicFraming', () => {
  it('picks all-clear on green reports', () => {
    const r = report({ activity: { ok: true, windowMs: 86400000, total: 10, bySystem: {}, byKind: {}, byOutcome: {}, bySeverity: {}, passRate: 1.0, recent: [] } });
    expect(deterministicFraming(r)).toBe('all-clear');
  });

  it('picks degraded on real failures or down bridges', () => {
    const r = report({ incidents: { ok: true, recent: [{ a: 1 }, { b: 2 }, { c: 3 }], bySeverity: {}, dispatch: null } });
    expect(deterministicFraming(r)).toBe('degraded');

    const downBridge = report({ bridges: { axiom: { ok: true, online: false }, recourse: { ok: true, available: true } } });
    expect(deterministicFraming(downBridge)).toBe('degraded');
  });

  it('picks heads-up on minor flags', () => {
    const r = report({ activity: { ok: true, windowMs: 86400000, total: 42, bySystem: {}, byKind: {}, byOutcome: {}, bySeverity: {}, passRate: 0.85, recent: [] }, incidents: { ok: true, recent: [{ a: 1 }], bySeverity: {}, dispatch: null } });
    expect(deterministicFraming(r)).toBe('heads-up');
  });
});

describe('buildDeliveryVoice', () => {
  beforeEach(() => {
    vi.stubEnv('OPENHUB_JEV_ENABLED', '0');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('returns a deterministic voice when JEV is disabled', async () => {
    const voice = await buildDeliveryVoice(report());
    expect(voice.source).toBe('deterministic');
    expect(['steady', 'attentive', 'heads-up', 'all-clear', 'degraded']).toContain(voice.framing);
    expect(voice.opener.length).toBeGreaterThan(0);
  });
});

describe('humanizedSelfReport', () => {
  beforeEach(() => {
    vi.stubEnv('OPENHUB_JEV_ENABLED', '0');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('keeps facts factual and frames them with variety', async () => {
    const { text, voice } = await humanizedSelfReport(report());
    expect(text).toContain('42 events');
    expect(text).toContain('axiom:up');
    expect(text).toContain('(source: deterministic)');
    expect(voice.headline.length).toBeGreaterThan(0);
  });

  it('facts body is independent of voice', () => {
    const f = selfReportFacts(report());
    expect(f).toContain('42 events');
    expect(f).not.toContain('deterministic');
  });
});