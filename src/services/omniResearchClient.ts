/**
 * OmniResearch client — full capability surface for OpenHub.
 *
 * Omni (:3012) exposes ~49 HTTP routes + MCP. This client covers the
 * operations OpenHub/Axiom actually invoke (research, harvest, DAG, marketing,
 * ecosystem bridge, LLM, baseline sources). Every call is fail-soft:
 * `{ available:false, error }` when Omni is down — never fabricated state.
 */

export function omniBaseUrl(): string {
  return (process.env.OMNI_RESEARCH_URL || 'http://127.0.0.1:3012').replace(/\/+$/, '');
}

export interface OmniResult<T = any> {
  available: boolean;
  status?: number;
  data?: T;
  error?: string;
}

/** Machine-readable catalog of Omni capabilities (for UI / copilot / fleet). */
export const OMNI_CAPABILITIES = [
  { id: 'health', name: 'Health & ecosystem backends', method: 'GET', path: '/api/health', kind: 'query' },
  { id: 'llm.research', name: 'LiteLLM research synthesis', method: 'POST', path: '/api/llm/research', kind: 'mutation' },
  { id: 'research.deep', name: 'Deep deterministic research', method: 'POST', path: '/api/agent/deep-deterministic-research', kind: 'mutation' },
  { id: 'research.intel', name: 'Deterministic intel dossier', method: 'POST', path: '/api/agent/deterministic-intel', kind: 'mutation' },
  { id: 'research.autonomous', name: 'Autonomous research loop', method: 'POST', path: '/api/research/autonomous-loop', kind: 'mutation' },
  { id: 'harvest.multi', name: 'ArXiv+OpenAlex+Wikipedia+PubMed harvest', method: 'POST', path: '/api/integrations/multi-harvest', kind: 'query' },
  { id: 'harvest.arxiv', name: 'ArXiv search', method: 'POST', path: '/api/integrations/arxiv', kind: 'query' },
  { id: 'harvest.openalex', name: 'OpenAlex search', method: 'POST', path: '/api/integrations/openalex', kind: 'query' },
  { id: 'harvest.wikipedia', name: 'Wikipedia search', method: 'POST', path: '/api/integrations/wikipedia', kind: 'query' },
  { id: 'harvest.pubmed', name: 'PubMed search', method: 'POST', path: '/api/integrations/pubmed', kind: 'query' },
  { id: 'browser.scrape', name: 'Page scrape', method: 'POST', path: '/api/browser/scrape', kind: 'query' },
  { id: 'dag.plan', name: 'Big-10 DAG plan', method: 'POST', path: '/api/agent/big10/plan-dag', kind: 'mutation' },
  { id: 'dag.execute', name: 'Big-10 DAG execute', method: 'POST', path: '/api/agent/big10/execute-dag', kind: 'mutation' },
  { id: 'subagents.list', name: 'Deterministic subagents', method: 'GET', path: '/api/agent/subagents/list', kind: 'query' },
  { id: 'subagents.step', name: 'Execute subagent step', method: 'POST', path: '/api/agent/subagents/execute-step', kind: 'mutation' },
  { id: 'baseline.sources', name: 'Baseline source registry', method: 'GET', path: '/api/agent/baseline-sources', kind: 'query' },
  { id: 'llama.health', name: 'Local model lane health', method: 'GET', path: '/api/llama/health', kind: 'query' },
  { id: 'llama.generate', name: 'Local model generate', method: 'POST', path: '/api/llama/generate', kind: 'mutation' },
  { id: 'jev.decision', name: 'JEV decision + Dev-Brain advisory', method: 'POST', path: '/api/gateway/jev-decision', kind: 'mutation' },
  { id: 'marketing.competitive', name: 'Competitive brief', method: 'POST', path: '/api/marketing/competitive-brief', kind: 'mutation' },
  { id: 'marketing.campaign', name: 'Campaign plan', method: 'POST', path: '/api/marketing/campaign-plan', kind: 'mutation' },
  { id: 'marketing.brand', name: 'Brand review', method: 'POST', path: '/api/marketing/brand-review', kind: 'mutation' },
  { id: 'marketing.outreach', name: 'Outreach sequence', method: 'POST', path: '/api/marketing/outreach-sequence', kind: 'mutation' },
  { id: 'marketing.multiplier', name: 'Content multiplier', method: 'POST', path: '/api/marketing/content-multiplier', kind: 'mutation' },
  { id: 'marketing.lead', name: 'Lead magnet', method: 'POST', path: '/api/marketing/lead-magnet', kind: 'mutation' },
  { id: 'synergy.analyze', name: 'Synergy analysis', method: 'POST', path: '/api/synergy/analyze', kind: 'mutation' },
  { id: 'comparison.benchmark', name: 'Comparison benchmark', method: 'POST', path: '/api/comparison/benchmark', kind: 'mutation' },
  { id: 'pipeline.unified', name: 'Unified research+media pipeline', method: 'POST', path: '/api/pipeline/unified-research-media', kind: 'mutation' },
  { id: 'analytics.suite', name: 'Analytics presentation suite', method: 'POST', path: '/api/analytics/generate-suite', kind: 'mutation' },
  { id: 'notebook.video', name: 'NotebookLM storyboard', method: 'POST', path: '/api/notebooklm/generate-video', kind: 'mutation' },
  { id: 'notebook.picture', name: 'NotebookLM picture', method: 'POST', path: '/api/notebooklm/generate-picture', kind: 'mutation' },
  { id: 'ecosystem.status', name: 'Ecosystem pillar status', method: 'GET', path: '/api/ecosystem/status', kind: 'query' },
  { id: 'ecosystem.report', name: 'Report failure to OpenHub', method: 'POST', path: '/api/ecosystem/report', kind: 'mutation' },
  { id: 'ecosystem.axiom-repair', name: 'Dispatch Axiom repair', method: 'POST', path: '/api/ecosystem/axiom-repair', kind: 'mutation' },
  { id: 'ecosystem.axiom-exemplars', name: 'Axiom prior-art exemplars', method: 'GET', path: '/api/ecosystem/axiom-exemplars', kind: 'query' },
  { id: 'mcp.tools', name: 'MCP tools/list + tools/call', method: 'POST', path: '/api/mcp', kind: 'mutation' },
  { id: 'mcp.manifest', name: 'MCP client manifest', method: 'GET', path: '/api/mcp/manifest', kind: 'query' },
] as const;

