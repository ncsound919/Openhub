import React, { useEffect, useRef } from 'react';
import { ShieldCheck, Loader2, Rocket, XCircle, ArrowRight, MessageSquare } from 'lucide-react';
import { Link } from 'react-router-dom';
import { StatusLight, type LightState } from '../components/StatusLight';
import { stageLight, type PipelineController } from './usePipeline';
import { cn } from '../lib/utils';

/**
 * AxiomBar — the workspace control surface.
 *
 * It is deliberately NOT a second chat box. There is one conversational input
 * (the Axiom chat panel); this bar is status + the primary actions + the live
 * progress stream. That removes the "which box do I type in?" confusion: the
 * only place to type is the chat, and this bar can focus it.
 */
export function AxiomBar({
  projectName,
  hasProject,
  axiomOnline,
  onRequestChat,
  pipeline,
}: {
  projectName?: string;
  hasProject: boolean;
  axiomOnline: boolean | null;
  onRequestChat: () => void;
  pipeline: PipelineController;
}) {
  const { job, starting, running } = pipeline;
  const chatRef = useRef<HTMLButtonElement>(null);

  // ⌘K / Ctrl+K focuses the Axiom chat input (the single input).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        onRequestChat();
        window.dispatchEvent(new CustomEvent('openhub:focus-ask'));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onRequestChat]);

  const run = (mode: 'autopilot' | 'audit') => { void pipeline.start(mode); };

  const pct = job ? Math.round((job.progress ?? 0) * 100) : 0;
  const resultLight: LightState = !job
    ? 'idle'
    : running
      ? 'working'
      : job.status === 'complete'
        ? 'ok'
        : job.status === 'cancelled'
          ? 'warn'
          : 'error';
  const resultLabel = !job
    ? ''
    : running
      ? `Running ${job.mode}…`
      : job.status === 'complete'
        ? 'Pipeline complete'
        : job.status === 'cancelled'
          ? 'Pipeline cancelled'
          : job.error || 'Pipeline failed';

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--color-border-muted)] bg-[var(--color-surface-raised)] px-3 py-2">
      <div className="flex shrink-0 items-center gap-2.5">
        <StatusLight
          state={axiomOnline === null ? 'idle' : axiomOnline ? 'ok' : 'offline'}
          label={axiomOnline === null ? 'Axiom…' : axiomOnline ? 'Axiom' : 'Axiom offline'}
          title={axiomOnline ? 'Axiom backend online' : 'Axiom backend unreachable'}
        />
        <span className="h-4 w-px bg-[var(--color-border-muted)]" />
        <StatusLight
          state={hasProject ? 'ok' : 'warn'}
          label={projectName || (hasProject ? 'Project loaded' : 'No project')}
          title={hasProject ? `Active project: ${projectName}` : 'Load a project to enable agent actions'}
        />
      </div>

      {/* Progress stream, or a prompt to open the chat. */}
      {job ? (
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1.5">
          <div className="flex min-w-[8rem] flex-1 items-center gap-2">
            <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-white/10">
              <div
                className={cn('h-full rounded-full transition-[width] duration-500', running ? 'bg-[var(--color-accent)]' : job.status === 'complete' ? 'bg-[var(--color-success)]' : 'bg-[var(--color-warning)]')}
                style={{ width: `${pct}%`, boxShadow: running ? '0 0 8px var(--color-accent)' : undefined }}
              />
            </div>
            <span className="shrink-0 font-mono text-[10px] text-[var(--color-text-muted)]">{pct}%</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            {job.stages.map((s) => (
              <StatusLight key={s.id} state={stageLight(s)} label={s.label} title={`${s.label}: ${s.detail || s.status}`} />
            ))}
          </div>
          <StatusLight state={resultLight} label={resultLabel} className="max-w-[22rem]" title={resultLabel} />
          {running && (
            <button
              type="button"
              onClick={() => void pipeline.cancel()}
              className="flex items-center gap-1 rounded-md border border-[var(--color-border-muted)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-danger)]"
            >
              <XCircle className="h-3 w-3" /> Cancel
            </button>
          )}
        </div>
      ) : (
        <button
          ref={chatRef}
          type="button"
          onClick={onRequestChat}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-base)] px-3 py-1.5 text-left text-xs text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-text-primary)]"
          title="Open the Axiom chat (⌘K)"
        >
          <MessageSquare className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent-text)]" />
          <span className="min-w-0 flex-1 truncate">Ask Axiom, run a loop, audit, or compose — open the chat (⌘K)</span>
          <ArrowRight className="h-3.5 w-3.5 shrink-0" />
        </button>
      )}

      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={() => run('autopilot')}
          disabled={!hasProject || running || starting}
          className="flex items-center gap-1 rounded-md bg-[var(--color-accent)] px-2.5 py-1 text-[10px] font-bold text-white hover:brightness-110 disabled:opacity-50"
          style={running ? { boxShadow: '0 0 10px var(--color-accent)' } : undefined}
          title="Autopilot: typecheck → adversary → audit → repair → loop → verify"
        >
          {starting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Rocket className="h-3 w-3" />}
          Autopilot
        </button>
        <button
          type="button"
          onClick={() => run('audit')}
          disabled={!hasProject || running || starting}
          className="flex items-center gap-1 rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-base)] px-2 py-1 text-[10px] font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] disabled:opacity-40"
          title="Run the audit team and dispatch repair if it fails"
        >
          <ShieldCheck className="h-3 w-3" /> Audit
        </button>
        <Link
          to="/assurance"
          className="flex items-center gap-1 text-[10px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
          title="Full reports"
        >
          Reports <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
    </div>
  );
}
