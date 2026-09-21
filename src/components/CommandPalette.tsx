import React from 'react';
import { useNavigate } from 'react-router-dom';
import { CornerDownLeft, FolderGit2, Search } from 'lucide-react';
import { NAV_ITEMS, type NavItem } from '../lib/nav';
import { useStore } from '../store';
import { cn } from '../lib/utils';

type Entry = {
  id: string;
  group: string;
  label: string;
  sub?: string;
  icon: React.ReactNode;
  run: () => void;
};

function fuzzy(text: string, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = text.toLowerCase();
  return needle.every((n) => hay.includes(n));
}

export function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [query, setQuery] = React.useState('');
  const [index, setIndex] = React.useState(0);
  const navigate = useNavigate();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const repositories = useStore((s) => s.repositories);
  const activeProject = useStore((s) => s.activeProject);

  React.useEffect(() => {
    if (open) {
      setQuery('');
      setIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const entries: Entry[] = React.useMemo(() => {
    const nav: Entry[] = NAV_ITEMS.map((n: NavItem) => ({
      id: `nav:${n.to}`,
      group: 'Navigate',
      label: n.label,
      sub: n.to,
      icon: <n.icon className="w-4 h-4" />,
      run: () => {
        navigate(n.to);
        onClose();
      },
    }));

    const actions: Entry[] = [
      {
        id: 'action:load-project',
        group: 'Actions',
        label: 'Load a project',
        sub: 'Import from GitHub or a local folder',
        icon: <FolderGit2 className="w-4 h-4" />,
        run: () => {
          navigate('/projects');
          onClose();
        },
      },
      {
        id: 'action:new-loop',
        group: 'Actions',
        label: 'Start a loop',
        sub: activeProject ? `Target: ${activeProject.repositoryName}` : 'Load a project first',
        icon: <FolderGit2 className="w-4 h-4" />,
        run: () => {
          navigate('/axiom');
          onClose();
        },
      },
    ];

    const repos: Entry[] = (() => {
      let recent: string[] = [];
      try {
        recent = JSON.parse(localStorage.getItem('openhub.recentProjects') || '[]') as string[];
      } catch { /* ignore */ }
      const ranked = [...repositories].sort((a, b) => {
        const ra = recent.indexOf(a.id);
        const rb = recent.indexOf(b.id);
        return (ra === -1 ? 999 : ra) - (rb === -1 ? 999 : rb);
      });
      return ranked.slice(0, 6).map((r) => ({
        id: `repo:${r.id}`,
        group: 'Projects',
        label: r.name,
        sub: `${r.owner}/${r.name}`,
        icon: <FolderGit2 className="w-4 h-4" />,
        run: () => {
          navigate(`/${r.owner}/${r.name}`);
          onClose();
        },
      }));
    })();

    return [...nav, ...actions, ...repos];
  }, [navigate, onClose, repositories, activeProject]);

  const filtered = React.useMemo(() => {
    const q = query.trim();
    if (!q) return entries;
    return entries.filter((e) => fuzzy(`${e.group} ${e.label} ${e.sub ?? ''}`, q));
  }, [entries, query]);

  const visible = filtered.slice(0, 40);

  React.useEffect(() => {
    setIndex(0);
  }, [query]);

  React.useEffect(() => {
    if (index >= visible.length) setIndex(Math.max(0, visible.length - 1));
  }, [visible.length, index]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Tab') {
      // Keep focus inside the modal (input + options only).
      e.preventDefault();
      inputRef.current?.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex((i) => Math.min(i + 1, visible.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const entry = visible[index];
      if (entry) entry.run();
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-[14vh] px-4" role="dialog" aria-modal="true" aria-label="Command palette">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={onClose} />
      <div
        className="relative w-full max-w-lg overflow-hidden rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface-overlay)] shadow-2xl shadow-black/50"
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2 border-b border-[var(--color-border-muted)] px-3.5 py-3">
          <Search className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-listbox"
            aria-autocomplete="list"
            aria-activedescendant={visible[index] ? `cmd-opt-${visible[index].id}` : undefined}
            aria-label="Search commands"
            placeholder="Search commands, projects, actionsâ€¦"
            className="w-full bg-transparent text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] outline-none"
          />
          <kbd className="hidden sm:inline-flex items-center rounded border border-[var(--color-border-muted)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-text-muted)]">
            ESC
          </kbd>
        </div>

        <div id="command-palette-listbox" role="listbox" aria-label="Results" className="max-h-[46vh] overflow-y-auto py-1.5">
          {visible.length === 0 && (
            <p className="px-4 py-6 text-center text-xs text-[var(--color-text-muted)]">
              No results for â€œ{query}â€.
            </p>
          )}
          {visible.map((e, i) => (
            <div key={e.id}>
              {i === 0 || visible[i - 1].group !== e.group ? (
                <div className="px-4 pt-2.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
                  {e.group}
                </div>
              ) : null}
              <button
                key={e.id}
                id={`cmd-opt-${e.id}`}
                role="option"
                aria-selected={i === index}
                onMouseEnter={() => setIndex(i)}
                onClick={e.run}
                className={cn(
                  'group flex w-full items-center gap-3 px-4 py-2 text-left',
                  i === index && 'bg-[var(--color-surface-hover)]',
                )}
              >
                <span className="shrink-0 text-[var(--color-text-muted)] group-hover:text-[var(--color-accent-text)]">
                  {e.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-[var(--color-text-primary)]">{e.label}</span>
                  {e.sub && <span className="block truncate text-[11px] text-[var(--color-text-muted)]">{e.sub}</span>}
                </span>
                {i === index && <CornerDownLeft className="w-3.5 h-3.5 shrink-0 text-[var(--color-text-muted)]" />}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}