import { describe, it, expect, afterEach } from 'vitest';
import { mintAxiomToken } from '../src/services/axiomClient.js';

// Regression: the OpenHub → Axiom token must carry the owner roles, or every
// RBAC-gated Axiom call (mission approve/reject, project run/stop) returns
// 403 {"error":"forbidden"} as soon as RBAC is on (the default).
//
// 2026-10-15: the signing secret no longer comes from Keywire's keywire-keys.json
// (Keywire retired ecosystem-wide; Axiom archived). It is AXIOM_JWT_SECRET, else
// the emergency key file — and absent both, no token (honest degrade).
describe('OpenHub internal Axiom token', () => {
  afterEach(() => {
    delete process.env.AXIOM_JWT_SECRET;
    delete process.env.AXIOM_EMERGENCY_KEY_FILE;
  });

  it('carries owner roles and write permission', () => {
    process.env.AXIOM_JWT_SECRET = 'test-secret';
    const token = mintAxiomToken();
    expect(token).toBeTruthy();
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as {
      roles?: string[];
      permissions?: string[];
    };
    expect(payload.roles).toEqual(expect.arrayContaining(['owner', 'admin']));
    expect(payload.permissions).toEqual(expect.arrayContaining(['write']));
  });

  it('degrades honestly to an empty token when no secret is configured', () => {
    // Negative control: no env secret and no emergency key -> no token, never a
    // bad-signature JWT.
    process.env.AXIOM_EMERGENCY_KEY_FILE = 'C:/definitely/absent/emergency-key.json';
    expect(mintAxiomToken()).toBe('');
  });
});
