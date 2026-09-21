import React from 'react';
import { Loader2, Play, Square, RefreshCw } from 'lucide-react';
import { getAuthHeaders, getCsrfToken } from '../auth/AuthProvider';
import { cn } from '../lib/utils';

type Service = {
  slug: string;
  name: string;
  port: number;
  up: boolean;
  pid: number | null;
  category: 'core' | 'audit' | 'repair' | 'llm';
  uptimeSeconds?: number;
};

/** Services dock — the running dev environment: ports, health, start/stop. */
export function ServicesDock() {
  const [services, setServices] = React.useState<Service[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [busySlug, setBusySlug] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const load = async () => {
    try {
      const res = await fetch('/api/lifecycle/services', { credentials: 'include', headers: getAuthHeaders() });
      const json = await res.json();
      if (json.ok && Array.isArray(json.services)) setServices(json.services);
    } catch { /* offline */ } finally {
      setLoading(false);
    }
  };

  React.useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15000);
    return () => clearInterval(t);
  }, []);

  const toggle = async (s: Service) => {
    if (s.up && !window.confirm(`Stop ${s.name}? Any process it owns will be terminated.`)) return;
    setBusySlug(s.slug);
    setError(null);
    try {
      const res = await fetch(`/api/lifecycle/services/${s.slug}/${s.up ? 'stop' : 'start'}`, {
        method: 'POST',
        credentials: 'include',
        headers: { ...getAuthHeaders(), 'X-CSRF-Token': getCsrfToken() },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.ok === false) throw new Error(json.error || `Service ${s.up ? 'stop' : 'start'} failed (HTTP ${res.status})`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Service action failed');
    } finally {
      setBusySlug(null);
    }
  };

  const up = services.filter((s) => s.up).length;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
        <span>Services · {up}/{services.length}</span>
        <button onClick={() => void load()} className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]" title="Refresh">
          <RefreshCw className={cn('w-3 h-3', loading && 'animate-spin')} />
        </button>
      </div>
      {error && (
        <div role="alert" className="mx-2 mb-1 rounded border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-2 py-1 text-[10px] text-[var(--color-danger)]">
          {error}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 space-y-1.5">
        {loading && services.length === 0 ? (
          <div className="flex items-center gap-2 px-2 py-3 text-xs text-[var(--color-text-muted)]">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Reading service catalog…
          </div>
        ) : services.length === 0 ? (
          <div className="px-2 py-3 text-xs text-[var(--color-text-muted)]">No services configured.</div>
        ) : (
          services.map((s) => (
            <div key={s.slug} className="rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-base)] px-2.5 py-2">
              <div className="flex items-center gap-2">
                <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', s.up ? 'bg-[var(--color-success)]' : 'bg-[var(--color-text-muted)]')} />
                <span className="min-w-0 flex-1 truncate text-xs font-semibold text-[var(--color-text-primary)]" title={s.slug}>{s.name}</span>
                <button
                  onClick={() => void toggle(s)}
                  disabled={busySlug === s.slug}
                  className={cn(
                    'flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold disabled:opacity-40',
                    s.up
                      ? 'border border-[var(--color-border-muted)] text-[var(--color-text-muted)] hover:text-[var(--color-danger)]'
                      : 'bg-[var(--color-accent)] text-[var(--color-text-primary)] hover:bg-[var(--color-accent-hover)]',
                  )}
                >
                  {busySlug === s.slug ? <Loader2 className="w-3 h-3 animate-spin" /> : s.up ? <Square className="w-3 h-3" /> : <Play className="w-3 h-3" />}
                  {s.up ? 'Stop' : 'Start'}
                </button>
              </div>
              <div className="mt-1 flex items-center gap-2 font-mono text-[10px] text-[var(--color-text-muted)]">
                <span>{s.category}</span>
                {s.port > 0 && <span>· :{s.port}</span>}
                {s.pid != null && <span>· pid {s.pid}</span>}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}