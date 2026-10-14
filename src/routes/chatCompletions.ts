import express from 'express';
import { runLlm, type LlmMessage } from '../services/llmRouter';

/**
 * OpenAI-compatible chat endpoint for external bot clients (Open-Chat).
 *
 * OpenHub's normal /api/* surface is browser-cookie + CSRF auth, which a phone
 * bot cannot use. This router is mounted at the ROOT (so the path is exactly
 * `POST /v1/chat/completions`) and authenticates with a static Bearer token from
 * `OPENHUB_CHAT_TOKEN` — the same shape Open-Chat's generic HTTP protocol sends.
 *
 * It is intentionally OpenAI-shaped (both JSON and SSE) so Open-Chat's existing
 * "hermes" protocol works with zero client changes. Credentials for the model
 * gateway stay server-side; runLlm resolves them from env.
 */

interface ChatBody {
  model?: string;
  stream?: boolean;
  messages?: Array<{ role?: string; content?: unknown }>;
}

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

export function createChatCompletionsRouter(): express.Router {
  const router = express.Router();

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

    const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : undefined;

    try {
      const result = await runLlm(messages, model ? { model } : {});
      if (!result.ok || typeof result.text !== 'string') {
        return res.status(502).json({
          error: { message: result.error ?? 'Upstream model request failed.', type: 'upstream_error' },
        });
      }

      const created = Math.floor(Date.now() / 1000);
      const id = `chatcmpl-openhub-${created}-${Math.random().toString(36).slice(2, 10)}`;

      // Streaming: emit one content delta, a stop chunk, then [DONE]. runLlm is
      // non-streaming, so the reply arrives as a single delta — still valid SSE.
      if (body.stream) {
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();
        const frame = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
        frame({ id, object: 'chat.completion.chunk', created, model: model ?? 'openhub', choices: [{ index: 0, delta: { role: 'assistant', content: result.text }, finish_reason: null }] });
        frame({ id, object: 'chat.completion.chunk', created, model: model ?? 'openhub', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      return res.json({
        id,
        object: 'chat.completion',
        created,
        model: model ?? 'openhub',
        provider: result.provider ?? undefined,
        choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: 'stop' }],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ error: { message: message || 'Chat completion failed.', type: 'server_error' } });
    }
  });

  return router;
}
