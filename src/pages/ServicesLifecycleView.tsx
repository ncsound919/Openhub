import { useEffect, useState } from 'react';
import { Activity, Play, Square, RefreshCw, CheckCircle2, XCircle } from 'lucide-react';
import { getCsrfToken, getAuthHeaders } from '../auth/AuthProvider';

interface ServiceItem {
  slug: string;
  name: string;
  port: number;
  up: boolean;
  pid: number | null;
  category: string;
  uptimeSeconds?: number;
}

export function ServicesLifecycleView() {
  const [services, setServices] = useState<ServiceItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionSlug, setActionSlug] = useState<string | null>(null);

  const fetchServices = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/lifecycle/services', { credentials: 'include', headers: getAuthHeaders() });
      const data = await res.json();
      if (data.ok && Array.isArray(data.services)) {
        setServices(data.services);
      }
    } catch {}
    setLoading(false);
  };

  useEffect(() => {
    fetchServices();
  }, []);

  const handleStart = async (slug: string) => {
    setActionSlug(slug);
    try {
      await fetch(`/api/lifecycle/services/${slug}/start`, { method: 'POST', credentials: 'include', headers: { ...getAuthHeaders(), 'X-CSRF-Token': getCsrfToken() } });
      await fetchServices();
    } catch {}
    setActionSlug(null);
  };

  const handleStop = async (slug: string) => {
    setActionSlug(slug);
    try {
      await fetch(`/api/lifecycle/services/${slug}/stop`, { method: 'POST', credentials: 'include', headers: { ...getAuthHeaders(), 'X-CSRF-Token': getCsrfToken() } });
      await fetchServices();
    } catch {}
    setActionSlug(null);
  };

  const online = services.filter((s) => s.up).length;
  const stopped = services.length - online;
  const categories = new Set(services.map((s) => s.category)).size;
  const onlinePct = services.length ? Math.round((online / services.length) * 100) : 0;

  const stats = [
    { label: 'Services', value: String(services.length), sub: `${categories} categories`, accent: 'var(--color-info)', accent2: 'var(--color-accent)', pct: services.length ? Math.min(100, services.length * 20) : 0 },
    { label: 'Online', value: String(online), sub: 'pid-gated workers up', accent: 'var(--color-success)', accent2: 'var(--color-success)', pct: onlinePct },
    { label: 'Stopped', value: String(stopped), sub: 'ready to launch', accent: 'var(--color-warning)', accent2: 'var(--color-warning)', pct: services.length ? 100 - onlinePct : 0 },
    { label: 'Mode', value: 'On-demand', sub: 'resources conserved', accent: 'var(--color-accent)', accent2: 'var(--color-accent)', pct: onlinePct },
  ];

  return (
    <div className="flex-1 w-full max-w-6xl mx-auto flex flex-col gap-5 px-4 py-6">
      {/* Hero */}
      <section className="gradient-hero rounded-2xl p-6 relative overflow-hidden">
        <div className="absolute -right-8 -top-12 opacity-[0.12] pointer-events-none">
          <Activity className="w-56 h-56 text-emerald-300" strokeWidth={1} />
        </div>
        <div className="flex items-center gap-2 text-[11px] font-extrabold uppercase tracking-[0.18em] text-emerald-300">
          <span className={`w-1.5 h-1.5 rounded-full ${online > 0 ? 'bg-emerald-400 animate-pulse' : 'bg-surface-overlay'}`} />
          Lifecycle · Safe pid-gated workers
        </div>
        <h2 className="mt-2">Services <span className="text-info">on demand.</span></h2>
        <p className="mt-1.5 max-w-xl text-sm text-gray-400">Open code, audit, and repair workers only when needed.</p>
        <div className="mt-4">
          <button
            onClick={fetchServices}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-lg border border-border-muted bg-surface-base/70 px-4 py-2 text-sm font-bold text-gray-400 hover:border-blue-500/50 disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>
      </section>

      {/* Stats */}
      <section className="grid grid-cols-2 xl:grid-cols-4 gap-3" aria-label="Service status">
        {stats.map((s) => (
          <div key={s.label} className="industrial-card stat-tile p-4" style={{ ['--accent' as string]: s.accent, ['--accent2' as string]: s.accent2 }}>
            <div className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-gray-400">{s.label}</div>
            <div className="mt-1 truncate text-2xl font-extrabold text-[var(--color-text-primary)] tracking-tight">{s.value}</div>
            <div className="mt-0.5 truncate text-[11px] text-gray-400">{s.sub}</div>
            <div className="meter mt-2.5"><span style={{ width: `${s.pct}%` }} /></div>
          </div>
        ))}
      </section>

      {services.length === 0 ? (
        <div className="industrial-card p-8 text-center">
          <Activity className="w-7 h-7 mx-auto text-gray-400" />
          <p className="mt-2 text-sm font-bold text-[var(--color-text-primary)]">{loading ? 'Reading services…' : 'No services found'}</p>
          <p className="mt-1 text-xs text-gray-400">Refresh to re-query the lifecycle endpoint.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {services.map((svc) => (
            <div key={svc.slug} className="industrial-card clickable p-4 flex flex-col justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-bold text-[var(--color-text-primary)]">{svc.name}</span>
                  <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] font-bold uppercase ${svc.up ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-border-muted bg-surface-overlay text-gray-400'}`}>
                    {svc.up ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
                    {svc.up ? 'Online' : 'Stopped'}
                  </span>
                </div>
                <div className="mt-2 space-y-0.5 font-mono text-[11px] text-gray-400">
                  <div className="truncate">:{svc.port} · pid <span className="text-gray-400">{svc.pid ?? '—'}</span></div>
                  <div className="truncate uppercase">{svc.category}{svc.uptimeSeconds != null ? ` · up ${svc.uptimeSeconds}s` : ''}</div>
                </div>
              </div>
              <div className="border-t border-surface-overlay pt-3">
                {svc.up ? (
                  <button
                    onClick={() => handleStop(svc.slug)}
                    disabled={actionSlug === svc.slug}
                    className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 py-2 font-mono text-xs font-bold text-red-300 hover:bg-red-500/20 disabled:opacity-40"
                  >
                    <Square className="w-3 h-3" /> {actionSlug === svc.slug ? 'Stopping…' : 'Stop'}
                  </button>
                ) : (
                  <button
                    onClick={() => handleStart(svc.slug)}
                    disabled={actionSlug === svc.slug}
                    className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 py-2 font-mono text-xs font-bold text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-40"
                  >
                    <Play className="w-3 h-3" /> {actionSlug === svc.slug ? 'Launching…' : 'Launch'}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
