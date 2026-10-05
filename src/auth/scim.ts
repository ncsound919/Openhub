// SCIM 2.0 user provisioning for OpenHub.
//
// The gap it closed: an org could not provision/deprovision OpenHub users from
// its IdP (Okta/Entra/OneLogin), which is a hard gate for enterprise rollouts.
// This router implements the SCIM 2.0 Users endpoints an IdP's provisioning
// client expects, mapped onto the existing user store, plus read-only Groups
// derived from roles. It is bearer-gated by a dedicated SCIM token, separate
// from the user session auth.
//
// Honesty / safety contract:
//   - With no SCIM_BEARER_TOKEN configured the router refuses (503) — it never
//     falls open.
//   - Token comparison is timing-safe; the token is never logged.
//   - DELETE deactivates (SCIM semantics) rather than hard-deleting; the user
//     store clears the refresh token and sessions on deactivation.
//   - An optional seat cap (`maxSeats`) is enforced on create.

import express from 'express';
import crypto from 'crypto';
import type { BaseUser } from 'awesome-node-auth';

export interface ScimUserStore {
  findById(id: string): Promise<BaseUser | null>;
  findByEmail(email: string): Promise<BaseUser | null>;
  findByUsername(username: string): Promise<BaseUser | null>;
  create(data: Partial<BaseUser> & { username?: string }): Promise<BaseUser>;
  listUsers(limit: number, offset: number): Promise<Array<BaseUser & { active?: boolean }>>;
  countUsers(): Promise<number>;
  countActiveUsers(): Promise<number>;
  updateRole(id: string, role: string | null, by?: string): Promise<boolean>;
  setActive(id: string, active: boolean, by?: string): Promise<boolean>;
  updateProfile(id: string, data: { firstName?: string | null; lastName?: string | null }): Promise<void>;
  deleteUser(id: string): Promise<void>;
  isActive(id: string): Promise<boolean | null>;
}

export interface ScimOptions {
  store: ScimUserStore;
  env?: NodeJS.ProcessEnv;
  /** Optional seat cap; when reached, POST /Users is refused with 403. */
  maxSeats?: number | null;
}

export const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const SCIM_LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function toScimUser(u: BaseUser & { active?: boolean }): Record<string, unknown> {
  const username = (u as unknown as { username?: string }).username || u.email.split('@')[0];
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: u.id,
    externalId: u.providerAccountId ?? undefined,
    userName: username,
    name: {
      givenName: u.firstName ?? undefined,
      familyName: u.lastName ?? undefined,
      formatted: [u.firstName, u.lastName].filter(Boolean).join(' ') || undefined,
    },
    emails: [{ value: u.email, primary: true }],
    active: u.active !== false,
    roles: u.role ? [{ value: u.role, primary: true }] : [],
    meta: { resourceType: 'User', location: `/scim/v2/Users/${u.id}` },
  };
}

function scimError(res: express.Response, status: number, detail: string): void {
  res.status(status).json({ schemas: [SCIM_ERROR_SCHEMA], detail, status: String(status) });
}

interface ScimUserBody {
  userName?: unknown;
  externalId?: unknown;
  name?: { givenName?: unknown; familyName?: unknown; formatted?: unknown };
  emails?: Array<{ value?: unknown; primary?: unknown }>;
  active?: unknown;
  roles?: Array<{ value?: unknown }>;
}

function parseBody(raw: unknown): { userName: string; email: string; firstName: string | null; lastName: string | null; role: string | null; active: boolean } | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as ScimUserBody;
  const userName = typeof b.userName === 'string' ? b.userName.trim() : '';
  const emailRaw = Array.isArray(b.emails) ? b.emails.find((e) => typeof e?.value === 'string')?.value : undefined;
  const email = (typeof emailRaw === 'string' ? emailRaw : userName.includes('@') ? userName : '').trim().toLowerCase();
  if (!email) return null;
  const role = Array.isArray(b.roles) && typeof b.roles[0]?.value === 'string' ? b.roles[0].value : null;
  return {
    userName: userName || email.split('@')[0],
    email,
    firstName: typeof b.name?.givenName === 'string' ? b.name.givenName : null,
    lastName: typeof b.name?.familyName === 'string' ? b.name.familyName : null,
    role,
    active: b.active !== false,
  };
}

