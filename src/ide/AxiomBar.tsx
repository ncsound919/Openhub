import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Send, ShieldCheck, Loader2, Sparkles, Wand2, Play, CornerDownLeft } from 'lucide-react';
import { getAuthHeaders, getCsrfToken } from '../auth/AuthProvider';
import { StatusLight, type LightState } from '../components/StatusLight';
import { cn } from '../lib/utils';

type PanelId = 'autonomy' | 'composer' | 'agent' | 'threads' | 'review';

type AuditPhase = 'idle' | 'running' | 'pass' | 'fail' | 'error';
const AUDIT_LIGHT: Record<AuditPhase, LightState> = {
  idle: 'idle',
  running: 'working',
  pass: 'ok',
  fail: 'warn',
  error: 'error',
};

const SUGGESTIONS: Array<{ label: string; prompt: string }> = [
  { label: 'Explain this project', prompt: 'Explain this project: what it does, its architecture, and its riskiest areas.' },
  { label: 'Find bugs', prompt: 'Audit this codebase for correctness bugs and security issues, and tell me the highest-impact ones first.' },
  { label: 'Write tests', prompt: 'Identify the least-tested critical paths in this project and write focused tests for them.' },
];

/**
 * AxiomBar — the single, always-visible place to direct Axiom in the workspace.
 *
 * Before this, "where do I type?" was a puzzle: the chat lived behind a tool
 * icon at the bottom of the activity rail, loop goals hid in Autonomy, and the
 * audit toggle lived on another page. The bar gives every request one obvious
 * entry point, exposes the two headline actions (chat + audit), and shows live
 * state lights so loaded / working / done is legible at a glance.
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
  const [audit, setAudit] = useState<{ phase: AuditPhase; message?: string }>({ phase: 'idle' });
  const inputRef = useRef<HTMLInputElement>(null);

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

  const runAudit = async () => {
    if (!hasProject || audit.phase === 'running') return;
    setAudit({ phase: 'running', message: 'Auditing project…' });
    try {
      const res = await fetch('/api/repair/audit-and-repair', {
        method: 'POST',
        credentials: 'include',
        headers: getAuthHeaders({ 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() }),
        body: JSON.stringify({}),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.ok === false) {
        setAudit({ phase: 'error', message: json?.error || `Audit failed (HTTP ${res.status})` });
        return;
      }
      const overall = json?.audit?.overallStatus;
      setAudit({
        phase: overall === 'pass' ? 'pass' : 'fail',
        message: typeof json?.message === 'string' ? json.message : overall === 'pass' ? 'Audit passed' : 'Audit found issues',
      });
    } catch (e) {
      setAudit({ phase: 'error', message: e instanceof Error ? e.message : 'Audit failed' });
    }
  };

  // ⌘K / Ctrl+K focuses the command bar — the keyboard shortcut people already
  // reach for when they want to "ask the tool something".
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
        <button
          type="button"
          onClick={() => void runAudit()}
          disabled={!hasProject || audit.phase === 'running'}
          className={cn(
            'flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-bold text-white transition-shadow disabled:opacity-50',
            audit.phase === 'running' ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-success)] hover:brightness-110',
          )}
          style={audit.phase === 'running' ? { boxShadow: '0 0 10px var(--color-accent)' } : undefined}
          title="Run the audit team on this project (audit + dispatch repair)"
        >
          {audit.phase === 'running' ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldCheck className="h-3 w-3" />}
          Audit
        </button>
      </div>

      {/* Live result of the last audit + quick prompts, so a first-time user has
          a one-click starting point instead of a blank input. */}
      <div className="flex basis-full flex-wrap items-center gap-x-2 gap-y-1.5">
        {audit.phase !== 'idle' && (
          <StatusLight
            state={AUDIT_LIGHT[audit.phase]}
            label={audit.message}
            className="max-w-[22rem]"
            title={audit.message}
          />
        )}
        {hasProject && (
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
        )}
      </div>
    </div>
  );
}
