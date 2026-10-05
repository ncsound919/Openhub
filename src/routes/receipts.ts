import express from 'express';
import {
  anchorHead,
  chainHead,
  getAnchor,
  getReceipt,
  listReceipts,
  verifyChain,
  verifyReceipt,
  type Receipt,
  type ReceiptKind,
} from '../services/receipts.js';
import { configuredOperatorRoles, isOperator, requestRole } from '../lib/operator.js';

/**
 * Per-caller receipt visibility. A receipt carrying a userId is visible to
 * that user and to operators. Operators are only distinguishable when the
 * OPENHUB_ADMIN_ROLES gate is configured (a `*` gate or an unset gate means
 * "no distinguished operators"), so:
 *   - owned receipt: owner, or an operator under a configured gate;
 *   - legacy/system receipt (no userId): everyone when the gate is unset,
 *     otherwise operators only.
 */
export function receiptVisibleTo(req: express.Request): (r: Receipt) => boolean {
  const roles = configuredOperatorRoles();
  const gated = roles.length > 0 && !roles.includes('*');
  const admin = gated && isOperator(requestRole(req), roles);
  const sub = (req as unknown as { user?: { sub?: unknown } }).user?.sub;
  const me = typeof sub === 'string' ? sub : '';
  return (r: Receipt) => {
    if (admin) return true;
    if (!r.userId) return !gated;
    return r.userId === me;
  };
}

/**
 * Receipts API — read + verify the evidence spine.
 *
 *   GET  /api/receipts                      list (filter by run/scorer/kind)
 *   GET  /api/receipts/chain                head, anchor, and chain verification
 *   POST /api/receipts/anchor               anchor the current head externally
 *   GET  /api/receipts/:id                  one receipt + content verification
 *   GET  /api/receipts/:id/verify           same, explicit
 *
 * All routes are auth-gated; static paths are declared before `:id` so they are
 * not shadowed.
 */
export function createReceiptsRouter(deps: { authMiddleware: express.RequestHandler }): express.Router {
  const router = express.Router();
  router.use(deps.authMiddleware);

  router.get('/receipts', (req, res) => {
    try {
      const limit = Number(req.query.limit);
      const kind = typeof req.query.kind === 'string' ? (req.query.kind as ReceiptKind) : undefined;
      const receipts = listReceipts({
        ...(typeof req.query.runId === 'string' ? { runId: req.query.runId } : {}),
        ...(typeof req.query.scorer === 'string' ? { scorer: req.query.scorer } : {}),
        ...(kind ? { kind } : {}),
        ...(req.query.includeProbes === '1' ? { includeProbes: true } : {}),
        ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
        visible: receiptVisibleTo(req),
      });
      res.json({ ok: true, receipts, count: receipts.length });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  const handleChain = (_req: express.Request, res: express.Response) => {
    try {
      const anchor = getAnchor();
      const result = verifyChain(undefined, anchor ?? undefined);
      res.json({ ok: true, head: chainHead(), anchor, verification: result });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  };

  router.get('/receipts/chain', handleChain);
  router.get('/receipts/verify-chain', handleChain);

  router.get('/receipts/anchor', (_req, res) => {
    try {
      const anchor = getAnchor();
      if (!anchor) return res.status(404).json({ ok: false, error: 'No anchor recorded yet — POST /api/receipts/anchor to create one' });
      res.json({ ok: true, anchor });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post('/receipts/anchor', (_req, res) => {
    try {
      res.json({ ok: true, anchor: anchorHead() });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.get('/receipts/:id', (req, res) => {
    try {
      const found = getReceipt(req.params.id);
      const receipt = found && receiptVisibleTo(req)(found) ? found : undefined;
      if (!receipt) return res.status(404).json({ ok: false, error: 'Receipt not found' });
      res.json({ ok: true, receipt, verification: verifyReceipt(receipt) });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.get('/receipts/:id/verify', (req, res) => {
    try {
      const found = getReceipt(req.params.id);
      const receipt = found && receiptVisibleTo(req)(found) ? found : undefined;
      if (!receipt) return res.status(404).json({ ok: false, error: 'Receipt not found' });
      res.json({ ok: true, verification: verifyReceipt(receipt) });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}