function parseFilter(query: unknown): { field: string; value: string } | null {
  if (typeof query !== 'string' || !query.trim()) return null;
  const m = /^\s*([A-Za-z.]+)\s+eq\s+"([^"]*)"\s*$/i.exec(query);
  if (!m) return null;
  return { field: m[1].toLowerCase(), value: m[2] };
}

/** Build the SCIM router. Mount at the app root (it declares `/scim/v2/...`). */
export function createScimRouter(opts: ScimOptions): express.Router {
  const router = express.Router();
  const env = opts.env ?? process.env;

  // Guard only the SCIM surface. Mounted at the app root, a bare `router.use`
  // would 503 every non-SCIM request whenever SCIM_BEARER_TOKEN is unset.
  router.use('/scim', (req, res, next) => {
    const expected = (env.SCIM_BEARER_TOKEN || '').trim();
    if (!expected) return scimError(res, 503, 'SCIM is not configured on this server');
    const auth = String(req.headers.authorization || '');
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (!m || !safeEqual(m[1].trim(), expected)) {
      console.warn(`[scim] 401 ${req.method} ${req.path} — bad or missing SCIM token`);
      return scimError(res, 401, 'unauthorized');
    }
    return next();
  });

  router.get('/scim/v2/Users', async (req, res) => {
    try {
      const filter = parseFilter(req.query.filter);
      if (filter) {
        const found = filter.field === 'username'
          ? await opts.store.findByUsername(filter.value)
          : filter.field === 'emails.value' || filter.field === 'email'
            ? await opts.store.findByEmail(filter.value)
            : null;
        const resources = found ? [toScimUser(found as BaseUser & { active?: boolean })] : [];
        return res.json({ schemas: [SCIM_LIST_SCHEMA], totalResults: resources.length, startIndex: 1, itemsPerPage: resources.length, Resources: resources });
      }
      const total = await opts.store.countUsers();
      const startIndex = Math.max(1, Number(req.query.startIndex) || 1);
      const count = Math.min(200, Math.max(1, Number(req.query.count) || 100));
      const users = await opts.store.listUsers(count, startIndex - 1);
      res.json({ schemas: [SCIM_LIST_SCHEMA], totalResults: total, startIndex, itemsPerPage: users.length, Resources: users.map(toScimUser) });
    } catch (e) {
      scimError(res, 500, e instanceof Error ? e.message : 'list failed');
    }
  });

  router.post('/scim/v2/Users', async (req, res) => {
    try {
      const parsed = parseBody(req.body);
      if (!parsed) return scimError(res, 400, 'userName and an email are required');
      if (typeof opts.maxSeats === 'number' && opts.maxSeats > 0) {
        const used = await opts.store.countActiveUsers();
        if (used >= opts.maxSeats) return scimError(res, 403, `seat limit reached (${used}/${opts.maxSeats})`);
      }
      const existing = await opts.store.findByEmail(parsed.email);
      if (existing) return scimError(res, 409, 'a user with this email already exists');
      const created = await opts.store.create({
        email: parsed.email,
        password: crypto.randomBytes(24).toString('hex'),
        username: parsed.userName,
        firstName: parsed.firstName ?? undefined,
        lastName: parsed.lastName ?? undefined,
        role: parsed.role ?? undefined,
        loginProvider: 'scim',
      });
      if (!parsed.active) await opts.store.setActive(created.id, false, 'scim');
      res.status(201).json(toScimUser({ ...created, active: parsed.active }));
    } catch (e) {
      scimError(res, 500, e instanceof Error ? e.message : 'create failed');
    }
  });

  router.get('/scim/v2/Users/:id', async (req, res) => {
    try {
      const u = await opts.store.findById(req.params.id);
      if (!u) return scimError(res, 404, 'user not found');
      const active = await opts.store.isActive(u.id);
      res.json(toScimUser({ ...u, active: active !== false }));
    } catch (e) {
      scimError(res, 500, e instanceof Error ? e.message : 'read failed');
    }
  });

  const applyUpdate = async (req: express.Request, res: express.Response, partial: boolean) => {
    try {
      const u = await opts.store.findById(req.params.id);
      if (!u) return scimError(res, 404, 'user not found');
      let roleChange: string | null | undefined;
      let activeChange: boolean | undefined;
      const namePairs: { firstName?: string | null; lastName?: string | null } = {};

      if (partial) {
        const ops = Array.isArray(req.body?.Operations) ? req.body.Operations as Array<{ op?: string; path?: string; value?: unknown }> : [];
        for (const op of ops) {
          const path = String(op.path ?? '').toLowerCase();
          if (path === 'active') activeChange = op.value === true || op.value === 'true';
          else if (path === 'roles') {
            const v = Array.isArray(op.value) ? op.value[0] : op.value;
            roleChange = typeof (v as { value?: unknown })?.value === 'string' ? String((v as { value: string }).value) : null;
          } else if (path === 'username' && typeof op.value === 'string') {
            // userName changes are accepted but the account keeps its stored
            // username; noted rather than silently rewritten.
          } else if (path === 'name.givenname') namePairs.firstName = typeof op.value === 'string' ? op.value : null;
          else if (path === 'name.familyname') namePairs.lastName = typeof op.value === 'string' ? op.value : null;
        }
      } else {
        const parsed = parseBody(req.body);
        if (!parsed) return scimError(res, 400, 'invalid user body');
        roleChange = parsed.role;
        activeChange = parsed.active;
        namePairs.firstName = parsed.firstName;
        namePairs.lastName = parsed.lastName;
      }

      if (roleChange !== undefined) await opts.store.updateRole(u.id, roleChange, 'scim');
      if (namePairs.firstName !== undefined || namePairs.lastName !== undefined) {
        await opts.store.updateProfile(u.id, { firstName: namePairs.firstName, lastName: namePairs.lastName });
      }
      if (activeChange !== undefined) await opts.store.setActive(u.id, activeChange, 'scim');

      const fresh = await opts.store.findById(u.id);
      const active = await opts.store.isActive(u.id);
      res.json(toScimUser({ ...(fresh ?? u), active: active !== false }));
    } catch (e) {
      scimError(res, 500, e instanceof Error ? e.message : 'update failed');
    }
  };

  router.put('/scim/v2/Users/:id', (req, res) => void applyUpdate(req, res, false));
  router.patch('/scim/v2/Users/:id', (req, res) => void applyUpdate(req, res, true));

  router.delete('/scim/v2/Users/:id', async (req, res) => {
    try {
      const u = await opts.store.findById(req.params.id);
      if (!u) return scimError(res, 404, 'user not found');
      // SCIM DELETE = deprovision. Deactivate + drop sessions (store does the latter).
      await opts.store.setActive(u.id, false, 'scim');
      res.status(204).end();
    } catch (e) {
      scimError(res, 500, e instanceof Error ? e.message : 'delete failed');
    }
  });

  // Groups are the org's roles (read-only projection). IdPs read these to
  // reconcile group membership; OpenHub derives role from the SSO group claim.
  router.get('/scim/v2/Groups', async (_req, res) => {
    try {
      const users = await opts.store.listUsers(1000, 0);
      const roles = [...new Set(users.map((u) => u.role).filter((r): r is string => !!r))].sort();
      const resources = roles.map((role) => ({
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
        id: `role:${role}`,
        displayName: role,
        members: users.filter((u) => u.role === role).map((u) => ({ value: u.id, display: u.email })),
      }));
      res.json({ schemas: [SCIM_LIST_SCHEMA], totalResults: resources.length, startIndex: 1, itemsPerPage: resources.length, Resources: resources });
    } catch (e) {
      scimError(res, 500, e instanceof Error ? e.message : 'groups failed');
    }
  });

  return router;
}
