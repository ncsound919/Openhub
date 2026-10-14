import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, Play, Square, RefreshCw, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { getCsrfToken, getAuthHeaders } from '../auth/AuthProvider';
import { StatusLight } from '../components/StatusLight';

interface ServiceItem {
  slug: string;
  name: string;
  port: number;
  up: boolean;
  pid: number | null;
  category: string;
  uptimeSeconds?: number;
}

const CATEGORY_LABELS: Record<string, string> = {
  core: 'Core',
  audit: 'Audit team',
  repair: 'Repair team',
  llm: 'Models',
  game: 'Game',
};

const CATEGORY_ORDER = ['core', 'audit', 'repair', 'llm', 'game'];

/**
 * Services lifecycle — the operable Fleet surface. The whole fleet, a category
 * ("audit team", "repair team"), or a single service can be started or stopped;
 * starting a down service launches its server on demand.
 */
export function ServicesLifecycleView() {
  const [services, setServices] = useState<ServiceItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const fetchServices = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/lifecycle/services', { credentials: 'include', headers: getAuthHeaders() });
      const data = await res.json();
      if (data.ok && Array.isArray(data.services)) setServices(data.services);
    } catch { /* leave prior state */ }
    setLoading(false);
  }, []);

  useEffect(() => { void fetchServices(); }, [fetchServices]);

  const post = async (key: string, path: string, label: string) => {
    setBusy(key);
    setNote(null);
    try {
      const res = await fetch(path, {
        method: 'POST',
        credentials: 'include',
        headers: { ...getAuthHeaders(), 'X-CSRF-Token': getCsrfToken() },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        setNote(`${label} failed: ${data?.error ?? data?.message ?? `HTTP ${res.status}`}`);
      }
      await fetchServices();
    } catch (e) {
      setNote(`${label} failed: ${e instanceof Error ? e.message : 'request error'}`);
    } finally {
      setBusy(null);
    }
  };

  const groups = useMemo(() => {
    const byCat = new Map<string, ServiceItem[]>();
    for (const s of services) {
      const list = byCat.get(s.category) ?? [];
      list.push(s);
      byCat.set(s.category, list);
    }
    const cats = [...byCat.keys()].sort((a, b) => {
      const ia = CATEGORY_ORDER.indexOf(a);
      const ib = CATEGORY_ORDER.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
    });
    return cats.map((cat) => ({ cat, items: byCat.get(cat) ?? [] }));
  }, [services]);

  const online = services.filter((s) => s.up).length;
  const fleetUp = services.length > 0 && online === services.length;

  return (
    <div className="flex-1 w-full max-w-6xl mx-auto flex flex-col gap-4 px-4 py-6">
      {/* Fleet controls */}
      <section className="industrial-card px-4 py-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <StatusLight
          state={services.length === 0 ? 'idle' : fleetUp ? 'ok' : online > 0 ? 'warn' : 'offline'}
          label={`Fleet ${online}/${services.length} up`}
          title="Services currently online"
        />
        <span className="text-[11px] text-[var(--color-text-muted)]">Start a down service to launch its server on demand.</span>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            onClick={() => void post('fleet', '/api/lifecycle/all/start', 'Start fleet')}
            disabled={busy !== null || loading}
            className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {busy === 'fleet' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />} Start fleet
          </button>
          <button
            onClick={() => void post('fleet', '/api/lifecycle/all/stop', 'Stop fleet')}
            disabled={busy !== null || loading}
            className="inline-flex items-center gap-1.5 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs font-bold text-red-300 hover:bg-red-500/20 disabled:opacity-50"
          >
            <Square className="w-3.5 h-3.5" /> Stop fleet
          </button>
          <button
            onClick={() => void fetchServices()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-md border border-border-muted bg-surface-base/70 px-2.5 py-1.5 text-xs font-bold text-gray-400 hover:text-[var(--color-text-primary)] disabled:opacity-50"
            title="Refresh"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
        {note && <p className="basis-full text-[11px] text-[var(--color-danger)]">{note}</p>}
      </section>

      {services.length === 0 ? (
        <div className="industrial-card p-8 text-center">
          <Activity className="w-7 h-7 mx-auto text-gray-400" />
          <p className="mt-2 text-sm font-bold text-[var(--color-text-primary)]">{loading ? 'Reading services…' : 'No services found'}</p>
          <p className="mt-1 text-xs text-gray-400">Refresh to re-query the lifecycle endpoint.</p>
        </div>
      ) : (
        groups.map(({ cat, items }) => {
          const upCount = items.filter((s) => s.up).length;
          return (
            <section key={cat} className="space-y-2">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-industrial tracking-tight text-[var(--color-text-primary)]">{CATEGORY_LABELS[cat] ?? cat}</h3>
                <StatusLight state={upCount === items.length ? 'ok' : upCount > 0 ? 'warn' : 'offline'} label={`${upCount}/${items.length}`} />
                <div className="ml-auto flex items-center gap-1.5">
                  <button
                    onClick={() => void post(`g:${cat}`, `/api/lifecycle/groups/${cat}/start`, `Start ${cat}`)}
                    disabled={busy !== null || loading}
                    className="rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[10px] font-bold text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-50"
                  >
                    {busy === `g:${cat}` ? 'Starting…' : 'Start all'}
                  </button>
                  <button
                    onClick={() => void post(`g:${cat}`, `/api/lifecycle/groups/${cat}/stop`, `Stop ${cat}`)}
                    disabled={busy !== null || loading}
                    className="rounded border border-border-muted px-2 py-1 text-[10px] font-bold text-gray-400 hover:text-red-300 disabled:opacity-50"
                  >
                    Stop all
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                {items.map((svc) => (
                  <div key={svc.slug} className="industrial-card p-3 flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <StatusLight state={svc.up ? 'ok' : 'offline'} dotOnly title={svc.up ? 'online' : 'stopped'} />
                        <span className="truncate text-xs font-bold text-[var(--color-text-primary)]">{svc.name}</span>
                      </div>
                      <div className="mt-0.5 truncate font-mono text-[10px] text-gray-400">
                        :{svc.port} · pid {svc.pid ?? '—'}{svc.uptimeSeconds != null ? ` · up ${svc.uptimeSeconds}s` : ''}
                      </div>
                    </div>
                    {svc.up ? (
                      <button
                        onClick={() => void post(svc.slug, `/api/lifecycle/services/${svc.slug}/stop`, `Stop ${svc.slug}`)}
                        disabled={busy === svc.slug}
                        className="shrink-0 inline-flex items-center gap-1 rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-[10px] font-bold text-red-300 hover:bg-red-500/20 disabled:opacity-40"
                      >
                        {busy === svc.slug ? <Loader2 className="w-3 h-3 animate-spin" /> : <Square className="w-3 h-3" />} Stop
                      </button>
                    ) : (
                      <button
                        onClick={() => void post(svc.slug, `/api/lifecycle/services/${svc.slug}/start`, `Start ${svc.slug}`)}
                        disabled={busy === svc.slug}
                        className="shrink-0 inline-flex items-center gap-1 rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[10px] font-bold text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-40"
                      >
                        {busy === svc.slug ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />} Start
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}
