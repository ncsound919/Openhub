import { useEffect, useState } from 'react';
import {
  Database, Cloud, Github, Shield, Zap, Cpu, Loader2, RefreshCw,
  Server, FlaskConical, XCircle, CheckCircle2, Smartphone,
} from 'lucide-react';
import { useStore } from '../store';
import { getAuthHeaders } from '../auth/AuthProvider';
import { cn } from '../lib/utils';

type IntegrationStatus = {
  id: string;
  name: string;
  icon: typeof Github;
  /** null = no credential on this device: neither connected nor broken. */
  up: boolean | null;
  detail: string;
};

type ProviderHealth = {
  id: string;
  name: string;
  category: string;
  configured: boolean;
  up: boolean | null;
  detail: string;
  requires?: string;
};

type GitHubCredentialHealth = {
  key: string;
  present: boolean;
  valid: boolean;
  login: string | null;
  status: number | null;
  error?: string;
};

type KaggleKernel = { ref?: string; title?: string; lastRunTime?: string; [key: string]: unknown };

/**
 * Kaggle lane: the kernels the configured token can see, with live status and
 * output checks. This is the thin UI over /api/kaggle/* that the mobile plan
 * needed; the heavy job orchestration (kernel push) is still separate.
 */
function KaggleKernelsPanel() {
  const [state, setState] = useState<{ configured: boolean; authenticated: boolean } | null>(null);
  const [kernels, setKernels] = useState<KaggleKernel[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      const authRes = await fetch('/api/kaggle/auth', { credentials: 'include', headers: getAuthHeaders() });
      const auth = await authRes.json();
      setState(auth?.data ?? null);
      if (!auth?.data?.authenticated) {
        setKernels([]);
        return;
      }
      const res = await fetch('/api/kaggle/kernels', { credentials: 'include', headers: getAuthHeaders() });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || `Kernels request failed (HTTP ${res.status})`);
      setKernels(Array.isArray(json.data) ? (json.data as KaggleKernel[]).slice(0, 8) : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kaggle request failed');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const refOf = (k: KaggleKernel): string => {
    if (typeof k.ref === 'string' && k.ref.includes('/')) return k.ref;
    if (typeof k.owner === 'string' && typeof k.slug === 'string') return `${k.owner}/${k.slug}`;
    return '';
  };

  const check = async (ref: string, kind: 'status' | 'output') => {
    const [owner, slug] = ref.split('/');
    if (!owner || !slug) return;
    setNotes((n) => ({ ...n, [ref]: `${kind}…` }));
    try {
      const res = await fetch(
        kind === 'status'
          ? `/api/kaggle/kernels/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}/status`
          : `/api/kaggle/kernels/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}/output`,
        { credentials: 'include', headers: getAuthHeaders() },
      );
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || `Kaggle ${kind} failed (HTTP ${res.status})`);
      const note = kind === 'status'
        ? `status: ${String((json.data as { status?: unknown })?.status ?? 'unknown')}`
        : (json.data as { kind?: string; bytes?: number })?.kind === 'archive'
          ? `output: ${Number((json.data as { bytes?: number }).bytes ?? 0).toLocaleString()} bytes (archive)`
          : 'output: JSON payload';
      setNotes((n) => ({ ...n, [ref]: note }));
    } catch (err) {
      setNotes((n) => ({ ...n, [ref]: err instanceof Error ? err.message : 'failed' }));
    }
  };

  return (
    <section className="industrial-card p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="!text-base flex items-center gap-2"><FlaskConical className="w-4 h-4 text-emerald-300" /> Kaggle kernels</h2>
        <button onClick={() => void load()} className="inline-flex items-center gap-2 rounded-lg border border-border-muted bg-surface-base/70 px-3 py-1.5 text-xs font-bold text-gray-400 hover:border-blue-500/50">
          <RefreshCw className={cn('w-3.5 h-3.5', busy && 'animate-spin')} /> Refresh
        </button>
      </div>

      {state?.configured === false && (
        <p className="mt-3 rounded-md border border-border-muted bg-surface-base px-3 py-2 text-xs text-gray-400">
          Set <code className="font-mono text-gray-300">KAGGLE_API_TOKEN</code> on the server to list and drive kernels from here.
        </p>
      )}
      {state?.configured === true && state.authenticated === false && (
        <p className="mt-3 rounded-md border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-3 py-2 text-xs text-[var(--color-danger)]">
          The Kaggle token was rejected. Rotate <code className="font-mono">KAGGLE_API_TOKEN</code> and refresh.
        </p>
      )}
      {error && <p className="mt-3 text-xs text-[var(--color-danger)]">{error}</p>}
      {busy && kernels.length === 0 && !error && <p className="mt-3 text-xs text-gray-400">Reading kernels…</p>}

      {kernels.length > 0 && (
        <ul className="mt-3 space-y-2">
          {kernels.map((k, i) => {
            const ref = refOf(k);
            return (
              <li key={ref || i} className="flex flex-wrap items-center gap-2 rounded-md border border-border-muted bg-surface-base px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-[var(--color-text-primary)]" title={String(k.title ?? ref)}>{String(k.title ?? ref)}</div>
                  <div className="truncate font-mono text-[10px] text-gray-500">
                    {ref}
                    {typeof k.lastRunTime === 'string' ? ` · ran ${k.lastRunTime.slice(0, 16).replace('T', ' ')}` : ''}
                    {notes[ref] ? ` · ${notes[ref]}` : ''}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <button onClick={() => void check(ref, 'status')} disabled={!ref} className="inline-flex items-center gap-1 rounded border border-border-muted px-2 py-1 text-[10px] font-bold text-gray-400 hover:text-[var(--color-text-primary)] disabled:opacity-40">
                    <CheckCircle2 className="w-3 h-3" /> Status
                  </button>
                  <button onClick={() => void check(ref, 'output')} disabled={!ref} className="inline-flex items-center gap-1 rounded border border-border-muted px-2 py-1 text-[10px] font-bold text-gray-400 hover:text-[var(--color-text-primary)] disabled:opacity-40">
                    <XCircle className="w-3 h-3" /> Output
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {state?.authenticated === true && kernels.length === 0 && !busy && !error && (
        <p className="mt-3 text-xs text-gray-400">Token accepted, but this account has no kernels visible.</p>
      )}
    </section>
  );
}

/** Real integration status — no simulated providers or latency jitter. */
export function IntegrationsHub() {
  const repositories = useStore((s) => s.repositories);
  const [statuses, setStatuses] = useState<Record<string, { up: boolean; detail: string }>>({});
  const [providers, setProviders] = useState<ProviderHealth[]>([]);
  const [githubCredentials, setGithubCredentials] = useState<GitHubCredentialHealth[]>([]);
  const [vault, setVault] = useState<{ reachable: boolean; secretCount: number | null; project: string } | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    const get = async (url: string) => {
      try {
        const res = await fetch(url, { credentials: 'include', headers: getAuthHeaders() });
        return await res.json();
      } catch {
        return null;
      }
    };

    const [recourse, llm, health] = await Promise.all([
      get('/api/recourse/status'),
      get('/api/intelligence/llm'),
      get('/api/integrations/providers'),
    ]);

    setStatuses({
      recourse: {
        up: !!recourse?.available,
        detail: recourse?.available ? `generation ${recourse?.data?.status?.generation ?? '?'}` : (recourse?.error ?? 'offline'),
      },
      llm: {
        up: !!llm?.ok,
        detail: llm?.ok ? `${llm.models?.length ?? 0} models · ${llm.configuredModel ?? ''}` : (llm?.error ?? 'gateway offline'),
      },
    });

    setProviders(Array.isArray(health?.providers) ? (health.providers as ProviderHealth[]) : []);
    setGithubCredentials(Array.isArray(health?.githubCredentials) ? (health.githubCredentials as GitHubCredentialHealth[]) : []);
    setVault(health?.vault ? { reachable: !!health.vault.reachable, secretCount: health.vault.secretCount ?? null, project: health.vault.project } : null);
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

  const cloudLane = (id: string): { up: boolean | null; detail: string } => {
    const p = providers.find((x) => x.id === id);
    if (!p) return { up: null, detail: loading ? '…' : 'not reported' };
    return { up: p.up, detail: p.detail };
  };

  // GitHub's status is the credential probe, not "how many repos this account
  // happens to have loaded": a phone with a valid token but no repo yet used to
  // read "Error / not connected" while the card right above said Connected.
  const githubLane = cloudLane('github');
  const github: IntegrationStatus = githubLane.detail === 'not reported'
    ? { id: 'github', name: 'GitHub', icon: Github, up: null, detail: repositories.length > 0 ? `${repositories.length} repositories` : 'not connected' }
    : {
      id: 'github',
      name: 'GitHub',
      icon: Github,
      up: githubLane.up,
      detail: githubLane.up && repositories.length > 0 ? `${repositories.length} repos · ${githubLane.detail}` : githubLane.detail,
    };

  // Axiom was dropped from this fleet; only the opencode engine and the cloud
  // lanes are wired now. Its provider probe is still shown in Business providers
  // for anyone who re-enables it, but it is not scored as a missing integration.
  const integrations: IntegrationStatus[] = [
    github,
    { id: 'aws', name: 'AWS', icon: Server, ...cloudLane('aws') },
    { id: 'cloudflare', name: 'Cloudflare / R2', icon: Cloud, ...cloudLane('cloudflare') },
    { id: 'kaggle', name: 'Kaggle', icon: FlaskConical, ...cloudLane('kaggle') },
    { id: 'opencode', name: 'opencode Engine', icon: Cpu, ...cloudLane('opencode') },
    { id: 'local-model', name: 'Local model (phone)', icon: Smartphone, ...cloudLane('local-model') },
    { id: 'recourse', name: 'Recourse', icon: Cpu, up: statuses.recourse?.up ?? false, detail: statuses.recourse?.detail ?? '…' },
    { id: 'llm', name: 'LLM Gateway', icon: Database, up: statuses.llm?.up ?? false, detail: statuses.llm?.detail ?? '…' },
  ];

  const upCount = integrations.filter((i) => i.up === true).length;

  return (
    <div className="flex-1 w-full max-w-6xl mx-auto flex flex-col gap-5 px-4 py-6">
      <section className="gradient-hero rounded-2xl p-6 relative overflow-hidden">
        <div className="absolute -right-8 -top-12 opacity-[0.12] pointer-events-none">
          <Cloud className="w-56 h-56 text-blue-300" strokeWidth={1} />
        </div>
        <div className="flex items-center gap-2 text-[11px] font-extrabold uppercase tracking-[0.18em] text-emerald-300">
          <Shield className="w-3.5 h-3.5" /> Fleet integrations
        </div>
        <h2 className="mt-2">Integrations <span className="text-info">at a glance.</span></h2>
        <p className="mt-1.5 max-w-xl text-sm text-gray-400">
          Live status of the fleet services OpenHub is wired to — read from their real endpoints, never synthesized.
        </p>
        <div className="mt-4">
          <button onClick={() => void load()} className="inline-flex items-center gap-2 rounded-lg border border-border-muted bg-surface-base/70 px-4 py-2 text-sm font-bold text-gray-400 hover:border-blue-500/50">
            <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} /> Re-check
          </button>
        </div>
      </section>

      <section className="industrial-card p-5">
        <div className="flex items-center justify-between">
          <h2 className="!text-base flex items-center gap-2"><Zap className="w-4 h-4 text-blue-300" /> Business providers</h2>
          {vault && (
            <span className="font-mono text-[11px] text-gray-400">
              Keywire {vault.reachable ? 'reachable' : 'unreachable'} · {vault.secretCount ?? '?'} secrets
            </span>
          )}
        </div>
        {providers.length > 0 ? (
          <div className="mt-3 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {providers.map((p) => (
              <div key={p.id} className="industrial-card stat-tile p-4" style={{ ['--accent' as string]: p.up === true ? 'var(--color-success)' : p.up === false ? 'var(--color-danger)' : 'var(--color-border-muted)' }}>
                <div className="flex items-center gap-2 text-[10px] font-extrabold uppercase tracking-[0.14em] text-gray-400">
                  <span className="truncate">{p.name}</span>
                  <span className="ml-auto shrink-0 rounded-full border border-border-muted px-1.5 py-0.5 text-[11px] tracking-wide">{p.category}</span>
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <span className={cn('h-2 w-2 rounded-full', p.up === true ? 'bg-[var(--color-success)]' : p.up === false ? 'bg-[var(--color-danger)]' : 'bg-gray-500')} />
                  <span className="text-sm font-bold text-[var(--color-text-primary)]">
                    {p.up === true ? 'Connected' : p.up === false ? 'Error' : p.configured ? 'Needs setup' : 'Not configured'}
                  </span>
                </div>
                <div className="mt-0.5 text-[11px] text-gray-400">{p.detail}</div>
                {p.requires && <div className="mt-1 font-mono text-[10px] text-gray-500">requires: {p.requires}</div>}
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-3 text-sm text-gray-400">{loading ? 'Probing providers…' : 'No provider status available — the vault was unreachable.'}</div>
        )}

        {githubCredentials.length > 0 && (
          <div className="mt-4 border-t border-border-muted pt-3">
            <div className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-gray-400">GitHub vault credentials</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {githubCredentials.map((c) => (
                <span
                  key={c.key}
                  title={c.error || (c.login ? `@${c.login}` : '')}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px]',
                    c.valid
                      ? 'border-[var(--color-success)]/40 text-[var(--color-success)]'
                      : c.present
                        ? 'border-[var(--color-danger)]/40 text-[var(--color-danger)]'
                        : 'border-border-muted text-gray-500',
                  )}
                >
                  <span className={cn('h-1.5 w-1.5 rounded-full', c.valid ? 'bg-[var(--color-success)]' : c.present ? 'bg-[var(--color-danger)]' : 'bg-gray-600')} />
                  {c.key}
                  {c.valid && c.login ? ` · @${c.login}` : c.present ? ' · revoked' : ' · absent'}
                </span>
              ))}
            </div>
          </div>
        )}
      </section>

      <KaggleKernelsPanel />

      <section className="grid grid-cols-2 xl:grid-cols-4 gap-3" aria-label="Integration status">
        {integrations.map((i) => {
          const Icon = i.icon;
          return (
            <div key={i.id} className="industrial-card stat-tile p-4" style={{ ['--accent' as string]: i.up === true ? 'var(--color-success)' : i.up === false ? 'var(--color-danger)' : 'var(--color-border-muted)' }}>
              <div className="flex items-center gap-2 text-[10px] font-extrabold uppercase tracking-[0.14em] text-gray-400">
                <Icon className="w-3.5 h-3.5" /> {i.name}
              </div>
              <div className="mt-1.5 flex items-center gap-2">
                <span className={cn('h-2 w-2 rounded-full', i.up === true ? 'bg-[var(--color-success)]' : i.up === false ? 'bg-[var(--color-danger)]' : 'bg-gray-500')} />
                <span className="text-sm font-bold text-[var(--color-text-primary)]">{i.up === true ? 'Connected' : i.up === false ? 'Error' : 'Not configured'}</span>
              </div>
              <div className="mt-0.5 truncate text-[11px] text-gray-400" title={i.detail}>{i.detail}</div>
            </div>
          );
        })}
      </section>

      <section className="industrial-card p-5">
        <h2 className="!text-base flex items-center gap-2"><Shield className="w-4 h-4 text-emerald-400" /> Status</h2>
        <div className="mt-3 space-y-2">
          {integrations.map((i) => (
            <div key={i.id} className="flex items-center justify-between rounded-md border border-border-muted bg-surface-base px-3 py-2">
              <div className="flex items-center gap-2 min-w-0">
                <i.icon className="w-4 h-4 shrink-0 text-gray-400" />
                <span className="text-sm font-semibold text-[var(--color-text-primary)]">{i.name}</span>
              </div>
              <div className="flex items-center gap-2 min-w-0">
                <span className="truncate font-mono text-[11px] text-gray-400">{i.detail}</span>
                <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold', i.up === true ? 'bg-[color-mix(in_srgb,var(--color-success)_15%,transparent)] text-[var(--color-success)]' : i.up === false ? 'bg-[color-mix(in_srgb,var(--color-danger)_15%,transparent)] text-[var(--color-danger)]' : 'bg-[color-mix(in_srgb,var(--color-border-muted)_35%,transparent)] text-gray-400')}>
                  {i.up === true ? 'up' : i.up === false ? 'down' : 'unset'}
                </span>
              </div>
            </div>
          ))}
        </div>
        <p className="mt-3 flex items-center gap-1.5 text-[11px] text-gray-400">
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
          {upCount}/{integrations.length} integrations reachable. Additional providers are configured via environment, not this screen.
        </p>
      </section>
    </div>
  );
}