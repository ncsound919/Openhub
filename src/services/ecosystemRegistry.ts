import { getDb } from '../auth/db.js';
import path from 'path';
import {
  probeFleetCapabilities,
  type BridgeProbeResult,
  type FleetCapabilitiesSnapshot,
} from './capabilityProbe.js';
import type { ScorerResult } from './evidence.js';

/**
 * Ecosystem registry — a queryable catalog of the Overlay365 fleet's tools,
 * services, pillar projects and the operator's Ecosystem extension pack.
 *
 * Every entry carries the four things an agent needs for quick recall:
 *   1. stack      — languages/frameworks/runtime
 *   2. purpose    — one-line what-it-is-for
 *   3. audit      — a 0-100 ranking score + letter grade, with its source
 *   4. deployability — % to fully realized deployability, from a transparent
 *                      six-factor rubric (see DEPLOY_WEIGHTS)
 *
 * Honesty contract (matches the rest of the harness):
 *   - Scores are seeded from real audit artifacts already on disk
 *     (`Uplift/reports/*`). Their provenance is always recorded in
 *     `auditSource`; an entity with no defensible score reports `null` and
 *     `auditSource: 'not-yet-ranked'` — never an invented number.
 *   - Live health is only ever set from a successful fleet probe; a failed or
 *     skipped probe leaves `health: 'unknown'`. Nothing is fabricated up.
 *   - The registry persists its runtime overlay in SQLite so agents can recall
 *     it without re-probing; `refresh` re-probes and re-persists.
 */

export type EntityKind = 'service' | 'tool' | 'project' | 'pack';
export type HealthStatus = 'online' | 'degraded' | 'offline' | 'unknown';

export interface DeployFactors {
  deployed: boolean;
  buildable: boolean;
  verified: boolean;
  versionControlled: boolean;
  integrated: boolean;
  documented: boolean;
}

export interface EcosystemEntity {
  id: string;
  name: string;
  kind: EntityKind;
  pillar: string;
  stack: string[];
  purpose: string;
  repo: string | null;
  port: number | null;
  url: string | null;
  /** Capability-registry slug used for live health probing (services/tools). */
  bridge: string | null;
  tags: string[];
  auditScore: number | null;
  auditGrade: string | null;
  auditSource: string;
  auditAt: string | null;
  /** GitHub repo (owner/repo or URL) for live RepoRank/Grader scoring. */
  auditRepo: string | null;
  /** Local dir for The Deep — absolute, or relative to UPLIFT_ROOT. */
  auditDir: string | null;
  factors: DeployFactors;
  blockers: string[];
  evidence: string[];
  notes?: string;
}

export type AuditScorerName = 'reporank' | 'grader' | 'deep';

export interface AuditScorerOutcome {
  scorer: AuditScorerName;
  status: 'ok' | 'partial' | 'unavailable';
  score: number | null;
  grade: string | null;
  summary: string;
  error?: string;
  durationMs?: number;
}

export type RegistryEntry = Omit<EcosystemEntity, 'auditGrade'> & {
  deployability: number;
  auditGrade: string | null;
  /** Per-scorer live audit outcomes (empty until a live audit runs). */
  auditOutcomes: AuditScorerOutcome[];
  health: HealthStatus;
  healthDetail: string | null;
  healthCheckedAt: string | null;
  /** When the last live audit ran, if ever. */
  auditLiveAt: string | null;
  /** 1-based rank by audit score among scored entries; null when unscored. */
  rank: number | null;
};

export interface RegistrySnapshot {
  live: boolean;
  generatedAt: string;
  probedAt: string | null;
  totals: {
    total: number;
    byKind: Record<string, number>;
    byHealth: Record<string, number>;
    averageDeployability: number;
  };
  entries: RegistryEntry[];
  ranking: Array<{ rank: number; id: string; name: string; auditScore: number; deployability: number }>;
  error?: string;
}

export interface RegistryQuery {
  kind?: EntityKind | '';
  pillar?: string;
  search?: string;
  health?: HealthStatus | '';
  minDeployability?: number;
  maxDeployability?: number;
  sort?: 'deployability' | 'audit' | 'name';
  limit?: number;
}

/** Transparent deployability rubric. Weights sum to 100. */
export const DEPLOY_WEIGHTS: Record<keyof DeployFactors, number> = {
  deployed: 25,
  buildable: 15,
  verified: 20,
  versionControlled: 20,
  integrated: 10,
  documented: 10,
};

const DEPLOY_FACTOR_KEYS = Object.keys(DEPLOY_WEIGHTS) as (keyof DeployFactors)[];

export function deployabilityPercent(factors: DeployFactors): number {
  const total = DEPLOY_FACTOR_KEYS.reduce((sum, k) => sum + DEPLOY_WEIGHTS[k], 0);
  const earned = DEPLOY_FACTOR_KEYS.reduce((sum, k) => sum + (factors[k] ? DEPLOY_WEIGHTS[k] : 0), 0);
  return Math.round((earned / total) * 100);
}

export function gradeFor(score: number): string {
  return score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F';
}

// ---------------------------------------------------------------------------
// Seed catalog. Scores are grounded in the reports cited in `evidence`:
//   reports/2026-08-16-agentops-readiness-matrix.md   (live/buildable/demoable)
//   reports/2026-08-25-ecosystem-output-grading.md    (component PASS/INFO/DOWN)
//   reports/2026-08-25-full-ecosystem-audit.md        (VC / wiring / health)
//   reports/ecosystem-work-audit.md                   (per-repo commit state)
// ---------------------------------------------------------------------------

const AGENTOPS = 'reports/2026-08-16-agentops-readiness-matrix.md';
const GRADING = 'reports/2026-08-25-ecosystem-output-grading.md';
const ECOSYS_AUDIT = 'reports/2026-08-25-full-ecosystem-audit.md';
const VC_AUDIT = 'reports/ecosystem-work-audit.md';

function f(partial: Partial<DeployFactors>): DeployFactors {
  return {
    deployed: false,
    buildable: false,
    verified: false,
    versionControlled: false,
    integrated: false,
    documented: false,
    ...partial,
  };
}

function entity(input: Partial<EcosystemEntity> & Pick<EcosystemEntity, 'id' | 'name' | 'kind' | 'pillar' | 'purpose'>): EcosystemEntity {
  const auditScore = input.auditScore ?? null;
  const port = input.port ?? null;
  const bridge = input.bridge ?? null;
  const url = input.url ?? (bridge && port ? `http://127.0.0.1:${port}` : null);
  return {
    repo: input.repo ?? null,
    port,
    url,
    bridge,
    tags: input.tags ?? [],
    auditScore,
    auditGrade: auditScore == null ? null : gradeFor(auditScore),
    auditSource: input.auditSource ?? (auditScore == null ? 'not-yet-ranked' : 'seed'),
    auditAt: input.auditAt ?? null,
    auditRepo: input.auditRepo ?? null,
    auditDir: input.auditDir ?? null,
    factors: input.factors ?? f({}),
    blockers: input.blockers ?? [],
    evidence: input.evidence ?? [],
    stack: input.stack ?? [],
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    id: input.id,
    name: input.name,
    kind: input.kind,
    pillar: input.pillar,
    purpose: input.purpose,
  };
}

