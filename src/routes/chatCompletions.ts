import express from 'express';
import { type LlmMessage, type LlmTier } from '../services/llmRouter';
import { runAppLlm } from '../services/appModel';

/**
 * OpenAI-compatible chat endpoint — the ONE model contract every app on the
 * phone calls.
 *
 * OpenHub's normal /api/* surface is browser-cookie + CSRF auth, which an
 * Android app or a phone bot cannot use. This router is mounted at the ROOT (so
 * the path is exactly `POST /v1/chat/completions`) and authenticates with a
 * static Bearer token from `OPENHUB_CHAT_TOKEN`.
 *
 * Tiers:
 *   local  — the phone's Qwen model, tried first for short work
 *   gateway — the shared edge gateway (`mobile-gateway`), which owns the
 *             provider keys and runs its own task-aware free-first lane order
 *
 * Model aliases are resolved here, not by the edge: `auto`/`fleet-free` means
 * "let the router decide", `code`/`reasoning`/`fast`/`free` set the lane order,
 * and a lane id (`gemini`, `deepseek`, …) pins that lane.
 */

interface ChatBody {
  model?: string;
  stream?: boolean;
  messages?: Array<{ role?: string; content?: unknown }>;
  /** Optional task hint; the header wins when both are present. */
  task?: string;
}

/** Aliases that mean "route by policy" rather than "use this exact model". */
const ALIASES: Record<string, { task?: string; tier?: LlmTier }> = {
  auto: {},
  'fleet-free': {},
  fast: { task: 'fast' },
  general: { task: 'general' },
  code: { task: 'code' },
  coding: { task: 'code' },
  reasoning: { task: 'reasoning' },
  free: { task: 'free' },
  local: { tier: 'local' },
};

function bearerToken(req: express.Request): string {
  const header = req.header('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : '';
}

/** Fail-closed: a token MUST be configured, otherwise the endpoint refuses. */
function authorized(req: express.Request): boolean {
  const expected = (process.env.OPENHUB_CHAT_TOKEN ?? '').trim();
  if (!expected) return false;
  const got = bearerToken(req);
  if (!got) return false;
  // Length check first (timing-safe compare needs equal lengths).
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i += 1) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/** Coerce an OpenAI messages array into the llmRouter's expected shape. */
function toLlmMessages(raw: ChatBody['messages']): LlmMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: LlmMessage[] = [];
  for (const m of raw) {
    const role = m?.role === 'system' || m?.role === 'assistant' || m?.role === 'user' ? m.role : 'user';
    const content = typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '');
    if (content.trim()) out.push({ role, content } as LlmMessage);
  }
  return out;
}

function routeHint(model: string | undefined, headerTask: string | null, bodyTask: string | undefined): {
  model?: string;
  task: string;
  tier?: LlmTier;
} {
  const task = (headerTask || bodyTask || 'general').toLowerCase();
  if (!model) return { task };
  const alias = ALIASES[model];
  if (alias) return { task: alias.task ?? task, tier: alias.tier };
  // A lane id or `lane/model` is a deliberate pin; the gateway validates it.
  return { task, model };
}

export function createChatCompletionsRouter(): express.Router {
  const router = express.Router();

  router.get('/v1/models', async (req, res) => {
    if (!authorized(req)) {
      return res.status(401).json({
        error: {
          message: process.env.OPENHUB_CHAT_TOKEN
            ? 'Invalid API token.'
            : 'Chat endpoint disabled: set OPENHUB_CHAT_TOKEN to enable it.',
          type: 'invalid_request_error',
        },
      });
    }

    const local = {
      id: process.env.OPENHUB_LOCAL_LLM_MODEL || 'qwen3.5-4b',
      object: 'model',
      owned_by: 'openhub-local',
      lane: 'local',
      tier: 'local',
    };
    const base = (process.env.OPENHUB_LLM_BASE_URL || '').replace(/\/+$/, '');
    let remote: Array<Record<string, unknown>> = [];
    let remoteError: string | null = null;
    if (base) {
      try {
        const key = (process.env.OPENHUB_LLM_KEY || process.env.LITELLM_MASTER_KEY || '').trim();
        const r = await fetch(`${base}/v1/models`, {
          headers: key ? { authorization: `Bearer ${key}` } : {},
          signal: AbortSignal.timeout(8000),
        });
        if (r.ok) {
          const body = (await r.json()) as { data?: Array<Record<string, unknown>> };
          remote = Array.isArray(body.data) ? body.data : [];
        } else {
          remoteError = `gateway HTTP ${r.status}`;
        }
      } catch (err) {
        remoteError = err instanceof Error ? err.message : String(err);
      }
    }

    return res.json({
      object: 'list',
      data: [local, ...remote],
      local,
      remote,
      remote_error: remoteError,
    });
  });

  router.post('/v1/chat/completions', async (req, res) => {
    if (!authorized(req)) {
      return res.status(401).json({
        error: {
          message: process.env.OPENHUB_CHAT_TOKEN
            ? 'Invalid API token.'
            : 'Chat endpoint disabled: set OPENHUB_CHAT_TOKEN to enable it.',
          type: 'invalid_request_error',
        },
      });
    }

    const body = (req.body ?? {}) as ChatBody;
    const messages = toLlmMessages(body.messages);
    if (messages.length === 0) {
      return res.status(400).json({ error: { message: 'messages must be a non-empty array.', type: 'invalid_request_error' } });
    }

    const bodyModel = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : undefined;
    const hint = routeHint(bodyModel, req.header('x-llm-task') ?? null, body.task);
    const app = (req.header('x-openhub-app') || req.header('x-llm-app') || 'external').trim() || 'external';

    try {
      const result = await runAppLlm(messages, {
        model: hint.model,
        task: hint.task,
        tier: hint.tier,
        app,
      });
      if (!result.ok || typeof result.text !== 'string') {
        return res.status(502).json({
          error: { message: result.error ?? 'Upstream model request failed.', type: 'upstream_error' },
        });
      }

      const created = Math.floor(Date.now() / 1000);
      const id = `chatcmpl-openhub-${created}-${Math.random().toString(36).slice(2, 10)}`;
      const lane = result.tier === 'local' ? 'local' : 'gateway';

      // Streaming: emit one content delta, a stop chunk, then [DONE]. runLlm is
      // non-streaming, so the reply arrives as a single delta — still valid SSE.
      if (body.stream) {
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();
        const frame = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
        frame({ id, object: 'chat.completion.chunk', created, model: bodyModel ?? 'openhub', choices: [{ index: 0, delta: { role: 'assistant', content: result.text }, finish_reason: null }] });
        frame({ id, object: 'chat.completion.chunk', created, model: bodyModel ?? 'openhub', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      return res.json({
        id,
        object: 'chat.completion',
        created,
        model: bodyModel ?? 'openhub',
        provider: result.provider ?? undefined,
        _llm: { tier: result.tier ?? 'gateway', lane, task: hint.task, app },
        choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: 'stop' }],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ error: { message: message || 'Chat completion failed.', type: 'server_error' } });
    }
  });

  return router;
}
