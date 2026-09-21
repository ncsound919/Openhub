import { useCallback, useState } from 'react';
import { Crosshair, Loader2, Play, Search, ShieldAlert, ShieldCheck, XCircle } from 'lucide-react';
import { getAuthHeaders } from '../auth/AuthProvider';
import { useStore } from '../store';

/**
 * Antagonist — Axiom's self-directed work (Prospector) and verification-strength
 * proof (Adversary), surfaced in OpenHub over the Axiom proxy. Every number shown
 * comes from a real scan or a real mutation run; when Axiom is unreachable the
 * page says so instead of showing zeros.
 */

interface Opportunity {
  id: string; kind: string; severity: string; effort: string;
  file: string; line: number; detail: string; goal: string; score: number;
}
interface BacklogReport { dir: string; scannedFiles: number; total: number; opportunities: Opportunity[]; top: Opportunity[]; note: string }
interface Survivor { file: string; line: number; before: string; after: string; operator: string }
interface AdversaryReport { checked: boolean; verdict: string; killRatePct: number | null; killed: number; mutantsRun: number; reason?: string; note: string; survivors: Survivor[] }
interface CampaignItem { opportunityId?: string; loopId?: string; goal: string }

const sevClass: Record<string, string> = {
  high: 'text-red-400 border-red-500/30 bg-red-500/10',
  medium: 'text-amber-300 border-amber-500/30 bg-amber-500/10',
  low: 'text-[var(--color-text-muted)] border-[var(--color-border-muted)]',
};
const verdictClass: Record<string, string> = {
  strong: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10',
  weak: 'text-red-400 border-red-500/30 bg-red-500/10',
  unproven: 'text-amber-300 border-amber-500/30 bg-amber-500/10',
  'not-checked': 'text-[var(--color-text-muted)] border-[var(--color-border-muted)]',
};

