import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bot, CheckCircle2, Circle, ListChecks, Loader2, Plus, Send, Square, X,
} from 'lucide-react';
import {
  abortMission,
  createMission,
  fetchMessages,
  fetchPendingPermissions,
  fetchTodos,
  missionStatusFromMessages,
  respondToPermission,
  sendPrompt,
  steer,
  subscribeMission,
  type MissionTodo,
  type ParsedMissionEvent,
  type PendingPermission,
} from '../mission/useMission.js';
import { MissionTranscript } from '../mission/MissionTranscript';
import {
  appendTranscriptDelta,
  normalizeTranscript,
  upsertTranscriptRole,
  upsertTranscriptText,
  upsertTranscriptTool,
  type TranscriptEntry,
} from '../mission/transcript.js';
import type { MissionEvent, MissionStatus } from '../lib/missionStore.js';
import { useEngineStatus } from '../mission/EngineStatusBar';
import { cn } from '../lib/utils';
import { planTasksFromText, planTasksFromTodos, type PlanTask } from './agentPlan.js';

type Phase = 'idle' | 'planning' | 'awaiting' | 'running' | 'done' | 'failed';

interface EditorAgentPanelProps {
  /** Repository label for the header; the engine's working directory is configured server-side. */
  activeProjectName?: string | null;
  /**
   * A selection (or other context) to drop into the composer. A new `id` is a
   * new insertion; the same id is not re-applied when the panel re-renders.
   */
  seed?: { id: number; text: string } | null;
  onClose?: () => void;
}

const PLAN_FIRST_KEY = 'openhub.editor.planFirst';
const SESSION_KEY = 'openhub.editor.agent.v1';

function readPlanFirst(): boolean {
  try {
    return localStorage.getItem(PLAN_FIRST_KEY) !== '0';
  } catch {
    return true;
  }
}

/** The newest assistant reply after the latest user prompt. */
function latestAssistantText(entries: TranscriptEntry[]): string {
  if (!entries.length) return '';
  let lastUser = -1;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i].role === 'user') { lastUser = i; break; }
  }
  return entries
    .slice(lastUser + 1)
    .filter((entry) => entry.role === 'assistant' && entry.text.trim())
    .map((entry) => entry.text)
    .join('\n\n');
}

function planPrompt(goal: string): string {
  return [
    'Create an implementation plan for the task below.',
    'This is plan mode: do not edit files or run commands that change the workspace.',
    'Return a short numbered plan (3-8 concrete steps) and a todo checklist. Keep it concise.',
    '',
    `Task: ${goal}`,
  ].join('\n');
}

function revisionPrompt(goal: string, feedback: string): string {
  return [
    'Revise the implementation plan using the feedback below. Still do not edit files.',
    'Return the updated numbered plan and checklist.',
    '',
    `Original task: ${goal}`,
    `Feedback: ${feedback}`,
  ].join('\n');
}

function executionPrompt(goal: string): string {
  return [
    'The plan is approved. Execute it now in the workspace using the tools.',
    'The approved plan is the previous assistant message. Keep the todo list updated as you work, and report what changed when you are done.',
    '',
    `Task: ${goal || 'Execute the approved plan.'}`,
  ].join('\n');
}

/**
 * The prompts that route plan/execute turns are plumbing, not the user's words.
 * Render the goal or feedback they carry so the conversation reads naturally.
 */
function displayUserText(raw: string): string {
  if (raw.startsWith('Create an implementation plan for the task below.')) {
    return /(?:^|\n)Task:\s*([\s\S]*)$/.exec(raw)?.[1]?.trim() || 'Plan this change';
  }
  if (raw.startsWith('Revise the implementation plan using the feedback below.')) {
    const feedback = /(?:^|\n)Feedback:\s*([\s\S]*)$/.exec(raw)?.[1]?.trim();
    return feedback ? `Revise the plan: ${feedback}` : 'Revise the plan';
  }
  if (raw.startsWith('The plan is approved.')) return 'Execute the approved plan.';
  return raw;
}