const SEED: EcosystemEntity[] = [
  // ---- Platform / core services -----------------------------------------
  entity({
    id: 'axiom', name: 'Axiom Coding Harness', kind: 'service', pillar: 'platform',
    stack: ['TypeScript', 'Node.js', 'Express', 'React', 'Vite', 'SQLite', 'MCP'],
    purpose: 'Deterministic-spec coding harness that plans, generates, audits and repairs code across the fleet.',
    repo: 'Axiom Agent', port: 3198, bridge: 'axiom', tags: ['coding-loop', 'orchestration', 'primary'],
    auditScore: 85, auditSource: ECOSYS_AUDIT, auditAt: '2026-08-25',
    factors: f({ deployed: true, buildable: true, verified: true, versionControlled: true, integrated: true, documented: true }),
    evidence: [ECOSYS_AUDIT, 'AXIOM_FLEET_INTEGRATION.md'],
  }),
  entity({
    id: 'openhub', name: 'OpenHub Assurance IDE', kind: 'service', pillar: 'platform',
    stack: ['TypeScript', 'Node.js', 'Express', 'React', 'Vite', 'better-sqlite3', 'MCP'],
    purpose: 'Assurance IDE and audit suite — pipelines, scoring, repair, readiness dashboards for fleet repos.',
    repo: 'Axiom Agent/openhub', port: 3010, bridge: null, tags: ['audit', 'ide', 'assurance'],
    auditScore: 80, auditSource: ECOSYS_AUDIT, auditAt: '2026-08-25',
    factors: f({ deployed: true, buildable: true, verified: true, versionControlled: true, integrated: true, documented: true }),
    evidence: ['AXIOM_FLEET_INTEGRATION.md'],
  }),
  entity({
    id: 'draymond', name: 'Draymond Orchestrator', kind: 'service', pillar: 'orchestration',
    stack: ['TypeScript', 'Node.js', 'Next.js', 'Python', 'SQLite'],
    purpose: 'Fleet orchestration, scheduling and repair dispatch hub with .draymond brain state.',
    repo: 'Uplift/Draymond-Orchestrator', port: 3444, bridge: 'draymond', tags: ['orchestration', 'repair', 'brain'],
    auditScore: 85, auditSource: ECOSYS_AUDIT, auditAt: '2026-08-25',
    factors: f({ deployed: true, buildable: true, verified: true, versionControlled: true, integrated: true, documented: true }),
    evidence: [ECOSYS_AUDIT],
  }),
  entity({
    id: 'keywire', name: 'Keywire Zero-Trust Vault', kind: 'service', pillar: 'security',
    stack: ['TypeScript', 'Node.js', 'SQLite', 'JWT'],
    purpose: 'Zero-trust secret vault and SVID/service-token resolution for every fleet credential.',
    repo: 'Uplift/Keywire', bridge: null, tags: ['secrets', 'security', 'zero-trust'],
    auditScore: 70, auditSource: ECOSYS_AUDIT, auditAt: '2026-08-25',
    factors: f({ deployed: true, buildable: true, verified: true, versionControlled: false, integrated: true, documented: true }),
    blockers: ['No git repository at audit time — secrets-critical source unversioned.'],
    evidence: [ECOSYS_AUDIT, '§1 leaked keys', '§4 no version control'],
  }),

  // ---- Audit / review tools (bridged) -----------------------------------
  entity({
    id: 'reporank', name: 'RepoRank', kind: 'tool', pillar: 'audit',
    stack: ['TypeScript', 'Node.js'],
    purpose: 'Repository health ranker and dependency analyser; the fleet’s score-my-repo crown jewel.',
    repo: 'ncsound919/reporank', port: 3200, bridge: 'reporank', tags: ['scoring', 'rank', 'audit'],
    auditScore: 90, auditSource: AGENTOPS, auditAt: '2026-08-16',
    factors: f({ deployed: true, buildable: true, verified: false, versionControlled: true, integrated: true, documented: true }),
    blockers: ['Hosted Team tier needs a persistent host (worker + DB), not just static Vercel.'],
    evidence: [AGENTOPS + ' (#1, /health 200, live/buildable/demoable)'],
  }),
  entity({
    id: 'grader', name: 'Grader', kind: 'tool', pillar: 'audit',
    stack: [],
    purpose: 'Data-backed code quality and grade evaluator; fallback scorer beside RepoRank.',
    repo: 'local agents/Grader-main', port: 3201, bridge: 'grader', tags: ['scoring', 'grades', 'audit'],
    auditScore: 80, auditSource: AGENTOPS, auditAt: '2026-08-16',
    factors: f({ deployed: true, buildable: true, verified: false, versionControlled: false, integrated: true, documented: true }),
    blockers: ['Version-control state unverified.'],
    evidence: [AGENTOPS + ' (#2, /api/health 200)'],
  }),
  entity({
    id: 'claw-protect', name: 'Claw-Protect', kind: 'tool', pillar: 'audit',
    stack: [],
    purpose: 'SAST vulnerability scanner and secret-leak detector used as the security gate.',
    repo: 'Uplift/Claw-Protect-main', port: 3300, bridge: 'claw-protect', tags: ['security', 'sast', 'secrets'],
    auditScore: null,
    factors: f({ deployed: true, buildable: true, verified: false, versionControlled: false, integrated: true, documented: false }),
    blockers: ['No defensible audit score in the reports yet; version-control state unverified.'],
    evidence: ['AXIOM_FLEET_INTEGRATION.md (security gate)'],
  }),
  entity({
    id: 'codenexus', name: 'CodeNexus', kind: 'tool', pillar: 'audit',
    stack: [],
    purpose: 'Autonomous PR review and code-improvement engine; local-workspace alternative to RepoRank.',
    repo: 'Draymond-Orchestrator/agents/CodeNexus-main', port: 3205, bridge: 'codenexus', tags: ['pr-review', 'audit'],
    auditScore: null,
    factors: f({ deployed: true, buildable: true, verified: false, versionControlled: false, integrated: true, documented: false }),
    blockers: ['No defensible audit score in the reports yet; version-control state unverified.'],
    evidence: ['AXIOM_FLEET_INTEGRATION.md (OSS harness curation #5)'],
  }),
  entity({
    id: 'the-deep', name: 'The Deep', kind: 'tool', pillar: 'audit',
    stack: ['Node.js', 'TypeScript'],
    purpose: 'Deep static-analysis, bug-taxonomy and intent audit engine behind the deep scorer.',
    repo: 'Uplift/The Deep', port: 3100, bridge: 'the-deep', tags: ['static-analysis', 'deep-audit'],
    auditScore: null,
    factors: f({ deployed: true, buildable: true, verified: false, versionControlled: false, integrated: true, documented: true }),
    blockers: ['No git repository at audit time.', 'No defensible aggregate score yet.'],
    evidence: [ECOSYS_AUDIT + ' (§4 The Deep has no git)'],
  }),
  entity({
    id: 'agentbrowser', name: 'AgentBrowser', kind: 'tool', pillar: 'audit',
    stack: ['TypeScript', 'Node.js', 'Playwright'],
    purpose: 'Serialized browser-automation and browser-QA bridge for the harness.',
    repo: 'tap919/AgentBrowser', port: 3700, bridge: null, tags: ['browser', 'qa', 'automation'],
    auditScore: 90, auditSource: AGENTOPS, auditAt: '2026-08-16',
    factors: f({ deployed: true, buildable: true, verified: false, versionControlled: true, integrated: true, documented: true }),
    evidence: [AGENTOPS + ' (#5, /api/system/health 200)'],
  }),
  entity({
    id: 'vibe-reality', name: 'Vibe-Reality', kind: 'tool', pillar: 'audit',
    stack: [],
    purpose: 'Runtime-behaviour and consistency-assertion code auditor.',
    port: 3202, bridge: 'vibe-reality', tags: ['runtime-audit'],
    auditScore: null,
    factors: f({ deployed: true, buildable: false, verified: false, versionControlled: false, integrated: true, documented: false }),
    blockers: ['No defensible audit evidence yet.'],
    evidence: ['openhub capabilityRegistry'],
  }),

  // ---- Decision / intelligence ------------------------------------------
  entity({
    id: 'dev-brain', name: 'Dev-Brain', kind: 'tool', pillar: 'audit',
    stack: ['TypeScript', 'Node.js', 'Express'],
    purpose: 'Deterministic, LLM-free decision engine: intake/triage, OSS-harness ranking, repair-lane choice.',
    repo: 'Uplift/Dev-Brain', port: 3450, bridge: 'dev-brain', tags: ['decision', 'triage', 'deterministic'],
    auditScore: 85, auditSource: 'AXIOM_FLEET_INTEGRATION.md Phase 9', auditAt: '2026-09-17',
    factors: f({ deployed: true, buildable: true, verified: true, versionControlled: true, integrated: true, documented: true }),
    evidence: ['AXIOM_FLEET_INTEGRATION.md §Phase 9 (17 files / 48 tests green)'],
  }),
  entity({
    id: 'deterministic-brain', name: 'Deterministic Brain', kind: 'tool', pillar: 'core',
    stack: ['Python'],
    purpose: 'Zero-LLM deterministic planning/core engine — the fleet’s determinism moat.',
    repo: 'ncsound919/deterministic-brain', port: 3210, bridge: 'deterministic-brain', tags: ['deterministic', 'planning'],
    auditScore: 90, auditSource: AGENTOPS, auditAt: '2026-08-16',
    factors: f({ deployed: true, buildable: true, verified: true, versionControlled: true, integrated: true, documented: true }),
    evidence: [AGENTOPS + ' (#7, library, 229 tests)'],
  }),
  entity({
    id: 'router-budget', name: 'Router + Budget Engine', kind: 'tool', pillar: 'llm',
    stack: ['TypeScript'],
    purpose: 'Lane routing and workflow budgets that make cost a routing constraint (RouteGuard).',
    repo: 'Draymond-Orchestrator/llm.ts + workflow-budget.ts', bridge: null, tags: ['routing', 'budget', 'governance'],
    auditScore: 90, auditSource: AGENTOPS, auditAt: '2026-08-16',
    factors: f({ deployed: true, buildable: true, verified: false, versionControlled: true, integrated: true, documented: true }),
    evidence: [AGENTOPS + ' (#9, library, lane-freeze demo)'],
  }),
  entity({
    id: 'kairos', name: 'Kairos', kind: 'tool', pillar: 'product',
    stack: ['TypeScript'],
    purpose: 'Business-metric radar with nine detectors for revenue/ops alerts (BusinessRadar).',
    repo: 'Draymond-Orchestrator/src/lib/draymond/kairos.ts', bridge: null, tags: ['alerts', 'business-metrics'],
    auditScore: 90, auditSource: AGENTOPS, auditAt: '2026-08-16',
    factors: f({ deployed: true, buildable: true, verified: false, versionControlled: true, integrated: true, documented: true }),
    evidence: [AGENTOPS + ' (#8, scheduler-driven)'],
  }),

  // ---- Memory / LLM / index ---------------------------------------------
  entity({
    id: 'recourse', name: 'Recourse', kind: 'service', pillar: 'memory',
    stack: ['TypeScript', 'Node.js', 'Express', 'React', 'Vite', 'Python'],
    purpose: 'Self-developing architectural OS: verified prior art, fleet memory, synergy map and code-pattern write-back.',
    repo: 'Downloads/recourse', port: 3050, bridge: 'recourse', tags: ['memory', 'self-learning', 'prior-art'],
    auditScore: 80, auditSource: 'AXIOM_FLEET_INTEGRATION.md Phase 6-7', auditAt: '2026-09-17',
    factors: f({ deployed: true, buildable: true, verified: true, versionControlled: true, integrated: true, documented: true }),
    evidence: ['AXIOM_FLEET_INTEGRATION.md §Phase 6', '§Phase 7'],
  }),
  entity({
    id: 'litellm', name: 'LiteLLM Proxy', kind: 'service', pillar: 'llm',
    stack: ['Python', 'LiteLLM'],
    purpose: 'OpenAI-compatible LLM router with fleet fallback groups (free → openrouter → ollama → paid).',
    repo: 'Draymond-Orchestrator/data/litellm', port: 4100, bridge: 'litellm', tags: ['llm', 'routing', 'fallback'],
    auditScore: 95, auditSource: GRADING, auditAt: '2026-08-25',
    factors: f({ deployed: true, buildable: true, verified: true, versionControlled: true, integrated: true, documented: true }),
    evidence: [GRADING + ' (service litellm :4100 UP)'],
  }),
  entity({
    id: 'dsh-harness', name: 'DSH Harness', kind: 'service', pillar: 'llm',
    stack: ['TypeScript', 'Node.js'],
    purpose: 'DeepSeek harness service used as a model lane by the fleet router.',
    repo: 'Uplift/Deepseek Harness', port: 3080, bridge: null, tags: ['llm', 'harness'],
    auditScore: 80, auditSource: GRADING, auditAt: '2026-08-25',
    factors: f({ deployed: true, buildable: true, verified: false, versionControlled: false, integrated: true, documented: false }),
    blockers: ['Fleet manifest pointed at a dead path at audit time (path rot).', '~300 dirty files / gitignore gap.'],
    evidence: [GRADING + ' (service dsh-harness :3080 UP)', ECOSYS_AUDIT + ' (§3.1 path rot)'],
  }),
  entity({
    id: 'mutly', name: 'Mutly', kind: 'tool', pillar: 'index',
    stack: ['TypeScript', 'Node.js'],
    purpose: 'Repository daemon and code indexer (AgentCI) — semantic/lexical index across repos.',
    repo: 'tap919/Mutly-Daemon-Agent', port: 4000, bridge: 'mutly', tags: ['index', 'ci', 'search'],
    auditScore: 90, auditSource: AGENTOPS, auditAt: '2026-08-16',
    factors: f({ deployed: true, buildable: true, verified: false, versionControlled: true, integrated: true, documented: true }),
    evidence: [AGENTOPS + ' (#3, /api/agent/public-config 200)'],
  }),

  // ---- Products / services ----------------------------------------------
  entity({
    id: 'open-chat', name: 'Open-Chat', kind: 'service', pillar: 'product',
    stack: ['TypeScript', 'Node.js'],
    purpose: 'Agent chat product (AgentChat) with OSS-to-enterprise self-host funnel.',
    repo: 'ncsound919/Open-Chat + tap919/openchat', port: 5175, bridge: null, tags: ['chat', 'product'],
    auditScore: 90, auditSource: AGENTOPS, auditAt: '2026-08-16',
    factors: f({ deployed: true, buildable: true, verified: true, versionControlled: true, integrated: true, documented: true }),
    blockers: ['71 dirty files at audit time.'],
    evidence: [AGENTOPS + ' (#4, 951 tests)', ECOSYS_AUDIT + ' (§4 dirty tree)'],
  }),
  entity({
    id: 'global-lens', name: 'Overlay Global Lens', kind: 'service', pillar: 'product',
    stack: ['TypeScript', 'React', 'Vite'],
    purpose: 'Geospatial intelligence product; clean, live product per the ecosystem audit.',
    repo: 'Uplift/Overlay-Global-Lens', port: 3090, bridge: null, tags: ['product', 'geo'],
    auditScore: 40, auditSource: GRADING, auditAt: '2026-08-25',
    factors: f({ deployed: false, buildable: true, verified: false, versionControlled: true, integrated: true, documented: true }),
    blockers: ['Not running and absent from the pm2 roster — never restarted after a pm2 daemon death.'],
    evidence: [GRADING + ' (service global-lens :3090 DOWN)'],
  }),
  entity({
    id: 'soundlab', name: 'Sound Lab', kind: 'service', pillar: 'product',
    stack: ['Python'],
    purpose: 'Fleet audio/music product surface.',
    repo: 'Uplift/soundlab', bridge: null, tags: ['product', 'audio'],
    auditScore: null,
    factors: f({ deployed: true, buildable: true, verified: false, versionControlled: true, integrated: false, documented: false }),
    blockers: ['5 dirty files at audit time.'],
    evidence: [ECOSYS_AUDIT + ' (§4 dirty tree)'],
  }),
  entity({
    id: 'middleman', name: 'Middleman (E3)', kind: 'service', pillar: 'revenue',
    stack: ['Python', 'FastAPI', 'SQLite'],
    purpose: 'Metered gateway that turns usage into billable events for the E3 revenue rail.',
    repo: '06_Resources/tap919-middleman-main', port: 8021, bridge: null, tags: ['billing', 'metering', 'e3'],
    auditScore: 50, auditSource: AGENTOPS, auditAt: '2026-08-16',
    factors: f({ deployed: false, buildable: true, verified: false, versionControlled: true, integrated: false, documented: false }),
    blockers: ['Not running, not in pm2, no venv; MIDDLEMAN_URL not wired into Draymond.'],
    evidence: [AGENTOPS + ' (#10, DOWN)'],
  }),

  // ---- Pillar / app projects --------------------------------------------
  entity({
    id: 'uplift-health', name: 'Uplift Health', kind: 'project', pillar: 'pillar',
    stack: ['TypeScript', 'Next.js', 'Supabase'],
    purpose: 'Health pillar product with directory, profile and shared-identity auth.',
    repo: 'Uplift/Uplift Health', tags: ['pillar', 'health'],
    auditScore: 80, auditSource: VC_AUDIT, auditAt: '2026-08-12',
    factors: f({ deployed: true, buildable: true, verified: true, versionControlled: true, integrated: true, documented: true }),
    blockers: ['Shared-auth adapter work sat uncommitted on a pushed branch.'],
    evidence: [VC_AUDIT + ' (Health 388/388, deploys live)', ECOSYS_AUDIT + ' (§4 dirty tree)'],
  }),
  entity({
    id: 'uplift-wealth', name: 'Uplift Wealth', kind: 'project', pillar: 'pillar',
    stack: ['TypeScript', 'Next.js', 'Supabase'],
    purpose: 'Wealth pillar product with shared-auth and pg support.',
    repo: 'Uplift/Uplift Wealth', tags: ['pillar', 'wealth'],
    auditScore: 80, auditSource: VC_AUDIT, auditAt: '2026-08-12',
    factors: f({ deployed: true, buildable: true, verified: true, versionControlled: true, integrated: true, documented: true }),
    blockers: ['Shared-auth adapter originally shipped only from the local working tree.'],
    evidence: [VC_AUDIT + ' (Wealth supabaseAuth+pg 19/19)', 'Fix log #1 DONE'],
  }),
  entity({
    id: 'uplift-justice', name: 'Uplift Justice', kind: 'project', pillar: 'pillar',
    stack: ['TypeScript', 'Next.js', 'Supabase'],
    purpose: 'Justice pillar product with shared identity and auth endpoints.',
    repo: 'Uplift/Uplift Justice', tags: ['pillar', 'justice'],
    auditScore: 80, auditSource: VC_AUDIT, auditAt: '2026-08-12',
    factors: f({ deployed: true, buildable: true, verified: true, versionControlled: true, integrated: true, documented: true }),
    evidence: [VC_AUDIT + ' (Justice supabaseAuth 12/12, auth 401 correct)'],
  }),
  entity({
    id: 'agentops-platform', name: 'AgentOps Platform', kind: 'project', pillar: 'platform',
    stack: ['TypeScript', 'Python'],
    purpose: 'Governance wedge bundle (RepoRank, Router, Kairos, Brain, Mutly, Open-Chat) + pricing/exit docs.',
    repo: 'Uplift/AgentOps-Platform', tags: ['platform', 'bundle', 'gtm'],
    auditScore: 75, auditSource: AGENTOPS, auditAt: '2026-08-16',
    factors: f({ deployed: true, buildable: true, verified: false, versionControlled: false, integrated: true, documented: true }),
    blockers: ['No git repository at audit time.', 'Gaps are packaging not engineering: deploy landing, start Middleman, publish 3 OSS repos, build demo shell.'],
    evidence: [AGENTOPS + ' (10/12 modules ready; earlier 55% readiness)', ECOSYS_AUDIT + ' (§4 no git)'],
  }),
  entity({
    id: 'owl-token', name: 'OVL Token Contract', kind: 'project', pillar: 'app',
    stack: ['Solidity', 'Hardhat', 'Node.js'],
    purpose: 'Overlay token contract (Phase 0 tokenomics: 1B supply, treasury-hold, Transak on-ramp).',
    repo: 'ncsound919/Overlay365-AI-Safety', tags: ['token', 'blockchain', 'critical'],
    auditScore: 85, auditSource: VC_AUDIT, auditAt: '2026-08-12',
    factors: f({ deployed: true, buildable: true, verified: true, versionControlled: true, integrated: false, documented: true }),
    blockers: ['Tokenomics strategy docs still live in a separate strategy repo; on-ramp is a stub.'],
    evidence: [VC_AUDIT + ' (59/59 contract suite; git init + push fix #2 DONE)'],
  }),
  entity({
    id: 'ecos', name: 'ECOS', kind: 'project', pillar: 'app',
    stack: ['TypeScript'],
    purpose: 'Ecosystem OS site/product surface.',
    repo: 'Uplift/ECOS', tags: ['product', 'site'],
    auditScore: null,
    factors: f({ deployed: true, buildable: true, verified: false, versionControlled: true, integrated: false, documented: false }),
    blockers: ['22 dirty files at audit time.'],
    evidence: [ECOSYS_AUDIT + ' (§4 dirty tree)'],
  }),
  entity({
    id: 'boxing-sim', name: 'Boxing Sim / BBTech', kind: 'project', pillar: 'app',
    stack: ['TypeScript', 'React'],
    purpose: 'Boxing simulation and sports-data product line.',
    repo: 'Uplift/02_Pillars', tags: ['sports', 'simulation'],
    auditScore: null,
    factors: f({ deployed: true, buildable: true, verified: false, versionControlled: false, integrated: false, documented: true }),
    blockers: ['YouTube API key was hardcoded in an in-code fallback default.'],
    evidence: [ECOSYS_AUDIT + ' (§1.6 hardcoded key)'],
  }),
  entity({
    id: 'oncology', name: 'Overlay Oncology', kind: 'project', pillar: 'app',
    stack: ['Python', 'Nextflow'],
    purpose: 'Oncology research pipeline with strong colocated test culture and benchmarks.',
    repo: 'Uplift/Overlay-Oncology', tags: ['oncology', 'research'],
    auditScore: 85, auditSource: ECOSYS_AUDIT, auditAt: '2026-08-25',
    factors: f({ deployed: true, buildable: true, verified: true, versionControlled: true, integrated: false, documented: true }),
    evidence: [ECOSYS_AUDIT + ' (§8 healthy inventory)'],
  }),
  entity({
    id: 'hempforge', name: 'HempForge', kind: 'project', pillar: 'app',
    stack: ['TypeScript'],
    purpose: 'Niche hemp-supply-chain ledger with a defensible vertical moat.',
    repo: 'Uplift/HempForge-main', tags: ['vertical', 'ledger'],
    auditScore: null,
    factors: f({ deployed: true, buildable: true, verified: false, versionControlled: false, integrated: false, documented: false }),
    blockers: ['Vendored drop with its own git history and missing license lineage.'],
    evidence: [ECOSYS_AUDIT + ' (§2 vendored drops)'],
  }),
  entity({
    id: 'benchmark-olympics', name: 'Benchmark Olympics', kind: 'tool', pillar: 'audit',
    stack: ['TypeScript', 'Python'],
    purpose: 'Cross-model/output benchmarking arena used for fleet quality comparisons.',
    repo: 'Uplift/Benchmark Olympics', bridge: null, tags: ['benchmark', 'evals'],
    auditScore: 50, auditSource: ECOSYS_AUDIT, auditAt: '2026-08-25',
    factors: f({ deployed: true, buildable: true, verified: false, versionControlled: false, integrated: true, documented: true }),
    blockers: ['85 dirty files against only 20 tracked — high loss risk.', 'LIVE DRAYMOND_TOKEN + Gemini key sat in .env.local.'],
    evidence: [ECOSYS_AUDIT + ' (§1.9, §4)'],
  }),
  entity({
    id: 'codegang', name: 'Codegang', kind: 'project', pillar: 'app',
    stack: ['TypeScript', 'Next.js'],
    purpose: 'Collaborative code platform application (Supabase-backed).',
    repo: '05_Apps/Codegang', tags: ['app', 'collab'],
    auditScore: 45, auditSource: ECOSYS_AUDIT, auditAt: '2026-08-25',
    factors: f({ deployed: false, buildable: true, verified: false, versionControlled: false, integrated: false, documented: false }),
    blockers: ['No git repository at audit time.', 'Supabase superuser password + DeepSeek key exposed in .env.'],
    evidence: [ECOSYS_AUDIT + ' (§1.14, §4)'],
  }),
  entity({
    id: 'comic-metaphor-logic', name: 'Comic Metaphor Logic', kind: 'project', pillar: 'app',
    stack: ['TypeScript', 'React'],
    purpose: 'Comic-metaphor content/engine product.',
    repo: 'Uplift/Comic Metaphor Logic', tags: ['product', 'content'],
    auditScore: null,
    factors: f({ deployed: true, buildable: true, verified: false, versionControlled: false, integrated: false, documented: true }),
    blockers: ['Stripe LIVE key + Supabase service_role JWT exposed on disk.'],
    evidence: [ECOSYS_AUDIT + ' (§1.1)'],
  }),
  entity({
    id: 'knowledge-bank', name: 'Knowledge Bank', kind: 'project', pillar: 'resource',
    stack: ['Markdown'],
    purpose: 'Shared knowledge/reference repository for the ecosystem.',
    repo: 'Uplift/knowledge_bank', tags: ['docs', 'knowledge'],
    auditScore: 40, auditSource: ECOSYS_AUDIT, auditAt: '2026-08-25',
    factors: f({ deployed: true, buildable: false, verified: false, versionControlled: false, integrated: false, documented: true }),
    blockers: ['No git repository at audit time.'],
    evidence: [ECOSYS_AUDIT + ' (§4 no git)'],
  }),

  // ---- Operator Ecosystem extension pack --------------------------------
  entity({
    id: 'ecosystem-agents', name: 'Ecosystem Agents', kind: 'pack', pillar: 'ecosystem-pack',
    stack: ['Markdown', 'YAML'],
    purpose: 'Agent definitions (frontmatter + tools) that add GSD roles to the harness.',
    repo: 'Desktop/Ecosystem/agents', tags: ['agents', 'pack'],
    auditScore: 85, auditSource: 'AXIOM_FLEET_INTEGRATION.md Phase 10', auditAt: '2026-09-17',
    factors: f({ deployed: true, buildable: true, verified: true, versionControlled: false, integrated: true, documented: true }),
    blockers: ['Ecosystem folder is not version controlled.'],
    evidence: ['AXIOM_FLEET_INTEGRATION.md §Phase 10 (34-entry agent catalog)'],
  }),
  entity({
    id: 'ecosystem-skills', name: 'Ecosystem Skills', kind: 'pack', pillar: 'ecosystem-pack',
    stack: ['Markdown', 'YAML'],
    purpose: 'Skill definitions (SKILL.md) matched to goals and injected into missions.',
    repo: 'Desktop/Ecosystem/skills + ecc-skills', tags: ['skills', 'pack'],
    auditScore: 85, auditSource: 'ecosystemKnowledge.test.ts', auditAt: null,
    factors: f({ deployed: true, buildable: true, verified: true, versionControlled: false, integrated: true, documented: true }),
    blockers: ['Ecosystem folder is not version controlled.'],
    evidence: ['openhub/tests/ecosystemKnowledge.test.ts (>=120 skills indexed)'],
  }),
  entity({
    id: 'ecosystem-commands', name: 'Ecosystem Commands', kind: 'pack', pillar: 'ecosystem-pack',
    stack: ['Markdown'],
    purpose: 'Slash-command catalog (discovery only; operator-invoked, never auto-run).',
    repo: 'Desktop/Ecosystem/commands', tags: ['commands', 'pack'],
    auditScore: 85, auditSource: 'AXIOM_FLEET_INTEGRATION.md Phase 10', auditAt: '2026-09-17',
    factors: f({ deployed: true, buildable: true, verified: true, versionControlled: false, integrated: true, documented: true }),
    blockers: ['Ecosystem folder is not version controlled.'],
    evidence: ['AXIOM_FLEET_INTEGRATION.md §Phase 10 (88 command files)'],
  }),
  entity({
    id: 'ecosystem-plugins', name: 'Ecosystem Plugins', kind: 'pack', pillar: 'ecosystem-pack',
    stack: ['JavaScript', 'Markdown'],
    purpose: 'Single-file plugins (e.g. superpowers) discovered with default-deny capabilities.',
    repo: 'Desktop/Ecosystem/plugins', tags: ['plugins', 'pack'],
    auditScore: 75, auditSource: 'AXIOM_FLEET_INTEGRATION.md Phase 10', auditAt: '2026-09-17',
    factors: f({ deployed: true, buildable: true, verified: true, versionControlled: false, integrated: true, documented: true }),
    blockers: ['Ecosystem folder is not version controlled.'],
    evidence: ['AXIOM_FLEET_INTEGRATION.md §Phase 10 (single-file plugin manifest)'],
  }),
  entity({
    id: 'ecosystem-rules', name: 'Ecosystem Rules', kind: 'pack', pillar: 'ecosystem-pack',
    stack: ['Markdown'],
    purpose: 'Standing rules + lazy overlay365 five-layer files (SOUL/ECOSYSTEM/STRATEGY/MEMORY/OPS).',
    repo: 'Desktop/Ecosystem/rules', tags: ['rules', 'pack'],
    auditScore: 70, auditSource: 'AXIOM_FLEET_INTEGRATION.md Phase 10', auditAt: '2026-09-17',
    factors: f({ deployed: true, buildable: true, verified: true, versionControlled: false, integrated: true, documented: true }),
    blockers: ['Ecosystem AGENTS.md is corrupted on disk (U+FFFD em-dashes).', 'Ecosystem folder is not version controlled.'],
    evidence: ['AXIOM_FLEET_INTEGRATION.md §Phase 10 (AGENTS.md corruption note)'],
  }),
  entity({
    id: 'get-shit-done', name: 'Get-Shit-Done (GSD)', kind: 'pack', pillar: 'ecosystem-pack',
    stack: ['Markdown'],
    purpose: 'Workflow, reference and template library that drives the GSD execution playbooks.',
    repo: 'Desktop/Ecosystem/get-shit-done', tags: ['workflows', 'templates', 'pack'],
    auditScore: 80, auditSource: 'ecosystemKnowledge.test.ts', auditAt: null,
    factors: f({ deployed: true, buildable: true, verified: true, versionControlled: false, integrated: true, documented: true }),
    blockers: ['Ecosystem folder is not version controlled.'],
    evidence: ['openhub/tests/ecosystemKnowledge.test.ts (>=85 workflows, >=40 references)'],
  }),
];

