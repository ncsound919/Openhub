import React, { useEffect, useState } from 'react';
import { Bot } from 'lucide-react';
import { stageLight, type PipelineJobView, type PipelineStageView } from '../ide/usePipeline';
import { cn } from '../lib/utils';

/**
 * PipelineRobot — the answer to "autopilot says running but I can't see
 * anything happening".
 *
 * A central, graphic build visualizer: every pipeline stage is a robot
 * attachment (head / arms / torso / drive / visor) that materializes as its
 * stage runs and locks in when it finishes. The running attachment pulses with
 * a NOW WORKING card carrying the vital details; pending stages are the TODO
 * list; finished stages are the DONE list. Pure render of `PipelineJobView` —
 * no timers, no browser APIs, SSR-safe.
 */

export type RobotPartKey = 'head' | 'visor' | 'torso' | 'arm-left' | 'arm-right' | 'legs';

interface PartDef {
  key: RobotPartKey;
  title: string;
  blurb: string;
}

export const ROBOT_PARTS: PartDef[] = [
  { key: 'head', title: 'Sensor head', blurb: 'Type safety scan' },
  { key: 'visor', title: 'Verifier visor', blurb: 'Final gate' },
  { key: 'torso', title: 'Audit core', blurb: 'Team verdict' },
  { key: 'arm-left', title: 'Probe arm', blurb: 'Fault injection' },
  { key: 'arm-right', title: 'Repair arm', blurb: 'Fix dispatch' },
  { key: 'legs', title: 'Drive legs', blurb: 'Agent loop' },
];

/** Fixed stage → robot attachment mapping. Unknown/custom stages render as
 *  bolt-on modules (still listed in TODO/DONE), never as a wrong body part. */
const STAGE_PART: Record<string, RobotPartKey> = {
  typecheck: 'head',
  adversary: 'arm-left',
  audit: 'torso',
  repair: 'arm-right',
  loop: 'legs',
  verify: 'visor',
};

export function partKeyForStage(stageId: string): RobotPartKey | null {
  return STAGE_PART[stageId] ?? null;
}

export function partDefForStage(stageId: string): PartDef | null {
  const key = partKeyForStage(stageId);
  return key ? (ROBOT_PARTS.find((p) => p.key === key) ?? null) : null;
}

/** Stages that haven't started — the TODO list. */
export function todosForStages(stages: PipelineStageView[]): PipelineStageView[] {
  return stages.filter((s) => s.status === 'pending');
}

/** Stages that finished (done or skipped) — the DONE list. */
export function doneForStages(stages: PipelineStageView[]): PipelineStageView[] {
  return stages.filter((s) => s.status === 'done' || s.status === 'skipped');
}

/** The stage to spotlight: running first, then failed, then the next todo. */
export function nowStageForJob(stages: PipelineStageView[]): PipelineStageView | null {
  return (
    stages.find((s) => s.status === 'running') ??
    stages.find((s) => s.status === 'failed') ??
    stages.find((s) => s.status === 'pending') ??
    stages[stages.length - 1] ??
    null
  );
}

/** Human duration: "45s", "3m 12s", "1h 02m", "—" when not computable. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

function ts(v: string | null | undefined): number | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** Elapsed ms for one stage: ended−started when finished, now−started while
 *  running, null when pending or the timestamps are absent. */
export function stageElapsedMs(stage: PipelineStageView, nowMs: number): number | null {
  const start = ts(stage.startedAt);
  if (start === null || stage.status === 'pending') return null;
  const end = stage.status === 'running' ? nowMs : (ts(stage.endedAt) ?? nowMs);
  return Math.max(0, end - start);
}

/** Elapsed ms for the whole job, or null without a created timestamp. */
export function jobElapsedMs(job: PipelineJobView, nowMs: number): number | null {
  const start = ts(job.createdAt);
  if (start === null) return null;
  const end = job.status === 'running' || job.status === 'awaiting-approval' ? nowMs : (ts(job.updatedAt) ?? nowMs);
  return Math.max(0, end - start);
}

/** Rough ETA while running with partial progress; null otherwise. Linear
 *  extrapolation, so it is labeled approximate wherever it is shown. */
export function etaMs(job: PipelineJobView, nowMs: number): number | null {
  if (job.status !== 'running') return null;
  const p = job.progress ?? 0;
  const elapsed = jobElapsedMs(job, nowMs);
  if (elapsed === null || p <= 0 || p >= 1) return null;
  return Math.round((elapsed * (1 - p)) / p);
}

