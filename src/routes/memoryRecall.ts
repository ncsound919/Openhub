import { Router, type RequestHandler } from 'express';

/**
 * Memory recall proxy — the ONE read surface for the fleet's memory bridges.
 *
 * The phone's Sieve and Recourse deployments are only reachable through the
 * mobile-gateway Worker (`OPENHUB_MOBILE_GATEWAY_URL`), which holds their keys
 * server-side. This route fans a single query out to the requested sources and
 * reports each one honestly: an offline peer comes back `available: false` with
 * its reason instead of being silently dropped, so an empty hit list is never
 * mistaken for "nothing is known".
 *
 * Mounted at `/api`; every response carries `{ ok, query, results }`.
 */

export type MemoryRecallSource = 'sieve' | 'recourse';

const GATEWAY_TIMEOUT_MS = 15_000;
const MAX_QUERY_CHARS = 400;
const DEFAULT_TOP_K = 8;
const MAX_TOP_K = 50;

const SOURCES = ['sieve', 'recourse'] as const;

export interface MemoryRecallHit {
  id: string;
  text: string;
  score?: number | null;
  path?: string | null;
  line?: number | null;
  kind?: string | null;
  source?: string | null;
  layers?: string[];
}

export interface MemorySourceResult {
  source: MemoryRecallSource;
  available: boolean;
  endpoint: string;
  latencyMs: number;
  status?: number;
  hits: MemoryRecallHit[];
  layers?: Record<string, { available: boolean; count: number; reason?: string; mode?: string }>;
  reason?: string;
}

/** The gateway base, read per request so a test (or restart) can change it. */
function gatewayBase(): string | null {
  const raw = (process.env.OPENHUB_MOBILE_GATEWAY_URL || '').trim().replace(/\/+$/, '');
  return raw.length > 0 ? raw : null;
}

const ENDPOINTS: Record<MemoryRecallSource, string> = {
  sieve: '/v1/sieve/recall',
  recourse: '/v1/recourse/recall',
};

interface GatewayReply {
  status: number;
  data: Record<string, unknown> | null;
}

async function postGateway(base: string, path: string, body: unknown): Promise<GatewayReply> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
  });
  const text = await res.text().catch(() => '');
  let data: Record<string, unknown> | null = null;
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    data = { raw: text.slice(0, 400) };
  }
  return { status: res.status, data };
}

function asHits(value: unknown): MemoryRecallHit[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((h): h is Record<string, unknown> => h !== null && typeof h === 'object')
    .map((h) => ({
      id: String(h.id ?? ''),
      text: typeof h.text === 'string' ? h.text : '',
      score: typeof h.score === 'number' ? h.score : null,
      path: typeof h.path === 'string' ? h.path : null,
      line: typeof h.line === 'number' ? h.line : null,
      kind: typeof h.kind === 'string' ? h.kind : null,
      source: typeof h.source === 'string' ? h.source : null,
      layers: Array.isArray(h.layers) ? h.layers.map(String) : undefined,
    }))
    .filter((h) => h.id !== '' || h.text !== '');
}

function asLayers(
  value: unknown,
): Record<string, { available: boolean; count: number; reason?: string; mode?: string }> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, { available: boolean; count: number; reason?: string; mode?: string }> = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    const layer = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    out[name] = {
      available: layer.available !== false,
      count: Number.isFinite(Number(layer.count)) ? Number(layer.count) : 0,
      ...(typeof layer.reason === 'string' ? { reason: layer.reason } : {}),
      ...(typeof layer.mode === 'string' ? { mode: layer.mode } : {}),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

async function recallFrom(
  source: MemoryRecallSource,
  base: string,
  query: string,
  k: number,
): Promise<MemorySourceResult> {
  const endpoint = `${base}${ENDPOINTS[source]}`;
  const startedAt = Date.now();
  const body = source === 'sieve' ? { query, k, layers: 'all' } : { query, topK: k };

  try {
    const reply = await postGateway(base, ENDPOINTS[source], body);
    const data = reply.data;
    const latencyMs = Date.now() - startedAt;
    const baseResult = { source, endpoint, latencyMs, status: reply.status };

    if (reply.status >= 400 || !data) {
      const reason =
        (typeof data?.error === 'string' && data.error) ||
        `Gateway replied HTTP ${reply.status}`;
      return { ...baseResult, available: false, hits: [], reason };
    }
    if (data.available === false) {
      return {
        ...baseResult,
        available: false,
        hits: [],
        layers: asLayers(data.layers),
        reason: (typeof data.reason === 'string' && data.reason) || 'source reported unavailable',
      };
    }
    return {
      ...baseResult,
      available: true,
      hits: asHits(data.hits),
      layers: asLayers(data.layers),
    };
  } catch (err) {
    const reason =
      err instanceof Error ? err.message : 'memory bridge unreachable';
    return {
      source,
      endpoint,
      latencyMs: Date.now() - startedAt,
      available: false,
      hits: [],
      reason: `upstream unreachable: ${reason}`,
    };
  }
}

export function createMemoryRecallRouter(deps: { authMiddleware: RequestHandler }): Router {
  const router = Router();
  router.use(deps.authMiddleware);

  /**
   * POST /api/memory/recall
   * Body: { query, source?: 'sieve' | 'recourse' | 'both', k?: number }
   *
   * 400 for a malformed query, 503 when every requested source is offline
   * (results are still returned so the caller can show WHY).
   */
  router.post('/memory/recall', async (req, res) => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;

    const query = typeof body.query === 'string' ? body.query.trim() : '';
    if (!query) return res.status(400).json({ ok: false, error: 'query is required' });
    if (query.length > MAX_QUERY_CHARS) {
      return res
        .status(400)
        .json({ ok: false, error: `query must be at most ${MAX_QUERY_CHARS} characters` });
    }

    const rawSource = typeof body.source === 'string' ? body.source.toLowerCase() : 'both';
    if (rawSource !== 'both' && !(SOURCES as readonly string[]).includes(rawSource)) {
      return res.status(400).json({ ok: false, error: 'source must be sieve, recourse or both' });
    }

    const kRaw = Number(body.k ?? body.topK ?? DEFAULT_TOP_K);
    const k = Number.isFinite(kRaw)
      ? Math.min(MAX_TOP_K, Math.max(1, Math.trunc(kRaw)))
      : DEFAULT_TOP_K;

    const base = gatewayBase();
    if (!base) {
      return res.status(503).json({
        ok: false,
        error:
          'OPENHUB_MOBILE_GATEWAY_URL is not set — this server cannot reach the Sieve or Recourse mobile deployments.',
        query,
        k,
        gateway: null,
        results: {},
      });
    }

    const requested: MemoryRecallSource[] =
      rawSource === 'both' ? [...SOURCES] : [rawSource as MemoryRecallSource];

    try {
      const results = await Promise.all(requested.map((source) => recallFrom(source, base, query, k)));
      const ok = results.some((r) => r.available);
      res.status(ok ? 200 : 503).json({
        ok,
        query,
        k,
        gateway: base,
        requested,
        results: Object.fromEntries(results.map((r) => [r.source, r])),
        ...(ok ? {} : { error: 'Every requested memory bridge is offline — see each reason.' }),
        takenAt: new Date().toISOString(),
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : 'recall failed',
        query,
        k,
        gateway: base,
        results: {},
      });
    }
  });

  return router;
}