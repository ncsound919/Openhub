import React, { Suspense, lazy, useEffect, useState } from 'react';
import { Bot } from 'lucide-react';
import type { PipelineJobView, PipelineStageView } from '../ide/usePipeline';
import { PipelineRobot, auditVerdict, doneForStages, etaMs, formatDuration, jobElapsedMs, nowStageForJob, partDefForStage, stageElapsedMs, todosForStages, useNowMs } from './PipelineRobot';
import { cn } from '../lib/utils';

const Scene = lazy(() =>
  import('./PipelineRobotScene').then((m) => ({ default: m.PipelineRobotCanvas })),
);

/** ErrorBoundary: if WebGL is unavailable the 3D scene throws — fall back to
 *  the flat robot instead of a blank panel. SSR never mounts the scene at all. */
class SceneErrorBoundary extends React.Component<{ fallback: React.ReactNode; children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function truncate(text: string, max = 220): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Deterministic build narration — the small paragraph under the visual.
 * Pure function of the job: mode/status, overall progress, the sector under
 * assembly and its vital detail, what is online, and what is queued next.
 */
export function describeBuild(job: PipelineJobView, nowMs: number = Date.now()): string {
  const pct = Math.round((job.progress ?? 0) * 100);
  const now = nowStageForJob(job.stages);
  const dones = doneForStages(job.stages);
  const todos = todosForStages(job.stages);
  const elapsed = jobElapsedMs(job, nowMs);
  const eta = etaMs(job, nowMs);
  const verdict = auditVerdict(job);
  const online = dones.filter((s) => s.ok !== false && s.status === 'done').map((s) => s.label);
  const head =
    job.status === 'complete'
      ? `The ${job.mode} build is complete at ${pct}%.`
      : job.status === 'failed'
        ? `The ${job.mode} build failed at ${pct}%.`
        : job.status === 'awaiting-approval'
          ? `The ${job.mode} plan is parked for approval at ${pct}%.`
          : job.status === 'cancelled'
            ? `The ${job.mode} build was cancelled at ${pct}%.`
            : `The ${job.mode} build is ${pct}% assembled and running.`;
  const working = now
    ? now.status === 'running'
      ? `Right now the ${now.label} sector${partDefForStage(now.id) ? ` (${partDefForStage(now.id)!.title})` : ''} is under assembly${now.detail ? `: ${truncate(now.detail, 200)}` : '.'}`
      : now.status === 'failed'
        ? `The ${now.label} sector failed${now.detail ? `: ${truncate(now.detail, 200)}` : ' and needs attention.'}`
        : now.status === 'pending'
          ? `Next up is the ${now.label} sector.`
          : `Last finished: ${now.label}.`
    : 'No stages in this run.';
  const tail =
    `${online.length} of ${job.stages.length} attachments online` +
    (online.length ? ` (${online.join(', ')})` : '') +
    (todos.length ? `; queued next: ${todos.map((s) => s.label).join(', ')}.` : '.') +
    (elapsed !== null ? ` Elapsed ${formatDuration(elapsed)}${eta !== null ? `, ETA ~${formatDuration(eta)}` : ''}.` : '') +
    (verdict ? ` Audit verdict: ${verdict.status}${verdict.score !== null ? `, score ${verdict.score}` : ''}${verdict.criticals !== null ? `, ${verdict.criticals} critical` : ''}.` : '') +
    (job.goal ? ` Goal: ${truncate(job.goal, 140)}` : '') +
    (job.error ? ` Fault: ${truncate(job.error, 140)}` : '');
  return `${head} ${working} ${tail}`;
}

function MiniList({ title, count, items, empty, tone, nowMs }: { title: string; count: number; items: PipelineStageView[]; empty: string; tone: 'todo' | 'done'; nowMs?: number }) {
  const rows = items.map((s) => ({ s, dur: nowMs !== undefined ? stageElapsedMs(s, nowMs) : null }));
  return (
    <div className="rounded-xl border border-[var(--color-border-muted)] p-3">
      <div className="text-[10px] font-black uppercase tracking-[0.16em] text-gray-400">
        {title} · {count}
      </div>
      {rows.length === 0 ? (
        <p className="mt-1.5 font-mono text-[11px] text-gray-400">{empty}</p>
      ) : (
        <ul className="mt-1.5 space-y-1.5">
          {rows.map(({ s, dur }) => {
            const part = partDefForStage(s.id);
            const dot =
              tone === 'done'
                ? s.status === 'skipped'
                  ? 'bg-gray-500'
                  : s.ok === false
                    ? 'bg-[var(--color-danger)]'
                    : 'bg-[#2ea043]'
                : 'bg-[#d29922]';
            return (
              <li key={s.id} className="flex items-center gap-2 font-mono text-[11px] text-gray-300">
                <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', dot)} />
                <span className="truncate" title={s.detail || s.status}>
                  {s.label}
                  {part ? <span className="text-gray-500"> → {part.title}</span> : null}
                  {tone === 'done' ? <span className="text-gray-500"> · {s.status === 'skipped' ? 'skipped' : s.ok === false ? 'needs attention' : 'ok'}</span> : null}
                  {dur !== null ? <span className="text-gray-500"> · {formatDuration(dur)}</span> : null}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function PipelineRobot3D({
  job,
  onApprove,
  onReject,
  actionBusy,
}: {
  job: PipelineJobView | null;
  /** Inline plan approval (Dashboard wires the shared controller here). */
  onApprove?: () => void;
  onReject?: () => void;
  actionBusy?: boolean;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  const nowMs = useNowMs(job?.status === 'running');
  if (!job) return null;

  const pct = Math.round((job.progress ?? 0) * 100);
  const now = nowStageForJob(job.stages);
  const nowPart = now ? partDefForStage(now.id) : null;
  const todos = todosForStages(job.stages);
  const dones = doneForStages(job.stages);
  const elapsed = jobElapsedMs(job, nowMs);
  const eta = etaMs(job, nowMs);
  const verdict = auditVerdict(job);
  const awaiting = job.status === 'awaiting-approval';
  const nowElapsed = now ? stageElapsedMs(now, nowMs) : null;

  const fallback = (
    <div className="flex h-80 items-center justify-center rounded-xl border border-dashed border-[var(--color-border-muted)] font-mono text-[11px] text-[var(--color-text-muted)] md:h-96">
      Assembling build-bot…
    </div>
  );

  return (
    <section aria-label={`3D build visualizer — ${job.mode} ${job.status}, ${pct} percent`} className="industrial-card overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-surface-overlay bg-surface-raised/60 px-4 py-3">
        <Bot className="h-4 w-4 text-[var(--color-accent-text)]" />
        <h2 className="!text-base">Build visualizer · 3D</h2>
        <span className="ml-auto font-mono text-[11px] text-[var(--color-text-muted)]">
          {job.mode} · {job.status} · {pct}%{elapsed !== null ? ` · ${formatDuration(elapsed)}` : ''}{eta !== null ? ` · ETA ~${formatDuration(eta)}` : ''}
        </span>
      </div>
      {job.goal ? (
        <div className="border-b border-surface-overlay px-4 py-2 font-mono text-[11px] text-[var(--color-text-secondary)]">
          <span className="text-[var(--color-text-muted)]">goal · </span>
          <span title={job.goal}>{truncate(job.goal, 160)}</span>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-2 font-mono text-[10px] text-gray-400" aria-label="Sector legend">
        <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-[#39ff6a]" /> working (pulsing)</span>
        <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-[#2ea043]" /> finished</span>
        <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-[#d29922]" /> to do</span>
        <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-[var(--color-danger)]" /> failed</span>
      </div>

      <div className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <div className="h-80 rounded-xl border border-surface-overlay bg-black/40 md:h-96">
          {mounted ? (
            <SceneErrorBoundary fallback={<PipelineRobot job={job} nowMs={nowMs} onApprove={onApprove} onReject={onReject} actionBusy={actionBusy} />}>
              <Suspense fallback={fallback}>
                <Scene job={job} />
              </Suspense>
            </SceneErrorBoundary>
          ) : (
            fallback
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          {awaiting && (
            <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3">
              <div className="text-[10px] font-black uppercase tracking-[0.16em] text-amber-300">
                Plan ready — approve to run
              </div>
              {onApprove && onReject ? (
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={onApprove}
                    disabled={actionBusy}
                    className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-500 disabled:opacity-40"
                  >
                    {actionBusy ? 'Working…' : 'Approve & run'}
                  </button>
                  <button
                    type="button"
                    onClick={onReject}
                    disabled={actionBusy}
                    className="rounded-md border border-[var(--color-border-muted)] px-3 py-1.5 text-xs font-semibold text-gray-300 hover:text-red-400 disabled:opacity-40"
                  >
                    Reject
                  </button>
                </div>
              ) : (
                <p className="mt-1 font-mono text-[11px] text-gray-400">Approve in the workspace command bar.</p>
              )}
            </div>
          )}
          {verdict && (
            <div className="rounded-xl border border-[var(--color-border-muted)] bg-surface-base/60 px-3 py-2 font-mono text-[11px] text-[var(--color-text-secondary)]">
              <span className="text-[var(--color-text-muted)]">audit verdict · </span>
              <span className="font-bold text-[var(--color-text-primary)]">{verdict.status}</span>
              {verdict.score !== null ? <span> · score {verdict.score}</span> : null}
              {verdict.criticals !== null ? <span> · {verdict.criticals} critical</span> : null}
            </div>
          )}
          <div className="rounded-xl border border-[color-mix(in_srgb,var(--color-accent)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-accent)_7%,transparent)] p-3">
            <div className="text-[10px] font-black uppercase tracking-[0.16em] text-[var(--color-accent-text)]">
              {now ? (now.status === 'running' ? 'Now working' : now.status === 'failed' ? 'Needs attention' : now.status === 'pending' ? 'Up next' : 'Last finished') : 'Idle'}
            </div>
            {now && (
              <div className="mt-1.5">
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-sm font-bold text-[var(--color-text-primary)]">{now.label}</span>
                  {nowPart && <span className="shrink-0 font-mono text-[10px] text-[var(--color-text-muted)]">→ {nowPart.title}</span>}
                </div>
                <p className="mt-1 font-mono text-[11px] leading-relaxed text-[var(--color-text-secondary)]" title={now.detail || now.status}>
                  {now.detail ? truncate(now.detail, 200) : `Status: ${now.status}`}
                </p>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
                  <div className="h-full rounded-full bg-[#39ff6a] transition-[width] duration-500" style={{ width: `${Math.round((now.progress ?? 0) * 100)}%` }} />
                </div>
                <div className="mt-1 font-mono text-[10px] text-[var(--color-text-muted)]">
                  stage {Math.round((now.progress ?? 0) * 100)}% · {now.status}
                  {nowElapsed !== null ? ` · ${formatDuration(nowElapsed)}` : ''}
                </div>
              </div>
            )}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <MiniList title="Todo" count={todos.length} items={todos} empty="Nothing queued." tone="todo" nowMs={nowMs} />
            <MiniList title="Done" count={dones.length} items={dones} empty="Nothing finished yet." tone="done" nowMs={nowMs} />
          </div>
        </div>
      </div>

      <p className="border-t border-surface-overlay px-4 py-3 font-mono text-[11px] leading-relaxed text-[var(--color-text-secondary)]">{describeBuild(job, nowMs)}</p>
    </section>
  );
}