export interface AuditVerdict {
  status: string;
  score: number | null;
  criticals: number | null;
}

/** The audit verdict the backend already attaches to the job payload — no
 *  second fetch needed. Null until a report lands on the job. */
export function auditVerdict(job: PipelineJobView): AuditVerdict | null {
  const a = job.audit;
  if (!a || typeof a !== 'object') return null;
  if (typeof a.overallStatus !== 'string' && typeof a.overallScore !== 'number') return null;
  return {
    status: typeof a.overallStatus === 'string' ? a.overallStatus : '—',
    score: typeof a.overallScore === 'number' ? a.overallScore : null,
    criticals: typeof a.criticalFindings === 'number' ? a.criticalFindings : null,
  };
}

/** Ticking clock for live elapsed/ETA. Only ticks while `active`; the robot
 *  itself stays a pure function of (`job`, `nowMs`) for tests. */
export function useNowMs(active: boolean, stepMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), stepMs);
    return () => clearInterval(t);
  }, [active, stepMs]);
  return now;
}

type LightState = 'idle' | 'working' | 'ok' | 'warn' | 'error' | 'offline';

function partColors(light: LightState): { stroke: string; fill: string; glow: boolean; dashed: boolean } {
  switch (light) {
    case 'working':
      return { stroke: 'var(--color-accent)', fill: 'color-mix(in srgb, var(--color-accent) 14%, transparent)', glow: true, dashed: false };
    case 'ok':
      return { stroke: 'var(--color-success)', fill: 'color-mix(in srgb, var(--color-success) 16%, transparent)', glow: false, dashed: false };
    case 'error':
      return { stroke: 'var(--color-danger)', fill: 'color-mix(in srgb, var(--color-danger) 14%, transparent)', glow: true, dashed: false };
    case 'warn':
      return { stroke: 'var(--color-warning)', fill: 'color-mix(in srgb, var(--color-warning) 12%, transparent)', glow: false, dashed: false };
    case 'offline':
      return { stroke: 'var(--color-text-muted)', fill: 'transparent', glow: false, dashed: true };
    case 'idle':
    default:
      return { stroke: 'color-mix(in srgb, var(--color-text-muted) 45%, transparent)', fill: 'transparent', glow: false, dashed: true };
  }
}

function PartGroup({
  light,
  label,
  children,
}: {
  light: LightState;
  label: string;
  children: React.ReactNode;
}) {
  const c = partColors(light);
  return (
    <g
      className={cn(light === 'working' && 'animate-pulse')}
      style={c.glow ? { filter: `drop-shadow(0 0 6px ${c.stroke})` } : undefined}
    >
      <title>{label}</title>
      {React.Children.map(children, (child) =>
        React.isValidElement(child)
          ? React.cloneElement(child as React.ReactElement<{ stroke?: string; fill?: string; strokeDasharray?: string; strokeWidth?: number }>, {
              stroke: c.stroke,
              fill: c.fill,
              strokeWidth: light === 'idle' || light === 'offline' ? 1.25 : 2,
              ...(c.dashed ? { strokeDasharray: '5 4' } : {}),
            })
          : child,
      )}
    </g>
  );
}

