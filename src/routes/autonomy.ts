import express from 'express';
import { autonomyLoop, type AutonomyLoop } from '../services/autonomyLoop.js';

/**
 * Autonomy heartbeat surface.
 *   GET  /api/autonomy/state    latest self-awareness snapshot (null until first tick)
 *   GET  /api/autonomy/stream   Server-Sent Events: one message per tick
 *   POST /api/autonomy/tick     force an immediate tick (operator/tests)
 *
 * Auth-gated. The UI streams this so services/insights/health update with no
 * manual refresh — the node keeps itself current.
 */
export function createAutonomyRouter(deps: { authMiddleware: express.RequestHandler; loop?: AutonomyLoop }): express.Router {
  const router = express.Router();
  const loop = deps.loop ?? autonomyLoop;
  router.use(deps.authMiddleware);

  router.get('/autonomy/state', async (_req, res) => {
    try {
      res.json({ ok: true, snapshot: loop.getState() });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post('/autonomy/tick', async (_req, res) => {
    try {
      const snapshot = await loop.runTick();
      res.json({ ok: true, snapshot });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.get('/autonomy/stream', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (typeof (res as any).flushHeaders === 'function') (res as any).flushHeaders();

    const send = (snapshot: unknown) => {
      try {
        res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
      } catch {
        /* client gone */
      }
    };

    const current = loop.getState();
    if (current) send(current);

    const unsubscribe = loop.subscribe(send);
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* client gone */
      }
    }, 25_000);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  return router;
}
