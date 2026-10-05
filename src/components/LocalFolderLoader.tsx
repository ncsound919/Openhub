import React from 'react';
import { FolderOpen, Loader2, ArrowUp, Check } from 'lucide-react';
import { useStore, apiHeaders } from '../store';

interface BrowseEntry {
  name: string;
  path: string;
}

/** Load a folder from this machine as the active project. Sits next to Load project buttons. */
export function LocalFolderLoader({ className = '' }: { className?: string }) {
  const { importLocalFolder } = useStore();
  const [open, setOpen] = React.useState(false);
  const [folderPath, setFolderPath] = React.useState('');
  const [name, setName] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [browsing, setBrowsing] = React.useState(false);
  const [browseDir, setBrowseDir] = React.useState<string | null>(null);
  const [browseParent, setBrowseParent] = React.useState<string | null>(null);
  const [browseEntries, setBrowseEntries] = React.useState<BrowseEntry[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState(false);

  const browse = async (dir?: string) => {
    setBrowsing(true);
    setError(null);
    try {
      const res = await fetch(`/api/browse${dir ? `?dir=${encodeURIComponent(dir)}` : ''}`, {
        credentials: 'include',
        headers: apiHeaders(),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Cannot browse that location');
      setBrowseDir(data.dir ?? null);
      setBrowseParent(data.parent ?? null);
      setBrowseEntries(data.entries ?? []);
      if (data.dir) setFolderPath(data.dir);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Browse unavailable');
    } finally {
      setBrowsing(false);
    }
  };

  const handleLoad = async () => {
    if (!folderPath.trim() || busy) return;
    setBusy(true);
    setError(null);
    const result = await importLocalFolder(folderPath.trim(), name.trim() || undefined);
    setBusy(false);
    if (!result.ok) {
      setError(result.error || 'Import failed');
      return;
    }
    setDone(true);
    setTimeout(() => {
      setOpen(false);
      setDone(false);
    }, 900);
  };

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy]);

  return (
    <>
      <button
        onClick={() => {
          setOpen(true);
          setError(null);
          setDone(false);
          if (!browseDir && browseEntries.length === 0) void browse();
        }}
        className={`inline-flex items-center justify-center gap-2 rounded-lg border border-border-muted bg-surface-raised hover:border-emerald-500/50 px-4 py-2.5 font-semibold text-sm text-gray-200 ${className}`}
      >
        <FolderOpen className="w-4 h-4 text-emerald-400" /> Local folder
      </button>

      {open && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70" onClick={() => !busy && setOpen(false)} />
          <div role="dialog" aria-modal="true" aria-labelledby="lfl-title" className="relative w-full max-w-lg rounded-2xl border border-border-muted bg-surface-base p-5 shadow-2xl">
            <div className="flex items-center gap-2">
              <FolderOpen className="w-4 h-4 text-emerald-400" />
              <h2 id="lfl-title" className="!text-base">Load local folder</h2>
            </div>
            <p className="mt-1 text-xs text-gray-400">
              Point OpenHub at a folder on this machine. It is used in place — drift scan, workspace, and loops start automatically.
            </p>

            <label htmlFor="lfl-path" className="mt-4 block text-[10px] font-extrabold uppercase tracking-[0.14em] text-gray-400">
              Folder path
            </label>
            <input
              id="lfl-path"
              autoFocus
              value={folderPath}
              onChange={(e) => setFolderPath(e.target.value)}
              placeholder="C:\projects\my-app  or  /home/dev/my-app"
              className="mt-1.5 w-full rounded-lg border border-border-muted bg-surface-raised px-3 py-2 font-mono text-xs text-[var(--color-text-primary)] placeholder-gray-500 outline-none focus:border-emerald-500"
            />

            <label htmlFor="lfl-name" className="mt-3 block text-[10px] font-extrabold uppercase tracking-[0.14em] text-gray-400">
              Name <span className="normal-case font-semibold">(optional — defaults to folder name)</span>
            </label>
            <input
              id="lfl-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-app"
              className="mt-1.5 w-full rounded-lg border border-border-muted bg-surface-raised px-3 py-2 text-xs text-[var(--color-text-primary)] placeholder-gray-500 outline-none focus:border-emerald-500"
            />

            <div className="mt-3 rounded-xl border border-surface-overlay bg-bg-base">
              <div className="flex items-center gap-2 border-b border-surface-overlay px-3 py-2">
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-gray-400">
                  {browsing ? 'Browsing…' : browseDir ?? 'This machine'}
                </span>
                {browseParent && (
                  <button
                    onClick={() => void browse(browseParent)}
                    className="inline-flex items-center gap-1 text-[11px] font-bold text-gray-400 hover:text-[var(--color-text-primary)]"
                  >
                    <ArrowUp className="w-3 h-3" /> Up
                  </button>
                )}
              </div>
              <div className="max-h-44 overflow-y-auto p-1.5">
                {browseEntries.map((entry) => (
                  <button
                    key={entry.path}
                    onClick={() => {
                      setFolderPath(entry.path);
                      void browse(entry.path);
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-gray-200 hover:bg-surface-overlay"
                  >
                    <FolderOpen className="w-3.5 h-3.5 shrink-0 text-gray-400" />
                    <span className="truncate">{entry.name}</span>
                  </button>
                ))}
                {browseEntries.length === 0 && !browsing && (
                  <p className="px-2 py-3 text-center text-xs text-gray-400">No subfolders here.</p>
                )}
              </div>
            </div>

            {error && <p className="mt-3 text-xs font-mono text-red-400">{error}</p>}
            {done && (
              <p className="mt-3 inline-flex items-center gap-1.5 text-xs font-bold text-emerald-300">
                <Check className="w-4 h-4" /> Folder loaded — workspace is ready.
              </p>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setOpen(false)}
                disabled={busy}
                className="rounded-lg border border-border-muted px-4 py-2 text-xs font-bold text-gray-400 hover:text-[var(--color-text-primary)] disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                onClick={handleLoad}
                disabled={busy || !folderPath.trim()}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 px-4 py-2 text-xs font-bold text-white"
              >
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FolderOpen className="w-3.5 h-3.5" />}
                {busy ? 'Loading…' : 'Load folder'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
