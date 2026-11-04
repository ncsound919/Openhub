process.env.OPENHUB_RECEIPTS_DISABLE = '1';
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createDshProxyRouter } from '../src/routes/dshProxy.js';
import {
  startDshEngine,
  stopDshEngine,
  setDshHarnessFactory,
  pendingDshApprovals,
  respondDshApproval,
  type DshHarnessLike,
  type DshApprovalOutcome,
} from '../src/services/dshEngine.js';

interface FakeRuntime extends DshHarnessLike {
  startCalls: number;
  closeCalls: number;
  approvalHandlers: Array<(method: string, params: Record<string, unknown>) => Promise<unknown>>;
  session(sessionId?: string): FakeProxySession;
  resumeSession(sessionId: string): Promise<FakeProxySession>;
}

interface FakeProxySession {
  id: string;
  run(input: string): Promise<{ sessionId: string; finalResponse: string; finishReason: string }>;
  setWorkingDirectory(d: string): Promise<string>;
  getWorkingDirectory(): Promise<string>;
}

let proxySessionSeq = 0;

function fakeRuntime(opts?: { failStart?: string }): FakeRuntime {
  const h: FakeRuntime = {
    startCalls: 0,
    closeCalls: 0,
    approvalHandlers: [] as FakeRuntime['approvalHandlers'],
    client: {
      start() {},
      onRequest(handler: (method: string, params: Record<string, unknown>) => Promise<unknown>) {
        h.approvalHandlers.push(handler);
      },
    },
    session(sessionId?: string) {
      proxySessionSeq += 1;
      const id = sessionId ?? `dsh_p_${proxySessionSeq}`;
      return {
        id,
        run: (input: string) => Promise.resolve({ sessionId: id, finalResponse: `echo: ${input}`, finishReason: 'stop' }),
        setWorkingDirectory: (d: string) => Promise.resolve(d),
        getWorkingDirectory: () => Promise.resolve(process.cwd()),
      };
    },
    resumeSession(sessionId: string) { return Promise.resolve(h.session(sessionId)); },
    start() {
      h.startCalls += 1;
      if (opts?.failStart) return Promise.reject(new Error(opts.failStart));
      return Promise.resolve();
    },
    close() {
      h.closeCalls += 1;
      return Promise.resolve();
    },
  } as FakeRuntime;
  return h;
}

/** The dsh runtime asks the bridge for approval: this drives one pending request. */
function askApproval(h: FakeRuntime, params: Record<string, unknown> = { operation: 'bash ls' }): Promise<{ outcome: string }> {
  return h.approvalHandlers[0]!('approval/request', params) as Promise<{ outcome: string }>;
}

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api', createDshProxyRouter({ authMiddleware: (_req, _res, next) => next() }));
  return a;
}

afterEach(async () => {
  setDshHarnessFactory(null);
  await stopDshEngine().catch(() => null);
  for (const a of pendingDshApprovals()) respondDshApproval(a.id, 'cancelled');
});