/**
 * Live audit targets. `auditRepo` feeds RepoRank + Grader (GitHub URL or
 * owner/repo); `auditDir` feeds The Deep (absolute, or relative to UPLIFT_ROOT).
 * Only entities listed here can be live-scored — everything else keeps its
 * seeded provenance rather than being sent to a scorer that cannot read it.
 */
const AUDIT_TARGETS: Record<string, { auditRepo?: string; auditDir?: string }> = {
  axiom: { auditDir: 'Deepseek Harness/Axiom Agent' },
  openhub: { auditDir: 'Deepseek Harness/Axiom Agent/openhub' },
  draymond: { auditDir: 'Draymond-Orchestrator' },
  'dev-brain': { auditDir: 'Dev-Brain' },
  'deterministic-brain': { auditRepo: 'ncsound919/deterministic-brain' },
  'the-deep': { auditDir: 'The Deep' },
  reporank: { auditRepo: 'ncsound919/reporank' },
  mutly: { auditRepo: 'tap919/Mutly-Daemon-Agent' },
  agentbrowser: { auditRepo: 'tap919/AgentBrowser' },
  'open-chat': { auditRepo: 'ncsound919/Open-Chat' },
  'owl-token': { auditRepo: 'ncsound919/Overlay365-AI-Safety' },
  'uplift-health': { auditDir: 'Uplift Health' },
  'uplift-wealth': { auditDir: 'Uplift Wealth' },
  'uplift-justice': { auditDir: 'Uplift Justice' },
};

