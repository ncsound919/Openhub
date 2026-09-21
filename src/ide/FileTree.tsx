import React from 'react';
import { ChevronRight, File, Folder, FolderOpen, Loader2, Pencil, Trash2 } from 'lucide-react';
import { getAuthHeaders } from '../auth/AuthProvider';
import { cn } from '../lib/utils';

export type TreeNode = {
  name: string;
  type: 'file' | 'dir';
  path: string;
  size?: number;
};

/** Recursive, lazy-loading file tree over /api/project/active/contents. */
export function FileTree({
  rootPath,
  changedFiles,
  onOpenFile,
  activePath,
  onRenameFile,
  onDeleteFile,
}: {
  rootPath: string;
  changedFiles: Set<string>;
  onOpenFile: (node: TreeNode) => void;
  activePath?: string | null;
  onRenameFile?: (node: TreeNode) => void;
  onDeleteFile?: (node: TreeNode) => void;
}) {
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set([rootPath]));
  const [dirs, setDirs] = React.useState<Record<string, TreeNode[]>>({});
  const [loading, setLoading] = React.useState<Set<string>>(new Set());
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  const loadDir = React.useCallback(async (dirPath: string) => {
    setLoading((s) => new Set(s).add(dirPath));
    try {
      const res = await fetch(`/api/project/active/contents?path=${encodeURIComponent(dirPath)}`, {
        credentials: 'include',
        headers: getAuthHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok || data.type !== 'dir') {
        setErrors((e) => ({ ...e, [dirPath]: data.error || `Unable to read this folder (HTTP ${res.status})` }));
        return;
      }
      setErrors((e) => {
        if (!(dirPath in e)) return e;
        const next = { ...e };
        delete next[dirPath];
        return next;
      });
      const entries: TreeNode[] = (data.entries ?? []).sort((a: TreeNode, b: TreeNode) =>
        a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1,
      );
      setDirs((d) => ({ ...d, [dirPath]: entries }));
    } catch {
      setErrors((e) => ({ ...e, [dirPath]: 'Folder request failed â€” is the server reachable?' }));
    } finally {
      setLoading((s) => {
        const next = new Set(s);
        next.delete(dirPath);
        return next;
      });
    }
  }, []);

  const toggle = (node: TreeNode) => {
    if (node.type !== 'dir') return;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(node.path)) next.delete(node.path);
      else {
        next.add(node.path);
        if (!dirs[node.path]) void loadDir(node.path);
      }
      return next;
    });
  };

  const hasChanges = (node: TreeNode): boolean =>
    node.type === 'file'
      ? changedFiles.has(node.path)
      : Array.from(changedFiles).some((p) => p.startsWith(`${node.path}/`));

  // Load the root directory when the tree first mounts or the root changes.
  React.useEffect(() => {
    if (!dirs[rootPath] && !loading.has(rootPath)) void loadDir(rootPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath]);

  const renderChildren = (dirPath: string, depth: number): React.ReactNode => {
    const children = dirs[dirPath] ?? [];
    return children.map((node) => {
      const indent = { paddingLeft: `${8 + depth * 12}px` };
      const changed = hasChanges(node);
      return (
        <React.Fragment key={node.path}>
          <div className="group/row relative flex w-full items-center">
            <button
              onClick={() => toggle(node)}
              onDoubleClick={() => node.type === 'file' && onOpenFile(node)}
              className={cn(
                'flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-2 text-left text-[12px] transition-colors',
                node.type === 'file'
                  ? activePath === node.path
                    ? 'bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] text-[var(--color-text-primary)]'
                    : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]'
                  : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]',
              )}
              style={indent}
              title={node.path}
            >
              {node.type === 'dir' ? (
                <>
                  <ChevronRight
                    className={cn('w-3 h-3 shrink-0 text-[var(--color-text-muted)] transition-transform', expanded.has(node.path) && 'rotate-90')}
                  />
                  {expanded.has(node.path) ? (
                    <FolderOpen className="w-3.5 h-3.5 shrink-0 text-[var(--color-accent-text)]" />
                  ) : (
                    <Folder className="w-3.5 h-3.5 shrink-0 text-[var(--color-accent-text)]" />
                  )}
                </>
              ) : (
                <span className="w-[18px] shrink-0 flex items-center justify-center">
                  <File className="w-3.5 h-3.5 shrink-0 text-[var(--color-text-muted)]" />
                </span>
              )}
              <span className="min-w-0 flex-1 truncate">{node.name}</span>
              {changed && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-warning)]" />}
              {node.type === 'dir' && loading.has(node.path) && (
                <Loader2 className="w-3 h-3 shrink-0 animate-spin text-[var(--color-text-muted)]" />
              )}
            </button>
            {/* Actions are siblings of the row button â€” never nested interactive
                elements (axe nested-interactive), and revealed on row hover. */}
            {node.type === 'file' && (onRenameFile || onDeleteFile) && (
              <span className="flex shrink-0 items-center gap-0.5 pr-1.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/row:opacity-100">
                {onRenameFile && (
                  <button
                    type="button"
                    aria-label={`Rename ${node.name}`}
                    title="Rename"
                    onClick={() => onRenameFile(node)}
                    className="rounded p-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
                  >
                    <Pencil className="w-3 h-3" />
                  </button>
                )}
                {onDeleteFile && (
                  <button
                    type="button"
                    aria-label={`Delete ${node.name}`}
                    title="Delete"
                    onClick={() => onDeleteFile(node)}
                    className="rounded p-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}
              </span>
            )}
          </div>
          {node.type === 'dir' && expanded.has(node.path) && (
            <div>
              {errors[node.path] ? (
                <div className="flex items-center gap-2 py-1 pr-2 text-[11px] text-[var(--color-danger)]" style={{ paddingLeft: `${20 + depth * 12}px` }}>
                  <span className="min-w-0 flex-1 truncate" title={errors[node.path]}>{errors[node.path]}</span>
                  <button onClick={() => void loadDir(node.path)} className="shrink-0 rounded border border-[var(--color-border-muted)] px-1.5 py-0.5 font-semibold hover:text-[var(--color-text-primary)]">Retry</button>
                </div>
              ) : dirs[node.path] ? renderChildren(node.path, depth + 1) : null}
            </div>
          )}
        </React.Fragment>
      );
    });
  };

  return (
    <div className="flex-1 overflow-y-auto py-1">
      {errors[rootPath] && (
        <div className="flex items-center gap-2 px-2 py-1.5 text-[11px] text-[var(--color-danger)]">
          <span className="min-w-0 flex-1">{errors[rootPath]}</span>
          <button
            onClick={() => void loadDir(rootPath)}
            className="shrink-0 rounded border border-[var(--color-border-muted)] px-1.5 py-0.5 font-semibold hover:text-[var(--color-text-primary)]"
          >
            Retry
          </button>
        </div>
      )}
      {renderChildren(rootPath, 0)}
    </div>
  );
}