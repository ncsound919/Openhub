process.env.OPENHUB_RECEIPTS_DISABLE = '1';
import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import {
  readDshEngineConfig,
  dshEngineHealth,
  startDshEngine,
  stopDshEngine,
  setDshHarnessFactory,
  getDshHarness,
  pendingDshApprovals,
  respondDshApproval,
  dshNotifications,
  onDshNotification,
  listDshSessions,
  createDshSession,
  getDshSessionInfo,
  runDshPrompt,
  dshSessionMessages,
  type DshHarnessLike,
  type DshApprovalOutcome,
} from '../src/services/dshEngine.js';

interface FakeHarness extends DshHarnessLike {
  startCalls: number;
  closeCalls: number;
  startError?: string;
  approvalHandlers: Array<(method: string, params: Record<string, unknown>) => Promise<unknown>>;
  madeSessions: FakeSession[];
  session(sessionId?: string): FakeSession;
  resumeSession(sessionId: string): Promise<FakeSession>;
}

interface FakeSession {
  id: string;
  runs: string[];
  dir: string | null;
  run(input: string): Promise<{ sessionId: string; finalResponse: string; finishReason: string }>;
  setWorkingDirectory(d: string): Promise<string>;
  getWorkingDirectory(): Promise<string>;
}

let fakeSessionSeq = 0;