export const SEED_ENTITIES: EcosystemEntity[] = SEED.map((e) => {
  const target = AUDIT_TARGETS[e.id];
  if (!target) return e;
  return { ...e, auditRepo: e.auditRepo ?? target.auditRepo ?? null, auditDir: e.auditDir ?? target.auditDir ?? null };
});

// ---------------------------------------------------------------------------
// Live health overlay (via the capability registry probe)
// ---------------------------------------------------------------------------

function healthFromProbe(probe: BridgeProbeResult | undefined): { health: HealthStatus; detail: string | null } {
  if (!probe) return { health: 'unknown', detail: null };
  const detail = probe.reason || probe.version || probe.endpoint || null;
  if (probe.status === 'online') return { health: 'online', detail };
  if (probe.status === 'degraded') return { health: 'degraded', detail };
  return { health: 'offline', detail };
}

/** Apply a probe result onto an entity's deployability factors. */
export function applyProbe(
  entityItem: EcosystemEntity,
  probe: BridgeProbeResult | undefined,
  checkedAt: string | null,
  audit?: { outcomes?: AuditScorerOutcome[]; liveAt?: string | null },
): RegistryEntry {
  const { health, detail } = healthFromProbe(probe);
  const factors: DeployFactors = { ...entityItem.factors };

  if (probe) {
    factors.deployed = probe.status !== 'offline';
    if (probe.status === 'degraded' && !entityItem.blockers.some((b) => b.includes('degraded'))) {
      entityItem = { ...entityItem, blockers: [...entityItem.blockers, 'Live probe returned a degraded (5xx) response.'] };
    }
  }

  return {
    ...entityItem,
    factors,
    deployability: deployabilityPercent(factors),
    health,
    healthDetail: detail,
    healthCheckedAt: probe ? checkedAt : null,
    auditOutcomes: audit?.outcomes ?? [],
    auditLiveAt: audit?.liveAt ?? null,
    rank: null,
  };
}

