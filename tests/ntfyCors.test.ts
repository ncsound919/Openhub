import express from 'express';
import { createServer } from 'node:http';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createNtfyRouter } from '../src/routes/ntfy';
import { publishToChannel } from '../src/services/channel';

let server: ReturnType<typeof createServer>;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(createNtfyRouter());
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(() => {
  server?.close();
});

describe('ntfy channel phone compatibility (Cloudflare tunnel / capacitor webview)', () => {
  it('answers OPTIONS preflight with wildcard CORS for any origin', async () => {
    const res = await fetch(`${base}/openhub-reports/json`, {
      method: 'OPTIONS',
      headers: { Origin: 'capacitor://localhost' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('serves the NDJSON stream with CORS headers when token-authenticated', async () => {
    process.env.OPENHUB_NTFY_TOKEN = 'test-token';
    try {
      publishToChannel({ topic: 'openhub-reports', title: 'OpenHub self-report', message: 'hello' }, process.env);
      const res = await fetch(`${base}/openhub-reports/json?poll=1`, {
        headers: { Origin: 'capacitor://localhost', Authorization: 'Bearer test-token' },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      const text = await res.text();
      expect(text).toContain('"event":"message"');
      expect(text).toContain('OpenHub self-report');
    } finally {
      delete process.env.OPENHUB_NTFY_TOKEN;
    }
  });

  it('refuses unauthenticated reads (fail-closed) but still returns CORS headers', async () => {
    process.env.OPENHUB_NTFY_TOKEN = 'test-token';
    try {
      const res = await fetch(`${base}/openhub-reports/json?poll=1`, {
        headers: { Origin: 'capacitor://localhost' },
      });
      expect(res.status).toBe(401);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    } finally {
      delete process.env.OPENHUB_NTFY_TOKEN;
    }
  });
});