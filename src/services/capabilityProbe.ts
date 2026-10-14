import net from 'node:net';
import {
  FLEET_BRIDGES,
  type BridgeCapabilityStatement,
  type BridgeOperation,
} from './capabilityRegistry.js';
import { recordReceipt } from './receipts.js';
import { runLocalCommand } from './processRunner.js';

export type BridgeHealthStatus = 'online' | 'offline' | 'degraded';

export interface BridgeProbeResult {
  slug: string;
  name: string;
  category: string;
  status: BridgeHealthStatus;
  reason?: string;
  latencyMs: number;
  lastChecked: string;
  lastReceiptId?: string;
  version?: string;
  operations: BridgeOperation[];
  transport: string;
  endpoint?: string;
}

export interface FleetCapabilitiesSnapshot {
  probedAt: string;
  cached: boolean;
  ttlMs: number;
  summary: {
    total: number;
    online: number;
    degraded: number;
    offline: number;
  };
  bridges: BridgeProbeResult[];
}

const DEFAULT_CACHE_TTL_MS = 20_000;

interface CacheEntry {
  snapshot: FleetCapabilitiesSnapshot;
  expiresAt: number;
}

let probeCache: CacheEntry | null = null;

async function probeHttp(
  host: string,
  port: number,
  path: string,
  timeoutMs = 2500,
): Promise<{ ok: boolean; status: number; text: string }> {
  try {
    const url = `http://${host}:${port}${path}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text().catch(() => '');
    return { ok: res.status < 500, status: res.status, text: text.slice(0, 300) };
  } catch (err: any) {
    return { ok: false, status: 0, text: err.message || 'Connection failed' };
  }
}

function probeTcp(
  host: string,
  port: number,
  timeoutMs = 1500,
): Promise<{ ok: boolean; reason?: string }> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (ok: boolean, reason?: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, reason });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false, `TCP connection to ${host}:${port} timed out (${timeoutMs}ms)`));
    socket.once('error', (err) => finish(false, err.message));
    socket.connect(port, host);
  });
}

/**
 * Probe a single bridge declared in the capability registry.
 * Emits an evidence probe receipt for every check.
 */
export async function probeBridge(bridge: BridgeCapabilityStatement): Promise<BridgeProbeResult> {
  const startedAt = Date.now();
  const identity = bridge.identity;
  let status: BridgeHealthStatus = 'offline';
  let reason: string | undefined;
  let version: string | undefined;
  let output = '';

  if (identity.transport === 'http' && identity.host && identity.port) {
    const probePath = bridge.liveness.path || '/';
    const httpRes = await probeHttp(
      identity.host,
      identity.port,
      probePath,
      bridge.liveness.timeoutMs || 2500,
    );
    output = httpRes.text;
    if (httpRes.ok) {
      // 2xx/3xx = genuinely reachable and responding normally
      status = 'online';
      // Try extracting version if JSON
      try {
        const parsed = JSON.parse(httpRes.text);
        version = parsed.version || parsed.v;
      } catch {
        /* ignore */
      }
    } else if (httpRes.status >= 400 && httpRes.status < 500) {
      // 4xx = bridge rejected the probe (auth, not-found, etc.) — treat as offline
      // since traffic routing to it would fail (W7).
      status = 'offline';
      reason = `HTTP ${httpRes.status} — bridge rejected probe`;
    } else {
      // 5xx = bridge is reachable but erroring (degraded)
      status = httpRes.status >= 500 ? 'degraded' : 'offline';
      reason = httpRes.text || `HTTP ${httpRes.status}`;
    }
  } else if (identity.transport === 'tcp' && identity.host && identity.port) {
    const tcpRes = await probeTcp(
      identity.host,
      identity.port,
      bridge.liveness.timeoutMs || 1500,
    );
    if (tcpRes.ok) {
      status = 'online';
      output = `TCP ${identity.host}:${identity.port} open`;
    } else {
      status = 'offline';
      reason = tcpRes.reason || 'Port closed';
      output = reason;
    }
  } else if (identity.transport === 'cli' && identity.cliCommand) {
    const args = bridge.liveness.args || ['--version'];
    const run = await runLocalCommand(identity.cliCommand, args, {
      cwd: process.cwd(),
      timeoutMs: bridge.liveness.timeoutMs || 3000,
      probe: true,
      label: `probe:${identity.slug}`,
    });
    output = run.output;
    if (run.ok) {
      status = 'online';
      version = run.output.split('\n')[0]?.slice(0, 80);
    } else {
      status = 'offline';
      reason = run.output || `Process exited with ${run.code}`;
    }
  }

  const durationMs = Date.now() - startedAt;

  // Evidence spine: every probe is receipted
  let receiptId: string | undefined;
  try {
    const receipt = recordReceipt({
      kind: 'probe',
      command: `probe:${identity.slug} (${identity.transport})`,
      target: identity.slug,
      status: status === 'online' ? 'passed' : 'failed',
      durationMs,
      output: output || reason || '',
      meta: {
        bridge: identity.slug,
        category: identity.category,
        transport: identity.transport,
        port: identity.port,
      },
    });
    receiptId = receipt.id;
  } catch {
    /* receipts recording is best effort */
  }

  const endpoint =
    identity.transport === 'http' && identity.port
      ? `http://${identity.host || '127.0.0.1'}:${identity.port}${bridge.liveness.path || ''}`
      : identity.port
      ? `${identity.host || '127.0.0.1'}:${identity.port}`
      : identity.cliCommand;

  return {
    slug: identity.slug,
    name: identity.name,
    category: identity.category,
    status,
    reason,
    latencyMs: durationMs,
    lastChecked: new Date().toISOString(),
    lastReceiptId: receiptId,
    version,
    operations: bridge.operations,
    transport: identity.transport,
    endpoint,
  };
}

/**
 * Probe all fleet capability bridges, TTL cached.
 * Passing refresh=true bypasses the cache.
 */
export async function probeFleetCapabilities(options: {
  refresh?: boolean;
  ttlMs?: number;
} = {}): Promise<FleetCapabilitiesSnapshot> {
  const now = Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_CACHE_TTL_MS;

  if (!options.refresh && probeCache && probeCache.expiresAt > now) {
    return {
      ...probeCache.snapshot,
      cached: true,
    };
  }

  const bridges = Object.values(FLEET_BRIDGES);
  const results = await Promise.all(bridges.map((b) => probeBridge(b)));

  const summary = {
    total: results.length,
    online: results.filter((r) => r.status === 'online').length,
    degraded: results.filter((r) => r.status === 'degraded').length,
    offline: results.filter((r) => r.status === 'offline').length,
  };

  const snapshot: FleetCapabilitiesSnapshot = {
    probedAt: new Date().toISOString(),
    cached: false,
    ttlMs,
    summary,
    bridges: results,
  };

  probeCache = {
    snapshot,
    expiresAt: now + ttlMs,
  };

  return snapshot;
}

export function resetCapabilityProbeCache(): void {
  probeCache = null;
}
