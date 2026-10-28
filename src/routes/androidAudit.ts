import { Router, type RequestHandler } from 'express';

/**
 * Android Audit Desk bridge.
 *
 * The desk binds to loopback on the phone (127.0.0.1:8765). OpenHub may be
 * reached through a tunnel or another device, so the browser cannot call that
 * loopback directly. This router proxies reads through OpenHub's own origin.
 *
 * Read-only by design: uploads and scans stay on the desk. Every failure is
 * reported as `{ ok: false, reason }` with 503, never an empty success.
 */

const DESK_BASE = (process.env.ANDROID_AUDIT_DESK_URL || 'http://127.0.0.1:8765').replace(/\/+$/, '');
const TIMEOUT_MS = Number(process.env.ANDROID_AUDIT_TIMEOUT_MS || 15_000);
const FORMATS = new Set(['json', 'md', 'agent-md', 'agent-json', 'sarif']);

async function deskFetch(path: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(`${DESK_BASE}${path}`, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function forwardJson(path: string): Promise<{ status: number; body: unknown }> {
  const res = await deskFetch(path);
  const text = await res.text();
  let body: unknown = { ok: false, reason: `desk returned HTTP ${res.status}` };
  try {
    body = text ? JSON.parse(text) : body;
  } catch {
    body = { ok: false, reason: text.slice(0, 500) || `desk returned HTTP ${res.status}` };
  }
  return { status: res.status, body };
}

export function createAndroidAuditRouter(deps: { authMiddleware: RequestHandler }): Router {
  const router = Router();
  router.use(deps.authMiddleware);

  router.get('/android-audit/health', async (_req, res) => {
    try {
      const { status, body } = await forwardJson('/api/health');
      res.status(status).json({ ...(body as object), desk: DESK_BASE });
    } catch (err) {
      res.status(503).json({ ok: false, reason: err instanceof Error ? err.message : 'audit desk unreachable', desk: DESK_BASE });
    }
  });

  router.get('/android-audit/profiles', async (_req, res) => {
    try {
      const { status, body } = await forwardJson('/api/profiles');
      res.status(status).json(body);
    } catch (err) {
      res.status(503).json({ ok: false, reason: err instanceof Error ? err.message : 'audit desk unreachable' });
    }
  });

  router.get('/android-audit/integrations', async (_req, res) => {
    try {
      const { status, body } = await forwardJson('/api/integrations');
      res.status(status).json(body);
    } catch (err) {
      res.status(503).json({ ok: false, reason: err instanceof Error ? err.message : 'audit desk unreachable' });
    }
  });

  router.get('/android-audit/report', async (req, res) => {
    const id = Number(req.query.id);
    const format = String(req.query.format || 'json');
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, reason: 'id must be a positive integer' });
    }
    if (!FORMATS.has(format)) {
      return res.status(400).json({ ok: false, reason: `format must be one of ${[...FORMATS].join(', ')}` });
    }
    try {
      const upstream = await deskFetch(`/api/report?id=${id}&format=${encodeURIComponent(format)}`);
      const text = await upstream.text();
      const type = format === 'sarif'
        ? 'application/sarif+json; charset=utf-8'
        : format === 'md' || format === 'agent-md'
          ? 'text/markdown; charset=utf-8'
          : 'application/json; charset=utf-8';
      res.status(upstream.status).type(type).send(text);
    } catch (err) {
      res.status(503).json({ ok: false, reason: err instanceof Error ? err.message : 'audit desk unreachable' });
    }
  });

  return router;
}