function truncate(text: string, max = 150): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function PipelineRobot({
  job,
  nowMs: nowMsProp,
  onApprove,
  onReject,
  actionBusy,
}: {
  job: PipelineJobView | null;
  /** Clock for elapsed/ETA. Defaults to Date.now(); pass a ticking value to go live. */
  nowMs?: number;
  /** When present and the job is parked, the approval action renders inline. */
  onApprove?: () => void;
  onReject?: () => void;
  actionBusy?: boolean;
}) {
  if (!job) return null;
  const nowMs = nowMsProp ?? Date.now();

  const stages = job.stages;
  const byPart = new Map<RobotPartKey, PipelineStageView>();
  for (const s of stages) {
    const key = partKeyForStage(s.id);
    if (key && !byPart.has(key)) byPart.set(key, s);
  }
  const lightOf = (key: RobotPartKey): LightState => {
    const s = byPart.get(key);
    return s ? stageLight(s) : 'idle';
  };
  const labelOf = (key: RobotPartKey): string => {
    const s = byPart.get(key);
    const def = ROBOT_PARTS.find((p) => p.key === key);
    return s ? `${def?.title ?? key} · ${s.label} (${s.status}${s.ok === false ? ', needs attention' : ''})` : `${def?.title ?? key} · not in this run`;
  };

  const pct = Math.round((job.progress ?? 0) * 100);
  const now = nowStageForJob(stages);
  const nowPart = now ? partDefForStage(now.id) : null;
  const todos = todosForStages(stages);
  const dones = doneForStages(stages);
  const doneRows = dones.map((s) => ({ s, dur: stageElapsedMs(s, nowMs) }));
  const modules = stages.filter((s) => !partKeyForStage(s.id));
  const elapsed = jobElapsedMs(job, nowMs);
  const eta = etaMs(job, nowMs);
  const verdict = auditVerdict(job);
  const awaiting = job.status === 'awaiting-approval';
  const nowElapsed = now ? stageElapsedMs(now, nowMs) : null;

  return (
    <section aria-label={`Autopilot build visualizer — ${job.mode} ${job.status}, ${pct} percent`} className="industrial-card overflow-hidden">
      <div className="flex items-center gap-2 border-b border-surface-overlay bg-surface-raised/60 px-4 py-3">
        <Bot className="h-4 w-4 text-[var(--color-accent-text)]" />
        <h2 className="!text-base">Build visualizer</h2>
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

      <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        {/* Robot — parts assemble as stages run */}
        <div className="flex items-center justify-center">
          <svg viewBox="0 0 220 240" className="h-64 w-auto max-w-full" role="img" aria-label="Robot assembling as pipeline stages complete">
            {/* frame / shadow */}
            <ellipse cx="110" cy="228" rx="52" ry="7" fill="rgba(255,255,255,0.05)" />
            {/* legs — agent loop */}
            <PartGroup light={lightOf('legs')} label={labelOf('legs')}>
              <rect x="80" y="140" width="20" height="66" rx="8" />
              <rect x="120" y="140" width="20" height="66" rx="8" />
              <rect x="72" y="206" width="30" height="10" rx="4" />
              <rect x="118" y="206" width="30" height="10" rx="4" />
            </PartGroup>
            {/* left arm — adversary probe */}
            <PartGroup light={lightOf('arm-left')} label={labelOf('arm-left')}>
              <rect x="30" y="64" width="24" height="54" rx="9" />
              <circle cx="42" cy="130" r="9" />
            </PartGroup>
            {/* right arm — repair */}
            <PartGroup light={lightOf('arm-right')} label={labelOf('arm-right')}>
              <rect x="166" y="64" width="24" height="54" rx="9" />
              <circle cx="178" cy="130" r="9" />
            </PartGroup>
            {/* torso — audit core */}
            <PartGroup light={lightOf('torso')} label={labelOf('torso')}>
              <rect x="65" y="56" width="90" height="78" rx="14" />
            </PartGroup>
            {/* core readout — overall progress */}
            <circle cx="110" cy="95" r="21" fill="rgba(0,0,0,0.35)" stroke="var(--color-border-muted)" strokeWidth="1.5" />
            <text x="110" y="99" textAnchor="middle" fontSize="13" fontWeight="800" fill="var(--color-text-primary)" fontFamily="ui-monospace, monospace">
              {pct}%
            </text>
            {/* head — typecheck */}
            <PartGroup light={lightOf('head')} label={labelOf('head')}>
              <rect x="85" y="10" width="50" height="36" rx="10" />
              <line x1="110" y1="10" x2="110" y2="2" />
              <circle cx="110" cy="3" r="2.5" />
            </PartGroup>
            {/* visor — verify gate */}
            <PartGroup light={lightOf('visor')} label={labelOf('visor')}>
              <rect x="91" y="21" width="38" height="13" rx="6" />
            </PartGroup>
          </svg>
        </div>

        {/* Vital info */}
        <div className="flex min-w-0 flex-col gap-3">
          {/* Parked plan — the action lives here, not just in the command bar. */}
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
          {/* NOW WORKING */}
          <div className="rounded-xl border border-[color-mix(in_srgb,var(--color-accent)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-accent)_7%,transparent)] p-3">
            <div className="text-[10px] font-black uppercase tracking-[0.16em] text-[var(--color-accent-text)]">
              {now ? (now.status === 'running' ? 'Now working' : now.status === 'failed' ? 'Needs attention' : now.status === 'pending' ? 'Up next' : 'Last finished') : 'Idle'}
            </div>
            {now ? (
              <div className="mt-1.5">
                <div className="flex items-baseline gap-2">
                  <span className="truncate text-sm font-bold text-[var(--color-text-primary)]">{now.label}</span>
                  {nowPart && <span className="shrink-0 font-mono text-[10px] text-[var(--color-text-muted)]">→ {nowPart.title}</span>}
                </div>
                <p className="mt-1 font-mono text-[11px] leading-relaxed text-[var(--color-text-secondary)]" title={now.detail || now.status}>
                  {now.detail ? truncate(now.detail) : `Status: ${now.status}`}
                </p>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
                  <div
                    className="h-full rounded-full bg-[var(--color-accent)] transition-[width] duration-500"
                    style={{ width: `${Math.round((now.progress ?? 0) * 100)}%` }}
                  />
                </div>
                <div className="mt-1 font-mono text-[10px] text-[var(--color-text-muted)]">
                  stage {Math.round((now.progress ?? 0) * 100)}% · {now.status}
                  {now.ok === false ? ' · check needed' : now.ok === true ? ' · ok' : ''}
                  {nowElapsed !== null ? ` · ${formatDuration(nowElapsed)}` : ''}
                </div>
              </div>
            ) : (
              <p className="mt-1 font-mono text-[11px] text-[var(--color-text-muted)]">No stages in this run.</p>
            )}
          </div>

          {/* Audit verdict — carried on the job payload, no second fetch. */}
          {verdict && (
            <div className="rounded-xl border border-[var(--color-border-muted)] bg-surface-base/60 px-3 py-2 font-mono text-[11px] text-[var(--color-text-secondary)]">
              <span className="text-[var(--color-text-muted)]">audit verdict · </span>
              <span className="font-bold text-[var(--color-text-primary)]">{verdict.status}</span>
              {verdict.score !== null ? <span> · score {verdict.score}</span> : null}
              {verdict.criticals !== null ? <span> · {verdict.criticals} critical</span> : null}
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {/* TODO */}
            <div className="rounded-xl border border-[var(--color-border-muted)] p-3">
              <div className="text-[10px] font-black uppercase tracking-[0.16em] text-gray-400">Todo · {todos.length}</div>
              {todos.length === 0 ? (
                <p className="mt-1.5 font-mono text-[11px] text-gray-400">Nothing queued.</p>
              ) : (
                <ul className="mt-1.5 space-y-1.5">
                  {todos.map((s) => {
                    const part = partDefForStage(s.id);
                    return (
                      <li key={s.id} className="flex items-center gap-2 font-mono text-[11px] text-gray-300">
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-gray-500" />
                        <span className="truncate" title={s.detail || s.label}>
                          {s.label}
                          {part ? <span className="text-gray-500"> → {part.title}</span> : null}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            {/* DONE */}
            <div className="rounded-xl border border-[var(--color-border-muted)] p-3">
              <div className="text-[10px] font-black uppercase tracking-[0.16em] text-gray-400">Done · {dones.length}</div>
              {dones.length === 0 ? (
                <p className="mt-1.5 font-mono text-[11px] text-gray-400">Nothing finished yet.</p>
              ) : (
                <ul className="mt-1.5 space-y-1.5">
                  {doneRows.map(({ s, dur }) => (
                    <li key={s.id} className="flex items-center gap-2 font-mono text-[11px]" title={s.detail || s.status}>
                      <span
                        className={cn(
                          'h-1.5 w-1.5 shrink-0 rounded-full',
                          s.status === 'skipped' ? 'bg-gray-500' : s.ok === false ? 'bg-[var(--color-danger)]' : 'bg-[var(--color-success)]',
                        )}
                      />
                      <span className="truncate text-gray-300">
                        {s.label}
                        <span className="text-gray-500"> · {s.status === 'skipped' ? 'skipped' : s.ok === false ? 'needs attention' : 'ok'}</span>
                        {dur !== null ? <span className="text-gray-500"> · {formatDuration(dur)}</span> : null}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* Bolt-on modules for custom stages not mapped to a body part */}
          {modules.length > 0 && (
            <div className="rounded-xl border border-dashed border-[var(--color-border-muted)] p-3">
              <div className="text-[10px] font-black uppercase tracking-[0.16em] text-gray-400">Bolt-on modules · {modules.length}</div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {modules.map((s) => (
                  <span key={s.id} className="rounded-full border border-[var(--color-border-muted)] px-2 py-0.5 font-mono text-[10px] text-gray-300" title={s.detail || s.status}>
                    {s.label} · {s.status}
                  </span>
                ))}
              </div>
            </div>
          )}

          {job.error && <p className="font-mono text-[11px] text-[var(--color-danger)]">{job.error}</p>}
        </div>
      </div>
    </section>
  );
}