function rankEntries(entries: RegistryEntry[]): RegistryEntry[] {
  const scored = entries
    .filter((e): e is RegistryEntry & { auditScore: number } => e.auditScore !== null)
    .sort((a, b) => b.auditScore - a.auditScore || b.deployability - a.deployability);
  const rankById = new Map(scored.map((e, i) => [e.id, i + 1]));
  return entries.map((e) => ({ ...e, rank: rankById.get(e.id) ?? null }));
}

// ---------------------------------------------------------------------------
// Live audit scoring — RepoRank + Grader (GitHub) and The Deep (local dir).
// Aggregated honestly: only scorers that returned a real score contribute to
// the combined audit score; unavailable scorers are recorded with their error.
// ---------------------------------------------------------------------------

const DEFAULT_AUDIT_CONCURRENCY = 2;
const DEFAULT_AUDIT_MAX = 6;

export interface LiveAuditDeps {
  reporank?: (repo: string) => Promise<ScorerResult>;
  grader?: (repo: string) => Promise<ScorerResult>;
  deep?: (dir: string) => Promise<ScorerResult>;
}

/** Local dir for The Deep: absolute as-is, else resolved under UPLIFT_ROOT. */
export function resolveAuditDir(entityItem: EcosystemEntity, env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = entityItem.auditDir;
  if (!dir) return null;
  if (path.isAbsolute(dir)) return dir;
  const root = env.UPLIFT_ROOT;
  return root ? path.join(root.replace(/[/\\]+$/, ''), dir) : null;
}

