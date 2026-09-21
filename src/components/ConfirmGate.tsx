import { useEffect, useState } from 'react';
import { AlertTriangle, ShieldAlert, X } from 'lucide-react';
import type { GateIntensity } from '../lib/autonomy';
import { cn } from '../lib/utils';

export interface GateRequest {
  title: string;
  detail?: string;
  intensity: GateIntensity;
  confirmLabel?: string;
  /** For catastrophic actions: the operator must type this phrase to confirm. */
  phrase?: string;
}

interface Pending extends GateRequest {
  resolve: (ok: boolean) => void;
}

let pending: Pending | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

/**
 * Ask for confirmation before a consequential action. Resolves true when the
 * operator confirms. Intensity triages the friction:
 *   reversible   — one click
 *   destructive  — red confirm
 *   catastrophic — type a phrase
 */
export function confirmGate(req: GateRequest): Promise<boolean> {
  return new Promise((resolve) => {
    // A second gate replaces the first; resolve the orphan as cancelled so its
    // caller never hangs on a promise that can no longer be settled.
    if (pending) { const prev = pending; pending = null; prev.resolve(false); }
    pending = { ...req, resolve };
    emit();
  });
}

function settle(ok: boolean): void {
  const p = pending;
  pending = null;
  emit();
  p?.resolve(ok);
}

const TONE: Record<GateIntensity, { ring: string; icon: typeof AlertTriangle; label: string }> = {
  reversible: { ring: 'border-[var(--color-border-strong)]', icon: AlertTriangle, label: 'Confirm' },
  destructive: { ring: 'border-[var(--color-danger)]', icon: ShieldAlert, label: 'Destructive action' },
  catastrophic: { ring: 'border-[var(--color-danger)]', icon: ShieldAlert, label: 'This cannot be undone' },
};

/** Mount once in the app shell. Renders the active gate, if any. */
export function ConfirmGateHost() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);

  const [typed, setTyped] = useState('');
  useEffect(() => { setTyped(''); }, [pending?.title]);
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') settle(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending]);

  if (!pending) return null;
  const tone = TONE[pending.intensity];
  const Icon = tone.icon;
  const needsPhrase = pending.intensity === 'catastrophic';
  const phrase = pending.phrase ?? 'confirm';
  const canConfirm = !needsPhrase || typed.trim().toLowerCase() === phrase.toLowerCase();

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center px-4" role="dialog" aria-modal="true" aria-label={tone.label}>
      <div className="absolute inset-0 bg-black/70" onClick={() => settle(false)} />
      <div className={cn('relative w-full max-w-md rounded-lg border-2 bg-[var(--color-surface-overlay)] p-5 shadow-2xl shadow-black/60', tone.ring)}>
        <div className="flex items-start gap-3">
          <Icon className={cn('mt-0.5 h-5 w-5 shrink-0', pending.intensity === 'reversible' ? 'text-[var(--color-warning)]' : 'text-[var(--color-danger)]')} />
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-black uppercase tracking-widest text-[var(--color-text-muted)]">{tone.label}</div>
            <div className="mt-1 text-sm font-bold text-[var(--color-text-primary)]">{pending.title}</div>
            {pending.detail && <p className="mt-1 text-xs leading-relaxed text-gray-400 whitespace-pre-wrap">{pending.detail}</p>}
          </div>
          <button onClick={() => settle(false)} aria-label="Close" className="shrink-0 text-gray-500 hover:text-[var(--color-text-primary)]"><X className="h-4 w-4" /></button>
        </div>

        {needsPhrase && (
          <div className="mt-4">
            <label className="text-[11px] text-gray-400">
              Type <span className="font-mono font-bold text-[var(--color-danger)]">{phrase}</span> to confirm
            </label>
            <input
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="mt-1 w-full rounded border border-[var(--color-border-muted)] bg-[var(--color-surface-base)] px-2 py-1.5 font-mono text-xs text-[var(--color-text-primary)] outline-none focus:border-[var(--color-danger)]"
            />
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={() => settle(false)}
            className="rounded-md border border-[var(--color-border-muted)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
          >
            Cancel
          </button>
          <button
            autoFocus={!needsPhrase}
            onClick={() => settle(true)}
            disabled={!canConfirm}
            className={cn(
              'rounded-md px-3 py-1.5 text-xs font-bold text-white disabled:opacity-40',
              pending.intensity === 'reversible' ? 'bg-[var(--color-accent)] hover:brightness-110' : 'bg-[var(--color-danger)] hover:brightness-110',
            )}
          >
            {pending.confirmLabel ?? (pending.intensity === 'reversible' ? 'Confirm' : 'Proceed')}
          </button>
        </div>
      </div>
    </div>
  );
}
