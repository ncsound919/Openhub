import React, { useCallback, useEffect, useState } from 'react';
import { getAuthHeaders } from '../auth/AuthProvider';
import { cn } from '../lib/utils';

interface TeamTool { id: string; label: string; mode: 'http' | 'local'; method?: string; path?: string; }
interface TeamSpec { id: string; label: string; description: string; tools: TeamTool[]; enabled: boolean; baseUrl?: string; }

interface Catalog { teams: TeamSpec[]; jobTypes: Record<string, string[]>; }
interface ToolRun { id: string; label: string; result: { ok: boolean; status?: number; error?: string; data?: unknown }; }
interface TeamRunResult { team: string; busy: boolean; tools: ToolRun[]; }
interface DraymondRoutines { day: { ok: boolean; data?: unknown; error?: string }; schedules: { ok: boolean; data?: unknown; error?: string }; jobTypes: Record<string, string[]>; }
interface SynergyOverview { recourse: { synergyMap?: { ok?: boolean; data?: unknown; error?: string }; candidates?: { ok?: boolean; data?: unknown }; learnStatus?: { ok?: boolean; data?: unknown } }; draymond?: { lessons?: { ok?: boolean; data?: unknown; error?: string } }; }

function summary(result: ToolRun['result']): string {
  if (result.error) return `✗ ${result.error.slice(0, 120)}`;
  const d = result.data as { success?: boolean; jev?: { ok?: boolean; source?: string; error?: string } } | undefined;
  const jev = d?.jev;
  if (jev) return `${jev.ok === false ? '✗' : '✓'} jev:${jev.source ?? '?'}${jev.error ? ` ${jev.error.slice(0, 100)}` : ''}`;
  if (d && typeof d.success === 'boolean') return `✓ success:${d.success}`;
  return `✓ HTTP ${result.status ?? 200}`;
}

