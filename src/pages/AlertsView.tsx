import { useCallback, useEffect, useState } from 'react';
import { getAuthHeaders } from '../auth/AuthProvider';

interface Incident {
  id: string;
  source: string;
  kind: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  detail: string;
  dedupKey: string;
  dispatched: boolean;
  createdAt: string;
}

interface AlertsHealth {
  generatedAt: string;
  incidents: Incident[];
  dispatch: { inFlight: boolean; queued: number };
  bySeverity24h: Record<string, number>;
  backup: { ok: boolean | null; reason?: string; detail?: unknown };
}

const SEVERITY_STYLE: Record<string, string> = {
  critical: 'bg-red-500/15 text-red-300 border-red-500/30',
  high: 'bg-orange-500/15 text-orange-300 border-orange-500/30',
  medium: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  low: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
};

export function AlertsView() {
  const [data, setData] = useState<AlertsHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/alerts/health', { headers: getAuthHeaders(), credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load alerts');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => { void load(); }, 30_000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="flex flex-1 flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">Alerts</h1>
          <p className="text-xs text-[var(--color-text-muted)]">
            Draymond/Keywire security alerts surfaced through the incident bus.
          </p>
        </div>
        <button
          onClick={() => void load()}
          className="rounded border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
        >
          Refresh
        </button>
      </header>

      {loading && <div className="text-sm text-[var(--color-text-muted)]">Loading…</div>}
      {error && <div className="rounded border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">{error}</div>}

      {data && (
        <>
          <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {(['critical', 'high', 'medium', 'low'] as const).map((sev) => (
              <div key={sev} className={`rounded border p-3 ${SEVERITY_STYLE[sev]}`}>
                <div className="text-2xl font-semibold">{data.bySeverity24h[sev] ?? 0}</div>
                <div className="text-xs uppercase tracking-wide opacity-80">{sev} · 24h</div>
              </div>
            ))}
          </section>

          <section className="rounded border border-[var(--color-border)] p-4">
            <div className="mb-2 text-xs uppercase tracking-wide text-[var(--color-text-muted)]">Backup integrity</div>
            {data.backup.ok === true && <div className="text-sm text-green-300">Healthy</div>}
            {data.backup.ok === false && <div className="text-sm text-red-300">UNHEALTHY — see detail</div>}
            {data.backup.ok === null && (
              <div className="text-sm text-amber-300">Unknown — {data.backup.reason ?? 'not reported'}</div>
            )}
            {data.backup.detail != null && (
              <pre className="mt-2 overflow-x-auto rounded bg-black/30 p-2 text-[11px] text-[var(--color-text-muted)]">
                {JSON.stringify(data.backup.detail, null, 2)}
              </pre>
            )}
          </section>

          <section className="rounded border border-[var(--color-border)]">
            <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-2">
              <div className="text-xs uppercase tracking-wide text-[var(--color-text-muted)]">Recent incidents</div>
              <div className="text-[11px] text-[var(--color-text-muted)]">
                dispatch: {data.dispatch.inFlight ? 'in-flight' : 'idle'} · queued {data.dispatch.queued}
              </div>
            </div>
            {data.incidents.length === 0 ? (
              <div className="p-4 text-sm text-[var(--color-text-muted)]">No incidents recorded.</div>
            ) : (
              <ul className="divide-y divide-[var(--color-border)]">
                {data.incidents.map((inc) => (
                  <li key={inc.id} className="flex flex-col gap-1 px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className={`rounded border px-1.5 py-0.5 text-[10px] uppercase ${SEVERITY_STYLE[inc.severity] ?? ''}`}>
                        {inc.severity}
                      </span>
                      <span className="text-sm text-[var(--color-text-primary)]">{inc.kind}</span>
                      <span className="text-[11px] text-[var(--color-text-muted)]">
                        {inc.source} · {new Date(inc.createdAt).toLocaleString()}
                        {inc.dispatched ? ' · dispatched' : ''}
                      </span>
                    </div>
                    <div className="text-xs text-[var(--color-text-muted)]">{inc.detail}</div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