function outcomeOf(scorer: AuditScorerName, result: ScorerResult): AuditScorerOutcome {
  const score = typeof result.score === 'number' ? result.score : null;
  return {
    scorer,
    status: result.status ?? (score === null ? 'unavailable' : 'ok'),
    score,
    grade: score === null ? null : (result.grade ?? gradeFor(score)),
    summary: (result.summary || '').slice(0, 300),
    ...(result.error ? { error: result.error.slice(0, 300) } : {}),
    ...(typeof result.durationMs === 'number' ? { durationMs: result.durationMs } : {}),
  };
}

async function loadDefaultAuditDeps(): Promise<Required<LiveAuditDeps>> {
  const suite = await import('./auditSuite.js');
  return {
    reporank: suite.runRepoRankScorer,
    grader: suite.runGraderScorer,
    deep: suite.runDeepScorer,
  };
}

/** Run every scorer an entity has a target for, in parallel, and aggregate. */
export async function auditEntityLive(
  entityItem: EcosystemEntity,
  deps: LiveAuditDeps = {},
): Promise<{ score: number | null; grade: string | null; sources: AuditScorerName[]; outcomes: AuditScorerOutcome[] }> {
  const hasInjected = Boolean(deps.reporank || deps.grader || deps.deep);
  const resolved = hasInjected ? deps : await loadDefaultAuditDeps();
  const tasks: Array<Promise<AuditScorerOutcome>> = [];

  if (entityItem.auditRepo && resolved.reporank) {
    tasks.push(Promise.resolve(resolved.reporank(entityItem.auditRepo)).then((r) => outcomeOf('reporank', r)).catch((e) => unavailable('reporank', e)));
  }
  if (entityItem.auditRepo && resolved.grader) {
    tasks.push(Promise.resolve(resolved.grader(entityItem.auditRepo)).then((r) => outcomeOf('grader', r)).catch((e) => unavailable('grader', e)));
  }
  const dir = resolveAuditDir(entityItem);
  if (dir && resolved.deep) {
    tasks.push(Promise.resolve(resolved.deep(dir)).then((r) => outcomeOf('deep', r)).catch((e) => unavailable('deep', e)));
  }

  const outcomes = await Promise.all(tasks);
  const scores = outcomes.filter((o) => o.score !== null).map((o) => o.score as number);
  const score = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
  return {
    score,
    grade: score === null ? null : gradeFor(score),
    sources: outcomes.filter((o) => o.score !== null).map((o) => o.scorer),
    outcomes,
  };
}

