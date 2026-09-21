import { useEffect, useRef, useState } from 'react';
import { getAuthHeaders } from '../auth/AuthProvider';

/**
 * Live autonomy state. Subscribes to the server's SSE heartbeat
 * (/api/autonomy/stream); if EventSource cannot authenticate (Bearer-only
 * sessions) it silently falls back to polling /api/autonomy/state. Either way
 * the UI stays current with no operator action.
 */
export interface AutonomySnapshot {
  generatedAt: string;
  tick: number;
  running: boolean;
  intervalMs: number;
  health: {
    servicesUp: number;
    servicesTotal: number;
    recourseOnline: boolean;
    highSeverityEvents: number;
    insightCount: number;
    passRate: number | null;
  };
  services: Array<{ slug: string; name: string; port: number; up: boolean; category: string }>;
  telemetry: any;
  insights: any;
  resumedRuns: number;
  degraded: string[];
}

export function useAutonomy(pollMs = 15_000): { snapshot: AutonomySnapshot | null; connected: boolean } {
  const [snapshot, setSnapshot] = useState<AutonomySnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let stopped = false;
    let es: EventSource | null = null;

    const startPolling = () => {
      if (pollRef.current || stopped) return;
      const tick = async () => {
        try {
          const res = await fetch('/api/autonomy/state', { credentials: 'include', headers: getAuthHeaders() });
          const data = await res.json();
          if (data.ok && data.snapshot) setSnapshot(data.snapshot as AutonomySnapshot);
        } catch {
          /* keep the last snapshot */
        }
      };
      void tick();
      pollRef.current = setInterval(tick, pollMs);
    };

    try {
      es = new EventSource('/api/autonomy/stream', { withCredentials: true });
      es.addEventListener('snapshot', (event: MessageEvent) => {
        try {
          setSnapshot(JSON.parse(event.data) as AutonomySnapshot);
          setConnected(true);
        } catch {
          /* ignore malformed frame */
        }
      });
      es.onerror = () => {
        setConnected(false);
        try {
          es?.close();
        } catch {
          /* ignore */
        }
        es = null;
        startPolling();
      };
    } catch {
      startPolling();
    }

    return () => {
      stopped = true;
      try {
        es?.close();
      } catch {
        /* ignore */
      }
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [pollMs]);

  return { snapshot, connected };
}
