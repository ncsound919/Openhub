import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeAuditCompleter } from '../src/services/auditCore';
import type { AuditRule } from '../src/core/config';

const RULE: AuditRule = {
  id: 'r1',
  name: 'rule',
  description: 'test rule',
  severity: 'medium',
  include: [],
  exclude: [],
  filePaths: [],
  enabled: true,
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function okJson(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function callOf(mock: { mock: { calls: unknown[] } }): [string, RequestInit] {
  return mock.mock.calls[0] as unknown as [string, RequestInit];
}

describe('makeAuditCompleter', () => {
  it('posts to the gateway with the ollama-cloud group and bearer', async () => {
    vi.stubEnv('AUDIT_LLM_BASE_URL', 'http://127.0.0.1:4100');
    vi.stubEnv('AUDIT_LLM_MODEL', 'ollama-cloud');
    vi.stubEnv('AUDIT_LLM_KEY', 'sk-test');
    const fetchMock = vi.fn(async () => okJson('ok'));
    vi.stubGlobal('fetch', fetchMock);

    const complete = await makeAuditCompleter();
    const out = await complete({ system: 'sys', prompt: 'usr', rule: RULE });
    expect(out).toBe('ok');

    const [url, init] = callOf(fetchMock);
    expect(String(url)).toBe('http://127.0.0.1:4100/v1/chat/completions');
    const body = JSON.parse(String(init.body)) as { model: string; messages: unknown[] };
    expect(body.model).toBe('ollama-cloud');
    expect(body.messages).toHaveLength(2);
    expect(init.headers).toMatchObject({ Authorization: 'Bearer sk-test' });
  });

  it('defaults to the ollama-cloud group when AUDIT_LLM_MODEL is unset', async () => {
    vi.stubEnv('AUDIT_LLM_MODEL', '');
    vi.stubEnv('AUDIT_LLM_KEY', 'k');
    const fetchMock = vi.fn(async () => okJson('ok'));
    vi.stubGlobal('fetch', fetchMock);

    const complete = await makeAuditCompleter();
    await complete({ system: 's', prompt: 'p', rule: RULE });
    const body = JSON.parse(String(callOf(fetchMock)[1].body)) as { model: string };
    expect(body.model).toBe('ollama-cloud');
  });

  it('throws an explicit, key-free error on a non-2xx response', async () => {
    vi.stubEnv('AUDIT_LLM_KEY', 'sk-secret-value');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 502 })));
    const complete = await makeAuditCompleter();
    await expect(complete({ system: 's', prompt: 'p', rule: RULE })).rejects.toThrow(/HTTP 502/);
  });
});
