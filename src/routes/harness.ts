import express from 'express';
import {
  addMessage,
  createSession,
  getSession,
  listMessages,
  listSessions,
  listToolCalls,
} from '../harness/store';
import { subscribe } from '../harness/events';
import { runTurn } from '../harness/loop';
import { TOOLS } from '../harness/tools';

/**
 * Harness HTTP surface. All routes are behind the normal OpenHub session auth.
 *
 *   GET  /api/harness/tools
 *   GET  /api/harness/sessions
 *   POST /api/harness/sessions
 *   GET  /api/harness/sessions/:id
 *   GET  /api/harness/sessions/:id/events   (SSE)
 *   POST /api/harness/sessions/:id/message
 */
export function createHarnessRouter(deps: { authMiddleware: express.RequestHandler }): express.Router {
  const router = express.Router();
  router.use(deps.authMiddleware);

  router.get('/harness/tools', (_req, res) => {
    res.json({ ok: true, tools: TOOLS });
  });

  router.get('/harness/sessions', (_req, res) => {
    res.json({ ok: true, sessions: listSessions(30) });
  });

  router.post('/harness/sessions', (req, res) => {
    const title = typeof req.body?.title === 'string' ? req.body.title : undefined;
    res.status(201).json({ ok: true, session: createSession(title) });
  });

  router.get('/harness/sessions/:id', (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ ok: false, error: 'session not found' });
    return res.json({
      ok: true,
      session,
      messages: listMessages(session.id, 100),
      toolCalls: listToolCalls(session.id, 100),
    });
  });

  router.get('/harness/sessions/:id/events', (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ ok: false, error: 'session not found' });
    return subscribe(session.id, res);
  });

  router.post('/harness/sessions/:id/message', async (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ ok: false, error: 'session not found' });
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    if (!content.trim()) return res.status(400).json({ ok: false, error: 'content is required' });

    try {
      const result = await runTurn(session.id, content);
      // The user message was persisted by runTurn; return the full pair so a
      // client that missed an SSE frame can still render the turn.
      return res.json({
        ok: result.ok,
        session,
        text: result.text,
        tier: result.tier,
        toolCalls: result.toolCalls,
        messages: listMessages(session.id, 100),
        error: result.error,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addMessage(session.id, 'assistant', `Harness error: ${message}`);
      return res.status(500).json({ ok: false, error: message });
    }
  });

  return router;
}
