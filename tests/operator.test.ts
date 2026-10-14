import { describe, it, expect, afterEach } from 'vitest';
import type { Request, Response } from 'express';
import { configuredOperatorRoles, isOperator, requireOperator, operatorGateWarning, operatorGateFor } from '../src/lib/operator';

function mockRes() {
  const res = {
    statusCode: 0 as number,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
  };
  return res;
}

describe('operator role gate', () => {
  const prev = process.env.OPENHUB_ADMIN_ROLES;
  afterEach(() => {
    if (prev === undefined) delete process.env.OPENHUB_ADMIN_ROLES;
    else process.env.OPENHUB_ADMIN_ROLES = prev;
  });

  it('parses comma/space separated roles and dedupes', () => {
    expect(configuredOperatorRoles({ OPENHUB_ADMIN_ROLES: 'owner, admin  owner' } as NodeJS.ProcessEnv)).toEqual(['owner', 'admin']);
    expect(configuredOperatorRoles({} as NodeJS.ProcessEnv)).toEqual([]);
    expect(configuredOperatorRoles({ OPENHUB_ADMIN_ROLES: '   ' } as NodeJS.ProcessEnv)).toEqual([]);
  });

  it('a disabled gate allows any authenticated request', () => {
    delete process.env.OPENHUB_ADMIN_ROLES;
    const res = mockRes();
    let nexted = false;
    requireOperator({ user: { role: 'member' } } as unknown as Request, res as unknown as Response, () => { nexted = true; });
    expect(nexted).toBe(true);
    expect(res.statusCode).toBe(0);
  });

  it('a configured gate 403s a non-operator and passes an operator', () => {
    process.env.OPENHUB_ADMIN_ROLES = 'owner,admin';
    const denied = mockRes();
    let deniedNext = false;
    requireOperator({ user: { role: 'member' } } as unknown as Request, denied as unknown as Response, () => { deniedNext = true; });
    expect(deniedNext).toBe(false);
    expect(denied.statusCode).toBe(403);

    const allowed = mockRes();
    let allowedNext = false;
    requireOperator({ user: { role: 'admin' } } as unknown as Request, allowed as unknown as Response, () => { allowedNext = true; });
    expect(allowedNext).toBe(true);
  });

  it('a wildcard allows any authenticated role', () => {
    process.env.OPENHUB_ADMIN_ROLES = '*';
    expect(isOperator(undefined, configuredOperatorRoles())).toBe(true);
    expect(isOperator('member', configuredOperatorRoles())).toBe(true);
  });

  it('warns only while unset', () => {
    delete process.env.OPENHUB_ADMIN_ROLES;
    expect(operatorGateWarning()).toMatch(/OPENHUB_ADMIN_ROLES/);
    process.env.OPENHUB_ADMIN_ROLES = 'admin';
    expect(operatorGateWarning()).toBeNull();
  });
});

describe('operatorGateFor (router-level gate)', () => {
  const prev = process.env.OPENHUB_ADMIN_ROLES;
  afterEach(() => {
    if (prev === undefined) delete process.env.OPENHUB_ADMIN_ROLES;
    else process.env.OPENHUB_ADMIN_ROLES = prev;
  });
  const gate = operatorGateFor([/^\/pipeline(\/|$)/]);
  const run = (method: string, path: string, role?: string) => {
    const res = mockRes();
    let passed = false;
    gate({ method, path, user: role ? { role } : {} } as unknown as Request, res as unknown as Response, () => { passed = true; });
    return { passed, status: res.statusCode };
  };

  it('blocks a non-operator on a matching mutation', () => {
    process.env.OPENHUB_ADMIN_ROLES = 'owner,admin';
    expect(run('POST', '/pipeline/run', 'viewer')).toEqual({ passed: false, status: 403 });
    expect(run('POST', '/pipeline/run')).toEqual({ passed: false, status: 403 });
  });

  it('matches case-insensitively, like Express routing', () => {
    process.env.OPENHUB_ADMIN_ROLES = 'owner';
    expect(run('PUT', '/PIPELINE/auto', 'viewer').passed).toBe(false);
  });

  it('lets operators, reads and non-matching paths through', () => {
    process.env.OPENHUB_ADMIN_ROLES = 'owner';
    expect(run('POST', '/pipeline/run', 'owner').passed).toBe(true);
    expect(run('GET', '/pipeline/list', 'viewer').passed).toBe(true);
    expect(run('POST', '/insights/refresh', 'viewer').passed).toBe(true);
  });
});
