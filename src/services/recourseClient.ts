/**
 * Recourse client — the self-developing architectural OS on this node.
 * OpenHub integrates Recourse's self-learning memory, synergy mapping, and
 * self-healing repair into Axiom's long-running coding loop. All calls are
 * best-effort with a short timeout; when Recourse is offline every function
 * returns an explicit `available: false` rather than fabricating state.
 */

/** Resolve the Recourse base URL per call so env overrides (and tests) always
 *  apply, even after this module was first imported. */
export function recourseBaseUrl(): string {
  return (process.env.RECOURSE_URL || 'http://localhost:3050').replace(/\/+$/, '');
}

function recourseSecret(): string {
  return process.env.RECOURSE_API_SECRET || '';
}

export interface RecourseResult<T = any> {
  available: boolean;
  status?: number;
  data?: T;
  error?: string;
}

async function recourseFetch<T = any>(
  path: string,
  opts: { method?: string; body?: unknown; guarded?: boolean } = {},
): Promise<RecourseResult<T>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const base = recourseBaseUrl();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (opts.guarded) {
      const secret = recourseSecret();
      if (!secret) {
        return { available: false, error: 'RECOURSE_API_SECRET not set — guarded Recourse write is fail-closed' };
      }
      headers['Authorization'] = `Bearer ${secret}`;
    }
    const res = await fetch(`${base}${path}`, {
      method: opts.method ?? 'GET',
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      signal: ctrl.signal,
    });
    const data = (await res.json().catch(() => null)) as T;
    return { available: res.ok, status: res.status, data };
  } catch (err) {
    return { available: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Live system status (learner, dreaming, autonomy, repair). */
export async function recourseStatus(): Promise<RecourseResult> {
  return recourseFetch('/api/recourse/status');
}

/** Cross-domain synergy map: how domains/components reinforce each other. */
export async function recourseSynergyMap(): Promise<RecourseResult> {
  return recourseFetch('/api/recourse/synergy/map');
}

export interface SynergyEdgeView { from?: string; to?: string; weight?: number; kind?: string }
export interface SynergyCandidateView { domain?: string; method?: string; reason?: string; score?: number }
export interface SynergyMapView {
  domains: string[];
  edges: SynergyEdgeView[];
  candidates: SynergyCandidateView[];
  generatedAtRun?: number;
  manifestHash?: string;
}

/**
 * Normalize the synergy map. Recourse nests the payload as
 * `{ success, map: { domains, edges, candidates, ... } }` — reading top-level
 * `domains` (the previous assumption) always yielded empty. Tolerates both.
 */
export function normalizeSynergyMap(data: unknown): SynergyMapView {
  const empty: SynergyMapView = { domains: [], edges: [], candidates: [] };
  if (!data || typeof data !== 'object') return empty;
  const outer = data as Record<string, unknown>;
  const map = (outer.map && typeof outer.map === 'object' ? outer.map : outer) as Record<string, unknown>;
  const domains = Array.isArray(map.domains) ? (map.domains as unknown[]).map(String).filter(Boolean) : [];
  const edges = Array.isArray(map.edges) ? (map.edges as SynergyEdgeView[]) : [];
  const candidates = Array.isArray(map.candidates) ? (map.candidates as SynergyCandidateView[]) : [];
  return {
    domains,
    edges,
    candidates,
    ...(typeof map.generatedAtRun === 'number' ? { generatedAtRun: map.generatedAtRun } : {}),
    ...(typeof map.manifestHash === 'string' ? { manifestHash: map.manifestHash } : {}),
  };
}

export interface AgendaNextItem { title: string; rationale?: string; status?: string }
export interface AgendaNextView { math?: AgendaNextItem; oncology?: AgendaNextItem }

/**
 * Normalize `/agenda/next`. Recourse returns `{ nextMath, nextOncology }`, each
 * a `{ milestone, statusReport, rationale }` record (nullable). The previous
 * consumer guessed at flat `title`/`item` fields and never resolved a label.
 */
export function normalizeAgendaNext(data: unknown): AgendaNextView {
  if (!data || typeof data !== 'object') return {};
  const toItem = (raw: unknown): AgendaNextItem | undefined => {
    if (!raw || typeof raw !== 'object') return undefined;
    const n = raw as Record<string, unknown>;
    const milestone = n.milestone;
    const title =
      typeof milestone === 'string' ? milestone
        : milestone && typeof milestone === 'object'
          ? String((milestone as Record<string, unknown>).id ?? (milestone as Record<string, unknown>).title ?? (milestone as Record<string, unknown>).name ?? '')
          : '';
    const rationale = typeof n.rationale === 'string' ? n.rationale : undefined;
    const statusReport = n.statusReport && typeof n.statusReport === 'object' ? (n.statusReport as Record<string, unknown>) : null;
    const status = statusReport && typeof statusReport.status === 'string' ? statusReport.status
      : statusReport && typeof statusReport.state === 'string' ? statusReport.state : undefined;
    if (!title && !rationale) return undefined;
    return {
      title: title || 'next milestone',
      ...(rationale ? { rationale } : {}),
      ...(status ? { status } : {}),
    };
  };
  const math = toItem((data as Record<string, unknown>).nextMath);
  const oncology = toItem((data as Record<string, unknown>).nextOncology);
  return { ...(math ? { math } : {}), ...(oncology ? { oncology } : {}) };
}

/** Semantic recall from Recourse's self-learning memory.
 *
 *  Recourse's route reads the query from `q` (not `query`) and accepts an
 *  optional `kind` filter (`gene|lesson|hypothesis|signal|snapshot`) plus a
 *  `topK` cap. Results arrive as `{ success, query, hits: [{id,kind,text,score}] }`. */
export async function recourseMemoryRecall(
  query: string,
  opts: { kind?: string; topK?: number } = {},
): Promise<RecourseResult> {
  const params = new URLSearchParams({ q: query });
  if (opts.kind) params.set('kind', opts.kind);
  if (opts.topK) params.set('topK', String(opts.topK));
  return recourseFetch(`/api/recourse/memory/recall?${params.toString()}`);
}

/** Normalize a Recourse memory-recall response into a flat hit list.
 *  Best-effort and shape-tolerant: unknown shapes yield `[]` (never invented). */
export function normalizeRecallHits(data: unknown): Array<{ id?: string; kind?: string; text: string; score?: number }> {
  if (!data || typeof data !== 'object') return [];
  const obj = data as Record<string, unknown>;
  const raw = Array.isArray(obj.hits) ? obj.hits
    : Array.isArray(obj.results) ? obj.results
    : Array.isArray(obj.matches) ? obj.matches
    : Array.isArray(data) ? data
    : [];
  const out: Array<{ id?: string; kind?: string; text: string; score?: number }> = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const h = item as Record<string, unknown>;
    const text = typeof h.text === 'string' ? h.text
      : typeof h.content === 'string' ? h.content
      : typeof h.summary === 'string' ? h.summary
      : '';
    if (!text) continue;
    out.push({
      ...(typeof h.id === 'string' ? { id: h.id } : {}),
      ...(typeof h.kind === 'string' ? { kind: h.kind } : {}),
      text,
      ...(typeof h.score === 'number' && Number.isFinite(h.score) ? { score: h.score } : {}),
    });
  }
  return out;
}

/** Feed an outcome back into Recourse's memory so it self-learns.
 *
 *  Recourse's built-in `/memory/index` route re-indexes its own registry and
 *  ignores the request body, so external agent outcomes are written through the
 *  fleet-memory intake instead — the payload is not silently discarded. If the
 *  intake route is absent (older Recourse) the write reports unavailable
 *  honestly rather than pretending. */
export async function recourseMemoryIndex(payload: unknown): Promise<RecourseResult> {
  const body = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? { ...(payload as Record<string, unknown>), source: (payload as Record<string, unknown>).source ?? 'openhub' }
    : { source: 'openhub', payload };
  return recourseFetch('/api/recourse/fleet/memory', { method: 'POST', body, guarded: true });
}

/** Re-index Recourse's own registry + snapshots into its vector memory. */
export async function recourseMemoryReindex(): Promise<RecourseResult> {
  return recourseFetch('/api/recourse/memory/index', { method: 'POST', body: {}, guarded: true });
}

// ---------------------------------------------------------------------------
// Full capability surface (read-mostly; guarded writes)
// ---------------------------------------------------------------------------

/** Registered tools/genes and their current promoted state. */
export async function recourseRegistry(): Promise<RecourseResult> {
  return recourseFetch('/api/recourse/registry');
}

/** Which self-hosted tools Recourse adopted to back its own internal ops (dogfood). */
export async function recourseCapabilities(): Promise<RecourseResult> {
  return recourseFetch('/api/recourse/capabilities');
}

/** How the upgraded system differs from its boot baseline. */
export async function recourseUpgradeReport(): Promise<RecourseResult> {
  return recourseFetch('/api/recourse/system/upgrade-report');
}

/** Append-only provenance chain over promotions/repairs. */
export async function recourseProvenance(limit = 50): Promise<RecourseResult> {
  return recourseFetch(`/api/recourse/provenance?limit=${encodeURIComponent(String(limit))}`);
}

/** What Recourse will self-develop next (autonomous agenda head). */
export async function recourseAgendaNext(): Promise<RecourseResult> {
  return recourseFetch('/api/recourse/agenda/next');
}

/** Recursive learner status (episodes, calibration, directives). */
export async function recourseLearnStatus(): Promise<RecourseResult> {
  return recourseFetch('/api/recourse/learn/status');
}

/** Dreaming engine status (REM cycles, hypotheses). */
export async function recourseDreamStatus(): Promise<RecourseResult> {
  return recourseFetch('/api/recourse/dream/status');
}

/** Live self-hosted capability modules built by Recourse's own templates. */
export async function recourseSelfHosted(): Promise<RecourseResult> {
  return recourseFetch('/api/recourse/selfhosted');
}

/** Skill library (Agent-Skills export/import surface). */
export async function recourseSkills(): Promise<RecourseResult> {
  return recourseFetch('/api/recourse/skills');
}

/** Run one capability-forge iteration. Guarded write. */
export async function recourseForgeRun(payload: Record<string, unknown> = {}): Promise<RecourseResult> {
  return recourseFetch('/api/recourse/forge/run', { method: 'POST', body: payload, guarded: true });
}

/** Execute a self-hosted tool by name with the given arguments. Guarded write. */
export async function recourseSelfHostedExecute(
  name: string,
  args: Record<string, unknown> = {},
): Promise<RecourseResult> {
  return recourseFetch(`/api/recourse/selfhosted/${encodeURIComponent(name)}/execute`, {
    method: 'POST',
    body: { args },
    guarded: true,
  });
}

// ---------------------------------------------------------------------------
// Self Reporter — Recourse's own deterministic, first-person field dispatches
// ---------------------------------------------------------------------------

/** Latest self-written dispatch (or `available:false` when none is on disk). */
export async function recourseReporterLatest(): Promise<RecourseResult> {
  return recourseFetch('/api/recourse/reporter/latest');
}

/** Newest-first index of archived dispatches. */
export async function recourseReporterArticles(limit?: number): Promise<RecourseResult> {
  const q = Number.isFinite(limit) && (limit as number) > 0 ? `?limit=${encodeURIComponent(String(limit))}` : '';
  return recourseFetch(`/api/recourse/reporter/articles${q}`);
}

/** Reporter configuration + archive count. */
export async function recourseReporterStatus(): Promise<RecourseResult> {
  return recourseFetch('/api/recourse/reporter/status');
}

/** Available reporter voices and output formats (customization surface). */
export async function recourseReporterVoices(): Promise<RecourseResult> {
  return recourseFetch('/api/recourse/reporter/voices');
}

/** Compose a dispatch for a voice/format WITHOUT persisting it (read-only). */
export async function recourseReporterPreview(voice?: string, format?: string): Promise<RecourseResult> {
  const params = new URLSearchParams();
  if (voice) params.set('voice', voice);
  if (format) params.set('format', format);
  const q = params.toString();
  return recourseFetch(`/api/recourse/reporter/preview${q ? `?${q}` : ''}`);
}

/** One archived dispatch by its content-address fingerprint. */
export async function recourseReporterArticle(fingerprint: string): Promise<RecourseResult> {
  return recourseFetch(`/api/recourse/reporter/article/${encodeURIComponent(fingerprint)}`);
}

/** Ask Recourse to compose a fresh dispatch. Guarded write. */
export async function recourseReporterGenerate(payload: Record<string, unknown> = {}): Promise<RecourseResult> {
  return recourseFetch('/api/recourse/reporter/generate', { method: 'POST', body: payload, guarded: true });
}

/** Attach a non-canonical model narration to the latest dispatch. Guarded. */
export async function recourseReporterNarrate(fingerprint?: string): Promise<RecourseResult> {
  return recourseFetch('/api/recourse/reporter/narrate', {
    method: 'POST',
    body: fingerprint ? { fingerprint } : {},
    guarded: true,
  });
}

/** Normalize a registry response into a compact tool list. */
export function normalizeRegistryTools(data: unknown): Array<{
  name: string; domain: string; version?: string; score?: number; passed?: boolean; selfHosted?: boolean; health?: string;
}> {
  if (!data || typeof data !== 'object') return [];
  const list = Array.isArray((data as Record<string, unknown>).registry)
    ? (data as { registry: unknown[] }).registry
    : Array.isArray(data) ? (data as unknown[]) : [];
  const out: Array<{ name: string; domain: string; version?: string; score?: number; passed?: boolean; selfHosted?: boolean; health?: string }> = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const t = item as Record<string, unknown>;
    const name = typeof t.name === 'string' ? t.name : '';
    if (!name) continue;
    const versions = Array.isArray(t.versions) ? (t.versions as Array<Record<string, unknown>>) : [];
    const current = versions.find((v) => v && v.version === t.currentVersion) ?? versions[versions.length - 1] ?? {};
    out.push({
      name,
      domain: typeof t.domain === 'string' ? t.domain : 'unknown',
      ...(typeof t.currentVersion === 'string' ? { version: t.currentVersion } : {}),
      ...(typeof current.score === 'number' && Number.isFinite(current.score) ? { score: current.score } : {}),
      passed: current.passed_verifier === true,
      selfHosted: typeof t.entrypoint === 'string' && t.entrypoint.includes('.selfhosted/'),
      ...(typeof t.healthStatus === 'string' ? { health: t.healthStatus } : {}),
    });
  }
  return out;
}