function unavailable(scorer: AuditScorerName, err: unknown): AuditScorerOutcome {
  return {
    scorer,
    status: 'unavailable',
    score: null,
    grade: null,
    summary: '',
    error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
  };
}

export interface AuditRegistryOptions {
  ids?: string[];
  limit?: number;
  concurrency?: number;
  deps?: LiveAuditDeps;
}

export interface AuditedEntity {
  id: string;
  score: number | null;
  grade: string | null;
  sources: AuditScorerName[];
  outcomes: AuditScorerOutcome[];
}

export interface AuditRegistryResult {
  auditedAt: string;
  audited: AuditedEntity[];
  skipped: Array<{ id: string; reason: string }>;
  snapshot: RegistrySnapshot;
}

async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift() as T;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/**
 * Live-audit the registry (or a subset by id) with RepoRank, Grader and The
 * Deep, then persist the resulting scores. Entities without a configured
 * target are skipped with a reason, never silently scored from nothing.
 */
export async function auditRegistry(options: AuditRegistryOptions = {}): Promise<AuditRegistryResult> {
  const deps = options.deps ?? {};
  const entries = composeEntries();
  const wanted = options.ids && options.ids.length ? new Set(options.ids) : null;
  const limit = Math.min(50, Math.max(1, options.limit ?? DEFAULT_AUDIT_MAX));
  const concurrency = Math.min(8, Math.max(1, options.concurrency ?? DEFAULT_AUDIT_CONCURRENCY));

  const skipped: Array<{ id: string; reason: string }> = [];
  const eligible = entries.filter((e) => {
    if (wanted && !wanted.has(e.id)) return false;
    if (!e.auditRepo && !resolveAuditDir(e)) {
      skipped.push({ id: e.id, reason: 'no live audit target (auditRepo/auditDir) configured' });
      return false;
    }
    return true;
  });

  const selected = eligible.slice(0, limit);
  for (const e of eligible.slice(limit)) skipped.push({ id: e.id, reason: `beyond limit ${limit}` });

  const auditedAt = new Date().toISOString();
  const results = new Map<string, AuditedEntity>();
  await runWithConcurrency(selected, concurrency, async (e) => {
    const live = await auditEntityLive(e, deps);
    results.set(e.id, { id: e.id, score: live.score, grade: live.grade, sources: live.sources, outcomes: live.outcomes });
  });

  const updated = entries.map((e) => {
    const live = results.get(e.id);
    if (!live) return e;
    const hasScore = live.score !== null;
    return {
      ...e,
      ...(hasScore
        ? { auditScore: live.score, auditGrade: live.grade, auditSource: `live:${live.sources.join('+')}`, auditAt: auditedAt }
        : {}),
      auditOutcomes: live.outcomes,
      auditLiveAt: auditedAt,
    };
  });

  try {
    persistEntries(updated);
  } catch {
    /* persistence is best-effort; the returned snapshot still reflects the run */
  }

  return {
    auditedAt,
    audited: [...results.values()],
    skipped,
    snapshot: listRegistry({ limit: 500 }),
  };
}

// ---------------------------------------------------------------------------
// SQLite persistence (runtime overlay)
// ---------------------------------------------------------------------------

function ensureTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS ecosystem_registry (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      pillar TEXT NOT NULL,
      stack TEXT NOT NULL DEFAULT '[]',
      purpose TEXT NOT NULL DEFAULT '',
      repo TEXT,
      port INTEGER,
      url TEXT,
      bridge TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      audit_score REAL,
      audit_grade TEXT,
      audit_source TEXT NOT NULL DEFAULT 'not-yet-ranked',
      audit_at TEXT,
      audit_breakdown TEXT NOT NULL DEFAULT '[]',
      audit_live_at TEXT,
      factors TEXT NOT NULL DEFAULT '{}',
      deployability REAL NOT NULL DEFAULT 0,
      health TEXT NOT NULL DEFAULT 'unknown',
      health_detail TEXT,
      health_checked_at TEXT,
      blockers TEXT NOT NULL DEFAULT '[]',
      evidence TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL
    );
  `);
  // Additive migrations for registries created before live scoring existed.
  const cols = getDb().prepare('PRAGMA table_info(ecosystem_registry)').all() as Array<{ name: string }>;
  const has = (name: string) => cols.some((c) => c.name === name);
  if (!has('audit_breakdown')) getDb().exec("ALTER TABLE ecosystem_registry ADD COLUMN audit_breakdown TEXT NOT NULL DEFAULT '[]'");
  if (!has('audit_live_at')) getDb().exec('ALTER TABLE ecosystem_registry ADD COLUMN audit_live_at TEXT');
}

interface PersistedRow {
  id: string;
  audit_score: number | null;
  audit_grade: string | null;
  audit_source: string;
  audit_at: string | null;
  audit_breakdown: string;
  audit_live_at: string | null;
  factors: string;
  deployability: number;
  health: string;
  health_detail: string | null;
  health_checked_at: string | null;
  blockers: string;
}

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function persistEntries(entries: RegistryEntry[]): void {
  ensureTable();
  const db = getDb();
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT OR REPLACE INTO ecosystem_registry
      (id, name, kind, pillar, stack, purpose, repo, port, url, bridge, tags,
       audit_score, audit_grade, audit_source, audit_at, audit_breakdown, audit_live_at,
       factors, deployability,
       health, health_detail, health_checked_at, blockers, evidence, updated_at)
    VALUES
      (@id, @name, @kind, @pillar, @stack, @purpose, @repo, @port, @url, @bridge, @tags,
       @audit_score, @audit_grade, @audit_source, @audit_at, @audit_breakdown, @audit_live_at,
       @factors, @deployability,
       @health, @health_detail, @health_checked_at, @blockers, @evidence, @updated_at)
  `);
  db.transaction(() => {
    db.prepare('DELETE FROM ecosystem_registry').run();
    for (const e of entries) {
      insert.run({
        id: e.id,
        name: e.name,
        kind: e.kind,
        pillar: e.pillar,
        stack: JSON.stringify(e.stack),
        purpose: e.purpose,
        repo: e.repo,
        port: e.port,
        url: e.url,
        bridge: e.bridge,
        tags: JSON.stringify(e.tags),
        audit_score: e.auditScore,
        audit_grade: e.auditGrade,
        audit_source: e.auditSource,
        audit_at: e.auditAt,
        audit_breakdown: JSON.stringify(e.auditOutcomes ?? []),
        audit_live_at: e.auditLiveAt ?? null,
        factors: JSON.stringify(e.factors),
        deployability: e.deployability,
        health: e.health,
        health_detail: e.healthDetail,
        health_checked_at: e.healthCheckedAt,
        blockers: JSON.stringify(e.blockers),
        evidence: JSON.stringify(e.evidence),
        updated_at: now,
      });
    }
  })();
}

function loadPersisted(): Map<string, PersistedRow> {
  try {
    ensureTable();
    const rows = getDb()
      .prepare('SELECT id, audit_score, audit_grade, audit_source, audit_at, audit_breakdown, audit_live_at, factors, deployability, health, health_detail, health_checked_at, blockers FROM ecosystem_registry')
      .all() as PersistedRow[];
    return new Map(rows.map((r) => [r.id, r]));
  } catch {
    return new Map();
  }
}

