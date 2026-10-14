import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { getAuthHeaders } from '../auth/AuthProvider';

export interface EngineStatus {
  available: boolean;
  error?: string;
  version?: string;
  /** Configured model providers; null/undefined = unknown. 0 means every prompt will fail. */
  providerCount?: number | null;
}

const POLL_MS = 10_000;

/**
 * Poll `GET /api/opencode/status` (the OpenHub proxy that fronts the opencode
 * engine) and expose the parsed health. Shared by the status chip and the page
 * so the composer's gate and the chip never disagree about reachability.
 *
 * The engine is reached through OpenHub's own proxy with cookie auth, exactly
 * like the editor bridge (`axiomEditorClient`).
 */
export function useEngineStatus(): EngineStatus | null {
  const [status, setStatus] = useState<EngineStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch('/api/opencode/status', {
          credentials: 'include',
          headers: { ...getAuthHeaders() },
        });
        const json = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          data?: Partial<EngineStatus>;
          error?: string;
        };
        if (cancelled) return;
        const data = json.data;
        if (json.ok && data && typeof data.available === 'boolean') {
          setStatus({ available: data.available, error: data.error, version: data.version, providerCount: data.providerCount });
        } else {
          setStatus({ available: false, error: json.error || `status request failed (HTTP ${res.status})` });
        }
      } catch {
        if (!cancelled) setStatus({ available: false, error: 'status request failed' });
      }
    };
    void poll();
    const timer = setInterval(() => { void poll(); }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return status;
}

/**
 * Compact opencode engine health chip. Prefer passing `status` (from a single
 * shared `useEngineStatus()` on the page) so the page polls once, not twice.
 * With no prop it self-polls, which keeps standalone use working.
 */
export function EngineStatusBar({ status }: { status?: EngineStatus | null } = {}) {
  // A provided prop (including explicit `null`) means the caller owns polling.
  if (status !== undefined) return <EngineStatusChip status={status} />;
  return <SelfPollingEngineStatusBar />;
}

function SelfPollingEngineStatusBar() {
  const status = useEngineStatus();
  return <EngineStatusChip status={status} />;
}

function EngineStatusChip({ status }: { status: EngineStatus | null }) {
  if (!status) {
    return (
      <span className="inline-flex items-center gap-2 rounded-full border border-[var(--color-border-muted)] bg-[var(--color-surface-raised)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-text-muted)]">
        <span aria-hidden="true" className="h-3 w-3 shrink-0 rounded-sm bg-[var(--color-surface-overlay)] motion-safe:animate-pulse" />
        checking opencode…
      </span>
    );
  }

  if (status.available && status.providerCount === 0) {
    return (
      <span
        title="The engine is running but has no model providers, so every prompt fails with ProviderNoProvidersError. Run `opencode auth login` or set the provider key in OpenHub's environment."
        className="inline-flex items-center gap-1.5 rounded-full border border-[color-mix(in_srgb,var(--color-warning)_45%,transparent)] bg-[color-mix(in_srgb,var(--color-warning)_12%,transparent)] px-2.5 py-1 text-[11px] font-semibold text-[var(--color-warning)]"
      >
        <AlertTriangle className="h-3.5 w-3.5" />
        opencode up — no model providers
      </span>
    );
  }

  if (status.available) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-[color-mix(in_srgb,var(--color-success)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-success)_12%,transparent)] px-2.5 py-1 text-[11px] font-semibold text-[var(--color-success)]">
        <CheckCircle2 className="h-3.5 w-3.5" />
        opencode ready{status.version ? ` · v${status.version}` : ''}
      </span>
    );
  }

  return (
    <span
      title={status.error}
      className="inline-flex items-center gap-1.5 rounded-full border border-[color-mix(in_srgb,var(--color-warning)_45%,transparent)] bg-[color-mix(in_srgb,var(--color-warning)_12%,transparent)] px-2.5 py-1 text-[11px] font-semibold text-[var(--color-warning)]"
    >
      <AlertTriangle className="h-3.5 w-3.5" />
      opencode down — {status.error ?? 'unreachable'}
    </span>
  );
}
