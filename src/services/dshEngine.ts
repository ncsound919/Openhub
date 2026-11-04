import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import {
  DeepSeekHarness,
  type HarnessNotification,
} from '@deepseek-ai/dsh-sdk-client';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';

/**
 * dshEngine.ts — the DeepSeek Harness runtime lives in this process.
 *
 * Phase 1 of the opencode → dsh swap (`DEEPSEEK-HARNESS-SWAP.md`): an additive
 * engine seam that mirrors `opencodeEngine.ts` conventions — a lazily spawned
 * runtime owned by OpenHub, a shared in-flight start, a health snapshot and a
 * fail-closed approval bridge — while everything dsh-specific stays here. The
 * default engine is still opencode; routes mount at `/api/dsh/*` so Mission
 * Control can switch per deployment via `OPENHUB_AGENT_ENGINE=dsh`.
 *
 * The runtime is NOT `opencode serve`: there is no port and no HTTP health
 * probe. The SDK client (`@deepseek-ai/dsh-sdk-client`, stdio JSON-RPC) spawns
 * `dsh --profile sdk` as a child, and its startup provider binds the child's
 * stdin EOF to a bounded shutdown — so a killed OpenHub takes the runtime down
 * with it instead of orphaning a process on a port.
 *
 * Type note: `@deepseek-ai/dsh` and the client are pinned to the SAME npm
 * version (the client refuses a mismatch at spawn, see resolveDshBinFromManifests).
 * npm's `latest` dist-tag is stale 0.0.1-rc.1; install both at the matching
 * runtime version instead.
 */

const DSH_HOME_DEFAULT = path.join(os.homedir(), '.openhub', 'dsh');

export interface DshEngineConfig {
  /** Runtime executable; empty = SDK client resolves its same-version `dsh`. */
  bin: string;
  /** Isolated harness home (OPENHUB_DSH_HOME); resolved absolute. */
  home: string;
  /** dsh profile name (OPENHUB_DSH_PROFILE, default `sdk`). */
  profile: string;
  /** Provider route (OPENHUB_DSH_PROVIDER); empty = dsh default (`deepseek-official`). */
  provider: string;
  /** Model (OPENHUB_DSH_MODEL); empty = dsh's default, keeping models swappable. */
  model: string;
  /** Reasoning effort; dsh accepts `off | low | high | max`. */
  effort: string;
  /** Output cap per root-agent request (OPENHUB_DSH_MAX_TOKENS). */
  maxTokens: number;
  /** Operator approval bridge (OPENHUB_DSH_APPROVALS, default on). */
  approvals: boolean;
}

const REASONING_EFFORTS = new Set(['off', 'low', 'high', 'max']);

export function readDshEngineConfig(env: NodeJS.ProcessEnv = process.env): DshEngineConfig {
  const rawHome = env.OPENHUB_DSH_HOME || DSH_HOME_DEFAULT;
  const maxRaw = Number(env.OPENHUB_DSH_MAX_TOKENS || '0');
  return {
    bin: (env.OPENHUB_DSH_BIN || '').trim(),
    home: path.isAbsolute(rawHome) ? rawHome : path.resolve(rawHome),
    profile: (env.OPENHUB_DSH_PROFILE || 'sdk').trim() || 'sdk',
    provider: (env.OPENHUB_DSH_PROVIDER || '').trim(),
    model: (env.OPENHUB_DSH_MODEL || '').trim(),
    effort: (env.OPENHUB_DSH_REASONING_EFFORT || '').trim(),
    maxTokens: Number.isInteger(maxRaw) && maxRaw > 0 ? maxRaw : 0,
    approvals: (env.OPENHUB_DSH_APPROVALS || 'true').toLowerCase() !== 'false',
  };
}

/** A pending runtime approval waiting on the operator. */
export interface DshApproval {
  /** OpenHub-side id; the wire request carries no usable id of its own. */
  id: string;
  method: string;
  params: Record<string, unknown>;
  receivedAt: string;
}

/** One runtime notification ring entry (`session.event`, agent status, …). */
export interface DshNotification extends HarnessNotification {
  receivedAt: string;
  seq: number;
}

