import { useEffect, useState } from 'react';
import { getAuthHeaders } from '../../auth/AuthProvider';

export interface SnapshotSection<T = any> {
  ok: boolean;
  error?: string;
  [key: string]: any;
}

export interface SystemSnapshot {
  generatedAt: string;
  project: SnapshotSection & { repositoryName?: string; path?: string };
  drift: SnapshotSection & { ahead?: number; behind?: number; uncommitted?: number; branch?: string };
  audit: SnapshotSection & { verdict?: string; reportId?: string };
  runs: SnapshotSection & { total?: number; active?: number; latest?: any };
  research: SnapshotSection & { total?: number; latest?: any[] };
  ecosystem: SnapshotSection & { sources?: { root: string; label: string; entries: number }[]; entries?: number };
  incidents: SnapshotSection & { recent?: any[]; bySeverity?: Record<string, number>; dispatch?: { inFlight: boolean; queued: number } };
  recourse: SnapshotSection & { summary?: string };
}

/** Poll the shared snapshot feed (10s) while the visualizer is open. */
export function useSnapshot(pollMs = 10_000): { snapshot: SystemSnapshot | null; error: string | null } {
  const [snapshot, setSnapshot] = useState<SystemSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/api/system/snapshot', { credentials: 'include', headers: getAuthHeaders() });
        const data = await res.json();
        if (!cancelled) {
          if (data.ok && data.snapshot) {
            setSnapshot(data.snapshot);
            setError(null);
          } else {
            setError(data.error || 'snapshot unavailable');
          }
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'snapshot request failed');
      }
    };
    void load();
    const t = setInterval(() => void load(), pollMs);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [pollMs]);

  return { snapshot, error };
}

/** True when the browser can actually run WebGL. */
export function webglAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return !!(canvas.getContext('webgl') || canvas.getContext('experimental-webgl'));
  } catch {
    return false;
  }
}
