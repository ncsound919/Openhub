import { keywireSecretNames, keywireProject } from './keywire.js';
import { probeVaultGitHubCredentials, type VaultCredentialHealth } from './githubVaultAuth.js';
import { OPENCODE_BASE, basicAuthHeader } from './opencodeEngine.js';

/**
 * Real provider health for the Integrations surface.
 *
 * The previous screen read `/api/business/integrations`, which was removed in
 * the Axiom-only consolidation, so it always rendered "the vault was
 * unreachable". This rebuilds the same panel from live probes — Keywire vault
 * reachability, per-credential GitHub checks, and short HTTP probes of the fleet
 * services the IDE actually calls. Nothing is synthesized: an unreachable
 * provider reports `up: false` with its error.
 */

export interface ProviderHealth {
  id: string;
  name: string;
  category: string;
  configured: boolean;
  up: boolean | null;
  detail: string;
  requires?: string;
}

export interface ProviderHealthReport {
  ok: boolean;
  checkedAt: string;
  vault: { reachable: boolean; secretCount: number | null; project: string };
  providers: ProviderHealth[];
  githubCredentials: VaultCredentialHealth[];
}

export interface ProviderHealthDeps {
  secretNames: typeof keywireSecretNames;
  probeGitHub: typeof probeVaultGitHubCredentials;
  fetchImpl: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 4000;

function defaultDeps(): ProviderHealthDeps {
  return { secretNames: keywireSecretNames, probeGitHub: probeVaultGitHubCredentials, fetchImpl: fetch };
}

interface HttpProbe {
  up: boolean;
  status: number | null;
  error?: string;
}

async function probeHttp(url: string, path: string, deps: ProviderHealthDeps, headers?: Record<string, string>): Promise<HttpProbe> {
  const base = url.replace(/\/+$/, '');
  const target = `${base}${path}`;
  try {
    const res = await deps.fetchImpl(target, {
      method: 'GET',
      ...(headers ? { headers } : {}),
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    return { up: res.ok, status: res.status };
  } catch (err) {
    return { up: false, status: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function probeProviderHealth(
  env: NodeJS.ProcessEnv = process.env,
  deps: ProviderHealthDeps = defaultDeps(),
): Promise<ProviderHealthReport> {
  const checkedAt = new Date().toISOString();

  const [names, credentials] = await Promise.all([
    deps.secretNames(env).catch((): { available: boolean; data?: string[]; error?: string } => ({ available: false, error: 'Keywire unreachable' })),
    deps.probeGitHub(env).catch(() => [] as VaultCredentialHealth[]),
  ]);

  const secretCount = names.available && names.data ? names.data.length : null;
  const vault = {
    reachable: names.available === true,
    secretCount,
    project: keywireProject(env),
  };

  const validGithub = credentials.filter((c) => c.valid);
  const github: ProviderHealth = {
    id: 'github',
    name: 'GitHub',
    category: 'vcs',
    configured: credentials.some((c) => c.present),
    up: validGithub.length > 0,
    detail: validGithub.length
      ? `@${validGithub[0].login} (${validGithub.length}/${credentials.length} vault credentials valid)`
      : credentials.some((c) => c.present)
        ? `${credentials.filter((c) => c.present && !c.valid).map((c) => c.key).join(', ')} revoked/expired`
        : 'no GitHub credential in the vault',
    requires: 'GITHUB_TOKEN',
  };

  const keywire: ProviderHealth = {
    id: 'keywire',
    name: 'Keywire Vault',
    category: 'security',
    configured: true,
    up: vault.reachable,
    detail: vault.reachable ? `${secretCount ?? 0} secrets · ${vault.project}` : 'unreachable',
    requires: 'KEYWIRE_KEYS_FILE',
  };

  const axiomUrl = env.OPENHUB_AXIOM_URL || env.AXIOM_URL || 'http://127.0.0.1:3198';
  const opencodeUrl = env.OPENCODE_BASE_URL || OPENCODE_BASE;
  const recourseUrl = env.RECOURSE_URL || 'http://127.0.0.1:3050';
  const llmUrl = env.OPENHUB_LLM_BASE_URL || 'http://127.0.0.1:4100';
  const browserUrl = env.OPENHUB_AGENTBROWSER_URL || 'http://127.0.0.1:3700';

  const [axiom, opencode, recourse, llm, browser] = await Promise.all([
    probeHttp(axiomUrl, '/api/health', deps),
    probeHttp(opencodeUrl, '/global/health', deps, { Authorization: basicAuthHeader() }),
    probeHttp(recourseUrl, '/api/recourse/status', deps),
    probeHttp(llmUrl, '/health/liveliness', deps),
    probeHttp(browserUrl, '/api/system/health', deps),
  ]);

  const httpProvider = (
    id: string, name: string, category: string, probe: HttpProbe, url: string, requires?: string,
  ): ProviderHealth => ({
    id,
    name,
    category,
    configured: true,
    up: probe.up,
    detail: probe.up ? `${url} ok` : (probe.error || `HTTP ${probe.status ?? 'no response'}`),
    ...(requires ? { requires } : {}),
  });

  return {
    ok: true,
    checkedAt,
    vault,
    providers: [
      github,
      keywire,
      httpProvider('axiom', 'Axiom Harness', 'core', axiom, axiomUrl),
      httpProvider('opencode', 'opencode Engine', 'core', opencode, opencodeUrl),
      httpProvider('recourse', 'Recourse', 'memory', recourse, recourseUrl),
      httpProvider('llm', 'LLM Gateway', 'llm', llm, llmUrl, 'OPENHUB_LLM_BASE_URL'),
      httpProvider('agentbrowser', 'AgentBrowser', 'browser', browser, browserUrl, 'AGENTBROWSER_API_KEY'),
    ],
    githubCredentials: credentials,
  };
}