/** Minimal surface of `HarnessSession` the engine touches (test seam). */
export interface DshSessionLike {
  readonly id: string;
  run(input: string): Promise<{ sessionId: string; finalResponse: string; finishReason: string }>;
  setWorkingDirectory(dir: string): Promise<string>;
  getWorkingDirectory(): Promise<string>;
}

/** Minimal surface of `DeepSeekHarness` the engine touches (test seam). */
export interface DshHarnessLike {
  client: {
    start(): void;
    onRequest(handler: (method: string, params: Record<string, unknown>) => Promise<unknown>): void;
  };
  start(): Promise<void>;
  close(): Promise<void>;
  /** Optional: absent on older fakes; session routes fail closed when missing. */
  session?(sessionId?: string): DshSessionLike;
  resumeSession?(sessionId: string): Promise<DshSessionLike>;
}

/** Options that make a DeepSeekHarness launch out of one config. */
export function harnessOptions(config: DshEngineConfig): ConstructorParameters<typeof DeepSeekHarness>[0] {
  return {
    profile: config.profile,
    dshHome: config.home,
    ...(config.bin ? { dshBin: config.bin } : {}),
    approvalRequests: config.approvals,
    ...(config.provider ? { provider: config.provider } : {}),
    ...(config.model ? { model: config.model } : {}),
    ...(config.effort && REASONING_EFFORTS.has(config.effort)
      ? { reasoningEffort: ReasoningEffortId(config.effort) }
      : {}),
    ...(config.maxTokens > 0 ? { maxTokens: config.maxTokens } : {}),
  };
}

type DshHarnessFactory = (config: DshEngineConfig) => DshHarnessLike;

/** Real factory: the published SDK client, spawned with the resolved launch spec. */
const defaultFactory: DshHarnessFactory = (cfg) =>
  new DeepSeekHarness(harnessOptions(cfg)) as unknown as DshHarnessLike;

let factory: DshHarnessFactory = defaultFactory;
/** Tests swap the factory; the real client needs node + a dsh binary to spawn. */
export function setDshHarnessFactory(next: DshHarnessFactory | null): void {
  factory = next ?? defaultFactory;
}

let harness: DshHarnessLike | null = null;
let started = false;
let startError: string | null = null;
let starting: Promise<{ started: boolean; error?: string }> | null = null;

/** Approvals pending on the operator, keyed by our own id. */
const pending = new Map<string, { approval: DshApproval; resolve: (outcome: DshApprovalOutcome) => void }>();
let approvalSeq = 0;

export type DshApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled';

/** Live notifications for Mission Control (ring buffer, newest last). */
const notificationBuffer: DshNotification[] = [];
const notificationListeners = new Set<(n: DshNotification) => void>();
const NOTIFICATION_RING = 500;
const MAX_NOTIFICATION_PARAMS = 16 << 10;
let notificationSeq = 0;

function publishNotification(method: string, params: Record<string, unknown>): void {
  notificationSeq += 1;
  const record: DshNotification = { method, params, receivedAt: new Date().toISOString(), seq: notificationSeq };
  notificationBuffer.push(record);
  if (notificationBuffer.length > NOTIFICATION_RING) notificationBuffer.shift();
  for (const listener of notificationListeners) {
    try { listener(record); } catch { /* listener is best-effort */ }
  }
}

export function dshNotifications(sinceSeq = 0): { events: DshNotification[]; nextCursor: number } {
  return {
    events: notificationBuffer.filter((n) => n.seq > sinceSeq),
    nextCursor: notificationSeq,
  };
}

export function onDshNotification(listener: (n: DshNotification) => void): () => void {
  notificationListeners.add(listener);
  return () => { notificationListeners.delete(listener); };
}

export function pendingDshApprovals(): DshApproval[] {
  return [...pending.values()].map((p) => p.approval);
}

/** Answer one pending approval. Unknown or already-answered ids do nothing. */
export function respondDshApproval(id: string, outcome: DshApprovalOutcome): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  pending.delete(id);
  entry.resolve(outcome);
  return true;
}

