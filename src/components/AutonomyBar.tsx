import { Activity, Brain, CheckCircle2, XCircle } from 'lucide-react';
import { useAutonomy } from '../hooks/useAutonomy';

/**
 * Live self-awareness strip. Renders the autonomy snapshot streamed from the
 * server with no operator action — services, Recourse, insights and severity
 * counts stay current on their own.
 */
export function AutonomyBar() {
  const { snapshot, connected } = useAutonomy();

  if (!snapshot) {
    return (
      <section className="industrial-card p-3 flex items-center gap-2 text-xs text-gray-400">
        <Brain className="w-4 h-4 text-accent animate-pulse" />
        Autonomy engine warming up — probing services and self-learning state…
      </section>
    );
  }

  const h = snapshot.health;
  const chips = [
    { label: 'Services', value: `${h.servicesUp}/${h.servicesTotal}`, ok: h.servicesTotal > 0 && h.servicesUp > 0 },
    { label: 'Recourse', value: h.recourseOnline ? 'online' : 'offline', ok: h.recourseOnline },
    { label: 'Insights', value: String(h.insightCount), ok: true },
    { label: 'High-sev', value: String(h.highSeverityEvents), ok: h.highSeverityEvents === 0 },
    { label: 'Pass rate', value: h.passRate === null ? '—' : `${Math.round(h.passRate * 100)}%`, ok: h.passRate === null || h.passRate >= 0.5 },
  ];

  return (
    <section className="industrial-card p-3 flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="flex items-center gap-2 pr-2">
        <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`} />
        <Activity className="w-4 h-4 text-accent" />
        <span className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-gray-400">
          Autonomy {connected ? 'live' : 'polling'} · tick {snapshot.tick}
        </span>
      </div>
      {chips.map((c) => (
        <div key={c.label} className="flex items-center gap-1.5">
          {c.ok ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> : <XCircle className="w-3.5 h-3.5 text-amber-400" />}
          <span className="font-mono text-[11px] text-gray-300">
            {c.label} <span className="text-[var(--color-text-primary)]">{c.value}</span>
          </span>
        </div>
      ))}
      {snapshot.degraded.length > 0 && (
        <span className="font-mono text-[10px] text-amber-300">degraded: {snapshot.degraded.join(', ')}</span>
      )}
    </section>
  );
}