/** Keep an optimistic prompt visible until the server history contains it. */
function mergePendingUsers(server: TranscriptEntry[], current: TranscriptEntry[]): TranscriptEntry[] {
  const pending = current.filter((entry) => entry.id.startsWith('local-'));
  if (pending.length === 0) return server;
  const seen = new Set(
    server.filter((entry) => entry.role === 'user').map((entry) => displayUserText(entry.text).trim()),
  );
  return [...server, ...pending.filter((entry) => !seen.has(displayUserText(entry.text).trim()))];
}

/**
 * The editor's docked coding agent: one conversation with the local Qwen model,
 * streamed through OpenHub's opencode proxy. Plan-first uses opencode's native
 * read-only `plan` agent; execution switches the same session to `build`, so the
 * approved plan stays in context. The plan checklist is parsed from the reply;
 * once the build agent writes todos, those become the authoritative checklist.
 */
export function EditorAgentPanel({ activeProjectName = null, seed = null, onClose }: EditorAgentPanelProps) {
  const engine = useEngineStatus();
  const [goal, setGoal] = useState('');
  const goalRef = useRef('');
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const phaseRef = useRef<Phase>('idle');
  const [status, setStatus] = useState<MissionStatus | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const transcriptRef = useRef<TranscriptEntry[]>([]);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [planTasks, setPlanTasks] = useState<PlanTask[]>([]);
  const [todos, setTodos] = useState<MissionTodo[]>([]);
  const [pendingPerms, setPendingPerms] = useState<PendingPermission[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [planFirst, setPlanFirst] = useState(readPlanFirst);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const runStartedAtRef = useRef(0);
  const finishingRef = useRef(false);
  const localMessageSeq = useRef(0);
  const restoreAttempted = useRef(false);

  const applyPhase = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const applyTranscript = useCallback((next: TranscriptEntry[] | ((cur: TranscriptEntry[]) => TranscriptEntry[])) => {
    setTranscript((cur) => {
      const value = typeof next === 'function' ? next(cur) : next;
      transcriptRef.current = value;
      return value;
    });
  }, []);

  const setSession = useCallback((id: string | null) => {
    sessionIdRef.current = id;
    setSessionId(id);
  }, []);

  /** Show the prompt immediately; history replaces it with the server message. */
  const appendUserMessage = useCallback((text: string) => {
    localMessageSeq.current += 1;
    const id = `local-${Date.now()}-${localMessageSeq.current}`;
    applyTranscript((cur) => [...cur, { id, role: 'user', text, tools: [], at: Date.now() }]);
  }, [applyTranscript]);

  const loadTodos = useCallback(async (id = sessionIdRef.current) => {
    if (!id) return;
    try {
      setTodos(await fetchTodos(id));
    } catch {
      // Keep the last known checklist; the next poll retries.
    }
  }, []);

  /**
   * Settle a completed plan turn. The SSE idle event is the primary signal, but
   * we read history here so the checklist never depends on a frame that arrived
   * before React mounted.
   */
  const finishPlan = useCallback(async (known?: unknown[]) => {
    if (finishingRef.current || phaseRef.current !== 'planning') return;
    finishingRef.current = true;
    try {
      const id = sessionIdRef.current;
      const raw = known ?? (id ? await fetchMessages(id, 50).catch(() => []) : []);
      const entries = raw.length ? normalizeTranscript(raw) : transcriptRef.current;
      if (raw.length && entries.length) applyTranscript((cur) => mergePendingUsers(entries, cur));
      const assistantAt = [...entries].reverse().find((entry) => entry.role === 'assistant' && entry.text)?.at;
      // Ignore an older completed turn if the new plan prompt has not landed yet.
      if (assistantAt !== undefined && runStartedAtRef.current && assistantAt < runStartedAtRef.current - 2_000) {
        return;
      }
      const planText = latestAssistantText(entries) || latestAssistantText(transcriptRef.current);
      setPlanTasks(planTasksFromText(planText));
      applyPhase('awaiting');
      setStatus('review');
      if (id) void loadTodos(id);
    } finally {
      finishingRef.current = false;
    }
  }, [applyPhase, applyTranscript, loadTodos]);

  const handleEnd = useCallback((result: 'done' | 'failed') => {
    if (result === 'failed') {
      setStatus('failed');
      applyPhase('failed');
      return;
    }
    if (phaseRef.current === 'planning') {
      void finishPlan();
      return;
    }
    if (phaseRef.current === 'running') {
      setStatus('done');
      applyPhase('done');
      setPlanTasks((cur) => cur.map((task) => ({ ...task, status: 'done' })));
      void loadTodos();
    }
  }, [applyPhase, finishPlan, loadTodos]);

  const handleEvent = useCallback((event: MissionEvent) => {
    const parsed = event as ParsedMissionEvent;
    if (parsed.kind === 'message.updated' && parsed.messageId && parsed.role) {
      applyTranscript((cur) => upsertTranscriptRole(cur, parsed.messageId!, parsed.role!, parsed.at));
      return;
    }
    if (parsed.kind === 'message.part.delta' && parsed.messageId && parsed.partId && parsed.delta) {
      if (parsed.field === undefined || parsed.field === 'text') {
        applyTranscript((cur) => appendTranscriptDelta(cur, parsed.messageId!, parsed.partId!, parsed.delta!, parsed.at));
      }
      return;
    }
    if (parsed.kind === 'message.part.updated' && parsed.messageId) {
      if (parsed.partType === 'text' && parsed.partText !== undefined) {
        applyTranscript((cur) =>
          upsertTranscriptText(cur, parsed.messageId!, parsed.partId ?? parsed.messageId!, parsed.partText!, parsed.at),
        );
      } else if (parsed.partType === 'tool' && parsed.tool) {
        applyTranscript((cur) => upsertTranscriptTool(cur, parsed.messageId!, parsed.tool!, parsed.at));
      }
      return;
    }
    if (parsed.kind === 'session.error') {
      setTranscriptError(parsed.text || 'The agent failed before it replied.');
    }
    if (parsed.permission) {
      setPendingPerms((cur) => (cur.some((p) => p.id === parsed.permission!.id) ? cur : [...cur, parsed.permission!]));
    } else if (parsed.permissionReplied) {
      setPendingPerms((cur) => cur.filter((p) => p.id !== parsed.permissionReplied));
    }
  }, [applyTranscript]);

  const subscribeTo = useCallback((id: string) => {
    unsubscribeRef.current?.();
    setPendingPerms([]);
    unsubscribeRef.current = subscribeMission(
      id,
      handleEvent,
      (message) => setError(message),
      handleEnd,
    );
  }, [handleEvent, handleEnd]);

  useEffect(() => () => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
  }, []);

  // Reload/close recovery: the opencode session is durable, so restore its id,
  // recent history and (when the saved turn was a plan) the plan review state.
  useEffect(() => {
    if (restoreAttempted.current) return;
    restoreAttempted.current = true;
    type SavedSession = { id?: unknown; goal?: unknown; phase?: unknown };
    let saved: SavedSession | null = null;
    try {
      saved = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null') as SavedSession | null;
    } catch {
      saved = null;
    }
    if (!saved || typeof saved.id !== 'string' || !saved.id) {
      try { localStorage.removeItem(SESSION_KEY); } catch { /* unavailable */ }
      return;
    }
    const id = saved.id;
    const goal = typeof saved.goal === 'string' ? saved.goal : '';
    const phases: Phase[] = ['idle', 'planning', 'awaiting', 'running', 'done', 'failed'];
    const savedPhase: Phase = phases.includes(saved.phase as Phase) ? (saved.phase as Phase) : 'done';
    setSession(id);
    goalRef.current = goal;
    setGoal('');
    applyPhase(savedPhase);
    setStatus(
      savedPhase === 'awaiting' ? 'review'
        : savedPhase === 'done' ? 'done'
          : savedPhase === 'failed' ? 'failed'
            : savedPhase === 'idle' ? null : 'running',
    );
    subscribeTo(id);
    setTranscriptLoading(true);
    let cancelled = false;
    void (async () => {
      try {
        const messages = await fetchMessages(id, 50);
        if (cancelled) return;
        const entries = normalizeTranscript(messages);
        if (entries.length) applyTranscript((cur) => mergePendingUsers(entries, cur));
        const next = missionStatusFromMessages(messages);
        if (next === 'done') {
          if (savedPhase === 'awaiting' || savedPhase === 'planning') {
            setPlanTasks(planTasksFromText(latestAssistantText(entries)));
            applyPhase('awaiting');
            setStatus('review');
          } else {
            applyPhase('done');
            setStatus('done');
          }
        } else if (next === 'failed') {
          applyPhase('failed');
          setStatus('failed');
        } else if (entries.length) {
          if (savedPhase === 'planning') { applyPhase('planning'); setStatus('running'); }
          else if (savedPhase === 'awaiting') { applyPhase('awaiting'); setStatus('review'); }
          else { applyPhase('running'); setStatus('running'); }
        } else {
          applyPhase('idle');
          setStatus(null);
        }
        void loadTodos(id);
      } catch (err) {
        if (!cancelled) {
          setTranscriptError(err instanceof Error ? err.message : 'Unable to restore the conversation');
          applyPhase('idle');
          setStatus(null);
        }
      } finally {
        if (!cancelled) setTranscriptLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [applyPhase, applyTranscript, loadTodos, setSession, subscribeTo]);

  // Keep the durable session id (and the turn's goal) across a phone reload.
  useEffect(() => {
    if (!sessionId) return;
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({ id: sessionId, goal: goalRef.current, phase }));
    } catch {
      // Storage can be unavailable in private mode; the turn still works.
    }
  }, [sessionId, phase]);

  // History + live repair. SSE deltas keep the reply current; this read covers a
  // suspended phone, a missed frame, and the terminal status.
  useEffect(() => {
    if (!sessionId) {
      setTranscriptLoading(false);
      return;
    }
    let cancelled = false;
    let inFlight = false;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const messages = await fetchMessages(sessionId, 50);
        if (cancelled) return;
        const entries = normalizeTranscript(messages);
        if (entries.length) applyTranscript((cur) => mergePendingUsers(entries, cur));
        else if (transcriptRef.current.length === 0) applyTranscript(entries);
        const next = missionStatusFromMessages(messages);
        const assistantAt = [...entries].reverse().find((entry) => entry.role === 'assistant' && entry.text)?.at;
        const stale = assistantAt !== undefined && runStartedAtRef.current > 0 && assistantAt < runStartedAtRef.current - 2_000;
        if (stale) return;
        if (next === 'done' && phaseRef.current === 'planning') {
          void finishPlan(messages);
        } else if (next === 'done' && phaseRef.current === 'running') {
          setStatus('done');
          applyPhase('done');
          setPlanTasks((cur) => cur.map((task) => ({ ...task, status: 'done' })));
          void loadTodos(sessionId);
        } else if (next) {
          // A restored plan review keeps its review status; the plan card owns
          // the approval action until the user approves or revises it.
          if (phaseRef.current === 'awaiting' && next === 'done') return;
          setStatus(next);
          if (next === 'failed' && (phaseRef.current === 'planning' || phaseRef.current === 'running')) {
            applyPhase('failed');
          }
        }
      } catch (err) {
        if (!cancelled) setTranscriptError(err instanceof Error ? err.message : 'Unable to load the conversation');
      } finally {
        inFlight = false;
        if (!cancelled) setTranscriptLoading(false);
      }
    };
    void load();
    if (phase !== 'planning' && phase !== 'running') {
      return () => { cancelled = true; };
    }
    const timer = setInterval(() => { void load(); }, 2_500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionId, phase, applyPhase, applyTranscript, finishPlan, loadTodos]);

  // Engine todos are the authoritative checklist once the build agent writes them.
  useEffect(() => {
    if (!sessionId) return;
    void loadTodos(sessionId);
    if (phase !== 'planning' && phase !== 'running') return;
    const timer = setInterval(() => { void loadTodos(sessionId); }, 3_000);
    return () => clearInterval(timer);
  }, [sessionId, phase, loadTodos]);

  // A phone that sleeps through permission.asked needs a read on resume.
  useEffect(() => {
    if (!sessionId) {
      setPendingPerms([]);
      return;
    }
    let cancelled = false;
    const refresh = () => {
      void fetchPendingPermissions(sessionId)
        .then((list) => { if (!cancelled) setPendingPerms(list); })
        .catch(() => { /* live events still populate */ });
    };
    refresh();
    const onVisible = () => {
      if (typeof document === 'undefined' || document.visibilityState !== 'visible') return;
      refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
    };
  }, [sessionId]);

  const startTask = async (text: string, plan: boolean) => {
    setBusy(true);
    setError(null);
    setTranscriptError(null);
    try {
      let target = sessionIdRef.current;
      if (!target) {
        target = await createMission(text);
        setSession(target);
        applyTranscript([]);
        setTranscriptLoading(true);
        setPlanTasks([]);
        setTodos([]);
        subscribeTo(target);
      }
      goalRef.current = text;
      setGoal(text);
      appendUserMessage(text);
      runStartedAtRef.current = Date.now();
      if (plan) {
        setPlanTasks([]);
        applyPhase('planning');
        setStatus('running');
        await sendPrompt(target, planPrompt(text), { agent: 'plan' });
      } else {
        setPlanTasks([]);
        applyPhase('running');
        setStatus('running');
        await sendPrompt(target, text, { agent: 'build' });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to start the agent');
      applyPhase('failed');
      setStatus('failed');
    } finally {
      setBusy(false);
    }
  };

  const approvePlan = async () => {
    const target = sessionIdRef.current;
    if (!target || busy) return;
    setBusy(true);
    setError(null);
    appendUserMessage('Execute the approved plan.');
    runStartedAtRef.current = Date.now();
    applyPhase('running');
    setStatus('running');
    try {
      await sendPrompt(target, executionPrompt(goalRef.current), { agent: 'build' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to start execution');
      applyPhase('awaiting');
      setStatus('review');
    } finally {
      setBusy(false);
    }
  };

  const handleSend = async () => {
    const text = goal.trim();
    if (!text || busy || engine?.available === false) return;
    const target = sessionIdRef.current;
    if ((phaseRef.current === 'planning' || phaseRef.current === 'running') && target) {
      setBusy(true);
      setError(null);
      appendUserMessage(text);
      try {
        await steer(target, text);
        setGoal('');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unable to steer the agent');
      } finally {
        setBusy(false);
      }
      return;
    }
    if (phaseRef.current === 'awaiting' && target) {
      setBusy(true);
      setError(null);
      setPlanTasks([]);
      setTodos([]);
      appendUserMessage(`Revise the plan: ${text}`);
      runStartedAtRef.current = Date.now();
      applyPhase('planning');
      setStatus('running');
      try {
        await sendPrompt(target, revisionPrompt(goalRef.current, text), { agent: 'plan' });
        setGoal('');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unable to revise the plan');
        applyPhase('awaiting');
        setStatus('review');
      } finally {
        setBusy(false);
      }
      return;
    }
    const plan = planFirst;
    await startTask(text, plan);
    setGoal('');
  };

  const stop = async () => {
    const target = sessionIdRef.current;
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      await abortMission(target, target);
      setStatus('done');
      applyPhase('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to stop the agent');
    } finally {
      setBusy(false);
    }
  };

  const newChat = () => {
    const target = sessionIdRef.current;
    if (target && (phaseRef.current === 'planning' || phaseRef.current === 'running')) {
      void abortMission(target, target).catch(() => undefined);
    }
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    try { localStorage.removeItem(SESSION_KEY); } catch { /* unavailable */ }
    setSession(null);
    applyTranscript([]);
    transcriptRef.current = [];
    setTranscriptError(null);
    setTranscriptLoading(false);
    setStatus(null);
    applyPhase('idle');
    setPlanTasks([]);
    setTodos([]);
    setPendingPerms([]);
    setGoal('');
    goalRef.current = '';
    runStartedAtRef.current = 0;
    setError(null);
  };

  const answerPermission = (permission: PendingPermission, response: 'once' | 'always' | 'reject') => {
    const target = sessionIdRef.current;
    if (!target) return;
    setPendingPerms((cur) => cur.filter((p) => p.id !== permission.id));
    respondToPermission(target, permission.id, response).catch(() => {
      void fetchPendingPermissions(target).then(setPendingPerms).catch(() => undefined);
    });
  };

  const togglePlanFirst = () => {
    setPlanFirst((value) => {
      const next = !value;
      try { localStorage.setItem(PLAN_FIRST_KEY, next ? '1' : '0'); } catch { /* unavailable */ }
      return next;
    });
  };

  // A selection from the editor is inserted as context (not sent on its own).
  // The user adds the instruction, then sends the whole message.
  useEffect(() => {
    if (!seed?.text.trim()) return;
    setGoal((cur) => (cur.trim() ? `${cur.replace(/\s+$/, '')}\n\n${seed.text}` : seed.text));
    requestAnimationFrame(() => {
      const el = composerRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, [seed]);

  const shownTranscript = transcript.map((entry) =>
    entry.role === 'user' ? { ...entry, text: displayUserText(entry.text) } : entry,
  );
  // The plan agent also writes a coarse one-line todo. During review the parsed
  // plan is far more useful, so the engine list only takes over once it carries
  // at least as much detail as the plan (or there is no parsed plan at all).
  const engineTasks = planTasksFromTodos(todos);
  const useEngineTasks = engineTasks.length > 0 && (planTasks.length === 0 || engineTasks.length >= planTasks.length);
  const tasks = useEngineTasks ? engineTasks : planTasks;
  const doneCount = tasks.filter((task) => task.status === 'done').length;
  const running = phase === 'planning' || phase === 'running';
  const online = engine?.available === true;
  const canSend = goal.trim().length > 0 && !busy && engine?.available !== false;
  const showPlan = tasks.length > 0 || phase === 'planning' || phase === 'awaiting';

  // Claude Code / Codex habit: Esc interrupts the turn instead of hunting for
  // the Stop button. Only while a turn is actually running.
  useEffect(() => {
    if (!running) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      void stop();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [running, stop]);
  const sendLabel =
    phase === 'planning' || phase === 'running' ? 'Steer'
      : phase === 'awaiting' ? 'Revise plan'
        : planFirst ? 'Plan' : 'Run';
  const placeholder =
    phase === 'planning' ? 'Steer the plan…'
      : phase === 'running' ? 'Steer the run…'
        : phase === 'awaiting' ? 'Ask for a plan change…'
          : 'Ask the agent to build, explain, or change something…';

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-surface-base)]">
      <header className="flex min-h-12 shrink-0 items-center gap-2 border-b border-[var(--color-border-muted)] px-3">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[color-mix(in_srgb,var(--color-accent)_16%,transparent)] text-[var(--color-accent-text)]">
          <Bot className="h-4 w-4" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-semibold text-[var(--color-text-primary)]">Agent</span>
            <span
              className="flex min-w-0 items-center gap-1 font-mono text-[10px] text-[var(--color-text-muted)]"
              title={online ? 'Local model on the Adreno GPU' : engine?.error ?? 'Engine unavailable'}
            >
              <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', online ? 'bg-[var(--color-success)]' : 'bg-[var(--color-warning)]')} />
              <span className="truncate">{online ? 'qwen3.5-4b' : 'engine down'}</span>
            </span>
          </div>
          <p className="truncate text-[10px] text-[var(--color-text-muted)]">
            {activeProjectName ? `In ${activeProjectName}` : 'Configured workspace'}
          </p>
        </div>
        <button
          type="button"
          onClick={newChat}
          aria-label="New agent chat"
          title="New chat"
          className="flex min-h-10 min-w-10 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
        >
          <Plus className="h-4 w-4" />
        </button>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close agent"
            title="Close"
            className="flex min-h-10 min-w-10 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </header>

      {showPlan && (
        <section aria-label="Plan tasks" className="shrink-0 border-b border-[var(--color-border-muted)] bg-[var(--color-surface-raised)]">
          <div className="flex min-h-9 items-center gap-2 px-3">
            <ListChecks className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent-text)]" aria-hidden="true" />
            <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
              {useEngineTasks ? 'Tasks' : 'Plan'}
            </span>
            {tasks.length > 0 && (
              <span className="font-mono text-[10px] text-[var(--color-text-muted)]">{doneCount}/{tasks.length}</span>
            )}
            {phase === 'planning' && <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--color-text-muted)]" aria-label="Planning" />}
            {phase === 'awaiting' && (
              <button
                type="button"
                onClick={() => void approvePlan()}
                disabled={busy || !sessionId}
                className="ml-auto inline-flex min-h-9 items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-2.5 text-[11px] font-semibold text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-40"
              >
                Approve &amp; run
              </button>
            )}
          </div>
          {tasks.length > 0 ? (
            <ul className="max-h-44 space-y-1 overflow-y-auto px-3 pb-2">
              {tasks.map((task) => (
                <li key={task.id} className="flex items-start gap-2 text-[11px] leading-snug">
                  {task.status === 'done' ? (
                    <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0 text-[var(--color-success)]" aria-label="Done" />
                  ) : task.status === 'in_progress' ? (
                    <Loader2 className="mt-px h-3.5 w-3.5 shrink-0 animate-spin text-[var(--color-info)]" aria-label="In progress" />
                  ) : (
                    <Circle className="mt-px h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" aria-label="Pending" />
                  )}
                  <span className={cn(
                    'min-w-0 flex-1 break-words',
                    task.status === 'done' ? 'text-[var(--color-text-muted)] line-through' : 'text-[var(--color-text-secondary)]',
                  )}>
                    {task.content}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-3 pb-2 text-[11px] text-[var(--color-text-muted)]">
              {phase === 'awaiting'
                ? 'The plan is in the conversation. Approve it to start execution.'
                : 'Drawing up a plan…'}
            </p>
          )}
        </section>
      )}

      <MissionTranscript
        entries={shownTranscript}
        status={phase === 'idle' ? undefined : status ?? (running ? 'running' : undefined)}
        error={error ?? transcriptError}
        loading={transcriptLoading}
        emptyLabel={sessionId ? undefined : 'Ask the agent to plan, explain, or change the workspace.'}
      />

      {pendingPerms.length > 0 && (
        <div role="alert" className="shrink-0 border-t border-[var(--color-border-muted)] bg-[color-mix(in_srgb,var(--color-warning)_8%,transparent)] px-3 py-2 text-xs">
          {pendingPerms.map((permission) => (
            <div key={permission.id} className="flex flex-col gap-1.5 py-1">
              <span className="min-w-0 truncate text-[var(--color-text-primary)]" title={permission.title}>
                Agent needs approval{permission.type ? ` (${permission.type})` : ''}: {permission.title}
              </span>
              <div className="flex gap-1.5">
                {(['once', 'always', 'reject'] as const).map((verdict) => (
                  <button
                    key={verdict}
                    type="button"
                    onClick={() => answerPermission(permission, verdict)}
                    className="min-h-9 flex-1 rounded-md border border-[var(--color-border-muted)] px-2 text-[11px] font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
                  >
                    {verdict === 'once' ? 'Allow once' : verdict === 'always' ? 'Always' : 'Deny'}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="shrink-0 border-t border-[var(--color-border-muted)] px-3 py-2">
        <textarea
          ref={composerRef}
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void handleSend();
            }
          }}
          rows={2}
          aria-label="Ask the coding agent"
          placeholder={placeholder}
          disabled={engine?.available === false}
          className="w-full resize-none rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-base)] px-2.5 py-2 text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:opacity-50"
        />
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={togglePlanFirst}
            aria-pressed={planFirst}
            title="Ask for an approvable plan before the agent edits anything"
            className={cn(
              'inline-flex min-h-9 items-center gap-1 rounded-md border px-2 text-[10px] font-semibold transition-colors',
              planFirst
                ? 'border-[color-mix(in_srgb,var(--color-accent)_45%,transparent)] bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)] text-[var(--color-accent-text)]'
                : 'border-[var(--color-border-muted)] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]',
            )}
          >
            <ListChecks className="h-3 w-3" aria-hidden="true" />
            Plan first
          </button>
          {running && (
            <button
              type="button"
              onClick={() => void stop()}
              disabled={busy}
              className="inline-flex min-h-9 items-center gap-1 rounded-md border border-[var(--color-border-strong)] px-2 text-[10px] font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] disabled:opacity-40"
            >
              <Square className="h-3 w-3" aria-hidden="true" />
              Stop
            </button>
          )}
          <span className="ml-auto hidden font-mono text-[9px] text-[var(--color-text-muted)] sm:inline">⌘/Ctrl+Enter</span>
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={!canSend}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-2.5 text-[11px] font-semibold text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Send className="h-3.5 w-3.5" aria-hidden="true" />}
            {sendLabel}
          </button>
        </div>
        <p className="mt-1 text-[10px] leading-snug text-[var(--color-text-muted)]">
          {phase === 'awaiting'
            ? 'Approve above, or send feedback to revise the plan.'
            : running
              ? 'Messages steer the current run.'
              : planFirst
                ? 'Plan first asks for a checklist before anything is edited.'
                : 'The agent runs directly in the configured workspace.'}
        </p>
      </div>
    </div>
  );
}
