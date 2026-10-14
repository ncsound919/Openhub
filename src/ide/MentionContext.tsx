import React from 'react';
import { Loader2, Paperclip, AlertTriangle, Check } from 'lucide-react';
import { axiomEditorMentions } from './axiomEditorClient';
import { mentionTokens } from './contextMentions';

interface MentionsState {
  resolved: string[];
  unresolved: string[];
  block: string;
}

const EMPTY: MentionsState = { resolved: [], unresolved: [], block: '' };

/**
 * Resolves `@file/@folder/@code/@docs/@git` mentions in a prompt and reports the
 * resolved context block back to the parent. Renders nothing when the text has
 * no mentions. Debounced, and the last request wins (a stale response is
 * discarded), so it is safe to type into.
 */
export function ContextMentions({
  projectPath,
  text,
  onBlockChange,
}: {
  projectPath: string;
  text: string;
  onBlockChange?: (block: string) => void;
}) {
  const [state, setState] = React.useState<MentionsState>(EMPTY);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const tokens = React.useMemo(() => mentionTokens(text), [text]);
  const hasTokens = tokens.length > 0;
  // Keep the latest callback in a ref so it is not a dependency of the effect.
  const cbRef = React.useRef(onBlockChange);
  cbRef.current = onBlockChange;

  React.useEffect(() => {
    if (!projectPath || !hasTokens) {
      setState(EMPTY);
      cbRef.current?.('');
      return;
    }
    let cancelled = false;
    setBusy(true);
    setError(null);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const r = await axiomEditorMentions({ dir: projectPath, text });
          if (cancelled) return;
          const d = (r.data ?? {}) as { block?: string; resolved?: string[]; unresolved?: string[] };
          const next: MentionsState = {
            resolved: Array.isArray(d.resolved) ? d.resolved : [],
            unresolved: Array.isArray(d.unresolved) ? d.unresolved : [],
            block: typeof d.block === 'string' ? d.block : '',
          };
          setState(next);
          cbRef.current?.(next.block);
        } catch (e) {
          if (!cancelled) {
            setError(e instanceof Error ? e.message : 'mention resolution failed');
            setState(EMPTY);
            cbRef.current?.('');
          }
        } finally {
          if (!cancelled) setBusy(false);
        }
      })();
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [projectPath, text, hasTokens]);

  if (!hasTokens) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[10px]" aria-live="polite">
      <Paperclip className="w-3 h-3 text-[var(--color-text-muted)]" />
      {busy && <Loader2 className="w-3 h-3 animate-spin text-[var(--color-text-muted)]" />}
      {state.resolved.map((r) => (
        <span key={r} className="inline-flex items-center gap-1 rounded border border-[var(--color-success)]/40 bg-[var(--color-success)]/10 px-1.5 py-0.5 font-mono text-[var(--color-success)]" title="resolved">
          <Check className="w-2.5 h-2.5" />{r}
        </span>
      ))}
      {state.unresolved.map((u) => (
        <span key={u} className="inline-flex items-center gap-1 rounded border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 px-1.5 py-0.5 font-mono text-[var(--color-warning)]" title="unresolved — the server found nothing for this mention">
          <AlertTriangle className="w-2.5 h-2.5" />{u}
        </span>
      ))}
      {!busy && state.resolved.length === 0 && state.unresolved.length === 0 && !error && (
        <span className="text-[var(--color-text-muted)]">no mentions resolved</span>
      )}
      {error && <span className="text-[var(--color-danger)]">{error}</span>}
    </div>
  );
}
