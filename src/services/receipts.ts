/**
 * Receipts — the evidence spine.
 *
 * Every verification number OpenHub shows must be traceable to a command that
 * actually ran. A receipt is the immutable record of that execution: the
 * command line, its working directory, exit status, output digest, timing, and
 * the run/scorer it belongs to.
 *
 * Integrity model (tamper-evident logging, per Crosby/Wallach and Certificate
 * Transparency RFC 6962):
 *   - Each receipt carries a content `digest` over its asserted fields.
 *   - Receipts are append-only and hash-chained: `chainHash = MAC(prevHash |
 *     digest)`, so editing, deleting, or reordering any entry breaks the chain
 *     from that point forward.
 *   - The chain MAC is keyed with an HMAC secret when one is configured, so an
 *     attacker who can rewrite the store still cannot forge hashes.
 *   - A hash chain cannot detect *end-truncation* (dropping the newest
 *     entries). `anchorHead()` records the current head outside the log so
 *     `verifyChain(head)` fails if the log no longer reaches it.
 *
 * Boundaries, mirroring the rest of the codebase:
 *   - Best-effort persistence. A disk failure never fails the command.
 *   - Output is digested, not trusted; only a short, secret-redacted tail is
 *     retained for display.
 *   - Verification fails closed: a missing receipt is a gap, never a pass.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { SECRET_PATTERNS } from './secretScan.js';

export type ReceiptKind = 'command' | 'probe' | 'bridge' | 'decision';
export type ReceiptStatus = 'passed' | 'failed' | 'timeout' | 'skipped' | 'unavailable';

export interface ReceiptInput {
  kind: ReceiptKind;
  /** Human-printable command line (or endpoint for a bridge call). */
  command: string;
  tool?: string;
  cwd?: string;
  target?: string;
  scorer?: string;
  runId?: string;
  label?: string;
  status: ReceiptStatus;
  exitCode?: number | null;
  startedAt?: string;
  durationMs?: number;
  output?: string;
  meta?: Record<string, unknown>;
}

export interface Receipt {
  id: string;
  /** Content digest over the asserted fields. */
  digest: string;
  /** Position in the append-only chain (0-based). */
  seq: number;
  /** chainHash of the previous receipt (genesis = 64 zeros). */
  prevHash: string;
  /** Keyed MAC linking this receipt to the whole history. */
  chainHash: string;
  kind: ReceiptKind;
  command: string;
  tool?: string;
  cwd?: string;
  target?: string;
  scorer?: string;
  runId?: string;
  label?: string;
  status: ReceiptStatus;
  exitCode: number | null;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  outputBytes: number;
  outputDigest: string;
  outputTail: string;
  meta?: Record<string, unknown>;
}

export interface ReceiptContext {
  runId?: string;
  target?: string;
  scorer?: string;
}

const GENESIS = '0'.repeat(64);

const als = new AsyncLocalStorage<ReceiptContext>();

/** Set the receipt context for the current async execution and its children. */
export function enterReceiptContext(ctx: ReceiptContext): void {
  als.enterWith(ctx);
}

/** Run `fn` with a receipt context bound to it. */
export function runWithReceipts<T>(ctx: ReceiptContext, fn: () => T): T {
  return als.run(ctx, fn);
}

export function currentReceiptContext(): ReceiptContext | undefined {
  return als.getStore();
}

const OUTPUT_TAIL_CHARS = 600;
const MAX_RECEIPTS = 5000;

/** Resolve the chain MAC key. Prefers a dedicated secret, then the node's
 *  own access-token secret so the chain is keyed without extra config. */
function chainKey(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENHUB_RECEIPTS_HMAC_KEY || env.ACCESS_TOKEN_SECRET || '';
}

/** Redact anything matching a known secret pattern before retaining output. */
export function redactSecrets(input: string): string {
  let out = input;
  for (const pattern of SECRET_PATTERNS) {
    try {
      pattern.regex.lastIndex = 0;
      out = out.replace(pattern.regex, `[redacted:${pattern.name}]`);
    } catch {
      /* a broken pattern must not break redaction */
    }
  }
  return out;
}

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function canonical(fields: Array<string | number | null | undefined>): string {
  return fields.map((f) => (f === null || f === undefined ? '' : String(f))).join('\u0000');
}