/** The approval bridge: runtime requests arrive here and fail CLOSED if OpenHub dies. */
function installApprovalBridge(harnessLike: DshHarnessLike, approvalsEnabled: boolean): void {
  if (!approvalsEnabled) return;
  harnessLike.client.onRequest(async (method, params) => {
    if (!/approval/i.test(method)) throw new Error(`unsupported request: ${method}`);
    approvalSeq += 1;
    const id = `dsh_ap_${approvalSeq}`;
    const outcome = await new Promise<DshApprovalOutcome>((resolve) => {
      pending.set(id, {
        approval: { id, method, params, receivedAt: new Date().toISOString() },
        resolve,
      });
      publishNotification('openhub/approval-requested', { approvalId: id, approvalMethod: method });
    });
    publishNotification('openhub/approval-resolved', { approvalId: id, outcome });
    return { outcome };
  });
}

export async function dshEngineHealth(): Promise<{ available: boolean; error?: string }> {
  if (!harness) {
    return startError ? { available: false, error: startError } : { available: false };
  }
  return started
    ? { available: true }
    : { available: false, error: 'runtime process is up but the initialize handshake has not completed' };
}

/**
 * The live runtime, or null. Mission Control callers get a degraded
 * `available:false` snapshot instead of a throw so a dead runtime is data,
 * matching the opencode status contract.
 */
export function getDshHarness(): DshHarnessLike | null {
  return harness;
}

/** Open a session handle on the live runtime (no wire traffic until first use). */
export function openDshSession(sessionId?: string): DshSessionLike {
  if (!harness) throw new Error('dsh runtime is not started — call /api/dsh/engine/start first');
  if (typeof harness.session !== 'function') throw new Error('dsh runtime does not expose sessions in this build');
  return harness.session(sessionId);
}

/** One OpenHub-tracked runtime session. Handles die with the harness. */
export interface DshSessionRecord {
  id: string;
  createdAt: string;
  resumedFrom: string | null;
  workingDirectory: string | null;
  runs: number;
  lastFinishReason: string | null;
  lastRunAt: string | null;
}

const sessions = new Map<string, { handle: DshSessionLike; record: DshSessionRecord }>();

/** Prompt bodies above this are rejected before they reach the runtime. */
export const DSH_MAX_PROMPT_CHARS = 256_000;

function requireSessions(harnessLike: DshHarnessLike): asserts harnessLike is DshHarnessLike & {
  session(sessionId?: string): DshSessionLike;
} {
  if (typeof harnessLike.session !== 'function') {
    throw new Error('dsh runtime does not expose sessions in this build');
  }
}

function validateWorkingDirectory(dir: string): string {
  if (!path.isAbsolute(dir)) throw new Error('workingDirectory must be an absolute path');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch {
    throw new Error('workingDirectory does not exist: ' + dir);
  }
  if (!stat.isDirectory()) throw new Error('workingDirectory is not a directory: ' + dir);
  return path.normalize(dir);
}

/** Live session registry (in-process; runtime history persists in dshHome). */
export function listDshSessions(): DshSessionRecord[] {
  return [...sessions.values()].map((s) => ({ ...s.record }));
}

export async function createDshSession(opts: { workingDirectory?: string; resumeId?: string } = {}): Promise<DshSessionRecord> {
  if (!harness) throw new Error('dsh runtime is not started — call /api/dsh/engine/start first');
  const dir = opts.workingDirectory !== undefined ? validateWorkingDirectory(opts.workingDirectory) : null;
  let handle: DshSessionLike;
  let resumedFrom: string | null = null;
  if (opts.resumeId !== undefined) {
    if (typeof harness.resumeSession !== 'function') throw new Error('dsh runtime does not support resumeSession in this build');
    handle = await harness.resumeSession(opts.resumeId);
    resumedFrom = opts.resumeId;
  } else {
    requireSessions(harness);
    handle = harness.session();
  }
  if (dir) await handle.setWorkingDirectory(dir);
  const record: DshSessionRecord = {
    id: handle.id,
    createdAt: new Date().toISOString(),
    resumedFrom,
    workingDirectory: dir,
    runs: 0,
    lastFinishReason: null,
    lastRunAt: null,
  };
  sessions.set(handle.id, { handle, record });
  publishNotification('openhub/session-created', { sessionId: handle.id, resumedFrom });
  return { ...record };
}

