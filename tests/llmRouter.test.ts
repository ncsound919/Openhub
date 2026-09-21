import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { runLlm } from '../src/services/llmRouter';

const servers: Server[] = [];

function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      handler(req, res);
    });
    // Swallow socket errors (e.g. ECONNRESET after a client-side abort).
    server.on('connection', (socket) => socket.on('error', () => {}));
    servers.push(server);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(stopServer));
});

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function jsonChatOk(res: ServerResponse, content: string): void {
  json(res, 200, { choices: [{ message: { content } }] });
}

describe('runLlm against the fleet seam', () => {
  it('returns assistant text and the provider base URL on success', async () => {
    const received: Array<{ model?: unknown; messages?: unknown }> = [];
    const { baseUrl } = await startServer((req, res) => {
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          received.push(JSON.parse(body));
          jsonChatOk(res, 'review text');
        });
      } else {
        json(res, 404, { error: 'not found' });
      }
    });

    const messages = [
      { role: 'system' as const, content: 'you are a senior reviewer' },
      { role: 'user' as const, content: 'inspect this PR' },
    ];
    const result = await runLlm(messages, { baseUrl });

    expect(result).toEqual({ ok: true, text: 'review text', provider: baseUrl });
    expect(received[0]).toMatchObject({
      model: 'fleet-free',
      messages,
    });
  });

  it('returns { ok: false, error } on HTTP 500 without throwing', async () => {
    const { baseUrl } = await startServer((_req, res) => {
      json(res, 500, { error: 'upstream exploded' });
    });

    const result = await runLlm([{ role: 'user', content: 'analyze' }], { baseUrl });

    expect(result.ok).toBe(false);
    expect(result.text).toBeNull();
    expect(result.provider).toBeNull();
    expect(result.error).toMatch(/HTTP 500/);
    expect(result.error).toContain('upstream exploded');
  });

  it('falls back to OPENHUB_LLM_FALLBACKS when the primary returns 500', async () => {
    const { baseUrl: primary } = await startServer((_req, res) => {
      json(res, 500, { error: 'primary down' });
    });
    const { baseUrl: fallback } = await startServer((req, res) => {
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        jsonChatOk(res, 'fallback review');
      } else {
        json(res, 404, { error: 'not found' });
      }
    });

    const result = await runLlm(
      [{ role: 'user', content: 'analyze' }],
      { baseUrl: primary },
      { OPENHUB_LLM_FALLBACKS: fallback },
    );

    expect(result.ok).toBe(true);
    expect(result.text).toBe('fallback review');
    expect(result.provider).toBe(fallback);
  });

  it('uses OPENHUB_LLM_FALLBACK_MODEL for the fallback attempt (local primary, API fallback)', async () => {
    const primaryModels: unknown[] = [];
    const fallbackModels: unknown[] = [];
    const { baseUrl: primary } = await startServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { primaryModels.push(JSON.parse(body).model); json(res, 500, { error: 'local down' }); });
    });
    const { baseUrl: fallback } = await startServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { fallbackModels.push(JSON.parse(body).model); jsonChatOk(res, 'api review'); });
    });

    const result = await runLlm(
      [{ role: 'user', content: 'analyze' }],
      { baseUrl: primary },
      {
        OPENHUB_LLM_MODEL: 'olmoe',
        OPENHUB_LLM_FALLBACKS: fallback,
        OPENHUB_LLM_FALLBACK_MODEL: 'fleet-free',
      },
    );

    expect(result.ok).toBe(true);
    expect(result.provider).toBe(fallback);
    expect(primaryModels).toEqual(['olmoe']);
    expect(fallbackModels).toEqual(['fleet-free']);
  });

  it('reports the last error when every provider fails', async () => {
    const { baseUrl: primary } = await startServer((_req, res) => {
      json(res, 500, { error: 'primary exploded' });
    });
    const { baseUrl: lastFallback } = await startServer((_req, res) => {
      json(res, 500, { error: 'fallback exploded' });
    });

    const result = await runLlm(
      [{ role: 'user', content: 'analyze' }],
      { baseUrl: primary },
      { OPENHUB_LLM_FALLBACKS: `http://127.0.0.1:1, ${lastFallback}` },
    );

    expect(result.ok).toBe(false);
    expect(result.text).toBeNull();
    expect(result.provider).toBeNull();
    expect(result.error).toContain('fallback exploded');
  });

  it('returns a timeout error when the provider never responds', async () => {
    const { baseUrl } = await startServer((req, _res) => {
      req.on('error', () => {});
      // Intentionally never responds; the client aborts via AbortSignal.timeout.
    });

    const result = await runLlm([{ role: 'user', content: 'analyze' }], { baseUrl, timeoutMs: 500 });

    expect(result.ok).toBe(false);
    expect(result.text).toBeNull();
    expect(result.provider).toBeNull();
    expect(result.error).toMatch(/timed out after 500ms/);
  });
});