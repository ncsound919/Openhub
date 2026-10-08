import { useEffect, useRef, useState } from 'react';
import { GitBranch, Loader2 } from 'lucide-react';
import { useStore } from '../store';
import { useMissionStore } from '../lib/missionStore.js';
import {
  abortMission,
  createMission,
  fetchSession,
  fetchSessions,
  sendPrompt,
  sessionToMission,
  steer,
  subscribeMission,
  normalizeSessionTelemetry,
  type SessionTelemetry,
} from './useMission.js';
import { EngineStatusBar, useEngineStatus } from './EngineStatusBar';
import { GoalComposer } from './GoalComposer';
import { MissionTimeline } from './MissionTimeline';
import { MissionInspector } from './MissionInspector';
import { MissionRail } from './MissionRail';
import { MissionStatusHeader, useElapsed } from './MissionStatusHeader';

const TELEMETRY_POLL_MS = 5_000;

/** Render an unknown count as `—` (mono numbers only). */
function fmtNum(n: number | undefined): string {
  return n == null ? '—' : n.toLocaleString('en-US');
}

/**
 * Mission Control — three regions: the missions rail (left), the working
 * column (status header + composer + timeline), and the inspector (right).
 *
 * Sessions are the source of truth: on mount the page lists opencode sessions
 * and upserts them as missions, then polls the active session's telemetry every
 * ~5s. The opencode session JSON shape is UNVERIFIED against a live engine, so
 * every telemetry read is defensive and unknown values render as `—`.
 */
