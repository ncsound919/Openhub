import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb } from '../src/auth/db';

// Mock the heavy deps so the test exercises flow logic, not real audits/Axiom.
vi.mock('../src/services/auditSuite', () => ({
  executeAuditSuite: vi.fn(),
}));
vi.mock('../src/services/axiomClient', () => ({
  getAxiomStatus: vi.fn(),
  startAxiomProjectLoop: vi.fn(),
}));

import { executeAuditSuite } from '../src/services/auditSuite';
import { getAxiomStatus, startAxiomProjectLoop } from '../src/services/axiomClient';
import { runEcosystemRepair, resolveToolFolder } from '../src/services/ecosystemRepair';
import { listIncidents } from '../src/services/incidentBus';

const UPLIFT_ROOT = 'C:\\Users\\User\\Downloads\\Uplift';

describe('ecosystemRepair', () => {
  let tmp: string;
  let previousDbPath: string | undefined;
  let previousRoot: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ecosystem-repair-'));
    previousDbPath = process.env.OPENHUB_DB_PATH;
    previousRoot = process.env.UPLIFT_ROOT;
    process.env.OPENHUB_DB_PATH = path.join(tmp, 'test.db');
    process.env.UPLIFT_ROOT = UPLIFT_ROOT;
    process.env.OPENHUB_AUTODISPATCH = '0'; // keep the incident bus from auto-dispatching
    closeDb();
    vi.clearAllMocks();
  });

  afterEach(() => {
    closeDb();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (previousDbPath === undefined) delete process.env.OPENHUB_DB_PATH;
    else process.env.OPENHUB_DB_PATH = previousDbPath;
    if (previousRoot === undefined) delete process.env.UPLIFT_ROOT;
    else process.env.UPLIFT_ROOT = previousRoot;
  });

  it('resolves a registered operative tool to its preloaded local folder', () => {
    const { entry, dir } = resolveToolFolder('draymond');
    expect(entry).not.toBeNull();
    expect(entry!.name).toBe('Draymond Orchestrator');
    expect(dir).toBe(path.join(UPLIFT_ROOT, 'Draymond-Orchestrator'));
  });

  it('reports an honest unavailable-folder result for an unregistered tool', async () => {
    const result = await runEcosystemRepair({
      toolId: 'does-not-exist',
      source: 'draymond',
      severity: 'high',
      kind: 'test',
      detail: 'x',
    });
    expect(result.ok).toBe(false);
    expect(result.dispatch).toBe('unavailable-folder');
    expect(result.incident.id).toBeTruthy();
    expect(executeAuditSuite).not.toHaveBeenCalled();
  });

  it('records the incident even when the flow fails', async () => {
    const result = await runEcosystemRepair({
      toolId: 'nope',
      source: 'dev-brain',
      severity: 'critical',
      kind: 'test',
      detail: 'x',
    });
    expect(result.incident.source).toBe('dev-brain');
    expect(result.incident.severity).toBe('critical');
  });

  it('does not dispatch a repair when the audit passes', async () => {
    vi.mocked(executeAuditSuite).mockResolvedValue({
      id: 'audit-1',
      timestamp: new Date().toISOString(),
      target: UPLIFT_ROOT,
      results: [],
      overallStatus: 'pass',
      overallScore: 95,
      overallScoreDeterministic: 95,
      grade: 'A',
    } as never);

    const result = await runEcosystemRepair({
      toolId: 'draymond',
      source: 'draymond',
      severity: 'medium',
      kind: 'audit-pass',
      detail: 'nothing wrong',
    });
    expect(result.ok).toBe(true);
    expect(result.dispatch).toBe('none-pass');
    expect(startAxiomProjectLoop).not.toHaveBeenCalled();
  });

  it('dispatches to Axiom with the preloaded targetDir when the audit fails', async () => {
    vi.mocked(executeAuditSuite).mockResolvedValue({
      id: 'audit-2',
      timestamp: new Date().toISOString(),
      target: UPLIFT_ROOT,
      results: [],
      overallStatus: 'fail',
      overallScore: 40,
      overallScoreDeterministic: 40,
      grade: 'F',
    } as never);
    vi.mocked(getAxiomStatus).mockResolvedValue({ ok: true });
    vi.mocked(startAxiomProjectLoop).mockResolvedValue({ ok: true, id: 'loop-1' });

    const result = await runEcosystemRepair({
      toolId: 'draymond',
      source: 'draymond',
      severity: 'high',
      kind: 'audit-fail',
      detail: 'broken thing',
    });
    expect(result.dispatch).toBe('axiom-dispatched');
    expect(startAxiomProjectLoop).toHaveBeenCalledWith(
      expect.objectContaining({ targetDir: path.join(UPLIFT_ROOT, 'Draymond-Orchestrator'), modelRoute: 'auto' })
    );
  });

  it('stays honest (no dispatch) when Axiom is unreachable', async () => {
    vi.mocked(executeAuditSuite).mockResolvedValue({
      id: 'audit-3',
      timestamp: new Date().toISOString(),
      target: UPLIFT_ROOT,
      results: [],
      overallStatus: 'fail',
      overallScore: 40,
      overallScoreDeterministic: 40,
      grade: 'F',
    } as never);
    vi.mocked(getAxiomStatus).mockResolvedValue({ ok: false });

    const result = await runEcosystemRepair({
      toolId: 'recourse',
      source: 'ecosystem',
      severity: 'high',
      kind: 'audit-fail',
      detail: 'broken',
    });
    expect(result.dispatch).toBe('axiom-down');
    expect(result.ok).toBe(false);
    expect(startAxiomProjectLoop).not.toHaveBeenCalled();
  });

  it('travels the repair brief findings in the Axiom goal, not only the HTTP message', async () => {
    vi.mocked(executeAuditSuite).mockResolvedValue({
      id: 'audit-4',
      timestamp: new Date().toISOString(),
      target: UPLIFT_ROOT,
      results: [],
      overallStatus: 'fail',
      overallScore: 40,
      overallScoreDeterministic: 40,
      grade: 'F',
      findings: [
        {
          source: 'gitleaks',
          dimension: 'security',
          category: 'secret',
          severity: 'high',
          location: { file: 'src/config.ts', line: 12 },
          evidence: 'AWS key committed to source',
        },
      ],
    } as never);
    vi.mocked(getAxiomStatus).mockResolvedValue({ ok: true });
    vi.mocked(startAxiomProjectLoop).mockResolvedValue({ ok: true, id: 'loop-2' });

    const result = await runEcosystemRepair({
      toolId: 'draymond',
      source: 'draymond',
      severity: 'high',
      kind: 'audit-fail',
      detail: 'leaked key',
    });

    const sentGoal = vi.mocked(startAxiomProjectLoop).mock.calls[0][0].goal;
    expect(sentGoal).toContain('OPENHUB REPAIR BRIEF');
    expect(sentGoal).toContain('src/config.ts');
    expect(sentGoal).toContain('AWS key committed to source');

    // The incident must show the real Axiom dispatch, not stay dispatched:false.
    const stored = listIncidents(20).find((i) => i.id === result.incident.id);
    expect(stored?.dispatched).toBe(true);
    expect(stored?.dispatchResult).toContain('axiom-dispatched');
  });
});