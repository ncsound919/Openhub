import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createAuditRouter } from '../src/routes/auditRoutes';

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use('/api', createAuditRouter({ authMiddleware: (_req, _res, next) => next() }));
  return instance;
}

describe('audit tools catalog', () => {
  it('lists every suite scorer including the deep/codegang/codenexus/local_qa cards', async () => {
    const res = await request(app()).get('/api/audit/tools');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const names = (res.body.tools as Array<{ name: string }>).map((t) => t.name);
    for (const expected of ['reporank', 'grader', 'claw-protect', 'codegraph', 'ocr', 'deep', 'codegang', 'codenexus', 'local_qa']) {
      expect(names).toContain(expected);
    }
    const labels = Object.fromEntries(
      (res.body.tools as Array<{ name: string; label?: string }>).map((t) => [t.name, t.label ?? t.name]),
    );
    expect(labels.deep).toBe('The Deep');
    expect(labels.codegang).toBe('CodeGang');
    expect(labels.codenexus).toBe('CodeNexus');
    expect(labels.local_qa).toBe('Benchmark Olympics QA');
  });
});
