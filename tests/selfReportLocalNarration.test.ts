import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SelfReport } from '../src/services/selfReport';

const probeLocalModel = vi.fn();
const runLlm = vi.fn();

vi.mock('../src/services/localModel', () => ({ probeLocalModel }));
vi.mock('../src/services/llmRouter', () => ({ runLlm }));

const {
  localNarrationMessages,
  narrateSelfReportWithPhone,
} = await import('../src/services/selfReportVoice');

function report(over: Partial<SelfReport> = {}): SelfReport {
  return {
    schema: 'openhub-self-report-v1',
    at: '2026-10-27T12:00:00.000Z',
    identity: { ok: true, name: 'openhub', version: '2.0.0', pid: 1, uptimeSec: 3600, platform: 'android', node: 'v24', port: 3000 },
    activity: {
      ok: true,
      windowMs: 86400000,
      total: 42,
      bySystem: { openhub: 30, sieve: 12 },
      byKind: { report: 20, probe: 22 },
      byOutcome: { passed: 40, failed: 2 },
      bySeverity: { info: 41, warning: 1 },
      passRate: 0.9524,
      recent: [],
    },
    incidents: { ok: true, recent: [{ id: 'i1', severity: 'warning' }], bySeverity: { warning: 1 }, dispatch: null },
    runs: { ok: true, total: 5, active: 1, latest: { id: 'run-1', status: 'looping' } },
    audit: { ok: true, verdict: 'pass', reportId: 'a1', at: '2026-10-27T11:00:00.000Z' },
    ecosystem: { ok: true, sources: [], entries: 0 },
    bridges: { axiom: { ok: true, online: true }, recourse: { ok: true, available: true } },
    ...over,
  };
}

beforeEach(() => {
  probeLocalModel.mockReset();
  runLlm.mockReset();
});

describe('local narration prompt', () => {
  it('carries the real facts and forbids invented details', () => {
    const messages = localNarrationMessages(report());
    expect(messages[0].content).toContain('Never invent');
    expect(messages[1].content).toContain('42 events');
    expect(messages[1].content).toContain('pass 95%');
    expect(messages[1].content).toContain('Activity by system');
    expect(messages[1].content).toContain('run-1');
  });

  it('says a missing section is unavailable instead of filling it in', () => {
    const messages = localNarrationMessages(report({ incidents: { ok: false, error: 'db busy' } }));
    expect(messages[1].content).toContain('Recent incidents: unavailable');
  });
});

describe('narrateSelfReportWithPhone', () => {
  it('uses the local tier only and returns the published model id', async () => {
    probeLocalModel.mockResolvedValue({
      reachable: true, baseUrl: 'http://127.0.0.1:8080', models: ['qwen3.5-4b'], modelId: 'qwen3.5-4b', checkedAt: 'now',
    });
    runLlm.mockResolvedValue({ ok: true, text: '  OpenHub is steady.  ', provider: 'local:http://127.0.0.1:8080', tier: 'local' });

    const result = await narrateSelfReportWithPhone(report());

    expect(result).toMatchObject({ available: true, prose: 'OpenHub is steady.', model: 'qwen3.5-4b', provider: 'local:http://127.0.0.1:8080' });
    expect(runLlm).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ tier: 'local', localMaxTokens: 320, timeoutMs: 120_000 }),
    );
  });

  it('fails honestly when the phone model is not reachable', async () => {
    probeLocalModel.mockResolvedValue({
      reachable: false, baseUrl: null, models: [], modelId: 'qwen3.5-4b', error: 'connect ECONNREFUSED', checkedAt: 'now',
    });

    const result = await narrateSelfReportWithPhone(report());

    expect(result.available).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
    expect(runLlm).not.toHaveBeenCalled();
  });

  it('does not present an empty local reply as a brief', async () => {
    probeLocalModel.mockResolvedValue({
      reachable: true, baseUrl: 'http://127.0.0.1:8080', models: ['qwen3.5-4b'], modelId: 'qwen3.5-4b', checkedAt: 'now',
    });
    runLlm.mockResolvedValue({ ok: true, text: '   ', provider: 'local:http://127.0.0.1:8080', tier: 'local' });

    const result = await narrateSelfReportWithPhone(report());

    expect(result.available).toBe(false);
    expect(result.error).toContain('empty brief');
  });
});
