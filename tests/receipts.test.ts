import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  anchorHead,
  chainHash,
  chainHead,
  clearReceipts,
  listReceipts,
  receiptDigest,
  recordCommandReceipt,
  recordReceipt,
  redactSecrets,
  runWithReceipts,
  verifyChain,
  verifyReceipt,
} from '../src/services/receipts';

function mk(overrides: Record<string, unknown> = {}) {
  return recordReceipt({
    kind: 'command',
    command: 'npx tsc --noEmit',
    tool: 'tsc',
    cwd: '/repo',
    status: 'passed',
    exitCode: 0,
    startedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 100,
    output: 'ok',
    ...overrides,
  });
}

beforeEach(() => {
  clearReceipts();
  vi.unstubAllEnvs();
});

afterEach(() => {
  clearReceipts();
  vi.unstubAllEnvs();
});

describe('receipts — record + content integrity', () => {
  it('builds a content-addressed receipt with a stable digest', () => {
    const r = mk();
    expect(r.id).toBe(`rc_${r.digest.slice(0, 20)}`);
    expect(r.digest).toBe(receiptDigest(r));
    expect(r.seq).toBe(0);
    expect(r.chainHash.length).toBe(64);
    expect(verifyReceipt(r).valid).toBe(true);
  });

  it('detects an edited receipt', () => {
    const r = mk();
    const tampered = { ...r, status: 'failed' as const };
    expect(verifyReceipt(tampered).valid).toBe(false);
  });

  it('redacts secrets in the retained output tail', () => {
    const r = mk({ output: 'token=ghp_' + 'a'.repeat(36) });
    expect(r.outputTail).toContain('[redacted:');
    expect(r.outputTail).not.toContain('ghp_');
    expect(redactSecrets('x')).toBe('x');
  });
});

describe('receipts — chain', () => {
  it('links each receipt to the previous one', () => {
    const a = mk({ command: 'a' });
    const b = mk({ command: 'b' });
    expect(b.seq).toBe(1);
    expect(a.prevHash).toBe('0'.repeat(64));
    expect(b.prevHash).toBe(a.chainHash);
    expect(b.chainHash).toBe(chainHash(a.chainHash, b.digest));
    expect(verifyChain().valid).toBe(true);
  });

  it('detects a content edit inside the chain', () => {
    mk({ command: 'a' });
    mk({ command: 'b' });
    const chain = listReceipts({ limit: 10, includeProbes: true }).reverse();
    chain[0] = { ...chain[0], command: 'edited' };
    const result = verifyChain(chain);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(0);
  });

  it('detects a reordered link', () => {
    mk({ command: 'a' });
    mk({ command: 'b' });
    const chain = listReceipts({ limit: 10, includeProbes: true }).reverse();
    expect(verifyChain([chain[1], chain[0]]).valid).toBe(false);
  });

  it('detects end-truncation via an external anchor', () => {
    mk({ command: 'a' });
    mk({ command: 'b' });
    const anchor = anchorHead();
    expect(anchor.seq).toBe(1);
    const truncated = listReceipts({ limit: 10, includeProbes: true }).reverse().slice(0, 1);
    const result = verifyChain(truncated, anchor);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('anchor');
  });

  it('uses an HMAC key when configured', () => {
    vi.stubEnv('OPENHUB_RECEIPTS_HMAC_KEY', 'secret-key');
    const r = mk();
    expect(r.chainHash).toBe(chainHash('0'.repeat(64), r.digest, 'secret-key'));
    expect(verifyChain().valid).toBe(true);
  });
});

describe('receipts — context + filters', () => {
  it('tags receipts with the active run/scorer context', () => {
    const r = runWithReceipts({ runId: 'audit_1', scorer: 'typecheck', target: '/repo' }, () => mk());
    expect(r.runId).toBe('audit_1');
    expect(r.scorer).toBe('typecheck');
    expect(r.target).toBe('/repo');
    expect(listReceipts({ runId: 'audit_1' })).toHaveLength(1);
  });

  it('excludes probes by default and includes them on request', () => {
    recordCommandReceipt({
      command: 'node --version',
      tool: 'node',
      cwd: '/repo',
      status: 'passed',
      exitCode: 0,
      startedAt: Date.now(),
      durationMs: 5,
      output: 'v22',
      probe: true,
    });
    expect(listReceipts()).toHaveLength(0);
    expect(listReceipts({ includeProbes: true })).toHaveLength(1);
  });

  it('exposes the current chain head', () => {
    expect(chainHead()).toEqual({ seq: -1, chainHash: '0'.repeat(64) });
    mk();
    expect(chainHead().seq).toBe(0);
  });
});
