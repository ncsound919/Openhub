import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  clearLoopRuns,
  intakeSignal,
  evaluateRisk,
  triggerClosedLoop,
  approveLoopRun,
  getLoopMetrics,
  setKillSwitch,
  isKillSwitchActive,
  listLoopRuns,
  getLoopRun,
} from '../src/services/closedLoop';
import { clearReceipts, listReceipts } from '../src/services/receipts';
import { createClosedLoopRouter } from '../src/routes/closedLoopRoutes';

// Mock audit suite runner so test executes fast without spawning real subprocesses
vi.mock('../src/services/auditSuite', () => ({
  executeAuditSuite: vi.fn().mockResolvedValue({
    id: 'audit_mock_1',
    overallScore: 85,
    findings: [],
  }),
}));

vi.mock('../src/services/recourseBridge', () => ({
  recordRecourseOutcome: vi.fn().mockResolvedValue({ available: true, status: 200 }),
}));

describe('Closed Self-Improving Loop (Phase D)', () => {
  beforeEach(() => {
    clearLoopRuns();
    clearReceipts();
    setKillSwitch(false);
  });

  describe('D2: Signal Intake & Deduplication', () => {
    it('does not trigger loop on a single low/medium spike', () => {
      const res = intakeSignal({
        source: 'audit',
        key: 'eslint_warning',
        severity: 'medium',
        targetDir: 'C:/mock/repo',
        message: 'Unused variable',
      });
      expect(res.triggered).toBe(false);
      expect(res.reason).toContain('Single occurrence observed');
      expect(listLoopRuns()).toHaveLength(0);
    });

    it('triggers immediately on a critical severity signal', () => {
      const res = intakeSignal({
        source: 'audit',
        key: 'cve_critical',
        severity: 'critical',
        targetDir: 'C:/mock/repo',
        message: 'RCE vulnerability detected',
      });
      expect(res.triggered).toBe(true);
      expect(res.runId).toBeDefined();
      expect(listLoopRuns()).toHaveLength(1);
    });

    it('triggers when composite conditions are met (repeated signal within window)', () => {
      const res1 = intakeSignal({
        source: 'audit',
        key: 'type_error',
        severity: 'high',
        targetDir: 'C:/mock/repo',
        message: 'Property missing',
      });
      expect(res1.triggered).toBe(false);

      const res2 = intakeSignal({
        source: 'audit',
        key: 'type_error',
        severity: 'high',
        targetDir: 'C:/mock/repo',
        message: 'Property missing',
      });
      expect(res2.triggered).toBe(true);
      expect(res2.runId).toBeDefined();
    });
  });

  describe('D3: Risk Routing', () => {
    it('routes low risk to deterministic runbook', () => {
      const risk = evaluateRisk({
        type: 'runbook',
        name: 'Auto-format',
        description: 'run prettier',
        targetDir: 'C:/mock/repo',
        filesTargeted: ['src/utils.ts'],
      });
      expect(risk).toBe('low');
    });

    it('routes code logic fixes to ambiguous (Axiom mission)', () => {
      const risk = evaluateRisk({
        type: 'axiom_mission',
        name: 'Fix NullPointer',
        description: 'investigate and patch',
        targetDir: 'C:/mock/repo',
        filesTargeted: ['src/service.ts'],
      });
      expect(risk).toBe('ambiguous');
    });

    it('routes protected file changes to high risk (human approval)', () => {
      const risk = evaluateRisk({
        type: 'runbook',
        name: 'Update server',
        description: 'modify server',
        targetDir: 'C:/mock/repo',
        filesTargeted: ['src/server.ts'],
      });
      expect(risk).toBe('high');
    });

    it('routes broad blast radius to high risk', () => {
      const risk = evaluateRisk({
        type: 'runbook',
        name: 'Mass edit',
        description: 'touch 10 files',
        targetDir: 'C:/mock/repo',
        filesTargeted: ['f1.ts', 'f2.ts', 'f3.ts', 'f4.ts', 'f5.ts', 'f6.ts', 'f7.ts'],
      });
      expect(risk).toBe('high');
    });
  });

  describe('D1 & D5: Canonical Stages & Loop Closure with Receipts', () => {
    it('executes canonical stages and generates an evidence receipt for each stage transition', async () => {
      const signals = [
        {
          id: 'sig_1',
          source: 'audit' as const,
          key: 'lint_unused',
          severity: 'medium' as const,
          targetDir: 'C:/mock/repo',
          message: 'unused variable',
          timestamp: Date.now(),
        },
      ];

      const run = triggerClosedLoop('C:/mock/repo', signals);
      expect(run.id).toBeDefined();
      expect(run.stageHistory.map((s) => s.stage)).toContain('detect');

      // Wait briefly for async execution through diagnose, decide, act, verify, learn
      await new Promise((r) => setTimeout(r, 250));

      const updated = getLoopRun(run.id);
      expect(updated?.status).toBe('completed');
      expect(updated?.stageHistory.map((s) => s.stage)).toEqual([
        'detect',
        'diagnose',
        'decide',
        'act',
        'verify',
        'learn',
      ]);

      // Every stage emitted an evidence receipt
      const receipts = listReceipts({ runId: run.id });
      expect(receipts.length).toBeGreaterThanOrEqual(6);
      for (const stage of ['detect', 'diagnose', 'decide', 'act', 'verify', 'learn']) {
        expect(receipts.some((r) => r.label === `loop_stage:${stage}`)).toBe(true);
      }
    });

    it('honours human approval for waiting runs', async () => {
      const run = triggerClosedLoop('C:/mock/repo', []);
      run.status = 'waiting_approval';

      const approved = await approveLoopRun(run.id, 'lead-developer@openhub.dev');
      expect(approved?.approvedBy).toBe('lead-developer@openhub.dev');
      expect(approved?.status).toBe('completed');
    });
  });

  describe('D4: Guardrails & Kill Switch', () => {
    it('aborts execution when kill switch is activated', async () => {
      setKillSwitch(true);
      expect(isKillSwitchActive()).toBe(true);

      const run = triggerClosedLoop('C:/mock/repo', []);
      await new Promise((r) => setTimeout(r, 50));

      const updated = getLoopRun(run.id);
      expect(updated?.status).toBe('cancelled');
    });
  });

  describe('D6: Metrics', () => {
    it('computes MTTR, change-failure rate, and automation success rate', () => {
      const metrics = getLoopMetrics();
      expect(metrics).toHaveProperty('mttrMs');
      expect(metrics).toHaveProperty('changeFailureRate');
      expect(metrics).toHaveProperty('automationSuccessRate');
      expect(metrics).toHaveProperty('totalRuns');
    });
  });
});

describe('Closed Loop Routes', () => {
  beforeEach(() => {
    clearLoopRuns();
    setKillSwitch(false);
  });

  function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/api', createClosedLoopRouter({ authMiddleware: (_req, _res, next) => next() }));
    return app;
  }

  it('POST /api/loop/signal ingests signal and GET /api/loop/metrics returns metrics', async () => {
    const app = makeApp();
    const sigRes = await request(app).post('/api/loop/signal').send({
      key: 'test_leak',
      targetDir: 'C:/mock/repo',
      severity: 'critical',
    });
    expect(sigRes.status).toBe(200);
    expect(sigRes.body.ok).toBe(true);
    expect(sigRes.body.triggered).toBe(true);

    const metricsRes = await request(app).get('/api/loop/metrics');
    expect(metricsRes.status).toBe(200);
    expect(metricsRes.body.ok).toBe(true);
    expect(metricsRes.body.metrics.totalRuns).toBeGreaterThan(0);
  });

  it('POST /api/loop/kill-switch toggles kill switch state', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/loop/kill-switch').send({ active: true });
    expect(res.status).toBe(200);
    expect(res.body.killSwitchActive).toBe(true);
  });
});