/** Digest over the fields a receipt asserts; recomputed to verify integrity. */
export function receiptDigest(r: Pick<Receipt,
  'kind' | 'command' | 'tool' | 'cwd' | 'target' | 'scorer' | 'runId' | 'label' |
  'status' | 'exitCode' | 'startedAt' | 'durationMs' | 'outputDigest'
>): string {
  return sha256(canonical([
    r.kind, r.command, r.tool, r.cwd, r.target, r.scorer, r.runId, r.label,
    r.status, r.exitCode, r.startedAt, r.durationMs, r.outputDigest,
  ]));
}

/** Chain link: HMAC(prev | digest) when keyed, else SHA-256. */
export function chainHash(prevHash: string, digest: string, key = chainKey()): string {
  const input = `${prevHash}\u0000${digest}`;
  return key
    ? crypto.createHmac('sha256', key).update(input).digest('hex')
    : sha256(input);
}

const ring: Receipt[] = [];
const byId = new Map<string, Receipt>();
let headSeq = -1;
let headHash = GENESIS;
let inMemoryAnchor: ChainAnchor | null = null;

function receiptsDir(): string | null {
  if (process.env.OPENHUB_RECEIPTS_DISABLE === '1') return null;
  return process.env.OPENHUB_RECEIPTS_DIR
    ? path.resolve(process.env.OPENHUB_RECEIPTS_DIR)
    : path.resolve(process.cwd(), 'data', 'receipts');
}

function persist(receipt: Receipt): void {
  const dir = receiptsDir();
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'receipts.jsonl'), `${JSON.stringify(receipt)}\n`, 'utf8');
  } catch {
    /* persistence is best-effort */
  }
}

/** Build, chain, store, and return an immutable receipt. */
export function recordReceipt(input: ReceiptInput): Receipt {
  const ctx = currentReceiptContext();
  const output = input.output ?? '';
  const startedAt = input.startedAt ?? new Date().toISOString();
  const durationMs = Math.max(0, Math.round(input.durationMs ?? 0));
  const endedAt = new Date(new Date(startedAt).getTime() + durationMs).toISOString();
  const outputDigest = sha256(output);
  const base = {
    kind: input.kind,
    command: input.command,
    tool: input.tool,
    cwd: input.cwd,
    target: input.target ?? ctx?.target,
    scorer: input.scorer ?? ctx?.scorer,
    runId: input.runId ?? ctx?.runId,
    label: input.label,
    status: input.status,
    exitCode: input.exitCode ?? null,
    startedAt,
    durationMs,
    outputDigest,
  };
  const digest = receiptDigest(base);
  const prevHash = headHash;
  const link = chainHash(prevHash, digest);
  const seq = headSeq + 1;
  const receipt: Receipt = {
    ...base,
    id: `rc_${digest.slice(0, 20)}`,
    digest,
    seq,
    prevHash,
    chainHash: link,
    endedAt,
    outputBytes: Buffer.byteLength(output, 'utf8'),
    outputTail: redactSecrets(output).slice(-OUTPUT_TAIL_CHARS),
    ...(input.meta ? { meta: input.meta } : {}),
  };
  ring.push(receipt);
  if (ring.length > MAX_RECEIPTS) {
    const dropped = ring.shift();
    if (dropped) byId.delete(dropped.id);
  }
  byId.set(receipt.id, receipt);
  headSeq = seq;
  headHash = link;
  persist(receipt);
  return receipt;
}

export function getReceipt(id: string): Receipt | undefined {
  return byId.get(id);
}

export interface ReceiptFilter {
  runId?: string;
  scorer?: string;
  kind?: ReceiptKind;
  includeProbes?: boolean;
  limit?: number;
}

/** Most-recent-first listing. Probes are excluded by default. */
export function listReceipts(filter: ReceiptFilter = {}): Receipt[] {
  const limit = Math.max(1, Math.min(1000, filter.limit ?? 100));
  const out: Receipt[] = [];
  for (let i = ring.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const r = ring[i];
    if (filter.runId && r.runId !== filter.runId) continue;
    if (filter.scorer && r.scorer !== filter.scorer) continue;
    if (filter.kind && r.kind !== filter.kind) continue;
    if (!filter.includeProbes && r.kind === 'probe') continue;
    out.push(r);
  }
  return out;
}

export interface ReceiptVerification {
  id: string;
  /** Content digest matches the asserted fields. */
  valid: boolean;
  expected: string;
  actual: string;
}

