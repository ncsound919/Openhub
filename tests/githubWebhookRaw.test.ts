import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'node:crypto';
import { captureWebhookRawBody, verifyGitHubSignature, GITHUB_WEBHOOK_PATH } from '../src/services/githubWebhookRaw';

const SECRET = 'test-webhook-secret';

function sign(body: string): string {
  return `sha256=${crypto.createHmac('sha256', SECRET).update(Buffer.from(body)).digest('hex')}`;
}

// Mirrors openhub/server.ts: the GLOBAL json parser (with the capture hook) is
// mounted before the webhook route, exactly as in production.
function makeApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '50mb', verify: captureWebhookRawBody }));
  app.post(GITHUB_WEBHOOK_PATH, (req, res) => {
    const raw = (req as express.Request & { rawBody?: Buffer }).rawBody;
    const sig = String(req.headers['x-hub-signature-256'] || '');
    if (!verifyGitHubSignature(raw, SECRET, sig)) {
      return res.status(401).json({ error: 'invalid signature' });
    }
    res.json({ ok: true, body: req.body });
  });
  return app;
}

describe('github webhook raw-body capture', () => {
  it('captures raw bytes even though the global parser runs first, and accepts a valid signature', async () => {
    const payload = JSON.stringify({ action: 'opened', repository: { full_name: 'o/r' } });
    const res = await request(makeApp())
      .post(GITHUB_WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', sign(payload))
      .send(payload);
    expect(res.status).toBe(200);
    expect(res.body.body).toEqual({ action: 'opened', repository: { full_name: 'o/r' } });
  });

  it('rejects a forged signature (fails closed)', async () => {
    const payload = JSON.stringify({ action: 'opened' });
    const res = await request(makeApp())
      .post(GITHUB_WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', 'sha256=deadbeef')
      .send(payload);
    expect(res.status).toBe(401);
  });

  it('rejects a missing signature', async () => {
    const res = await request(makeApp())
      .post(GITHUB_WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ action: 'ping' }));
    expect(res.status).toBe(401);
  });

  it('does not retain raw bodies for non-webhook paths', async () => {
    const app = express();
    let seen: Buffer | undefined;
    app.use(
      express.json({
        verify: (req, res, buf) => {
          captureWebhookRawBody(req as express.Request, res, buf);
          seen = (req as express.Request & { rawBody?: Buffer }).rawBody;
        },
      }),
    );
    app.post('/api/other', (_req, res) => res.json({ ok: true }));
    const res = await request(app).post('/api/other').set('Content-Type', 'application/json').send('{"a":1}');
    expect(res.status).toBe(200);
    expect(seen).toBeUndefined();
  });
});
