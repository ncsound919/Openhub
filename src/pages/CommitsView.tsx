import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useStore } from '../store';
import { GitCommit, Calendar, ShieldCheck, FolderGit2 } from 'lucide-react';
import { format } from 'date-fns';
import { getAuthHeaders } from '../auth/AuthProvider';

interface GitState {
  branch: string | null;
  head: string | null;
  subject: string | null;
  changed: string[];
  remote: string | null;
}

/** Real commit state for the active project — no invented history. */
export function CommitsView() {
  const { repo: repoName } = useParams();
  const repo = useStore((state) => state.repositories.find((r) => r.name === repoName));
  const activeProject = useStore((s) => s.activeProject);
  const [git, setGit] = useState<GitState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isActive = !!activeProject && !!repo && activeProject.repoId === repo.id;

  useEffect(() => {
    if (!isActive) return;
    (async () => {
      try {
        const res = await fetch('/api/project/active/git', { credentials: 'include', headers: getAuthHeaders() });
        const data = await res.json();
        if (data.ok && data.git) setGit(data.git as GitState);
        else setError(data.error || 'Git state unavailable');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Git state request failed');
      }
    })();
  }, [isActive]);

  if (!repo) return null;

  if (!isActive) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <FolderGit2 className="w-8 h-8 text-gray-400" />
        <p className="mt-3 text-sm font-bold text-[var(--color-text-primary)]">No commit history available</p>
        <p className="mt-1 max-w-sm text-xs text-gray-400">
          Commit history is read from the active project's real Git worktree. Load <span className="font-mono text-[var(--color-text-primary)]">{repo.owner}/{repo.name}</span> as the active project to see it.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold flex items-center">
          <GitCommit className="w-5 h-5 mr-2 text-gray-400" /> Commit History
        </h2>
        <button className="bg-surface-raised border border-border-muted rounded-md px-3 py-1.5 text-sm font-semibold flex items-center shadow-sm">
          {git?.branch ?? '—'}
        </button>
      </div>

      {error && <div className="rounded border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs font-mono text-amber-300">{error}</div>}

      <div className="border border-border-muted rounded-md overflow-hidden bg-surface-raised shadow-sm">
        <div className="bg-surface-base border-b border-border-muted px-4 py-3 text-sm font-semibold text-gray-400 flex items-center">
          <Calendar className="w-4 h-4 mr-2 text-gray-400" />
          Working tree
        </div>

        {git?.head ? (
          <div className="p-4 hover:bg-surface-base transition-colors flex items-center justify-between">
            <div className="flex items-start space-x-3">
              <div className="w-9 h-9 rounded-full bg-surface-overlay border border-border-muted flex items-center justify-center">
                <GitCommit className="w-4 h-4 text-gray-400" />
              </div>
              <div>
                <h4 className="font-bold text-gray-400">{git.subject ?? 'no commit message'}</h4>
                <div className="flex items-center text-xs text-gray-400 mt-1 space-x-2">
                  <span className="font-mono text-blue-400">{git.head.slice(0, 10)}</span>
                  <span>HEAD</span>
                  <span className="flex items-center text-green-500 font-bold">
                    <ShieldCheck className="w-3 h-3 mr-0.5" /> Worktree commit
                  </span>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="p-6 text-center text-xs font-mono text-gray-400">No commits yet in this worktree.</div>
        )}

        {git && git.changed.length > 0 && (
          <div className="border-t border-border-muted px-4 py-3">
            <div className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-2">Uncommitted changes · {git.changed.length}</div>
            <div className="space-y-1 font-mono text-xs text-gray-400">
              {git.changed.slice(0, 30).map((c, i) => (
                <div key={i} className="truncate">{c}</div>
              ))}
            </div>
          </div>
        )}
      </div>

      {git?.remote && (
        <div className="text-xs font-mono text-gray-400">
          remote: <span className="text-gray-400">{git.remote}</span> · branch <span className="text-[var(--color-text-primary)]">{git.branch}</span>
        </div>
      )}
    </div>
  );
}
