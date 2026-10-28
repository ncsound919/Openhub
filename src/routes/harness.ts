import express from 'express';
import {
  addMessage,
  addToolCall,
  createSession,
  decideApproval,
  getApproval,
  getSession,
  listApprovals,
  listMessages,
  listSessions,
  listToolCalls,
} from '../harness/store';
import { publish, subscribe } from '../harness/events';
import { runTurn } from '../harness/loop';
import { TOOLS, executeTool } from '../harness/tools';

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
      approvals: listApprovals(session.id, 50),
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
        approval: result.approval ?? null,
        messages: listMessages(session.id, 100),
        approvals: listApprovals(session.id, 50),
        error: result.error,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addMessage(session.id, 'assistant', `Harness error: ${message}`);
      return res.status(500).json({ ok: false, error: message });
    }
  });

  router.post('/harness/approvals/:id', async (req, res) => {
    const approval = getApproval(req.params.id);
    if (!approval) return res.status(404).json({ ok: false, error: 'approval not found' });
    if (approval.status !== 'pending') {
      return res.status(409).json({ ok: false, error: `approval is already ${approval.status}` });
    }

    const allow = req.body?.allow === true;
    if (!allow) {
      const denied = decideApproval(approval.id, 'denied', 'operator denied');
      const text = `Denied: ${approval.tool} was not run.`;
      addMessage(approval.sessionId, 'assistant', text);
      publish(approval.sessionId, 'approval.resolved', { approval: denied });
      return res.json({ ok: true, approval: denied, text });
    }

    const startedAt = Date.now();
    publish(approval.sessionId, 'tool.started', {
      tool: approval.tool,
      args: approval.args,
      at: new Date(startedAt).toISOString(),
    });
    const result = await executeTool(approval.tool, approval.args);
    const finishedAt = Date.now();
    addToolCall(
      approval.sessionId,
      approval.tool,
      approval.args,
      result as unknown as Record<string, unknown>,
      result.ok ? 'ok' : 'error',
      startedAt,
      finishedAt,
    );
    const updated = decideApproval(
      approval.id,
      result.ok ? 'executed' : 'failed',
      result.ok ? null : result.error ?? result.summary,
      result as unknown as Record<string, unknown>,
    );
    const text = result.ok
      ? `${approval.tool}: ${result.summary}`
      : `${approval.tool} failed: ${result.summary}`;
    addMessage(approval.sessionId, 'assistant', text);
    publish(approval.sessionId, 'tool.result', {
      tool: approval.tool,
      ok: result.ok,
      summary: result.summary,
      at: result.at,
    });
    publish(approval.sessionId, 'approval.resolved', { approval: updated, result });
    return res.json({ ok: result.ok, approval: updated, result, text });
  });

  return router;
}