/** Recompute a single receipt's content digest and compare it to the stored one. */
export function verifyReceipt(receipt: Receipt): ReceiptVerification {
  const expected = receipt.digest;
  const actual = receiptDigest(receipt);
  return { id: receipt.id, valid: expected === actual, expected, actual };
}

export interface ChainVerification {
  valid: boolean;
  checked: number;
  /** Seq of the first entry that broke the chain, when invalid. */
  brokenAt?: number;
  reason?: string;
}

/**
 * Verify an append-only chain: every entry's content digest must hold, every
 * `prevHash`/`chainHash` link must match, and seq must be contiguous. Detects
 * edits, deletions, and reorderings. (End-truncation is caught by `verifyChain`
 * against a prior `anchorHead()`.)
 */
export function verifyChain(
  entries: readonly Receipt[] = ring,
  anchor?: { seq: number; chainHash: string },
): ChainVerification {
  if (anchor && (entries.length === 0 || entries[entries.length - 1].seq < anchor.seq)) {
    return { valid: false, checked: entries.length, reason: `chain does not reach anchored head seq ${anchor.seq} (truncation?)` };
  }
  let prev = GENESIS;
  let expectedSeq = entries.length ? entries[0].seq : 0;
  for (const r of entries) {
    if (r.seq !== expectedSeq) {
      return { valid: false, checked: expectedSeq, brokenAt: r.seq, reason: `seq gap: expected ${expectedSeq}, saw ${r.seq}` };
    }
    if (receiptDigest(r) !== r.digest) {
      return { valid: false, checked: expectedSeq, brokenAt: r.seq, reason: 'content digest mismatch (entry edited)' };
    }
    const link = chainHash(prev, r.digest);
    if (link !== r.chainHash || r.prevHash !== prev) {
      return { valid: false, checked: expectedSeq, brokenAt: r.seq, reason: 'chain link mismatch (entry inserted/reordered)' };
    }
    prev = r.chainHash;
    expectedSeq += 1;
  }
  if (anchor && (entries[entries.length - 1]?.chainHash !== anchor.chainHash || anchor.chainHash !== prev)) {
    return { valid: false, checked: entries.length, reason: 'head hash does not match the anchor' };
  }
  return { valid: true, checked: entries.length };
}

export interface ChainAnchor {
  seq: number;
  chainHash: string;
  at: string;
}

/** Record the current head outside the log so end-truncation is detectable. */
export function anchorHead(): ChainAnchor {
  const anchor: ChainAnchor = { seq: headSeq, chainHash: headHash, at: new Date().toISOString() };
  inMemoryAnchor = anchor;
  const dir = receiptsDir();
  if (dir) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'anchor.json'), JSON.stringify(anchor, null, 2), 'utf8');
    } catch {
      /* best-effort */
    }
  }
  return anchor;
}

export function getAnchor(): ChainAnchor | null {
  const dir = receiptsDir();
  if (dir) {
    try {
      const raw = fs.readFileSync(path.join(dir, 'anchor.json'), 'utf8');
      const parsed = JSON.parse(raw) as ChainAnchor;
      if (typeof parsed?.seq === 'number' && typeof parsed?.chainHash === 'string') {
        return parsed;
      }
    } catch {
      /* fall back to in-memory anchor */
    }
  }
  return inMemoryAnchor;
}

export function chainHead(): { seq: number; chainHash: string } {
  return { seq: headSeq, chainHash: headHash };
}

/** Test seam: clear the in-memory store and chain head. */
export function clearReceipts(): void {
  ring.length = 0;
  byId.clear();
  headSeq = -1;
  headHash = GENESIS;
  inMemoryAnchor = null;
  const dir = receiptsDir();
  if (dir) {
    try {
      fs.unlinkSync(path.join(dir, 'anchor.json'));
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Record a process run as a receipt. Called by `processRunner` for every
 * subprocess so the audit trail is automatic rather than opt-in.
 */
export function recordCommandReceipt(input: {
  command: string;
  tool: string;
  cwd: string;
  status: ReceiptStatus;
  exitCode: number | null;
  startedAt: number;
  durationMs: number;
  output: string;
  probe?: boolean;
  label?: string;
}): Receipt {
  return recordReceipt({
    kind: input.probe ? 'probe' : 'command',
    command: input.command,
    tool: input.tool,
    cwd: input.cwd,
    status: input.status,
    exitCode: input.exitCode,
    startedAt: new Date(input.startedAt).toISOString(),
    durationMs: input.durationMs,
    output: input.output,
    ...(input.label ? { label: input.label } : {}),
  });
}