export type OmniCapabilityId = (typeof OMNI_CAPABILITIES)[number]['id'];

async function omniFetch<T = any>(
  path: string,
  opts: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<OmniResult<T>> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${omniBaseUrl()}${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      signal: ctrl.signal,
    });
    const data = (await res.json().catch(() => null)) as T;
    if (!res.ok) {
      const msg =
        (data as any)?.error ||
        (data as any)?.message ||
        `HTTP ${res.status}`;
      return { available: false, status: res.status, data, error: String(msg) };
    }
    return { available: true, status: res.status, data };
  } catch (err) {
    const aborted = err instanceof Error && (err.name === 'AbortError' || /abort/i.test(err.message));
    return {
      available: false,
      error: aborted
        ? `timed out after ${Math.round(timeoutMs / 1000)}s — OmniResearch did not answer`
        : err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function omniHealth(): Promise<OmniResult> {
  return omniFetch('/api/health', { timeoutMs: 4000 });
}

/** Catalog of every wired Omni capability (id, method, path). */
export async function omniCapabilities(): Promise<OmniResult> {
  const health = await omniHealth();
  return {
    available: health.available,
    status: health.status,
    data: {
      baseUrl: omniBaseUrl(),
      mcp: `${omniBaseUrl()}/api/mcp`,
      capabilities: OMNI_CAPABILITIES,
      backends: (health.data as any)?.backends ?? null,
      error: health.error,
    },
    error: health.error,
  };
}

/** LiteLLM one-shot research prompt (JSON or text). */
export async function omniLlmResearch(prompt: string, temperature?: number): Promise<OmniResult> {
  if (!prompt?.trim()) return { available: false, error: 'prompt is required' };
  return omniFetch('/api/llm/research', {
    method: 'POST',
    body: { prompt, ...(typeof temperature === 'number' ? { temperature } : {}) },
    timeoutMs: 120_000,
  });
}

/** Deep deterministic research dossier. */
export async function omniDeepResearch(input: {
  query: string;
  domain: string;
  skill?: string;
  targetUrls?: string[];
}): Promise<OmniResult> {
  if (!input?.query || !input?.domain) {
    return { available: false, error: 'query and domain are required' };
  }
  return omniFetch('/api/agent/deep-deterministic-research', {
    method: 'POST',
    body: input,
    timeoutMs: 180_000,
  });
}

/** Free multi-source harvest (ArXiv, OpenAlex, Wikipedia, PubMed). */
export async function omniMultiHarvest(query: string, maxPerSource = 5): Promise<OmniResult> {
  if (!query?.trim()) return { available: false, error: 'query is required' };
  return omniFetch('/api/integrations/multi-harvest', {
    method: 'POST',
    body: { query: query.trim(), maxPerSource },
    timeoutMs: 30_000,
  });
}

/** Autonomous research loop (lightweight topic convergence). */
export async function omniAutonomousLoop(
  topic: string,
  opts: { sector?: string; maxIterations?: number } = {},
): Promise<OmniResult> {
  if (!topic?.trim()) return { available: false, error: 'topic is required' };
  return omniFetch('/api/research/autonomous-loop', {
    method: 'POST',
    body: {
      topic: topic.trim(),
      ...(opts.sector ? { sector: opts.sector } : {}),
      maxIterations: opts.maxIterations ?? 1,
    },
    timeoutMs: 180_000,
  });
}

export async function omniBaselineSources(query?: {
  category?: string;
  sector?: string;
  query?: string;
  minAuthority?: number;
}): Promise<OmniResult> {
  const qs = new URLSearchParams();
  if (query?.category) qs.set('category', query.category);
  if (query?.sector) qs.set('sector', query.sector);
  if (query?.query) qs.set('query', query.query);
  if (query?.minAuthority !== undefined) qs.set('minAuthority', String(query.minAuthority));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return omniFetch(`/api/agent/baseline-sources${suffix}`);
}

export async function omniJevDecision(input: {
  domain?: string;
  riskPenaltyLambda?: number;
}): Promise<OmniResult> {
  return omniFetch('/api/gateway/jev-decision', {
    method: 'POST',
    body: input ?? {},
    timeoutMs: 25_000,
  });
}

export async function omniMarketing(
  kind: 'competitive-brief' | 'campaign-plan' | 'brand-review' | 'outreach-sequence' | 'content-multiplier' | 'lead-magnet',
  body: Record<string, unknown>,
): Promise<OmniResult> {
  return omniFetch(`/api/marketing/${kind}`, {
    method: 'POST',
    body,
    timeoutMs: 120_000,
  });
}

export async function omniMcpCall(name: string, args: Record<string, unknown> = {}): Promise<OmniResult> {
  return omniFetch('/api/mcp', {
    method: 'POST',
    body: { jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } },
    timeoutMs: 120_000,
  });
}

export async function omniMcpToolsList(): Promise<OmniResult> {
  return omniFetch('/api/mcp', {
    method: 'POST',
    body: { jsonrpc: '2.0', id: Date.now(), method: 'tools/list', params: {} },
    timeoutMs: 8000,
  });
}

export async function omniEcosystemStatus(): Promise<OmniResult> {
  return omniFetch('/api/ecosystem/status');
}

export async function omniAxiomExemplars(goal: string, max = 5): Promise<OmniResult> {
  if (!goal?.trim()) return { available: false, error: 'goal is required' };
  return omniFetch(`/api/ecosystem/axiom-exemplars?goal=${encodeURIComponent(goal)}&max=${max}`, {
    timeoutMs: 8000,
  });
}

/** Generic operation runner used by the proxy router. */
export async function omniInvoke(
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 120_000,
): Promise<OmniResult> {
  const m = method.toUpperCase();
  if (m === 'GET') return omniFetch(path, { timeoutMs: Math.min(timeoutMs, 15_000) });
  return omniFetch(path, { method: 'POST', body: body ?? {}, timeoutMs });
}
