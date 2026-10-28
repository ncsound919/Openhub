import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACTION_SCHEMA, parseAction } from '../src/harness/loop';
import { buildSystemPrompt, renderAppMap } from '../src/harness/systemMap';
import { executeTool, requiresApproval, TOOLS } from '../src/harness/tools';
import { serializeEvent } from '../src/harness/events';
import { diffFleetState, fleetStateFrom } from '../src/harness/watch';
import { fetchTts } from '../src/harness/tts';
import { APP_MANIFESTS } from '../src/harness/apps';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('app map and prompt', () => {
  it('names the real apps and tools without dumping docs', () => {
    const map = renderAppMap();
    expect(map).toContain('agent-support');
    expect(map).toContain('ecosystem-control');
    expect(map).toContain('Sieve');
    expect(map.split('\n').length).toBe(APP_MANIFESTS.length);

    const prompt = buildSystemPrompt('fleet: 3 online');
    expect(prompt).toContain('<apps>');
    expect(prompt).toContain('fleet.status');
    expect(prompt).toContain('fleet: 3 online');
    expect(prompt).toContain('Reply with ONE JSON object');
  });

  it('separates read tools from approval-gated writes', () => {
    for (const tool of TOOLS) {
      if (tool.risk === 'read') {
        expect(tool.annotations.readOnlyHint).toBe(true);
      } else {
        expect(tool.risk).toBe('write');
        expect(tool.annotations.readOnlyHint).toBe(false);
      }
      expect(tool.annotations.destructiveHint).toBe(false);
    }
    expect(TOOLS.some((t) => t.risk === 'read')).toBe(true);
    expect(TOOLS.some((t) => t.risk === 'write')).toBe(true);
  });
});

describe('action envelope', () => {
  it('is strict: every field required, no extra properties', () => {
    expect(ACTION_SCHEMA.additionalProperties).toBe(false);
    expect(ACTION_SCHEMA.required).toEqual(['type', 'say', 'tool', 'args', 'plan']);
    expect((ACTION_SCHEMA.properties.args as { additionalProperties: boolean }).additionalProperties).toBe(false);
    expect((ACTION_SCHEMA.properties.args as unknown as { required: string[] }).required).toEqual([
      'service',
      'window',
      'limit',
      'job',
      'title',
      'steps',
      'budget_usd',
      'playbook',
      'run_id',
    ]);
  });

  it('parses a valid final and a fenced tool call', () => {
    const final = parseAction(
      '{"type":"final","say":"All clear","tool":null,"args":{"service":null,"window":null,"limit":null},"plan":null}',
    );
    expect(final?.type).toBe('final');
    expect(final?.say).toBe('All clear');

    const tool = parseAction(
      '```json\n{"type":"tool","say":"checking","tool":"fleet.status","args":{"service":null,"window":"24h","limit":10},"plan":null}\n```',
    );
    expect(tool?.type).toBe('tool');
    expect(tool?.tool).toBe('fleet.status');
    expect(tool?.args.window).toBe('24h');
    expect(tool?.args.limit).toBe(10);
  });

  it('rejects prose and malformed JSON', () => {
    expect(parseAction('Here is the answer')).toBeNull();
    expect(parseAction('{"type":"tool"')).toBeNull();
    expect(parseAction('{"type":"unknown","say":"x"}')).toBeNull();
  });
});

describe('read tools', () => {
  it('summarises the fleet overview', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            ok: true,
            overview: {
              health: { online: 2, degraded: 1, offline: 0, unknown: 0 },
              total: 3,
              jobs: { total: 4, enabled: 3, failing: 1 },
              runs24h: { total: 5, ok: 4, error: 1 },
              events24h: 9,
              lastRunAt: '2026-10-28T10:00:00.000Z',
            },
          }),
          { status: 200 },
        ),
      ),
    );
    const result = await executeTool('fleet.status', {}, { ECOSYSTEM_CONTROL_TOKEN: 'test' } as NodeJS.ProcessEnv);
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('2 online');
    expect(result.summary).toContain('1 failing');
    expect(result.summary).toContain('4 ok');
  });

  it('refuses an unknown tool with the catalog in the error', async () => {
    const result = await executeTool('shell.exec', {}, {} as NodeJS.ProcessEnv);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('Unknown tool');
    expect(result.summary).toContain('fleet.status');
  });

  it('fails closed without a control token', async () => {
    const result = await executeTool('fleet.status', {}, {} as NodeJS.ProcessEnv);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('ECOSYSTEM_CONTROL_TOKEN');
  });
});

