import { useEffect, useRef } from 'react';
import { Bot, Loader2, User, Wrench } from 'lucide-react';
import type { MissionStatus } from '../lib/missionStore.js';
import type { TranscriptEntry } from './transcript.js';

interface MissionTranscriptProps {
  entries: TranscriptEntry[];
  status?: MissionStatus;
  /** A message-fetch or session error shown above the conversation. */
  error?: string | null;
  /** True until the first history read for the selected session settles. */
  loading?: boolean;
  /** Prompt shown before any session exists (the editor's docked agent). */
  emptyLabel?: string;
}

function clock(at: number | undefined): string | null {
  if (at === undefined) return null;
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function toolTone(status: string | undefined): string {
  if (status === 'completed' || status === 'success') return 'text-[var(--color-success)]';
  if (status === 'error' || status === 'failed') return 'text-[var(--color-danger)]';
  return 'text-[var(--color-text-muted)]';
}

function TranscriptRow({ entry }: { entry: TranscriptEntry }) {
  const isUser = entry.role === 'user';
  const time = clock(entry.at);
  return (
    <article
      aria-label={isUser ? 'Your message' : 'Agent response'}
      className={
        'rounded-md border px-3 py-2 ' +
        (isUser
          ? 'border-[var(--color-border-muted)] bg-[var(--color-surface-raised)]'
          : 'border-[color-mix(in_srgb,var(--color-accent)_25%,var(--color-border-muted))] bg-[var(--color-surface-base)]')
      }
    >
      <header className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
        {isUser ? <User className="h-3 w-3" aria-hidden="true" /> : <Bot className="h-3 w-3" aria-hidden="true" />}
        {isUser ? 'You' : 'Agent'}
        {time && <span className="ml-auto font-mono font-normal normal-case">{time}</span>}
      </header>
      {entry.text && (
        <p className="mt-1.5 whitespace-pre-wrap break-words text-pretty text-sm leading-relaxed text-[var(--color-text-primary)]">
          {entry.text}
        </p>
      )}
      {entry.tools.length > 0 && (
        <ul className="mt-2 space-y-1 border-t border-[var(--color-border-muted)] pt-1.5">
          {entry.tools.map((tool) => (
            <li key={tool.id} className="flex items-start gap-1.5 font-mono text-[10px] text-[var(--color-text-muted)]">
              <Wrench className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate" title={tool.title ?? tool.name}>
                {tool.name}
                {tool.title ? ` · ${tool.title}` : ''}
              </span>
              {tool.status && <span className={`shrink-0 ${toolTone(tool.status)}`}>{tool.status}</span>}
            </li>
          ))}
        </ul>
      )}
      {entry.error && (
        <p className="mt-1.5 whitespace-pre-wrap break-words text-xs text-[var(--color-danger)]">{entry.error}</p>
      )}
    </article>
  );
}

/**
 * The mission conversation: the user's goal and the agent's actual reply,
 * including a compact row for each tool it ran. It auto-follows the newest
 * content while the reader is at the bottom; scrolling up stops the follow.
 */
export function MissionTranscript({ entries, status, error = null, loading = false, emptyLabel }: MissionTranscriptProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const visible = entries.filter((entry) => entry.text || entry.tools.length > 0 || entry.error);
  const running = status === 'planned' || status === 'running';

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [entries]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        aria-label="Mission conversation"
        className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3"
      >
        {error && (
          <p role="alert" className="rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-base)] px-3 py-2 text-xs text-[var(--color-danger)]">
            {error}
          </p>
        )}
        {visible.length === 0 ? (
          <div className="flex min-h-[8rem] flex-col items-center justify-center gap-2 p-6 text-center text-balance text-sm text-[var(--color-text-muted)]">
            {status === undefined ? (
              <span>{emptyLabel ?? 'No mission selected — describe a goal to begin.'}</span>
            ) : running ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                <span>Agent is working — waiting for its first response…</span>
              </>
            ) : loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                <span>Loading the conversation…</span>
              </>
            ) : (
              <span>No response was recorded for this mission.</span>
            )}
          </div>
        ) : (
          visible.map((entry) => <TranscriptRow key={entry.id} entry={entry} />)
        )}
        {running && visible.length > 0 && (
          <p className="flex items-center gap-1.5 px-1 text-[11px] text-[var(--color-text-muted)]">
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            Agent is working…
          </p>
        )}
      </div>
    </div>
  );
}
