import { Router } from 'express';
import {
  publishToChannel,
  channelHistory,
  subscribeToChannel,
  resolveSince,
  type ChannelMessage,
} from '../services/channel.js';

/**
 * ntfy-compatible channel server (mounted at `/ntfy`).
 *
 * Open-Chat's ntfy bot subscribes with host set to a full URL and topic set to
 * the channel, e.g.  host `http://127.0.0.1:<port>/ntfy`  topic `openhub-reports`.
 * That yields `GET /ntfy/openhub-reports/json` (NDJSON stream) and
 * `POST /ntfy` (publish). No third-party server; local-first.
 *
 * Auth FAILS CLOSED: `OPENHUB_NTFY_TOKEN` must be set, otherwise the channel
 * refuses every request. It used to default open, which published an
 * unauthenticated read/write message bus on whatever interface OpenHub was
 * bound to — a loopback bind is a deployment detail, not an access control.
 * Set `OPENHUB_NTFY_ALLOW_ANONYMOUS=1` to restore the old open behaviour.
 */

const KEEPALIVE_MS = 30_000;

/** Emit in the exact shape Open-Chat's NtfyClient parses. */
function toNtfy(msg: ChannelMessage): Record<string, unknown> {
  return { event: 'message', ...msg };
}

function timingSafeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorized(req: { headers: Record<string, unknown>; query: Record<string, unknown> }, token: string): boolean {
  if (!token) return process.env.OPENHUB_NTFY_ALLOW_ANONYMOUS === '1';
  const header = String(req.headers['authorization'] || '');
  if (header.startsWith('Bearer ') && timingSafeEquals(header.slice(7).trim(), token)) return true;
  return typeof req.query.token === 'string' && timingSafeEquals(req.query.token, token);
}

export function createNtfyRouter(): Router {
  const router = Router();

  router.post('/', (req, res) => {
    const token = process.env.OPENHUB_NTFY_TOKEN || '';
    if (!authorized(req as never, token)) return res.status(401).json({ error: 'unauthorized' });
    const body = (req.body && typeof req.body === 'object') ? (req.body as Record<string, unknown>) : {};
    const topic = typeof body.topic === 'string' ? body.topic : '';
    const message = typeof body.message === 'string' ? body.message : '';
    if (!topic || !message) {
      return res.status(400).json({ error: 'topic and message are required' });
    }
    const msg = publishToChannel({
      topic,
      message,
      title: typeof body.title === 'string' ? body.title : undefined,
      priority: typeof body.priority === 'number' ? body.priority : undefined,
      tags: Array.isArray(body.tags) ? (body.tags as string[]) : undefined,
    });
    res.json(toNtfy(msg));
  });

  // Snapshot history (poll mode) — useful for clients/tests.
  router.get('/:topic/json', (req, res) => {
    const token = process.env.OPENHUB_NTFY_TOKEN || '';
    if (!authorized(req as never, token)) return res.status(401).json({ error: 'unauthorized' });

    const topic = req.params.topic;
    const sinceTs = resolveSince(typeof req.query.since === 'string' ? req.query.since : undefined);
    const history = channelHistory(topic, 500).filter((m) => m.time >= sinceTs);

    if (req.query.poll === '1' || req.query.poll === 'true') {
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.end(history.map((m) => JSON.stringify(toNtfy(m))).join('\n') + (history.length ? '\n' : ''));
      return;
    }

    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const write = (line: object) => { try { res.write(`${JSON.stringify(line)}\n`); } catch { /* closed */ } };
    for (const m of history) write(toNtfy(m));

    const unsubscribe = subscribeToChannel(topic, (m) => write(toNtfy(m)));
    const keepalive = setInterval(() => write({}), KEEPALIVE_MS);

    req.on('close', () => {
      clearInterval(keepalive);
      unsubscribe();
    });
  });

  return router;
}
