import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAuditCoreRouter } from '../src/routes/auditCoreRoutes';

const dirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-core-routes-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', createAuditCoreRouter({ authMiddleware: (_req, _res, next) => next() }));
  return app;
}

let prevBase: string | undefined;
let prevModel: string | undefined;
beforeEach(() => {
  prevBase = process.env.OPENHUB_LLM_BASE_URL;
  prevModel = process.env.OPENHUB_LLM_MODEL;
  delete process.env.OPENHUB_LLM_BASE_URL;
  delete process.env.OPENHUB_LLM_MODEL;
});
afterEach(() => {
  if (prevBase === undefined) delete process.env.OPENHUB_LLM_BASE_URL; else process.env.OPENHUB_LLM_BASE_URL = prevBase;
  if (prevModel === undefined) delete process.env.OPENHUB_LLM_MODEL; else process.env.OPENHUB_LLM_MODEL = prevModel;
});

describe('auditCore routes', () => {
  it('400s without a valid targetDir', async () => {
    expect((await request(makeApp()).get('/api/audit-core/config')).status).toBe(400);
    expect((await request(makeApp()).post('/api/audit-core/run').send({ targetDir: 'C:/definitely/missing' })).status).toBe(400);
  });

  it('returns the config for a target dir', async () => {
    const d = tmpDir();
    fs.writeFileSync(path.join(d, 'openhub.yaml'), ['gate:', '  threshold: critical'].join('\n'));
    const res = await request(makeApp()).get(`/api/audit-core/config?targetDir=${encodeURIComponent(d)}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.source).toBe('openhub.yaml');
    expect(res.body.config.gate.threshold).toBe('critical');
  });

  it('runs the core over findings and returns validation + gate', async () => {
    const d = tmpDir();
    fs.mkdirSync(path.join(d, 'src'), { recursive: true });
    fs.writeFileSync(path.join(d, 'src', 'a.ts'), 'const x = 1;\n');
    const res = await request(makeApp()).post('/api/audit-core/run').send({
      targetDir: d,
      findings: [{ source: 'deep', dimension: 'correctness', category: 'npe', severity: 'high', confidence: 0.5, determinism: 'static', location: { file: 'src/a.ts', line: 1 } }],
    });
    expect(res.status).toBe(200);
    expect(res.body.core.gate.passed).toBe(false);
    expect(res.body.core.validation.confirmed).toBe(1);
  });

  it('reports rules/autofix as unconfigured without an LLM, never faking a pass', async () => {
    const d = tmpDir();
    const rules = await request(makeApp()).post('/api/audit-core/rules').send({ targetDir: d });
    expect(rules.status).toBe(200);
    expect(rules.body.configured).toBe(false);
    const autofix = await request(makeApp()).post('/api/audit-core/autofix').send({ targetDir: d, findings: [] });
    expect(autofix.status).toBe(200);
    expect(autofix.body.configured).toBe(false);
  });
});
