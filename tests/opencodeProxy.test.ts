import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createOpencodeProxyRouter } from '../src/routes/opencodeProxy.js';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api', createOpencodeProxyRouter({ authMiddleware: (_req, _res, next) => next() }));
  return a;
}

describe('opencodeProxy', () => {
  it('GET /api/opencode/status reports engine availability honestly', async () => {
    const res = await request(app()).get('/api/opencode/status');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.data.available).toBe('boolean');
  });
});
