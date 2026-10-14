import crypto from 'crypto';
import { Router, type RequestHandler } from 'express';
import { getDb } from '../auth/db.js';
import { getAgentRoster, type AgentBackend } from '../services/agentRegistry.js';

/**
 * Research escalation: ask the configured research agents (AgentBrowser,
 * OmniResearch, BookBridge) a question. Reachability is probed per backend
 * and every query is persisted so the copilot research screen loads history.
 * Answers are never fabricated — a backend without a live endpoint reports
 * `reachable: false` with an explicit note.
 */

interface ResearchRow {
  id: string;
  query: string;
  result_json: string;
  created_at: string;
}

function ensureTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS research_queries (
      id TEXT PRIMARY KEY,
      query TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

const ASK_TIMEOUT_MS = 12_000;

/** Probe a backend's advertised endpoint (agent.json runtime) and health path. */
async function probeBackend(backend: AgentBackend): Promise<{ reachable: boolean; note: string; endpoint?: string }> {
  if (!backend.present) return { reachable: false, note: 'directory not on disk' };
  // The roster already read the manifest; re-read the agent.json for its runtime.
  let endpoint: string | null = null;
  let healthPath = '/api/health';
  try {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const agentJson = path.join(backend.path, 'agent.json');
    if (fs.existsSync(agentJson)) {
      const parsed = JSON.parse(fs.readFileSync(agentJson, 'utf8').replace(/^\uFEFF/, ''));
      endpoint = typeof parsed?.runtime?.endpoint === 'string' ? parsed.runtime.endpoint : null;
      if (typeof parsed?.runtime?.healthPath === 'string') healthPath = parsed.runtime.healthPath;
    }
  } catch { /* no agent.json */ }

  if (!endpoint) {
    return { reachable: false, note: 'no runtime.endpoint advertised (agent.json missing or no runtime)' };
  }
  try {
    const res = await fetch(`${endpoint.replace(/\/+$/, '')}${healthPath}`, {
      signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
    });
    return { reachable: res.ok, note: res.ok ? 'reachable' : `HTTP ${res.status}`, endpoint };
  } catch (err) {
    return { reachable: false, note: err instanceof Error ? err.message : 'unreachable', endpoint };
  }
}

export function createResearchRouter(deps: { authMiddleware: RequestHandler }): Router {
  const router = Router();
  router.use(deps.authMiddleware);

  router.post('/research/ask', async (req, res) => {
    const query = (req.body as { query?: unknown } | undefined)?.query;
    if (typeof query !== 'string' || query.trim() === '') {
      return res.status(400).json({ ok: false, error: 'query is required' });
    }
    ensureTable();
    const roster = getAgentRoster();
    const backends = await Promise.all(
      roster.research.map(async (b) => ({ name: b.name, slug: b.slug, ...(await probeBackend(b)) })),
    );
    const reachable = backends.filter((b) => b.reachable);
    const result = {
      ok: true,
      query: query.trim(),
      backends,
      answered: reachable.length > 0,
      note: reachable.length
        ? `${reachable.length} research engine${reachable.length === 1 ? '' : 's'} reachable.`
        : 'No research engine reachable — AgentBrowser/OmniResearch/BookBridge are offline or lack a runtime endpoint.',
    };
    const id = crypto.randomUUID();
    getDb().prepare('INSERT INTO research_queries (id, query, result_json, created_at) VALUES (?, ?, ?, ?)')
      .run(id, query.trim(), JSON.stringify(result), new Date().toISOString());
    res.json(result);
  });

  router.get('/research/queries', (_req, res) => {
    ensureTable();
    const rows = getDb().prepare('SELECT * FROM research_queries ORDER BY created_at DESC LIMIT 50').all() as unknown as ResearchRow[];
    res.json({
      ok: true,
      queries: rows.map((r) => {
        let result: unknown = null;
        try { result = JSON.parse(r.result_json); } catch { /* corrupt row */ }
        return { id: r.id, query: r.query, result, createdAt: r.created_at };
      }),
    });
  });

  return router;
}