/** Self-healing repair scan of a local directory. */
export async function recourseScanHeal(targetDir: string): Promise<RecourseResult> {
  return recourseFetch('/api/recourse/repair/scan-heal', { method: 'POST', body: { targetDir }, guarded: true });
}

/** Autonomous agenda (what Recourse is self-developing next). */
export async function recourseAgenda(): Promise<RecourseResult> {
  return recourseFetch('/api/recourse/agenda');
}

/** One-line summary for surfacing; never throws. */
export async function recourseSummary(): Promise<string> {
  const [status, synergy] = await Promise.all([recourseStatus(), recourseSynergyMap()]);
  if (!status.available && !synergy.available) {
    return `Recourse offline (${recourseBaseUrl()}).`;
  }
  const bits: string[] = [];
  if (status.available) {
    const s = status.data ?? {};
    bits.push(`recourse ${s.status ?? s.state ?? 'online'}`);
  }
  if (synergy.available) {
    // Recourse nests the map under `map`; normalize before counting.
    const domains = normalizeSynergyMap(synergy.data).domains.length;
    bits.push(`synergy map: ${domains} domain${domains === 1 ? '' : 's'}`);
  }
  return bits.length ? bits.join(' · ') : `Recourse reachable but returned no state (${recourseBaseUrl()}).`;
}
