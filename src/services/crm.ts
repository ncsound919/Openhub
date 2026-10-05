import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

/**
 * Thin CRM — the business-development spine of OpenHub.
 *
 * Deliberately small and local (SQLite), inspired by deskcomm-CRM's shape
 * (contacts → companies → deals → activities) but without the multi-tenant
 * Next.js/PHP surface. Deterministic throughout: stages, probabilities, and
 * next-best-action rules are fixed policy, not model output. Actions dispatch
 * to the fleet's deterministic brain (see brainDispatch.ts).
 */

export const STAGES = ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'] as const;
export type Stage = (typeof STAGES)[number];

/** Fixed per-stage win probability (percent). Deterministic forecast input. */
export const STAGE_PROBABILITY: Record<Stage, number> = {
  lead: 10,
  qualified: 25,
  proposal: 50,
  negotiation: 70,
  won: 100,
  lost: 0,
};

const OPEN_STAGES: Stage[] = ['lead', 'qualified', 'proposal', 'negotiation'];

export interface Company {
  id: string; name: string; domain: string | null; industry: string | null;
  website: string | null; notes: string | null; createdAt: string; updatedAt: string;
}
export interface Contact {
  id: string; companyId: string | null; name: string; email: string | null; phone: string | null;
  title: string | null; source: string | null; status: string;
  lastContactedAt: string | null; createdAt: string; updatedAt: string;
}
export interface Deal {
  id: string; companyId: string | null; contactId: string | null; title: string;
  valueCents: number; currency: string; stage: Stage; probability: number;
  source: string | null; expectedClose: string | null;
  createdAt: string; updatedAt: string; closedAt: string | null;
}
export interface Activity {
  id: string; subjectType: string; subjectId: string; kind: string; note: string | null;
  dueAt: string | null; doneAt: string | null; createdAt: string;
}

export interface NextAction {
  id: string;
  kind: 'first_touch' | 'stale_deal' | 'proposal_nudge' | 'closing_soon' | 'no_next_step';
  priority: number;
  title: string;
  detail: string;
  subject: { type: 'deal' | 'contact'; id: string };
  suggestion: string;
}

let db: Database.Database | null = null;

function crmPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENHUB_CRM_DB_PATH || path.join(process.cwd(), 'data', 'crm.db');
}

