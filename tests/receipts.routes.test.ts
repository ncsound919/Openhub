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
