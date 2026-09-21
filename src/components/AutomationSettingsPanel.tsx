import { useCallback, useEffect, useState } from 'react';
import { Bot, Loader2, Play, RefreshCw } from 'lucide-react';
import { getAuthHeaders, getCsrfToken } from '../auth/AuthProvider';
import { StatusLight } from './StatusLight';

interface AutoConfig {
  enabled: boolean;
  trigger: 'interval' | 'drift' | 'both';
  intervalMs: number;
  mode: 'audit' | 'autopilot';
  lastRunAt: string | null;
  lastJobId: string | null;
  lastNote: string | null;
}

const INTERVALS: Array<{ label: string; ms: number }> = [
  { label: '5 min', ms: 5 * 60_000 },
  { label: '15 min', ms: 15 * 60_000 },
  { label: '30 min', ms: 30 * 60_000 },
  { label: '60 min', ms: 60 * 60_000 },
];

const TRIGGERS: Array<{ id: AutoConfig['trigger']; label: string; hint: string }> = [
  { id: 'drift', label: 'On drift', hint: 'Run when the project has uncommitted changes or commits ahead of upstream' },
  { id: 'interval', label: 'On a timer', hint: 'Run every N minutes regardless of state' },
  { id: 'both', label: 'Drift or timer', hint: 'Run on drift, or on the timer if nothing changed' },
];

/**
 * Automation — the unattended Autopilot controls. This is the "leash" for Auto
 * autonomy mode: what triggers a run, how often, and how deep.
 */
export function AutomationSettingsPanel() {
  const [cfg, setCfg] = useState<AutoConfig | null>(null);
  const [killSwitch, setKillSwitch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/pipeline/auto', { credentials: 'include', headers: getAuthHeaders() });
      const json = await res.json().catch(() => ({}));
      if (json?.auto) setCfg(json.auto as AutoConfig);
      setKillSwitch(json?.killSwitch === true);
    } catch { /* leave prior state */ }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const save = async (patch: Partial<AutoConfig>) => {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch('/api/pipeline/auto', {
        method: 'PUT',
        credentials: 'include',
        headers: { ...getAuthHeaders(), 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
        body: JSON.stringify(patch),
      });
      const json = await res.json().catch(() => ({}));
      if (json?.auto) setCfg(json.auto as AutoConfig);
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  const runNow = async () => {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch('/api/pipeline/auto/tick', {
        method: 'POST', credentials: 'include',
        headers: { ...getAuthHeaders(), 'X-CSRF-Token': getCsrfToken() },
      });
      const json = await res.json().catch(() => ({}));
      const r = json?.result as { started?: boolean; skipped?: string } | undefined;
      setNote(r?.started ? 'Started a run.' : `Did not run: ${r?.skipped ?? 'unknown'}`);
      await load();
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Tick failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-8 space-y-6 animate-in fade-in duration-300">
      <div className="border-b border-white/5 pb-6">
        <h2 className="text-2xl font-industrial text-[var(--color-text-primary)] tracking-tight">Automation</h2>
        <p className="text-xs text-gray-400 font-bold uppercase tracking-widest mt-1">
          Unattended Autopilot. Auto autonomy mode runs the pipeline with no button and no plan gate.
        </p>
      </div>

      <div className="industrial-card p-5 space-y-4 max-w-2xl">
        <div className="flex items-center gap-3">
          <StatusLight state={cfg?.enabled ? (killSwitch ? 'warn' : 'ok') : 'idle'} label={cfg?.enabled ? 'Auto on' : 'Auto off'} />
          {killSwitch && <StatusLight state="error" label="kill switch engaged" title="OPENHUB_AUTODISPATCH=0 — nothing runs" />}
        </div>

        <label className="flex cursor-pointer items-center justify-between gap-3 text-sm text-[var(--color-text-secondary)]">
          <span>
            Enable unattended runs
            <span className="block text-[11px] text-gray-500">Also switched on by choosing Auto in the chat.</span>
          </span>
          <input
            type="checkbox"
            checked={cfg?.enabled ?? false}
            disabled={!cfg || busy}
            onChange={(e) => void save({ enabled: e.target.checked })}
          />
        </label>

        <label className="flex items-center justify-between gap-3 text-sm text-[var(--color-text-secondary)]">
          <span>
            Trigger
            <span className="block text-[11px] text-gray-500">{TRIGGERS.find((t) => t.id === cfg?.trigger)?.hint}</span>
          </span>
          <select
            value={cfg?.trigger ?? 'drift'}
            disabled={!cfg || busy}
            onChange={(e) => void save({ trigger: e.target.value as AutoConfig['trigger'] })}
            className="rounded border border-border-muted bg-surface-base px-2 py-1 text-[12px] font-bold"
          >
            {TRIGGERS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </label>

        <label className="flex items-center justify-between gap-3 text-sm text-[var(--color-text-secondary)]">
          <span>
            Interval
            <span className="block text-[11px] text-gray-500">Used by the timer trigger, and as the fallback for “both”.</span>
          </span>
          <select
            value={cfg?.intervalMs ?? 15 * 60_000}
            disabled={!cfg || busy || cfg?.trigger === 'drift'}
            onChange={(e) => void save({ intervalMs: Number(e.target.value) })}
            className="rounded border border-border-muted bg-surface-base px-2 py-1 text-[12px] font-bold disabled:opacity-40"
          >
            {INTERVALS.map((i) => <option key={i.ms} value={i.ms}>{i.label}</option>)}
          </select>
        </label>

        <label className="flex items-center justify-between gap-3 text-sm text-[var(--color-text-secondary)]">
          <span>
            Depth
            <span className="block text-[11px] text-gray-500">Audit is the audit/repair half; Autopilot runs every stage.</span>
          </span>
          <select
            value={cfg?.mode ?? 'autopilot'}
            disabled={!cfg || busy}
            onChange={(e) => void save({ mode: e.target.value as AutoConfig['mode'] })}
            className="rounded border border-border-muted bg-surface-base px-2 py-1 text-[12px] font-bold"
          >
            <option value="audit">Audit + repair</option>
            <option value="autopilot">Autopilot (all stages)</option>
          </select>
        </label>

        <div className="border-t border-white/5 pt-4 space-y-1 font-mono text-[11px] text-gray-400">
          <div className="flex items-center gap-2"><Bot className="w-3.5 h-3.5" /> <span className="truncate">last run: {cfg?.lastRunAt ? new Date(cfg.lastRunAt).toLocaleString() : 'never'}</span></div>
          {cfg?.lastNote && <div className="truncate">note: {cfg.lastNote}</div>}
          {cfg?.lastJobId && <div className="truncate">job: {cfg.lastJobId}</div>}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void runNow()}
            disabled={busy || killSwitch}
            className="inline-flex items-center gap-1.5 rounded border border-border-muted px-2.5 py-1 text-[11px] font-bold text-gray-300 hover:text-[var(--color-text-primary)] disabled:opacity-40"
            title={killSwitch ? 'Blocked by the kill switch' : 'Run one tick now'}
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />} Run now
          </button>
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex items-center gap-1.5 rounded border border-border-muted px-2.5 py-1 text-[11px] font-bold text-gray-400 hover:text-[var(--color-text-primary)]"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
          {note && <span className="text-[11px] text-[var(--color-text-muted)]">{note}</span>}
        </div>
      </div>
    </div>
  );
}