/** Merge persisted runtime fields onto the current seed (seed is the source of truth for static fields). */
function composeEntries(): RegistryEntry[] {
  const persisted = loadPersisted();
  const entries = SEED_ENTITIES.map((seed) => {
    const row = persisted.get(seed.id);
    if (!row) {
      return {
        ...seed,
        deployability: deployabilityPercent(seed.factors),
        health: 'unknown' as HealthStatus,
        healthDetail: null,
        healthCheckedAt: null,
        auditOutcomes: [],
        auditLiveAt: null,
        rank: null,
      };
    }
    const factors = safeParse<DeployFactors>(row.factors, seed.factors);
    const auditScore = row.audit_score ?? seed.auditScore;
    return {
      ...seed,
      factors,
      deployability: typeof row.deployability === 'number' ? row.deployability : deployabilityPercent(factors),
      auditScore,
      auditGrade: auditScore == null ? null : gradeFor(auditScore),
      auditSource: row.audit_source || seed.auditSource,
      auditAt: row.audit_at ?? seed.auditAt,
      health: (row.health as HealthStatus) || 'unknown',
      healthDetail: row.health_detail,
      healthCheckedAt: row.health_checked_at,
      blockers: safeParse<string[]>(row.blockers, seed.blockers),
      auditOutcomes: safeParse<AuditScorerOutcome[]>(row.audit_breakdown, []),
      auditLiveAt: row.audit_live_at,
      rank: null,
    };
  });
  return rankEntries(entries);
}

// ---------------------------------------------------------------------------
// Query + summary
// ---------------------------------------------------------------------------

function matches(entry: RegistryEntry, query: RegistryQuery): boolean {
  if (query.kind && entry.kind !== query.kind) return false;
  if (query.pillar && entry.pillar !== query.pillar) return false;
  if (query.health && entry.health !== query.health) return false;
  if (typeof query.minDeployability === 'number' && entry.deployability < query.minDeployability) return false;
  if (typeof query.maxDeployability === 'number' && entry.deployability > query.maxDeployability) return false;
  if (query.search) {
    const needle = query.search.toLowerCase();
    const hay = `${entry.id} ${entry.name} ${entry.purpose} ${entry.stack.join(' ')} ${entry.tags.join(' ')}`.toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

function sortEntries(entries: RegistryEntry[], sort: RegistryQuery['sort']): RegistryEntry[] {
  if (sort === 'name') return [...entries].sort((a, b) => a.name.localeCompare(b.name));
  if (sort === 'audit') {
    return [...entries].sort((a, b) => (b.auditScore ?? -1) - (a.auditScore ?? -1) || b.deployability - a.deployability);
  }
  return [...entries].sort((a, b) => b.deployability - a.deployability || (b.auditScore ?? -1) - (a.auditScore ?? -1));
}

function totalsOf(entries: RegistryEntry[]): RegistrySnapshot['totals'] {
  const byKind: Record<string, number> = {};
  const byHealth: Record<string, number> = {};
  for (const e of entries) {
    byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    byHealth[e.health] = (byHealth[e.health] ?? 0) + 1;
  }
  const averageDeployability = entries.length
    ? Math.round(entries.reduce((sum, e) => sum + e.deployability, 0) / entries.length)
    : 0;
  return { total: entries.length, byKind, byHealth, averageDeployability };
}

/** Read the registry (persisted overlay + seed), with optional filtering. */
export function listRegistry(query: RegistryQuery = {}): RegistrySnapshot {
  const all = composeEntries();
  const filtered = sortEntries(all.filter((e) => matches(e, query)), query.sort);
  const limit = Math.min(500, Math.max(1, query.limit ?? 200));
  const entries = filtered.slice(0, limit);
  const ranking = all
    .filter((e): e is RegistryEntry & { auditScore: number; rank: number } => e.rank !== null && e.auditScore !== null)
    .sort((a, b) => a.rank - b.rank)
    .map((e) => ({ rank: e.rank, id: e.id, name: e.name, auditScore: e.auditScore, deployability: e.deployability }));
  return {
    live: true,
    generatedAt: new Date().toISOString(),
    probedAt: null,
    totals: totalsOf(entries),
    entries,
    ranking,
  };
}

export function getRegistryEntry(id: string): RegistryEntry | null {
  return composeEntries().find((e) => e.id === id) ?? null;
}

/**
 * Re-probe fleet health and persist the refreshed overlay. `probe` is
 * injectable for deterministic tests; production uses the capability probe.
 * Set `audit` to also run live RepoRank/Grader/The Deep scoring on entities
 * that have an audit target (bounded by `auditIds` / `auditLimit`).
 */
export async function refreshRegistry(options: {
  probe?: () => Promise<FleetCapabilitiesSnapshot>;
  /** When no probe is available, keep the persisted/seed state instead of throwing. */
  persist?: boolean;
  audit?: boolean;
  auditIds?: string[];
  auditLimit?: number;
  auditDeps?: LiveAuditDeps;
} = {}): Promise<RegistrySnapshot> {
  const probe = options.probe ?? (() => probeFleetCapabilities({ refresh: true }));
  let snapshot: FleetCapabilitiesSnapshot | null = null;
  let error: string | undefined;
  try {
    snapshot = await probe();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const bridged = new Set(SEED_ENTITIES.filter((e) => e.bridge).map((e) => e.bridge as string));
  const probes = new Map<string, BridgeProbeResult>();
  for (const bridge of snapshot?.bridges ?? []) {
    if (bridged.has(bridge.slug)) probes.set(bridge.slug, bridge);
  }

  const checkedAt = snapshot?.probedAt ?? null;
  // Start from the composed entries so a health refresh preserves any live
  // audit outcomes already persisted.
  const entries = rankEntries(
    composeEntries().map((e) =>
      applyProbe(e, e.bridge ? probes.get(e.bridge) : undefined, checkedAt, {
        outcomes: e.auditOutcomes,
        liveAt: e.auditLiveAt,
      }),
    ),
  );

  if (options.persist !== false) {
    try {
      persistEntries(entries);
    } catch (err) {
      if (!error) error = `persist failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (options.audit) {
    const audited = await auditRegistry({
      ...(options.auditIds ? { ids: options.auditIds } : {}),
      ...(typeof options.auditLimit === 'number' ? { limit: options.auditLimit } : {}),
      ...(options.auditDeps ? { deps: options.auditDeps } : {}),
    });
    return { ...audited.snapshot, probedAt: snapshot?.probedAt ?? null };
  }

  return {
    live: true,
    generatedAt: new Date().toISOString(),
    probedAt: snapshot?.probedAt ?? null,
    totals: totalsOf(entries),
    entries,
    ranking: entries
      .filter((e): e is RegistryEntry & { auditScore: number; rank: number } => e.rank !== null && e.auditScore !== null)
      .sort((a, b) => a.rank - b.rank)
      .map((e) => ({ rank: e.rank, id: e.id, name: e.name, auditScore: e.auditScore, deployability: e.deployability })),
    ...(error ? { error } : {}),
  };
}

/** One-line human summary (dashboards/CLI). */
export function summarizeRegistry(snapshot: RegistrySnapshot): string {
  const { total, byHealth, averageDeployability } = snapshot.totals;
  const online = byHealth.online ?? 0;
  const offline = byHealth.offline ?? 0;
  const unknown = byHealth.unknown ?? 0;
  return `Ecosystem registry: ${total} entities · avg deployability ${averageDeployability}% · health online ${online} / offline ${offline} / unknown ${unknown}`;
}

/** Reset the persisted overlay (tests / operator). */
export function clearRegistry(): void {
  try {
    ensureTable();
    getDb().prepare('DELETE FROM ecosystem_registry').run();
  } catch {
    /* nothing persisted */
  }
}
