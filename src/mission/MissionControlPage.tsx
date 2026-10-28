import { useCallback, useEffect, useRef, useState } from 'react';
import { GitBranch, Loader2, X } from 'lucide-react';
import { useStore } from '../store';
import { useMissionStore, type MissionEvent } from '../lib/missionStore.js';
import {
  abortMission,
  createMission,
  fetchMessages,
  fetchSession,
  fetchSessions,
  fetchPendingPermissions,
  missionStatusFromMessages,
  sendPrompt,
  sessionToMission,
  steer,
  subscribeMission,
  normalizeSessionTelemetry,
  respondToPermission,
  type ParsedMissionEvent,
  type PendingPermission,
  type SessionTelemetry,
} from './useMission.js';
import { EngineStatusBar, useEngineStatus } from './EngineStatusBar';
import { GoalComposer } from './GoalComposer';
import { MissionTimeline } from './MissionTimeline';
import { MissionTranscript } from './MissionTranscript';
import {
  appendTranscriptDelta,
  normalizeTranscript,
  upsertTranscriptRole,
  upsertTranscriptText,
  upsertTranscriptTool,
  type TranscriptEntry,
} from './transcript.js';
import { MissionInspector } from './MissionInspector';
import { MissionRail } from './MissionRail';
import { MissionStatusHeader, useElapsed } from './MissionStatusHeader';

const TELEMETRY_POLL_MS = 5_000;
/**
 * The engine streams text over SSE, but the transcript also polls history while
 * a mission runs. The poll is the safety net for a phone that was suspended and
 * missed deltas; 2.5s keeps the reply close to live without hammering the engine.
 */
const TRANSCRIPT_POLL_MS = 2_500;

/**
 * Stable empty array so the events selector never returns a fresh reference —
 * `useStore` treats a new snapshot on every call as an infinite render loop.
 */
const EMPTY_EVENTS: MissionEvent[] = [];

/**
 * Show a local notification. Chrome Android does not implement the
 * `new Notification()` constructor (it throws "Illegal constructor"); the
 * supported path there is the service worker registration. Both are guarded so
 * a denied/unsupported notification can never break a mission.
 */
