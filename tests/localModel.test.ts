import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  localModelTarget,
  normalizeBaseUrl,
  probeLocalModel,
  probeBase,
  localOpencodeModel,
  localProviderConfig,
  mergeLocalProvider,
  resetLocalModelCache,
  LOCAL_PROVIDER_ID,
} from '../src/services/localModel.js';

beforeEach(() => resetLocalModelCache());

function modelsResponse(ids: string[]): Response {
  return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('local model target', () => {
  it('is off when nothing is configured', () => {
    expect(localModelTarget({})).toBeNull();
    expect(localModelTarget({ OPENHUB_LOCAL_LLM_URL: '   ' })).toBeNull();
  });

  it('accepts a base with or without /v1 and de-duplicates the fallback ports', () => {
    expect(normalizeBaseUrl('http://127.0.0.1:8080/v1/')).toBe('http://127.0.0.1:8080');
    const target = localModelTarget({ OPENHUB_LOCAL_LLM_URL: 'http://127.0.0.1:8080/v1', OPENHUB_LOCAL_LLM_MODEL: 'qwen3.5-4b' });
    expect(target).toMatchObject({ baseUrl: 'http://127.0.0.1:8080', modelId: 'qwen3.5-4b' });
    expect(target?.candidates).toEqual(['http://127.0.0.1:8080', 'http://127.0.0.1:11434']);
  });

  it('probes the configured base, then the other well-known local port', async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL) => {
      seen.push(String(url));
      if (String(url).includes(':11434')) throw new Error('connect ECONNREFUSED');
      return modelsResponse(['Qwen3.5-4B-Q4_K_M.gguf']);
    }) as unknown as typeof fetch;
    const probe = await probeLocalModel({ OPENHUB_LOCAL_LLM_URL: 'http://127.0.0.1:11434', OPENHUB_LOCAL_LLM_MODEL: 'qwen3.5-4b' }, { fetchImpl });
    expect(seen).toEqual(['http://127.0.0.1:11434/v1/models', 'http://127.0.0.1:8080/v1/models']);
    expect(probe).toMatchObject({ reachable: true, baseUrl: 'http://127.0.0.1:8080' });
    // The server advertises a renamed GGUF: its id is used instead of the configured one.
    expect(probe.modelId).toBe('Qwen3.5-4B-Q4_K_M.gguf');
  });

  it('reports unreachable with the real error and never as up', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('connect ECONNREFUSED'); }) as unknown as typeof fetch;
    const probe = await probeLocalModel({ OPENHUB_LOCAL_LLM_MODEL: 'qwen3.5-4b' }, { fetchImpl });
    expect(probe.reachable).toBe(false);
    expect(probe.baseUrl).toBeNull();
    expect(probe.error).toContain('ECONNREFUSED');
    expect(await localOpencodeModel({ OPENHUB_LOCAL_LLM_MODEL: 'qwen3.5-4b' }, { fetchImpl })).toBeNull();
  });

  it('caches the probe so prompts do not hammer the phone', async () => {
    const fetchImpl = vi.fn(async () => modelsResponse(['qwen3.5-4b'])) as unknown as typeof fetch;
    const env = { OPENHUB_LOCAL_LLM_MODEL: 'qwen3.5-4b' };
    await probeLocalModel(env, { fetchImpl });
    await probeLocalModel(env, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await localOpencodeModel(env, { fetchImpl })).toEqual({ providerID: LOCAL_PROVIDER_ID, modelID: 'qwen3.5-4b' });
  });

  it('treats HTTP errors as an answer, not a reason to try another port', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const res = await probeBase('http://127.0.0.1:8080', fetchImpl, 100);
    expect(res).toMatchObject({ ok: false, error: 'HTTP 500' });
  });
});

describe('opencode provider config for the local model', () => {
  it('declares a tools-capable OpenAI-compatible provider in the v1 shape', () => {
    const target = localModelTarget({ OPENHUB_LOCAL_LLM_MODEL: 'qwen3.5-4b' })!;
    const cfg = localProviderConfig(target, ['Qwen3.5-4B-Q4_K_M.gguf']) as Record<string, any>;
    // opencode 1.19.x reads `provider`/`npm`/`options`; the v2 shape is ignored.
    expect(cfg.providers).toBeUndefined();
    const local = cfg.provider[LOCAL_PROVIDER_ID];
    expect(local.npm).toBe('@ai-sdk/openai-compatible');
    expect(local.options.baseURL).toBe('http://127.0.0.1:11434/v1');
    expect(local.models['qwen3.5-4b'].tool_call).toBe(true);
    expect(local.models['Qwen3.5-4B-Q4_K_M.gguf']).toBeDefined();
  });

  it('merges into the operator config without dropping MCP servers or other providers', () => {
    const userConfig = {
      $schema: 'https://opencode.ai/config.json',
      mcp: { 'aws-mcp': { type: 'local', command: ['npx', 'aws-mcp'] } },
      provider: { openrouter: { npm: '@ai-sdk/openrouter' } },
    };
    const target = localModelTarget({ OPENHUB_LOCAL_LLM_MODEL: 'qwen3.5-4b' })!;
    const merged = mergeLocalProvider(userConfig, target, ['qwen3.5-4b']);
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.config.mcp).toEqual(userConfig.mcp);
    expect((merged.config.provider as Record<string, unknown>).openrouter).toEqual(userConfig.provider.openrouter);
    expect((merged.config.provider as Record<string, any>)[LOCAL_PROVIDER_ID].options.baseURL).toContain('/v1');
  });

  it('refuses to build an overlay from a non-object config instead of dropping settings', () => {
    const target = localModelTarget({ OPENHUB_LOCAL_LLM_MODEL: 'qwen3.5-4b' })!;
    expect(mergeLocalProvider([1, 2, 3], target)).toMatchObject({ ok: false });
    expect(mergeLocalProvider('not json', target)).toMatchObject({ ok: false });
  });
});
