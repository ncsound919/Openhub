import React from 'react';
import { Link } from 'react-router-dom';
import { Loader2, Rocket, XCircle } from 'lucide-react';
import { StatusLight } from './StatusLight';
import { usePipelineContext } from '../ide/PipelineProvider';
import { stageLight } from '../ide/usePipeline';
import { cn } from '../lib/utils';

/**
 * Global run indicator — the answer to "I can't tell if an audit is happening".
 * Lives in the app header, so a pipeline's progress and per-stage lights are
 * visible from every page, not just the workspace. Hidden when there is no run;
 * shows the last result briefly after one finishes.
 */
export function GlobalRunIndicator() {
  const { job, running, cancel } = usePipelineContext();
  if (!job) return null;

  const pct = Math.round((job.progress ?? 0) * 100);
  const tone = running ? 'var(--color-accent)' : job.status === 'complete' ? 'var(--color-success)' : 'var(--color-warning)';
  const active = job.stages.find((s) => s.status === 'running') ?? job.stages.find((s) => s.status === 'pending');

  return (
    <div
      className={cn(
        'hidden md:flex items-center gap-2 rounded-full border px-3 py-1 text-xs',
        running
          ? 'border-[color-mix(in_srgb,var(--color-accent)_45%,transparent)] bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)]'
          : 'border-[var(--color-border-muted)] bg-[var(--color-surface-raised)]',
      )}
      title={`${job.mode} pipeline: ${job.status}${job.error ? ` — ${job.error}` : ''}`}
    >
      <Link to="/workspace" className="flex items-center gap-2 min-w-0">
        {running ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--color-accent-text)]" />
        ) : (
          <Rocket className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />
        )}
        <span className="font-semibold text-[var(--color-text-secondary)] capitalize">{job.mode}</span>
        <span className="relative h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-white/10">
          <span
            className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500"
            style={{ width: `${pct}%`, background: tone, boxShadow: running ? `0 0 8px ${tone}` : undefined }}
          />
        </span>
        <span className="shrink-0 font-mono text-[10px] text-[var(--color-text-muted)]">{pct}%</span>
        <span className="hidden lg:flex items-center gap-1.5">
          {job.stages.map((s) => (
            <StatusLight key={s.id} state={stageLight(s)} dotOnly title={`${s.label}: ${s.detail || s.status}`} />
          ))}
        </span>
        {active && running && <span className="hidden xl:inline truncate text-[10px] text-[var(--color-text-muted)]">{active.label}…</span>}
      </Link>
      {running ? (
        <button
          type="button"
          onClick={(e) => { e.preventDefault(); void cancel(); }}
          aria-label="Cancel pipeline"
          title="Cancel run"
          className="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"
        >
          <XCircle className="h-3.5 w-3.5" />
        </button>
      ) : (
        <StatusLight state={job.status === 'complete' ? 'ok' : job.status === 'cancelled' ? 'warn' : 'error'} dotOnly title={job.error || job.status} />
      )}
    </div>
  );
}
