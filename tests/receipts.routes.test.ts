import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createReceiptsRouter } from '../src/routes/receipts';
import { clearReceipts, recordReceipt } from '../src/services/receipts';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createReceiptsRouter({ authMiddleware: (_req, _res, next) => next() }));
  return app;
}

describe('Receipts API', () => {
  beforeEach(() => {
    clearReceipts();
  });

  it('lists receipts with filtering', async () => {
    recordReceipt({
      kind: 'command',
      command: 'git status',
      status: 'passed',
      runId: 'run_1',
      scorer: 'git_history',
    });
    recordReceipt({
      kind: 'command',
      command: 'npm test',
      status: 'passed',
      runId: 'run_2',
      scorer: 'local_qa',
    });

    const app = makeApp();
    const res = await request(app).get('/api/receipts?runId=run_1');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.count).toBe(1);
    expect(res.body.receipts[0].command).toBe('git status');
  });

  it('retrieves and verifies single receipt by id', async () => {
    const r = recordReceipt({
      kind: 'command',
      command: 'tsc --noEmit',
      status: 'passed',
    });

    const app = makeApp();
    const res = await request(app).get(`/api/receipts/${r.id}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.receipt.id).toBe(r.id);
    expect(res.body.verification.valid).toBe(true);

    const verifyRes = await request(app).get(`/api/receipts/${r.id}/verify`);
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.verification.valid).toBe(true);
  });

  it('verifies chain and anchors head', async () => {
    recordReceipt({ kind: 'command', command: 'cmd1', status: 'passed' });
    recordReceipt({ kind: 'command', command: 'cmd2', status: 'passed' });

    const app = makeApp();
    const chainRes = await request(app).get('/api/receipts/verify-chain');
    expect(chainRes.status).toBe(200);
    expect(chainRes.body.ok).toBe(true);
    expect(chainRes.body.verification.valid).toBe(true);
    expect(chainRes.body.head.seq).toBe(1);

    const anchorPost = await request(app).post('/api/receipts/anchor');
    expect(anchorPost.status).toBe(200);
    expect(anchorPost.body.ok).toBe(true);
    expect(anchorPost.body.anchor.seq).toBe(1);

    const anchorGet = await request(app).get('/api/receipts/anchor');
    expect(anchorGet.status).toBe(200);
    expect(anchorGet.body.anchor.seq).toBe(1);
  });
});

describe('Receipts API per-user scoping (audit 2026-09-23)', () => {
  function appAs(sub: string, role?: string) {
    const app = express();
    app.use(express.json());
    app.use('/api', createReceiptsRouter({
      authMiddleware: (req, _res, next) => { (req as any).user = { sub, role }; next(); },
    }));
    return app;
  }

  beforeEach(() => {
    clearReceipts();
    delete process.env.OPENHUB_ADMIN_ROLES;
  });

  it("hides another user's receipts in list and get", async () => {
    const r = recordReceipt({ kind: 'command', command: 'secret-run', status: 'passed', userId: 'alice' });
    const list = await request(appAs('bob')).get('/api/receipts');
    expect(list.body.receipts.map((x: any) => x.command)).not.toContain('secret-run');
    const one = await request(appAs('bob')).get(`/api/receipts/${r.id}`);
    expect(one.status).toBe(404);
    const own = await request(appAs('alice')).get(`/api/receipts/${r.id}`);
    expect(own.status).toBe(200);
  });

  it('lets a configured operator see everything and hides legacy receipts from others', async () => {
    process.env.OPENHUB_ADMIN_ROLES = 'admin';
    try {
      recordReceipt({ kind: 'command', command: 'legacy', status: 'passed' });
      recordReceipt({ kind: 'command', command: 'alice-run', status: 'passed', userId: 'alice' });
      const admin = await request(appAs('root', 'admin')).get('/api/receipts');
      expect(admin.body.count).toBe(2);
      const bob = await request(appAs('bob', 'user')).get('/api/receipts');
      expect(bob.body.count).toBe(0);
    } finally {
      delete process.env.OPENHUB_ADMIN_ROLES;
    }
  });
});
