import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  FLEET_BRIDGES,
  getBridgeStatement,
  listBridgeStatements,
} from '../src/services/capabilityRegistry';
import {
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
