import { describe, it, expect, beforeEach, vi } from 'vitest';
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

// The Jarvis bridge is the fleet's only CLI-transported service, and it is that
// way for a reason worth pinning down: Jarvis's own server port is held by an
// unrelated process on this host, so an HTTP liveness probe would return 200
// for the wrong service. These assertions make "probe it over HTTP instead"
// fail rather than quietly reintroducing the false positive.
describe('Capability Registry (jarvis bridge)', () => {
  const jarvis = () => getBridgeStatement('jarvis')!;

  it('is declared as a core, CLI-transported bridge', () => {
    expect(jarvis()).toBeDefined();
    expect(jarvis().identity.slug).toBe('jarvis');
    expect(jarvis().identity.category).toBe('core');
    expect(jarvis().identity.transport).toBe('cli');
  });

  it('never probes an HTTP port, because none of them is Jarvis', () => {
    // No port and no host: probeBridge's HTTP arm requires both, so this bridge
    // physically cannot answer for another listener.
    expect(jarvis().identity.port).toBeUndefined();
    expect(jarvis().identity.host).toBeUndefined();
    expect(jarvis().liveness.type).toBe('cli');
    expect(jarvis().liveness.path).toBeUndefined();
    expect(jarvis().versionSpec.type).toBe('cli');
  });

  it('points at a real interpreter and imports the package in liveness', () => {
    expect(jarvis().identity.cliCommand).toMatch(/python\.exe$/);
    expect(jarvis().liveness.args).toEqual(['-c', 'import openjarvis;print(openjarvis.__version__)']);
    // The timeout has to exceed the measured ~15s that the full CLI console
    // script takes; `import openjarvis` is ~0.3s, so 15s is generous headroom
    // that still fails fast on a broken venv.
    expect(jarvis().liveness.timeoutMs).toBeGreaterThanOrEqual(15_000);
  });

  it('honours OPENHUB_JARVIS_PYTHON before the baked-in default', async () => {
    // FLEET_BRIDGES is a module-level const, so the override is only visible
    // through a fresh module instance. Without resetModules this test would
    // read the already-evaluated default and pass for the wrong reason.
    const prev = process.env.OPENHUB_JARVIS_PYTHON;
    process.env.OPENHUB_JARVIS_PYTHON = 'C:/elsewhere/python.exe';
    try {
      vi.resetModules();
      const reloaded = await import('../src/services/capabilityRegistry');
      expect(reloaded.getBridgeStatement('jarvis')?.identity.cliCommand).toBe('C:/elsewhere/python.exe');
    } finally {
      vi.resetModules();
      if (prev === undefined) delete process.env.OPENHUB_JARVIS_PYTHON;
      else process.env.OPENHUB_JARVIS_PYTHON = prev;
    }
  });

  it('declares the OpenHub round-trip as an operation', () => {
    const ids = jarvis().operations.map((o) => o.id);
    expect(ids).toContain('agent.ask');
    expect(ids).toContain('doctor.check');
    expect(ids).toContain('speech.synthesize');
    expect(ids).toContain('tool.openhub');
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
