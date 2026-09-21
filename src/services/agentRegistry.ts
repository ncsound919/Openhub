import fs from 'fs';
import path from 'path';

/**
 * Agent role registry — which on-disk agents back OpenHub's audit system and
 * research pipeline. Paths are explicit configuration: they derive from
 * UPLIFT_ROOT and can be overridden with `;`-delimited env vars
 * (OPENHUB_AUDIT_AGENTS / OPENHUB_RESEARCH_AGENTS). No machine path is
 * hardcoded in source; a configured path that does not exist degrades to
 * `present: false` with an explicit note rather than being silently dropped.
 */

export type AgentRole = 'audit' | 'research';

export interface AgentBackend {
  role: AgentRole;
  path: string;
  slug: string;
  name: string;
  description: string;
  present: boolean;
  manifest: 'agent.json' | 'metadata.json' | 'package.json' | 'directory' | null;
}

export interface AgentRoster {
  audit: AgentBackend[];
  research: AgentBackend[];
}

function splitPaths(raw: string | undefined): string[] {
  if (!raw || raw.trim() === '') return [];
  return raw.split(';').map((s) => s.trim()).filter(Boolean);
}

function upliftRoot(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.UPLIFT_ROOT;
  if (root && root.trim()) return root.replace(/[/\\]+$/, '');
  return path.join('C:', 'Users', 'User', 'Downloads', 'Uplift');
}

function resolveConfigured(
  env: NodeJS.ProcessEnv,
  overrideKey: 'OPENHUB_AUDIT_AGENTS' | 'OPENHUB_RESEARCH_AGENTS',
  defaults: string[],
): string[] {
  const explicit = splitPaths(env[overrideKey]);
  return explicit.length > 0 ? explicit : defaults;
}

function defaultAuditPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const up = upliftRoot(env);
  // Every default must exist on a standard node: each entry backs a live
  // audit scorer (claw/sca <- Claw-Protect, grader <- Grader, reporank <-
  // reporank agent dir). Entries that do not exist degrade to present:false,
  // so dead defaults are a weak team — keep this list to real directories.
  return [
    path.join(up, 'Draymond-Orchestrator', 'agents', 'CodeNexus-main'),
    path.join(up, 'The Deep'),
    path.join(up, 'Draymond-Orchestrator', 'agents', 'Claw-Protect-main'),
    path.join(up, 'Draymond-Orchestrator', 'agents', 'deterministic-brain'),
    path.join(up, 'Draymond-Orchestrator', 'agents', 'Grader-main'),
  ];
}

function defaultResearchPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const up = upliftRoot(env);
  return [
    path.join(up, 'Draymond-Orchestrator', 'agents', 'OmniResearch-Pro-main'),
    path.join(up, 'Draymond-Orchestrator', 'agents', 'AgentBrowser-main'),
  ];
}

function readJson(p: string): Record<string, unknown> | null {
  try {
    if (!fs.statSync(p).isFile()) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function firstString(...values: unknown[]): string {
  for (const v of values) {
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return '';
}

const DESCRIPTION_CAP = 220;

function describeDir(dir: string, slug: string): { name: string; description: string; manifest: AgentBackend['manifest'] } {
  const agentJson = readJson(path.join(dir, 'agent.json'));
  if (agentJson) {
    const name = firstString(agentJson.name, agentJson.id, slug);
    const description = firstString(agentJson.description, agentJson.tagline, agentJson.bio, agentJson.role);
    return { name, description: description.slice(0, DESCRIPTION_CAP), manifest: 'agent.json' };
  }
  const metadata = readJson(path.join(dir, 'metadata.json'));
  if (metadata && (typeof metadata.name === 'string' || typeof metadata.description === 'string')) {
    const name = firstString(metadata.name, slug);
    const description = firstString(metadata.description);
    return { name, description: description.slice(0, DESCRIPTION_CAP), manifest: 'metadata.json' };
  }
  const pkg = readJson(path.join(dir, 'package.json'));
  if (pkg && (typeof pkg.name === 'string' || typeof pkg.description === 'string')) {
    const name = firstString(pkg.name, slug);
    const description = firstString(pkg.description);
    return { name, description: description.slice(0, DESCRIPTION_CAP), manifest: 'package.json' };
  }
  return {
    name: slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    description: 'On-disk agent directory (no manifest found).',
    manifest: 'directory',
  };
}

function buildBackend(role: AgentRole, dir: string): AgentBackend {
  const slug = path.basename(dir.replace(/[/\\]+$/, ''));
  const present = (() => {
    try {
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  })();
  const info = present ? describeDir(dir, slug) : { name: slug, description: 'Directory not found on disk.', manifest: null as AgentBackend['manifest'] };
  return { role, path: dir, slug, name: info.name, description: info.description, present, manifest: info.manifest };
}

/** Resolve the full audit + research agent roster for the current node. */
export function getAgentRoster(env: NodeJS.ProcessEnv = process.env): AgentRoster {
  const auditPaths = resolveConfigured(env, 'OPENHUB_AUDIT_AGENTS', defaultAuditPaths(env));
  const researchPaths = resolveConfigured(env, 'OPENHUB_RESEARCH_AGENTS', defaultResearchPaths(env));
  return {
    audit: auditPaths.map((p) => buildBackend('audit', p)),
    research: researchPaths.map((p) => buildBackend('research', p)),
  };
}
