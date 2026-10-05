import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import {
  createCompany, createContact, listContacts, updateContact,
  createDeal, listDeals, moveDealStage, logActivity,
  pipelineSummary, nextActions, closeCrmDb, STAGES,
} from '../src/services/crm';
import { createCrmRouter } from '../src/routes/crm';
import { dispatchToBrain, dispatchTask, actionToQuery } from '../src/services/brainDispatch';

const DAY = 86_400_000;
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhub-crm-'));
  vi.stubEnv('OPENHUB_CRM_DB_PATH', path.join(dir, 'crm.db'));
  closeCrmDb();
});

afterEach(() => {
  closeCrmDb();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('crm store', () => {
  it('creates companies, contacts and deals and reads them back', () => {
    const co = createCompany({ name: 'Acme LLC', industry: 'retail' });
    const ct = createContact({ name: 'Dana', email: 'dana@acme.test', companyId: co.id, source: 'uplift-health' });
    expect(listContacts({ search: 'dana' })).toHaveLength(1);
    expect(listContacts({ companyId: co.id })[0].id).toBe(ct.id);

    const deal = createDeal({ title: 'Starter tier', valueCents: 100_000, stage: 'qualified', contactId: ct.id });
    expect(deal.stage).toBe('qualified');
    expect(deal.probability).toBe(25);
    expect(listDeals({ stage: 'qualified' })[0].id).toBe(deal.id);
  });

  it('moves stage, sets probability and stamped closed_at for won/lost', () => {
    const d = createDeal({ title: 'X', valueCents: 5000 });
    const won = moveDealStage(d.id, 'won');
    expect(won?.stage).toBe('won');
    expect(won?.probability).toBe(100);
    expect(won?.closedAt).toBeTruthy();
    expect(moveDealStage(d.id, 'nonsense' as never)).toBeNull();
  });

  it('computes a deterministic pipeline + weighted forecast', () => {
    createDeal({ title: 'A', valueCents: 100_000, stage: 'proposal' }); // 50%
    createDeal({ title: 'B', valueCents: 40_000, stage: 'lead' }); // 10%
    createDeal({ title: 'C', valueCents: 999_999, stage: 'won' });
    const s = pipelineSummary();
    expect(s.openCount).toBe(2);
    expect(s.openValueCents).toBe(140_000);
    expect(s.weightedForecastCents).toBe(100_000 * 0.5 + 40_000 * 0.1);
    expect(s.wonValueCents).toBe(999_999);
    expect(s.byStage.proposal.count).toBe(1);
  });

  it('touch updates lastContactedAt via an outreach activity', () => {
    const c = createContact({ name: 'Sam' });
    logActivity({ subjectType: 'contact', subjectId: c.id, kind: 'email', note: 'intro sent' });
    expect(listContacts()[0].lastContactedAt).toBeTruthy();
    expect(updateContact(c.id, { status: 'contacted' })?.status).toBe('contacted');
  });
});

describe('next-best-action rules (deterministic)', () => {
  it('flags a never-contacted contact for first touch', () => {
    createContact({ name: 'New Lead', email: 'x@y.test', source: 'site' });
    const actions = nextActions();
    expect(actions.some((a) => a.kind === 'first_touch')).toBe(true);
  });

  it('flags stale, proposal nudge and closing-soon deals by elapsed time', () => {
    const stale = createDeal({ title: 'Stale lead', stage: 'lead' });
    const proposal = createDeal({ title: 'Proposal sitting', stage: 'proposal' });
    createDeal({ title: 'Closing', stage: 'negotiation', expectedClose: new Date(Date.now() + 2 * DAY).toISOString() });

    const later = nextActions({ staleDealDays: 7, proposalNudgeDays: 3, closingSoonDays: 7 }, process.env, Date.now() + 10 * DAY);
    const kinds = later.map((a) => a.kind);
    expect(kinds).toContain('stale_deal');
    expect(kinds).toContain('proposal_nudge');
    // Each open deal reports exactly one follow-up kind at this horizon.
    expect(later.filter((a) => a.subject.id === stale.id).map((a) => a.kind)).toEqual(['stale_deal']);
    expect(later.filter((a) => a.subject.id === proposal.id).map((a) => a.kind)).toEqual(['proposal_nudge']);

    // closing_soon is relative to "now", so evaluate it at the current time.
    const soon = nextActions({ closingSoonDays: 7 }, process.env, Date.now());
    expect(soon.map((a) => a.kind)).toContain('closing_soon');
  });

  it('produces stable ids so the client can dispatch an exact action', () => {
    createContact({ name: 'Stable' });
    const a = nextActions()[0];
    const b = nextActions().find((x) => x.id === a.id);
    expect(b).toBeTruthy();
  });
});

describe('crm routes', () => {
  const app = express();
  app.use(express.json());
  app.use('/api', createCrmRouter({ authMiddleware: (_req, _res, next) => next() }));

  it('creates and lists contacts/deals and returns the action queue', async () => {
    const c = await request(app).post('/api/crm/contacts').send({ name: 'Pat', email: 'pat@z.test' });
    expect(c.status).toBe(201);
    expect(c.body.name).toBe('Pat');

    const d = await request(app).post('/api/crm/deals').send({ title: 'Deal', valueCents: 200000, stage: 'proposal' });
    expect(d.status).toBe(201);

    const pipe = await request(app).get('/api/crm/pipeline');
    expect(pipe.status).toBe(200);
    expect(pipe.body.openValueCents).toBe(200000);

    const acts = await request(app).get('/api/crm/actions');
    expect(acts.status).toBe(200);
    expect(Array.isArray(acts.body.actions)).toBe(true);
  });

  it('rejects malformed input', async () => {
    expect((await request(app).post('/api/crm/contacts').send({})).status).toBe(400);
    expect((await request(app).post('/api/crm/deals').send({ title: '' })).status).toBe(400);
    expect((await request(app).patch('/api/crm/deals/nope').send({ stage: 'bogus' })).status).toBe(400);
  });

  it('dispatches an action to the deterministic brain and logs the attempt', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ final_output: 'next step: call', reasoning: { chosen_skill: 'outreach' } }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    const c = await request(app).post('/api/crm/contacts').send({ name: 'Dispatch Me' });
    const actions = await request(app).get('/api/crm/actions');
    const action = actions.body.actions.find((a: { kind: string }) => a.kind === 'first_touch');
    const r = await request(app).post('/api/crm/actions/dispatch').send({ action });
    expect(r.status).toBe(200);
    expect(r.body.available).toBe(true);
    expect(r.body.activityId).toBeTruthy();
  });

  it('reports 503 when the brain is unreachable (never fakes a result)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const r = await request(app).post('/api/crm/actions/dispatch').send({ query: 'follow up with Acme' });
    expect(r.status).toBe(503);
    expect(r.body.available).toBe(false);
    expect(r.body.error).toContain('ECONNREFUSED');
  });
});

