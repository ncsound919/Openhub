import React from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  CircleDot, Lightbulb, Menu, Search, X, ChevronRight, Moon, Sun,
} from 'lucide-react';
import { useAuth } from '../auth/AuthProvider';
import { useStore } from '../store';
import { NAV_GROUPS, BREADCRUMBS } from '../lib/nav';
import { getAuthHeaders } from '../auth/AuthProvider';
import { TerminalPanel } from './TerminalPanel';
import { CommandPalette } from './CommandPalette';
import { GlobalRunIndicator } from './GlobalRunIndicator';
import { PipelineProvider } from '../ide/PipelineProvider';
import { cn } from '../lib/utils';

export function Layout() {
  const { user, logout } = useAuth();
  const { beginnerMode, toggleBeginnerMode, fetchRepositories, activeProject, activeProjectLoading, unloadActiveProject, drift, theme, toggleTheme } = useStore();
  const [sidebarOpen, setSidebarOpen] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [unreadActivity, setUnreadActivity] = React.useState(false);
  const location = useLocation();

  // B3: unread activity badge — newest incident newer than last visit to /activity.
  React.useEffect(() => {
    const check = () => {
      const lastSeen = localStorage.getItem('openhub.activity.lastSeen');
      fetch('/api/incidents', { credentials: 'include', headers: getAuthHeaders() })
        .then((r) => r.json())
        .then((json) => {
          const incidents = Array.isArray(json?.incidents) ? json.incidents : [];
          const newest = incidents[0]?.createdAt as string | undefined;
          setUnreadActivity(!!newest && (!lastSeen || newest > lastSeen));
        })
        .catch(() => setUnreadActivity(false));
    };
    check();
    const t = setInterval(check, 45000);
    return () => clearInterval(t);
  }, [location.pathname]);

  React.useEffect(() => {
    void fetchRepositories();
    void useStore.getState().fetchActiveProject();
  }, [fetchRepositories]);

  // C1: remember recently used projects for the ⌘K palette.
  React.useEffect(() => {
    const id = useStore.getState().activeProject?.repoId;
    if (!id) return;
    try {
      const recent = JSON.parse(localStorage.getItem('openhub.recentProjects') || '[]') as string[];
      const next = [id, ...recent.filter((r) => r !== id)].slice(0, 8);
      localStorage.setItem('openhub.recentProjects', JSON.stringify(next));
    } catch { /* ignore */ }
  }, [useStore((s) => s.activeProject?.repoId)]);

  React.useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  // Global ⌘K / Ctrl-K
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
      if (e.key === 'Escape') setPaletteOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const crumb = BREADCRUMBS[location.pathname] ?? location.pathname.split('/').filter(Boolean).pop() ?? 'Command';

  const driftChip = activeProject
    ? drift?.branch
      ? `${drift.branch}${drift.ahead ? ` · ${drift.ahead}↑` : ''}${drift.behind ? ` ${drift.behind}↓` : ''}${drift.uncommitted ? ` · ${drift.uncommitted} uncommitted` : ''}`
      : null
    : null;

  return (
    <PipelineProvider>
    <div className="min-h-screen flex font-sans relative bg-[var(--color-bg-base)]">
      {/* Sidebar — desktop */}
      <aside className="hidden lg:flex w-[236px] shrink-0 flex-col border-r border-[var(--color-border-muted)] bg-[var(--color-surface-base)]/80 backdrop-blur sticky top-0 h-screen z-40">
        <Link to="/" className="flex items-center gap-2.5 px-4 pt-5 pb-4">
          <span className="w-8 h-8 rounded-md flex items-center justify-center bg-[var(--color-accent)]">
            <span className="text-[15px] font-extrabold text-[var(--color-text-primary)] leading-none tracking-tight">O</span>
          </span>
          <span>
            <span className="block text-[15px] font-bold tracking-tight text-[var(--color-text-primary)] leading-none">OpenHub</span>
            <span className="block text-[10px] font-medium text-[var(--color-text-muted)] mt-0.5">workspace</span>
          </span>
        </Link>

        {/* ⌘K trigger */}
        <div className="px-3 pb-3">
          <button
            onClick={() => setPaletteOpen(true)}
            className="flex w-full items-center gap-2 rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-raised)] px-2.5 py-1.5 text-xs text-[var(--color-text-muted)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-text-secondary)] transition-colors"
          >
            <Search className="w-3.5 h-3.5 shrink-0" />
            <span className="flex-1 text-left">Search…</span>
            <kbd className="rounded border border-[var(--color-border-muted)] px-1 py-0.5 text-[10px] font-semibold">⌘K</kbd>
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 pb-4 space-y-5 pt-1">
          {NAV_GROUPS.map((group) => (
            <div key={group.label}>
              <div className="sidebar-group-label mb-1.5">{group.label}</div>
              <div className="space-y-0.5">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <NavLink
                      key={item.to + item.label}
                      to={item.to}
                      end={item.end}
                      className={({ isActive }) => cn('sidebar-link', isActive && 'active')}
                    >
                      <Icon className="w-4 h-4 shrink-0" />
                      {item.label}
                      {item.to === '/activity' && unreadActivity && (
                        <span className="ml-auto h-2 w-2 shrink-0 rounded-full bg-[var(--color-danger)]" title="New activity since your last visit" />
                      )}
                    </NavLink>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* Active project card */}
        <div className="p-3 border-t border-[var(--color-border-muted)]">
          <div className="rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-raised)] p-3">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
              <CircleDot className="w-3 h-3 text-[var(--color-accent-text)]" /> Active project
            </div>
            {activeProject ? (
              <>
                <Link to="/workspace" className="mt-1.5 block truncate text-[13px] font-semibold text-[var(--color-text-primary)] hover:text-[var(--color-accent-text)]" title={activeProject.path}>
                  {activeProject.repositoryName}
                </Link>
                <div className="mt-0.5 truncate font-mono text-[10px] text-[var(--color-text-muted)]" title={activeProject.path}>{activeProject.path}</div>
                <div className="mt-2 flex items-center justify-between">
                  <span className="truncate font-mono text-[10px] text-[var(--color-text-secondary)]">{driftChip ?? (activeProject.defaultBranch ?? '')}</span>
                  <button
                    onClick={() => void unloadActiveProject()}
                    className="shrink-0 text-[11px] font-medium text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"
                  >
                    Unload
                  </button>
                </div>
              </>
            ) : (
              <div className="mt-1.5 text-xs text-[var(--color-text-muted)]">
                {activeProjectLoading ? 'Reading context…' : 'None loaded.'}{' '}
                <Link to="/projects" className="font-semibold text-[var(--color-accent-text)] hover:text-[var(--color-accent)]">Load one →</Link>
              </div>
            )}
          </div>
        </div>
      </aside>

      {/* Mobile drawer */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/70" onClick={() => setSidebarOpen(false)} />
          <div className="absolute left-0 top-0 h-full w-[270px] bg-[var(--color-surface-base)] border-r border-[var(--color-border-muted)] p-4 overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <span className="text-[var(--color-text-primary)] font-bold tracking-tight">OpenHub</span>
              <button onClick={() => setSidebarOpen(false)} aria-label="Close menu" className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]">
                <X className="w-5 h-5" />
              </button>
            </div>
            {NAV_GROUPS.map((group) => (
              <div key={group.label} className="mb-4">
                <div className="sidebar-group-label mb-1.5">{group.label}</div>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <NavLink key={item.to + item.label} to={item.to} end={item.end} className={({ isActive }) => cn('sidebar-link', isActive && 'active')}>
                      <Icon className="w-4 h-4" /> {item.label}
                    </NavLink>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Main column */}
      <div className="flex-1 min-w-0 flex flex-col relative z-10">
        <header className="sticky top-0 z-30 border-b border-[var(--color-border-muted)] bg-[var(--color-bg-base)]/85 backdrop-blur px-4 py-2.5 flex items-center gap-3">
          <button className="lg:hidden text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]" onClick={() => setSidebarOpen(true)} aria-label="Open menu">
            <Menu className="w-5 h-5" />
          </button>
          <nav className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)] min-w-0" aria-label="Breadcrumb">
            <Link to="/" className="hover:text-[var(--color-text-primary)] font-medium">Home</Link>
            <ChevronRight className="w-3 h-3 shrink-0" />
            <span className="text-[var(--color-text-secondary)] font-semibold truncate">{crumb}</span>
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <GlobalRunIndicator />
            {activeProject && (
              <Link
                to="/workspace"
                className="hidden md:inline-flex max-w-[260px] items-center gap-2 rounded-full border border-[color-mix(in_srgb,var(--color-accent)_35%,transparent)] bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] px-3 py-1 text-xs font-medium text-[var(--color-accent-text)] hover:bg-[color-mix(in_srgb,var(--color-accent)_16%,transparent)]"
                title={activeProject.path}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-accent-hover)] animate-pulse shrink-0" />
                <span className="truncate">{activeProject.repositoryName}</span>
                {driftChip && <span className="truncate font-mono text-[10px] text-[var(--color-text-muted)]">{driftChip}</span>}
              </Link>
            )}
            <button
              onClick={() => setPaletteOpen(true)}
              title="Search (⌘K)"
              className="hidden sm:inline-flex items-center gap-2 rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-raised)] px-2.5 py-1.5 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] transition-colors"
            >
              <Search className="w-3.5 h-3.5" />
              <kbd className="rounded border border-[var(--color-border-muted)] px-1 py-0.5 text-[10px] font-semibold">⌘K</kbd>
            </button>
            <button
              onClick={toggleTheme}
              title={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
              aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
              className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border-muted)] bg-[var(--color-surface-raised)] px-2.5 py-1.5 text-xs font-medium text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-secondary)]"
            >
              {theme === 'light' ? <Moon className="w-3.5 h-3.5" /> : <Sun className="w-3.5 h-3.5" />}
              <span className="hidden sm:inline">{theme === 'light' ? 'Dark' : 'Light'}</span>
            </button>
            <button
              onClick={toggleBeginnerMode}
              title="Toggle guidance hints"
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors',
                beginnerMode
                  ? 'border-[color-mix(in_srgb,var(--color-warning)_45%,transparent)] bg-[color-mix(in_srgb,var(--color-warning)_10%,transparent)] text-[var(--color-warning)]'
                  : 'border-[var(--color-border-muted)] bg-[var(--color-surface-raised)] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]',
              )}
            >
              <Lightbulb className={cn('w-3.5 h-3.5', beginnerMode && 'animate-pulse')} />
              <span className="hidden sm:inline">Guide</span>
            </button>
            <Link to="/settings" className="flex items-center gap-2 rounded-md border border-transparent hover:border-[var(--color-border-muted)] pl-1 pr-2 py-1">
              {/* Local initials avatar: the previous ui-avatars.com <img> leaked
                  the username to a third party and needed an external CSP hole. */}
              <span
                aria-hidden="true"
                className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--color-accent)] text-[11px] font-semibold text-white"
              >
                {(user?.username || user?.email || 'dev').slice(0, 2).toUpperCase()}
              </span>
              <span className="hidden md:block text-xs font-medium text-[var(--color-text-secondary)] max-w-[120px] truncate">{user?.username || 'Account'}</span>
            </Link>
            <button onClick={logout} className="hidden sm:block text-xs font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]">
              Sign out
            </button>
          </div>
        </header>

        <main className="flex-1 flex flex-col pb-16">
          <Outlet />
        </main>

        <TerminalPanel />
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
    </PipelineProvider>
  );
}