function fakeHarness(opts?: { failStart?: string }): FakeHarness {
  const h = {
    startCalls: 0,
    closeCalls: 0,
    approvalHandlers: [] as FakeHarness['approvalHandlers'],
    madeSessions: [] as FakeSession[],
    client: {
      start() {},
      onRequest(handler: (method: string, params: Record<string, unknown>) => Promise<unknown>) {
        h.approvalHandlers.push(handler);
      },
    },
    session(sessionId?: string) {
      fakeSessionSeq += 1;
      const id = sessionId ?? `dsh_s_${fakeSessionSeq}`;
      const s: FakeSession = {
        id,
        runs: [],
        dir: null,
        run(input: string) {
          s.runs.push(input);
          return Promise.resolve({ sessionId: id, finalResponse: `done: ${input}`, finishReason: 'stop' });
        },
        setWorkingDirectory(d: string) { s.dir = d; return Promise.resolve(d); },
        getWorkingDirectory() { return Promise.resolve(s.dir ?? process.cwd()); },
      };
      h.madeSessions.push(s);
      return s;
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
  } as FakeHarness;
  return h;
}

afterEach(async () => {
  setDshHarnessFactory(null);
  await stopDshEngine().catch(() => null);
  for (const a of pendingDshApprovals()) respondDshApproval(a.id, 'cancelled');
});

describe('dshEngine config', () => {
  it('defaults to the sdk profile, an isolated home, and approvals on', () => {
    const cfg = readDshEngineConfig({} as NodeJS.ProcessEnv);
    expect(cfg.profile).toBe('sdk');
    expect(cfg.approvals).toBe(true);
    expect(cfg.effort).toBe('');
    expect(cfg.maxTokens).toBe(0);
    expect(cfg.bin).toBe('');
    expect(cfg.home).toMatch(/[\\/]dsh$/);
  });
  it('resolves a relative dsh home against the process cwd', () => {
    const cfg = readDshEngineConfig({ OPENHUB_DSH_HOME: 'data/dsh-home' } as NodeJS.ProcessEnv);
    expect(/[\\/]data[\\/]dsh-home$/.test(cfg.home)).toBe(true);
  });
  it('drops non-positive or non-integer token caps', () => {
    expect(readDshEngineConfig({ OPENHUB_DSH_MAX_TOKENS: '0' } as NodeJS.ProcessEnv).maxTokens).toBe(0);
    expect(readDshEngineConfig({ OPENHUB_DSH_MAX_TOKENS: '-5' } as NodeJS.ProcessEnv).maxTokens).toBe(0);
    expect(readDshEngineConfig({ OPENHUB_DSH_MAX_TOKENS: '1.5' } as NodeJS.ProcessEnv).maxTokens).toBe(0);
    expect(readDshEngineConfig({ OPENHUB_DSH_MAX_TOKENS: '49152' } as NodeJS.ProcessEnv).maxTokens).toBe(49152);
  });
  it('treats only exact "false" as approvals off', () => {
    expect(readDshEngineConfig({ OPENHUB_DSH_APPROVALS: 'false' } as NodeJS.ProcessEnv).approvals).toBe(false);
    expect(readDshEngineConfig({ OPENHUB_DSH_APPROVALS: '0' } as NodeJS.ProcessEnv).approvals).toBe(true);
  });
});

describe('dshEngine lifecycle', () => {
  it('reports a degraded data snapshot before any start, never a throw', async () => {
    const health = await dshEngineHealth();
    expect(health).toEqual({ available: false });
    expect(getDshHarness()).toBeNull();
  });

  it('starts once, shares concurrent starts, and reports healthy afterwards', async () => {
    const h = fakeHarness();
    setDshHarnessFactory(() => h);
    const [a, b] = await Promise.all([startDshEngine(), startDshEngine()]);
    expect(a).toEqual({ started: true });
    expect(b).toEqual({ started: true });
    expect(h.startCalls).toBe(1);
    expect(getDshHarness()).toBe(h);
    await expect(dshEngineHealth()).resolves.toEqual({ available: true });
  });

  it('surfaces a failed handshake as data and does not retain the torn-down client', async () => {
    const h = fakeHarness({ failStart: 'handshake refused' });
    setDshHarnessFactory(() => h);
    const result = await startDshEngine();
    expect(result).toEqual({ started: false, error: 'handshake refused' });
    expect(getDshHarness()).toBeNull();
    await expect(dshEngineHealth()).resolves.toEqual({ available: false, error: 'handshake refused' });
    // A failed start hands the client back cleaned-up; the next start must build a fresh runtime.
    const h2 = fakeHarness();
    setDshHarnessFactory(() => h2);
    await expect(startDshEngine()).resolves.toEqual({ started: true });
    expect(h2.startCalls).toBe(1);
    await stopDshEngine();
  });

  it('stops the runtime it owns and reports healthy:false after stop', async () => {
    const h = fakeHarness();
    setDshHarnessFactory(() => h);
    await startDshEngine();
    await expect(stopDshEngine()).resolves.toEqual({ stopped: true });
    expect(h.closeCalls).toBe(1);
    await expect(dshEngineHealth()).resolves.toEqual({ available: false });
  });
});

describe('approval bridge', () => {
  it('fails CLOSED: approvals without an operator answer stay pending and the runtime kills the grant itself', async () => {
    // Documented runtime behavior the bridge relies on: a transport loss or an
    // unanswered request yields the runtime's fail-closed `unavailable` outcome.
    // OpenHub therefore only surfaces the pending list and never auto-accepts.
    const h = fakeHarness();
    setDshHarnessFactory(() => h);
    await startDshEngine();
    expect(getDshHarness()).not.toBeNull();
    expect(pendingDshApprovals()).toEqual([]);
  });

  it('lists pending approvals and forwards exactly the allowed outcomes', async () => {
    const h = fakeHarness();
    setDshHarnessFactory(() => h);
    await startDshEngine();
    // Simulate the runtime asking for an approval over the bridge.
    const worker = (h.approvalHandlers[0]!('approval/request', { operation: 'bash ls', session: 's1' })) as Promise<{ outcome: string }>;
    const pendingList = pendingDshApprovals();
    expect(pendingList).toHaveLength(1);
    expect(pendingList[0]!.method).toBe('approval/request');
    expect(pendingList[0]!.params).toMatchObject({ operation: 'bash ls' });
    expect(pendingList[0]!.id).toMatch(/^dsh_ap_/);

    expect(respondDshApproval('no-such-id', 'allowed-once')).toBe(false);
    expect(pendingDshApprovals()).toHaveLength(1);
    expect(respondDshApproval(pendingList[0]!.id, 'rejected')).toBe(true);
    await expect(worker).resolves.toEqual({ outcome: 'rejected' });
    expect(pendingDshApprovals()).toHaveLength(0);
  });

  it('starts-without-approvals leaves the bridge uninstalled', async () => {
    const h = fakeHarness();
    setDshHarnessFactory(() => h);
    await startDshEngine({ OPENHUB_DSH_APPROVALS: 'false' } as NodeJS.ProcessEnv);
    expect(h.approvalHandlers).toHaveLength(0);
  });
});

describe('dsh sessions (phase 2)', () => {
  it('refuses session work before the engine starts', async () => {
    await expect(createDshSession()).rejects.toThrow(/not started/);
    await expect(runDshPrompt('dsh_s_nope', 'hi')).rejects.toThrow(/no such dsh session/);
    expect(listDshSessions()).toEqual([]);
  });

  it('creates, lists and reads back a session with its live directory', async () => {
    setDshHarnessFactory(() => fakeHarness());
    await startDshEngine();
    const created = await createDshSession({ workingDirectory: os.tmpdir() });
    expect(created.id).toMatch(/^dsh_s_/);
    expect(created.workingDirectory).toBe(path.normalize(os.tmpdir()));
    expect(created.runs).toBe(0);
    expect(listDshSessions().map((s) => s.id)).toEqual([created.id]);
    await expect(getDshSessionInfo(created.id)).resolves.toMatchObject({ id: created.id, runs: 0 });
    await expect(getDshSessionInfo('dsh_s_nope')).resolves.toBeNull();
  });

  it('fails closed on bad working directories', async () => {
    setDshHarnessFactory(() => fakeHarness());
    await startDshEngine();
    await expect(createDshSession({ workingDirectory: 'relative/path' })).rejects.toThrow(/absolute/);
    await expect(createDshSession({ workingDirectory: path.join(os.tmpdir(), 'definitely-not-here-12345') })).rejects.toThrow(/does not exist/);
    await expect(createDshSession({ workingDirectory: __filename })).rejects.toThrow(/not a directory/);
    expect(listDshSessions()).toEqual([]);
  });

  it('resumes a persisted session id through the runtime', async () => {
    const h = fakeHarness();
    setDshHarnessFactory(() => h);
    await startDshEngine();
    const resumed = await createDshSession({ resumeId: 'persisted-abc' });
    expect(resumed.id).toBe('persisted-abc');
    expect(resumed.resumedFrom).toBe('persisted-abc');
  });

  it('runs a prompt and records metadata, never bodies, in the ring', async () => {
    setDshHarnessFactory(() => fakeHarness());
    await startDshEngine();
    const created = await createDshSession();
    const result = await runDshPrompt(created.id, 'secret-plans do the thing');
    expect(result).toMatchObject({ sessionId: created.id, finishReason: 'stop' });
    expect(result.finalResponse).toContain('secret-plans');
    await expect(getDshSessionInfo(created.id)).resolves.toMatchObject({ runs: 1, lastFinishReason: 'stop' });
    const { events } = dshSessionMessages(created.id);
    const runRecord = events.find((n) => n.method === 'openhub/session-run');
    expect(runRecord).toBeDefined();
    expect(runRecord!.params).toMatchObject({ sessionId: created.id, finishReason: 'stop' });
    expect(runRecord!.params).not.toHaveProperty('finalResponse');
    expect(runRecord!.params).not.toHaveProperty('input');
    // A sibling session's traffic does not leak into this session's messages.
    const other = await createDshSession();
    const mine = dshSessionMessages(created.id).events;
    expect(mine.some((n) => JSON.stringify(n.params).includes(other.id))).toBe(false);
  });

  it('validates prompt input before touching the runtime', async () => {
    const h = fakeHarness();
    setDshHarnessFactory(() => h);
    await startDshEngine();
    const created = await createDshSession();
    await expect(runDshPrompt(created.id, '   ')).rejects.toThrow(/non-empty/);
    await expect(runDshPrompt(created.id, 'x'.repeat(256_001))).rejects.toThrow(/exceeds/);
    expect(h.madeSessions[0]!.runs).toEqual([]);
  });

  it('stop clears the session registry so dead handles cannot run', async () => {
    setDshHarnessFactory(() => fakeHarness());
    await startDshEngine();
    const created = await createDshSession();
    await stopDshEngine();
    expect(listDshSessions()).toEqual([]);
    await expect(runDshPrompt(created.id, 'hi')).rejects.toThrow(/no such dsh session/);
  });
});

describe('notification ring', () => {
  it('publishes engine lifecycle notifications with an advancing cursor', async () => {
    setDshHarnessFactory(() => fakeHarness());
    const seen: string[] = [];
    const unsubscribe = onDshNotification((n) => seen.push(n.method));
    const cursorBefore = dshNotifications().nextCursor;
    await startDshEngine();
    await stopDshEngine();
    expect(seen).toEqual(['openhub/engine-started', 'openhub/engine-stopped']);
    // Notification params never carry secrets: a start record names the profile and the isolated home only.
    const started = dshNotifications(cursorBefore - 1).events.find((n) => n.method === 'openhub/engine-started');
    expect(started?.params).toMatchObject({ profile: 'sdk', approvals: true });
    expect(dshNotifications(dshNotifications().nextCursor).events).toHaveLength(0);
    unsubscribe();
  });

  it('abandons pending approvals on stop so the runtime may not re-grant them', async () => {
    const h = fakeHarness();
    setDshHarnessFactory(() => h);
    await startDshEngine();
    // A pending approval with no resolution on the wire: stop() clears it.
    void h.approvalHandlers[0]!('approval/request', { operation: 'edit file.ts' });
    expect(pendingDshApprovals()).toHaveLength(1);
    const stopped = dshNotifications().events.filter((n) => n.method === 'openhub/approval-cancelled');
    expect(stopped).toHaveLength(0);
    await stopDshEngine();
    expect(pendingDshApprovals()).toHaveLength(0);
  });
});
