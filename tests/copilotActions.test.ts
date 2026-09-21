import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as actions from '../src/lib/copilotActions';
import type { Ctx } from '../src/lib/copilotActions';

const project = {
  repoId: 'repo_1',
  repositoryName: 'acme/app',
  path: 'C:/work/acme-app',
  owner: 'acme',
  name: 'app',
  defaultBranch: 'main',
} as any;
const ctx: Ctx = { project };

const RICH = {
  ok: true,
  type: 'file',
  content: 'hello world',
  bytes: 11,
  entries: [{ name: 'src', type: 'dir' }, { name: 'a.ts', type: 'file' }],
  findings: [{ severity: 'high', title: 'hardcoded secret' }],
  repos: [{ id: 1, full_name: 'acme/app' }],
  services: [{ slug: 'axiom', up: true }],
  tools: [{ name: 'reporank', status: 'active' }],
  runs: [{ id: 'run_1', status: 'complete' }],
  events: [{ id: 'evt_1' }],
  keys: [{ id: 'key_1', title: 'laptop' }],
  webhooks: [{ id: 'wh_1', url: 'http://x' }],
  results: [{ scorer: 'reporank', score: 90 }],
  milestones: [{ title: 'M1' }],
  nodes: [{ id: 'n1' }],
  skills: [{ name: 'ParserFix' }],
  tools_mcp: [{ name: 'github' }],
  report: { overallStatus: 'pass', results: [] },
  status: 'ok',
  overallStatus: 'pass',
  summary: 'fine',
  message: 'done',
  url: 'http://localhost:3050',
  score: 90,
  data: [],
  items: [],
};

function okResponse(body: unknown = RICH): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

const CALLS: Array<[string, () => Promise<unknown>]> = [
  ['logCopilotAction', () => actions.logCopilotAction(ctx, 'act', 'details')],
  ['reportHiccup', () => actions.reportHiccup('kind', 'detail', 'high')],
  ['readProjectFile', () => actions.readProjectFile(ctx, 'README.md')],
  ['writeProjectFile', () => actions.writeProjectFile(ctx, 'a.ts', 'code')],
  ['pushProject', () => actions.pushProject(ctx)],
  ['scanProjectFile', () => actions.scanProjectFile(ctx, 'a.ts')],
  ['runPipeline', () => actions.runPipeline(ctx, 'ship it')],
  ['pipelineStatus', () => actions.pipelineStatus('run_1')],
  ['listServices', () => actions.listServices()],
  ['controlService', () => actions.controlService(ctx, 'axiom', 'start')],
  ['listTools', () => actions.listTools()],
  ['setToolStatus', () => actions.setToolStatus(ctx, 'reporank', 'active')],
  ['fleetSummary', () => actions.fleetSummary()],
  ['runAudit', () => actions.runAudit(ctx)],
  ['triggerRepair', () => actions.triggerRepair(ctx, 'signal')],
  ['auditAndRepair', () => actions.auditAndRepair(ctx)],
  ['runAgent', () => actions.runAgent(ctx, 'reporank')],
  ['listMcpTools', () => actions.listMcpTools()],
  ['callMcpTool', () => actions.callMcpTool(ctx, 'github', '{"x":1}')],
  ['refreshKnowledge', () => actions.refreshKnowledge()],
  ['intelSummary', () => actions.intelSummary()],
  ['listSshKeys', () => actions.listSshKeys()],
  ['addSshKey', () => actions.addSshKey(ctx, 'laptop', 'ssh-ed25519 AAAA')],
  ['removeSshKey', () => actions.removeSshKey(ctx, 'laptop')],
  ['listWebhooks', () => actions.listWebhooks()],
  ['addWebhook', () => actions.addWebhook(ctx, 'http://x/hook', 'push,pull_request')],
  ['testWebhook', () => actions.testWebhook(ctx, 'http://x/hook')],
  ['removeWebhook', () => actions.removeWebhook(ctx, 'http://x/hook')],
  ['askResearch', () => actions.askResearch(ctx, 'what is X')],
  ['startSupervisionRun', () => actions.startSupervisionRun(ctx, 'fix bug')],
  ['supervisionRuns', () => actions.supervisionRuns()],
  ['generateFile', () => actions.generateFile(ctx, 'a.ts', 'a util')],
  ['ufcTools', () => actions.ufcTools()],
  ['ufcCall', () => actions.ufcCall('lint', '{}')],
  ['recourseStatusSummary', () => actions.recourseStatusSummary()],
  ['synergyRecall', () => actions.synergyRecall('parser')],
  ['recourseRegistrySummary', () => actions.recourseRegistrySummary()],
  ['recourseAgendaSummary', () => actions.recourseAgendaSummary()],
  ['recourseUpgradeSummary', () => actions.recourseUpgradeSummary()],
  ['recourseHeal', () => actions.recourseHeal(ctx)],
  ['dreamSummary', () => actions.dreamSummary()],
  ['snapshotSummary', () => actions.snapshotSummary()],
];

beforeEach(() => {
  vi.stubGlobal('localStorage', {
    getItem: () => 'test-token',
    setItem: () => {},
    removeItem: () => {},
  });
  vi.stubGlobal('document', { cookie: '__Host-csrf-token=csrf123' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('copilotActions — success paths', () => {
  it('every action runs against a healthy backend and returns a string (or void)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse()));
    const failures: string[] = [];
    for (const [name, run] of CALLS) {
      try {
        const result = await run();
        if (result !== undefined && typeof result !== 'string') failures.push(`${name}: non-string ${typeof result}`);
      } catch (err: any) {
        failures.push(`${name}: threw ${err?.message ?? err}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('covers rich response branches (directory read, findings, push success)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      // A root listing (path=) is a directory; a named read is a file.
      if (String(url).endsWith('path=')) return okResponse({ ...RICH, type: 'dir' });
      return okResponse();
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await actions.readProjectFile(ctx, '')).toContain('Directory');
    expect(await actions.scanProjectFile(ctx, 'a.ts')).toContain('finding');
    expect(await actions.pushProject(ctx)).toContain('Pushed');
  });

  it('returns the "load a project" guard without a project', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse()));
    const bare: Ctx = { project: null };
    expect(await actions.readProjectFile(bare, 'a.ts')).toContain('Load a project');
    expect(await actions.pushProject(bare)).toContain('Load a project');
  });
});

describe('copilotActions — failure paths', () => {
  it('handles non-2xx responses without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const failures: string[] = [];
    for (const [name, run] of CALLS) {
      try {
        await run();
      } catch (err: any) {
        failures.push(`${name}: threw ${err?.message ?? err}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('handles network rejection without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }));
    const failures: string[] = [];
    for (const [name, run] of CALLS) {
      try {
        await run();
      } catch (err: any) {
        failures.push(`${name}: threw ${err?.message ?? err}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
