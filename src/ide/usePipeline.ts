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
}
export type PipelineJobStatus = 'running' | 'complete' | 'failed' | 'cancelled';
export interface PipelineJobView {
  id: string;
  mode: string;
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
  start: (mode: 'autopilot' | 'audit', goal?: string) => Promise<void>;
  cancel: () => Promise<void>;
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

  const start = useCallback(async (mode: 'autopilot' | 'audit', goal?: string) => {
    setStarting(true);
    setError(null);
    try {
      const res = await fetch('/api/pipeline/run', {
        method: 'POST',
        credentials: 'include',
        headers: getAuthHeaders({ 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() }),
        body: JSON.stringify({ mode, ...(goal && goal.trim() ? { goal: goal.trim() } : {}) }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.job) {
        setError(json?.error || `Could not start pipeline (HTTP ${res.status})`);
        return;
      }
      const next = json.job as PipelineJobView;
      setJob(next);
      if (timer.current) clearTimeout(timer.current);
      void poll(next.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start pipeline');
    } finally {
      setStarting(false);
    }
  }, [poll]);

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

  return { job, starting, running: job?.status === 'running', error, start, cancel, refresh };
}

/** Light-state mapping for a pipeline stage, shared by every indicator. */
export function stageLight(s: PipelineStageView): 'idle' | 'working' | 'ok' | 'warn' | 'error' | 'offline' {
  if (s.status === 'running') return 'working';
  if (s.status === 'failed') return 'error';
  if (s.status === 'cancelled') return 'warn';
  if (s.status === 'done') return s.ok === false ? 'warn' : 'ok';
  return 'idle';
}