describe('deterministic-brain dispatch', () => {
  it('POSTs the verified /task contract', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('http://127.0.0.1:3210/task');
      const body = JSON.parse(String(init?.body));
      expect(body.query).toContain('follow up');
      expect(body.lane_override).toBe('sales');
      return new Response(JSON.stringify({ final_output: 'ok' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const r = await dispatchToBrain('follow up with Acme', { laneOverride: 'sales' });
    expect(r.available).toBe(true);
  });

  it('falls back to the Uplift-Agent queue when the brain errors, and reports the chain', async () => {
    vi.stubEnv('OPENHUB_UPLIFT_AGENT_URL', 'http://127.0.0.1:8000');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes(':3210/task')) return new Response(JSON.stringify({ detail: 'tqdm OSError' }), { status: 500 });
      if (url.includes(':8000/task')) return new Response(JSON.stringify({ task_id: 'task_1', status: 'queued' }), { status: 202 });
      throw new Error(`unexpected ${url}`);
    }));
    const r = await dispatchTask('follow up with Acme');
    expect(r.available).toBe(true);
    expect(r.status).toBe(202);
    expect(r.target).toContain('8000');
    expect(r.attempts).toHaveLength(2);
    expect(r.attempts[0].status).toBe(500);
  });

  it('never dispatches at the colibri model port: fallback requires explicit config', async () => {
    vi.stubEnv('OPENHUB_UPLIFT_AGENT_URL', '');
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url);
      return new Response('boom', { status: 500 });
    }));
    const r = await dispatchTask('follow up with Acme');
    expect(r.available).toBe(false);
    expect(r.attempts).toHaveLength(1);
    expect(r.error).toContain('no fallback configured');
    expect(calls.every((u) => !u.includes(':8000'))).toBe(true);
  });

  it('builds a deterministic action query', () => {
    const q = actionToQuery({ kind: 'stale_deal', title: 'T', detail: 'D', suggestion: 'S' });
    expect(q).toContain('stale_deal');
    expect(q).toContain('S');
  });
});

describe('crm stage constants', () => {
  it('keeps the documented stage order', () => {
    expect([...STAGES]).toEqual(['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost']);
  });
});