function notifyMission(title: string, body: string, tag: string): void {
  if (typeof window === 'undefined' || !('Notification' in window) || Notification.permission !== 'granted') return;
  const options: NotificationOptions = { body, tag, icon: '/icon-192.png', badge: '/icon-192.png' };
  if ('serviceWorker' in navigator) {
    void navigator.serviceWorker.ready
      .then((registration) => registration.showNotification(title, options))
      .catch(() => undefined);
    return;
  }
  try { new Notification(title, options); } catch { /* unsupported */ }
}

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
  const events = useMissionStore((s) => (s.activeId ? (s.events[s.activeId] ?? EMPTY_EVENTS) : EMPTY_EVENTS));

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [telemetry, setTelemetry] = useState<SessionTelemetry | null>(null);
  const [telemetryError, setTelemetryError] = useState<string | null>(null);
  const [steerText, setSteerText] = useState('');
  const [steering, setSteering] = useState(false);
  const [pendingPerms, setPendingPerms] = useState<PendingPermission[]>([]);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [showEvents, setShowEvents] = useState(false);
  const lastTranscriptSessionRef = useRef<string | null>(null);
  // A single token that forces the inspector to re-read. It is bumped only for
  // a same-session status change (see below); selecting another mission already
  // re-reads via its sessionId, so bumping there would double-fetch.
  const [inspectorRefreshToken, setInspectorRefreshToken] = useState(0);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  // Track the last session/status the inspector was told about, so only a
  // same-session transition nudges a re-read.
  const lastInspectorSessionRef = useRef<string | null>(null);
  const lastInspectorStatusRef = useRef<string | null>(null);

  const elapsed = useElapsed(activeMission?.createdAt);

  // One live subscription for the page's lifetime; replaced per new mission.
  useEffect(() => () => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
  }, []);

  const subscribeTo = useCallback((id: string) => {
    unsubscribeRef.current?.();
    setPendingPerms([]);
    unsubscribeRef.current = subscribeMission(
      id,
      (event) => {
        const parsed = event as ParsedMissionEvent;
        // Message parts are the conversation, not bus noise. Fold them into the
        // transcript (including token deltas) and keep them out of the event
        // log, which would otherwise be one row per streamed chunk.
        if (parsed.kind === 'message.updated' && parsed.messageId && parsed.role) {
          setTranscript((cur) => upsertTranscriptRole(cur, parsed.messageId!, parsed.role!, parsed.at));
          return;
        }
        if (parsed.kind === 'message.part.delta' && parsed.messageId && parsed.partId && parsed.delta) {
          if (parsed.field === undefined || parsed.field === 'text') {
            setTranscript((cur) => appendTranscriptDelta(cur, parsed.messageId!, parsed.partId!, parsed.delta!, parsed.at));
          }
          return;
        }
        if (parsed.kind === 'message.part.updated' && parsed.messageId) {
          if (parsed.partType === 'text' && parsed.partText !== undefined) {
            setTranscript((cur) =>
              upsertTranscriptText(cur, parsed.messageId!, parsed.partId ?? parsed.messageId!, parsed.partText!, parsed.at),
            );
          } else if (parsed.partType === 'tool' && parsed.tool) {
            setTranscript((cur) => upsertTranscriptTool(cur, parsed.messageId!, parsed.tool!, parsed.at));
          }
          return;
        }

        useMissionStore.getState().addEvent(id, event);
        if (parsed.kind === 'session.error') {
          setTranscriptError(parsed.text || 'The agent failed before it replied.');
        }
        const { permission, permissionReplied } = parsed;
        if (permission) {
          setPendingPerms((cur) => (cur.some((p) => p.id === permission.id) ? cur : [...cur, permission]));
          notifyMission('OpenHub needs approval', permission.title || 'Agent is waiting on you', permission.id);
        } else if (permissionReplied) {
          setPendingPerms((cur) => cur.filter((p) => p.id !== permissionReplied));
        }
      },
      (message) => {
        // A dropped SSE feed is not proof the engine stopped working. Marking
        // the mission failed here made a phone that slept through the stream
        // report a live run as dead (and blocked re-subscribing on resume).
        // Keep the last real status; a terminal event or Stop still moves it.
        setError(message);
      },
      (result) => {
        // Engine-aligned completion signal. The terminal opencode bus event
        // names (`session.idle` / `session.completed` / `session.error`) are
        // UNVERIFIED against a live engine — see `subscribeMission`.
        useMissionStore.getState().setStatus(id, result);
        notifyMission('Mission finished', `Status: ${result}`, id);
      },
    );
  }, []);

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

  // The conversation: read history on selection (and for a finished mission),
  // then poll while a run is live. SSE deltas keep it current between reads;
  // this read is what repairs a suspended phone or a missed frame. It is also
  // the terminal-status fallback: the last assistant message's `finish` field
  // says whether the run actually stopped.
  useEffect(() => {
    if (!activeSessionId) {
      setTranscript([]);
      setTranscriptError(null);
      setTranscriptLoading(false);
      return;
    }
    let cancelled = false;
    const sessionChanged = lastTranscriptSessionRef.current !== activeSessionId;
    lastTranscriptSessionRef.current = activeSessionId;
    if (sessionChanged) {
      setTranscript([]);
      setTranscriptError(null);
      setTranscriptLoading(true);
    }

    let inFlight = false;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const messages = await fetchMessages(activeSessionId, 50);
        if (cancelled) return;
        const entries = normalizeTranscript(messages);
        // An empty read must not erase text that already streamed in; a later
        // poll will fill the gap. A non-empty read is authoritative.
        setTranscript((cur) => (entries.length > 0 || cur.length === 0 ? entries : cur));
        setTranscriptError(null);

        const mission = useMissionStore.getState().missions.find((m) => m.sessionId === activeSessionId);
        const next = missionStatusFromMessages(messages);
        if (mission && next && next !== mission.status) {
          useMissionStore.getState().setStatus(mission.id, next);
        }
      } catch (err) {
        if (!cancelled) setTranscriptError(err instanceof Error ? err.message : 'Unable to load the conversation');
      } finally {
        inFlight = false;
        if (!cancelled) setTranscriptLoading(false);
      }
    };

    void load();
    const running = activeMission?.status === 'planned' || activeMission?.status === 'running';
    if (!running) return () => { cancelled = true; };
    const timer = setInterval(() => { void load(); }, TRANSCRIPT_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeSessionId, activeMission?.status]);

  useEffect(() => {
    if (!activeSessionId) {
      setTelemetry(null);
      setTelemetryError(null);
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const raw = await fetchSession(activeSessionId);
        if (cancelled) return;
        setTelemetry(normalizeSessionTelemetry(raw));
        setTelemetryError(null);
      } catch (err) {
        // A persistent poll failure must be visible, not silently swallowed
        // while the engine chip still says "ready". Values stay `—`.
        if (cancelled) return;
        setTelemetry(null);
        setTelemetryError(err instanceof Error ? err.message : 'telemetry unavailable');
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

  // Nudge the inspector to re-read only when the SAME session's status changes.
  useEffect(() => {
    const session = activeSessionId ?? null;
    const status = activeMission?.status ?? null;
    const sameSession = session !== null && session === lastInspectorSessionRef.current;
    if (sameSession && lastInspectorStatusRef.current !== status) {
      setInspectorRefreshToken((k) => k + 1);
    }
    lastInspectorSessionRef.current = session;
    lastInspectorStatusRef.current = status;
  }, [activeSessionId, activeMission?.status]);

  // Recover approvals after a reload or a browser suspend. The engine shows a
  // permission once on the bus; without this read, a phone that was backgrounded
  // when it fired can never unblock the agent.
  useEffect(() => {
    if (!activeSessionId) {
      setPendingPerms([]);
      return;
    }
    let cancelled = false;
    const refresh = () => {
      void fetchPendingPermissions(activeSessionId)
        .then((list) => { if (!cancelled) setPendingPerms(list); })
        .catch(() => { /* engine down/unavailable — live events still populate */ });
    };
    refresh();
    // Android suspends a backgrounded PWA's SSE connection; any permission
    // asked while it was suspended is only on the bus, not in our state. Re-read
    // when the app becomes visible again (or the network returns).
    const onVisible = () => {
      if (typeof document === 'undefined' || document.visibilityState !== 'visible') return;
      refresh();
      // The stream may have exhausted its retries while the PWA was frozen.
      // Re-open it for a mission that can still emit events.
      const mission = useMissionStore.getState().missions.find((m) => m.id === activeId);
      if (mission && (mission.status === 'running' || mission.status === 'planned')) {
        subscribeTo(mission.sessionId ?? mission.id);
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
    };
  }, [activeSessionId, activeId, subscribeTo]);

  const selectMission = (id: string) => {
    const store = useMissionStore.getState();
    store.setActive(id);
    setShowEvents(false);
    setTranscript([]);
    setTranscriptError(null);
    setTranscriptLoading(true);
    const mission = store.missions.find((m) => m.id === id);
    // Only subscribe to missions that can still emit events; a finished session
    // would otherwise fail the stream and wrongly flip `done` to `failed`.
    if (mission && (mission.status === 'planned' || mission.status === 'running')) {
      subscribeTo(mission.sessionId ?? mission.id);
    }
  };

  const onSubmit = async (goal: string) => {
    // Chrome Android ignores Notification.requestPermission() outside a user
    // gesture; asking on mount silently did nothing. This is still the click
    // handler's stack, so the prompt is allowed.
    if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'default') {
      void Notification.requestPermission().catch(() => undefined);
    }
    setBusy(true);
    setError(null);
    try {
      const id = await createMission(goal);
      const store = useMissionStore.getState();
      setShowEvents(false);
      setTranscript([]);
      setTranscriptError(null);
      setTranscriptLoading(true);
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
    } catch (err) {
      // The abort did not succeed — keep `running` and surface it. Never report
      // a stop that did not happen.
      setError(err instanceof Error ? err.message : 'Unable to stop the mission');
      return;
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
        <button
          type="button"
          onClick={() => setInspectorOpen(true)}
          className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-raised)] px-2.5 py-1.5 text-xs font-medium text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-secondary)] lg:hidden"
          aria-label="Open diff inspector"
        >
          Diff / files
        </button>
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
              className="min-h-[44px] w-full rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-base)] px-2 py-1.5 text-xs text-[var(--color-text-primary)]"
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

          <MissionStatusHeader mission={activeMission} session={telemetry} elapsed={elapsed} />

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

          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--color-border-muted)] px-3 py-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
              {showEvents ? 'Event log' : 'Conversation'}
            </span>
            <button
              type="button"
              onClick={() => setShowEvents((value) => !value)}
              aria-pressed={showEvents}
              aria-label={showEvents ? 'Show conversation' : 'Show event log'}
              className="inline-flex min-h-[44px] items-center rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-raised)] px-2.5 py-0.5 text-[10px] font-semibold text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-secondary)] sm:min-h-0"
            >
              {showEvents ? 'Conversation' : 'Event log'}
            </button>
          </div>

          {showEvents ? (
            <MissionTimeline
              events={events}
              emptyLabel={activeMission ? 'No bus events recorded for this mission.' : undefined}
            />
          ) : (
            <MissionTranscript
              key={activeSessionId ?? 'no-mission'}
              entries={transcript}
              status={activeMission?.status}
              error={transcriptError}
              loading={transcriptLoading}
            />
          )}

          {/* The agent is blocked on these until answered. */}
          {pendingPerms.length > 0 && steerSessionId && (
            <div role="alert" className="shrink-0 border-t border-[var(--color-border-muted)] bg-[color-mix(in_srgb,var(--color-warning)_8%,transparent)] px-4 py-2 text-xs">
              {pendingPerms.map((p) => (
                <div key={p.id} className="flex flex-col gap-2 py-1 sm:flex-row sm:items-center sm:gap-2">
                  <span className="min-w-0 flex-1 truncate text-[var(--color-text-primary)]" title={p.title}>
                    Agent needs approval{p.type ? ` (${p.type})` : ''}: {p.title}
                  </span>
                  <div className="flex shrink-0 gap-2">
                    {(['once', 'always', 'reject'] as const).map((verdict) => (
                      <button
                        key={verdict}
                        type="button"
                        onClick={() => {
                          setPendingPerms((cur) => cur.filter((x) => x.id !== p.id));
                          respondToPermission(steerSessionId, p.id, verdict).catch((err) => {
                            setPendingPerms((cur) => [...cur, p]);
                            setError(err instanceof Error ? err.message : 'Unable to answer the permission request');
                          });
                        }}
                        className="min-h-[44px] flex-1 rounded-md border border-[var(--color-border-muted)] px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] sm:flex-none sm:px-2 sm:py-1 sm:text-xs"
                      >
                        {verdict === 'once' ? 'Allow once' : verdict === 'always' ? 'Always allow' : 'Deny'}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

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
                className="min-w-0 flex-1 resize-none rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-base)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:opacity-50"
              />
              <button
                type="button"
                onClick={() => void onSteer()}
                disabled={!canSteer}
                title={steerReason}
                className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md bg-[var(--color-accent-text)] px-3 py-1.5 text-xs font-semibold text-[var(--color-bg-base)] transition-colors hover:bg-[var(--color-accent-hover)] disabled:opacity-40 sm:min-h-0"
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
            refreshToken={inspectorRefreshToken}
          />
        </aside>
      </div>

      {/* Mobile inspector drawer */}
      {inspectorOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/70" onClick={() => setInspectorOpen(false)} />
          <div className="absolute right-0 top-0 h-full w-full max-w-md bg-[var(--color-surface-base)] border-l border-[var(--color-border-muted)] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-[var(--color-border-muted)] px-4 py-2.5">
              <span className="text-sm font-semibold text-[var(--color-text-primary)]">Inspector</span>
              <button
                type="button"
                onClick={() => setInspectorOpen(false)}
                aria-label="Close inspector"
                className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <MissionInspector
              sessionId={activeSessionId ?? null}
              telemetry={telemetry}
              refreshToken={inspectorRefreshToken}
            />
          </div>
        </div>
      )}

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
        {telemetryError && (
          <span className="text-[var(--color-warning)]" title={telemetryError}>
            telemetry unavailable
          </span>
        )}
        {busy && (
          <span className="ml-auto inline-flex items-center gap-1.5 text-[var(--color-text-secondary)]">
            <Loader2 className="h-3 w-3 animate-spin" /> starting mission…
          </span>
        )}
      </footer>
    </div>
  );
}
