import { useEffect, useState } from 'react';
import {
  Database, Cloud, Github, Shield, Zap, Cpu, Loader2, RefreshCw,
} from 'lucide-react';
import { useStore } from '../store';
import { getAuthHeaders } from '../auth/AuthProvider';
import { cn } from '../lib/utils';

type IntegrationStatus = {
  id: string;
  name: string;
  icon: typeof Github;
  up: boolean;
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

/** Real integration status — no simulated providers or latency jitter. */
export function IntegrationsHub() {
  const repositories = useStore((s) => s.repositories);
  const [statuses, setStatuses] = useState<Record<string, { up: boolean; detail: string }>>({});
  const [providers, setProviders] = useState<ProviderHealth[]>([]);
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

    const [recourse, llm, axiom, business] = await Promise.all([
      get('/api/recourse/status'),
      get('/api/intelligence/llm'),
      get('/api/axiom/status'),
      get('/api/business/integrations'),
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
      axiom: {
        up: !!(axiom?.ok && axiom?.data?.status === 'ok'),
        detail: axiom?.data?.status === 'ok' ? 'loop harness online' : 'offline',
      },
    });

    setProviders(Array.isArray(business?.integrations) ? (business.integrations as ProviderHealth[]) : []);
    setVault(business?.vault ? { reachable: !!business.vault.reachable, secretCount: business.vault.secretCount ?? null, project: business.vault.project } : null);
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

  const githubConnected = repositories.length > 0;

  const integrations: IntegrationStatus[] = [
    { id: 'github', name: 'GitHub', icon: Github, up: githubConnected, detail: githubConnected ? `${repositories.length} repositories` : 'not connected' },
    { id: 'recourse', name: 'Recourse', icon: Cpu, up: statuses.recourse?.up ?? false, detail: statuses.recourse?.detail ?? '…' },
    { id: 'llm', name: 'LLM Gateway', icon: Database, up: statuses.llm?.up ?? false, detail: statuses.llm?.detail ?? '…' },
    { id: 'axiom', name: 'Axiom', icon: Zap, up: statuses.axiom?.up ?? false, detail: statuses.axiom?.detail ?? '…' },
  ];

  const upCount = integrations.filter((i) => i.up).length;

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
      </section>

      <section className="grid grid-cols-2 xl:grid-cols-4 gap-3" aria-label="Integration status">
        {integrations.map((i) => {
          const Icon = i.icon;
          return (
            <div key={i.id} className="industrial-card stat-tile p-4" style={{ ['--accent' as string]: i.up ? 'var(--color-success)' : 'var(--color-danger)' }}>
              <div className="flex items-center gap-2 text-[10px] font-extrabold uppercase tracking-[0.14em] text-gray-400">
                <Icon className="w-3.5 h-3.5" /> {i.name}
              </div>
              <div className="mt-1.5 flex items-center gap-2">
                <span className={cn('h-2 w-2 rounded-full', i.up ? 'bg-[var(--color-success)]' : 'bg-[var(--color-danger)]')} />
                <span className="text-sm font-bold text-[var(--color-text-primary)]">{i.up ? 'Connected' : 'Offline'}</span>
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
                <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold', i.up ? 'bg-[color-mix(in_srgb,var(--color-success)_15%,transparent)] text-[var(--color-success)]' : 'bg-[color-mix(in_srgb,var(--color-danger)_15%,transparent)] text-[var(--color-danger)]')}>
                  {i.up ? 'up' : 'down'}
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