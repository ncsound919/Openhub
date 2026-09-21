import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Send, ShieldCheck, Loader2, Sparkles, Wand2, Play, CornerDownLeft, Rocket, XCircle, ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { getAuthHeaders, getCsrfToken } from '../auth/AuthProvider';
import { StatusLight, type LightState } from '../components/StatusLight';
import { cn } from '../lib/utils';

type PanelId = 'autonomy' | 'composer' | 'agent' | 'threads' | 'review';

type StageStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed' | 'cancelled';
interface PipelineStageView {
  id: string;
  label: string;
  status: StageStatus;
  ok: boolean | null;
  detail: string;
  progress: number;
}
interface PipelineJobView {
  id: string;
  mode: string;
  status: 'running' | 'complete' | 'failed' | 'cancelled';
  progress: number;
  stages: PipelineStageView[];
  error: string | null;
}

const SUGGESTIONS: Array<{ label: string; prompt: string }> = [
  { label: 'Explain this project', prompt: 'Explain this project: what it does, its architecture, and its riskiest areas.' },
  { label: 'Find bugs', prompt: 'Audit this codebase for correctness bugs and security issues, and tell me the highest-impact ones first.' },
  { label: 'Write tests', prompt: 'Identify the least-tested critical paths in this project and write focused tests for them.' },
];

function stageLight(s: PipelineStageView): LightState {
  if (s.status === 'running') return 'working';
  if (s.status === 'failed') return 'error';
  if (s.status === 'cancelled') return 'warn';
  if (s.status === 'done') return s.ok === false ? 'warn' : 'ok';
  if (s.status === 'skipped') return 'idle';
  return 'idle';
}

/**
 * AxiomBar — the single, always-visible place to direct Axiom in the workspace.
 *
 * It offers the two headline actions as one click: Autopilot runs the whole
 * project pipeline (typecheck → audit → repair → agent loop → verify) as a
 * background job, and Audit runs the audit/repair half. Both are polled, so the
 * bar shows a real progress bar and a light per stage instead of a spinner that
 * may or may not be doing anything.
 */