export async function getDshSessionInfo(id: string): Promise<DshSessionRecord | null> {
  const entry = sessions.get(id);
  if (!entry) return null;
  try {
    entry.record.workingDirectory = await entry.handle.getWorkingDirectory();
  } catch { /* a dead handle keeps its last-known directory */ }
  return { ...entry.record };
}

/**
 * Run one prompt on a session. The response text goes back to the caller only —
 * the notification ring records metadata (never prompt/response bodies, which
 * can carry file contents and secrets any authenticated reader could fetch).
 */
export async function runDshPrompt(id: string, input: string): Promise<{ sessionId: string; finalResponse: string; finishReason: string }> {
  const entry = sessions.get(id);
  if (!entry) throw new Error('no such dsh session (engine restarted?)');
  if (typeof input !== 'string' || !input.trim()) throw new Error('input must be a non-empty string');
  if (input.length > DSH_MAX_PROMPT_CHARS) throw new Error(`input exceeds ${DSH_MAX_PROMPT_CHARS} characters`);
  const result = await entry.handle.run(input);
  entry.record.runs += 1;
  entry.record.lastFinishReason = result.finishReason;
  entry.record.lastRunAt = new Date().toISOString();
  publishNotification('openhub/session-run', {
    sessionId: id,
    finishReason: result.finishReason,
    responseChars: result.finalResponse.length,
  });
  return result;
}

/** Ring events that mention a session (session.event payloads + run records). */
export function dshSessionMessages(sessionId: string, sinceSeq = 0): { events: DshNotification[]; nextCursor: number } {
  const { events, nextCursor } = dshNotifications(sinceSeq);
  return {
    events: events.filter((n) => {
      const p = n.params as Record<string, unknown>;
      return Object.values(p).some((v) => v === sessionId)
        || (typeof n.method === 'string' && /session/i.test(n.method) && JSON.stringify(p).includes(sessionId));
    }),
    nextCursor,
  };
}

/**
 * Concurrent callers share one start (a double-click used to leak a second
 * engine with opencode; the same rule holds here — the client refuses to
 * spawn beside a process whose exit is unproved).
 */
export function startDshEngine(env: NodeJS.ProcessEnv = process.env): Promise<{ started: boolean; error?: string }> {
  if (!starting) starting = doStart(env).finally(() => { starting = null; });
  return starting;
}

async function doStart(env: NodeJS.ProcessEnv): Promise<{ started: boolean; error?: string }> {
  if (harness && started) return { started: true };
  const config = readDshEngineConfig(env);
  const candidate = factory(config);
  try {
    installApprovalBridge(candidate, config.approvals);
    await candidate.start();
    harness?.close().catch(() => { /* replaced runtime keeps cleaning itself up */ });
    harness = candidate;
    startError = null;
    started = true;
    publishNotification('openhub/engine-started', {
      profile: config.profile,
      dshHome: config.home,
      approvals: config.approvals,
    });
    return { started: true };
  } catch (err) {
    startError = err instanceof Error ? err.message : String(err);
    // A failed start hands the harness back cleaned-up (client close() is
    // permanent); do not retain it — the next start() call must construct a
    // fresh runtime, never reuse a torn-down client.
    if (harness !== candidate) { try { await candidate.close(); } catch { /* best effort */ } }
    return { started: false, error: startError };
  }
}

export async function stopDshEngine(): Promise<{ stopped: boolean; reason?: string }> {
  const current = harness;
  if (!current) return { stopped: false, reason: 'the dsh runtime was not started by OpenHub in this process' };
  harness = null;
  started = false;
  // Handles belong to the dead runtime; the persisted history in dshHome
  // survives, so callers re-enter with POST /dsh/sessions { resumeId }.
  sessions.clear();
  const outcomes = [...pending.keys()];
  pending.clear();
  for (const id of outcomes) publishNotification('openhub/approval-cancelled', { approvalId: id });
  await current.close().catch((err) => {
    publishNotification('openhub/engine-stop-error', { error: err instanceof Error ? err.message : String(err) });
  });
  publishNotification('openhub/engine-stopped', { pendingAbandoned: outcomes.length });
  return { stopped: true };
}
