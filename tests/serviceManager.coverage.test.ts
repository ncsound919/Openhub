import { afterEach, describe, expect, it, vi } from 'vitest';
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  MANAGED_SERVICES,
  buildServiceEnv,
  getAllServicesStatus,
  getListeningPid,
  getServiceStatus,
  isPortListening,
  isProtectedPort,
  probeHttp,
  startServiceSafe,
  stopServiceSafe,
  type ManagedServiceConfig,
} from '../src/services/serviceManager';

const INJECTED: string[] = [];
const tmpDirs: string[] = [];

function inject(slug: string, config: Partial<ManagedServiceConfig> & { port: number }): ManagedServiceConfig {
  const full: ManagedServiceConfig = {
    slug,
    name: `Test ${slug}`,
    healthPath: '/health',
    cwd: config.cwd ?? process.cwd(),
    command: 'node',
    args: ['-e', ''],
    category: 'core',
    ...config,
  };
  MANAGED_SERVICES[slug] = full;
  INJECTED.push(slug);
  return full;
}

async function listenOnEphemeral(): Promise<{ server: net.Server; port: number }> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as net.AddressInfo;
  return { server, port: address.port };
}

afterEach(() => {
  for (const slug of INJECTED.splice(0)) delete MANAGED_SERVICES[slug];
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      /* best-effort */
    }
  }
  vi.unstubAllGlobals();
});

describe('serviceManager coverage', () => {
  it('classifies protected control-plane / auth ports only', () => {
    expect(isProtectedPort(3000)).toBe(true);
    expect(isProtectedPort(3010)).toBe(true);
    expect(isProtectedPort(3198)).toBe(false);
    expect(isProtectedPort(59999)).toBe(false);
  });

  it('pins the catalog PORT and lets per-service env win last', () => {
    const withEnv = buildServiceEnv(MANAGED_SERVICES['claw-protect'], { PORT: '3010', PATH: '/bin' });
    expect(withEnv.PORT).toBe('3300');
    expect(withEnv.CLAW_PORT).toBe('3300');

    const noEnv = buildServiceEnv(MANAGED_SERVICES.grader, { PORT: '9999' });
    expect(noEnv.PORT).toBe('3201');
    expect(noEnv).not.toHaveProperty('CLAW_PORT');
  });

  it('reports a free high port as not listening', async () => {
    expect(await isPortListening(59999)).toBe(false);
  });

  it('reports a bound port as listening and resolves its owning pid', async () => {
    const { server, port } = await listenOnEphemeral();
    try {
      expect(await isPortListening(port)).toBe(true);
      expect(await isPortListening(port, '127.0.0.1', 100)).toBe(true);
      const pid = getListeningPid(port);
      expect(pid === null || pid > 0).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(getListeningPid(59999)).toBeNull();
  }, 60_000);

  it('probeHttp treats <500 as healthy and any throw as down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    expect(await probeHttp(1234, '/health')).toBe(true);

    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503 })));
    expect(await probeHttp(1234, '/health')).toBe(false);

    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }));
    expect(await probeHttp(1234, '/health')).toBe(false);
  });

  it('returns null for an unknown service and a full status for a known one', async () => {
    expect(await getServiceStatus('does-not-exist')).toBeNull();
    const axiom = await getServiceStatus('axiom');
    expect(axiom).not.toBeNull();
    expect(axiom!.slug).toBe('axiom');
    expect(axiom!.port).toBe(3198);
    expect(typeof axiom!.up).toBe('boolean');
    // Not listening → pid stays null even when requested.
    expect(axiom!.pid).toBeNull();
    expect(await getServiceStatus('axiom', true)).not.toBeNull();
  });

  it('reports a probe service as up with a resolved pid when included', async () => {
    const { server, port } = await listenOnEphemeral();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhub-sm-status-'));
    tmpDirs.push(dir);
    inject('probe-tmp', { port, healthPath: '/', cwd: dir });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    try {
      const status = await getServiceStatus('probe-tmp', true);
      expect(status).not.toBeNull();
      expect(status!.up).toBe(true);
      expect(status!.pid === null || status!.pid > 0).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 60_000);

  it('aggregates every catalog service', async () => {
    const statuses = await getAllServicesStatus();
    expect(statuses).toHaveLength(Object.keys(MANAGED_SERVICES).length);
    expect(statuses.every((s) => typeof s.slug === 'string')).toBe(true);
  });

  it('stopServiceSafe rejects unknown slugs and refuses protected ports', async () => {
    const unknown = await stopServiceSafe('nope-nope');
    expect(unknown.ok).toBe(false);
    expect(unknown.message).toContain('Unknown service');

    inject('protected-tmp', { port: 3010 });
    const guarded = await stopServiceSafe('protected-tmp');
    expect(guarded.ok).toBe(false);
    expect(guarded.message).toContain('protected');
  });

  it('stopServiceSafe is a no-op for a service that is already stopped', async () => {
    inject('idle-tmp', { port: 59998 });
    const result = await stopServiceSafe('idle-tmp');
    expect(result.ok).toBe(true);
    expect(result.message).toContain('already stopped');
  }, 60_000);

  it('startServiceSafe rejects unknown slugs and missing directories', async () => {
    const unknown = await startServiceSafe('nope-nope');
    expect(unknown.ok).toBe(false);
    expect(unknown.message).toContain('Unknown service');

    const missing = path.join(os.tmpdir(), `openhub-missing-${Date.now()}-${Math.random()}`);
    inject('nodir-tmp', { port: 59997, cwd: missing });
    const result = await startServiceSafe('nodir-tmp');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Directory not found');
  }, 60_000);

  it('startServiceSafe reports an already-running service without spawning', async () => {
    const { server, port } = await listenOnEphemeral();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openhub-sm-running-'));
    tmpDirs.push(dir);
    inject('running-tmp', { port, healthPath: '/', cwd: dir });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    try {
      const result = await startServiceSafe('running-tmp');
      expect(result.ok).toBe(true);
      expect(result.message).toContain('already running');
      expect(result.status?.slug).toBe('running-tmp');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 60_000);
});
