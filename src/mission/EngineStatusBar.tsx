import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { getAuthHeaders } from '../auth/AuthProvider';

export interface EngineStatus {
  available: boolean;
  error?: string;
  version?: string;
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
          setStatus({ available: data.available, error: data.error, version: data.version });
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
      <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border-muted)] bg-[var(--color-surface-raised)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-text-muted)]">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        checking opencode…
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
