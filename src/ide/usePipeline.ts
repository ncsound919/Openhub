import { useCallback, useEffect, useRef, useState } from 'react';
import { getAuthHeaders, getCsrfToken } from '../auth/AuthProvider';

export type PipelineStageStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed' | 'cancelled';
export interface PipelineStageView {
  id: string;
  label: string;
  status: PipelineStageStatus;
  ok: boolean | null;
  detail: string;
  progress: number;
  enabled?: boolean;
}
export type PipelineJobStatus = 'awaiting-approval' | 'running' | 'complete' | 'failed' | 'cancelled';
export interface PipelineJobView {
  id: string;
  mode: string;
  goal?: string;
  status: PipelineJobStatus;
  progress: number;
  stages: PipelineStageView[];
  error: string | null;
}

export interface PipelineController {
  job: PipelineJobView | null;
  starting: boolean;
  running: boolean;
  error: string | null;
  start: (mode: 'autopilot' | 'audit', goal?: string, opts?: { planGate?: boolean }) => Promise<void>;
  cancel: () => Promise<void>;
  approve: (plan?: Array<{ id: string; enabled: boolean }>, goal?: string) => Promise<void>;
  reject: () => Promise<void>;
  refresh: () => Promise<void>;
}

const POLL_MS = 1500;

/**
 * Shared pipeline state. The workspace owns one instance and passes it to every
 * surface that starts or shows a run (command bar, empty state), so a job
 * started from one place is visible everywhere and only one poller exists.
 */
export function usePipeline(): PipelineController {
  const [job, setJob] = useState<PipelineJobView | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  useEffect(() => () => {
    mounted.current = false;
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const poll = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/pipeline/${encodeURIComponent(id)}`, { credentials: 'include', headers: getAuthHeaders() });
      const json = await res.json().catch(() => ({}));
      if (!mounted.current) return;
      const next = json?.job as PipelineJobView | undefined;
      if (next) {
        setJob(next);
        if (next.status === 'running') timer.current = setTimeout(() => void poll(id), POLL_MS);
        else setError(next.error ?? null);
      }
    } catch {
      if (mounted.current) timer.current = setTimeout(() => void poll(id), 3000);
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/pipeline', { credentials: 'include', headers: getAuthHeaders() });
      const json = await res.json().catch(() => ({}));
      const jobs = Array.isArray(json?.jobs) ? (json.jobs as PipelineJobView[]) : [];
      if (mounted.current && jobs[0]) {
        setJob(jobs[0]);
        if (jobs[0].status === 'running') {
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => void poll(jobs[0].id), POLL_MS);
        }
      }
    } catch { /* no runs yet */ }
  }, [poll]);

  const start = useCallback(async (mode: 'autopilot' | 'audit', goal?: string, opts?: { planGate?: boolean }) => {
    setStarting(true);
    setError(null);
    try {
      const res = await fetch('/api/pipeline/run', {
        method: 'POST',
        credentials: 'include',
        headers: getAuthHeaders({ 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() }),
        body: JSON.stringify({ mode, ...(goal && goal.trim() ? { goal: goal.trim() } : {}), ...(opts?.planGate ? { planGate: true } : {}) }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.job) {
        setError(json?.error || `Could not start pipeline (HTTP ${res.status})`);
        return;
      }
      const next = json.job as PipelineJobView;
      setJob(next);
      if (timer.current) clearTimeout(timer.current);
      if (next.status === 'running') void poll(next.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start pipeline');
    } finally {
      setStarting(false);
    }
  }, [poll]);

  const decide = useCallback(async (action: 'approve' | 'reject', plan?: Array<{ id: string; enabled: boolean }>, goal?: string) => {
    const id = job?.id;
    if (!id) return;
    setStarting(true);
    setError(null);
    try {
      const res = await fetch(`/api/pipeline/${encodeURIComponent(id)}/${action}`, {
        method: 'POST',
        credentials: 'include',
        headers: getAuthHeaders({ 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() }),
        body: JSON.stringify({ ...(plan ? { plan } : {}), ...(goal ? { goal } : {}) }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.ok === false) { setError(json?.error || `Could not ${action} pipeline`); return; }
      if (json?.job) setJob(json.job as PipelineJobView);
      if (action === 'approve' && json?.job) void poll((json.job as PipelineJobView).id);
    } catch (e) {
      setError(e instanceof Error ? e.message : `Could not ${action} pipeline`);
    } finally {
      setStarting(false);
    }
  }, [job, poll]);

  const approve = useCallback((plan?: Array<{ id: string; enabled: boolean }>, goal?: string) => decide('approve', plan, goal), [decide]);
  const reject = useCallback(() => decide('reject'), [decide]);

  const cancel = useCallback(async () => {
    if (!job) return;
    try {
      await fetch(`/api/pipeline/${encodeURIComponent(job.id)}/cancel`, {
        method: 'POST', credentials: 'include',
        headers: getAuthHeaders({ 'X-CSRF-Token': getCsrfToken() }),
      });
    } catch { /* the poll reflects the final state */ }
  }, [job]);

  // Adopt the most recent run on mount so a page reload does not lose sight of
  // an in-flight pipeline.
  useEffect(() => { void refresh(); }, [refresh]);

  return { job, starting, running: job?.status === 'running', error, start, cancel, approve, reject, refresh };
}

/** Light-state mapping for a pipeline stage, shared by every indicator. */
export function stageLight(s: PipelineStageView): 'idle' | 'working' | 'ok' | 'warn' | 'error' | 'offline' {
  if (s.status === 'running') return 'working';
  if (s.status === 'failed') return 'error';
  if (s.status === 'cancelled') return 'warn';
  if (s.status === 'done') return s.ok === false ? 'warn' : 'ok';
  return 'idle';
}