export function getCrmDb(env: NodeJS.ProcessEnv = process.env): Database.Database {
  if (db) return db;
  const file = crmPath(env);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS companies (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, domain TEXT, industry TEXT,
      website TEXT, notes TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY, company_id TEXT, name TEXT NOT NULL, email TEXT, phone TEXT,
      title TEXT, source TEXT, status TEXT NOT NULL DEFAULT 'new',
      last_contacted_at TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS deals (
      id TEXT PRIMARY KEY, company_id TEXT, contact_id TEXT, title TEXT NOT NULL,
      value_cents INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'USD',
      stage TEXT NOT NULL DEFAULT 'lead', probability INTEGER,
      source TEXT, expected_close TEXT, created_at TEXT, updated_at TEXT, closed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS activities (
      id TEXT PRIMARY KEY, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL,
      kind TEXT NOT NULL, note TEXT, due_at TEXT, done_at TEXT, created_at TEXT,
      meta TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id);
    CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals(stage);
    CREATE INDEX IF NOT EXISTS idx_activities_subject ON activities(subject_type, subject_id);
  `);
  return db;
}

/** Test seam: close and forget the singleton. */
export function closeCrmDb(): void {
  if (db) { db.close(); db = null; }
}

const uid = (p: string) => `${p}-${crypto.randomUUID().slice(0, 12)}`;
const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------
export function createCompany(input: { name: string; domain?: string; industry?: string; website?: string; notes?: string }, env?: NodeJS.ProcessEnv): Company {
  const d = getCrmDb(env);
  const c: Company = {
    id: uid('co'), name: input.name.trim(),
    domain: input.domain ?? null, industry: input.industry ?? null,
    website: input.website ?? null, notes: input.notes ?? null,
    createdAt: nowIso(), updatedAt: nowIso(),
  };
  d.prepare(`INSERT INTO companies (id,name,domain,industry,website,notes,created_at,updated_at) VALUES (@id,@name,@domain,@industry,@website,@notes,@createdAt,@updatedAt)`).run(c);
  return c;
}

function rowToCompany(r: Record<string, unknown>): Company {
  return { id: String(r.id), name: String(r.name), domain: (r.domain as string) ?? null, industry: (r.industry as string) ?? null, website: (r.website as string) ?? null, notes: (r.notes as string) ?? null, createdAt: String(r.created_at), updatedAt: String(r.updated_at) };
}

export function listCompanies(env?: NodeJS.ProcessEnv): Company[] {
  return getCrmDb(env).prepare('SELECT * FROM companies ORDER BY created_at DESC').all().map((r) => rowToCompany(r as Record<string, unknown>));
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------
export function createContact(input: { name: string; email?: string; companyId?: string; phone?: string; title?: string; source?: string; status?: string }, env?: NodeJS.ProcessEnv): Contact {
  const d = getCrmDb(env);
  const c: Contact = {
    id: uid('ct'), companyId: input.companyId ?? null, name: input.name.trim(),
    email: input.email ?? null, phone: input.phone ?? null, title: input.title ?? null,
    source: input.source ?? null, status: input.status ?? 'new',
    lastContactedAt: null, createdAt: nowIso(), updatedAt: nowIso(),
  };
  d.prepare(`INSERT INTO contacts (id,company_id,name,email,phone,title,source,status,last_contacted_at,created_at,updated_at) VALUES (@id,@companyId,@name,@email,@phone,@title,@source,@status,@lastContactedAt,@createdAt,@updatedAt)`).run(c);
  return c;
}

function rowToContact(r: Record<string, unknown>): Contact {
  return {
    id: String(r.id), companyId: (r.company_id as string) ?? null, name: String(r.name),
    email: (r.email as string) ?? null, phone: (r.phone as string) ?? null, title: (r.title as string) ?? null,
    source: (r.source as string) ?? null, status: String(r.status),
    lastContactedAt: (r.last_contacted_at as string) ?? null, createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  };
}

export function listContacts(query: { search?: string; status?: string; companyId?: string } = {}, env?: NodeJS.ProcessEnv): Contact[] {
  const d = getCrmDb(env);
  const clauses: string[] = [];
  const params: Record<string, string> = {};
  if (query.status) { clauses.push('status = @status'); params.status = query.status; }
  if (query.companyId) { clauses.push('company_id = @companyId'); params.companyId = query.companyId; }
  if (query.search) { clauses.push('(name LIKE @q OR email LIKE @q)'); params.q = `%${query.search}%`; }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return d.prepare(`SELECT * FROM contacts ${where} ORDER BY created_at DESC`).all(params).map((r) => rowToContact(r as Record<string, unknown>));
}

export function getContact(id: string, env?: NodeJS.ProcessEnv): Contact | null {
  const r = getCrmDb(env).prepare('SELECT * FROM contacts WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return r ? rowToContact(r) : null;
}

export function updateContact(id: string, patch: Partial<Pick<Contact, 'name' | 'email' | 'phone' | 'title' | 'status' | 'companyId' | 'lastContactedAt'>>, env?: NodeJS.ProcessEnv): Contact | null {
  const existing = getContact(id, env);
  if (!existing) return null;
  const merged = { ...existing, ...patch, updatedAt: nowIso() };
  getCrmDb(env).prepare(`UPDATE contacts SET name=@name,email=@email,phone=@phone,title=@title,status=@status,company_id=@companyId,last_contacted_at=@lastContactedAt,updated_at=@updatedAt WHERE id=@id`).run(merged);
  return getContact(id, env);
}

// ---------------------------------------------------------------------------
// Deals
// ---------------------------------------------------------------------------
export function createDeal(input: { title: string; valueCents?: number; currency?: string; stage?: Stage; companyId?: string; contactId?: string; source?: string; expectedClose?: string }, env?: NodeJS.ProcessEnv): Deal {
  const stage = (input.stage && STAGES.includes(input.stage) ? input.stage : 'lead') as Stage;
  const d: Deal = {
    id: uid('dl'), companyId: input.companyId ?? null, contactId: input.contactId ?? null,
    title: input.title.trim(), valueCents: Math.max(0, Math.round(input.valueCents ?? 0)),
    currency: input.currency ?? 'USD', stage, probability: STAGE_PROBABILITY[stage],
    source: input.source ?? null, expectedClose: input.expectedClose ?? null,
    createdAt: nowIso(), updatedAt: nowIso(), closedAt: null,
  };
  getCrmDb(env).prepare(`INSERT INTO deals (id,company_id,contact_id,title,value_cents,currency,stage,probability,source,expected_close,created_at,updated_at,closed_at) VALUES (@id,@companyId,@contactId,@title,@valueCents,@currency,@stage,@probability,@source,@expectedClose,@createdAt,@updatedAt,@closedAt)`).run(d);
  return d;
}

function rowToDeal(r: Record<string, unknown>): Deal {
  return {
    id: String(r.id), companyId: (r.company_id as string) ?? null, contactId: (r.contact_id as string) ?? null,
    title: String(r.title), valueCents: Number(r.value_cents ?? 0), currency: String(r.currency ?? 'USD'),
    stage: String(r.stage) as Stage, probability: Number(r.probability ?? 0),
    source: (r.source as string) ?? null, expectedClose: (r.expected_close as string) ?? null,
    createdAt: String(r.created_at), updatedAt: String(r.updated_at), closedAt: (r.closed_at as string) ?? null,
  };
}

export function listDeals(query: { stage?: Stage } = {}, env?: NodeJS.ProcessEnv): Deal[] {
  const d = getCrmDb(env);
  const sql = query.stage ? 'SELECT * FROM deals WHERE stage = ? ORDER BY value_cents DESC' : 'SELECT * FROM deals ORDER BY created_at DESC';
  return (query.stage ? d.prepare(sql).all(query.stage) : d.prepare(sql).all()).map((r) => rowToDeal(r as Record<string, unknown>));
}

export function moveDealStage(id: string, stage: Stage, env?: NodeJS.ProcessEnv): Deal | null {
  if (!STAGES.includes(stage)) return null;
  const d = getCrmDb(env);
  const closedAt = stage === 'won' || stage === 'lost' ? nowIso() : null;
  const info = d.prepare('UPDATE deals SET stage=?, probability=?, updated_at=?, closed_at=? WHERE id=?').run(stage, STAGE_PROBABILITY[stage], nowIso(), closedAt, id);
  if (info.changes === 0) return null;
  return rowToDeal(d.prepare('SELECT * FROM deals WHERE id = ?').get(id) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Activities
// ---------------------------------------------------------------------------
export function logActivity(input: { subjectType: string; subjectId: string; kind: string; note?: string; dueAt?: string; doneAt?: string }, env?: NodeJS.ProcessEnv): Activity {
  const a: Activity = {
    id: uid('ac'), subjectType: input.subjectType, subjectId: input.subjectId,
    kind: input.kind, note: input.note ?? null, dueAt: input.dueAt ?? null, doneAt: input.doneAt ?? null,
    createdAt: nowIso(),
  };
  getCrmDb(env).prepare(`INSERT INTO activities (id,subject_type,subject_id,kind,note,due_at,done_at,created_at) VALUES (@id,@subjectType,@subjectId,@kind,@note,@dueAt,@doneAt,@createdAt)`).run(a);
  if (input.kind === 'email' || input.kind === 'call' || input.kind === 'meeting') {
    getCrmDb(env).prepare('UPDATE contacts SET last_contacted_at=?, updated_at=? WHERE id=?').run(nowIso(), nowIso(), input.subjectId);
  }
  return a;
}

export function listActivities(filter: { subjectType?: string; subjectId?: string } = {}, env?: NodeJS.ProcessEnv): Activity[] {
  const d = getCrmDb(env);
  const clauses: string[] = [];
  const params: Record<string, string> = {};
  if (filter.subjectType) { clauses.push('subject_type = @subjectType'); params.subjectType = filter.subjectType; }
  if (filter.subjectId) { clauses.push('subject_id = @subjectId'); params.subjectId = filter.subjectId; }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return d.prepare(`SELECT * FROM activities ${where} ORDER BY created_at DESC LIMIT 200`).all(params).map((r) => {
    const x = r as Record<string, unknown>;
    return { id: String(x.id), subjectType: String(x.subject_type), subjectId: String(x.subject_id), kind: String(x.kind), note: (x.note as string) ?? null, dueAt: (x.due_at as string) ?? null, doneAt: (x.done_at as string) ?? null, createdAt: String(x.created_at) };
  });
}

// ---------------------------------------------------------------------------
// Deterministic pipeline + forecast
// ---------------------------------------------------------------------------
export interface PipelineSummary {
  byStage: Record<Stage, { count: number; valueCents: number }>;
  openCount: number;
  openValueCents: number;
  wonValueCents: number;
  weightedForecastCents: number;
  currency: string;
}

export function pipelineSummary(env?: NodeJS.ProcessEnv): PipelineSummary {
  const deals = listDeals({}, env);
  const byStage = Object.fromEntries(STAGES.map((s) => [s, { count: 0, valueCents: 0 }])) as PipelineSummary['byStage'];
  let openValueCents = 0;
  let wonValueCents = 0;
  let weightedForecastCents = 0;
  for (const d of deals) {
    byStage[d.stage].count += 1;
    byStage[d.stage].valueCents += d.valueCents;
    if (OPEN_STAGES.includes(d.stage)) {
      openValueCents += d.valueCents;
      weightedForecastCents += Math.round(d.valueCents * (d.probability / 100));
    }
    if (d.stage === 'won') wonValueCents += d.valueCents;
  }
  return { byStage, openCount: deals.filter((d) => OPEN_STAGES.includes(d.stage)).length, openValueCents, wonValueCents, weightedForecastCents, currency: deals[0]?.currency ?? 'USD' };
}

// ---------------------------------------------------------------------------
// Deterministic next-best-action rules
// ---------------------------------------------------------------------------
const DAY_MS = 86_400_000;

function daysSince(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor((now - t) / DAY_MS) : null;
}

export interface ActionPolicy {
  staleDealDays?: number;      // default 7
  proposalNudgeDays?: number;  // default 3
  closingSoonDays?: number;    // default 7
}

export function nextActions(policy: ActionPolicy = {}, env?: NodeJS.ProcessEnv, nowMs = Date.now()): NextAction[] {
  const staleDealDays = policy.staleDealDays ?? 7;
  const proposalNudgeDays = policy.proposalNudgeDays ?? 3;
  const closingSoonDays = policy.closingSoonDays ?? 7;

  const deals = listDeals({}, env);
  const contacts = listContacts({}, env);
  const activities = listActivities({}, env);
  const lastActivityAt = new Map<string, number>();
  for (const a of activities) {
    const t = Date.parse(a.createdAt);
    if (Number.isFinite(t)) lastActivityAt.set(`${a.subjectType}:${a.subjectId}`, Math.max(lastActivityAt.get(`${a.subjectType}:${a.subjectId}`) ?? 0, t));
  }

  const actions: NextAction[] = [];

  for (const d of deals) {
    if (d.stage === 'won' || d.stage === 'lost') continue;
    const last = lastActivityAt.get(`deal:${d.id}`) ?? Date.parse(d.updatedAt);
    const stale = Number.isFinite(last) ? Math.floor((nowMs - last) / DAY_MS) : null;
    if (d.stage === 'proposal' && stale !== null && stale >= proposalNudgeDays) {
      actions.push({ id: `act-proposal_nudge-${d.id}`, kind: 'proposal_nudge', priority: 90, title: `Nudge proposal: ${d.title}`, detail: `In proposal stage for ${stale}d with no activity.`, subject: { type: 'deal', id: d.id }, suggestion: 'Send a short value-reminder and ask for a decision date.' });
    } else if (stale !== null && stale >= staleDealDays) {
      actions.push({ id: `act-stale_deal-${d.id}`, kind: 'stale_deal', priority: 70, title: `Follow up: ${d.title}`, detail: `No activity for ${stale}d at stage "${d.stage}".`, subject: { type: 'deal', id: d.id }, suggestion: 'Re-open the thread with one concrete next step.' });
    }
    if (d.expectedClose) {
      const due = Date.parse(d.expectedClose);
      if (Number.isFinite(due)) {
        const daysLeft = Math.ceil((due - nowMs) / DAY_MS);
        if (daysLeft >= 0 && daysLeft <= closingSoonDays) {
          actions.push({ id: `act-closing_soon-${d.id}`, kind: 'closing_soon', priority: 80, title: `Close soon: ${d.title}`, detail: `Expected close in ${daysLeft}d.`, subject: { type: 'deal', id: d.id }, suggestion: 'Confirm the buyer, paperwork, and payment path now.' });
        }
      }
    }
  }

  for (const c of contacts) {
    const hasActivity = lastActivityAt.has(`contact:${c.id}`);
    if (!c.lastContactedAt && !hasActivity) {
      actions.push({ id: `act-first_touch-${c.id}`, kind: 'first_touch', priority: 60, title: `First touch: ${c.name}`, detail: `${c.email ? c.email : 'no email'} · source ${c.source ?? 'unknown'}`, subject: { type: 'contact', id: c.id }, suggestion: 'Send a short, specific intro tied to how they arrived.' });
    }
  }

  actions.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  return actions;
}
