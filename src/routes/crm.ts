import { Router, type RequestHandler } from 'express';
import {
  createCompany, listCompanies,
  createContact, listContacts, getContact, updateContact,
  createDeal, listDeals, moveDealStage,
  logActivity, listActivities,
  pipelineSummary, nextActions, STAGES, type Stage,
} from '../services/crm.js';
import { dispatchTask, actionToQuery, deterministicBrainUrl, upliftAgentUrl } from '../services/brainDispatch.js';

/**
 * CRM routes — the business-development spine, mounted at `/api` (auth-gated).
 * Deterministic CRUD + pipeline/forecast + a next-best-action queue that
 * dispatches to the fleet's deterministic brain.
 */
export function createCrmRouter(deps: { authMiddleware: RequestHandler }): Router {
  const router = Router();
  router.use(deps.authMiddleware);

  const bad = (res: import('express').Response, msg: string) => res.status(400).json({ error: msg });

  router.get('/crm/health', (_req, res) => {
    try {
      const s = pipelineSummary();
      res.json({ ok: true, brain: deterministicBrainUrl(), fallback: upliftAgentUrl() || null, pipeline: s });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'crm db error' });
    }
  });

  // --- companies ---
  router.get('/crm/companies', (_req, res) => res.json({ companies: listCompanies() }));
  router.post('/crm/companies', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.name !== 'string' || !b.name.trim()) return bad(res, 'name is required');
    res.status(201).json(createCompany({
      name: b.name,
      ...(typeof b.domain === 'string' ? { domain: b.domain } : {}),
      ...(typeof b.industry === 'string' ? { industry: b.industry } : {}),
      ...(typeof b.website === 'string' ? { website: b.website } : {}),
      ...(typeof b.notes === 'string' ? { notes: b.notes } : {}),
    }));
  });

  // --- contacts ---
  router.get('/crm/contacts', (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    res.json({ contacts: listContacts({ search: q.search, status: q.status, companyId: q.companyId }) });
  });
  router.post('/crm/contacts', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.name !== 'string' || !b.name.trim()) return bad(res, 'name is required');
    if (b.email !== undefined && typeof b.email !== 'string') return bad(res, 'email must be a string');
    res.status(201).json(createContact({
      name: b.name,
      ...(typeof b.email === 'string' ? { email: b.email } : {}),
      ...(typeof b.companyId === 'string' ? { companyId: b.companyId } : {}),
      ...(typeof b.phone === 'string' ? { phone: b.phone } : {}),
      ...(typeof b.title === 'string' ? { title: b.title } : {}),
      ...(typeof b.source === 'string' ? { source: b.source } : {}),
      ...(typeof b.status === 'string' ? { status: b.status } : {}),
    }));
  });
  router.get('/crm/contacts/:id', (req, res) => {
    const c = getContact(req.params.id);
    if (!c) return res.status(404).json({ error: 'not found' });
    res.json(c);
  });
  router.patch('/crm/contacts/:id', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch: Parameters<typeof updateContact>[1] = {};
    for (const k of ['name', 'email', 'phone', 'title', 'status', 'companyId', 'lastContactedAt'] as const) {
      if (typeof b[k] === 'string') (patch as Record<string, string>)[k] = b[k] as string;
    }
    const updated = updateContact(req.params.id, patch);
    if (!updated) return res.status(404).json({ error: 'not found' });
    res.json(updated);
  });

  // --- deals ---
  router.get('/crm/deals', (req, res) => {
    const stage = typeof req.query.stage === 'string' && STAGES.includes(req.query.stage as Stage) ? (req.query.stage as Stage) : undefined;
    res.json({ deals: listDeals(stage ? { stage } : {}) });
  });
  router.post('/crm/deals', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.title !== 'string' || !b.title.trim()) return bad(res, 'title is required');
    res.status(201).json(createDeal({
      title: b.title,
      ...(typeof b.valueCents === 'number' ? { valueCents: b.valueCents } : {}),
      ...(typeof b.currency === 'string' ? { currency: b.currency } : {}),
      ...(typeof b.stage === 'string' && STAGES.includes(b.stage as Stage) ? { stage: b.stage as Stage } : {}),
      ...(typeof b.companyId === 'string' ? { companyId: b.companyId } : {}),
      ...(typeof b.contactId === 'string' ? { contactId: b.contactId } : {}),
      ...(typeof b.source === 'string' ? { source: b.source } : {}),
      ...(typeof b.expectedClose === 'string' ? { expectedClose: b.expectedClose } : {}),
    }));
  });
  router.patch('/crm/deals/:id', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.stage !== 'string' || !STAGES.includes(b.stage as Stage)) return bad(res, `stage must be one of ${STAGES.join(', ')}`);
    const updated = moveDealStage(req.params.id, b.stage as Stage);
    if (!updated) return res.status(404).json({ error: 'not found' });
    res.json(updated);
  });

  // --- activities ---
  router.get('/crm/activities', (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    res.json({ activities: listActivities({ subjectType: q.subjectType, subjectId: q.subjectId }) });
  });
  router.post('/crm/activities', (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.subjectType !== 'string' || typeof b.subjectId !== 'string' || typeof b.kind !== 'string') {
      return bad(res, 'subjectType, subjectId and kind are required');
    }
    res.status(201).json(logActivity({
      subjectType: b.subjectType, subjectId: b.subjectId, kind: b.kind,
      ...(typeof b.note === 'string' ? { note: b.note } : {}),
      ...(typeof b.dueAt === 'string' ? { dueAt: b.dueAt } : {}),
      ...(typeof b.doneAt === 'string' ? { doneAt: b.doneAt } : {}),
    }));
  });

  // --- pipeline + actions ---
  router.get('/crm/pipeline', (_req, res) => res.json(pipelineSummary()));

  router.get('/crm/actions', (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    const num = (v: string | undefined) => (v && Number.isFinite(Number(v)) ? Number(v) : undefined);
    const actions = nextActions({
      ...(num(q.staleDealDays) !== undefined ? { staleDealDays: num(q.staleDealDays) } : {}),
      ...(num(q.proposalNudgeDays) !== undefined ? { proposalNudgeDays: num(q.proposalNudgeDays) } : {}),
      ...(num(q.closingSoonDays) !== undefined ? { closingSoonDays: num(q.closingSoonDays) } : {}),
    });
    res.json({ actions });
  });

  /** Dispatch an action (or a raw query) to the deterministic brain. */
  router.post('/crm/actions/dispatch', async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    let query = typeof b.query === 'string' ? b.query : '';
    let loggedActivityId: string | null = null;

    if (!query && b.action && typeof b.action === 'object') {
      const a = b.action as { kind?: unknown; title?: unknown; detail?: unknown; suggestion?: unknown; subject?: { type?: unknown; id?: unknown } };
      if (typeof a.kind !== 'string' || typeof a.title !== 'string') return bad(res, 'action.kind and action.title are required');
      query = actionToQuery({
        kind: a.kind, title: a.title,
        detail: typeof a.detail === 'string' ? a.detail : '',
        suggestion: typeof a.suggestion === 'string' ? a.suggestion : '',
      });
      if (a.subject && typeof a.subject.type === 'string' && typeof a.subject.id === 'string') {
        try {
          const logged = logActivity({ subjectType: a.subject.type, subjectId: a.subject.id, kind: 'dispatch', note: `dispatched: ${a.kind}` });
          loggedActivityId = logged.id;
        } catch { /* activity logging is best-effort */ }
      }
    }

    if (!query) return bad(res, 'query or action is required');
    const laneOverride = typeof b.laneOverride === 'string' ? b.laneOverride : undefined;
    const result = await dispatchTask(query, laneOverride ? { laneOverride } : {});
    res.status(result.available ? 200 : 503).json({ ...result, activityId: loggedActivityId });
  });

  return router;
}
