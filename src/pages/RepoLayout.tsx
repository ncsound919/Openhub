import React from 'react';
import { Link, NavLink, Outlet, useParams } from 'react-router-dom';
import { Code, CircleDot, GitPullRequest, PlayCircle, KanbanSquare, BookOpen, Settings, Book, Star, GitFork, Eye, Puzzle } from 'lucide-react';
import { useStore } from '../store';
import { cn } from '../lib/utils';

export function RepoLayout() {
  const { owner, repo: repoName } = useParams();
  const repo = useStore((state) =>
    state.repositories.find(r => r.owner === owner && r.name === repoName)
  );
  const fetchRepositories = useStore(s => s.fetchRepositories);
  const openIssues = useStore(s => s.issues.filter(i => i.repoId === repo?.id && i.state === 'open').length);
  const openPulls = useStore(s => s.pullRequests.filter(i => i.repoId === repo?.id && i.state === 'open').length);

  React.useEffect(() => {
    if (!repo) void fetchRepositories();
  }, [owner, repoName, repo, fetchRepositories]);

  if (!repo) {
    return (
      <div className="p-10 text-center">
        <Book className="w-8 h-8 mx-auto text-gray-400" />
        <p className="mt-3 text-sm font-bold text-[var(--color-text-primary)]">Repository not found</p>
        <p className="mt-1 text-xs text-gray-400">{owner}/{repoName} isn’t in this account.</p>
        <Link to="/projects" className="mt-4 inline-block text-xs font-bold text-blue-300 hover:text-blue-200">Back to projects →</Link>
      </div>
    );
  }

  const navItems = [
    { to: `/${owner}/${repoName}`, icon: Code, label: 'Code', end: true },
    { to: `/${owner}/${repoName}/issues`, icon: CircleDot, label: 'Issues', count: openIssues },
    { to: `/${owner}/${repoName}/pulls`, icon: GitPullRequest, label: 'Pulls', count: openPulls },
    { to: `/${owner}/${repoName}/actions`, icon: PlayCircle, label: 'Actions' },
    { to: `/${owner}/${repoName}/projects`, icon: KanbanSquare, label: 'Projects' },
    { to: `/${owner}/${repoName}/wiki`, icon: BookOpen, label: 'Wiki' },
    { to: `/${owner}/${repoName}/extensions`, icon: Puzzle, label: 'Extensions' },
    { to: `/${owner}/${repoName}/settings`, icon: Settings, label: 'Settings' },
  ];

  return (
    <div className="flex-1 flex flex-col min-w-0">
      {/* Condensed dark header */}
      <div className="border-b border-surface-overlay bg-surface-base/80 backdrop-blur px-4 md:px-6 pt-4">
        <div className="max-w-6xl mx-auto">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 min-w-0 text-lg">
              <span className="w-8 h-8 rounded-lg bg-surface-overlay border border-border-muted flex items-center justify-center shrink-0">
                <Book className="w-4 h-4 text-gray-400" />
              </span>
              <span className="truncate font-bold text-[var(--color-text-primary)]">
                <span className="text-gray-400 font-semibold">{owner}</span>
                <span className="text-gray-400 mx-1">/</span>
                {repoName}
              </span>
              {repo.isPrivate && (
                <span className="text-[10px] font-extrabold uppercase tracking-widest border border-border-muted text-gray-400 px-2 py-0.5 rounded-full">Private</span>
              )}
              {repo.language && (
                <span className="hidden sm:inline-flex items-center gap-1.5 text-[11px] text-gray-400">
                  <span className="w-2 h-2 rounded-full bg-blue-400" />{repo.language}
                </span>
              )}
            </div>

            <div className="ml-auto flex items-center gap-1.5">
              {[
                { icon: Eye, label: 'Watch', value: '1' },
                { icon: GitFork, label: 'Fork', value: String(repo.forks) },
                { icon: Star, label: 'Star', value: String(repo.stars) },
              ].map((b) => (
                <button
                  key={b.label}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border-muted bg-surface-raised hover:border-border-strong px-2.5 py-1.5 text-xs font-bold text-gray-400"
                >
                  <b.icon className="w-3.5 h-3.5 text-gray-400" />
                  <span className="hidden sm:inline">{b.label}</span>
                  <span className="count-pill">{b.value}</span>
                </button>
              ))}
            </div>
          </div>

          <nav className="mt-3 flex gap-0.5 overflow-x-auto" aria-label="Repository">
            {navItems.map((item) => (
              <NavLink
                key={item.label}
                to={item.to}
                end={item.end}
                className={({ isActive }) => cn('repo-tab', isActive && 'active')}
              >
                <item.icon className="w-3.5 h-3.5" />
                {item.label}
                {item.count !== undefined && item.count > 0 && (
                  <span className="count-pill">{item.count}</span>
                )}
              </NavLink>
            ))}
          </nav>
        </div>
      </div>

      <div className="flex-1 max-w-6xl mx-auto w-full px-4 md:px-6 py-5">
        <Outlet />
      </div>
    </div>
  );
}
