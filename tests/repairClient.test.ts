import { describe, it, expect, afterEach } from 'vitest';
import { triggerRepairTriage } from '../src/services/repairClient.js';

const prevFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = prevFetch;
});

function stubJson(body: unknown, status = 200): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
}

describe('triggerRepairTriage', () => {
  it('passes a successful triage through', async () => {
    stubJson({ ok: true, id: 'triage-1' });
    const r = await triggerRepairTriage({ signal: 's', detail: 'd' });
    expect(r.ok).toBe(true);
  });

  it('normalizes a 200 without ok:true into a real error (never error-less)', async () => {
    stubJson({ ok: false });
    const r = await triggerRepairTriage({ signal: 's', detail: 'd' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/declined/);
  });

  it('normalizes an empty object body', async () => {
    stubJson({});
    const r = await triggerRepairTriage({ signal: 's', detail: 'd' });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('reports an unreachable Draymond with the URL', async () => {
    globalThis.fetch = (async () => {
      throw new Error('fetch failed');
    }) as unknown as typeof fetch;
    const r = await triggerRepairTriage({ signal: 's', detail: 'd' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unreachable/);
  });
});