describe('dshProxy', () => {
  it('GET /api/dsh/status reports the engine as data, degraded when not started', async () => {
    const res = await request(app()).get('/api/dsh/status');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ available: false, engine: 'dsh', config: { profile: 'sdk', approvals: true } });
  });

  it('POST /api/dsh/engine/start runs the shared start and reports success once', async () => {
    const h = fakeRuntime();
    setDshHarnessFactory(() => h);
    const res = await request(app()).post('/api/dsh/engine/start');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ started: true });
    expect(h.startCalls).toBe(1);
    await expect(request(app()).get('/api/dsh/status').then((r) => r.body.data))
      .resolves.toMatchObject({ available: true });
    await stopDshEngine();
  });

  it('POST /api/dsh/engine/start with a failing handshake carries the engine error', async () => {
    setDshHarnessFactory(() => fakeRuntime({ failStart: 'handshake refused' }));
    const res = await request(app()).post('/api/dsh/engine/start');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ started: false, error: 'handshake refused' });
    await stopDshEngine();
  });

  it('POST /api/dsh/engine/stop without an engine reports why (not stopped)', async () => {
    const res = await request(app()).post('/api/dsh/engine/stop');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ stopped: false });
  });

  it('GET /api/dsh/approvals lists bridged pending requests, nothing invented', async () => {
    await expect(request(app()).get('/api/dsh/approvals').then((r) => r.body.data)).resolves.toEqual([]);
  });

  it('session lifecycle: empty list, create, read, prompt, messages', async () => {
    setDshHarnessFactory(() => fakeRuntime());
    await startDshEngine();
    await expect(request(app()).get('/api/dsh/sessions').then((r) => r.body.data)).resolves.toEqual([]);

    const created = await request(app()).post('/api/dsh/sessions').send({});
    expect(created.status).toBe(200);
    const id = created.body.data.id as string;
    expect(id).toMatch(/^dsh_p_/);

    const listed = await request(app()).get('/api/dsh/sessions');
    expect(listed.body.data.map((s: { id: string }) => s.id)).toEqual([id]);

    const one = await request(app()).get(`/api/dsh/sessions/${id}`);
    expect(one.status).toBe(200);
    expect(one.body.data).toMatchObject({ id, runs: 0 });

    const missing = await request(app()).get('/api/dsh/sessions/dsh_p_nope');
    expect(missing.status).toBe(404);

    const prompted = await request(app()).post(`/api/dsh/sessions/${id}/prompt`).send({ input: 'hello agent' });
    expect(prompted.status).toBe(200);
    expect(prompted.body.data).toMatchObject({ sessionId: id, finishReason: 'stop' });

    const messages = await request(app()).get(`/api/dsh/sessions/${id}/messages`);
    expect(messages.status).toBe(200);
    expect(messages.body.data.events.some((n: { method: string }) => n.method === 'openhub/session-run')).toBe(true);
    expect(JSON.stringify(messages.body.data)).not.toContain('hello agent');
  });

  it('prompt and create validate input and engine state with honest statuses', async () => {
    // No engine started: session creation is a 502, not a hang.
    const down = await request(app()).post('/api/dsh/sessions').send({});
    expect(down.status).toBe(502);

    setDshHarnessFactory(() => fakeRuntime());
    await startDshEngine();
    const created = await request(app()).post('/api/dsh/sessions').send({});
    const id = created.body.data.id as string;

    const empty = await request(app()).post(`/api/dsh/sessions/${id}/prompt`).send({ input: '  ' });
    expect(empty.status).toBe(400);
    const nonString = await request(app()).post(`/api/dsh/sessions/${id}/prompt`).send({ input: 42 });
    expect(nonString.status).toBe(400);
    const ghost = await request(app()).post('/api/dsh/sessions/dsh_p_nope/prompt').send({ input: 'hi' });
    expect(ghost.status).toBe(404);
    const badDir = await request(app()).post('/api/dsh/sessions').send({ workingDirectory: 'relative/nope' });
    expect(badDir.status).toBe(400);
    const badType = await request(app()).post('/api/dsh/sessions').send({ workingDirectory: 42 });
    expect(badType.status).toBe(400);
  });

  it('unsupported session actions answer 501, never fake success', async () => {
    setDshHarnessFactory(() => fakeRuntime());
    await startDshEngine();
    const created = await request(app()).post('/api/dsh/sessions').send({});
    const id = created.body.data.id as string;
    for (const action of ['abort', 'revert', 'unrevert', 'todos', 'diff']) {
      const res = await request(app()).post(`/api/dsh/sessions/${id}/${action}`);
      expect(res.status).toBe(501);
      expect(res.body.error).toMatch(/no session/);
    }
  });

  it('GET /api/dsh/events exposes the cursor-pollable notification ring', async () => {
    const first = await request(app()).get('/api/dsh/events');
    expect(first.status).toBe(200);
    expect(first.body.data).toHaveProperty('events');
    expect(first.body.data).toHaveProperty('nextCursor');
    const cursor = first.body.data.nextCursor as number;
    const empty = await request(app()).get(`/api/dsh/events?since=${cursor}`);
    expect(empty.body.data.events).toEqual([]);
  });

  it('approval reply validates the outcome before touching the bridge', async () => {
    const harness = fakeRuntime();
    setDshHarnessFactory(() => harness);
    await startDshEngine();
    const pending1 = askApproval(harness);
    const approvals = await request(app()).get('/api/dsh/approvals');
    expect(approvals.body.data).toHaveLength(1);
    const id = approvals.body.data[0].id;

    const bad = await request(app()).post(`/api/dsh/approvals/${id}`).send({ outcome: 'yes-please' });
    expect(bad.status).toBe(400);
    const no = await request(app()).post('/api/dsh/approvals/ap_unknown').send({ outcome: 'rejected' });
    expect(no.status).toBe(404);

    const answer = await request(app()).post(`/api/dsh/approvals/${id}`).send({ outcome: 'rejected' });
    expect(answer.status).toBe(200);
    await expect(pending1).resolves.toEqual({ outcome: 'rejected' });
    await expect(request(app()).get('/api/dsh/approvals').then((r) => r.body.data)).resolves.toEqual([]);
  });
});