export function TeamControlView() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [draymond, setDraymond] = useState<DraymondRoutines | null>(null);
  const [synergy, setSynergy] = useState<SynergyOverview | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [results, setResults] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [c, d, s] = await Promise.all([
        fetch('/api/teams', { headers: getAuthHeaders() }),
        fetch('/api/jobs/draymond', { headers: getAuthHeaders() }),
        fetch('/api/teams/synergy', { headers: getAuthHeaders() }),
      ]);
      const cj = await c.json();
      const dj = await d.json();
      const sj = await s.json();
      setCatalog(cj.ok ? cj : null);
      setDraymond(dj.ok ? dj : null);
      setSynergy(sj.ok ? sj : null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const run = useCallback(async (url: string, key: string, payload: Record<string, unknown> = {}) => {
    setBusy((b) => ({ ...b, [key]: true }));
    setResults((r) => ({ ...r, [key]: undefined }));
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ payload }),
      });
      const json = await res.json();
      setResults((r) => ({ ...r, [key]: json }));
    } catch (e) {
      setResults((r) => ({ ...r, [key]: { ok: false, error: e instanceof Error ? e.message : String(e) } }));
    } finally {
      setBusy((b) => ({ ...b, [key]: false }));
    }
  }, []);

  const runTeam = (id: string) => run(`/api/teams/${id}/run`, `team:${id}`);
  const runJob = (type: string, payload: Record<string, unknown> = {}) => run(`/api/jobs/${type}/run`, `job:${type}`, payload);

  const renderTeamRun = (id: string) => {
    const r = results[`team:${id}`] as TeamRunResult | undefined;
    if (!r) return null;
    if (r.busy) return <div className="text-xs text-amber-400">busy — a run is already in flight</div>;
    return (
      <div className="mt-2 space-y-1 text-xs">
        {r.tools.map((t) => (
          <div key={t.id} className="flex gap-2">
            <span className="shrink-0">{t.result.ok ? '✓' : '✗'}</span>
            <span className="text-[var(--color-text-secondary)]">{t.label}</span>
            <span className="font-mono text-[var(--color-text-muted)]">{summary(t.result)}</span>
          </div>
        ))}
      </div>
    );
  };

  const renderJobRun = (type: string) => {
    const r = results[`job:${type}`] as { jobType?: string; teams?: string[]; results?: TeamRunResult[]; learn?: unknown } | undefined;
    if (!r || !r.results) return null;
    return (
      <div className="mt-2 space-y-1 text-xs">
        <div className="text-[var(--color-text-muted)]">teams called: {r.teams?.join(', ')}</div>
        {r.results.map((tr) =>
          tr.busy ? (
            <div key={tr.team} className="text-amber-400">team {tr.team} busy</div>
          ) : (
            tr.tools.map((t) => (
              <div key={`${tr.team}:${t.id}`} className="flex gap-2">
                <span className="shrink-0">{t.result.ok ? '✓' : '✗'}</span>
                <span className="text-[var(--color-text-secondary)]">[{tr.team}] {t.label}</span>
                <span className="font-mono text-[var(--color-text-muted)]">{summary(t.result)}</span>
              </div>
            ))
          ),
        )}
        {r.learn ? <div className="pt-1 text-[11px] text-[var(--color-text-muted)]">learning fed: Recourse memory/episode + Draymond outcome</div> : null}
      </div>
    );
  };

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-text-primary)]">Tool Teams</h1>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Job types call only the teams they need — nothing runs all at once. Per-team busy guard prevents stacked runs.
          </p>
        </div>
        <button
          onClick={refresh}
          className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]"
        >
          Refresh
        </button>
      </div>

      {error && <div className="mb-4 rounded-md border border-[var(--color-danger)] p-3 text-sm text-[var(--color-danger)]">{error}</div>}

      {/* Job types → teams */}
      {catalog && (
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold text-[var(--color-text-primary)]">Job types → teams</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Object.entries(catalog.jobTypes).map(([type, teams]) => (
              <div key={type} className="rounded-lg border border-[var(--color-border)] p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-medium text-[var(--color-text-primary)]">{type}</span>
                  <button
                    onClick={() => runJob(type)}
                    disabled={busy[`job:${type}`]}
                    className="rounded-md bg-[var(--color-accent)] px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50"
                  >
                    {busy[`job:${type}`] ? 'Running…' : 'Run'}
                  </button>
                </div>
                <div className="flex flex-wrap gap-1">
                  {teams.map((t) => (
                    <span key={t} className="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[11px] text-[var(--color-text-secondary)]">
                      {t}
                    </span>
                  ))}
                </div>
                {renderJobRun(type)}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Teams & tools */}
      {catalog && (
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold text-[var(--color-text-primary)]">Teams & tools</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {catalog.teams.map((team) => (
              <div key={team.id} className={cn('rounded-lg border p-3', team.enabled ? 'border-[var(--color-border)]' : 'border-dashed border-[var(--color-border-muted)]')}>
                <div className="mb-2 flex items-center justify-between">
                  <div>
                    <span className="text-sm font-medium text-[var(--color-text-primary)]">{team.label}</span>
                    <span className="ml-2 text-[11px] text-[var(--color-text-muted)]">{team.enabled ? 'configured' : 'not configured'}</span>
                  </div>
                  <button
                    onClick={() => runTeam(team.id)}
                    disabled={busy[`team:${team.id}`]}
                    className="rounded-md border border-[var(--color-border)] px-2.5 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] disabled:opacity-50"
                  >
                    {busy[`team:${team.id}`] ? 'Running…' : 'Run team'}
                  </button>
                </div>
                <p className="mb-2 text-xs text-[var(--color-text-muted)]">{team.description}</p>
                <ul className="space-y-0.5 text-xs text-[var(--color-text-secondary)]">
                  {team.tools.map((tool) => (
                    <li key={tool.id} className="truncate">
                      {tool.label}
                      {tool.mode === 'http' && tool.path && <span className="font-mono text-[var(--color-text-muted)]"> — {tool.path}</span>}
                    </li>
                  ))}
                </ul>
                {renderTeamRun(team.id)}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Synergy & learning (Recourse + Draymond) */}
      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold text-[var(--color-text-primary)]">Synergy & learning</h2>
        {!synergy ? (
          <div className="rounded-md border border-dashed border-[var(--color-border-muted)] p-4 text-xs text-[var(--color-text-muted)]">
            No synergy/learning data (Recourse or Draymond unreachable).
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-[var(--color-border)] p-3">
              <span className="text-sm font-medium text-[var(--color-text-primary)]">Recourse synergy map</span>
              <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap text-[11px] text-[var(--color-text-secondary)]">
                {String(JSON.stringify(synergy.recourse.synergyMap?.data ?? synergy.recourse.synergyMap ?? {}, null, 2) ?? '').slice(0, 1600)}
              </pre>
            </div>
            <div className="rounded-lg border border-[var(--color-border)] p-3">
              <span className="text-sm font-medium text-[var(--color-text-primary)]">Recourse candidates</span>
              <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap text-[11px] text-[var(--color-text-secondary)]">
                {String(JSON.stringify(synergy.recourse.candidates?.data ?? {}, null, 2) ?? '').slice(0, 1600)}
              </pre>
            </div>
            <div className="rounded-lg border border-[var(--color-border)] p-3">
              <span className="text-sm font-medium text-[var(--color-text-primary)]">Draymond lessons</span>
              <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap text-[11px] text-[var(--color-text-secondary)]">
                {String(JSON.stringify(synergy.draymond?.lessons?.data ?? {}, null, 2) ?? '').slice(0, 1600)}
              </pre>
            </div>
          </div>
        )}
        <p className="mt-2 text-xs text-[var(--color-text-muted)]">
          Every job run feeds its real outcome back into Recourse (fleet memory + learner episode) and Draymond (recordOutcome), so routing improves as the fleet runs. Toggle with <span className="font-mono">OPENHUB_TEAMS_LEARN=0</span>.
        </p>
      </section>

      {/* Draymond routines & crons */}
      <section>
        <h2 className="mb-3 text-sm font-semibold text-[var(--color-text-primary)]">Draymond routines & crons</h2>
        {!draymond || (!draymond.day.ok && !draymond.schedules.ok) ? (
          <div className="rounded-md border border-dashed border-[var(--color-border-muted)] p-4 text-xs text-[var(--color-text-muted)]">
            Draymond unreachable or not configured ({draymond?.day.error ?? draymond?.schedules.error ?? 'no data'}).
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {draymond.day.ok && (
              <div className="rounded-lg border border-[var(--color-border)] p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-medium text-[var(--color-text-primary)]">Daily flow</span>
                  <button onClick={() => runJob('daily', { phase: 'current' })} disabled={busy['job:daily']} className="rounded-md bg-[var(--color-accent)] px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50">
                    {busy['job:daily'] ? 'Running…' : 'Run'}
                  </button>
                </div>
                <pre className="max-h-56 overflow-auto whitespace-pre-wrap text-[11px] text-[var(--color-text-secondary)]">
                  {String(JSON.stringify(draymond.day.data, null, 2) ?? '').slice(0, 2400)}
                </pre>
                {renderJobRun('daily')}
              </div>
            )}
            {draymond.schedules.ok && (
              <div className="rounded-lg border border-[var(--color-border)] p-3">
                <span className="text-sm font-medium text-[var(--color-text-primary)]">Scheduled jobs</span>
                <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap text-[11px] text-[var(--color-text-secondary)]">
                  {String(JSON.stringify(draymond.schedules.data, null, 2) ?? '').slice(0, 2400)}
                </pre>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}