export function AxiomBar({
  projectName,
  hasProject,
  axiomOnline,
  onRequestChat,
  onOpenPanel,
}: {
  projectName?: string;
  hasProject: boolean;
  axiomOnline: boolean | null;
  onRequestChat: () => void;
  onOpenPanel: (panel: PanelId) => void;
}) {
  const [text, setText] = useState('');
  const [pipeline, setPipeline] = useState<PipelineJobView | null>(null);
  const [starting, setStarting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => () => { mountedRef.current = false; if (pollTimer.current) clearTimeout(pollTimer.current); }, []);

  const ask = useCallback(
    (prompt: string) => {
      const trimmed = prompt.trim();
      if (!trimmed || !hasProject) return;
      window.dispatchEvent(new CustomEvent('openhub:ask', { detail: { text: trimmed } }));
      onRequestChat();
    },
    [hasProject, onRequestChat],
  );

  const submit = () => {
    if (!text.trim()) return;
    ask(text);
    setText('');
  };

  const pollPipeline = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/pipeline/${encodeURIComponent(id)}`, { credentials: 'include', headers: getAuthHeaders() });
      const json = await res.json().catch(() => ({}));
      if (!mountedRef.current) return;
      const job = json?.job as PipelineJobView | undefined;
      if (job) setPipeline(job);
      if (job && job.status === 'running') {
        pollTimer.current = setTimeout(() => void pollPipeline(id), 1500);
      }
    } catch {
      if (mountedRef.current) pollTimer.current = setTimeout(() => void pollPipeline(id), 3000);
    }
  }, []);

  const runPipeline = async (mode: 'autopilot' | 'audit') => {
    if (!hasProject || starting || pipeline?.status === 'running') return;
    const goal = text.trim();
    setStarting(true);
    try {
      const res = await fetch('/api/pipeline/run', {
        method: 'POST',
        credentials: 'include',
        headers: getAuthHeaders({ 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() }),
        body: JSON.stringify({ mode, ...(goal ? { goal } : {}) }),
      });
      const json = await res.json().catch(() => ({}));
      const job = json?.job as PipelineJobView | undefined;
      if (job) {
        setPipeline(job);
        if (goal) setText('');
        if (pollTimer.current) clearTimeout(pollTimer.current);
        void pollPipeline(job.id);
      }
    } catch { /* surfaced by the next poll / result light */ } finally {
      setStarting(false);
    }
  };

  const cancel = async () => {
    if (!pipeline) return;
    try {
      await fetch(`/api/pipeline/${encodeURIComponent(pipeline.id)}/cancel`, {
        method: 'POST', credentials: 'include',
        headers: getAuthHeaders({ 'X-CSRF-Token': getCsrfToken() }),
      });
    } catch { /* poll will reflect the final state */ }
  };

  // ⌘K / Ctrl+K focuses the command bar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const running = pipeline?.status === 'running';
  const pct = pipeline ? Math.round((pipeline.progress ?? 0) * 100) : 0;
  const resultLight: LightState = !pipeline
    ? 'idle'
    : running
      ? 'working'
      : pipeline.status === 'complete'
        ? 'ok'
        : pipeline.status === 'cancelled'
          ? 'warn'
          : 'error';
  const resultLabel = !pipeline
    ? ''
    : running
      ? `Running ${pipeline.mode}…`
      : pipeline.status === 'complete'
        ? 'Pipeline complete'
        : pipeline.status === 'cancelled'
          ? 'Pipeline cancelled'
          : pipeline.error || 'Pipeline failed';

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--color-border-muted)] bg-[var(--color-surface-raised)] px-3 py-2">
      <div className="flex shrink-0 items-center gap-2.5">
        <StatusLight
          state={axiomOnline === null ? 'idle' : axiomOnline ? 'ok' : 'offline'}
          label={axiomOnline === null ? 'Axiom…' : axiomOnline ? 'Axiom' : 'Axiom offline'}
          title={axiomOnline ? 'Axiom backend online' : 'Axiom backend unreachable — loops and Tab completion are unavailable'}
        />
        <span className="h-4 w-px bg-[var(--color-border-muted)]" />
        <StatusLight
          state={hasProject ? 'ok' : 'warn'}
          label={projectName || (hasProject ? 'Project loaded' : 'No project')}
          title={hasProject ? `Active project: ${projectName}` : 'Load a project to enable agent actions'}
        />
      </div>

      <div className="relative flex min-w-[16rem] flex-1 items-center">
        <Sparkles className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-[var(--color-accent-text)]" />
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          disabled={!hasProject}
          aria-label="Ask Axiom"
          placeholder={
            hasProject
              ? `Ask Axiom to build, fix, audit, or explain${projectName ? ` ${projectName}` : ''}…  (⌘K)`
              : 'Load a project to start working with Axiom…'
          }
          className="w-full rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-base)] py-1.5 pl-8 pr-[4.5rem] text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] outline-none focus:border-[var(--color-accent)] focus:shadow-[0_0_0_1px_var(--color-accent)] disabled:opacity-50"
        />
        <button
          type="button"
          onClick={submit}
          disabled={!hasProject || !text.trim()}
          className="absolute right-1 flex items-center gap-1 rounded bg-[var(--color-accent)] px-2 py-1 text-[10px] font-semibold text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-30"
          title="Send to Axiom"
        >
          <Send className="h-3 w-3" />
          Ask
          <CornerDownLeft className="h-3 w-3 opacity-70" />
        </button>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={() => void runPipeline('autopilot')}
          disabled={!hasProject || running || starting}
          className="flex items-center gap-1 rounded-md bg-[var(--color-accent)] px-2 py-1 text-[10px] font-bold text-white hover:brightness-110 disabled:opacity-50"
          style={running ? { boxShadow: '0 0 10px var(--color-accent)' } : undefined}
          title="Autopilot: typecheck → audit → repair → agent loop → verify (uses the input as the goal, if any)"
        >
          {starting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Rocket className="h-3 w-3" />}
          Autopilot
        </button>
        <button
          type="button"
          onClick={() => void runPipeline('audit')}
          disabled={!hasProject || running || starting}
          className="flex items-center gap-1 rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-base)] px-2 py-1 text-[10px] font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] disabled:opacity-40"
          title="Run the audit team and dispatch repair if it fails"
        >
          <ShieldCheck className="h-3 w-3" /> Audit
        </button>
        <button
          type="button"
          onClick={() => onOpenPanel('autonomy')}
          disabled={!hasProject}
          className="flex items-center gap-1 rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-base)] px-2 py-1 text-[10px] font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] disabled:opacity-40"
          title="Run the autonomous loop against this project"
        >
          <Play className="h-3 w-3" /> Loop
        </button>
        <button
          type="button"
          onClick={() => onOpenPanel('composer')}
          disabled={!hasProject}
          className="flex items-center gap-1 rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-base)] px-2 py-1 text-[10px] font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] disabled:opacity-40"
          title="Multi-file composer"
        >
          <Wand2 className="h-3 w-3" /> Compose
        </button>
      </div>

      {/* Pipeline progress / result, or one-click starting prompts. */}
      <div className="flex basis-full flex-wrap items-center gap-x-3 gap-y-1.5">
        {pipeline ? (
          <>
            <div className="flex min-w-[10rem] flex-1 items-center gap-2">
              <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-white/10">
                <div
                  className={cn('h-full rounded-full transition-[width] duration-500', running ? 'bg-[var(--color-accent)]' : pipeline.status === 'complete' ? 'bg-[var(--color-success)]' : 'bg-[var(--color-warning)]')}
                  style={{ width: `${pct}%`, boxShadow: running ? '0 0 8px var(--color-accent)' : undefined }}
                />
              </div>
              <span className="shrink-0 font-mono text-[10px] text-[var(--color-text-muted)]">{pct}%</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
              {pipeline.stages.map((s) => (
                <StatusLight key={s.id} state={stageLight(s)} label={s.label} title={`${s.label}: ${s.detail || s.status}`} />
              ))}
            </div>
            <StatusLight state={resultLight} label={resultLabel} className="max-w-[24rem]" title={resultLabel} />
            {running ? (
              <button
                type="button"
                onClick={() => void cancel()}
                className="flex items-center gap-1 rounded-md border border-[var(--color-border-muted)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-danger)]"
              >
                <XCircle className="h-3 w-3" /> Cancel
              </button>
            ) : (
              <Link to="/assurance" className="flex items-center gap-1 text-[10px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]">
                Full report <ArrowRight className="h-3 w-3" />
              </Link>
            )}
          </>
        ) : (
          hasProject && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--color-text-muted)]">Try</span>
              {SUGGESTIONS.map((s) => (
                <button
                  key={s.label}
                  type="button"
                  onClick={() => ask(s.prompt)}
                  className="rounded-full border border-[var(--color-border-muted)] bg-[var(--color-surface-base)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)] hover:border-[var(--color-accent)] hover:text-[var(--color-text-primary)]"
                  title={s.prompt}
                >
                  {s.label}
                </button>
              ))}
            </div>
          )
        )}
      </div>
    </div>
  );
}