describe('write tools', () => {
  it('marks every non-read tool as approval-gated', () => {
    expect(requiresApproval('fleet.status')).toBe(false);
    expect(requiresApproval('telemetry.summary')).toBe(false);
    expect(requiresApproval('cron.pause')).toBe(true);
    expect(requiresApproval('cron.enable')).toBe(true);
    expect(requiresApproval('cron.run')).toBe(true);
    expect(requiresApproval('plan.create')).toBe(true);
    expect(requiresApproval('agent.playbook_run')).toBe(true);
    expect(requiresApproval('agent.reconcile')).toBe(true);
    expect(requiresApproval('agent.playbooks')).toBe(false);
    expect(requiresApproval('agent.playbook_runs')).toBe(false);
  });

  it('lists Agent Support playbooks through the loopback hub', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        return new Response(
          JSON.stringify({
            ok: true,
            playbooks: [
              {
                id: 'ops.fleet-health',
                title: 'Fleet health',
                domain: 'OPS',
                scheduleMinutes: 60,
                steps: 6,
              },
            ],
          }),
          { status: 200 },
        );
      }),
    );
    const result = await executeTool(
      'agent.playbooks',
      {},
      { AGENT_SUPPORT_TOKEN: 'token' } as NodeJS.ProcessEnv,
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('ops.fleet-health');
    expect(result.summary).toContain('every 60m');
    expect(calls[0]).toContain('127.0.0.1:8766/api/ecosystem/playbooks');
  });

  it('queues an Agent Support playbook run by exact id', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: String(init?.body ?? '') });
        return new Response(
          JSON.stringify({ ok: true, accepted: true, message: 'Queued one occurrence.' }),
          { status: 202 },
        );
      }),
    );
    const result = await executeTool(
      'agent.playbook_run',
      { playbook: 'ops.fleet-health' },
      { AGENT_SUPPORT_TOKEN: 'token' } as NodeJS.ProcessEnv,
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('Queued ops.fleet-health');
    expect(calls[0].url).toContain('/api/ecosystem/playbooks/run');
    expect(JSON.parse(calls[0].body)).toEqual({ playbookId: 'ops.fleet-health' });
  });

  it('pauses a job through the control plane', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: String(init?.body ?? '') });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );
    const result = await executeTool(
      'cron.pause',
      { job: 'fleet-watch' },
      { ECOSYSTEM_CONTROL_TOKEN: 'test' } as NodeJS.ProcessEnv,
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('fleet-watch is now paused');
    expect(calls[0].url).toContain('/api/jobs/fleet-watch/reconfigure');
    expect(JSON.parse(calls[0].body)).toEqual({ enabled: false });
  });

  it('creates a plan with one step per line', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: String(init?.body ?? '') });
        return new Response(JSON.stringify({ ok: true, plan: { id: 7 } }), { status: 201 });
      }),
    );
    const result = await executeTool(
      'plan.create',
      { title: 'Nightly oncology', steps: '- check worker\n2) run audit\n', budget_usd: 5 },
      { ECOSYSTEM_CONTROL_TOKEN: 'test' } as NodeJS.ProcessEnv,
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('plan #7');
    const body = JSON.parse(calls[0].body) as { steps: string[]; title: string; budget_usd: number };
    expect(calls[0].url).toContain('/api/plans');
    expect(body.title).toBe('Nightly oncology');
    expect(body.steps).toEqual(['check worker', 'run audit']);
    expect(body.budget_usd).toBe(5);
  });
});

describe('fleet watcher', () => {
  const base = {
    online: 1,
    degraded: 1,
    offline: 0,
    unknown: 15,
    total: 17,
    enabledJobs: 6,
    totalJobs: 7,
    failingJobs: 0,
    runsOk: 124,
    runsError: 1,
  };

  it('reads the control-plane overview without inventing fields', () => {
    const state = fleetStateFrom({
      overview: {
        health: { online: 1, degraded: 1, offline: 0, unknown: 15 },
        total: 17,
        jobs: { total: 7, enabled: 6, failing: 0 },
        runs24h: { ok: 124, error: 1 },
      },
    });
    expect(state).toEqual(base);
  });

  it('is silent when nothing changed', () => {
    expect(diffFleetState(base, base)).toEqual([]);
  });

  it('reports a new offline service, a failing job and new errors', () => {
    const changes = diffFleetState(base, {
      ...base,
      offline: 1,
      failingJobs: 1,
      runsError: 3,
    });
    expect(changes.join(' ')).toContain('1 service(s) offline');
    expect(changes.join(' ')).toContain('1 failing job(s)');
    expect(changes.join(' ')).toContain('2 new failed run(s)');
  });
});

describe('Kokoro loopback bridge', () => {
  it('returns the WAV bytes from the local service', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(new Uint8Array([82, 73, 70, 70]), {
          status: 200,
          headers: { 'content-type': 'audio/wav' },
        }),
      ),
    );
    const result = await fetchTts('hello', {} as NodeJS.ProcessEnv);
    expect(result.ok).toBe(true);
    expect(result.contentType).toBe('audio/wav');
    expect(Array.from(result.audio ?? [])).toEqual([82, 73, 70, 70]);
  });

  it('surfaces the exact unavailability reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: false, reason: 'Kokoro is missing model.onnx' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const result = await fetchTts('hello', {} as NodeJS.ProcessEnv);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('missing model.onnx');
  });

  it('fails closed when the service is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }));
    const result = await fetchTts('hello', {} as NodeJS.ProcessEnv);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('unreachable');
  });
});

describe('SSE frame', () => {
  it('uses the event-stream shape with an id', () => {
    const frame = serializeEvent('tool.result', 7, { tool: 'fleet.status' });
    expect(frame).toContain('id: 7');
    expect(frame).toContain('event: tool.result');
    expect(frame).toContain('data: {"tool":"fleet.status"}');
    expect(frame.endsWith('\n\n')).toBe(true);
  });
});