export function MissionControlPage() {
  const activeProject = useStore((s) => s.activeProject);
  const engine = useEngineStatus();
  const missions = useMissionStore((s) => s.missions);
  const activeId = useMissionStore((s) => s.activeId);
  const activeMission = useMissionStore((s) => s.missions.find((m) => m.id === s.activeId) ?? null);
  const events = useMissionStore((s) => (s.activeId ? s.events[s.activeId] ?? [] : []));

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [telemetry, setTelemetry] = useState<SessionTelemetry | null>(null);
  const [steerText, setSteerText] = useState('');
  const [steering, setSteering] = useState(false);
  // Bumped whenever the active mission or its status changes, so the inspector
  // re-reads the diff/todos as a run progresses.
  const [inspectorRefreshKey, setInspectorRefreshKey] = useState(0);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  const elapsed = useElapsed(activeMission?.createdAt);

  // One live subscription for the page's lifetime; replaced per new mission.
  useEffect(() => () => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
  }, []);

  const subscribeTo = (id: string) => {
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
  };

  // Load the opencode session list once and reconcile it into the mission store.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await fetchSessions();
        if (cancelled) return;
        const store = useMissionStore.getState();
        for (const raw of list) {
          const mapped = sessionToMission(raw);
          if (!mapped) continue;
          const existing = useMissionStore.getState().missions.find((m) => m.id === mapped.id);
          // Never downgrade a live mission's status from a list snapshot.
          store.upsertMission(existing ? { ...mapped, status: existing.status } : mapped);
        }
        setLoadError(null);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Unable to load sessions');
      } finally {
        if (!cancelled) setSessionsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Poll the active session's telemetry while a mission is selected.
  const activeSessionId = activeMission?.sessionId;
  useEffect(() => {
    if (!activeSessionId) {
      setTelemetry(null);
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const raw = await fetchSession(activeSessionId);
        if (!cancelled) setTelemetry(normalizeSessionTelemetry(raw));
      } catch {
        if (!cancelled) setTelemetry(null);
      }
    };
    void poll();
    const timer = setInterval(() => {
      void poll();
    }, TELEMETRY_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeSessionId]);

  // Re-read the inspector whenever the active mission or its status changes.
  useEffect(() => {
    setInspectorRefreshKey((k) => k + 1);
  }, [activeId, activeMission?.status]);

  const selectMission = (id: string) => {
    const store = useMissionStore.getState();
    store.setActive(id);
    const mission = store.missions.find((m) => m.id === id);
    // Only subscribe to missions that can still emit events; a finished session
    // would otherwise fail the stream and wrongly flip `done` to `failed`.
    if (mission && (mission.status === 'planned' || mission.status === 'running')) {
      subscribeTo(mission.sessionId ?? mission.id);
    }
  };

  const onSubmit = async (goal: string) => {
    setBusy(true);
    setError(null);
    try {
      const id = await createMission(goal);
      const store = useMissionStore.getState();
      store.setActive(id);
      // Subscribe BEFORE prompting: otherwise the engine's early frames race
      // ahead of this subscription and are lost (the "empty timeline" bug).
      subscribeTo(id);
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

  // Steer is only meaningful mid-run; the session id is the request target.
  const steerSessionId = activeMission?.sessionId ?? activeMission?.id ?? null;
  const steerTrimmed = steerText.trim();
  const canSteer = activeMission?.status === 'running' && steerSessionId != null && steerTrimmed.length > 0 && !steering;
  const steerReason =
    activeMission?.status !== 'running'
      ? 'Steering is available while the mission is running'
      : steerSessionId == null
        ? 'No session to steer'
        : 'Type a message to steer the run';

  const onSteer = async () => {
    if (!steerSessionId || activeMission?.status !== 'running' || !steerText.trim() || steering) return;
    setSteering(true);
    setError(null);
    try {
      await steer(steerSessionId, steerText.trim());
      setSteerText('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to steer the mission');
    } finally {
      setSteering(false);
    }
  };

  const add = telemetry?.additions;
  const del = telemetry?.deletions;
  const filesDelta =
    add == null && del == null
      ? telemetry?.filesChanged == null
        ? '—'
        : `${telemetry.filesChanged} files`
      : `${add == null ? '—' : `+${add}`}/${del == null ? '—' : `-${del}`}`;
  const cost = telemetry?.cost;
  const inlineError = error ?? loadError;

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

      <div className="flex min-h-0 flex-1">
        {/* Rail — full vertical rail on lg+; a native select is the mobile fallback (below). */}
        <aside className="hidden w-60 shrink-0 border-r border-[var(--color-border-muted)] lg:block">
          <MissionRail
            missions={missions}
            activeId={activeId}
            onSelect={selectMission}
            loading={sessionsLoading}
          />
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Mobile fallback: the rail is hidden under lg, so mission switching moves here. */}
          <div className="border-b border-[var(--color-border-muted)] px-3 py-2 lg:hidden">
            <label htmlFor="mission-select" className="sr-only">
              Select mission
            </label>
            <select
              id="mission-select"
              value={activeId ?? ''}
              onChange={(e) => {
                if (e.target.value) selectMission(e.target.value);
              }}
              className="w-full rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-base)] px-2 py-1.5 text-xs text-[var(--color-text-primary)]"
            >
              {missions.length === 0 ? (
                <option value="">No missions yet</option>
              ) : (
                activeId == null && <option value="">Select a mission…</option>
              )}
              {missions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.goal}
                </option>
              ))}
            </select>
          </div>

          <MissionStatusHeader mission={activeMission} session={telemetry} />

          <div className="shrink-0 border-b border-[var(--color-border-muted)]">
            <GoalComposer
              engineOnline={engine?.available ?? false}
              onSubmit={onSubmit}
              busy={busy}
              canStop={canStop}
              onStop={onStop}
            />
            {inlineError && <div className="px-4 pb-2 text-xs text-[var(--color-danger)]">{inlineError}</div>}
          </div>

          <MissionTimeline events={events} />

          {/* Steer: send a follow-up while the agent runs (opencode prompt_async). */}
          <div className="shrink-0 border-t border-[var(--color-border-muted)] px-4 py-2">
            <div className="flex items-end gap-2">
              <textarea
                value={steerText}
                onChange={(e) => setSteerText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void onSteer();
                  }
                }}
                disabled={activeMission?.status !== 'running' || steering}
                placeholder="Steer the running mission…"
                aria-label="Steer the running mission"
                title={steerReason}
                rows={2}
                className="min-w-0 flex-1 resize-none rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-base)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none disabled:opacity-50"
              />
              <button
                type="button"
                onClick={() => void onSteer()}
                disabled={!canSteer}
                title={steerReason}
                className="inline-flex items-center gap-1.5 rounded-md bg-[var(--color-accent-text)] px-3 py-1.5 text-xs font-semibold text-[var(--color-bg-base)] transition-colors hover:bg-[var(--color-accent-hover)] disabled:opacity-40"
              >
                {steering ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Send
              </button>
            </div>
            {activeMission?.status !== 'running' && (
              <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">{steerReason}</p>
            )}
          </div>
        </div>

        <aside className="hidden min-h-0 w-80 shrink-0 lg:block">
          <MissionInspector
            sessionId={activeSessionId ?? null}
            telemetry={telemetry}
            refreshKey={inspectorRefreshKey}
          />
        </aside>
      </div>

      <footer className="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-1 border-t border-[var(--color-border-muted)] px-4 py-2 font-mono text-[11px] text-[var(--color-text-muted)]">
        <span>
          status <span className="text-[var(--color-text-secondary)]">{activeMission?.status ?? 'idle'}</span>
        </span>
        <span>
          tokens in/out{' '}
          <span className="text-[var(--color-text-secondary)]">
            {fmtNum(telemetry?.tokens?.input)} / {fmtNum(telemetry?.tokens?.output)}
          </span>
        </span>
        {/* Cost unit (USD) is assumed from opencode's assistant-message `cost`. UNVERIFIED. */}
        <span>
          cost <span className="text-[var(--color-text-secondary)]">{cost == null ? '—' : `$${cost.toFixed(4)}`}</span>
        </span>
        <span>
          files <span className="text-[var(--color-text-secondary)]">{filesDelta}</span>
        </span>
        <span>
          elapsed <span className="text-[var(--color-text-secondary)]">{elapsed}</span>
        </span>
        {busy && (
          <span className="ml-auto inline-flex items-center gap-1.5 text-[var(--color-text-secondary)]">
            <Loader2 className="h-3 w-3 animate-spin" /> starting mission…
          </span>
        )}
      </footer>
    </div>
  );
}
