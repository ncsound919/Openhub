import { describe, it, expect, beforeEach } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import {
  FLEET_BRIDGES,
  getBridgeStatement,
  listBridgeStatements,
} from '../src/services/capabilityRegistry';
import {
  probeBridge,
  probeFleetCapabilities,
  resetCapabilityProbeCache,
} from '../src/services/capabilityProbe';
import { createFleetCapabilitiesRouter } from '../src/routes/fleetCapabilities';
import { clearReceipts, listReceipts } from '../src/services/receipts';

describe('Capability Registry (C1)', () => {
  it('registers all known fleet bridges with typed capability statements', () => {
    const list = listBridgeStatements();
    expect(list.length).toBeGreaterThanOrEqual(12);

    const axiom = getBridgeStatement('axiom');
    expect(axiom).toBeDefined();
    expect(axiom?.identity.slug).toBe('axiom');
    expect(axiom?.identity.category).toBe('core');
    expect(axiom?.identity.port).toBe(3198);
    expect(axiom?.operations.map((o) => o.id)).toContain('mission.run');
    expect(axiom?.operations.map((o) => o.id)).toContain('composer.edit');

    const grader = getBridgeStatement('grader');
    expect(grader?.liveness.path).toBe('/api/healthz');
    expect(grader?.readiness.path).toBe('/api/readyz');

    const redis = getBridgeStatement('redis');
    expect(redis?.identity.transport).toBe('tcp');
    expect(redis?.identity.port).toBe(6379);

    const sieve = getBridgeStatement('sieve');
    expect(sieve?.identity.category).toBe('memory');
    expect(sieve?.liveness.path).toBe('/v1/sieve/health');
    expect(sieve?.operations.map((o) => o.id)).toContain('code.recall');
    expect(getBridgeStatement('recourse-mobile')?.liveness.path).toBe('/v1/recourse/health');
  });
});

describe('Capability Probing & Evidence (C2)', () => {
  beforeEach(() => {
    resetCapabilityProbeCache();
    clearReceipts();
  });

  it('probes declared bridges and emits probe receipts', async () => {
    const snapshot = await probeFleetCapabilities({ refresh: true });
    expect(snapshot.summary.total).toBe(Object.keys(FLEET_BRIDGES).length);
    expect(snapshot.bridges.length).toBe(snapshot.summary.total);

    // Each probe emits an evidence receipt (kind: 'probe')
    const probeReceipts = listReceipts({ includeProbes: true, kind: 'probe' });
    expect(probeReceipts.length).toBeGreaterThanOrEqual(snapshot.summary.total);

    // Honest reporting: offline bridges are reported with reason, never fabricated up
    const offlineBridges = snapshot.bridges.filter((b) => b.status === 'offline');
    for (const b of offlineBridges) {
      expect(b.reason).toBeDefined();
      expect(b.lastReceiptId).toBeDefined();
    }
  });

  it('serves cached snapshot when within TTL', async () => {
    const first = await probeFleetCapabilities({ refresh: true });
    expect(first.cached).toBe(false);

    const second = await probeFleetCapabilities({ refresh: false });
    expect(second.cached).toBe(true);
    expect(second.probedAt).toBe(first.probedAt);
  });

  it('probes a bridge declared by baseUrl instead of host:port', async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: '1.2.3' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const result = await probeBridge({
        identity: {
          slug: 'edge-test',
          name: 'Edge Test',
          category: 'memory',
          transport: 'http',
          baseUrl: `http://127.0.0.1:${port}`,
        },
        versionSpec: { type: 'http', endpointOrArgs: '/health' },
        liveness: { type: 'http', path: '/v1/app/health', timeoutMs: 2000 },
        readiness: { type: 'http', path: '/v1/app/health', timeoutMs: 2000 },
        operations: [],
      });
      expect(result.status).toBe('online');
      expect(result.version).toBe('1.2.3');
      expect(result.endpoint).toBe(`http://127.0.0.1:${port}/v1/app/health`);
      expect(seen).toEqual(['/v1/app/health']);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('Fleet Capabilities Router (C2)', () => {
  beforeEach(() => {
    resetCapabilityProbeCache();
  });

  function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/api', createFleetCapabilitiesRouter({ authMiddleware: (_req, _res, next) => next() }));
    return app;
  }

  it('GET /api/fleet/capabilities returns probe snapshot', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/fleet/capabilities');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.summary.total).toBeGreaterThan(0);
    expect(Array.isArray(res.body.bridges)).toBe(true);
  });

  it('GET /api/fleet/capabilities/catalog returns read-only declarations', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/fleet/capabilities/catalog');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.bridges.length).toBeGreaterThanOrEqual(12);
  });
});
