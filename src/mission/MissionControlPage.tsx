import { useEffect, useRef, useState } from 'react';
import { GitBranch, Loader2 } from 'lucide-react';
import { useStore } from '../store';
import { useMissionStore } from '../lib/missionStore.js';
import { abortMission, createMission, sendPrompt, subscribeMission } from './useMission.js';
import { EngineStatusBar, useEngineStatus } from './EngineStatusBar';
import { GoalComposer } from './GoalComposer';
import { MissionTimeline } from './MissionTimeline';
import { MissionInspector } from './MissionInspector';

/**
 * Mission Control — one goal in, a mission out. This is the Phase B skeleton:
 * the header/status, the composer, the timeline and the inspector are wired to
 * real state, while telemetry numbers stay placeholders ("—") because the
 * engine lanes are not wired live yet.
 */
export function MissionControlPage() {
  const activeProject = useStore((s) => s.activeProject);
  const engine = useEngineStatus();
  const activeId = useMissionStore((s) => s.activeId);
  const activeMission = useMissionStore((s) => s.missions.find((m) => m.id === s.activeId) ?? null);
  const events = useMissionStore((s) => (s.activeId ? s.events[s.activeId] ?? [] : []));

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  // One live subscription for the page's lifetime; replaced per new mission.
  useEffect(() => () => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
  }, []);

  const onSubmit = async (goal: string) => {
    setBusy(true);
    setError(null);
    try {
      const id = await createMission(goal);
      const store = useMissionStore.getState();
      store.setActive(id);
      // Subscribe BEFORE prompting: otherwise the engine's early frames race
      // ahead of this subscription and are lost (the "empty timeline" bug).
      unsubscribeRef.current?.();
      unsubscribeRef.current = subscribeMission(
        id,
        (event) => {
          useMissionStore.getState().addEvent(id, event);
        },
        (message) => {
          setError(message);
          useMissionStore.getState().setStatus(id, 'failed');
        },
      );
      await sendPrompt(id, goal);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to start mission');
    } finally {
      setBusy(false);
    }
  };

  const onStop = async () => {
    if (!activeId) return;
    setError(null);
    try {
      await abortMission(activeId, activeId);
    } catch {
      /* best effort — mark done regardless so the control is not stuck */
    }
    useMissionStore.getState().setStatus(activeId, 'done');
  };

  const canStop = activeMission?.status === 'planned' || activeMission?.status === 'running';

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-bg-base)]">
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-[var(--color-border-muted)] px-4 py-2.5">
        <EngineStatusBar status={engine} />
        <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-[var(--color-text-secondary)]">
          <GitBranch className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />
          <span className="truncate font-semibold text-[var(--color-text-primary)]">
            {activeProject?.repositoryName ?? 'No project loaded'}
          </span>
          {activeProject?.defaultBranch && (
            <span className="shrink-0 font-mono text-[11px] text-[var(--color-text-muted)]">
              {activeProject.defaultBranch}
            </span>
          )}
        </span>
      </header>

      <div className="shrink-0 border-b border-[var(--color-border-muted)]">
        <GoalComposer
          engineOnline={engine?.available ?? false}
          onSubmit={onSubmit}
          busy={busy}
          canStop={canStop}
          onStop={onStop}
        />
        {error && (
          <div className="px-4 pb-2 text-xs text-[var(--color-danger)]">{error}</div>
        )}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[1fr_320px]">
        <MissionTimeline events={events} />
        <MissionInspector />
      </div>

      <footer className="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-1 border-t border-[var(--color-border-muted)] px-4 py-2 font-mono text-[11px] text-[var(--color-text-muted)]">
        <span>status <span className="text-[var(--color-text-secondary)]">{activeMission?.status ?? 'idle'}</span></span>
        <span>tokens <span className="text-[var(--color-text-secondary)]">—</span></span>
        <span>cost <span className="text-[var(--color-text-secondary)]">—</span></span>
        <span>iterations <span className="text-[var(--color-text-secondary)]">—</span></span>
        {busy && (
          <span className="ml-auto inline-flex items-center gap-1.5 text-[var(--color-text-secondary)]">
            <Loader2 className="h-3 w-3 animate-spin" /> starting mission…
          </span>
        )}
      </footer>
    </div>
  );
}
