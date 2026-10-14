import React from 'react';
import { Terminal, X, ChevronUp, ChevronDown } from 'lucide-react';
import { TerminalView } from '../ide/TerminalView';
import { useStore } from '../store';

/** Global terminal — a real shell bridge to the active project (no theater). */
export function TerminalPanel() {
  const [isOpen, setIsOpen] = React.useState(false);
  const [isExpanded, setIsExpanded] = React.useState(false);
  const activeProject = useStore((s) => s.activeProject);

  if (!isOpen) {
    return (
      <button
        type="button"
        aria-label="Open terminal"
        className="fixed bottom-0 left-0 z-50 flex items-center rounded-tr-lg border-r border-t border-[var(--color-border-muted)] bg-[var(--color-surface-raised)] px-4 py-2 text-xs font-bold text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)]"
        onClick={() => setIsOpen(true)}
      >
        <Terminal className="mr-2 h-4 w-4" />
        Terminal
      </button>
    );
  }

  return (
    <div className={`fixed bottom-0 left-0 right-0 z-50 flex flex-col border-t border-[var(--color-border-muted)] bg-[var(--color-bg-base)] shadow-2xl ${isExpanded ? 'h-1/2' : 'h-64'}`}>
      <div className="flex items-center justify-end gap-2 px-3 py-1.5">
        <button onClick={() => setIsExpanded(!isExpanded)} className="rounded p-1 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]" aria-label={isExpanded ? 'Collapse terminal' : 'Expand terminal'}>
          {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
        </button>
        <button onClick={() => setIsOpen(false)} className="rounded p-1 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]" aria-label="Close terminal">
          <X className="h-4 w-4" />
        </button>
      </div>
      {activeProject ? (
        <div className="min-h-0 flex-1">
          <TerminalView projectRepoId={activeProject.repoId} />
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-[var(--color-text-muted)]">
          Load a project to open a shell here.
        </div>
      )}
    </div>
  );
}