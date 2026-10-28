import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACTION_SCHEMA, parseAction } from '../src/harness/loop';
import { buildSystemPrompt, renderAppMap } from '../src/harness/systemMap';
import { executeTool, TOOLS } from '../src/harness/tools';
import { serializeEvent } from '../src/harness/events';
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

  it('keeps phase 1 read-only', () => {
    for (const tool of TOOLS) {
      expect(tool.risk).toBe('read');
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect(tool.annotations.destructiveHint).toBe(false);
    }
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

describe('SSE frame', () => {
  it('uses the event-stream shape with an id', () => {
    const frame = serializeEvent('tool.result', 7, { tool: 'fleet.status' });
    expect(frame).toContain('id: 7');
    expect(frame).toContain('event: tool.result');
    expect(frame).toContain('data: {"tool":"fleet.status"}');
    expect(frame.endsWith('\n\n')).toBe(true);
  });
});
