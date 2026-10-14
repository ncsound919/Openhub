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
const bare: Ctx = { project: null };

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
function textRes(body = 'x', status = 200): Response {
  return new Response(body, { status });
}

/** Queue responses in call order; unmatched calls fall back to an empty OK JSON. */
function fetchQueue(...responses: Array<Response | Error>) {
  let i = 0;
  const fn = vi.fn(async () => {
    if (i < responses.length) {
      const r = responses[i++];
      if (r instanceof Error) throw r;
      return r;
    }
    return jsonRes({});
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

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

describe('copilotActions coverage — project guard', () => {
  it('every project-scoped action refuses without a project', async () => {
    fetchQueue();
    expect(await actions.readProjectFile(bare, 'a.ts')).toContain('Load a project');
    expect(await actions.writeProjectFile(bare, 'a.ts', 'x')).toContain('Load a project');
    expect(await actions.pushProject(bare)).toContain('Load a project');
    expect(await actions.scanProjectFile(bare, 'a.ts')).toContain('Load a project');
    expect(await actions.runPipeline(bare, 'msg')).toContain('Load a project');
    expect(await actions.runAudit(bare)).toContain('Load a project');
    expect(await actions.triggerRepair(bare, 'sig')).toContain('Load a project');
    expect(await actions.auditAndRepair(bare)).toContain('Load a project');
    expect(await actions.startSupervisionRun(bare, 'goal')).toContain('Load a project');
    expect(await actions.recourseHeal(bare)).toContain('Load a project');
    expect(await actions.generateFile(bare, 'a.ts', 'd')).toContain('Load a project');
  });

  it('audit + incident helpers never throw', async () => {
    fetchQueue(new Error('offline'));
    await expect(actions.logCopilotAction(ctx, 'x', 'y')).resolves.toBeUndefined();
    await expect(actions.reportHiccup('kind', 'detail')).resolves.toBeUndefined();
  });
});

describe('copilotActions coverage — readProjectFile', () => {
  it('truncates long files, labels empty files and lists directories', async () => {
    fetchQueue(jsonRes({ type: 'file', content: 'a'.repeat(1600) }));
    expect(await actions.readProjectFile(ctx, 'big.ts')).toContain('chars total');

    fetchQueue(jsonRes({ type: 'file', content: '' }));
    expect(await actions.readProjectFile(ctx, 'empty.ts')).toBe('(empty file)');

    fetchQueue(jsonRes({ type: 'dir', entries: [{ name: 'src', type: 'dir' }, { name: 'a.ts', type: 'file' }] }));
    const dir = await actions.readProjectFile(ctx, 'src');
    expect(dir).toContain('Directory src');
    expect(dir).toContain('\u25B8 src');
    expect(dir).toContain('\u00B7 a.ts');

    fetchQueue(jsonRes({ type: 'dir', entries: [] }));
    expect(await actions.readProjectFile(ctx, '')).toContain('(empty)');
  });

  it('reports missing files with and without a server error, and request failures', async () => {
    fetchQueue(jsonRes({ error: 'gone' }));
    expect(await actions.readProjectFile(ctx, 'x.ts')).toContain('gone');
    fetchQueue(jsonRes({}));
    expect(await actions.readProjectFile(ctx, 'x.ts')).toContain('not found');
    fetchQueue(new Error('offline'));
    expect(await actions.readProjectFile(ctx, 'x.ts')).toContain('request failed');
  });
});

describe('copilotActions coverage — write/push', () => {
  it('writeProjectFile handles failures, byte counts and exceptions', async () => {
    fetchQueue(jsonRes({ error: 'disk full' }, 500));
    expect(await actions.writeProjectFile(ctx, 'a.ts', 'code')).toBe('Write failed: disk full.');
    fetchQueue(textRes('nope', 500));
    expect(await actions.writeProjectFile(ctx, 'a.ts', 'code')).toBe('Write failed: HTTP 500.');
    fetchQueue(jsonRes({ bytes: 11 }));
    expect(await actions.writeProjectFile(ctx, 'a.ts', 'code')).toBe('Wrote a.ts (11 bytes).');
    fetchQueue(jsonRes({}));
    expect(await actions.writeProjectFile(ctx, 'a.ts', 'code')).toBe('Wrote a.ts (4 bytes).');
    fetchQueue(new Error('offline'));
    expect(await actions.writeProjectFile(ctx, 'a.ts', 'code')).toContain('request error');
  });

  it('pushProject handles failures and succeeds', async () => {
    fetchQueue(textRes('nope', 500));
    expect(await actions.pushProject(ctx)).toBe('Push failed: HTTP 500.');
    fetchQueue(jsonRes({ ok: false, error: 'rejected' }));
    expect(await actions.pushProject(ctx)).toBe('Push failed: rejected.');
    fetchQueue(jsonRes({ ok: true }));
    expect(await actions.pushProject(ctx)).toBe('Pushed acme/app to origin.');
    fetchQueue(new Error('offline'));
    expect(await actions.pushProject(ctx)).toBe('Push request failed.');
  });
});

describe('copilotActions coverage — scanProjectFile', () => {
  it('covers not-a-file, no findings, severity grouping and errors', async () => {
    fetchQueue(jsonRes({ type: 'dir' }));
    expect(await actions.scanProjectFile(ctx, 'a.ts')).toContain('not a file');

    fetchQueue(jsonRes({ type: 'file', content: 'x' }), jsonRes({ findings: [] }));
    expect(await actions.scanProjectFile(ctx, 'a.ts')).toBe('a.ts: no findings.');

    fetchQueue(
      jsonRes({ type: 'file', content: 'x' }),
      jsonRes({ findings: [{ severity: 'high', title: 'h' }, { severity: 'high', title: 'h2' }, { title: 'none' }] }),
    );
    const report = await actions.scanProjectFile(ctx, 'a.ts');
    expect(report).toContain('3 findings');
    expect(report).toContain('2 high');
    expect(report).toContain('1 unknown');

    fetchQueue(new Error('offline'));
    expect(await actions.scanProjectFile(ctx, 'a.ts')).toContain('failed');
  });
});

describe('copilotActions coverage — pipeline', () => {
  it('runPipeline covers success, failure and exception', async () => {
    fetchQueue(jsonRes({ ok: true, data: { id: 'abcdef1234' } }));
    expect(await actions.runPipeline(ctx, 'ship')).toBe('Axiom loop started (abcdef12). Ask for /pipeline-status abcdef1234 to follow it.');
    fetchQueue(jsonRes({ error: 'queue down' }));
    expect(await actions.runPipeline(ctx, 'ship')).toBe('Axiom loop failed to start: queue down.');
    fetchQueue(new Error('offline'));
    expect(await actions.runPipeline(ctx, 'ship')).toBe('Axiom loop request failed.');
  });

  it('pipelineStatus covers null, missing stages, detail and exception', async () => {
    fetchQueue(textRes('oops'));
    expect(await actions.pipelineStatus('run_1')).toBe('No Axiom loop status returned.');
    fetchQueue(jsonRes({ data: { status: 'running', iteration: 1, maxIterations: 8 } }));
    expect(await actions.pipelineStatus('run_1')).toBe('Axiom loop run_1 — running (iteration 1/8). no stage detail yet');
    fetchQueue(jsonRes({ data: { status: 'done', iteration: 2, maxIterations: 8, iterations: [{ stages: [{ label: 'Build', status: 'done' }] }] } }));
    expect(await actions.pipelineStatus('run_12345678')).toContain('Build: done');
    fetchQueue(new Error('offline'));
    expect(await actions.pipelineStatus('run_1')).toBe('Axiom loop status request failed.');
  });
});

describe('copilotActions coverage — services and tools', () => {
  it('listServices covers empty, envelope, array and failure', async () => {
    fetchQueue(jsonRes([]));
    expect(await actions.listServices()).toBe('No on-demand services registered.');
    fetchQueue(jsonRes({ services: [] }));
    expect(await actions.listServices()).toBe('No on-demand services registered.');
    fetchQueue(jsonRes({ data: [{ slug: 'axiom', status: 'up' }] }));
    expect(await actions.listServices()).toContain('axiom');
    fetchQueue(new Error('offline'));
    expect(await actions.listServices()).toBe('Service list request failed.');
  });

  it('controlService covers failure, success and exception', async () => {
    fetchQueue(jsonRes({ error: 'no' }, 500));
    expect(await actions.controlService(ctx, 'axiom', 'stop')).toBe('Service stop failed: no.');
    fetchQueue(jsonRes({}));
    expect(await actions.controlService(ctx, 'axiom', 'start')).toBe('Service axiom: start requested.');
    fetchQueue(new Error('offline'));
    expect(await actions.controlService(ctx, 'axiom', 'start')).toBe('Service start request failed.');
  });

  it('listTools covers empty, success and failure', async () => {
    fetchQueue(jsonRes({ data: [] }));
    expect(await actions.listTools()).toBe('Registry is empty.');
    fetchQueue(jsonRes([{ name: 'reporank', type: 'cli', status: 'active' }]));
    expect(await actions.listTools()).toContain('reporank');
    fetchQueue(new Error('offline'));
    expect(await actions.listTools()).toBe('Registry request failed.');
  });

  it('setToolStatus covers no match, patch failure, success and exception', async () => {
    fetchQueue(jsonRes([{ id: 't1', name: 'other' }]));
    expect(await actions.setToolStatus(ctx, 'reporank', 'active')).toContain('No tool matching');

    fetchQueue(jsonRes([{ id: 't1', name: 'reporank' }]), textRes('nope', 500));
    expect(await actions.setToolStatus(ctx, 'reporank', 'inactive')).toContain("Couldn't update reporank.");

    fetchQueue(jsonRes({ data: [{ id: 't1', name: 'Reporank' }] }), jsonRes({}));
    expect(await actions.setToolStatus(ctx, 'reporank', 'active')).toBe('Reporank is now active.');

    fetchQueue(new Error('offline'));
    expect(await actions.setToolStatus(ctx, 'reporank', 'active')).toBe('Tool update failed.');
  });
});

describe('copilotActions coverage — fleet / audit / repair / agents', () => {
  it('fleetSummary covers rich data and failure', async () => {
    fetchQueue(jsonRes({ goals: [1, 2], treasury: { revenueUSD: 100 }, source: 'db' }), jsonRes([{}, {}, {}]));
    expect(await actions.fleetSummary()).toBe('Fleet: 3 agents · 2 goals · revenue $100 · source db.');
    fetchQueue(jsonRes({}), jsonRes({ count: 4 }));
    expect(await actions.fleetSummary()).toContain('4 agents');
    fetchQueue(new Error('offline'));
    expect(await actions.fleetSummary()).toBe('Fleet summary request failed.');
  });

  it('runAudit covers failure, success and exception', async () => {
    fetchQueue(jsonRes({ error: 'nope' }, 500));
    expect(await actions.runAudit(ctx)).toBe('Audit failed: nope.');
    fetchQueue(jsonRes({ ok: true, report: { overallStatus: 'pass', results: [{ error: 'e' }, {}] } }));
    expect(await actions.runAudit(ctx)).toBe('Audit verdict: pass — 2 checks, 1 failing. See the Audit page for detail.');
    fetchQueue(new Error('offline'));
    expect(await actions.runAudit(ctx)).toBe('Audit request failed.');
  });

  it('triggerRepair covers failure, success and exception', async () => {
    fetchQueue(textRes('nope', 500));
    expect(await actions.triggerRepair(ctx, 'sig')).toBe('Repair dispatch failed: HTTP 500.');
    fetchQueue(jsonRes({ ok: true }));
    expect(await actions.triggerRepair(ctx, 'sig')).toContain('Repair triage dispatched.');
    fetchQueue(new Error('offline'));
    expect(await actions.triggerRepair(ctx, 'sig')).toBe('Repair dispatch failed.');
  });

  it('auditAndRepair covers failure, message/no-message and exception', async () => {
    fetchQueue(textRes('nope', 500));
    expect(await actions.auditAndRepair(ctx)).toBe('Audit+repair failed: HTTP 500.');
    fetchQueue(jsonRes({ ok: true, message: 'repaired' }));
    expect(await actions.auditAndRepair(ctx)).toBe('repaired');
    fetchQueue(jsonRes({ ok: true, audit: { overallStatus: 'pass' } }));
    expect(await actions.auditAndRepair(ctx)).toBe('Audit pass.');
    fetchQueue(new Error('offline'));
    expect(await actions.auditAndRepair(ctx)).toBe('Audit+repair request failed.');
  });

  it('runAgent covers 501, failure, success and exception', async () => {
    fetchQueue(textRes('nope', 501));
    expect(await actions.runAgent(ctx, 'ghost')).toContain('has no executable mapped');
    fetchQueue(jsonRes({ error: 'boom' }, 500));
    expect(await actions.runAgent(ctx, 'ghost')).toBe('Agent run failed: boom.');
    fetchQueue(jsonRes({ ok: true }));
    expect(await actions.runAgent(ctx, 'reporank')).toContain('reporank');
    fetchQueue(new Error('offline'));
    expect(await actions.runAgent(ctx, 'reporank')).toBe('Agent dispatch failed.');
  });

  it('listMcpTools reports the retired bridge', async () => {
    expect(await actions.listMcpTools()).toContain('retired');
  });

  it('callMcpTool reports the retired bridge', async () => {
    expect(await actions.callMcpTool(ctx, 'github', 'not-json')).toContain('retired');
    expect(await actions.callMcpTool(ctx, 'github', '{"a":1}')).toContain('github');
  });

  it('refreshKnowledge covers failure, success and exception', async () => {
    fetchQueue(textRes('nope', 500));
    expect(await actions.refreshKnowledge()).toBe('Re-index failed: HTTP 500.');
    fetchQueue(jsonRes({}));
    expect(await actions.refreshKnowledge()).toBe('Knowledge re-index requested.');
    fetchQueue(new Error('offline'));
    expect(await actions.refreshKnowledge()).toBe('Re-index request failed.');
  });
});

describe('copilotActions coverage — intelSummary', () => {
  it('renders sources, agents, roster and empty index', async () => {
    fetchQueue(
      jsonRes({ sources: [{ label: 'Eco', root: '/r', entries: 3 }], totals: { agent: 2 }, live: false }),
      jsonRes({ count: 2, path: '/x/agents' }),
      jsonRes({ audit: [{ name: 'audit', present: true }], research: [{ name: 'res', present: false }] }),
    );
    const out = await actions.intelSummary();
    expect(out).toContain('Intel sources (1)');
    expect(out).toContain('(index empty)');
    expect(out).toContain('Fleet catalog: 2 agents (agents)');
    expect(out).toContain('Audit backends (1)');
    expect(out).toContain('Research backends (1)');
  });

  it('falls back to the root, then to no sources, and reports a missing catalog', async () => {
    fetchQueue(jsonRes({ root: '/r' }), jsonRes({}), jsonRes({}));
    expect(await actions.intelSummary()).toContain('Source: /r');

    fetchQueue(jsonRes({ totals: { agent: 2, skill: 1 } }), jsonRes({ error: 'nope' }), jsonRes({ ok: false }));
    const out = await actions.intelSummary();
    expect(out).toContain('No intel sources configured');
    expect(out).toContain('Index: 3 entries');
    expect(out).toContain('Fleet catalog: not found.');

    fetchQueue(new Error('offline'));
    expect(await actions.intelSummary()).toBe('Intel summary request failed.');
  });
});

describe('copilotActions coverage — SSH keys', () => {
  it('listSshKeys covers empty, detail and exception', async () => {
    fetchQueue(jsonRes([]));
    expect(await actions.listSshKeys()).toContain('No SSH keys registered');
    fetchQueue(jsonRes([{ id: 'key_12345678', title: 'laptop' }]));
    expect(await actions.listSshKeys()).toContain('laptop (key_1234)');
    fetchQueue(new Error('offline'));
    expect(await actions.listSshKeys()).toBe('SSH key list request failed.');
  });

  it('addSshKey covers failure, success and exception', async () => {
    fetchQueue(jsonRes({ error: 'dup' }, 500));
    expect(await actions.addSshKey(ctx, 'laptop', 'ssh-x')).toBe("Couldn't add key: dup.");
    fetchQueue(jsonRes({}));
    expect(await actions.addSshKey(ctx, 'laptop', 'ssh-x')).toContain('laptop');
    fetchQueue(new Error('offline'));
    expect(await actions.addSshKey(ctx, 'laptop', 'ssh-x')).toBe('SSH key request failed.');
  });

  it('removeSshKey covers no match, failure, success and exception', async () => {
    fetchQueue(jsonRes([]));
    expect(await actions.removeSshKey(ctx, 'missing')).toContain('No SSH key matching');
    fetchQueue(jsonRes([{ id: 'key_1', title: 'laptop' }]), textRes('nope', 500));
    expect(await actions.removeSshKey(ctx, 'laptop')).toContain("Couldn't remove laptop.");
    fetchQueue(jsonRes([{ id: 'key_1', title: 'laptop' }]), jsonRes({}));
    expect(await actions.removeSshKey(ctx, 'key_')).toContain('laptop');
    fetchQueue(new Error('offline'));
    expect(await actions.removeSshKey(ctx, 'laptop')).toBe('SSH key removal failed.');
  });
});

describe('copilotActions coverage — webhooks', () => {
  it('listWebhooks covers empty, paused, detail and exception', async () => {
    fetchQueue(jsonRes([]));
    expect(await actions.listWebhooks()).toContain('No webhooks registered');
    fetchQueue(jsonRes([{ id: 'wh_12345678', url: 'http://x/hook', active: 0 }]));
    expect(await actions.listWebhooks()).toContain('paused');
    fetchQueue(new Error('offline'));
    expect(await actions.listWebhooks()).toBe('Webhook list request failed.');
  });

  it('addWebhook validates the URL, parses events and handles failures', async () => {
    fetchQueue();
    expect(await actions.addWebhook(ctx, 'ftp://x', '')).toContain('must start with http(s)');
    fetchQueue(jsonRes({}));
    expect(await actions.addWebhook(ctx, 'http://x/hook', 'push, pull_request')).toContain('push, pull_request');
    fetchQueue(jsonRes({}));
    expect(await actions.addWebhook(ctx, 'http://x/hook', '')).toContain('events: *');
    fetchQueue(jsonRes({ error: 'bad' }, 500));
    expect(await actions.addWebhook(ctx, 'http://x/hook', '')).toBe("Couldn't add webhook: bad.");
    fetchQueue(new Error('offline'));
    expect(await actions.addWebhook(ctx, 'http://x/hook', '')).toBe('Webhook request failed.');
  });

  it('testWebhook covers no match, failure, success and exception', async () => {
    fetchQueue(jsonRes([]));
    expect(await actions.testWebhook(ctx, 'missing')).toContain('No webhook matching');
    fetchQueue(jsonRes([{ id: 'wh_1', url: 'http://x/hook' }]), textRes('nope', 500));
    expect(await actions.testWebhook(ctx, 'http://x/hook')).toBe('Test ping failed: HTTP 500.');
    fetchQueue(jsonRes([{ id: 'wh_1', url: 'http://x/hook' }]), jsonRes({}));
    expect(await actions.testWebhook(ctx, 'wh_1')).toBe('Test ping fired for http://x/hook.');
    fetchQueue(new Error('offline'));
    expect(await actions.testWebhook(ctx, 'http://x/hook')).toBe('Webhook test failed.');
  });

  it('removeWebhook covers no match, failure, success and exception', async () => {
    fetchQueue(jsonRes([]));
    expect(await actions.removeWebhook(ctx, 'missing')).toContain('No webhook matching');
    fetchQueue(jsonRes([{ id: 'wh_1', url: 'http://x/hook' }]), textRes('nope', 500));
    expect(await actions.removeWebhook(ctx, 'http://x/hook')).toBe("Couldn't remove webhook for http://x/hook.");
    fetchQueue(jsonRes([{ id: 'wh_1', url: 'http://x/hook' }]), jsonRes({}));
    expect(await actions.removeWebhook(ctx, 'wh_1')).toBe('Webhook for http://x/hook removed.');
    fetchQueue(new Error('offline'));
    expect(await actions.removeWebhook(ctx, 'http://x/hook')).toBe('Webhook removal failed.');
  });
});

describe('copilotActions coverage — research / supervision', () => {
  it('askResearch covers failure, reachable/offline backends and exception', async () => {
    fetchQueue(textRes('nope', 500));
    expect(await actions.askResearch(ctx, 'q')).toBe('Research request failed: HTTP 500.');
    fetchQueue(jsonRes({ ok: true, note: 'done', backends: [{ name: 'A', reachable: true }, { name: 'B', reachable: false, note: 'no' }] }));
    const out = await actions.askResearch(ctx, 'q');
    expect(out).toContain('Research: done');
    expect(out).toContain('A: reachable');
    expect(out).toContain('B: offline (no)');
    fetchQueue(new Error('offline'));
    expect(await actions.askResearch(ctx, 'q')).toBe('Research request failed.');
  });

  it('startSupervisionRun covers failure, skills and exception', async () => {
    fetchQueue(textRes('nope', 500));
    expect(await actions.startSupervisionRun(ctx, 'goal')).toBe('Supervision failed: HTTP 500.');
    fetchQueue(jsonRes({ ok: true, run: { id: 'run_12345678', skills: [{ name: 'ParserFix' }] } }));
    expect(await actions.startSupervisionRun(ctx, 'goal')).toContain('best skills: ParserFix');
    fetchQueue(jsonRes({ ok: true, run: { id: 'run_2' } }));
    expect(await actions.startSupervisionRun(ctx, 'goal')).toContain('best skills');
    fetchQueue(new Error('offline'));
    expect(await actions.startSupervisionRun(ctx, 'goal')).toBe('Supervision request failed.');
  });

  it('supervisionRuns covers empty, detail and exception', async () => {
    fetchQueue(jsonRes({ runs: [] }));
    expect(await actions.supervisionRuns()).toContain('No supervised runs yet');
    fetchQueue(jsonRes({ runs: [{ status: 'running', goal: 'g', iteration: 1, maxIterations: 8, id: 'run_12345678' }] }));
    expect(await actions.supervisionRuns()).toContain('[running] g');
    fetchQueue(new Error('offline'));
    expect(await actions.supervisionRuns()).toBe('Supervision ledger request failed.');
  });
});

describe('copilotActions coverage — generate / UFC', () => {
  it('generateFile reports the retired bridge', async () => {
    expect(await actions.generateFile(ctx, 'a.ts', 'd')).toContain('retired');
  });

  it('ufcTools reports the retired bridge', async () => {
    expect(await actions.ufcTools()).toContain('retired');
  });

  it('ufcCall reports the retired bridge', async () => {
    expect(await actions.ufcCall('convert_pdf', 'nope')).toContain('retired');
    expect(await actions.ufcCall('convert_pdf', '{}')).toContain('convert_pdf');
  });
});

describe('copilotActions coverage — recourse', () => {
  it('recourseStatusSummary covers offline, status, synergy and exception', async () => {
    fetchQueue(jsonRes({ available: false }), jsonRes({ available: false }));
    expect(await actions.recourseStatusSummary()).toContain('Recourse offline');
    fetchQueue(jsonRes({ available: true, data: { status: 'ok', message: 'hello' } }), jsonRes({ available: false }));
    expect(await actions.recourseStatusSummary()).toContain('Recourse: ok');
    fetchQueue(jsonRes({ available: false }), jsonRes({ available: true, data: { domains: [1, 2] } }));
    expect(await actions.recourseStatusSummary()).toContain('2 domain(s)');
    fetchQueue(jsonRes({ available: false }), jsonRes({ available: true, data: [1] }));
    expect(await actions.recourseStatusSummary()).toContain('1 domain(s)');
    fetchQueue(new Error('offline'));
    expect(await actions.recourseStatusSummary()).toBe('Recourse request failed.');
  });

  it('synergyRecall covers unavailable, empty, items and exception', async () => {
    fetchQueue(jsonRes({ available: false, error: 'down' }));
    expect(await actions.synergyRecall('q')).toContain('unavailable');
    fetchQueue(jsonRes({ available: true, data: { hits: [] } }));
    expect(await actions.synergyRecall('q')).toContain('No recalled memory');
    fetchQueue(jsonRes({ available: true, data: { hits: [{ text: 'aaa' }, { content: 'bbb' }, { other: 1 }] } }));
    const out = await actions.synergyRecall('q');
    expect(out).toContain('aaa');
    expect(out).toContain('bbb');
    fetchQueue(new Error('offline'));
    expect(await actions.synergyRecall('q')).toBe('Recourse recall request failed.');
  });

  it('recourseRegistrySummary covers unavailable, empty, entries and exception', async () => {
    fetchQueue(jsonRes({ available: false, error: 'off' }));
    expect(await actions.recourseRegistrySummary()).toContain('unavailable');
    fetchQueue(jsonRes({ available: true, data: { registry: [] } }));
    expect(await actions.recourseRegistrySummary()).toBe('Recourse registry empty.');
    fetchQueue(jsonRes({ available: true, data: { registry: [{ name: 'tool', domain: 'd', currentVersion: 2, versions: [{ version: 1, score: 1 }, { version: 2, score: 9 }], entrypoint: '.selfhosted/x', healthStatus: 'ok' }] } }));
    const out = await actions.recourseRegistrySummary();
    expect(out).toContain('score=9');
    expect(out).toContain('self-hosted');
    fetchQueue(new Error('offline'));
    expect(await actions.recourseRegistrySummary()).toBe('Recourse registry request failed.');
  });

  it('recourseAgendaSummary covers unavailable, empty, items and exception', async () => {
    fetchQueue(jsonRes({ available: false }));
    expect(await actions.recourseAgendaSummary()).toContain('unavailable');
    fetchQueue(jsonRes({ available: true, data: { items: [] } }));
    expect(await actions.recourseAgendaSummary()).toBe('Recourse agenda empty.');
    fetchQueue(jsonRes({ available: true, data: { agenda: [{ goal: 'g1', score: 5 }, { summary: 's2' }] } }));
    const out = await actions.recourseAgendaSummary();
    expect(out).toContain('g1');
    expect(out).toContain('(5)');
    fetchQueue(new Error('offline'));
    expect(await actions.recourseAgendaSummary()).toBe('Recourse agenda request failed.');
  });

  it('recourseUpgradeSummary covers unavailable, empty delta, bits and exception', async () => {
    fetchQueue(jsonRes({ available: false }));
    expect(await actions.recourseUpgradeSummary()).toContain('unavailable');
    fetchQueue(jsonRes({ available: true, data: {} }));
    expect(await actions.recourseUpgradeSummary()).toBe('Recourse upgrade report has no delta.');
    fetchQueue(jsonRes({ available: true, data: { addedTools: [1], upgradedTools: [1], removedTools: [1], benchmarkSolvedDelta: 2, selfhostedDelta: 3 } }));
    const out = await actions.recourseUpgradeSummary();
    expect(out).toContain('+1 tools');
    expect(out).toContain('self-hosted Δ3');
    fetchQueue(new Error('offline'));
    expect(await actions.recourseUpgradeSummary()).toBe('Recourse upgrade report request failed.');
  });

  it('recourseHeal covers unavailable, success, truncation and exception', async () => {
    fetchQueue(jsonRes({ available: false, error: 'offline' }));
    expect(await actions.recourseHeal(ctx)).toContain('unavailable');
    fetchQueue(jsonRes({ available: true, data: { healed: 1 } }));
    expect(await actions.recourseHeal(ctx)).toBe('{"healed":1}');
    fetchQueue(jsonRes({ available: true, data: { blob: 'x'.repeat(2000) } }));
    expect(await actions.recourseHeal(ctx)).toContain('truncated');
    fetchQueue(new Error('offline'));
    expect(await actions.recourseHeal(ctx)).toBe('Recourse heal request failed.');
  });
});

describe('copilotActions coverage — dream / snapshot', () => {
  it('dreamSummary covers unavailable, empty, entries and exception', async () => {
    fetchQueue(jsonRes({ ok: false }));
    expect(await actions.dreamSummary()).toBe('Dream state unavailable.');
    fetchQueue(jsonRes({ ok: true, entries: [] }));
    expect(await actions.dreamSummary()).toBe('Dream state empty — no repos tracked yet.');
    fetchQueue(jsonRes({ ok: true, summary: { graded: 1, total: 2, healthy: 1, attention: 1, critical: 0 }, entries: [{ name: 'app', grade: 'A', score: 90, status: 'healthy', development: 'active' }] }));
    const out = await actions.dreamSummary();
    expect(out).toContain('Dream: 1/2 graded');
    expect(out).toContain('app: A');
    fetchQueue(new Error('offline'));
    expect(await actions.dreamSummary()).toBe('Dream state request failed.');
  });

  it('snapshotSummary covers unavailable, full snapshot, empty sections and exception', async () => {
    fetchQueue(jsonRes({ ok: false }));
    expect(await actions.snapshotSummary()).toBe('Snapshot unavailable.');

    fetchQueue(jsonRes({
      ok: true,
      snapshot: {
        project: { ok: true, repositoryName: 'acme/app' },
        drift: { ok: true, ahead: 1, behind: 2, uncommitted: 3 },
        audit: { ok: true, verdict: 'pass' },
        runs: { ok: true, total: 5, active: 1 },
        ecosystem: { ok: true, entries: 9 },
        incidents: { ok: true, recent: [{}, {}] },
        recourse: { summary: 'online' },
      },
    }));
    const out = await actions.snapshotSummary();
    expect(out).toContain('project: acme/app');
    expect(out).toContain('audit: pass');
    expect(out).toContain('ecosystem: 9 entries');

    fetchQueue(jsonRes({ ok: true, snapshot: {} }));
    const empty = await actions.snapshotSummary();
    expect(empty).toContain('project: none');
    expect(empty).toContain('drift: n/a');
    expect(empty).toContain('recourse: offline');

    fetchQueue(new Error('offline'));
    expect(await actions.snapshotSummary()).toBe('Snapshot request failed.');
  });
});