export function AntagonistView() {
  const activeProject = useStore((s) => s.activeProject);
  const [dir, setDir] = useState('');
  const [report, setReport] = useState<BacklogReport | null>(null);
  const [adversary, setAdversary] = useState<AdversaryReport | null>(null);
  const [busy, setBusy] = useState<'' | 'scan' | 'adversary' | 'campaign'>('');
  const [error, setError] = useState<string | null>(null);
  const [campaign, setCampaign] = useState<CampaignItem[] | null>(null);

  const target = dir.trim() || activeProject?.path || '';

  const call = useCallback(async (path: string, init?: RequestInit) => {
    const res = await fetch(path, { credentials: 'include', headers: getAuthHeaders(), ...init });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json?.ok === false) throw new Error(json?.error || `request failed (${res.status})`);
    return json;
  }, []);

  const scan = useCallback(async () => {
    if (!target) { setError('Enter a directory or load an active project.'); return; }
    setBusy('scan'); setError(null); setCampaign(null);
    try {
      const json = await call(`/api/axiom/prospector/scan?dir=${encodeURIComponent(target)}&top=25`);
      setReport(json.data?.report as BacklogReport);
    } catch (err) { setError(err instanceof Error ? err.message : 'scan failed'); }
    finally { setBusy(''); }
  }, [call, target]);

  const runAdversary = useCallback(async () => {
    if (!target) { setError('Enter a directory or load an active project.'); return; }
    setBusy('adversary'); setError(null); setCampaign(null);
    try {
      const json = await call('/api/axiom/adversary/run', { method: 'POST', body: JSON.stringify({ dir: target, maxMutants: 12 }) });
      setAdversary(json.data?.report as AdversaryReport);
    } catch (err) { setError(err instanceof Error ? err.message : 'adversary failed'); }
    finally { setBusy(''); }
  }, [call, target]);

  const launch = useCallback(async (dryRun: boolean) => {
    if (!target) { setError('Enter a directory or load an active project.'); return; }
    setBusy('campaign'); setError(null);
    try {
      const json = await call('/api/axiom/prospector/run', { method: 'POST', body: JSON.stringify({ dir: target, count: 2, dryRun }) });
      const items = (dryRun ? json.data?.wouldLaunch : json.data?.launched) as CampaignItem[] | undefined;
      setCampaign(items ?? []);
    } catch (err) { setError(err instanceof Error ? err.message : 'campaign failed'); }
    finally { setBusy(''); }
  }, [call, target]);

  return (
    <div className="flex-1 w-full max-w-6xl mx-auto flex flex-col gap-5 px-4 py-6 relative z-10">
      <header className="flex items-center gap-3">
        <Crosshair className="w-5 h-5 text-red-400" aria-hidden />
        <div>
          <h1 className="text-lg font-extrabold tracking-tight text-[var(--color-text-primary)]">Adversary &amp; Prospector</h1>
          <p className="text-xs text-[var(--color-text-muted)]">Find the work worth doing, then prove the tests can catch a fault.</p>
        </div>
      </header>

      <section className="rounded-xl border border-[var(--color-border-muted)] p-4 flex flex-col gap-3">
        <label className="text-[11px] font-bold uppercase tracking-widest text-[var(--color-text-muted)]" htmlFor="antagonist-dir">Target directory</label>
        <div className="flex flex-wrap items-center gap-2">
          <input
            id="antagonist-dir"
            value={dir}
            onChange={(e) => setDir(e.target.value)}
            placeholder={activeProject?.path || 'absolute path inside the workspace root'}
            className="flex-1 min-w-[260px] rounded-md border border-[var(--color-border-muted)] bg-transparent px-3 py-1.5 font-mono text-xs text-[var(--color-text-primary)]"
          />
          <button onClick={() => void scan()} disabled={busy !== ''} className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border-muted)] px-3 py-1.5 text-xs font-semibold disabled:opacity-50">
            {busy === 'scan' ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : <Search className="w-3.5 h-3.5" aria-hidden />} Scan
          </button>
          <button onClick={() => void runAdversary()} disabled={busy !== ''} className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border-muted)] px-3 py-1.5 text-xs font-semibold disabled:opacity-50">
            {busy === 'adversary' ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : <ShieldAlert className="w-3.5 h-3.5" aria-hidden />} Adversary
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => void launch(true)} disabled={busy !== ''} className="rounded-md border border-[var(--color-border-muted)] px-3 py-1 text-xs font-semibold disabled:opacity-50">Preview campaign</button>
          <button onClick={() => void launch(false)} disabled={busy !== ''} className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border-muted)] px-3 py-1 text-xs font-semibold disabled:opacity-50">
            {busy === 'campaign' ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> : <Play className="w-3.5 h-3.5" aria-hidden />} Launch top 2
          </button>
          <span className="font-mono text-[11px] text-[var(--color-text-muted)]">{target || 'no target selected'}</span>
        </div>
        {error && <div className="text-xs text-red-400">{error}</div>}
      </section>

      {campaign && (
        <section className="rounded-xl border border-[var(--color-border-muted)] p-4">
          <h2 className="mb-2 text-[11px] font-bold uppercase tracking-widest text-[var(--color-text-muted)]">Campaign</h2>
          {campaign.length === 0 ? <div className="text-xs text-[var(--color-text-muted)]">Nothing to launch.</div> : (
            <ul className="flex flex-col gap-1">
              {campaign.map((c, i) => (
                <li key={i} className="font-mono text-xs text-[var(--color-text-primary)]">
                  <span className="text-[var(--color-accent-text)]">{c.opportunityId ?? c.loopId}</span> — {c.goal.slice(0, 140)}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {adversary && (
        <section className="rounded-xl border border-[var(--color-border-muted)] p-4">
          <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-[var(--color-text-muted)]">
            <ShieldAlert className="w-3.5 h-3.5" aria-hidden /> Verification strength
          </h2>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className={`rounded border px-1.5 py-0.5 font-bold uppercase ${verdictClass[adversary.verdict] || verdictClass['not-checked']}`}>{adversary.verdict}</span>
            {adversary.checked && adversary.killRatePct !== null && (
              <span className="font-mono text-[var(--color-text-primary)]">kill rate {adversary.killRatePct}% ({adversary.killed}/{adversary.mutantsRun} mutants)</span>
            )}
            {!adversary.checked && <span className="text-[var(--color-text-muted)]">{adversary.reason}</span>}
          </div>
          <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">{adversary.note}</p>
          {adversary.verdict === 'strong' && (
            <p className="mt-2 inline-flex items-center gap-1 text-xs text-emerald-400"><ShieldCheck className="w-3.5 h-3.5" aria-hidden /> the suite caught every mutant</p>
          )}
          {adversary.survivors.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1">
              {adversary.survivors.slice(0, 12).map((s, i) => (
                <li key={i} className="flex items-center gap-2 font-mono text-[11px]">
                  <XCircle className="w-3 h-3 shrink-0 text-red-400" aria-hidden />
                  <span className="text-[var(--color-accent-text)]">{s.file}:{s.line}</span>
                  <span className="text-[var(--color-text-primary)]">{s.before} → {s.after}</span>
                  <span className="text-[var(--color-text-muted)]">{s.operator}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {report && (
        <section className="rounded-xl border border-[var(--color-border-muted)] p-4">
          <h2 className="mb-2 text-[11px] font-bold uppercase tracking-widest text-[var(--color-text-muted)]">
            Opportunity backlog — {report.total} across {report.scannedFiles} file(s)
          </h2>
          {report.opportunities.length === 0 ? (
            <div className="text-xs text-[var(--color-text-muted)]">{report.note}</div>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {report.opportunities.slice(0, 30).map((o) => (
                <li key={o.id} className="flex items-center gap-2 text-xs">
                  <span className="w-8 text-right font-mono text-[var(--color-text-muted)]">{o.score}</span>
                  <span className={`rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase ${sevClass[o.severity] || sevClass.low}`}>{o.kind}</span>
                  <span className="font-mono text-[var(--color-accent-text)]">{o.file}{o.line ? `:${o.line}` : ''}</span>
                  <span className="truncate text-[var(--color-text-muted)]">{o.detail}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
