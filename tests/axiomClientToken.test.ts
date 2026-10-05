import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mintAxiomToken } from '../src/services/axiomClient.js';

// Regression: the OpenHub → Axiom token must carry the owner roles, or every
// RBAC-gated Axiom call (mission approve/reject, project run/stop) returns
// 403 {"error":"forbidden"} as soon as RBAC is on (the default).
describe('OpenHub internal Axiom token', () => {
  afterEach(() => {
    delete process.env.KEYWIRE_KEYS_FILE;
  });

  it('carries owner roles and write permission', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-keywire-'));
    const keysFile = path.join(dir, 'keys.json');
    fs.writeFileSync(keysFile, JSON.stringify({ jwtSecret: 'test-secret' }));
    process.env.KEYWIRE_KEYS_FILE = keysFile;
    try {
      const token = mintAxiomToken();
      expect(token).toBeTruthy();
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as {
        roles?: string[];
        permissions?: string[];
      };
      expect(payload.roles).toEqual(expect.arrayContaining(['owner', 'admin']));
      expect(payload.permissions).toEqual(expect.arrayContaining(['write']));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
