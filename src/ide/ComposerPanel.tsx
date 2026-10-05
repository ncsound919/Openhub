import React from 'react';
import { Wand2, Loader2, Check, AlertTriangle, FileCode, Play } from 'lucide-react';
import { getAuthHeaders, getCsrfToken } from '../auth/AuthProvider';
import { axiomEditorChat } from './axiomEditorClient';
import { parseCodeFences, type ComposerFile } from './composer';
import { ContextMentions } from './MentionContext';
import { cn } from '../lib/utils';

const COMPOSER_SYSTEM = [
  'You are an autonomous coding agent editing an existing repository.',
  'Return the files you change as fenced code blocks whose info string is the repo-relative path, including the FULL contents of each file, for example:',
  '```src/lib/example.ts',
  '<complete file contents>',
  '```',
  'Output only the blocks (a one-line summary before them is fine). Do not use placeholders or omit unchanged lines.',
].join('\n');

/** Multi-file composer: a goal goes to Axiom, the streamed response is parsed
 *  into whole-file edits, reviewed, then written through OpenHub's path-guarded
 *  file API and gated by a typecheck. */
export function ComposerPanel({
  projectPath,
  activeFilePath,
  activeFileContent,
  onApplied,
}: {
  projectPath: string;
  activeFilePath?: string | null;
  activeFileContent?: string;
  onApplied?: (paths: string[]) => void;
}) {
  const [goal, setGoal] = React.useState('');
  const [includeActive, setIncludeActive] = React.useState(true);
  const [contextBlock, setContextBlock] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [stream, setStream] = React.useState('');
  const [files, setFiles] = React.useState<ComposerFile[]>([]);
  const [ignored, setIgnored] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<string | null>(null);

  const canRun = !!projectPath && !!goal.trim() && !busy;

  const run = async () => {
    if (!canRun) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setFiles([]);
    setIgnored(0);
    setStream('');
    try {
      const fileContext = includeActive && activeFilePath && activeFileContent
        ? `\n\nCurrent file (${activeFilePath}):\n\`\`\`${activeFilePath}\n${activeFileContent}\n\`\`\``
        : '';
      const mentionContext = contextBlock.trim() ? `\n\n${contextBlock.trim()}` : '';
      const context = `${fileContext}${mentionContext}`;
      const out = await axiomEditorChat(
        [
          { role: 'system', content: COMPOSER_SYSTEM },
          { role: 'user', content: `Repository: ${projectPath}\n\nTask: ${goal.trim()}${context}` },
        ],
        (delta) => setStream((s) => s + delta),
        { tier: 'auto' },
      );
      const parsed = parseCodeFences(out.text);
      setFiles(parsed.files);
      setIgnored(parsed.ignored);
      if (!parsed.files.length) {
        setError('Axiom returned no file edits. Try rephrasing or adding more context.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Composer request failed');
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!files.length || busy) return;
    if (!window.confirm(`Write ${files.length} file${files.length === 1 ? '' : 's'} to disk? Open buffers are reloaded.`)) return;
    setBusy(true);
    setError(null);
    setResult(null);
    const headers = getAuthHeaders({ 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() });
    const wrote: string[] = [];
    const failed: string[] = [];
    for (const f of files) {
      try {
        const res = await fetch('/api/project/active/contents', {
          method: 'PUT',
          credentials: 'include',
          headers,
          body: JSON.stringify({ path: f.path, content: f.content }),
        });
        if (res.ok) wrote.push(f.path);
        else failed.push(f.path);
      } catch {
        failed.push(f.path);
      }
    }
    setResult(`Applied ${wrote.length}/${files.length} file${files.length === 1 ? '' : 's'}${failed.length ? ` — failed: ${failed.join(', ')}` : ''}`);
    if (failed.length) setError('Some files were not written (see result).');
    if (wrote.length) onApplied?.(wrote);
    setBusy(false);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-[var(--color-border-muted)] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
        Composer · multi-file
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="Describe the change across files, e.g. 'add a debounce util and use it in the search box'…"
          rows={3}
          className="w-full resize-none rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-base)] p-2 text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
        />
        <div className="flex items-center gap-2">
          {activeFilePath && (
            <label className="flex items-center gap-1.5 text-[11px] text-[var(--color-text-secondary)]">
              <input type="checkbox" checked={includeActive} onChange={(e) => setIncludeActive(e.target.checked)} />
              Include <span className="font-mono">{activeFilePath.split('/').pop()}</span>
            </label>
          )}
          <button
            type="button"
            onClick={() => void run()}
            disabled={!canRun}
            aria-busy={busy}
            className="ml-auto flex items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-40"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}
            Compose
          </button>
        </div>
        <ContextMentions projectPath={projectPath} text={goal} onBlockChange={setContextBlock} />

        {error && (
          <div role="alert" className="rounded border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-2 py-1.5 text-[11px] text-[var(--color-danger)]">
            {error}
          </div>
        )}

        {stream && !files.length && (
          <pre className="max-h-56 overflow-auto rounded border border-[var(--color-border-muted)] bg-[var(--color-surface-base)] p-2 font-mono text-[10px] text-[var(--color-text-secondary)] whitespace-pre-wrap">
            {stream}
          </pre>
        )}

        {files.length > 0 && (
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--color-text-secondary)]">
              <FileCode className="w-3.5 h-3.5 text-[var(--color-accent-text)]" />
              {files.length} file{files.length === 1 ? '' : 's'} to write
              {ignored > 0 && <span className="font-normal text-[var(--color-text-muted)]">· {ignored} block{ignored === 1 ? '' : 's'} ignored</span>}
            </div>
            {files.map((f) => (
              <details key={f.path} className="rounded border border-[var(--color-border-muted)] bg-[var(--color-surface-base)]">
                <summary className="cursor-pointer px-2 py-1 font-mono text-[11px] text-[var(--color-text-primary)]">
                  {f.path} <span className="text-[var(--color-text-muted)]">({f.content.length} B)</span>
                </summary>
                <pre className="max-h-56 overflow-auto border-t border-[var(--color-border-muted)] p-2 font-mono text-[10px] text-[var(--color-text-secondary)] whitespace-pre-wrap">
                  {f.content}
                </pre>
              </details>
            ))}
            <button
              type="button"
              onClick={() => void apply()}
              disabled={busy}
              className="flex w-full items-center justify-center gap-1.5 rounded-md bg-[var(--color-success)] px-3 py-1.5 text-xs font-semibold text-white hover:brightness-110 disabled:opacity-40"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
              Apply {files.length} file{files.length === 1 ? '' : 's'} &amp; typecheck
            </button>
          </div>
        )}

        {result && (
          <div className={cn('flex items-center gap-1.5 text-[11px] text-[var(--color-success)]')} role="status">
            <Check className="w-3.5 h-3.5" /> {result}
          </div>
        )}
        {!projectPath && (
          <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-warning)]">
            <AlertTriangle className="w-3.5 h-3.5" /> Load a project to compose.
          </div>
        )}
      </div>
    </div>
  );
}
